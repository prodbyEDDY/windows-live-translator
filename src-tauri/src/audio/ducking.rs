//! Session ducking — lower the peer app's (or whole system's) volume while a
//! translation is audible, then restore it.
//!
//! ## Why a restore file
//! Ducking mutates *other* processes' per-session volumes via
//! `ISimpleAudioVolume::SetMasterVolume`. If we crash while ducked, those apps
//! stay quiet forever (the volume setting persists for the life of that audio
//! session). To recover, [`DuckGuard::duck`] writes the original volumes to a
//! small JSON file *before* touching anything; [`restore_after_crash`] reads it
//! at the next app start and puts the volumes back. On a clean teardown the
//! guard's `Drop` restores volumes and removes the file, so a normal exit leaves
//! nothing to recover.
//!
//! ## COM threading
//! `ISimpleAudioVolume` (and every other WASAPI session interface) is **not**
//! `Send`. A [`DuckGuard`] therefore holds raw COM pointers and is neither
//! `Send` nor `Sync`; it must be created and dropped on the *same* thread. The
//! live controller spawns a dedicated `ducking` `std::thread` for exactly this
//! reason — the guard never crosses a thread boundary.
//!
//! ## Ducking policy (per spec)
//! * `level` is an **absolute** target fraction (e.g. 0.2), not a multiplier.
//! * We never *increase* a session's volume: the applied level is
//!   `level.min(original)`. A session already quieter than `level` is left
//!   alone.
//! * Volumes ramp down/up in 5 steps over ~150 ms (30 ms between steps) to avoid
//!   an abrupt jump.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// Ramp configuration shared by duck-down and restore-up.
const RAMP_STEPS: u32 = 5;
const RAMP_STEP_DELAY: Duration = Duration::from_millis(30);

// ---------------------------------------------------------------------------
// Restore file (pure logic — unit-tested in CI, no COM)
// ---------------------------------------------------------------------------

/// Persist the sessions we are about to duck as `[[pid, original_volume], ...]`.
///
/// Written *before* any volume is changed so a crash mid-duck is recoverable.
pub fn write_restore_file(path: &Path, entries: &[(u32, f32)]) -> anyhow::Result<()> {
    let json = serde_json::to_string(entries)?;
    std::fs::write(path, json)?;
    Ok(())
}

