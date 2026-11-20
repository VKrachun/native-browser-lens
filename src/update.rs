//! Signed self-updates. Each release publishes `latest.json` (version, and the SHA-256 of every
//! archive) and its minisign signature. Lens installs an update only when the signature verifies
//! against the key built into it and every downloaded byte matches the signed hash.
use crate::paths::Paths;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The release signing key (its private half lives in the repository's MINISIGN_SECRET_KEY).
const PUBLIC_KEY: &str = "RWRUIk1sA/LfACfTQLljdyJArqZHzXbSZB32dsXEr2AMUrXAmSXevoDr";
const FEED: &str = "https://github.com/sirv/native-browser-lens/releases/latest/download";
const MAX_DOWNLOAD: u64 = 200 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Asset {
    pub file: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Manifest {
    pub version: String,
    /// Keyed by target triple, as release archives are named.
    pub assets: BTreeMap<String, Asset>,
    /// The installers, keyed as their names end ("macos-arm64", "linux-x86_64"): the macOS app
    /// and the AppImage update from these as a whole.
    #[serde(default)]
    pub installers: BTreeMap<String, Asset>,
    /// The unpacked-extension package, refreshed with the app until store listings take over.
    pub extension: Option<Asset>,
}

/// The archive this computer needs. Linux builds are static (musl), so any Linux takes them.
pub fn target() -> Option<&'static str> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "x86_64-unknown-linux-musl",
        ("linux", "aarch64") => "aarch64-unknown-linux-musl",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        // Windows on ARM runs the x64 build through its emulation; there is no ARM build.
        ("windows", "x86_64" | "aarch64") => "x86_64-pc-windows-msvc",
        _ => return None,
    })
}

/// The installer this computer's app and AppImage update from.
fn installer() -> Option<&'static str> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x86_64",
        ("macos", "aarch64") => "macos-arm64",
        ("macos", "x86_64") => "macos-x64",
        _ => return None,
    })
}

/// The AppImage this Lens runs from: Lens replaces that file as a whole.
fn appimage() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .filter(|image| image.is_file())
}

/// The macOS app bundle `executable` lives in: Lens replaces the bundle as a whole.
fn app_bundle(executable: &Path) -> Option<PathBuf> {
    let macos = executable.parent()?;
    let bundle = macos.parent()?.parent()?;
    (macos.ends_with("Contents/MacOS") && bundle.extension().is_some_and(|e| e == "app"))
        .then(|| bundle.to_path_buf())
}

/// Who updates this copy instead of Lens: a package manager or the Microsoft Store.
pub fn managed_by(executable: &Path) -> Option<&'static str> {
    if std::env::var("LENS_UPDATES").is_ok_and(|v| v == "off") {
        return Some("LENS_UPDATES=off");
    }
    if appimage().is_some() {
        return None;
    }
    let path = executable.to_string_lossy();
    if path.contains("/Cellar/") || path.contains("/homebrew/") {
        Some("Homebrew")
    } else if path.starts_with("/usr/") || path.starts_with("/opt/") {
        Some("the system package manager")
    } else if path.contains("\\WindowsApps\\") {
        Some("the Microsoft Store")
    } else {
        None
    }
}

fn feed() -> String {
    std::env::var("LENS_UPDATE_FEED").unwrap_or_else(|_| FEED.into())
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(300)))
        .build()
        .into()
}

fn download(agent: &ureq::Agent, url: &str) -> Result<Vec<u8>, String> {
    let mut response = agent
        .get(url)
        .call()
        .map_err(|e| format!("cannot download {url}: {e}"))?;
    response
        .body_mut()
        .with_config()
        .limit(MAX_DOWNLOAD)
        .read_to_vec()
        .map_err(|e| format!("the download of {url} broke off: {e}"))
}

/// `1.10.0` > `1.9.3`; anything unparsable counts as 0.
pub fn newer(candidate: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split('.')
            .map(|p| p.parse().unwrap_or(0))
            .collect()
    };
    parse(candidate) > parse(current)
}

/// The signed manifest, verified; Some only when it offers a newer version than this one.
pub fn check() -> Result<Option<Manifest>, String> {
    let agent = agent();
    let base = feed();
    let manifest = download(&agent, &format!("{base}/latest.json")).map_err(|e| {
        if e.ends_with("404") {
            "no published Lens release to update from yet".to_string()
        } else {
            e
        }
    })?;
    let signature = download(&agent, &format!("{base}/latest.json.minisig"))?;
    let manifest = verified(&manifest, &String::from_utf8_lossy(&signature))?;
    Ok(newer(&manifest.version, env!("CARGO_PKG_VERSION")).then_some(manifest))
}

