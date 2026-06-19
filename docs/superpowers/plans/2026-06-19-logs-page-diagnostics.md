# Logs Page & Diagnostics Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sidebar **Logs** page that surfaces everything happening in the background, with detailed labelled logging across the voice-message pipeline + ElevenLabs/Gemini REST layers, an export button (`.txt`/`.json`), and a connection self-test that pinpoints the customer's ElevenLabs failure.

**Architecture:** A custom `tracing` Layer fans every log event into a bounded in-memory ring buffer, a rotating `.jsonl` file under app-data, and a live `log:entry` Tauri event. The frontend Logs screen seeds from a `logs_get` snapshot and live-appends from the event. Targeted structured logs are added across the pipeline and REST clients; a self-test makes real probe calls and returns a structured verdict.

**Tech Stack:** Rust / Tauri 2, `tracing` + `tracing-subscriber` (Layer API), `time` (timestamps), `serde_json`; React 19 + Zustand + HeroUI + i18next; Vitest.

## Global Constraints

- Logging must NEVER crash or block the app: every sink (ring/file/emit) is best-effort, lock-poison tolerant (`unwrap_or_else(|p| p.into_inner())`), and `let _ =` on fallible I/O.
- Do NOT add `tracing-appender` or any new crate that pulls `time`/`tokio` transitively (keyring/time pins — see `Cargo.toml` comments). The file sink is hand-rolled with `std::fs`.
- API keys are ALWAYS masked in logs and self-test output via `mask_secret`; all other content (including full transcript/translation text) is logged in full.
- Pipeline behaviour, stage strings, and `error:<short>` codes are UNCHANGED — logging is purely additive.
- Backend types crossing IPC use `#[serde(rename_all = "camelCase")]` to mirror the existing TS convention.
- Rust tests run: `cargo test --manifest-path src-tauri/Cargo.toml --lib <filter>`. Frontend tests run: `npm test` (vitest, from repo root).
- Follow existing file conventions: doc-comments on public items, `tracing::{info,warn,error,debug}!` with structured fields, `target:` set to a module label (`"voice"`, `"elevenlabs"`, `"gemini"`).

---

## File Structure

**New:**
- `src-tauri/src/logbus.rs` — log capture: `LogEntry`, ring `LogBus`, `LogBusLayer`, `FileSink`, `mask_secret`, formatters, `logs_*` commands.
- `src/lib/logs.ts` — pure frontend helpers: level ordering, `filterLogs`, `formatLogLine`.
- `src/lib/__tests__/logs.test.ts` — unit tests for `src/lib/logs.ts`.
- `src/screens/LogsScreen.tsx` — the Logs page (diagnostics card + console list + actions).

**Modified:**
- `src-tauri/src/lib.rs` — layered tracing init, `install_sink` in setup, register commands, declare `pub mod logbus`.
- `src-tauri/src/elevenlabs/rest.rs` — `classify_elevenlabs_tts_error`, `ElevenProbe`, `probe_validate`/`probe_synth`, structured logging.
- `src-tauri/src/gemini/rest.rs` — `GeminiProbe`, `probe_validate_key`/`probe_tts`, structured logging.
- `src-tauri/src/ipc.rs` — pipeline detailed logging, `elevenlabs_self_test`/`gemini_self_test` commands.
- `src/lib/ipc.ts` — `LogEntry`/self-test types + `logsGet`/`logsClear`/`logsExport`/`logsDir`/`elevenlabsSelfTest`/`geminiSelfTest`/`onLogEntry`.
- `src/components/Icons.tsx` — `IconLogs`.
- `src/components/Sidebar.tsx` — Logs nav item.
- `src/App.tsx` — `case "logs"`.
- `src/stores/app.ts` — `Screen` union `+ "logs"`.
- `src/i18n/en.json`, `src/i18n/ru.json` — `nav.logs`, `screen.logs`, `logs.*`.
- `src/screens/__tests__/render-smoke.test.tsx` — add LogsScreen smoke.

---

## Task 1: logbus core — types, masking, ring, formatters

**Files:**
- Create: `src-tauri/src/logbus.rs`
- Modify: `src-tauri/src/lib.rs:9` (add `pub mod logbus;` after `pub mod wizard;`)
- Test: inline `#[cfg(test)] mod tests` in `src-tauri/src/logbus.rs`

**Interfaces:**
- Produces: `LogEntry { seq:u64, ts:String, level:String, target:String, message:String, fields:serde_json::Map<String,Value> }`; `mask_secret(&str)->String`; `format_txt_line(&LogEntry)->String`; `export_bytes(&[LogEntry], &str)->Vec<u8>`; `LogBus` with `new()`, `push(level,target,message,fields)`, `snapshot()->Vec<LogEntry>`, `clear()`; `MAX_RING: usize = 5000`.

- [ ] **Step 1: Declare the module**

In `src-tauri/src/lib.rs`, after line `pub mod wizard;`, add:

```rust
pub mod logbus;
```

- [ ] **Step 2: Write the core file with the pure pieces + tests**

Create `src-tauri/src/logbus.rs`:

```rust
//! Background log capture: a `tracing` Layer fans every event into a bounded
//! in-memory ring (for the Logs page), a rotating `.jsonl` file (survives a
//! crash), and a live `log:entry` Tauri event. The detailed diagnostics the
//! voice pipeline already emits via `tracing::*` were invisible in a windowed
//! release build (no console) — this makes them visible and exportable.
//!
//! Logging is best-effort everywhere: a failure to write the file or emit the
//! event must never crash or block the app.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Max entries kept in the in-memory ring (the Logs page reads this snapshot).
pub const MAX_RING: usize = 5000;

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

/// The bounded ring + seq counter. The global instance also holds the file sink
/// and the Tauri app handle (set in `install_sink`); a fresh `new()` instance
/// (used by tests) has neither.
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
    pub fn push(&self, level: String, target: String, message: String, fields: Map<String, Value>) -> LogEntry {
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
        let e = entry("WARN", "elevenlabs", "TTS failed", vec![
            ("httpStatus", Value::from(401)),
            ("code", Value::from("detected_unusual_activity")),
        ]);
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
        // Map key stays as written.
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
}
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib logbus::tests`
Expected: PASS (8 tests). If `time::OffsetDateTime::now_local` errors at compile, confirm `Cargo.toml` `time` features include `local-offset` (they do).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/logbus.rs src-tauri/src/lib.rs
git commit -m "feat(logs): logbus core — LogEntry, ring buffer, masking, formatters"
```

---

## Task 2: logbus capture layer + rotating file sink

**Files:**
- Modify: `src-tauri/src/logbus.rs` (add `FileSink`, global `bus()`, `LogBusLayer`, `install_sink`, `logs_dir_path`)
- Test: inline tests in `src-tauri/src/logbus.rs`

**Interfaces:**
- Consumes: `LogBus`, `LogEntry`, `export_bytes` (Task 1).
- Produces: `bus() -> &'static LogBus` (global, also files+emits on push); `LogBusLayer` (`impl tracing_subscriber::Layer`); `install_sink(app: tauri::AppHandle, logs_dir: PathBuf)`; `logs_dir_path() -> Option<PathBuf>`.

