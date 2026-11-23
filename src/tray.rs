//! `lens tray`: the menu-bar / system-tray icon. It shows whether Lens runs, the setup progress and
//! updates, and offers pause, automatic updates, update now, logs, restart and quit. It only talks
//! to the daemon; it never starts one by itself except through Start or Restart.
use crate::client::Client;
use crate::paths::Paths;
use crate::protocol::{Reply, Request};
use crate::setup::Mark;
use std::fs::{File, TryLockError};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, SystemTime};

const POLL: Duration = Duration::from_secs(5);

/// A check the person started from the menu runs now: the menu says so instead of the button.
static CHECKING: AtomicBool = AtomicBool::new(false);
/// An update the person started from the menu installs now; a second click does nothing.
static INSTALLING: AtomicBool = AtomicBool::new(false);

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
    /// Whole minutes since the last update check, so the menu's "checked … ago" stays current.
    pub checked_minutes_ago: Option<i64>,
    pub update_error: Option<String>,
    pub checking: bool,
    pub installing: bool,
    /// Browsers used this week with an extension older than the app, as "chromium 0.12.14".
    pub older_extensions: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Action {
    TogglePause,
    OpenSetup,
    ToggleAutomatic,
    CheckUpdates,
    UpdateNow,
    OpenLogs,
    /// The setup page at its settings.
    OpenSettings,
    /// The setup page at the recent reviews.
    RecentReviews,
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
        snapshot.older_extensions = crate::setup::older_extensions(&status);
    }
    if let Ok(Reply::Updates(updates)) = client.call(Request::GetUpdates) {
        snapshot.automatic = updates.automatic;
        snapshot.managed = updates.managed_by.is_some();
        snapshot.available = updates.available;
        snapshot.checked_minutes_ago = updates
            .checked_at
            .map(|at| (crate::daemon::now_ms() - at).max(0) / 60_000);
        snapshot.update_error = updates.last_error;
    }
    snapshot.checking = CHECKING.load(Ordering::Relaxed);
    snapshot.installing = INSTALLING.load(Ordering::Relaxed);
    snapshot
}

/// Starts a program and waits for it on a thread, so a finished one does not stay a zombie.
fn detach(command: &mut std::process::Command) -> io::Result<()> {
    let mut child = command.spawn()?;
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// `text` on one line (line breaks and runs of spaces become one space), cut to `max`
/// characters, for one line of the menu.
fn one_line(text: &str, max: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match line.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &line[..at]),
        None => line,
    }
}

/// A PowerShell script that shows `text` as a balloon from the notification area. The text sits
/// in a single-quoted string, so only quotes need escaping; PowerShell also ends that string at
/// a typographic single quote.
#[cfg_attr(not(windows), allow(dead_code))]
fn balloon_script(text: &str) -> String {
    let quoted: String = one_line(text, 250)
        .chars()
        .map(|c| match c {
            '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => "''".to_string(),
            c => c.to_string(),
        })
        .collect();
    format!(
        "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; \
         $n = New-Object System.Windows.Forms.NotifyIcon; \
         $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; \
         $n.ShowBalloonTip(8000, 'Sirv Lens', '{quoted}', [System.Windows.Forms.ToolTipIcon]::Info); \
         Start-Sleep -Seconds 9; $n.Dispose()"
    )
}

/// PowerShell's -EncodedCommand: the script as base64 of UTF-16LE, so no shell quoting applies.
#[cfg_attr(not(windows), allow(dead_code))]
fn encoded_command(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The menu closes on a click, so what a check or an update found is told in a notification.
fn notify(text: &str) {
    let mut command = if cfg!(target_os = "macos") {
        // A line break ends the AppleScript string.
        let quoted = text
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace(['\n', '\r'], " ");
        let mut c = std::process::Command::new("osascript");
        c.args([
            "-e",
            &format!("display notification \"{quoted}\" with title \"Sirv Lens\""),
        ]);
        c
    } else if cfg!(windows) {
        let mut c = std::process::Command::new("powershell");
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-EncodedCommand",
            &encoded_command(&balloon_script(text)),
        ]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            c.creation_flags(CREATE_NO_WINDOW);
        }
        c
    } else {
        let mut c = std::process::Command::new("notify-send");
        c.args(["--app-name=Sirv Lens", "Sirv Lens", text]);
        c
    };
    let _ = detach(
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null()),
    );
}

