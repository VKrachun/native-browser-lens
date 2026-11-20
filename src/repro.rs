//! What an agent needs to reproduce a capture: one timeline of the person's steps and what the
//! page did, a Playwright test that repeats the steps, and a HAR file of the recorded server
//! answers. Everything here comes from the evidence, which a website wrote: generated code holds
//! page text only inside JSON string literals and one-line comments, so a page cannot add code.
use crate::protocol::{
    Action, ActionKind, Annotation, Evidence, Locator, MarkTarget, PageElement, ReviewVoice,
    ScreenNote, Shape, TimeRange,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fmt::Write as _;

/// Most actions and elements a capture keeps; the collector sends fewer.
pub const MAX_ACTIONS: usize = 500;
pub const MAX_ELEMENTS: usize = 800;
/// A URL change this soon after a click or a key press is that step's result, not a new visit.
const CAUSED_NAVIGATION_MS: i64 = 5000;

/// One line of the timeline.
struct Entry {
    timestamp: i64,
    text: String,
    /// The action it describes, for the test; None for what the page did or the person said.
    action: Option<Action>,
    source: Source,
}

#[derive(Clone, Copy, PartialEq)]
enum Source {
    Page,
    /// Words from the person's voice notes.
    Said,
    /// A note the person added in the review, with what it points at.
    Noted,
    /// What the screen showed, from the DOM recording.
    Screen,
}

/// What the person added to a recording: their words, their notes, and the parts that stay.
#[derive(Default)]
pub struct Context<'a> {
    pub voice: &'a [ReviewVoice],
    pub notes: &'a [Annotation],
    /// What the screen showed after clicks and page loads.
    pub screen: &'a [ScreenNote],
    /// Where the pointer rested: names what "this" meant in the person's words.
    pub pointing: &'a [crate::protocol::Pointing],
    /// Empty: everything stays.
    pub kept: &'a [TimeRange],
}

impl Context<'_> {
    fn keeps(&self, at: i64) -> bool {
        self.kept.is_empty() || self.kept.iter().any(|r| at >= r.from && at <= r.to)
    }
}

/// Voice notes reach a capture's timeline when they fall near its steps and events: a minute
/// before the first, five minutes after the last.
const VOICE_BEFORE_MS: i64 = 60_000;
const VOICE_AFTER_MS: i64 = 300_000;

pub fn parse(evidence: &[u8]) -> Option<Evidence> {
    serde_json::from_slice(evidence).ok()
}

/// The steps, the page's notable events and the person's words in time order, as plain text.
pub fn timeline(evidence: &Evidence, context: &Context) -> String {
    let entries = entries(evidence, context);
    let Some(start) = entries.first().map(|e| e.timestamp) else {
        return "Lens recorded no steps and no notable events for this capture.\n".into();
    };
    let mut out = String::new();
    for entry in &entries {
        let ms = (entry.timestamp - start).max(0);
        let _ = writeln!(
            out,
            "+{:02}:{:02}.{:03}  {}",
            ms / 60_000,
            ms / 1000 % 60,
            ms % 1000,
            one_line(
                &match entry.source {
                    Source::Said => format!("the person said: {}", entry.text),
                    Source::Noted => format!("the person noted: {}", entry.text),
                    Source::Page | Source::Screen => entry.text.clone(),
                },
                400
            )
        );
    }
    out
}