- [ ] **Step 1: Write the failing file-sink + layer tests**

Add to the `tests` module in `src-tauri/src/logbus.rs`:

```rust
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib logbus::tests`
Expected: FAIL — `FileSink`, `LogBusLayer`, `bus` not found.

- [ ] **Step 3: Implement the sink, global bus, and layer**

In `src-tauri/src/logbus.rs`, update imports at the top:

```rust
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
```

Add the file-size threshold constant near `MAX_RING`:

```rust
/// Rotate the `.jsonl` file once it passes this size (keeps one previous file).
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
```

Add the file sink (after the `LogBus` impl):

```rust
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
        Ok(Self { dir, path, file, written, max_bytes: MAX_FILE_BYTES })
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
```

Add the global wiring (app handle + sink live alongside the global bus):

```rust
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
    SINKS.get_or_init(|| Mutex::new(Sinks { app: None, sink: None }))
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
```

Add the visitor + layer:

```rust
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib logbus::tests`
Expected: PASS (all Task 1 + 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/logbus.rs
git commit -m "feat(logs): tracing capture layer + rotating jsonl file sink"
```

---

## Task 3: wire tracing layering + logs commands

**Files:**
- Modify: `src-tauri/src/lib.rs` (tracing init `run()`; `install_sink` in `.setup()`; register commands)
- Modify: `src-tauri/src/logbus.rs` (add the four `#[tauri::command]`s)

**Interfaces:**
- Consumes: `bus()`, `export_bytes`, `logs_dir_path`, `install_sink`, `LogBusLayer` (Task 2).
- Produces commands: `logs_get() -> Vec<LogEntry>`, `logs_clear()`, `logs_export(dest:String, format:String) -> Result<(),String>`, `logs_dir() -> Option<String>`.

- [ ] **Step 1: Add the commands to `logbus.rs`**

Append to `src-tauri/src/logbus.rs` (before the `#[cfg(test)]` block):

```rust
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
```

- [ ] **Step 2: Switch tracing init to a layered registry**

In `src-tauri/src/lib.rs`, replace the body of the tracing init in `run()` (currently lines ~118-121):

```rust
    // Tracing: respect RUST_LOG via the env filter, defaulting to `info`.
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
```

with:

```rust
    // Tracing: a layered registry so EVERY event also lands in the log bus
    // (in-memory ring + rotating .jsonl + live `log:entry`) for the Logs page,
    // not just stdout (which a windowed release build has no console for).
    // Default filter captures our own crate at debug; deps stay at info.
    use tracing_subscriber::prelude::*;
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,live_translator_lib=debug"));
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer())
        .with(crate::logbus::LogBusLayer)
        .try_init();
```

- [ ] **Step 3: Install the file sink + handle in setup**

In `src-tauri/src/lib.rs` `.setup(|app| { ... })`, after the `voice_dir` is created (right after `std::fs::create_dir_all(&voice_dir)?;`, ~line 167), add:

```rust
            // Wire the log bus to a rotating file under app-data + the app
            // handle so events also stream live to the Logs page.
            let logs_dir = app_data_dir.join("logs");
            crate::logbus::install_sink(app.handle().clone(), logs_dir);
            tracing::info!(target: "app", version = env!("CARGO_PKG_VERSION"), "app starting; log bus installed");
```

- [ ] **Step 4: Register the commands**

In `src-tauri/src/lib.rs` `tauri::generate_handler![...]` (ends ~line 234), add before `wizard::wizard_state,`:

```rust
            logbus::logs_get,
            logbus::logs_clear,
            logbus::logs_export,
            logbus::logs_dir,
```

- [ ] **Step 5: Build to verify it compiles**

Run: `cargo build --manifest-path src-tauri/Cargo.toml --lib`
Expected: compiles clean (warnings ok). If `with` is unresolved, confirm `use tracing_subscriber::prelude::*;` is in scope in `run()`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/logbus.rs
git commit -m "feat(logs): layer the log bus into tracing init + logs_* commands"
```

---

## Task 4: ElevenLabs error classifier + probes + structured logging

**Files:**
- Modify: `src-tauri/src/elevenlabs/rest.rs`
- Test: inline tests in `src-tauri/src/elevenlabs/rest.rs`

**Interfaces:**
- Consumes: `crate::logbus::mask_secret`.
- Produces: `ElevenTtsError { http_status:u16, code:String, human:String }` + `classify_elevenlabs_tts_error(status:u16, body:&str) -> ElevenTtsError`; `ElevenProbe { ok:bool, http_status:Option<u16>, code:Option<String>, detail:String }` + `async probe_validate(api_key, voice_id) -> ElevenProbe` + `async probe_synth(api_key, voice_id, model_id) -> ElevenProbe`.

- [ ] **Step 1: Write the failing classifier tests**

Add to the `tests` module in `src-tauri/src/elevenlabs/rest.rs`:

```rust
    #[test]
    fn classify_tts_error_body_scan_beats_status() {
        // 401 with the unusual-activity marker → specific code, not generic auth.
        let e = classify_elevenlabs_tts_error(
            401,
            r#"{"detail":{"status":"detected_unusual_activity","message":"Unusual activity detected. Free Tier usage disabled."}}"#,
        );
        assert_eq!(e.code, "detected_unusual_activity");
        assert_eq!(e.http_status, 401);
        assert!(!e.human.is_empty());
    }

    #[test]
    fn classify_tts_error_known_codes() {
        assert_eq!(classify_elevenlabs_tts_error(404, r#"{"status":"voice_not_found"}"#).code, "voice_not_found");
        assert_eq!(classify_elevenlabs_tts_error(402, r#"{"status":"quota_exceeded"}"#).code, "quota_exceeded");
        assert_eq!(classify_elevenlabs_tts_error(400, r#"{"status":"text_too_long"}"#).code, "text_too_long");
        assert_eq!(classify_elevenlabs_tts_error(429, r#"{"status":"too_many_concurrent"}"#).code, "concurrent_limit_exceeded");
    }

    #[test]
    fn classify_tts_error_falls_back_to_status_family() {
        assert_eq!(classify_elevenlabs_tts_error(401, "opaque").code, "authentication_error");
        assert_eq!(classify_elevenlabs_tts_error(403, "opaque").code, "authorization_error");
        assert_eq!(classify_elevenlabs_tts_error(500, "boom").code, "internal_error");
        assert_eq!(classify_elevenlabs_tts_error(418, "teapot").code, "unknown_error");
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib elevenlabs::rest::tests`
Expected: FAIL — `classify_elevenlabs_tts_error` not found.

- [ ] **Step 3: Implement classifier + probes + logging**

In `src-tauri/src/elevenlabs/rest.rs`, add to the imports/top:

```rust
use serde::Serialize;
use std::time::Instant;

use crate::logbus::mask_secret;
```

Add the classifier (after `classify_elevenlabs`):

```rust
/// A classified ElevenLabs TTS failure for logging + self-test reporting.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevenTtsError {
    pub http_status: u16,
    pub code: String,
    pub human: String,
}

/// Map an ElevenLabs error (`status` + response `body`) to a stable code +
/// human sentence. Scans the body for documented status strings first (more
/// specific than the HTTP family), then falls back to the HTTP status.
pub fn classify_elevenlabs_tts_error(status: u16, body: &str) -> ElevenTtsError {
    let lower = body.to_ascii_lowercase();
    let code = if lower.contains("detected_unusual_activity") {
        "detected_unusual_activity"
    } else if lower.contains("quota_exceeded") || lower.contains("insufficient_credits") {
        "quota_exceeded"
    } else if lower.contains("voice_not_found") {
        "voice_not_found"
    } else if lower.contains("model_not_found") {
        "model_not_found"
    } else if lower.contains("invalid_api_key") {
        "invalid_api_key"
    } else if lower.contains("missing_permission") {
        "missing_permissions"
    } else if lower.contains("text_too_long") {
        "text_too_long"
    } else if lower.contains("concurrent") {
        "concurrent_limit_exceeded"
    } else if lower.contains("rate_limit") || lower.contains("too_many_requests") {
        "rate_limit_exceeded"
    } else {
        match status {
            400 => "validation_error",
            401 => "authentication_error",
            402 => "payment_required",
            403 => "authorization_error",
            404 => "not_found",
            409 => "conflict",
            429 => "rate_limit_error",
            500 => "internal_error",
            503 => "service_unavailable",
            _ => "unknown_error",
        }
    };
    ElevenTtsError {
        http_status: status,
        code: code.to_string(),
        human: human_for_eleven_code(code).to_string(),
    }
}

fn human_for_eleven_code(code: &str) -> &'static str {
    match code {
        "detected_unusual_activity" => "ElevenLabs flagged this IP and disabled Free-tier usage (VPN/datacenter/region). A paid plan or a non-flagged network is required.",
        "quota_exceeded" => "Out of ElevenLabs credits/quota for this billing window.",
        "voice_not_found" => "The voice_id does not exist for this account.",
        "model_not_found" => "The requested model is not available for this account.",
        "invalid_api_key" => "The ElevenLabs API key is invalid.",
        "missing_permissions" => "The API key lacks permission for this voice/model/feature.",
        "text_too_long" => "The text exceeds the per-request character limit.",
        "concurrent_limit_exceeded" => "Too many concurrent ElevenLabs requests.",
        "rate_limit_exceeded" | "rate_limit_error" => "ElevenLabs rate limit hit; retry with backoff.",
        "authentication_error" => "Authentication failed (invalid or missing key).",
        "authorization_error" => "Not authorized for this action.",
        "payment_required" => "Insufficient credits for this operation.",
        "validation_error" => "The request parameters were invalid.",
        "internal_error" => "ElevenLabs internal server error.",
        "service_unavailable" => "ElevenLabs is temporarily unavailable.",
        _ => "Unrecognized ElevenLabs error.",
    }
}

/// A connection-probe result for the self-test (no audio is recorded).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevenProbe {
    pub ok: bool,
    pub http_status: Option<u16>,
    pub code: Option<String>,
    pub detail: String,
}

/// Probe the credential + voice via get-voice, logging the exact outcome.
pub async fn probe_validate(api_key: &str, voice_id: &str) -> ElevenProbe {
    let url = format!("{API_BASE}/voices/{voice_id}");
    tracing::info!(target: "elevenlabs", voice_id = %mask_secret(voice_id), key = %mask_secret(api_key), "self-test: validate (get-voice) →");
    match client().get(&url).header("xi-api-key", api_key).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            if (200..300).contains(&status) {
                tracing::info!(target: "elevenlabs", http_status = status, "self-test: validate OK");
                ElevenProbe { ok: true, http_status: Some(status), code: None, detail: "voice found".into() }
            } else {
                let err = classify_elevenlabs_tts_error(status, &body);
                tracing::error!(target: "elevenlabs", http_status = status, code = %err.code, body = %body, "self-test: validate FAILED");
                ElevenProbe { ok: false, http_status: Some(status), code: Some(err.code), detail: err.human }
            }
        }
        Err(e) => {
            let detail = format!("network: {}", e.without_url());
            tracing::error!(target: "elevenlabs", error = %detail, "self-test: validate network error");
            ElevenProbe { ok: false, http_status: None, code: Some("network_error".into()), detail }
        }
    }
}

/// Probe synthesis with a tiny phrase, logging the exact outcome.
pub async fn probe_synth(api_key: &str, voice_id: &str, model_id: &str) -> ElevenProbe {
    let url = convert_url(voice_id);
    let body = serde_json::json!({ "text": "Test.", "model_id": model_id });
    let started = Instant::now();
    tracing::info!(target: "elevenlabs", voice_id = %mask_secret(voice_id), model = model_id, "self-test: synth (convert) →");
    match client().post(&url).header("xi-api-key", api_key).json(&body).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if (200..300).contains(&status) {
                let bytes = resp.bytes().await.map(|b| b.len()).unwrap_or(0);
                let ms = started.elapsed().as_millis();
                tracing::info!(target: "elevenlabs", http_status = status, bytes, latency_ms = ms as u64, "self-test: synth OK");
                ElevenProbe { ok: true, http_status: Some(status), code: None, detail: format!("{bytes} bytes in {ms} ms") }
            } else {
                let text = resp.text().await.unwrap_or_default();
                let err = classify_elevenlabs_tts_error(status, &text);
                tracing::error!(target: "elevenlabs", http_status = status, code = %err.code, body = %text, "self-test: synth FAILED");
                ElevenProbe { ok: false, http_status: Some(status), code: Some(err.code), detail: err.human }
            }
        }
        Err(e) => {
            let detail = format!("network: {}", e.without_url());
            tracing::error!(target: "elevenlabs", error = %detail, "self-test: synth network error");
            ElevenProbe { ok: false, http_status: None, code: Some("network_error".into()), detail }
        }
    }
}
```

Add structured logging to the production `synthesize_elevenlabs` (do not change its signature/return). Replace its body's request + error handling:

```rust
pub async fn synthesize_elevenlabs(
    api_key: &str,
    voice_id: &str,
    model_id: &str,
    text: &str,
) -> anyhow::Result<Vec<i16>> {
    let url = convert_url(voice_id);
    let body = serde_json::json!({ "text": text, "model_id": model_id });
    let started = Instant::now();
    tracing::info!(target: "elevenlabs", voice_id = %mask_secret(voice_id), key = %mask_secret(api_key), model = model_id, text_len = text.chars().count(), "TTS convert →");
    let resp = client()
        .post(&url)
        .header("xi-api-key", api_key)
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body_text = resp.text().await.unwrap_or_default();
        let err = classify_elevenlabs_tts_error(status, &body_text);
        tracing::error!(target: "elevenlabs", http_status = status, code = %err.code, body = %body_text, latency_ms = started.elapsed().as_millis() as u64, "ElevenLabs TTS failed");
        anyhow::bail!("ElevenLabs TTS failed: HTTP {status}: {body_text}");
    }

    let bytes = resp.bytes().await?;
    let pcm = parse_pcm_s16le(&bytes);
    if pcm.is_empty() {
        tracing::error!(target: "elevenlabs", bytes = bytes.len(), "ElevenLabs TTS returned no audio");
        anyhow::bail!("ElevenLabs TTS returned no audio");
    }
    tracing::info!(target: "elevenlabs", samples = pcm.len(), latency_ms = started.elapsed().as_millis() as u64, "TTS convert OK");
    Ok(pcm)
}
```

> Note: `resp.status()` was used twice before; capture `as_u16()` once as above.

- [ ] **Step 4: Run tests to verify pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib elevenlabs::rest::tests`
Expected: PASS (existing tests + 3 new classifier tests). Existing `classify_maps_statuses` etc. still pass (unchanged fn).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/elevenlabs/rest.rs
git commit -m "feat(logs): ElevenLabs error classifier + probes + structured TTS logging"
```

---

## Task 5: Gemini logging + self-test commands + pipeline logging

**Files:**
- Modify: `src-tauri/src/gemini/rest.rs` (probes + structured logging)
- Modify: `src-tauri/src/ipc.rs` (pipeline logging + `elevenlabs_self_test` / `gemini_self_test` commands)
- Modify: `src-tauri/src/lib.rs` (register the two self-test commands)
- Test: inline test in `src-tauri/src/gemini/rest.rs`

**Interfaces:**
- Consumes: `classify_elevenlabs_tts_error`, `probe_validate`, `probe_synth`, `ElevenProbe` (Task 4); `mask_secret` (Task 1); `get_api_key`, `get_elevenlabs_api_key`, settings (existing).
- Produces: `GeminiProbe { ok, httpStatus, code, detail }` + `async probe_validate_key(key)`/`async probe_tts(key, voice)`; commands `elevenlabs_self_test() -> ElevenSelfTest`, `gemini_self_test() -> GeminiSelfTest`.

- [ ] **Step 1: Write a failing Gemini probe-shape test**

Add to the `tests` module in `src-tauri/src/gemini/rest.rs`:

```rust
    #[test]
    fn gemini_probe_serializes_camel_case() {
        let p = GeminiProbe { ok: false, http_status: Some(403), code: Some("auth".into()), detail: "bad key".into() };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"httpStatus\":403"));
        assert!(json.contains("\"ok\":false"));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib gemini::rest::tests::gemini_probe`
Expected: FAIL — `GeminiProbe` not found.

- [ ] **Step 3: Add the Gemini probe type, probes, and logging**

In `src-tauri/src/gemini/rest.rs` top imports add:

```rust
use std::time::Instant;
use crate::logbus::mask_secret;
```

Add the probe type + functions (near `validate_key`):

```rust
/// A Gemini connection-probe result for the self-test.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiProbe {
    pub ok: bool,
    pub http_status: Option<u16>,
    pub code: Option<String>,
    pub detail: String,
}

