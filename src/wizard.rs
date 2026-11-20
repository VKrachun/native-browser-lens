//! The setup wizard: a page the daemon serves on 127.0.0.1, opened in the person's browser when
//! they open the app (and from the menu-bar icon). It shows each step with its live state, turns
//! green as the person does them, and offers the actions Lens can take for them: open a
//! browser's extensions page, show the extension folder, download the speech model, choose the
//! AI model, connect the coding agents, open Lens Settings.
//!
//! Access: the app opens a link that works once and for two minutes (a link in a command line or
//! the browser history is useless after that). It sets an HttpOnly, SameSite=Strict session
//! cookie, which every page and request then needs. The Host header must be the address itself
//! (no DNS rebinding) and actions must come from the page's own origin. It answers through the
//! daemon's own requests, from a short list.
use crate::daemon::Daemon;
use crate::investigate::{Agent, AgentInfo};
use crate::paths::Paths;
use crate::protocol::{Outcome, Reply, Request, SetupStatus, SpeechStatus};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const PAGE: &str = include_str!("setup.html");
const MAX_BODY: u64 = 16 * 1024;
/// How long a link from the app works.
const LINK_LIFE: Duration = Duration::from_secs(120);

pub struct Wizard {
    port: u16,
    session: String,
    links: Mutex<HashMap<String, Instant>>,
}

impl Wizard {
    /// A fresh address that opens the wizard once, within two minutes.
    pub fn link(&self) -> String {
        let code = uuid::Uuid::new_v4().simple().to_string();
        let mut links = self.links.lock().unwrap_or_else(|p| p.into_inner());
        links.retain(|_, made| made.elapsed() < LINK_LIFE);
        links.insert(code.clone(), Instant::now());
        format!("http://127.0.0.1:{}/start/{code}", self.port)
    }

    fn redeem(&self, code: &str) -> bool {
        let mut links = self.links.lock().unwrap_or_else(|p| p.into_inner());
        links
            .remove(code)
            .is_some_and(|made| made.elapsed() < LINK_LIFE)
    }

    fn cookie_name(&self) -> String {
        format!("lens_setup_{}", self.port)
    }

    /// Whether the request carries this wizard's session cookie.
    fn admitted(&self, request: &tiny_http::Request) -> bool {
        let name = self.cookie_name();
        header(request, "Cookie").is_some_and(|cookies| {
            cookies.split(';').any(|pair| {
                pair.trim()
                    .split_once('=')
                    .is_some_and(|(k, v)| k == name && same(v.as_bytes(), self.session.as_bytes()))
            })
        })
    }
}

/// Equal in time that does not depend on where they differ.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Starts the server.
pub fn serve(daemon: Arc<Daemon>, paths: &Paths) -> std::io::Result<Arc<Wizard>> {
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(std::io::Error::other)?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| std::io::Error::other("no port"))?;
    let wizard = Arc::new(Wizard {
        port,
        session: uuid::Uuid::new_v4().simple().to_string(),
        links: Mutex::new(HashMap::new()),
    });
    let paths = paths.clone();
    let serving = wizard.clone();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let (daemon, paths, wizard) = (daemon.clone(), paths.clone(), serving.clone());
            std::thread::spawn(move || answer(&daemon, &paths, &wizard, request));
        }
    });
    Ok(wizard)
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
enum Action {
    OpenExtensions {
        browser: String,
    },
    OpenStore {
        browser: String,
    },
    OpenSettings {
        browser: String,
    },
    ShowFolder {
        firefox: bool,
    },
    InstallSpeech,
    SetDestination {
        choice: crate::protocol::TaskDestination,
    },
    SetSummaryAgent {
        agent: Option<Agent>,
    },
    ConnectAgents,
}

fn header<'a>(request: &'a tiny_http::Request, name: &str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