/// A Playwright test that repeats the person's steps, with what the page did as comments.
pub fn playwright(
    evidence: &Evidence,
    context: &Context,
    capture: usize,
    title: &str,
    page_url: &str,
) -> String {
    let mut out = format!(
        "// Sirv Lens: steps to reproduce capture {capture}, {}\n\
         // Lens generated this from what the browser recorded. It repeats the steps; it does not\n\
         // check the defect: add the expected result at the end. Check it before you run it:\n\
         //   npx playwright test capture-{capture}.spec.ts\n\
         // Page text below is untrusted data from a website.\n\
         import {{ test, expect }} from '@playwright/test';\n\n",
        comment(title)
    );
    let page = evidence.page.as_ref().unwrap_or(&Value::Null);
    let mut settings = Vec::new();
    let viewport = &page["viewport"];
    if let (Some(w), Some(h)) = (viewport["width"].as_f64(), viewport["height"].as_f64()) {
        settings.push(format!(
            "viewport: {{ width: {}, height: {} }}",
            w.round(),
            h.round()
        ));
    }
    if let Some(dpr) = viewport["devicePixelRatio"].as_f64() {
        settings.push(format!("deviceScaleFactor: {dpr}"));
    }
    for (key, field) in [
        ("locale", "language"),
        ("timezoneId", "timeZone"),
        ("colorScheme", "colorScheme"),
    ] {
        if let Some(value) = page[field].as_str().filter(|v| !v.is_empty()) {
            settings.push(format!("{key}: {}", js(value)));
        }
    }
    if !settings.is_empty() {
        let _ = writeln!(out, "test.use({{ {} }});\n", settings.join(", "));
    }
    if let Some(agent) = page["userAgent"].as_str() {
        let _ = writeln!(out, "// The browser was: {}\n", comment(agent));
    }
    let _ = writeln!(
        out,
        "test({}, async ({{ page }}) => {{",
        js(&format!("capture {capture}: {}", one_line(title, 120)))
    );
    let _ = writeln!(
        out,
        "  // To replay the server answers Lens recorded instead of the live server:\n  \
         // await page.routeFromHAR('capture-{capture}.har', {{ notFound: 'fallback' }});"
    );

    let entries = entries(evidence, context);
    let mut current: Option<String> = None;
    let mut last_step: Option<(i64, ActionKind)> = None;
    for entry in &entries {
        let Some(action) = &entry.action else {
            let source = match entry.source {
                Source::Said => "The person said",
                Source::Noted => "The person noted",
                Source::Screen => "On screen",
                Source::Page => "Lens recorded",
            };
            let _ = writeln!(out, "  // {source}: {}", comment(&entry.text));
            continue;
        };
        if current.as_deref() != Some(action.url.as_str()) {
            let caused = last_step.is_some_and(|(at, kind)| {
                matches!(kind, ActionKind::Click | ActionKind::Press)
                    && action.timestamp - at <= CAUSED_NAVIGATION_MS
            });
            if action.url.contains("[REDACTED]") {
                let _ = writeln!(
                    out,
                    "  // Lens redacted part of the next URL; put the real value back."
                );
            }
            let _ = writeln!(
                out,
                "{}",
                navigation(&action.url, caused && current.is_some())
            );
            current = Some(action.url.clone());
        }
        if action.kind != ActionKind::Navigate {
            step(&mut out, action);
            last_step = Some((action.timestamp, action.kind));
        }
    }
    if current.is_none() {
        let _ = writeln!(out, "{}", navigation(page_url, false));
    }
    let _ = writeln!(
        out,
        "  // The person captured the defect here. Compare with capture-{capture}.png.\n  \
         await page.screenshot({{ path: 'capture-{capture}-reproduced.png' }});\n  \
         // Add the expected result, for example:\n  \
         // await expect(page.getByRole('status')).toHaveText('…');\n\
         }});"
    );
    out
}

/// How a test reaches `url`. After a click or a key, the page usually gets there itself: wait for
/// it. Timing alone cannot tell (the person may have typed an address after opening a menu), so a
/// wait that sees no navigation goes there after five seconds instead of failing.
pub fn navigation(url: &str, caused: bool) -> String {
    if caused {
        format!(
            "  await page.waitForURL({0}, {{ timeout: 5000 }}).catch(() => page.goto({0}));",
            js(url)
        )
    } else {
        format!("  await page.goto({});", js(url))
    }
}

/// The URL a `navigation` line goes to, and whether it waits for the page to get there itself.
pub fn navigation_target(line: &str) -> Option<(String, bool)> {
    let (rest, caused) = match line.strip_prefix("  await page.goto(") {
        Some(rest) => (rest, false),
        None => (line.strip_prefix("  await page.waitForURL(")?, true),
    };
    let url = serde_json::Deserializer::from_str(rest)
        .into_iter::<String>()
        .next()?
        .ok()?;
    Some((url, caused))
}

/// The start of each step a test cannot repeat, so a check can count them.
pub const SKIPPED_STEP: &str = "// Skipped step: ";

fn step(out: &mut String, action: &Action) {
    let target = action.target.as_ref().map(locator);
    let value = action.value.as_deref().unwrap_or("");
    let line = match (action.kind, &target) {
        (ActionKind::Click, Some(t)) => format!("await {t}.click();"),
        (ActionKind::Fill, Some(t)) if action.masked => format!(
            "await {t}.fill(''); // The person typed a private value here: type a valid one."
        ),
        (ActionKind::Fill, Some(t)) => format!("await {t}.fill({});", js(value)),
        (ActionKind::Press, Some(t)) => format!("await {t}.press({});", js(value)),
        (ActionKind::Press, None) => format!("await page.keyboard.press({});", js(value)),
        (ActionKind::Select, Some(t)) if action.masked => {
            format!(
                "{SKIPPED_STEP}{}",
                comment(&format!("the person chose a private option in {t}."))
            )
        }
        (ActionKind::Select, Some(t)) => {
            format!("await {t}.selectOption({{ label: {} }});", js(value))
        }
        (ActionKind::Check, Some(t)) => format!("await {t}.check();"),
        (ActionKind::Uncheck, Some(t)) => format!("await {t}.uncheck();"),
        (ActionKind::Upload, Some(t)) => format!(
            "{SKIPPED_STEP}{}",
            comment(&format!(
                "the person chose files here ({value}): await {t}.setInputFiles([...]);"
            ))
        ),
        (ActionKind::Scroll, _) => match value.parse::<f64>() {
            Ok(y) if y.is_finite() => {
                format!("await page.evaluate(() => window.scrollTo(0, {y}));")
            }
            _ => return,
        },
        _ => format!(
            "{SKIPPED_STEP}Lens could not locate it: {}",
            comment(&describe(action))
        ),
    };
    let _ = writeln!(out, "  {line}");
}