/// Probe the Gemini key via the models list endpoint, logging the outcome.
pub async fn probe_validate_key(key: &str) -> GeminiProbe {
    tracing::info!(target: "gemini", key = %mask_secret(key), "self-test: validate key →");
    match validate_key(key).await {
        KeyStatus::Valid => {
            tracing::info!(target: "gemini", "self-test: key OK");
            GeminiProbe { ok: true, http_status: Some(200), code: None, detail: "key valid".into() }
        }
        KeyStatus::Invalid { reason } => {
            tracing::error!(target: "gemini", reason = %reason, "self-test: key INVALID");
            GeminiProbe { ok: false, http_status: None, code: Some("invalid_key".into()), detail: reason }
        }
        KeyStatus::Error { message } => {
            tracing::error!(target: "gemini", message = %message, "self-test: key check error");
            GeminiProbe { ok: false, http_status: None, code: Some("error".into()), detail: message }
        }
        KeyStatus::Missing => {
            GeminiProbe { ok: false, http_status: None, code: Some("missing".into()), detail: "no key stored".into() }
        }
    }
}

/// Probe Gemini TTS with a tiny phrase (mirrors what transcription needs:
/// reachability of generativelanguage.googleapis.com), logging the outcome.
pub async fn probe_tts(key: &str, voice: &str) -> GeminiProbe {
    let started = Instant::now();
    tracing::info!(target: "gemini", voice, "self-test: TTS probe →");
    match synthesize_speech(key, "Test.", voice).await {
        Ok(pcm) => {
            let ms = started.elapsed().as_millis();
            tracing::info!(target: "gemini", samples = pcm.len(), latency_ms = ms as u64, "self-test: TTS OK");
            GeminiProbe { ok: true, http_status: Some(200), code: None, detail: format!("{} samples in {ms} ms", pcm.len()) }
        }
        Err(e) => {
            let detail = e.to_string();
            tracing::error!(target: "gemini", error = %detail, "self-test: TTS FAILED");
            GeminiProbe { ok: false, http_status: None, code: Some("tts_failed".into()), detail }
        }
    }
}
```

Add failure logging in `call_generate_content` (before its `anyhow::bail!`):

```rust
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body_text = resp.text().await.unwrap_or_default();
        tracing::warn!(target: "gemini", http_status = status, body = %body_text, model = "gemini-3.5-flash", "generateContent failed");
        anyhow::bail!("generateContent failed: HTTP {status}: {body_text}");
    }
