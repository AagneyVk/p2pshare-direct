use jni::objects::{JByteArray, JClass};
use jni::sys::{jboolean, jbyteArray, jint, jlong};
use jni::JNIEnv;
use libc::{c_void, lseek, off_t, read, SEEK_CUR, SEEK_END, SEEK_SET};
use std::os::fd::RawFd;

#[no_mangle]
pub extern "system" fn Java_com_p2pshare_android_transfer_NativeTransferCore_nativeProbeSeekable(
    _env: JNIEnv,
    _class: JClass,
    fd: jint,
) -> jboolean {
    let current = unsafe { lseek(fd as RawFd, 0, SEEK_CUR) };
    if current < 0 { 0 } else { 1 }
}

#[no_mangle]
pub extern "system" fn Java_com_p2pshare_android_transfer_NativeTransferCore_nativeFileSize(
    _env: JNIEnv,
    _class: JClass,
    fd: jint,
) -> jlong {
    let fd = fd as RawFd;
    let current = unsafe { lseek(fd, 0, SEEK_CUR) };
    if current < 0 { return -1; }
    let end = unsafe { lseek(fd, 0, SEEK_END) };
    let _ = unsafe { lseek(fd, current, SEEK_SET) };
    end as jlong
}

#[no_mangle]
pub extern "system" fn Java_com_p2pshare_android_transfer_NativeTransferCore_nativeRead(
    env: JNIEnv,
    _class: JClass,
    fd: jint,
    max_bytes: jint,
) -> jbyteArray {
    let requested = max_bytes.clamp(1, 8 * 1024 * 1024) as usize;
    let mut buffer = vec![0u8; requested];
    let count = unsafe { read(fd as RawFd, buffer.as_mut_ptr() as *mut c_void, requested) };
    if count < 0 { return std::ptr::null_mut(); }
    buffer.truncate(count as usize);
    match env.byte_array_from_slice(&buffer) {
        Ok(array) => array.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}