/// A Playwright locator expression: test ID, then role and name, then text, then CSS.
fn locator(l: &Locator) -> String {
    if let Some(id) = &l.test_id {
        return format!("page.getByTestId({})", js(id));
    }
    if let (Some(role), Some(name)) = (&l.role, &l.name) {
        let mut out = format!(
            "page.getByRole({}, {{ name: {}, exact: true }})",
            js(role),
            js(name)
        );
        if let Some(n) = l.nth {
            let _ = write!(out, ".nth({n})");
        }
        return out;
    }
    if let Some(text) = &l.text {
        return format!("page.getByText({}, {{ exact: true }}).first()", js(text));
    }
    format!("page.locator({})", js(&l.css))
}

/// A short human description of a locator, for the timeline.
fn describe_locator(l: &Locator) -> String {
    if let Some(id) = &l.test_id {
        return format!("[data-testid={}]", js(id));
    }
    match (&l.role, &l.name, &l.text) {
        (Some(role), Some(name), _) => format!("{role} {}", js(name)),
        (_, _, Some(text)) => format!("text {}", js(text)),
        _ => format!("element {}", js(&l.css)),
    }
}

fn describe(action: &Action) -> String {
    let target = action
        .target
        .as_ref()
        .map(describe_locator)
        .unwrap_or_else(|| "the page".into());
    let value = action.value.as_deref().unwrap_or("");
    match action.kind {
        ActionKind::Click => format!("click {target}"),
        ActionKind::Fill if action.masked => format!("type a private value into {target}"),
        ActionKind::Fill => format!("type {} into {target}", js(value)),
        ActionKind::Press => format!("press {value} in {target}"),
        ActionKind::Select if action.masked => format!("choose a private option in {target}"),
        ActionKind::Select => format!("choose {} in {target}", js(value)),
        ActionKind::Check => format!("check {target}"),
        ActionKind::Uncheck => format!("uncheck {target}"),
        ActionKind::Upload => format!("choose files ({value}) in {target}"),
        ActionKind::Scroll => format!("scroll to y={value}"),
        ActionKind::Navigate => format!("go to {}", action.url),
    }
}