/// What a finished check says, in the notification.
fn check_result(reply: io::Result<Reply>, current: &str) -> String {
    match reply {
        Ok(Reply::Updates(u)) => match u.available {
            Some(version) => {
                format!("Lens {version} is available. Choose Update to {version} now in the menu.")
            }
            None => format!("Lens {current} is up to date."),
        },
        Ok(_) => "The update check gave no answer.".into(),
        Err(e) => format!("The update check failed: {e}"),
    }
}

/// The line under the update item: when Lens last looked, or why it could not.
fn update_status(now: &Snapshot) -> Option<String> {
    if now.checking || now.installing {
        return None;
    }
    if let Some(error) = &now.update_error {
        // With a release found, the error is the install's.
        let what = if now.available.is_some() {
            "update"
        } else {
            "check"
        };
        return Some(format!("Last {what} failed: {}", one_line(error, 80)));
    }
    if now.available.is_some() {
        return None;
    }
    Some(match now.checked_minutes_ago? {
        0 => "Up to date · checked just now".into(),
        m @ 1..60 => format!("Up to date · checked {m} min ago"),
        m @ 60..1440 => format!("Up to date · checked {} h ago", m / 60),
        m => format!("Up to date · checked {} days ago", m / 1440),
    })
}

/// Runs a menu action, then sends `wake` so the menu shows the new state at once. Actions that wait
/// on the daemon or a service manager run on a thread, so the menu never freezes.
pub fn perform(paths: &Paths, action: Action, now: &Snapshot, wake: &mpsc::Sender<()>) {
    let busy: Option<&'static AtomicBool> = match action {
        Action::CheckUpdates => Some(&CHECKING),
        Action::UpdateNow => Some(&INSTALLING),
        _ => None,
    };
    if busy.is_some_and(|b| b.swap(true, Ordering::Relaxed)) {
        return;
    }
    let (paths, now, done) = (paths.clone(), now.clone(), wake.clone());
    let work = move || {
        if let Err(e) = act(&paths, action, &now) {
            crate::daemon::log(&paths, &format!("tray: {action:?} failed: {e}"));
        }
        if let Some(busy) = busy {
            busy.store(false, Ordering::Relaxed);
        }
        let _ = done.send(());
    };
    match action {
        Action::Start
        | Action::Restart
        | Action::Quit
        | Action::CheckUpdates
        | Action::UpdateNow => {
            // The menu says "Checking…" or "Installing…" while it runs.
            let _ = wake.send(());
            std::thread::spawn(work);
        }
        _ => work(),
    }
}

fn act(paths: &Paths, action: Action, now: &Snapshot) -> io::Result<()> {
    let call =
        |request| Client::attach(paths).and_then(|mut c| c.call(request).map_err(io::Error::other));
    match action {
        Action::TogglePause => call(Request::SetPaused {
            paused: !now.paused,
        })
        .map(drop),
        Action::ToggleAutomatic => call(Request::SetAutomaticUpdates {
            enabled: !now.automatic,
        })
        .map(drop),
        Action::CheckUpdates => {
            notify(&check_result(call(Request::CheckUpdates), &now.version));
            Ok(())
        }
        // Minutes at most; the daemon restarts itself when it installs one.
        Action::UpdateNow => {
            if let Some(version) = &now.available {
                notify(&format!(
                    "Installing Lens {version}. Lens restarts when it is done."
                ));
            }
            call(Request::UpdateNow)
                .map(drop)
                .inspect_err(|e| notify(&format!("The update did not install: {e}")))
        }
        Action::OpenSetup | Action::OpenSettings | Action::RecentReviews => {
            match call(Request::SetupPage)? {
                Reply::SetupPage(url) => crate::setup::open_url(&page_link(&url, action)),
                _ => Ok(()),
            }
        }
        Action::OpenLogs => open(&paths.logs),
        Action::Start => crate::service::start(paths),
        Action::Restart => crate::paths::executable().and_then(|exe| {
            std::process::Command::new(exe)
                .arg("restart")
                .status()
                .map(drop)
        }),
        // A stopped Lens only closes its tray: no quit marker, so the browser can still start it.
        Action::Quit => {
            if now.running {
                let _ = crate::quit(paths);
            }
            std::process::exit(0);
        }
    }
}