```

And in `synthesize_speech` (before its `anyhow::bail!`):

```rust
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body_text = resp.text().await.unwrap_or_default();
        tracing::warn!(target: "gemini", http_status = status, body = %body_text, model = "gemini-3.1-flash-tts-preview", "TTS generateContent failed");
        anyhow::bail!("TTS generateContent failed: HTTP {status}: {body_text}");
    }
```

> The local `use serde::Serialize;` is already imported at the top of `gemini/rest.rs` (it imports `serde::{Deserialize, Serialize}`). Confirm; if not, add it.

- [ ] **Step 4: Run the probe test to verify pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib gemini::rest::tests::gemini_probe`
Expected: PASS.

- [ ] **Step 5: Add self-test commands + pipeline logging to `ipc.rs`**

In `src-tauri/src/ipc.rs`, extend the imports (line ~17-18) to include the probe items:

```rust
use crate::elevenlabs::rest::{synthesize_elevenlabs, validate_elevenlabs, ELEVEN_MODEL_ID, probe_validate, probe_synth, ElevenProbe};
use crate::gemini::rest::{synthesize_speech, transcribe_translate, validate_key, KeyStatus, TTS_VOICES, probe_validate_key, probe_tts, GeminiProbe};
use crate::logbus::mask_secret;
```

Add the self-test result types + commands (near the other voice commands, e.g. after `tts_voices`):

