use crate::filing::Attempt;
use crate::protocol::{
    BlobRef, Capture, CaptureKind, CaptureMode, ClientInfo, ClientSeen, Edits, Observation,
    ObservationStatus, ObservationSummary, Project, Review, ReviewSummary, Shape, Shot, VoiceNote,
    VoiceSegment, VoiceState,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

/// Each entry moves the schema one version forward. Append; never edit a shipped entry.
const MIGRATIONS: &[&str] = &[
    "CREATE TABLE observations (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT,
        created_at INTEGER NOT NULL
    );",
    "CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        origins TEXT NOT NULL,
        enabled INTEGER NOT NULL
    );
    CREATE TABLE captures (
        id INTEGER PRIMARY KEY,
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        page_url TEXT NOT NULL,
        page_title TEXT NOT NULL,
        mode TEXT NOT NULL,
        screenshot_sha256 TEXT NOT NULL,
        screenshot_size INTEGER NOT NULL,
        evidence_sha256 TEXT NOT NULL,
        evidence_size INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        gap_count INTEGER NOT NULL
    );
    CREATE INDEX captures_by_observation ON captures(observation_id);",
    "ALTER TABLE captures ADD COLUMN annotations TEXT NOT NULL DEFAULT '[]';",
    "ALTER TABLE observations ADD COLUMN notes TEXT NOT NULL DEFAULT '';
    ALTER TABLE observations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE observations ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
    UPDATE observations SET updated_at = created_at;",
    "ALTER TABLE captures ADD COLUMN recording_sha256 TEXT;
    ALTER TABLE captures ADD COLUMN recording_size INTEGER;",
    "CREATE TABLE reviews (
        id INTEGER PRIMARY KEY,
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        body TEXT NOT NULL
    );",
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE filings (
        review_id INTEGER PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
        observation_id INTEGER NOT NULL,
        body TEXT NOT NULL
    );",
    "CREATE TABLE clients (
        profile TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        last_seen INTEGER NOT NULL
    );",
    "CREATE TABLE voice_notes (
        id INTEGER PRIMARY KEY,
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        audio_sha256 TEXT NOT NULL,
        audio_size INTEGER NOT NULL,
        state TEXT NOT NULL,
        language TEXT,
        segments TEXT NOT NULL DEFAULT '[]',
        detail TEXT
    );
    CREATE INDEX voice_notes_by_observation ON voice_notes(observation_id);",
    "ALTER TABLE captures ADD COLUMN kind TEXT NOT NULL DEFAULT 'moment';
    ALTER TABLE captures ADD COLUMN started_at INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE captures ADD COLUMN edits TEXT NOT NULL DEFAULT '{}';",
    "ALTER TABLE captures ADD COLUMN shots TEXT NOT NULL DEFAULT '[]';",
    "ALTER TABLE observations ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';",
    // AUTOINCREMENT: an ID is never given again after a delete, so a page, an agent or a folder
    // that still holds an old ID never reaches a new record. SQLite cannot add it in place: each
    // table is rebuilt with the same columns (foreign keys are off while a migration runs).
    "CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        url TEXT,
        created_at INTEGER NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]'
    );
    INSERT INTO observations_new SELECT id, title, url, created_at, notes, revision, updated_at, tags
        FROM observations;
    DROP TABLE observations;
    ALTER TABLE observations_new RENAME TO observations;
    CREATE TABLE captures_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        page_url TEXT NOT NULL,
        page_title TEXT NOT NULL,
        mode TEXT NOT NULL,
        screenshot_sha256 TEXT NOT NULL,
        screenshot_size INTEGER NOT NULL,
        evidence_sha256 TEXT NOT NULL,
        evidence_size INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        gap_count INTEGER NOT NULL,
        annotations TEXT NOT NULL DEFAULT '[]',
        recording_sha256 TEXT,
        recording_size INTEGER,
        kind TEXT NOT NULL DEFAULT 'moment',
        started_at INTEGER NOT NULL DEFAULT 0,
        edits TEXT NOT NULL DEFAULT '{}',
        shots TEXT NOT NULL DEFAULT '[]'
    );
    INSERT INTO captures_new SELECT id, observation_id, created_at, page_url, page_title, mode,
        screenshot_sha256, screenshot_size, evidence_sha256, evidence_size, event_count, gap_count,
        annotations, recording_sha256, recording_size, kind, started_at, edits, shots FROM captures;
    DROP TABLE captures;
    ALTER TABLE captures_new RENAME TO captures;
    CREATE INDEX captures_by_observation ON captures(observation_id);
    CREATE TABLE reviews_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        body TEXT NOT NULL
    );
    INSERT INTO reviews_new SELECT id, observation_id, body FROM reviews;
    DROP TABLE reviews;
    ALTER TABLE reviews_new RENAME TO reviews;
    CREATE TABLE voice_notes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        audio_sha256 TEXT NOT NULL,
        audio_size INTEGER NOT NULL,
        state TEXT NOT NULL,
        language TEXT,
        segments TEXT NOT NULL DEFAULT '[]',
        detail TEXT
    );
    INSERT INTO voice_notes_new SELECT id, observation_id, started_at, duration_ms, audio_sha256,
        audio_size, state, language, segments, detail FROM voice_notes;
    DROP TABLE voice_notes;
    ALTER TABLE voice_notes_new RENAME TO voice_notes;
    CREATE INDEX voice_notes_by_observation ON voice_notes(observation_id);
    -- Before this, a deleted newest row gave its ID to the next one, so IDs above today's highest
    -- may have been used and still be named elsewhere (a VibeQ observation, an export folder, a
    -- page). New IDs start a thousand above: more deletes of the newest rows in a row than that,
    -- before this update, is not a case Lens expects. A new notebook (no rows, no settings) has
    -- used no ID and starts at 1.
    DELETE FROM sqlite_sequence
        WHERE name IN ('observations', 'captures', 'reviews', 'voice_notes');
    INSERT INTO sqlite_sequence (name, seq)
        SELECT 'observations', COALESCE(MAX(id), 0) + 1000 * (EXISTS (SELECT 1 FROM settings)
            OR EXISTS (SELECT 1 FROM observations)) FROM observations
        UNION ALL SELECT 'captures', COALESCE(MAX(id), 0) + 1000 * (EXISTS (SELECT 1 FROM settings)
            OR EXISTS (SELECT 1 FROM observations)) FROM captures
        UNION ALL SELECT 'reviews', COALESCE(MAX(id), 0) + 1000 * (EXISTS (SELECT 1 FROM settings)
            OR EXISTS (SELECT 1 FROM observations)) FROM reviews
        UNION ALL SELECT 'voice_notes', COALESCE(MAX(id), 0) + 1000 * (EXISTS (SELECT 1 FROM settings)
            OR EXISTS (SELECT 1 FROM observations)) FROM voice_notes;",
];

/// A stored body this Lens cannot read (a newer Lens wrote it, say) is left out, and says so in
/// the log, instead of vanishing without a word.
fn unreadable<T>(what: &str, id: i64, parsed: serde_json::Result<T>) -> Option<T> {
    parsed
        .map_err(|e| eprintln!("lens: a stored {what} ({id}) is not readable and is left out: {e}"))
        .ok()
}

