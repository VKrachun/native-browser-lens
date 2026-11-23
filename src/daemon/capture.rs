//! Captures: the screenshot, its evidence, the shots and recordings that come with it.
use super::*;

/// A screenshot of a 4K display at 2x is about 10 MiB of PNG; the request limit leaves room for base64.
pub(super) const MAX_SCREENSHOT_BYTES: usize = 12 * 1024 * 1024;

/// The screenshot of a capture whose pictures wait for the replay tools; it says so.
pub(super) const PENDING_SCREENSHOT: &[u8] = include_bytes!("../../assets/pending-screenshot.png");

/// When the browser would have taken its step shots: a moment after the last of a quick series of
/// clicks and keys, as the extension's SHOT_DELAY_MS does. At most MAX_SHOTS, the latest kept.
pub(super) fn step_shot_times(actions: &[crate::protocol::Action]) -> Vec<i64> {
    pub(super) const DELAY_MS: i64 = 700;
    let steps: Vec<i64> = actions
        .iter()
        .filter(|a| {
            matches!(
                a.kind,
                ActionKind::Click
                    | ActionKind::Press
                    | ActionKind::Select
                    | ActionKind::Check
                    | ActionKind::Uncheck
            )
        })
        .map(|a| a.timestamp)
        .collect();
    let mut times: Vec<i64> = steps
        .iter()
        .enumerate()
        .filter(|(n, at)| steps.get(n + 1).is_none_or(|next| next - *at > DELAY_MS))
        .map(|(_, at)| at + DELAY_MS)
        .collect();
    let extra = times.len().saturating_sub(MAX_SHOTS);
    times.drain(..extra);
    times
}

