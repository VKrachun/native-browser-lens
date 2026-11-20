//! `lensd`: the one process per user that owns the notebook. Every client talks to it; nothing else
//! opens the database.
use crate::blobs::Blobs;
use crate::framing::{read_frame, write_frame};
use crate::paths::Paths;
use crate::protocol::*;
use crate::store::{CaptureRow, Store, Updated};
use crate::vibeq::{self, Client};
use crate::{export, filing, handoff, investigate, ipc, render, repro, secrets, speech};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use interprocess::local_socket::{Stream, prelude::*};
use std::fs::{File, TryLockError};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Daemon {
    store: Mutex<Store>,
    /// What a speech model install in progress reports; None when none runs.
    speech_download: Mutex<Option<ModelState>>,
    /// Voice note IDs for the transcription worker.
    speech_queue: std::sync::OnceLock<std::sync::mpsc::Sender<i64>>,
    /// Observations being titled in the background.
    titling: Mutex<std::collections::HashSet<i64>>,
    /// The daemon itself, for work that outlives a request.
    me: std::sync::OnceLock<std::sync::Weak<Daemon>>,
    blobs: Blobs,
    data_dir: String,
    downloads: std::path::PathBuf,
    filings: std::path::PathBuf,
    notebook: std::path::PathBuf,
    paths: Paths,
    /// Agents' questions for live evidence, and the browsers' answers.
    live: crate::live::Asks,
    /// The setup wizard, once its server runs.
    setup_page: std::sync::OnceLock<Arc<crate::wizard::Wizard>>,
}

const TOKEN_ACCOUNT: &str = "vibeq-token";
/// A token from the environment wins over the secret store: for CI and automation, where no
/// keyring runs. People use Settings.
const TOKEN_ENV: &str = "LENS_VIBEQ_TOKEN";

/// Whether a VibeQ token is saved. The keychain is read once and then after each change: the
/// settings pages poll every few seconds while the store lock is held, and a keychain prompt
/// would otherwise stall every browser.
static HAS_TOKEN: Mutex<Option<bool>> = Mutex::new(None);

/// The observations being filed now. A second filing of one (a double click, the page and an
/// agent) is refused: both would freeze their own submission and VibeQ would get two tasks.
static FILING: Mutex<std::collections::BTreeSet<i64>> =
    Mutex::new(std::collections::BTreeSet::new());

struct FilingNow(i64);

impl Drop for FilingNow {
    fn drop(&mut self) {
        FILING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

fn has_token() -> bool {
    let mut known = HAS_TOKEN.lock().unwrap_or_else(|e| e.into_inner());
    *known.get_or_insert_with(|| saved_token().ok().flatten().is_some())
}

fn token_changed() {
    *HAS_TOKEN.lock().unwrap_or_else(|e| e.into_inner()) = None;
    // Read it again now, off the store lock that the settings pages hold.
    std::thread::spawn(has_token);
}

fn vibeq_connected(store: &Store) -> Result<bool, ProtocolError> {
    Ok(store.setting("vibeq.endpoint").map_err(storage)?.is_some() && has_token())
}

fn destination_settings(store: &Store) -> Result<DestinationSettings, ProtocolError> {
    let vibeq_connected = vibeq_connected(store)?;
    let saved = store.setting("task.destination").map_err(storage)?;
    let choice: Option<TaskDestination> = match saved {
        Some(json) => serde_json::from_str(&json).map_err(storage)?,
        None => vibeq_connected.then(|| TaskDestination {
            tracker: Tracker::Vibeq,
            address: String::new(),
        }),
    };
    Ok(DestinationSettings {
        choice: choice.filter(|c| c.tracker != Tracker::Vibeq || vibeq_connected),
        vibeq_connected,
    })
}

fn vibeq_settings(store: &Store) -> Result<VibeQSettings, ProtocolError> {
    let has_token = has_token();
    Ok(VibeQSettings {
        endpoint: store.setting("vibeq.endpoint").map_err(storage)?,
        has_token,
        account: store
            .setting("vibeq.account")
            .map_err(storage)?
            .filter(|name| has_token && !name.is_empty()),
        token_from_environment: std::env::var(TOKEN_ENV).is_ok_and(|t| !t.trim().is_empty()),
        secret_store: secrets::status(),
    })
}

fn saved_token() -> Result<Option<String>, ProtocolError> {
    match std::env::var(TOKEN_ENV) {
        Ok(token) if !token.trim().is_empty() => Ok(Some(token.trim().into())),
        _ => secrets::get(TOKEN_ACCOUNT).map_err(storage),
    }
}

/// A screenshot of a 4K display at 2x is about 10 MiB of PNG; the request limit leaves room for base64.
const MAX_SCREENSHOT_BYTES: usize = 12 * 1024 * 1024;

/// Returns `Ok(())` at once when another daemon already holds the lock: the caller then connects to it.
/// Appends one line to `lensd.log`; the daemon has no terminal once a service or browser starts it.
pub fn log(paths: &Paths, line: &str) {
    use std::io::Write;
    if let Ok(mut file) = paths.log("lensd.log") {
        let _ = writeln!(
            file,
            "{} pid {}: {line}",
            now_ms() / 1000,
            std::process::id()
        );
    }
}

/// `service`: started by the login service, so refresh the browser registrations first. A browser
/// installed after Lens, or a binary that moved, is then fixed at the next login.
pub fn run(paths: &Paths, service: bool) -> std::io::Result<()> {
    paths.ensure()?;
    let lock = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.lock())?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return Ok(()),
        Err(TryLockError::Error(e)) => return Err(e),
    }
    if service {
        match crate::paths::executable().and_then(|exe| crate::register::register(paths, &exe)) {
            Ok(_) => {}
            Err(e) => log(paths, &format!("registration refresh failed: {e}")),
        }
    }
    log(
        paths,
        &format!("started, version {}", env!("CARGO_PKG_VERSION")),
    );
    // An installer may have brought new extension builds: unpack them where browsers load them.
    match crate::bundle::sync_extensions(paths) {
        Ok(true) => log(
            paths,
            "unpacked the bundled extensions; reload them in the browser",
        ),
        Ok(false) => {}
        Err(e) => log(
            paths,
            &format!("the bundled extensions did not unpack: {e}"),
        ),
    }
    let store = Store::open(&paths.database()).map_err(std::io::Error::other)?;
    let daemon = Arc::new(Daemon::new(store, paths));
    crate::update::clean_up();
    // Unfinished uploads cannot resume after a restart: the client starts them again.
    let _ = std::fs::remove_dir_all(paths.data.join("uploads"));
    // Renders an earlier daemon did not finish (see attachments::save).
    let _ = std::fs::remove_dir_all(paths.data.join("attachments"));
    start_transcription(daemon.clone());
    std::thread::spawn(has_token);
    // What deleted records left behind: now, then every hour.
    let sweeper = Arc::downgrade(&daemon);
    std::thread::spawn(move || {
        while let Some(daemon) = sweeper.upgrade() {
            daemon.sweep_soon();
            drop(daemon);
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    });
    match crate::wizard::serve(daemon.clone(), paths) {
        Ok(wizard) => {
            let _ = daemon.setup_page.set(wizard);
        }
        Err(e) => log(paths, &format!("the setup page did not start: {e}")),
    }
    if service {
        SERVICE.store(true, std::sync::atomic::Ordering::SeqCst);
        schedule_updates(daemon.clone());
        crate::tray::spawn(paths);
        watch_tray(paths);
        watch_program(paths);
        watch_registration(paths);
    }
    let listener = ipc::listen(paths).map_err(|e| {
        std::io::Error::new(
            e.kind(),
            format!(
                "cannot open the Lens endpoint in {}: {e}",
                paths.runtime.display()
            ),
        )
    })?;
    for connection in listener.incoming() {
        match connection {
            Ok(stream) => {
                let daemon = daemon.clone();
                let paths = paths.clone();
                std::thread::spawn(move || {
                    if let Err(e) = serve(&daemon, stream) {
                        log(&paths, &format!("connection ended: {e}"));
                    }
                });
            }
            Err(e) => log(paths, &format!("accept failed: {e}")),
        }
    }
    drop(lock);
    Ok(())
}

fn serve(daemon: &Daemon, stream: Stream) -> std::io::Result<()> {
    let mut stream = &stream;
    let mut transfer = None;
    while let Some(frame) = read_frame(&mut stream, MAX_REQUEST_BYTES)? {
        let (reply, stop) = daemon.answer(&frame, &mut transfer);
        write_frame(&mut stream, &reply)?;
        if stop {
            std::process::exit(0);
        }
    }
    Ok(())
}

impl Daemon {
    /// One request frame in, one reply frame out, and whether the daemon stops after sending it.
    /// Never fails: a broken request gets an error reply.
    fn answer(
        &self,
        frame: &[u8],
        transfer: &mut Option<crate::attachments::Transfer>,
    ) -> (Vec<u8>, bool) {
        let mut stop = false;
        let reply = match serde_json::from_slice::<RequestFrame>(frame) {
            Ok(request) => {
                stop = matches!(request.request, Request::Shutdown);
                ReplyFrame {
                    id: request.id,
                    outcome: self.handle_with_transfer(request.request, transfer),
                }
            }
            Err(e) => ReplyFrame {
                id: serde_json::from_slice::<serde_json::Value>(frame)
                    .ok()
                    .and_then(|v| v.get("id")?.as_u64())
                    .and_then(|id| u32::try_from(id).ok())
                    .unwrap_or(0),
                outcome: Outcome::Error {
                    error: ProtocolError::new(ErrorCode::BadRequest, e.to_string()),
                },
            },
        };
        let bytes = serde_json::to_vec(&reply).expect("protocol types serialize");
        if bytes.len() <= MAX_REPLY_BYTES {
            return (bytes, stop);
        }
        let too_large = ReplyFrame {
            id: reply.id,
            outcome: Outcome::Error {
                error: ProtocolError::new(
                    ErrorCode::TooLarge,
                    format!("reply of {} bytes exceeds 1 MiB", bytes.len()),
                ),
            },
        };
        (
            serde_json::to_vec(&too_large).expect("protocol types serialize"),
            stop,
        )
    }

    pub fn new(store: Store, paths: &Paths) -> Self {
        Self {
            store: Mutex::new(store),
            speech_download: Mutex::new(None),
            speech_queue: std::sync::OnceLock::new(),
            me: std::sync::OnceLock::new(),
            titling: Mutex::new(std::collections::HashSet::new()),
            blobs: Blobs::new(paths.blobs()),
            data_dir: paths.data.display().to_string(),
            downloads: paths.downloads(),
            filings: paths.filings(),
            notebook: paths.data.clone(),
            paths: paths.clone(),
            live: crate::live::Asks::default(),
            setup_page: std::sync::OnceLock::new(),
        }
    }

    pub(crate) fn handle(&self, request: Request) -> Outcome {
        self.handle_with_transfer(request, &mut None)
    }

    fn handle_with_transfer(
        &self,
        request: Request,
        transfer: &mut Option<crate::attachments::Transfer>,
    ) -> Outcome {
        match self.reply(request, transfer) {
            Ok(result) => Outcome::Ok {
                result: Box::new(result),
            },
            Err(error) => Outcome::Error { error },
        }
    }