/// An observation's filings so far.
#[derive(Debug, PartialEq)]
pub struct Filed {
    /// The highest VibeQ revision sent: the next filing goes above it.
    pub vibeq_revision: u64,
    /// The newest notes revision filed: an older review would undo it.
    pub reviewed_revision: u32,
    /// The VibeQ project of the first filing: amendments stay in it (VibeQ keys a task by it).
    pub project_id: String,
    /// The newest review filed: an older one would send what that review left out (a mask
    /// added since, say).
    pub review: i64,
    /// The VibeQ of the first filing: the task lives there, so amendments go there too.
    pub endpoint: String,
}

/// One task of a split: its title, notes and tags, and edits by original capture ID.
pub struct TaskPlan {
    pub title: String,
    pub notes: String,
    pub tags: Vec<String>,
    pub edits: Vec<(i64, Edits)>,
    /// Captures of the original that this task leaves out.
    pub leave: Vec<i64>,
}

/// Copies every capture and voice note of `from` to `to`, in ID order.
fn copy_children(tx: &rusqlite::Transaction, from: i64, to: i64) -> rusqlite::Result<()> {
    for table in ["captures", "voice_notes"] {
        // Every column but the row ID and the owner, so a later migration is copied too.
        let columns: Vec<String> = tx
            .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<String>>>()?
            .into_iter()
            .filter(|c| c != "id" && c != "observation_id")
            .collect();
        let columns = columns.join(", ");
        tx.execute(
            &format!(
                "INSERT INTO {table} (observation_id, {columns})
                 SELECT ?2, {columns} FROM {table} WHERE observation_id = ?1 ORDER BY id"
            ),
            params![from, to],
        )?;
    }
    Ok(())
}

/// What an update found.
#[derive(Debug)]
pub enum Updated {
    Saved(Observation),
    /// Someone saved first; this is their version.
    Conflict(Observation),
    Missing,
}

const OBSERVATION_COLUMNS: &str = "id, title, url, notes, revision, created_at, updated_at, tags";

fn observation_from_row(row: &rusqlite::Row) -> rusqlite::Result<Observation> {
    Ok(Observation {
        id: row.get(0)?,
        title: row.get(1)?,
        url: row.get(2)?,
        notes: row.get(3)?,
        revision: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        tags: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or_default(),
    })
}

const CAPTURE_COLUMNS: &str = "id, observation_id, created_at, page_url, page_title, mode,
    screenshot_sha256, screenshot_size, evidence_sha256, evidence_size, event_count, gap_count,
    annotations, recording_sha256, recording_size, kind, started_at, edits, shots";

fn capture_from_row(row: &rusqlite::Row) -> rusqlite::Result<Capture> {
    let mode: String = row.get(5)?;
    let annotations: String = row.get(12)?;
    let kind: String = row.get(15)?;
    let edits: String = row.get(17)?;
    Ok(Capture {
        id: row.get(0)?,
        observation: row.get(1)?,
        created_at: row.get(2)?,
        page_url: row.get(3)?,
        page_title: row.get(4)?,
        mode: mode_from(&mode),
        screenshot: BlobRef {
            sha256: row.get(6)?,
            size: row.get::<_, i64>(7)? as u64,
            media_type: "image/png".into(),
        },
        evidence: BlobRef {
            sha256: row.get(8)?,
            size: row.get::<_, i64>(9)? as u64,
            media_type: "application/json".into(),
        },
        event_count: row.get(10)?,
        gap_count: row.get(11)?,
        annotations: stored_json(12, &annotations)?,
        recording: match (
            row.get::<_, Option<String>>(13)?,
            row.get::<_, Option<i64>>(14)?,
        ) {
            (Some(sha256), Some(size)) => Some(BlobRef {
                sha256,
                size: size as u64,
                media_type: "application/json".into(),
            }),
            _ => None,
        },
        kind: if kind == "session" {
            CaptureKind::Session
        } else {
            CaptureKind::Moment
        },
        started_at: row.get(16)?,
        edits: stored_json(17, &edits)?,
        shots: stored_json(18, &row.get::<_, String>(18)?)?,
    })
}

/// A JSON column read strictly: masks and cuts that cannot be read must fail the capture, never
/// read as none, so a review cannot leave with what the person hid.
fn stored_json<T: serde::de::DeserializeOwned>(column: usize, text: &str) -> rusqlite::Result<T> {
    serde_json::from_str(text).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(e))
    })
}

/// The first finding, else the first line of the notes, for a list row.
fn headline(notes: &str) -> Option<String> {
    let line = notes
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("Findings"))?
        .trim_start_matches(['-', '*', ' '])
        .trim();
    (!line.is_empty()).then(|| line.chars().take(140).collect())
}

const VOICE_COLUMNS: &str = "id, observation_id, started_at, duration_ms, audio_sha256, audio_size,
    state, language, segments, detail";

fn voice_from_row(row: &rusqlite::Row) -> rusqlite::Result<VoiceNote> {
    let state: String = row.get(6)?;
    let segments: String = row.get(8)?;
    Ok(VoiceNote {
        id: row.get(0)?,
        observation: row.get(1)?,
        started_at: row.get(2)?,
        duration_ms: row.get(3)?,
        audio: BlobRef {
            sha256: row.get(4)?,
            size: row.get::<_, i64>(5)? as u64,
            media_type: "audio/wav".into(),
        },
        state: match state.as_str() {
            "transcribing" => VoiceState::Transcribing,
            "done" => VoiceState::Done,
            "failed" => VoiceState::Failed,
            _ => VoiceState::Waiting,
        },
        language: row.get(7)?,
        segments: serde_json::from_str(&segments).unwrap_or_default(),
        detail: row.get(9)?,
    })
}

/// A capture's row before it has an ID and an observation.
pub struct CaptureRow {
    pub created_at: i64,
    pub page_url: String,
    pub page_title: String,
    pub mode: CaptureMode,
    pub screenshot: BlobRef,
    pub evidence: BlobRef,
    pub event_count: u32,
    pub gap_count: u32,
    pub recording: Option<BlobRef>,
    pub kind: CaptureKind,
    pub started_at: i64,
    pub shots: Vec<Shot>,
}

fn mode_name(mode: CaptureMode) -> &'static str {
    match mode {
        CaptureMode::Deep => "deep",
        CaptureMode::Limited => "limited",
        CaptureMode::ScreenshotOnly => "screenshotOnly",
    }
}

fn mode_from(name: &str) -> CaptureMode {
    match name {
        "deep" => CaptureMode::Deep,
        "limited" => CaptureMode::Limited,
        _ => CaptureMode::ScreenshotOnly,
    }
}

