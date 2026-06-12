//! WASAPI device & application audio-session enumeration.
//!
//! Two distinct code paths live here:
//!   * Device enumeration ([`list_devices`], [`cable_render_device_id`]) uses the
//!     high-level `wasapi` crate (0.23).
//!   * Application audio-session enumeration ([`list_audio_apps`]) drops down to
//!     raw COM via the `windows` crate. It is intentionally self-contained — no
//!     `wasapi`-crate objects cross into it — so the `unsafe` blocks stay small
//!     and auditable.

use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicesPayload {
    pub inputs: Vec<DeviceInfo>,
    pub outputs: Vec<DeviceInfo>,
    pub cable_present: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSession {
    pub pid: u32,
    pub name: String,
}

/// Friendly-name fragment of the VB-Audio Virtual Cable *render* endpoint we
/// play translated audio into. (The matching capture endpoint is "CABLE Output".)
pub const CABLE_RENDER_NAME: &str = "CABLE Input";

// ---------------------------------------------------------------------------
// Device enumeration (wasapi crate)
// ---------------------------------------------------------------------------

/// Enumerate a single direction's active devices, marking the default endpoint.
fn collect_direction(
    enumerator: &wasapi::DeviceEnumerator,
    direction: &wasapi::Direction,
) -> anyhow::Result<Vec<DeviceInfo>> {
    // The default device may legitimately not exist (e.g. no capture hardware);
    // in that case nothing is flagged as default rather than failing the whole
    // enumeration.
    let default_id = enumerator
        .get_default_device(direction)
        .ok()
        .and_then(|d| d.get_id().ok());

    let collection = enumerator.get_device_collection(direction)?;
    let mut out = Vec::new();
    for device in &collection {
        let device = device?;
        let id = device.get_id()?;
        let name = device.get_friendlyname()?;
        let is_default = default_id.as_deref() == Some(id.as_str());
        out.push(DeviceInfo {
            id,
            name,
            is_default,
        });
    }
    Ok(out)
}

/// List all active capture (input) and render (output) endpoints.
///
/// `cable_present` is true when any render endpoint's friendly name contains
/// [`CABLE_RENDER_NAME`].
pub fn list_devices() -> anyhow::Result<DevicesPayload> {
    // COM must be initialised (MTA) on the calling thread. `initialize_mta`
    // returns an HRESULT; converting to a Result and discarding the value
    // tolerates the "already initialised" case (S_FALSE / RPC_E_CHANGED_MODE),
    // which is fine here — we never uninitialise.
    let _ = wasapi::initialize_mta().ok();

    let enumerator = wasapi::DeviceEnumerator::new()
        .map_err(|e| anyhow::anyhow!("failed to create device enumerator: {e}"))?;

    let inputs = collect_direction(&enumerator, &wasapi::Direction::Capture)?;
    let outputs = collect_direction(&enumerator, &wasapi::Direction::Render)?;

    let cable_present = outputs.iter().any(|d| d.name.contains(CABLE_RENDER_NAME));

    Ok(DevicesPayload {
        inputs,
        outputs,
        cable_present,
    })
}

/// Resolve the device id of the VB-Audio "CABLE Input" *render* endpoint, if present.
pub fn cable_render_device_id() -> Option<String> {
    let payload = list_devices().ok()?;
    payload
        .outputs
        .into_iter()
        .find(|d| d.name.contains(CABLE_RENDER_NAME))
        .map(|d| d.id)
}

// ---------------------------------------------------------------------------
// Application audio-session enumeration (raw COM via the `windows` crate)
// ---------------------------------------------------------------------------

/// List processes that currently have an *active* audio session on the default
/// render endpoint (e.g. Zoom, a browser playing a call).
///
/// Returns one [`AppSession`] per distinct pid. The system-sounds session
/// (pid 0) and our own process are skipped. Returning an empty vec is a valid
/// result — it simply means nothing is currently playing audio.
pub fn list_audio_apps() -> anyhow::Result<Vec<AppSession>> {
    use windows::core::Interface;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
        IMMDeviceEnumerator, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    let own_pid = std::process::id();

    unsafe {
        // Tolerate an already-initialised apartment: CoInitializeEx returns
        // S_FALSE if COM was already initialised on this thread, or
        // RPC_E_CHANGED_MODE if a different apartment was requested elsewhere.
        // Neither is fatal for our read-only usage, so we ignore the HRESULT.
        // We do NOT call CoUninitialize — the thread may keep using COM.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| anyhow::anyhow!("CoCreateInstance(MMDeviceEnumerator) failed: {e}"))?;

        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .map_err(|e| anyhow::anyhow!("GetDefaultAudioEndpoint failed: {e}"))?;

        let manager: IAudioSessionManager2 = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| anyhow::anyhow!("Activate(IAudioSessionManager2) failed: {e}"))?;

        let sessions = manager
            .GetSessionEnumerator()
            .map_err(|e| anyhow::anyhow!("GetSessionEnumerator failed: {e}"))?;

        let count = sessions.GetCount().unwrap_or(0);

        let mut seen: HashSet<u32> = HashSet::new();
        let mut apps = Vec::new();

        for i in 0..count {
            // Per-session failures must not abort the whole scan — sessions can
            // disappear between GetCount and GetSession, etc. Skip and continue.
            let control = match sessions.GetSession(i) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let control2: IAudioSessionControl2 = match control.cast() {
                Ok(c) => c,
                Err(_) => continue,
            };

            let pid = match control2.GetProcessId() {
                Ok(p) => p,
                Err(_) => continue,
            };
            if pid == 0 || pid == own_pid || seen.contains(&pid) {
                continue;
            }

            match control2.GetState() {
                Ok(state) if state == AudioSessionStateActive => {}
                _ => continue,
            }

            // Elevated processes deny OpenProcess — still list them by pid so
            // the app picker doesn't silently hide an audible app.
            let name = process_name_for_pid(pid).unwrap_or_else(|| format!("pid {pid}"));

            seen.insert(pid);
            apps.push(AppSession { pid, name });
        }

        Ok(apps)
    }
}