    fn reply(
        &self,
        request: Request,
        transfer: &mut Option<crate::attachments::Transfer>,
    ) -> Result<Reply, ProtocolError> {
        let mut store = self
            .store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(match request {
            Request::Hello => Reply::Hello(Hello {
                version: env!("CARGO_PKG_VERSION").into(),
                protocol: PROTOCOL_VERSION,
                data_dir: self.data_dir.clone(),
                secret_store: secrets::status(),
                paused: store
                    .setting("collection.paused")
                    .map_err(storage)?
                    .as_deref()
                    == Some("true"),
            }),
            Request::CreateObservation { title, url } => {
                let title = title.trim();
                if title.is_empty() {
                    return Err(bad("the title is empty"));
                }
                Reply::Observation(
                    store
                        .create_observation(title, url.as_deref(), now_ms())
                        .map_err(storage)?,
                )
            }
            Request::ListObservations => {
                Reply::Observations(store.list_observations().map_err(storage)?)
            }
            Request::GetObservation { id } => Reply::Observation(
                store
                    .get_observation(id)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such observation"))?,
            ),
            Request::UpdateObservation(update) => {
                let title = update.title.trim();
                if title.is_empty() {
                    return Err(bad("the title is empty"));
                }
                if update.notes.len() > MAX_NOTES_BYTES {
                    return Err(ProtocolError::new(
                        ErrorCode::TooLarge,
                        "the notes exceed 256 KiB",
                    ));
                }
                let outcome = store
                    .update_observation(
                        update.id,
                        update.revision,
                        title,
                        &update.notes,
                        update.tags.as_deref().map(clean_tags).as_deref(),
                        now_ms(),
                    )
                    .map_err(storage)?;
                match outcome {
                    Updated::Saved(saved) => Reply::Observation(saved),
                    Updated::Conflict(current) => {
                        return Err(ProtocolError::new(
                            ErrorCode::Conflict,
                            format!(
                                "the observation changed elsewhere (revision {} is current)",
                                current.revision
                            ),
                        ));
                    }
                    Updated::Missing => return Err(not_found("no such observation")),
                }
            }
            Request::SplitObservation {
                observation,
                revision,
                findings,
                title,
            } => {
                let title = plain(&title);
                if title.is_empty() || title.len() > 200 {
                    return Err(bad(
                        "the new observation needs a title of at most 200 characters",
                    ));
                }
                let found = store
                    .get_observation(observation)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such observation"))?;
                let (all, own) = split_findings(&found.notes);
                let chosen: std::collections::BTreeSet<usize> =
                    findings.iter().map(|i| *i as usize).collect();
                if chosen.is_empty() || chosen.iter().any(|i| *i >= all.len()) {
                    return Err(bad("choose findings from the notes to move"));
                }
                let block = |pick: &dyn Fn(usize) -> bool| {
                    let lines: Vec<&str> = all
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| pick(*i))
                        .map(|(_, l)| l.as_str())
                        .collect();
                    let head = if lines.is_empty() {
                        String::new()
                    } else {
                        format!("{FINDINGS_HEADER}\n{}", lines.join("\n"))
                    };
                    [head, own.clone()]
                        .into_iter()
                        .filter(|p| !p.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n\n")
                };
                let kept = block(&|i| !chosen.contains(&i));
                let moved = block(&|i| chosen.contains(&i));
                let outcome = store
                    .split_observation(observation, revision, &kept, &title, &moved, now_ms())
                    .map_err(storage)?;
                match outcome {
                    Updated::Saved(copy) => {
                        // Both are the person's now: a later summary must not put every finding back.
                        // The split is done: a failure here must not report it as failed.
                        for id in [observation, copy.id] {
                            if let Err(e) = store.set_setting(&format!("title.auto.{id}"), "") {
                                log(&self.paths, &format!("split {observation}: {e}"));
                            }
                        }
                        self.requeue_voice(&store);
                        Reply::Observation(copy)
                    }
                    Updated::Conflict(_) => {
                        return Err(ProtocolError::new(
                            ErrorCode::Conflict,
                            "the notes changed after you chose; choose again",
                        ));
                    }
                    Updated::Missing => return Err(not_found("no such observation")),
                }
            }
            Request::DeleteObservation { id } => {
                if !store.delete_observation(id).map_err(storage)? {
                    return Err(not_found("no such observation"));
                }
                drop(store);
                // Its recordings, screenshots and frozen folders go too, unless another record
                // shares them.
                self.sweep_soon();
                Reply::Deleted
            }
            Request::ListProjects => Reply::Projects(store.list_projects().map_err(storage)?),
            Request::SaveProject(input) => {
                let name = input.name.trim();
                if name.is_empty() {
                    return Err(bad("the project name is empty"));
                }
                let mut origins = Vec::new();
                for origin in &input.origins {
                    let origin = normalize_origin(origin)?;
                    if !origins.contains(&origin) {
                        origins.push(origin);
                    }
                }
                if origins.is_empty() {
                    return Err(bad("a project needs at least one origin"));
                }
                let saved = store
                    .save_project(input.id, name, &origins, input.enabled)
                    .map_err(storage)?;
                Reply::Project(saved.ok_or_else(|| not_found("no such project"))?)
            }
            Request::DeleteProject { id } => match store.delete_project(id).map_err(storage)? {
                true => Reply::Deleted,
                false => return Err(not_found("no such project")),
            },
            Request::CreateCapture(capture) => {
                let screenshot = match &capture.screenshot_blob {
                    // One byte past the limit is enough to refuse it below.
                    Some(blob) => {
                        self.blobs
                            .read(&blob.sha256, 0, MAX_SCREENSHOT_BYTES as u32 + 1)
                            .map_err(|_| not_found("upload the screenshot first"))?
                            .0
                    }
                    None => BASE64
                        .decode(capture.screenshot.as_bytes())
                        .map_err(|e| bad(format!("the screenshot is not base64: {e}")))?,
                };
                if !screenshot.starts_with(b"\x89PNG\r\n\x1a\n") {
                    return Err(bad("the screenshot is not a PNG"));
                }
                if screenshot.len() > MAX_SCREENSHOT_BYTES {
                    return Err(ProtocolError::new(
                        ErrorCode::TooLarge,
                        "the screenshot exceeds 12 MiB",
                    ));
                }
                let page_url = url::Url::parse(&capture.page_url)
                    .map_err(|e| bad(format!("the page URL is not valid: {e}")))?;
                let mut capture = capture;
                capture.evidence.actions.truncate(repro::MAX_ACTIONS);
                capture.evidence.elements.truncate(repro::MAX_ELEMENTS);
                let evidence = serde_json::to_vec(&capture.evidence).expect("evidence serializes");
                // The recording came through UploadChunk; it must be stored and be JSON.
                let recording = match capture.recording.clone() {
                    Some(blob) => {
                        let (head, size) = self
                            .blobs
                            .read(&blob.sha256, 0, 1)
                            .map_err(|_| not_found("upload the recording first"))?;
                        if head != b"[" {
                            return Err(bad("the recording must be a JSON array of rrweb events"));
                        }
                        Some(BlobRef {
                            size,
                            media_type: "application/json".into(),
                            ..blob
                        })
                    }
                    None => None,
                };
                let row = CaptureRow {
                    created_at: now_ms(),
                    page_url: page_url.into(),
                    page_title: capture.page_title,
                    mode: capture.evidence.mode,
                    screenshot: self.blobs.put(&screenshot, "image/png").map_err(storage)?,
                    evidence: self
                        .blobs
                        .put(&evidence, "application/json")
                        .map_err(storage)?,
                    event_count: capture.evidence.events.len() as u32,
                    gap_count: capture.evidence.gaps.len() as u32,
                    recording,
                    kind: capture.kind,
                    started_at: capture.started_at,
                    shots: self.checked_shots(&capture.shots)?,
                };
                let saved = store
                    .create_capture(capture.observation, row)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such observation"))?;
                self.auto_title(saved.observation);
                Reply::Capture(saved)
            }
            Request::ListCaptures { observation } => {
                Reply::Captures(store.list_captures(observation).map_err(storage)?)
            }
            Request::GetCapture { id } => Reply::Capture(
                store
                    .get_capture(id)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such capture"))?,
            ),
            Request::SaveAnnotations { capture, shapes } => {
                if shapes.len() > MAX_SHAPES {
                    return Err(bad(format!("more than {MAX_SHAPES} shapes")));
                }
                for shape in &shapes {
                    shape.validate().map_err(bad)?;
                }
                if !store.save_annotations(capture, &shapes).map_err(storage)? {
                    return Err(not_found("no such capture"));
                }
                Reply::Capture(
                    store
                        .get_capture(capture)
                        .map_err(storage)?
                        .ok_or_else(|| not_found("no such capture"))?,
                )
            }
            Request::SaveEdits { capture, edits } => {
                edits.validate().map_err(bad)?;
                let found = store
                    .get_capture(capture)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such capture"))?;
                // An empty kept list means "unedited, keep all" downstream: edits that keep
                // nothing must never reach it.
                if edits != Edits::default()
                    && edits.kept(found.started_at, found.created_at).is_empty()
                {
                    return Err(bad("these trims and cuts leave nothing of the recording"));
                }
                if edits
                    .shot_masks
                    .iter()
                    .any(|m| !found.shots.iter().any(|s| s.at == m.at))
                {
                    return Err(bad("a mask names a shot this capture does not have"));
                }
                if !store.save_edits(capture, &edits).map_err(storage)? {
                    return Err(not_found("no such capture"));
                }
                Reply::Capture(
                    store
                        .get_capture(capture)
                        .map_err(storage)?
                        .ok_or_else(|| not_found("no such capture"))?,
                )
            }
            Request::CreateReview(request) => {
                if !request.screenshots_checked {
                    return Err(bad(
                        "confirm that you checked every screenshot for private data",
                    ));
                }
                let mut ids = request.captures.clone();
                ids.sort_unstable();
                ids.dedup();
                // Each capture once: a list with repeats would render one capture many times.
                if ids.is_empty() || ids.len() > 50 || ids.len() != request.captures.len() {
                    return Err(bad("choose between 1 and 50 captures"));
                }
                let observation = store
                    .get_observation(request.observation)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such observation"))?;
                if observation.revision != request.revision {
                    return Err(ProtocolError::new(
                        ErrorCode::Conflict,
                        "the notes changed after you reviewed them; review again",
                    ));
                }
                let mut items = Vec::new();
                for id in &request.captures {
                    let capture = store
                        .get_capture(*id)
                        .map_err(storage)?
                        .filter(|c| c.observation == observation.id)
                        .ok_or_else(|| {
                            not_found(format!("capture {id} is not in this observation"))
                        })?;
                    let original = self
                        .blobs
                        .read_all(&capture.screenshot.sha256)
                        .map_err(storage)?;
                    let rendered =
                        render::render(&original, &capture.annotations).map_err(storage)?;
                    let evidence = self
                        .blobs
                        .read_all(&capture.evidence.sha256)
                        .map_err(storage)?;
                    let parsed = repro::parse(&evidence)
                        .ok_or_else(|| storage("the capture's evidence is not readable"))?;
                    let marks = repro::mark_targets(
                        &capture.annotations,
                        &parsed.elements,
                        repro::scale(&original, &parsed),
                    );
                    // Trims and cuts decide what leaves; an unedited capture keeps all of it.
                    let kept = if capture.edits == Edits::default() {
                        Vec::new()
                    } else {
                        let kept = capture.edits.kept(capture.started_at, capture.created_at);
                        if kept.is_empty() {
                            return Err(bad(format!(
                                "the edits of capture {id} leave nothing to share"
                            )));
                        }
                        kept
                    };
                    let inside = |at: i64| {
                        kept.is_empty() || kept.iter().any(|r| at >= r.from && at <= r.to)
                    };
                    let annotations: Vec<Annotation> = capture
                        .edits
                        .annotations
                        .iter()
                        .filter(|a| inside(a.at))
                        .cloned()
                        .collect();
                    // A mask hides pixels only: the replay would show the same text. The stored
                    // marks decide, not the page that asked (it can be stale).
                    let masked = capture
                        .annotations
                        .iter()
                        .any(|s| matches!(s, Shape::Mask { .. }));
                    // Screen text and pointed-at names come from the replay: masked, none of it.
                    let (screen, pointing) = if masked {
                        Default::default()
                    } else {
                        self.recording_notes(&capture, &kept)
                    };
                    let before = parsed.actions.len() + parsed.events.len();
                    let shared = repro::for_review(parsed, request.typed_values, &kept);
                    let cut =
                        before.saturating_sub(shared.actions.len() + shared.events.len()) as u32;
                    // Step shots show what was typed, as pixels: they leave only with typed values.
                    let mut shots = Vec::new();
                    // Only a recording's shots are shown for checking (the editor's filmstrip); a
                    // moment capture leaves with its own screenshot only.
                    for shot in capture.shots.iter().filter(|s| {
                        // The editor shows shots with their replay only: none without it.
                        request.typed_values
                            && capture.kind == CaptureKind::Session
                            && capture.recording.is_some()
                            && inside(s.at)
                            && !capture.edits.hidden_shots.contains(&s.at)
                    }) {
                        shots.push(self.masked_shot(shot, &capture.edits)?);
                    }
                    let shared = serde_json::to_vec(&shared).expect("evidence serializes");
                    items.push(ReviewItem {
                        capture: capture.id,
                        page_url: capture.page_url,
                        page_title: capture.page_title,
                        mode: capture.mode,
                        screenshot: self.blobs.put(&rendered, "image/png").map_err(storage)?,
                        evidence: self
                            .blobs
                            .put(&shared, "application/json")
                            .map_err(storage)?,
                        recording: match &capture.recording {
                            Some(recording) if request.recordings.contains(id) && !masked => {
                                Some(self.kept_recording(recording, &kept)?)
                            }
                            _ => None,
                        },
                        findings: export::findings(
                            &serde_json::from_slice(&shared).unwrap_or_default(),
                        ),
                        marks,
                        kind: capture.kind,
                        kept,
                        annotations,
                        screen,
                        pointing,
                        shots,
                        cut,
                        shots_dropped: 0,
                        captured_at: capture.created_at,
                        started_at: capture.started_at,
                    });
                }
                // Transcribed notes only: one still waiting is not something the person has read.
                let voice: Vec<ReviewVoice> = store
                    .list_voice_notes(observation.id)
                    .map_err(storage)?
                    .into_iter()
                    .filter(|v| v.state == VoiceState::Done)
                    .map(|v| ReviewVoice {
                        segments: v
                            .segments
                            .into_iter()
                            .filter(|seg| {
                                crate::record::spoken_in_kept(
                                    items
                                        .iter()
                                        .filter(|i| i.kind == CaptureKind::Session)
                                        .map(|i| (i.started_at, i.captured_at, i.kept.as_slice())),
                                    v.started_at + seg.start_ms,
                                    v.started_at + seg.end_ms,
                                )
                            })
                            .collect(),
                        started_at: v.started_at,
                        duration_ms: v.duration_ms,
                        language: v.language,
                    })
                    .collect();
                let mut review = Review {
                    id: 0,
                    observation: observation.id,
                    revision: observation.revision,
                    created_at: now_ms(),
                    title: observation.title,
                    notes: observation.notes,
                    tags: observation.tags,
                    items,
                    voice,
                };
                // Checked now, so a filing never fails after the person's work.
                self.fit_for_filing(&mut review)?;
                Reply::Review(store.create_review(review).map_err(storage)?)
            }
            Request::Announce(client) => {
                if client.profile.is_empty() || client.profile.len() > 64 {
                    return Err(bad("the profile ID must be 1 to 64 characters"));
                }
                store.save_client(&client, now_ms()).map_err(storage)?;
                Reply::Done
            }
            Request::InstallService => {
                // A separate process: on Linux the install stops this daemon so that the service
                // owns Lens, which would end the install halfway if it ran in here.
                let executable = crate::paths::executable().map_err(storage)?;
                std::process::Command::new(executable)
                    .args(["service", "install"])
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(storage)?;
                Reply::Done
            }
            Request::SetupStatus => {
                let executable = crate::paths::executable().map_err(storage)?;
                let service = match crate::service::state(&self.paths) {
                    crate::service::State::Installed { manager } => Some(manager.to_string()),
                    crate::service::State::NotInstalled => None,
                };
                let mut status = SetupStatus {
                    version: env!("CARGO_PKG_VERSION").into(),
                    protocol: PROTOCOL_VERSION,
                    binary: executable.display().to_string(),
                    service,
                    browsers: crate::register::check(&self.paths, &executable),
                    extensions: store.list_clients().map_err(storage)?,
                    projects: store.count("projects").map_err(storage)?,
                    captures: store.count("captures").map_err(storage)?,
                    vibeq_configured: store.setting("vibeq.endpoint").map_err(storage)?.is_some(),
                    steps: Vec::new(),
                };
                status.steps = crate::setup::steps(&status);
                Reply::Setup(Box::new(status))
            }
            Request::SetPaused { paused } => {
                store
                    .set_setting("collection.paused", if paused { "true" } else { "false" })
                    .map_err(storage)?;
                Reply::Done
            }
            Request::GetUpdates => Reply::Updates(self.update_state(&store)?),
            Request::SetAutomaticUpdates { enabled } => {
                store
                    .set_setting("update.automatic", if enabled { "true" } else { "false" })
                    .map_err(storage)?;
                Reply::Updates(self.update_state(&store)?)
            }
            Request::UpdateNow => {
                drop(store);
                self.update(true)?;
                Reply::Updates(self.update_state(&self.lock_store())?)
            }
            Request::CheckUpdates => {
                drop(store);
                self.update(false)?;
                Reply::Updates(self.update_state(&self.lock_store())?)
            }
            Request::GetDestination => Reply::Destination(destination_settings(&store)?),
            Request::SetDestination {
                choice,
                only_if_unset,
            } => {
                if !only_if_unset
                    || store
                        .setting("task.destination")
                        .map_err(storage)?
                        .is_none()
                {
                    let choice = crate::destination::normalize(choice).map_err(bad)?;
                    if choice.tracker == Tracker::Vibeq && !vibeq_connected(&store)? {
                        return Err(bad("Connect VibeQ in Settings first."));
                    }
                    store
                        .set_setting(
                            "task.destination",
                            &serde_json::to_string(&choice).map_err(storage)?,
                        )
                        .map_err(storage)?;
                }
                Reply::Destination(destination_settings(&store)?)
            }
            Request::GetSummaryAgent => Reply::SummaryAgent(summary_agent(&store)),
            Request::SetSummaryAgent { agent } => {
                let value = match agent {
                    Some(investigate::Agent::Claude) => "claude",
                    Some(investigate::Agent::Codex) => "codex",
                    None => "",
                };
                store.set_setting("agent.summary", value).map_err(storage)?;
                Reply::Done
            }
            Request::ListAgents => {
                drop(store);
                Reply::Agents(
                    [investigate::Agent::Codex, investigate::Agent::Claude]
                        .into_iter()
                        .map(|agent| investigate::AgentInfo {
                            agent,
                            state: investigate::status(agent),
                        })
                        .collect(),
                )
            }
            Request::Investigate { review, agent } => {
                let review = store
                    .get_review(review)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such review"))?;
                drop(store);
                Reply::Suggestion(
                    investigate::investigate(agent, &review, &self.blobs, &self.notebook)
                        .map_err(remote)?,
                )
            }
            Request::ListReviews => Reply::Reviews(store.list_reviews().map_err(storage)?),
            // ponytail: reads every review for each page; a keyset query if lists reach the 100,000s.
            Request::ListReviewsPage {
                before,
                limit,
                observation,
            } => {
                let mut page = store
                    .reviews_page(before, observation, limit.min(500))
                    .map_err(storage)?;
                fit_page(&mut page);
                Reply::Reviews(page)
            }
            Request::GetReview { review } => Reply::Review(
                store
                    .get_review(review)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such review"))?,
            ),
            Request::ExportReview { review } => {
                let review = store
                    .get_review(review)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such review"))?;
                drop(store);
                let folder =
                    export::export(&review, &self.blobs, &self.downloads).map_err(storage)?;
                Reply::Exported(Exported {
                    folder: folder.display().to_string(),
                })
            }
            Request::ReadAttachment {
                review,
                capture,
                offset,
                include_voice,
            } => {
                if offset == 0 {
                    *transfer = None;
                    let frozen = store
                        .get_review(review)
                        .map_err(storage)?
                        .ok_or_else(|| not_found("no such review"))?;
                    let voice = store
                        .mp4_voice(&frozen, capture.is_some() && include_voice)
                        .map_err(storage)?;
                    drop(store);
                    *transfer = Some(
                        crate::attachments::Transfer::open(
                            &frozen,
                            capture,
                            &self.blobs,
                            &self.paths.data.join("video-tools"),
                            &voice,
                        )
                        .map_err(storage)?,
                    );
                } else {
                    drop(store);
                }
                let reader = transfer
                    .as_mut()
                    .filter(|t| t.review == review && t.capture == capture)
                    .ok_or_else(|| bad("No matching attachment transfer on this connection."))?;
                let (bytes, total_size) = reader.read(offset).map_err(storage)?;
                if offset + bytes.len() as u64 == total_size {
                    *transfer = None;
                }
                Reply::Blob(BlobChunk {
                    data: BASE64.encode(bytes),
                    total_size,
                })
            }
            Request::ExportAttachment {
                review,
                capture,
                include_voice,
            } => {
                let review = store
                    .get_review(review)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such review"))?;
                let voice = store
                    .mp4_voice(&review, capture.is_some() && include_voice)
                    .map_err(storage)?;
                drop(store);
                let path = crate::attachments::save(
                    &review,
                    capture,
                    &self.blobs,
                    &voice,
                    &self.downloads,
                    &self.paths.data.join("video-tools"),
                )
                .map_err(storage)?;
                Reply::Attachment(path.display().to_string())
            }
            Request::RecentEvidence { site } => {
                if store
                    .setting("collection.paused")
                    .map_err(storage)?
                    .as_deref()
                    == Some("true")
                {
                    return Err(bad(
                        "Lens is paused: the person stopped collection from the Lens menu",
                    ));
                }
                drop(store);
                let site = site.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
                let tabs = self.live.ask(site).ok_or_else(|| {
                    bad(
                        "no browser answered: open Chrome or Firefox where Lens collects on the \
                         site, and turn on \"Let coding agents read the last ten minutes\" in Lens \
                         Settings",
                    )
                })?;
                Reply::LiveEvidence(tabs.into_iter().map(crate::live::digest).collect())
            }
            Request::WaitForAsk { after } => {
                drop(store);
                Reply::Ask(self.live.wait_for_ask(after))
            }
            Request::ProvideEvidence { ask, tabs } => {
                drop(store);
                self.live.answer(ask, tabs);
                Reply::Done
            }
            Request::SetupPage => {
                drop(store);
                Reply::SetupPage(
                    self.setup_page
                        .get()
                        .ok_or_else(|| bad("the setup page is not running"))?
                        .link(),
                )
            }
            Request::ConnectAgents => {
                drop(store);
                let lens = crate::paths::executable().map_err(storage)?;
                Reply::AgentSetup(crate::agents::connect(&lens))
            }
            Request::DisconnectAgents => {
                drop(store);
                Reply::AgentSetup(crate::agents::disconnect())
            }
            Request::ListHandoffApps => {
                drop(store);
                Reply::HandoffApps(handoff::installed())
            }
            Request::HandOff {
                review,
                app,
                folder,
            } => {
                let review = store
                    .get_review(review)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such review"))?;
                // The recording's newest filing, from this review or an earlier one: the agent
                // then works from that VibeQ task.
                let task = store.filed_task(review.observation).map_err(storage)?;
                drop(store);
                let project = std::path::PathBuf::from(folder.trim());
                if !project.is_absolute() || !project.is_dir() {
                    return Err(bad("choose an existing project folder, as a full path"));
                }
                let exported =
                    export::export(&review, &self.blobs, &self.paths.data.join("handoffs"))
                        .map_err(storage)?;
                let report =
                    std::fs::read_to_string(exported.join("report.md")).map_err(storage)?;
                let prompt = handoff::prompt(
                    app,
                    &review.title,
                    task.as_ref().map(|(id, url)| (id.as_str(), url.as_str())),
                    &exported,
                    &report,
                );
                handoff::start(app, &review.title, &prompt, &project).map_err(bad)?;
                Reply::HandedOff(Exported {
                    folder: exported.display().to_string(),
                })
            }
            Request::GetVibeQ => Reply::VibeQ(vibeq_settings(&store)?),
            Request::SetVibeQ(input) => {
                let saved = store.setting("vibeq.endpoint").map_err(storage)?;
                drop(store);
                let endpoint = vibeq::validate_endpoint(&input.endpoint).map_err(bad)?;
                let moved = saved.as_deref() != Some(endpoint.as_str().trim_end_matches('/'));
                let account = match input.token.as_deref().map(str::trim) {
                    // A token belongs to its VibeQ: a new address without a new token signs out,
                    // so the old token never goes to the new host.
                    None if moved
                        && std::env::var(TOKEN_ENV).is_ok_and(|t| !t.trim().is_empty()) =>
                    {
                        return Err(bad(
                            "LENS_VIBEQ_TOKEN is set for the current VibeQ; unset it before you change the address",
                        ));
                    }
                    None if moved && saved.is_some() => {
                        secrets::delete(TOKEN_ACCOUNT).map_err(storage)?;
                        Some(String::new())
                    }
                    None => None,
                    Some("") => {
                        secrets::delete(TOKEN_ACCOUNT).map_err(storage)?;
                        Some(String::new())
                    }
                    Some(token) => {
                        // A token that VibeQ does not accept is never saved.
                        let me = Client::new(endpoint.as_str(), token)
                            .map_err(bad)?
                            .me()
                            .map_err(remote)?;
                        // LENS_VIBEQ_TOKEN wins over a saved token, so there is nothing to save.
                        if std::env::var(TOKEN_ENV).is_ok_and(|t| !t.trim().is_empty()) {
                            if saved_token()?.as_deref() != Some(token) {
                                return Err(bad(
                                    "LENS_VIBEQ_TOKEN is set and overrides this token",
                                ));
                            }
                        } else {
                            secrets::set(TOKEN_ACCOUNT, token).map_err(storage)?;
                        }
                        Some(me.name)
                    }
                };
                token_changed();
                let store = self.lock_store();
                let endpoint = endpoint.as_str().trim_end_matches('/');
                store
                    .set_setting("vibeq.endpoint", endpoint)
                    .map_err(storage)?;
                if let Some(account) = account {
                    store
                        .set_setting("vibeq.account", &account)
                        .map_err(storage)?;
                }
                Reply::VibeQ(vibeq_settings(&store)?)
            }
            Request::ListMembers => {
                drop(store);
                Reply::Members(self.vibeq_client()?.members().map_err(remote)?)
            }
            Request::GetFiling { review } => {
                let attempt = store
                    .filing(review)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("this review was not filed"))?;
                Reply::Filing(filing_reply(&attempt))
            }
            Request::FileReview { review, assignee } => {
                let found = store
                    .get_review(review)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such review"))?;
                if !FILING
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(found.observation)
                {
                    return Err(ProtocolError::new(
                        ErrorCode::Conflict,
                        "Lens is filing this already; wait for it to finish",
                    ));
                }
                let _filing = FilingNow(found.observation);
                let existing = store.filing(review).map_err(storage)?;
                let filed = store.filed(found.observation).map_err(storage)?;
                let install = self.install_id(&store)?;
                // An amendment stays in the first filing's project: VibeQ finds the task by it,
                // also when the site moved to another project since.
                let project = match &filed {
                    Some(f) => f.project_id.clone(),
                    None => project_for(&store, found.items.first().map(|i| i.page_url.as_str()))?,
                };
                drop(store);
                let client = self.vibeq_client()?;
                let mut attempt = match existing {
                    Some(attempt) => attempt,
                    None => {
                        // Before any file is staged: retries of a frozen attempt come above.
                        if let Some(why) =
                            filing::refused(&found, filed.as_ref(), &client.endpoint())
                        {
                            return Err(ProtocolError::new(ErrorCode::Conflict, why));
                        }
                        let attempt = filing::prepare(
                            &found,
                            &self.blobs,
                            &self.filings,
                            &client.endpoint(),
                            install,
                            project,
                            assignee,
                        )
                        .map(|mut attempt| {
                            attempt.submission.revision =
                                filing::next_revision(&found, filed.as_ref());
                            attempt
                        })
                        .map_err(bad)?;
                        self.lock_store().save_filing(&attempt).map_err(storage)?;
                        attempt
                    }
                };
                let delivered = filing::deliver(&mut attempt, &client, |a| {
                    self.lock_store().save_filing(a).map_err(|e| e.to_string())
                });
                delivered.map_err(remote)?;
                Reply::Filing(filing_reply(&attempt))
            }
            Request::ListIssues { observation } => Reply::Issues(
                store
                    .setting(&format!("issues.{observation}"))
                    .map_err(storage)?
                    .and_then(|json| serde_json::from_str(&json).ok())
                    .unwrap_or_default(),
            ),
            Request::SplitIntoTasks {
                observation,
                revision,
                issues,
            } => {
                if issues.len() < 2
                    || issues.len() > 8
                    || issues.iter().any(|i| plain(&i.title).is_empty())
                {
                    return Err(bad("split into 2 to 8 tasks, each with a title"));
                }
                let found = store
                    .get_observation(observation)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such observation"))?;
                let captures = store.list_captures(observation).map_err(storage)?;
                let voice_start = store
                    .list_voice_notes(observation)
                    .map_err(storage)?
                    .iter()
                    .filter(|v| v.state == VoiceState::Done)
                    .map(|v| v.started_at)
                    .min();
                let own = split_findings(&found.notes).1;
                let plans: Vec<crate::store::TaskPlan> = issues
                    .iter()
                    .map(|issue| {
                        let (edits, leave) = issue_edits(issue, voice_start, &captures);
                        crate::store::TaskPlan {
                            title: plain(&issue.title),
                            notes: [
                                format!(
                                    "{FINDINGS_HEADER}\n{}",
                                    issue
                                        .findings
                                        .iter()
                                        .map(|f| format!("- {}", export::escape(f)))
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                ),
                                own.clone(),
                            ]
                            .into_iter()
                            .filter(|p| !p.is_empty())
                            .collect::<Vec<_>>()
                            .join("\n\n"),
                            tags: clean_tags(&issue.tags),
                            edits,
                            leave,
                        }
                    })
                    .collect();
                match store
                    .split_into_tasks(observation, revision, &plans, now_ms())
                    .map_err(storage)?
                {
                    Ok(created) => {
                        self.requeue_voice(&store);
                        Reply::Split(created)
                    }
                    Err(Updated::Missing) => return Err(not_found("no such observation")),
                    Err(_) => {
                        return Err(ProtocolError::new(
                            ErrorCode::Conflict,
                            "the notes changed after the split was suggested; look again",
                        ));
                    }
                }
            }
            Request::FindDuplicates { observation } => {
                let found = store
                    .get_observation(observation)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such observation"))?;
                // This observation's own task, from an earlier filing, is not a duplicate of it.
                let own_task = store
                    .filed_task(observation)
                    .map_err(storage)?
                    .map(|(id, _)| id);
                drop(store);
                Reply::Duplicates(self.duplicates(&found, own_task.as_deref())?)
            }
            Request::StartSirvant { review } => {
                let attempt = store.filing(review).map_err(storage)?;
                drop(store);
                let Some((endpoint, task)) =
                    attempt.and_then(|a| a.receipt.map(|r| (a.endpoint, r.task_id)))
                else {
                    return Err(bad("file the review to VibeQ first"));
                };
                let client = self.vibeq_client()?;
                if client.endpoint() != endpoint {
                    return Err(bad(format!(
                        "this review was filed to {endpoint}; restore that VibeQ address first"
                    )));
                }
                Reply::Sirvant(client.start_sirvant(&task).map_err(remote)?)
            }
            Request::UploadChunk(chunk) => {
                drop(store);
                Reply::Uploaded(self.upload(chunk)?)
            }
            Request::AddVoiceNote(note) => {
                store
                    .get_observation(note.observation)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such observation"))?;
                let (header, size) = self
                    .blobs
                    .read(&note.audio.sha256, 0, speech::WAV_HEADER_BYTES)
                    .map_err(|_| not_found("upload the recording first"))?;
                let duration = speech::wav_duration_ms(&header, size).map_err(bad)?;
                let audio = BlobRef {
                    size,
                    media_type: "audio/wav".into(),
                    ..note.audio
                };
                let saved = store
                    .add_voice_note(note.observation, note.started_at, duration, &audio)
                    .map_err(storage)?;
                self.queue_transcription(saved.id);
                Reply::VoiceNote(saved)
            }
            Request::ListVoiceNotes { observation } => {
                Reply::VoiceNotes(store.list_voice_notes(observation).map_err(storage)?)
            }
            Request::RetryVoiceNote { id } => {
                let note = store
                    .get_voice_note(id)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such voice note"))?;
                if note.state != VoiceState::Failed {
                    return Err(bad("only a voice note that failed is transcribed again"));
                }
                store
                    .set_voice_state(id, VoiceState::Waiting, None, &[], None)
                    .map_err(storage)?;
                let note = store
                    .get_voice_note(id)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such voice note"))?;
                drop(store);
                self.queue_transcription(id);
                Reply::VoiceNote(note)
            }
            Request::DeleteVoiceNote { id } => {
                if !store.delete_voice_note(id).map_err(storage)? {
                    return Err(not_found("no such voice note"));
                }
                Reply::Deleted
            }
            Request::UpdateVoiceNote { id, segments } => {
                let note = store
                    .get_voice_note(id)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such voice note"))?;
                if segments.len() > 2000 || segments.iter().any(|s| s.text.len() > 4000) {
                    return Err(bad("the transcript is too long"));
                }
                // A note still being written down gets the machine's words over this edit.
                if !matches!(note.state, VoiceState::Done | VoiceState::Failed) {
                    return Err(ProtocolError::new(
                        ErrorCode::Conflict,
                        "the voice note is still being written down; correct it when it is done",
                    ));
                }
                if segments.iter().any(|s| {
                    s.start_ms < 0 || s.end_ms < s.start_ms || s.end_ms > note.duration_ms + 1000
                }) {
                    return Err(bad("a transcript line is outside the voice note"));
                }
                store
                    .set_voice_state(
                        id,
                        VoiceState::Done,
                        note.language.as_deref(),
                        &segments,
                        note.detail.as_deref(),
                    )
                    .map_err(storage)?;
                Reply::VoiceNote(
                    store
                        .get_voice_note(id)
                        .map_err(storage)?
                        .expect("it exists"),
                )
            }
            Request::Summarize { observation } => {
                drop(store);
                Reply::Summary(self.summary(observation)?)
            }
            Request::SpeechStatus => {
                drop(store);
                Reply::Speech(self.speech_status())
            }
            Request::InstallSpeech => {
                drop(store);
                self.install_speech();
                Reply::Speech(self.speech_status())
            }
            Request::ReadBlob {
                sha256,
                offset,
                length,
            } => {
                drop(store);
                let (chunk, total_size) = self
                    .blobs
                    .read(&sha256, offset, length.min(MAX_BLOB_CHUNK))
                    .map_err(|e| match e.kind() {
                        std::io::ErrorKind::NotFound => not_found("no such blob"),
                        std::io::ErrorKind::InvalidInput => bad(e.to_string()),
                        _ => storage(e),
                    })?;
                Reply::Blob(BlobChunk {
                    data: BASE64.encode(chunk),
                    total_size,
                })
            }
            Request::Shutdown => Reply::Stopping,
        })
    }
}

