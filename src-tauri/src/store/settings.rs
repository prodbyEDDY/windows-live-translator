use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CaptureMode { App, System }

// Fix #1: `deny_unknown_fields` removed so a settings.json written by a newer app version
// (containing fields we don't know yet) silently round-trips instead of wiping all prefs.
// Unknown-key enforcement is handled explicitly inside `patch()`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub my_lang: String,
    pub peer_lang: String,
    pub mic_id: Option<String>,
    pub output_id: Option<String>,
    pub capture_mode: CaptureMode,
    pub echo_target_language: bool,
    pub ducking_enabled: bool,
    pub duck_level: f32,
    pub mix_original: bool,
    pub mix_gain_db: f32,
    /// VAD economy mode: skip streaming silence to Gemini (default off). The
    /// serde `default` on the struct means an older settings.json without this
    /// key still loads (it falls back to `false`).
    pub vad_economy: bool,
    pub ui_lang: String,
    pub wizard_done: bool,
    pub tts_voice: String,
    /// When no live session is running, pipe the raw microphone straight into
    /// the virtual cable so the peer still hears the (untranslated) original
    /// voice instead of silence. Lets the user leave their call app's mic set to
    /// "CABLE Output" permanently. Default on; serde `default` keeps older
    /// settings files loading (falls back to `false` — see `default_idle_passthrough`).
    #[serde(default = "default_idle_passthrough")]
    pub idle_passthrough: bool,
    /// `echoTargetLanguage` is sent ONLY to the IN session (peer → you): when the
    /// peer speaks your own language, the model passes their original audio
    /// through instead of staying silent. The OUT session always sends
    /// `echoTargetLanguage=false` (it must never re-voice speech that leaked into
    /// the mic — that would amplify an acoustic echo loop). Default on; an older
    /// file's explicit `false` is flipped once by the schema migration in
    /// [`SettingsStore::open`].
    ///
    /// Auto-close the live session after a couple of minutes with no translation
    /// activity, so a forgotten session doesn't keep burning Gemini minutes.
    /// Default on; an older file missing the key falls back to `true`.
    #[serde(default = "default_true")]
    pub idle_auto_stop: bool,
    /// Settings-file schema version, bumped when a default flip needs a one-shot
    /// migration (see [`SettingsStore::open`]). Older files predate versioning and
    /// deserialize to `0` (triggering the migration); new installs start at
    /// [`CURRENT_SCHEMA_VERSION`] via the `Default` impl.
    #[serde(default = "default_schema_version")]
    pub settings_schema_version: u32,
}

/// Default for [`Settings::idle_passthrough`] when absent from an older file.
fn default_idle_passthrough() -> bool {
    true
}

/// `true` default for boolean settings whose absence in an older file means "on".
fn default_true() -> bool {
    true
}

/// Schema version assumed for a file that predates settings versioning, so the
/// one-shot migration in [`SettingsStore::open`] runs for it (→ flips the
/// same-language passthrough default on).
fn default_schema_version() -> u32 {
    0
}

/// Current settings schema version. Bump (and extend the migration in
/// [`SettingsStore::open`]) whenever a default needs to flip for existing users.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

impl Default for Settings {
    fn default() -> Self {
        Self {
            my_lang: "ru".into(), peer_lang: "en".into(),
            mic_id: None, output_id: None,
            capture_mode: CaptureMode::App,
            echo_target_language: true,
            ducking_enabled: true, duck_level: 0.2,
            mix_original: false, mix_gain_db: -12.0,
            vad_economy: false,
            ui_lang: "ru".into(), wizard_done: false,
            tts_voice: "Kore".into(),
            idle_passthrough: true,
            idle_auto_stop: true,
            settings_schema_version: CURRENT_SCHEMA_VERSION,
        }
    }
}

