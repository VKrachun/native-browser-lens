//! The one protocol. Every client (the extension through the shim, the CLI, the MCP server) speaks it
//! to `lensd`. The TypeScript side is generated from these types (`cargo test` writes
//! `extension/src/protocol/`), so the two sides cannot drift without CI failing.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const PROTOCOL_VERSION: u32 = 1;

/// Chrome refuses a host message larger than 1 MiB. Every client gets the same limit, so a reply
/// that works for the CLI also works for the browser.
pub const MAX_REPLY_BYTES: usize = 1024 * 1024;
pub const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Tracker {
    Linear,
    Jira,
    Basecamp,
    Github,
    Clipboard,
    Vibeq,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TaskDestination {
    pub tracker: Tracker,
    pub address: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DestinationSettings {
    pub choice: Option<TaskDestination>,
    pub vibeq_connected: bool,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RequestFrame {
    pub id: u32,
    #[serde(flatten)]
    pub request: Request,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "method", content = "params", rename_all = "camelCase")]
#[ts(export)]
// One message at a time, short lived: boxing large variants would only add indirection.
#[allow(clippy::large_enum_variant)]
pub enum Request {
    Hello,
    CreateObservation {
        title: String,
        url: Option<String>,
    },
    ListObservations,
    GetObservation {
        #[ts(type = "number")]
        id: i64,
    },
    /// Saves the title and notes when `revision` is still current; else a `conflict` error.
    UpdateObservation(ObservationUpdate),
    /// Deletes an observation with its captures, voice notes and reviews. Filed tasks stay in VibeQ.
    DeleteObservation {
        #[ts(type = "number")]
        id: i64,
    },
    /// Moves the chosen findings to a new observation with copies of every capture and voice
    /// note, so unrelated defects become separate tasks. Each side is then edited on its own.
    SplitObservation {
        #[ts(type = "number")]
        observation: i64,
        revision: u32,
        /// Indexes into the findings block at the top of the notes.
        findings: Vec<u32>,
        title: String,
    },
    /// Puts Sirvant, VibeQ's agent, to work on the task this review was filed as.
    StartSirvant {
        #[ts(type = "number")]
        review: i64,
    },
    /// The separate problems the summary model found in an observation's recording.
    ListIssues {
        #[ts(type = "number")]
        observation: i64,
    },
    /// Replaces the observation with one observation per issue, each trimmed to its part of the
    /// recording. The original goes; its files stay, shared by the copies.
    SplitIntoTasks {
        #[ts(type = "number")]
        observation: i64,
        revision: u32,
        issues: Vec<crate::investigate::Issue>,
    },
    /// Open VibeQ tasks that may describe the same problem as this observation.
    FindDuplicates {
        #[ts(type = "number")]
        observation: i64,
    },
    ListProjects,
    /// Creates a project when `id` is null, else replaces that project.
    SaveProject(ProjectInput),
    DeleteProject {
        #[ts(type = "number")]
        id: i64,
    },
    /// Saves a screenshot and its evidence. A null observation starts a new one, titled after the page.
    CreateCapture(NewCapture),
    ListCaptures {
        #[ts(type = "number")]
        observation: i64,
    },
    GetCapture {
        #[ts(type = "number")]
        id: i64,
    },
    /// Replaces the capture's annotations. The screenshot itself never changes.
    SaveAnnotations {
        #[ts(type = "number")]
        capture: i64,
        shapes: Vec<Shape>,
    },
    /// Replaces a recording's edits: the trimmed ends, the cut parts, the notes and drawings.
    SaveEdits {
        #[ts(type = "number")]
        capture: i64,
        edits: Edits,
    },
    /// Freezes what may leave the notebook: chosen captures, rendered with their marks and masks,
    /// at the observation's current revision. The person must confirm they checked the screenshots.
    CreateReview(ReviewRequest),
    ListReviews,
    GetReview {
        #[ts(type = "number")]
        review: i64,
    },
    /// The extension says who it is after it connects, and again when its granted sites change.
    Announce(ClientInfo),
    /// Every setup step, checked against the real state: service, browsers, extensions, sites.
    SetupStatus,
    /// Makes Lens start at login, as `lens service install` does. The daemon restarts under the
    /// service manager, so the extension reconnects.
    InstallService,
    /// Pauses or resumes evidence collection in every browser.
    SetPaused {
        paused: bool,
    },
    /// The update state: this version, the newest known, and whether updates install by themselves.
    GetUpdates,
    SetAutomaticUpdates {
        enabled: bool,
    },
    /// Checks the signed release feed now and installs a newer version; Lens restarts afterwards.
    UpdateNow,
    /// Checks the signed release feed now and installs nothing.
    CheckUpdates,
    /// Which agent CLIs are installed and signed in.
    ListAgents,
    /// The agent for titles, findings, splits and duplicate checks; null is automatic.
    GetSummaryAgent,
    GetDestination,
    SetDestination {
        choice: TaskDestination,
        #[serde(default, rename = "onlyIfUnset")]
        only_if_unset: bool,
    },
    SetSummaryAgent {
        agent: Option<crate::investigate::Agent>,
    },
    /// A draft report from Codex or Claude Code over one frozen review. Nothing is saved.
    Investigate {
        #[ts(type = "number")]
        review: i64,
        agent: crate::investigate::Agent,
    },
    /// Writes a review to a new folder in Downloads.
    ExportReview {
        #[ts(type = "number")]
        review: i64,
    },
    /// Save the frozen diagnostics ZIP, or the MP4 of one reviewed capture, in Downloads.
    ExportAttachment {
        #[ts(type = "number")]
        review: i64,
        #[ts(type = "number | null")]
        capture: Option<i64>,
        #[serde(default, rename = "includeVoice")]
        include_voice: bool,
    },
    /// Stream a reviewed export on this connection. Offset zero starts a new transfer.
    ReadAttachment {
        #[ts(type = "number")]
        review: i64,
        #[ts(type = "number | null")]
        capture: Option<i64>,
        #[ts(type = "number")]
        offset: u64,
        #[serde(default, rename = "includeVoice")]
        include_voice: bool,
    },
    /// An agent asks for the last ten minutes on a site (host, such as app.example.com; every
    /// collected tab when None). The browsers that allow it answer within a few seconds.
    RecentEvidence {
        site: Option<String>,
    },
    /// The extension waits here for an agent's question newer than `after`.
    WaitForAsk {
        #[ts(type = "number")]
        after: u64,
    },
    /// The extension's answer to a question: its collected tabs on that site.
    ProvideEvidence {
        #[ts(type = "number")]
        ask: u64,
        tabs: Vec<crate::live::LiveTab>,
    },
    /// A link that opens the setup wizard once, within two minutes (served on 127.0.0.1).
    SetupPage,
    /// Gives the coding agents here the sirv-lens skill and MCP server (`lens agents connect`).
    ConnectAgents,
    /// Takes them back (`lens agents disconnect`).
    DisconnectAgents,
    /// The coding agent apps installed on this computer that a review can be handed to.
    ListHandoffApps,
    /// Exports the review and opens the app on it, working in `folder` (the project's folder).
    HandOff {
        #[ts(type = "number")]
        review: i64,
        app: crate::handoff::HandoffApp,
        folder: String,
    },
    GetVibeQ,
    /// Saves the VibeQ address; a token, when given, goes to the OS secret store (empty removes it).
    SetVibeQ(VibeQInput),
    ListMembers,
    /// Files a review to VibeQ, or finishes an interrupted filing of it.
    FileReview {
        #[ts(type = "number")]
        review: i64,
        assignee: Option<String>,
    },
    GetFiling {
        #[ts(type = "number")]
        review: i64,
    },
    /// One chunk of a stored blob. Replies stay under 1 MiB, so large blobs take several reads.
    ReadBlob {
        sha256: String,
        #[ts(type = "number")]
        offset: u64,
        length: u32,
    },
    /// Appends one chunk to an upload; the last chunk stores the whole file as a blob. Uploads
    /// carry what does not fit one request: voice recordings, long DOM recordings.
    UploadChunk(UploadChunk),
    /// Adds a recorded voice note to an observation and queues its transcription.
    AddVoiceNote(NewVoiceNote),
    ListVoiceNotes {
        #[ts(type = "number")]
        observation: i64,
    },
    DeleteVoiceNote {
        #[ts(type = "number")]
        id: i64,
    },
    /// Transcribes a voice note again, after it failed.
    RetryVoiceNote {
        #[ts(type = "number")]
        id: i64,
    },
    /// Replaces a voice note's transcript with the person's correction.
    UpdateVoiceNote {
        #[ts(type = "number")]
        id: i64,
        segments: Vec<VoiceSegment>,
    },
    /// A title and findings for an observation, from a small model (Claude Haiku, else Codex).
    /// Nothing is saved; the client applies what it keeps.
    Summarize {
        #[ts(type = "number")]
        observation: i64,
    },
    /// Whether transcription is ready: the speech model, and the engine that runs it.
    SpeechStatus,
    /// Downloads the speech models (once, about 575 MB), then transcribes waiting voice notes.
    InstallSpeech,
    /// Ends the daemon after the reply (updates, tests). The next connection starts a new one.
    Shutdown,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UploadChunk {
    /// A UUID the client chose for this upload.
    pub upload: String,
    /// Where this chunk starts; it must equal the bytes received so far.
    #[ts(type = "number")]
    pub offset: u64,
    /// Base64.
    pub data: String,
    /// The last chunk: the daemon stores the file and replies with its blob.
    pub done: bool,
    pub media_type: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NewVoiceNote {
    #[ts(type = "number")]
    pub observation: i64,
    /// When the recording began, in Unix milliseconds: segment times are relative to it.
    #[ts(type = "number")]
    pub started_at: i64,
    /// A 16 kHz mono 16-bit WAV from UploadChunk.
    pub audio: BlobRef,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VoiceNote {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub observation: i64,
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number")]
    pub duration_ms: i64,
    pub audio: BlobRef,
    pub state: VoiceState,
    pub language: Option<String>,
    pub segments: Vec<VoiceSegment>,
    /// Why the transcription failed, or what it waits for.
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum VoiceState {
    /// Waiting for the speech model or for its turn.
    Waiting,
    Transcribing,
    Done,
    Failed,
}

/// A stretch of speech, in milliseconds from the start of the recording.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VoiceSegment {
    #[ts(type = "number")]
    pub start_ms: i64,
    #[ts(type = "number")]
    pub end_ms: i64,
    pub text: String,
    /// The person corrected what Whisper heard.
    #[serde(default)]
    pub corrected: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SpeechStatus {
    pub model: ModelState,
    /// The engines found next to Lens, best first, such as `GPU (Vulkan)` and `CPU`.
    pub engines: Vec<String>,
    /// The model's name, for the settings page.
    pub model_name: String,
    #[ts(type = "number")]
    pub download_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
#[ts(export)]
pub enum ModelState {
    Missing,
    Downloading {
        #[ts(type = "number")]
        received: u64,
        #[ts(type = "number")]
        total: u64,
    },
    Ready,
    Failed {
        reason: String,
    },
}

/// The transcript shared in a review. Optional MP4 narration uses separate local audio references.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewVoice {
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number")]
    pub duration_ms: i64,
    pub language: Option<String>,
    pub segments: Vec<VoiceSegment>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReplyFrame {
    pub id: u32,
    #[serde(flatten)]
    pub outcome: Outcome,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "camelCase")]
#[ts(export)]
pub enum Outcome {
    Ok { result: Box<Reply> },
    Error { error: ProtocolError },
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
#[ts(export)]
// One message at a time, short lived: boxing large variants would only add indirection.
#[allow(clippy::large_enum_variant)]
pub enum Reply {
    Hello(Hello),
    Observation(Observation),
    Observations(Vec<ObservationSummary>),
    Project(Project),
    Projects(Vec<Project>),
    Deleted,
    Capture(Capture),
    Captures(Vec<Capture>),
    Blob(BlobChunk),
    Review(Review),
    Reviews(Vec<ReviewSummary>),
    Exported(Exported),
    Attachment(String),
    HandoffApps(Vec<crate::handoff::HandoffApp>),
    AgentSetup(Vec<crate::agents::AgentSetup>),
    SetupPage(String),
    Ask(Option<crate::live::Ask>),
    LiveEvidence(Vec<crate::live::LiveDigest>),
    /// The review was handed off; `folder` holds the exported report.
    HandedOff(Exported),
    VibeQ(VibeQSettings),
    Members(Vec<crate::vibeq::Member>),
    Filing(Filing),
    Sirvant(crate::vibeq::SirvantRun),
    Issues(Vec<crate::investigate::Issue>),
    Split(Vec<Observation>),
    Duplicates(Vec<crate::investigate::Duplicate>),
    SummaryAgent(Option<crate::investigate::Agent>),
    Destination(DestinationSettings),
    Agents(Vec<crate::investigate::AgentInfo>),
    Done,
    Setup(Box<SetupStatus>),
    Updates(UpdateState),
    Uploaded(Option<BlobRef>),
    VoiceNote(VoiceNote),
    VoiceNotes(Vec<VoiceNote>),
    Speech(SpeechStatus),
    Suggestion(crate::investigate::Suggestion),
    Summary(crate::investigate::Summary),
    Stopping,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewRequest {
    #[ts(type = "number")]
    pub observation: i64,
    /// The revision the person reviewed; a newer one means they did not see the latest notes.
    pub revision: u32,
    #[ts(type = "Array<number>")]
    pub captures: Vec<i64>,
    /// Captures whose DOM recording leaves too. Masks do not apply to recordings, so each one is
    /// an explicit choice.
    #[ts(type = "Array<number>")]
    pub recordings: Vec<i64>,
    /// Whether the values the person typed leave with the steps. Without it they are masked.
    pub typed_values: bool,
    pub screenshots_checked: bool,
}

/// What a person approved to leave the notebook. Never changes after it is created.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Review {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub observation: i64,
    pub revision: u32,
    #[ts(type = "number")]
    pub created_at: i64,
    pub title: String,
    pub notes: String,
    /// The observation's tags when the review was made.
    #[serde(default)]
    pub tags: Vec<String>,
    pub items: Vec<ReviewItem>,
    /// The person's transcribed voice notes, oldest first.
    #[serde(default)]
    pub voice: Vec<ReviewVoice>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewSummary {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub observation: i64,
    pub revision: u32,
    #[ts(type = "number")]
    pub created_at: i64,
    pub title: String,
    pub captures: u32,
    /// The first capture's page (written by the website: untrusted).
    pub page_url: Option<String>,
    /// The VibeQ task this review was filed as, if it was.
    pub vibeq_task_id: Option<String>,
    pub vibeq_task_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewItem {
    #[ts(type = "number")]
    pub capture: i64,
    pub page_url: String,
    pub page_title: String,
    pub mode: CaptureMode,
    /// The screenshot with its marks drawn and its masks burned in.
    pub screenshot: BlobRef,
    pub evidence: BlobRef,
    pub recording: Option<BlobRef>,
    /// What failed, as the report states it: HTTP errors, failed requests, console errors.
    pub findings: Vec<String>,
    /// What each mark on the screenshot points at, in the order of the marks. Masks are left out.
    #[serde(default)]
    pub marks: Vec<MarkTarget>,
    #[serde(default = "moment")]
    pub kind: CaptureKind,
    /// The parts of the recording that leave, after trims and cuts; empty for a moment capture.
    #[serde(default)]
    pub kept: Vec<TimeRange>,
    /// The person's notes and drawings at moments of the recording.
    #[serde(default)]
    pub annotations: Vec<Annotation>,
    /// What the screen showed, read from the DOM recording: page loads and the result of clicks.
    #[serde(default)]
    pub screen: Vec<ScreenNote>,
    /// Where the pointer rested, inside the kept time.
    #[serde(default)]
    pub pointing: Vec<Pointing>,
    /// The shots that leave: inside the kept time, not removed by the person.
    #[serde(default)]
    pub shots: Vec<Shot>,
    /// Steps and events left out because they fell in a trimmed or cut part.
    #[serde(default)]
    pub cut: u32,
    /// Shots left out so the whole filing fits VibeQ's file limit.
    #[serde(default)]
    pub shots_dropped: u32,
    /// When the capture was saved, in Unix milliseconds.
    #[serde(default)]
    #[ts(type = "number")]
    pub captured_at: i64,
    #[serde(default)]
    #[ts(type = "number")]
    pub started_at: i64,
}

/// Where the pointer rested, from the DOM recording: what "this" meant while the person spoke.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Pointing {
    #[ts(type = "number")]
    pub from: i64,
    #[ts(type = "number")]
    pub to: i64,
    /// The element as a person names it, like `button "Export"`.
    pub label: String,
}

/// The elements the pointer was on between `from` and `to`, longest first, at most `max`.
pub fn pointed_at(track: &[Pointing], from: i64, to: i64, max: usize) -> Vec<String> {
    let mut found: Vec<(i64, &str)> = Vec::new();
    for p in track {
        let overlap = p.to.min(to) - p.from.max(from);
        if overlap <= 0 {
            continue;
        }
        match found.iter_mut().find(|(_, l)| *l == p.label) {
            Some(seen) => seen.0 += overlap,
            None => found.push((overlap, &p.label)),
        }
    }
    found.sort_by_key(|f| std::cmp::Reverse(f.0));
    found
        .into_iter()
        .take(max)
        .map(|(_, l)| l.to_string())
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScreenNote {
    #[ts(type = "number")]
    pub at: i64,
    pub text: String,
    /// Text and labelled controls that appeared, and those that went away (a page load lists
    /// what it showed as appeared).
    #[serde(default)]
    pub appeared: Vec<String>,
    #[serde(default)]
    pub gone: Vec<String>,
    /// After a click, not a page load.
    #[serde(default)]
    pub after_click: bool,
}

fn moment() -> CaptureKind {
    CaptureKind::Moment
}

/// The page elements under one mark.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MarkTarget {
    /// The mark's position among the capture's marks, from 1.
    pub mark: u32,
    /// `rectangle`, `arrow` or `pen`.
    pub kind: String,
    pub elements: Vec<Locator>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpdateState {
    pub current: String,
    /// The newest version the last check found, when it is newer than this one.
    pub available: Option<String>,
    #[ts(type = "number | null")]
    pub checked_at: Option<i64>,
    pub automatic: bool,
    /// A package manager or the Microsoft Store updates this copy instead.
    pub managed_by: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ClientInfo {
    /// chrome, edge, brave, chromium, firefox, or another name the extension detects.
    pub browser: String,
    pub extension_version: String,
    /// A random ID kept in the browser profile, so two profiles count as two clients.
    pub profile: String,
    pub protocol: u32,
    pub granted_origins: Vec<String>,
    /// The extension's ID in this browser: the store's, or the unpacked one. Older extensions do
    /// not send it.
    #[serde(default)]
    pub extension_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ClientSeen {
    pub client: ClientInfo,
    #[ts(type = "number")]
    pub last_seen: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BrowserCheck {
    pub name: String,
    pub installed: bool,
    /// The browser can start this Lens binary for the Lens extension.
    pub registered: bool,
    /// What is wrong, and what fixes it, when it is not registered.
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SetupStatus {
    pub version: String,
    pub protocol: u32,
    pub binary: String,
    /// launchd, systemd, autostart or login item; null when Lens does not start at login.
    pub service: Option<String>,
    pub browsers: Vec<BrowserCheck>,
    /// Extensions that connected, newest first.
    pub extensions: Vec<ClientSeen>,
    pub projects: u32,
    pub captures: u32,
    pub vibeq_configured: bool,
    /// The checklist the terminal and the side panel show, computed here once.
    pub steps: Vec<crate::setup::Step>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VibeQSettings {
    pub endpoint: Option<String>,
    /// Whether a token is saved. The token itself never leaves the daemon.
    pub has_token: bool,
    /// The VibeQ name of the member the saved token belongs to, recorded when it was saved.
    pub account: Option<String>,
    /// The token comes from LENS_VIBEQ_TOKEN, not the secret store.
    pub token_from_environment: bool,
    pub secret_store: SecretStoreStatus,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VibeQInput {
    pub endpoint: String,
    pub token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Filing {
    #[ts(type = "number")]
    pub review: i64,
    /// Null until VibeQ confirmed the task.
    pub task_url: Option<String>,
    /// Files VibeQ does not hold yet; filing the review again uploads them.
    pub missing_files: u32,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Exported {
    pub folder: String,
}

pub const MAX_BLOB_CHUNK: u32 = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Project {
    #[ts(type = "number")]
    pub id: i64,
    pub name: String,
    /// Exact origins such as `https://shop.example.com`. Evidence is collected only on these.
    pub origins: Vec<String>,
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectInput {
    #[ts(type = "number | null")]
    pub id: Option<i64>,
    pub name: String,
    pub origins: Vec<String>,
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NewCapture {
    #[ts(type = "number | null")]
    pub observation: Option<i64>,
    pub page_url: String,
    pub page_title: String,
    /// PNG bytes, base64.
    pub screenshot: String,
    pub evidence: Evidence,
    /// The rrweb events (a JSON array) from UploadChunk, when the tab was recorded.
    pub recording: Option<BlobRef>,
    pub kind: CaptureKind,
    /// Where the recording and the evidence begin, in Unix milliseconds.
    #[ts(type = "number")]
    pub started_at: i64,
    /// Screenshots taken during the recording, after the person's steps.
    #[serde(default)]
    pub shots: Vec<Shot>,
}

/// A real screenshot of the tab, taken while it was recorded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Shot {
    #[ts(type = "number")]
    pub at: i64,
    /// WebP from UploadChunk.
    pub image: BlobRef,
    /// `step`: after a click or a key; `end`: the screenshot at Stop or Capture.
    pub reason: String,
}

pub const MAX_SHOTS: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CaptureKind {
    /// Capture mode: the last minutes before the person pressed Capture.
    Moment,
    /// Record mode: from Record to Stop.
    Session,
}

/// What the person changed in a recording before sharing it. Times are Unix milliseconds.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct Edits {
    #[ts(type = "number | null")]
    pub trim_start: Option<i64>,
    #[ts(type = "number | null")]
    pub trim_end: Option<i64>,
    /// Parts cut out of the recording; what happened there does not leave.
    pub cuts: Vec<TimeRange>,
    pub annotations: Vec<Annotation>,
    /// Shots the person removed, by their time.
    #[ts(type = "Array<number>")]
    pub hidden_shots: Vec<i64>,
    /// Parts of shots the person blacked out, burned in before a shot leaves.
    pub shot_masks: Vec<ShotMask>,
}

/// Black boxes over one shot, as fractions (0 to 1) of its width and height.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShotMask {
    /// The shot's time.
    #[ts(type = "number")]
    pub at: i64,
    pub areas: Vec<Area>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TimeRange {
    #[ts(type = "number")]
    pub from: i64,
    #[ts(type = "number")]
    pub to: i64,
}

/// A note at a moment of the recording, with an optional drawing over the page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Annotation {
    pub id: String,
    #[ts(type = "number")]
    pub at: i64,
    pub text: String,
    /// Strokes in CSS pixels of the recorded page's viewport.
    pub drawing: Vec<Vec<Point>>,
    /// The page elements under the drawing, for an agent.
    pub elements: Vec<Locator>,
}

pub const MAX_ANNOTATIONS: usize = 200;
pub const MAX_STROKE_POINTS: usize = 2000;

impl Edits {
    /// Bounded and finite, so stored edits always load and render.
    pub fn validate(&self) -> Result<(), String> {
        if self.annotations.len() > MAX_ANNOTATIONS || self.cuts.len() > MAX_ANNOTATIONS {
            return Err(format!(
                "a recording keeps at most {MAX_ANNOTATIONS} notes and cuts"
            ));
        }
        for a in &self.annotations {
            if a.text.len() > 4000 || a.id.len() > 64 || a.elements.len() > 20 {
                return Err("a note is too long".into());
            }
            let points: usize = a.drawing.iter().map(Vec::len).sum();
            if points > MAX_STROKE_POINTS
                || a.drawing
                    .iter()
                    .flatten()
                    .any(|p| !p.x.is_finite() || !p.y.is_finite())
            {
                return Err("a drawing is too large or not finite".into());
            }
        }
        if self.cuts.iter().any(|c| c.to < c.from) {
            return Err("a cut ends before it starts".into());
        }
        if self.shot_masks.len() > MAX_SHOTS
            || self.shot_masks.iter().any(|m| {
                m.areas.len() > MAX_ANNOTATIONS
                    || m.areas
                        .iter()
                        .any(|a| ![a.x, a.y, a.width, a.height].iter().all(|v| v.is_finite()))
            })
        {
            return Err("too many masks, or a mask that is not finite".into());
        }
        Ok(())
    }

    /// The time ranges that stay, inside `[start, end]`: the trimmed span minus the cuts.
    pub fn kept(&self, start: i64, end: i64) -> Vec<TimeRange> {
        let from = self.trim_start.unwrap_or(start).max(start);
        let to = self.trim_end.unwrap_or(end).min(end);
        let mut cuts = self.cuts.clone();
        cuts.sort_by_key(|c| c.from);
        let mut kept = Vec::new();
        let mut cursor = from;
        for cut in cuts {
            // A cut of no length removes nothing; it must not split the range in two.
            if cut.to <= cut.from || cut.to <= cursor || cut.from >= to {
                continue;
            }
            if cut.from > cursor {
                kept.push(TimeRange {
                    from: cursor,
                    to: cut.from,
                });
            }
            cursor = cursor.max(cut.to);
        }
        if cursor < to {
            kept.push(TimeRange { from: cursor, to });
        }
        kept
    }
}

/// What the collector saw before the capture, and what it could not see.
#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Evidence {
    pub mode: CaptureMode,
    pub events: Vec<EvidenceEvent>,
    pub gaps: Vec<CoverageGap>,
    pub page: Option<serde_json::Value>,
    /// What the person did in the tab, oldest first.
    #[serde(default)]
    pub actions: Vec<Action>,
    /// The visible elements at the moment of the capture, so marks can name what they point at.
    /// Reviews leave this list out.
    #[serde(default)]
    pub elements: Vec<PageElement>,
    /// What the collector left out on purpose, by reason (analytics, beacon, inline data).
    #[serde(default)]
    #[ts(type = "Record<string, number>")]
    pub dropped: std::collections::BTreeMap<String, u32>,
}

/// One thing the person did, with a locator a test runner can find again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Action {
    #[ts(type = "number")]
    pub timestamp: i64,
    pub kind: ActionKind,
    /// The page URL when it happened, redacted.
    pub url: String,
    pub target: Option<Locator>,
    /// The typed text, the chosen option, the key (`Enter`, `Control+k`) or the scroll offset.
    pub value: Option<String>,
    /// The person typed here, but the value stays on this computer: a password, a card number,
    /// a field with a sensitive name, or a review without typed values.
    pub masked: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ActionKind {
    Click,
    Fill,
    Press,
    Select,
    Check,
    Uncheck,
    Upload,
    Scroll,
    Navigate,
}

/// Ways to find an element again, best first: test ID, role and accessible name, text, CSS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Locator {
    pub test_id: Option<String>,
    pub role: Option<String>,
    pub name: Option<String>,
    /// Which match it is, from 0, when the role and name match more than one element.
    pub nth: Option<u32>,
    pub text: Option<String>,
    pub css: String,
}

/// An element on screen at the moment of the capture, in CSS pixels of the viewport.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PageElement {
    pub locator: Locator,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CaptureMode {
    /// Chromium `debugger`: network with bodies, console, exceptions.
    Deep,
    /// `webRequest` metadata only (Firefox, or when the debugger is refused).
    Limited,
    /// No collector on this tab: the screenshot alone.
    ScreenshotOnly,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EvidenceEvent {
    #[ts(type = "number")]
    pub timestamp: i64,
    pub kind: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CoverageGap {
    pub channel: String,
    pub reason: String,
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number | null")]
    pub ended_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Capture {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub observation: i64,
    #[ts(type = "number")]
    pub created_at: i64,
    pub page_url: String,
    pub page_title: String,
    pub mode: CaptureMode,
    pub screenshot: BlobRef,
    /// The full `Evidence` as JSON.
    pub evidence: BlobRef,
    pub event_count: u32,
    pub gap_count: u32,
    pub annotations: Vec<Shape>,
    /// rrweb events as a JSON array.
    pub recording: Option<BlobRef>,
    pub kind: CaptureKind,
    #[ts(type = "number")]
    pub started_at: i64,
    pub edits: Edits,
    pub shots: Vec<Shot>,
}

/// A mark on a screenshot, in the screenshot's own pixels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum Shape {
    Rectangle {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        color: String,
    },
    Arrow {
        from: Point,
        to: Point,
        color: String,
    },
    Pen {
        points: Vec<Point>,
        color: String,
    },
    /// Hides what is under it in every export; the stored screenshot keeps the pixels.
    Mask {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

pub const MAX_SHAPES: usize = 500;
pub const MAX_PEN_POINTS: usize = 5000;

impl Shape {
    /// Finite coordinates, `#rrggbb` colors and bounded sizes, so a stored shape always renders.
    pub fn validate(&self) -> Result<(), String> {
        let color_ok = |c: &str| {
            c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|b| b.is_ascii_hexdigit())
        };
        let finite = |values: &[f64]| values.iter().all(|v| v.is_finite());
        let (numbers, color): (Vec<f64>, Option<&str>) = match self {
            Shape::Rectangle {
                x,
                y,
                width,
                height,
                color,
            } => (vec![*x, *y, *width, *height], Some(color)),
            Shape::Mask {
                x,
                y,
                width,
                height,
            } => (vec![*x, *y, *width, *height], None),
            Shape::Arrow { from, to, color } => (vec![from.x, from.y, to.x, to.y], Some(color)),
            Shape::Pen { points, color } => {
                if points.len() > MAX_PEN_POINTS {
                    return Err(format!(
                        "a pen stroke has more than {MAX_PEN_POINTS} points"
                    ));
                }
                (
                    points.iter().flat_map(|p| [p.x, p.y]).collect(),
                    Some(color),
                )
            }
        };
        if !finite(&numbers) {
            return Err("a shape has a coordinate that is not a finite number".into());
        }
        match color {
            Some(c) if !color_ok(c) => Err(format!("{c:?} is not a #rrggbb color")),
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BlobRef {
    pub sha256: String,
    #[ts(type = "number")]
    pub size: u64,
    pub media_type: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BlobChunk {
    /// Base64.
    pub data: String,
    #[ts(type = "number")]
    pub total_size: u64,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Hello {
    pub version: String,
    pub protocol: u32,
    pub data_dir: String,
    pub secret_store: SecretStoreStatus,
    /// Collection is paused from the Lens menu: no tab collects until it resumes.
    pub paused: bool,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
#[ts(export)]
pub enum SecretStoreStatus {
    Available,
    Unavailable { reason: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Observation {
    #[ts(type = "number")]
    pub id: i64,
    pub title: String,
    pub url: Option<String>,
    pub notes: String,
    /// Grows by one with every saved edit; an update must name the revision it started from.
    pub revision: u32,
    /// Short labels for the VibeQ task, such as `assets` or `bug`; see `clean_tags`.
    pub tags: Vec<String>,
    /// Milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
}

/// An observation in a list: no notes, so long notebooks stay under the reply limit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ObservationSummary {
    #[ts(type = "number")]
    pub id: i64,
    pub title: String,
    pub url: Option<String>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    pub capture_count: u32,
    /// Session when it holds a Record mode recording.
    pub kind: CaptureKind,
    /// The length of its recordings, in milliseconds.
    #[ts(type = "number")]
    pub duration_ms: i64,
    pub voice_count: u32,
    pub status: ObservationStatus,
    /// The newest capture's screenshot, for a thumbnail.
    pub thumbnail: Option<BlobRef>,
    /// The first finding, or the first line of the notes.
    pub headline: Option<String>,
    /// The VibeQ task of the newest filed review.
    pub task_url: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ObservationStatus {
    Draft,
    Reviewed,
    /// VibeQ confirmed a task for one of its reviews.
    Filed,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ObservationUpdate {
    #[ts(type = "number")]
    pub id: i64,
    pub revision: u32,
    pub title: String,
    pub notes: String,
    /// Left out (or null), the tags stay as they are.
    #[serde(default)]
    #[ts(optional)]
    pub tags: Option<Vec<String>>,
}

/// Tags as VibeQ keeps them: lowercase, words joined by `-`, at most 32 characters, eight tags,
/// each once. Anything else is dropped, so a model or a typo cannot add odd labels.
pub fn clean_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let words: Vec<String> = tag
            .to_lowercase()
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == ':'))
            .filter(|w| !w.is_empty())
            .map(String::from)
            .collect();
        let tag: String = words.join("-").chars().take(32).collect();
        let tag = tag.trim_matches('-').to_string();
        if !tag.is_empty() && !out.contains(&tag) && out.len() < 8 {
            out.push(tag);
        }
    }
    out
}

pub const MAX_NOTES_BYTES: usize = 256 * 1024;

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ErrorCode {
    BadRequest,
    NotFound,
    /// The record changed since the client read it; read it again.
    Conflict,
    /// VibeQ or the network failed; the message says whether a retry is safe.
    Remote,
    TooLarge,
    Storage,
    Internal,
}

impl ProtocolError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Edits, TimeRange};

    #[test]
    fn tags_are_cleaned() {
        let raw = [
            "AI Tools",
            "ai-tools",
            " Bug!! ",
            "",
            "x".repeat(40).as_str(),
            "a/b",
        ]
        .map(String::from);
        assert_eq!(
            super::clean_tags(&raw),
            ["ai-tools", "bug", &"x".repeat(32), "a-b"]
        );
    }

    #[test]
    fn trims_and_cuts_leave_the_kept_ranges() {
        let r = |from, to| TimeRange { from, to };
        let edits = Edits {
            trim_start: Some(10),
            trim_end: Some(90),
            cuts: vec![r(40, 50), r(0, 15), r(85, 120)],
            ..Edits::default()
        };
        assert_eq!(edits.kept(0, 100), [r(15, 40), r(50, 85)]);
        assert_eq!(Edits::default().kept(0, 100), [r(0, 100)]);
    }

    #[test]
    fn the_extension_speaks_this_protocol_version() {
        let client = include_str!("../extension/src/lens-client.ts");
        let line = format!(
            "export const PROTOCOL_VERSION = {};",
            super::PROTOCOL_VERSION
        );
        assert!(
            client.contains(&line),
            "extension/src/lens-client.ts must say: {line}"
        );
    }
}
