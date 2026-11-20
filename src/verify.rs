//! Proof of a fix: repeats a review's steps on the dev server with the project's own Playwright,
//! watches the network and the console while it runs, and compares what failed with what the
//! person recorded. The test runs in a scratch folder inside the project, so `@playwright/test`
//! comes from the project's node_modules, and the folder is removed afterwards.
use crate::protocol::{Evidence, Review, ReviewItem};
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;

/// The test's own time, then Playwright's start and the browser.
const RUN: Duration = Duration::from_secs(240);

/// What the test notes while it runs, and where it writes it.
/// The dev server's URLs and console text go to the agent: query values, credentials and
/// secret-looking text are redacted first (failures compare by path), and the lists are bounded.
const WATCH: &str = r#"
const lensSeen = { requests: [] as { status: number; method: string; url: string }[], console: [] as string[], keys: [] as string[], missed: [] as string[], blocked: [] as string[] };
const lensUrl = (u: string) => { try { const x = new URL(u); x.username = ''; x.password = ''; x.hash = ''; for (const k of [...x.searchParams.keys()]) x.searchParams.set(k, 'REDACTED'); return x.toString(); } catch { return '[unreadable URL]'; } };
const lensText = (t: string) => t.slice(0, 1000)
  .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [REDACTED]')
  .replace(/((?:set-)?cookie["']?\s{0,8}[:=]\s{0,8})[^\n]*/gi, '$1[REDACTED]')
  .replace(/((?:authorization|cookie|password|passwd|secret|token|api[_-]?key|session[_-]?id|csrf|xsrf)["']?\s{0,8}[:=]\s{0,8})[^\s,;}]+/gi, '$1[REDACTED]')
  .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[REDACTED]')
  .replace(/\b(?:\d[ -]?){12,18}\d\b/g, '[REDACTED]')
  .replace(/https?:\/\/[^\s"')]+/g, (u) => lensUrl(u));
const lensRequest = (status: number, method: string, url: string) => {
  let key = '';
  try { key = `${status} ${new URL(url).pathname}`; } catch {}
  if (key && !lensSeen.keys.includes(key) && lensSeen.keys.length < 5000) lensSeen.keys.push(key);
  if (lensSeen.requests.length < 100) lensSeen.requests.push({ status, method, url: lensUrl(url) });
};
const lensConsole = (text: string) => { const clean = lensText(text); if (lensSeen.console.length < 500 && !lensSeen.console.includes(clean)) lensSeen.console.push(clean); };
// The generated test calls these: a page that did not go on by itself, a page load on another site.
const lensHooks = globalThis as { lensMissed?: (url: string) => void; lensBlocked?: (url: string) => void };
lensHooks.lensMissed = (u) => { if (lensSeen.missed.length < 100) lensSeen.missed.push(lensUrl(u)); };
lensHooks.lensBlocked = (u) => { if (lensSeen.blocked.length < 100) lensSeen.blocked.push(lensUrl(u)); };
test.afterEach(() => writeFileSync(process.env.LENS_VERIFY_OUT ?? 'lens-verify.json', JSON.stringify(lensSeen)));
"#;
const LISTEN: &str = "  page.on('response', (r) => { if (r.status() >= 400) lensRequest(r.status(), r.request().method(), r.url()); });
  page.on('requestfailed', (r) => lensRequest(0, r.method(), r.url()));
  page.on('console', (m) => { if (m.type() === 'error') lensConsole(m.text()); });
  page.on('pageerror', (e) => lensConsole(String(e)));
";

/// The test with the listeners added: a module-level record, written after the test, and the
/// listeners at the start of its body.
fn instrument(spec: &str) -> String {
    let mut out = String::new();
    for line in spec.lines() {
        out.push_str(line);
        out.push('\n');
        if line.starts_with("import { test, expect } from '@playwright/test';") {
            out.push_str("import { writeFileSync } from 'node:fs';\n");
            out.push_str(WATCH);
        } else if line.starts_with("test(") && line.ends_with("async ({ page }) => {") {
            out.push_str(LISTEN);
        }
    }
    out
}

/// A failure as people compare it: the status and the path of a request, or a console text.
fn key_of_finding(finding: &str) -> Option<String> {
    // Web addresses only: "net::ERR_FAILED" parses as a URL too, and would never match.
    let path = |url: &str| {
        url::Url::parse(url)
            .ok()
            .filter(|u| matches!(u.scheme(), "http" | "https"))
            .map(|u| u.path().to_string())
    };
    if let Some(rest) = finding.strip_prefix("Request failed: ") {
        return Some(format!("0 {}", path(rest.split_whitespace().last()?)?));
    }
    let (status, url) = finding.strip_prefix("HTTP ")?.split_once(" from ")?;
    Some(format!(
        "{status} {}",
        path(url.split_whitespace().next()?)?
    ))
}

pub fn verify(
    review: &Review,
    item: &ReviewItem,
    n: usize,
    evidence: &Evidence,
    raw_evidence: &Value,
    base_url: &str,
    project: &Path,
) -> Result<Value, String> {
    let base_url = base_url.trim();
    if url::Url::parse(base_url).is_err() {
        return Err(format!(
            "{base_url:?} is not a URL, such as http://localhost:3000"
        ));
    }
    let project = project
        .canonicalize()
        .map_err(|e| format!("cannot use the project folder {}: {e}", project.display()))?;
    let name = format!("lens-verify-{}-capture-{n}", review.id);
    let (spec, _) = crate::export::project_test(review, item, n, evidence, Some(base_url), &name);
    // Everything the run writes stays in the scratch folder.
    let spec = spec.replace(
        &format!("{{ path: '{name}-reproduced.png' }}"),
        "{ path: test.info().outputPath('reproduced.png') }",
    );
    if !spec
        .lines()
        .any(|l| l.trim_start().starts_with("await page."))
    {
        return Err("Lens recorded no steps to repeat for this capture".into());
    }
    let mut skipped = skipped_steps(&spec);
    // A folder of its own for each run: two runs at once, or files someone keeps in
    // .lens/verify, are never overwritten or removed.
    let folder = project
        .join(".lens")
        .join(format!("verify-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&folder).map_err(|e| format!("cannot write in the project: {e}"))?;
    let seen = folder.join(format!("{name}.json"));
    let config = folder.join("playwright.config.mjs");
    let written = std::fs::write(folder.join(format!("{name}.spec.ts")), instrument(&spec))
        .and_then(|()| {
            std::fs::write(
                &config,
                format!(
                    "const browser = process.env.LENS_VERIFY_BROWSER;\n\
                     export default {{ testDir: '.', outputDir: './results', timeout: 120000, reporter: 'json', \
                     use: {{ baseURL: {}, ...(browser ? {{ launchOptions: {{ executablePath: browser }} }} : {{}}) }} }};\n",
                    serde_json::to_string(base_url).expect("strings serialize")
                ),
            )
        });
    let result = written
        .map_err(|e| format!("cannot write in the project: {e}"))
        .and_then(|()| run(&project, &config, &seen));
    let _ = std::fs::remove_dir_all(&folder);
    let _ = std::fs::remove_dir(project.join(".lens"));
    // Private values the agent's environment gives the test never come back, in any part of the
    // answer: errors, console text, request URLs, or Playwright's own output on a failure.
    let private: Vec<String> = std::env::vars()
        .filter(|(k, v)| k.starts_with("LENS_PRIVATE_") && !v.is_empty())
        .map(|(_, v)| v)
        .collect();
    let private = forms(&private);
    let (report, watched) = result.map_err(|e| scrub(&strip_ansi(&e), &private))?;
    let errors = errors(&report);
    skipped.extend(run_skips(&watched));
    let passed = report["stats"]["unexpected"].as_u64() == Some(0)
        && report["stats"]["expected"].as_u64().unwrap_or(0) > 0;
    let recorded = crate::export::findings(raw_evidence);
    let requests = watched["requests"].as_array().cloned().unwrap_or_default();
    let console: Vec<String> = watched["console"]
        .as_array()
        .map(|c| {
            c.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    // Every failed request's status and path, not only the first hundred that are listed.
    let now: Vec<String> = watched["keys"]
        .as_array()
        .map(|keys| {
            keys.iter()
                .filter_map(|k| k.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let mut still = Vec::new();
    let mut gone = Vec::new();
    // A failure without an address or a text to compare: Lens cannot say that it is gone.
    let mut unknown = Vec::new();
    for finding in &recorded {
        let text = finding
            .strip_prefix("Console error: ")
            .or_else(|| finding.strip_prefix("Exception: "));
        let again = match (key_of_finding(finding), text) {
            (Some(key), _) => Some(now.contains(&key)),
            (None, Some(text)) => {
                let text = without_queries(text.trim());
                Some(console.iter().any(|c| without_queries(c).contains(&text)))
            }
            (None, None) => None,
        };
        match again {
            Some(true) => still.push(finding.clone()),
            Some(false) => gone.push(finding.clone()),
            None => unknown.push(finding.clone()),
        }
    }
    let verdict = if !passed {
        "The steps did not run through: see errors. The defect, or a changed page, stops them."
    } else if !skipped.is_empty() {
        "Inconclusive: the test could not repeat every step the person took (see skippedSteps), so the defect may not have had its chance."
    } else if !still.is_empty() {
        "The steps ran, but a failure the person recorded happened again: see stillFailing."
    } else if !unknown.is_empty() {
        "The steps ran, and no failure Lens can compare happened again; check notCompared by hand."
    } else {
        "The steps ran on the dev server, and none of the failures the person recorded happened again."
    };
    let answer = json!({
        "review": review.id,
        "capture": n,
        "baseUrl": base_url,
        "project": project.display().to_string(),
        "stepsRan": passed,
        "skippedSteps": skipped,
        "verdict": verdict,
        "errors": errors,
        "recordedFindings": recorded,
        "stillFailing": still,
        "notSeenAgain": gone,
        "notCompared": unknown,
        "failedRequestsNow": requests,
        "consoleErrorsNow": console,
    });
    let mut answer = answer;
    scrub_value(&mut answer, &private);
    Ok(answer)
}

/// Every form a private value can take in Playwright's output: as typed, escaped in JSON or a
/// JavaScript string, and URL-encoded. Longest first, so a value inside another goes with it.
fn forms(private: &[String]) -> Vec<String> {
    let mut all: Vec<String> = private
        .iter()
        .filter(|v| !v.is_empty())
        .flat_map(|v| {
            let json = serde_json::to_string(v).expect("strings serialize");
            let inner = json[1..json.len() - 1].to_string();
            let twice = serde_json::to_string(&inner).expect("strings serialize");
            [
                v.clone(),
                inner,
                twice[1..twice.len() - 1].to_string(),
                url::form_urlencoded::byte_serialize(v.as_bytes()).collect(),
                // encodeURIComponent, and encodeURI as a URL path keeps `/` and friends.
                percent(v, ""),
                percent(v, ";,/?:@&=+$#"),
            ]
        })
        .collect();
    all.sort_by_key(|f| std::cmp::Reverse(f.len()));
    all.dedup();
    all
}

/// `text` percent-encoded as JavaScript's encodeURIComponent does, leaving `keep` as it is too.
fn percent(text: &str, keep: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) || keep.contains(c) {
            out.push(c);
        } else {
            let mut bytes = [0; 4];
            for b in c.encode_utf8(&mut bytes).bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}

/// Each string in the answer, scrubbed; short values too (a PIN is short). Lens's own fields stay
/// as they are, so a value such as "3000" never makes the base URL or the verdict unreadable.
fn scrub_value(value: &mut Value, private: &[String]) {
    match value {
        Value::String(text) => *text = scrub(text, private),
        Value::Array(items) => items.iter_mut().for_each(|v| scrub_value(v, private)),
        Value::Object(map) => map
            .iter_mut()
            .filter(|(key, _)| !matches!(key.as_str(), "baseUrl" | "verdict" | "project"))
            .for_each(|(_, v)| scrub_value(v, private)),
        _ => {}
    }
}

/// The text with each private value replaced.
fn scrub(text: &str, private: &[String]) -> String {
    private
        .iter()
        .filter(|v| !v.is_empty())
        .fold(text.to_string(), |text, v| {
            text.replace(v.as_str(), "[PRIVATE]")
        })
}

/// The steps the test does not really take: ones Lens could not write (a file upload, a private
/// option, an element it could not find), private values the environment does not give, and a
/// stop before another site. A run without them proves nothing about the defect.
/// What the run itself could not repeat: a click that no longer took the page on (the test went
/// there by address, so its passing proves nothing), and page loads on another site it stopped.
fn run_skips(watched: &Value) -> Vec<String> {
    let list = |key: &str| {
        watched[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(String::from))
            .collect::<Vec<_>>()
    };
    let missed = list("missed").into_iter().map(|url| {
        format!("the page did not go to {url} after the step; the test opened it by address")
    });
    let blocked = list("blocked")
        .into_iter()
        .map(|url| format!("a page load on another site was stopped: {url}"));
    missed.chain(blocked).collect()
}

fn skipped_steps(spec: &str) -> Vec<String> {
    let mut skipped = Vec::new();
    for line in spec.lines().map(str::trim) {
        if let Some(step) = line.strip_prefix(crate::repro::SKIPPED_STEP) {
            skipped.push(step.to_string());
        } else if line.starts_with("throw new Error(") {
            skipped.push("the steps on another site".into());
        } else if let Some(at) = line.find("process.env.LENS_PRIVATE_") {
            let name: String = line[at + "process.env.".len()..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            if !std::env::var(&name).is_ok_and(|v| !v.is_empty()) {
                skipped.push(format!(
                    "a private value: set {name} for the MCP server or lens verify"
                ));
            }
        }
    }
    skipped
}

/// Runs the test with the project's Playwright. Returns the JSON report and what the test noted.
fn run(project: &Path, config: &Path, seen: &Path) -> Result<(Value, Value), String> {
    let npx = crate::investigate::program(if cfg!(windows) { "npx.cmd" } else { "npx" })
        .or_else(|| crate::investigate::program("npx"))
        .ok_or("npx is not installed: install Node.js, then @playwright/test in the project")?;
    let (_, out, err) = crate::handoff::bounded(
        crate::investigate::command(&npx)
            .env("PATH", crate::investigate::path_for(&npx))
            // The JSON report goes to stdout, never over a file the project's CI keeps.
            .env_remove("PLAYWRIGHT_JSON_OUTPUT_FILE")
            .env_remove("PLAYWRIGHT_JSON_OUTPUT_DIR")
            .env_remove("PLAYWRIGHT_JSON_OUTPUT_NAME")
            .args(["--no-install", "playwright", "test", "--config"])
            .arg(config)
            .current_dir(project)
            .env("LENS_VERIFY_OUT", seen),
        None,
        RUN,
        16 * 1024 * 1024,
    )?;
    let report: Value = serde_json::from_str(out.trim()).map_err(|_| {
        let said = format!("{}\n{}", out.trim(), err.trim());
        let hint = if said.contains("could not determine executable")
            || said.contains("Cannot find module '@playwright/test'")
            || said.contains("npm error")
        {
            "Playwright is not installed in this project: npm i -D @playwright/test && npx playwright install chromium. "
        } else {
            ""
        };
        format!("{hint}Playwright did not run: {}", last_lines(&said, 12))
    })?;
    let watched = std::fs::read_to_string(seen)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| json!({}));
    Ok((report, watched))
}

/// Every error message in a Playwright JSON report, without terminal colours.
fn errors(report: &Value) -> Vec<String> {
    let mut found = Vec::new();
    fn walk(value: &Value, found: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for (key, inner) in map {
                    if key == "error" || key == "errors" {
                        collect(inner, found);
                    } else {
                        walk(inner, found);
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|i| walk(i, found)),
            _ => {}
        }
    }
    fn collect(value: &Value, found: &mut Vec<String>) {
        match value {
            Value::Array(items) => items.iter().for_each(|i| collect(i, found)),
            Value::Object(map) => {
                if let Some(message) = map.get("message").and_then(Value::as_str) {
                    let clean = strip_ansi(message);
                    if !found.contains(&clean) {
                        found.push(clean);
                    }
                }
            }
            _ => {}
        }
    }
    walk(report, &mut found);
    found
}

/// The text with the query of each URL left out: the live text has its values redacted.
fn without_queries(text: &str) -> String {
    text.split(' ')
        .map(|word| match (word.contains("://"), word.find('?')) {
            (true, Some(at)) => &word[..at],
            _ => word,
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_the_test_cannot_take_are_named() {
        let spec = "  await page.goto(\"/cart\");\n  // Skipped step: the person chose files here (a.png): await x.setInputFiles([...]);\n  await page.locator(\"#pin\").fill(process.env.LENS_PRIVATE_9 ?? ''); // A private value\n  throw new Error(\"Lens stops here\");\n  await page.click();";
        let skipped = skipped_steps(spec);
        assert_eq!(skipped.len(), 3, "{skipped:?}");
        assert!(skipped[0].starts_with("the person chose files"));
        assert!(skipped[1].contains("LENS_PRIVATE_9"));
        assert!(skipped_steps("  await page.goto(\"/cart\");\n  await page.click();").is_empty());
    }

    #[test]
    fn the_test_gets_its_listeners() {
        let spec = "import { test, expect } from '@playwright/test';\n\ntest(\"capture 1: Cart\", async ({ page }) => {\n  await page.goto(\"http://localhost:3000/cart\");\n});\n";
        let watched = instrument(spec);
        assert!(watched.contains("import { writeFileSync } from 'node:fs';"));
        assert!(watched.contains("test.afterEach("));
        let body = watched.split("async ({ page }) => {").nth(1).unwrap();
        assert!(body.trim_start().starts_with("page.on('response'"));
    }

    #[test]
    fn findings_compare_by_status_and_path() {
        assert_eq!(
            key_of_finding("HTTP 500 from https://app.example.com/api/price?x=1").as_deref(),
            Some("500 /api/price")
        );
        assert_eq!(key_of_finding("Console error: total is NaN"), None);
        assert_eq!(
            key_of_finding("Request failed: net::ERR_FAILED https://app.example.com/api/x")
                .as_deref(),
            Some("0 /api/x")
        );
        assert_eq!(
            scrub("fill(\"hunter2\") failed", &["hunter2".into()]),
            "fill(\"[PRIVATE]\") failed"
        );
        // Escaped, encoded, and one value inside another: none of it survives.
        let private = forms(&["a\"b c".into(), "a\"b c d".into()]);
        let mut answer = json!({ "errors": ["fill(\"a\\\"b c d\")"], "url": "/x?q=a%22b+c" });
        scrub_value(&mut answer, &private);
        let text = answer.to_string();
        assert!(!text.contains("b c") && !text.contains("a%22b"), "{text}");
        // In a URL path, as a browser writes it, and inside the returned JSON.
        let private = forms(&["my card/4242 x".into()]);
        let mut answer = json!({
            "failedRequestsNow": [{ "url": "http://localhost:3000/pay/my%20card/4242%20x" },
                                  { "url": "http://localhost:3000/q/my%20card%2F4242%20x" }],
        });
        scrub_value(&mut answer, &private);
        let text = answer.to_string();
        assert!(!text.contains("4242"), "{text}");
        // Short values go too, but Lens's own fields stay readable.
        let private = forms(&["123".into()]);
        let mut answer =
            json!({ "baseUrl": "http://x.test:123", "verdict": "123", "errors": ["pin 123"] });
        scrub_value(&mut answer, &private);
        assert_eq!(
            answer,
            json!({ "baseUrl": "http://x.test:123", "verdict": "123", "errors": ["pin [PRIVATE]"] })
        );
        assert_eq!(
            without_queries("GET https://a.test/x?id=REDACTED failed"),
            without_queries("GET https://a.test/x?id=7 failed")
        );
        assert_eq!(strip_ansi("\u{1b}[31mExpected\u{1b}[39m 1"), "Expected 1");
        let report = json!({ "suites": [{ "specs": [{ "tests": [{ "results": [{ "error": { "message": "\u{1b}[2mTimeout\u{1b}[22m" }, "errors": [{ "message": "\u{1b}[2mTimeout\u{1b}[22m" }] }] }] }] }] });
        assert_eq!(errors(&report), vec!["Timeout".to_string()]);
    }
}
