//! Filing a review to VibeQ through a durable outbox. The attempt is frozen and saved before any
//! network traffic, and every retry reconciles with VibeQ first, so an interrupted response never
//! creates a second task and never uploads a file twice.
use crate::blobs::Blobs;
use crate::export;
use crate::protocol::Review;
use crate::vibeq::{Client, Receipt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const MAX_MARKDOWN_CHARS: usize = 100_000;
pub const MAX_ATTACHMENTS: usize = 64;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub filename: String,
    pub content_type: String,
    pub sha256: String,
}

/// The body VibeQ's capture endpoint validates; frozen once, sent unchanged on every retry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Submission {
    pub submission_id: String,
    pub observation_id: String,
    pub revision: u64,
    pub project_id: String,
    pub title: String,
    pub markdown: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee_id: Option<String>,
    pub reviewed: bool,
    pub evidence_manifest: Vec<Artifact>,
    /// `lens` first, then the observation's tags (VibeQ `e7b523f7` and later). Empty in attempts
    /// saved before tags existed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub review: i64,
    pub observation: i64,
    pub endpoint: String,
    pub folder: PathBuf,
    pub submission: Submission,
    /// Bound on the first contact; a token of another member cannot continue this attempt.
    pub member_id: Option<String>,
    pub receipt: Option<Receipt>,
}

/// Freezes a review as files and a submission. Nothing is sent.
pub fn prepare(
    review: &Review,
    blobs: &Blobs,
    root: &Path,
    endpoint: &str,
    install: Uuid,
    project_id: String,
    assignee: Option<String>,
) -> Result<Attempt, String> {
    let folder = export::export(review, blobs, root)
        .map_err(|e| format!("the review cannot be frozen: {e}"))?;
    let submission_id = Uuid::new_v4();
    let mut files: Vec<PathBuf> = std::fs::read_dir(&folder)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.is_file() && attach(path))
        .collect();
    files.sort();
    if files.len() > MAX_ATTACHMENTS {
        return Err(format!(
            "the review has {} files; VibeQ takes {MAX_ATTACHMENTS}",
            files.len()
        ));
    }
    let mut manifest = Vec::new();
    for path in &files {
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        manifest.push(Artifact {
            id: Uuid::new_v5(&submission_id, filename.as_bytes()).to_string(),
            content_type: content_type(&filename).into(),
            sha256: hex(&bytes),
            filename,
        });
    }
    let markdown = std::fs::read_to_string(folder.join("report.md")).map_err(|e| e.to_string())?;
    if markdown.chars().count() > MAX_MARKDOWN_CHARS {
        return Err("the report exceeds VibeQ's 100,000 characters; shorten the notes".into());
    }
    let title: String = review.title.trim().chars().take(500).collect();
    Ok(Attempt {
        review: review.id,
        observation: review.observation,
        endpoint: endpoint.into(),
        folder,
        submission: Submission {
            submission_id: submission_id.to_string(),
            observation_id: Uuid::new_v5(
                &install,
                format!("observation:{}", review.observation).as_bytes(),
            )
            .to_string(),
            // VibeQ revisions start at 1 and must grow with every amendment.
            revision: u64::from(review.revision) + 1,
            project_id,
            title,
            markdown,
            assignee_id: assignee,
            reviewed: true,
            evidence_manifest: manifest,
            tags: crate::protocol::clean_tags(
                &std::iter::once("lens".to_string())
                    .chain(review.tags.iter().cloned())
                    .collect::<Vec<_>>(),
            ),
        },
        member_id: None,
        receipt: None,
    })
}

