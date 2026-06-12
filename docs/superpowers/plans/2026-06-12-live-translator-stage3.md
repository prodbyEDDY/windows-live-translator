# Live Translator — Stage 3 (Polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Spec §10 этап 3.

**Scope decision:** auto-updates (tauri-updater) are NOT implemented — they require an update server + signing keys (distribution decision for the user); README notes this. Everything else from spec stage 3 lands here.

### Task S3-1: Cost & duration in UI
- `live_ctrl.rs`: a 1s-tick task tracks per-direction active seconds (count a second for a session whose status is running/reconnecting); emits `live:cost {seconds, estimatedUsd}` where estimatedUsd = (out_secs + in_secs) / 60 * 0.023. Const `USD_PER_SESSION_MINUTE: f64 = 0.023` with doc pointing at the pricing source. Pure fn `estimate_usd(out_secs, in_secs) -> f64` (TDD).
- Frontend: `onCost` in ipc.ts; LiveScreen status bar shows `~$0.12 · 05:32` (cost i18n'd, tooltip explaining the estimate).

### Task S3-2: Mix original voice into the call
- `playback.rs`: `start_playback_with_mix(device_id, src_rate, mix: Option<MixConfig{rx: Receiver<Vec<f32>>, gain: f32}>)` — mix bed is mono 48k f32; render loop adds `gain * bed_sample` to each output sample (bed pulled from a local VecDeque fed by try_recv; drop-oldest above ~500ms; silence when empty). Keep `start_playback` as a thin wrapper (None). Unit-test the pure mixing math (`mix_into(out: &mut [f32], bed: &mut VecDeque<f32>, gain)`).
- `live_ctrl.rs`: when `cfg.mix_original && !test_mode`, out-bridge tees mic 48k blocks into the mix channel of the CABLE playback; gain = `10^(mix_gain_db/20)`.
- `LiveConfig` gains `mixOriginal: bool, mixGainDb: f32` (already in Settings; thread through). SettingsScreen: enable the two controls (remove «Скоро»).

### Task S3-3: VAD economy (optional, default off)
- New Settings field `vadEconomy: bool` (serde default false — old settings files load fine). New LiveConfig field.
- `audio/vad.rs`: `struct EnergyVad { speaking: bool, hangover_ms, threshold_db }` — `push(block: &[f32], block_ms: f32) -> VadDecision{Speech | Silence | JustResumed}`; speech when rms_db > -45; silence only after 800ms continuous below threshold; pre-roll: bridges keep last 300ms ring of chunks, flush on resume. TDD the state machine (sine vs zeros sequences).
- Bridges: when vad_economy && Silence → skip `blocking_send_audio` (chunks dropped, not buffered); on JustResumed → send pre-roll ring first. Note in Settings UI: «экономит ~50% на тишине, может срезать первое слово» tooltip.

### Task S3-4: Single instance + NSIS installer
- `cargo add tauri-plugin-single-instance` + register (focus existing main window on second launch).
- `npm run tauri build` → NSIS artifact under `src-tauri/target/release/bundle/nsis/*.exe`; verify it builds; do not run the installer. README: установка из инсталлятора + сборка из исходников; note про автообновления (см. scope decision).
### Task S3-5: Final hardening + release
- All gates; final visual smoke screenshot `docs/testing/screenshots/stage3-final.png`; bump version 0.3.0 in tauri.conf.json/package.json/Cargo.toml; commit + tag `v0.3.0-stage3`.
- Final whole-project review pass (orchestrator-led) before tag.