/// Read a restore file written by [`write_restore_file`]. Returns `None` if the
/// file is absent or unparseable (a corrupt file is treated as "nothing to
/// restore" rather than a hard error — recovery is best-effort).
pub fn read_restore_file(path: &Path) -> Option<Vec<(u32, f32)>> {
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

/// Remove the restore file, ignoring a missing-file error. Best-effort.
pub fn clear_restore_file(path: &Path) {
    let _ = std::fs::remove_file(path);
}

// ---------------------------------------------------------------------------
// DuckGuard (COM — lives on one thread, RAII restore on Drop)
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod com {
    use super::*;
    use windows::core::Interface;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        ISimpleAudioVolume, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    /// One ducked session: the COM volume control, the owning pid, and the
    /// volume it had *before* we touched it.
    struct Entry {
        vol: ISimpleAudioVolume,
        #[allow(dead_code)]
        pid: u32,
        original: f32,
    }

    /// RAII volume-ducking guard. Created on a thread with COM initialized;
    /// dropped on the same thread (it is `!Send` because `ISimpleAudioVolume`
    /// is). Drop ramps volumes back to their originals and clears the restore
    /// file.
    pub struct DuckGuard {
        entries: Vec<Entry>,
        restore_path: PathBuf,
    }

    impl DuckGuard {
        /// Duck matching sessions to `level` (absolute fraction, clamped to
        /// `0..=1`).
        ///
        /// * `pid == Some(p)` → only sessions belonging to process `p`.
        /// * `pid == None` → every session except our own process.
        ///
        /// Writes the restore file (originals) *before* changing any volume,
        /// then ramps each session down to `level.min(original)` in
        /// [`RAMP_STEPS`] steps. Sessions already quieter than `level` are
        /// recorded (so Drop restores them to their exact original) but their
        /// applied target never exceeds their original — we never turn a session
        /// *up*.
        pub fn duck(restore_path: PathBuf, pid: Option<u32>, level: f32) -> anyhow::Result<Self> {
            let level = level.clamp(0.0, 1.0);
            let own_pid = std::process::id();

            let entries = unsafe { collect_sessions(pid, own_pid)? };

            // Persist originals BEFORE mutating anything.
            let restore: Vec<(u32, f32)> =
                entries.iter().map(|e| (e.pid, e.original)).collect();
            write_restore_file(&restore_path, &restore)?;

            // Ramp each session down to its target in lock-step. Per-step we set
            // every session, then sleep, so all apps duck together.
            for step in 1..=RAMP_STEPS {
                let frac = step as f32 / RAMP_STEPS as f32;
                for e in &entries {
                    let target = level.min(e.original);
                    // Linear interpolate original → target over the ramp.
                    let v = e.original + (target - e.original) * frac;
                    unsafe {
                        let _ = e.vol.SetMasterVolume(v, std::ptr::null());
                    }
                }
                std::thread::sleep(RAMP_STEP_DELAY);
            }

            Ok(Self {
                entries,
                restore_path,
            })
        }
    }

    impl Drop for DuckGuard {
        fn drop(&mut self) {
            // MUST be panic-safe: this runs on the ducking thread and a panic in
            // Drop while unwinding would abort the process. Every COM call is in
            // an `unsafe` block whose Result we discard, and nothing here can
            // panic (no unwrap/index/alloc-that-can-fail on the hot path).
            for step in 1..=RAMP_STEPS {
                let frac = step as f32 / RAMP_STEPS as f32;
                for e in &self.entries {
                    // We ramp from the (possibly clamped) ducked value back to
                    // original. We don't know the exact current value, but
                    // interpolating original*frac from 0 toward original is
                    // smooth enough and always ends exactly at `original`.
                    let v = e.original * frac;
                    unsafe {
                        let _ = e.vol.SetMasterVolume(v, std::ptr::null());
                    }
                }
                std::thread::sleep(RAMP_STEP_DELAY);
            }
            // Final exact write in case the ramp left rounding error.
            for e in &self.entries {
                unsafe {
                    let _ = e.vol.SetMasterVolume(e.original, std::ptr::null());
                }
            }
            clear_restore_file(&self.restore_path);
        }
    }

    /// Enumerate the default render endpoint's sessions and collect volume
    /// controls for the ones matching `pid` (or all but `own_pid` when `None`).
    ///
    /// # Safety
    /// COM must be usable on the calling thread; this initializes it tolerantly.
    /// The returned `ISimpleAudioVolume`s are `!Send` and must stay on this
    /// thread.
    unsafe fn collect_sessions(pid: Option<u32>, own_pid: u32) -> anyhow::Result<Vec<Entry>> {
        // Tolerate an already-initialised apartment (S_FALSE / RPC_E_CHANGED_MODE).
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

        let mut out: Vec<Entry> = Vec::new();
        for i in 0..count {
            // Per-session failures must not abort the scan.
            let control = match sessions.GetSession(i) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let control2: IAudioSessionControl2 = match control.cast() {
                Ok(c) => c,
                Err(_) => continue,
            };
            let session_pid = match control2.GetProcessId() {
                Ok(p) => p,
                Err(_) => continue,
            };

            // Skip the system-sounds session (pid 0) always.
            if session_pid == 0 {
                continue;
            }
            let keep = match pid {
                Some(target) => session_pid == target,
                None => session_pid != own_pid,
            };
            if !keep {
                continue;
            }

            let vol: ISimpleAudioVolume = match control.cast() {
                Ok(v) => v,
                Err(_) => continue,
            };
            let original = match vol.GetMasterVolume() {
                Ok(v) => v,
                Err(_) => continue,
            };

            out.push(Entry {
                vol,
                pid: session_pid,
                original,
            });
        }

        Ok(out)
    }

    /// App-start crash recovery: read the restore file and put each recorded
    /// pid's session volume back, then clear the file. Pids whose sessions are
    /// gone are silently skipped (the app exited — its session, and thus the
    /// stuck volume setting, died with it).
    ///
    /// Best-effort and panic-free: any COM failure leaves the file in place for
    /// a later attempt only if enumeration itself fails; once we successfully
    /// enumerate we clear the file regardless of individual set results.
    pub fn restore_after_crash(restore_path: &Path) {
        let Some(entries) = read_restore_file(restore_path) else {
            return;
        };
        if entries.is_empty() {
            clear_restore_file(restore_path);
            return;
        }

        let result = unsafe { restore_volumes(&entries) };
        if result.is_ok() {
            clear_restore_file(restore_path);
        } else {
            // Enumeration failed (no render endpoint yet?). Leave the file for a
            // future attempt rather than dropping the recovery data.
            tracing::warn!("ducking: crash-restore enumeration failed; will retry next start");
        }
    }

    /// # Safety
    /// COM must be usable on the calling thread; initialized tolerantly here.
    unsafe fn restore_volumes(entries: &[(u32, f32)]) -> anyhow::Result<()> {
        use std::collections::HashMap;

        let want: HashMap<u32, f32> = entries.iter().copied().collect();

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

        for i in 0..count {
            let control = match sessions.GetSession(i) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let control2: IAudioSessionControl2 = match control.cast() {
                Ok(c) => c,
                Err(_) => continue,
            };
            let session_pid = match control2.GetProcessId() {
                Ok(p) => p,
                Err(_) => continue,
            };
            let Some(&orig) = want.get(&session_pid) else {
                continue;
            };
            let vol: ISimpleAudioVolume = match control.cast() {
                Ok(v) => v,
                Err(_) => continue,
            };
            let _ = vol.SetMasterVolume(orig, std::ptr::null());
        }

        Ok(())
    }
}

#[cfg(windows)]
pub use com::{restore_after_crash, DuckGuard};

// ---------------------------------------------------------------------------
// Non-Windows stubs (so the crate at least type-checks off-Windows; the app
// only ships on Windows). Never exercised in CI on this platform.
// ---------------------------------------------------------------------------

#[cfg(not(windows))]
mod stub {
    use super::*;

    pub struct DuckGuard;

    impl DuckGuard {
        pub fn duck(
            _restore_path: PathBuf,
            _pid: Option<u32>,
            _level: f32,
        ) -> anyhow::Result<Self> {
            anyhow::bail!("ducking is only supported on Windows")
        }
    }

    pub fn restore_after_crash(_restore_path: &Path) {}
}

#[cfg(not(windows))]
pub use stub::{restore_after_crash, DuckGuard};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_file_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("duck-restore.json");

        // Absent file → None.
        assert!(read_restore_file(&path).is_none());

        // Write → read returns exactly what we wrote (order + values preserved).
        let entries = vec![(1234u32, 0.8f32), (5678u32, 0.42f32), (9000u32, 1.0f32)];
        write_restore_file(&path, &entries).unwrap();
        let got = read_restore_file(&path).expect("should read back");
        assert_eq!(got, entries);

        // Clear → read returns None again.
        clear_restore_file(&path);
        assert!(read_restore_file(&path).is_none());

        // Clearing an already-absent file is a no-op (no panic).
        clear_restore_file(&path);
    }

    #[test]
    fn read_corrupt_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("duck-restore.json");
        std::fs::write(&path, "not json at all {{{").unwrap();
        assert!(read_restore_file(&path).is_none());
    }

    #[test]
    fn empty_entries_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("duck-restore.json");
        write_restore_file(&path, &[]).unwrap();
        assert_eq!(read_restore_file(&path), Some(vec![]));
        clear_restore_file(&path);
    }

    /// Hardware smoke test — DO NOT run automatically. Ducks any active session
    /// to 0.5 for 300 ms, drops the guard, and asserts the volume came back to
    /// its original. Needs an app playing audio (start the SoundPlayer wav loop
    /// as in Task 10). Reports the observed original → ducked → restored values.
    #[cfg(windows)]
    #[test]
    #[ignore = "mutates real session volumes; needs an active audio session"]
    fn duck_and_restore_smoke() {
        use windows::core::Interface;
        use windows::Win32::Media::Audio::{
            eConsole, eRender, AudioSessionStateActive, IAudioSessionControl2,
            IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator,
        };
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
        };

        // Find an active session and read its original volume + pid.
        let (target_pid, original) = unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).unwrap();
            let device = enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .unwrap();
            let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None).unwrap();
            let sessions = manager.GetSessionEnumerator().unwrap();
            let count = sessions.GetCount().unwrap_or(0);
            let own = std::process::id();
            let mut found: Option<(u32, f32)> = None;
            for i in 0..count {
                let Ok(control) = sessions.GetSession(i) else {
                    continue;
                };
                let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                let Ok(pid) = control2.GetProcessId() else {
                    continue;
                };
                if pid == 0 || pid == own {
                    continue;
                }
                if !matches!(control2.GetState(), Ok(s) if s == AudioSessionStateActive) {
                    continue;
                }
                let Ok(vol) = control.cast::<ISimpleAudioVolume>() else {
                    continue;
                };
                let Ok(v) = vol.GetMasterVolume() else {
                    continue;
                };
                found = Some((pid, v));
                break;
            }
            found.expect("no active audio session found — start the wav loop first")
        };

        println!("duck_and_restore_smoke: target pid={target_pid} original={original:.3}");

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("duck-restore.json");

        // Duck to 0.5 (or below original — never up).
        let guard = DuckGuard::duck(path.clone(), Some(target_pid), 0.5).unwrap();

        // Restore file must exist while ducked.
        assert!(path.exists(), "restore file must exist while ducked");

        // Read the ducked volume.
        let ducked = read_session_volume(target_pid);
        println!("duck_and_restore_smoke: ducked={ducked:?}");

        std::thread::sleep(std::time::Duration::from_millis(300));

        // Drop the guard → ramps back + clears the file.
        drop(guard);

        let restored = read_session_volume(target_pid);
        println!("duck_and_restore_smoke: restored={restored:?}");

        assert!(
            !path.exists(),
            "restore file must be removed after guard drop"
        );

        if let Some(r) = restored {
            assert!(
                (r - original).abs() < 0.01,
                "volume must return to original: original={original:.3} restored={r:.3}"
            );
        }
    }

    /// Read one pid's current session volume from the default render endpoint.
    #[cfg(windows)]
    fn read_session_volume(target_pid: u32) -> Option<f32> {
        use windows::core::Interface;
        use windows::Win32::Media::Audio::{
            eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
            ISimpleAudioVolume, MMDeviceEnumerator,
        };
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
        };
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
            let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None).ok()?;
            let sessions = manager.GetSessionEnumerator().ok()?;
            let count = sessions.GetCount().unwrap_or(0);
            for i in 0..count {
                let Ok(control) = sessions.GetSession(i) else {
                    continue;
                };
                let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                let Ok(pid) = control2.GetProcessId() else {
                    continue;
                };
                if pid != target_pid {
                    continue;
                }
                let Ok(vol) = control.cast::<ISimpleAudioVolume>() else {
                    continue;
                };
                return vol.GetMasterVolume().ok();
            }
            None
        }
    }
}
