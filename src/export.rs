//! A review as a folder anyone can open: a Markdown report, the rendered screenshots, the evidence
//! and the recordings, and the review itself as JSON.
use crate::blobs::Blobs;
use crate::protocol::{CaptureKind, Evidence, Review, ReviewItem, ReviewVoice};
use crate::repro;
use serde_json::Value;
use std::fmt::Write as _;
use std::io;
use std::path::{Path, PathBuf};

pub fn export(review: &Review, blobs: &Blobs, root: &Path) -> io::Result<PathBuf> {
    std::fs::create_dir_all(root)?;
    let folder = new_folder(
        root,
        &format!("lens-review-{}-{}", review.id, slug(&review.title)),
    )?;
    // Titles, URLs and console text come from web pages: they are escaped or fenced, so a page
    // cannot add links, images or HTML to a report someone opens later. The person's notes stay
    // Markdown.
    let mut report = format!("# {}\n\n", escape(&review.title));
    // What a reader needs first: the findings in the notes, then the person's own words, then
    // each capture; the raw timelines come last.
    if !review.notes.trim().is_empty() {
        let _ = write!(report, "{}\n\n", review.notes.trim());
    }
    if !review.voice.is_empty() {
        report.push_str("## What the person said\n\nTranscribed on this computer.\n\n");
    }
    for (index, note) in review.voice.iter().enumerate() {
        let n = index + 1;
        let transcript = voice_transcript(note);
        let _ = writeln!(report, "{}", fenced(&transcript));
        std::fs::write(folder.join(format!("voice-{n}.txt")), transcript)?;
    }
    let mut timelines = String::new();
    for (index, item) in review.items.iter().enumerate() {
        let n = index + 1;
        let session = item.kind == CaptureKind::Session;
        // A recording's page at Stop is not in its review: it cannot be masked there, and no
        // copy of it leaves (filings, agents and hand-offs read this folder).
        let screenshot = crate::record::files_end_screenshot(item);
        if screenshot {
            std::fs::write(
                folder.join(format!("capture-{n}.png")),
                blobs.read_all(&item.screenshot.sha256)?,
            )?;
        }
        let evidence = blobs.read_all(&item.evidence.sha256)?;
        std::fs::write(folder.join(format!("capture-{n}-evidence.json")), &evidence)?;
        let parsed = repro::parse(&evidence);
        for (name, contents) in reproduction(review, item, n, parsed.as_ref()) {
            std::fs::write(folder.join(name), contents)?;
        }
        for (k, shot) in item.shots.iter().enumerate() {
            std::fs::write(
                folder.join(format!("capture-{n}-shot-{}.webp", k + 1)),
                blobs.read_all(&shot.image.sha256)?,
            )?;
        }
        if let Some(recording) = &item.recording {
            std::fs::write(
                folder.join(format!("capture-{n}.rrweb.json")),
                blobs.read_all(&recording.sha256)?,
            )?;
        }
        let title = if item.page_title.is_empty() {
            &item.page_url
        } else {
            &item.page_title
        };
        let _ = write!(
            report,
            "## {} {n}: {}\n\nPage: {}\n\n",
            if session { "Recording" } else { "Capture" },
            escape(title),
            code(&item.page_url)
        );
        if screenshot {
            let _ = write!(report, "![Capture {n}](capture-{n}.png)\n\n");
        }
        if !item.annotations.is_empty() {
            report.push_str("The person's notes on the recording:\n\n");
            for note in &item.annotations {
                let on: Vec<String> = note.elements.iter().map(|l| code(&l.css)).collect();
                let _ = writeln!(
                    report,
                    "- {}{}",
                    note.text.trim().replace('\n', " "),
                    if on.is_empty() {
                        String::new()
                    } else {
                        format!(" (marked {})", on.join(", "))
                    }
                );
            }
            report.push('\n');
        }
        if !item.findings.is_empty() {
            report.push_str("What the browser recorded:\n\n");
            for finding in &item.findings {
                let _ = writeln!(report, "- {}", code(finding));
            }
            report.push('\n');
        }
        if let Some(evidence) = &parsed {
            let _ = write!(
                timelines,
                "### Capture {n}\n\nOldest first. `capture-{n}.lens.json` holds the same steps with \
                 their locators.\n\n{}\n",
                fenced(&repro::timeline(evidence, &context(item, &review.voice)))
            );
        }
    }
    if !timelines.is_empty() {
        let _ = write!(report, "## Timeline\n\n{timelines}");
    }
    std::fs::write(folder.join("report.md"), report)?;
    std::fs::write(
        folder.join("review.json"),
        serde_json::to_vec_pretty(review)?,
    )?;
    Ok(folder)
}

