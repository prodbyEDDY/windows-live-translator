# Reliability Hardening and Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the confirmed crash, shutdown, concurrency, persistence, and silent-failure risks, then add a privacy-safe 24-hour diagnostics page and exportable text bundle.

**Architecture:** Introduce a generation-aware live lifecycle coordinator and cancellation paths that are independent from congested audio queues. Add a best-effort rotating diagnostics service before changing failure paths, then harden voice jobs, settings, frontend initialization, and shutdown around explicit state and bounded work.

**Tech Stack:** Rust 2021, Tauri 2, Tokio, WASAPI, tracing, rusqlite, React 19, TypeScript, Zustand, Vitest.

**Specification:** `docs/superpowers/specs/2026-06-15-reliability-diagnostics-design.md`

---

## File Map

**Create**

- `src-tauri/src/diagnostics.rs` - sanitized 24-hour rotating diagnostic journal, read/filter/export helpers, and redaction tests.
- `src-tauri/src/live_lifecycle.rs` - generation-aware `Off/Starting/Running/Stopping` coordinator with pure transition tests.
- `src/lib/diagnostics.ts` - frontend diagnostic types and filtering helpers.
- `src/screens/DiagnosticsScreen.tsx` - diagnostic record list, filters, privacy notice, refresh, and export.
- `src/lib/__tests__/diagnostics.test.ts` - frontend diagnostics helper tests.
- `docs/testing/reliability-release-checklist.md` - automated and user-operated Windows release gates.

**Modify**

- `src-tauri/src/lib.rs` - initialize diagnostics first, manage new state, recover startup failures, and bound exit teardown.
- `src-tauri/src/ipc.rs` - lifecycle coordination, recorder status/stop, voice job limits/cancellation, diagnostic commands.
- `src-tauri/src/live_ctrl.rs` - nonblocking audio submission, worker health propagation, bounded stop, generation-tagged events.
- `src-tauri/src/gemini/live.rs` - cancellation token, send/close deadlines, nonblocking enqueue result.
- `src-tauri/src/audio/capture.rs` - terminal worker status.
- `src-tauri/src/audio/playback.rs` - terminal worker status and queue cleanup.
- `src-tauri/src/store/settings.rs` - serialize the entire patch transaction and recover malformed files.
- `src-tauri/src/store/history.rs` - transactional clear behavior and startup recovery support.
- `src-tauri/src/store/mod.rs` - expose new store helpers if needed.
- `src/stores/app.ts` - retryable initialization, lifecycle serialization, ordered settings patches, recorder state.
- `src/lib/ipc.ts` - generation-aware event types and new recorder/diagnostics IPC.
- `src/App.tsx` - diagnostics route and startup retry state.
- `src/components/Sidebar.tsx` - diagnostics navigation and shared version source.
- `src/components/Icons.tsx` - diagnostics icon.
- `src/screens/VoiceScreen.tsx` - backend-authoritative recorder state and navigation-safe behavior.
- `src/screens/HistoryScreen.tsx` - visible errors, stale-request suppression, correct clear semantics.
- `src/i18n/en.json` and `src/i18n/ru.json` - diagnostics, retry, lifecycle, and recovery copy.
- Existing Rust and Vitest test files - focused regressions and corrected `duckLevel` fixtures.
- Version manifests and lockfiles - final patch-version bump only after all gates pass.

### Task 1: Diagnostic Journal Core

**Files:**
- Create: `src-tauri/src/diagnostics.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/store/mod.rs`

- [ ] **Step 1: Write failing redaction, retention, and bounded-read tests**

Add tests that construct a temporary journal and assert:

```rust
assert!(!sanitize_message("Bearer secret-token").contains("secret-token"));
assert!(!sanitize_message(r"C:\Users\Alice\private\clip.wav").contains("Alice"));
assert!(!sanitize_fields(json!({"transcript":"hello"})).to_string().contains("hello"));
assert_eq!(journal.read_recent(Filter::default(), 2)?.len(), 2);
assert!(journal.prune(now)?.iter().all(|entry| entry.timestamp >= now - Duration::hours(24)));
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml diagnostics -- --nocapture
```

Expected: compile failure because `diagnostics` does not exist.

- [ ] **Step 3: Implement the journal**

Implement these public interfaces:

```rust
#[derive(Clone)]
pub struct DiagnosticJournal {
    dir: Arc<PathBuf>,
    write_lock: Arc<Mutex<()>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticRecord {
    pub timestamp_utc: String,
    pub timestamp_local: String,
    pub level: DiagnosticLevel,
    pub subsystem: String,
    pub event: String,
    pub message: String,
    pub fields: serde_json::Value,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticFilter {
    pub levels: Option<Vec<DiagnosticLevel>>,
    pub subsystem: Option<String>,
    pub limit: Option<usize>,
}

impl DiagnosticJournal {
    pub fn open(dir: PathBuf) -> anyhow::Result<Self>;
    pub fn record(&self, level: DiagnosticLevel, subsystem: &str, event: &str, message: &str, fields: serde_json::Value);
    pub fn read_recent(&self, filter: DiagnosticFilter) -> anyhow::Result<Vec<DiagnosticRecord>>;
    pub fn export_text(&self, version: &str) -> anyhow::Result<String>;
    pub fn prune(&self) -> anyhow::Result<()>;
}
```

Use one UTC-date JSONL file per day, a 24-hour timestamp filter, a 10 MiB defensive directory cap, and a default UI limit of 1,000 records. Logging must swallow its own write errors after forwarding one warning to `tracing`.

- [ ] **Step 4: Run focused tests**

Run the Task 1 command. Expected: all diagnostic tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/src/diagnostics.rs src-tauri/src/lib.rs src-tauri/src/store/mod.rs
git commit -m "feat: add privacy-safe diagnostic journal"
```

### Task 2: Diagnostics IPC and Page

**Files:**
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/ipc.ts`
- Create: `src/lib/diagnostics.ts`
- Create: `src/lib/__tests__/diagnostics.test.ts`
- Create: `src/screens/DiagnosticsScreen.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/Icons.tsx`
- Modify: `src/i18n/en.json`
- Modify: `src/i18n/ru.json`

- [ ] **Step 1: Write failing frontend helper and render tests**

Test newest-first ordering, filter serialization, empty state, failed load state, and export invocation. Use representative records that contain no user content.

- [ ] **Step 2: Run focused Vitest tests and verify failure**

```powershell
npm test -- --run src/lib/__tests__/diagnostics.test.ts src/screens/__tests__/render-smoke.test.tsx
```

Expected: module/route failures.

- [ ] **Step 3: Add diagnostic commands**

Add:

```rust
#[tauri::command]
pub fn diagnostics_list(
    state: State<'_, AppState>,
    filter: DiagnosticFilter,
) -> Result<Vec<DiagnosticRecord>, String>;

#[tauri::command]
pub fn diagnostics_export(
    state: State<'_, AppState>,
    dest: String,
) -> Result<(), String>;

#[tauri::command]
pub fn diagnostics_frontend_event(
    state: State<'_, AppState>,
    level: DiagnosticLevel,
    event: String,
    message: String,
) -> Result<(), String>;
```

`diagnostics_export` writes the already-sanitized bundle to the user-selected path. It must reject a destination that is not a regular `.txt` path.

- [ ] **Step 4: Add the page and frontend error bridge**

Extend `Screen` with `"diagnostics"`. Register `window.error` and `unhandledrejection` listeners that log sanitized error class/message only. The page shows level/subsystem filters, Refresh, Export, privacy text, and a capped list.

- [ ] **Step 5: Run focused tests and frontend build**

Run:

```powershell
npm test -- --run src/lib/__tests__/diagnostics.test.ts src/screens/__tests__/render-smoke.test.tsx
npm run build
```

Expected: tests and TypeScript/Vite build pass.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs src/lib/ipc.ts src/lib/diagnostics.ts src/lib/__tests__/diagnostics.test.ts src/screens/DiagnosticsScreen.tsx src/App.tsx src/components/Sidebar.tsx src/components/Icons.tsx src/i18n/en.json src/i18n/ru.json
git commit -m "feat: add diagnostics page and log export"
```

### Task 3: Generation-Aware Live Lifecycle

**Files:**
- Create: `src-tauri/src/live_lifecycle.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/live_ctrl.rs`
- Modify: `src/lib/ipc.ts`
- Modify: `src/stores/app.ts`
- Modify: `src/stores/__tests__/app.test.ts`

- [ ] **Step 1: Write failing pure lifecycle tests**

Cover:

```rust
assert!(coordinator.begin_start().is_ok());
assert_eq!(coordinator.begin_start(), Err(LifecycleError::Busy));
assert_eq!(coordinator.begin_stop(old_generation), StopDecision::Stale);
assert_eq!(coordinator.finish_stop(current_generation), LifecyclePhase::Off);
```

Add frontend tests proving Start is blocked during Stop and old-generation `off` events are ignored.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml live_lifecycle -- --nocapture
npm test -- --run src/stores/__tests__/app.test.ts
```

