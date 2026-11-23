//! VibeQ: the token, the filing of reviews as tasks, Sirvant and duplicate checks.
use super::*;

pub(super) const TOKEN_ACCOUNT: &str = "vibeq-token";
/// A token from the environment wins over the secret store: for CI and automation, where no
/// keyring runs. People use Settings.
pub(super) const TOKEN_ENV: &str = "LENS_VIBEQ_TOKEN";

/// Whether a VibeQ token is saved. The keychain is read once and then after each change: the
/// settings pages poll every few seconds while the store lock is held, and a keychain prompt
/// would otherwise stall every browser.
pub(super) static HAS_TOKEN: Mutex<Option<bool>> = Mutex::new(None);

/// The observations being filed now. A second filing of one (a double click, the page and an
/// agent) is refused: both would freeze their own submission and VibeQ would get two tasks.
pub(super) static FILING: Mutex<std::collections::BTreeSet<i64>> =
    Mutex::new(std::collections::BTreeSet::new());

pub(super) struct FilingNow(i64);

impl Drop for FilingNow {
    fn drop(&mut self) {
        FILING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

pub(super) fn has_token() -> bool {
    let mut known = HAS_TOKEN.lock().unwrap_or_else(|e| e.into_inner());
    *known.get_or_insert_with(|| saved_token().ok().flatten().is_some())
}

pub(super) fn token_changed() {
    *HAS_TOKEN.lock().unwrap_or_else(|e| e.into_inner()) = None;
    // Read it again now, off the store lock that the settings pages hold.
    std::thread::spawn(has_token);
}

pub(super) fn vibeq_connected(store: &Store) -> Result<bool, ProtocolError> {
    Ok(store.setting("vibeq.endpoint").map_err(storage)?.is_some() && has_token())
}

pub(super) fn destination_settings(store: &Store) -> Result<DestinationSettings, ProtocolError> {
    let vibeq_connected = vibeq_connected(store)?;
    let saved = store.setting("task.destination").map_err(storage)?;
    let choice: Option<TaskDestination> = match saved {
        Some(json) => serde_json::from_str(&json).map_err(storage)?,
        None => vibeq_connected.then(|| TaskDestination {
            tracker: Tracker::Vibeq,
            address: String::new(),
        }),
    };
    Ok(DestinationSettings {
        choice: choice.filter(|c| c.tracker != Tracker::Vibeq || vibeq_connected),
        vibeq_connected,
    })
}

pub(super) fn vibeq_settings(store: &Store) -> Result<VibeQSettings, ProtocolError> {
    let has_token = has_token();
    Ok(VibeQSettings {
        endpoint: store.setting("vibeq.endpoint").map_err(storage)?,
        has_token,
        account: store
            .setting("vibeq.account")
            .map_err(storage)?
            .filter(|name| has_token && !name.is_empty()),
        token_from_environment: std::env::var(TOKEN_ENV).is_ok_and(|t| !t.trim().is_empty()),
        secret_store: secrets::status(),
    })
}

pub(super) fn saved_token() -> Result<Option<String>, ProtocolError> {
    match std::env::var(TOKEN_ENV) {
        Ok(token) if !token.trim().is_empty() => Ok(Some(token.trim().into())),
        _ => secrets::get(TOKEN_ACCOUNT).map_err(storage),
    }
}

impl Daemon {
    pub(super) fn set_vibeq(
        &self,
        store: std::sync::MutexGuard<'_, Store>,
        input: VibeQInput,
    ) -> Result<Reply, ProtocolError> {
        let saved = store.setting("vibeq.endpoint").map_err(storage)?;
        drop(store);
        let endpoint = vibeq::validate_endpoint(&input.endpoint).map_err(bad)?;
        let moved = saved.as_deref() != Some(endpoint.as_str().trim_end_matches('/'));
        let account = match input.token.as_deref().map(str::trim) {
            // A token belongs to its VibeQ: a new address without a new token signs out,
            // so the old token never goes to the new host.
            None if moved && std::env::var(TOKEN_ENV).is_ok_and(|t| !t.trim().is_empty()) => {
                return Err(bad(
                    "LENS_VIBEQ_TOKEN is set for the current VibeQ; unset it before you change the address",
                ));
            }
            None if moved && saved.is_some() => {
                secrets::delete(TOKEN_ACCOUNT).map_err(storage)?;
                Some(String::new())
            }
            None => None,
            Some("") => {
                secrets::delete(TOKEN_ACCOUNT).map_err(storage)?;
                Some(String::new())
            }
            Some(token) => {
                // A token that VibeQ does not accept is never saved.
                let me = Client::new(endpoint.as_str(), token)
                    .map_err(bad)?
                    .me()
                    .map_err(remote)?;
                // LENS_VIBEQ_TOKEN wins over a saved token, so there is nothing to save.
                if std::env::var(TOKEN_ENV).is_ok_and(|t| !t.trim().is_empty()) {
                    if saved_token()?.as_deref() != Some(token) {
                        return Err(bad("LENS_VIBEQ_TOKEN is set and overrides this token"));
                    }
                } else {
                    secrets::set(TOKEN_ACCOUNT, token).map_err(storage)?;
                }
                Some(me.name)
            }
        };
        token_changed();
        let store = self.lock_store();
        let endpoint = endpoint.as_str().trim_end_matches('/');
        store
            .set_setting("vibeq.endpoint", endpoint)
            .map_err(storage)?;
        if let Some(account) = account {
            store
                .set_setting("vibeq.account", &account)
                .map_err(storage)?;
        }
        Ok(Reply::VibeQ(vibeq_settings(&store)?))
    }

    pub(super) fn file_review(
        &self,
        store: std::sync::MutexGuard<'_, Store>,
        review: i64,
        assignee: Option<String>,
    ) -> Result<Reply, ProtocolError> {
        let found = store
            .get_review(review)
            .map_err(storage)?
            .ok_or_else(|| not_found("no such review"))?;
        if !FILING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(found.observation)
        {
            return Err(ProtocolError::new(
                ErrorCode::Conflict,
                "Lens is filing this already; wait for it to finish",
            ));
        }
        let _filing = FilingNow(found.observation);
        let existing = store.filing(review).map_err(storage)?;
        let filed = store.filed(found.observation).map_err(storage)?;
        let install = self.install_id(&store)?;
        // An amendment stays in the first filing's project: VibeQ finds the task by it,
        // also when the site moved to another project since.
        let project = match &filed {
            Some(f) => f.project_id.clone(),
            None => project_for(&store, found.items.first().map(|i| i.page_url.as_str()))?,
        };
        drop(store);
        let client = self.vibeq_client()?;
        let mut attempt = match existing {
            Some(attempt) => attempt,
            None => {
                // Before any file is staged: retries of a frozen attempt come above.
                if let Some(why) = filing::refused(&found, filed.as_ref(), &client.endpoint()) {
                    return Err(ProtocolError::new(ErrorCode::Conflict, why));
                }
                let attempt = filing::prepare(
                    &found,
                    &self.blobs,
                    &self.filings,
                    &client.endpoint(),
                    install,
                    project,
                    assignee,
                )
                .map(|mut attempt| {
                    attempt.submission.revision = filing::next_revision(&found, filed.as_ref());
                    attempt
                })
                .map_err(bad)?;
                self.lock_store().save_filing(&attempt).map_err(storage)?;
                attempt
            }
        };
        let delivered = filing::deliver(&mut attempt, &client, |a| {
            self.lock_store().save_filing(a).map_err(|e| e.to_string())
        });
        delivered.map_err(remote)?;
        Ok(Reply::Filing(filing_reply(&attempt)))
    }

    pub(super) fn start_sirvant(
        &self,
        store: std::sync::MutexGuard<'_, Store>,
        review: i64,
    ) -> Result<Reply, ProtocolError> {
        let attempt = store.filing(review).map_err(storage)?;
        drop(store);
        let Some((endpoint, task)) =
            attempt.and_then(|a| a.receipt.map(|r| (a.endpoint, r.task_id)))
        else {
            return Err(bad("file the review to VibeQ first"));
        };
        let client = self.vibeq_client()?;
        if client.endpoint() != endpoint {
            return Err(bad(format!(
                "this review was filed to {endpoint}; restore that VibeQ address first"
            )));
        }
        Ok(Reply::Sirvant(client.start_sirvant(&task).map_err(remote)?))
    }

    /// Open VibeQ tasks like this observation: VibeQ's title search for the title and each
    /// finding, then a small model's judgment of which describe the same problem. Without a
    /// model, close titles come back as "maybe".
    pub(super) fn duplicates(
        &self,
        found: &Observation,
        own_task: Option<&str>,
    ) -> Result<Vec<investigate::Duplicate>, ProtocolError> {
        let client = self.vibeq_client()?;
        let findings: Vec<String> = split_findings(&found.notes)
            .0
            .iter()
            .map(|f| f.trim_start_matches("- ").replace('\\', ""))
            .collect();
        let mut queries = vec![found.title.clone()];
        queries.extend(findings.iter().cloned());
        queries.truncate(6);
        let mut candidates: Vec<serde_json::Value> = Vec::new();
        for query in &queries {
            for result in client.similar(query).map_err(remote)? {
                let Some(id) = result["id"].as_str() else {
                    continue;
                };
                if Some(id) == own_task {
                    continue;
                }
                let score = result["similarity"].as_f64().unwrap_or(0.0);
                match candidates.iter_mut().find(|c| c["id"] == id) {
                    Some(seen) if seen["similarity"].as_f64().unwrap_or(0.0) < score => {
                        seen["similarity"] = score.into()
                    }
                    Some(_) => {}
                    None => candidates.push(result),
                }
            }
        }
        candidates.sort_by(|a, b| {
            b["similarity"]
                .as_f64()
                .partial_cmp(&a["similarity"].as_f64())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        candidates.truncate(8);
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let brief: Vec<serde_json::Value> = candidates
            .iter()
            .map(|c| {
                serde_json::json!({
                    "id": c["id"],
                    "title": c["title"],
                    "status": c["status"],
                    "description": c["description"].as_str().unwrap_or("").chars().take(400).collect::<String>(),
                })
            })
            .collect();
        let report = serde_json::json!({ "title": found.title, "findings": findings });
        let preferred = summary_agent(&self.lock_store());
        let judged = investigate::judge_duplicates(
            &report,
            &serde_json::Value::from(brief),
            &self.notebook,
            preferred,
        );
        let endpoint = client.endpoint();
        Ok(candidates
            .iter()
            .filter_map(|c| {
                let id = c["id"].as_str()?.to_string();
                let similarity = c["similarity"].as_f64().unwrap_or(0.0);
                let (verdict, reason) = match &judged {
                    Ok(same) => match same.iter().find(|(i, _)| *i == id) {
                        Some((_, reason)) => ("same", Some(reason.clone())),
                        None if similarity >= 0.5 => ("maybe", None),
                        None => return None,
                    },
                    // No model: close titles only, as a hint.
                    Err(_) if similarity >= 0.3 => ("maybe", None),
                    Err(_) => return None,
                };
                Some(investigate::Duplicate {
                    url: format!("{endpoint}/?task={id}"),
                    task_id: id,
                    title: c["title"].as_str().unwrap_or_default().to_string(),
                    status: c["status"].as_str().unwrap_or_default().to_string(),
                    similarity,
                    verdict: verdict.into(),
                    reason,
                })
            })
            .collect())
    }

    pub(super) fn vibeq_client(&self) -> Result<Client, ProtocolError> {
        let endpoint = self
            .lock_store()
            .setting("vibeq.endpoint")
            .map_err(storage)?
            .ok_or_else(|| bad("add the VibeQ address in Settings first"))?;
        let token = saved_token()?.ok_or_else(|| bad("sign in to VibeQ in Settings first"))?;
        Client::new(&endpoint, &token).map_err(bad)
    }

    /// A random ID made once per notebook; VibeQ observation IDs derive from it, so two notebooks
    /// never claim the same observation.
    pub(super) fn install_id(&self, store: &Store) -> Result<uuid::Uuid, ProtocolError> {
        if let Some(id) = store.setting("install.id").map_err(storage)?
            && let Ok(id) = uuid::Uuid::parse_str(&id)
        {
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4();
        store
            .set_setting("install.id", &id.to_string())
            .map_err(storage)?;
        Ok(id)
    }
}

/// The Lens project of the review's page, as VibeQ's project key.
pub(super) fn project_for(store: &Store, page_url: Option<&str>) -> Result<String, ProtocolError> {
    let origin = page_url
        .and_then(|u| url::Url::parse(u).ok())
        .map(|u| u.origin().ascii_serialization());
    let projects = store.list_projects().map_err(storage)?;
    Ok(projects
        .iter()
        .find(|p| origin.as_ref().is_some_and(|o| p.origins.contains(o)))
        .map(|p| format!("lens-project-{}", p.id))
        .unwrap_or_else(|| "lens".into()))
}

pub(super) fn filing_reply(attempt: &filing::Attempt) -> Filing {
    Filing {
        review: attempt.review,
        task_url: attempt.receipt.as_ref().map(|r| r.task_url.clone()),
        missing_files: attempt
            .receipt
            .as_ref()
            .map_or(attempt.submission.evidence_manifest.len(), |r| {
                r.missing_attachments.len()
            }) as u32,
    }
}