impl Daemon {
    fn update_state(&self, store: &Store) -> Result<UpdateState, ProtocolError> {
        let executable = crate::paths::executable().map_err(storage)?;
        Ok(UpdateState {
            current: env!("CARGO_PKG_VERSION").into(),
            // Empty once checked and none was found; stale once this version installed it.
            available: store
                .setting("update.available")
                .map_err(storage)?
                .filter(|v| crate::update::newer(v, env!("CARGO_PKG_VERSION"))),
            checked_at: store
                .setting("update.checked_at")
                .map_err(storage)?
                .and_then(|t| t.parse().ok()),
            automatic: store
                .setting("update.automatic")
                .map_err(storage)?
                .as_deref()
                != Some("false"),
            managed_by: crate::update::managed_by(&executable).map(String::from),
            last_error: store
                .setting("update.error")
                .map_err(storage)?
                .filter(|e| !e.is_empty()),
        })
    }

    /// Checks the signed feed; with `install`, installs a newer release and restarts Lens.
    pub fn update(&self, install: bool) -> Result<(), ProtocolError> {
        let found = crate::update::check();
        let store = self.lock_store();
        store
            .set_setting("update.checked_at", &now_ms().to_string())
            .map_err(storage)?;
        let manifest = match found {
            Ok(manifest) => manifest,
            Err(e) => {
                store.set_setting("update.error", &e).map_err(storage)?;
                return Err(remote(e));
            }
        };
        store.set_setting("update.error", "").map_err(storage)?;
        let Some(manifest) = manifest else {
            store.set_setting("update.available", "").map_err(storage)?;
            return Ok(());
        };
        store
            .set_setting("update.available", &manifest.version)
            .map_err(storage)?;
        drop(store);
        if !install {
            return Ok(());
        }
        log(
            &self.paths,
            &format!("installing update {}", manifest.version),
        );
        // Read before the file is replaced: afterwards Linux reports this binary as "… (deleted)".
        let executable = crate::paths::executable().map_err(storage)?;
        if let Err(e) = crate::update::install(&self.paths, &manifest) {
            let _ = self.lock_store().set_setting("update.error", &e);
            return Err(remote(e));
        }
        restart_soon(&self.paths, &executable);
        Ok(())
    }

