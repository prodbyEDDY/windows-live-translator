//! SQLite-backed history store for call records and voice messages.
//!
//! One database file, two tables, one `Mutex<Connection>` (rusqlite `Connection`
//! is `!Sync`).  All timestamps are stored as RFC-3339 strings via the `time`
//! crate (already a pinned dependency) — no chrono, no extra dep.

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use anyhow::Context as _;
use rusqlite::{params, Connection, OptionalExtension as _};
use serde::{Deserialize, Serialize};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

// ── record types ─────────────────────────────────────────────────────────────

/// A completed interpreter call stored in the `calls` table.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CallRecord {
    pub id: i64,
    pub started_at: String,
    pub my_lang: String,
    pub peer_lang: String,
    pub duration_secs: i64,
    pub transcript_json: String,
}

/// A voice message (drop-in or recorded) stored in the `voice_messages` table.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceRecord {
    pub id: i64,
    pub created_at: String,
    /// `"in"` = received / dropped-in;  `"out"` = recorded outgoing.
    pub kind: String,
    pub source_path: String,
    pub source_lang: Option<String>,
    pub transcript: Option<String>,
    pub translation: Option<String>,
    pub translated_audio_path: Option<String>,
    pub target_lang: String,
    /// Pipeline stage: `pending|transcribing|translating|synthesizing|done|error:<msg>`
    pub stage: String,
}

/// Partial update applied to a `VoiceRecord` via [`HistoryStore::update_voice`].
/// Only `Some` fields are written; `None` fields are left unchanged.
#[derive(Debug, Default, Clone)]
pub struct VoiceUpdate {
    pub source_lang: Option<String>,
    pub transcript: Option<String>,
    pub translation: Option<String>,
    pub translated_audio_path: Option<String>,
    pub stage: Option<String>,
}

// ── store ─────────────────────────────────────────────────────────────────────

/// Thread-safe SQLite history store.
///
/// The inner `Connection` is wrapped in a `Mutex` because rusqlite's
/// `Connection` is `!Sync`.  All methods take `&self` and lock for the
/// duration of the operation only.
pub struct HistoryStore {
    conn: Mutex<Connection>,
}