fn send(
    request: tiny_http::Request,
    status: u16,
    kind: &str,
    body: String,
    extra: &[(&str, &str)],
) {
    let mut response = tiny_http::Response::from_string(body).with_status_code(status);
    let common = [
        ("Content-Type", kind),
        ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"),
        (
            "Content-Security-Policy",
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; \
             connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; \
             form-action 'none'",
        ),
    ];
    for (name, value) in common.iter().chain(extra) {
        if let Ok(h) = tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()) {
            response.add_header(h);
        }
    }
    let _ = request.respond(response);
}

fn refuse(request: tiny_http::Request, status: u16, text: &str) {
    send(
        request,
        status,
        "text/plain; charset=utf-8",
        text.into(),
        &[],
    );
}

fn answer(daemon: &Daemon, paths: &Paths, wizard: &Wizard, mut request: tiny_http::Request) {
    let origin = format!("http://127.0.0.1:{}", wizard.port);
    if header(&request, "Host") != Some(&origin[7..]) {
        return refuse(request, 403, "Forbidden");
    }
    let url = request.url().to_string();
    if let Some(code) = url.strip_prefix("/start/") {
        if request.method() != &tiny_http::Method::Get || !wizard.redeem(code) {
            return refuse(
                request,
                403,
                "This setup link was used already or is too old. Open Set up Lens again from the Lens icon.",
            );
        }
        let cookie = format!(
            "{}={}; HttpOnly; SameSite=Strict; Path=/",
            wizard.cookie_name(),
            wizard.session
        );
        return send(
            request,
            303,
            "text/plain",
            String::new(),
            &[("Location", "/"), ("Set-Cookie", &cookie)],
        );
    }
    if !wizard.admitted(&request) {
        return refuse(
            request,
            403,
            "Open Set up Lens from the Lens icon, or open the Lens app: this page needs its link.",
        );
    }
    let json_kind = "application/json; charset=utf-8";
    match (request.method(), url.as_str()) {
        (tiny_http::Method::Get, "/") => send(
            request,
            200,
            "text/html; charset=utf-8",
            PAGE.to_string(),
            &[],
        ),
        (tiny_http::Method::Get, "/status") => {
            let body = status(daemon, paths).to_string();
            send(request, 200, json_kind, body, &[])
        }
        (tiny_http::Method::Post, "/action") => {
            let same_origin = header(&request, "Origin") == Some(origin.as_str());
            let is_json =
                header(&request, "Content-Type").is_some_and(|t| t.starts_with("application/json"));
            if !same_origin || !is_json {
                return refuse(request, 403, "Forbidden");
            }
            let mut body = String::new();
            if request
                .as_reader()
                .take(MAX_BODY)
                .read_to_string(&mut body)
                .is_err()
            {
                return refuse(request, 400, "Bad request");
            }
            let result = match serde_json::from_str::<Action>(&body) {
                Ok(action) => act(daemon, paths, action),
                Err(e) => Err(format!("unknown action: {e}")),
            };
            let body = match result {
                Ok(()) => json!({ "ok": true }),
                Err(error) => json!({ "ok": false, "error": error }),
            };
            send(request, 200, json_kind, body.to_string(), &[])
        }
        _ => refuse(request, 404, "Not found"),
    }
}

fn ask(daemon: &Daemon, request: Request) -> Result<Reply, String> {
    match daemon.handle(request) {
        Outcome::Ok { result } => Ok(*result),
        Outcome::Error { error } => Err(error.message),
    }
}