    /// Makes a review fit what VibeQ takes: at most MAX_ATTACHMENTS files, so the shots share
    /// what the records, end screenshots and recordings leave (evenly spaced, the rest counted);
    /// and records under their size limit.
    fn fit_for_filing(&self, review: &mut Review) -> Result<(), ProtocolError> {
        let limit = crate::filing::MAX_ATTACHMENTS;
        let base: usize = review
            .items
            .iter()
            .map(|i| {
                1 + usize::from(crate::record::files_end_screenshot(i))
                    + usize::from(i.recording.is_some())
            })
            .sum();
        if base > limit {
            return Err(bad(format!(
                "this review would file {base} files and VibeQ takes {limit}; review fewer captures at once"
            )));
        }
        crate::record::share_shots(&mut review.items, limit - base);
        for (index, item) in review.items.iter().enumerate() {
            let evidence = self
                .blobs
                .read_all(&item.evidence.sha256)
                .ok()
                .and_then(|b| repro::parse(&b))
                .ok_or_else(|| storage("the capture's evidence is not readable"))?;
            crate::record::build(review, item, index + 1, &evidence).map_err(bad)?;
        }
        Ok(())
    }

    /// Shots from UploadChunk: stored WebP images, at most MAX_SHOTS.
    fn checked_shots(&self, shots: &[Shot]) -> Result<Vec<Shot>, ProtocolError> {
        if shots.len() > MAX_SHOTS {
            return Err(bad(format!("a capture keeps at most {MAX_SHOTS} shots")));
        }
        shots
            .iter()
            .map(|shot| {
                let (head, size) = self
                    .blobs
                    .read(&shot.image.sha256, 0, 12)
                    .map_err(|_| not_found("upload the shots first"))?;
                if head.get(0..4) != Some(b"RIFF") || head.get(8..12) != Some(b"WEBP") {
                    return Err(bad("a shot must be a WebP image"));
                }
                Ok(Shot {
                    at: shot.at,
                    image: BlobRef {
                        size,
                        media_type: "image/webp".into(),
                        ..shot.image.clone()
                    },
                    reason: if shot.reason == "end" { "end" } else { "step" }.into(),
                })
            })
            .collect()
    }