impl HistoryStore {
    /// Open (or create) the database at `path`.
    ///
    /// Creates the parent directory if it does not exist, opens the SQLite
    /// file, and runs `CREATE TABLE IF NOT EXISTS` for both tables so the
    /// schema is always up-to-date — idempotent, safe to call on an existing
    /// database.
    pub fn open(path: PathBuf) -> anyhow::Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .with_context(|| format!("create history dir {}", dir.display()))?;
        }

        let conn = Connection::open(&path)
            .with_context(|| format!("open history db at {}", path.display()))?;

        // Enable WAL for better concurrent read behaviour (cosmetic for a
        // single-writer app, but good practice).
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS calls (
                id              INTEGER PRIMARY KEY,
                started_at      TEXT    NOT NULL,
                my_lang         TEXT    NOT NULL,
                peer_lang       TEXT    NOT NULL,
                duration_secs   INTEGER NOT NULL,
                transcript_json TEXT    NOT NULL
            );
            CREATE TABLE IF NOT EXISTS voice_messages (
                id                    INTEGER PRIMARY KEY,
                created_at            TEXT NOT NULL,
                kind                  TEXT NOT NULL CHECK(kind IN ('in','out')),
                source_path           TEXT NOT NULL,
                source_lang           TEXT,
                transcript            TEXT,
                translation           TEXT,
                translated_audio_path TEXT,
                target_lang           TEXT NOT NULL,
                stage                 TEXT NOT NULL DEFAULT 'pending'
            );",
        )?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    // ── calls ──────────────────────────────────────────────────────────────

    /// Insert a new call record and return its auto-assigned `id`.
    pub fn save_call(
        &self,
        my_lang: &str,
        peer_lang: &str,
        duration_secs: i64,
        transcript_json: &str,
    ) -> anyhow::Result<i64> {
        let started_at = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .context("format started_at")?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO calls (started_at, my_lang, peer_lang, duration_secs, transcript_json)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![started_at, my_lang, peer_lang, duration_secs, transcript_json],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Return calls ordered newest-first.
    ///
    /// When `search` is `Some(s)`, only rows whose `transcript_json` contains
    /// `s` (case-insensitive LIKE) are returned.
    pub fn list_calls(&self, search: Option<&str>) -> anyhow::Result<Vec<CallRecord>> {
        let conn = self.conn.lock().unwrap();
        let (sql, like_pat) = match search {
            Some(s) => (
                "SELECT id, started_at, my_lang, peer_lang, duration_secs, transcript_json
                 FROM calls WHERE transcript_json LIKE ?1 ESCAPE '\\'
                 ORDER BY id DESC",
                Some(format!("%{}%", s.replace('%', "\\%").replace('_', "\\_"))),
            ),
            None => (
                "SELECT id, started_at, my_lang, peer_lang, duration_secs, transcript_json
                 FROM calls ORDER BY id DESC",
                None,
            ),
        };

        let mut stmt = conn.prepare(sql)?;
        let rows = if let Some(pat) = like_pat {
            stmt.query_map(params![pat], row_to_call)?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            stmt.query_map([], row_to_call)?
                .collect::<Result<Vec<_>, _>>()?
        };
        Ok(rows)
    }

    // ── voice messages ──────────────────────────────────────────────────────

    /// Insert a new voice record (stage = `"pending"`) and return its `id`.
    pub fn save_voice(
        &self,
        kind: &str,
        source_path: &str,
        target_lang: &str,
    ) -> anyhow::Result<i64> {
        let created_at = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .context("format created_at")?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO voice_messages
                 (created_at, kind, source_path, target_lang, stage)
             VALUES (?1, ?2, ?3, ?4, 'pending')",
            params![created_at, kind, source_path, target_lang],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Overwrite the `source_path` of an existing voice row.
    ///
    /// `source_path` is set once at insert and is deliberately *not* part of
    /// [`VoiceUpdate`]; the pipeline uses this to swap the placeholder path
    /// (inserted before the row id was known) for the canonical `{id}-source.*`
    /// file name once the id exists.
    pub fn set_source_path(&self, id: i64, source_path: &str) -> anyhow::Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE voice_messages SET source_path = ?1 WHERE id = ?2",
            params![source_path, id],
        )?;
        Ok(())
    }

    /// Apply a partial update to a voice record.
    ///
    /// Only fields that are `Some` in `patch` are written.  If `patch` is
    /// entirely empty the call is a no-op (no SQL executed).
    pub fn update_voice(&self, id: i64, patch: VoiceUpdate) -> anyhow::Result<()> {
        // Build a dynamic SET clause from whichever fields are present.
        let mut sets: Vec<&str> = Vec::new();
        if patch.source_lang.is_some() {
            sets.push("source_lang = ?");
        }
        if patch.transcript.is_some() {
            sets.push("transcript = ?");
        }
        if patch.translation.is_some() {
            sets.push("translation = ?");
        }
        if patch.translated_audio_path.is_some() {
            sets.push("translated_audio_path = ?");
        }
        if patch.stage.is_some() {
            sets.push("stage = ?");
        }

        if sets.is_empty() {
            return Ok(());
        }

        // Positional placeholders: ?1…?N for fields, ?N+1 for the WHERE id.
        let numbered: Vec<String> = sets
            .iter()
            .enumerate()
            .map(|(i, col)| col.replace('?', &format!("?{}", i + 1)))
            .collect();
        let id_placeholder = format!("?{}", sets.len() + 1);
        let sql = format!(
            "UPDATE voice_messages SET {} WHERE id = {}",
            numbered.join(", "),
            id_placeholder
        );

        // Build the params list in matching order.
        let conn = self.conn.lock().unwrap();
        // rusqlite requires a homogeneous params type, so use `dyn ToSql`.
        use rusqlite::types::ToSql;
        let mut values: Vec<Box<dyn ToSql>> = Vec::new();
        if let Some(v) = patch.source_lang {
            values.push(Box::new(v));
        }
        if let Some(v) = patch.transcript {
            values.push(Box::new(v));
        }
        if let Some(v) = patch.translation {
            values.push(Box::new(v));
        }
        if let Some(v) = patch.translated_audio_path {
            values.push(Box::new(v));
        }
        if let Some(v) = patch.stage {
            values.push(Box::new(v));
        }
        values.push(Box::new(id));

        let params_refs: Vec<&dyn ToSql> = values.iter().map(|v| v.as_ref()).collect();
        conn.execute(&sql, params_refs.as_slice())?;
        Ok(())
    }

    /// Fetch a single voice record by id.
    pub fn get_voice(&self, id: i64) -> anyhow::Result<Option<VoiceRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, created_at, kind, source_path, source_lang,
                    transcript, translation, translated_audio_path, target_lang, stage
             FROM voice_messages WHERE id = ?1",
        )?;
        let record = stmt
            .query_row(params![id], row_to_voice)
            .optional()?;
        Ok(record)
    }

    /// Return voice messages ordered newest-first.
    ///
    /// When `search` is `Some(s)`, only rows where `transcript` OR
    /// `translation` contains `s` (LIKE) are returned.
    pub fn list_voice(&self, search: Option<&str>) -> anyhow::Result<Vec<VoiceRecord>> {
        let conn = self.conn.lock().unwrap();
        let (sql, like_pat) = match search {
            Some(s) => (
                "SELECT id, created_at, kind, source_path, source_lang,
                        transcript, translation, translated_audio_path, target_lang, stage
                 FROM voice_messages
                 WHERE transcript LIKE ?1 ESCAPE '\\'
                    OR translation LIKE ?1 ESCAPE '\\'
                 ORDER BY id DESC",
                Some(format!("%{}%", s.replace('%', "\\%").replace('_', "\\_"))),
            ),
            None => (
                "SELECT id, created_at, kind, source_path, source_lang,
                        transcript, translation, translated_audio_path, target_lang, stage
                 FROM voice_messages ORDER BY id DESC",
                None,
            ),
        };

        let mut stmt = conn.prepare(sql)?;
        let rows = if let Some(pat) = like_pat {
            stmt.query_map(params![pat], row_to_voice)?
                .collect::<Result<Vec<_>, _>>()?
        } else {
            stmt.query_map([], row_to_voice)?
                .collect::<Result<Vec<_>, _>>()?
        };
        Ok(rows)
    }

    /// Delete all rows from both tables and remove every file under `voice_dir`.
    ///
    /// Individual file-removal errors are silently ignored (the database rows
    /// are always cleared regardless).
    pub fn clear_all(&self, voice_dir: &Path) -> anyhow::Result<()> {
        {
            let conn = self.conn.lock().unwrap();
            conn.execute_batch("DELETE FROM voice_messages; DELETE FROM calls;")?;
        }

        // Best-effort: remove files under voice_dir; ignore per-file errors.
        if voice_dir.is_dir() {
            if let Ok(entries) = std::fs::read_dir(voice_dir) {
                for entry in entries.flatten() {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }

        Ok(())
    }
}

// ── row mappers ───────────────────────────────────────────────────────────────

fn row_to_call(row: &rusqlite::Row<'_>) -> rusqlite::Result<CallRecord> {
    Ok(CallRecord {
        id: row.get(0)?,
        started_at: row.get(1)?,
        my_lang: row.get(2)?,
        peer_lang: row.get(3)?,
        duration_secs: row.get(4)?,
        transcript_json: row.get(5)?,
    })
}

fn row_to_voice(row: &rusqlite::Row<'_>) -> rusqlite::Result<VoiceRecord> {
    Ok(VoiceRecord {
        id: row.get(0)?,
        created_at: row.get(1)?,
        kind: row.get(2)?,
        source_path: row.get(3)?,
        source_lang: row.get(4)?,
        transcript: row.get(5)?,
        translation: row.get(6)?,
        translated_audio_path: row.get(7)?,
        target_lang: row.get(8)?,
        stage: row.get(9)?,
    })
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn open_temp() -> (HistoryStore, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let store = HistoryStore::open(dir.path().join("history.db")).unwrap();
        (store, dir)
    }

    // ── calls ─────────────────────────────────────────────────────────────

    #[test]
    fn call_roundtrip() {
        let (store, _dir) = open_temp();
        let id = store
            .save_call("ru", "en", 42, r#"[{"text":"hello"}]"#)
            .unwrap();
        assert!(id > 0);

        let calls = store.list_calls(None).unwrap();
        assert_eq!(calls.len(), 1);
        let rec = &calls[0];
        assert_eq!(rec.id, id);
        assert_eq!(rec.my_lang, "ru");
        assert_eq!(rec.peer_lang, "en");
        assert_eq!(rec.duration_secs, 42);
        assert_eq!(rec.transcript_json, r#"[{"text":"hello"}]"#);
        // started_at should be a valid RFC-3339 string
        assert!(rec.started_at.contains('T'));
    }

    #[test]
    fn call_list_order_newest_first() {
        let (store, _dir) = open_temp();
        store.save_call("ru", "en", 10, "[]").unwrap();
        store.save_call("de", "fr", 20, "[]").unwrap();
        let calls = store.list_calls(None).unwrap();
        assert_eq!(calls.len(), 2);
        // newest (higher id) first
        assert!(calls[0].id > calls[1].id);
    }

    #[test]
    fn call_search_filters() {
        let (store, _dir) = open_temp();
        store
            .save_call("ru", "en", 5, r#"[{"text":"привет мир"}]"#)
            .unwrap();
        store
            .save_call("ru", "en", 5, r#"[{"text":"hello world"}]"#)
            .unwrap();

        let found = store.list_calls(Some("привет")).unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].transcript_json.contains("привет"));

        let none = store.list_calls(Some("xyz_not_here")).unwrap();
        assert!(none.is_empty());

        let all = store.list_calls(Some("text")).unwrap();
        assert_eq!(all.len(), 2);
    }

    // ── voice messages ────────────────────────────────────────────────────

    #[test]
    fn voice_roundtrip() {
        let (store, _dir) = open_temp();
        let id = store.save_voice("in", "/tmp/foo.ogg", "en").unwrap();
        assert!(id > 0);

        let rec = store.get_voice(id).unwrap().expect("record exists");
        assert_eq!(rec.id, id);
        assert_eq!(rec.kind, "in");
        assert_eq!(rec.source_path, "/tmp/foo.ogg");
        assert_eq!(rec.target_lang, "en");
        assert_eq!(rec.stage, "pending");
        assert!(rec.source_lang.is_none());
        assert!(rec.transcript.is_none());
        assert!(rec.translation.is_none());
        assert!(rec.translated_audio_path.is_none());
    }

    #[test]
    fn voice_update_stage() {
        let (store, _dir) = open_temp();
        let id = store.save_voice("out", "/tmp/rec.wav", "de").unwrap();

        store
            .update_voice(
                id,
                VoiceUpdate {
                    stage: Some("transcribing".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let rec = store.get_voice(id).unwrap().unwrap();
        assert_eq!(rec.stage, "transcribing");

        store
            .update_voice(
                id,
                VoiceUpdate {
                    transcript: Some("Hallo Welt".into()),
                    translation: Some("Hello World".into()),
                    stage: Some("done".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let rec = store.get_voice(id).unwrap().unwrap();
        assert_eq!(rec.stage, "done");
        assert_eq!(rec.transcript.as_deref(), Some("Hallo Welt"));
        assert_eq!(rec.translation.as_deref(), Some("Hello World"));
    }

    #[test]
    fn voice_update_empty_patch_noop() {
        let (store, _dir) = open_temp();
        let id = store.save_voice("in", "/a.ogg", "ru").unwrap();
        // Should not panic or error
        store
            .update_voice(id, VoiceUpdate::default())
            .unwrap();
        let rec = store.get_voice(id).unwrap().unwrap();
        assert_eq!(rec.stage, "pending");
    }

    #[test]
    fn voice_get_missing_returns_none() {
        let (store, _dir) = open_temp();
        let result = store.get_voice(9999).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn voice_list_order_newest_first() {
        let (store, _dir) = open_temp();
        store.save_voice("in", "/a.ogg", "en").unwrap();
        store.save_voice("out", "/b.ogg", "fr").unwrap();
        let list = store.list_voice(None).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list[0].id > list[1].id);
    }

    #[test]
    fn voice_search_filters_transcript_and_translation() {
        let (store, _dir) = open_temp();
        let id1 = store.save_voice("in", "/a.ogg", "en").unwrap();
        let id2 = store.save_voice("in", "/b.ogg", "en").unwrap();

        store
            .update_voice(
                id1,
                VoiceUpdate {
                    transcript: Some("привет мир".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .update_voice(
                id2,
                VoiceUpdate {
                    translation: Some("hello world".into()),
                    ..Default::default()
                },
            )
            .unwrap();

        // Search transcript
        let found = store.list_voice(Some("привет")).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, id1);

        // Search translation
        let found = store.list_voice(Some("hello")).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, id2);

        // No match
        let none = store.list_voice(Some("xyz_nope")).unwrap();
        assert!(none.is_empty());
    }

    // ── clear_all ─────────────────────────────────────────────────────────

    #[test]
    fn clear_all_removes_rows_and_files() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("history.db");
        let voice_dir = dir.path().join("voice");
        std::fs::create_dir_all(&voice_dir).unwrap();

        let store = HistoryStore::open(db_path).unwrap();

        // Insert some records
        store.save_call("ru", "en", 5, "[]").unwrap();
        let vid = store.save_voice("in", "/x.ogg", "en").unwrap();

        // Create dummy files in voice_dir
        let f1 = voice_dir.join("clip1.ogg");
        let f2 = voice_dir.join("clip2.ogg");
        std::fs::write(&f1, b"dummy").unwrap();
        std::fs::write(&f2, b"dummy").unwrap();

        assert!(f1.exists());
        assert!(f2.exists());

        store.clear_all(&voice_dir).unwrap();

        // Rows cleared
        assert!(store.list_calls(None).unwrap().is_empty());
        assert!(store.list_voice(None).unwrap().is_empty());
        assert!(store.get_voice(vid).unwrap().is_none());

        // Files removed
        assert!(!f1.exists());
        assert!(!f2.exists());
    }

    #[test]
    fn clear_all_nonexistent_voice_dir_is_ok() {
        let (store, dir) = open_temp();
        let fake_dir = dir.path().join("no_such_dir");
        // Should not error even if the directory doesn't exist
        store.clear_all(&fake_dir).unwrap();
    }

    // ── serialisation ─────────────────────────────────────────────────────

    #[test]
    fn records_serialise_camel_case() {
        let rec = CallRecord {
            id: 1,
            started_at: "2026-01-01T00:00:00Z".into(),
            my_lang: "ru".into(),
            peer_lang: "en".into(),
            duration_secs: 60,
            transcript_json: "[]".into(),
        };
        let json = serde_json::to_string(&rec).unwrap();
        assert!(json.contains("\"startedAt\""));
        assert!(json.contains("\"myLang\""));
        assert!(json.contains("\"peerLang\""));
        assert!(json.contains("\"durationSecs\""));
        assert!(json.contains("\"transcriptJson\""));

        let vrec = VoiceRecord {
            id: 2,
            created_at: "2026-01-01T00:00:00Z".into(),
            kind: "in".into(),
            source_path: "/p.ogg".into(),
            source_lang: None,
            transcript: None,
            translation: None,
            translated_audio_path: None,
            target_lang: "en".into(),
            stage: "pending".into(),
        };
        let vj = serde_json::to_string(&vrec).unwrap();
        assert!(vj.contains("\"createdAt\""));
        assert!(vj.contains("\"sourcePath\""));
        assert!(vj.contains("\"targetLang\""));
        assert!(vj.contains("\"translatedAudioPath\""));
    }
}
