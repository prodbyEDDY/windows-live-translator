use crate::gemini::types::*;
use futures_util::{SinkExt, StreamExt};
use std::collections::VecDeque;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone)]
pub struct LiveSessionConfig {
    pub endpoint: Option<String>, // None => real Gemini WS_URL with ?key=
    pub api_key: String,
    pub target_lang: String,
    pub echo: bool,
    pub label: &'static str, // "in" | "out" for logs
}

#[derive(Debug, Clone)]
pub enum SessionEvent {
    Connected,
    Reconnecting,
    Audio(Vec<i16>),           // 24k mono
    InputTranscript(String),
    OutputTranscript(String),
    TurnComplete,
    Failed(String), // terminal
}

enum Ctl {
    Audio(Vec<i16>),
    Stop,
}

#[derive(Clone)]
pub struct LiveSession {
    ctl: mpsc::Sender<Ctl>,
}

impl LiveSession {
    pub fn spawn(cfg: LiveSessionConfig) -> (Self, mpsc::Receiver<SessionEvent>) {
        let (ctl_tx, ctl_rx) = mpsc::channel::<Ctl>(256);
        let (ev_tx, ev_rx) = mpsc::channel::<SessionEvent>(256);
        tokio::spawn(run_session(cfg, ctl_rx, ev_tx));
        (Self { ctl: ctl_tx }, ev_rx)
    }

    pub async fn send_audio(&self, pcm16: Vec<i16>) {
        let _ = self.ctl.send(Ctl::Audio(pcm16)).await;
    }

    pub fn blocking_send_audio(&self, pcm16: Vec<i16>) {
        let _ = self.ctl.blocking_send(Ctl::Audio(pcm16));
    }

    pub async fn stop(&self) {
        let _ = self.ctl.send(Ctl::Stop).await;
    }
}

/// Push captured audio into the cross-reconnect buffer, dropping the oldest
/// chunk when the ~10s ring (`PENDING_CAP`) is full.
fn push_pending(pending: &mut VecDeque<Vec<i16>>, pcm: Vec<i16>) {
    pending.push_back(pcm);
    while pending.len() > PENDING_CAP {
        pending.pop_front();
    }
}

/// Non-blocking event emission. A wedged consumer must lose events, never
/// freeze the actor (and thus the capture thread feeding it).
fn emit(ev: &mpsc::Sender<SessionEvent>, label: &str, event: SessionEvent) {
    if let Err(TrySendError::Full(dropped)) = ev.try_send(event) {
        tracing::warn!(label, "events channel full, dropping {dropped:?}");
    }
}

const PENDING_CAP: usize = 100; // ~10s of 100ms chunks

/// Hard deadline for the first server frame after a setup send. A connection
/// that stays silent past this is treated as a reconnect cause (it counts
/// toward the attempt cap, so a permanently silent server ends in `Failed`).
const FIRST_FRAME_TIMEOUT_SECS: u64 = 15;