    /// What the screen showed in a capture's DOM recording, inside the kept time.
    /// The shot with the person's masks burned in; the unmasked one never leaves.
    fn masked_shot(&self, shot: &Shot, edits: &Edits) -> Result<Shot, ProtocolError> {
        let Some(mask) = edits
            .shot_masks
            .iter()
            .find(|m| m.at == shot.at && !m.areas.is_empty())
        else {
            return Ok(shot.clone());
        };
        let original = self.blobs.read_all(&shot.image.sha256).map_err(storage)?;
        let masked = render::mask_webp(&original, &mask.areas).map_err(storage)?;
        Ok(Shot {
            image: self.blobs.put(&masked, "image/webp").map_err(storage)?,
            ..shot.clone()
        })
    }

    /// The recording as the edits left it: an unedited one as it is, an edited one rebuilt from
    /// the kept parts only, so no frame of a cut part leaves.
    fn kept_recording(
        &self,
        recording: &BlobRef,
        kept: &[TimeRange],
    ) -> Result<BlobRef, ProtocolError> {
        if kept.is_empty() {
            return Ok(recording.clone());
        }
        let events: Vec<serde_json::Value> = self
            .blobs
            .read_all(&recording.sha256)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .ok_or_else(|| storage("the capture's recording is not readable"))?;
        let trimmed = crate::digest::trim(&events, kept);
        let bytes = serde_json::to_vec(&trimmed).expect("events serialize");
        self.blobs
            .put(&bytes, &recording.media_type)
            .map_err(storage)
    }

    /// What the recording shows, inside the kept time: the screen changes, and where the pointer
    /// rested (what "this" meant while the person spoke).
    fn recording_notes(
        &self,
        capture: &Capture,
        kept: &[TimeRange],
    ) -> (Vec<ScreenNote>, Vec<Pointing>) {
        let Some(recording) = &capture.recording else {
            return (Vec::new(), Vec::new());
        };
        let Some(events) = self
            .blobs
            .read_all(&recording.sha256)
            .ok()
            .and_then(|b| serde_json::from_slice::<Vec<serde_json::Value>>(&b).ok())
        else {
            return (Vec::new(), Vec::new());
        };
        let inside = |from: i64, to: i64| {
            to >= capture.started_at - 2000
                && (kept.is_empty() || kept.iter().any(|r| from <= r.to && to >= r.from))
        };
        let screen = crate::digest::digest(&events)
            .into_iter()
            .filter(|n| inside(n.at, n.at))
            .collect();
        // A label was read when the pointer arrived: it must have arrived inside a kept part,
        // and it ends where that part ends, so nothing from a cut part leaves.
        let pointing = crate::digest::pointing(&events)
            .into_iter()
            .filter(|p| inside(p.from, p.to))
            .filter_map(|mut p| {
                if kept.is_empty() {
                    return Some(p);
                }
                let r = kept.iter().find(|r| p.from >= r.from && p.from <= r.to)?;
                p.to = p.to.min(r.to);
                Some(p)
            })
            .collect();
        (screen, pointing)
    }

    /// A title and findings for an observation from a small model. Nothing is saved.
    fn summary(&self, observation: i64) -> Result<investigate::Summary, ProtocolError> {
        let store = self.lock_store();
        let found = store
            .get_observation(observation)
            .map_err(storage)?
            .ok_or_else(|| not_found("no such observation"))?;
        let captures = store.list_captures(observation).map_err(storage)?;
        let voice: Vec<ReviewVoice> = store
            .list_voice_notes(observation)
            .map_err(storage)?
            .into_iter()
            .filter(|v| v.state == VoiceState::Done)
            .map(|v| ReviewVoice {
                started_at: v.started_at,
                duration_ms: v.duration_ms,
                language: v.language,
                segments: v.segments,
            })
            .collect();
        drop(store);
        // Words from cut or trimmed parts never reach the model, as they never leave in a review.
        let recordings: Vec<(i64, i64, Vec<TimeRange>)> = captures
            .iter()
            .filter(|c| c.kind == CaptureKind::Session)
            .map(|c| {
                let kept = if c.edits == Edits::default() {
                    Vec::new()
                } else {
                    c.edits.kept(c.started_at, c.created_at)
                };
                (c.started_at, c.created_at, kept)
            })
            .collect();
        let voice: Vec<ReviewVoice> = voice
            .into_iter()
            .map(|mut v| {
                v.segments.retain(|seg| {
                    crate::record::spoken_in_kept(
                        recordings.iter().map(|(a, b, k)| (*a, *b, k.as_slice())),
                        v.started_at + seg.start_ms,
                        v.started_at + seg.end_ms,
                    )
                });
                v
            })
            .collect();
        let mut items = Vec::new();
        for capture in &captures {
            let Some(evidence) = self
                .blobs
                .read_all(&capture.evidence.sha256)
                .ok()
                .and_then(|b| repro::parse(&b))
            else {
                continue;
            };
            let kept = if capture.edits == Edits::default() {
                Vec::new()
            } else {
                capture.edits.kept(capture.started_at, capture.created_at)
            };
            let (screen, pointing) = self.recording_notes(capture, &kept);
            let context = repro::Context {
                voice: &voice,
                notes: &capture.edits.annotations,
                screen: &screen,
                pointing: &pointing,
                kept: &kept,
            };
            let shared = repro::for_review(evidence, false, &kept);
            items.push(serde_json::json!({
                "pageUrl": capture.page_url,
                "pageTitle": capture.page_title,
                "timeline": repro::timeline(&shared, &context),
            }));
        }
        let context = serde_json::json!({
            "currentTitle": found.title,
            "personNotes": found.notes,
            "voiceTranscripts": voice.iter().map(export::voice_transcript).collect::<Vec<_>>(),
            "captures": items,
        });
        let preferred = summary_agent(&self.lock_store());
        let summary =
            investigate::summarize(&context, &self.notebook, preferred).map_err(remote)?;
        // The review page offers to split by these, also when the summary ran in the background.
        // Not for an observation deleted while the model ran: a new one can get its ID.
        let store = self.lock_store();
        if store.get_observation(observation).ok().flatten().is_some() {
            let _ = store.set_setting(
                &format!("issues.{observation}"),
                &serde_json::to_string(&summary.issues).expect("issues serialize"),
            );
        }
        drop(store);
        Ok(summary)
    }

