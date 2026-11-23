//! Settings and updates.
use super::*;

impl Daemon {
    pub(super) fn update_state(&self, store: &Store) -> Result<UpdateState, ProtocolError> {
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
}

/// Checks for updates an hour after start and then daily; installs them when the person allows it.
pub(super) fn schedule_updates(daemon: Arc<Daemon>) {
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
                let _busy = Busy::start();
                if let Err(e) = daemon.update(automatic) {
                    log(&daemon.paths, &format!("update check: {}", e.message));
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(24 * 3600));
        }
    });
}

const SPEECH_SETTINGS: &str = "speech.settings";
const PRIVACY_SETTINGS: &str = "privacy.settings";
const FINDINGS_ENABLED: &str = "findings.enabled";
const FINDINGS_MODEL: &str = "findings.model";
const RETENTION_DAYS: &str = "storage.retention.days";
const RETENTION_FILED_ONLY: &str = "storage.retention.filedOnly";

/// The speech models the settings page offers; the first is the default.
pub(super) const SPEECH_MODELS: [&str; 2] = ["large-v3-turbo", "small"];

fn saved_json<T: serde::de::DeserializeOwned>(
    store: &Store,
    key: &str,
) -> Result<Option<T>, ProtocolError> {
    // A value an older Lens wrote that no longer reads is the default, not an error.
    Ok(store
        .setting(key)
        .map_err(storage)?
        .and_then(|json| serde_json::from_str(&json).ok()))
}

fn save_json(store: &Store, key: &str, value: &impl serde::Serialize) -> Result<(), ProtocolError> {
    let json = serde_json::to_string(value).expect("settings serialize");
    store.set_setting(key, &json).map_err(storage)
}

/// Trimmed, without empty or repeated entries; an error past `max` entries or `len` characters.
fn clean_list(
    items: Vec<String>,
    what: &str,
    max: usize,
    len: usize,
) -> Result<Vec<String>, ProtocolError> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let item = item.trim().to_string();
        if item.chars().count() > len {
            return Err(bad(format!("a {what} is longer than {len} characters")));
        }
        if !item.is_empty() && !out.contains(&item) {
            out.push(item);
        }
    }
    if out.len() > max {
        return Err(bad(format!("keep at most {max} {what}s")));
    }
    Ok(out)
}

/// Trimmed text, None when empty; an error past `len` characters.
fn optional(text: Option<String>, what: &str, len: usize) -> Result<Option<String>, ProtocolError> {
    let text = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    if text.as_ref().is_some_and(|t| t.chars().count() > len) {
        return Err(bad(format!("the {what} is longer than {len} characters")));
    }
    Ok(text)
}

pub(super) fn speech_settings(store: &Store) -> Result<SpeechSettings, ProtocolError> {
    Ok(
        saved_json(store, SPEECH_SETTINGS)?.unwrap_or_else(|| SpeechSettings {
            model: SPEECH_MODELS[0].into(),
            language: None,
            prompt: None,
        }),
    )
}

pub(super) fn set_speech_settings(
    store: &Store,
    settings: SpeechSettings,
) -> Result<SpeechSettings, ProtocolError> {
    if !SPEECH_MODELS.contains(&settings.model.as_str()) {
        return Err(bad(format!(
            "the speech model is one of {}",
            SPEECH_MODELS.join(", ")
        )));
    }
    let language = optional(settings.language, "language", 8)?.map(|l| l.to_lowercase());
    if language
        .as_deref()
        .is_some_and(|l| !l.bytes().all(|b| b.is_ascii_alphabetic() || b == b'-'))
    {
        return Err(bad("the language is a code such as en or pt-br"));
    }
    let settings = SpeechSettings {
        model: settings.model,
        language,
        prompt: optional(settings.prompt, "prompt", 1000)?,
    };
    save_json(store, SPEECH_SETTINGS, &settings)?;
    Ok(settings)
}

pub(super) fn privacy_settings(store: &Store) -> Result<PrivacySettings, ProtocolError> {
    Ok(saved_json(store, PRIVACY_SETTINGS)?.unwrap_or_default())
}