/// Resolve a pid to its executable's file stem (e.g. "zoom"). Returns `None`
/// on any failure (access denied, process gone), so the caller can skip it.
///
/// Opens the process with the minimal `PROCESS_QUERY_LIMITED_INFORMATION`
/// right and always closes the handle before returning.
fn process_name_for_pid(pid: u32) -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;

        let mut buf = [0u16; 1024]; // > MAX_PATH: long install paths must not fail the query
        let mut size = buf.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        );

        // Always release the handle, regardless of the query outcome.
        let _ = CloseHandle(handle);

        result.ok()?;

        let full = String::from_utf16_lossy(&buf[..size as usize]);
        let stem = Path::new(&full)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or(full);
        Some(stem)
    }
}

// ---------------------------------------------------------------------------
// Background watcher
// ---------------------------------------------------------------------------

/// Build a stable snapshot string capturing what a consumer cares about:
/// the set of device ids (per direction), which one is default, and whether
/// the virtual cable is present. Used to debounce `devices:changed` events.
fn snapshot(payload: &DevicesPayload) -> String {
    let mut s = String::new();
    for (tag, list) in [("i", &payload.inputs), ("o", &payload.outputs)] {
        for d in list {
            s.push_str(tag);
            s.push('|');
            s.push_str(&d.id);
            s.push('|');
            s.push_str(if d.is_default { "1" } else { "0" });
            s.push('\n');
        }
    }
    s.push_str(if payload.cable_present { "cable1" } else { "cable0" });
    s
}

/// Spawn a background thread that polls device state every 2s and emits a Tauri
/// `devices:changed` event (carrying the [`DevicesPayload`]) whenever the
/// snapshot changes versus the previous successful read.
///
/// Call exactly once from app setup — there is no shutdown mechanism and a
/// second call would spawn a duplicate poller emitting duplicate events.
pub fn spawn_device_watcher(app: tauri::AppHandle) {
    use tauri::Emitter;

    std::thread::spawn(move || {
        // COM init for this thread (devices enumeration needs it).
        let _ = wasapi::initialize_mta().ok();

        let mut last: Option<String> = None;
        loop {
            let payload = match list_devices() {
                Ok(p) => p,
                Err(e) => {
                    tracing::warn!("device watcher: list_devices failed: {e}");
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    continue;
                }
            };

            let snap = snapshot(&payload);
            let changed = match &last {
                Some(prev) => prev != &snap,
                None => false, // seed the first snapshot without emitting
            };

            if changed {
                if let Err(e) = app.emit("devices:changed", &payload) {
                    tracing::warn!("device watcher: emit failed: {e}");
                }
            }
            last = Some(snap);

            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires audio hardware"]
    fn devices_smoke() {
        let d = list_devices().unwrap();
        assert!(!d.outputs.is_empty());
        println!("{:#?}", d);
        println!("{:#?}", list_audio_apps().unwrap());
    }
}