    /// Open VibeQ tasks like this observation: VibeQ's title search for the title and each
    /// finding, then a small model's judgment of which describe the same problem. Without a
    /// model, close titles come back as "maybe".
    fn duplicates(
        &self,
        found: &Observation,
        own_task: Option<&str>,
    ) -> Result<Vec<investigate::Duplicate>, ProtocolError> {
        let client = self.vibeq_client()?;
        let findings: Vec<String> = split_findings(&found.notes)
            .0
            .iter()
            .map(|f| f.trim_start_matches("- ").replace('\\', ""))
            .collect();
        let mut queries = vec![found.title.clone()];
        queries.extend(findings.iter().cloned());
        queries.truncate(6);
        let mut candidates: Vec<serde_json::Value> = Vec::new();
        for query in &queries {
            for result in client.similar(query).map_err(remote)? {
                let Some(id) = result["id"].as_str() else {
                    continue;
                };
                if Some(id) == own_task {
                    continue;
                }
                let score = result["similarity"].as_f64().unwrap_or(0.0);
                match candidates.iter_mut().find(|c| c["id"] == id) {
                    Some(seen) if seen["similarity"].as_f64().unwrap_or(0.0) < score => {
                        seen["similarity"] = score.into()
                    }
                    Some(_) => {}
                    None => candidates.push(result),
                }
            }
        }
        candidates.sort_by(|a, b| {
            b["similarity"]
                .as_f64()
                .partial_cmp(&a["similarity"].as_f64())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        candidates.truncate(8);
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let brief: Vec<serde_json::Value> = candidates
            .iter()
            .map(|c| {
                serde_json::json!({
                    "id": c["id"],
                    "title": c["title"],
                    "status": c["status"],
                    "description": c["description"].as_str().unwrap_or("").chars().take(400).collect::<String>(),
                })
            })
            .collect();
        let report = serde_json::json!({ "title": found.title, "findings": findings });
        let preferred = summary_agent(&self.lock_store());
        let judged = investigate::judge_duplicates(
            &report,
            &serde_json::Value::from(brief),
            &self.notebook,
            preferred,
        );
        let endpoint = client.endpoint();
        Ok(candidates
            .iter()
            .filter_map(|c| {
                let id = c["id"].as_str()?.to_string();
                let similarity = c["similarity"].as_f64().unwrap_or(0.0);
                let (verdict, reason) = match &judged {
                    Ok(same) => match same.iter().find(|(i, _)| *i == id) {
                        Some((_, reason)) => ("same", Some(reason.clone())),
                        None if similarity >= 0.5 => ("maybe", None),
                        None => return None,
                    },
                    // No model: close titles only, as a hint.
                    Err(_) if similarity >= 0.3 => ("maybe", None),
                    Err(_) => return None,
                };
                Some(investigate::Duplicate {
                    url: format!("{endpoint}/?task={id}"),
                    task_id: id,
                    title: c["title"].as_str().unwrap_or_default().to_string(),
                    status: c["status"].as_str().unwrap_or_default().to_string(),
                    similarity,
                    verdict: verdict.into(),
                    reason,
                })
            })
            .collect())
    }

    /// Titles an observation in the background, once its words are written down, unless the
    /// person named it: only a page's own title or Lens's earlier automatic one is replaced.
    fn auto_title(&self, observation: i64) {
        let Some(daemon) = self.me() else { return };
        if !self
            .titling
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(observation)
        {
            return;
        }
        std::thread::spawn(move || {
            // A Record mode voice note arrives a few seconds after its recording.
            std::thread::sleep(std::time::Duration::from_secs(8));
            if let Err(e) = daemon.try_auto_title(observation) {
                log(
                    &daemon.paths,
                    &format!("title for observation {observation}: {e}"),
                );
            }
            daemon
                .titling
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&observation);
        });
    }

    fn try_auto_title(&self, observation: i64) -> Result<(), String> {
        let key = format!("title.auto.{observation}");
        let (found, automatic, waiting) = {
            let store = self.lock_store();
            let Some(found) = store
                .get_observation(observation)
                .map_err(|e| e.to_string())?
            else {
                return Ok(());
            };
            let captures = store
                .list_captures(observation)
                .map_err(|e| e.to_string())?;
            let earlier = store.setting(&key).map_err(|e| e.to_string())?;
            let automatic = found.title.trim().is_empty()
                || earlier.as_deref() == Some(found.title.as_str())
                || captures
                    .iter()
                    .any(|c| c.page_title == found.title || c.page_url == found.title);
            let waiting = store
                .list_voice_notes(observation)
                .map_err(|e| e.to_string())?
                .iter()
                .any(|v| {
                    v.state == VoiceState::Transcribing
                        || (v.state == VoiceState::Waiting && v.detail.is_none())
                });
            (found, automatic, waiting)
        };
        // Words still being written down call this again when they are done.
        let preferred = summary_agent(&self.lock_store());
        if !automatic || waiting || investigate::Agent::pick(preferred).is_none() {
            return Ok(());
        }
        let summary = self.summary(observation).map_err(|e| e.message)?;
        let store = self.lock_store();
        let previous = strip_findings(&found.notes);
        let findings = if summary.findings.is_empty() {
            String::new()
        } else {
            // The model read page text: its words cannot add links, images or HTML to the notes.
            format!(
                "{FINDINGS_HEADER}\n{}",
                summary
                    .findings
                    .iter()
                    .map(|f| format!("- {}", export::escape(f)))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        };
        let notes = [findings, previous]
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        let title = plain(&summary.title);
        // A person who edited meanwhile wins: the revision no longer matches and nothing changes.
        if let Updated::Saved(_) = store
            .update_observation(
                observation,
                found.revision,
                &title,
                &notes,
                // The person's own tags win; the model's only fill an empty list.
                found.tags.is_empty().then_some(summary.tags.as_slice()),
                now_ms(),
            )
            .map_err(|e| e.to_string())?
        {
            store.set_setting(&key, &title).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn me(&self) -> Option<Arc<Daemon>> {
        self.me.get().and_then(std::sync::Weak::upgrade)
    }

    fn speech_status(&self) -> SpeechStatus {
        let download = self
            .speech_download
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        speech::status(&self.paths, download.as_ref())
    }

    /// Starts the model download unless the models are there or a download runs.
    fn install_speech(&self) {
        let mut slot = self
            .speech_download
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if matches!(*slot, Some(ModelState::Downloading { .. }))
            || speech::models_ready(&self.paths)
        {
            return;
        }
        *slot = Some(ModelState::Downloading {
            received: 0,
            total: speech::download_size(),
        });
        drop(slot);
        let Some(daemon) = self.me() else { return };
        std::thread::spawn(move || {
            // A panic fails this download instead of leaving it "downloading" until a restart.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                speech::download(&daemon.paths, |received, total| {
                    *daemon
                        .speech_download
                        .lock()
                        .unwrap_or_else(|p| p.into_inner()) =
                        Some(ModelState::Downloading { received, total });
                })
            }))
            .unwrap_or_else(|_| Err("the download stopped unexpectedly; try again".into()));
            let next = match result {
                Ok(()) => None,
                Err(reason) => {
                    log(&daemon.paths, &format!("speech model download: {reason}"));
                    Some(ModelState::Failed { reason })
                }
            };
            *daemon
                .speech_download
                .lock()
                .unwrap_or_else(|p| p.into_inner()) = next;
            // Voice notes that waited for the model go now.
            if let Ok(waiting) = daemon.lock_store().untranscribed_voice_notes() {
                for id in waiting {
                    daemon.queue_transcription(id);
                }
            }
        });
    }

    /// Removes what no record names any more: blobs older than an hour (a new one waits for the
    /// record that will name it), and the frozen folders of deleted reviews in filings/ and
    /// handoffs/. Runs on its own thread.
    fn sweep_soon(&self) {
        if SWEEPING.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let Some(daemon) = self.me.get().and_then(std::sync::Weak::upgrade) else {
            SWEEPING.store(false, std::sync::atomic::Ordering::SeqCst);
            return;
        };
        std::thread::spawn(move || {
            daemon.sweep();
            SWEEPING.store(false, std::sync::atomic::Ordering::SeqCst);
        });
    }

    /// Under the store lock: no record can name a blob or a review appear while files go.
    fn sweep(&self) {
        let store = self.lock_store();
        let (blobs, reviews) = match store.references() {
            Ok(found) => found,
            Err(e) => return log(&self.paths, &format!("sweep: {e}")),
        };
        match self
            .blobs
            .sweep(&blobs, std::time::Duration::from_secs(3600))
        {
            Ok(0) => {}
            Ok(n) => log(&self.paths, &format!("removed {n} files no record names")),
            Err(e) => log(&self.paths, &format!("sweep: {e}")),
        }
        // Uploads the browser gave up on (a closed tab, a lost connection) never finish.
        if let Ok(parts) = std::fs::read_dir(self.paths.data.join("uploads")) {
            for part in parts.flatten() {
                let old = part
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age > std::time::Duration::from_secs(24 * 3600));
                if old {
                    let _ = std::fs::remove_file(part.path());
                }
            }
        }
        for root in [self.paths.filings(), self.paths.data.join("handoffs")] {
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let review = name
                    .strip_prefix("lens-review-")
                    .and_then(|rest| rest.split('-').next())
                    .and_then(|id| id.parse::<i64>().ok());
                if review.is_some_and(|id| !reviews.contains(&id)) {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        drop(store);
    }

    /// Voice notes that a split copied while they were still being written down.
    fn requeue_voice(&self, store: &Store) {
        if let Ok(waiting) = store.untranscribed_voice_notes() {
            for id in waiting {
                self.queue_transcription(id);
            }
        }
    }

    fn queue_transcription(&self, id: i64) {
        if let Some(queue) = self.speech_queue.get() {
            let _ = queue.send(id);
        }
    }

    /// Transcribes one voice note, unless it is done or the model is missing.
    fn transcribe(&self, id: i64) {
        let Ok(Some(note)) = self.lock_store().get_voice_note(id) else {
            return;
        };
        if matches!(note.state, VoiceState::Done | VoiceState::Failed) {
            return;
        }
        let wait = |detail: &str| {
            let _ =
                self.lock_store()
                    .set_voice_state(id, VoiceState::Waiting, None, &[], Some(detail));
        };
        if !speech::models_ready(&self.paths) {
            return wait("Waiting for the speech model: download it in Lens settings.");
        }
        let Ok(file) = self.blobs.file(&note.audio.sha256) else {
            return wait("The recording is missing.");
        };
        let _ = self
            .lock_store()
            .set_voice_state(id, VoiceState::Transcribing, None, &[], None);
        let result = speech::transcribe(&self.paths, &file, note.duration_ms);
        let store = self.lock_store();
        if result.is_ok() {
            self.auto_title(note.observation);
        }
        let _ = match result {
            Ok(t) => store.set_voice_state(
                id,
                VoiceState::Done,
                Some(&t.language),
                &t.segments,
                Some(&t.engine),
            ),
            Err(e) => {
                log(&self.paths, &format!("voice note {id}: {e}"));
                store.set_voice_state(id, VoiceState::Failed, None, &[], Some(&e))
            }
        };
    }

    /// Appends a chunk to an upload in `uploads/`; the last one becomes a blob.
    fn upload(&self, chunk: UploadChunk) -> Result<Option<BlobRef>, ProtocolError> {
        const MAX_UPLOAD: u64 = 512 * 1024 * 1024;
        let id_ok = chunk.upload.len() == 36
            && chunk
                .upload
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b'-');
        if !id_ok {
            return Err(bad("the upload ID must be a UUID"));
        }
        if !matches!(
            chunk.media_type.as_str(),
            "audio/wav" | "application/json" | "image/webp" | "image/png"
        ) {
            return Err(bad(
                "Lens takes WAV audio, WebP and PNG images and JSON uploads only",
            ));
        }
        let data = BASE64
            .decode(chunk.data.as_bytes())
            .map_err(|e| bad(format!("the chunk is not base64: {e}")))?;
        let dir = self.paths.data.join("uploads");
        std::fs::create_dir_all(&dir).map_err(storage)?;
        let part = dir.join(&chunk.upload);
        // The offset check and the append are one step: two chunks of one upload sent at once
        // must never both pass the check and interleave their bytes.
        // ponytail: one lock for every upload; one per upload ID if uploads ever run side by side.
        static UPLOADING: Mutex<()> = Mutex::new(());
        let _one_at_a_time = UPLOADING.lock().unwrap_or_else(|e| e.into_inner());
        let received = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if chunk.offset != received {
            return Err(ProtocolError::new(
                ErrorCode::Conflict,
                format!("the upload has {received} bytes, not {}", chunk.offset),
            ));
        }
        if received + data.len() as u64 > MAX_UPLOAD {
            let _ = std::fs::remove_file(&part);
            return Err(ProtocolError::new(
                ErrorCode::TooLarge,
                "uploads stop at 512 MiB",
            ));
        }
        {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&part)
                .map_err(storage)?;
            file.write_all(&data).map_err(storage)?;
        }
        if !chunk.done {
            return Ok(None);
        }
        self.blobs
            .put_file(&part, &chunk.media_type)
            .map(Some)
            .map_err(storage)
    }

    fn lock_store(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn vibeq_client(&self) -> Result<Client, ProtocolError> {
        let endpoint = self
            .lock_store()
            .setting("vibeq.endpoint")
            .map_err(storage)?
            .ok_or_else(|| bad("add the VibeQ address in Settings first"))?;
        let token = saved_token()?.ok_or_else(|| bad("sign in to VibeQ in Settings first"))?;
        Client::new(&endpoint, &token).map_err(bad)
    }

    /// A random ID made once per notebook; VibeQ observation IDs derive from it, so two notebooks
    /// never claim the same observation.
    fn install_id(&self, store: &Store) -> Result<uuid::Uuid, ProtocolError> {
        if let Some(id) = store.setting("install.id").map_err(storage)?
            && let Ok(id) = uuid::Uuid::parse_str(&id)
        {
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4();
        store
            .set_setting("install.id", &id.to_string())
            .map_err(storage)?;
        Ok(id)
    }
}

/// The Lens project of the review's page, as VibeQ's project key.
fn project_for(store: &Store, page_url: Option<&str>) -> Result<String, ProtocolError> {
    let origin = page_url
        .and_then(|u| url::Url::parse(u).ok())
        .map(|u| u.origin().ascii_serialization());
    let projects = store.list_projects().map_err(storage)?;
    Ok(projects
        .iter()
        .find(|p| origin.as_ref().is_some_and(|o| p.origins.contains(o)))
        .map(|p| format!("lens-project-{}", p.id))
        .unwrap_or_else(|| "lens".into()))
}

/// Set once a restart is on its way, so two reasons never start two restarts.
static SWEEPING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static RESTARTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// This daemon runs under the service manager (`lens daemon --service`).
static SERVICE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// An installer may replace Lens while it runs (a new DMG, setup program or package). The service
/// then restarts on the new program instead of serving the old one until the next login.
/// Keeps the menu-bar icon there: a tray can end when an update replaces the app while it hands
/// over to the new one, and nothing else starts it again. Quit Lens stops this daemon too, so a
/// tray the person quit does not come back. At login the service can start before the desktop's
/// panel: after three quick tries this tries every five minutes, so the icon comes once the panel
/// is up, and a session without a panel costs one try now and then.
fn watch_tray(paths: &Paths) {
    let paths = paths.clone();
    std::thread::spawn(move || {
        let mut misses = 0u32;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            if crate::tray::running(&paths) {
                misses = 0;
                continue;
            }
            misses += 1;
            if misses == 4 {
                log(
                    &paths,
                    "the tray does not stay up yet (see tray.log); trying every five minutes",
                );
            }
            if misses > 3 && !misses.is_multiple_of(10) {
                continue;
            }
            log(&paths, "the tray was not running; starting it");
            crate::tray::spawn(&paths);
        }
    });
}