impl Daemon {
    pub(super) fn create_capture(&self, capture: NewCapture) -> Result<Reply, ProtocolError> {
        let rendering = capture.render_screenshot
            && capture.screenshot.is_empty()
            && capture.screenshot_blob.is_none();
        let screenshot = match &capture.screenshot_blob {
            _ if rendering => PENDING_SCREENSHOT.to_vec(),
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
        let videos = self.checked_videos(&capture.evidence.events)?;
        // No screenshot from the browser: the replay's end, and a picture after each step.
        let mut shots = self.checked_shots(&capture.shots)?;
        let mut screenshot = screenshot;
        let mut pending = false;
        if rendering && let Some(recording) = &recording {
            let times = if capture.kind == CaptureKind::Session {
                step_shot_times(&capture.evidence.actions)
            } else {
                Vec::new()
            };
            match self.render_pictures(&recording.sha256, &times) {
                Ok((png, rendered)) => (screenshot, shots) = (png, rendered),
                Err(reason) => {
                    log(&self.paths, &format!("pictures from the replay: {reason}"));
                    pending = true;
                }
            }
        }
        let mut store = self.lock_store();
        let created_at = now_ms();
        let row = CaptureRow {
            created_at,
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
            // A start after the end would make every trim and review keep nothing. Kept,
            // not refused: the person's recording is not lost to a clock.
            started_at: capture.started_at.min(created_at),
            shots,
            videos,
        };
        let saved = store
            .create_capture(capture.observation, row)
            .map_err(storage)?
            .ok_or_else(|| not_found("no such observation"))?;
        if pending {
            store
                .set_setting(&pending_pictures(saved.id), "1")
                .map_err(storage)?;
        }
        drop(store);
        self.auto_title(saved.observation);
        Ok(Reply::Capture(saved))
    }

    /// The tab videos the evidence's `video` events name: stored WebM files from UploadChunk.
    fn checked_videos(&self, events: &[EvidenceEvent]) -> Result<Vec<BlobRef>, ProtocolError> {
        let mut videos: Vec<BlobRef> = Vec::new();
        for event in events.iter().filter(|e| e.kind == "video") {
            let Some(sha256) = event.data["blob"]["sha256"].as_str() else {
                return Err(bad("a video event names no blob"));
            };
            let (head, size) = self
                .blobs
                .read(sha256, 0, 4)
                .map_err(|_| not_found("upload the video first"))?;
            // Every WebM file starts with the EBML magic number.
            if head != b"\x1a\x45\xdf\xa3" {
                return Err(bad("the video is not a WebM file"));
            }
            if !videos.iter().any(|v| v.sha256 == sha256) {
                videos.push(BlobRef {
                    sha256: sha256.into(),
                    size,
                    media_type: "video/webm".into(),
                });
            }
        }
        Ok(videos)
    }

    /// Shots from UploadChunk: stored WebP images, at most MAX_SHOTS.
    /// The PNG screenshot and the step shots rendered from a stored recording, checked as the
    /// browser's are. An error when the replay tools are missing or the render fails.
    pub(super) fn render_pictures(
        &self,
        recording: &str,
        times: &[i64],
    ) -> Result<(Vec<u8>, Vec<Shot>), String> {
        let tools = self.paths.data.join("video-tools");
        if !crate::attachments::tools_ready(&tools) {
            return Err("the replay tools are not installed".into());
        }
        let events = self.blobs.read_all(recording).map_err(|e| e.to_string())?;
        let (png, webps) =
            crate::attachments::stills(&events, times, &tools).map_err(|e| e.to_string())?;
        if !png.starts_with(b"\x89PNG\r\n\x1a\n") || png.len() > MAX_SCREENSHOT_BYTES {
            return Err("the rendered screenshot is not a PNG of at most 12 MiB".into());
        }
        let shots = times
            .iter()
            .zip(webps)
            .map(|(at, webp)| {
                Ok(Shot {
                    at: *at,
                    image: self
                        .blobs
                        .put(&webp, "image/webp")
                        .map_err(|e| e.to_string())?,
                    reason: "step".into(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let shots = self.checked_shots(&shots).map_err(|e| e.message)?;
        Ok((png, shots))
    }

    /// Renders a capture's pending pictures on a thread of its own, once at a time for each
    /// capture, and again only ten minutes after a failure (the review page asks every few seconds).
    pub(super) fn render_pending_soon(&self, id: i64) {
        static TRIED: Mutex<BTreeMap<i64, std::time::Instant>> = Mutex::new(BTreeMap::new());
        // Before the ten minutes start: once the tools are installed, the next ask renders.
        if !crate::attachments::tools_ready(&self.paths.data.join("video-tools")) {
            return;
        }
        {
            let mut tried = TRIED.lock().unwrap_or_else(|e| e.into_inner());
            if tried
                .get(&id)
                .is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(600))
            {
                return;
            }
            tried.insert(id, std::time::Instant::now());
        }
        let Some(daemon) = self.me() else { return };
        std::thread::spawn(move || {
            let Ok(Some(capture)) = daemon.lock_store().get_capture(id) else {
                return;
            };
            let Some(recording) = &capture.recording else {
                return;
            };
            let times = if capture.kind == CaptureKind::Session {
                daemon
                    .blobs
                    .read_all(&capture.evidence.sha256)
                    .ok()
                    .and_then(|bytes| repro::parse(&bytes))
                    .map(|evidence| step_shot_times(&evidence.actions))
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            match daemon.render_pictures(&recording.sha256, &times) {
                Ok((png, shots)) => {
                    let Ok(screenshot) = daemon.blobs.put(&png, "image/png") else {
                        return;
                    };
                    let store = daemon.lock_store();
                    // Shots the browser took stay; only a capture without any gets the rendered ones.
                    let shots = if capture.shots.is_empty() {
                        shots
                    } else {
                        capture.shots.clone()
                    };
                    if store.replace_pictures(id, &screenshot, &shots).is_ok() {
                        let _ = store.delete_setting(&pending_pictures(id));
                        TRIED.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                    }
                }
                Err(reason) => log(
                    &daemon.paths,
                    &format!("pictures of capture {id}: {reason}"),
                ),
            }
        });
    }

    pub(super) fn checked_shots(&self, shots: &[Shot]) -> Result<Vec<Shot>, ProtocolError> {
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

    /// Appends a chunk to an upload in `uploads/`; the last one becomes a blob.
    pub(super) fn upload(&self, chunk: UploadChunk) -> Result<Option<BlobRef>, ProtocolError> {
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
            "audio/wav" | "application/json" | "image/webp" | "image/png" | "video/webm"
        ) {
            return Err(bad(
                "Lens takes WAV audio, WebM video, WebP and PNG images and JSON uploads only",
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
}
