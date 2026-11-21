mod agents;
mod attachments;
mod blobs;
mod bundle;
mod cli;
mod client;
mod daemon;
mod destination;
mod digest;
mod export;
mod filing;
mod framing;
mod handoff;
mod investigate;
mod ipc;
mod live;
mod mcp;
mod paths;
mod protocol;
mod record;
mod register;
mod render;
mod repro;
mod secrets;
mod service;
mod setup;
mod shim;
mod speech;
mod store;
mod tray;
mod update;
mod verify;
mod vibeq;
mod wizard;

use paths::Paths;
use protocol::{MAX_REPLY_BYTES, ReplyFrame, Request, RequestFrame};
use std::process::ExitCode;

const USAGE: &str = "Usage: lens <command>

  open               Set Lens up without a terminal and open the welcome page
  setup              Set Lens up step by step, checking each step
  setup-page         Print a link that opens the setup wizard once (open opens it)
  doctor             Check every setup step once
  status             Show the version, folders, service and daemon
  paths <name>       Print one folder: data, logs or extension (for scripts)
  start              Start Lens in the background
  stop               Stop Lens; neither the service nor the browser starts it again
  restart            Stop, then start
  update [--check]   Install the newest signed release (--check only reports it)
  service install    Start Lens at login (per user, no admin rights)
  service uninstall  Stop starting Lens at login
  register           Register Lens with every installed browser (per user)
  unregister         Remove those registrations
  reviews [--json]   List the reviews, newest first, with their VibeQ tasks
  review <id>        Print one review as JSON (what the MCP tool get_review returns)
  export <id> [--to DIR]
                     Write a review to a folder: report, screenshots, evidence, a
                     Playwright test and a HAR; prints the folder
  export <id> --playwright [--to DIR] [--base-url URL]
                     Write each capture's Playwright test and HAR for the project
                     (default tests/lens), against the dev server or the baseURL
  verify <id> --base-url URL [--capture N] [--project DIR]
                     Repeat the steps on the dev server with the project's
                     Playwright; say whether the recorded failures happen again
  recent [site]      The last ten minutes the browser holds for a site: failed
                     requests, console errors, steps (turn it on in Settings)
  agents connect     Give the coding agents here the sirv-lens skill and MCP server
                     (Claude Code, Codex, Cursor, Gemini CLI)
  agents disconnect  Take them back
  mcp                Serve reviewed defects to coding agents over MCP (stdio)
  tray               Show the Lens menu-bar / tray icon
  daemon             Run the Lens daemon in the foreground
  version            Print the version";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        // Chromium passes the caller's origin; Firefox passes the path of the host manifest.
        Some(a) if a.starts_with("chrome-extension://") || a.ends_with(".json") => {
            with_paths(shim::run)
        }
        Some("daemon") => {
            let service = args.get(1).is_some_and(|a| a == "--service");
            with_paths(|p| daemon::run(p, service))
        }
        Some("start") => with_paths(|p| service::start(p).map(|()| println!("started"))),
        Some("restart") => with_paths(|p| {
            if args.get(1).is_some_and(|a| a == "--after") {
                let seconds = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(2);
                std::thread::sleep(std::time::Duration::from_secs(seconds));
            }
            stop_daemon(p)?;
            service::start(p)?;
            println!("restarted");
            Ok(())
        }),
        Some("service") => match args.get(1).map(String::as_str) {
            Some("install") => with_paths(|p| {
                service::install(p, &crate::paths::executable()?)?;
                println!("Lens now starts at login and runs in the background.");
                Ok(())
            }),
            Some("uninstall") => with_paths(|p| {
                service::uninstall(p)?;
                println!("Lens no longer starts at login.");
                Ok(())
            }),
            _ => {
                eprintln!("{USAGE}");
                return ExitCode::from(2);
            }
        },
        Some("register") => {
            with_paths(|p| print_report(register::register(p, &crate::paths::executable()?)?))
        }
        Some("unregister") => with_paths(|p| print_report(register::unregister(p)?)),
        Some("status") => with_paths(status),
        Some("setup") => with_paths(setup::setup),
        Some("open") => with_paths(setup::open),
        // Started from the Applications folder, the Start menu or the app menu: no terminal.
        None if !std::io::IsTerminal::is_terminal(&std::io::stdout()) => with_paths(setup::open),
        Some("update") => with_paths(|p| {
            let executable = crate::paths::executable()?;
            if let Some(manager) = update::managed_by(&executable) {
                println!("{manager} updates this copy of Lens.");
                return Ok(());
            }
            match update::check().map_err(std::io::Error::other)? {
                None => println!("Lens {} is the newest version.", env!("CARGO_PKG_VERSION")),
                Some(manifest) if args.get(1).is_some_and(|a| a == "--check") => {
                    println!(
                        "Lens {} is available; lens update installs it.",
                        manifest.version
                    )
                }
                Some(manifest) => {
                    update::install(p, &manifest).map_err(std::io::Error::other)?;
                    // This process still runs the old file, which Linux now reports as deleted:
                    // the new binary, at the path read before the update, does the restart.
                    if ipc::connect(p).is_ok() || service::state(p) != service::State::NotInstalled
                    {
                        // No inherited output: on Windows the daemon this starts would keep a
                        // pipe like `lens update | grep` open, and the reader would never finish.
                        std::process::Command::new(&executable)
                            .arg("restart")
                            .stdin(std::process::Stdio::null())
                            .stdout(std::process::Stdio::null())
                            .stderr(std::process::Stdio::null())
                            .status()?;
                    }
                    println!("Lens {} is installed.", manifest.version);
                }
            }
            Ok(())
        }),
        Some("paths") => with_paths(|p| {
            let folder = match args.get(1).map(String::as_str) {
                Some("data") => p.data.clone(),
                Some("logs") => p.logs.clone(),
                Some("extension") => p.data.join("extension"),
                _ => return Err(std::io::Error::other("lens paths data|logs|extension")),
            };
            println!("{}", folder.display());
            Ok(())
        }),
        Some("doctor") => with_paths(setup::doctor),
        Some("mcp") => with_paths(mcp::run),
        Some("reviews") => {
            let json = args.iter().any(|a| a == "--json");
            with_paths(|p| cli::reviews(p, json))
        }
        Some("review") => match args.get(1) {
            Some(id) => with_paths(|p| cli::show(p, id)),
            None => Err(std::io::Error::other("lens review <id> (see lens reviews)")),
        },
        Some("export") => match args.get(1) {
            Some(id) => {
                let flag = |name: &str| {
                    args.iter()
                        .position(|a| a == name)
                        .and_then(|i| args.get(i + 1))
                        .map(String::as_str)
                };
                let (to, base) = (flag("--to"), flag("--base-url"));
                if args.iter().any(|a| a == "--playwright") {
                    with_paths(|p| cli::playwright(p, id, to, base))
                } else {
                    with_paths(|p| cli::export(p, id, to))
                }
            }
            None => Err(std::io::Error::other(
                "lens export <id> [--to DIR] | lens export <id> --playwright [--to DIR] [--base-url URL]",
            )),
        },
        Some("agents") => cli::agents(args.get(1).map(String::as_str)),
        Some("verify") => match args.get(1) {
            Some(id) => {
                let flag = |name: &str| {
                    args.iter()
                        .position(|a| a == name)
                        .and_then(|i| args.get(i + 1))
                        .map(String::as_str)
                };
                with_paths(|p| {
                    cli::verify(
                        p,
                        id,
                        flag("--base-url"),
                        flag("--capture"),
                        flag("--project"),
                    )
                })
            }
            None => Err(std::io::Error::other(
                "lens verify <id> --base-url http://localhost:3000 [--capture N] [--project DIR]",
            )),
        },
        Some("setup-page") => with_paths(|p| {
            match crate::client::Client::connect(p)?
                .call(Request::SetupPage)
                .map_err(std::io::Error::other)?
            {
                protocol::Reply::SetupPage(url) => println!("{url}"),
                _ => return Err(std::io::Error::other("unexpected reply")),
            }
            Ok(())
        }),
        Some("recent") => {
            let site = args.get(1).map(String::as_str);
            with_paths(|p| cli::recent(p, site))
        }
        Some("tray") => {
            let wait = args.get(1).is_some_and(|a| a == "--wait");
            with_paths(|p| tray::run(p, wait))
        }
        Some("stop") => with_paths(stop),
        Some("version" | "--version" | "-V") => {
            println!("lens {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("help" | "--help" | "-h") => {
            println!("{USAGE}");
            Ok(())
        }
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        // The reader stopped early, as `lens reviews | head` does: not an error.
        Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("lens: {e}");
            ExitCode::FAILURE
        }
    }
}

