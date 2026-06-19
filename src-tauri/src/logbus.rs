//! Background log capture: a `tracing` Layer fans every event into a bounded
//! in-memory ring (for the Logs page), a rotating `.jsonl` file (survives a
//! crash), and a live `log:entry` Tauri event. The detailed diagnostics the
//! voice pipeline already emits via `tracing::*` were invisible in a windowed
//! release build (no console) — this makes them visible and exportable.
//!
//! Logging is best-effort everywhere: a failure to write the file or emit the
//! event must never crash or block the app.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

/// Max entries kept in the in-memory ring (the Logs page reads this snapshot).
pub const MAX_RING: usize = 5000;

/// Rotate the `.jsonl` file once it passes this size (keeps one previous file).
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// One captured log event. Field names mirror into TS via camelCase.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub seq: u64,
    pub ts: String,
    pub level: String,
    pub target: String,
    pub message: String,
    pub fields: Map<String, Value>,
}

/// Mask a secret for logs: `abcd…wxyz (len=NN)`. Empty → `<none>`; short
/// secrets (≤8 chars) are fully hidden. Lets us verify two keys match (same
/// head/tail/length) without leaking the key into a shareable log.
pub fn mask_secret(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let n = chars.len();
    if n == 0 {
        return "<none>".to_string();
    }
    if n <= 8 {
        return format!("•••• (len={n})");
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[n - 4..].iter().collect();
    format!("{head}…{tail} (len={n})")
}

/// Render one entry as a single human-readable line for `.txt` export / display.
pub fn format_txt_line(e: &LogEntry) -> String {
    let mut s = format!("{}  {:<5}  {}  {}", e.ts, e.level, e.target, e.message);
    if !e.fields.is_empty() {
        let kv: Vec<String> = e
            .fields
            .iter()
            .map(|(k, v)| {
                let vs = match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                format!("{k}={vs}")
            })
            .collect();
        s.push_str("  | ");
        s.push_str(&kv.join(" "));
    }
    s
}

/// Serialize entries for export. `"json"` → pretty JSON array; anything else
/// (`"txt"`) → one `format_txt_line` per line.
pub fn export_bytes(entries: &[LogEntry], format: &str) -> Vec<u8> {
    match format {
        "json" => serde_json::to_vec_pretty(entries).unwrap_or_default(),
        _ => {
            let mut out = String::new();
            for e in entries {
                out.push_str(&format_txt_line(e));
                out.push('\n');
            }
            out.into_bytes()
        }
    }
}

/// The bounded ring + seq counter. The global instance also files + emits via
/// `fan_out`; a fresh `new()` instance (used by tests) does neither.
pub struct LogBus {
    ring: Mutex<VecDeque<LogEntry>>,
    seq: AtomicU64,
}

impl LogBus {
    pub fn new() -> Self {
        Self {
            ring: Mutex::new(VecDeque::with_capacity(MAX_RING)),
            seq: AtomicU64::new(0),
        }
    }

    /// Append an entry, evicting the oldest past `MAX_RING`. Returns the entry
    /// (with its assigned seq) so callers can also file/emit it.
    pub fn push(
        &self,
        level: String,
        target: String,
        message: String,
        fields: Map<String, Value>,
    ) -> LogEntry {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let entry = LogEntry {
            seq,
            ts: now_rfc3339(),
            level,
            target,
            message,
            fields,
        };
        let mut ring = self.ring.lock().unwrap_or_else(|p| p.into_inner());
        if ring.len() >= MAX_RING {
            ring.pop_front();
        }
        ring.push_back(entry.clone());
        entry
    }

    pub fn snapshot(&self) -> Vec<LogEntry> {
        let ring = self.ring.lock().unwrap_or_else(|p| p.into_inner());
        ring.iter().cloned().collect()
    }

    pub fn clear(&self) {
        let mut ring = self.ring.lock().unwrap_or_else(|p| p.into_inner());
        ring.clear();
    }
}

impl Default for LogBus {
    fn default() -> Self {
        Self::new()
    }
}

/// Current local time as RFC3339; falls back to UTC if the local offset is
/// unavailable.
fn now_rfc3339() -> String {
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;
    let now = OffsetDateTime::now_local().unwrap_or_else(|_| OffsetDateTime::now_utc());
    now.format(&Rfc3339).unwrap_or_default()
}

// ── file sink ───────────────────────────────────────────────────────────────

/// Append-only `.jsonl` sink with single-generation rotation.
struct FileSink {
    dir: PathBuf,
    path: PathBuf,
    file: File,
    written: u64,
    max_bytes: u64,
}

impl FileSink {
    fn open(dir: PathBuf) -> std::io::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("app.jsonl");
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            dir,
            path,
            file,
            written,
            max_bytes: MAX_FILE_BYTES,
        })
    }

    fn write_entry(&mut self, entry: &LogEntry) -> std::io::Result<()> {
        let mut line = serde_json::to_string(entry).unwrap_or_default();
        line.push('\n');
        self.file.write_all(line.as_bytes())?;
        self.written += line.len() as u64;
        if self.written >= self.max_bytes {
            self.rotate()?;
        }
        Ok(())
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        let rotated = self.dir.join("app.1.jsonl");
        let _ = std::fs::remove_file(&rotated);
        std::fs::rename(&self.path, &rotated)?;
        self.file = OpenOptions::new().create(true).append(true).open(&self.path)?;
        self.written = 0;
        Ok(())
    }
}

