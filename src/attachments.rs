//! Files the person can attach to a tracker draft. All inputs come from an immutable review.
use crate::{blobs::Blobs, export, protocol::Review};
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use zip::{ZipWriter, write::SimpleFileOptions};

/// Private references in a stored review. They are never part of the shared Review.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct VoiceSource {
    pub start: i64,
    pub duration: i64,
    pub sha256: String,
}

impl From<crate::protocol::VoiceNote> for VoiceSource {
    fn from(note: crate::protocol::VoiceNote) -> Self {
        Self {
            start: note.started_at,
            duration: note.duration_ms,
            sha256: note.audio.sha256,
        }
    }
}

pub fn save(
    review: &Review,
    capture: Option<i64>,
    blobs: &Blobs,
    voice: &[VoiceSource],
    downloads: &Path,
    tools: &Path,
) -> io::Result<PathBuf> {
    fs::create_dir_all(downloads)?;
    // The raw recording, voice and export folder never go to Downloads: they wait in the data
    // folder, which the daemon empties at start (an update can end it in the middle of a render).
    // Only the finished file is moved there, from a temporary file beside it.
    let work = tools.with_file_name("attachments");
    fs::create_dir_all(&work)?;
    let staging = private_dir(&work)?;
    let file = tempfile::Builder::new()
        .prefix(".lens-")
        .suffix(".part")
        .tempfile_in(downloads)?;
    let (name, extension) =
        match capture {
            None => {
                let folder = export::export(review, blobs, staging.path())?;
                let mut zip = ZipWriter::new(file.reopen()?);
                for entry in fs::read_dir(folder)? {
                    let entry = entry?;
                    zip.start_file(
                        entry.file_name().to_string_lossy(),
                        SimpleFileOptions::default(),
                    )?;
                    io::copy(&mut fs::File::open(entry.path())?, &mut zip)?;
                }
                zip.finish()?;
                (format!("lens-review-{}-evidence", review.id), "zip")
            }
            Some(id) => {
                let item = review
                    .items
                    .iter()
                    .find(|item| item.capture == id)
                    .ok_or_else(|| io::Error::other("Capture is not part of this review."))?;
                let recording = item
                    .recording
                    .as_ref()
                    .ok_or_else(|| io::Error::other("No reviewed replay for this capture."))?;
                let source = staging.path().join("recording.json");
                fs::write(&source, blobs.read_all(&recording.sha256)?)?;
                let ranges = staging.path().join("kept.json");
                let tracks = voice.iter().map(|v| Ok::<_, io::Error>(serde_json::json!({
                "start": v.start, "duration": v.duration, "path": blobs.file(&v.sha256)?,
            }))).collect::<io::Result<Vec<_>>>()?;
                fs::write(
                    &ranges,
                    serde_json::to_vec(&serde_json::json!({ "kept": item.kept, "voice": tracks }))?,
                )?;
                let script = staging.path().join("render.cjs");
                fs::write(&script, include_bytes!("review-video.cjs"))?;
                let node = crate::investigate::program("node")
                    .ok_or_else(|| io::Error::other("Install Node.js to render MP4 files."))?;
                let mut command = Command::new(&node);
                command
                    .env("PATH", crate::investigate::path_for(&node))
                    .arg(script)
                    .arg(tools)
                    .arg(source)
                    .arg(ranges)
                    .arg(file.path());
                if let Some(ffmpeg) = ffmpeg() {
                    command.env("LENS_FFMPEG", ffmpeg);
                }
                render(command, staging.path(), Duration::from_secs(20 * 60))?;
                (format!("lens-review-{}-capture-{id}", review.id), "mp4")
            }
        };
    // A retry or a concurrent export must never replace an existing attachment.
    let mut pending = file;
    for n in 1.. {
        let stem = if n == 1 {
            name.clone()
        } else {
            format!("{name}-{n}")
        };
        let target = downloads.join(format!("{stem}.{extension}"));
        match pending.persist_noclobber(&target) {
            Ok(_) => return Ok(target),
            Err(err) if err.error.kind() == io::ErrorKind::AlreadyExists => pending = err.file,
            Err(err) => return Err(err.error),
        }
    }
    unreachable!()
}

/// A folder only this account can read.
fn private_dir(parent: &Path) -> io::Result<tempfile::TempDir> {
    let mut builder = tempfile::Builder::new();
    builder.prefix("lens-attachment-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o700));
    }
    builder.tempdir_in(parent)
}

/// Whether the optional replay tools (Node.js, playwright-core, rrweb-player) are installed.
pub fn tools_ready(tools: &Path) -> bool {
    packages_installed(tools) && crate::investigate::program("node").is_some()
}

