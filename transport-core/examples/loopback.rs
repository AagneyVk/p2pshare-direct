//! Reproducible smoke benchmark, NOT a LAN/WAN or Android performance result.
use anyhow::{Result, ensure};
use p2pshare_transport::{BLOCK_SIZE, receive_file, send_file, tls};
use rustls::pki_types::PrivatePkcs8KeyDer;
use std::io::Write;
use std::time::{Duration, Instant};

#[tokio::main]
async fn main() -> Result<()> {
    let mib: usize = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "64".into())
        .parse()?;
    ensure!((1..=4096).contains(&mib), "size must be 1..4096 MiB");
    let directory = tempfile::tempdir()?;
    let source = directory.path().join("source");
    let destination = directory.path().join("received");
    std::fs::create_dir(&destination)?;
    let mut file = std::fs::File::create(&source)?;
    let mut state = 0x123456789abcdef0u64;
    let mut buffer = vec![0; BLOCK_SIZE];
    for _ in 0..mib {
        for bytes in buffer.as_chunks_mut::<8>().0 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            bytes.copy_from_slice(&state.to_le_bytes());
        }
        file.write_all(&buffer)?;
    }
    file.sync_all()?;
    drop(file);
    let a = rcgen::generate_simple_self_signed(vec!["localhost".into()])?;
    let b = rcgen::generate_simple_self_signed(vec!["localhost".into()])?;
    let (server_config, _) = tls::configurations(
        a.cert.der().clone(),
        PrivatePkcs8KeyDer::from(a.signing_key.serialize_der()).into(),
        b.cert.der().clone(),
    )?;
    let (_, client_config) = tls::configurations(
        b.cert.der().clone(),
        PrivatePkcs8KeyDer::from(b.signing_key.serialize_der()).into(),
        a.cert.der().clone(),
    )?;
    let server = quinn::Endpoint::server(server_config, "127.0.0.1:0".parse()?)?;
    let mut client = quinn::Endpoint::client("127.0.0.1:0".parse()?)?;
    client.set_default_client_config(client_config);
    let started = Instant::now();
    let (outgoing, incoming) =
        tokio::join!(client.connect(server.local_addr()?, "localhost")?, async {
            server.accept().await.unwrap().await
        });
    let outgoing = outgoing?;
    let incoming = incoming?;
    let connect_seconds = started.elapsed().as_secs_f64();
    let (sent, received) = tokio::time::timeout(Duration::from_secs(300), async {
        tokio::join!(
            send_file(&outgoing, &source),
            receive_file(&incoming, &destination, (mib * BLOCK_SIZE) as u64)
        )
    })
    .await?;
    let sent = sent?;
    received?;
    let total_seconds = started.elapsed().as_secs_f64();
    println!(
        "{}",
        serde_json::json!({
            "schema": 1, "topology": "loopback", "build": if cfg!(debug_assertions) { "debug" } else { "release" },
            "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
            "corpus": "xorshift64-seed-123456789abcdef0-no-compression", "transfer": sent,
            "connect_seconds": connect_seconds, "total_seconds_including_hash_and_sync": total_seconds,
            "effective_mib_per_second": mib as f64 / total_seconds,
            "integrity_verified": true,
            "caveats": ["warm page cache", "not independent devices", "not wire throughput", "no RSS CPU energy or p10 sampling"]
        })
    );
    outgoing.close(0u32.into(), b"done");
    incoming.close(0u32.into(), b"done");
    Ok(())
}