async fn run_session(
    cfg: LiveSessionConfig,
    mut ctl: mpsc::Receiver<Ctl>,
    ev: mpsc::Sender<SessionEvent>,
) {
    // Retained across reconnects so a resumed session can continue server-side
    // state; it dies with this task when we give up and emit `Failed` (intentional).
    let mut resume_handle: Option<String> = None;
    let mut pending: VecDeque<Vec<i16>> = VecDeque::new(); // audio buffered across reconnects
    let mut attempt: u32 = 0;

    'outer: loop {
        // Unified backoff gate: every path that re-enters the connect loop bumps
        // `attempt`, so a single capped, cancellable sleep here covers them all.
        if attempt > 0 {
            if attempt > 6 {
                tracing::error!(label = cfg.label, "live session failed: too many reconnect attempts");
                emit(
                    &ev,
                    cfg.label,
                    SessionEvent::Failed("too many reconnect attempts".into()),
                );
                return;
            }
            emit(&ev, cfg.label, SessionEvent::Reconnecting);
            let backoff =
                std::time::Duration::from_millis(500 * 2u64.pow(attempt.min(5)));
            let sleep = tokio::time::sleep(backoff);
            tokio::pin!(sleep);
            loop {
                tokio::select! {
                    _ = &mut sleep => break,
                    cmd = ctl.recv() => match cmd {
                        Some(Ctl::Audio(pcm)) => push_pending(&mut pending, pcm),
                        Some(Ctl::Stop) | None => return,
                    },
                }
            }
        }

        let url = match &cfg.endpoint {
            Some(e) => e.clone(),
            None => format!("{WS_URL}?key={}", cfg.api_key),
        };

        // Cancellable connect: a Stop arriving mid-reconnect must terminate the
        // actor instead of waiting out the (possibly hung) connection attempt.
        // The connect future is pinned so an `Audio` arriving during the wait
        // buffers without cancelling (and re-issuing) the in-flight handshake.
        let connect = tokio_tungstenite::connect_async(&url);
        tokio::pin!(connect);
        let ws = loop {
            tokio::select! {
                conn = &mut connect => match conn {
                    Ok((ws, _)) => break ws,
                    Err(e) => {
                        attempt += 1;
                        tracing::warn!(
                            label = cfg.label,
                            attempt,
                            reason = %format!("connect: {e}"),
                            "live session reconnecting"
                        );
                        continue 'outer;
                    }
                },
                cmd = ctl.recv() => match cmd {
                    Some(Ctl::Audio(pcm)) => push_pending(&mut pending, pcm),
                    Some(Ctl::Stop) | None => return,
                },
            }
        };

        let (mut sink, mut stream) = ws.split();

        let setup = setup_message(&cfg.target_lang, cfg.echo, resume_handle.as_deref());
        if sink
            .send(Message::Text(setup.to_string().into()))
            .await
            .is_err()
        {
            attempt += 1;
            tracing::warn!(
                label = cfg.label,
                attempt,
                reason = "setup-send failure",
                "live session reconnecting"
            );
            continue 'outer;
        }

        // Re-send buffered audio from before reconnect
        while let Some(chunk) = pending.pop_front() {
            let _ = sink
                .send(Message::Text(
                    realtime_audio_message(&chunk).to_string().into(),
                ))
                .await;
        }

        // `attempt` resets only after the first successfully parsed server frame
        // of this connection (see below), proving the link actually works.
        let mut connected = false;

        // A server that accepts the socket but never answers the setup (e.g. a
        // malformed setup it silently ignores) must not hang the session
        // forever: give the first frame a hard deadline, then reconnect.
        let first_frame_deadline =
            tokio::time::sleep(std::time::Duration::from_secs(FIRST_FRAME_TIMEOUT_SECS));
        tokio::pin!(first_frame_deadline);

        loop {
            tokio::select! {
                _ = &mut first_frame_deadline, if !connected => {
                    attempt += 1;
                    tracing::warn!(
                        label = cfg.label,
                        attempt,
                        reason = "no server frame after setup (timeout)",
                        "live session reconnecting"
                    );
                    continue 'outer;
                },
                cmd = ctl.recv() => match cmd {
                    Some(Ctl::Audio(pcm)) => {
                        let msg = realtime_audio_message(&pcm).to_string();
                        if sink.send(Message::Text(msg.into())).await.is_err() {
                            push_pending(&mut pending, pcm);
                            attempt += 1;
                            tracing::warn!(
                                label = cfg.label,
                                attempt,
                                reason = "audio-send failure",
                                "live session reconnecting"
                            );
                            continue 'outer;
                        }
                    }
                    Some(Ctl::Stop) | None => {
                        let _ = sink.close().await;
                        return;
                    }
                },
                frame = stream.next() => match frame {
                    Some(Ok(msg)) => {
                        // Borrow the frame bytes directly — no `to_vec()` copy.
                        // The `Text`/`Binary` payloads live in `msg` for the
                        // duration of this block, so a `&[u8]` slice suffices.
                        let payload: &[u8] = match &msg {
                            Message::Text(t) => t.as_bytes(),
                            Message::Binary(b) => b.as_ref(),
                            Message::Close(_) => {
                                attempt += 1;
                                tracing::warn!(
                                    label = cfg.label,
                                    attempt,
                                    reason = "close frame",
                                    "live session reconnecting"
                                );
                                continue 'outer;
                            }
                            _ => continue,
                        };
                        let Some(parsed) = parse_server_message(payload) else { continue };
                        if !connected {
                            connected = true;
                            attempt = 0;
                            tracing::info!(label = cfg.label, "live session connected");
                            emit(&ev, cfg.label, SessionEvent::Connected);
                        }
                        if let Some(u) = parsed.session_resumption_update {
                            if u.resumable == Some(true) {
                                resume_handle = u.new_handle;
                            }
                        }
                        if parsed.go_away.is_some() {
                            attempt += 1;
                            tracing::warn!(
                                label = cfg.label,
                                attempt,
                                reason = "goAway",
                                "live session reconnecting"
                            );
                            continue 'outer;
                        }
                        if let Some(sc) = parsed.server_content {
                            let audio = extract_audio(&sc);
                            if !audio.is_empty() {
                                emit(&ev, cfg.label, SessionEvent::Audio(audio));
                            }
                            if let Some(t) = sc.input_transcription {
                                emit(&ev, cfg.label, SessionEvent::InputTranscript(t.text));
                            }
                            if let Some(t) = sc.output_transcription {
                                emit(&ev, cfg.label, SessionEvent::OutputTranscript(t.text));
                            }
                            if sc.turn_complete == Some(true) {
                                emit(&ev, cfg.label, SessionEvent::TurnComplete);
                            }
                        }
                    }
                    Some(Err(_)) | None => {
                        attempt += 1;
                        tracing::warn!(
                            label = cfg.label,
                            attempt,
                            reason = "stream error/None",
                            "live session reconnecting"
                        );
                        continue 'outer;
                    }
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};

    const AUDIO_FRAME: &str = r#"{"serverContent":{"modelTurn":{"parts":[{"inlineData":{"mimeType":"audio/pcm;rate=24000","data":"AQACAA=="}}]},"outputTranscription":{"text":"hi"}}}"#;

    /// Read one client frame, parse it as JSON (the setup message), or `None`
    /// if the socket closes first.
    async fn recv_setup(
        ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    ) -> Option<serde_json::Value> {
        match ws.next().await {
            Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t))) => {
                Some(serde_json::from_str(t.as_str()).unwrap())
            }
            Some(Ok(m)) => panic!("expected text setup, got {m:?}"),
            _ => None,
        }
    }

    /// One mock listener that accepts `connections` sequential connections.
    ///
    /// The first connection asserts no resume handle, sends `setupComplete`, a
    /// `sessionResumptionUpdate{newHandle:"h-1"}`, and one audio frame. Every
    /// connection except the last then DROPS its socket to force a reconnect;
    /// each reconnect asserts the resume handle is `h-1` and replays
    /// `setupComplete` + one audio frame. The final connection stays open until
    /// the client closes it (the actor's `stop()`), keeping the listener alive
    /// so a stray reconnect never races a half-closed port. The join handle
    /// yields each connection's parsed setup message.
    async fn mock_server(
        connections: usize,
    ) -> (String, tokio::task::JoinHandle<Vec<serde_json::Value>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let mut setups = Vec::new();
            for conn in 0..connections {
                let (stream, _) = listener.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                let Some(setup) = recv_setup(&mut ws).await else {
                    break;
                };
                if conn == 0 {
                    assert!(
                        setup["setup"]["sessionResumption"]
                            .get("handle")
                            .is_none(),
                        "first connection must not carry a resume handle"
                    );
                } else {
                    assert_eq!(
                        setup["setup"]["sessionResumption"]["handle"], "h-1",
                        "reconnect must resume with handle h-1"
                    );
                }
                ws.send(r#"{"setupComplete":{}}"#.to_string().into())
                    .await
                    .unwrap();
                if conn == 0 {
                    ws.send(
                        r#"{"sessionResumptionUpdate":{"newHandle":"h-1","resumable":true}}"#
                            .to_string()
                            .into(),
                    )
                    .await
                    .unwrap();
                }
                ws.send(AUDIO_FRAME.to_string().into()).await.unwrap();
                setups.push(setup);

                if conn + 1 < connections {
                    // Drop the socket to force a reconnect onto the same listener.
                    drop(ws);
                } else {
                    // Last connection: drain until the client (actor `stop()`)
                    // closes, holding the listener open to avoid reconnect races.
                    while let Some(Ok(msg)) = ws.next().await {
                        if msg.is_close() {
                            break;
                        }
                    }
                }
            }
            setups
        });
        (format!("ws://{addr}"), handle)
    }

    #[tokio::test]
    async fn session_connects_streams_and_reports() {
        let (url, server) = mock_server(1).await;
        let (session, mut events) = LiveSession::spawn(LiveSessionConfig {
            endpoint: Some(url),
            api_key: "test".into(),
            target_lang: "ru".into(),
            echo: false,
            label: "in",
        });
        session.send_audio(vec![0i16; 1600]).await;
        let mut got_audio = false;
        let mut got_transcript = false;
        while let Ok(Some(ev)) =
            tokio::time::timeout(std::time::Duration::from_secs(5), events.recv()).await
        {
            match ev {
                SessionEvent::Audio(pcm) => {
                    assert_eq!(pcm, vec![1i16, 2]);
                    got_audio = true;
                }
                SessionEvent::OutputTranscript(t) => {
                    assert_eq!(t, "hi");
                    got_transcript = true;
                }
                _ => {}
            }
            if got_audio && got_transcript {
                break;
            }
        }
        assert!(got_audio && got_transcript);
        // Stop first so the server's final-connection drain loop unblocks.
        session.stop().await;
        let setups = server.await.unwrap();
        assert_eq!(
            setups[0]["setup"]["generationConfig"]["translationConfig"]["targetLanguageCode"],
            "ru"
        );
    }

    #[tokio::test]
    async fn session_reconnects_with_resume_handle() {
        // One listener serves two sequential connections: the first sends a
        // resume handle then drops; the second must resume with that handle and
        // deliver an audio frame, proving the resumed session works end-to-end.
        let (url, server) = mock_server(2).await;
        let (session, mut events) = LiveSession::spawn(LiveSessionConfig {
            endpoint: Some(url),
            api_key: "test".into(),
            target_lang: "en".into(),
            echo: false,
            label: "out",
        });

        let mut reconnecting = false;
        let mut connected_after_reconnect = false;
        let mut got_audio_after_reconnect = false;
        while let Ok(Some(ev)) =
            tokio::time::timeout(std::time::Duration::from_secs(5), events.recv()).await
        {
            match ev {
                SessionEvent::Reconnecting => reconnecting = true,
                SessionEvent::Connected if reconnecting => connected_after_reconnect = true,
                SessionEvent::Audio(_) if connected_after_reconnect => {
                    got_audio_after_reconnect = true;
                    break;
                }
                _ => {}
            }
        }
        assert!(reconnecting, "must emit Reconnecting after server drop");
        assert!(
            connected_after_reconnect,
            "must reconnect (Connected) after dropping the first socket"
        );
        assert!(
            got_audio_after_reconnect,
            "resumed session must deliver an audio frame"
        );

        // Stop must terminate the actor even though we are past the reconnect.
        session.stop().await;
        let setups = server.await.unwrap();
        assert_eq!(
            setups[1]["setup"]["sessionResumption"]["handle"], "h-1",
            "second connection setup must carry resume handle h-1"
        );
    }

    #[tokio::test]
    #[ignore = "real API; needs GEMINI_API_KEY"]
    async fn real_session_smoke() {
        let key = std::env::var("GEMINI_API_KEY").unwrap();
        let (s, mut ev) = LiveSession::spawn(LiveSessionConfig {
            endpoint: None,
            api_key: key,
            target_lang: "en".into(),
            echo: false,
            label: "smoke",
        });
        let first = tokio::time::timeout(std::time::Duration::from_secs(10), ev.recv())
            .await
            .unwrap();
        assert!(
            matches!(first, Some(SessionEvent::Connected)),
            "got {first:?}"
        );
        s.send_audio(vec![0i16; 1600]).await;
        s.stop().await;
    }
}