/// Sends a frozen attempt, or finishes one that was interrupted. `save` persists the attempt
/// whenever it learns something (the member, the receipt).
pub fn deliver(
    attempt: &mut Attempt,
    client: &Client,
    mut save: impl FnMut(&Attempt) -> Result<(), String>,
) -> Result<Receipt, String> {
    if attempt.endpoint != client.endpoint() {
        return Err(format!(
            "this review was filed to {}; restore that VibeQ address to finish it",
            attempt.endpoint
        ));
    }
    let member = client.me()?.id;
    match &attempt.member_id {
        Some(original) if *original != member => {
            return Err("this filing belongs to another VibeQ member; nothing was sent".into());
        }
        Some(_) => {}
        None => {
            attempt.member_id = Some(member);
            save(attempt)?;
        }
    }
    let manifest = &attempt.submission.evidence_manifest;
    let mut receipt = match client.receipt(&attempt.submission.submission_id)? {
        Some(found) => Some(validate(found, &attempt.submission)?),
        None => None,
    };
    let missing: Vec<&Artifact> = match &receipt {
        Some(r) => manifest
            .iter()
            .filter(|a| r.missing_attachments.contains(&a.id))
            .collect(),
        None => manifest.iter().collect(),
    };
    let staged = stage_all(client, &attempt.folder, &missing)?;
    if receipt.is_none() || !missing.is_empty() {
        let mut body = serde_json::to_value(&attempt.submission).expect("submissions serialize");
        body["stagedAttachments"] = staged.into();
        receipt = Some(validate(client.submit(&body)?, &attempt.submission)?);
    }
    attempt.receipt = receipt.clone();
    save(attempt)?;
    receipt.ok_or_else(|| "VibeQ returned no receipt".into())
}

/// Uploads run a few at a time: VibeQ spends about half a second storing each file, so a
/// recording with twenty shots took over ten seconds one by one.
const PARALLEL_UPLOADS: usize = 6;

/// Stages every artifact, in manifest order; the first failure fails the filing, which can retry.
fn stage_all(
    client: &Client,
    folder: &Path,
    artifacts: &[&Artifact],
) -> Result<Vec<serde_json::Value>, String> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let results = std::sync::Mutex::new(vec![None; artifacts.len()]);
    std::thread::scope(|scope| {
        for _ in 0..PARALLEL_UPLOADS.min(artifacts.len()) {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some(artifact) = artifacts.get(i) else {
                        break;
                    };
                    let result = stage_one(client, folder, artifact);
                    let failed = result.is_err();
                    results.lock().unwrap_or_else(|p| p.into_inner())[i] = Some(result);
                    if failed {
                        // The others stop taking new files; the filing fails and can retry.
                        next.store(artifacts.len(), std::sync::atomic::Ordering::Relaxed);
                    }
                }
            });
        }
    });
    results
        .into_inner()
        .unwrap_or_else(|p| p.into_inner())
        .into_iter()
        .map(|r| r.unwrap_or_else(|| Err("an upload did not run".into())))
        .collect()
}

fn stage_one(
    client: &Client,
    folder: &Path,
    artifact: &Artifact,
) -> Result<serde_json::Value, String> {
    let bytes = std::fs::read(folder.join(&artifact.filename)).map_err(|e| e.to_string())?;
    if hex(&bytes) != artifact.sha256 {
        return Err(format!(
            "{} changed after the review; nothing more was sent",
            artifact.filename
        ));
    }
    let key = client.stage(&artifact.filename, &artifact.content_type, &bytes)?;
    Ok(json!({ "id": artifact.id, "key": key }))
}

fn validate(receipt: Receipt, submission: &Submission) -> Result<Receipt, String> {
    let same = receipt
        .submission_id
        .eq_ignore_ascii_case(&submission.submission_id)
        && receipt
            .observation_id
            .eq_ignore_ascii_case(&submission.observation_id)
        && receipt.revision == submission.revision;
    let known = receipt.missing_attachments.iter().all(|id| {
        submission
            .evidence_manifest
            .iter()
            .any(|a| a.id.eq_ignore_ascii_case(id))
    });
    if same && known {
        Ok(receipt)
    } else {
        Err("VibeQ answered with a receipt for a different submission".into())
    }
}

/// What a task needs as files (`lens-capture.v1`): each capture's record, its shots, its end
/// screenshot and its DOM recording. The record holds the timeline, steps, network, console,
/// transcript and notes, so the loose files stay in the local export only.
fn attach(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    name.starts_with("capture-")
        && (name.ends_with(".lens.json")
            || name.ends_with(".rrweb.json")
            || name.ends_with(".webp")
            || name.ends_with(".png"))
}