pub(super) fn set_privacy_settings(
    store: &Store,
    settings: PrivacySettings,
) -> Result<PrivacySettings, ProtocolError> {
    let headers: Vec<String> = settings
        .sensitive_headers
        .into_iter()
        .map(|h| h.to_ascii_lowercase())
        .collect();
    let settings = PrivacySettings {
        mask_selectors: clean_list(settings.mask_selectors, "selector", 100, 500)?,
        sensitive_headers: clean_list(headers, "header", 100, 200)?,
        sensitive_patterns: clean_list(settings.sensitive_patterns, "pattern", 100, 500)?,
    };
    let token = |b: u8| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b);
    if settings
        .sensitive_headers
        .iter()
        .any(|h| !h.bytes().all(token))
    {
        return Err(bad("a header name has a character headers cannot have"));
    }
    save_json(store, PRIVACY_SETTINGS, &settings)?;
    Ok(settings)
}

/// The provider is the summary agent (`agent.summary`), so SetSummaryAgent and this agree.
pub(super) fn findings_settings(store: &Store) -> Result<FindingsSettings, ProtocolError> {
    Ok(FindingsSettings {
        enabled: findings_enabled(store),
        provider: summary_agent(store).map(|agent| match agent {
            investigate::Agent::Claude => "claude".into(),
            investigate::Agent::Codex => "codex".into(),
        }),
        model: store
            .setting(FINDINGS_MODEL)
            .map_err(storage)?
            .filter(|m| !m.is_empty()),
    })
}

/// The settings as `investigate::summarize_with` takes them.
pub(super) fn findings_config(store: &Store) -> Result<investigate::FindingsConfig, ProtocolError> {
    let settings = findings_settings(store)?;
    Ok(investigate::FindingsConfig {
        enabled: settings.enabled,
        provider: settings.provider,
        model: settings.model,
    })
}

pub(super) fn findings_enabled(store: &Store) -> bool {
    store.setting(FINDINGS_ENABLED).ok().flatten().as_deref() != Some("false")
}

pub(super) fn set_findings_settings(
    store: &Store,
    settings: FindingsSettings,
) -> Result<FindingsSettings, ProtocolError> {
    let provider = optional(settings.provider, "provider", 16)?;
    if !matches!(provider.as_deref(), None | Some("claude") | Some("codex")) {
        return Err(bad("the provider is claude, codex or automatic"));
    }
    let model = optional(settings.model, "model", 100)?.unwrap_or_default();
    if !model
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"-._:/[]".contains(&b))
    {
        return Err(bad("a model name has letters, digits and - . _ : / only"));
    }
    store
        .set_setting(
            FINDINGS_ENABLED,
            if settings.enabled { "true" } else { "false" },
        )
        .map_err(storage)?;
    store
        .set_setting("agent.summary", provider.as_deref().unwrap_or(""))
        .map_err(storage)?;
    store.set_setting(FINDINGS_MODEL, &model).map_err(storage)?;
    findings_settings(store)
}

/// Days to keep, and whether only filed observations go.
pub(super) fn retention(store: &Store) -> Result<(Option<u32>, bool), ProtocolError> {
    let days = store
        .setting(RETENTION_DAYS)
        .map_err(storage)?
        .and_then(|d| d.parse().ok());
    let filed_only = store
        .setting(RETENTION_FILED_ONLY)
        .map_err(storage)?
        .as_deref()
        == Some("true");
    Ok((days, filed_only))
}

pub(super) fn set_retention(
    store: &Store,
    days: Option<u32>,
    filed_only: bool,
) -> Result<(), ProtocolError> {
    match days {
        Some(days) if !(1..=3650).contains(&days) => {
            return Err(bad("keep observations for 1 to 3650 days"));
        }
        Some(days) => store.set_setting(RETENTION_DAYS, &days.to_string()),
        None => store.delete_setting(RETENTION_DAYS),
    }
    .map_err(storage)?;
    store
        .set_setting(
            RETENTION_FILED_ONLY,
            if filed_only { "true" } else { "false" },
        )
        .map_err(storage)
}

/// The replay tools install in progress, or how the last one ended.
#[derive(Default)]
pub(super) struct VideoInstall {
    pub(super) running: bool,
    pub(super) progress: Option<String>,
    pub(super) failed: Option<String>,
}