/// The person's steps and the page's notable events, oldest first. Requests appear only when they
/// failed or came from the page's own code (fetch, XHR) or loaded a document.
fn entries(evidence: &Evidence, context: &Context) -> Vec<Entry> {
    let mut entries: Vec<Entry> = evidence
        .actions
        .iter()
        .map(|a| Entry {
            timestamp: a.timestamp,
            text: describe(a),
            action: Some(a.clone()),
            source: Source::Page,
        })
        .collect();
    let mut requests: HashMap<&str, (&str, &str)> = HashMap::new();
    for event in &evidence.events {
        let data = &event.data;
        let text = |key: &str| data[key].as_str().unwrap_or("");
        let line = match event.kind.as_str() {
            "request" => {
                requests.insert(text("requestId"), (text("method"), text("resourceType")));
                None
            }
            "response" => {
                let (method, kind) = requests.get(text("requestId")).copied().unwrap_or(("", ""));
                let status = data["status"].as_u64().unwrap_or(0);
                let wanted = status >= 400
                    || matches!(
                        kind,
                        "XHR" | "Fetch" | "Document" | "xmlhttprequest" | "main_frame"
                    );
                wanted.then(|| format!("HTTP {status} from {method} {}", text("url")))
            }
            "networkFailure" => Some(format!(
                "request failed: {} {}",
                text("errorText"),
                text("url")
            )),
            "console" => Some(format!("console.{}: {}", text("level"), text("text"))),
            "exception" => Some(format!("exception: {}", text("text"))),
            "log" if matches!(text("level"), "error" | "warning") => {
                Some(format!("browser {}: {}", text("level"), text("text")))
            }
            _ => None,
        };
        if let Some(text) = line {
            entries.push(Entry {
                timestamp: event.timestamp,
                text: text.trim_end().into(),
                action: None,
                source: Source::Page,
            });
        }
    }
    let first = entries.iter().map(|e| e.timestamp).min();
    let last = entries.iter().map(|e| e.timestamp).max();
    for note in context.voice {
        for segment in &note.segments {
            let at = note.started_at + segment.start_ms;
            // The middle of the words decides, as for the transcript (see record::spoken_in_kept).
            if !context.keeps(note.started_at + (segment.start_ms + segment.end_ms) / 2) {
                continue;
            }
            let near = match (first, last) {
                (Some(first), Some(last)) => {
                    at >= first - VOICE_BEFORE_MS && at <= last + VOICE_AFTER_MS
                }
                _ => true,
            };
            if near {
                let pointed = crate::protocol::pointed_at(
                    context.pointing,
                    at - 500,
                    note.started_at + segment.end_ms.max(segment.start_ms) + 300,
                    2,
                );
                let text = segment.text.trim();
                entries.push(Entry {
                    timestamp: at,
                    text: if pointed.is_empty() {
                        text.into()
                    } else {
                        format!("{text} (pointing at {})", pointed.join(", then "))
                    },
                    action: None,
                    source: Source::Said,
                });
            }
        }
    }
    for note in context.screen.iter().filter(|n| context.keeps(n.at)) {
        entries.push(Entry {
            timestamp: note.at,
            text: note.text.clone(),
            action: None,
            source: Source::Screen,
        });
    }
    for note in context.notes.iter().filter(|n| context.keeps(n.at)) {
        let on: Vec<String> = note.elements.iter().map(describe_locator).collect();
        let text = match (note.text.trim(), on.is_empty()) {
            (text, true) => text.to_string(),
            ("", false) => format!("marked {}", on.join(", ")),
            (text, false) => format!("{text} (marked {})", on.join(", ")),
        };
        entries.push(Entry {
            timestamp: note.at,
            text,
            action: None,
            source: Source::Noted,
        });
    }
    // Stable: an action and the events it caused keep their recorded order at equal times.
    entries.sort_by_key(|e| e.timestamp);
    entries
}

/// A HAR 1.2 file with every response whose body Lens recorded, for `page.routeFromHAR`.
pub fn har(evidence: &Evidence) -> Value {
    let mut requests: HashMap<&str, &Value> = HashMap::new();
    let mut responses: HashMap<&str, &Value> = HashMap::new();
    let mut entries = Vec::new();
    for event in &evidence.events {
        let id = event.data["requestId"].as_str().unwrap_or("");
        match event.kind.as_str() {
            "request" => {
                requests.insert(id, &event.data);
            }
            "response" => {
                responses.insert(id, &event.data);
            }
            "responseBody" => {
                let (Some(request), Some(response)) = (requests.get(id), responses.get(id)) else {
                    continue;
                };
                let body = &event.data["body"];
                let text = match event.data["format"].as_str() {
                    Some("json") => body.to_string(),
                    Some("text") => body.as_str().unwrap_or("").to_string(),
                    _ => continue,
                };
                let mime = response["mimeType"]
                    .as_str()
                    .unwrap_or("application/octet-stream");
                let mut har_request = json!({
                    "method": request["method"].as_str().unwrap_or("GET"),
                    "url": request["url"],
                    "httpVersion": "HTTP/1.1",
                    "cookies": [], "headers": [], "queryString": [],
                    "headersSize": -1, "bodySize": -1,
                });
                if let Some(post) = request["postData"].as_str() {
                    har_request["postData"] = json!({
                        "mimeType": request["postDataType"].as_str().unwrap_or(""),
                        "text": post,
                    });
                }
                entries.push(json!({
                    "startedDateTime": iso_time(event.timestamp),
                    "time": 0,
                    "request": har_request,
                    "response": {
                        "status": response["status"],
                        "statusText": response["statusText"].as_str().unwrap_or(""),
                        "httpVersion": "HTTP/1.1",
                        "cookies": [],
                        "headers": [{ "name": "content-type", "value": mime }],
                        "content": { "size": text.len(), "mimeType": mime, "text": text },
                        "redirectURL": "",
                        "headersSize": -1,
                        "bodySize": -1,
                    },
                    "cache": {},
                    "timings": { "send": 0, "wait": 0, "receive": 0 },
                }));
            }
            _ => {}
        }
    }
    json!({ "log": {
        "version": "1.2",
        "creator": { "name": "Sirv Lens", "version": env!("CARGO_PKG_VERSION") },
        "entries": entries,
    }})
}

