//! Files the person can attach to a tracker draft. All inputs come from an immutable review.
use crate::{blobs::Blobs, export, protocol::Review};
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
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
    let staging = tempfile::tempdir_in(downloads)?;
    let file = tempfile::NamedTempFile::new_in(staging.path())?;
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
                let result = Command::new("node")
                    .arg(script)
                    .arg(tools)
                    .arg(source)
                    .arg(ranges)
                    .arg(file.path())
                    .output()
                    .map_err(|e| {
                        io::Error::other(format!("Install Node.js to render MP4 files: {e}"))
                    })?;
                if !result.status.success() {
                    return Err(io::Error::other(
                        String::from_utf8_lossy(&result.stderr).trim().to_owned(),
                    ));
                }
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

/// One sequential transfer per native connection. Closing the port drops its temporary file.
pub struct Transfer {
    file: fs::File,
    _folder: tempfile::TempDir,
    pub review: i64,
    pub capture: Option<i64>,
}

impl Transfer {
    pub fn open(
        review: &Review,
        capture: Option<i64>,
        blobs: &Blobs,
        tools: &Path,
        voice: &[VoiceSource],
    ) -> io::Result<Self> {
        let mut staging = tempfile::Builder::new();
        staging.prefix("lens-attachment-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            staging.permissions(fs::Permissions::from_mode(0o700));
        }
        let folder = staging.tempdir()?;
        let path = save(review, capture, blobs, voice, folder.path(), tools)?;
        Ok(Self {
            file: fs::File::open(path)?,
            _folder: folder,
            review: review.id,
            capture,
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
