use std::os::fd::FromRawFd;
use std::{collections::HashMap, fs::File, sync::{Mutex, OnceLock, atomic::{AtomicI64, Ordering}}};

static SOURCES: OnceLock<Mutex<HashMap<i64, File>>> = OnceLock::new();
static NEXT_SOURCE: AtomicI64 = AtomicI64::new(1);

pub(crate) fn take_source(handle: i64) -> anyhow::Result<File> {
    SOURCES.get_or_init(Default::default).lock().map_err(|_| anyhow::anyhow!("source registry unavailable"))?
        .remove(&handle).ok_or_else(|| anyhow::anyhow!("source handle expired"))
}

// Duplicate while Java still owns the descriptor; a queued command carries an
// opaque handle, never a raw fd that cancellation could close and reuse.
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_p2pshare_android_QuicTransport_nativeRegister(
    _env: *mut std::ffi::c_void, _object: *mut std::ffi::c_void, fd: i32,
) -> i64 {
    std::panic::catch_unwind(|| -> Option<i64> {
        let mut sources = SOURCES.get_or_init(Default::default).lock().ok()?;
        if sources.len() >= 4 { return None; }
        let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
        if duplicate < 0 { return None; }
        let mut file = unsafe { File::from_raw_fd(duplicate) };
        use std::io::Seek;
        if !file.metadata().ok()?.is_file() || file.stream_position().is_err() { return None; }
        let id = NEXT_SOURCE.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1)).ok()?;
        sources.insert(id, file);
        Some(id)
    }).ok().flatten().unwrap_or(-1)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_p2pshare_android_QuicTransport_nativeRelease(
    _env: *mut std::ffi::c_void, _object: *mut std::ffi::c_void, handle: i64,
) {
    let _ = take_source(handle);
}

#[cfg(test)]
mod source_tests {
    use super::*;
    use std::os::fd::AsRawFd;

    #[test]
    fn registered_source_owns_duplicate_and_is_consumed_once() {
        let file = tempfile::tempfile().unwrap();
        let handle = Java_com_p2pshare_android_QuicTransport_nativeRegister(
            std::ptr::null_mut(), std::ptr::null_mut(), file.as_raw_fd());
        assert!(handle > 0);
        drop(file);
        assert!(take_source(handle).unwrap().metadata().unwrap().is_file());
        assert!(take_source(handle).is_err());
        let (socket, _) = std::os::unix::net::UnixStream::pair().unwrap();
        assert_eq!(Java_com_p2pshare_android_QuicTransport_nativeRegister(
            std::ptr::null_mut(), std::ptr::null_mut(), socket.as_raw_fd()), -1);
    }
}

// Kotlin transfers ownership of one socketpair end via detachFd().
// Only primitives cross JNI; no Java references escape and no payload crosses JNI.
#[unsafe(no_mangle)]
pub unsafe extern "system" fn Java_com_p2pshare_android_QuicTransport_nativeRun(
    _env: *mut std::ffi::c_void,
    _object: *mut std::ffi::c_void,
    fd: i32,
) -> i32 {
    std::panic::catch_unwind(|| {
        let socket = unsafe { std::os::unix::net::UnixStream::from_raw_fd(fd) };
        socket.set_nonblocking(true)?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        runtime.block_on(async {
            let socket = tokio::net::UnixStream::from_std(socket)?;
            let (reader, writer) = socket.into_split();
            crate::engine::run(reader, writer).await
        })
    })
    .map_or(-1, |result| if result.is_ok() { 0 } else { -1 })
}
