//! Tauri IPC command surface — the frontend contract.
//!
//! Command names and argument shapes here are load-bearing: the React frontend
//! invokes them by exact name. Tauri 2 maps JS camelCase argument keys to the
//! snake_case Rust parameters automatically, and `cfg` arrives as a JSON object
//! deserialized into [`crate::live_ctrl::LiveConfig`] (which is `camelCase`).

use tauri::{AppHandle, State};

use crate::audio::devices::{list_audio_apps, list_devices, AppSession, DevicesPayload};
use crate::gemini::rest::{validate_key, KeyStatus};
use crate::live_ctrl::{LiveConfig, LiveController};
use crate::store::secrets::{get_api_key, set_api_key};
use crate::store::settings::{Settings, SettingsStore};

/// Shared application state held by Tauri's managed-state registry.
pub struct AppState {
    pub settings: SettingsStore,
    /// The single in-flight live session, if any. `Mutex<Option<…>>` enforces
    /// "at most one running session" and lets `live_stop` `take` it.
    ///
    /// This is a **`tokio::sync::Mutex`** (not `std::sync::Mutex`) so the guard
    /// can be held across an `.await` in the async `live_start`/`live_stop`
    /// commands. `LiveController` is `Send` (all its fields — `Arc`, atomics,
    /// crossbeam channels, the `LiveSession` mpsc sender, and `JoinHandle<()>`
    /// — are `Send`; the only `!Send` value, the COM `DuckGuard`, lives entirely
    /// inside the ducking thread and is never stored here), so holding the guard
    /// across `spawn_blocking(...).await` is sound and lets us serialize
    /// concurrent starts without a separate "starting" flag.
    pub live: tokio::sync::Mutex<Option<LiveController>>,
}

/// Read the current settings snapshot.
#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Settings {
    state.settings.get()
}

/// Merge a partial JSON patch into settings and persist it.
#[tauri::command]
pub fn settings_set(
    state: State<'_, AppState>,
    patch: serde_json::Value,
) -> Result<Settings, String> {
    state.settings.patch(patch).map_err(|e| e.to_string())
}

/// Report whether an API key is stored, WITHOUT a network round-trip.
///
/// Returns `Missing` if nothing is stored. If a key is present it returns
/// `Valid` optimistically — the UI calls [`api_key_set`] to actually validate
/// against Gemini before trusting it.
#[tauri::command]
pub fn api_key_status() -> KeyStatus {
    match get_api_key() {
        Some(_) => KeyStatus::Valid,
        None => KeyStatus::Missing,
    }
}

/// Validate a candidate API key against Gemini and, only if valid, store it.
#[tauri::command]
pub async fn api_key_set(key: String) -> Result<KeyStatus, String> {
    let status = validate_key(&key).await;
    if matches!(status, KeyStatus::Valid) {
        set_api_key(&key).map_err(|e| e.to_string())?;
    }
    Ok(status)
}

/// Enumerate capture/render devices and the virtual-cable presence flag.
#[tauri::command]
pub fn devices_list() -> Result<DevicesPayload, String> {
    list_devices().map_err(|e| e.to_string())
}

/// List processes with an active audio session (the app picker source).
#[tauri::command]
pub fn audio_apps_list() -> Result<Vec<AppSession>, String> {
    list_audio_apps().map_err(|e| e.to_string())
}

/// Start a live session (OUT pipeline in this task).
///
/// Async so the blocking WASAPI device-open / WS-spawn work (~100–600 ms)
/// runs on a `spawn_blocking` pool thread instead of freezing the UI event
/// loop. The `tokio::sync::Mutex` guard is held across the `.await`, which
/// serializes concurrent `live_start` calls (the second sees `Some(_)` and
/// returns `already_running`) without a race or a separate "starting" flag.
///
/// `LiveController::start` itself calls `tauri::async_runtime::block_on`
/// internally; running it inside `spawn_blocking` is sound (calling `block_on`
/// directly inside this async command would panic — "cannot block_on within a
/// runtime").
///
/// Error strings are part of the contract:
/// * `"no_api_key"` — no key stored; the UI must run the API-key step first.
/// * `"already_running"` — a session is already live.
/// * `"cable_missing"` — live mode but the VB-CABLE render endpoint is absent.
#[tauri::command]
pub async fn live_start(
    app: AppHandle,
    state: State<'_, AppState>,
    cfg: LiveConfig,
) -> Result<(), String> {
    // Hold the async guard across the await: this both reserves the single slot
    // (rejecting a concurrent second start) and lets us store the controller
    // once built.
    let mut guard = state.live.lock().await;
    if guard.is_some() {
        return Err("already_running".to_string());
    }

    let api_key = get_api_key().ok_or_else(|| "no_api_key".to_string())?;

    // Build the controller off the event loop. `LiveController::start` does the
    // blocking device-open + WS spawn (and its own internal `block_on`), so it
    // must run inside `spawn_blocking`, not inline.
    let controller = tauri::async_runtime::spawn_blocking(move || {
        LiveController::start(app, api_key, cfg)
    })
    .await
    .map_err(|e| format!("live_start join: {e}"))?
    .map_err(|e| e.to_string())?;

    *guard = Some(controller);
    Ok(())
}

/// Stop the live session if one is running. A no-op if nothing is live.
///
/// Async so the blocking teardown (joining audio threads, flushing the WS
/// close — up to a few hundred ms) runs on a `spawn_blocking` pool thread
/// instead of freezing the UI event loop. `LiveController::stop` uses
/// `tauri::async_runtime::block_on` internally; running it inside
/// `spawn_blocking` is sound.
#[tauri::command]
pub async fn live_stop(state: State<'_, AppState>) -> Result<(), String> {
    // Take the controller out under the lock, then drop the lock before the
    // (blocking) teardown so a concurrent `live_start` isn't starved.
    //
    // (Tauri requires async commands that borrow `State` to return a `Result`;
    // the teardown itself is infallible, so `Ok(())` is always returned.)
    let controller = state.live.lock().await.take();
    if let Some(controller) = controller {
        let _ = tauri::async_runtime::spawn_blocking(move || controller.stop()).await;
    }
    Ok(())
}