/// The setup page's one-time link, at the part of the page the action names. A browser keeps
/// the fragment through the link's redirect to the page.
fn page_link(url: &str, action: Action) -> String {
    match action {
        Action::OpenSettings => format!("{url}#settings"),
        Action::RecentReviews => format!("{url}#reviews"),
        _ => url.to_string(),
    }
}

fn open(folder: &Path) -> io::Result<()> {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    detach(std::process::Command::new(program).arg(folder))
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
            None,
            // Only the icon closes: Lens is already stopped, and the browser can still start it.
            button("Quit tray", Action::Quit),
        ];
    }
    let mut items = vec![text(format!("Lens {} is running", now.version))];
    items.push(button(
        &if now.setup_done < now.setup_required {
            format!(
                "Finish setting up ({} of {} done)…",
                now.setup_done, now.setup_required
            )
        } else {
            "Set up Lens…".to_string()
        },
        Action::OpenSetup,
    ));
    if !now.older_extensions.is_empty() {
        items.push(text(format!(
            "Older extension in {}",
            now.older_extensions.join(", ")
        )));
    }
    items.push(button("Open Settings…", Action::OpenSettings));
    items.push(button("Recent reviews…", Action::RecentReviews));
    items.push(None);
    items.push(check("Pause collection", Action::TogglePause, now.paused));
    if !now.managed {
        items.push(check(
            "Install updates automatically",
            Action::ToggleAutomatic,
            now.automatic,
        ));
        items.push(match &now.available {
            Some(version) if now.installing => text(format!("Installing {version}…")),
            Some(version) => button(&format!("Update to {version} now"), Action::UpdateNow),
            None if now.checking => text("Checking for updates…".into()),
            None => button("Check for updates", Action::CheckUpdates),
        });
        if let Some(status) = update_status(now) {
            items.push(text(status));
        }
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

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// This tray's program file and when it changed last, read once at start: on Linux the running
/// program's path reads "… (deleted)" after an update renames a new file over it.
struct Program {
    path: PathBuf,
    started: SystemTime,
}

impl Program {
    fn current() -> Option<Self> {
        let path = crate::paths::executable().ok()?;
        Some(Self {
            started: modified(&path)?,
            path,
        })
    }

    /// An update replaced the program: start a tray from the new file and end this one. The new
    /// tray waits for this one's lock; without this the old tray ran until logout. A missing
    /// file is an install still in progress, and a tray that could not start keeps this one.
    fn hand_over_if_replaced(&self, paths: &Paths) {
        if modified(&self.path).is_none_or(|now| now == self.started) {
            return;
        }
        let program = if cfg!(windows) {
            self.path.with_file_name("lensw.exe")
        } else {
            self.path.clone()
        };
        let started = std::process::Command::new(program)
            .args(["tray", "--wait"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
        match started {
            Ok(_) => std::process::exit(0),
            Err(e) => crate::daemon::log(paths, &format!("tray: cannot start the new tray: {e}")),
        }
    }
}

/// Asks the daemon every POLL, or at once when `wake` says a menu action ran, and gives the state
/// to `show` until it returns false. It runs beside the menu, so a slow daemon never freezes it.
fn watch(paths: &Paths, wake: &mpsc::Receiver<()>, mut show: impl FnMut(Snapshot) -> bool) {
    let program = Program::current();
    loop {
        if let Some(program) = &program {
            program.hand_over_if_replaced(paths);
        }
        if !show(snapshot(paths)) {
            return;
        }
        if let Err(mpsc::RecvTimeoutError::Disconnected) = wake.recv_timeout(POLL) {
            return;
        }
        while wake.try_recv().is_ok() {}
    }
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
    // Why a tray did not stay up goes to tray.log.
    let errors = paths
        .log("tray.log")
        .map(std::process::Stdio::from)
        .unwrap_or_else(|_| std::process::Stdio::null());
    command
        .arg("tray")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(errors);
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
        wake: mpsc::Sender<()>,
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
                            perform(&tray.paths, action, &tray.now, &tray.wake)
                        }),
                        ..Default::default()
                    }
                    .into(),
                    Some(Item { label, action, .. }) => StandardItem {
                        label,
                        enabled: action.is_some(),
                        activate: Box::new(move |tray: &mut Self| {
                            if let Some(action) = action {
                                perform(&tray.paths, action, &tray.now, &tray.wake)
                            }
                        }),
                        ..Default::default()
                    }
                    .into(),
                })
                .collect()
        }
    }

    // ksni gives the items new ids whenever the layout changes, so a click on an old menu does
    // not reach another item; a label change keeps the item and its action in place.
    pub fn run(paths: &Paths) -> io::Result<()> {
        let (wake, woken) = mpsc::channel();
        let tray = LensTray {
            paths: paths.clone(),
            now: snapshot(paths),
            wake,
        };
        // No StatusNotifier host (a headless session, or GNOME without its AppIndicator
        // extension): there is nowhere to show an icon, so the tray ends quietly.
        let handle = tray
            .spawn()
            .map_err(|e| io::Error::other(format!("no system tray here: {e}")))?;
        watch(paths, &woken, |now| {
            handle.update(|tray| tray.now = now);
            !handle.is_closed()
        });
        Ok(())
    }
}

