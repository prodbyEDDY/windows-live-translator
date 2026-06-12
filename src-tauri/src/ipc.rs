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
    pub live: std::sync::Mutex<Option<LiveController>>,
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
/// Error strings are part of the contract:
/// * `"no_api_key"` — no key stored; the UI must run the API-key step first.
/// * `"already_running"` — a session is already live.
/// * `"cable_missing"` — live mode but the VB-CABLE render endpoint is absent.
#[tauri::command]
pub fn live_start(
    app: AppHandle,
    state: State<'_, AppState>,
    cfg: LiveConfig,
) -> Result<(), String> {
    // Reject a second concurrent session before doing any work.
    let mut guard = state.live.lock().unwrap();
    if guard.is_some() {
        return Err("already_running".to_string());
    }

    let api_key = get_api_key().ok_or_else(|| "no_api_key".to_string())?;

    let controller = LiveController::start(app, api_key, cfg).map_err(|e| e.to_string())?;
    *guard = Some(controller);
    Ok(())
}

/// Stop the live session if one is running. A no-op if nothing is live.
#[tauri::command]
pub fn live_stop(state: State<'_, AppState>) {
    // Take the controller out under the lock, then drop the lock before the
    // (blocking) teardown so a concurrent `live_start` isn't starved.
    let controller = state.live.lock().unwrap().take();
    if let Some(controller) = controller {
        controller.stop();
    }
}
