//! The daemon's local endpoint: a Unix socket in a 0700 folder on macOS and Linux, a named pipe
//! that admits only its owner on Windows. Never a TCP port.
use crate::paths::Paths;
use interprocess::local_socket::{Listener, ListenerOptions, Stream, prelude::*};
use std::io;

#[cfg(unix)]
pub fn listen(paths: &Paths) -> io::Result<Listener> {
    use interprocess::local_socket::GenericFilePath;
    paths.check_socket_folder()?;
    let path = paths.socket();
    // Only the lock holder calls this, so a socket file left here belongs to a dead daemon.
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let options = ListenerOptions::new().name(path.as_path().to_fs_name::<GenericFilePath>()?);
    // The 0700 folder (Paths::ensure) is what keeps other accounts out: BSD kernels, macOS among
    // them, ignore a socket file's own mode, and interprocess can set it only on Linux.
    #[cfg(target_os = "linux")]
    let options = {
        use interprocess::os::unix::local_socket::ListenerOptionsExt;
        options.mode(0o600)
    };
    options.create_sync()
}

#[cfg(unix)]
pub fn connect(paths: &Paths) -> io::Result<Stream> {
    use interprocess::local_socket::GenericFilePath;
    paths.check_socket_folder()?;
    Stream::connect(paths.socket().as_path().to_fs_name::<GenericFilePath>()?)
}

#[cfg(windows)]
pub fn listen(paths: &Paths) -> io::Result<Listener> {
    use interprocess::local_socket::GenericNamespaced;
    use interprocess::os::windows::{
        local_socket::ListenerOptionsExt, security_descriptor::SecurityDescriptor,
    };
    // Protected DACL, one ACE: full access for the pipe's owner (OW), nobody else.
    let sddl = widestring::U16CString::from_str("D:P(A;;GA;;;OW)").map_err(io::Error::other)?;
    ListenerOptions::new()
        .name(paths.pipe_name().to_ns_name::<GenericNamespaced>()?)
        .security_descriptor(SecurityDescriptor::deserialize(&sddl)?)
        .create_sync()
}

/// Pipe names are machine-wide, so another account could create ours first while no daemon runs.
/// The daemon then fails to create its first instance (FILE_FLAG_FIRST_PIPE_INSTANCE). The client
/// guards itself twice before it sends a byte: it opens the pipe at identification level only, so a
/// foreign server cannot impersonate it, and it accepts the pipe only when the pipe object's owner is
/// the current user. Owning an object as another user needs SeRestorePrivilege, so this check
/// cannot be faked the way a process ID can be reused.
#[cfg(windows)]
pub fn connect(paths: &Paths) -> io::Result<Stream> {
    use interprocess::os::windows::named_pipe::local_socket::Stream as PipeStream;
    let handle = windows_identity::open_pipe(&format!(r"\\.\pipe\{}", paths.pipe_name()))?;
    if !windows_identity::owned_by_current_user(&handle)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the Lens pipe belongs to another account; refusing it",
        ));
    }
    Ok(Stream::from(
        PipeStream::try_from(handle).map_err(|e| io::Error::other(format!("{e:?}")))?,
    ))
}

#[cfg(windows)]
mod windows_identity {
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
    };
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_KERNEL_OBJECT};
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        TOKEN_INFORMATION_CLASS, TOKEN_OWNER, TOKEN_QUERY, TOKEN_USER, TokenOwner, TokenUser,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_OVERLAPPED, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// The same open interprocess performs, plus identification-level quality of service.
    pub fn open_pipe(path: &str) -> io::Result<OwnedHandle> {
        let path = widestring::U16CString::from_str(path).map_err(io::Error::other)?;
        // SAFETY: a null-terminated path and no security attributes or template.
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: CreateFileW just returned this handle and nothing else owns it.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }

    /// True when the pipe's owner is this token's user or its default owner. An elevated
    /// administrator's objects are owned by the Administrators group, not the user, so both count;
    /// another non-admin account's pipe matches neither.
    pub fn owned_by_current_user(pipe: &OwnedHandle) -> io::Result<bool> {
        let user = token_information(TokenUser)?;
        let default_owner = token_information(TokenOwner)?;
        // SAFETY: GetSecurityInfo fills `owner` inside `descriptor`, which LocalFree releases after
        // the comparisons; both token buffers outlive their SID pointers.
        unsafe {
            let mut owner: PSID = std::ptr::null_mut();
            let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            let status = GetSecurityInfo(
                pipe.as_raw_handle(),
                SE_KERNEL_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            );
            if status != 0 {
                return Err(io::Error::from_raw_os_error(status as i32));
            }
            let user_sid = (*(user.as_ptr() as *const TOKEN_USER)).User.Sid;
            let owner_sid = (*(default_owner.as_ptr() as *const TOKEN_OWNER)).Owner;
            let same = EqualSid(owner, user_sid) != 0 || EqualSid(owner, owner_sid) != 0;
            LocalFree(descriptor);
            Ok(same)
        }
    }

    /// One TOKEN_INFORMATION_CLASS of this process's token, in a u64 buffer so casts are aligned.
    fn token_information(class: TOKEN_INFORMATION_CLASS) -> io::Result<Vec<u64>> {
        // SAFETY: the token handle is opened and closed here; sizes come from the first call.
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut size = 0u32;
            GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut size);
            let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
            let ok = GetTokenInformation(token, class, buffer.as_mut_ptr().cast(), size, &mut size);
            CloseHandle(token);
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(buffer)
        }
    }
}