fn context<'a>(item: &'a ReviewItem, voice: &'a [ReviewVoice]) -> repro::Context<'a> {
    repro::Context {
        voice,
        notes: &item.annotations,
        screen: &item.screen,
        pointing: &item.pointing,
        kept: &item.kept,
    }
}

/// A voice note as text: `[mm:ss] words`, one line per stretch of speech.
pub fn voice_transcript(note: &ReviewVoice) -> String {
    let mut out = String::new();
    for segment in &note.segments {
        let s = segment.start_ms / 1000;
        let _ = writeln!(out, "[{:02}:{:02}] {}", s / 60, s % 60, segment.text.trim());
    }
    out
}

/// The generated files of one capture: the `lens-capture.v1` record, its timeline, a Playwright
/// test, and a HAR file.
pub fn reproduction(
    review: &Review,
    item: &ReviewItem,
    n: usize,
    evidence: Option<&Evidence>,
) -> Vec<(String, Vec<u8>)> {
    let Some(evidence) = evidence else {
        return Vec::new();
    };
    let voice = &review.voice[..];
    let title = if item.page_title.is_empty() {
        &item.page_url
    } else {
        &item.page_title
    };
    vec![
        (
            format!("capture-{n}.lens.json"),
            // Review creation checked the size; a record that cannot fit is left out, not cut.
            crate::record::build(review, item, n, evidence).unwrap_or_default(),
        ),
        (
            format!("capture-{n}-timeline.txt"),
            repro::timeline(evidence, &context(item, voice)).into_bytes(),
        ),
        (
            format!("capture-{n}.spec.ts"),
            repro::playwright(evidence, &context(item, voice), n, title, &item.page_url)
                .into_bytes(),
        ),
    ]
    .into_iter()
    .chain({
        // A HAR without recorded answers replays nothing: it is left out.
        let har = repro::har(evidence);
        let empty = har["log"]["entries"].as_array().is_none_or(Vec::is_empty);
        (!empty).then(|| {
            (
                format!("capture-{n}.har"),
                serde_json::to_vec_pretty(&har).expect("HAR serializes"),
            )
        })
    })
    .collect()
}

/// The masked fill that `repro::playwright` writes, and what a project test puts there.
const MASKED_FILL: &str = ".fill(''); // The person typed a private value here: type a valid one.";

/// A capture's Playwright test, ready to live in a project: `name` names its files, the recorded
/// site becomes `base_url` (or relative paths for the project's own baseURL), and each private
/// value becomes an environment variable, LENS_PRIVATE_1 and on, so it can also run in CI.
/// Returns the test and its HAR, when Lens recorded server answers.
pub fn project_test(
    review: &Review,
    item: &ReviewItem,
    n: usize,
    evidence: &crate::protocol::Evidence,
    base_url: Option<&str>,
    name: &str,
) -> (String, Option<Vec<u8>>) {
    let mut spec = String::new();
    let mut har = None;
    for (file, contents) in reproduction(review, item, n, Some(evidence)) {
        if file == format!("capture-{n}.spec.ts") {
            spec = String::from_utf8_lossy(&contents).into_owned();
        } else if file == format!("capture-{n}.har") {
            har = Some(contents);
        }
    }
    let map = OriginMap::new(&spec, &item.page_url, base_url);
    (
        for_project(&spec, &map, n, name, review.id),
        har.map(|bytes| map.har(bytes)),
    )
}

/// Where a project test sends the recorded site: the origin of its first page goes to the dev
/// server's base URL (or to relative paths, for the project's baseURL). Another origin has no
/// counterpart on the dev server: production, or a payment or sign-in site.
struct OriginMap {
    home: Option<String>,
    base: Option<String>,
}

impl OriginMap {
    fn new(spec: &str, page_url: &str, base_url: Option<&str>) -> Self {
        let origin = |url: &str| {
            url::Url::parse(url)
                .ok()
                .map(|u| u.origin().ascii_serialization())
                .filter(|o| o != "null")
        };
        // The first page the test opens, not the capture's last page: a session that ends on a
        // checkout site began on the shop.
        let home = spec
            .lines()
            .find_map(repro::navigation_target)
            .and_then(|(url, _)| origin(&url))
            .or_else(|| origin(page_url));
        // The base goes into JavaScript strings that verify_fix runs: only an http(s) origin and
        // path, as the URL parser writes them (quotes and backslashes cannot survive it).
        let base = base_url
            .and_then(|b| url::Url::parse(b.trim()).ok())
            .filter(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some())
            .map(|u| {
                format!(
                    "{}{}",
                    u.origin().ascii_serialization(),
                    u.path().trim_end_matches('/')
                )
            });
        Self { home, base }
    }

