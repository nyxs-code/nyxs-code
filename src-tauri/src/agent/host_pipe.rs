//! The named pipe the hidden PowerShell host gets its commands through (see ps_host.rs).
//!
//! It replaced a localhost TCP socket, which looked like a reverse shell to antivirus software
//! and could be reached by any process on the machine. The pipe is local only
//! (`PIPE_REJECT_REMOTE_CLIENTS`), its DACL lets in only the user running Nyxs, its name is
//! new for every host (and `FILE_FLAG_FIRST_PIPE_INSTANCE` stops another process from creating
//! it first), and the end that connects must be the host's own process, which also proves it
//! with the token it was given.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_NO_DATA, ERROR_PIPE_CONNECTED,
    ERROR_PIPE_LISTENING, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
    TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeClientProcessId,
    SetNamedPipeHandleState, PIPE_NOWAIT, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// How long the connected end has to send its token.
const TOKEN_WAIT: Duration = Duration::from_secs(5);
/// The pipe's buffers each way, like a socket's.
const BUFFER: u32 = 64 * 1024;

/// The security descriptor that lets only the user `sid` open the pipe: a protected DACL with
/// one entry, so nothing is inherited and no one else (other users, services) gets in.
pub(crate) fn user_only_sddl(sid: &str) -> String {
    format!("D:P(A;;GA;;;{sid})")
}

/// The SID of the user this process runs as, in its string form (`S-1-5-21-…`).
fn current_user_sid() -> Result<String, String> {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let mut size = 0u32;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
        // u64s keep the buffer aligned for TOKEN_USER.
        let mut buf = vec![0u64; (size as usize).div_ceil(8).max(1)];
        let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), size, &mut size);
        CloseHandle(token);
        if ok == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut text: *mut u16 = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let len = (0..).take_while(|&i| *text.add(i) != 0).count();
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
        LocalFree(text.cast());
        Ok(sid)
    }
}

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// The server end of a host's pipe, waiting for the host to connect.
pub(crate) struct PipeServer {
    handle: OwnedHandle,
    /// The name the host opens it by (without `\\.\pipe\`).
    pub(crate) name: String,
}

/// Creates the pipe `\\.\pipe\<name>`, open to the current user only.
pub(crate) fn create(name: &str) -> Result<PipeServer, String> {
    let sddl = wide(&user_only_sddl(&current_user_sid()?));
    let path = wide(&format!(r"\\.\pipe\{name}"));
    unsafe {
        let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut sd,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let attrs = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd,
            bInheritHandle: 0,
        };
        // Not waiting at first, so the connect can be polled while watching the host start.
        let handle = CreateNamedPipeW(
            path.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            BUFFER,
            BUFFER,
            0,
            &attrs,
        );
        let err = std::io::Error::last_os_error();
        LocalFree(sd);
        if handle == INVALID_HANDLE_VALUE {
            return Err(err.to_string());
        }
        Ok(PipeServer {
            handle: OwnedHandle::from_raw_handle(handle),
            name: name.to_string(),
        })
    }
}