fn packages_installed(tools: &Path) -> bool {
    tools.join("node_modules/playwright-core").is_dir()
        && tools.join("node_modules/rrweb-player").is_dir()
}

/// The FFmpeg for MP4 files: `LENS_FFMPEG`, or the one on the search path.
fn ffmpeg() -> Option<PathBuf> {
    std::env::var_os("LENS_FFMPEG")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(|| crate::investigate::program("ffmpeg"))
}

/// The versions `lens video-tools install` puts in the tools folder.
const PACKAGES: [&str; 2] = ["playwright-core@1.65.0", "rrweb-player@2.2.2"];

/// What MP4 export needs, for the settings page and `lens video-tools`. `ready`: an MP4 export
/// can run. `detail` says what to do first when it cannot.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoToolsCheck {
    pub ready: bool,
    pub node: bool,
    pub ffmpeg: bool,
    pub detail: Option<String>,
}

pub fn check_video_tools(tools: &Path) -> VideoToolsCheck {
    let node = crate::investigate::program("node").is_some();
    let ffmpeg = ffmpeg().is_some();
    let packages = packages_installed(tools);
    VideoToolsCheck {
        ready: node && ffmpeg && packages,
        node,
        ffmpeg,
        detail: video_tools_detail(node, ffmpeg, packages),
    }
}

/// The first thing to fix: the installer needs Node.js, and it cannot install FFmpeg.
fn video_tools_detail(node: bool, ffmpeg: bool, packages: bool) -> Option<String> {
    let text = if !node {
        "Install Node.js from https://nodejs.org, then install the video tools with `lens video-tools install` or in Settings → Video export."
    } else if !packages {
        "Install the video tools with `lens video-tools install` or in Settings → Video export."
    } else if !ffmpeg {
        "Install FFmpeg (https://ffmpeg.org) to save MP4 files. Pictures from a replay work without it."
    } else {
        return None;
    };
    Some(text.into())
}

/// Installs playwright-core, rrweb-player and Playwright's Chromium into `tools` with the
/// Node.js and npm on this computer. `on_progress` hears each step. FFmpeg is not installed.
pub fn install_video_tools(tools: &Path, on_progress: impl Fn(&str)) -> Result<(), String> {
    use crate::investigate::{path_for, program};
    let missing = "Install Node.js with npm from https://nodejs.org, then try again.";
    let node = program("node").ok_or(missing)?;
    let npm = program("npm").ok_or(missing)?;
    fs::create_dir_all(tools).map_err(|e| format!("{}: {e}", tools.display()))?;
    let work = tools.with_file_name("attachments");
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let logs = private_dir(&work).map_err(|e| e.to_string())?;
    // The last lines of a failed step: npm and Playwright put the cause at the end.
    let tail = |e: io::Error| {
        let text = e.to_string();
        let lines: Vec<&str> = text.lines().collect();
        lines[lines.len().saturating_sub(15)..].join("\n")
    };

    on_progress("Installing Playwright & rrweb-player…");
    // npm's own .cmd file on Windows: Rust runs it through cmd.exe with safe quoting.
    let mut install = crate::investigate::command(&npm);
    install
        .env("PATH", path_for(&node))
        .args(["install", "--prefix"])
        .arg(tools)
        .args(PACKAGES)
        .args(["--no-audit", "--no-fund"]);
    run_logged(
        install,
        &logs.path().join("npm.log"),
        Duration::from_secs(15 * 60),
        "npm install",
    )
    .map_err(|e| format!("npm install failed: {}", tail(e)))?;

    on_progress("Downloading Chromium…");
    // The package's own script, run by node: no .bin shim, so no .cmd file on Windows.
    let mut chromium = Command::new(&node);
    chromium
        .env("PATH", path_for(&node))
        .arg(tools.join("node_modules/playwright-core/cli.js"))
        .args(["install", "chromium"]);
    run_logged(
        chromium,
        &logs.path().join("chromium.log"),
        Duration::from_secs(20 * 60),
        "The Chromium download",
    )
    .map_err(|e| format!("The Chromium download failed: {}", tail(e)))?;

    on_progress("Verifying installation…");
    if !tools_ready(tools) {
        return Err(format!(
            "npm finished, but {} has no playwright-core or rrweb-player.",
            tools.display()
        ));
    }
    Ok(())
}