/// Every five minutes, repairs the browser registrations when one stops pointing at this program:
/// a browser installed since, a manifest another Lens copy wrote, or one a cleanup removed. The
/// extension then reconnects by itself. Sandboxed browsers ("(Flatpak)", "(Snap)") stay as they are:
/// a manifest cannot fix them.
fn watch_registration(paths: &Paths) {
    let paths = paths.clone();
    std::thread::spawn(move || {
        let Ok(executable) = crate::paths::executable() else {
            return;
        };
        loop {
            std::thread::sleep(std::time::Duration::from_secs(300));
            // A program that moved (an AppImage) is no longer the one to register: its new copy
            // registers itself when it starts.
            if !executable.is_file() {
                return;
            }
            let broken = crate::register::check(&paths, &executable)
                .into_iter()
                .any(|b| b.installed && !b.registered && !b.name.contains('('));
            if !broken {
                continue;
            }
            match crate::register::register(&paths, &executable) {
                Ok(_) => log(&paths, "repaired the browser registration"),
                Err(e) => log(
                    &paths,
                    &format!("the browser registration repair failed: {e}"),
                ),
            }
        }
    });
}

fn watch_program(paths: &Paths) {
    let paths = paths.clone();
    std::thread::spawn(move || {
        let Ok(executable) = crate::paths::executable() else {
            return;
        };
        let stamp = |p: &std::path::Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        let started = stamp(&executable);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(10));
            let now = stamp(&executable);
            // A missing file is an install still in progress: wait for the new one.
            if started.is_some() && now.is_some() && now != started {
                log(
                    &paths,
                    "the Lens program was replaced; restarting on the new one",
                );
                restart_soon(&paths, &executable);
                return;
            }
        }
    });
}

/// Starts `lens restart` from the new binary, detached; it stops this daemon after the reply is out
/// and starts the new one through the service manager.
fn restart_soon(paths: &Paths, executable: &std::path::Path) {
    if RESTARTING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    // A helper started by a service dies with it: systemd stops every process of the unit when
    // this one exits. So the service exits as failed once the reply is out, and systemd
    // (Restart=on-failure) or launchd (KeepAlive unless SuccessfulExit) starts the new program.
    // Only a supervised daemon may exit to restart: launchd on macOS, systemd on Linux (it sets
    // INVOCATION_ID). One from a desktop autostart entry restarts itself like a plain one.
    // launchd names its job in XPC_SERVICE_NAME; a --service daemon started without the plist
    // has no launchd to start it again.
    #[cfg(target_os = "macos")]
    let supervised = std::env::var("XPC_SERVICE_NAME").is_ok_and(|n| n == crate::service::LABEL);
    #[cfg(not(target_os = "macos"))]
    let supervised = std::env::var_os("INVOCATION_ID").is_some();
    if cfg!(unix) && supervised && SERVICE.load(std::sync::atomic::Ordering::SeqCst) {
        log(
            paths,
            "exiting so the service manager starts the new program",
        );
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(2));
            std::process::exit(75);
        });
        return;
    }
    let mut command = std::process::Command::new(executable);
    command
        .args(["restart", "--after", "2"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: Windows ignores it with DETACHED_PROCESS
    }
    if let Err(e) = command.spawn() {
        log(paths, &format!("cannot restart after the update: {e}"));
    }
}

/// Heads the findings a model wrote, so every reader knows they are not the person's own words.
pub const FINDINGS_HEADER: &str =
    "Findings (written by Claude Haiku from the recording; check them):";

/// A model's title as plain text: no Markdown or HTML punctuation.
fn plain(text: &str) -> String {
    text.chars()
        .filter(|c| !"[]()<>!`*_#|\\".contains(*c))
        .collect::<String>()
        .trim()
        .to_string()
}

/// Long page URLs can make even a hundred summaries pass the reply limit: the page ends early
/// (never empty, so a list always moves on), and the next one starts below its last review.
fn fit_page(page: &mut Vec<crate::protocol::ReviewSummary>) {
    let mut size = 0;
    let fits = page
        .iter()
        .take_while(|r| {
            size += serde_json::to_vec(r).map_or(0, |b| b.len()) + 1;
            size <= MAX_REPLY_BYTES / 2
        })
        .count();
    page.truncate(fits.max(1));
}

/// The person's choice of agent for summaries and duplicate checks; None is automatic.
fn summary_agent(store: &Store) -> Option<investigate::Agent> {
    match store.setting("agent.summary").ok().flatten().as_deref() {
        Some("claude") => Some(investigate::Agent::Claude),
        Some("codex") => Some(investigate::Agent::Codex),
        _ => None,
    }
}

/// The edits that trim each session capture to the issue's time range: transcript seconds from
/// the first voice note's start, with a few seconds around them; and the session captures wholly
/// outside that range, which belong to another issue and stay out of this one's task. None of it
/// without the times.
fn issue_edits(
    issue: &investigate::Issue,
    voice_start: Option<i64>,
    captures: &[Capture],
) -> (Vec<(i64, Edits)>, Vec<i64>) {
    let (Some(from), Some(to), Some(start)) = (issue.from_seconds, issue.to_seconds, voice_start)
    else {
        return Default::default();
    };
    let (first, last) = (from.min(to), from.max(to));
    let from = start
        .saturating_add((first * 1000.0) as i64)
        .saturating_sub(3000);
    let to = start
        .saturating_add((last * 1000.0) as i64)
        .saturating_add(3000);
    let mut trimmed = Vec::new();
    let mut outside = Vec::new();
    for c in captures.iter().filter(|c| c.kind == CaptureKind::Session) {
        let mut edits = c.edits.clone();
        edits.trim_start = Some(edits.trim_start.unwrap_or(c.started_at).max(from));
        edits.trim_end = Some(edits.trim_end.unwrap_or(c.created_at).min(to));
        if edits.kept(c.started_at, c.created_at).is_empty() {
            outside.push(c.id);
        } else {
            trimmed.push((c.id, edits));
        }
    }
    // Times that miss every recording are wrong, not another issue's: then all stay whole.
    if trimmed.is_empty() {
        outside.clear();
    }
    (trimmed, outside)
}

/// The findings lines (`- ...`) of the block at the top of the notes, and the rest of the notes.
fn split_findings(notes: &str) -> (Vec<String>, String) {
    let mut lines = notes.lines().peekable();
    let mut found = Vec::new();
    if lines
        .peek()
        .is_some_and(|l| l.trim() == "Findings:" || l.trim() == FINDINGS_HEADER)
    {
        lines.next();
        while let Some(line) = lines.next_if(|l| l.trim_start().starts_with("- ")) {
            found.push(line.trim().to_string());
        }
    }
    (
        found,
        lines.collect::<Vec<_>>().join("\n").trim().to_string(),
    )
}

/// The notes without an earlier findings block at their top.
fn strip_findings(notes: &str) -> String {
    split_findings(notes).1
}

/// One worker transcribes voice notes in order; a GPU runs one model at a time anyway.
fn start_transcription(daemon: Arc<Daemon>) {
    let (queue, jobs) = std::sync::mpsc::channel::<i64>();
    let _ = daemon.speech_queue.set(queue);
    let _ = daemon.me.set(Arc::downgrade(&daemon));
    if let Ok(waiting) = daemon.lock_store().untranscribed_voice_notes() {
        for id in waiting {
            daemon.queue_transcription(id);
        }
    }
    let worker = Arc::downgrade(&daemon);
    std::thread::spawn(move || {
        for id in jobs {
            match worker.upgrade() {
                // A panic stops this note, not the only worker: later notes still go.
                Some(daemon) => {
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        daemon.transcribe(id)
                    }))
                    .is_err()
                    {
                        log(
                            &daemon.paths,
                            &format!("voice note {id}: transcription panicked"),
                        );
                    }
                }
                None => break,
            }
        }
    });
}

/// Checks for updates an hour after start and then daily; installs them when the person allows it.
fn schedule_updates(daemon: Arc<Daemon>) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3600));
        loop {
            let executable = crate::paths::executable();
            let managed = executable
                .as_deref()
                .ok()
                .and_then(crate::update::managed_by);
            if managed.is_none() {
                let automatic = daemon
                    .lock_store()
                    .setting("update.automatic")
                    .ok()
                    .flatten()
                    .as_deref()
                    != Some("false");
                if let Err(e) = daemon.update(automatic) {
                    log(&daemon.paths, &format!("update check: {}", e.message));
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(24 * 3600));
        }
    });
}

fn filing_reply(attempt: &filing::Attempt) -> Filing {
    Filing {
        review: attempt.review,
        task_url: attempt.receipt.as_ref().map(|r| r.task_url.clone()),
        missing_files: attempt
            .receipt
            .as_ref()
            .map_or(attempt.submission.evidence_manifest.len(), |r| {
                r.missing_attachments.len()
            }) as u32,
    }
}

fn remote(message: String) -> ProtocolError {
    ProtocolError::new(ErrorCode::Remote, message)
}

fn bad(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(ErrorCode::BadRequest, message)
}

fn not_found(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(ErrorCode::NotFound, message)
}

fn storage(error: impl std::fmt::Display) -> ProtocolError {
    ProtocolError::new(ErrorCode::Storage, error.to_string())
}

