use std::io;
use std::path::PathBuf;

/// Where Lens keeps its data and its daemon socket. Binaries never live here, so an update never
/// touches the notebook. `LENS_HOME` puts everything under one folder (tests, portable runs).
#[derive(Clone, Debug)]
pub struct Paths {
    pub data: PathBuf,
    pub runtime: PathBuf,
    pub logs: PathBuf,
}

impl Paths {
    pub fn resolve() -> io::Result<Self> {
        if let Some(home) = std::env::var_os("LENS_HOME").filter(|v| !v.is_empty()) {
            let data = PathBuf::from(home);
            return Ok(Self {
                runtime: data.join("run"),
                logs: data.join("logs"),
                data,
            });
        }
        let base = directories::BaseDirs::new()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no home directory"))?;
        #[cfg(target_os = "macos")]
        let data = base.data_local_dir().join("Sirv Lens");
        #[cfg(windows)]
        let data = base.data_local_dir().join("Sirv").join("Lens");
        #[cfg(all(unix, not(target_os = "macos")))]
        let data = base.data_local_dir().join("sirv-lens");
        // $XDG_RUNTIME_DIR is per user, mode 0700 and cleared at logout: the right home for a socket.
        #[cfg(all(unix, not(target_os = "macos")))]
        let runtime = base
            .runtime_dir()
            .map(|r| r.join("sirv-lens"))
            .unwrap_or_else(|| data.join("run"));
        #[cfg(not(all(unix, not(target_os = "macos"))))]
        let runtime = data.join("run");
        #[cfg(target_os = "macos")]
        let logs = base.home_dir().join("Library/Logs/Sirv Lens");
        #[cfg(windows)]
        let logs = data.join("logs");
        // $XDG_STATE_HOME is where the XDG spec puts logs; ~/.local/state when unset.
        #[cfg(all(unix, not(target_os = "macos")))]
        let logs = base
            .state_dir()
            .map(|s| s.join("sirv-lens"))
            .unwrap_or_else(|| base.home_dir().join(".local/state/sirv-lens"));
        Ok(Self {
            data,
            runtime,
            logs,
        })
    }

    pub fn ensure(&self) -> io::Result<()> {
        for dir in [&self.data, &self.runtime, &self.blobs(), &self.logs] {
            private_dir(dir)?;
        }
        // The short socket folder, when the runtime folder's path is too long (see `socket`). It
        // sits in a shared temporary folder: made without following links, and checked.
        #[cfg(unix)]
        if let Some(folder) = self.socket_folder() {
            use std::os::unix::fs::DirBuilderExt;
            match std::fs::DirBuilder::new().mode(0o700).create(&folder) {
                Err(e) if e.kind() != io::ErrorKind::AlreadyExists => return Err(e),
                _ => {}
            }
            self.check_socket_folder()?;
        }
        Ok(())
    }

    /// The socket's folder when it is not the private runtime folder.
    #[cfg(unix)]
    fn socket_folder(&self) -> Option<PathBuf> {
        let folder = self.socket().parent().map(PathBuf::from)?;
        (folder != self.runtime).then_some(folder)
    }