```rust
/// Result of the ElevenLabs connection self-test (no audio recorded).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevenSelfTest {
    pub key_present: bool,
    pub voice_id: String,
    pub validate: ElevenProbe,
    pub synth: ElevenProbe,
}

/// Run a real ElevenLabs validate + tiny synth probe and report the verdict.
/// Logs the exact HTTP status/body so the Logs page shows the precise cause
/// (e.g. detected_unusual_activity) without recording a real message.
#[tauri::command]
pub async fn elevenlabs_self_test(state: State<'_, AppState>) -> Result<ElevenSelfTest, String> {
    let voice_id = state.settings.get().eleven_voice_id;
    let key = match get_elevenlabs_api_key() {
        Some(k) => k,
        None => {
            tracing::warn!(target: "elevenlabs", "self-test: no API key stored");
            let miss = ElevenProbe { ok: false, http_status: None, code: Some("no_key".into()), detail: "no ElevenLabs key stored".into() };
            return Ok(ElevenSelfTest {
                key_present: false,
                voice_id: mask_secret(&voice_id),
                validate: miss.clone(),
                synth: miss,
            });
        }
    };
    tracing::info!(target: "elevenlabs", voice_id = %mask_secret(&voice_id), "self-test: started");
    let validate = probe_validate(&key, &voice_id).await;
    // Only attempt synth if validate passed (avoids a second confusing error).
    let synth = if validate.ok {
        probe_synth(&key, &voice_id, ELEVEN_MODEL_ID).await
    } else {
        ElevenProbe { ok: false, http_status: None, code: Some("skipped".into()), detail: "skipped (validate failed)".into() }
    };
    tracing::info!(target: "elevenlabs", validate_ok = validate.ok, synth_ok = synth.ok, "self-test: finished");
    Ok(ElevenSelfTest { key_present: true, voice_id: mask_secret(&voice_id), validate, synth })
}

/// Result of the Gemini connection self-test.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiSelfTest {
    pub key_present: bool,
    pub validate: GeminiProbe,
    pub tts: GeminiProbe,
}

/// Run a real Gemini key-validate + tiny TTS probe (transcription uses the same
/// host) and report the verdict.
#[tauri::command]
pub async fn gemini_self_test(state: State<'_, AppState>) -> Result<GeminiSelfTest, String> {
    let key = match get_api_key() {
        Some(k) => k,
        None => {
            tracing::warn!(target: "gemini", "self-test: no API key stored");
            let miss = GeminiProbe { ok: false, http_status: None, code: Some("no_key".into()), detail: "no Gemini key stored".into() };
            return Ok(GeminiSelfTest { key_present: false, validate: miss.clone(), tts: miss });
        }
    };
    tracing::info!(target: "gemini", "self-test: started");
    let validate = probe_validate_key(&key).await;
    let voice = state.settings.get().tts_voice;
    let voice = if voice.is_empty() { "Kore".to_string() } else { voice };
    let tts = if validate.ok {
        probe_tts(&key, &voice).await
    } else {
        GeminiProbe { ok: false, http_status: None, code: Some("skipped".into()), detail: "skipped (validate failed)".into() }
    };
    tracing::info!(target: "gemini", validate_ok = validate.ok, tts_ok = tts.ok, "self-test: finished");
    Ok(GeminiSelfTest { key_present: true, validate, tts })
}
```

Now add the pipeline logging. In `run_record_pipeline` (the recording path), at the very start add a job log and an `Instant`:

```rust
async fn run_record_pipeline(
    app: AppHandle,
    history: Arc<HistoryStore>,
    voice_dir: PathBuf,
    id: i64,
    source_path: PathBuf,
    peer_lang: String,
    synth: OutSynth,
) {
    let job_started = std::time::Instant::now();
    tracing::info!(target: "voice", id, kind = "out", peer_lang = %peer_lang, provider = ?synth.provider, eleven_voice = %mask_secret(&synth.eleven_voice_id), "record pipeline started");
    set_stage(&app, &history, id, STAGE_TRANSCRIBING);
```

After the source bytes are read, log size:

```rust
    tracing::info!(target: "voice", id, source_bytes = bytes.len(), "read recorded WAV source");
```

After a successful transcribe (`let _ = history.update_voice(... transcription ...)`), add:

```rust
    tracing::info!(target: "voice", id, source_lang = %transcription.source_lang, transcript_len = transcription.transcript.chars().count(), translation_len = transcription.translation.chars().count(), elapsed_ms = job_started.elapsed().as_millis() as u64, "transcribe+translate OK");
```

Just before synthesis, log the resolved route (after `let plan = plan_out_synth(...)`):

```rust
    match &plan {
        SynthPlan::Gemini { voice } => tracing::info!(target: "voice", id, route = "gemini", voice = %voice, "synth route resolved"),
        SynthPlan::Eleven { voice_id, model } => tracing::info!(target: "voice", id, route = "elevenlabs", voice_id = %mask_secret(voice_id), model = %model, "synth route resolved"),
        SynthPlan::Fail(short) => tracing::warn!(target: "voice", id, route = "fail", short = %short, "synth pre-flight failed"),
    }
```

After a successful `pcm` is obtained (the `let pcm = match pcm_result { Ok(p) => p, ... }` — add to the `Ok(p)` arm a log, or after the match):

```rust
    tracing::info!(target: "voice", id, samples = pcm.len(), "synthesis OK");
```

In `set_stage`, add a trace log so every transition is captured:

```rust
fn set_stage(app: &AppHandle, history: &HistoryStore, id: i64, stage: &str) {
    tracing::info!(target: "voice", id, stage = %stage, "stage →");
    let _ = history.update_voice(
```

In `run_import_pipeline`, at the start add:

```rust
    tracing::info!(target: "voice", id, kind = "in", target_lang = %target_lang, mime = %mime, "import pipeline started");
```

and after reading bytes:

```rust
    tracing::info!(target: "voice", id, source_bytes = bytes.len(), "read source file");
```

and after a successful transcribe in the import path (`Ok(t) => { ... }` arm, before `set_stage(STAGE_DONE)`):

```rust
            tracing::info!(target: "voice", id, source_lang = %t.source_lang, transcript_len = t.transcript.chars().count(), translation_len = t.translation.chars().count(), "import transcribe+translate OK");
```

> The existing `tracing::warn!` failure lines already carry the error `e` (HTTP status + body) — keep them.

- [ ] **Step 6: Register the self-test commands**

In `src-tauri/src/lib.rs` `generate_handler![...]`, add after the `logbus::*` lines:

```rust
            ipc::elevenlabs_self_test,
            ipc::gemini_self_test,
```