    /// The URL on the dev server; None when it is on another site.
    fn map(&self, url: &str) -> Option<String> {
        // Not a URL (rare): the line stays as it was recorded.
        let Ok(parsed) = url::Url::parse(url) else {
            return Some(url.into());
        };
        if Some(parsed.origin().ascii_serialization()) != self.home {
            return None;
        }
        let rest = &parsed[url::Position::BeforePath..];
        Some(match &self.base {
            Some(base) => format!("{base}{rest}"),
            None if rest.is_empty() => "/".into(),
            None => rest.into(),
        })
    }

    /// The HAR with the recorded site's requests on the dev server, so routeFromHAR matches them.
    /// Requests to other sites (a CDN, a payment API) keep their address.
    fn har(&self, bytes: Vec<u8>) -> Vec<u8> {
        let Ok(mut har) = serde_json::from_slice::<Value>(&bytes) else {
            return bytes;
        };
        if self.base.is_none() {
            return bytes;
        }
        for entry in har["log"]["entries"].as_array_mut().into_iter().flatten() {
            let url = &mut entry["request"]["url"];
            if let Some(mapped) = url.as_str().and_then(|u| self.map(u)) {
                *url = Value::String(mapped);
            }
        }
        serde_json::to_vec_pretty(&har).expect("HAR serializes")
    }
}

/// The first lines of a project test: a page load on another site (production, a payment or
/// sign-in site) is stopped in the browser before it gets there. A click before Lens's `throw` can
/// submit a form or follow a redirect there, so the throw alone is not enough. A Lens check hears
/// of each stop (`lensBlocked`).
// ponytail: a server redirect after an allowed request is followed by the browser unrouted; a
// framenavigated check would catch it after the fact.
fn guard(map: &OriginMap) -> String {
    let home = match &map.base {
        Some(base) => serde_json::to_string(base).expect("strings serialize"),
        None => "String(test.info().project.use.baseURL)".into(),
    };
    format!(
        "  // Lens: this test runs on the dev server only; a page load on another site stops here.\n  \
         const lensHome = new URL({home}).origin;\n  \
         await page.context().route('**/*', (route) => {{\n    \
           const request = route.request();\n    \
           let top = true;\n    \
           try {{ top = !request.frame().parentFrame(); }} catch {{}}\n    \
           if (request.isNavigationRequest() && top && new URL(request.url()).origin !== lensHome) {{\n      \
             (globalThis as {{ lensBlocked?: (url: string) => void }}).lensBlocked?.(request.url());\n      \
             return route.abort('blockedbyclient');\n    \
           }}\n    \
           return route.fallback();\n  \
         }});\n"
    )
}

fn for_project(spec: &str, map: &OriginMap, n: usize, name: &str, review: i64) -> String {
    // Only the pages the test opens move to the dev server: text the person typed keeps its URLs.
    let mut out = String::new();
    for line in spec.lines() {
        match repro::navigation_target(line) {
            Some((url, caused)) => match map.map(&url) {
                Some(mapped) => out.push_str(&repro::navigation(&mapped, caused)),
                None => {
                    let site = url::Url::parse(&url)
                        .map(|u| u.origin().ascii_serialization())
                        .unwrap_or(url);
                    let message = format!(
                        "Lens stops here: the recording goes on at {site}, a site this test does not run on. \
                         A test must not act on it; do the rest of the steps by hand."
                    );
                    out.push_str(&format!(
                        "  throw new Error({});",
                        serde_json::to_string(&message).expect("strings serialize")
                    ));
                }
            },
            None => out.push_str(line),
        }
        out.push('\n');
        if line.starts_with("test(") && line.ends_with("async ({ page }) => {") {
            out.push_str(&guard(map));
        }
    }
    for (from, to) in [
        (format!("capture-{n}.spec.ts"), format!("{name}.spec.ts")),
        (format!("capture-{n}.har"), format!("{name}.har")),
        (
            format!("capture-{n}-reproduced.png"),
            format!("{name}-reproduced.png"),
        ),
    ] {
        out = out.replace(&from, &to);
    }
    let mut private = 0;
    let lines: Vec<String> = out
        .lines()
        .map(|line| {
            if line.contains(MASKED_FILL) {
                private += 1;
                line.replace(
                    MASKED_FILL,
                    &format!(
                        ".fill(process.env.LENS_PRIVATE_{private} ?? ''); // A private value the person typed: set LENS_PRIVATE_{private}."
                    ),
                )
            } else {
                line.to_string()
            }
        })
        .collect();
    let recorded = map.home.as_deref().unwrap_or("the recorded site");
    let target = match &map.base {
        Some(base) => format!("runs against {base}"),
        None => "uses the baseURL in playwright.config".to_string(),
    };
    format!(
        "// From Sirv Lens review {review}, capture {n}. Recorded on {recorded}; this test {target}.\n\
         // The HAR path is relative to the folder you run Playwright in.\n{}\n",
        lines.join("\n")
    )
}

