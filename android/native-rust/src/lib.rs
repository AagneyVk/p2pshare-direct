use jni::objects::{JByteArray, JClass};
use jni::sys::{jbyteArray, jint, jlong};
use jni::JNIEnv;
use libc::{close, dup, fstat, pread, stat, S_IFMT, S_IFREG};
use std::collections::HashMap;
use std::os::fd::RawFd;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const MAX_REGION_BYTES: usize = 32 * 1024 * 1024;
const PROBE_READABLE: jlong = 1;
const PROBE_SEEKABLE: jlong = 1 << 1;
const PROBE_REGULAR: jlong = 1 << 2;
const PROBE_SIZE_KNOWN: jlong = 1 << 3;

struct Source {
    fd: RawFd,
    size: i64,
    regular: bool,
}

struct TransferCore {
    next_source: AtomicU64,
    sources: Mutex<HashMap<u64, Source>>,
}

impl TransferCore {
    fn new() -> Self {
        Self { next_source: AtomicU64::new(1), sources: Mutex::new(HashMap::new()) }
    }
}

impl Drop for TransferCore {
    fn drop(&mut self) {
        if let Ok(mut sources) = self.sources.lock() {
            for (_, source) in sources.drain() {
                unsafe { close(source.fd); }
            }
        }
    }
}

fn core<'a>(handle: jlong) -> Option<&'a TransferCore> {
    if handle == 0 { None } else { Some(unsafe { &*(handle as *const TransferCore) }) }
}

fn stat_fd(fd: RawFd) -> Option<stat> {
    let mut value: stat = unsafe { std::mem::zeroed() };
    if unsafe { fstat(fd, &mut value) } == 0 { Some(value) } else { None }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_p2pshare_android_NativeTransferCore_nativeCreate(
    _env: JNIEnv, _class: JClass,
) -> jlong {
    Box::into_raw(Box::new(TransferCore::new())) as jlong
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_p2pshare_android_NativeTransferCore_nativeDestroy(
    _env: JNIEnv, _class: JClass, handle: jlong,
) {
    if handle != 0 { unsafe { drop(Box::from_raw(handle as *mut TransferCore)); } }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_p2pshare_android_NativeTransferCore_nativeAttachReadableFd(
    _env: JNIEnv, _class: JClass, handle: jlong, fd: jint,
) -> jlong {
    let Some(core) = core(handle) else { unsafe { close(fd); } return 0; };
    // Kotlin transfers ownership of this descriptor. Keep it open for the session and
    // close it on release/destroy. fstat avoids moving the shared file offset.
    let Some(meta) = stat_fd(fd) else { unsafe { close(fd); } return 0; };
    let id = core.next_source.fetch_add(1, Ordering::Relaxed);
    if id == 0 { unsafe { close(fd); } return 0; }
    let regular = (meta.st_mode & S_IFMT) == S_IFREG;
    let size = if regular { meta.st_size.max(0) } else { -1 };
    match core.sources.lock() {
        Ok(mut sources) => { sources.insert(id, Source { fd, size, regular }); id as jlong }
        Err(_) => { unsafe { close(fd); } 0 }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_p2pshare_android_NativeTransferCore_nativeReleaseSource(
    _env: JNIEnv, _class: JClass, handle: jlong, source_id: jlong,
) {
    let Some(core) = core(handle) else { return; };
    if let Ok(mut sources) = core.sources.lock() {
        if let Some(source) = sources.remove(&(source_id as u64)) { unsafe { close(source.fd); } }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_p2pshare_android_NativeTransferCore_nativeProbeSource(
    _env: JNIEnv, _class: JClass, handle: jlong, source_id: jlong, sample_bytes: jint,
) -> jlong {
    let Some(core) = core(handle) else { return 0; };
    let Ok(sources) = core.sources.lock() else { return 0; };
    let Some(source) = sources.get(&(source_id as u64)) else { return 0; };
    let mut flags = PROBE_READABLE;
    if source.regular { flags |= PROBE_SEEKABLE | PROBE_REGULAR | PROBE_SIZE_KNOWN; }
    // For provider-backed descriptors, test positional readability without disturbing
    // the descriptor offset. Zero-byte files remain valid readable sources.
    if source.size != 0 && sample_bytes > 0 {
        let mut byte = 0u8;
        if unsafe { pread(source.fd, &mut byte as *mut u8 as *mut _, 1, 0) } < 0 { flags &= !PROBE_READABLE; }
    }
    flags
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_p2pshare_android_NativeTransferCore_nativeSourceSize(
    _env: JNIEnv, _class: JClass, handle: jlong, source_id: jlong,
) -> jlong {
    let Some(core) = core(handle) else { return -1; };
    let Ok(sources) = core.sources.lock() else { return -1; };
    sources.get(&(source_id as u64)).map(|s| s.size as jlong).unwrap_or(-1)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_p2pshare_android_NativeTransferCore_nativeReadRegion(
    env: JNIEnv, _class: JClass, handle: jlong, source_id: jlong, offset: jlong, bytes: jint,
) -> jbyteArray {
    if offset < 0 || bytes <= 0 || bytes as usize > MAX_REGION_BYTES { return std::ptr::null_mut(); }
    let Some(core) = core(handle) else { return std::ptr::null_mut(); };
    let Ok(sources) = core.sources.lock() else { return std::ptr::null_mut(); };
    let Some(source) = sources.get(&(source_id as u64)) else { return std::ptr::null_mut(); };
    let mut output = vec![0u8; bytes as usize];
    let mut done = 0usize;
    while done < output.len() {
        let count = unsafe {
            pread(source.fd, output[done..].as_mut_ptr() as *mut _, output.len() - done, offset as i64 + done as i64)
        };
        if count < 0 { return std::ptr::null_mut(); }
        if count == 0 { break; }
        done += count as usize;
    }
    output.truncate(done);
    match env.byte_array_from_slice(&output) {
        Ok(array) => array.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

// Kept deliberately tiny: Android's ParcelFileDescriptor already gives us an owned
// duplicate. This helper exists for future native socket/session attachment paths.
#[allow(dead_code)]
fn duplicate_fd(fd: RawFd) -> Option<RawFd> {
    let copy = unsafe { dup(fd) };
    if copy < 0 { None } else { Some(copy) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use std::os::fd::AsRawFd;

    #[test]
    fn positional_reads_do_not_move_file_offset() {
        let path = std::env::temp_dir().join(format!("p2pshare-core-{}", std::process::id()));
        let mut file = File::create(&path).unwrap();
        file.write_all(b"0123456789").unwrap();
        drop(file);
        let file = File::open(&path).unwrap();
        let fd = file.as_raw_fd();
        let mut out = [0u8; 3];
        assert_eq!(unsafe { pread(fd, out.as_mut_ptr() as *mut _, 3, 4) }, 3);
        assert_eq!(&out, b"456");
        let _ = std::fs::remove_file(path);
    }
}
