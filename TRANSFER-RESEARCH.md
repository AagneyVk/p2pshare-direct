# Transfer pipeline research milestone

## Implemented

Android regular, seekable document descriptors can now be read directly by Rust.
JNI duplicates a descriptor synchronously into a bounded four-entry registry;
commands carry single-consumption opaque handles. Cancellation releases unused
handles; an accepted transfer owns its descriptor until its work ends. This avoids
the fd-reuse race of sending raw fd integers asynchronously. Pipe/cloud providers
retain staging. The wire protocol is unchanged; Android and desktop interoperate.

Both platforms use a bounded producer/consumer send pipeline. A blocking worker
reads and validates requested blocks ahead of QUIC writes. Two queued 1 MiB blocks
overlap file IO/hash with transmission; ownership moves into Quinn `write_chunk`
instead of copying each block through `write_all`. This is not kernel zero-copy
and does not remove encryption or retransmission memory. The source is opened
once across manifest construction and sending, preventing a path replacement
between those phases from changing the source inode.

Every requested block is rehashed, final receipts remain mandatory, and receivers
still verify and sync completed files. Prehashing, the final disk hash pass,
Android export copying, the conservative 512 KiB stream window and LAN-only
pairing remain. These changes alone do not establish algorithmic novelty.

## Experiment

`P2PSHARE_SEND_MODE=serial` retains the sequential reference sender. The default
uses the pipeline. CI runs `tests/pipeline-benchmark.py`: three alternating pairs
of 256 MiB verified loopback transfers, publishing full results and median ratio
as `pipeline-benchmark`. This isolates sender scheduling/copy changes; it is not
an Android staging comparison or a physical Wi-Fi benchmark. Shared-runner timing
is noisy. No competitor claim follows from it.

Android instrumentation asserts regular files choose the no-staging path. Linux
interop closes Java-equivalent original descriptors before sending, exercising
native ownership and both pairing roles against the desktop executable.

## Research direction

The next hypothesis is reducing time-to-first-byte without losing recovery:
bounded speculative block transmission while constructing a content-addressed
manifest, with per-block proofs/verification and a final authenticated commitment.
This requires a protocol change, source-mutation semantics, receiver quarantine,
reconnect state and an explicit adversarial test matrix. It is not implemented
or claimed as new; compare against Bao/Iroh before proposing novelty.

Any proposed mechanism must beat the sequential reference and competing tools
on complete-file time across fresh copies, partial retries, edited files and
small-file batches, with memory/energy and failure rates reported alongside speed.

Primary references:
- https://developer.android.com/reference/android/os/ParcelFileDescriptor
- https://docs.rs/quinn/latest/quinn/struct.SendStream.html
- https://github.com/oconnor663/bao
- https://github.com/n0-computer/iroh-blobs
