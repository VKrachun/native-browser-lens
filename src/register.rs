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
        },
        Browser {
            name: "Chromium",
            family: Family::Chromium,
            root: config.join("chromium"),
        },
        Browser {
            name: "Microsoft Edge",
            family: Family::Chromium,
            root: config.join("microsoft-edge"),
        },
        Browser {
            name: "Brave",
            family: Family::Chromium,
            root: config.join("BraveSoftware/Brave-Browser"),
        },
        Browser {
            name: "Firefox",
            family: Family::Firefox,
            root: home.join(".mozilla"),
        },
        // Firefox 147 and later keep a new profile here (XDG) and read native manifests here too.
        // Lens writes to each Mozilla folder that exists and never creates ~/.mozilla, which would
        // move Firefox back to its old folder.
        Browser {
            name: "Firefox",
            family: Family::Firefox,
            root: config.join("mozilla"),
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
    /// Whether the browser is on this computer. Firefox on macOS keeps its profiles in
    /// Application Support/Firefox and may never have made the Mozilla folder, where it still
    /// reads native messaging hosts; registering creates that folder.
    pub fn installed(&self) -> bool {
        self.root.is_dir()
            || (cfg!(target_os = "macos")
                && self.family == Family::Firefox
                && (self.root.with_file_name("Firefox").is_dir()
                    || Path::new("/Applications/Firefox.app").is_dir()))
    }
}

#[cfg(unix)]
pub fn register(_paths: &Paths, executable: &Path) -> io::Result<Report> {
    let (home, config) = home_and_config()?;
    register_unix(&browsers(&home, &config), executable)
}

#[cfg(unix)]
pub fn register_unix(browsers: &[Browser], executable: &Path) -> io::Result<Report> {
    let mut report = Vec::new();
    for browser in browsers {
        if !browser.installed() {
            report.push((browser.name, "not installed".to_string()));
            continue;
        }
        let path = manifest_path(browser);
        std::fs::create_dir_all(path.parent().expect("manifest has a folder"))?;
        let body = serde_json::to_vec_pretty(&manifest(browser.family, executable))?;
        write_atomically(&path, &body)?;
        report.push((browser.name, path.display().to_string()));
    }
    Ok(report)
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
    for browser in browsers() {
        let file = hosts.join(match browser.family {
            Family::Chromium => "chromium.json",
            Family::Firefox => "firefox.json",
        });
        write_atomically(
            &file,
            &serde_json::to_vec_pretty(&manifest(browser.family, executable))?,
        )?;
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(format!(r"{}\{HOST_NAME}", browser.registry_key))?;
        key.set_value("", &file.as_os_str())?;
        report.push((browser.name, file.display().to_string()));
    }
    Ok(report)
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
    // Sandboxed packages cannot start a program outside their sandbox through a plain manifest.
    #[cfg(not(target_os = "macos"))]
    for (name, folder) in [
        ("Firefox (Flatpak)", ".var/app/org.mozilla.firefox"),
        ("Google Chrome (Flatpak)", ".var/app/com.google.Chrome"),
        ("Chromium (Flatpak)", ".var/app/org.chromium.Chromium"),
        ("Brave (Flatpak)", ".var/app/com.brave.Browser"),
        ("Firefox (Snap)", "snap/firefox"),
        ("Chromium (Snap)", "snap/chromium"),
    ] {
        if home.join(folder).is_dir() {
            checks.push(BrowserCheck {
                name: name.into(),
                installed: true,
                registered: false,
                problem: Some(
                    "a sandboxed browser cannot start Lens yet; use this browser's system package"
                        .into(),
                ),
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
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, body)?;
    std::fs::rename(&temporary, path)
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
        };
        let chrome = Browser {
            name: "Google Chrome",
            family: Family::Chromium,
            root: dir.path().join("Google/Chrome"),
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
        register_unix(&browsers(home.path(), &config), executable).unwrap();
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
        let firefox_app =
            cfg!(target_os = "macos") && Path::new("/Applications/Firefox.app").is_dir();
        assert_eq!(written.len(), 1 + usize::from(firefox_app));

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