    /// Another account could make the shared-temporary socket folder first, or put a link there:
    /// then it is refused, by the daemon before it listens and by a client before it connects.
    #[cfg(unix)]
    pub fn check_socket_folder(&self) -> io::Result<()> {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let Some(folder) = self.socket_folder() else {
            return Ok(());
        };
        let meta = std::fs::symlink_metadata(&folder)?;
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { libc::getuid() };
        if !meta.file_type().is_dir() || meta.uid() != uid || meta.permissions().mode() & 0o077 != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "{} is not a private folder of this account; remove it, then start Lens again",
                    folder.display()
                ),
            ));
        }
        Ok(())
    }

    /// Where exports go: the person's Downloads folder, else `~/Downloads`.
    pub fn downloads(&self) -> PathBuf {
        directories::UserDirs::new()
            .and_then(|dirs| dirs.download_dir().map(PathBuf::from))
            .or_else(|| directories::BaseDirs::new().map(|b| b.home_dir().join("Downloads")))
            .unwrap_or_else(|| self.data.join("exports"))
    }

    /// Frozen filing attempts: what was reviewed, byte for byte, until VibeQ confirms it.
    pub fn filings(&self) -> PathBuf {
        self.data.join("filings")
    }

    pub fn database(&self) -> PathBuf {
        self.data.join("lens.sqlite")
    }

    pub fn blobs(&self) -> PathBuf {
        self.data.join("blobs")
    }

    /// A log file; it restarts empty when it passes 1 MiB, so logs never grow without bound.
    pub fn log(&self, name: &str) -> std::io::Result<std::fs::File> {
        private_dir(&self.logs)?;
        let path = self.logs.join(name);
        let full = std::fs::metadata(&path).is_ok_and(|m| m.len() > 1024 * 1024);
        std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(!full)
            .truncate(full)
            .open(path)
    }

    pub fn lock(&self) -> PathBuf {
        self.runtime.join("lensd.lock")
    }

    /// A socket address holds 104 bytes on macOS (108 on Linux), so a long home folder or
    /// LENS_HOME does not fit: then the socket goes to a short 0700 folder of this account's own in
    /// the temporary folder, named for the runtime folder so two data folders never meet.
    #[cfg(unix)]
    pub fn socket(&self) -> PathBuf {
        let path = self.runtime.join("lensd.sock");
        if path.as_os_str().len() < 100 {
            return path;
        }
        let digest = self
            .runtime
            .as_os_str()
            .as_encoded_bytes()
            .iter()
            .fold(0xcbf29ce484222325u64, |h, b| {
                (h ^ *b as u64).wrapping_mul(0x100000001b3)
            });
        let temporary = std::env::temp_dir();
        let base = if temporary.as_os_str().len() > 60 {
            PathBuf::from("/tmp")
        } else {
            temporary
        };
        // SAFETY: getuid has no preconditions and cannot fail.
        let uid = unsafe { libc::getuid() };
        base.join(format!("sirv-lens-{uid}"))
            .join(format!("{digest:016x}.sock"))
    }

    /// Named pipes share one machine-wide namespace, so the name carries the data folder: two users,
    /// or a test with its own LENS_HOME, never meet. The pipe's DACL admits only its owner.
    #[cfg(windows)]
    pub fn pipe_name(&self) -> String {
        let digest = self
            .data
            .to_string_lossy()
            .to_lowercase()
            .bytes()
            .fold(0xcbf29ce484222325u64, |h, b| {
                (h ^ b as u64).wrapping_mul(0x100000001b3)
            });
        format!("sirv-lens-{digest:016x}")
    }
}

#[cfg(unix)]
fn private_dir(dir: &PathBuf) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

#[cfg(windows)]
fn private_dir(dir: &PathBuf) -> io::Result<()> {
    // %LOCALAPPDATA% is already private to the account.
    std::fs::create_dir_all(dir)
}

/// The file that starts Lens, for the service, the browser registrations and restarts. From an
/// AppImage that is the AppImage itself: the running binary lives in a mount that goes away.
pub fn executable() -> io::Result<PathBuf> {
    match std::env::var_os("APPIMAGE").map(PathBuf::from) {
        Some(image) if image.is_file() => Ok(image),
        _ => std::env::current_exe(),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn a_long_runtime_folder_gets_a_short_socket() {
        let at = |runtime: &str| Paths {
            data: PathBuf::from("/d"),
            runtime: PathBuf::from(runtime),
            logs: PathBuf::from("/l"),
        };
        assert_eq!(
            at("/run/user/1000/sirv-lens").socket(),
            PathBuf::from("/run/user/1000/sirv-lens/lensd.sock")
        );
        let long = format!(
            "/Users/{}/Library/Application Support/Sirv Lens/run",
            "a".repeat(60)
        );
        let socket = at(&long).socket();
        assert!(socket.as_os_str().len() < 104, "{}", socket.display());
        assert_ne!(socket, at(&format!("{long}2")).socket());
    }
}
