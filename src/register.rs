//! Native messaging registration for every supported browser, per user, no admin rights.
//! macOS and Linux: one manifest file per browser. Windows: the manifest in the data folder plus
//! an HKCU registry key per browser that points at it.
use crate::paths::Paths;
use crate::protocol::BrowserCheck;
use serde_json::json;
use std::io;
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;

pub const HOST_NAME: &str = "studio.sirv.lens";
/// The unpacked development ID (from the `key` in the extension manifest), then the Chrome Web
/// Store ID.
pub const CHROMIUM_EXTENSION_IDS: &[&str] = &[
    "cggibhoaigdeemmdlfcncfkmoknndbfd",
    "lihjnfpbomppjmdlnchkookggmefanbg",
];
pub const FIREFOX_EXTENSION_ID: &str = "lens@sirv.studio";

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Family {
    Chromium,
    Firefox,
}

pub struct Browser {
    pub name: &'static str,
    pub family: Family,
    /// macOS/Linux: the folder holding the browser's profile data. Registration happens only when it
    /// exists, so Lens never creates folders for browsers that are not installed.
    #[cfg(unix)]
    pub root: PathBuf,
    /// Extra folders that also prove this browser is installed, even before `root` exists (such as
    /// macOS's `Application Support/Firefox` or Ubuntu's Snap `~/snap/firefox`, whose
    /// `xdg-desktop-portal` WebExtensions bridge reads `~/.mozilla/native-messaging-hosts`).
    #[cfg(unix)]
    pub also_installed_if: Vec<PathBuf>,
    #[cfg(windows)]
    pub registry_key: &'static str,
}

pub fn manifest(family: Family, executable: &Path) -> serde_json::Value {
    let mut manifest = json!({
        "name": HOST_NAME,
        "description": "Sirv Lens",
        "path": executable,
        "type": "stdio",
    });
    match family {
        Family::Chromium => {
            manifest["allowed_origins"] = CHROMIUM_EXTENSION_IDS
                .iter()
                .map(|id| format!("chrome-extension://{id}/"))
                .collect()
        }
        Family::Firefox => manifest["allowed_extensions"] = json!([FIREFOX_EXTENSION_ID]),
    }
    manifest
}

