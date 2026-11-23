//! Voice notes, their transcription, and the speech models.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

impl Daemon {
    pub(super) fn add_voice_note(
        &self,
        store: &Store,
        note: NewVoiceNote,
    ) -> Result<Reply, ProtocolError> {
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
        Ok(Reply::VoiceNote(saved))
    }

    pub(super) fn retry_voice_note(
        &self,
        store: std::sync::MutexGuard<'_, Store>,
        id: i64,
    ) -> Result<Reply, ProtocolError> {
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
        Ok(Reply::VoiceNote(note))
    }

    pub(super) fn update_voice_note(
        &self,
        store: &Store,
        id: i64,
        segments: Vec<VoiceSegment>,
    ) -> Result<Reply, ProtocolError> {
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
        if segments
            .iter()
            .any(|s| s.start_ms < 0 || s.end_ms < s.start_ms || s.end_ms > note.duration_ms + 1000)
        {
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
        Ok(Reply::VoiceNote(
            store
                .get_voice_note(id)
                .map_err(storage)?
                .expect("it exists"),
        ))
    }

    pub(super) fn speech_status(&self) -> Result<SpeechStatus, ProtocolError> {
        let settings = speech_settings(&self.lock_store())?;
        let download = self
            .speech_download
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        Ok(speech::status_for(
            &self.paths,
            &settings.model,
            download.as_ref(),
        ))
    }

    /// Starts the download of the chosen model unless it is there or a download runs. A download
    /// the person stopped does not block a new one: the new one waits for the old thread to end.
    pub(super) fn install_speech(&self) -> Result<(), ProtocolError> {
        let model = speech_settings(&self.lock_store())?.model;
        let mut slot = self
            .speech_download
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if matches!(*slot, Some(ModelState::Downloading { .. }))
            || speech::models_ready_for(&self.paths, &model)
        {
            return Ok(());
        }
        let Some(daemon) = self.me() else {
            return Ok(());
        };
        let cancel = Arc::new(AtomicBool::new(false));
        *self.speech_cancel.lock().unwrap_or_else(|p| p.into_inner()) = cancel.clone();
        *slot = Some(ModelState::Downloading {
            received: 0,
            total: speech::download_size_for(&model),
        });
        drop(slot);
        std::thread::spawn(move || {
            // One download writes the model files at a time; a stopped one ends at its next chunk.
            static ONE: Mutex<()> = Mutex::new(());
            let _one = ONE.lock().unwrap_or_else(|p| p.into_inner());
            // A panic fails this download instead of leaving it "downloading" until a restart.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                speech::download_cancellable(&daemon.paths, &model, &cancel, |received, total| {
                    if !cancel.load(Ordering::SeqCst) {
                        *daemon
                            .speech_download
                            .lock()
                            .unwrap_or_else(|p| p.into_inner()) =
                            Some(ModelState::Downloading { received, total });
                    }
                })
            }))
            .unwrap_or_else(|_| Err("the download stopped unexpectedly; try again".into()));
            // A stopped download leaves the state as the stop (or a newer download) set it.
            if cancel.load(Ordering::SeqCst) {
                return;
            }
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
        Ok(())
    }

    /// Stops the download in progress, so the model shows as missing again. Its `.part` files
    /// stay, and the next install resumes them.
    pub(super) fn cancel_speech_download(&self) {
        let mut slot = self
            .speech_download
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if matches!(*slot, Some(ModelState::Downloading { .. })) {
            self.speech_cancel
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .store(true, Ordering::SeqCst);
            *slot = None;
        }
    }

    /// Voice notes that a split copied while they were still being written down.
    pub(super) fn requeue_voice(&self, store: &Store) {
        if let Ok(waiting) = store.untranscribed_voice_notes() {
            for id in waiting {
                self.queue_transcription(id);
            }
        }
    }

    pub(super) fn queue_transcription(&self, id: i64) {
        if let Some(queue) = self.speech_queue.get() {
            let _ = queue.send(id);
        }
    }

    /// Transcribes one voice note, unless it is done or the model is missing.
    pub(super) fn transcribe(&self, id: i64) {
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
        let Ok(settings) = speech_settings(&self.lock_store()) else {
            return wait("The speech settings cannot be read.");
        };
        if !speech::models_ready_for(&self.paths, &settings.model) {
            return wait("Waiting for the speech model: download it in Lens settings.");
        }
        let Ok(file) = self.blobs.file(&note.audio.sha256) else {
            return wait("The recording is missing.");
        };
        let _ = self
            .lock_store()
            .set_voice_state(id, VoiceState::Transcribing, None, &[], None);
        let result = speech::transcribe_with(
            &self.paths,
            &file,
            &speech::TranscribeOptions {
                model_id: &settings.model,
                language: settings.language.as_deref(),
                prompt: settings.prompt.as_deref(),
            },
        );
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
}

/// One worker transcribes voice notes in order; a GPU runs one model at a time anyway.
pub(super) fn start_transcription(daemon: Arc<Daemon>) {
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
