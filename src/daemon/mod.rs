//! `lensd`: the one process per user that owns the notebook. Every client talks to it; nothing else
//! opens the database.
mod capture;
mod lifecycle;
mod observations;
mod review;
mod settings;
mod tasks;
#[cfg(test)]
mod tests;
mod voice;

use crate::blobs::Blobs;
use crate::framing::{read_frame, write_frame};
use crate::paths::Paths;
use crate::protocol::*;
use crate::store::{CaptureRow, Store, Updated, pending_pictures};
use crate::vibeq::{self, Client};
use crate::{export, filing, handoff, investigate, ipc, render, repro, secrets, speech};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use interprocess::local_socket::{Stream, prelude::*};
use std::collections::BTreeMap;
use std::fs::{File, TryLockError};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use lifecycle::*;
use observations::*;
use review::*;
use settings::*;
use tasks::*;
use voice::*;

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
    /// The stop flag of the speech model download in progress; each download gets its own.
    speech_cancel: Mutex<Arc<std::sync::atomic::AtomicBool>>,
    /// The replay tools install in progress, or how the last one ended.
    video_install: Mutex<VideoInstall>,
}

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
    // The browser never starts a quit Lens, so this start is the person's (or the login's).
    let _ = std::fs::remove_file(paths.quit_marker());
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
            daemon.apply_retention();
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
                    if let Err(e) = serve(daemon, stream) {
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

/// Attachment downloads in progress on one connection, by review and capture: a page can read a
/// ZIP and an MP4 at the same time.
type Transfers = Mutex<std::collections::HashMap<(i64, Option<i64>), crate::attachments::Transfer>>;

/// Requests that wait on a model, the network, a render or another program. Each runs on a thread
/// of its own, so the page's other requests (a notes save, a status) do not wait behind it: one
/// connection serves a whole page. Every other request keeps its order on the connection.
fn slow(request: &Request) -> bool {
    matches!(
        request,
        Request::Investigate { .. }
            | Request::Summarize { .. }
            | Request::FindDuplicates { .. }
            | Request::FileReview { .. }
            | Request::StartSirvant { .. }
            | Request::ListMembers
            | Request::GetVibeQ
            | Request::ListAgents
            | Request::ConnectAgents
            | Request::DisconnectAgents
            | Request::ExportReview { .. }
            | Request::ExportAttachment { .. }
            | Request::ReadAttachment { .. }
            | Request::HandOff { .. }
            | Request::WaitForAsk { .. }
            | Request::CheckUpdates
            | Request::UpdateNow
            | Request::CreateCapture(_)
            | Request::CreateReview(_)
            | Request::GetStorage
            | Request::PruneStorage { .. }
            | Request::SetRetention { .. }
    )
}

/// Slow requests and updates under way: a stop waits for them, so it does not end an install or a
/// filing halfway.
static BUSY: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

struct Busy;

impl Busy {
    fn start() -> Self {
        BUSY.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Busy
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Waits until no slow work runs, at most `limit`.
fn wait_until_idle(limit: std::time::Duration) {
    let deadline = std::time::Instant::now() + limit;
    while BUSY.load(std::sync::atomic::Ordering::SeqCst) > 0 && std::time::Instant::now() < deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

fn serve(daemon: Arc<Daemon>, stream: Stream) -> std::io::Result<()> {
    let stream = Arc::new(stream);
    // Replies leave one whole frame at a time: from this loop and from the slow requests' threads.
    let sending = Arc::new(Mutex::new(()));
    let transfers = Arc::new(Transfers::default());
    while let Some(frame) = read_frame(&mut &*stream, MAX_REQUEST_BYTES)? {
        match serde_json::from_slice::<RequestFrame>(&frame) {
            Ok(request) if slow(&request.request) => {
                let (daemon, stream, sending, transfers) = (
                    daemon.clone(),
                    stream.clone(),
                    sending.clone(),
                    transfers.clone(),
                );
                // A browser's wait for an agent's question changes nothing: a stop need not wait.
                let busy =
                    (!matches!(request.request, Request::WaitForAsk { .. })).then(Busy::start);
                std::thread::spawn(move || {
                    let _busy = busy;
                    let (reply, _) = daemon.answer_parsed(Ok(request), &frame, &transfers);
                    let _one = sending.lock().unwrap_or_else(|e| e.into_inner());
                    // The page may be gone by now: nothing waits for this reply then.
                    let _ = write_frame(&mut &*stream, &reply);
                });
            }
            parsed => {
                let (reply, stop) = daemon.answer_parsed(parsed, &frame, &transfers);
                {
                    let _one = sending.lock().unwrap_or_else(|e| e.into_inner());
                    write_frame(&mut &*stream, &reply)?;
                }
                if stop {
                    wait_until_idle(std::time::Duration::from_secs(10));
                    std::process::exit(0);
                }
            }
        }
    }
    Ok(())
}

impl Daemon {
    /// One request frame in, one reply frame out, and whether the daemon stops after sending it.
    /// Never fails: a broken request gets an error reply.
    #[cfg(test)]
    fn answer(&self, frame: &[u8], transfers: &Transfers) -> (Vec<u8>, bool) {
        self.answer_parsed(serde_json::from_slice(frame), frame, transfers)
    }

    /// `answer` for a frame already parsed (`parsed`), which the connection reads to choose a thread.
    fn answer_parsed(
        &self,
        parsed: Result<RequestFrame, serde_json::Error>,
        frame: &[u8],
        transfers: &Transfers,
    ) -> (Vec<u8>, bool) {
        let mut stop = false;
        let reply = match parsed {
            Ok(request) => {
                stop = matches!(request.request, Request::Shutdown);
                ReplyFrame {
                    id: request.id,
                    outcome: self.handle_with_transfer(request.request, transfers),
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
            speech_cancel: Mutex::default(),
            video_install: Mutex::new(VideoInstall::default()),
        }
    }

    pub(crate) fn handle(&self, request: Request) -> Outcome {
        self.handle_with_transfer(request, &Transfers::default())
    }

    fn handle_with_transfer(&self, request: Request, transfers: &Transfers) -> Outcome {
        match self.reply(request, transfers) {
            Ok(result) => Outcome::Ok {
                result: Box::new(result),
            },
            Err(error) => Outcome::Error { error },
        }
    }

    fn reply(&self, request: Request, transfers: &Transfers) -> Result<Reply, ProtocolError> {
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
            } => self.split_observation(&mut store, observation, revision, findings, title)?,
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
                // Rendering takes seconds: other requests must not wait on the store meanwhile.
                drop(store);
                self.create_capture(capture)?
            }
            Request::ListCaptures { observation } => {
                let captures = store.list_captures(observation).map_err(storage)?;
                // The review page opens: pictures that waited for the replay tools are made now.
                for capture in &captures {
                    if store
                        .setting(&pending_pictures(capture.id))
                        .map_err(storage)?
                        .is_some()
                    {
                        self.render_pending_soon(capture.id);
                    }
                }
                Reply::Captures(captures)
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
            Request::CreateReview(request) => self.create_review(store, request)?,
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
            Request::SetupStatus => Reply::Setup(Box::new(
                crate::setup::setup_status(&self.paths, Some(&store)).map_err(storage)?,
            )),
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
                        .map(investigate::info)
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
            } => self.read_attachment(store, review, capture, offset, include_voice, transfers)?,
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
            } => self.hand_off(store, review, app, folder)?,
            Request::GetVibeQ => Reply::VibeQ(vibeq_settings(&store)?),
            Request::SetVibeQ(input) => self.set_vibeq(store, input)?,
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
                self.file_review(store, review, assignee)?
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
            } => self.split_into_tasks(&mut store, observation, revision, issues)?,
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
            Request::StartSirvant { review } => self.start_sirvant(store, review)?,
            Request::UploadChunk(chunk) => {
                drop(store);
                Reply::Uploaded(self.upload(chunk)?)
            }
            Request::AddVoiceNote(note) => self.add_voice_note(&store, note)?,
            Request::ListVoiceNotes { observation } => {
                Reply::VoiceNotes(store.list_voice_notes(observation).map_err(storage)?)
            }
            Request::RetryVoiceNote { id } => self.retry_voice_note(store, id)?,
            Request::DeleteVoiceNote { id } => {
                if !store.delete_voice_note(id).map_err(storage)? {
                    return Err(not_found("no such voice note"));
                }
                Reply::Deleted
            }
            Request::UpdateVoiceNote { id, segments } => {
                self.update_voice_note(&store, id, segments)?
            }
            Request::Summarize { observation } => {
                drop(store);
                Reply::Summary(self.summary(observation)?.0)
            }
            Request::SpeechStatus => {
                drop(store);
                Reply::Speech(self.speech_status()?)
            }
            Request::InstallSpeech => {
                drop(store);
                self.install_speech()?;
                Reply::Speech(self.speech_status()?)
            }
            Request::CancelSpeechDownload => {
                drop(store);
                self.cancel_speech_download();
                Reply::Speech(self.speech_status()?)
            }
            Request::GetSpeechSettings => Reply::SpeechSettings(speech_settings(&store)?),
            Request::SetSpeechSettings(settings) => {
                Reply::SpeechSettings(set_speech_settings(&store, settings)?)
            }
            Request::GetVideoTools => {
                drop(store);
                Reply::VideoTools(self.video_tools())
            }
            Request::InstallVideoTools => {
                drop(store);
                self.install_video_tools();
                Reply::VideoTools(self.video_tools())
            }
            Request::GetStorage => {
                drop(store);
                Reply::Storage(self.storage_usage()?)
            }
            Request::PruneStorage {
                older_than_days,
                filed_only,
            } => {
                drop(store);
                Reply::Pruned(self.prune(older_than_days, filed_only)?)
            }
            Request::SetRetention { days, filed_only } => {
                set_retention(&store, days, filed_only)?;
                drop(store);
                Reply::Storage(self.storage_usage()?)
            }
            Request::GetPrivacySettings => Reply::PrivacySettings(privacy_settings(&store)?),
            Request::SetPrivacySettings(settings) => {
                Reply::PrivacySettings(set_privacy_settings(&store, settings)?)
            }
            Request::GetFindingsSettings => Reply::FindingsSettings(findings_settings(&store)?),
            Request::SetFindingsSettings(settings) => {
                Reply::FindingsSettings(set_findings_settings(&store, settings)?)
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

    fn me(&self) -> Option<Arc<Daemon>> {
        self.me.get().and_then(std::sync::Weak::upgrade)
    }

    fn lock_store(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
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
