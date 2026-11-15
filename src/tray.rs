//! `lens tray`: the menu-bar / system-tray icon. It shows whether Lens runs, the setup progress and
//! updates, and offers pause, automatic updates, update now, logs, restart and quit. It only talks
//! to the daemon; it never starts one by itself except through Start or Restart.
use crate::client::Client;
use crate::paths::Paths;
use crate::protocol::{Reply, Request};
use crate::setup::Mark;
use std::fs::{File, TryLockError};
use std::io;
use std::time::Duration;

const POLL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Snapshot {
    pub running: bool,
    pub version: String,
    pub paused: bool,
    pub setup_done: usize,
    pub setup_required: usize,
    pub automatic: bool,
    pub managed: bool,
    pub available: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Action {
    TogglePause,
    ToggleAutomatic,
    UpdateNow,
    OpenLogs,
    Start,
    Restart,
    Quit,
}

/// What the daemon says now; a stopped daemon gives the default (not running).
pub fn snapshot(paths: &Paths) -> Snapshot {
    let Ok(mut client) = Client::attach(paths) else {
        return Snapshot::default();
    };
    let mut snapshot = Snapshot {
        running: true,
        ..Snapshot::default()
    };
    if let Ok(Reply::Hello(hello)) = client.call(Request::Hello) {
        snapshot.version = hello.version;
        snapshot.paused = hello.paused;
    }
    if let Ok(Reply::Setup(status)) = client.call(Request::SetupStatus) {
        let required = status.steps.iter().filter(|s| s.mark != Mark::Optional);
        snapshot.setup_required = required.clone().count();
        snapshot.setup_done = required.filter(|s| s.mark == Mark::Done).count();
    }
    if let Ok(Reply::Updates(updates)) = client.call(Request::GetUpdates) {
        snapshot.automatic = updates.automatic;
        snapshot.managed = updates.managed_by.is_some();
        snapshot.available = updates.available;
    }
    snapshot
}

pub fn perform(paths: &Paths, action: Action, now: &Snapshot) {
    let call =
        |request| Client::attach(paths).and_then(|mut c| c.call(request).map_err(io::Error::other));
    let result = match action {
        Action::TogglePause => call(Request::SetPaused {
            paused: !now.paused,
        })
        .map(drop),
        Action::ToggleAutomatic => call(Request::SetAutomaticUpdates {
            enabled: !now.automatic,
        })
        .map(drop),
        // Minutes at most; the daemon restarts itself when it installs one.
        Action::UpdateNow => {
            let paths = paths.clone();
            std::thread::spawn(move || {
                let _ = Client::attach(&paths).map(|mut c| c.call(Request::UpdateNow));
            });
            Ok(())
        }
        Action::OpenLogs => open(&paths.logs),
        Action::Start => crate::service::start(paths),
        Action::Restart => crate::paths::executable().and_then(|exe| {
            std::process::Command::new(exe)
                .arg("restart")
                .spawn()
                .map(drop)
        }),
        Action::Quit => {
            let _ = crate::stop_daemon(paths);
            std::process::exit(0);
        }
    };
    if let Err(e) = result {
        crate::daemon::log(paths, &format!("tray: {action:?} failed: {e}"));
    }
}

fn open(folder: &std::path::Path) -> io::Result<()> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(folder)
        .spawn()
        .map(drop)
}

/// The menu as data, so both tray front ends show the same items.
pub struct Item {
    pub label: String,
    pub action: Option<Action>,
    /// Some for a check item.
    pub checked: Option<bool>,
}