/// `https://Shop.Example.com:443/` becomes `https://shop.example.com`. Paths, queries, fragments,
/// credentials and schemes other than http and https are refused, so an origin means one origin.
pub fn normalize_origin(input: &str) -> Result<String, ProtocolError> {
    let refused = || {
        bad(format!(
            "{input:?} is not an origin such as https://shop.example.com"
        ))
    };
    let url = url::Url::parse(input.trim()).map_err(|_| refused())?;
    let plain = url.path() == "/" && url.query().is_none() && url.fragment().is_none();
    let anonymous = url.username().is_empty() && url.password().is_none();
    if !matches!(url.scheme(), "http" | "https") || !plain || !anonymous || url.host().is_none() {
        return Err(refused());
    }
    Ok(url.origin().ascii_serialization())
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_times_become_trims_around_the_transcript() {
        let capture = Capture {
            id: 3,
            observation: 1,
            created_at: 60_000,
            page_url: String::new(),
            page_title: String::new(),
            mode: CaptureMode::Deep,
            screenshot: BlobRef {
                sha256: "a".repeat(64),
                size: 1,
                media_type: String::new(),
            },
            evidence: BlobRef {
                sha256: "b".repeat(64),
                size: 1,
                media_type: String::new(),
            },
            event_count: 0,
            gap_count: 0,
            annotations: vec![],
            recording: None,
            kind: CaptureKind::Session,
            started_at: 10_000,
            edits: Edits::default(),
            shots: vec![],
        };
        let issue = |from, to| investigate::Issue {
            title: "x".into(),
            findings: vec![],
            tags: vec![],
            from_seconds: from,
            to_seconds: to,
        };
        let edits = issue_edits(
            &issue(Some(20.0), Some(5.0)),
            Some(10_000),
            std::slice::from_ref(&capture),
        )
        .0;
        assert_eq!(edits.len(), 1);
        assert_eq!(
            (edits[0].1.trim_start, edits[0].1.trim_end),
            (Some(12_000), Some(33_000))
        );
        assert_eq!(
            issue_edits(
                &issue(None, Some(5.0)),
                Some(10_000),
                std::slice::from_ref(&capture)
            ),
            Default::default()
        );
        // Far outside every capture: the times are wrong, so all stay whole.
        assert_eq!(
            issue_edits(
                &issue(Some(500.0), Some(600.0)),
                Some(10_000),
                std::slice::from_ref(&capture)
            ),
            Default::default()
        );
        // Another issue's recording stays out of this issue's task.
        let mut later = capture.clone();
        later.id = 2;
        later.started_at = 900_000;
        later.created_at = 960_000;
        let (edits, leave) = issue_edits(
            &issue(Some(20.0), Some(5.0)),
            Some(10_000),
            &[capture, later],
        );
        assert_eq!((edits.len(), leave), (1, vec![2]));
    }

    #[test]
    fn a_page_of_long_urls_ends_before_the_reply_limit() {
        let summary = |id| crate::protocol::ReviewSummary {
            id,
            observation: 1,
            revision: 1,
            created_at: 0,
            page_url: Some(format!("https://a.test/{}", "x".repeat(11 * 1024))),
            title: String::new(),
            captures: 1,
            vibeq_task_id: None,
            vibeq_task_url: None,
        };
        let mut page: Vec<_> = (1..=100).rev().map(summary).collect();
        fit_page(&mut page);
        let bytes = serde_json::to_vec(&page).unwrap().len();
        assert!(
            !page.is_empty() && page.len() < 100 && bytes < MAX_REPLY_BYTES,
            "{bytes}"
        );
        let mut one = vec![summary(1)];
        fit_page(&mut one);
        assert_eq!(one.len(), 1);
    }

    fn daemon() -> (tempfile::TempDir, Daemon) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("lens.sqlite")).unwrap();
        let paths = Paths {
            data: dir.path().to_path_buf(),
            runtime: dir.path().join("run"),
            logs: dir.path().join("logs"),
        };
        let daemon = Daemon::new(store, &paths);
        (dir, daemon)
    }

    fn ask(daemon: &Daemon, json: &str) -> serde_json::Value {
        serde_json::from_slice(&daemon.answer(json.as_bytes(), &mut None).0).unwrap()
    }

    #[test]
    fn invalid_settings_and_browser_migration_preserve_the_saved_default_after_restart() {
        let (dir, daemon) = daemon();
        let send = |tracker: &str, address: &str, only_if_unset: bool| {
            let request = serde_json::json!({"id": 1, "method": "setDestination", "params": {
                "choice": {"tracker": tracker, "address": address}, "onlyIfUnset": only_if_unset
            }});
            ask(&daemon, &request.to_string())
        };
        assert_eq!(
            send("jira", "https://team.atlassian.net", false)["status"],
            "ok"
        );
        assert_eq!(send("github", "invalid", false)["status"], "error");
        assert_eq!(
            send("linear", "", true)["result"]["data"]["choice"]["tracker"],
            "jira"
        );
        let paths = daemon.paths.clone();
        drop(daemon);
        let restarted = Daemon::new(
            Store::open(&dir.path().join("lens.sqlite")).unwrap(),
            &paths,
        );
        let settings = ask(&restarted, r#"{"id":2,"method":"getDestination"}"#);
        assert_eq!(
            settings["result"]["data"]["choice"]["address"],
            "https://team.atlassian.net"
        );
    }

    #[test]
    fn answers_requests_and_reports_bad_ones() {
        let (_dir, daemon) = daemon();
        let created = ask(
            &daemon,
            r#"{"id":7,"method":"createObservation","params":{"title":" Cart total ","url":null}}"#,
        );
        assert_eq!(created["id"], 7);
        assert_eq!(created["status"], "ok");
        assert_eq!(created["result"]["data"]["title"], "Cart total");

        let listed = ask(&daemon, r#"{"id":8,"method":"listObservations"}"#);
        assert_eq!(listed["result"]["data"].as_array().unwrap().len(), 1);

        let empty = ask(
            &daemon,
            r#"{"id":9,"method":"createObservation","params":{"title":"  ","url":null}}"#,
        );
        assert_eq!(empty["error"]["code"], "badRequest");

        let unknown = ask(&daemon, r#"{"id":10,"method":"dropTables"}"#);
        assert_eq!(
            (unknown["id"].as_u64(), unknown["status"].as_str()),
            (Some(10), Some("error"))
        );

        assert!(
            daemon
                .answer(br#"{"id":11,"method":"shutdown"}"#, &mut None)
                .1
        );
        assert!(!daemon.answer(br#"{"id":12,"method":"hello"}"#, &mut None).1);
    }

    #[test]
    fn normalizes_origins_and_refuses_anything_else() {
        assert_eq!(
            normalize_origin(" https://Shop.Example.com:443/ ").unwrap(),
            "https://shop.example.com"
        );
        assert_eq!(
            normalize_origin("http://127.0.0.1:8080").unwrap(),
            "http://127.0.0.1:8080"
        );
        for bad in [
            "shop.example.com",
            "https://a.test/cart",
            "https://a.test/?q=1",
            "https://u:p@a.test",
            "file:///etc",
            "chrome://settings",
        ] {
            assert!(normalize_origin(bad).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn stores_a_capture_and_serves_its_blobs_in_chunks() {
        let (_dir, daemon) = daemon();
        let png = [b"\x89PNG\r\n\x1a\n".as_slice(), &[7u8; 600 * 1024]].concat();
        // The recording arrives first, in chunks, as a blob.
        let events = br#"[{"type":4,"data":{"href":"http://127.0.0.1:4100/cart"},"timestamp":1}]"#;
        let upload = "0b5c4e1e-8d7a-4f0e-9a39-1d2f3c4b5a69";
        let first = ask(&daemon, &serde_json::json!({ "id": 9, "method": "uploadChunk", "params": {
            "upload": upload, "offset": 0, "data": BASE64.encode(&events[..10]), "done": false, "mediaType": "application/json" } }).to_string());
        assert_eq!(first["result"]["data"], serde_json::Value::Null, "{first}");
        let last = ask(&daemon, &serde_json::json!({ "id": 10, "method": "uploadChunk", "params": {
            "upload": upload, "offset": 10, "data": BASE64.encode(&events[10..]), "done": true, "mediaType": "application/json" } }).to_string());
        let recording = last["result"]["data"].clone();
        assert_eq!(recording["size"], events.len(), "{last}");
        let request = serde_json::json!({
            "id": 1, "method": "createCapture", "params": {
                "observation": null, "pageUrl": "http://127.0.0.1:4100/cart", "pageTitle": "Cart",
                "screenshot": BASE64.encode(&png),
                "evidence": { "mode": "deep", "page": null, "gaps": [],
                    "events": [{ "timestamp": 1, "kind": "console", "data": { "level": "error" } }] },
                "recording": recording, "kind": "session", "startedAt": 1
            }
        });
        let reply = ask(&daemon, &request.to_string());
        assert_eq!(reply["status"], "ok", "{reply}");
        let capture = &reply["result"]["data"];
        assert_eq!(
            (capture["eventCount"].as_u64(), capture["mode"].as_str()),
            (Some(1), Some("deep"))
        );

        let sha = capture["screenshot"]["sha256"].as_str().unwrap();
        let mut read = Vec::new();
        while read.len() < png.len() {
            let chunk = ask(
                &daemon,
                &serde_json::json!({ "id": 2, "method": "readBlob",
                "params": { "sha256": sha, "offset": read.len(), "length": 1_000_000 } })
                .to_string(),
            );
            let data = BASE64
                .decode(chunk["result"]["data"]["data"].as_str().unwrap())
                .unwrap();
            assert!(data.len() as u32 <= MAX_BLOB_CHUNK && !data.is_empty());
            read.extend(data);
        }
        assert_eq!(read, png);
        // A large screenshot comes as an uploaded blob instead of base64.
        let mut by_blob = request.clone();
        by_blob["params"]["screenshot"] = "".into();
        by_blob["params"]["screenshotBlob"] = capture["screenshot"].clone();
        let again = ask(&daemon, &by_blob.to_string());
        assert_eq!(
            again["result"]["data"]["screenshot"]["sha256"], sha,
            "{again}"
        );
        by_blob["params"]["screenshotBlob"]["sha256"] = "0".repeat(64).into();
        assert_eq!(ask(&daemon, &by_blob.to_string())["status"], "error");

        // Edits: saved, validated, and returned with the capture.
        let id = capture["id"].as_i64().unwrap();
        let edits = serde_json::json!({ "trimStart": 2, "trimEnd": null, "cuts": [{ "from": 5, "to": 6 }],
            "annotations": [{ "id": "n1", "at": 3, "text": "here", "drawing": [[{ "x": 1.0, "y": 2.0 }]], "elements": [] }] });
        let saved = ask(&daemon, &serde_json::json!({ "id": 3, "method": "saveEdits", "params": { "capture": id, "edits": edits } }).to_string());
        assert_eq!(
            saved["result"]["data"]["edits"]["cuts"][0]["from"], 5,
            "{saved}"
        );
        assert_eq!(saved["result"]["data"]["kind"], "session");
        let everything = serde_json::json!({ "trimStart": null, "trimEnd": null, "cuts": [{ "from": 0, "to": i64::MAX }], "annotations": [] });
        let nothing_left = ask(&daemon, &serde_json::json!({ "id": 5, "method": "saveEdits", "params": { "capture": id, "edits": everything } }).to_string());
        assert_eq!(
            nothing_left["status"], "error",
            "a cut of everything must not mean: share all"
        );
        let backwards = serde_json::json!({ "trimStart": null, "trimEnd": null, "cuts": [{ "from": 6, "to": 5 }], "annotations": [] });
        let refused = ask(&daemon, &serde_json::json!({ "id": 4, "method": "saveEdits", "params": { "capture": id, "edits": backwards } }).to_string());
        assert_eq!(refused["status"], "error");

        let not_png = serde_json::json!({ "id": 3, "method": "createCapture", "params": {
            "observation": null, "pageUrl": "http://a.test/", "pageTitle": "", "screenshot": BASE64.encode(b"GIF89a"),
            "evidence": { "mode": "screenshotOnly", "page": null, "gaps": [], "events": [] }, "recording": null,
            "kind": "moment", "startedAt": 0 } });
        assert_eq!(
            ask(&daemon, &not_png.to_string())["error"]["code"],
            "badRequest"
        );
    }
}