fn verified(manifest: &[u8], signature: &str) -> Result<Manifest, String> {
    // Debug builds may trust a test key (the update round-trip test); release builds never do.
    #[cfg(debug_assertions)]
    if let Ok(key) = std::env::var("LENS_UPDATE_PUBLIC_KEY") {
        return verified_with(&key, manifest, signature);
    }
    verified_with(PUBLIC_KEY, manifest, signature)
}

fn verified_with(public_key: &str, manifest: &[u8], signature: &str) -> Result<Manifest, String> {
    let key = minisign_verify::PublicKey::from_base64(public_key).map_err(|e| e.to_string())?;
    let signature = minisign_verify::Signature::decode(signature)
        .map_err(|e| format!("the update signature is unreadable: {e}"))?;
    key.verify(manifest, &signature, false).map_err(|e| {
        format!("the update is not signed by the Lens release key ({e}); nothing was installed")
    })?;
    serde_json::from_slice(manifest).map_err(|e| format!("the update manifest is unreadable: {e}"))
}

fn checked(bytes: Vec<u8>, asset: &Asset) -> Result<Vec<u8>, String> {
    let actual: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if actual == asset.sha256 {
        Ok(bytes)
    } else {
        Err(format!(
            "{} does not match its signed hash; nothing was installed",
            asset.file
        ))
    }
}

/// Downloads, verifies and installs a newer release over this binary (and `lensw` on Windows),
/// and refreshes the unpacked extension when there is one. The caller restarts Lens.
pub fn install(paths: &Paths, manifest: &Manifest) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    if let Some(manager) = managed_by(&executable) {
        return Err(format!("{manager} updates this copy of Lens"));
    }
    let agent = agent();
    let fetch_installer = || {
        let key = installer().ok_or("no Lens installer exists for this computer")?;
        let asset = manifest
            .installers
            .get(key)
            .ok_or_else(|| format!("release {} has no installer for {key}", manifest.version))?;
        checked(
            download(&agent, &format!("{}/{}", feed(), asset.file))?,
            asset,
        )
    };
    // Installer copies are replaced whole: one changed file would break the app's signature or
    // the AppImage. Their bundled extensions follow on the next start.
    if let Some(image) = appimage() {
        let bytes = fetch_installer()?;
        return replace(&image, &bytes).map_err(|e| format!("cannot replace the AppImage: {e}"));
    }
    if let Some(bundle) = app_bundle(&executable) {
        let dmg = fetch_installer()?;
        return replace_app(paths, &bundle, &dmg);
    }
    let target = target().ok_or("no Lens build exists for this computer")?;
    let asset = manifest
        .assets
        .get(target)
        .ok_or_else(|| format!("release {} has no build for {target}", manifest.version))?;
    let archive = checked(
        download(&agent, &format!("{}/{}", feed(), asset.file))?,
        asset,
    )?;
    // Everything downloads before the first file changes: the daemon restarts on the new program
    // within seconds of its replacement, and that would end a download still under way.
    let extension = match &manifest.extension {
        Some(extension) if paths.data.join("extension").is_dir() => Some(checked(
            download(&agent, &format!("{}/{}", feed(), extension.file))?,
            extension,
        )?),
        _ => None,
    };
    let names: &[&str] = if cfg!(windows) {
        &["lens.exe", "lensw.exe"]
    } else {
        &["lens"]
    };
    for name in names {
        let bytes = extract(&archive, &asset.file, name)?;
        replace(&executable.with_file_name(name), &bytes)
            .map_err(|e| format!("cannot replace {name}: {e}"))?;
    }
    // The speech programs, where the release builds them for this computer.
    for name in SPEECH_PROGRAMS {
        let name = format!("{name}{}", std::env::consts::EXE_SUFFIX);
        if let Ok(bytes) = extract(&archive, &asset.file, &name) {
            replace(&executable.with_file_name(&name), &bytes)
                .map_err(|e| format!("cannot replace {name}: {e}"))?;
        }
    }
    if let Some(package) = extension {
        unpack_extension(&package, &paths.data.join("extension"))
            .map_err(|e| format!("cannot refresh the extension: {e}"))?;
    }
    Ok(())
}