#[cfg(target_os = "macos")]
pub fn browsers(home: &Path, _config: &Path) -> Vec<Browser> {
    let support = home.join("Library/Application Support");
    [
        ("Google Chrome", Family::Chromium, "Google/Chrome"),
        ("Chromium", Family::Chromium, "Chromium"),
        ("Microsoft Edge", Family::Chromium, "Microsoft Edge"),
        ("Brave", Family::Chromium, "BraveSoftware/Brave-Browser"),
        ("Firefox", Family::Firefox, "Mozilla"),
    ]
    .into_iter()
    .map(|(name, family, dir)| Browser {
        name,
        family,
        root: support.join(dir),
        also_installed_if: if family == Family::Firefox {
            vec![
                support.join("Firefox"),
                PathBuf::from("/Applications/Firefox.app"),
                PathBuf::from("/Applications/Firefox Developer Edition.app"),
                PathBuf::from("/Applications/Firefox Nightly.app"),
            ]
        } else {
            Vec::new()
        },
    })
    .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn browsers(home: &Path, config: &Path) -> Vec<Browser> {
    vec![
        Browser {
            name: "Google Chrome",
            family: Family::Chromium,
            root: config.join("google-chrome"),
            also_installed_if: Vec::new(),
        },
        Browser {
            name: "Chromium",
            family: Family::Chromium,
            root: config.join("chromium"),
            also_installed_if: Vec::new(),
        },
        Browser {
            name: "Microsoft Edge",
            family: Family::Chromium,
            root: config.join("microsoft-edge"),
            also_installed_if: Vec::new(),
        },
        Browser {
            name: "Brave",
            family: Family::Chromium,
            root: config.join("BraveSoftware/Brave-Browser"),
            also_installed_if: Vec::new(),
        },
        // Native Firefox (pre-147 or legacy profile) reads ~/.mozilla/native-messaging-hosts.
        // Snap Firefox (default on Ubuntu) and portal-enabled Flatpak Firefox also read this path
        // through xdg-desktop-portal's WebExtensions portal, even though their profiles live in
        // ~/snap/firefox or ~/.var/app/org.mozilla.firefox.
        Browser {
            name: "Firefox",
            family: Family::Firefox,
            root: home.join(".mozilla"),
            also_installed_if: vec![
                home.join("snap/firefox"),
                home.join(".var/app/org.mozilla.firefox"),
            ],
        },
        // Firefox 147 and later keep a new profile here (XDG) and read native manifests here too.
        // Lens writes to each Mozilla folder that exists and never creates ~/.mozilla for an XDG-only
        // install, which would move Firefox back to its old folder.
        Browser {
            name: "Firefox",
            family: Family::Firefox,
            root: config.join("mozilla"),
            also_installed_if: Vec::new(),
        },
    ]
}

#[cfg(unix)]
fn manifest_path(browser: &Browser) -> PathBuf {
    let folder = match (cfg!(target_os = "macos"), browser.family) {
        (false, Family::Firefox) => "native-messaging-hosts",
        _ => "NativeMessagingHosts",
    };
    browser.root.join(folder).join(format!("{HOST_NAME}.json"))
}

#[cfg(windows)]
pub fn browsers() -> Vec<Browser> {
    [
        (
            "Google Chrome",
            Family::Chromium,
            r"Software\Google\Chrome\NativeMessagingHosts",
        ),
        (
            "Chromium",
            Family::Chromium,
            r"Software\Chromium\NativeMessagingHosts",
        ),
        (
            "Microsoft Edge",
            Family::Chromium,
            r"Software\Microsoft\Edge\NativeMessagingHosts",
        ),
        (
            "Brave",
            Family::Chromium,
            r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
        ),
        (
            "Firefox",
            Family::Firefox,
            r"Software\Mozilla\NativeMessagingHosts",
        ),
    ]
    .into_iter()
    .map(|(name, family, registry_key)| Browser {
        name,
        family,
        registry_key,
    })
    .collect()
}

/// One line per browser, for `lens register` and `lens status`.
pub type Report = Vec<(&'static str, String)>;

#[cfg(unix)]
impl Browser {
    /// Whether the browser is on this computer. Some installations (Firefox on macOS, or Snap
    /// Firefox on Ubuntu) keep their profiles elsewhere and may never have created `root`;
    /// registering creates the native-messaging-hosts folder there.
    pub fn installed(&self) -> bool {
        self.root.is_dir() || self.also_installed_if.iter().any(|p| p.is_dir())
    }
}

#[cfg(unix)]
pub fn register(_paths: &Paths, executable: &Path) -> io::Result<Report> {
    let (home, config) = home_and_config()?;
    register_unix(&browsers(&home, &config), executable)
}

#[cfg(unix)]
pub fn register_unix(browsers: &[Browser], executable: &Path) -> io::Result<Report> {
    let mut report: Report = Vec::new();
    let (mut written, mut failed) = (false, None);
    for browser in browsers.iter().filter(|b| b.installed()) {
        let path = manifest_path(browser);
        let outcome = std::fs::create_dir_all(path.parent().expect("manifest has a folder"))
            .and_then(|()| {
                let body = serde_json::to_vec_pretty(&manifest(browser.family, executable))?;
                write_atomically(&path, &body)
            });
        // One browser's failure leaves the others registered and shows in its line.
        match outcome {
            Ok(()) => {
                written = true;
                report.push((browser.name, path.display().to_string()));
            }
            Err(e) => {
                report.push((browser.name, format!("cannot register: {e}")));
                failed.get_or_insert(e);
            }
        }
    }
    // Firefox reads two folders on Linux: "not installed" only when it has neither.
    for browser in browsers {
        if !report.iter().any(|(name, _)| *name == browser.name) {
            report.push((browser.name, "not installed".to_string()));
        }
    }
    match failed {
        Some(e) if !written => Err(e),
        _ => Ok(report),
    }
}

#[cfg(unix)]
pub fn unregister(_paths: &Paths) -> io::Result<Report> {
    let (home, config) = home_and_config()?;
    let mut report = Vec::new();
    for browser in browsers(&home, &config) {
        let path = manifest_path(&browser);
        match std::fs::remove_file(&path) {
            Ok(()) => report.push((browser.name, format!("removed {}", path.display()))),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(report)
}

#[cfg(unix)]
fn home_and_config() -> io::Result<(PathBuf, PathBuf)> {
    let base = directories::BaseDirs::new()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no home directory"))?;
    Ok((
        base.home_dir().to_path_buf(),
        base.config_dir().to_path_buf(),
    ))
}

#[cfg(windows)]
pub fn register(paths: &Paths, executable: &Path) -> io::Result<Report> {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};
    let hosts = paths.data.join("hosts");
    std::fs::create_dir_all(&hosts)?;
    let mut report = Vec::new();
    let (mut written, mut failed) = (false, None);
    for browser in browsers() {
        let file = hosts.join(match browser.family {
            Family::Chromium => "chromium.json",
            Family::Firefox => "firefox.json",
        });
        let outcome = serde_json::to_vec_pretty(&manifest(browser.family, executable))
            .map_err(io::Error::from)
            .and_then(|body| write_atomically(&file, &body))
            .and_then(|()| {
                let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
                    .create_subkey(format!(r"{}\{HOST_NAME}", browser.registry_key))?;
                key.set_value("", &file.as_os_str())
            });
        // One browser's failure leaves the others registered and shows in its line.
        match outcome {
            Ok(()) => {
                written = true;
                report.push((browser.name, file.display().to_string()));
            }
            Err(e) => {
                report.push((browser.name, format!("cannot register: {e}")));
                failed.get_or_insert(e);
            }
        }
    }
    match failed {
        Some(e) if !written => Err(e),
        _ => Ok(report),
    }
}

#[cfg(windows)]
pub fn unregister(paths: &Paths) -> io::Result<Report> {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};
    let mut report = Vec::new();
    for browser in browsers() {
        match RegKey::predef(HKEY_CURRENT_USER)
            .delete_subkey(format!(r"{}\{HOST_NAME}", browser.registry_key))
        {
            Ok(()) => report.push((browser.name, "removed".to_string())),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    let _ = std::fs::remove_dir_all(paths.data.join("hosts"));
    Ok(report)
}

/// Whether a manifest registers this binary for the Lens extensions.
fn manifest_problem(path: &Path, family: Family, executable: &Path) -> Option<String> {
    let Ok(bytes) = std::fs::read(path) else {
        return Some("not registered; run lens register".into());
    };
    let Ok(found) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Some("the registration is damaged; run lens register".into());
    };
    let expected = manifest(family, executable);
    // Windows and macOS paths ignore case.
    let same = match (found["path"].as_str(), expected["path"].as_str()) {
        (Some(a), Some(b)) if cfg!(any(windows, target_os = "macos")) => a.eq_ignore_ascii_case(b),
        (a, b) => a == b,
    };
    if !same {
        return Some(format!(
            "registered for {}, not this Lens; run lens register",
            found["path"].as_str().unwrap_or("another program")
        ));
    }
    let key = match family {
        Family::Chromium => "allowed_origins",
        Family::Firefox => "allowed_extensions",
    };
    let allowed = found[key].as_array().cloned().unwrap_or_default();
    let missing = expected[key]
        .as_array()
        .into_iter()
        .flatten()
        .any(|id| !allowed.contains(id));
    missing.then(|| "registered for an older Lens extension; run lens register".into())
}

/// Every browser this system has, and whether it can start this binary for the extension.
#[cfg(unix)]
pub fn check(_paths: &Paths, executable: &Path) -> Vec<BrowserCheck> {
    let Ok((home, config)) = home_and_config() else {
        return Vec::new();
    };
    #[cfg_attr(target_os = "macos", allow(unused_mut))]
    let mut checks: Vec<BrowserCheck> = browsers(&home, &config)
        .iter()
        .filter(|b| b.installed())
        .map(|b| {
            let problem = manifest_problem(&manifest_path(b), b.family, executable);
            BrowserCheck {
                name: b.name.into(),
                installed: true,
                registered: problem.is_none(),
                problem,
            }
        })
        .fold(Vec::<BrowserCheck>::new(), |mut checks, check| {
            // One browser can read more than one folder: it is registered when all of them are.
            match checks.iter_mut().find(|c| c.name == check.name) {
                Some(seen) if seen.problem.is_none() => *seen = check,
                Some(_) => {}
                None => checks.push(check),
            }
            checks
        });
    // Sandboxed packages without a WebExtensions desktop portal cannot start a program outside
    // their sandbox through a plain manifest. Snap Firefox on Ubuntu uses xdg-desktop-portal and
    // is registered via ~/.mozilla/native-messaging-hosts above.
    #[cfg(not(target_os = "macos"))]
    for (name, folder, problem) in [
        (
            "Firefox (Flatpak)",
            ".var/app/org.mozilla.firefox",
            "needs the WebExtensions desktop portal; if it cannot connect, use Firefox's system package",
        ),
        (
            "Google Chrome (Flatpak)",
            ".var/app/com.google.Chrome",
            "a sandboxed browser cannot start Lens yet; use this browser's system package",
        ),
        (
            "Chromium (Flatpak)",
            ".var/app/org.chromium.Chromium",
            "a sandboxed browser cannot start Lens yet; use this browser's system package",
        ),
        (
            "Brave (Flatpak)",
            ".var/app/com.brave.Browser",
            "a sandboxed browser cannot start Lens yet; use this browser's system package",
        ),
        (
            "Chromium (Snap)",
            "snap/chromium",
            "a sandboxed browser cannot start Lens yet; use this browser's system package",
        ),
    ] {
        if home.join(folder).is_dir() {
            checks.push(BrowserCheck {
                name: name.into(),
                installed: true,
                registered: false,
                problem: Some(problem.into()),
            });
        }
    }
    checks
}

#[cfg(windows)]
pub fn check(_paths: &Paths, executable: &Path) -> Vec<BrowserCheck> {
    use winreg::{
        RegKey,
        enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE},
    };
    let app_path = |exe: &str| {
        [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
            .into_iter()
            .any(|root| {
                RegKey::predef(root)
                    .open_subkey(format!(
                        r"Software\Microsoft\Windows\CurrentVersion\App Paths\{exe}"
                    ))
                    .is_ok()
            })
    };
    let local = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from);
    browsers()
        .into_iter()
        .filter(|b| match b.name {
            "Google Chrome" => app_path("chrome.exe"),
            "Microsoft Edge" => app_path("msedge.exe"),
            "Brave" => app_path("brave.exe"),
            "Firefox" => app_path("firefox.exe"),
            _ => local
                .as_ref()
                .is_some_and(|l| l.join(r"Chromium\Application\chrome.exe").is_file()),
        })
        .map(|b| {
            let manifest = RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey(format!(r"{}\{HOST_NAME}", b.registry_key))
                .and_then(|k| k.get_value::<String, _>(""));
            let problem = match manifest {
                Ok(path) => manifest_problem(Path::new(&path), b.family, executable),
                Err(_) => Some("not registered; run lens register".into()),
            };
            BrowserCheck {
                name: b.name.into(),
                installed: true,
                registered: problem.is_none(),
                problem,
            }
        })
        .collect()
}

fn write_atomically(path: &Path, body: &[u8]) -> io::Result<()> {
    // Its own name per call: two registrations at once (daemon and setup) do not share a file.
    let temporary = path.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4()));
    let written = std::fs::write(&temporary, body).and_then(|()| std::fs::rename(&temporary, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    written
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn firefox_counts_as_installed_from_its_own_profile_folder() {
        let dir = tempfile::tempdir().unwrap();
        let firefox = Browser {
            name: "Firefox",
            family: Family::Firefox,
            root: dir.path().join("Mozilla"),
            also_installed_if: vec![dir.path().join("Firefox")],
        };
        let chrome = Browser {
            name: "Google Chrome",
            family: Family::Chromium,
            root: dir.path().join("Google/Chrome"),
            also_installed_if: Vec::new(),
        };
        std::fs::create_dir_all(dir.path().join("Firefox")).unwrap();
        assert!(
            firefox.installed(),
            "Application Support/Firefox without Mozilla"
        );
        assert!(!chrome.installed());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn firefox_gets_a_manifest_in_each_mozilla_folder_and_never_a_new_one() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join("custom-xdg-config");
        std::fs::create_dir_all(config.join("mozilla/firefox")).unwrap();
        let executable = Path::new("/opt/lens/lens");
        let report = register_unix(&browsers(home.path(), &config), executable).unwrap();
        let firefox: Vec<_> = report.iter().filter(|(n, _)| *n == "Firefox").collect();
        assert_eq!(firefox.len(), 1, "one Firefox line, not also not installed");
        let xdg = config.join("mozilla/native-messaging-hosts/studio.sirv.lens.json");
        assert_eq!(manifest_problem(&xdg, Family::Firefox, executable), None);
        assert!(
            !home.path().join(".mozilla").exists(),
            "an XDG Firefox keeps its folder"
        );

        std::fs::create_dir_all(home.path().join(".mozilla/firefox")).unwrap();
        register_unix(&browsers(home.path(), &config), executable).unwrap();
        let legacy = home
            .path()
            .join(".mozilla/native-messaging-hosts/studio.sirv.lens.json");
        assert_eq!(manifest_problem(&legacy, Family::Firefox, executable), None);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn snap_firefox_registers_in_mozilla_native_messaging_hosts() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join(".config");
        std::fs::create_dir_all(home.path().join("snap/firefox/common")).unwrap();
        let executable = Path::new("/opt/lens/lens");
        let report = register_unix(&browsers(home.path(), &config), executable).unwrap();
        let firefox: Vec<_> = report.iter().filter(|(n, _)| *n == "Firefox").collect();
        assert_eq!(firefox.len(), 1);
        assert_ne!(firefox[0].1, "not installed");
        let manifest = home
            .path()
            .join(".mozilla/native-messaging-hosts/studio.sirv.lens.json");
        assert_eq!(
            manifest_problem(&manifest, Family::Firefox, executable),
            None
        );
    }

    #[test]
    fn writes_manifests_only_for_installed_browsers() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join(".config");
        let browsers = browsers(home.path(), &config);
        let chrome = browsers.iter().find(|b| b.name == "Google Chrome").unwrap();
        std::fs::create_dir_all(&chrome.root).unwrap();

        let report = register_unix(&browsers, Path::new("/opt/lens/lens")).unwrap();
        let written: Vec<_> = report
            .iter()
            .filter(|(_, line)| line != "not installed")
            .collect();
        // A Mac with Firefox in /Applications (CI runners have it) counts Firefox as installed.
        let firefox_app = cfg!(target_os = "macos")
            && [
                "/Applications/Firefox.app",
                "/Applications/Firefox Developer Edition.app",
                "/Applications/Firefox Nightly.app",
            ]
            .iter()
            .any(|p| Path::new(p).is_dir());
        assert_eq!(written.len(), 1 + usize::from(firefox_app));

        // A browser whose folder Lens cannot write to does not stop the others.
        let chromium = browsers.iter().find(|b| b.name == "Chromium").unwrap();
        std::fs::create_dir_all(&chromium.root).unwrap();
        std::fs::write(manifest_path(chromium).parent().unwrap(), "a file").unwrap();
        let report = register_unix(&browsers, Path::new("/opt/lens/lens")).unwrap();
        assert!(
            report
                .iter()
                .any(|(n, line)| *n == "Chromium" && line.starts_with("cannot register"))
        );
        assert!(manifest_path(chrome).is_file());

        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(manifest_path(chrome)).unwrap()).unwrap();
        assert_eq!(manifest["name"], HOST_NAME);
        assert_eq!(manifest["path"], "/opt/lens/lens");
        assert_eq!(
            manifest["allowed_origins"][0],
            "chrome-extension://cggibhoaigdeemmdlfcncfkmoknndbfd/"
        );
        assert!(
            firefox_app
                || !browsers
                    .iter()
                    .find(|b| b.name == "Firefox")
                    .unwrap()
                    .root
                    .exists()
        );
    }

    #[test]
    fn checks_find_missing_moved_and_current_registrations() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        let lens = Path::new("/opt/lens/lens");
        assert!(
            manifest_problem(&path, Family::Chromium, lens)
                .unwrap()
                .contains("not registered")
        );
        std::fs::write(
            &path,
            serde_json::to_vec(&manifest(Family::Chromium, Path::new("/old/lens"))).unwrap(),
        )
        .unwrap();
        assert!(
            manifest_problem(&path, Family::Chromium, lens)
                .unwrap()
                .contains("/old/lens")
        );
        std::fs::write(
            &path,
            serde_json::to_vec(&manifest(Family::Chromium, lens)).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest_problem(&path, Family::Chromium, lens), None);
    }

    #[test]
    fn firefox_manifests_name_the_addon() {
        assert_eq!(
            manifest(Family::Firefox, Path::new("/x"))["allowed_extensions"][0],
            FIREFOX_EXTENSION_ID
        );
    }
}
