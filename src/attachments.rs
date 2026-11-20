//! Files the person can attach to a tracker draft. All inputs come from an immutable review.
use crate::{blobs::Blobs, export, protocol::Review};
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::Command,
};
use zip::{ZipWriter, write::SimpleFileOptions};

pub fn save(
    review: &Review,
    capture: Option<i64>,
    blobs: &Blobs,
    downloads: &Path,
    tools: &Path,
) -> io::Result<PathBuf> {
    fs::create_dir_all(downloads)?;
    let staging = tempfile::tempdir_in(downloads)?;
    let file = tempfile::NamedTempFile::new_in(staging.path())?;
    let (name, extension) = match capture {
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
            fs::write(&ranges, serde_json::to_vec(&item.kept)?)?;
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