fn content_type(filename: &str) -> &'static str {
    if filename.ends_with(".lens.json") {
        return crate::record::CONTENT_TYPE;
    }
    if filename.ends_with(".rrweb.json") {
        return "application/vnd.rrweb+json";
    }
    match filename.rsplit('.').next() {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("json") => "application/json",
        Some("md") => "text/markdown",
        // VibeQ shows text/plain inline; the test is code to read, not to run in a browser.
        Some("txt" | "ts") => "text/plain",
        Some("har") => "application/json",
        _ => "application/octet-stream",
    }
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{BlobRef, CaptureKind, CaptureMode, ReviewItem};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Fake {
        receipts: HashMap<String, Value>,
        staged: Vec<String>,
        submits: usize,
        drop_next_submit_reply: bool,
    }
    use serde_json::Value;

    /// A VibeQ that commits a submission and can lose the reply, as a dropped connection does.
    fn fake_vibeq() -> (String, Arc<Mutex<Fake>>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = format!(
            "http://127.0.0.1:{}",
            server.server_addr().to_ip().unwrap().port()
        );
        let state = Arc::new(Mutex::new(Fake::default()));
        let shared = state.clone();
        std::thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let mut body = Vec::new();
                request.as_reader().read_to_end(&mut body).unwrap();
                let url = request.url().to_string();
                let authorized = request.headers().iter().any(|h| {
                    h.field.equiv("Authorization") && h.value.as_str() == "Bearer good-token"
                });
                let mut fake = shared.lock().unwrap();
                let reply = |status: u16, value: Value| {
                    tiny_http::Response::from_string(value.to_string()).with_status_code(status)
                };
                let response = if !authorized {
                    reply(403, json!({ "error": "personal_token_required" }))
                } else if url == "/auth/me" {
                    reply(200, json!({ "id": "member-1" }))
                } else if url == "/api/attachments/stage" {
                    fake.staged.push(String::from_utf8_lossy(&body).into());
                    reply(
                        201,
                        json!({ "stagedKey": format!("staged/member-1/{}", fake.staged.len()) }),
                    )
                } else if let Some(id) = url.strip_prefix("/api/capture/v1/submissions/") {
                    match fake.receipts.get(id) {
                        Some(receipt) => reply(200, receipt.clone()),
                        None => reply(404, json!({ "error": "not_found" })),
                    }
                } else if url == "/api/capture/v1/submissions" {
                    let submission: Value = serde_json::from_slice(&body).unwrap();
                    fake.submits += 1;
                    let staged: Vec<&str> = submission["stagedAttachments"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|s| s["id"].as_str().unwrap())
                        .collect();
                    let missing: Vec<&str> = submission["evidenceManifest"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|a| a["id"].as_str().unwrap())
                        .filter(|id| !staged.contains(id))
                        .collect();
                    let receipt = json!({
                        "submissionId": submission["submissionId"], "observationId": submission["observationId"],
                        "revision": submission["revision"], "taskId": "task-1", "taskUrl": "http://vibeq.test/?task=task-1",
                        "createdAt": 1.0, "attachmentStatus": if missing.is_empty() { "complete" } else { "partial" },
                        "missingAttachments": missing, "payloadHash": "x",
                    });
                    fake.receipts.insert(
                        submission["submissionId"].as_str().unwrap().into(),
                        receipt.clone(),
                    );
                    if std::mem::take(&mut fake.drop_next_submit_reply) {
                        continue; // committed, but the reply is lost
                    }
                    reply(201, receipt)
                } else {
                    reply(404, json!({}))
                };
                drop(fake);
                let _ = request.respond(response);
            }
        });
        (address, state)
    }

    fn review(dir: &Path) -> (Review, Blobs) {
        let blobs = Blobs::new(dir.join("blobs"));
        let png = {
            let mut pixmap = tiny_skia::Pixmap::new(4, 4).unwrap();
            pixmap.fill(tiny_skia::Color::WHITE);
            pixmap.encode_png().unwrap()
        };
        let screenshot = blobs.put(&png, "image/png").unwrap();
        let evidence = blobs.put(br#"{"events":[]}"#, "application/json").unwrap();
        let review = Review {
            id: 7,
            observation: 3,
            revision: 2,
            created_at: 1,
            title: "Cart total shows NaN".into(),
            notes: "After the coupon.".into(),
            tags: vec!["Assets".into(), "bug".into()],
            items: vec![ReviewItem {
                capture: 1,
                page_url: "https://shop.test/cart".into(),
                page_title: "Cart".into(),
                mode: CaptureMode::Deep,
                screenshot,
                evidence: BlobRef { ..evidence },
                recording: None,
                findings: vec!["HTTP 500 from https://shop.test/api".into()],
                marks: vec![],
                kind: CaptureKind::Moment,
                kept: vec![],
                annotations: vec![],
                screen: vec![],
                pointing: vec![],
                shots: vec![],
                cut: 0,
                shots_dropped: 0,
                captured_at: 0,
                started_at: 0,
            }],
            voice: vec![],
        };
        (review, blobs)
    }

    #[test]
    fn a_lost_reply_is_recovered_without_a_second_task_or_upload() {
        let dir = tempfile::tempdir().unwrap();
        let (review, blobs) = review(dir.path());
        let (endpoint, fake) = fake_vibeq();
        let client = Client::new(&endpoint, "good-token").unwrap();
        let install = Uuid::new_v4();
        let mut attempt = prepare(
            &review,
            &blobs,
            &dir.path().join("filings"),
            &client.endpoint(),
            install,
            "p".into(),
            None,
        )
        .unwrap();
        assert_eq!(attempt.submission.revision, 3);
        assert_eq!(attempt.submission.tags, ["lens", "assets", "bug"]);
        let files = attempt.submission.evidence_manifest.len();
        // The report is the description, review.json is bookkeeping, and this evidence holds no
        // network or console event: only the screenshot goes as a file.
        assert_eq!(files, 1, "the screenshot");

        fake.lock().unwrap().drop_next_submit_reply = true;
        let mut saved = Vec::new();
        assert!(
            deliver(&mut attempt, &client, |a| {
                saved.push(a.clone());
                Ok(())
            })
            .is_err()
        );
        assert_eq!(saved.last().unwrap().member_id.as_deref(), Some("member-1"));

        let receipt = deliver(&mut attempt, &client, |_| Ok(())).unwrap();
        assert_eq!(
            (receipt.task_id.as_str(), receipt.missing_attachments.len()),
            ("task-1", 0)
        );
        let fake = fake.lock().unwrap();
        assert_eq!(
            (fake.submits, fake.staged.len()),
            (1, files),
            "no second task, no second upload"
        );
    }

    #[test]
    fn refuses_another_member_a_changed_file_and_another_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let (review, blobs) = review(dir.path());
        let (endpoint, _fake) = fake_vibeq();
        let client = Client::new(&endpoint, "good-token").unwrap();
        let fresh = || {
            prepare(
                &review,
                &blobs,
                &dir.path().join("filings"),
                &client.endpoint(),
                Uuid::new_v4(),
                "p".into(),
                None,
            )
            .unwrap()
        };

        let mut other_member = fresh();
        other_member.member_id = Some("member-2".into());
        assert!(
            deliver(&mut other_member, &client, |_| Ok(()))
                .unwrap_err()
                .contains("another VibeQ member")
        );

        let mut changed = fresh();
        std::fs::write(changed.folder.join("capture-1.png"), "edited after review").unwrap();
        assert!(
            deliver(&mut changed, &client, |_| Ok(()))
                .unwrap_err()
                .contains("changed after the review")
        );

        let mut moved = fresh();
        moved.endpoint = "https://elsewhere.test".into();
        assert!(
            deliver(&mut moved, &client, |_| Ok(()))
                .unwrap_err()
                .contains("restore that VibeQ address")
        );
    }
}