impl Daemon {
    pub(super) fn storage_usage(&self) -> Result<StorageUsage, ProtocolError> {
        let store = self.lock_store();
        let named = store.storage_summary().map_err(storage)?;
        let (retention_days, retention_filed_only) = retention(&store)?;
        drop(store);
        let models_dir = speech::models_dir(&self.paths);
        let models = crate::blobs::dir_bytes(&models_dir);
        let mut total = crate::blobs::dir_bytes(&self.paths.data);
        if !models_dir.starts_with(&self.paths.data) {
            total += models;
        }
        let known = named.recordings_bytes + named.audio_bytes + named.screenshots_bytes + models;
        Ok(StorageUsage {
            recordings_bytes: named.recordings_bytes,
            audio_bytes: named.audio_bytes,
            screenshots_bytes: named.screenshots_bytes,
            models_bytes: models,
            // Evidence, reviews, filings, the database, the replay tools and unswept files.
            other_bytes: total.saturating_sub(known),
            total_bytes: total.max(known),
            observation_count: named.observation_count,
            review_count: named.review_count,
            retention_days,
            retention_filed_only,
        })
    }

    /// Deletes observations unchanged for `older_than_days` days; the sweep then removes the
    /// files no other record names.
    pub(super) fn prune(
        &self,
        older_than_days: u32,
        filed_only: bool,
    ) -> Result<PruneResult, ProtocolError> {
        if older_than_days == 0 {
            return Err(bad("keep observations for at least one day"));
        }
        let cutoff = now_ms().saturating_sub(i64::from(older_than_days) * 24 * 3600 * 1000);
        let named = |c: &crate::store::CategoryCounts| {
            c.recordings_bytes + c.audio_bytes + c.screenshots_bytes + c.other_bytes
        };
        let store = self.lock_store();
        let before = store.storage_summary().map_err(storage)?;
        let deleted = store
            .prune_observations(cutoff, filed_only)
            .map_err(storage)?;
        let after = store.storage_summary().map_err(storage)?;
        drop(store);
        if deleted > 0 {
            self.sweep_soon();
        }
        Ok(PruneResult {
            deleted_observations: deleted,
            freed_bytes: named(&before).saturating_sub(named(&after)),
        })
    }

    /// The hourly prune the person chose with SetRetention.
    pub(super) fn apply_retention(&self) {
        let rule = retention(&self.lock_store());
        let Ok((Some(days), filed_only)) = rule else {
            return;
        };
        match self.prune(days, filed_only) {
            Ok(r) if r.deleted_observations > 0 => log(
                &self.paths,
                &format!(
                    "retention: deleted {} observations older than {days} days",
                    r.deleted_observations
                ),
            ),
            Ok(_) => {}
            Err(e) => log(&self.paths, &format!("retention: {}", e.message)),
        }
    }

    pub(super) fn video_tools(&self) -> VideoToolsStatus {
        let check = crate::attachments::check_video_tools(&self.paths.data.join("video-tools"));
        let install = self.video_install.lock().unwrap_or_else(|e| e.into_inner());
        VideoToolsStatus {
            ready: check.ready,
            installing: install.running,
            node: check.node,
            ffmpeg: check.ffmpeg,
            detail: install.failed.clone().or(check.detail),
            progress: install.progress.clone(),
        }
    }

    /// Installs the replay tools on a thread of its own, unless an install runs.
    pub(super) fn install_video_tools(&self) {
        {
            let mut install = self.video_install.lock().unwrap_or_else(|e| e.into_inner());
            if install.running {
                return;
            }
            *install = VideoInstall {
                running: true,
                ..VideoInstall::default()
            };
        }
        let Some(daemon) = self.me() else { return };
        std::thread::spawn(move || {
            let _busy = Busy::start();
            let tools = daemon.paths.data.join("video-tools");
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                crate::attachments::install_video_tools(&tools, |step| {
                    daemon
                        .video_install
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .progress = Some(step.into());
                })
            }))
            .unwrap_or_else(|_| Err("the install stopped unexpectedly; try again".into()));
            if let Err(reason) = &result {
                log(&daemon.paths, &format!("video tools install: {reason}"));
            }
            *daemon
                .video_install
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = VideoInstall {
                failed: result.err(),
                ..VideoInstall::default()
            };
        });
    }
}