/// A fenced code block whose fence is longer than any backtick run inside.
fn fenced(text: &str) -> String {
    let longest = text.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat((longest + 1).max(3));
    format!("{fence}text\n{}\n{fence}\n", text.trim_end())
}

/// Text from a page or a model, on one line, where it cannot form a link, an image, HTML or code:
/// only those characters are escaped, so the text stays readable where people edit it.
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars().take(500) {
        match c {
            '\n' | '\r' => out.push(' '),
            '\\' | '`' | '[' | ']' | '<' | '>' => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out
}

/// An inline code span whose fence is longer than any backtick run inside, so nothing in it renders.
pub fn code(text: &str) -> String {
    let flat: String = text
        .chars()
        .take(500)
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    let longest = flat.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat(longest + 1);
    format!("{fence} {flat} {fence}")
}

/// Failed requests, console errors and exceptions, in the order they happened.
pub fn findings(evidence: &Value) -> Vec<String> {
    let events = evidence["events"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    events
        .iter()
        .filter_map(|event| {
            let data = &event["data"];
            let text = |key: &str| data[key].as_str().unwrap_or("").to_string();
            match event["kind"].as_str()? {
                "response" if data["status"].as_u64()? >= 400 => {
                    Some(format!("HTTP {} from {}", data["status"], text("url")))
                }
                "networkFailure" => Some(
                    format!("Request failed: {} {}", text("errorText"), text("url"))
                        .trim_end()
                        .into(),
                ),
                "console" if matches!(data["level"].as_str(), Some("error" | "assert")) => {
                    Some(format!("Console error: {}", text("text")))
                }
                "exception" => Some(format!("Exception: {}", text("text"))),
                _ => None,
            }
        })
        .collect()
}

fn slug(title: &str) -> String {
    let mut slug = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
        if slug.len() >= 40 {
            break;
        }
    }
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        "observation".into()
    } else {
        slug.into()
    }
}

