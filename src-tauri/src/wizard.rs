//! First-run wizard backend: VB-CABLE detection and (assisted) installation.
//!
//! Two IPC commands back the four-step setup wizard:
//!   * [`wizard_state`] — a cheap, network-free snapshot of "is a key stored?"
//!     and "is the virtual cable present?", driving the wizard's gating.
//!   * [`wizard_install_cable`] — downloads the official VB-CABLE driver pack,
//!     extracts it to a temp dir, and launches the vendor's installer *elevated*
//!     (UAC), waiting for it to finish.
//!
//! ## Installer launch: interactive, not silent
//! VB-CABLE's `VBCABLE_Setup_x64.exe` is an Inno-Setup-style installer whose
//! silent-install flags are undocumented by VB-Audio (the `-i -h` flags some
//! forums cite are unverified and behave inconsistently across pack versions).
//! Rather than risk a silent run that does nothing — or worse, the wrong thing —
//! we launch the installer **with no arguments** so the vendor's own GUI appears
//! and the user clicks "Install Driver". The driver then registers without a
//! reboot in the normal case; the frontend re-polls [`wizard_state`] to detect
//! the new endpoint (and shows a "may need a reboot" hint if it doesn't appear).
//!
//! ## Security
//!   * The download URL is a hard-coded HTTPS constant — never user input.
//!   * The only value interpolated into the PowerShell command is our own temp
//!     path, and it is passed via `Start-Process -FilePath <path>` as a single
//!     argument (the call uses a separate `-Command` script that references the
//!     path through a quoted literal), not concatenated into a shell string.
//!   * We launch *only* the located `VBCABLE_Setup_x64.exe` — nothing else from
//!     the archive is executed.

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;

use crate::audio::devices::list_devices;
use crate::store::secrets::get_api_key;

/// Official VB-Audio driver-pack download (HTTPS only — do not parameterise).
pub const CABLE_ZIP_URL: &str =
    "https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip";
/// Vendor download page, opened as a fallback when the automated install fails.
pub const CABLE_PAGE_URL: &str = "https://vb-audio.com/Cable/";

/// File name of the 64-bit installer inside the driver pack.
const INSTALLER_NAME: &str = "VBCABLE_Setup_x64.exe";

/// A cheap snapshot for the wizard's gating logic — no network round-trips.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WizardState {
    pub key_present: bool,
    pub cable_present: bool,
}

/// Dedicated download client with a generous timeout (the pack is a few MB but
/// the vendor CDN can be slow). Built once and reused.
static DL_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn dl_client() -> &'static reqwest::Client {
    DL_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .expect("failed to build wizard download client")
    })
}

/// Report whether an API key is stored and whether the virtual cable is present.
///
/// Both reads are local: the key check hits the OS keyring, the cable check
/// enumerates audio endpoints. A device-enumeration failure is treated as
/// "cable absent" rather than erroring the whole wizard.
#[tauri::command]
pub fn wizard_state() -> Result<WizardState, String> {
    let key_present = get_api_key().is_some();
    let cable_present = list_devices().map(|d| d.cable_present).unwrap_or(false);
    Ok(WizardState {
        key_present,
        cable_present,
    })
}

/// Recursively search `dir` for the VB-CABLE 64-bit installer.
///
/// The installer may sit at the archive root or one directory down depending on
/// the pack version, so we walk the whole extracted tree. The match is
/// case-insensitive on the file name. Returns the first match found.
///
/// Factored out as a pure function so it can be unit-tested against a synthetic
/// extracted tree without any download or real install.
pub fn find_installer(dir: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            subdirs.push(path);
        } else if file_type.is_file() {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name.eq_ignore_ascii_case(INSTALLER_NAME) {
                    return Some(path);
                }
            }
        }
    }
    // Recurse into subdirectories only after exhausting this level.
    for sub in subdirs {
        if let Some(found) = find_installer(&sub) {
            return Some(found);
        }
    }
    None
}

/// Extract the driver-pack `bytes` into `dest` and return the located installer
/// path. Pure/blocking — intended to run inside `spawn_blocking`.
fn extract_and_locate(bytes: Vec<u8>, dest: &Path) -> Result<PathBuf, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("extract_failed: {e}"))?;
    archive
        .extract(dest)
        .map_err(|e| format!("extract_failed: {e}"))?;
    find_installer(dest).ok_or_else(|| "installer_not_found_in_zip".to_string())
}

