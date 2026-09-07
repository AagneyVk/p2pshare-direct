use std::{io, path::Path};

// Android forbids hard links for ordinary apps. Use the kernel's atomic
// no-replace rename on Android and Linux; never fall back to overwriting rename.
#[cfg(any(target_os = "android", target_os = "linux"))]
pub fn publish(source: &Path, destination: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let source = CString::new(source.as_os_str().as_bytes())?;
    let destination = CString::new(destination.as_os_str().as_bytes())?;
    // SAFETY: valid, NUL-terminated paths live through this synchronous syscall.
    // Raw syscall avoids depending on the API-30 Bionic renameat2 symbol.
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

#[cfg(not(any(target_os = "android", target_os = "linux")))]
pub fn publish(source: &Path, destination: &Path) -> io::Result<()> {
    std::fs::hard_link(source, destination)?;
    std::fs::remove_file(source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publication_never_replaces_existing_content() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("partial");
        let destination = directory.path().join("complete");
        std::fs::write(&source, b"new verified content").unwrap();
        std::fs::write(&destination, b"previous content").unwrap();
        assert!(publish(&source, &destination).is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"previous content");
        assert_eq!(std::fs::read(&source).unwrap(), b"new verified content");
        let vacant = directory.path().join("vacant");
        publish(&source, &vacant).unwrap();
        assert_eq!(std::fs::read(vacant).unwrap(), b"new verified content");
        assert!(!source.exists());
    }
}