// ── global wiring ───────────────────────────────────────────────────────────

struct Sinks {
    app: Option<AppHandle>,
    sink: Option<FileSink>,
}

static BUS: OnceLock<LogBus> = OnceLock::new();
static SINKS: OnceLock<Mutex<Sinks>> = OnceLock::new();

/// The process-wide log bus. `push` here also files + emits (when a sink is
/// installed). Tests that want isolation use `LogBus::new()` directly.
pub fn bus() -> &'static LogBus {
    BUS.get_or_init(LogBus::new)
}

fn sinks() -> &'static Mutex<Sinks> {
    SINKS.get_or_init(|| {
        Mutex::new(Sinks {
            app: None,
            sink: None,
        })
    })
}

/// Attach the Tauri app handle + open the rotating file. Called once from
/// `setup()` after the app-data dir exists. Best-effort: a failed file open
/// leaves the ring + live emit working.
pub fn install_sink(app: AppHandle, logs_dir: PathBuf) {
    let opened = FileSink::open(logs_dir).ok();
    let mut s = sinks().lock().unwrap_or_else(|p| p.into_inner());
    s.app = Some(app);
    s.sink = opened;
}

/// The directory the `.jsonl` files live in (for the "open folder" action).
pub fn logs_dir_path() -> Option<PathBuf> {
    let s = sinks().lock().unwrap_or_else(|p| p.into_inner());
    s.sink.as_ref().map(|sink| sink.dir.clone())
}

/// File + emit an already-pushed entry (best-effort).
fn fan_out(entry: &LogEntry) {
    let mut s = sinks().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(sink) = s.sink.as_mut() {
        let _ = sink.write_entry(entry);
    }
    if let Some(app) = s.app.as_ref() {
        let _ = app.emit("log:entry", entry);
    }
}

// ── tracing layer ───────────────────────────────────────────────────────────

/// Collects the `message` field and all other fields off a tracing event.
#[derive(Default)]
struct FieldVisitor {
    message: String,
    fields: Map<String, Value>,
}

impl FieldVisitor {
    fn put(&mut self, field: &Field, value: Value) {
        if field.name() == "message" {
            self.message = match value {
                Value::String(s) => s,
                other => other.to_string(),
            };
        } else {
            self.fields.insert(field.name().to_string(), value);
        }
    }
}

impl Visit for FieldVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.put(field, Value::String(format!("{value:?}")));
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field, Value::String(value.to_string()));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put(field, Value::from(value));
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put(field, Value::from(value));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put(field, Value::from(value));
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.put(field, Value::from(value));
    }
}

/// The `tracing` layer: every event → ring (+ file + emit via `fan_out`).
pub struct LogBusLayer;

impl<S: Subscriber> Layer<S> for LogBusLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        let meta = event.metadata();
        let entry = bus().push(
            meta.level().to_string(),
            meta.target().to_string(),
            visitor.message,
            visitor.fields,
        );
        fan_out(&entry);
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

/// Snapshot of the in-memory ring (newest last). The Logs page seeds from this.
#[tauri::command]
pub fn logs_get() -> Vec<LogEntry> {
    bus().snapshot()
}

/// Clear the in-memory ring (the on-disk `.jsonl` keeps its rolling history).
#[tauri::command]
pub fn logs_clear() {
    bus().clear();
}

/// Write the current ring to `dest` as `"txt"` or `"json"`.
#[tauri::command]
pub fn logs_export(dest: String, format: String) -> Result<(), String> {
    let entries = bus().snapshot();
    let bytes = export_bytes(&entries, &format);
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())
}

