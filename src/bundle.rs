//! What an installer puts beside Lens: the browser extensions, built for Chrome-family browsers and
//! for Firefox. They are unpacked into the data folder, the stable place people load them from, and
//! refreshed there whenever an installer brings a different build.
use crate::paths::Paths;
use std::io;
use std::path::{Path, PathBuf};

pub const EXTENSIONS: [&str; 2] = ["extension", "extension-firefox"];

/// Where the installers put resources: the macOS app bundle, the Linux packages and AppImage, or
/// the Windows install folder. None for a plain binary (development, install.sh).
fn resources() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let dir = executable.parent()?;
    [
        dir.join("../Resources"),
        dir.join("../lib/sirv-lens"),
        dir.join("../lib/lens"),
        dir.to_path_buf(),
    ]
    .into_iter()
    .find(|d| d.join("extension").join("manifest.json").is_file())
}

/// Copies each bundled extension into the data folder when the copy there differs. Returns
/// whether one changed, so the caller can say that the browser must reload it.
pub fn sync_extensions(paths: &Paths) -> io::Result<bool> {
    let Some(from) = resources() else {
        return Ok(false);
    };
    let mut changed = false;
    for name in EXTENSIONS {
        let source = from.join(name);
        let target = paths.data.join(name);
        if !source.join("manifest.json").is_file() || fingerprint(&source) == fingerprint(&target) {
            continue;
        }
        // A self-update unpacks a newer build than the installer's (a Windows install folder keeps
        // the one it came with): never go back to the older one.
        if let (Some(have), Some(bundled)) = (version(&target), version(&source))
            && crate::update::newer(&have, &bundled)
        {
            continue;
        }
        // Next to the target, then swapped in: a browser never sees half a folder.
        let fresh = paths.data.join(format!(".{name}.new"));
        let _ = std::fs::remove_dir_all(&fresh);
        copy_dir(&source, &fresh)?;
        swap_dir(&fresh, &target)?;
        changed = true;
    }
    Ok(changed)
}

fn version(dir: &Path) -> Option<String> {
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).ok()?).ok()?;
    Some(manifest.get("version")?.as_str()?.to_string())
}

/// Puts the folder `fresh` in place of `folder`. The old one goes aside first, comes back when the
/// new one cannot go in, and is removed only once the new one is in: a failure never leaves none.
pub fn swap_dir(fresh: &Path, folder: &Path) -> io::Result<()> {
    let old = folder.with_extension("old");
    let _ = std::fs::remove_dir_all(&old);
    match std::fs::rename(folder, &old) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    if let Err(e) = std::fs::rename(fresh, folder) {
        let _ = std::fs::rename(&old, folder);
        return Err(e);
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

/// Every file's relative path and size, plus a hash of the manifest: equal for two copies of one
/// build.
fn fingerprint(dir: &Path) -> Option<Vec<(String, u64)>> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    std::fs::read(dir.join("manifest.json"))
        .ok()?
        .hash(&mut hasher);
    let mut files = vec![(String::new(), hasher.finish())];
    let mut stack = vec![dir.to_path_buf()];
    while let Some(folder) = stack.pop() {
        for entry in std::fs::read_dir(&folder).ok()?.flatten() {
            let path = entry.path();
            let meta = entry.metadata().ok()?;
            if meta.is_dir() {
                stack.push(path);
            } else {
                let relative = path.strip_prefix(dir).ok()?.to_string_lossy().into_owned();
                files.push((relative, meta.len()));
            }
        }
    }
    files.sort();
    Some(files)
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_copy_matches_and_a_change_does_not() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        std::fs::create_dir_all(a.join("chunks")).unwrap();
        std::fs::write(a.join("manifest.json"), "{\"version\":\"1\"}").unwrap();
        std::fs::write(a.join("chunks/x.js"), "x").unwrap();
        let b = dir.path().join("b");
        copy_dir(&a, &b).unwrap();
        assert_eq!(fingerprint(&a), fingerprint(&b));
        std::fs::write(b.join("chunks/x.js"), "xy").unwrap();
        assert_ne!(fingerprint(&a), fingerprint(&b));
        assert!(fingerprint(&dir.path().join("none")).is_none());
    }

    #[test]
    fn a_swap_replaces_the_folder_and_versions_are_read() {
        let dir = tempfile::tempdir().unwrap();
        let (folder, fresh) = (dir.path().join("extension"), dir.path().join(".new"));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("manifest.json"), r#"{"version":"0.12.23"}"#).unwrap();
        std::fs::create_dir_all(&fresh).unwrap();
        std::fs::write(fresh.join("manifest.json"), r#"{"version":"0.12.9"}"#).unwrap();
        assert!(crate::update::newer(
            &version(&folder).unwrap(),
            &version(&fresh).unwrap()
        ));
        swap_dir(&fresh, &folder).unwrap();
        assert_eq!(version(&folder).as_deref(), Some("0.12.9"));
        assert!(!fresh.exists() && !folder.with_extension("old").exists());
        // No folder yet: the new one simply goes in.
        std::fs::create_dir_all(&fresh).unwrap();
        swap_dir(&fresh, &dir.path().join("extension-firefox")).unwrap();
        assert!(dir.path().join("extension-firefox").is_dir());
    }
}