pub struct Store {
    db: Connection,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let db = Connection::open(path)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "foreign_keys", "ON")?;
        let mut store = Self { db };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&mut self) -> rusqlite::Result<()> {
        let current: i64 = self
            .db
            .pragma_query_value(None, "user_version", |row| row.get(0))?;
        let current = usize::try_from(current).unwrap_or(usize::MAX);
        if current > MIGRATIONS.len() {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "the notebook uses schema {current}, newer than this Lens ({}); update Lens",
                MIGRATIONS.len()
            )));
        }
        if current == MIGRATIONS.len() {
            return Ok(());
        }
        // A rebuilt table is dropped and renamed: with foreign keys on, the drop would cascade
        // and delete every child row. SQLite ignores this pragma inside a transaction.
        self.db.pragma_update(None, "foreign_keys", "OFF")?;
        let result = (|| {
            for (index, sql) in MIGRATIONS.iter().enumerate().skip(current) {
                let tx = self.db.transaction()?;
                // A rebuild copies rows as they are: it cannot break a link that was whole.
                tx.execute_batch(sql)?;
                tx.pragma_update(None, "user_version", index as i64 + 1)?;
                tx.commit()?;
            }
            Ok(())
        })();
        self.db.pragma_update(None, "foreign_keys", "ON")?;
        result
    }

    pub fn create_observation(
        &self,
        title: &str,
        url: Option<&str>,
        created_at: i64,
    ) -> rusqlite::Result<Observation> {
        self.db.execute(
            "INSERT INTO observations (title, url, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![title, url, created_at],
        )?;
        Ok(self
            .get_observation(self.db.last_insert_rowid())?
            .expect("the row was just inserted"))
    }

    pub fn get_observation(&self, id: i64) -> rusqlite::Result<Option<Observation>> {
        let mut statement = self.db.prepare(&format!(
            "SELECT {OBSERVATION_COLUMNS} FROM observations WHERE id = ?1"
        ))?;
        statement
            .query_map([id], observation_from_row)?
            .next()
            .transpose()
    }

    // ponytail: the whole list in one reply; page it when a notebook nears 5000 observations
    // (about 1 MiB of summaries).
    pub fn list_observations(&self) -> rusqlite::Result<Vec<ObservationSummary>> {
        let mut statement = self.db.prepare(
            "SELECT o.id, o.title, o.url, o.created_at, o.updated_at,
                (SELECT COUNT(*) FROM captures c WHERE c.observation_id = o.id),
                EXISTS (SELECT 1 FROM captures c WHERE c.observation_id = o.id AND c.kind = 'session'),
                (SELECT COALESCE(SUM(c.created_at - c.started_at), 0) FROM captures c
                    WHERE c.observation_id = o.id AND c.started_at > 0),
                (SELECT COUNT(*) FROM voice_notes v WHERE v.observation_id = o.id),
                EXISTS (SELECT 1 FROM filings f WHERE f.observation_id = o.id
                    AND json_extract(f.body, '$.receipt') IS NOT NULL),
                EXISTS (SELECT 1 FROM reviews r WHERE r.observation_id = o.id),
                (SELECT c.screenshot_sha256 FROM captures c WHERE c.observation_id = o.id ORDER BY c.id DESC LIMIT 1),
                (SELECT c.screenshot_size FROM captures c WHERE c.observation_id = o.id ORDER BY c.id DESC LIMIT 1),
                o.notes,
                (SELECT json_extract(f.body, '$.receipt.taskUrl') FROM filings f
                    WHERE f.observation_id = o.id AND json_extract(f.body, '$.receipt') IS NOT NULL
                    ORDER BY f.review_id DESC LIMIT 1)
             FROM observations o ORDER BY o.created_at DESC, o.id DESC",
        )?;
        statement
            .query_map([], |row| {
                let sha: Option<String> = row.get(11)?;
                let size: Option<i64> = row.get(12)?;
                let notes: String = row.get(13)?;
                Ok(ObservationSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    url: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    capture_count: row.get(5)?,
                    kind: if row.get::<_, bool>(6)? {
                        CaptureKind::Session
                    } else {
                        CaptureKind::Moment
                    },
                    duration_ms: row.get(7)?,
                    voice_count: row.get(8)?,
                    status: if row.get::<_, bool>(9)? {
                        ObservationStatus::Filed
                    } else if row.get::<_, bool>(10)? {
                        ObservationStatus::Reviewed
                    } else {
                        ObservationStatus::Draft
                    },
                    thumbnail: sha.zip(size).map(|(sha256, size)| BlobRef {
                        sha256,
                        size: size as u64,
                        media_type: "image/png".into(),
                    }),
                    headline: headline(&notes),
                    task_url: row.get(14)?,
                })
            })?
            .collect()
    }

    /// Every blob a record still names, and every review that exists. A blob is named by its
    /// sha256 in some text column (a column of its own, or inside a JSON body), so any run of 64
    /// lowercase hex digits counts: a false match only keeps a blob longer.
    pub fn references(
        &self,
    ) -> rusqlite::Result<(
        std::collections::HashSet<String>,
        std::collections::HashSet<i64>,
    )> {
        let mut blobs = std::collections::HashSet::new();
        let tables: Vec<String> = self
            .db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for table in tables {
            let mut statement = self
                .db
                .prepare(&format!("SELECT * FROM \"{}\"", table.replace('"', "\"\"")))?;
            let columns = statement.column_count();
            let mut rows = statement.query([])?;
            while let Some(row) = rows.next()? {
                for i in 0..columns {
                    if let rusqlite::types::ValueRef::Text(text) = row.get_ref(i)? {
                        hex_runs(text, &mut blobs);
                    }
                }
            }
        }
        let reviews = self
            .db
            .prepare("SELECT id FROM reviews")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok((blobs, reviews))
    }

    /// Deletes an observation; captures, voice notes and reviews go with it. Returns false when
    /// there is none. Blobs stay: other records may share them.
    pub fn delete_observation(&self, id: i64) -> rusqlite::Result<bool> {
        // One transaction: a failure never leaves the observation without its filing receipt.
        let tx = self.db.unchecked_transaction()?;
        tx.execute("DELETE FROM filings WHERE observation_id = ?1", [id])?;
        let deleted = tx.execute("DELETE FROM observations WHERE id = ?1", [id])? > 0;
        for key in [format!("issues.{id}"), format!("title.auto.{id}")] {
            tx.execute("DELETE FROM settings WHERE key = ?1", [key])?;
        }
        tx.commit()?;
        Ok(deleted)
    }

    pub fn update_observation(
        &self,
        id: i64,
        revision: u32,
        title: &str,
        notes: &str,
        tags: Option<&[String]>,
        now: i64,
    ) -> rusqlite::Result<Updated> {
        let tags = tags.map(|t| serde_json::to_string(t).expect("tags serialize"));
        let changed = self.db.execute(
            "UPDATE observations SET title = ?3, notes = ?4, tags = COALESCE(?6, tags),
                revision = revision + 1, updated_at = ?5
             WHERE id = ?1 AND revision = ?2",
            params![id, revision, title, notes, now, tags],
        )?;
        Ok(match (changed, self.get_observation(id)?) {
            (1, Some(saved)) => Updated::Saved(saved),
            (_, Some(current)) => Updated::Conflict(current),
            (_, None) => Updated::Missing,
        })
    }

    /// Saves `kept_notes` on `id` (when `revision` is still current) and makes a new observation
    /// with `title`, `notes` and a copy of each capture and voice note of `id`, in one transaction.
    pub fn split_observation(
        &mut self,
        id: i64,
        revision: u32,
        kept_notes: &str,
        title: &str,
        notes: &str,
        now: i64,
    ) -> rusqlite::Result<Updated> {
        let tx = self.db.transaction()?;
        let changed = tx.execute(
            "UPDATE observations SET notes = ?3, revision = revision + 1, updated_at = ?4
             WHERE id = ?1 AND revision = ?2",
            params![id, revision, kept_notes, now],
        )?;
        if changed != 1 {
            drop(tx);
            return Ok(match self.get_observation(id)? {
                Some(current) => Updated::Conflict(current),
                None => Updated::Missing,
            });
        }
        tx.execute(
            "INSERT INTO observations (title, url, notes, tags, created_at, updated_at)
             SELECT ?2, url, ?3, tags, ?4, ?4 FROM observations WHERE id = ?1",
            params![id, title, notes, now],
        )?;
        let copy = tx.last_insert_rowid();
        copy_children(&tx, id, copy)?;
        tx.commit()?;
        Ok(Updated::Saved(
            self.get_observation(copy)?
                .expect("the row was just inserted"),
        ))
    }

    /// Replaces observation `id` (when `revision` is still current) with one new observation per
    /// plan, each with a copy of every capture and voice note and the plan's edits on its
    /// captures; then deletes `id`. One transaction: all of it happens, or none. Blobs stay.
    pub fn split_into_tasks(
        &mut self,
        id: i64,
        revision: u32,
        plans: &[TaskPlan],
        now: i64,
    ) -> rusqlite::Result<Result<Vec<Observation>, Updated>> {
        let tx = self.db.transaction()?;
        let current: Option<u32> = tx
            .query_row(
                "SELECT revision FROM observations WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        if current != Some(revision) {
            drop(tx);
            return Ok(Err(match self.get_observation(id)? {
                Some(found) => Updated::Conflict(found),
                None => Updated::Missing,
            }));
        }
        let ids = |tx: &rusqlite::Transaction, owner: i64| -> rusqlite::Result<Vec<i64>> {
            tx.prepare("SELECT id FROM captures WHERE observation_id = ?1 ORDER BY id")?
                .query_map([owner], |r| r.get(0))?
                .collect()
        };
        let originals = ids(&tx, id)?;
        let mut copies = Vec::new();
        for plan in plans {
            tx.execute(
                "INSERT INTO observations (title, url, notes, tags, created_at, updated_at)
                 SELECT ?2, url, ?3, ?4, ?5, ?5 FROM observations WHERE id = ?1",
                params![
                    id,
                    plan.title,
                    plan.notes,
                    serde_json::to_string(&plan.tags).expect("tags serialize"),
                    now
                ],
            )?;
            let copy = tx.last_insert_rowid();
            copy_children(&tx, id, copy)?;
            // Copies come in the originals' order: the nth copy is the nth original's.
            for (original, new) in originals.iter().zip(ids(&tx, copy)?) {
                if plan.leave.contains(original) {
                    tx.execute("DELETE FROM captures WHERE id = ?1", [new])?;
                } else if let Some((_, edits)) = plan.edits.iter().find(|(c, _)| c == original) {
                    tx.execute(
                        "UPDATE captures SET edits = ?2 WHERE id = ?1",
                        params![new, serde_json::to_string(edits).expect("edits serialize")],
                    )?;
                }
            }
            copies.push(copy);
        }
        tx.execute("DELETE FROM filings WHERE observation_id = ?1", [id])?;
        tx.execute("DELETE FROM observations WHERE id = ?1", [id])?;
        for key in [format!("issues.{id}"), format!("title.auto.{id}")] {
            tx.execute("DELETE FROM settings WHERE key = ?1", [key])?;
        }
        tx.commit()?;
        let mut out = Vec::new();
        for copy in copies {
            out.extend(self.get_observation(copy)?);
        }
        Ok(Ok(out))
    }

    /// Stores a review; `review.id` is replaced by the new row's ID.
    pub fn create_review(&mut self, mut review: Review) -> rusqlite::Result<Review> {
        let voice: Vec<crate::attachments::VoiceSource> = self
            .list_voice_notes(review.observation)?
            .into_iter()
            .map(Into::into)
            .collect();
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT INTO reviews (observation_id, body) VALUES (?1, '')",
            [review.observation],
        )?;
        review.id = tx.last_insert_rowid();
        let mut local = serde_json::to_value(&review).expect("reviews serialize");
        local["mp4Voice"] = serde_json::to_value(voice).expect("voice sources serialize");
        let body = local.to_string();
        tx.execute(
            "UPDATE reviews SET body = ?2 WHERE id = ?1",
            params![review.id, body],
        )?;
        tx.commit()?;
        Ok(review)
    }

    pub fn mp4_voice(
        &self,
        review: &Review,
        include: bool,
    ) -> rusqlite::Result<Vec<crate::attachments::VoiceSource>> {
        if !include {
            return Ok(Vec::new());
        }
        let sources: Option<String> = self.db.query_row(
            "SELECT json_extract(body, '$.mp4Voice') FROM reviews WHERE id = ?1",
            [review.id],
            |row| row.get(0),
        )?;
        if let Some(json) = sources {
            return serde_json::from_str(&json).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            });
        }
        // Older snapshots identify each reviewed transcript by its original clock and length.
        Ok(self
            .list_voice_notes(review.observation)?
            .into_iter()
            .filter(|note| {
                review
                    .voice
                    .iter()
                    .any(|v| v.started_at == note.started_at && v.duration_ms == note.duration_ms)
            })
            .map(Into::into)
            .collect())
    }

    pub fn get_review(&self, id: i64) -> rusqlite::Result<Option<Review>> {
        let mut statement = self.db.prepare("SELECT body FROM reviews WHERE id = ?1")?;
        let mut rows = statement.query_map([id], |row| row.get::<_, String>(0))?;
        Ok(match rows.next().transpose()? {
            Some(body) => unreadable("review", id, serde_json::from_str(&body)),
            None => None,
        })
    }

    pub fn list_reviews(&self) -> rusqlite::Result<Vec<ReviewSummary>> {
        self.reviews_page(None, None, u32::MAX)
    }

    /// Up to `limit` reviews older than `before`, of one observation or all, newest first. Only
    /// the page's own rows are read.
    pub fn reviews_page(
        &self,
        before: Option<i64>,
        observation: Option<i64>,
        limit: u32,
    ) -> rusqlite::Result<Vec<ReviewSummary>> {
        let mut statement = self.db.prepare(
            "SELECT body FROM reviews WHERE (?1 IS NULL OR id < ?1)
             AND (?2 IS NULL OR observation_id = ?2) ORDER BY id DESC LIMIT ?3",
        )?;
        let bodies = statement
            .query_map(params![before, observation, i64::from(limit)], |row| {
                row.get::<_, String>(0)
            })?;
        let mut reviews = Vec::new();
        let bodies: Vec<String> = bodies.collect::<rusqlite::Result<_>>()?;
        for body in bodies {
            if let Some(review) = unreadable::<Review>("review", 0, serde_json::from_str(&body)) {
                let receipt = self.filing(review.id)?.and_then(|a| a.receipt);
                reviews.push(ReviewSummary {
                    id: review.id,
                    observation: review.observation,
                    revision: review.revision,
                    created_at: review.created_at,
                    page_url: review.items.first().map(|i| i.page_url.clone()),
                    title: review.title,
                    captures: review.items.len() as u32,
                    vibeq_task_id: receipt.as_ref().map(|r| r.task_id.clone()),
                    vibeq_task_url: receipt.map(|r| r.task_url),
                });
            }
        }
        Ok(reviews)
    }

    pub fn save_client(&self, client: &ClientInfo, now: i64) -> rusqlite::Result<()> {
        let body = serde_json::to_string(client).expect("clients serialize");
        self.db.execute(
            "INSERT INTO clients (profile, body, last_seen) VALUES (?1, ?2, ?3)
             ON CONFLICT(profile) DO UPDATE SET body = excluded.body, last_seen = excluded.last_seen",
            params![client.profile, body, now],
        )?;
        Ok(())
    }

    pub fn list_clients(&self) -> rusqlite::Result<Vec<ClientSeen>> {
        let mut statement = self
            .db
            .prepare("SELECT body, last_seen FROM clients ORDER BY last_seen DESC")?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get(1)?)))?;
        let mut clients = Vec::new();
        for row in rows {
            let (body, last_seen) = row?;
            if let Some(client) = unreadable("browser", 0, serde_json::from_str(&body)) {
                clients.push(ClientSeen { client, last_seen });
            }
        }
        Ok(clients)
    }

    pub fn count(&self, table: &str) -> rusqlite::Result<u32> {
        // `table` is one of this file's own names, never input.
        self.db
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
    }

    pub fn setting(&self, key: &str) -> rusqlite::Result<Option<String>> {
        let mut statement = self
            .db
            .prepare("SELECT value FROM settings WHERE key = ?1")?;
        statement
            .query_map([key], |row| row.get(0))?
            .next()
            .transpose()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.db.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// The VibeQ task (id and URL) of this observation's newest confirmed filing, if any.
    pub fn filed_task(&self, observation: i64) -> rusqlite::Result<Option<(String, String)>> {
        self.db
            .query_row(
                "SELECT json_extract(body, '$.receipt.taskId'), json_extract(body, '$.receipt.taskUrl')
                 FROM filings
                 WHERE observation_id = ?1 AND json_extract(body, '$.receipt') IS NOT NULL
                 ORDER BY review_id DESC LIMIT 1",
                [observation],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map(|found| match found {
                Some((Some(id), Some(url))) => Some((id, url)),
                _ => None,
            })
    }

    pub fn filing(&self, review: i64) -> rusqlite::Result<Option<Attempt>> {
        let mut statement = self
            .db
            .prepare("SELECT body FROM filings WHERE review_id = ?1")?;
        let body: Option<String> = statement
            .query_map([review], |row| row.get(0))?
            .next()
            .transpose()?;
        Ok(body.and_then(|b| serde_json::from_str(&b).ok()))
    }

    pub fn save_filing(&self, attempt: &Attempt) -> rusqlite::Result<()> {
        let body = serde_json::to_string(attempt).expect("attempts serialize");
        self.db.execute(
            "INSERT INTO filings (review_id, observation_id, body) VALUES (?1, ?2, ?3)
             ON CONFLICT(review_id) DO UPDATE SET body = excluded.body",
            params![attempt.review, attempt.observation, body],
        )?;
        Ok(())
    }

    /// What this observation's filings, finished or not, decide for the next one.
    pub fn filed(&self, observation: i64) -> rusqlite::Result<Option<Filed>> {
        let mut statement = self.db.prepare(
            "SELECT f.body, json_extract(r.body, '$.revision'), f.review_id FROM filings f
             JOIN reviews r ON r.id = f.review_id
             WHERE f.observation_id = ?1 ORDER BY f.review_id",
        )?;
        let rows = statement.query_map([observation], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<u32>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        let mut found: Option<Filed> = None;
        for row in rows {
            let (body, reviewed, review) = row?;
            let Ok(attempt) = serde_json::from_str::<Attempt>(&body) else {
                continue;
            };
            let filed = found.get_or_insert_with(|| Filed {
                vibeq_revision: 0,
                reviewed_revision: 0,
                project_id: attempt.submission.project_id.clone(),
                review,
                endpoint: attempt.endpoint.clone(),
            });
            filed.review = filed.review.max(review);
            filed.vibeq_revision = filed.vibeq_revision.max(attempt.submission.revision);
            filed.reviewed_revision = filed.reviewed_revision.max(reviewed.unwrap_or(0));
        }
        Ok(found)
    }

    pub fn list_projects(&self) -> rusqlite::Result<Vec<Project>> {
        let mut statement = self
            .db
            .prepare("SELECT id, name, origins, enabled FROM projects ORDER BY name, id")?;
        statement
            .query_map([], |row| {
                let origins: String = row.get(2)?;
                Ok(Project {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    origins: serde_json::from_str(&origins).unwrap_or_default(),
                    enabled: row.get(3)?,
                })
            })?
            .collect()
    }

    /// Inserts when `id` is None. Returns None when the given `id` does not exist.
    pub fn save_project(
        &self,
        id: Option<i64>,
        name: &str,
        origins: &[String],
        enabled: bool,
    ) -> rusqlite::Result<Option<Project>> {
        let encoded = serde_json::to_string(origins).expect("strings serialize");
        let id = match id {
            None => {
                self.db.execute(
                    "INSERT INTO projects (name, origins, enabled) VALUES (?1, ?2, ?3)",
                    params![name, encoded, enabled],
                )?;
                self.db.last_insert_rowid()
            }
            Some(id) => {
                let changed = self.db.execute(
                    "UPDATE projects SET name = ?2, origins = ?3, enabled = ?4 WHERE id = ?1",
                    params![id, name, encoded, enabled],
                )?;
                if changed == 0 {
                    return Ok(None);
                }
                id
            }
        };
        Ok(Some(Project {
            id,
            name: name.into(),
            origins: origins.to_vec(),
            enabled,
        }))
    }

    pub fn delete_project(&self, id: i64) -> rusqlite::Result<bool> {
        Ok(self
            .db
            .execute("DELETE FROM projects WHERE id = ?1", [id])?
            > 0)
    }

    /// Adds the capture to `observation`, or to a new observation titled after the page.
    /// Returns None when `observation` does not exist.
    pub fn create_capture(
        &mut self,
        observation: Option<i64>,
        row: CaptureRow,
    ) -> rusqlite::Result<Option<Capture>> {
        let tx = self.db.transaction()?;
        let observation = match observation {
            Some(id) => {
                let exists = tx
                    .prepare("SELECT 1 FROM observations WHERE id = ?1")?
                    .exists([id])?;
                if !exists {
                    return Ok(None);
                }
                id
            }
            None => {
                let title = match row.page_title.trim() {
                    "" => row.page_url.as_str(),
                    title => title,
                };
                tx.execute(
                    "INSERT INTO observations (title, url, created_at) VALUES (?1, ?2, ?3)",
                    params![title, row.page_url, row.created_at],
                )?;
                tx.last_insert_rowid()
            }
        };
        tx.execute(
            "INSERT INTO captures (observation_id, created_at, page_url, page_title, mode,
                screenshot_sha256, screenshot_size, evidence_sha256, evidence_size, event_count, gap_count,
                recording_sha256, recording_size, kind, started_at, shots)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                observation,
                row.created_at,
                row.page_url,
                row.page_title,
                mode_name(row.mode),
                row.screenshot.sha256,
                row.screenshot.size as i64,
                row.evidence.sha256,
                row.evidence.size as i64,
                row.event_count,
                row.gap_count,
                row.recording.as_ref().map(|r| r.sha256.clone()),
                row.recording.as_ref().map(|r| r.size as i64),
                match row.kind {
                    CaptureKind::Moment => "moment",
                    CaptureKind::Session => "session",
                },
                row.started_at,
                serde_json::to_string(&row.shots).expect("shots serialize")
            ],
        )?;
        let id = tx.last_insert_rowid();
        tx.execute(
            "UPDATE observations SET updated_at = ?2 WHERE id = ?1",
            params![observation, row.created_at],
        )?;
        tx.commit()?;
        Ok(Some(Capture {
            id,
            observation,
            created_at: row.created_at,
            page_url: row.page_url,
            page_title: row.page_title,
            mode: row.mode,
            screenshot: row.screenshot,
            evidence: row.evidence,
            event_count: row.event_count,
            gap_count: row.gap_count,
            annotations: Vec::new(),
            recording: row.recording,
            kind: row.kind,
            started_at: row.started_at,
            edits: Edits::default(),
            shots: row.shots,
        }))
    }

    pub fn add_voice_note(
        &self,
        observation: i64,
        started_at: i64,
        duration_ms: i64,
        audio: &BlobRef,
    ) -> rusqlite::Result<VoiceNote> {
        self.db.execute(
            "INSERT INTO voice_notes (observation_id, started_at, duration_ms, audio_sha256, audio_size, state)
             VALUES (?1, ?2, ?3, ?4, ?5, 'waiting')",
            params![observation, started_at, duration_ms, audio.sha256, audio.size as i64],
        )?;
        let id = self.db.last_insert_rowid();
        Ok(self.get_voice_note(id)?.expect("just inserted"))
    }

    pub fn get_voice_note(&self, id: i64) -> rusqlite::Result<Option<VoiceNote>> {
        let mut statement = self.db.prepare(&format!(
            "SELECT {VOICE_COLUMNS} FROM voice_notes WHERE id = ?1"
        ))?;
        statement
            .query_map([id], voice_from_row)?
            .next()
            .transpose()
    }

    pub fn list_voice_notes(&self, observation: i64) -> rusqlite::Result<Vec<VoiceNote>> {
        let mut statement = self.db.prepare(&format!(
            "SELECT {VOICE_COLUMNS} FROM voice_notes WHERE observation_id = ?1 ORDER BY started_at, id"
        ))?;
        statement
            .query_map([observation], voice_from_row)?
            .collect()
    }

    /// Voice notes that still need a transcript, oldest first.
    pub fn untranscribed_voice_notes(&self) -> rusqlite::Result<Vec<i64>> {
        let mut statement = self.db.prepare(
            "SELECT id FROM voice_notes WHERE state IN ('waiting', 'transcribing') ORDER BY id",
        )?;
        statement.query_map([], |row| row.get(0))?.collect()
    }

    pub fn set_voice_state(
        &self,
        id: i64,
        state: VoiceState,
        language: Option<&str>,
        segments: &[VoiceSegment],
        detail: Option<&str>,
    ) -> rusqlite::Result<()> {
        let state = match state {
            VoiceState::Waiting => "waiting",
            VoiceState::Transcribing => "transcribing",
            VoiceState::Done => "done",
            VoiceState::Failed => "failed",
        };
        self.db.execute(
            "UPDATE voice_notes SET state = ?2, language = ?3, segments = ?4, detail = ?5 WHERE id = ?1",
            params![
                id,
                state,
                language,
                serde_json::to_string(segments).expect("segments serialize"),
                detail
            ],
        )?;
        Ok(())
    }

    pub fn delete_voice_note(&self, id: i64) -> rusqlite::Result<bool> {
        Ok(self
            .db
            .execute("DELETE FROM voice_notes WHERE id = ?1", [id])?
            > 0)
    }

    pub fn list_captures(&self, observation: i64) -> rusqlite::Result<Vec<Capture>> {
        let mut statement = self.db.prepare(&format!(
            "SELECT {CAPTURE_COLUMNS} FROM captures WHERE observation_id = ?1 ORDER BY created_at, id"
        ))?;
        statement
            .query_map([observation], capture_from_row)?
            .collect()
    }

    pub fn get_capture(&self, id: i64) -> rusqlite::Result<Option<Capture>> {
        let mut statement = self.db.prepare(&format!(
            "SELECT {CAPTURE_COLUMNS} FROM captures WHERE id = ?1"
        ))?;
        let mut rows = statement.query_map([id], capture_from_row)?;
        rows.next().transpose()
    }

    /// Returns false when the capture does not exist.
    pub fn save_edits(&self, capture: i64, edits: &Edits) -> rusqlite::Result<bool> {
        let encoded = serde_json::to_string(edits).expect("edits serialize");
        Ok(self.db.execute(
            "UPDATE captures SET edits = ?2 WHERE id = ?1",
            params![capture, encoded],
        )? > 0)
    }

    /// Returns false when the capture does not exist.
    pub fn save_annotations(&self, capture: i64, shapes: &[Shape]) -> rusqlite::Result<bool> {
        let encoded = serde_json::to_string(shapes).expect("shapes serialize");
        Ok(self.db.execute(
            "UPDATE captures SET annotations = ?2 WHERE id = ?1",
            params![capture, encoded],
        )? > 0)
    }
}