/// Everything the page shows, in one answer it asks for every two seconds.
fn status(daemon: &Daemon, paths: &Paths) -> Value {
    let setup: Option<SetupStatus> = match ask(daemon, Request::SetupStatus) {
        Ok(Reply::Setup(status)) => Some(*status),
        _ => None,
    };
    let speech: Option<SpeechStatus> = match ask(daemon, Request::SpeechStatus) {
        Ok(Reply::Speech(status)) => Some(status),
        _ => None,
    };
    let agents: Vec<AgentInfo> = match ask(daemon, Request::ListAgents) {
        Ok(Reply::Agents(agents)) => agents,
        _ => Vec::new(),
    };
    let summary_agent = match ask(daemon, Request::GetSummaryAgent) {
        Ok(Reply::SummaryAgent(agent)) => agent,
        _ => None,
    };
    let destination = match ask(daemon, Request::GetDestination) {
        Ok(Reply::Destination(settings)) => Some(settings),
        _ => None,
    };
    let signed_in = destination.as_ref().is_some_and(|d| d.vibeq_connected);
    let account = if signed_in {
        match ask(daemon, Request::GetVibeQ) {
            Ok(Reply::VibeQ(settings)) => settings.account,
            _ => None,
        }
    } else {
        None
    };
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    };
    let browsers: Vec<Value> = setup
        .as_ref()
        .map(|s| {
            s.browsers
                .iter()
                .filter(|b| b.installed)
                .map(|b| {
                    json!({
                        "name": b.name,
                        "registered": b.registered,
                        "problem": b.problem,
                        "firefox": b.name.starts_with("Firefox"),
                        "page": launcher(&b.name).map(|l| l.page),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": platform,
        "setup": setup,
        "browsers": browsers,
        "speech": speech,
        "agents": agents,
        "vibeq": { "signedIn": signed_in, "account": account },
        "destination": destination,
        "summaryAgent": summary_agent,
        "codingAgentsConnected": crate::agents::connected(),
        "folders": {
            "chromium": paths.data.join("extension").display().to_string(),
            "firefox": paths.data.join("extension-firefox").join("manifest.json").display().to_string(),
        },
    })
}

fn act(daemon: &Daemon, paths: &Paths, action: Action) -> Result<(), String> {
    match action {
        Action::OpenExtensions { browser } => {
            let launch = launcher(&browser).ok_or("Lens does not know that browser")?;
            open_in(&launch, launch.page)
        }
        Action::OpenStore { browser } => {
            let launch = launcher(&browser).ok_or("Lens does not know that browser")?;
            let store = if launch.firefox {
                crate::setup::FIREFOX_STORE
            } else {
                crate::setup::CHROME_STORE
            };
            open_in(&launch, store)
        }
        Action::OpenSettings { browser } => {
            let launch = launcher(&browser).ok_or("Lens does not know that browser")?;
            if launch.firefox {
                return Err("in Firefox, open the Lens sidebar and choose Settings".into());
            }
            let id = connected_id(daemon).ok_or("add the extension first")?;
            open_in(&launch, &format!("chrome-extension://{id}/options.html"))
        }
        Action::ShowFolder { firefox } => {
            let folder = paths.data.join(if firefox {
                "extension-firefox"
            } else {
                "extension"
            });
            crate::setup::open_url(&folder.display().to_string()).map_err(|e| e.to_string())
        }
        Action::InstallSpeech => ask(daemon, Request::InstallSpeech).map(drop),
        Action::SetDestination { choice } => ask(
            daemon,
            Request::SetDestination {
                choice,
                only_if_unset: false,
            },
        )
        .map(drop),
        Action::SetSummaryAgent { agent } => {
            ask(daemon, Request::SetSummaryAgent { agent }).map(drop)
        }
        Action::ConnectAgents => match ask(daemon, Request::ConnectAgents)? {
            Reply::AgentSetup(done) => match done.iter().find(|d| !d.ok) {
                Some(failed) => Err(format!("{}: {}", failed.agent, failed.detail)),
                None => Ok(()),
            },
            _ => Ok(()),
        },
    }
}

/// The ID of the newest connected Chromium extension, as it reported itself.
fn connected_id(daemon: &Daemon) -> Option<String> {
    match ask(daemon, Request::SetupStatus) {
        Ok(Reply::Setup(status)) => status
            .extensions
            .iter()
            .filter(|e| e.client.browser != "firefox")
            .find_map(|e| e.client.extension_id.clone())
            .filter(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))),
        _ => None,
    }
}

struct Launch {
    /// A Flatpak's application ID: Linux starts it with `flatpak run`.
    flatpak: Option<&'static str>,
    mac_app: &'static str,
    linux: &'static [&'static str],
    windows: &'static str,
    page: &'static str,
    firefox: bool,
}

