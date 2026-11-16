//! The background service: Lens starts at login and runs for this user, without admin rights.
//! macOS: a LaunchAgent. Linux: a systemd user unit, or XDG autostart without systemd. Windows: an
//! HKCU Run entry that starts the windowless launcher `lensw.exe`. The daemon exits 0 when asked to
//! stop, and every manager here restarts it only after a failure, so `lens stop` stays stopped.
use crate::paths::Paths;
use std::io;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Command;

#[cfg(target_os = "macos")]
pub const LABEL: &str = "studio.sirv.lens";

#[derive(Debug, PartialEq)]
pub enum State {
    NotInstalled,
    /// Installed; whether the daemon answers is a separate check.
    Installed {
        manager: &'static str,
    },
}

#[cfg(unix)]
fn run(program: &str, arguments: &[&str]) -> io::Result<String> {
    let output = Command::new(program).args(arguments).output()?;
    let text = String::from_utf8_lossy(&output.stdout).into_owned()
        + &String::from_utf8_lossy(&output.stderr);
    if output.status.success() {
        Ok(text)
    } else {
        Err(io::Error::other(format!(
            "{program} {}: {}",
            arguments.join(" "),
            text.trim()
        )))
    }
}

/// Installs the service, or moves it to `executable` when it starts another Lens program: the
/// Lens the person opens is the one they want, say a new AppImage beside an older `lens`.
/// Otherwise starts it. A data folder of its own (LENS_HOME: tests, demos) never moves the
/// person's service.
pub fn ensure(paths: &Paths, executable: &Path) -> io::Result<()> {
    match state(paths) {
        State::NotInstalled => install(paths, executable),
        _ if std::env::var_os("LENS_HOME").is_none() && !runs(paths, executable) => {
            install(paths, executable)
        }
        _ => start(paths),
    }
}

/// Starts the daemon without any service manager, detached (as the browser shim does).
fn spawn_detached(paths: &Paths) -> io::Result<()> {
    crate::shim::connect_or_start(paths).map(drop)
}

// ---------------------------------------------------------------- macOS

#[cfg(target_os = "macos")]
fn plist_path() -> io::Result<PathBuf> {
    let base = directories::BaseDirs::new().ok_or_else(|| io::Error::other("no home directory"))?;
    Ok(base
        .home_dir()
        .join(format!("Library/LaunchAgents/{LABEL}.plist")))
}

#[cfg(target_os = "macos")]
fn domain() -> String {
    // SAFETY: getuid has no preconditions.
    format!("gui/{}", unsafe { libc::getuid() })
}

#[cfg(target_os = "macos")]
pub fn plist(executable: &Path, paths: &Paths) -> String {
    let escape = |p: &Path| {
        p.display()
            .to_string()
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>{}</string><string>daemon</string><string>--service</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>{}</string>
</dict>
</plist>
"#,
        escape(executable),
        escape(&paths.logs.join("lensd.log")),
    )
}

/// Whether the installed service starts `executable`.
#[cfg(target_os = "macos")]
fn runs(paths: &Paths, executable: &Path) -> bool {
    let want = plist(executable, paths);
    let program = want
        .lines()
        .find(|l| l.contains("<array>"))
        .unwrap_or_default();
    plist_path()
        .and_then(std::fs::read_to_string)
        .is_ok_and(|have| have.contains(program))
}

#[cfg(target_os = "macos")]
pub fn install(paths: &Paths, executable: &Path) -> io::Result<()> {
    paths.ensure()?;
    let path = plist_path()?;
    std::fs::create_dir_all(path.parent().expect("plist has a folder"))?;
    let _ = run("launchctl", &["bootout", &format!("{}/{LABEL}", domain())]);
    std::fs::write(&path, plist(executable, paths))?;
    run(
        "launchctl",
        &["bootstrap", &domain(), &path.display().to_string()],
    )
    .map(drop)
}