- [ ] **Step 7: Build + run the full backend test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: compiles; all tests PASS (ignored real-API smokes stay ignored).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/gemini/rest.rs src-tauri/src/ipc.rs src-tauri/src/lib.rs
git commit -m "feat(logs): Gemini logging, self-test commands, pipeline detail logs"
```

---

## Task 6: frontend IPC bindings + pure log helpers

**Files:**
- Modify: `src/lib/ipc.ts`
- Create: `src/lib/logs.ts`
- Test: `src/lib/__tests__/logs.test.ts`

**Interfaces:**
- Consumes: backend commands/events/types from Tasks 3 & 5.
- Produces: TS `LogEntry`, `ElevenSelfTest`, `GeminiSelfTest`, `ElevenProbe`, `GeminiProbe`; `ipc.logsGet/logsClear/logsExport/logsDir/elevenlabsSelfTest/geminiSelfTest/onLogEntry`; `LEVELS`, `levelRank`, `filterLogs`, `formatLogLine` in `src/lib/logs.ts`.

- [ ] **Step 1: Write failing tests for `src/lib/logs.ts`**

Create `src/lib/__tests__/logs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { filterLogs, formatLogLine, levelRank, type LogEntry } from "../logs";

function e(partial: Partial<LogEntry>): LogEntry {
  return {
    seq: 1,
    ts: "2026-06-19T14:03:11.482+03:00",
    level: "INFO",
    target: "voice",
    message: "hello",
    fields: {},
    ...partial,
  };
}

describe("levelRank", () => {
  it("orders severities ERROR > WARN > INFO > DEBUG > TRACE", () => {
    expect(levelRank("ERROR")).toBeGreaterThan(levelRank("WARN"));
    expect(levelRank("WARN")).toBeGreaterThan(levelRank("INFO"));
    expect(levelRank("INFO")).toBeGreaterThan(levelRank("DEBUG"));
  });
});

describe("filterLogs", () => {
  const entries = [
    e({ seq: 1, level: "INFO", target: "voice", message: "queued" }),
    e({ seq: 2, level: "ERROR", target: "elevenlabs", message: "TTS failed", fields: { code: "detected_unusual_activity" } }),
    e({ seq: 3, level: "DEBUG", target: "gemini", message: "latency" }),
  ];

  it("filters by minimum level", () => {
    const r = filterLogs(entries, { minLevel: "ERROR", query: "" });
    expect(r.map((x) => x.seq)).toEqual([2]);
  });

  it("filters by query across message, target, and field values", () => {
    expect(filterLogs(entries, { minLevel: "TRACE", query: "elevenlabs" }).map((x) => x.seq)).toEqual([2]);
    expect(filterLogs(entries, { minLevel: "TRACE", query: "unusual" }).map((x) => x.seq)).toEqual([2]);
    expect(filterLogs(entries, { minLevel: "TRACE", query: "queued" }).map((x) => x.seq)).toEqual([1]);
  });

  it("query is case-insensitive and empty matches all", () => {
    expect(filterLogs(entries, { minLevel: "TRACE", query: "" }).length).toBe(3);
    expect(filterLogs(entries, { minLevel: "TRACE", query: "TTS" }).map((x) => x.seq)).toEqual([2]);
  });
});