/// How to start a browser by the name Lens's registration gives it.
fn launcher(name: &str) -> Option<Launch> {
    if let Some(base) = name.strip_suffix(" (Flatpak)") {
        let id = match base {
            "Google Chrome" => "com.google.Chrome",
            "Chromium" => "org.chromium.Chromium",
            "Microsoft Edge" => "com.microsoft.Edge",
            "Brave" => "com.brave.Browser",
            "Firefox" => "org.mozilla.firefox",
            _ => return None,
        };
        return launcher(base).map(|l| Launch {
            flatpak: Some(id),
            ..l
        });
    }
    let chromium = |mac_app, linux, windows, page| Launch {
        flatpak: None,
        mac_app,
        linux,
        windows,
        page,
        firefox: false,
    };
    Some(match name {
        "Google Chrome" => chromium(
            "Google Chrome",
            &["google-chrome-stable", "google-chrome"],
            "chrome",
            "chrome://extensions",
        ),
        "Chromium" => chromium(
            "Chromium",
            &["chromium", "chromium-browser"],
            "chromium",
            "chrome://extensions",
        ),
        "Microsoft Edge" => chromium(
            "Microsoft Edge",
            &["microsoft-edge-stable", "microsoft-edge"],
            "msedge",
            "edge://extensions",
        ),
        "Brave" => chromium(
            "Brave Browser",
            &["brave-browser", "brave"],
            "brave",
            "brave://extensions",
        ),
        "Firefox" => Launch {
            flatpak: None,
            mac_app: "Firefox",
            linux: &["firefox"],
            windows: "firefox",
            page: "about:debugging#/runtime/this-firefox",
            firefox: true,
        },
        _ => return None,
    })
}

fn open_in(launch: &Launch, url: &str) -> Result<(), String> {
    let mut command = if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.args(["-a", launch.mac_app, url]);
        c
    } else if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", "start", "", launch.windows, url]);
        c
    } else if let Some(id) = launch.flatpak {
        let mut c = Command::new("flatpak");
        c.args(["run", id, url]);
        c
    } else {
        let program = launch
            .linux
            .iter()
            .find_map(|name| crate::investigate::program(name))
            .ok_or("Lens cannot find that browser's program")?;
        let mut c = Command::new(program);
        c.arg(url);
        c
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command
        .spawn()
        .map(drop)
        .map_err(|e| format!("cannot open the browser: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_registered_browser_can_be_opened() {
        for name in [
            "Google Chrome",
            "Chromium",
            "Microsoft Edge",
            "Brave",
            "Firefox",
        ] {
            let launch = launcher(name).expect(name);
            assert!(
                launch.page.contains("extensions") || launch.firefox,
                "{name}"
            );
        }
        assert!(launcher("Netscape").is_none());
        assert_eq!(
            launcher("Google Chrome (Flatpak)").unwrap().flatpak,
            Some("com.google.Chrome")
        );
        assert!(launcher("Firefox (Flatpak)").unwrap().firefox);
    }

    #[test]
    fn links_work_once_and_cookies_compare_whole() {
        let wizard = Wizard {
            port: 1,
            session: "s".into(),
            links: Mutex::new(HashMap::new()),
        };
        let link = wizard.link();
        let code = link.rsplit('/').next().unwrap();
        assert!(wizard.redeem(code));
        assert!(!wizard.redeem(code), "a link works once");
        assert!(!wizard.redeem("made-up"));
        assert!(same(b"abc", b"abc"));
        assert!(!same(b"abc", b"abd"));
        assert!(!same(b"abc", b"ab"));
    }

    #[test]
    fn actions_parse() {
        let action: Action =
            serde_json::from_str(r#"{"action":"openExtensions","browser":"Brave"}"#).unwrap();
        assert!(matches!(action, Action::OpenExtensions { browser } if browser == "Brave"));
        let action: Action =
            serde_json::from_str(r#"{"action":"openStore","browser":"Brave"}"#).unwrap();
        assert!(matches!(action, Action::OpenStore { browser } if browser == "Brave"));
        assert!(serde_json::from_str::<Action>(r#"{"action":"shutdown"}"#).is_err());
    }
}
