//! Reviews: what a person approved to leave, frozen, and the ways it leaves.
use super::*;

impl Daemon {
    pub(super) fn create_review(
        &self,
        store: std::sync::MutexGuard<'_, Store>,
        request: ReviewRequest,
    ) -> Result<Reply, ProtocolError> {
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
        let mut captures = Vec::new();
        for id in &request.captures {
            captures.push(
                store
                    .get_capture(*id)
                    .map_err(storage)?
                    .filter(|c| c.observation == observation.id)
                    .ok_or_else(|| not_found(format!("capture {id} is not in this observation")))?,
            );
        }
        let voice_notes = store.list_voice_notes(observation.id).map_err(storage)?;
        // Rendering takes seconds: other requests must not wait on the store meanwhile.
        drop(store);
        let mut items = Vec::new();
        for capture in captures {
            let id = capture.id;
            let original = self
                .blobs
                .read_all(&capture.screenshot.sha256)
                .map_err(storage)?;
            let rendered = render::render(&original, &capture.annotations).map_err(storage)?;
            let evidence = self
                .blobs
                .read_all(&capture.evidence.sha256)
                .map_err(storage)?;
            let mut parsed = repro::parse(&evidence)
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
            let inside =
                |at: i64| kept.is_empty() || kept.iter().any(|r| at >= r.from && at <= r.to);
            let annotations: Vec<Annotation> = capture
                .edits
                .annotations
                .iter()
                .filter(|a| inside(a.at))
                .cloned()
                .collect();
            // A mask hides pixels only: the replay would show the same text. The stored
            // marks decide, not the page that asked (it can be stale).
            let masked = capture.annotations.iter().any(Shape::hides);
            // The tab video shows the same pixels as the replay: it leaves as the replay does.
            if masked || !request.recordings.contains(&id) {
                parsed.events.retain(|e| e.kind != "video");
            }
            // Screen text and pointed-at names come from the replay: masked, none of it.
            let (screen, pointing) = if masked {
                Default::default()
            } else {
                self.recording_notes(&capture, &kept)
            };
            let before = parsed.actions.len() + parsed.events.len();
            let shared = repro::for_review(parsed, request.typed_values, &kept);
            let cut = before.saturating_sub(shared.actions.len() + shared.events.len()) as u32;
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
                    Some(recording) if request.recordings.contains(&id) && !masked => {
                        Some(self.kept_recording(recording, &kept)?)
                    }
                    _ => None,
                },
                findings: export::findings(&serde_json::from_slice(&shared).unwrap_or_default()),
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
        let voice: Vec<ReviewVoice> = voice_notes
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
        let mut store = self.lock_store();
        let current = store
            .get_observation(review.observation)
            .map_err(storage)?
            .map(|o| o.revision);
        if current != Some(review.revision) {
            return Err(ProtocolError::new(
                ErrorCode::Conflict,
                "the notes changed while the review was made; review again",
            ));
        }
        Ok(Reply::Review(store.create_review(review).map_err(storage)?))
    }

    pub(super) fn read_attachment(
        &self,
        store: std::sync::MutexGuard<'_, Store>,
        review: i64,
        capture: Option<i64>,
        offset: u64,
        include_voice: bool,
        transfers: &Transfers,
    ) -> Result<Reply, ProtocolError> {
        let key = (review, capture);
        let mut reader = if offset == 0 {
            let frozen = store
                .get_review(review)
                .map_err(storage)?
                .ok_or_else(|| not_found("no such review"))?;
            let voice = store
                .mp4_voice(&frozen, capture.is_some() && include_voice)
                .map_err(storage)?;
            drop(store);
            crate::attachments::Transfer::open(
                &frozen,
                capture,
                &self.blobs,
                &self.paths.data.join("video-tools"),
                &voice,
            )
            .map_err(storage)?
        } else {
            drop(store);
            // The page reads one transfer's parts in order: while one is read, the
            // transfer is out of the map.
            transfers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&key)
                .ok_or_else(|| bad("No matching attachment transfer on this connection."))?
        };
        let read = reader.read(offset);
        let keep = |reader| {
            transfers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(key, reader);
        };
        let (bytes, total_size) = match read {
            Ok(read) => read,
            Err(e) => {
                // The same part can be asked for again.
                keep(reader);
                return Err(storage(e));
            }
        };
        if offset + (bytes.len() as u64) < total_size {
            keep(reader);
        }
        Ok(Reply::Blob(BlobChunk {
            data: BASE64.encode(bytes),
            total_size,
        }))
    }

    pub(super) fn hand_off(
        &self,
        store: std::sync::MutexGuard<'_, Store>,
        review: i64,
        app: crate::handoff::HandoffApp,
        folder: String,
    ) -> Result<Reply, ProtocolError> {
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
        let exported = export::export(&review, &self.blobs, &self.paths.data.join("handoffs"))
            .map_err(storage)?;
        let report = std::fs::read_to_string(exported.join("report.md")).map_err(storage)?;
        let prompt = handoff::prompt(
            app,
            &review.title,
            task.as_ref().map(|(id, url)| (id.as_str(), url.as_str())),
            &exported,
            &report,
        );
        handoff::start(app, &review.title, &prompt, &project).map_err(bad)?;
        Ok(Reply::HandedOff(Exported {
            folder: exported.display().to_string(),
        }))
    }

    /// Makes a review fit what VibeQ takes: at most MAX_ATTACHMENTS files, so the shots share
    /// what the records, end screenshots and recordings leave (evenly spaced, the rest counted);
    /// and records under their size limit.
    pub(super) fn fit_for_filing(&self, review: &mut Review) -> Result<(), ProtocolError> {
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

    /// What the screen showed in a capture's DOM recording, inside the kept time.
    /// The shot with the person's masks burned in; the unmasked one never leaves.
    pub(super) fn masked_shot(&self, shot: &Shot, edits: &Edits) -> Result<Shot, ProtocolError> {
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
    pub(super) fn kept_recording(
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
    pub(super) fn recording_notes(
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
}

/// Long page URLs can make even a hundred summaries pass the reply limit: the page ends early
/// (never empty, so a list always moves on), and the next one starts below its last review.
pub(super) fn fit_page(page: &mut Vec<crate::protocol::ReviewSummary>) {
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
