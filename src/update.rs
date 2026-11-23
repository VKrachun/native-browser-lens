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
    /// When the release was made, in Unix seconds. Feeds before 0.12.24 lack it.
    #[serde(default)]
    pub released_at: Option<i64>,
    /// The oldest version this release may replace; never above `version`.
    #[serde(default)]
    pub min_version: Option<String>,
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
    if let Ok(paths) = Paths::resolve() {
        fresh(&manifest, &paths.data.join("last_seen_release_ts"))?;
    }
    Ok(newer(&manifest.version, env!("CARGO_PKG_VERSION")).then_some(manifest))
}

/// A signed manifest older than one this Lens already saw is a replay: a frozen feed, or one
/// rolled back to an older release. `floor` keeps the newest release time seen.
fn fresh(manifest: &Manifest, floor: &Path) -> Result<(), String> {
    let seen: Option<i64> = std::fs::read_to_string(floor)
        .ok()
        .and_then(|s| s.trim().parse().ok());
    match (manifest.released_at, seen) {
        (None, Some(_)) => Err(
            "the update feed has no release time, but an earlier one had: it looks replayed; nothing was installed"
                .into(),
        ),
        (Some(at), Some(seen)) if at < seen => Err(format!(
            "the update feed is older than one Lens already saw ({at} < {seen}): it looks replayed; nothing was installed"
        )),
        (Some(at), seen) if seen != Some(at) => {
            if let Some(folder) = floor.parent() {
                let _ = std::fs::create_dir_all(folder);
            }
            let _ = std::fs::write(floor, at.to_string());
            Ok(())
        }
        _ => Ok(()),
    }
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
    let manifest = serde_json::from_slice(manifest)
        .map_err(|e| format!("the update manifest is unreadable: {e}"))?;
    bound(manifest, signature.trusted_comment())
}

/// The signature also signs its trusted comment. Its `version` and `timestamp` (`=` or `:`, as
/// minisign writes it) must agree with the manifest; without `released_at`, the comment's
/// timestamp stands in for it.
fn bound(mut manifest: Manifest, comment: &str) -> Result<Manifest, String> {
    let field = |name: &str| {
        comment
            .split_whitespace()
            .find_map(|w| w.strip_prefix(name)?.strip_prefix(['=', ':']))
    };
    let tampered = |what: &str| {
        Err(format!(
            "the update manifest's {what} does not match its signature; nothing was installed"
        ))
    };
    if field("version")
        .is_some_and(|v| v.trim_start_matches('v') != manifest.version.trim_start_matches('v'))
    {
        return tampered("version");
    }
    match (
        field("timestamp").map(str::parse::<i64>),
        manifest.released_at,
    ) {
        (Some(Err(_)), _) => return tampered("release time"),
        (Some(Ok(signed)), Some(at)) if signed != at => return tampered("release time"),
        (Some(Ok(signed)), None) => manifest.released_at = Some(signed),
        _ => {}
    }
    if let Some(min) = manifest
        .min_version
        .as_deref()
        .filter(|min| newer(min, &manifest.version))
    {
        return Err(format!(
            "the update manifest is malformed: min_version {min} is above version {}; nothing was installed",
            manifest.version
        ));
    }
    Ok(manifest)
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
    if !newer(&manifest.version, env!("CARGO_PKG_VERSION")) {
        return Err(format!(
            "release {} is not newer than this Lens {}: no downgrade",
            manifest.version,
            env!("CARGO_PKG_VERSION")
        ));
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    if let Some(manager) = managed_by(&executable) {
        return Err(format!("{manager} updates this copy of Lens"));
    }
    let _lock = lock(paths)?;
    clean_up();
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
    // Every file is written beside its target before the first swap, so a failure up to there
    // changes nothing. `lens` goes last: the daemon restarts once that file changes.
    let mut names: Vec<String> = SPEECH_PROGRAMS
        .iter()
        .map(|name| format!("{name}{}", std::env::consts::EXE_SUFFIX))
        .collect();
    names.extend(
        if cfg!(windows) {
            &["lensw.exe", "lens.exe"][..]
        } else {
            &["lens"][..]
        }
        .iter()
        .map(|name| name.to_string()),
    );
    let mut staged = Vec::new();
    for (index, name) in names.into_iter().enumerate() {
        let target = executable.with_file_name(&name);
        let fresh = match extract(&archive, &asset.file, &name) {
            // The release builds the speech programs only for some computers.
            Err(_) if index < SPEECH_PROGRAMS.len() => continue,
            Err(e) => Err(e),
            Ok(bytes) => stage(&target, &bytes).map_err(|e| format!("cannot replace {name}: {e}")),
        };
        match fresh {
            Ok(fresh) => staged.push((name, fresh, target)),
            Err(e) => {
                for (_, fresh, _) in &staged {
                    let _ = std::fs::remove_file(fresh);
                }
                return Err(e);
            }
        }
    }
    let lens = staged.pop().expect("lens is staged last");
    for (name, fresh, target) in staged {
        swap(&fresh, &target).map_err(|e| format!("cannot replace {name}: {e}"))?;
    }
    if let Some(package) = extension {
        unpack_extension(&package, &paths.data.join("extension"))
            .map_err(|e| format!("cannot refresh the extension: {e}"))?;
    }
    swap(&lens.1, &lens.2).map_err(|e| format!("cannot replace {}: {e}", lens.0))
}

/// One update at a time, across processes: the update button, the daily check and `lens update`
/// share the staging names, and two at once could break the program or lose the app.
fn lock(paths: &Paths) -> Result<std::fs::File, String> {
    paths.ensure().map_err(|e| e.to_string())?;
    let file = std::fs::File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.runtime.join("update.lock"))
        .map_err(|e| e.to_string())?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => Err("an update is already running".into()),
        Err(std::fs::TryLockError::Error(e)) => Err(e.to_string()),
    }
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
    swap(&stage(target, bytes)?, target)
}