#[cfg(target_os = "macos")]
pub fn uninstall(_paths: &Paths) -> io::Result<()> {
    let _ = run("launchctl", &["bootout", &format!("{}/{LABEL}", domain())]);
    match std::fs::remove_file(plist_path()?) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

#[cfg(target_os = "macos")]
pub fn state(_paths: &Paths) -> State {
    match plist_path().map(|p| p.exists()) {
        Ok(true) => State::Installed { manager: "launchd" },
        _ => State::NotInstalled,
    }
}

#[cfg(target_os = "macos")]
pub fn start(paths: &Paths) -> io::Result<()> {
    if state(paths) == State::NotInstalled {
        return spawn_detached(paths);
    }
    let target = format!("{}/{LABEL}", domain());
    // After a bootout the job is unloaded: load it again; else kickstart the loaded job.
    if run("launchctl", &["print", &target]).is_err() {
        run(
            "launchctl",
            &["bootstrap", &domain(), &plist_path()?.display().to_string()],
        )?;
    }
    run("launchctl", &["kickstart", &target]).map(drop)
}

// ---------------------------------------------------------------- Linux and other Unix

#[cfg(all(unix, not(target_os = "macos")))]
fn config_dir() -> io::Result<PathBuf> {
    directories::BaseDirs::new()
        .map(|b| b.config_dir().to_path_buf())
        .ok_or_else(|| io::Error::other("no home directory"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn unit_path() -> io::Result<PathBuf> {
    Ok(config_dir()?.join("systemd/user/sirv-lens.service"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn autostart_path() -> io::Result<PathBuf> {
    Ok(config_dir()?.join("autostart/sirv-lens.desktop"))
}

/// systemd --user exists and has a session bus to talk to.
#[cfg(all(unix, not(target_os = "macos")))]
fn systemd_user() -> bool {
    run("systemctl", &["--user", "show-environment"]).is_ok()
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn unit(executable: &Path, paths: &Paths) -> String {
    let quote = |p: &Path| {
        format!(
            "\"{}\"",
            p.display()
                .to_string()
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
        )
    };
    format!(
        "[Unit]\nDescription=Sirv Lens\n\n[Service]\nExecStart={} daemon --service\nRestart=on-failure\nRestartSec=2\nStandardError=append:{}\n\n[Install]\nWantedBy=default.target\n",
        quote(executable),
        paths.logs.join("lensd.log").display()
    )
}

/// Whether the installed service starts `executable`.
#[cfg(all(unix, not(target_os = "macos")))]
fn runs(paths: &Paths, executable: &Path) -> bool {
    let want = unit(executable, paths);
    let program = want
        .lines()
        .find(|l| l.starts_with("ExecStart="))
        .unwrap_or_default();
    let autostart = format!("Exec=\"{}\" daemon", executable.display());
    unit_path()
        .and_then(std::fs::read_to_string)
        .is_ok_and(|have| have.lines().any(|l| l == program))
        || autostart_path()
            .and_then(std::fs::read_to_string)
            .is_ok_and(|have| have.contains(&autostart))
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn install(paths: &Paths, executable: &Path) -> io::Result<()> {
    paths.ensure()?;
    if systemd_user() {
        let path = unit_path()?;
        std::fs::create_dir_all(path.parent().expect("unit has a folder"))?;
        std::fs::write(&path, unit(executable, paths))?;
        run("systemctl", &["--user", "daemon-reload"])?;
        // A daemon the browser started earlier holds the lock; stop it so the service owns Lens.
        let _ = crate::stop_daemon(paths);
        // An absolute path makes systemd link the unit itself, wherever its own config folder is
        // (a custom XDG_CONFIG_HOME in this shell need not match the user manager's).
        return run(
            "systemctl",
            &["--user", "enable", "--now", &path.display().to_string()],
        )
        .map(drop);
    }
    let path = autostart_path()?;
    std::fs::create_dir_all(path.parent().expect("autostart has a folder"))?;
    std::fs::write(
        &path,
        format!(
            "[Desktop Entry]\nType=Application\nName=Sirv Lens\nExec=\"{}\" daemon --service\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n",
            executable.display()
        ),
    )?;
    let _ = crate::stop_daemon(paths);
    spawn_detached(paths)
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn uninstall(_paths: &Paths) -> io::Result<()> {
    if unit_path()?.exists() {
        let _ = run(
            "systemctl",
            &["--user", "disable", "--now", "sirv-lens.service"],
        );
        std::fs::remove_file(unit_path()?)?;
        let _ = run("systemctl", &["--user", "daemon-reload"]);
    }
    match std::fs::remove_file(autostart_path()?) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn state(_paths: &Paths) -> State {
    if unit_path().is_ok_and(|p| p.exists()) {
        State::Installed { manager: "systemd" }
    } else if autostart_path().is_ok_and(|p| p.exists()) {
        State::Installed {
            manager: "autostart",
        }
    } else {
        State::NotInstalled
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn start(paths: &Paths) -> io::Result<()> {
    match state(paths) {
        State::Installed { manager: "systemd" } => {
            run("systemctl", &["--user", "start", "sirv-lens.service"]).map(drop)
        }
        _ => spawn_detached(paths),
    }
}

// ---------------------------------------------------------------- Windows

#[cfg(windows)]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const RUN_VALUE: &str = "Sirv Lens";

/// `lensw.exe` beside `lens.exe`: a windowless launcher, so login opens no console window.
#[cfg(windows)]
pub fn launcher(executable: &Path) -> PathBuf {
    executable.with_file_name("lensw.exe")
}

/// Whether the installed service starts `executable`.
#[cfg(windows)]
fn runs(_paths: &Paths, executable: &Path) -> bool {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(RUN_KEY)
        .and_then(|k| k.get_value::<String, _>(RUN_VALUE))
        .is_ok_and(|have| {
            have == format!("\"{}\" daemon --service", launcher(executable).display())
        })
}

#[cfg(windows)]
pub fn install(paths: &Paths, executable: &Path) -> io::Result<()> {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};
    paths.ensure()?;
    let launcher = launcher(executable);
    if !launcher.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("{} is missing", launcher.display()),
        ));
    }
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN_KEY)?;
    key.set_value(
        RUN_VALUE,
        &format!("\"{}\" daemon --service", launcher.display()),
    )?;
    let _ = crate::stop_daemon(paths);
    start(paths)
}

#[cfg(windows)]
pub fn uninstall(_paths: &Paths) -> io::Result<()> {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};
    match RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(RUN_KEY, winreg::enums::KEY_SET_VALUE)
    {
        Ok(key) => match key.delete_value(RUN_VALUE) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(windows)]
pub fn state(_paths: &Paths) -> State {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};
    let installed = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(RUN_KEY)
        .and_then(|k| k.get_value::<String, _>(RUN_VALUE))
        .is_ok();
    if installed {
        State::Installed {
            manager: "login item",
        }
    } else {
        State::NotInstalled
    }
}

#[cfg(windows)]
pub fn start(paths: &Paths) -> io::Result<()> {
    spawn_detached(paths)
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn paths() -> Paths {
        Paths {
            data: "/data".into(),
            runtime: "/run".into(),
            logs: PathBuf::from("/logs"),
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn plist_restarts_only_after_failure() {
        let plist = plist(Path::new("/Users/a b/.local/bin/lens"), &paths());
        assert!(
            plist.contains("<string>/Users/a b/.local/bin/lens</string><string>daemon</string>")
        );
        assert!(plist.contains("<key>SuccessfulExit</key><false/>"));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn unit_quotes_the_path_and_restarts_only_after_failure() {
        let unit = unit(Path::new("/home/a b/.local/bin/lens"), &paths());
        assert!(unit.contains("ExecStart=\"/home/a b/.local/bin/lens\" daemon --service"));
        assert!(unit.contains("Restart=on-failure"));
        assert!(unit.contains("StandardError=append:/logs/lensd.log"));
    }

    #[cfg(windows)]
    #[test]
    fn launcher_sits_beside_lens() {
        assert_eq!(
            launcher(Path::new(r"C:\Lens\lens.exe")),
            PathBuf::from(r"C:\Lens\lensw.exe")
        );
    }
}
