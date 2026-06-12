pub mod audio;
pub mod store;
pub mod gemini;
pub mod voice;
pub mod live_ctrl;
pub mod ipc;
pub mod wizard;

use std::sync::Arc;

use tauri::Manager;

use crate::audio::devices::spawn_device_watcher;
use crate::ipc::AppState;
use crate::store::history::HistoryStore;
use crate::store::settings::SettingsStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Tracing: respect RUST_LOG via the env filter, defaulting to `info`.
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second instance was launched — focus the existing main window.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        // Native drag-out of translated voice files into other apps (WhatsApp).
        .plugin(tauri_plugin_drag::init())
        // Native "Save as…" dialog for exporting voice files.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Settings live under the per-user app-data directory.
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let settings = SettingsStore::open(app_data_dir.join("settings.json"))?;

            // History DB + voice-file directory live under the same app-data dir.
            // `voice_dir` MUST match the asset-protocol scope (`$APPDATA/voice/**`
            // in tauri.conf.json) so `<audio>` playback via convertFileSrc works.
            let history = HistoryStore::open(app_data_dir.join("history.db"))?;
            let voice_dir = app_data_dir.join("voice");
            std::fs::create_dir_all(&voice_dir)?;

            // Crash recovery: if a previous run died while a peer app was ducked,
            // restore those session volumes now (best-effort, before anything
            // else can re-duck). Uses the same restore-file path the ducking
            // thread writes (see `live_ctrl::DUCK_RESTORE_FILE`).
            crate::audio::ducking::restore_after_crash(
                &app_data_dir.join(crate::live_ctrl::DUCK_RESTORE_FILE),
            );

            app.manage(AppState {
                settings,
                live: tokio::sync::Mutex::new(None),
                history: Arc::new(history),
                voice_dir,
                recorder: std::sync::Mutex::new(None),
            });

            // Background poller emitting `devices:changed`. Call exactly once.
            spawn_device_watcher(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::settings_get,
            ipc::settings_set,
            ipc::api_key_status,
            ipc::api_key_set,
            ipc::devices_list,
            ipc::audio_apps_list,
            ipc::live_start,
            ipc::live_stop,
            ipc::voice_import,
            ipc::voice_record_start,
            ipc::voice_record_stop,
            ipc::voice_retry,
            ipc::voice_list,
            ipc::voice_get,
            ipc::voice_export,
            ipc::history_list_calls,
            ipc::history_list_voice,
            ipc::history_save_call,
            ipc::history_clear,
            wizard::wizard_state,
            wizard::wizard_install_cable,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app_handle, event| {
            // App-exit teardown: stop any running live session so the ducking
            // thread drops its `DuckGuard` and restores the peer app's volume.
            // Without this the app can exit while a session is live, killing the
            // ducking thread with the guard still held → peer stays muted until
            // the next launch.
            //
            // `ExitRequested` and `Exit` can both fire; gate the teardown behind
            // a `Once` so the (consuming) `controller.stop()` runs exactly once.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                static TEARDOWN: std::sync::Once = std::sync::Once::new();
                TEARDOWN.call_once(|| {
                    let state = app_handle.state::<AppState>();
                    // The event-loop closure runs on the main thread (not a tokio
                    // worker), so `blocking_lock()` cannot panic here.
                    let controller = state.live.blocking_lock().take();
                    if let Some(controller) = controller {
                        controller.stop();
                    }
                });
            }
        });
}