/// Atomically write `settings` to `path` (tmp file → `sync_all` → rename) so a
/// crash mid-write can never corrupt the file. Shared by `patch` and the
/// one-shot migration in [`SettingsStore::open`].
fn write_settings_to_disk(path: &std::path::Path, settings: &Settings) -> anyhow::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    {
        use std::io::Write as _;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(serde_json::to_string_pretty(settings)?.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub struct SettingsStore { path: PathBuf, inner: Mutex<Settings> }

impl SettingsStore {
    // Fix #4: distinguish NotFound (→ defaults) from other I/O errors (→ propagate).
    // Parse errors on an existing file fall back to defaults but emit a tracing warning.
    pub fn open(path: PathBuf) -> anyhow::Result<Self> {
        let mut settings = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Settings>(&text) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(
                        path = %path.display(),
                        error = %e,
                        "settings.json is malformed, falling back to defaults"
                    );
                    Settings::default()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
            Err(e) => return Err(e.into()),
        };

        // One-shot migration: an existing file written by an older version
        // predates settings versioning (deserializes to schema_version 0). Flip
        // the same-language passthrough on exactly once (the user can turn it back
        // off afterwards — that choice is saved with the new version, so it
        // sticks), then persist so this never re-runs. Best-effort: a failed
        // write just means we migrate again next launch, which is harmless.
        if settings.settings_schema_version < CURRENT_SCHEMA_VERSION {
            settings.echo_target_language = true;
            settings.settings_schema_version = CURRENT_SCHEMA_VERSION;
            if let Err(e) = write_settings_to_disk(&path, &settings) {
                tracing::warn!(error = %e, "settings migration write failed; will retry next launch");
            }
        }

        Ok(Self { path, inner: Mutex::new(settings) })
    }

    pub fn get(&self) -> Settings { self.inner.lock().unwrap().clone() }

    /// Merge a partial JSON object into current settings.
    ///
    /// Fix #1: every key in the patch must already exist in the serialised current
    /// settings — unknown keys are rejected with an error.
    ///
    /// Fix #2/#3: validate and write to disk *before* updating in-memory state, and
    /// the mutex is NOT held across disk I/O (lock → clone → drop → I/O → re-lock →
    /// update).  Concurrent patches result in last-writer-wins — acceptable for a
    /// settings UI.
    pub fn patch(&self, patch: serde_json::Value) -> anyhow::Result<Settings> {
        // Step 1: lock, clone current state, drop the guard immediately.
        let current = {
            let guard = self.inner.lock().unwrap();
            guard.clone()
        };

        // Step 2: pure validation + merge (no lock held, no I/O).
        let serde_json::Value::Object(p) = patch else {
            anyhow::bail!("patch must be object")
        };

        let current_value = serde_json::to_value(&current)?;
        let current_obj = current_value.as_object().unwrap();

        // Fix #1: explicit unknown-key check (replaces deny_unknown_fields on the struct).
        for key in p.keys() {
            if !current_obj.contains_key(key) {
                anyhow::bail!("unknown setting: {key}");
            }
        }

        let mut merged = current_value.clone();
        merged.as_object_mut().unwrap().extend(p);
        let updated: Settings = serde_json::from_value(merged)?;

        // Fix #2: write to disk first, before touching in-memory state.
        write_settings_to_disk(&self.path, &updated)?;

        // Step 3: re-lock and update in-memory state only after the rename succeeded.
        {
            let mut guard = self.inner.lock().unwrap();
            *guard = updated.clone();
        }

        Ok(updated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane() {
        let s = Settings::default();
        assert_eq!(s.my_lang, "ru");
        assert_eq!(s.peer_lang, "en");
        assert!(s.ducking_enabled);
        assert!((s.duck_level - 0.2).abs() < f32::EPSILON);
        // Same-language passthrough (IN direction) is ON by default now.
        assert!(s.echo_target_language);
        assert!(!s.wizard_done);
        assert!(!s.mix_original);
        // VAD economy is opt-in, default off.
        assert!(!s.vad_economy);
        // Idle auto-stop is on by default; new installs start at the current schema.
        assert!(s.idle_auto_stop);
        assert_eq!(s.settings_schema_version, CURRENT_SCHEMA_VERSION);
    }

    /// A pre-versioning settings.json (no schemaVersion, explicit
    /// echoTargetLanguage:false) must be migrated once: the flag flips to true and
    /// the version is bumped and persisted, so a later explicit false now sticks.
    #[test]
    fn migration_flips_echo_on_for_old_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"myLang":"ru","peerLang":"es","echoTargetLanguage":false}"#,
        )
        .unwrap();

        let store = SettingsStore::open(path.clone()).unwrap();
        let s = store.get();
        assert!(s.echo_target_language, "migration must flip echo on");
        assert_eq!(s.settings_schema_version, CURRENT_SCHEMA_VERSION);
        // Untouched fields survive.
        assert_eq!(s.my_lang, "ru");
        assert_eq!(s.peer_lang, "es");

        // Re-open: now at the current version, a user's explicit `false` persists.
        store
            .patch(serde_json::json!({"echoTargetLanguage": false}))
            .unwrap();
        let reopened = SettingsStore::open(path).unwrap();
        assert!(
            !reopened.get().echo_target_language,
            "post-migration explicit false must stick"
        );
    }

    /// An older file missing the idleAutoStop key falls back to `true`.
    #[test]
    fn load_tolerates_missing_idle_auto_stop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"myLang":"en","settingsSchemaVersion":1}"#).unwrap();
        let store = SettingsStore::open(path).unwrap();
        assert!(store.get().idle_auto_stop);
    }

    /// An older settings.json predating `vadEconomy` must still load, with the
    /// missing field defaulting to `false` (serde `default` on the struct).
    #[test]
    fn load_tolerates_missing_vad_economy() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"myLang": "en", "peerLang": "ru"}"#).unwrap();
        let store = SettingsStore::open(path).unwrap();
        assert_eq!(store.get().my_lang, "en");
        assert!(!store.get().vad_economy);
    }

    #[test]
    fn roundtrip_save_load() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(dir.path().join("settings.json")).unwrap();
        store.patch(serde_json::json!({"myLang": "de", "duckLevel": 0.5})).unwrap();
        let again = SettingsStore::open(dir.path().join("settings.json")).unwrap();
        assert_eq!(again.get().my_lang, "de");
        assert!((again.get().duck_level - 0.5).abs() < f32::EPSILON);
        assert_eq!(again.get().peer_lang, "en"); // untouched fields keep defaults
    }

    #[test]
    fn patch_rejects_unknown_garbage_types() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(dir.path().join("s.json")).unwrap();
        assert!(store.patch(serde_json::json!({"duckLevel": "loud"})).is_err());
    }

    /// Fix #1 (new test): patch() must reject keys that don't exist in Settings.
    #[test]
    fn patch_rejects_unknown_keys() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(dir.path().join("s.json")).unwrap();
        let err = store.patch(serde_json::json!({"nope": 1})).unwrap_err();
        assert!(err.to_string().contains("unknown setting: nope"), "got: {err}");
    }

    /// Fix #1 (new test): open() must tolerate unknown fields in settings.json
    /// (forward-compat: a file written by a newer app version must not wipe prefs).
    #[test]
    fn load_tolerates_unknown_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        // Write a settings file that contains a known field and a future unknown field.
        std::fs::write(
            &path,
            r#"{"myLang": "fr", "futureField": 1}"#,
        )
        .unwrap();
        let store = SettingsStore::open(path).unwrap();
        // The known field must survive; the unknown field is silently ignored.
        assert_eq!(store.get().my_lang, "fr");
    }
}