/// Copies the app out of the signed DMG beside `bundle`, checks its signature, and swaps it in.
#[cfg(target_os = "macos")]
fn replace_app(paths: &Paths, bundle: &Path, dmg: &[u8]) -> Result<(), String> {
    use std::process::Command;
    let run = |program: &str, args: &[&std::ffi::OsStr]| -> Result<(), String> {
        let output = Command::new(program)
            .args(args)
            .output()
            .map_err(|e| format!("cannot start {program}: {e}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "{program}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    };
    let work = paths.data.join("tmp").join("update");
    let _ = std::fs::remove_dir_all(&work);
    let mount = work.join("mount");
    std::fs::create_dir_all(&mount).map_err(|e| e.to_string())?;
    let image = work.join("Sirv-Lens.dmg");
    std::fs::write(&image, dmg).map_err(|e| e.to_string())?;
    let fresh = bundle.with_extension("app-update");
    let _ = std::fs::remove_dir_all(&fresh);
    let os = |p: &Path| p.as_os_str().to_owned();
    run(
        "hdiutil",
        &[
            "attach".as_ref(),
            "-nobrowse".as_ref(),
            "-readonly".as_ref(),
            "-noautoopen".as_ref(),
            "-mountpoint".as_ref(),
            &os(&mount),
            &os(&image),
        ],
    )?;
    let copied = std::fs::read_dir(&mount)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|entry| entry.path())
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .ok_or_else(|| "the update has no app in it".to_string())
        .and_then(|app| run("ditto", &[&os(&app), &os(&fresh)]));
    let _ = run(
        "hdiutil",
        &["detach".as_ref(), "-force".as_ref(), &os(&mount)],
    );
    let _ = std::fs::remove_dir_all(&work);
    copied?;
    run(
        "codesign",
        &[
            "--verify".as_ref(),
            "--deep".as_ref(),
            "--strict".as_ref(),
            &os(&fresh),
        ],
    )
    .map_err(|e| format!("the new app's signature does not verify ({e}); nothing was installed"))?;
    // The running Lens keeps its open files; the next start runs the new bundle at the same path.
    let old = bundle.with_extension("app-old");
    let _ = std::fs::remove_dir_all(&old);
    std::fs::rename(bundle, &old)
        .map_err(|e| format!("cannot replace {}: {e}", bundle.display()))?;
    if let Err(e) = std::fs::rename(&fresh, bundle) {
        let _ = std::fs::rename(&old, bundle);
        return Err(format!("cannot replace {}: {e}", bundle.display()));
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn replace_app(_paths: &Paths, _bundle: &Path, _dmg: &[u8]) -> Result<(), String> {
    Err("an app bundle updates only on macOS".into())
}

/// One file from a release archive, found by its name in any folder.
fn extract(archive: &[u8], archive_name: &str, name: &str) -> Result<Vec<u8>, String> {
    let missing = || format!("{archive_name} has no {name}");
    if archive_name.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(io::Cursor::new(archive)).map_err(|e| e.to_string())?;
        let index = (0..zip.len())
            .find(|&i| {
                zip.name_for_index(i)
                    .and_then(Result::ok)
                    .is_some_and(|n| n.rsplit('/').next() == Some(name))
            })
            .ok_or_else(missing)?;
        let mut bytes = Vec::new();
        zip.by_index(index)
            .map_err(|e| e.to_string())?
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        return Ok(bytes);
    }
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    for entry in tar.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        if path.file_name().is_some_and(|n| n == name) {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            return Ok(bytes);
        }
    }
    Err(missing())
}

/// Writes beside the target, then renames over it: a reader sees the old file or the new one,
/// never half of one. Windows cannot replace a running executable, but can rename it aside.
fn replace(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let fresh = target.with_extension("update");
    std::fs::write(&fresh, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fresh, std::fs::Permissions::from_mode(0o755))?;
    }
    #[cfg(windows)]
    if target.exists() {
        let old = target.with_extension("old");
        let _ = std::fs::remove_file(&old);
        std::fs::rename(target, &old)?;
        // The browsers start this file: put the working one back when the new one cannot go in.
        return std::fs::rename(&fresh, target).inspect_err(|_| {
            let _ = std::fs::rename(&old, target);
        });
    }
    std::fs::rename(&fresh, target)
}

/// Unpacks into a sibling folder first and swaps, so a failure keeps the working extension.
fn unpack_extension(package: &[u8], folder: &Path) -> io::Result<()> {
    let fresh: PathBuf = folder.with_extension("new");
    let _ = std::fs::remove_dir_all(&fresh);
    zip::ZipArchive::new(io::Cursor::new(package))
        .and_then(|mut zip| zip.extract(&fresh))
        .map_err(io::Error::other)?;
    std::fs::remove_dir_all(folder)?;
    std::fs::rename(&fresh, folder)
}

const SPEECH_PROGRAMS: [&str; 2] = ["lens-speech", "lens-speech-gpu"];