/// Writes `bytes` beside `target`, ready for `swap`.
fn stage(target: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
    let fresh = target.with_extension("update");
    std::fs::write(&fresh, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fresh, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(fresh)
}

fn swap(fresh: &Path, target: &Path) -> io::Result<()> {
    #[cfg(windows)]
    if target.exists() {
        // A name of its own: an earlier old copy a browser still runs cannot be removed yet.
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let old = target.with_extension(format!("{stamp}.old"));
        std::fs::rename(target, &old)?;
        // The browsers start this file: put the working one back when the new one cannot go in.
        return std::fs::rename(fresh, target).inspect_err(|_| {
            let _ = std::fs::rename(&old, target);
        });
    }
    std::fs::rename(fresh, target)
}

/// Unpacks into a sibling folder first and swaps, so a failure keeps the working extension.
fn unpack_extension(package: &[u8], folder: &Path) -> io::Result<()> {
    let fresh: PathBuf = folder.with_extension("new");
    let _ = std::fs::remove_dir_all(&fresh);
    zip::ZipArchive::new(io::Cursor::new(package))
        .and_then(|mut zip| zip.extract(&fresh))
        .map_err(io::Error::other)?;
    crate::bundle::swap_dir(&fresh, folder)
}

const SPEECH_PROGRAMS: [&str; 2] = ["lens-speech", "lens-speech-gpu"];

/// Removes the renamed executables a Windows update leaves behind once they no longer run
/// (`lens.old` from older versions, `lens.<stamp>.old` now).
pub fn clean_up() {
    let Some(folder) = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(Path::to_path_buf))
    else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&folder) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let stem = name.split('.').next().unwrap_or_default();
        if name.ends_with(".old")
            && ["lens", "lensw"]
                .iter()
                .chain(&SPEECH_PROGRAMS)
                .any(|s| *s == stem)
        {
            let _ = std::fs::remove_file(entry.path());
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
    fn a_second_update_is_refused_while_one_runs() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths {
            data: dir.path().join("data"),
            runtime: dir.path().join("run"),
            logs: dir.path().join("logs"),
        };
        let first = lock(&paths).unwrap();
        assert_eq!(lock(&paths).unwrap_err(), "an update is already running");
        drop(first);
        assert!(lock(&paths).is_ok());
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

        // The release signs with `-t "version=… timestamp=…"`: both must match the manifest.
        let sign = |comment: &str, body: &[u8]| {
            std::fs::write(&file, body).unwrap();
            let signed = std::process::Command::new("minisign")
                .args(["-S", "-s"])
                .arg(&secret)
                .arg("-m")
                .arg(&file)
                .args(["-t", comment])
                .output()
                .unwrap();
            assert!(signed.status.success());
            std::fs::read_to_string(dir.path().join("latest.json.minisig")).unwrap()
        };
        let current =
            br#"{"version":"9.9.9","assets":{},"extension":null,"released_at":1700000000}"#;
        let good = sign(
            "Sirv Lens 9.9.9 version=9.9.9 timestamp=1700000000",
            current,
        );
        let manifest = verified_with(&key, current, &good).unwrap();
        assert_eq!(manifest.released_at, Some(1700000000));
        let wrong = sign("version=9.9.8 timestamp=1700000000", current);
        assert!(
            verified_with(&key, current, &wrong)
                .unwrap_err()
                .contains("version does not match")
        );
        let stale = sign("version=9.9.9 timestamp=1600000000", current);
        assert!(
            verified_with(&key, current, &stale)
                .unwrap_err()
                .contains("release time does not match")
        );
    }

    fn manifest(version: &str, released_at: Option<i64>) -> Manifest {
        Manifest {
            version: version.into(),
            assets: BTreeMap::new(),
            installers: BTreeMap::new(),
            extension: None,
            released_at,
            min_version: None,
        }
    }

    #[test]
    fn the_trusted_comment_must_agree_with_the_manifest() {
        let plain = bound(manifest("1.2.0", None), "Sirv Lens 1.2.0").unwrap();
        assert_eq!(plain.released_at, None);
        // minisign's own comment: its timestamp stands in for a missing release time.
        let default = bound(
            manifest("1.2.0", None),
            "timestamp:1700000000\tfile:latest.json\thashed",
        )
        .unwrap();
        assert_eq!(default.released_at, Some(1700000000));
        assert!(bound(manifest("1.2.0", Some(5)), "version=1.2.0 timestamp=5").is_ok());
        assert!(bound(manifest("1.2.0", None), "version=v1.2.0").is_ok());
        assert!(bound(manifest("1.2.0", None), "version=1.1.0").is_err());
        assert!(bound(manifest("1.2.0", Some(5)), "timestamp=4").is_err());
        assert!(bound(manifest("1.2.0", None), "timestamp=soon").is_err());
        // A minimum above the version itself is malformed.
        let mut odd = manifest("1.2.0", None);
        odd.min_version = Some("1.3.0".into());
        assert!(bound(odd.clone(), "").unwrap_err().contains("malformed"));
        odd.min_version = Some("1.2.0".into());
        assert!(bound(odd, "").is_ok());
    }

    #[test]
    fn an_older_feed_than_one_seen_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let floor = dir.path().join("data").join("last_seen_release_ts");
        // An old feed without a release time passes until one with a release time is seen.
        assert!(fresh(&manifest("1.0.0", None), &floor).is_ok());
        assert!(!floor.exists());
        assert!(fresh(&manifest("1.1.0", Some(200)), &floor).is_ok());
        assert_eq!(std::fs::read_to_string(&floor).unwrap(), "200");
        assert!(fresh(&manifest("1.1.0", Some(200)), &floor).is_ok());
        assert!(
            fresh(&manifest("1.0.5", Some(100)), &floor)
                .unwrap_err()
                .contains("replayed")
        );
        assert!(
            fresh(&manifest("1.0.0", None), &floor)
                .unwrap_err()
                .contains("replayed")
        );
        assert!(fresh(&manifest("1.2.0", Some(300)), &floor).is_ok());
        assert_eq!(std::fs::read_to_string(&floor).unwrap(), "300");
    }

    #[test]
    fn install_refuses_a_downgrade() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths {
            data: dir.path().join("data"),
            runtime: dir.path().join("run"),
            logs: dir.path().join("logs"),
        };
        for version in ["0.0.1", env!("CARGO_PKG_VERSION")] {
            assert!(
                install(&paths, &manifest(version, None))
                    .unwrap_err()
                    .contains("no downgrade")
            );
        }
        // Nothing ran: not even the lock folder.
        assert!(!paths.runtime.exists());
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