impl PipeServer {
    /// Waits until the process `pid` connects and sends `token`, and gives the connection.
    /// Another process that connects first is turned away and the wait goes on; `alive` says
    /// whether the host is still running (no point waiting for one that exited).
    pub(crate) fn accept(
        self,
        pid: u32,
        token: &str,
        deadline: Instant,
        alive: impl Fn() -> bool,
    ) -> Result<File, String> {
        let h = self.handle.as_raw_handle() as HANDLE;
        loop {
            let state = unsafe {
                if ConnectNamedPipe(h, std::ptr::null_mut()) != 0 {
                    ERROR_PIPE_CONNECTED
                } else {
                    GetLastError()
                }
            };
            match state {
                ERROR_PIPE_CONNECTED => {
                    let mut client = 0u32;
                    let ok = unsafe { GetNamedPipeClientProcessId(h, &mut client) } != 0;
                    if ok && client == pid {
                        break;
                    }
                    log::warn!("host pipe: refused a connection from process {client}");
                    unsafe { DisconnectNamedPipe(h) };
                }
                ERROR_PIPE_LISTENING => {}
                // Someone connected and left already.
                ERROR_NO_DATA => unsafe {
                    DisconnectNamedPipe(h);
                },
                _ => {
                    return Err(format!(
                        "host: {}",
                        std::io::Error::from_raw_os_error(state as i32)
                    ))
                }
            }
            if Instant::now() >= deadline {
                return Err("host: PowerShell didn't connect in time".into());
            }
            if !alive() {
                return Err("host: PowerShell exited before connecting".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        // From here reads and writes block, as on a socket.
        let mode = PIPE_READMODE_BYTE | PIPE_WAIT;
        if unsafe { SetNamedPipeHandleState(h, &mode, std::ptr::null(), std::ptr::null()) } == 0 {
            return Err(format!("host: {}", std::io::Error::last_os_error()));
        }
        let file = File::from(self.handle);
        let reader = file.try_clone().map_err(|e| format!("host: {e}"))?;
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let ok = BufReader::new(reader).read_line(&mut line).is_ok();
            let _ = tx.send(ok.then_some(line));
        });
        match rx.recv_timeout(TOKEN_WAIT) {
            Ok(Some(line)) if line.trim_end() == token => Ok(file),
            other => {
                // Unblocks the reader if it is still waiting.
                close(&file);
                Err(if other.is_err() {
                    "host: PowerShell didn't identify itself in time".into()
                } else {
                    "host: the process that connected didn't identify itself".into()
                })
            }
        }
    }
}

/// Ends the connection for both sides, even while a copy of the handle is still open: the
/// host reads the end of its input and exits.
pub(crate) fn close(file: &File) {
    unsafe { DisconnectNamedPipe(file.as_raw_handle() as HANDLE) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn unique(tag: &str) -> String {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        format!("nyxs-test-{tag}-{}-{n}-{nanos}", std::process::id())
    }

    fn open_client(name: &str) -> File {
        let path = format!(r"\\.\pipe\{name}");
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
            {
                Ok(f) => return f,
                Err(e) if Instant::now() < deadline => {
                    let _ = e;
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => panic!("couldn't open {path}: {e}"),
            }
        }
    }

    #[test]
    fn lets_in_only_the_current_user() {
        let sid = current_user_sid().unwrap();
        assert!(sid.starts_with("S-1-"), "{sid}");
        assert_eq!(user_only_sddl(&sid), format!("D:P(A;;GA;;;{sid})"));
    }

    #[test]
    fn carries_the_host_protocol_both_ways() {
        let server = create(&unique("ok")).unwrap();
        let name = server.name.clone();
        let client = std::thread::spawn(move || {
            let mut c = open_client(&name);
            c.write_all(b"secret\n").unwrap();
            let mut got = [0u8; 5];
            c.read_exact(&mut got).unwrap();
            c.write_all(b"pong").unwrap();
            got
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut conn = server
            .accept(std::process::id(), "secret", deadline, || true)
            .unwrap();
        conn.write_all(b"hello").unwrap();
        let mut back = [0u8; 4];
        conn.read_exact(&mut back).unwrap();
        assert_eq!(&back, b"pong");
        assert_eq!(&client.join().unwrap(), b"hello");
    }

    #[test]
    fn turns_away_a_process_other_than_the_host() {
        let server = create(&unique("other")).unwrap();
        let name = server.name.clone();
        let intruder = std::thread::spawn(move || {
            let mut c = open_client(&name);
            let _ = c.write_all(b"secret\n");
            // Turned away: the pipe is closed on it.
            let mut buf = [0u8; 1];
            c.read(&mut buf).map(|n| n == 0).unwrap_or(true)
        });
        // The host is some other process: this one connecting doesn't count.
        let deadline = Instant::now() + Duration::from_millis(800);
        let err = server
            .accept(u32::MAX, "secret", deadline, || true)
            .unwrap_err();
        assert!(err.contains("didn't connect in time"), "{err}");
        assert!(intruder.join().unwrap(), "the intruder could still read");
    }

    #[test]
    fn refuses_a_wrong_token_and_a_name_taken_already() {
        let name = unique("token");
        let server = create(&name).unwrap();
        // A second pipe of the same name can't be made while the first exists.
        assert!(create(&name).is_err());
        let client_name = name.clone();
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let client = std::thread::spawn(move || {
            let mut c = open_client(&client_name);
            let _ = c.write_all(b"guess\n");
            // Stays connected, as a host does, until the server has decided.
            let _ = done_rx.recv_timeout(Duration::from_secs(10));
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        let err = server
            .accept(std::process::id(), "secret", deadline, || true)
            .unwrap_err();
        let _ = done_tx.send(());
        assert!(err.contains("didn't identify"), "{err}");
        client.join().unwrap();
    }

    #[test]
    fn stops_waiting_for_a_host_that_exited() {
        let server = create(&unique("gone")).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let err = server.accept(1, "x", deadline, || false).unwrap_err();
        assert!(err.contains("exited"), "{err}");
    }
}
