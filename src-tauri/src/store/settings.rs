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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            my_lang: "ru".into(), peer_lang: "en".into(),
            mic_id: None, output_id: None,
            capture_mode: CaptureMode::App,
            echo_target_language: false,
            ducking_enabled: true, duck_level: 0.2,
            mix_original: false, mix_gain_db: -12.0,
            vad_economy: false,
            ui_lang: "ru".into(), wizard_done: false,
            tts_voice: "Kore".into(),
        }
    }
}

pub struct SettingsStore { path: PathBuf, inner: Mutex<Settings> }

impl SettingsStore {
    // Fix #4: distinguish NotFound (→ defaults) from other I/O errors (→ propagate).
    // Parse errors on an existing file fall back to defaults but emit a tracing warning.
    pub fn open(path: PathBuf) -> anyhow::Result<Self> {
        let settings = match std::fs::read_to_string(&path) {
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
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        {
            use std::io::Write as _;
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(serde_json::to_string_pretty(&updated)?.as_bytes())?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, &self.path)?;

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
        assert!(!s.echo_target_language);
        assert!(!s.wizard_done);
        assert!(!s.mix_original);
        // VAD economy is opt-in, default off.
        assert!(!s.vad_economy);
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