/// Removes the renamed executables a Windows update leaves behind once they no longer run.
pub fn clean_up() {
    if let Ok(executable) = std::env::current_exe() {
        for name in [
            "lens.old",
            "lensw.old",
            "lens-speech.old",
            "lens-speech-gpu.old",
        ] {
            let _ = std::fs::remove_file(executable.with_file_name(name));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_bundles_are_found_and_installers_listed() {
        assert_eq!(
            app_bundle(Path::new("/Applications/Sirv Lens.app/Contents/MacOS/lens")),
            Some(PathBuf::from("/Applications/Sirv Lens.app"))
        );
        assert_eq!(app_bundle(Path::new("/home/a/.local/bin/lens")), None);
        let manifest: Manifest = serde_json::from_str(
            r#"{"version":"1.0.0","assets":{},"installers":{"macos-arm64":{"file":"a.dmg","sha256":"00"}},"extension":null}"#,
        )
        .unwrap();
        assert_eq!(manifest.installers["macos-arm64"].file, "a.dmg");
        let old: Manifest =
            serde_json::from_str(r#"{"version":"1.0.0","assets":{},"extension":null}"#).unwrap();
        assert!(old.installers.is_empty());
    }

    #[test]
    fn versions_compare_by_number() {
        assert!(newer("0.10.0", "0.9.9"));
        assert!(newer("v1.0.0", "0.99.0"));
        assert!(!newer("0.2.0", "0.2.0"));
        assert!(!newer("0.1.9", "0.2.0"));
    }

    #[test]
    fn only_the_release_key_is_accepted() {
        let manifest = br#"{"version":"9.9.9","assets":{},"extension":null}"#;
        // Signed with another key: refused, whatever it says.
        let foreign = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==\n";
        assert!(
            verified(manifest, foreign)
                .unwrap_err()
                .contains("not signed by the Lens release key")
        );
        assert!(verified(manifest, "garbage").is_err());
    }

    /// A throwaway key from the minisign CLI, when it is installed: a good signature verifies and
    /// one changed byte does not.
    #[test]
    fn a_signed_manifest_verifies_and_a_changed_one_does_not() {
        let Ok(dir) = tempfile::tempdir() else { return };
        let (public, secret, file) = (
            dir.path().join("k.pub"),
            dir.path().join("k.key"),
            dir.path().join("latest.json"),
        );
        let generated = std::process::Command::new("minisign")
            .args(["-G", "-W", "-p"])
            .arg(&public)
            .arg("-s")
            .arg(&secret)
            .output();
        if !generated.is_ok_and(|o| o.status.success()) {
            return; // no minisign here
        }
        let manifest = br#"{"version":"9.9.9","assets":{},"extension":null}"#;
        std::fs::write(&file, manifest).unwrap();
        assert!(
            std::process::Command::new("minisign")
                .args(["-S", "-s"])
                .arg(&secret)
                .arg("-m")
                .arg(&file)
                .output()
                .unwrap()
                .status
                .success()
        );
        let key = std::fs::read_to_string(&public)
            .unwrap()
            .lines()
            .nth(1)
            .unwrap()
            .to_string();
        let signature = std::fs::read_to_string(dir.path().join("latest.json.minisig")).unwrap();
        assert_eq!(
            verified_with(&key, manifest, &signature).unwrap().version,
            "9.9.9"
        );
        let tampered = br#"{"version":"9.9.8","assets":{},"extension":null}"#;
        assert!(verified_with(&key, tampered, &signature).is_err());
    }

    #[test]
    fn hashes_must_match() {
        let asset = Asset {
            file: "x".into(),
            sha256: "0".repeat(64),
        };
        assert!(checked(b"lens".to_vec(), &asset).is_err());
        let good = Asset {
            file: "x".into(),
            sha256: Sha256::digest(b"lens")
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
        };
        assert_eq!(checked(b"lens".to_vec(), &good).unwrap(), b"lens");
    }

    #[test]
    fn package_managed_copies_do_not_update_themselves() {
        assert_eq!(
            managed_by(Path::new("/opt/homebrew/Cellar/lens/1/bin/lens")),
            Some("Homebrew")
        );
        assert_eq!(
            managed_by(Path::new("/usr/bin/lens")),
            Some("the system package manager")
        );
        assert_eq!(managed_by(Path::new("/home/a/.local/bin/lens")), None);
    }

    #[test]
    fn extracts_the_binary_from_a_tarball() {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        let mut header = tar::Header::new_gnu();
        header.set_size(4);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, "sirv-lens-1-x/lens", &b"BIN!"[..])
            .unwrap();
        let archive = builder.into_inner().unwrap().finish().unwrap();
        assert_eq!(extract(&archive, "a.tar.gz", "lens").unwrap(), b"BIN!");
        assert!(extract(&archive, "a.tar.gz", "lensw.exe").is_err());
    }
}