// ---------------------------------------------------------------- macOS and Windows

#[cfg(any(target_os = "macos", windows))]
mod platform {
    use super::*;
    use tao::event::Event;
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
    use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

    /// What wakes the event loop: a click, or a new state from the watcher thread.
    enum Wake {
        Menu(MenuEvent),
        Fresh(Snapshot),
    }

    const ACTIONS: [Action; 11] = [
        Action::TogglePause,
        Action::OpenSetup,
        Action::ToggleAutomatic,
        Action::CheckUpdates,
        Action::UpdateNow,
        Action::OpenLogs,
        Action::OpenSettings,
        Action::RecentReviews,
        Action::Start,
        Action::Restart,
        Action::Quit,
    ];

    /// An item's id names its action, so a click on a menu that was replaced since still runs
    /// the item the person saw.
    fn id(action: Action) -> String {
        format!("{action:?}")
    }

    fn build(now: &Snapshot) -> Menu {
        let menu = Menu::new();
        for item in super::menu(now) {
            let _ = match item {
                None => menu.append(&PredefinedMenuItem::separator()),
                Some(Item {
                    label,
                    action: None,
                    ..
                }) => menu.append(&MenuItem::new(label, false, None)),
                Some(Item {
                    label,
                    action: Some(action),
                    checked: Some(on),
                }) => menu.append(&CheckMenuItem::with_id(id(action), label, true, on, None)),
                Some(Item {
                    label,
                    action: Some(action),
                    checked: None,
                }) => menu.append(&MenuItem::with_id(id(action), label, true, None)),
            };
        }
        menu
    }

    fn icon(running: bool) -> Option<Icon> {
        Icon::from_rgba(icon_rgba(32, running), 32, 32).ok()
    }

