//! Mutual TLS: both peers explicitly trust certificates provided by pairing.
//! Never accept arbitrary certificates or enable 0-RTT for file operations.
use anyhow::Result;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use std::sync::Arc;

pub fn configurations(
    certificate: CertificateDer<'static>,
    key: PrivateKeyDer<'static>,
    trusted_peer: CertificateDer<'static>,
) -> Result<(quinn::ServerConfig, quinn::ClientConfig)> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = rustls::RootCertStore::empty();
    roots.add(trusted_peer)?;
    let verifier = rustls::server::WebPkiClientVerifier::builder_with_provider(
        Arc::new(roots.clone()),
        provider.clone(),
    )
    .build()?;
    let mut server = rustls::ServerConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_client_cert_verifier(verifier)
        .with_single_cert(vec![certificate.clone()], key.clone_key())?;
    server.alpn_protocols = vec![b"p2pshare/3-alpha2".to_vec()];
    let mut client = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_root_certificates(roots)
        .with_client_auth_cert(vec![certificate], key)?;
    client.alpn_protocols = server.alpn_protocols.clone();
    let mut server = quinn::ServerConfig::with_crypto(Arc::new(
        quinn::crypto::rustls::QuicServerConfig::try_from(server)?,
    ));
    let mut client = quinn::ClientConfig::new(Arc::new(
        quinn::crypto::rustls::QuicClientConfig::try_from(client)?,
    ));
    let transport = transport_config()?;
    server.transport_config(transport.clone());
    client.transport_config(transport);
    Ok((server, client))
}

pub(crate) fn transport_config() -> Result<Arc<quinn::TransportConfig>> {
    let mut transport = quinn::TransportConfig::default();
    transport.max_concurrent_bidi_streams(1u32.into());
    transport.max_concurrent_uni_streams(0u32.into());
    transport.receive_window((32u32 * 1024 * 1024).into());
    // Larger alpha windows reproducibly tripped Quinn's bounded gap-buffer
    // defense in the 64 MiB loopback benchmark. Keep a conservative cap until
    // receive draining and sustained loss/reorder profiles are characterized.
    transport.stream_receive_window((512u32 * 1024).into());
    transport.send_window(512 * 1024);
    transport.max_idle_timeout(Some(std::time::Duration::from_secs(30).try_into()?));
    transport.keep_alive_interval(Some(std::time::Duration::from_secs(10)));
    Ok(Arc::new(transport))
}