/// What each mark points at. `scale` is screenshot pixels per CSS pixel. Elements under a mask
/// are never named: the mask says the person does not want them to leave.
pub fn mark_targets(shapes: &[Shape], elements: &[PageElement], scale: f64) -> Vec<MarkTarget> {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let boxed = |x: f64, y: f64, w: f64, h: f64| Rect {
        x: x / scale,
        y: y / scale,
        w: w / scale,
        h: h / scale,
    };
    let masks: Vec<Rect> = shapes
        .iter()
        .filter_map(|s| match s {
            Shape::Mask {
                x,
                y,
                width,
                height,
            } => Some(boxed(*x, *y, *width, *height)),
            _ => None,
        })
        .collect();
    let visible: Vec<(&PageElement, Rect)> = elements
        .iter()
        .map(|e| {
            (
                e,
                Rect {
                    x: e.x,
                    y: e.y,
                    w: e.width,
                    h: e.height,
                },
            )
        })
        .filter(|(_, r)| r.w > 0.0 && r.h > 0.0 && !masks.iter().any(|m| m.overlap(r) > 0.0))
        .collect();
    let smallest_at = |x: f64, y: f64| {
        visible
            .iter()
            .filter(|(_, r)| r.contains(x, y))
            .min_by(|a, b| a.1.area().total_cmp(&b.1.area()))
            .map(|(e, _)| e.locator.clone())
    };
    let mut targets = Vec::new();
    for (index, shape) in shapes.iter().enumerate() {
        let (kind, found) = match shape {
            Shape::Mask { .. } => continue,
            Shape::Arrow { to, .. } => (
                "arrow",
                smallest_at(to.x / scale, to.y / scale)
                    .into_iter()
                    .collect(),
            ),
            Shape::Rectangle {
                x,
                y,
                width,
                height,
                ..
            } => (
                "rectangle",
                inside(&visible, boxed(*x, *y, *width, *height), &smallest_at),
            ),
            Shape::Pen { points, .. } => {
                let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
                for p in points {
                    (x0, y0, x1, y1) = (x0.min(p.x), y0.min(p.y), x1.max(p.x), y1.max(p.y));
                }
                if points.is_empty() {
                    continue;
                }
                (
                    "pen",
                    inside(&visible, boxed(x0, y0, x1 - x0, y1 - y0), &smallest_at),
                )
            }
        };
        targets.push(MarkTarget {
            mark: index as u32 + 1,
            kind: kind.into(),
            elements: found,
        });
    }
    targets
}

/// The elements a box surrounds, largest first; else the smallest element under its center.
fn inside(
    visible: &[(&PageElement, Rect)],
    mark: Rect,
    smallest_at: &dyn Fn(f64, f64) -> Option<Locator>,
) -> Vec<Locator> {
    let mut within: Vec<&(&PageElement, Rect)> = visible
        .iter()
        .filter(|(_, r)| mark.overlap(r) >= 0.6 * r.area())
        .collect();
    within.sort_by(|a, b| b.1.area().total_cmp(&a.1.area()));
    let found: Vec<Locator> = within
        .iter()
        .take(5)
        .map(|(e, _)| e.locator.clone())
        .collect();
    if found.is_empty() {
        smallest_at(mark.x + mark.w / 2.0, mark.y + mark.h / 2.0)
            .into_iter()
            .collect()
    } else {
        found
    }
}

#[derive(Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Rect {
    fn area(&self) -> f64 {
        self.w.max(0.0) * self.h.max(0.0)
    }
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.w && y >= self.y && y <= self.y + self.h
    }
    fn overlap(&self, other: &Rect) -> f64 {
        let w = (self.x + self.w).min(other.x + other.w) - self.x.max(other.x);
        let h = (self.y + self.h).min(other.y + other.h) - self.y.max(other.y);
        w.max(0.0) * h.max(0.0)
    }
}

/// The evidence as a review shares it: without the element list. Unless the person chose to share
/// what they typed and the site's data, typed values are masked, request bodies are dropped, and
/// only the bodies of failed responses stay, as before Lens kept API answers.
pub fn for_review(mut evidence: Evidence, typed_values: bool, kept: &[TimeRange]) -> Evidence {
    evidence.elements.clear();
    // What happened in a trimmed or cut part does not leave.
    if !kept.is_empty() {
        let inside = |at: i64| kept.iter().any(|r| at >= r.from && at <= r.to);
        evidence.actions.retain(|a| inside(a.timestamp));
        evidence.events.retain(|e| inside(e.timestamp));
    }
    if typed_values {
        return evidence;
    }
    for action in &mut evidence.actions {
        if matches!(action.kind, ActionKind::Fill | ActionKind::Select) && !action.masked {
            action.value = None;
            action.masked = true;
        }
    }
    let failed: std::collections::HashSet<String> = evidence
        .events
        .iter()
        .filter(|e| e.kind == "response" && e.data["status"].as_u64().unwrap_or(0) >= 400)
        .filter_map(|e| e.data["requestId"].as_str().map(String::from))
        .collect();
    evidence.events.retain(|e| {
        e.kind != "responseBody"
            || e.data["requestId"]
                .as_str()
                .is_some_and(|id| failed.contains(id))
    });
    for event in &mut evidence.events {
        if event.kind == "request"
            && let Some(data) = event.data.as_object_mut()
        {
            data.remove("postData");
            data.remove("postDataType");
        }
    }
    evidence
}

