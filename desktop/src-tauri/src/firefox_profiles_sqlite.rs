//! Read Firefox's selectable-profile names from its profile-group databases.
use std::{
    ffi::{CStr, CString},
    os::raw::{c_char, c_int, c_void},
    path::Path,
    ptr,
};

#[cfg_attr(windows, link(name = "winsqlite3"))]
#[cfg_attr(target_os = "linux", link(name = "sqlite3"))]
extern "C" {
    fn sqlite3_open_v2(
        filename: *const c_char,
        db: *mut *mut c_void,
        flags: c_int,
        vfs: *const c_char,
    ) -> c_int;
    fn sqlite3_prepare_v2(
        db: *mut c_void,
        sql: *const c_char,
        len: c_int,
        statement: *mut *mut c_void,
        tail: *mut *const c_char,
    ) -> c_int;
    fn sqlite3_step(statement: *mut c_void) -> c_int;
    fn sqlite3_column_text(statement: *mut c_void, column: c_int) -> *const u8;
    fn sqlite3_finalize(statement: *mut c_void) -> c_int;
    fn sqlite3_close_v2(db: *mut c_void) -> c_int;
}

// SQLite uses a UTF-8 URI. Escaping also handles spaces, non-ASCII, # and ?.
fn immutable_uri(path: &Path) -> Option<CString> {
    let path = path.to_str()?.replace('\\', "/");
    let mut uri = String::from("file:");
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~/:".contains(&byte) {
            uri.push(byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri.push_str("?immutable=1");
    CString::new(uri).ok()
}

fn read(path: &Path, immutable: bool) -> Option<Vec<(String, String)>> {
    let filename = if immutable {
        immutable_uri(path)?
    } else {
        CString::new(path.to_str()?).ok()?
    };
    let sql = CString::new("SELECT path, name FROM Profiles LIMIT 1000").unwrap();
    let mut db = ptr::null_mut();
    let mut statement = ptr::null_mut();
    // The regular read includes Firefox's WAL. If the platform cannot open its
    // shared-memory file, the immutable fallback reads the last checkpoint.
    unsafe {
        let flags = 0x1 | if immutable { 0x40 } else { 0 }; // READONLY | URI
        if sqlite3_open_v2(filename.as_ptr(), &mut db, flags, ptr::null()) != 0 {
            if !db.is_null() {
                sqlite3_close_v2(db);
            }
            return None;
        }
        let mut result = None;
        if sqlite3_prepare_v2(db, sql.as_ptr(), -1, &mut statement, ptr::null_mut()) == 0 {
            let mut rows = Vec::new();
            loop {
                match sqlite3_step(statement) {
                    100 => {
                        let path = sqlite3_column_text(statement, 0);
                        let name = sqlite3_column_text(statement, 1);
                        if !path.is_null() && !name.is_null() {
                            if let (Ok(path), Ok(name)) = (
                                CStr::from_ptr(path.cast()).to_str(),
                                CStr::from_ptr(name.cast()).to_str(),
                            ) {
                                rows.push((path.to_owned(), name.to_owned()));
                            }
                        }
                    }
                    101 => {
                        result = Some(rows);
                        break;
                    }
                    _ => break,
                }
            }
        }
        if !statement.is_null() {
            sqlite3_finalize(statement);
        }
        sqlite3_close_v2(db);
        result
    }
}

pub(super) fn names(path: &Path) -> Vec<(String, String)> {
    read(path, false)
        .or_else(|| read(path, true))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    extern "C" {
        fn sqlite3_exec(
            db: *mut c_void,
            sql: *const c_char,
            callback: *const c_void,
            arg: *mut c_void,
            error: *mut *mut c_char,
        ) -> c_int;
    }
    #[test]
    fn reads_profile_names_from_live_wal_and_closed_database() {
        let directory =
            std::env::temp_dir().join(format!("warp-profile-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::create_dir_all(directory.join("Profile Groups")).unwrap();
        std::fs::create_dir_all(directory.join("Profiles/abc")).unwrap();
        let path = directory.join("Profile Groups/profile #1.sqlite");
        let filename = CString::new(path.to_str().unwrap()).unwrap();
        let sql = CString::new("PRAGMA journal_mode=WAL; CREATE TABLE Profiles(path TEXT, name TEXT); INSERT INTO Profiles VALUES ('Profiles/abc', 'Work');").unwrap();
        let mut db = ptr::null_mut();
        unsafe {
            assert_eq!(
                sqlite3_open_v2(filename.as_ptr(), &mut db, 0x2 | 0x4, ptr::null()),
                0
            );
            assert_eq!(
                sqlite3_exec(
                    db,
                    sql.as_ptr(),
                    ptr::null(),
                    ptr::null_mut(),
                    ptr::null_mut()
                ),
                0
            );
            assert_eq!(names(&path), vec![("Profiles/abc".into(), "Work".into())]);
            let mut profiles = vec![super::super::Profile {
                path: directory.join("Profiles/abc"),
                name: "default-release".into(),
            }];
            super::super::add_selectable_profiles(&directory, &mut profiles);
            assert_eq!(profiles.len(), 1);
            assert_eq!(profiles[0].name, "Work");
            assert_eq!(profiles[0].path, directory.join("Profiles/abc"));
            sqlite3_close_v2(db);
        }
        assert_eq!(names(&path), vec![("Profiles/abc".into(), "Work".into())]);
        assert!(names(&directory.join("missing.sqlite")).is_empty());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
