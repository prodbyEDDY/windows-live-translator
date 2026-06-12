use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CaptureMode { App, System }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
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
            ui_lang: "ru".into(), wizard_done: false,
            tts_voice: "Kore".into(),
        }
    }
}

pub struct SettingsStore { path: PathBuf, inner: Mutex<Settings> }

impl SettingsStore {
    pub fn open(path: PathBuf) -> anyhow::Result<Self> {
        let settings = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => Settings::default(),
        };
        Ok(Self { path, inner: Mutex::new(settings) })
    }

    pub fn get(&self) -> Settings { self.inner.lock().unwrap().clone() }

    /// Merge a partial JSON object into current settings; unknown/badly-typed fields error.
    pub fn patch(&self, patch: serde_json::Value) -> anyhow::Result<Settings> {
        let mut guard = self.inner.lock().unwrap();
        let mut merged = serde_json::to_value(&*guard)?;
        let serde_json::Value::Object(p) = patch else { anyhow::bail!("patch must be object") };
        merged.as_object_mut().unwrap().extend(p);
        let updated: Settings = serde_json::from_value(merged)?;
        *guard = updated.clone();
        if let Some(dir) = self.path.parent() { std::fs::create_dir_all(dir)?; }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&updated)?)?;
        std::fs::rename(&tmp, &self.path)?;
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
}