/// Each run of exactly 64 lowercase hex digits in `text`.
fn hex_runs(text: &[u8], found: &mut std::collections::HashSet<String>) {
    let hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    let mut start = None;
    for i in 0..=text.len() {
        match (start, text.get(i).copied().is_some_and(hex)) {
            (None, true) => start = Some(i),
            (Some(from), false) => {
                if i - from == 64 {
                    found.insert(String::from_utf8_lossy(&text[from..i]).into_owned());
                }
                start = None;
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn references_find_blobs_in_columns_and_json() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("lens.sqlite")).unwrap();
        let a = "a".repeat(64);
        let b = format!("{}b", "0".repeat(63));
        store
            .set_setting(
                "x",
                &format!(
                    r#"{{"sha256":"{a}","other":"{b}","long":"{}"}}"#,
                    "c".repeat(65)
                ),
            )
            .unwrap();
        let (found, _) = store.references().unwrap();
        assert!(found.contains(&a) && found.contains(&b));
        assert!(
            !found.iter().any(|s| s.starts_with('c')),
            "a 65-digit run names no blob"
        );
    }

    #[test]
    fn mp4_voice_is_local_and_frozen_independently_of_transcription() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("lens.sqlite")).unwrap();
        let obs = store.create_observation("A replay", None, 100).unwrap();
        let audio = BlobRef {
            sha256: "a".repeat(64),
            size: 32044,
            media_type: "audio/wav".into(),
        };
        let first = store.add_voice_note(obs.id, 100, 1000, &audio).unwrap();
        let review = store
            .create_review(Review {
                id: 0,
                observation: obs.id,
                revision: 1,
                created_at: 2000,
                title: obs.title,
                notes: String::new(),
                tags: vec![],
                items: vec![],
                voice: vec![],
            })
            .unwrap();
        store.add_voice_note(obs.id, 3000, 1000, &audio).unwrap();
        let public = serde_json::to_string(&store.get_review(review.id).unwrap().unwrap()).unwrap();
        assert!(!public.contains(&audio.sha256) && !public.contains("mp4Voice"));
        assert!(store.mp4_voice(&review, false).unwrap().is_empty());
        let frozen = store.mp4_voice(&review, true).unwrap();
        assert_eq!(frozen.len(), 1);
        assert_eq!(frozen[0].start, first.started_at);

        // A pre-audio review can recover its own transcribed source by its frozen timestamps.
        let mut old = review.clone();
        old.voice.push(crate::protocol::ReviewVoice {
            started_at: 100,
            duration_ms: 1000,
            language: None,
            segments: vec![],
        });
        store
            .db
            .execute(
                "UPDATE reviews SET body=?1 WHERE id=?2",
                params![serde_json::to_string(&old).unwrap(), old.id],
            )
            .unwrap();
        assert_eq!(store.mp4_voice(&old, true).unwrap().len(), 1);
        store.delete_voice_note(first.id).unwrap();
        assert!(store.mp4_voice(&old, true).unwrap().is_empty());
    }

    #[test]
    fn filed_names_the_first_project_and_the_highest_revisions() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("lens.sqlite")).unwrap();
        let observation = store.create_observation("a", None, 1).unwrap().id;
        assert_eq!(store.filed(observation).unwrap(), None);
        for (review, revision, vibeq, project) in [(10, 2, 3, "first"), (11, 2, 4, "moved")] {
            store
                .db
                .execute(
                    "INSERT INTO reviews (id, observation_id, body) VALUES (?1, ?2, ?3)",
                    params![review, observation, format!(r#"{{"revision":{revision}}}"#)],
                )
                .unwrap();
            let attempt: Attempt = serde_json::from_value(serde_json::json!({
                "review": review, "observation": observation, "endpoint": "https://v.test",
                "folder": "/f", "memberId": null, "receipt": null,
                "submission": {
                    "submissionId": "s", "observationId": "o", "revision": vibeq,
                    "projectId": project, "title": "t", "markdown": "m", "reviewed": true,
                    "evidenceManifest": []
                }
            }))
            .unwrap();
            store.save_filing(&attempt).unwrap();
        }
        assert_eq!(
            store.filed(observation).unwrap(),
            Some(Filed {
                vibeq_revision: 4,
                reviewed_revision: 2,
                project_id: "first".into(),
                review: 11,
                endpoint: "https://v.test".into(),
            })
        );
    }

    #[test]
    fn ids_are_never_given_again_and_old_rows_survive_the_rebuild() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lens.sqlite");
        // A notebook from before AUTOINCREMENT, with a review, a filing and a voice note.
        {
            let db = Connection::open(&path).unwrap();
            for sql in &MIGRATIONS[..MIGRATIONS.len() - 1] {
                db.execute_batch(sql).unwrap();
            }
            db.pragma_update(None, "user_version", (MIGRATIONS.len() - 1) as i64)
                .unwrap();
            db.execute_batch(
                "INSERT INTO observations (id, title, created_at, notes) VALUES (1, 'a', 1, 'n'), (2, 'b', 2, '');
                 INSERT INTO captures (id, observation_id, created_at, page_url, page_title, mode,
                     screenshot_sha256, screenshot_size, evidence_sha256, evidence_size, event_count, gap_count)
                     VALUES (5, 2, 3, 'https://a.test/', 'A', 'deep', 's', 1, 'e', 1, 0, 0);
                 INSERT INTO reviews (id, observation_id, body) VALUES (4, 2, '{}');
                 INSERT INTO filings (review_id, observation_id, body) VALUES (4, 2, '{}');
                 INSERT INTO voice_notes (id, observation_id, started_at, duration_ms, audio_sha256, audio_size, state)
                     VALUES (6, 2, 0, 1, 'w', 1, 'done');",
            )
            .unwrap();
        }
        let store = Store::open(&path).unwrap();
        let count = |table: &str| store.count(table).unwrap();
        assert_eq!(
            [
                count("observations"),
                count("captures"),
                count("reviews"),
                count("filings"),
                count("voice_notes")
            ],
            [2, 1, 1, 1, 1],
            "every row stays"
        );
        assert!(store.get_observation(1).unwrap().unwrap().notes == "n");
        // Foreign keys hold again: deleting an observation takes its children.
        assert!(store.delete_observation(2).unwrap());
        assert_eq!(
            [
                count("captures"),
                count("reviews"),
                count("filings"),
                count("voice_notes")
            ],
            [0, 0, 0, 0]
        );
        // The highest ID was 2 and is gone: the next observation gets one no earlier Lens gave,
        // even one deleted before the update (3, say).
        assert_eq!(store.create_observation("c", None, 3).unwrap().id, 1003);
    }

    #[test]
    fn review_pages_filter_in_the_query() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("lens.sqlite")).unwrap();
        let (a, b) = (
            store.create_observation("a", None, 1).unwrap().id,
            store.create_observation("b", None, 1).unwrap().id,
        );
        for (id, observation) in [(1, a), (2, b), (3, a), (4, a)] {
            store
                .db
                .execute(
                    "INSERT INTO reviews (id, observation_id, body) VALUES (?1, ?2, ?3)",
                    params![
                        id,
                        observation,
                        serde_json::json!({"id": id, "observation": observation, "revision": 1,
                            "createdAt": 0, "title": "t", "tags": [], "notes": "", "items": [],
                            "voice": []})
                        .to_string()
                    ],
                )
                .unwrap();
        }
        let ids = |page: Vec<ReviewSummary>| page.into_iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(ids(store.reviews_page(None, None, 2).unwrap()), [4, 3]);
        assert_eq!(ids(store.reviews_page(Some(3), None, 10).unwrap()), [2, 1]);
        assert_eq!(
            ids(store.reviews_page(None, Some(a), 10).unwrap()),
            [4, 3, 1]
        );
    }

    #[test]
    fn a_new_notebook_starts_at_one() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("lens.sqlite")).unwrap();
        assert_eq!(store.create_observation("a", None, 1).unwrap().id, 1);
    }

    #[test]
    fn migrates_once_and_keeps_observations() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lens.sqlite");
        let first = Store::open(&path)
            .unwrap()
            .create_observation("Price shows NaN", Some("https://a.test/"), 5)
            .unwrap();
        let reopened = Store::open(&path).unwrap();
        let listed = reopened.list_observations().unwrap();
        assert_eq!(
            (listed.len(), listed[0].id, listed[0].capture_count),
            (1, first.id, 0)
        );
    }

    #[test]
    fn a_split_into_tasks_replaces_the_observation_in_one_go() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("lens.sqlite")).unwrap();
        let blob = |sha: char| BlobRef {
            sha256: sha.to_string().repeat(64),
            size: 3,
            media_type: String::new(),
        };
        let capture = store
            .create_capture(
                None,
                CaptureRow {
                    created_at: 9000,
                    page_url: "https://shop.test/".into(),
                    page_title: "Shop".into(),
                    mode: CaptureMode::Deep,
                    screenshot: blob('a'),
                    evidence: blob('b'),
                    event_count: 1,
                    gap_count: 0,
                    kind: CaptureKind::Session,
                    started_at: 1000,
                    shots: vec![],
                    recording: Some(blob('r')),
                },
            )
            .unwrap()
            .unwrap();
        let id = capture.observation;
        store.add_voice_note(id, 1000, 8000, &blob('v')).unwrap();
        let trim = |from, to| Edits {
            trim_start: Some(from),
            trim_end: Some(to),
            ..Edits::default()
        };
        let plan = |title: &str, edits| TaskPlan {
            title: title.into(),
            notes: format!("{title} notes"),
            tags: vec!["bug".into()],
            edits: vec![(capture.id, edits)],
            leave: Vec::new(),
        };
        let plans = [
            plan("Comments", trim(1000, 4000)),
            plan("Hotspots", trim(4000, 9000)),
        ];
        assert!(matches!(
            store.split_into_tasks(id, 99, &plans, 10).unwrap(),
            Err(Updated::Conflict(_))
        ));
        let created = store.split_into_tasks(id, 0, &plans, 10).unwrap().unwrap();
        assert_eq!(
            created.iter().map(|o| o.title.as_str()).collect::<Vec<_>>(),
            ["Comments", "Hotspots"]
        );
        assert_eq!(created[1].tags, ["bug"]);
        let copy = &store.list_captures(created[1].id).unwrap()[0];
        assert_eq!(copy.edits, trim(4000, 9000));
        assert_eq!(
            copy.recording.as_ref().map(|r| &r.sha256),
            capture.recording.as_ref().map(|r| &r.sha256)
        );
        assert_eq!(store.list_voice_notes(created[0].id).unwrap().len(), 1);
        assert!(
            store.get_observation(id).unwrap().is_none(),
            "the original is gone"
        );
    }

    #[test]
    fn captures_start_or_join_observations() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("lens.sqlite")).unwrap();
        let blob = |sha: char| BlobRef {
            sha256: sha.to_string().repeat(64),
            size: 3,
            media_type: String::new(),
        };
        let row = |title: &str| CaptureRow {
            created_at: 10,
            page_url: "https://shop.test/cart".into(),
            page_title: title.into(),
            mode: CaptureMode::Deep,
            screenshot: blob('a'),
            evidence: blob('b'),
            event_count: 4,
            gap_count: 1,
            kind: CaptureKind::Moment,
            started_at: 5,
            shots: vec![],
            recording: None,
        };

        let first = store.create_capture(None, row("Cart")).unwrap().unwrap();
        let observations = store.list_observations().unwrap();
        assert_eq!(
            (observations.len(), observations[0].title.as_str()),
            (1, "Cart")
        );

        let second = store
            .create_capture(Some(first.observation), row(""))
            .unwrap()
            .unwrap();
        assert_eq!(store.list_observations().unwrap().len(), 1);
        let captures = store.list_captures(first.observation).unwrap();
        assert_eq!(
            captures.iter().map(|c| c.id).collect::<Vec<_>>(),
            [first.id, second.id]
        );
        assert_eq!(captures[1].mode, CaptureMode::Deep);

        assert!(store.create_capture(Some(999), row("x")).unwrap().is_none());

        // A split copies the captures (with their edits) and voice notes to a new observation.
        let edits = Edits {
            hidden_shots: vec![7],
            ..Edits::default()
        };
        assert!(store.save_edits(second.id, &edits).unwrap());
        store
            .add_voice_note(first.observation, 6, 900, &blob('v'))
            .unwrap();
        let revision = store
            .get_observation(first.observation)
            .unwrap()
            .unwrap()
            .revision;
        let Updated::Saved(copy) = store
            .split_observation(first.observation, revision, "kept", "Comments", "moved", 20)
            .unwrap()
        else {
            panic!("the split did not save");
        };
        assert_eq!(
            (copy.title.as_str(), copy.notes.as_str()),
            ("Comments", "moved")
        );
        let copied = store.list_captures(copy.id).unwrap();
        assert_eq!(copied.len(), 2);
        assert_eq!(copied[1].edits, edits);
        assert!(
            copied
                .iter()
                .all(|c| ![first.id, second.id].contains(&c.id))
        );
        assert_eq!(store.list_voice_notes(copy.id).unwrap().len(), 1);
        assert_eq!(
            store
                .get_observation(first.observation)
                .unwrap()
                .unwrap()
                .notes,
            "kept"
        );
        assert!(matches!(
            store
                .split_observation(first.observation, revision, "x", "y", "z", 30)
                .unwrap(),
            Updated::Conflict(_)
        ));

        let mask = Shape::Mask {
            x: 1.0,
            y: 2.0,
            width: 3.0,
            height: 4.0,
        };
        assert!(
            store
                .save_annotations(first.id, std::slice::from_ref(&mask))
                .unwrap()
        );
        assert_eq!(
            store.get_capture(first.id).unwrap().unwrap().annotations,
            vec![mask]
        );
        assert!(!store.save_annotations(999, &[]).unwrap());
        assert!(store.get_capture(999).unwrap().is_none());
        let untitled = store.create_capture(None, row("  ")).unwrap().unwrap();
        let titles: Vec<_> = store
            .list_observations()
            .unwrap()
            .into_iter()
            .map(|o| (o.id, o.title))
            .collect();
        assert!(titles.contains(&(untitled.observation, "https://shop.test/cart".into())));
    }

    #[test]
    fn updates_need_the_current_revision() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("lens.sqlite")).unwrap();
        let created = store.create_observation("Cart", None, 1).unwrap();
        assert_eq!(created.revision, 0);

        let Updated::Saved(saved) = store
            .update_observation(created.id, 0, "Cart", "NaN after coupon", None, 2)
            .unwrap()
        else {
            panic!("the first update must save");
        };
        assert_eq!(
            (saved.revision, saved.notes.as_str(), saved.updated_at),
            (1, "NaN after coupon", 2)
        );

        // A second window still holds revision 0: it must not overwrite the first.
        let Updated::Conflict(current) = store
            .update_observation(created.id, 0, "Cart", "stale", None, 3)
            .unwrap()
        else {
            panic!("a stale revision must conflict");
        };
        assert_eq!(current.notes, "NaN after coupon");
        assert!(matches!(
            store.update_observation(999, 0, "x", "", None, 4).unwrap(),
            Updated::Missing
        ));
    }

    #[test]
    fn projects_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("lens.sqlite")).unwrap();
        let origins = vec!["https://shop.test".to_string()];
        let created = store
            .save_project(None, "Shop", &origins, true)
            .unwrap()
            .unwrap();
        let renamed = store
            .save_project(Some(created.id), "Shop 2", &origins, false)
            .unwrap()
            .unwrap();
        assert_eq!(store.list_projects().unwrap(), vec![renamed]);
        assert!(
            store
                .save_project(Some(999), "x", &origins, true)
                .unwrap()
                .is_none()
        );
        assert!(store.delete_project(created.id).unwrap());
        assert!(store.list_projects().unwrap().is_empty());
    }

    #[test]
    fn refuses_a_newer_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lens.sqlite");
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", 99)
            .unwrap();
        assert!(Store::open(&path).is_err());
    }
}