/// A folder that did not exist before, so an export never mixes with or replaces another.
fn new_folder(root: &Path, name: &str) -> io::Result<PathBuf> {
    for attempt in 1..=100 {
        let candidate = match attempt {
            1 => root.join(name),
            n => root.join(format!("{name}-{n}")),
        };
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "100 export folders with this name exist",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_short_and_safe() {
        assert_eq!(slug("Cart: total shows NaN!"), "cart-total-shows-nan");
        assert_eq!(slug("../../etc/passwd"), "etc-passwd");
        assert_eq!(slug("   "), "observation");
    }

    #[test]
    fn page_text_cannot_add_markdown() {
        assert_eq!(code("a ``b`` c"), "``` a ``b`` c ```");
        assert_eq!(
            code("x\n![t](https://evil.test/p.png)"),
            "` x ![t](https://evil.test/p.png) `"
        );
        assert_eq!(escape("![t](u) <img>"), "!\\[t\\](u) \\<img\\>");
        assert_eq!(
            escape("It's a regression. Ctrl+A - done"),
            "It's a regression. Ctrl+A - done"
        );
    }

    #[test]
    fn findings_list_what_failed() {
        let evidence = serde_json::json!({ "events": [
            { "kind": "response", "data": { "status": 500, "url": "https://a.test/api" } },
            { "kind": "response", "data": { "status": 200, "url": "https://a.test/ok" } },
            { "kind": "console", "data": { "level": "error", "text": "total is NaN" } },
            { "kind": "console", "data": { "level": "log", "text": "hello" } },
        ]});
        assert_eq!(
            findings(&evidence),
            [
                "HTTP 500 from https://a.test/api",
                "Console error: total is NaN"
            ]
        );
    }

    #[test]
    fn never_reuses_a_folder() {
        let dir = tempfile::tempdir().unwrap();
        let first = new_folder(dir.path(), "x").unwrap();
        let second = new_folder(dir.path(), "x").unwrap();
        assert_ne!(first, second);
    }
}

#[cfg(test)]
mod project_tests {
    fn project(spec: &str, base: Option<&str>, name: &str) -> String {
        let map = super::OriginMap::new(spec, "https://other.example/end", base);
        super::for_project(spec, &map, 1, name, 7)
    }

    #[test]
    fn a_project_test_points_at_the_dev_server_and_asks_for_private_values() {
        let spec = "  await page.goto(\"https://app.example.com/cart\");\n  await page.getByRole('textbox', { name: 'Note' }).fill(\"see https://app.example.com/x\");\n  await page.getByRole('textbox', { name: 'Card' }).fill(''); // The person typed a private value here: type a valid one.\n  // await page.routeFromHAR('capture-1.har', { notFound: 'fallback' });\n  await page.waitForURL(\"https://app.example.com/pay\", { timeout: 5000 }).catch(() => ((globalThis as { lensMissed?: (url: string) => void }).lensMissed?.(\"https://app.example.com/pay\"), page.goto(\"https://app.example.com/pay\")));\n  await page.goto(\"https://other.example/x\");";
        let local = project(
            spec,
            Some("http://localhost:3000/"),
            "lens-review-7-capture-1",
        );
        assert!(local.contains("page.goto(\"http://localhost:3000/cart\")"));
        assert!(local.contains("waitForURL(\"http://localhost:3000/pay\", { timeout: 5000 }).catch(() => ((globalThis as { lensMissed?: (url: string) => void }).lensMissed?.(\"http://localhost:3000/pay\"), page.goto(\"http://localhost:3000/pay\")))"));
        assert!(local.contains("fill(process.env.LENS_PRIVATE_1 ?? '')"));
        assert!(local.contains("routeFromHAR('lens-review-7-capture-1.har'"));
        assert!(
            local.contains("fill(\"see https://app.example.com/x\")"),
            "typed text keeps its URLs"
        );
        // The first page decides, not the capture's last page; the test stops before another site.
        assert!(!local.contains("page.goto(\"https://other.example/x\")"));
        assert!(local.contains(
            "throw new Error(\"Lens stops here: the recording goes on at https://other.example"
        ));
        let relative = project(spec, None, "t");
        assert!(relative.contains("page.goto(\"/cart\")"));
        assert!(relative.contains("uses the baseURL in playwright.config"));
        let hostile = project(spec, Some("http://evil.test/\"+alert(1)+\""), "t");
        assert!(!hostile.contains("\"+alert(1)+\""));
        assert!(hostile.contains("page.goto(\"http://evil.test/%22+alert(1)+%22/cart\")"));
        let not_web = project(spec, Some("javascript:alert(1)"), "t");
        assert!(not_web.contains("page.goto(\"/cart\")"));
    }

    #[test]
    fn a_project_test_stops_page_loads_on_other_sites() {
        let spec = "test(\"capture 1\", async ({ page }) => {\n  await page.goto(\"https://app.example.com/cart\");\n});";
        let local = project(spec, Some("http://localhost:3000"), "t");
        let guard = local.find("const lensHome = new URL(\"http://localhost:3000\").origin;");
        let first = local.find("page.goto(\"http://localhost:3000/cart\")");
        assert!(guard.is_some() && guard < first, "{local}");
        assert!(local.contains("route.abort('blockedbyclient')"));
        let relative = project(spec, None, "t");
        assert!(relative.contains("new URL(String(test.info().project.use.baseURL)).origin"));
    }

    #[test]
    fn the_har_follows_the_test_to_the_dev_server() {
        let spec = "  await page.goto(\"https://app.example.com/cart\");";
        let map = super::OriginMap::new(
            spec,
            "https://app.example.com/cart",
            Some("http://localhost:3000"),
        );
        let har = serde_json::json!({ "log": { "entries": [
            { "request": { "url": "https://app.example.com/api/price?c=1" } },
            { "request": { "url": "https://cdn.example.net/a.js" } },
        ] } });
        let mapped: serde_json::Value =
            serde_json::from_slice(&map.har(serde_json::to_vec(&har).unwrap())).unwrap();
        assert_eq!(
            mapped["log"]["entries"][0]["request"]["url"],
            "http://localhost:3000/api/price?c=1"
        );
        assert_eq!(
            mapped["log"]["entries"][1]["request"]["url"],
            "https://cdn.example.net/a.js"
        );
    }
}
