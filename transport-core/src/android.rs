use std::os::fd::FromRawFd;

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
