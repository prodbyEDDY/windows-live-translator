# Reliability Hardening and Diagnostics Design

**Date:** 2026-06-15

**Status:** Approved

## Goal

Remove the identified crash, shutdown, concurrency, persistence, and silent-failure risks without changing the product's working translation behavior. Add a privacy-safe diagnostics page that retains detailed technical logs for 24 hours and exports them as a text file.

## Scope

This stabilization release covers:

- live-session Start, Stop, auto-stop, and application-exit coordination;
- bounded and cancellable WebSocket/audio shutdown;
- recording, voice import, history, settings, and application initialization failures;
- propagation of background audio failures to the UI and diagnostic log;
- a new Diagnostics page with filtering, refresh, and one-click text export;
- automated verification, production installer creation, and a user-executed Windows audio smoke test.

It does not redesign the translation pipeline, change translation prompts, add cloud telemetry, upload logs automatically, or store user speech content in diagnostics.

## Confirmed Problems

The current `main` already fixes several earlier findings, including `duckLevel` units, transcript memory bounds, stale-device fallback for microphone/headphone output, and playback priming. The remaining work is:

1. `live_stop` removes the controller before teardown finishes, allowing a new Start to overlap the old teardown. A late `off` event can overwrite the new session state.
2. Start holds the live mutex across blocking initialization, while panic and join-error paths do not consistently restore the idle state and passthrough.
3. WebSocket setup, buffered-audio resend, normal sends, and close operations do not all have cancellation or operation deadlines. Stop can wait indefinitely.
4. Capture-to-WebSocket forwarding can block when the async command channel fills, coupling an audio thread to network backpressure.
5. Playback and capture worker failures are mainly logged locally; the controller and UI can continue showing a running session after a pipeline has died.
6. Application exit performs synchronous live/audio teardown on the Tauri event loop and does not persist an active transcript.
7. Voice recording state is local to `VoiceScreen`. Navigating away or exiting can leave the backend recorder active and inaccessible from the UI.
8. Voice import reads complete files in an async task, has no explicit file-size or concurrency limit, and can create excessive memory/runtime pressure.
9. Clearing history can race with background voice pipelines and the UI reports success even when the backend clear operation fails.
10. Settings patches clone state, release the lock, write through a shared temporary path, and later replace memory. Concurrent patches can lose updates or race the temporary file.
11. Frontend initialization marks itself complete before initial IPC succeeds. A transient failure can leave the application permanently uninitialized.
12. Event subscription setup can partially succeed and then reject without cleaning already-created listeners.
13. Frontend Start, Stop, and auto-stop are not represented by one serialized lifecycle. Optimistic `off` state can hide failed teardown and permit re-entry.
14. Optimistic settings rollback can overwrite a newer successful patch.
15. History loading has unhandled errors and stale search responses; history clear hides failures; voice ordering is reversed despite the backend already returning newest first.
16. Settings and history startup failures can terminate application construction without a recoverable, user-facing diagnostic path.
17. Thread creation still contains panic-producing `expect` calls in live audio setup.
18. Several test fixtures use outdated `duckLevel` values and therefore do not protect the current `0.0..=1.0` contract.

## Architecture

### 1. Live Lifecycle Coordinator

Replace `Mutex<Option<LiveController>>` as the lifecycle model with an explicit coordinator state:

```text
Off -> Starting -> Running -> Stopping -> Off
```

Only the coordinator may transition this state. Each session gets a monotonically increasing generation ID. Backend events include that ID, and the frontend ignores events belonging to an older generation.

Start reserves `Starting`, releases the state lock while blocking resources are created, and then commits `Running` only if the same generation is still current. Any failure or panic result performs one cleanup path, restores passthrough, records diagnostics, and transitions to `Off`.

Stop changes `Running` or `Starting` to `Stopping` before removing resources. A new Start is rejected until teardown reaches `Off`. Repeated Stop and auto-stop requests join the same logical teardown and remain idempotent.

### 2. Bounded Cancellation and Backpressure

Live sessions receive a cancellation token independent from the audio command queue. WebSocket connect, setup send, buffered resend, audio send, and close operations use finite deadlines and observe cancellation.

Audio producers never wait indefinitely for network capacity. They use bounded non-blocking submission with an explicit drop policy and counters. Dropped chunks generate rate-limited warnings rather than one log entry per chunk.

Worker threads report terminal status over a dedicated health channel. Unexpected capture, playback, bridge, ducking, or WebSocket termination triggers coordinated session shutdown and a visible error. Thread-spawn failures return errors instead of panicking.

### 3. Graceful Shutdown and Recovery

Normal application exit requests asynchronous teardown and waits only for a fixed deadline. If a component exceeds the deadline, the application records the timeout and continues shutdown. Ducking restoration remains best-effort and crash-recoverable.

The frontend requests transcript persistence before final exit when a meaningful live transcript exists. Backend shutdown still remains safe if the frontend is unavailable or already gone.

Settings and history startup failures are separated:

- malformed settings are backed up and defaults are loaded;
- unrecoverable settings I/O errors open a visible startup error state;
- SQLite open/migration failures are logged and shown with recovery guidance;
- diagnostics remains available whenever the application can create its app-data directory.

### 4. Voice and History Operations

Recorder ownership moves to application-level state. The UI queries recorder status instead of assuming local state is authoritative. Navigating away does not orphan the recorder; application exit stops it. The existing five-minute recording cap remains.

Voice imports validate metadata before copying, enforce a documented maximum size, use blocking-task boundaries for filesystem reads/copies, and run through a small concurrency limiter. Background pipelines receive cancellation markers. History clear first cancels and drains affected jobs, then removes rows/files.

