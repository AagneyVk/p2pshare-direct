use p2pshare_transport::{BLOCK_SIZE, Manifest, manifest, receive_file, send_file, tls};
use rustls::pki_types::PrivatePkcs8KeyDer;
use std::time::Duration;

async fn peers() -> (
    quinn::Endpoint,
    quinn::Endpoint,
    quinn::Connection,
    quinn::Connection,
) {
    let a = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let b = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let (server_config, _) = tls::configurations(
        a.cert.der().clone(),
        PrivatePkcs8KeyDer::from(a.signing_key.serialize_der()).into(),
        b.cert.der().clone(),
    )
    .unwrap();
    let (_, client_config) = tls::configurations(
        b.cert.der().clone(),
        PrivatePkcs8KeyDer::from(b.signing_key.serialize_der()).into(),
        a.cert.der().clone(),
    )
    .unwrap();
    let server = quinn::Endpoint::server(server_config, "127.0.0.1:0".parse().unwrap()).unwrap();
    let mut client = quinn::Endpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
    client.set_default_client_config(client_config);
    let connect = client
        .connect(server.local_addr().unwrap(), "localhost")
        .unwrap();
    let (outgoing, incoming) =
        tokio::join!(connect, async { server.accept().await.unwrap().await });
    (server, client, outgoing.unwrap(), incoming.unwrap())
}

async fn transfer(size: usize, resume: bool) {
    let workspace = tempfile::tempdir().unwrap();
    let source = workspace.path().join("source");
    let destination = workspace.path().join("received");
    std::fs::create_dir(&destination).unwrap();
    let bytes: Vec<u8> = (0..size)
        .map(|i| (i.wrapping_mul(31) ^ (i >> 9)) as u8)
        .collect();
    std::fs::write(&source, &bytes).unwrap();
    let offer = manifest(&source).await.unwrap();
    if resume {
        let mut partial = bytes.clone();
        partial[BLOCK_SIZE] ^= 1;
        std::fs::write(destination.join(format!("{}.part", offer.digest)), partial).unwrap();
    }
    let (_server, _client, sender, receiver) = peers().await;
    let (sent, received) = tokio::join!(
        send_file(&sender, &source),
        receive_file(&receiver, &destination, size as u64)
    );
    let sent = sent.unwrap();
    let received = received.unwrap();
    assert_eq!(std::fs::read(received).unwrap(), bytes);
    assert_eq!(sent.source_bytes, size as u64);
    assert_eq!(
        sent.payload_bytes,
        if resume {
            BLOCK_SIZE as u64
        } else {
            size as u64
        }
    );
    sender.close(0u32.into(), b"done");
    receiver.close(0u32.into(), b"done");
}

#[tokio::test]
async fn quic_file_roundtrip() {
    tokio::time::timeout(
        Duration::from_secs(20),
        transfer(BLOCK_SIZE * 2 + 123, false),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn resume_rehashes_partial_and_repairs_only_corrupt_block() {
    tokio::time::timeout(
        Duration::from_secs(20),
        transfer(BLOCK_SIZE * 2 + 123, true),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn empty_file_roundtrip() {
    tokio::time::timeout(Duration::from_secs(20), transfer(0, false))
        .await
        .unwrap();
}

#[test]
fn manifest_rejects_untrusted_geometry_and_paths_disguised_as_hashes() {
    let mut offer = Manifest {
        name: String::new(),
        version: 3,
        size: 0,
        block_size: BLOCK_SIZE as u32,
        digest: blake3::hash(b"").to_hex().to_string(),
        blocks: vec![],
    };
    assert!(offer.validate().is_ok());
    offer.size = u64::MAX;
    assert!(offer.validate().is_err());
    offer.size = 0;
    offer.digest = "../outside".into();
    assert!(offer.validate().is_err());
    offer.digest = "a".repeat(64);
    offer.version = 2;
    assert!(offer.validate().is_err());
}

#[tokio::test]
async fn untrusted_client_certificate_is_rejected() {
    let server_identity = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let trusted_identity = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let attacker = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let (config, _) = tls::configurations(
        server_identity.cert.der().clone(),
        PrivatePkcs8KeyDer::from(server_identity.signing_key.serialize_der()).into(),
        trusted_identity.cert.der().clone(),
    )
    .unwrap();
    let (_, client_config) = tls::configurations(
        attacker.cert.der().clone(),
        PrivatePkcs8KeyDer::from(attacker.signing_key.serialize_der()).into(),
        server_identity.cert.der().clone(),
    )
    .unwrap();
    let server = quinn::Endpoint::server(config, "127.0.0.1:0".parse().unwrap()).unwrap();
    let mut client = quinn::Endpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
    client.set_default_client_config(client_config);
    let outcome = tokio::time::timeout(Duration::from_secs(5), async {
        let (incoming, _) = tokio::join!(
            async { server.accept().await.unwrap().await },
            client
                .connect(server.local_addr().unwrap(), "localhost")
                .unwrap()
        );
        incoming
    })
    .await
    .unwrap();
    assert!(outcome.is_err());
}

#[tokio::test]
async fn receiver_quota_rejection_does_not_create_partial_file() {
    let directory = tempfile::tempdir().unwrap();
    let (_server, _client, sender, receiver) = peers().await;
    let (mut send, _recv) = sender.open_bi().await.unwrap();
    let offer = Manifest {
        name: String::new(),
        version: 3,
        size: 1,
        block_size: BLOCK_SIZE as u32,
        digest: "a".repeat(64),
        blocks: vec!["b".repeat(64)],
    };
    let bytes = serde_json::to_vec(&offer).unwrap();
    send.write_all(&(bytes.len() as u32).to_be_bytes())
        .await
        .unwrap();
    send.write_all(&bytes).await.unwrap();
    send.finish().unwrap();
    assert!(receive_file(&receiver, directory.path(), 0).await.is_err());
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}
