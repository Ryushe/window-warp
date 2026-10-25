//! Read the OS owner of Firefox's existing profile lock; never acquire or release it.
use std::path::Path;

#[cfg(target_os = "linux")]
pub fn owned_by(profile: &Path, pid: u32) -> bool {
    use std::os::fd::AsRawFd;
    let Ok(file) = std::fs::File::open(profile.join(".parentlock")) else {
        return false;
    };
    let mut lock: libc::flock = unsafe { std::mem::zeroed() };
    lock.l_type = libc::F_WRLCK as libc::c_short;
    lock.l_whence = libc::SEEK_SET as libc::c_short;
    // F_GETLK only queries a conflicting lock. No create/truncate/F_SETLK.
    (unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETLK, &mut lock) }) == 0
        && lock.l_type == libc::F_WRLCK as libc::c_short
        && lock.l_pid > 0
        && lock.l_pid as u32 == pid
}

#[cfg(windows)]
pub fn owned_by(profile: &Path, pid: u32) -> bool {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_MORE_DATA, ERROR_SUCCESS, FILETIME, WAIT_TIMEOUT},
        System::{
            RestartManager::{
                RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY,
                RM_PROCESS_INFO,
            },
            Threading::{
                GetProcessTimes, OpenProcess, WaitForSingleObject,
                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            },
        },
    };
    let lock_file = profile.join("parent.lock");
    if !lock_file.is_file() {
        return false;
    }
    struct Session(u32);
    impl Drop for Session {
        fn drop(&mut self) {
            unsafe { RmEndSession(self.0) };
        }
    }
    let mut session = 0;
    let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
    unsafe {
        if RmStartSession(&mut session, 0, key.as_mut_ptr()) != ERROR_SUCCESS {
            return false;
        }
        let session = Session(session);
        let path: Vec<u16> = lock_file.as_os_str().encode_wide().chain(Some(0)).collect();
        if RmRegisterResources(session.0, 1, &path.as_ptr(), 0, ptr::null(), 0, ptr::null())
            != ERROR_SUCCESS
        {
            return false;
        }
        let mut owners = vec![RM_PROCESS_INFO::default(); 1];
        for _ in 0..3 {
            let mut needed = 0;
            let mut count = owners.len() as u32;
            let mut reasons = 0;
            let result = RmGetList(
                session.0,
                &mut needed,
                &mut count,
                owners.as_mut_ptr(),
                &mut reasons,
            );
            if result == ERROR_MORE_DATA {
                if needed == 0 || needed > 64 {
                    return false;
                }
                owners.resize(needed as usize, RM_PROCESS_INFO::default());
                continue;
            }
            if result != ERROR_SUCCESS || count != 1 || owners[0].Process.dwProcessId != pid {
                return false;
            }
            let owner = &owners[0].Process;
            let process = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            );
            if process.is_null() {
                return false;
            }
            let mut created = FILETIME::default();
            let mut exited = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            let same_live_process =
                GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) != 0
                    && created.dwLowDateTime == owner.ProcessStartTime.dwLowDateTime
                    && created.dwHighDateTime == owner.ProcessStartTime.dwHighDateTime
                    && WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
            CloseHandle(process);
            return same_live_process;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    #[test]
    fn missing_and_stale_profile_locks_are_not_live_owner_evidence() {
        let root = std::env::temp_dir().join(format!("warp-lock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let filename = if cfg!(windows) {
            "parent.lock"
        } else {
            ".parentlock"
        };
        assert!(!super::owned_by(&root, std::process::id()));
        std::fs::write(root.join(filename), []).unwrap();
        assert!(!super::owned_by(&root, std::process::id()));
        assert_eq!(std::fs::read(root.join(filename)).unwrap(), b"");
        std::fs::remove_file(root.join(filename)).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