The UI only reports a successful history clear after backend success. Loading errors are visible and recoverable. Search requests use request IDs or abort semantics so older responses cannot overwrite newer results.

### 5. Settings and Frontend State

Settings merge, validation, persistence, and in-memory replacement are serialized as one transaction. The store continues using atomic temp-file replacement, but each write cannot race another patch.

Frontend settings updates use a serialized queue or patch revision IDs. A failed older request cannot roll back a newer value.

Application initialization is retryable. Subscription registration cleans up partial success on failure, and listeners are installed only once. A visible retry action is provided when required startup IPC calls fail.

The frontend mirrors the backend lifecycle with `starting`, `running`, and `stopping` behavior. Start is unavailable during Stop, Stop is idempotent, and the UI does not claim `off` until authoritative teardown completes. History persistence errors are surfaced without preventing Stop.

## Diagnostics

### Storage

Diagnostics use local rotating UTF-8 text/JSON-lines files separate from `history.db`. This keeps diagnostics readable when the user-history database is unavailable and avoids making SQLite a dependency of crash reporting.

Files live under the application data directory in a dedicated `logs` directory. Records older than 24 hours are deleted at startup and periodically while the application is running. Storage is bounded by both age and a defensive total-size cap.

Each record contains:

- UTC and local timestamp;
- severity: `INFO`, `WARN`, or `ERROR`;
- subsystem;
- event name;
- sanitized message;
- optional sanitized structured fields;
- application version and session generation where relevant.

### Privacy and Redaction

Diagnostics must never contain:

- API keys or authorization headers;
- audio data;
- transcripts, translations, prompts, or synthesized speech;
- raw imported file contents;
- full user file paths;
- unmasked audio device IDs or other stable user identifiers.

Known sensitive values are structurally excluded before formatting. File paths are reduced to safe metadata such as extension and byte size. Device identifiers are represented by a short per-export hash or a generic role. Error bodies from external services are classified and sanitized before logging.

Redaction has unit tests covering API-key-like strings, bearer headers, Windows paths, device IDs, transcripts, and translation payloads.

### Event Coverage

The journal records:

- application startup, version, shutdown request, teardown result, and panic hook output;
- settings/history open, migration, write, clear, and recovery failures;
- device enumeration and selected-device availability without raw IDs;
- live lifecycle transitions and generation IDs;
- WebSocket connect/reconnect/classified failure/timeout/close;
- capture, playback, bridge, ducking, passthrough, and recorder start/stop/failure;
- voice import stage, sanitized file metadata, cancellation, and terminal failure;
- frontend initialization, subscription, IPC, and unhandled window errors;
- rate-limited counters for dropped audio chunks and event-channel pressure.

### Diagnostics Page

Add a `Diagnostics` navigation destination. It contains:

- records from the last 24 hours, newest first;
- severity and subsystem filters;
- manual refresh;
- loading, empty, and error states;
- a privacy notice explaining what is and is not collected;
- one button to export a `.txt` diagnostic bundle through the native save dialog.

The page loads a bounded window of records and does not render the complete file set at once.

The exported text file includes:

- application name and version;
- export timestamp and retention window;
- sanitized OS/runtime information;
- current configuration flags that are not sensitive;
- sanitized log records from the previous 24 hours.

Export is local and user-initiated. The application never uploads or sends the file.

## Error Handling Rules

1. User actions must not fail silently.
2. Cleanup is idempotent and bounded by deadlines.
3. Background-task failures must reach the lifecycle coordinator.
4. An error from an old session generation cannot change the current session.
5. Logging failures must not crash or block the application.
6. Diagnostic messages must be useful without including user content.
7. Recoverable failures expose Retry; destructive recovery requires explicit confirmation.

## Verification Strategy

Implementation follows test-first, subsystem-sized commits.

Automated release gates:

```text
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run tauri build
```

Focused tests cover:

- all valid and invalid lifecycle transitions;
- Start during Stop, concurrent Stop, auto-stop during manual Stop, and late old-generation events;
- cancellation and timeouts for connect/send/close;
- full audio queues and worker failure propagation;
- recorder state across navigation and shutdown;
- voice import size/concurrency limits and cancellation during history clear;
- concurrent settings patches and frontend patch ordering;
- initialization retry and partial subscription cleanup;
- stale history-search suppression and clear failure;
- log retention, size bound, redaction, filtering, and export;
- startup recovery and bounded shutdown helpers.

Hardware-independent integration tests use mocked WebSocket peers and test doubles for lifecycle workers. They do not claim to validate real WASAPI routing.

## Manual Windows Release Gate

The user performs the final hardware test using the production installer, a real microphone, headphones, VB-CABLE, and a real peer-call application. The checklist will include:

1. clean installation and first launch;
2. device detection and idle passthrough;
3. outgoing and incoming live translation;
4. Start/Stop repetition and immediate restart;
5. auto-stop and manual Stop overlap;
6. microphone/output disconnection during a session;
7. navigation during voice recording;
8. voice import, playback, export, and history clear;
9. normal exit during an active session and successful relaunch;
10. Diagnostics page review and `.txt` export;
11. confirmation that the exported file contains no speech, translations, API key, full paths, or raw device IDs.

Release is blocked until the user reports this checklist passed or explicitly accepts a documented exception.

## Delivery

Work is implemented as small reviewed commits grouped by subsystem. No partial stabilization release is published.

After all automated gates pass:

1. bump the patch version consistently in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`;
2. produce and inspect the production installer artifacts;
3. provide the manual Windows checklist and candidate installer;
4. receive the user's hardware-test result;
5. merge/push the verified commit set to `main`;
6. create and push the release tag;
7. publish the release with installer artifacts and concise release notes.

The exact version and tag are chosen from the repository state immediately before release.