/// Screenshot pixels per CSS pixel: the PNG's width over the viewport's.
pub fn scale(png: &[u8], evidence: &Evidence) -> f64 {
    let width = png
        .get(16..20)
        .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as f64)
        .unwrap_or(0.0);
    let viewport = evidence
        .page
        .as_ref()
        .and_then(|p| p["viewport"]["width"].as_f64())
        .unwrap_or(0.0);
    if width > 0.0 && viewport > 0.0 {
        width / viewport
    } else {
        1.0
    }
}

/// A JavaScript string literal: JSON, with the two line separators escaped as well, so no tool
/// that reads the file can see a line break inside it.
fn js(text: &str) -> String {
    serde_json::to_string(text)
        .expect("strings serialize")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// Text for a `//` comment: one line, no control characters, so it cannot end the comment.
fn comment(text: &str) -> String {
    one_line(text, 300)
}

fn one_line(text: &str, max: usize) -> String {
    let flat: String = text
        .chars()
        .map(|c| {
            if c.is_control() || c == '\u{2028}' || c == '\u{2029}' {
                ' '
            } else {
                c
            }
        })
        .collect();
    let flat = flat.trim();
    if flat.chars().count() <= max {
        flat.into()
    } else {
        flat.chars().take(max).collect::<String>() + "…"
    }
}

/// RFC 3339 in UTC from Unix milliseconds.
pub fn iso_time(ms: i64) -> String {
    let (days, rest) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1000 % 60,
        rest % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{CaptureMode, EvidenceEvent, Point};

    fn button(name: &str) -> Locator {
        Locator {
            test_id: None,
            role: Some("button".into()),
            name: Some(name.into()),
            nth: None,
            text: None,
            css: "button".into(),
        }
    }

    fn action(
        timestamp: i64,
        kind: ActionKind,
        url: &str,
        target: Option<Locator>,
        value: Option<&str>,
    ) -> Action {
        Action {
            timestamp,
            kind,
            url: url.into(),
            target,
            value: value.map(String::from),
            masked: false,
        }
    }

    fn event(timestamp: i64, kind: &str, data: Value) -> EvidenceEvent {
        EvidenceEvent {
            timestamp,
            kind: kind.into(),
            data,
        }
    }

    fn checkout() -> Evidence {
        let field = Locator {
            role: Some("textbox".into()),
            name: Some("Coupon".into()),
            ..button("")
        };
        Evidence {
            mode: CaptureMode::Deep,
            events: vec![
                event(
                    1500,
                    "request",
                    json!({ "requestId": "7", "url": "https://shop.test/api/price", "method": "POST", "resourceType": "Fetch", "postData": "{\"coupon\":\"SAVE10\"}", "postDataType": "application/json" }),
                ),
                event(
                    1600,
                    "response",
                    json!({ "requestId": "7", "url": "https://shop.test/api/price", "status": 500, "mimeType": "application/json" }),
                ),
                event(
                    1601,
                    "responseBody",
                    json!({ "requestId": "7", "format": "json", "body": { "error": "price is NaN" } }),
                ),
                event(
                    1700,
                    "console",
                    json!({ "level": "error", "text": "total is NaN" }),
                ),
            ],
            gaps: vec![],
            page: Some(
                json!({ "viewport": { "width": 640, "height": 480, "devicePixelRatio": 2 }, "language": "en-US" }),
            ),
            actions: vec![
                action(
                    1000,
                    ActionKind::Fill,
                    "https://shop.test/cart",
                    Some(field),
                    Some("SAVE10"),
                ),
                action(
                    1400,
                    ActionKind::Click,
                    "https://shop.test/cart",
                    Some(button("Pay")),
                    None,
                ),
                action(
                    2000,
                    ActionKind::Navigate,
                    "https://shop.test/receipt",
                    None,
                    None,
                ),
            ],
            elements: vec![],
            dropped: Default::default(),
        }
    }

    #[test]
    fn the_timeline_merges_steps_and_failures() {
        let text = timeline(&checkout(), &Context::default());
        assert_eq!(
            text,
            "+00:00.000  type \"SAVE10\" into textbox \"Coupon\"\n\
             +00:00.400  click button \"Pay\"\n\
             +00:00.600  HTTP 500 from POST https://shop.test/api/price\n\
             +00:00.700  console.error: total is NaN\n\
             +00:01.000  go to https://shop.test/receipt\n"
        );
    }

    #[test]
    fn navigation_lines_read_back() {
        for caused in [false, true] {
            let line = navigation("https://shop.test/a?q=\"x\")", caused);
            assert_eq!(
                navigation_target(&line),
                Some(("https://shop.test/a?q=\"x\")".to_string(), caused))
            );
        }
        assert_eq!(navigation_target("  await page.screenshot();"), None);
    }

    #[test]
    fn the_test_repeats_the_steps() {
        let script = playwright(
            &checkout(),
            &Context::default(),
            1,
            "Checkout",
            "https://shop.test/cart",
        );
        for expected in [
            "test.use({ viewport: { width: 640, height: 480 }, deviceScaleFactor: 2, locale: \"en-US\" });",
            "  await page.goto(\"https://shop.test/cart\");",
            "  await page.getByRole(\"textbox\", { name: \"Coupon\", exact: true }).fill(\"SAVE10\");",
            "  await page.getByRole(\"button\", { name: \"Pay\", exact: true }).click();",
            "  // Lens recorded: HTTP 500 from POST https://shop.test/api/price",
            "  await page.waitForURL(\"https://shop.test/receipt\", { timeout: 5000 }).catch(() => page.goto(\"https://shop.test/receipt\"));",
            "await page.screenshot({ path: 'capture-1-reproduced.png' });",
        ] {
            assert!(
                script.contains(expected),
                "missing {expected:?} in\n{script}"
            );
        }
    }

    #[test]
    fn page_text_cannot_become_code() {
        let mut evidence = checkout();
        evidence.actions[1].target =
            Some(button("x\n  await fetch('https://evil.test') //\u{2028}y"));
        evidence.events[3].data =
            json!({ "level": "error", "text": "a\nrequire('child_process').exec('rm -rf ~')" });
        let script = playwright(
            &evidence,
            &Context::default(),
            1,
            "t\n}); evil(); //",
            "https://shop.test/cart",
        );
        for line in script.lines() {
            let code = line.trim_start();
            assert!(
                code.is_empty()
                    || code.starts_with("//")
                    || code.starts_with("await ")
                    || code.starts_with("import ")
                    || code.starts_with("test")
                    || code == "});",
                "unexpected line: {line:?}"
            );
            assert!(
                !code.starts_with("require") && !code.starts_with("evil"),
                "{line:?}"
            );
        }
        // JavaScript ends a line at U+2028 too: no comment may hold one.
        for line in script.lines().filter(|l| l.contains("//")) {
            let after = &line[line.find("//").unwrap()..];
            assert!(!after.contains(['\u{2028}', '\u{2029}']), "{line:?}");
        }
    }

    #[test]
    fn the_persons_words_join_the_timeline_near_the_steps() {
        use crate::protocol::VoiceSegment;
        let note = ReviewVoice {
            started_at: 1300,
            duration_ms: 2000,
            language: Some("en".into()),
            segments: vec![
                VoiceSegment {
                    start_ms: 0,
                    end_ms: 900,
                    text: "now I pay".into(),
                    corrected: false,
                },
                VoiceSegment {
                    start_ms: 400_000,
                    end_ms: 401_000,
                    text: "much later".into(),
                    corrected: false,
                },
            ],
        };
        let voice = std::slice::from_ref(&note);
        let text = timeline(
            &checkout(),
            &Context {
                voice,
                ..Default::default()
            },
        );
        assert!(
            text.contains("+00:00.300  the person said: now I pay\n"),
            "{text}"
        );
        assert!(!text.contains("much later"));
        // Words like "this" come with what the pointer rested on while they were said.
        let pointing = [crate::protocol::Pointing {
            from: 1000,
            to: 2500,
            label: "button \"Export\"".into(),
        }];
        let pointed = timeline(
            &checkout(),
            &Context {
                voice,
                pointing: &pointing,
                ..Default::default()
            },
        );
        assert!(
            pointed.contains("the person said: now I pay (pointing at button \"Export\")"),
            "{pointed}"
        );
        let script = playwright(
            &checkout(),
            &Context {
                voice,
                ..Default::default()
            },
            1,
            "Checkout",
            "https://shop.test/cart",
        );
        assert!(
            script.contains("  // The person said: now I pay\n"),
            "{script}"
        );
    }

    #[test]
    fn notes_and_cuts_shape_the_timeline() {
        let notes = [Annotation {
            id: "a".into(),
            at: 1500,
            text: "total is wrong here".into(),
            drawing: vec![],
            elements: vec![button("Pay")],
        }];
        // The cut removes the console error and the failed answer.
        let kept = [
            TimeRange { from: 0, to: 1550 },
            TimeRange {
                from: 1800,
                to: 3000,
            },
        ];
        let context = Context {
            notes: &notes,
            kept: &kept,
            ..Default::default()
        };
        let text = timeline(&for_review(checkout(), true, &kept), &context);
        assert!(
            text.contains("the person noted: total is wrong here (marked button \"Pay\")"),
            "{text}"
        );
        assert!(
            !text.contains("console.error") && !text.contains("HTTP 500"),
            "{text}"
        );
    }

    #[test]
    fn the_har_holds_recorded_answers() {
        let har = har(&checkout());
        let entry = &har["log"]["entries"][0];
        assert_eq!(entry["request"]["method"], "POST");
        assert_eq!(
            entry["request"]["postData"]["text"],
            "{\"coupon\":\"SAVE10\"}"
        );
        assert_eq!(entry["response"]["status"], 500);
        assert_eq!(
            entry["response"]["content"]["text"],
            "{\"error\":\"price is NaN\"}"
        );
        assert_eq!(entry["startedDateTime"], "1970-01-01T00:00:01.601Z");
        assert_eq!(iso_time(1_763_120_400_123), "2025-11-14T11:40:00.123Z");
    }

    #[test]
    fn marks_name_elements_but_never_masked_ones() {
        let element = |name: &str, x: f64| PageElement {
            locator: button(name),
            x,
            y: 10.0,
            width: 40.0,
            height: 20.0,
        };
        let elements = [
            element("Pay", 10.0),
            element("Secret", 100.0),
            element("Back", 200.0),
        ];
        let shapes = [
            // Screenshot pixels at scale 2: around Pay, an arrow at Back, a mask over Secret.
            Shape::Rectangle {
                x: 10.0,
                y: 10.0,
                width: 110.0,
                height: 70.0,
                color: "#ff0000".into(),
            },
            Shape::Mask {
                x: 190.0,
                y: 10.0,
                width: 100.0,
                height: 60.0,
            },
            Shape::Arrow {
                from: Point { x: 0.0, y: 0.0 },
                to: Point { x: 430.0, y: 40.0 },
                color: "#ff0000".into(),
            },
            Shape::Rectangle {
                x: 200.0,
                y: 20.0,
                width: 60.0,
                height: 20.0,
                color: "#ff0000".into(),
            },
        ];
        let targets = mark_targets(&shapes, &elements, 2.0);
        let names: Vec<(u32, Vec<String>)> = targets
            .iter()
            .map(|t| {
                (
                    t.mark,
                    t.elements.iter().map(|l| l.name.clone().unwrap()).collect(),
                )
            })
            .collect();
        assert_eq!(
            names,
            [
                (1, vec!["Pay".to_string()]),
                (3, vec!["Back".to_string()]),
                (4, vec![])
            ]
        );
    }

    #[test]
    fn reviews_mask_typed_values_unless_shared() {
        let hidden = for_review(checkout(), false, &[]);
        assert_eq!(hidden.actions[0].value, None);
        assert!(hidden.actions[0].masked);
        assert!(
            timeline(&hidden, &Context::default())
                .contains("type a private value into textbox \"Coupon\"")
        );
        let shared = for_review(checkout(), true, &[]);
        assert_eq!(shared.actions[0].value.as_deref(), Some("SAVE10"));
        assert!(har(&shared)["log"]["entries"][0]["request"]["postData"].is_object());
    }

    #[test]
    fn reviews_without_typed_values_keep_only_failure_bodies() {
        let mut evidence = checkout();
        evidence.events.push(event(
            1800,
            "request",
            json!({ "requestId": "8", "method": "GET", "resourceType": "Fetch" }),
        ));
        evidence.events.push(event(
            1810,
            "response",
            json!({ "requestId": "8", "status": 200 }),
        ));
        evidence.events.push(event(
            1811,
            "responseBody",
            json!({ "requestId": "8", "format": "json", "body": { "email": "a@b.test" } }),
        ));
        let hidden = for_review(evidence, false, &[]);
        let text = serde_json::to_string(&hidden.events).unwrap();
        assert!(
            !text.contains("a@b.test") && !text.contains("SAVE10"),
            "{text}"
        );
        assert!(text.contains("price is NaN"), "the failure body stays");
    }
}