pub fn menu(now: &Snapshot) -> Vec<Option<Item>> {
    let text = |label: String| {
        Some(Item {
            label,
            action: None,
            checked: None,
        })
    };
    let button = |label: &str, action| {
        Some(Item {
            label: label.into(),
            action: Some(action),
            checked: None,
        })
    };
    let check = |label: &str, action, on| {
        Some(Item {
            label: label.into(),
            action: Some(action),
            checked: Some(on),
        })
    };
    if !now.running {
        return vec![
            text("Lens is stopped".into()),
            None,
            button("Start Lens", Action::Start),
            button("Open log folder", Action::OpenLogs),
        ];
    }
    let mut items = vec![text(format!("Lens {} is running", now.version))];
    if now.setup_done < now.setup_required {
        items.push(text(format!(
            "Setup: {} of {} done (lens setup)",
            now.setup_done, now.setup_required
        )));
    }
    items.push(None);
    items.push(check("Pause collection", Action::TogglePause, now.paused));
    if !now.managed {
        items.push(check(
            "Install updates automatically",
            Action::ToggleAutomatic,
            now.automatic,
        ));
        let update = match &now.available {
            Some(version) => format!("Update to {version} now"),
            None => "Check for updates now".into(),
        };
        items.push(Some(Item {
            label: update,
            action: Some(Action::UpdateNow),
            checked: None,
        }));
    }
    items.push(button("Open log folder", Action::OpenLogs));
    items.push(None);
    items.push(button("Restart Lens", Action::Restart));
    items.push(button("Quit Lens", Action::Quit));
    items
}

/// A lens ring, drawn here so no image files ship: blue while Lens runs, grey when it is stopped.
pub fn icon_rgba(size: u32, running: bool) -> Vec<u8> {
    let mut pixmap = tiny_skia::Pixmap::new(size, size).expect("icon size is positive");
    let mut paint = tiny_skia::Paint::default();
    if running {
        paint.set_color_rgba8(47, 123, 255, 255);
    } else {
        paint.set_color_rgba8(140, 140, 140, 255);
    }
    paint.anti_alias = true;
    let s = size as f32;
    if let Some(ring) = tiny_skia::PathBuilder::from_circle(s * 0.42, s * 0.42, s * 0.3) {
        let stroke = tiny_skia::Stroke {
            width: s * 0.12,
            ..Default::default()
        };
        pixmap.stroke_path(
            &ring,
            &paint,
            &stroke,
            tiny_skia::Transform::identity(),
            None,
        );
    }
    let mut handle = tiny_skia::PathBuilder::new();
    handle.move_to(s * 0.64, s * 0.64);
    handle.line_to(s * 0.9, s * 0.9);
    if let Some(handle) = handle.finish() {
        let stroke = tiny_skia::Stroke {
            width: s * 0.14,
            line_cap: tiny_skia::LineCap::Round,
            ..Default::default()
        };
        pixmap.stroke_path(
            &handle,
            &paint,
            &stroke,
            tiny_skia::Transform::identity(),
            None,
        );
    }
    // tiny-skia stores premultiplied RGBA; tray APIs take straight RGBA.
    pixmap
        .pixels()
        .iter()
        .flat_map(|p| {
            let c = p.demultiply();
            [c.red(), c.green(), c.blue(), c.alpha()]
        })
        .collect()
}

/// One tray per user session. `wait`: a tray that replaces an older one waits for it to let go.
fn single_instance(paths: &Paths, wait: bool) -> io::Result<Option<File>> {
    paths.ensure()?;
    let lock = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.runtime.join("tray.lock"))?;
    for _ in 0..if wait { 40 } else { 1 } {
        match lock.try_lock() {
            Ok(()) => return Ok(Some(lock)),
            Err(TryLockError::WouldBlock) => {
                std::thread::sleep(std::time::Duration::from_millis(250))
            }
            Err(TryLockError::Error(e)) => return Err(e),
        }
    }
    Ok(None)
}

/// Whether a tray holds its lock now.
pub fn running(paths: &Paths) -> bool {
    let Ok(lock) = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.runtime.join("tray.lock"))
    else {
        return true;
    };
    // Taken means a tray runs; free means none does (the lock goes with the file on drop).
    lock.try_lock().is_err()
}

pub fn run(paths: &Paths, wait: bool) -> io::Result<()> {
    let Some(_lock) = single_instance(paths, wait)? else {
        return Ok(());
    };
    platform::run(paths)
}

/// When this tray's program file changed on disk, as an update or a new installer does.
fn program_stamp() -> Option<std::time::SystemTime> {
    std::fs::metadata(crate::paths::executable().ok()?)
        .and_then(|m| m.modified())
        .ok()
}