- [ ] **Step 3: Implement coordinator**

Use:

```rust
pub enum LiveSlot {
    Off { next_generation: u64 },
    Starting { generation: u64 },
    Running { generation: u64, controller: LiveController },
    Stopping { generation: u64 },
}

pub struct LiveCoordinator {
    slot: tokio::sync::Mutex<LiveSlot>,
    stopped: tokio::sync::Notify,
}
```

Start reserves a generation before blocking setup. Stop transitions to `Stopping`, owns teardown, and publishes `Off` only for the same generation. Repeated Stop waits on `Notify` with a deadline. All `live:state`, `live:transcript`, `live:levels`, `live:cost`, and `live:auto_stop` payloads carry `generation`.

- [ ] **Step 4: Update frontend lifecycle**

Replace the single `starting` flag with:

```ts
type LiveOperation = "idle" | "starting" | "stopping";
```

Do not optimistically emit `off`. Persist history, request Stop, and clear duration/cost only after authoritative completion. Ignore events whose generation is older than the active generation.

- [ ] **Step 5: Run focused tests**

Run Task 3 commands. Expected: pass.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/live_lifecycle.rs src-tauri/src/lib.rs src-tauri/src/ipc.rs src-tauri/src/live_ctrl.rs src/lib/ipc.ts src/stores/app.ts src/stores/__tests__/app.test.ts
git commit -m "fix: serialize live session lifecycle"
```

### Task 4: Cancellable WebSocket and Nonblocking Audio Submission

**Files:**
- Modify: `src-tauri/src/gemini/live.rs`
- Modify: `src-tauri/src/live_ctrl.rs`

- [ ] **Step 1: Write failing async tests**

Add mocked WebSocket tests for Stop during setup send, Stop during buffered resend, a peer that never reads, and close timeout. Add a full-channel test proving audio submission returns immediately with `Dropped`.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml gemini::live -- --nocapture
```

- [ ] **Step 3: Implement independent cancellation and deadlines**

Use `tokio_util::sync::CancellationToken` and:

```rust
pub enum AudioSubmit {
    Accepted,
    DroppedFull,
    Closed,
}

pub fn try_send_audio(&self, pcm16: Vec<i16>) -> AudioSubmit;
pub async fn stop(&self, timeout: Duration) -> StopOutcome;
```

Wrap setup/audio/resend/close sends in `tokio::select!` with cancellation and a finite timeout. Preserve the existing reconnect cap and resume-handle behavior.

- [ ] **Step 4: Replace blocking bridge submission**

The bridge uses `try_send_audio`, increments an atomic dropped counter, and emits one rate-limited warning/diagnostic summary per interval.

- [ ] **Step 5: Run focused tests**

Expected: all Gemini live tests pass, including existing reconnect tests.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/gemini/live.rs src-tauri/src/live_ctrl.rs
git commit -m "fix: bound websocket shutdown and audio backpressure"
```

### Task 5: Audio Worker Health and Bounded Controller Stop

**Files:**
- Modify: `src-tauri/src/audio/capture.rs`
- Modify: `src-tauri/src/audio/playback.rs`
- Modify: `src-tauri/src/live_ctrl.rs`
- Modify: `src-tauri/src/ipc.rs`

- [ ] **Step 1: Write failing worker-status tests**

Extract pure status aggregation and assert that an unexpected required-worker exit becomes a terminal session failure, while a requested stop does not.

- [ ] **Step 2: Run focused Rust tests and verify failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml worker_health -- --nocapture
```

- [ ] **Step 3: Add health channels**

Capture and playback handles expose terminal status:

```rust
pub enum WorkerExit {
    Requested,
    DeviceLost(String),
    Failed(String),
    Panicked,
}
```

Clear playback `queued_samples` on every exit. Convert bridge and ducking thread `expect` calls into propagated startup errors.

- [ ] **Step 4: Coordinate failure and stop**

`LiveController` monitors required workers. Unexpected failure emits a sanitized diagnostic, a generation-tagged error state, and requests lifecycle Stop. Controller stop signals all workers first, then joins each with bounded helper threads/deadlines and records any timeout.