/// Launch `installer_path` elevated (UAC) and block until it exits.
///
/// Uses PowerShell's `Start-Process -Verb RunAs -Wait` to request elevation and
/// wait. The installer is launched with no arguments so the vendor GUI appears
/// (see module docs). A non-zero exit from PowerShell means the elevation was
/// declined or the process failed → `installer_cancelled`.
fn run_installer_elevated(installer_path: &Path) -> Result<(), String> {
    let path_str = installer_path
        .to_str()
        .ok_or_else(|| "installer_path_invalid".to_string())?;

    // The temp path is our own and contains no quotes, but escape single quotes
    // defensively (PowerShell escapes `'` by doubling it) so the literal can
    // never break out of the quoted string.
    let escaped = path_str.replace('\'', "''");
    let script = format!(
        "$p = Start-Process -FilePath '{escaped}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
    );

    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .status()
        .map_err(|e| format!("installer_launch_failed: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        // UAC declined (the Start-Process throws → non-zero) or installer aborted.
        Err("installer_cancelled".to_string())
    }
}

/// Download, extract, and run the VB-CABLE installer (elevated, interactive).
///
/// Steps:
///   1. Download the driver pack over HTTPS (120 s timeout).
///   2. Extract it into a temp dir and locate `VBCABLE_Setup_x64.exe`.
///   3. Launch it elevated and wait for the user to finish.
///
/// The temp dir is held alive across the entire installer run (the installer
/// reads from it) and cleaned up on return. The frontend polls [`wizard_state`]
/// afterwards to detect the freshly registered cable endpoint.
#[tauri::command]
pub async fn wizard_install_cable() -> Result<(), String> {
    // 1. Download.
    let resp = dl_client()
        .get(CABLE_ZIP_URL)
        .send()
        .await
        .map_err(|e| format!("download_failed: {}", e.without_url()))?;
    if !resp.status().is_success() {
        return Err(format!("download_failed: HTTP {}", resp.status().as_u16()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("download_failed: {}", e.without_url()))?
        .to_vec();

    // 2 + 3. Extract + run on a blocking thread (zip + the waiting child process
    // are both blocking). The TempDir is created and dropped inside this closure
    // so it outlives the installer run by construction.
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let tmp = tempfile::TempDir::new().map_err(|e| format!("tempdir_failed: {e}"))?;
        let installer = extract_and_locate(bytes, tmp.path())?;
        run_installer_elevated(&installer)
        // `tmp` drops here, after the installer has fully exited.
    })
    .await
    .map_err(|e| format!("install_task_panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// Build a tiny in-memory zip with `path` -> dummy exe content and return
    /// its bytes. No network, no real installer.
    fn build_zip(paths: &[&str]) -> Vec<u8> {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut zw = zip::ZipWriter::new(&mut buf);
            let opts = SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for p in paths {
                zw.start_file(*p, opts).unwrap();
                zw.write_all(b"MZ dummy").unwrap();
            }
            zw.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn extract_and_locate_finds_installer_at_root() {
        let bytes = build_zip(&["VBCABLE_Setup_x64.exe", "license.txt"]);
        let dir = tempfile::TempDir::new().unwrap();
        let found = extract_and_locate(bytes, dir.path()).unwrap();
        assert_eq!(
            found.file_name().unwrap().to_str().unwrap(),
            "VBCABLE_Setup_x64.exe"
        );
        assert!(found.exists());
    }

    #[test]
    fn find_installer_searches_nested_dirs() {
        let bytes = build_zip(&[
            "pack/readme.txt",
            "pack/drivers/VBCABLE_Setup_x64.exe",
        ]);
        let dir = tempfile::TempDir::new().unwrap();
        zip::ZipArchive::new(Cursor::new(bytes))
            .unwrap()
            .extract(dir.path())
            .unwrap();
        let found = find_installer(dir.path()).expect("should locate nested installer");
        assert!(found.ends_with("VBCABLE_Setup_x64.exe"));
    }

    #[test]
    fn find_installer_is_case_insensitive() {
        let bytes = build_zip(&["vbcable_setup_x64.EXE"]);
        let dir = tempfile::TempDir::new().unwrap();
        zip::ZipArchive::new(Cursor::new(bytes))
            .unwrap()
            .extract(dir.path())
            .unwrap();
        assert!(find_installer(dir.path()).is_some());
    }

    #[test]
    fn find_installer_returns_none_when_absent() {
        let bytes = build_zip(&["setup_x86.exe", "readme.txt", "sub/other.dll"]);
        let dir = tempfile::TempDir::new().unwrap();
        zip::ZipArchive::new(Cursor::new(bytes))
            .unwrap()
            .extract(dir.path())
            .unwrap();
        assert!(find_installer(dir.path()).is_none());
    }

    #[test]
    fn extract_and_locate_errors_when_installer_missing() {
        let bytes = build_zip(&["readme.txt", "VBCABLE_Setup_x86.exe"]);
        let dir = tempfile::TempDir::new().unwrap();
        let err = extract_and_locate(bytes, dir.path()).unwrap_err();
        assert_eq!(err, "installer_not_found_in_zip");
    }
}