/// An update replaced the program: start a tray from the new file and end this one. The new
/// tray waits for this one's lock; without this the old tray ran until logout.
fn hand_over_if_replaced(started: Option<std::time::SystemTime>) {
    if started.is_none() || program_stamp() == started {
        return;
    }
    if let Ok(executable) = crate::paths::executable() {
        let program = if cfg!(windows) {
            executable.with_file_name("lensw.exe")
        } else {
            executable
        };
        let _ = std::process::Command::new(program)
            .args(["tray", "--wait"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
    std::process::exit(0);
}

/// Starts the tray beside the service's daemon, detached, without a console window.
pub fn spawn(paths: &Paths) {
    let Ok(executable) = crate::paths::executable() else {
        return;
    };
    let program = if cfg!(windows) {
        executable.with_file_name("lensw.exe")
    } else {
        executable
    };
    let mut command = std::process::Command::new(program);
    command
        .arg("tray")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    if let Err(e) = command.spawn() {
        crate::daemon::log(paths, &format!("cannot start the tray: {e}"));
    }
}

// ---------------------------------------------------------------- Linux: StatusNotifierItem

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use super::*;
    use ksni::blocking::TrayMethods;

    struct LensTray {
        paths: Paths,
        now: Snapshot,
    }

    impl ksni::Tray for LensTray {
        fn id(&self) -> String {
            "sirv-lens".into()
        }
        fn title(&self) -> String {
            "Sirv Lens".into()
        }
        fn icon_pixmap(&self) -> Vec<ksni::Icon> {
            let size = 32;
            // StatusNotifier wants ARGB32 in network byte order.
            let data = icon_rgba(size, self.now.running)
                .chunks(4)
                .flat_map(|p| [p[3], p[0], p[1], p[2]])
                .collect();
            vec![ksni::Icon {
                width: size as i32,
                height: size as i32,
                data,
            }]
        }
        fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
            use ksni::menu::{CheckmarkItem, StandardItem};
            menu(&self.now)
                .into_iter()
                .map(|item| match item {
                    None => ksni::MenuItem::Separator,
                    Some(Item {
                        label,
                        action: Some(action),
                        checked: Some(on),
                    }) => CheckmarkItem {
                        label,
                        checked: on,
                        activate: Box::new(move |tray: &mut Self| {
                            perform(&tray.paths, action, &tray.now)
                        }),
                        ..Default::default()
                    }
                    .into(),
                    Some(Item { label, action, .. }) => StandardItem {
                        label,
                        enabled: action.is_some(),
                        activate: Box::new(move |tray: &mut Self| {
                            if let Some(action) = action {
                                perform(&tray.paths, action, &tray.now)
                            }
                        }),
                        ..Default::default()
                    }
                    .into(),
                })
                .collect()
        }
    }

    pub fn run(paths: &Paths) -> io::Result<()> {
        let tray = LensTray {
            paths: paths.clone(),
            now: snapshot(paths),
        };
        // No StatusNotifier host (a headless session, or GNOME without its AppIndicator
        // extension): there is nowhere to show an icon, so the tray ends quietly.
        let handle = tray
            .spawn()
            .map_err(|e| io::Error::other(format!("no system tray here: {e}")))?;
        let started = program_stamp();
        loop {
            std::thread::sleep(POLL);
            hand_over_if_replaced(started);
            let now = snapshot(paths);
            handle.update(|tray| tray.now = now);
            if handle.is_closed() {
                return Ok(());
            }
        }
    }
}

// ---------------------------------------------------------------- macOS and Windows

#[cfg(any(target_os = "macos", windows))]
mod platform {
    use super::*;
    use std::collections::HashMap;
    use std::time::Instant;
    use tao::event::{Event, StartCause};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
    use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

    fn build(now: &Snapshot) -> (Menu, HashMap<String, Action>) {
        let menu = Menu::new();
        let mut actions = HashMap::new();
        for (index, item) in super::menu(now).into_iter().enumerate() {
            let id = format!("item-{index}");
            let added = match item {
                None => menu.append(&PredefinedMenuItem::separator()),
                Some(Item {
                    label,
                    action,
                    checked,
                }) => {
                    if let Some(action) = action {
                        actions.insert(id.clone(), action);
                    }
                    match checked {
                        Some(on) => {
                            menu.append(&CheckMenuItem::with_id(id.as_str(), label, true, on, None))
                        }
                        None => menu.append(&MenuItem::with_id(
                            id.as_str(),
                            label,
                            action.is_some(),
                            None,
                        )),
                    }
                }
            };
            let _ = added;
        }
        (menu, actions)
    }

    fn icon(running: bool) -> Option<Icon> {
        Icon::from_rgba(icon_rgba(32, running), 32, 32).ok()
    }

    pub fn run(paths: &Paths) -> io::Result<()> {
        let paths = paths.clone();
        #[allow(unused_mut)]
        let mut event_loop = EventLoopBuilder::new().build();
        // tao starts as a regular app, which puts Lens in the Dock despite LSUIElement.
        #[cfg(target_os = "macos")]
        {
            use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
            event_loop.set_activation_policy(ActivationPolicy::Accessory);
        }
        let mut tray: Option<TrayIcon> = None;
        let mut actions = HashMap::new();
        let mut now = Snapshot::default();
        let mut next_poll = Instant::now();
        let started = program_stamp();
        event_loop.run(move |event, _, flow| {
            *flow = ControlFlow::WaitUntil(next_poll);
            if let Event::NewEvents(StartCause::Init) = event {
                // macOS needs the event loop running before the status item is made.
                now = snapshot(&paths);
                let (menu, map) = build(&now);
                actions = map;
                tray = TrayIconBuilder::new()
                    .with_tooltip("Sirv Lens")
                    .with_menu(Box::new(menu))
                    .with_icon(icon(now.running).expect("the icon is valid RGBA"))
                    .build()
                    .ok();
            }
            // macOS: opening Sirv Lens again while it runs only wakes this tray process, the
            // bundle's running app. Do what opening it does: the setup checks and the welcome page.
            if let Event::Reopen { .. } = event
                && let Ok(executable) = crate::paths::executable()
            {
                let _ = std::process::Command::new(executable)
                    .arg("open")
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn();
            }
            if Instant::now() >= next_poll {
                next_poll = Instant::now() + POLL;
                hand_over_if_replaced(started);
                let fresh = snapshot(&paths);
                if fresh != now {
                    now = fresh;
                    if let Some(tray) = &tray {
                        let (menu, map) = build(&now);
                        actions = map;
                        tray.set_menu(Some(Box::new(menu)));
                        let _ = tray.set_icon(icon(now.running));
                    }
                }
            }
            while let Ok(event) = MenuEvent::receiver().try_recv() {
                if let Some(action) = actions.get(event.id().as_ref()) {
                    perform(&paths, *action, &now);
                    next_poll = Instant::now();
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_menu_follows_the_state() {
        let stopped = menu(&Snapshot::default());
        assert!(
            stopped
                .iter()
                .flatten()
                .any(|i| i.action == Some(Action::Start))
        );

        let running = Snapshot {
            running: true,
            version: "1.0.0".into(),
            setup_done: 2,
            setup_required: 4,
            automatic: true,
            ..Default::default()
        };
        let labels: Vec<String> = menu(&running)
            .into_iter()
            .flatten()
            .map(|i| i.label)
            .collect();
        assert!(labels.contains(&"Setup: 2 of 4 done (lens setup)".to_string()));
        assert!(labels.contains(&"Check for updates now".to_string()));

        let managed = Snapshot {
            managed: true,
            ..running
        };
        assert!(
            !menu(&managed)
                .into_iter()
                .flatten()
                .any(|i| i.action == Some(Action::ToggleAutomatic))
        );
    }

    #[test]
    fn the_icon_is_straight_rgba_of_the_right_size() {
        let rgba = icon_rgba(32, true);
        assert_eq!(rgba.len(), 32 * 32 * 4);
        assert!(
            rgba.chunks(4).any(|p| p[3] == 255 && p[2] > 200),
            "the ring is drawn in blue"
        );
    }
}