- [ ] **Step 5: Run Rust tests and checks**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/audio/capture.rs src-tauri/src/audio/playback.rs src-tauri/src/live_ctrl.rs src-tauri/src/ipc.rs
git commit -m "fix: surface audio worker failures"
```

### Task 6: Recorder Ownership and Voice Job Limits

**Files:**
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/voice/pipeline.rs`
- Modify: `src/lib/ipc.ts`
- Modify: `src/stores/app.ts`
- Modify: `src/screens/VoiceScreen.tsx`
- Modify: `src/lib/__tests__/voice.test.ts`
- Modify: `src/stores/__tests__/app.test.ts`

- [ ] **Step 1: Write failing recorder/job tests**

Test backend recorder status, idempotent cancel on exit, maximum import size, bounded concurrent imports, and cancellation before history clear.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml voice -- --nocapture
npm test -- --run src/lib/__tests__/voice.test.ts src/stores/__tests__/app.test.ts
```

- [ ] **Step 3: Add application-level voice state**

Manage:

```rust
pub struct VoiceJobs {
    semaphore: Arc<Semaphore>,
    cancellation: Mutex<HashMap<i64, CancellationToken>>,
}
```

Add `voice_record_status` and `voice_record_cancel`. Keep the recorder in backend state until Stop/Cancel consumes it. Use a 100 MiB input limit, at most two processing jobs, `spawn_blocking` for metadata/copy/read, and explicit `file_too_large`/`busy` errors.

- [ ] **Step 4: Make history clear cancel and drain**

Cancel active voice tokens, wait for their guarded critical sections to finish, then clear rows/files. Pipelines check cancellation before every DB/file mutation.

- [ ] **Step 5: Make UI recorder state authoritative**

Store recorder status globally, query it on entering Voice, preserve the timer start timestamp, and stop/cancel during application exit. Navigation alone must not orphan control of an active recorder.

- [ ] **Step 6: Run focused tests**

Expected: pass.

- [ ] **Step 7: Commit**

```powershell
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs src-tauri/src/voice/pipeline.rs src/lib/ipc.ts src/stores/app.ts src/screens/VoiceScreen.tsx src/lib/__tests__/voice.test.ts src/stores/__tests__/app.test.ts
git commit -m "fix: harden recorder and voice jobs"
```

### Task 7: Settings Transaction and Retryable Frontend Initialization

**Files:**
- Modify: `src-tauri/src/store/settings.rs`
- Modify: `src/stores/app.ts`
- Modify: `src/stores/__tests__/app.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/i18n/en.json`
- Modify: `src/i18n/ru.json`

- [ ] **Step 1: Write failing concurrency and retry tests**

Rust: two concurrent patches to different keys must both survive and leave valid JSON without temp-file races.

Frontend: a failed first `init()` can retry; partial listener registration is cleaned up; an older failed settings patch cannot roll back a newer successful patch.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml store::settings -- --nocapture
npm test -- --run src/stores/__tests__/app.test.ts
```

- [ ] **Step 3: Serialize settings transaction**

Hold the settings mutex across merge, validation, atomic write, and in-memory replacement. This operation is low-frequency and correctness is more important than avoiding the short filesystem critical section. Use a unique temp file in the same directory if the helper remains callable outside the lock.

- [ ] **Step 4: Implement frontend revisions**

Track `initState: "idle" | "loading" | "ready" | "error"` and a settings revision counter. Listener setup uses sequential registration inside `try`, collecting and cleaning each unlisten function on failure. Expose `retryInit`.

- [ ] **Step 5: Add startup retry UI**

When initialization fails, render a recoverable error with Retry rather than an indefinite empty/loading state.

- [ ] **Step 6: Run focused tests and build**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml store::settings
npm test -- --run src/stores/__tests__/app.test.ts
npm run build
```

- [ ] **Step 7: Commit**

```powershell
git add src-tauri/src/store/settings.rs src/stores/app.ts src/stores/__tests__/app.test.ts src/App.tsx src/i18n/en.json src/i18n/ru.json
git commit -m "fix: serialize settings and retry initialization"
```

### Task 8: History Consistency and UI Error Handling

**Files:**
- Modify: `src-tauri/src/store/history.rs`
- Modify: `src/screens/HistoryScreen.tsx`
- Modify: `src/lib/history.ts`
- Modify: `src/lib/__tests__/history.test.ts`
- Modify: `src/stores/app.ts`
- Modify: `src/stores/__tests__/app.test.ts`

- [ ] **Step 1: Write failing tests**

Cover newest-first voice ordering, clear failure preserving UI state, stale search response suppression, visible load failure, and no success toast on backend failure.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
npm test -- --run src/lib/__tests__/history.test.ts src/stores/__tests__/app.test.ts
cargo test --manifest-path src-tauri/Cargo.toml store::history -- --nocapture
```

