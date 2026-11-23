//! Observations: splits, the model's titles and findings.
use super::*;

impl Daemon {
    pub(super) fn split_observation(
        &self,
        store: &mut Store,
        observation: i64,
        revision: u32,
        findings: Vec<u32>,
        title: String,
    ) -> Result<Reply, ProtocolError> {
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
        let header = findings_heading(&found.notes).unwrap_or_default();
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
                format!("{header}\n{}", lines.join("\n"))
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
        Ok(match outcome {
            Updated::Saved(copy) => {
                // Both are the person's now: a later summary must not put every finding back.
                // The split is done: a failure here must not report it as failed.
                for id in [observation, copy.id] {
                    if let Err(e) = store.set_setting(&format!("title.auto.{id}"), "") {
                        log(&self.paths, &format!("split {observation}: {e}"));
                    }
                }
                self.requeue_voice(store);
                Reply::Observation(copy)
            }
            Updated::Conflict(_) => {
                return Err(ProtocolError::new(
                    ErrorCode::Conflict,
                    "the notes changed after you chose; choose again",
                ));
            }
            Updated::Missing => return Err(not_found("no such observation")),
        })
    }

    pub(super) fn split_into_tasks(
        &self,
        store: &mut Store,
        observation: i64,
        revision: u32,
        issues: Vec<investigate::Issue>,
    ) -> Result<Reply, ProtocolError> {
        if issues.len() < 2 || issues.len() > 8 || issues.iter().any(|i| plain(&i.title).is_empty())
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
        // The model that suggested the split wrote the findings at the top of the notes.
        let header = match findings_heading(&found.notes) {
            Some(header) => header,
            None => crate::record::findings_header(&findings_label(&findings_config(store)?)),
        };
        let plans: Vec<crate::store::TaskPlan> = issues
            .iter()
            .map(|issue| {
                let (edits, leave) = issue_edits(issue, voice_start, &captures);
                crate::store::TaskPlan {
                    title: plain(&issue.title),
                    notes: [
                        format!(
                            "{header}\n{}",
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
        Ok(
            match store
                .split_into_tasks(observation, revision, &plans, now_ms())
                .map_err(storage)?
            {
                Ok(created) => {
                    self.requeue_voice(store);
                    Reply::Split(created)
                }
                Err(Updated::Missing) => return Err(not_found("no such observation")),
                Err(_) => {
                    return Err(ProtocolError::new(
                        ErrorCode::Conflict,
                        "the notes changed after the split was suggested; look again",
                    ));
                }
            },
        )
    }

    /// A title and findings for an observation from the model Settings chose, and that model's
    /// label for the findings header. Nothing is saved. Findings that are off run no model.
    pub(super) fn summary(
        &self,
        observation: i64,
    ) -> Result<(investigate::Summary, String), ProtocolError> {
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
        let config = findings_config(&self.lock_store())?;
        let (summary, label) = investigate::summarize_with(&context, &self.notebook, &config)
            .map_err(remote)?
            .ok_or_else(|| bad("findings are off in Settings"))?;
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
        Ok((summary, label))
    }

    /// Titles an observation in the background, once its words are written down, unless the
    /// person named it: only a page's own title or Lens's earlier automatic one is replaced.
    pub(super) fn auto_title(&self, observation: i64) {
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

    pub(super) fn try_auto_title(&self, observation: i64) -> Result<(), String> {
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
        let config = findings_config(&self.lock_store()).map_err(|e| e.message)?;
        if !config.enabled || !automatic || waiting {
            return Ok(());
        }
        match config.agent() {
            Ok(preferred) if investigate::Agent::pick(preferred).is_some() => {}
            _ => return Ok(()),
        }
        let (summary, label) = self.summary(observation).map_err(|e| e.message)?;
        let store = self.lock_store();
        let previous = strip_findings(&found.notes);
        let findings = if summary.findings.is_empty() {
            String::new()
        } else {
            // The model read page text: its words cannot add links, images or HTML to the notes.
            format!(
                "{}\n{}",
                crate::record::findings_header(&label),
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
}

/// The first line of the notes when it heads a findings block: a model's, or an older "Findings:".
pub(super) fn findings_heading(notes: &str) -> Option<String> {
    let first = notes.lines().next()?.trim();
    (first == "Findings:" || crate::record::is_findings_header(first)).then(|| first.to_string())
}

/// The label the configured model would put in a findings header, without running it.
pub(super) fn findings_label(config: &investigate::FindingsConfig) -> String {
    let agent = config
        .agent()
        .ok()
        .flatten()
        .unwrap_or(investigate::Agent::Claude);
    investigate::model_label(agent, config.model_for(agent).ok().flatten().as_deref())
}

/// A model's title as plain text: no Markdown or HTML punctuation.
pub(super) fn plain(text: &str) -> String {
    text.chars()
        .filter(|c| !"[]()<>!`*_#|\\".contains(*c))
        .collect::<String>()
        .trim()
        .to_string()
}

/// The person's choice of agent for summaries and duplicate checks; None is automatic.
pub(super) fn summary_agent(store: &Store) -> Option<investigate::Agent> {
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
pub(super) fn issue_edits(
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
pub(super) fn split_findings(notes: &str) -> (Vec<String>, String) {
    let mut lines = notes.lines().peekable();
    let mut found = Vec::new();
    if findings_heading(notes).is_some() {
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
pub(super) fn strip_findings(notes: &str) -> String {
    split_findings(notes).1
}
