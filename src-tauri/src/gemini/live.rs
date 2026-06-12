use crate::gemini::types::*;
use futures_util::{SinkExt, StreamExt};
use std::collections::VecDeque;
use tokio::sync::mpsc;
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

async fn run_session(
    cfg: LiveSessionConfig,
    mut ctl: mpsc::Receiver<Ctl>,
    ev: mpsc::Sender<SessionEvent>,
) {
    let mut resume_handle: Option<String> = None;
    let mut pending: VecDeque<Vec<i16>> = VecDeque::new(); // audio buffered across reconnects
    const PENDING_CAP: usize = 100; // ~10s of 100ms chunks
    let mut attempt: u32 = 0;

    'outer: loop {
        let url = match &cfg.endpoint {
            Some(e) => e.clone(),
            None => format!("{WS_URL}?key={}", cfg.api_key),
        };

        let ws = match tokio_tungstenite::connect_async(&url).await {
            Ok((ws, _)) => ws,
            Err(e) => {
                attempt += 1;
                if attempt > 6 {
                    let _ = ev.send(SessionEvent::Failed(format!("connect: {e}"))).await;
                    return;
                }
                let _ = ev.send(SessionEvent::Reconnecting).await;
                tokio::time::sleep(std::time::Duration::from_millis(
                    500 * 2u64.pow(attempt.min(5)),
                ))
                .await;
                continue;
            }
        };

        let (mut sink, mut stream) = ws.split();

        let setup = setup_message(&cfg.target_lang, cfg.echo, resume_handle.as_deref());
        if sink
            .send(Message::Text(setup.to_string().into()))
            .await
            .is_err()
        {
            continue;
        }

        attempt = 0;
        let _ = ev.send(SessionEvent::Connected).await;

        // Re-send buffered audio from before reconnect
        while let Some(chunk) = pending.pop_front() {
            let _ = sink
                .send(Message::Text(
                    realtime_audio_message(&chunk).to_string().into(),
                ))
                .await;
        }

        loop {
            tokio::select! {
                cmd = ctl.recv() => match cmd {
                    Some(Ctl::Audio(pcm)) => {
                        let msg = realtime_audio_message(&pcm).to_string();
                        if sink.send(Message::Text(msg.into())).await.is_err() {
                            pending.push_back(pcm);
                            while pending.len() > PENDING_CAP {
                                pending.pop_front();
                            }
                            let _ = ev.send(SessionEvent::Reconnecting).await;
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
                        let payload: Vec<u8> = match msg {
                            Message::Text(t) => t.as_bytes().to_vec(),
                            Message::Binary(b) => b.to_vec(),
                            Message::Close(_) => {
                                let _ = ev.send(SessionEvent::Reconnecting).await;
                                continue 'outer;
                            }
                            _ => continue,
                        };
                        let Some(parsed) = parse_server_message(&payload) else { continue };
                        if let Some(u) = parsed.session_resumption_update {
                            if u.resumable == Some(true) {
                                resume_handle = u.new_handle;
                            }
                        }
                        if parsed.go_away.is_some() {
                            let _ = ev.send(SessionEvent::Reconnecting).await;
                            continue 'outer;
                        }
                        if let Some(sc) = parsed.server_content {
                            let audio = extract_audio(&sc);
                            if !audio.is_empty() {
                                let _ = ev.send(SessionEvent::Audio(audio)).await;
                            }
                            if let Some(t) = sc.input_transcription {
                                let _ = ev.send(SessionEvent::InputTranscript(t.text)).await;
                            }
                            if let Some(t) = sc.output_transcription {
                                let _ = ev.send(SessionEvent::OutputTranscript(t.text)).await;
                            }
                            if sc.turn_complete == Some(true) {
                                let _ = ev.send(SessionEvent::TurnComplete).await;
                            }
                        }
                    }
                    Some(Err(_)) | None => {
                        let _ = ev.send(SessionEvent::Reconnecting).await;
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

    async fn mock_server(
        expect_resume: Option<String>,
    ) -> (String, tokio::task::JoinHandle<serde_json::Value>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            let setup: serde_json::Value = match ws.next().await.unwrap().unwrap() {
                tokio_tungstenite::tungstenite::Message::Text(t) => {
                    serde_json::from_str(t.as_str()).unwrap()
                }
                m => panic!("expected text setup, got {m:?}"),
            };
            if let Some(h) = expect_resume {
                assert_eq!(setup["setup"]["sessionResumption"]["handle"], h);
            }
            ws.send(r#"{"setupComplete":{}}"#.to_string().into())
                .await
                .unwrap();
            ws.send(
                r#"{"sessionResumptionUpdate":{"newHandle":"h-1","resumable":true}}"#
                    .to_string()
                    .into(),
            )
            .await
            .unwrap();
            ws.send(
                r#"{"serverContent":{"modelTurn":{"parts":[{"inlineData":{"mimeType":"audio/pcm;rate=24000","data":"AQACAA=="}}]},"outputTranscription":{"text":"hi"}}}"#
                    .to_string()
                    .into(),
            )
            .await
            .unwrap();
            setup
        });
        (format!("ws://{addr}"), handle)
    }

    #[tokio::test]
    async fn session_connects_streams_and_reports() {
        let (url, server) = mock_server(None).await;
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
            tokio::time::timeout(std::time::Duration::from_secs(3), events.recv()).await
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
        let setup = server.await.unwrap();
        assert_eq!(
            setup["setup"]["generationConfig"]["translationConfig"]["targetLanguageCode"],
            "ru"
        );
        session.stop().await;
    }

    #[tokio::test]
    async fn session_reconnects_with_resume_handle() {
        // server 1 completes setup, sends resume handle h-1, then drops the connection.
        let (url1, _s1) = mock_server(None).await;
        let (session, mut events) = LiveSession::spawn(LiveSessionConfig {
            endpoint: Some(url1),
            api_key: "test".into(),
            target_lang: "en".into(),
            echo: false,
            label: "out",
        });
        let mut reconnecting = false;
        while let Ok(Some(ev)) =
            tokio::time::timeout(std::time::Duration::from_secs(5), events.recv()).await
        {
            if matches!(ev, SessionEvent::Reconnecting) {
                reconnecting = true;
                break;
            }
        }
        assert!(reconnecting, "must emit Reconnecting after server drop");
        session.stop().await;
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