fn with_paths(run: impl FnOnce(&Paths) -> std::io::Result<()>) -> std::io::Result<()> {
    run(&Paths::resolve()?)
}

fn print_report(report: register::Report) -> std::io::Result<()> {
    for (browser, line) in report {
        println!("{browser:<16} {line}");
    }
    Ok(())
}

fn ask(paths: &Paths, request: Request) -> std::io::Result<Option<ReplyFrame>> {
    let Ok(mut stream) = ipc::connect(paths) else {
        return Ok(None);
    };
    framing::write_frame(
        &mut stream,
        &serde_json::to_vec(&RequestFrame { id: 1, request })?,
    )?;
    let reply = framing::read_frame(&mut stream, MAX_REPLY_BYTES)?
        .ok_or_else(|| std::io::Error::other("the daemon closed the connection"))?;
    Ok(Some(serde_json::from_slice(&reply)?))
}

fn status(paths: &Paths) -> std::io::Result<()> {
    println!("version          {}", env!("CARGO_PKG_VERSION"));
    println!("binary           {}", crate::paths::executable()?.display());
    println!("data             {}", paths.data.display());
    println!("logs             {}", paths.logs.display());
    match service::state(paths) {
        service::State::Installed { manager } => {
            println!("service          starts at login ({manager})")
        }
        service::State::NotInstalled => {
            println!("service          not installed (lens service install)")
        }
    }
    match ask(paths, Request::Hello)? {
        Some(ReplyFrame {
            outcome: protocol::Outcome::Ok { result },
            ..
        }) => match *result {
            protocol::Reply::Hello(hello) => {
                println!("daemon           running, version {}", hello.version)
            }
            _ => println!("daemon           running"),
        },
        Some(_) => println!("daemon           running, but it refused the status request"),
        None => println!("daemon           stopped"),
    }
    Ok(())
}

/// Asks the daemon to exit and waits until it has; Ok when none was running.
pub fn stop_daemon(paths: &Paths) -> std::io::Result<bool> {
    if ask(paths, Request::Shutdown)?.is_none() {
        return Ok(false);
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while ipc::connect(paths).is_ok() {
        if std::time::Instant::now() > deadline {
            return Err(std::io::Error::other(
                "the daemon did not stop within 10 seconds",
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Ok(true)
}

/// Stops Lens until the person starts it again: the browser no longer starts it on its own.
pub fn quit(paths: &Paths) -> std::io::Result<bool> {
    // First the marker: a browser page that asks in the moment of the stop must not start it again.
    paths.ensure()?;
    std::fs::write(paths.quit_marker(), b"")?;
    stop_daemon(paths)
}

fn stop(paths: &Paths) -> std::io::Result<()> {
    println!(
        "{}",
        if quit(paths)? {
            "stopped"
        } else {
            "not running"
        }
    );
    Ok(())
}
