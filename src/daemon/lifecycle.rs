//! What keeps the daemon healthy: the sweep, the tray and registration watchers, restarts.
use super::*;

impl Daemon {
    /// Removes what no record names any more: blobs older than an hour (a new one waits for the
    /// record that will name it), and the frozen folders of deleted reviews in filings/ and
    /// handoffs/. Runs on its own thread.
    pub(super) fn sweep_soon(&self) {
        if SWEEPING.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let Some(daemon) = self.me.get().and_then(std::sync::Weak::upgrade) else {
            SWEEPING.store(false, std::sync::atomic::Ordering::SeqCst);
            return;
        };
        std::thread::spawn(move || {
            daemon.sweep();
            SWEEPING.store(false, std::sync::atomic::Ordering::SeqCst);
        });
    }

    /// Under the store lock: no record can name a blob or a review appear while files go.
    pub(super) fn sweep(&self) {
        let store = self.lock_store();
        let (blobs, reviews) = match store.references() {
            Ok(found) => found,
            Err(e) => return log(&self.paths, &format!("sweep: {e}")),
        };
        match self
            .blobs
            .sweep(&blobs, std::time::Duration::from_secs(3600))
        {
            Ok(0) => {}
            Ok(n) => log(&self.paths, &format!("removed {n} files no record names")),
            Err(e) => log(&self.paths, &format!("sweep: {e}")),
        }
        // Uploads the browser gave up on (a closed tab, a lost connection) never finish.
        if let Ok(parts) = std::fs::read_dir(self.paths.data.join("uploads")) {
            for part in parts.flatten() {
                let old = part
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age > std::time::Duration::from_secs(24 * 3600));
                if old {
                    let _ = std::fs::remove_file(part.path());
                }
            }
        }
        for root in [self.paths.filings(), self.paths.data.join("handoffs")] {
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let review = name
                    .strip_prefix("lens-review-")
                    .and_then(|rest| rest.split('-').next())
                    .and_then(|id| id.parse::<i64>().ok());
                if review.is_some_and(|id| !reviews.contains(&id)) {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        drop(store);
    }
}

/// Set once a restart is on its way, so two reasons never start two restarts.
pub(super) static SWEEPING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
pub(super) static RESTARTING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
/// This daemon runs under the service manager (`lens daemon --service`).
pub(super) static SERVICE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// An installer may replace Lens while it runs (a new DMG, setup program or package). The service
/// then restarts on the new program instead of serving the old one until the next login.
/// Keeps the menu-bar icon there: a tray can end when an update replaces the app while it hands
/// over to the new one, and nothing else starts it again. Quit Lens stops this daemon too, so a
/// tray the person quit does not come back. At login the service can start before the desktop's
/// panel: after three quick tries this tries every five minutes, so the icon comes once the panel
/// is up, and a session without a panel costs one try now and then.
pub(super) fn watch_tray(paths: &Paths) {
    let paths = paths.clone();
    std::thread::spawn(move || {
        let mut misses = 0u32;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            if crate::tray::running(&paths) {
                misses = 0;
                continue;
            }
            misses += 1;
            if misses == 4 {
                log(
                    &paths,
                    "the tray does not stay up yet (see tray.log); trying every five minutes",
                );
            }
            if misses > 3 && !misses.is_multiple_of(10) {
                continue;
            }
            log(&paths, "the tray was not running; starting it");
            crate::tray::spawn(&paths);
        }
    });
}

/// Every five minutes, repairs the browser registrations when one stops pointing at this program:
/// a browser installed since, a manifest another Lens copy wrote, or one a cleanup removed. The
/// extension then reconnects by itself. Sandboxed browsers ("(Flatpak)", "(Snap)") stay as they are:
/// a manifest cannot fix them.
pub(super) fn watch_registration(paths: &Paths) {
    let paths = paths.clone();
    std::thread::spawn(move || {
        let Ok(executable) = crate::paths::executable() else {
            return;
        };
        loop {
            std::thread::sleep(std::time::Duration::from_secs(300));
            // A program that moved (an AppImage) is no longer the one to register: its new copy
            // registers itself when it starts.
            if !executable.is_file() {
                return;
            }
            let broken = crate::register::check(&paths, &executable)
                .into_iter()
                .any(|b| b.installed && !b.registered && !b.name.contains('('));
            if !broken {
                continue;
            }
            match crate::register::register(&paths, &executable) {
                Ok(_) => log(&paths, "repaired the browser registration"),
                Err(e) => log(
                    &paths,
                    &format!("the browser registration repair failed: {e}"),
                ),
            }
        }
    });
}

pub(super) fn watch_program(paths: &Paths) {
    let paths = paths.clone();
    std::thread::spawn(move || {
        let Ok(executable) = crate::paths::executable() else {
            return;
        };
        let stamp = |p: &std::path::Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        let started = stamp(&executable);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(10));
            let now = stamp(&executable);
            // A missing file is an install still in progress: wait for the new one.
            if started.is_some() && now.is_some() && now != started {
                log(
                    &paths,
                    "the Lens program was replaced; restarting on the new one",
                );
                restart_soon(&paths, &executable);
                return;
            }
        }
    });
}

/// Starts `lens restart` from the new binary, detached; it stops this daemon after the reply is out
/// and starts the new one through the service manager.
pub(super) fn restart_soon(paths: &Paths, executable: &std::path::Path) {
    if RESTARTING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    // A helper started by a service dies with it: systemd stops every process of the unit when
    // this one exits. So the service exits as failed once the reply is out, and systemd
    // (Restart=on-failure) or launchd (KeepAlive unless SuccessfulExit) starts the new program.
    // Only a supervised daemon may exit to restart: launchd on macOS, systemd on Linux (it sets
    // INVOCATION_ID). One from a desktop autostart entry restarts itself like a plain one.
    // launchd names its job in XPC_SERVICE_NAME; a --service daemon started without the plist
    // has no launchd to start it again.
    #[cfg(target_os = "macos")]
    let supervised = std::env::var("XPC_SERVICE_NAME").is_ok_and(|n| n == crate::service::LABEL);
    #[cfg(not(target_os = "macos"))]
    let supervised = std::env::var_os("INVOCATION_ID").is_some();
    if cfg!(unix) && supervised && SERVICE.load(std::sync::atomic::Ordering::SeqCst) {
        log(
            paths,
            "exiting so the service manager starts the new program",
        );
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(2));
            std::process::exit(75);
        });
        return;
    }
    let mut command = std::process::Command::new(executable);
    command
        .args(["restart", "--after", "2"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: Windows ignores it with DETACHED_PROCESS
    }
    if let Err(e) = command.spawn() {
        log(paths, &format!("cannot restart after the update: {e}"));
        // Nothing restarts: a later reason may try again.
        RESTARTING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}
