//! `lens setup` and `lens doctor`: one checklist, built from the daemon's live checks. Setup fixes
//! what it can by itself (service, registrations) and then waits, step by step, for what only the
//! person can do in the browser. Doctor prints the same checks once.
use crate::client::Client;
use crate::paths::Paths;
use crate::protocol::{PROTOCOL_VERSION, Reply, Request, SetupStatus};
use std::io::{self, Write};
use std::time::Duration;

/// Chrome, Edge and Brave add Lens from here. Firefox loads it from this computer until Lens is on
/// Firefox Add-ons.
pub const CHROME_STORE: &str =
    "https://chromewebstore.google.com/detail/sirv-lens/lihjnfpbomppjmdlnchkookggmefanbg";

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

pub fn steps(status: &SetupStatus, paths: &Paths) -> Vec<Step> {
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
        (None, None) => step(
            "Browser extension",
            Mark::Todo,
            extension_instructions(paths),
        ),
    });

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

    steps.push(if status.vibeq_configured {
        step("VibeQ", Mark::Done, "address saved".into())
    } else {
        step(
            "VibeQ",
            Mark::Optional,
            "to file tasks: Lens Settings, then Sign in with VibeQ".into(),
        )
    });
    steps
}

fn extension_instructions(paths: &Paths) -> String {
    let firefox = paths.data.join("extension-firefox").join("manifest.json");
    if firefox.is_file() {
        format!(
            "add the extension in Chrome, Edge or Brave from {CHROME_STORE}; in Firefox, open about:debugging, This Firefox, Load Temporary Add-on, and choose {}",
            firefox.display()
        )
    } else {
        format!("add the extension in Chrome, Edge or Brave from {CHROME_STORE}")
    }
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

/// Prints every check once. Fails when a required step is open.
pub fn doctor(paths: &Paths) -> io::Result<()> {
    let mut client = Client::connect(paths)?;
    let steps = status(&mut client)?.steps;
    print(&steps);
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
            let _ = open_url(CHROME_STORE);
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
        "the Lens app did not start; run lens doctor in a terminal to see why",
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
        .any(|b| b.name.starts_with("Firefox") && b.installed);
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
    let (headline, lede) = if connected {
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
        ("cmd", vec!["/C", "start", "", url])
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
            steps: vec![],
        }
    }

    fn paths() -> Paths {
        Paths {
            data: "/nowhere".into(),
            runtime: "/nowhere/run".into(),
            logs: "/nowhere/logs".into(),
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
        let steps = steps(&status(), &paths());
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
        assert!(steps(&ready, &paths()).iter().all(|s| s.mark != Mark::Todo));

        ready.extensions[0].client.protocol = PROTOCOL_VERSION + 1;
        let steps = steps(&ready, &paths());
        assert!(
            steps
                .iter()
                .find(|s| s.name == "Browser extension")
                .unwrap()
                .detail
                .contains("update Lens")
        );
    }
}