    pub fn run(paths: &Paths) -> io::Result<()> {
        let paths = paths.clone();
        #[allow(unused_mut)]
        let mut event_loop = EventLoopBuilder::<Wake>::with_user_event().build();
        // tao starts as a regular app, which puts Lens in the Dock despite LSUIElement.
        #[cfg(target_os = "macos")]
        {
            use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
            event_loop.set_activation_policy(ActivationPolicy::Accessory);
        }
        let proxy = event_loop.create_proxy();
        let clicks = proxy.clone();
        MenuEvent::set_event_handler(Some(move |event| {
            let _ = clicks.send_event(Wake::Menu(event));
        }));
        let (wake, woken) = mpsc::channel();
        {
            let paths = paths.clone();
            std::thread::spawn(move || {
                watch(&paths, &woken, |now| {
                    proxy.send_event(Wake::Fresh(now)).is_ok()
                })
            });
        }
        let mut tray: Option<TrayIcon> = None;
        let mut now = Snapshot::default();
        event_loop.run(move |event, _, flow| {
            *flow = ControlFlow::Wait;
            match event {
                // macOS needs the event loop running before the status item is made: the first
                // state makes it.
                Event::UserEvent(Wake::Fresh(fresh)) if tray.is_none() || fresh != now => {
                    now = fresh;
                    let menu = Box::new(build(&now));
                    match &tray {
                        Some(tray) => {
                            tray.set_menu(Some(menu));
                            let _ = tray.set_icon(icon(now.running));
                        }
                        None => match TrayIconBuilder::new()
                            .with_tooltip("Sirv Lens")
                            .with_menu(menu)
                            .with_icon(icon(now.running).expect("the icon is valid RGBA"))
                            .build()
                        {
                            Ok(made) => tray = Some(made),
                            Err(e) => {
                                crate::daemon::log(&paths, &format!("tray: no tray icon: {e}"));
                                std::process::exit(1);
                            }
                        },
                    }
                }
                Event::UserEvent(Wake::Menu(click)) => {
                    if let Some(action) = ACTIONS.into_iter().find(|a| id(*a) == click.id().0) {
                        perform(&paths, action, &now, &wake);
                    }
                }
                // macOS: opening Sirv Lens again while it runs only wakes this tray process, the
                // bundle's running app. Do what opening it does: the setup checks and the welcome
                // page.
                Event::Reopen { .. } => {
                    if let Ok(executable) = crate::paths::executable() {
                        let _ = detach(
                            std::process::Command::new(executable)
                                .arg("open")
                                .stdin(std::process::Stdio::null())
                                .stdout(std::process::Stdio::null())
                                .stderr(std::process::Stdio::null()),
                        );
                    }
                }
                _ => {}
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
        assert!(labels.contains(&"Finish setting up (2 of 4 done)…".to_string()));
        assert!(labels.contains(&"Check for updates".to_string()));

        // The click closes the menu: the menu then says what the check found, and when.
        let labels = |now: &Snapshot| -> Vec<String> {
            menu(now).into_iter().flatten().map(|i| i.label).collect()
        };
        let checked = Snapshot {
            checked_minutes_ago: Some(3),
            ..running.clone()
        };
        assert!(labels(&checked).contains(&"Up to date · checked 3 min ago".to_string()));
        let checking = Snapshot {
            checking: true,
            ..checked.clone()
        };
        assert!(labels(&checking).contains(&"Checking for updates…".to_string()));
        assert!(
            !menu(&checking)
                .into_iter()
                .flatten()
                .any(|i| i.action == Some(Action::CheckUpdates))
        );
        let failed = Snapshot {
            update_error: Some("offline".into()),
            ..checked.clone()
        };
        assert_eq!(one_line("é".repeat(3).as_str(), 2), "éé…");
        assert!(labels(&failed).contains(&"Last check failed: offline".to_string()));
        let newer = Snapshot {
            available: Some("9.9.9".into()),
            ..checked.clone()
        };
        assert!(labels(&newer).contains(&"Update to 9.9.9 now".to_string()));
        assert!(!labels(&newer).iter().any(|l| l.starts_with("Up to date")));
        // A failed install shows beside the button, on one short line.
        let refused = Snapshot {
            update_error: Some(format!("{}\nsecond line", "x".repeat(200))),
            ..newer.clone()
        };
        let line = format!("Last update failed: {}…", "x".repeat(80));
        assert!(labels(&refused).contains(&line));
        let installing = Snapshot {
            installing: true,
            ..newer
        };
        assert!(labels(&installing).contains(&"Installing 9.9.9…".to_string()));
        assert!(
            !menu(&installing)
                .into_iter()
                .flatten()
                .any(|i| i.action == Some(Action::UpdateNow))
        );
        assert!(
            menu(&Snapshot::default())
                .into_iter()
                .flatten()
                .any(|i| i.action == Some(Action::Quit)),
            "a stopped Lens's tray can still be closed"
        );

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
    fn stopped_and_running_menus_name_their_own_items() {
        let labels = |now: &Snapshot| -> Vec<String> {
            menu(now).into_iter().flatten().map(|i| i.label).collect()
        };
        let stopped = labels(&Snapshot::default());
        assert!(stopped.contains(&"Quit tray".to_string()));
        assert!(!stopped.contains(&"Quit Lens".to_string()));
        let running = Snapshot {
            running: true,
            ..Default::default()
        };
        for label in ["Open Settings…", "Recent reviews…", "Quit Lens"] {
            assert!(labels(&running).contains(&label.to_string()), "{label}");
        }
        assert_eq!(
            page_link("http://127.0.0.1:1/start/c", Action::OpenSettings),
            "http://127.0.0.1:1/start/c#settings"
        );
        assert_eq!(page_link("u", Action::OpenSetup), "u");
        assert_eq!(one_line("a\nb\r\n  c", 80), "a b c");
    }

    #[test]
    fn the_windows_balloon_escapes_its_text() {
        let script = balloon_script("it's ‘done’\nnow");
        assert!(script.contains("'it''s ''done'' now'"), "{script}");
        // UTF-16LE: "A" is 41 00.
        assert_eq!(encoded_command("A"), "QQA=");
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
