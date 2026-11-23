//! `lens setup` and `lens doctor`: one checklist, built from the daemon's live checks. Setup fixes
//! what it can by itself (service, registrations) and then waits, step by step, for what only the
//! person can do in the browser. Doctor prints the same checks once.
use crate::client::Client;
use crate::paths::Paths;
use crate::protocol::{PROTOCOL_VERSION, Reply, Request, SetupStatus};
use std::io::{self, Write};
use std::time::Duration;

/// Chrome, Edge and Brave add Lens from here.
pub const CHROME_STORE: &str =
    "https://chromewebstore.google.com/detail/sirv-lens/lihjnfpbomppjmdlnchkookggmefanbg";
/// Firefox adds Lens from here.
pub const FIREFOX_STORE: &str = "https://addons.mozilla.org/firefox/addon/sirv-lens/";

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Mark {
    Done,
    Todo,
    /// Not required; shown as a suggestion.
    Optional,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct Step {
    pub name: String,
    pub mark: Mark,
    pub detail: String,
}

pub fn steps(status: &SetupStatus) -> Vec<Step> {
    let step = |name: &str, mark, detail: String| Step {
        name: name.into(),
        mark,
        detail,
    };
    let mut steps = vec![step(
        "Lens app",
        Mark::Done,
        format!("version {} at {}", status.version, status.binary),
    )];

    steps.push(match &status.service {
        Some(manager) => step("Starts at login", Mark::Done, manager.to_string()),
        None => step(
            "Starts at login",
            Mark::Todo,
            "so recordings and filing work after a restart; run: lens service install".into(),
        ),
    });

    let usable: Vec<_> = status.browsers.iter().filter(|b| b.registered).collect();
    let problems: Vec<String> = status
        .browsers
        .iter()
        .filter_map(|b| b.problem.as_ref().map(|p| format!("{}: {p}", b.name)))
        .collect();
    steps.push(match (usable.is_empty(), status.browsers.is_empty()) {
        (_, true) => step(
            "Browser",
            Mark::Todo,
            "install Chrome, Edge, Brave, Chromium or Firefox".into(),
        ),
        (true, false) => step("Browser", Mark::Todo, problems.join("; ")),
        (false, false) => {
            let names: Vec<&str> = usable.iter().map(|b| b.name.as_str()).collect();
            let mut detail = format!("ready: {}", names.join(", "));
            if !problems.is_empty() {
                detail.push_str(&format!(" (also: {})", problems.join("; ")));
            }
            step("Browser", Mark::Done, detail)
        }
    });

    let current = status
        .extensions
        .iter()
        .find(|e| e.client.protocol == PROTOCOL_VERSION);
    let outdated = status
        .extensions
        .iter()
        .find(|e| e.client.protocol != PROTOCOL_VERSION);
    steps.push(match (current, outdated) {
        (Some(seen), _) => step(
            "Browser extension",
            Mark::Done,
            format!(
                "connected from {} (extension {})",
                seen.client.browser, seen.client.extension_version
            ),
        ),
        (None, Some(old)) if old.client.protocol < PROTOCOL_VERSION => step(
            "Browser extension",
            Mark::Todo,
            "the extension is older than this app; update the extension".into(),
        ),
        (None, Some(_)) => step(
            "Browser extension",
            Mark::Todo,
            "the extension is newer than this app; update Lens".into(),
        ),
        (None, None) => step("Browser extension", Mark::Todo, extension_instructions()),
    });

    // A store sends the new extension after its review, so this is a note, not a failed step.
    let older = older_extensions(status);
    if !older.is_empty() {
        steps.push(step(
            "Extension updates",
            Mark::Optional,
            format!(
                "older than the app ({}): {}. A store sends the new one after its review; a Load unpacked copy needs Reload on the extensions page",
                status.version,
                older.join(", ")
            ),
        ));
    }

    let granted: usize = status
        .extensions
        .iter()
        .map(|e| e.client.granted_origins.len())
        .sum();
    steps.push(if status.projects > 0 && granted > 0 {
        step(
            "A site to collect on",
            Mark::Done,
            format!("{granted} site(s) allowed"),
        )
    } else {
        step(
            "A site to collect on",
            Mark::Todo,
            "open the site you test, click the Lens button in the toolbar, then Collect evidence on this site"
                .into(),
        )
    });

    steps.push(if status.captures > 0 {
        step(
            "First recording",
            Mark::Done,
            format!("{} capture(s)", status.captures),
        )
    } else {
        step(
            "First recording",
            Mark::Optional,
            "on that site, press Record in the Lens side panel, use the site and say what you see"
                .into(),
        )
    });

    if status.vibeq_configured {
        steps.push(step("VibeQ", Mark::Done, "address saved".into()));
    }
    steps
}

/// Browsers used this week whose extension is older than the app, as "chromium 0.12.14".
pub fn older_extensions(status: &SetupStatus) -> Vec<String> {
    let week_ago = crate::daemon::now_ms() - 7 * 24 * 60 * 60 * 1000;
    let old = |e: &&crate::protocol::ClientSeen| {
        crate::update::newer(&status.version, &e.client.extension_version)
    };
    // Each extension copy has its own profile ID: a current one in the same browser, seen later,
    // replaced the old copy (a store build in place of an unpacked one).
    let replaced = |e: &crate::protocol::ClientSeen| {
        status
            .extensions
            .iter()
            .any(|c| c.client.browser == e.client.browser && c.last_seen > e.last_seen && !old(&c))
    };
    let mut older: Vec<String> = status
        .extensions
        .iter()
        .filter(|e| e.last_seen >= week_ago)
        .filter(old)
        .filter(|e| !replaced(e))
        .map(|e| format!("{} {}", e.client.browser, e.client.extension_version))
        .collect();
    older.sort();
    older.dedup();
    older
}

/// One coding agent in the doctor's list: optional, so never a failed step.
fn agent_step(info: &crate::investigate::AgentInfo) -> Step {
    use crate::investigate::{Agent, AgentState};
    let name = match info.agent {
        Agent::Claude => "Claude Code",
        Agent::Codex => "Codex",
    };
    let mut detail = match (&info.state, &info.binary, &info.problem) {
        (AgentState::Ready, Some(binary), _) => format!("ready: {binary}"),
        (_, Some(binary), Some(problem)) => format!("{binary} did not answer: {problem}"),
        (_, Some(binary), None) => format!("{binary}: not signed in with a subscription"),
        (_, None, _) => "not found".into(),
    };
    if !info.broken.is_empty() {
        detail.push_str(&format!(
            "; skipped {}: the system cannot start it, so reinstall or remove it",
            info.broken.join(", ")
        ));
    }
    Step {
        name: name.into(),
        mark: if info.state == AgentState::Ready {
            Mark::Done
        } else {
            Mark::Optional
        },
        detail,
    }
}

/// The doctor's line for a Lens that does not run. Not a failed step: the browser starts Lens
/// when it needs it, unless the person quit it.
/// Voice notes need a local Whisper model; any downloaded one counts.
fn speech_step(paths: &Paths) -> Step {
    let ready: Vec<&str> = crate::speech::MODELS
        .iter()
        .filter(|m| crate::speech::models_ready_for(paths, m.id))
        .map(|m| m.name)
        .collect();
    Step {
        name: "Speech model".into(),
        mark: if ready.is_empty() {
            Mark::Optional
        } else {
            Mark::Done
        },
        detail: if ready.is_empty() {
            "not downloaded: voice notes wait until you download it in Lens settings".into()
        } else {
            format!("ready: {}", ready.join(", "))
        },
    }
}

/// MP4 export of recordings needs Node.js, FFmpeg and the replay packages.
fn video_tools_step(paths: &Paths) -> Step {
    let check = crate::attachments::check_video_tools(&paths.data.join("video-tools"));
    Step {
        name: "Video tools".into(),
        mark: if check.ready {
            Mark::Done
        } else {
            Mark::Optional
        },
        detail: check
            .detail
            .unwrap_or_else(|| "ready: recordings export as MP4".into()),
    }
}

fn stopped_step(quit: bool) -> Step {
    Step {
        name: "Lens running".into(),
        mark: Mark::Optional,
        detail: if quit {
            "no: you quit Lens; open Sirv Lens or run lens start to start it".into()
        } else {
            "no: the browser starts it when needed, or run lens start".into()
        },
    }
}

fn extension_instructions() -> String {
    format!(
        "add the extension in Chrome, Edge or Brave from {CHROME_STORE}; in Firefox, from {FIREFOX_STORE}"
    )
}

fn status(client: &mut Client) -> io::Result<SetupStatus> {
    match client
        .call(Request::SetupStatus)
        .map_err(io::Error::other)?
    {
        Reply::Setup(status) => Ok(*status),
        _ => Err(io::Error::other("unexpected reply")),
    }
}

fn print(steps: &[Step]) {
    for step in steps {
        let mark = match step.mark {
            Mark::Done => "✓",
            Mark::Todo => "✗",
            Mark::Optional => "○",
        };
        println!("{mark} {:<22} {}", step.name, step.detail);
    }
}

/// The checks, from this computer and the notebook's records (`store`; None: no records yet).
/// The daemon answers SetupStatus with it; `lens doctor` runs it itself while Lens is stopped.
pub fn setup_status(paths: &Paths, store: Option<&crate::store::Store>) -> io::Result<SetupStatus> {
    let executable = crate::paths::executable()?;
    let service = match crate::service::state(paths) {
        crate::service::State::Installed { manager } => Some(manager.to_string()),
        crate::service::State::NotInstalled => None,
    };
    let records = |e: rusqlite::Error| io::Error::other(format!("the notebook: {e}"));
    let mut status = SetupStatus {
        version: env!("CARGO_PKG_VERSION").into(),
        protocol: PROTOCOL_VERSION,
        binary: executable.display().to_string(),
        service,
        browsers: crate::register::check(paths, &executable),
        extensions: store
            .map_or(Ok(Vec::new()), |s| s.list_clients())
            .map_err(records)?,
        projects: store
            .map_or(Ok(0), |s| s.count("projects"))
            .map_err(records)?,
        captures: store
            .map_or(Ok(0), |s| s.count("captures"))
            .map_err(records)?,
        vibeq_configured: store
            .map_or(Ok(None), |s| s.setting("vibeq.endpoint"))
            .map_err(records)?
            .is_some(),
        coding_agents_connected: crate::agents::connected(),
        steps: Vec::new(),
    };
    status.steps = steps(&status);
    Ok(status)
}

/// Prints every check once. Fails when a required step is open. It never starts Lens and never
/// removes the quit marker, so a Lens the person quit stays quit: while Lens is stopped, the
/// checks run here, on the notebook opened read-only.
pub fn doctor(paths: &Paths) -> io::Result<()> {
    let (steps, agents) = match Client::attach(paths) {
        Ok(mut client) => {
            let steps = status(&mut client)?.steps;
            // As the daemon sees them: its PATH can differ from this terminal's.
            let agents = match client.call(Request::ListAgents) {
                Ok(Reply::Agents(agents)) => agents,
                _ => Vec::new(),
            };
            (steps, agents)
        }
        Err(_) => {
            let store = crate::store::Store::open_read_only(&paths.database()).ok();
            let mut steps = setup_status(paths, store.as_ref())?.steps;
            steps.push(stopped_step(paths.quit_marker().exists()));
            let agents = [
                crate::investigate::Agent::Codex,
                crate::investigate::Agent::Claude,
            ]
            .into_iter()
            .map(crate::investigate::info)
            .collect();
            (steps, agents)
        }
    };
    print(&steps);
    print(&agents.iter().map(agent_step).collect::<Vec<_>>());
    print(&[speech_step(paths), video_tools_step(paths)]);
    match steps.iter().filter(|s| s.mark == Mark::Todo).count() {
        0 => {
            println!("\nEverything required is in order.");
            Ok(())
        }
        open => Err(io::Error::other(format!(
            "{open} step(s) need attention; lens setup walks through them"
        ))),
    }
}

/// Fixes what it can, then waits for each browser step, showing the checklist when it changes.
pub fn setup(paths: &Paths) -> io::Result<()> {
    let executable = crate::paths::executable()?;
    println!(
        "Setting up Lens. Press Ctrl+C at any time; lens setup continues where you stopped.\n"
    );
    crate::service::ensure(paths, &executable)?;
    crate::register::register(paths, &executable)?;
    let mut client = Client::connect(paths)?;
    let mut shown: Option<Vec<Step>> = None;
    let mut opened = false;
    loop {
        let steps = status(&mut client)?.steps;
        if shown.as_ref() != Some(&steps) {
            println!();
            print(&steps);
            shown = Some(steps.clone());
        }
        let Some(open) = steps.iter().find(|s| s.mark == Mark::Todo) else {
            println!(
                "\nLens is ready. On the site you test, open the Lens side panel and press Record."
            );
            return Ok(());
        };
        if open.name == "Browser extension" && !opened {
            opened = true;
            println!("\nChrome, Edge, Brave: {CHROME_STORE}\nFirefox: {FIREFOX_STORE}");
            let firefox_only = crate::register::check(paths, std::path::Path::new(""))
                .iter()
                // Snap and Flatpak browsers (named with a bracket) cannot start Lens.
                .filter(|b| b.installed && !b.name.contains('('))
                .all(|b| b.name.starts_with("Firefox"));
            let _ = open_url(if firefox_only {
                FIREFOX_STORE
            } else {
                CHROME_STORE
            });
        }
        if matches!(
            open.name.as_str(),
            "Lens app" | "Starts at login" | "Browser"
        ) {
            return Err(io::Error::other(format!("{}: {}", open.name, open.detail)));
        }
        print!("\rWaiting: {:<60}", open.name);
        io::stdout().flush()?;
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// `lens open`, and Lens started from the Applications folder, the Start menu or the app menu:
/// everything `lens setup` does, without a terminal. It unpacks the bundled extensions, registers
/// with the browsers, starts Lens at login (the daemon then shows the tray icon), and opens the
/// welcome page until an extension has connected. A problem shows on that page.
pub fn open(paths: &Paths) -> io::Result<()> {
    let result = open_steps(paths);
    // The live setup wizard, when the app runs; the page below when it could not start.
    if result.is_ok()
        && let Ok(Reply::SetupPage(url)) = Client::attach(paths)
            .and_then(|mut c| c.call(Request::SetupPage).map_err(io::Error::other))
    {
        return open_url(&url);
    }
    let connected = matches!(result, Ok(true));
    let problem = result.as_ref().err().map(|e| e.to_string());
    if let Err(e) = &result {
        crate::daemon::log(paths, &format!("lens open: {e}"));
    }
    // A person opened the app: always answer with the page, which says what is left, if anything.
    let page = paths.data.join("welcome.html");
    std::fs::create_dir_all(&paths.data)?;
    std::fs::write(&page, welcome(paths, problem.as_deref(), connected))?;
    open_url(&page.display().to_string())?;
    result.map(drop)
}

/// The setup steps of `open`; true when an extension of this version has already connected.
fn open_steps(paths: &Paths) -> io::Result<bool> {
    let executable = crate::paths::executable()?;
    // Opened from the disk image, or moved by Gatekeeper to a random read-only folder: the
    // browsers and the login item would name a path that is gone after a restart.
    let at = executable.to_string_lossy();
    if cfg!(target_os = "macos")
        && (at.starts_with("/Volumes/") || at.contains("/AppTranslocation/"))
    {
        return Err(io::Error::other(
            "drag Sirv Lens to the Applications folder, then open it from there",
        ));
    }
    crate::bundle::sync_extensions(paths)?;
    crate::register::register(paths, &executable)?;
    crate::service::ensure(paths, &executable)?;
    // The service manager starts the daemon; give it a moment before asking it.
    for _ in 0..40 {
        if let Ok(found) = Client::attach(paths).and_then(|mut c| status(&mut c)) {
            return Ok(found
                .extensions
                .iter()
                .any(|e| e.client.protocol == PROTOCOL_VERSION));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(io::Error::other(
        "the Lens app did not start. Restart the computer, then open Sirv Lens again",
    ))
}

fn welcome(paths: &Paths, problem: Option<&str>, connected: bool) -> String {
    let escape = |text: &str| {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };
    let mut page = include_str!("welcome.html").to_string();
    // Firefox only where it is installed: one browser's steps are enough to read.
    let firefox = crate::register::check(paths, std::path::Path::new(""))
        .iter()
        .any(|b| b.name.starts_with("Firefox") && b.installed && !b.name.contains('('));
    if !firefox
        && let (Some(start), Some(end)) =
            (page.find("<!--firefox-->"), page.find("<!--/firefox-->"))
    {
        page.replace_range(start..end + "<!--/firefox-->".len(), "");
    }
    let tray = if cfg!(target_os = "macos") {
        "menu bar"
    } else {
        "system tray"
    };
    let (headline, lede) = if problem.is_some() {
        (
            "Lens could not finish its setup.".to_string(),
            "Open Sirv Lens again. If this page comes back, the reason is below.".to_string(),
        )
    } else if connected {
        (
            "Lens is ready.".to_string(),
            format!(
                "The Lens app runs in the background and starts with your computer; its icon is in the {tray}. The browser extension is connected: open the site you test and click the Lens button. To add Lens to another browser, follow the steps below."
            ),
        )
    } else {
        (
            "Lens is installed. Add it to your browser.".to_string(),
            format!(
                "The Lens app now runs in the background and starts with your computer; its icon is in the {tray}. One step is left: the browser extension, which records the site you test."
            ),
        )
    };
    page.replace("{{VERSION}}", env!("CARGO_PKG_VERSION"))
        .replace("{{HEADLINE}}", &headline)
        .replace("{{LEDE}}", &lede)
        .replace(
            "{{CHROME_FOLDER}}",
            &escape(&paths.data.join("extension").display().to_string()),
        )
        .replace(
            "{{FIREFOX_MANIFEST}}",
            &escape(
                &paths
                    .data
                    .join("extension-firefox")
                    .join("manifest.json")
                    .display()
                    .to_string(),
            ),
        )
        .replace(
            "{{PROBLEM}}",
            &problem
                .map(|p| {
                    format!(
                        "<p class=\"problem\" role=\"alert\">Setup stopped: {}</p>",
                        escape(p)
                    )
                })
                .unwrap_or_default(),
        )
}

pub fn open_url(url: &str) -> io::Result<()> {
    let (program, arguments): (&str, Vec<&str>) = if cfg!(target_os = "macos") {
        ("open", vec![url])
    } else if cfg!(windows) {
        // Not `cmd /C start`: cmd splits a URL at `&` (a deep link with two parameters).
        ("rundll32", vec!["url.dll,FileProtocolHandler", url])
    } else {
        ("xdg-open", vec![url])
    };
    std::process::Command::new(program)
        .args(arguments)
        .spawn()
        .map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{BrowserCheck, ClientInfo, ClientSeen};

    fn status() -> SetupStatus {
        SetupStatus {
            version: "1.0.0".into(),
            protocol: PROTOCOL_VERSION,
            binary: "/bin/lens".into(),
            service: None,
            browsers: vec![],
            extensions: vec![],
            projects: 0,
            captures: 0,
            vibeq_configured: false,
            coding_agents_connected: false,
            steps: vec![],
        }
    }

    fn mark(steps: &[Step], name: &str) -> Mark {
        steps.iter().find(|s| s.name == name).unwrap().mark
    }

    #[test]
    fn the_welcome_page_names_the_folders_and_escapes_them() {
        let page = welcome(
            &Paths {
                data: "/home/a&b/lens".into(),
                runtime: "/r".into(),
                logs: "/l".into(),
            },
            Some("<boom>"),
            false,
        );
        let extension = std::path::Path::new("/home/a&b/lens").join("extension");
        assert!(page.contains(&extension.display().to_string().replace('&', "&amp;")));
        assert!(page.contains("Setup stopped: &lt;boom&gt;"));
        assert!(!page.contains("{{"));
    }

    #[test]
    fn a_fresh_install_needs_every_browser_step() {
        let steps = steps(&status());
        for name in [
            "Starts at login",
            "Browser",
            "Browser extension",
            "A site to collect on",
        ] {
            assert_eq!(mark(&steps, name), Mark::Todo, "{name}");
        }
        assert_eq!(mark(&steps, "First recording"), Mark::Optional);
    }

    #[test]
    fn a_connected_extension_with_a_site_completes_setup() {
        let mut ready = status();
        ready.service = Some("systemd".into());
        ready.browsers = vec![BrowserCheck {
            name: "Google Chrome".into(),
            installed: true,
            registered: true,
            problem: None,
        }];
        ready.projects = 1;
        ready.extensions = vec![ClientSeen {
            client: ClientInfo {
                browser: "chrome".into(),
                extension_version: "1.0.0".into(),
                profile: "p".into(),
                protocol: PROTOCOL_VERSION,
                granted_origins: vec!["https://shop.test".into()],
                extension_id: None,
            },
            last_seen: 1,
        }];
        assert!(steps(&ready).iter().all(|s| s.mark != Mark::Todo));

        ready.extensions[0].client.protocol = PROTOCOL_VERSION + 1;
        let steps = steps(&ready);
        assert!(
            steps
                .iter()
                .find(|s| s.name == "Browser extension")
                .unwrap()
                .detail
                .contains("update Lens")
        );
    }

    #[test]
    fn an_older_extension_used_this_week_is_noted_but_does_not_fail() {
        let seen = |browser: &str, version: &str, last_seen: i64| ClientSeen {
            client: ClientInfo {
                browser: browser.into(),
                extension_version: version.into(),
                profile: browser.into(),
                protocol: PROTOCOL_VERSION,
                granted_origins: vec![],
                extension_id: None,
            },
            last_seen,
        };
        let now = crate::daemon::now_ms();
        let mut current = status();
        current.version = "0.12.22".into();
        current.extensions = vec![
            seen("chromium", "0.12.14", now),
            seen("firefox", "0.12.22", now),
            // Not used for weeks: a profile nobody opens says nothing.
            seen("chrome", "0.12.5", now - 30 * 24 * 60 * 60 * 1000),
        ];
        assert_eq!(older_extensions(&current), vec!["chromium 0.12.14"]);
        let mut replaced = current.clone();
        replaced.extensions.extend([
            // The same old copy in another profile, not next to the first: named once.
            seen("chromium", "0.12.14", now - 2),
            // Brave's unpacked copy, then its store build: nothing to say.
            seen("brave", "0.12.14", now - 1),
            seen("brave", "0.12.22", now),
        ]);
        assert_eq!(older_extensions(&replaced), vec!["chromium 0.12.14"]);
        let note = steps(&current)
            .into_iter()
            .find(|s| s.name == "Extension updates")
            .unwrap();
        assert_eq!(note.mark, Mark::Optional);
        assert!(note.detail.contains("chromium 0.12.14"));
    }

    #[test]
    fn a_stopped_lens_is_noted_and_its_checks_run_here() {
        assert_eq!(stopped_step(false).mark, Mark::Optional);
        assert!(stopped_step(true).detail.contains("you quit Lens"));
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths {
            data: dir.path().join("data"),
            runtime: dir.path().join("run"),
            logs: dir.path().join("logs"),
        };
        // No notebook yet: the local checks still run, and nothing is written.
        let found = setup_status(&paths, None).unwrap();
        assert_eq!(mark(&found.steps, "Lens app"), Mark::Done);
        assert_eq!(mark(&found.steps, "Browser extension"), Mark::Todo);
        assert!(!paths.data.exists() && !paths.runtime.exists());
    }

    #[test]
    fn the_doctor_names_the_agent_program_and_broken_copies() {
        use crate::investigate::{Agent, AgentInfo, AgentState};
        let step = agent_step(&AgentInfo {
            agent: Agent::Claude,
            state: AgentState::Ready,
            binary: Some("/usr/local/bin/claude".into()),
            broken: vec!["/home/me/.bun/bin/claude".into()],
            problem: None,
        });
        assert_eq!(step.mark, Mark::Done);
        assert!(step.detail.starts_with("ready: /usr/local/bin/claude"));
        assert!(step.detail.contains("skipped /home/me/.bun/bin/claude"));
        let missing = agent_step(&AgentInfo {
            agent: Agent::Codex,
            state: AgentState::Missing,
            binary: None,
            broken: vec![],
            problem: None,
        });
        assert_eq!(
            (missing.mark, missing.detail.as_str()),
            (Mark::Optional, "not found")
        );
    }
}
