//! The native messaging host the browser starts. It relays frames between the browser and `lensd`,
//! and starts `lensd` when it is not running. It holds no state and makes no decisions.
use crate::framing::{read_frame, write_frame};
use crate::ipc;
use crate::paths::Paths;
use crate::protocol::{MAX_REPLY_BYTES, MAX_REQUEST_BYTES};
use interprocess::local_socket::Stream;
use std::io::{self, Read, Write};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub fn run(paths: &Paths) -> io::Result<()> {
    let stream =
        Arc::new(connect_or_start(paths).inspect_err(|e| log(paths, &format!("connect: {e}")))?);
    let to_daemon = stream.clone();
    let log_paths = paths.clone();
    std::thread::spawn(move || {
        // The browser closed the port: nothing more will come, so the shim ends.
        if let Err(e) = relay(&mut io::stdin().lock(), &mut &*to_daemon, MAX_REQUEST_BYTES) {
            log(&log_paths, &format!("browser to daemon: {e}"));
        }
        std::process::exit(0);
    });
    relay(&mut &*stream, &mut io::stdout().lock(), MAX_REPLY_BYTES)
        .inspect_err(|e| log(paths, &format!("daemon to browser: {e}")))
}

/// Browsers discard a host's stderr (Chrome on Windows always), so errors go to `host.log` in the
/// log folder.
fn log(paths: &Paths, line: &str) {
    if let Ok(mut file) = paths.log("host.log") {
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "{seconds} pid {}: {line}", std::process::id());
    }
}

fn relay(from: &mut impl Read, to: &mut impl Write, limit: usize) -> io::Result<()> {
    while let Some(frame) = read_frame(from, limit)? {
        write_frame(to, &frame)?;
    }
    Ok(())
}

pub fn connect_or_start(paths: &Paths) -> io::Result<Stream> {
    if let Ok(stream) = ipc::connect(paths) {
        return Ok(stream);
    }
    // With the service installed, the service manager starts the daemon: a plain one started
    // here, say in the seconds an update restarts the service, would take its lock and leave
    // Lens without its update watch and tray until the next login.
    // A data folder of its own (LENS_HOME: tests, demos) never uses the person's service.
    let service = std::env::var_os("LENS_HOME").is_none()
        && crate::service::state(paths) != crate::service::State::NotInstalled
        && crate::service::start(paths).is_ok();
    if !service {
        spawn_daemon(paths)?;
    }
    wait_for_daemon(paths)
}

/// Starts a plain daemon when none answers, never through the service: how a service without a
/// manager (Windows, Linux without systemd) starts Lens. Going through `connect_or_start` there
/// would ask the service again, without end.
pub fn connect_or_spawn(paths: &Paths) -> io::Result<Stream> {
    if let Ok(stream) = ipc::connect(paths) {
        return Ok(stream);
    }
    spawn_daemon(paths)?;
    wait_for_daemon(paths)
}

fn wait_for_daemon(paths: &Paths) -> io::Result<Stream> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match ipc::connect(paths) {
            Ok(stream) => return Ok(stream),
            Err(e) if Instant::now() >= deadline => {
                return Err(io::Error::new(
                    e.kind(),
                    format!("lensd did not start: {e}"),
                ));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// The daemon outlives the shim: its own process group (Unix), detached and out of the browser's
/// job object (Windows). Its stderr goes to `lensd.log` in the log folder.
fn spawn_daemon(paths: &Paths) -> io::Result<()> {
    paths.ensure()?;
    let log = paths.log("lensd.log")?;
    let mut command = Command::new(crate::paths::executable()?);
    command
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::Foundation::{
            HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
        };
        use windows_sys::Win32::System::Console::{
            GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
        };
        // The shim's standard handles are the browser's native messaging pipes. Windows passes every
        // inheritable handle to a child, so without this the long-lived daemon would hold the pipes
        // open and the browser would never see the host end.
        for id in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            // SAFETY: GetStdHandle returns this process's own handle or null/invalid, both checked.
            unsafe {
                let handle = GetStdHandle(id);
                if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                    SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
                }
            }
        }
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        command.creation_flags(
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
        );
        if command.spawn().is_ok() {
            return Ok(());
        }
        // The job forbids breakaway: the daemon then lives as long as the browser's job does.
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    command.spawn().map(drop)
}