describe("formatLogLine", () => {
  it("includes ts, level, target, message and fields", () => {
    const line = formatLogLine(e({ level: "WARN", target: "elevenlabs", message: "x", fields: { httpStatus: 401 } }));
    expect(line).toContain("WARN");
    expect(line).toContain("elevenlabs");
    expect(line).toContain("httpStatus=401");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- logs`
Expected: FAIL — cannot resolve `../logs`.

- [ ] **Step 3: Implement `src/lib/logs.ts`**

Create `src/lib/logs.ts`:

```ts
/** A captured backend log entry (camelCase mirror of `logbus::LogEntry`). */
export interface LogEntry {
  seq: number;
  ts: string;
  level: string;
  target: string;
  message: string;
  fields: Record<string, unknown>;
}

/** Severity order, lowest → highest. */
export const LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"] as const;
export type Level = (typeof LEVELS)[number];

/** Numeric rank of a level (higher = more severe); unknown levels rank as INFO. */
export function levelRank(level: string): number {
  const i = LEVELS.indexOf(level.toUpperCase() as Level);
  return i === -1 ? LEVELS.indexOf("INFO") : i;
}

export interface LogFilter {
  /** Minimum severity to include. */
  minLevel: string;
  /** Case-insensitive substring matched against message, target, and field values. */
  query: string;
}

/** Filter entries by minimum level and a free-text query. */
export function filterLogs(entries: LogEntry[], filter: LogFilter): LogEntry[] {
  const min = levelRank(filter.minLevel);
  const q = filter.query.trim().toLowerCase();
  return entries.filter((e) => {
    if (levelRank(e.level) < min) return false;
    if (!q) return true;
    if (e.message.toLowerCase().includes(q)) return true;
    if (e.target.toLowerCase().includes(q)) return true;
    return Object.entries(e.fields).some(
      ([k, v]) => k.toLowerCase().includes(q) || String(v).toLowerCase().includes(q)
    );
  });
}

/** One-line plain-text rendering (used for display + clipboard). */
export function formatLogLine(e: LogEntry): string {
  let s = `${e.ts}  ${e.level.padEnd(5)}  ${e.target}  ${e.message}`;
  const keys = Object.keys(e.fields);
  if (keys.length > 0) {
    s += "  | " + keys.map((k) => `${k}=${String(e.fields[k])}`).join(" ");
  }
  return s;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- logs`
Expected: PASS.

- [ ] **Step 5: Add IPC bindings**

In `src/lib/ipc.ts`, add types (after `VoiceProgressEvent`):

```ts
export type { LogEntry } from "./logs";

/** A connection-probe result (camelCase mirror of the Rust probe types). */
export interface ProbeResult {
  ok: boolean;
  httpStatus: number | null;
  code: string | null;
  detail: string;
}

export interface ElevenSelfTest {
  keyPresent: boolean;
  voiceId: string;
  validate: ProbeResult;
  synth: ProbeResult;
}

export interface GeminiSelfTest {
  keyPresent: boolean;
  validate: ProbeResult;
  tts: ProbeResult;
}
```

Add a top-of-file import so the value side can reference the type:

```ts
import type { LogEntry } from "./logs";
```

Add to the `ipc` object (before the `on*` listeners):

```ts
  logsGet: () => invoke<LogEntry[]>("logs_get"),
  logsClear: () => invoke<void>("logs_clear"),
  logsExport: (dest: string, format: "txt" | "json") =>
    invoke<void>("logs_export", { dest, format }),
  logsDir: () => invoke<string | null>("logs_dir"),
  elevenlabsSelfTest: () => invoke<ElevenSelfTest>("elevenlabs_self_test"),
  geminiSelfTest: () => invoke<GeminiSelfTest>("gemini_self_test"),
```

Add to the listeners (after `onVoiceProgress`):

```ts
  onLogEntry: (cb: (e: LogEntry) => void): Promise<UnlistenFn> =>
    listen("log:entry", (e) => cb(e.payload as LogEntry)),
```

- [ ] **Step 6: Run the full frontend suite (no regressions)**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/logs.ts src/lib/__tests__/logs.test.ts src/lib/ipc.ts
git commit -m "feat(logs): frontend log helpers + IPC bindings for logs & self-test"
```

---

## Task 7: Logs screen + sidebar/nav/i18n wiring

**Files:**
- Modify: `src/components/Icons.tsx` (add `IconLogs`)
- Modify: `src/components/Sidebar.tsx` (nav item)
- Modify: `src/App.tsx` (route)
- Modify: `src/stores/app.ts` (`Screen` union)
- Modify: `src/i18n/en.json`, `src/i18n/ru.json`
- Create: `src/screens/LogsScreen.tsx`
- Modify: `src/screens/__tests__/render-smoke.test.tsx`

**Interfaces:**
- Consumes: `ipc.logsGet/logsClear/logsExport/logsDir/elevenlabsSelfTest/geminiSelfTest/onLogEntry` (Task 6); `filterLogs/formatLogLine/LEVELS/LogEntry` (Task 6); `@tauri-apps/plugin-dialog` `save`, `@tauri-apps/plugin-opener` `revealItemInDir`.

- [ ] **Step 1: Add the `Screen` union member**

In `src/stores/app.ts:19`, change:

```ts
export type Screen = "live" | "voice" | "history" | "settings" | "help" | "wizard";
```

to:

```ts
export type Screen = "live" | "voice" | "history" | "settings" | "help" | "logs" | "wizard";
```

- [ ] **Step 2: Add the `IconLogs` icon**

In `src/components/Icons.tsx`, add after `IconHelp` (or any export):

```tsx
/** Terminal / log lines — Logs. */
export function IconLogs(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l2.5 2L7 13" />
      <path d="M12.5 13H17" />
    </svg>
  );
}
```

- [ ] **Step 3: Add the nav item**

In `src/components/Sidebar.tsx`, import `IconLogs` (add to the existing import block from `./Icons`), then add to `NAV_ITEMS` after the `history` entry:

```tsx
  { id: "logs", labelKey: "nav.logs", icon: IconLogs },
```

- [ ] **Step 4: Add i18n strings**

In `src/i18n/en.json`, add `"logs": "Logs"` to `nav`, `"logs": "Logs"` to `screen`, and a new top-level `logs` block:

```json
  "logs": {
    "diagnostics": "Diagnostics",
    "testEleven": "Test ElevenLabs",
    "testGemini": "Test Gemini",
    "testing": "Testing…",
    "pass": "OK",
    "fail": "Failed",
    "validate": "Validate",
    "synth": "Synthesis",
    "tts": "TTS",
    "noKey": "no key stored",
    "filterLevel": "Level",
    "searchPlaceholder": "Filter logs…",
    "clear": "Clear",
    "export": "Export",
    "openFolder": "Open folder",
    "follow": "Follow",
    "empty": "No logs yet. Reproduce the issue and entries will appear here.",
    "exported": "Logs exported."
  }
```

In `src/i18n/ru.json`, mirror with Russian:

```json
  "logs": {
    "diagnostics": "Диагностика",
    "testEleven": "Тест ElevenLabs",
    "testGemini": "Тест Gemini",
    "testing": "Проверка…",
    "pass": "OK",
    "fail": "Ошибка",
    "validate": "Проверка ключа",
    "synth": "Синтез",
    "tts": "Озвучка",
    "noKey": "ключ не задан",
    "filterLevel": "Уровень",
    "searchPlaceholder": "Фильтр логов…",
    "clear": "Очистить",
    "export": "Выгрузить",
    "openFolder": "Открыть папку",
    "follow": "Следить",
    "empty": "Логов пока нет. Воспроизведите проблему — записи появятся здесь.",
    "exported": "Логи выгружены."
  }
```

Also add `"logs": "Логи"` to `nav` and `"logs": "Логи"` to `screen` in `ru.json`, and `"logs": "Logs"` likewise in `en.json` (per the first sentence).

- [ ] **Step 5: Create the Logs screen**

Create `src/screens/LogsScreen.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@heroui/react";
import { ipc, type ElevenSelfTest, type GeminiSelfTest } from "../lib/ipc";
import { filterLogs, formatLogLine, LEVELS, type LogEntry } from "../lib/logs";
import { Banner } from "../components/Banner";

const UI_CAP = 3000;

const LEVEL_COLOR: Record<string, string> = {
  ERROR: "text-danger",
  WARN: "text-amber-600",
  INFO: "text-cobalt",
  DEBUG: "text-muted",
  TRACE: "text-muted",
};

export function LogsScreen() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [minLevel, setMinLevel] = useState<string>("TRACE");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const [eleven, setEleven] = useState<ElevenSelfTest | null>(null);
  const [gemini, setGemini] = useState<GeminiSelfTest | null>(null);
  const [testing, setTesting] = useState<"" | "eleven" | "gemini">("");
  const [toast, setToast] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Seed from the ring snapshot, then live-append from the event.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;
    void ipc.logsGet().then((seed) => {
      if (mounted) setEntries(seed.slice(-UI_CAP));
    });
    void ipc.onLogEntry((e) => {
      setEntries((prev) => {
        const next = prev.length >= UI_CAP ? [...prev.slice(1), e] : [...prev, e];
        return next;
      });
    }).then((un) => {
      unlisten = un;
    });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  // Auto-scroll to bottom while "follow" is on.
  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, follow]);

  const visible = filterLogs(entries, { minLevel, query });

  const runEleven = useCallback(async () => {
    setTesting("eleven");
    try {
      setEleven(await ipc.elevenlabsSelfTest());
    } finally {
      setTesting("");
    }
  }, []);

  const runGemini = useCallback(async () => {
    setTesting("gemini");
    try {
      setGemini(await ipc.geminiSelfTest());
    } finally {
      setTesting("");
    }
  }, []);

  async function handleExport(format: "txt" | "json") {
    const path = await save({
      defaultPath: `live-translator-logs.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!path) return;
    await ipc.logsExport(path, format);
    setToast(t("logs.exported"));
    setTimeout(() => setToast(null), 2500);
  }

  async function handleOpenFolder() {
    const dir = await ipc.logsDir();
    if (dir) await revealItemInDir(dir);
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 w-full max-w-[1100px] mx-auto px-6 py-7 flex flex-col gap-5 lt-screen-in">
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink leading-none shrink-0">
          {t("screen.logs")}
        </h1>

        {/* ---- Diagnostics card ---- */}
        <div className="shrink-0 rounded-card border border-hairline bg-surface p-4 flex flex-col gap-3">
          <h2 className="text-label font-semibold text-ink-2">{t("logs.diagnostics")}</h2>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outline" isDisabled={testing !== ""} onPress={() => void runEleven()}>
              {testing === "eleven" ? t("logs.testing") : t("logs.testEleven")}
            </Button>
            <Button size="sm" variant="outline" isDisabled={testing !== ""} onPress={() => void runGemini()}>
              {testing === "gemini" ? t("logs.testing") : t("logs.testGemini")}
            </Button>
          </div>
          {eleven && (
            <div className="text-caption font-mono text-ink-2 flex flex-col gap-1">
              <ProbeRow label={t("logs.validate")} ok={eleven.validate.ok} detail={probeText(eleven.validate)} t={t} />
              <ProbeRow label={t("logs.synth")} ok={eleven.synth.ok} detail={probeText(eleven.synth)} t={t} />
            </div>
          )}
          {gemini && (
            <div className="text-caption font-mono text-ink-2 flex flex-col gap-1">
              <ProbeRow label={t("logs.validate")} ok={gemini.validate.ok} detail={probeText(gemini.validate)} t={t} />
              <ProbeRow label={t("logs.tts")} ok={gemini.tts.ok} detail={probeText(gemini.tts)} t={t} />
            </div>
          )}
        </div>

        {/* ---- Toolbar ---- */}
        <div className="shrink-0 flex flex-wrap items-center gap-3">
          <select
            aria-label={t("logs.filterLevel")}
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value)}
            className="h-9 px-2 rounded-input border border-hairline bg-surface text-caption text-ink"
          >
            {[...LEVELS].reverse().map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
          <input
            type="search"
            placeholder={t("logs.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 min-w-[160px] h-9 px-3 rounded-input border border-hairline bg-surface text-caption text-ink placeholder:text-muted outline-none focus:border-cobalt/50"
          />
          <label className="flex items-center gap-1.5 text-caption text-muted">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            {t("logs.follow")}
          </label>
          <Button size="sm" variant="outline" onPress={() => void handleExport("txt")}>{t("logs.export")} .txt</Button>
          <Button size="sm" variant="outline" onPress={() => void handleExport("json")}>{t("logs.export")} .json</Button>
          <Button size="sm" variant="outline" onPress={() => void handleOpenFolder()}>{t("logs.openFolder")}</Button>
          <Button size="sm" variant="outline" onPress={() => { ipc.logsClear(); setEntries([]); }}>{t("logs.clear")}</Button>
        </div>

        {toast && (
          <div className="shrink-0"><Banner tone="ok" description={toast} onDismiss={() => setToast(null)} /></div>
        )}

        {/* ---- Console list ---- */}
        <div
          ref={scrollRef}
          onWheel={() => setFollow(false)}
          className="flex-1 min-h-0 overflow-y-auto rounded-card border border-hairline bg-paper p-3 font-mono text-code leading-relaxed"
        >
          {visible.length === 0 ? (
            <p className="text-muted text-caption p-4">{t("logs.empty")}</p>
          ) : (
            visible.map((e) => (
              <div key={e.seq} className="whitespace-pre-wrap break-words py-0.5 border-b border-hairline/40">
                <span className="text-muted">{e.ts}</span>{"  "}
                <span className={LEVEL_COLOR[e.level.toUpperCase()] ?? "text-ink"}>{e.level.padEnd(5)}</span>{"  "}
                <span className="text-ink-2">{e.target}</span>{"  "}
                <span className="text-ink">{e.message}</span>
                {Object.keys(e.fields).length > 0 && (
                  <span className="text-muted">{"  | " + Object.entries(e.fields).map(([k, v]) => `${k}=${String(v)}`).join(" ")}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function probeText(p: { ok: boolean; httpStatus: number | null; code: string | null; detail: string }): string {
  const status = p.httpStatus != null ? `HTTP ${p.httpStatus} ` : "";
  const code = p.code ? `[${p.code}] ` : "";
  return `${status}${code}${p.detail}`;
}

function ProbeRow({ label, ok, detail, t }: { label: string; ok: boolean; detail: string; t: (k: string) => string }) {
  return (
    <div className="flex items-start gap-2">
      <span className={ok ? "text-ok-deep" : "text-danger"}>{ok ? "✓" : "✗"}</span>
      <span className="text-ink shrink-0">{label}:</span>
      <span className="text-muted">{ok ? t("logs.pass") : t("logs.fail")} — {detail}</span>
    </div>
  );
}
```

> If `@heroui/react` `Button` `variant="outline"` is not valid in this version, match the variants already used in `HistoryScreen.tsx` (`"outline"`, `"danger"` are used there — `outline` is valid).

- [ ] **Step 6: Route it in `App.tsx`**

In `src/App.tsx`, import the screen and add the case. Add the import near the others:

```tsx
import { LogsScreen } from "./screens/LogsScreen";
```

In `renderScreen()`'s `switch`, add before `case "settings"` (to mirror nav order) or anywhere in the switch:

```tsx
      case "logs":
        return <LogsScreen />;
```

- [ ] **Step 7: Add a render-smoke test**

In `src/screens/__tests__/render-smoke.test.tsx`, follow the existing pattern for the other screens and add a case that renders `<LogsScreen />`. First open the file to match its exact harness, then add:

```tsx
import { LogsScreen } from "../LogsScreen";
// ... within the existing describe/it table or as a new it():
it("renders LogsScreen without crashing", () => {
  render(<LogsScreen />);
});
```

If the smoke test mocks `../lib/ipc`, ensure the mock includes `logsGet` (resolves `[]`), `onLogEntry` (resolves a no-op unlisten), `elevenlabsSelfTest`, `geminiSelfTest`, `logsClear`, `logsExport`, `logsDir`. Mock `@tauri-apps/plugin-dialog` and `@tauri-apps/plugin-opener` if not already globally mocked.

- [ ] **Step 8: Run the full frontend suite**

Run: `npm test`
Expected: PASS (logs unit tests + render smokes).

- [ ] **Step 9: Typecheck / build the frontend**

Run: `npm run build`
Expected: `tsc` clean, vite build succeeds.

- [ ] **Step 10: Commit**

```bash
git add src/components/Icons.tsx src/components/Sidebar.tsx src/App.tsx src/stores/app.ts src/i18n/en.json src/i18n/ru.json src/screens/LogsScreen.tsx src/screens/__tests__/render-smoke.test.tsx
git commit -m "feat(logs): Logs screen with diagnostics, console list, export"
```

---

## Final verification

- [ ] **Backend:** `cargo test --manifest-path src-tauri/Cargo.toml --lib` → all pass.
- [ ] **Frontend:** `npm test` → all pass; `npm run build` → clean.
- [ ] **Manual (via `npm run tauri dev`):** open **Logs** in the sidebar; confirm entries stream live; record a voice message and watch `voice` stage logs appear; click **Test ElevenLabs** with a wrong/blocked key and confirm the exact code (`detected_unusual_activity`/`voice_not_found`/etc.) shows both in the verdict card and the log; **Export** `.txt` and `.json` and open them; **Open folder** reveals the `.jsonl`.

## Self-Review (filled at plan time)

- **Spec coverage:** capture layer (T1–3), file+ring+emit (T2–3), commands (T3), pipeline detail logs (T5), ElevenLabs classifier/taxonomy (T4), self-test ElevenLabs+Gemini (T4–5), Logs page + filter/export/open/clear (T6–7), i18n + nav (T7), tests (every task). ✓
- **Placeholder scan:** no TBD/TODO; all code shown. ✓
- **Type consistency:** `LogEntry`, `ElevenProbe`/`GeminiProbe` (Rust) ↔ `ProbeResult` (TS, same shape), `ElevenSelfTest`/`GeminiSelfTest` camelCase match; `filterLogs`/`formatLogLine`/`levelRank` names consistent T6↔T7. ✓
