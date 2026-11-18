//! `lens-capture.v1`: one reviewed capture as one record for a person and an agent: what the
//! person did and said, what the screen showed, what the network and console did, the shots, and
//! what was left out on purpose. VibeQ reads it (see `docs/lens-capture.v1-handoff.md` in the
//! VibeQ repository). Page-derived text stays plain data: a reader renders it as text.
use crate::protocol::{
    Action, ActionKind, Annotation, CaptureMode, Evidence, Locator, Review, ReviewItem,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

pub const CONTENT_TYPE: &str = "application/vnd.sirv.lens-capture+json";
/// Records above this lose detail until they fit; VibeQ returns them inline to agents.
const TARGET_BYTES: usize = 64 * 1024;
const LIMIT_BYTES: usize = 400 * 1024;
/// Requests and console entries this soon after a step belong to it.
const STEP_WINDOW_MS: i64 = 2000;
/// A shot this soon after a step shows its result.
const SHOT_WINDOW_MS: i64 = 2500;
const MAX_BODY: usize = 8 * 1024;
/// The findings block a model wrote; must equal FINDINGS_HEADER in daemon.rs.
const FINDINGS_HEADER: &str = "Findings (written by Claude Haiku from the recording; check them):";
/// The page's own static files: their success says nothing about a defect.
const STATIC: [&str; 12] = [
    "Script",
    "Stylesheet",
    "Font",
    "Image",
    "Media",
    "Manifest",
    "script",
    "stylesheet",
    "font",
    "image",
    "media",
    "imageset",
];

/// The record of capture `n` of a review, as JSON bytes, or why it cannot fit even after the
/// truncation every reader is told about.
pub fn build(
    review: &Review,
    item: &ReviewItem,
    n: usize,
    evidence: &Evidence,
) -> Result<Vec<u8>, String> {
    let mut record = assemble(review, item, n, evidence);
    let size = |r: &Value| serde_json::to_vec(r).map_or(usize::MAX, |b| b.len());
    let mut text = size(&record);
    // Over the target: the bodies of successful answers first, largest first. Failures keep theirs:
    // they explain the defect.
    let mut bodies = 0u64;
    while text > TARGET_BYTES {
        let largest = record["network"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .filter(|(_, e)| {
                e["status"].as_u64().is_some_and(|s| s < 400) && e.get("failure").is_none()
            })
            .flat_map(|(i, e)| {
                ["requestBody", "responseBody"]
                    .into_iter()
                    .filter_map(move |k| e[k].as_str().map(|b| (i, k, b.len())))
            })
            .max_by_key(|(_, _, len)| *len);
        let Some((i, key, len)) = largest else { break };
        record["network"][i]
            .as_object_mut()
            .expect("entries are objects")
            .remove(key);
        bodies += 1;
        text = text.saturating_sub(len);
    }
    // Then screen text, then the oldest steps.
    let mut screen_items = 0u64;
    for keep in [10usize, 5, 2, 0] {
        if size(&record) <= TARGET_BYTES {
            break;
        }
        for step in record["steps"].as_array_mut().into_iter().flatten() {
            for key in ["appeared", "gone"] {
                if let Some(list) = step["screen"][key].as_array_mut()
                    && list.len() > keep
                {
                    screen_items += (list.len() - keep) as u64;
                    list.truncate(keep);
                }
            }
        }
    }
    let mut steps = 0u64;
    while size(&record) > LIMIT_BYTES && record["steps"].as_array().is_some_and(|s| !s.is_empty()) {
        let list = record["steps"].as_array_mut().expect("checked");
        let drop = (list.len() / 10).max(1);
        list.drain(..drop);
        steps += drop as u64;
    }
    record["dropped"]["truncated"] = json!({
        "bodies": bodies, "screenItems": screen_items, "steps": steps, "shots": item.shots_dropped,
    });
    let bytes = serde_json::to_vec_pretty(&record).expect("records serialize");
    if serde_json::to_vec(&record).map_or(usize::MAX, |b| b.len()) > LIMIT_BYTES {
        return Err(format!(
            "capture {n} does not fit a record of {} KB even without its steps; cut it shorter",
            LIMIT_BYTES / 1024
        ));
    }
    Ok(bytes)
}

/// A recording's page at Stop adds nothing to its replay and the shots after each step: only a
/// moment capture, whose screenshot is the capture, files it.
pub fn files_end_screenshot(item: &ReviewItem) -> bool {
    !(item.kind == crate::protocol::CaptureKind::Session && item.recording.is_some())
}

/// Keeps at most `budget` shots across the items, evenly spaced within each, in proportion to
/// how many each has; each item counts what it lost.
pub fn share_shots(items: &mut [ReviewItem], budget: usize) {
    let total: usize = items.iter().map(|i| i.shots.len()).sum();
    if total <= budget {
        return;
    }
    for item in items {
        let before = item.shots.len();
        let keep = before * budget / total;
        item.shots = (0..keep)
            .map(|k| item.shots[k * before / keep].clone())
            .collect();
        item.shots_dropped = (before - keep) as u32;
    }
}

struct Net {
    request_id: String,
    at: i64,
    method: String,
    url: String,
    kind: String,
    status: Option<u64>,
    ended: Option<i64>,
    failure: Option<String>,
    request_body: Option<String>,
    response_body: Option<String>,
}

fn assemble(review: &Review, item: &ReviewItem, n: usize, evidence: &Evidence) -> Value {
    let page = evidence.page.clone().unwrap_or(Value::Null);
    let start = if item.started_at > 0 {
        item.started_at
    } else {
        first_time(evidence).unwrap_or(item.captured_at)
    };
    let end = item.captured_at.max(start);
    let at = |t: i64| t - start;
    let mut dropped: BTreeMap<String, u64> = evidence
        .dropped
        .iter()
        .map(|(k, v)| (k.clone(), u64::from(*v)))
        .collect();

    // Network, in time order, without the page's static files and preflights.
    let mut net: Vec<Net> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for event in &evidence.events {
        let d = &event.data;
        let id = d["requestId"].as_str().unwrap_or("").to_string();
        match event.kind.as_str() {
            "request" => {
                index.insert(id.clone(), net.len());
                net.push(Net {
                    request_id: id,
                    at: event.timestamp,
                    method: d["method"].as_str().unwrap_or("GET").into(),
                    url: d["url"].as_str().unwrap_or("").into(),
                    kind: d["resourceType"].as_str().unwrap_or("").into(),
                    status: None,
                    ended: None,
                    failure: None,
                    request_body: d["postData"].as_str().map(String::from),
                    response_body: None,
                });
            }
            "response" => {
                if let Some(entry) = index.get(&id).map(|&i| &mut net[i]) {
                    entry.status = d["status"].as_u64();
                    entry.ended = Some(event.timestamp);
                }
            }
            "networkFailure" => {
                if let Some(entry) = index.get(&id).map(|&i| &mut net[i]) {
                    entry.failure = d["errorText"]
                        .as_str()
                        .map(String::from)
                        .or(Some("failed".into()));
                    entry.ended = Some(event.timestamp);
                }
            }
            "responseBody" => {
                if let Some(entry) = index.get(&id).map(|&i| &mut net[i]) {
                    entry.response_body = match d["format"].as_str() {
                        Some("json") => Some(d["body"].to_string()),
                        Some("text") => d["body"].as_str().map(String::from),
                        _ => None,
                    };
                }
            }
            _ => {}
        }
    }
    let failed = |e: &Net| e.failure.is_some() || e.status.is_some_and(|s| s >= 400);
    net.retain(|e| {
        let reason = if e.method == "OPTIONS" && !failed(e) {
            Some("preflight")
        } else if STATIC.contains(&e.kind.as_str()) && !failed(e) {
            Some("static-asset")
        } else {
            None
        };
        if let Some(reason) = reason {
            *dropped.entry(reason.into()).or_default() += 1;
        }
        reason.is_none()
    });

    // Console: errors and warnings, repeats merged.
    let mut console: Vec<Value> = Vec::new();
    let mut seen: HashMap<(String, String), usize> = HashMap::new();
    let mut repeats = 0u64;
    let mut console_at: Vec<i64> = Vec::new();
    for event in &evidence.events {
        let d = &event.data;
        let (level, text, source) = match event.kind.as_str() {
            "console" => match d["level"].as_str() {
                Some("error" | "assert") => (
                    "error",
                    d["text"].as_str().unwrap_or(""),
                    d["location"]["url"].as_str(),
                ),
                Some("warning" | "warn") => (
                    "warning",
                    d["text"].as_str().unwrap_or(""),
                    d["location"]["url"].as_str(),
                ),
                _ => continue,
            },
            "exception" => ("error", d["text"].as_str().unwrap_or(""), d["url"].as_str()),
            "log" => match d["level"].as_str() {
                Some("error") => ("error", d["text"].as_str().unwrap_or(""), d["url"].as_str()),
                Some("warning") => (
                    "warning",
                    d["text"].as_str().unwrap_or(""),
                    d["url"].as_str(),
                ),
                _ => continue,
            },
            _ => continue,
        };
        let key = (text.to_string(), source.unwrap_or("").to_string());
        if let Some(&i) = seen.get(&key) {
            console[i]["count"] = json!(console[i]["count"].as_u64().unwrap_or(1) + 1);
            repeats += 1;
            continue;
        }
        seen.insert(key, console.len());
        console_at.push(event.timestamp);
        let mut entry =
            json!({ "atMs": at(event.timestamp), "level": level, "text": text, "count": 1 });
        if let Some(source) = source.filter(|s| !s.is_empty()) {
            entry["source"] = json!(source);
        }
        console.push(entry);
    }

    // Steps: the person's actions and words, in time order.
    struct Draft {
        at: i64,
        value: Value,
        acts: bool,
    }
    let mut drafts: Vec<Draft> = Vec::new();
    for action in evidence
        .actions
        .iter()
        .filter(|a| a.kind != ActionKind::Scroll)
    {
        drafts.push(Draft {
            at: action.timestamp,
            value: action_step(action),
            acts: true,
        });
    }
    for note in &review.voice {
        for segment in &note.segments {
            let t = note.started_at + segment.start_ms;
            if t < start - 60_000 || t > end + 5_000 || !kept(item, t) {
                continue;
            }
            let mut step = json!({ "kind": "say", "value": segment.text.trim() });
            if segment.corrected {
                step["corrected"] = json!(true);
            }
            // What "this" and "here" meant: the elements under the pointer while the person spoke.
            let pointed = crate::protocol::pointed_at(
                &item.pointing,
                t - 500,
                note.started_at + segment.end_ms.max(segment.start_ms) + 300,
                2,
            );
            if !pointed.is_empty() {
                step["pointing"] = json!(pointed);
            }
            drafts.push(Draft {
                at: t,
                value: step,
                acts: false,
            });
        }
    }
    // A page load without a navigation step of its own starts one: what the page showed.
    for note in item.screen.iter().filter(|s| !s.after_click) {
        if drafts
            .iter()
            .any(|d| d.value["kind"] == "navigate" && (d.at - note.at).abs() <= 3000)
        {
            continue;
        }
        let url = evidence
            .actions
            .iter()
            .rev()
            .find(|a| a.timestamp <= note.at)
            .map_or(item.page_url.clone(), |a| a.url.clone());
        drafts.push(Draft {
            at: note.at,
            value: json!({ "kind": "navigate", "url": url }),
            acts: true,
        });
    }
    drafts.sort_by_key(|d| d.at);

    let shots: Vec<Value> = item
        .shots
        .iter()
        .enumerate()
        .map(|(k, shot)| {
            json!({
                "id": format!("shot-{}", k + 1), "atMs": at(shot.at),
                "file": format!("capture-{n}-shot-{}.webp", k + 1), "sha256": shot.image.sha256,
                "contentType": "image/webp", "reason": shot.reason,
            })
        })
        .chain(files_end_screenshot(item).then(|| {
            json!({
                "id": "end", "atMs": at(end), "file": format!("capture-{n}.png"),
                "sha256": item.screenshot.sha256, "contentType": "image/png", "reason": "end",
            })
        }))
        .collect();

    let mut steps: Vec<Value> = Vec::new();
    let mut counters: HashMap<usize, usize> = HashMap::new();
    let mut ids: HashMap<String, String> = HashMap::new();
    let mut linked: HashMap<String, bool> = HashMap::new();
    for (i, draft) in drafts.iter().enumerate() {
        let seq = i + 1;
        let mut step = draft.value.clone();
        step["seq"] = json!(seq);
        step["atMs"] = json!(at(draft.at));
        if draft.acts {
            let until = drafts
                .get(i + 1)
                .map_or(i64::MAX, |d| d.at)
                .min(draft.at + STEP_WINDOW_MS);
            let window = |t: i64| t >= draft.at && t < until;
            // Only what the person did changes the screen: clicks, keys, choices, checks.
            let caused = matches!(
                step["kind"].as_str(),
                Some("click" | "press" | "select" | "check" | "uncheck")
            );
            let requests: Vec<String> = net
                .iter()
                .filter(|e| window(e.at))
                .map(|e| {
                    let n = counters.entry(seq).or_default();
                    *n += 1;
                    let id = format!("s{seq}r{n}");
                    ids.insert(e.request_id.clone(), id.clone());
                    linked.insert(e.request_id.clone(), true);
                    id
                })
                .collect();
            if !requests.is_empty() {
                step["requests"] = json!(requests);
            }
            let logs: Vec<usize> = console_at
                .iter()
                .enumerate()
                .filter(|(_, t)| window(**t))
                .map(|(i, _)| i)
                .collect();
            if !logs.is_empty() {
                step["console"] = json!(logs);
            }
            if let Some(note) = item
                .screen
                .iter()
                .find(|s| s.after_click && caused && window(s.at))
            {
                step["screen"] = json!({ "appeared": note.appeared, "gone": note.gone });
            } else if step["kind"] == "navigate"
                && let Some(note) = item
                    .screen
                    .iter()
                    .find(|s| !s.after_click && (s.at - draft.at).abs() <= 3000)
            {
                step["screen"] = json!({ "appeared": note.appeared, "gone": [] });
            }
            if let Some(shot) = shots.iter().find(|s| {
                s["reason"] == "step"
                    && (s["atMs"].as_i64().unwrap_or(0) + start) > draft.at
                    && s["atMs"].as_i64().unwrap_or(0) + start - draft.at <= SHOT_WINDOW_MS
            }) {
                step["shot"] = shot["id"].clone();
            }
        }
        steps.push(step);
    }
    let mut before = 0;
    let network: Vec<Value> = net
        .iter()
        .map(|e| {
            let id = ids.get(&e.request_id).cloned().unwrap_or_else(|| {
                before += 1;
                format!("s0r{before}")
            });
            let mut entry = json!({
                "id": id, "atMs": at(e.at), "method": e.method, "url": e.url,
                "status": e.status, "durationMs": e.ended.map(|t| t - e.at),
            });
            if let Some(failure) = &e.failure {
                entry["failure"] = json!(failure);
            }
            // Bodies of failures, and of the page's own calls a step started.
            let wanted = failed(e) || linked.get(&e.request_id).copied().unwrap_or(false);
            let json_like = |b: &str| {
                b.len() <= MAX_BODY && matches!(b.trim_start().chars().next(), Some('{' | '['))
            };
            if wanted {
                if let Some(body) = e.request_body.as_deref().filter(|b| json_like(b)) {
                    entry["requestBody"] = json!(body);
                }
                if let Some(body) = e.response_body.as_deref().filter(|b| json_like(b)) {
                    entry["responseBody"] = json!(body);
                }
            }
            entry
        })
        .collect();

    let annotations: Vec<Value> = item
        .annotations
        .iter()
        .map(|a| annotation(a, at(a.at), &shots, start))
        .collect();
    let (findings, notes) = findings(review, item);

    json!({
        "version": 1,
        "producer": { "name": "sirv-lens", "version": env!("CARGO_PKG_VERSION") },
        "capture": {
            "id": uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_OID, format!("lens-capture:{}:{}", item.capture, item.captured_at).as_bytes()).to_string(),
            "kind": if item.kind == crate::protocol::CaptureKind::Session { "session" } else { "moment" },
            "startedAt": crate::repro::iso_time(start),
            "durationMs": end - start,
            "page": { "url": item.page_url, "title": item.page_title, "buildSha": page["buildId"].as_str() },
            "viewport": if page["viewport"].is_object() { json!({
                "width": page["viewport"]["width"], "height": page["viewport"]["height"],
                "devicePixelRatio": page["viewport"]["devicePixelRatio"],
            }) } else { Value::Null },
            "colorScheme": page["colorScheme"].as_str(),
            "locale": page["language"].as_str(),
            "timeZone": page["timeZone"].as_str(),
            "userAgent": page["userAgent"].as_str(),
            "collection": match item.mode { CaptureMode::Deep => "deep", CaptureMode::Limited => "limited", CaptureMode::ScreenshotOnly => "screenshotOnly" },
        },
        "findings": findings,
        "notes": notes,
        "steps": steps,
        "annotations": annotations,
        "network": network,
        "console": console,
        "shots": shots,
        "recording": item.recording.as_ref().map(|r| json!({
            "file": format!("capture-{n}.rrweb.json"), "sha256": r.sha256, "size": r.size,
            "rrweb": "2.2.2", "recordCanvas": false, "maskAllInputs": true,
        })),
        "dropped": {
            "requests": dropped,
            "consoleRepeats": repeats,
            "cut": item.cut,
            "truncated": { "bodies": 0, "screenItems": 0, "steps": 0, "shots": 0 },
        },
    })
}

fn kept(item: &ReviewItem, at: i64) -> bool {
    item.kept.is_empty() || item.kept.iter().any(|r| at >= r.from && at <= r.to)
}

fn first_time(evidence: &Evidence) -> Option<i64> {
    let actions = evidence.actions.iter().map(|a| a.timestamp);
    let events = evidence.events.iter().map(|e| e.timestamp);
    actions.chain(events).min()
}

fn action_step(action: &Action) -> Value {
    let kind = match action.kind {
        ActionKind::Click => "click",
        ActionKind::Fill => "fill",
        ActionKind::Press => "press",
        ActionKind::Select => "select",
        ActionKind::Check => "check",
        ActionKind::Uncheck => "uncheck",
        ActionKind::Upload => "upload",
        ActionKind::Navigate => "navigate",
        ActionKind::Scroll => "scroll",
    };
    let mut step = json!({ "kind": kind });
    if action.kind == ActionKind::Navigate {
        step["url"] = json!(action.url);
    }
    if let Some(target) = &action.target {
        step["target"] = locator(target);
    }
    if action.masked {
        step["masked"] = json!(true);
    } else if let Some(value) = &action.value {
        step["value"] = json!(value);
    }
    step
}

fn locator(l: &Locator) -> Value {
    json!({ "testId": l.test_id, "role": l.role, "name": l.name, "nth": l.nth, "text": l.text, "css": l.css })
}

fn annotation(a: &Annotation, at: i64, shots: &[Value], start: i64) -> Value {
    // Highlight stores the element's box as one closed four-corner line.
    let highlight = a.drawing.len() == 1
        && a.drawing[0].len() == 5
        && a.drawing[0].first() == a.drawing[0].last();
    let kind = if a.drawing.is_empty() {
        "note"
    } else if highlight {
        "highlight"
    } else {
        "drawing"
    };
    let mut value = json!({
        "id": a.id, "atMs": at, "text": a.text, "kind": kind,
        "elements": a.elements.iter().map(locator).collect::<Vec<_>>(),
    });
    if let Some(shot) = shots
        .iter()
        .min_by_key(|s| (s["atMs"].as_i64().unwrap_or(0) - at).abs())
        .filter(|s| (s["atMs"].as_i64().unwrap_or(0) - at).abs() <= 5000)
    {
        value["shot"] = shot["id"].clone();
    }
    let _ = start;
    value
}

/// The findings and the person's own notes, from the review's notes.
fn findings(review: &Review, item: &ReviewItem) -> (Value, String) {
    let mut lines = review.notes.lines().peekable();
    let mut items = Vec::new();
    let model = lines.peek().is_some_and(|l| l.trim() == FINDINGS_HEADER);
    if model {
        lines.next();
        while let Some(line) = lines.peek().and_then(|l| l.trim_start().strip_prefix("- ")) {
            let text = unescape(line.trim());
            let (kind, text) = if let Some(rest) = text.strip_prefix("Works well:") {
                ("praise", rest.trim().to_string())
            } else if let Some(rest) = text.strip_prefix("Question:") {
                ("question", rest.trim().to_string())
            } else {
                ("defect", text)
            };
            items.push(json!({ "text": text, "kind": kind, "atMs": null }));
            lines.next();
        }
    }
    let notes = lines.collect::<Vec<_>>().join("\n").trim().to_string();
    let _ = item;
    (
        json!({
            "title": review.title,
            "items": items,
            "writtenBy": if model { "model" } else { "person" },
            // The review page showed them before the person created the review. Nothing says the
            // person checked them: a reader must not treat them as confirmed.
            "shownToPerson": true,
        }),
        notes,
    )
}

/// Undoes Markdown escaping: `\[` is `[`.
fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && chars.peek().is_some_and(|n| n.is_ascii_punctuation()) {
            out.push(chars.next().expect("peeked"));
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        BlobRef, CaptureKind, EvidenceEvent, ReviewVoice, ScreenNote, Shot, TimeRange, VoiceSegment,
    };

    fn blob(c: char) -> BlobRef {
        BlobRef {
            sha256: c.to_string().repeat(64),
            size: 3,
            media_type: String::new(),
        }
    }

    fn sample() -> (Review, ReviewItem, Evidence) {
        let pay = Locator {
            test_id: None,
            role: Some("button".into()),
            name: Some("Pay".into()),
            nth: None,
            text: None,
            css: "button".into(),
        };
        let empty = Locator {
            test_id: None,
            role: None,
            name: None,
            nth: None,
            text: Some("No comments yet.".into()),
            css: "div.empty".into(),
        };
        let ev = |t: i64, kind: &str, data: Value| EvidenceEvent {
            timestamp: t,
            kind: kind.into(),
            data,
        };
        let evidence = Evidence {
            mode: CaptureMode::Deep,
            gaps: vec![],
            page: Some(
                json!({ "viewport": { "width": 1280, "height": 800, "devicePixelRatio": 1 }, "language": "en", "timeZone": "Europe/Podgorica", "colorScheme": "dark", "userAgent": "UA", "buildId": "next:abc" }),
            ),
            actions: vec![
                Action {
                    timestamp: 1100,
                    kind: ActionKind::Click,
                    url: "https://s.test/a".into(),
                    target: Some(empty),
                    value: None,
                    masked: false,
                },
                Action {
                    timestamp: 2000,
                    kind: ActionKind::Click,
                    url: "https://s.test/a".into(),
                    target: Some(pay),
                    value: None,
                    masked: false,
                },
                Action {
                    timestamp: 2500,
                    kind: ActionKind::Fill,
                    url: "https://s.test/a".into(),
                    target: None,
                    value: None,
                    masked: true,
                },
            ],
            elements: vec![],
            dropped: [("analytics".to_string(), 3)].into(),
            events: vec![
                ev(
                    1000,
                    "request",
                    json!({ "requestId": "1", "url": "https://s.test/app.js", "method": "GET", "resourceType": "Script" }),
                ),
                ev(1010, "response", json!({ "requestId": "1", "status": 200 })),
                ev(
                    2010,
                    "request",
                    json!({ "requestId": "2", "url": "https://s.test/api/price", "method": "POST", "resourceType": "Fetch", "postData": "{\"coupon\":\"X\"}" }),
                ),
                ev(2050, "response", json!({ "requestId": "2", "status": 200 })),
                ev(
                    2051,
                    "responseBody",
                    json!({ "requestId": "2", "format": "json", "body": { "total": null } }),
                ),
                ev(
                    2060,
                    "console",
                    json!({ "level": "error", "text": "total is NaN" }),
                ),
                ev(
                    2070,
                    "console",
                    json!({ "level": "error", "text": "total is NaN" }),
                ),
                ev(
                    2080,
                    "request",
                    json!({ "requestId": "3", "url": "https://s.test/api/x", "method": "OPTIONS", "resourceType": "Preflight" }),
                ),
            ],
        };
        let item = ReviewItem {
            capture: 7,
            page_url: "https://s.test/a".into(),
            page_title: "Assets".into(),
            mode: CaptureMode::Deep,
            screenshot: blob('e'),
            evidence: blob('f'),
            recording: Some(blob('r')),
            findings: vec![],
            marks: vec![],
            kind: CaptureKind::Session,
            kept: vec![TimeRange {
                from: 1000,
                to: 3000,
            }],
            annotations: vec![Annotation {
                id: "n1".into(),
                at: 2100,
                text: "should say the total".into(),
                drawing: vec![vec![
                    crate::protocol::Point { x: 0.0, y: 0.0 },
                    crate::protocol::Point { x: 9.0, y: 0.0 },
                    crate::protocol::Point { x: 9.0, y: 9.0 },
                    crate::protocol::Point { x: 0.0, y: 9.0 },
                    crate::protocol::Point { x: 0.0, y: 0.0 },
                ]],
                elements: vec![],
            }],
            pointing: vec![],
            screen: vec![
                ScreenNote {
                    at: 1000,
                    text: String::new(),
                    appeared: vec!["Comments".into()],
                    gone: vec![],
                    after_click: false,
                },
                ScreenNote {
                    at: 2001,
                    text: String::new(),
                    appeared: vec!["Total: NaN".into()],
                    gone: vec!["Pay".into()],
                    after_click: true,
                },
            ],
            shots: vec![Shot {
                at: 2700,
                image: blob('s'),
                reason: "step".into(),
            }],
            cut: 4,
            shots_dropped: 0,
            captured_at: 3000,
            started_at: 1000,
        };
        let review = Review {
            id: 1,
            observation: 1,
            revision: 1,
            created_at: 3001,
            title: "Checkout: total shows NaN".into(),
            notes: format!(
                "{FINDINGS_HEADER}\n- The total shows NaN \\(after Pay\\)\n- Works well: the 3D view\n\nI was on staging."
            ),
            tags: vec![],
            items: vec![],
            voice: vec![ReviewVoice {
                started_at: 900,
                duration_ms: 3000,
                language: Some("en".into()),
                segments: vec![VoiceSegment {
                    start_ms: 500,
                    end_ms: 900,
                    text: "it says NaN".into(),
                    corrected: true,
                }],
            }],
        };
        (review, item, evidence)
    }

    #[test]
    fn the_record_holds_steps_findings_and_links() {
        let (review, item, evidence) = sample();
        let record: Value =
            serde_json::from_slice(&build(&review, &item, 1, &evidence).unwrap()).unwrap();
        assert_eq!(record["version"], 1);
        assert_eq!(record["capture"]["page"]["buildSha"], "next:abc");
        assert_eq!(record["capture"]["durationMs"], 2000);
        assert_eq!(record["findings"]["writtenBy"], "model");
        assert_eq!(
            record["findings"]["items"][0]["text"],
            "The total shows NaN (after Pay)"
        );
        assert_eq!(record["findings"]["items"][1]["kind"], "praise");
        assert_eq!(record["notes"], "I was on staging.");
        let kinds: Vec<&str> = record["steps"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["navigate", "click", "say", "click", "fill"]);
        let navigate = &record["steps"][0];
        assert_eq!(navigate["screen"]["appeared"][0], "Comments");
        let empty_click = &record["steps"][1];
        assert_eq!(empty_click["target"]["text"], "No comments yet.");
        assert_eq!(record["steps"][2]["corrected"], true);
        let pay = &record["steps"][3];
        assert_eq!(pay["screen"]["gone"][0], "Pay");
        assert_eq!(pay["requests"][0], "s4r1");
        assert_eq!(pay["shot"], "shot-1");
        assert_eq!(pay["console"][0], 0);
        assert_eq!(record["steps"][4]["masked"], true);
        // The script's success and the preflight are left out and counted.
        assert_eq!(record["network"].as_array().unwrap().len(), 1);
        assert_eq!(record["network"][0]["responseBody"], "{\"total\":null}");
        assert_eq!(record["dropped"]["requests"]["static-asset"], 1);
        assert_eq!(record["dropped"]["requests"]["preflight"], 1);
        assert_eq!(record["dropped"]["requests"]["analytics"], 3);
        assert_eq!(record["dropped"]["consoleRepeats"], 1);
        assert_eq!(record["console"][0]["count"], 2);
        assert_eq!(record["dropped"]["cut"], 4);
        assert_eq!(record["annotations"][0]["kind"], "highlight");
        // A recording files no screenshot of the page at Stop.
        assert!(
            record["shots"]
                .as_array()
                .unwrap()
                .iter()
                .all(|s| s["reason"] != "end")
        );
        assert_eq!(record["recording"]["file"], "capture-1.rrweb.json");
    }

    #[test]
    fn success_bodies_go_first_and_failures_keep_theirs() {
        let (review, item, mut evidence) = sample();
        let ev = |t: i64, kind: &str, data: Value| EvidenceEvent {
            timestamp: t,
            kind: kind.into(),
            data,
        };
        let body = json!({ "rows": "y".repeat(7000) });
        for i in 0..20 {
            let id = format!("b{i}");
            evidence.events.push(ev(2001, "request", json!({ "requestId": id, "url": "https://s.test/api/list", "method": "GET", "resourceType": "Fetch" })));
            evidence.events.push(ev(
                2002,
                "response",
                json!({ "requestId": id, "status": 200 }),
            ));
            evidence.events.push(ev(
                2003,
                "responseBody",
                json!({ "requestId": id, "format": "json", "body": body }),
            ));
        }
        evidence.events.push(ev(2004, "request", json!({ "requestId": "bad", "url": "https://s.test/api/save", "method": "POST", "resourceType": "Fetch" })));
        evidence.events.push(ev(
            2005,
            "response",
            json!({ "requestId": "bad", "status": 500 }),
        ));
        evidence.events.push(ev(
            2006,
            "responseBody",
            json!({ "requestId": "bad", "format": "json", "body": { "error": "boom" } }),
        ));
        let record: Value =
            serde_json::from_slice(&build(&review, &item, 1, &evidence).unwrap()).unwrap();
        assert!(
            record["dropped"]["truncated"]["bodies"].as_u64().unwrap() > 0,
            "{}",
            record["dropped"]
        );
        assert_eq!(
            record["dropped"]["truncated"]["steps"], 0,
            "steps stay while bodies can go"
        );
        let failure = record["network"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["status"] == 500)
            .unwrap();
        assert_eq!(failure["responseBody"], "{\"error\":\"boom\"}");
    }

    #[test]
    fn shots_share_the_file_budget() {
        let (_, item, _) = sample();
        let shot = |at| Shot {
            at,
            image: blob('s'),
            reason: "step".into(),
        };
        let mut a = item.clone();
        a.shots = (0..40).map(shot).collect();
        let mut b = item;
        b.shots = (0..20).map(shot).collect();
        let mut items = [a, b];
        share_shots(&mut items, 30);
        assert_eq!((items[0].shots.len(), items[1].shots.len()), (20, 10));
        assert_eq!((items[0].shots_dropped, items[1].shots_dropped), (20, 10));
        assert_eq!(items[0].shots[1].at, 2, "evenly spaced");
    }

    #[test]
    fn a_large_record_loses_screen_text_then_old_steps() {
        let (review, mut item, mut evidence) = sample();
        let big: Vec<String> = (0..25)
            .map(|i| format!("{i} {}", "x".repeat(100)))
            .collect();
        for i in 0..3000 {
            evidence.actions.push(Action {
                timestamp: 4000 + i,
                kind: ActionKind::Click,
                url: "https://s.test/a".into(),
                target: None,
                value: None,
                masked: false,
            });
            item.screen.push(ScreenNote {
                at: 4000 + i,
                text: String::new(),
                appeared: big.clone(),
                gone: vec![],
                after_click: true,
            });
        }
        item.kept.clear();
        let bytes = build(&review, &item, 1, &evidence).unwrap();
        assert!(bytes.len() <= LIMIT_BYTES * 2, "{}", bytes.len());
        let record: Value = serde_json::from_slice(&bytes).unwrap();
        assert!(
            record["dropped"]["truncated"]["screenItems"]
                .as_u64()
                .unwrap()
                > 0
        );
    }
}