/// Pictures rendered from a recording (rrweb events), for a browser that could not take them: a
/// PNG of the end, and a WebP at each time in `times` (Unix ms). Offline, like the MP4 render.
pub fn stills(
    recording: &[u8],
    times: &[i64],
    tools: &Path,
) -> io::Result<(Vec<u8>, Vec<Vec<u8>>)> {
    let work = tools.with_file_name("attachments");
    fs::create_dir_all(&work)?;
    let staging = private_dir(&work)?;
    let source = staging.path().join("recording.json");
    fs::write(&source, recording)?;
    let at = staging.path().join("times.json");
    fs::write(&at, serde_json::to_vec(times)?)?;
    let script = staging.path().join("render.cjs");
    fs::write(&script, include_bytes!("review-video.cjs"))?;
    let node = crate::investigate::program("node")
        .ok_or_else(|| io::Error::other("Install Node.js to render pictures from the replay."))?;
    let mut command = Command::new(&node);
    command
        .env("PATH", crate::investigate::path_for(&node))
        .arg(script)
        .arg("--stills")
        .arg(tools)
        .arg(source)
        .arg(at)
        .arg(staging.path());
    render(command, staging.path(), Duration::from_secs(3 * 60))?;
    let screenshot = fs::read(staging.path().join("screenshot.png"))?;
    let shots = (0..times.len())
        .map(|n| fs::read(staging.path().join(format!("shot-{n}.webp"))))
        .collect::<io::Result<_>>()?;
    Ok((screenshot, shots))
}

/// Runs the renderer and stops it after `limit`: a stuck browser or encoder must not hold the
/// review page and the staging files forever.
fn render(command: Command, staging: &Path, limit: Duration) -> io::Result<()> {
    run_logged(command, &staging.join("render.log"), limit, "The render")
}

/// Runs a program with its error output in `log`, and stops it after `limit`. `what` names it in
/// the messages. A failure returns the log.
fn run_logged(mut command: Command, log: &Path, limit: Duration, what: &str) -> io::Result<()> {
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(fs::File::create(log)?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|e| io::Error::other(format!("Install Node.js to run {what}: {e}")))?;
    let deadline = std::time::Instant::now() + limit;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other(format!(
                "{what} took longer than {} minutes and was stopped.",
                limit.as_secs() / 60
            )));
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    };
    if status.success() {
        return Ok(());
    }
    let message = fs::read_to_string(log).unwrap_or_default();
    Err(io::Error::other(match message.trim() {
        "" => format!("{what} failed ({status})."),
        text => text.to_owned(),
    }))
}

/// One sequential transfer per review and capture on a native connection. Closing the port drops
/// its temporary file.
pub struct Transfer {
    file: fs::File,
    _folder: tempfile::TempDir,
}

impl Transfer {
    pub fn open(
        review: &Review,
        capture: Option<i64>,
        blobs: &Blobs,
        tools: &Path,
        voice: &[VoiceSource],
    ) -> io::Result<Self> {
        let folder = private_dir(&std::env::temp_dir())?;
        let path = save(review, capture, blobs, voice, folder.path(), tools)?;
        Ok(Self {
            file: fs::File::open(path)?,
            _folder: folder,
        })
    }

    pub fn read(&mut self, offset: u64) -> io::Result<(Vec<u8>, u64)> {
        use io::{Read, Seek};
        if self.file.stream_position()? != offset {
            return Err(io::Error::other(
                "Attachment transfer offset changed. Open the draft again.",
            ));
        }
        let total = self.file.metadata()?.len();
        let size = (total - offset).min(u64::from(crate::protocol::MAX_BLOB_CHUNK));
        let mut bytes = vec![0; size as usize];
        self.file.read_exact(&mut bytes)?;
        Ok((bytes, total))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_check_names_the_first_thing_to_fix() {
        let none = video_tools_detail(false, false, false).unwrap();
        assert!(none.contains("Node.js") && none.contains("lens video-tools install"));
        let packages = video_tools_detail(true, false, false).unwrap();
        assert!(packages.contains("lens video-tools install"));
        assert!(
            video_tools_detail(true, false, true)
                .unwrap()
                .contains("FFmpeg")
        );
        assert_eq!(video_tools_detail(true, true, true), None);
    }

    #[test]
    fn empty_and_installed_tools_folders() {
        let dir = tempfile::tempdir().unwrap();
        let empty = check_video_tools(dir.path());
        assert!(!empty.ready);
        assert!(empty.detail.is_some());
        for package in ["playwright-core", "rrweb-player"] {
            fs::create_dir_all(dir.path().join("node_modules").join(package)).unwrap();
        }
        let installed = check_video_tools(dir.path());
        assert_eq!(installed.ready, installed.node && installed.ffmpeg);
        assert_eq!(installed.ready, installed.detail.is_none());
        assert_eq!(tools_ready(dir.path()), installed.node);
    }
}