/// The logs directory path (for "open folder" via the opener plugin on JS side).
#[tauri::command]
pub fn logs_dir() -> Option<String> {
    logs_dir_path().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_secret_masks_head_tail_and_len() {
        assert_eq!(mask_secret(""), "<none>");
        assert_eq!(mask_secret("short"), "•••• (len=5)");
        assert_eq!(mask_secret("abcdefgh"), "•••• (len=8)");
        assert_eq!(mask_secret("sk_0123456789abcdef"), "sk_0…cdef (len=19)");
    }

    fn entry(level: &str, target: &str, msg: &str, fields: Vec<(&str, Value)>) -> LogEntry {
        let mut map = Map::new();
        for (k, v) in fields {
            map.insert(k.to_string(), v);
        }
        LogEntry {
            seq: 1,
            ts: "2026-06-19T14:03:11.482+03:00".to_string(),
            level: level.to_string(),
            target: target.to_string(),
            message: msg.to_string(),
            fields: map,
        }
    }

    #[test]
    fn format_txt_line_includes_fields() {
        let e = entry(
            "WARN",
            "elevenlabs",
            "TTS failed",
            vec![
                ("httpStatus", Value::from(401)),
                ("code", Value::from("detected_unusual_activity")),
            ],
        );
        let line = format_txt_line(&e);
        assert!(line.contains("WARN"));
        assert!(line.contains("elevenlabs"));
        assert!(line.contains("TTS failed"));
        assert!(line.contains("httpStatus=401"));
        assert!(line.contains("code=detected_unusual_activity"));
    }

    #[test]
    fn format_txt_line_no_fields_has_no_pipe() {
        let e = entry("INFO", "voice", "queued", vec![]);
        assert!(!format_txt_line(&e).contains(" | "));
    }

    #[test]
    fn export_bytes_json_roundtrips() {
        let e = entry("INFO", "voice", "hi", vec![("id", Value::from(7))]);
        let bytes = export_bytes(std::slice::from_ref(&e), "json");
        let back: Vec<LogEntry> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back, vec![e]);
    }

    #[test]
    fn export_bytes_txt_is_line_per_entry() {
        let a = entry("INFO", "voice", "one", vec![]);
        let b = entry("ERROR", "gemini", "two", vec![]);
        let bytes = export_bytes(&[a, b], "txt");
        let text = String::from_utf8(bytes).unwrap();
        assert_eq!(text.lines().count(), 2);
    }

    #[test]
    fn logentry_serializes_camel_case() {
        let e = entry("INFO", "voice", "hi", vec![]);
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"seq\""));
        assert!(json.contains("\"ts\""));
        assert!(json.contains("\"fields\""));
    }

    #[test]
    fn ring_caps_and_evicts_oldest() {
        let bus = LogBus::new();
        for i in 0..(MAX_RING + 10) {
            bus.push("INFO".into(), "t".into(), format!("m{i}"), Map::new());
        }
        let snap = bus.snapshot();
        assert_eq!(snap.len(), MAX_RING);
        // Oldest 10 evicted → first surviving message is "m10".
        assert_eq!(snap.first().unwrap().message, "m10");
        // seq keeps climbing past the cap.
        assert_eq!(snap.last().unwrap().seq, (MAX_RING + 10 - 1) as u64);
    }

    #[test]
    fn clear_empties_the_ring() {
        let bus = LogBus::new();
        bus.push("INFO".into(), "t".into(), "x".into(), Map::new());
        bus.clear();
        assert!(bus.snapshot().is_empty());
    }

    #[test]
    fn file_sink_writes_and_rotates() {
        let dir = tempfile::tempdir().unwrap();
        let mut sink = FileSink::open(dir.path().to_path_buf()).unwrap();
        let e = entry("INFO", "voice", "hello", vec![]);
        // Force rotation quickly with a tiny threshold.
        sink.max_bytes = 32;
        for _ in 0..50 {
            sink.write_entry(&e).unwrap();
        }
        // Active file + one rotated file exist.
        assert!(dir.path().join("app.jsonl").exists());
        assert!(dir.path().join("app.1.jsonl").exists());
    }

    #[test]
    fn layer_captures_event_into_global_ring() {
        use tracing_subscriber::prelude::*;
        // Unique marker so this is robust under parallel test execution.
        let subscriber = tracing_subscriber::registry().with(LogBusLayer);
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: "logbus_test_marker", answer = 42, name = "neo", "hello layer");
        });
        let snap = bus().snapshot();
        let found = snap
            .iter()
            .find(|e| e.target == "logbus_test_marker")
            .expect("event should be captured");
        assert_eq!(found.message, "hello layer");
        assert_eq!(found.level, "INFO");
        assert_eq!(found.fields.get("answer"), Some(&Value::from(42)));
        assert_eq!(found.fields.get("name"), Some(&Value::from("neo")));
    }
}