- [ ] **Step 3: Implement request sequencing and clear semantics**

Use monotonically increasing request IDs for calls and voice searches. Only the latest request may commit results/loading state. Catch errors and show a retryable banner. Mutate local/store history only after `historyClear()` succeeds.

- [ ] **Step 4: Correct voice ordering and fixtures**

Remove the frontend `.reverse()` because SQLite already returns `ORDER BY id DESC`. Change all test fixtures to `duckLevel` values in `0.0..=1.0`.

- [ ] **Step 5: Run focused tests**

Expected: pass.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/store/history.rs src/screens/HistoryScreen.tsx src/lib/history.ts src/lib/__tests__/history.test.ts src/stores/app.ts src/stores/__tests__/app.test.ts src/lib/__tests__/wizard.test.ts
git commit -m "fix: make history operations consistent"
```

### Task 9: Startup Recovery and Graceful Application Exit

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/store/settings.rs`
- Modify: `src-tauri/src/store/history.rs`
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src/stores/app.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write failing recovery/shutdown helper tests**

Test malformed-settings backup naming, startup failure classification, and teardown deadline outcome without real audio hardware.

- [ ] **Step 2: Run focused tests and verify failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml startup -- --nocapture
```

- [ ] **Step 3: Implement recoverable startup state**

Open diagnostics immediately after resolving/creating app-data. Back up malformed settings before defaults. Convert settings/history setup errors into a managed `StartupStatus` exposed through IPC when possible, with diagnostic records and actionable frontend copy.

- [ ] **Step 4: Implement bounded exit preparation**

Add a frontend `beforeunload`/Tauri close flow that requests `prepare_exit`: save meaningful transcript, cancel recorder, and stop live session. Backend exit remains independently safe and caps teardown wait. Never block the Tauri event loop on an unbounded join.

- [ ] **Step 5: Run Rust/frontend gates**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
npm test
npm run build
```

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/lib.rs src-tauri/src/store/settings.rs src-tauri/src/store/history.rs src-tauri/src/ipc.rs src/stores/app.ts src/App.tsx
git commit -m "fix: recover startup and bound app shutdown"
```

### Task 10: Full Regression Audit and Release Candidate

**Files:**
- Create: `docs/testing/reliability-release-checklist.md`
- Modify: `docs/testing/stage1-e2e-checklist.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/tauri.conf.json`
- Modify: version display source in frontend if still hardcoded

- [ ] **Step 1: Re-run static audit**

Search for remaining panic/silent failure/blocking hazards:

```powershell
rg -n "unwrap\\(|expect\\(|panic!|blocking_send|block_on|catch \\{|let _ =|std::fs::read|std::fs::copy" src-tauri/src src
```

Classify every hit. Fix only actionable production hazards covered by the specification, with a regression test before each correction.

- [ ] **Step 2: Run all automated gates**

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: all commands exit `0`; no ignored failure is counted as verification.

- [ ] **Step 3: Write the manual Windows checklist**

Create the exact 11-scenario checklist from the specification, including expected state, failure indicators, log-export instructions, and a privacy inspection step.

- [ ] **Step 4: Bump one patch version consistently**

Read the current version at execution time and increment the patch component once in all manifests/lockfiles and the UI version source.

- [ ] **Step 5: Build the production installer**

```powershell
npm run tauri build
```

Expected: NSIS installer under `src-tauri/target/release/bundle/nsis/` and any configured bundle artifacts. Record artifact names and SHA-256 hashes.

- [ ] **Step 6: Commit the release candidate**

```powershell
git add docs/testing/reliability-release-checklist.md docs/testing/stage1-e2e-checklist.md package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src
git commit -m "chore: prepare reliability release candidate"
```

- [ ] **Step 7: User hardware gate**

Provide the installer path/hash and checklist. Wait for the user to report pass/fail. Any failure returns to the relevant task with a regression test.

- [ ] **Step 8: Final verification after hardware pass**

Re-run the full automated gates and `git diff --check`. Confirm the worktree contains only intended release artifacts/source changes.

- [ ] **Step 9: Push and release**

Push the verified `main`, create an annotated version tag, push the tag, and publish a GitHub release containing installer artifacts, hashes, release notes, and known limitations. Do not perform this step before the user hardware gate passes.

