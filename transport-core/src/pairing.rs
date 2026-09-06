//! LAN v3-alpha pairing: pinned TLS server certificate + one-use bearer secret.
//! The secret is sent only AFTER server certificate validation, inside TLS.
//! A ticket grants one guest access to the session; share through a trusted channel.
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use quinn::{Connection, Endpoint};
use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::time::timeout;

const ALPN: &[u8] = b"p2pshare/3-ticket-alpha1";
const TTL: u64 = 300;
const LIMIT: usize = 8192;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ticket {
    version: u8,
    address: SocketAddr,
    expires: u64,
    certificate: Vec<u8>,
    secret: [u8; 32],
}

fn now() -> Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}

fn decode(code: &str) -> Result<Ticket> {
    ensure!(code.len() <= LIMIT, "ticket too large");
    let encoded = code
        .strip_prefix("p2p3:")
        .ok_or_else(|| anyhow::anyhow!("unsupported ticket"))?;
    let ticket: Ticket = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded)?)?;
    ensure!(ticket.version == 1, "unsupported ticket version");
    ensure!(
        ticket.expires > now()?.saturating_sub(60) && ticket.expires <= now()? + TTL + 60,
        "ticket expired or invalid lifetime"
    );
    ensure!(
        !ticket.address.ip().is_unspecified()
            && !ticket.address.ip().is_multicast()
            && ticket.address.port() != 0,
        "invalid peer address"
    );
    ensure!(
        !ticket.certificate.is_empty() && ticket.certificate.len() <= 2048,
        "invalid certificate length"
    );
    Ok(ticket)
}

pub struct Host {
    pub endpoint: Endpoint,
    pub ticket: String,
    secret: [u8; 32],
    expires: u64,
}

impl Host {
    pub fn bind(bind: SocketAddr, advertised_ip: IpAddr) -> Result<Self> {
        ensure!(
            !advertised_ip.is_unspecified() && !advertised_ip.is_multicast(),
            "invalid advertised IP"
        );
        ensure!(
            bind.is_ipv4() == advertised_ip.is_ipv4(),
            "address family mismatch"
        );
        let identity = rcgen::generate_simple_self_signed(vec!["p2pshare.local".into()])?;
        let mut server = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_no_client_auth()
        .with_single_cert(
            vec![identity.cert.der().clone()],
            PrivatePkcs8KeyDer::from(identity.signing_key.serialize_der()).into(),
        )?;
        server.alpn_protocols = vec![ALPN.to_vec()];
        let mut config = quinn::ServerConfig::with_crypto(Arc::new(
            quinn::crypto::rustls::QuicServerConfig::try_from(server)?,
        ));
        config.transport_config(crate::tls::transport_config()?);
        let endpoint = Endpoint::server(config, bind)?;
        let mut secret = [0; 32];
        getrandom::getrandom(&mut secret)
            .map_err(|_| anyhow::anyhow!("random source unavailable"))?;
        let expires = now()? + TTL;
        let data = Ticket {
            version: 1,
            address: SocketAddr::new(advertised_ip, endpoint.local_addr()?.port()),
            certificate: identity.cert.der().to_vec(),
            secret,
            expires,
        };
        let ticket = format!(
            "p2p3:{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&data)?)
        );
        ensure!(ticket.len() <= LIMIT, "generated ticket too large");
        Ok(Self {
            endpoint,
            ticket,
            secret,
            expires,
        })
    }

    /// Consuming self prevents a second successful use. Authentication is bounded
    /// and sequential; an untrusted client cannot reach a file parser.
    pub async fn accept(self) -> Result<(Endpoint, Connection)> {
        let deadline =
            tokio::time::Instant::now() + Duration::from_secs(self.expires.saturating_sub(now()?));
        loop {
            let incoming = tokio::time::timeout_at(deadline, self.endpoint.accept())
                .await?
                .ok_or_else(|| anyhow::anyhow!("endpoint closed"))?;
            if !incoming.remote_address_validated() {
                incoming.retry().ok();
                continue;
            }
            let attempt = async {
                let connection = incoming.await?;
                let auth = timeout(Duration::from_secs(5), async {
                    let (mut send, mut recv) = connection.accept_bi().await?;
                    let bytes = recv.read_to_end(32).await?;
                    ensure!(
                        bytes.len() == 32 && bool::from(bytes.as_slice().ct_eq(&self.secret)),
                        "pairing rejected"
                    );
                    ensure!(now()? < self.expires, "ticket expired");
                    send.write_all(b"OK").await?;
                    send.finish()?;
                    Ok::<_, anyhow::Error>(())
                })
                .await;
                if !matches!(auth, Ok(Ok(()))) {
                    connection.close(1u32.into(), b"pairing rejected");
                    anyhow::bail!("pairing rejected");
                }
                Ok(connection)
            };
            if let Ok(Ok(connection)) = tokio::time::timeout_at(
                deadline.min(tokio::time::Instant::now() + Duration::from_secs(8)),
                attempt,
            )
            .await
            {
                self.endpoint.set_server_config(None);
                return Ok((self.endpoint, connection));
            }
        }
    }
}

pub async fn join(code: &str) -> Result<(Endpoint, Connection)> {
    let ticket = decode(code)?;
    let mut roots = rustls::RootCertStore::empty();
    roots.add(CertificateDer::from(ticket.certificate))?;
    let mut tls = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_protocol_versions(&[&rustls::version::TLS13])?
    .with_root_certificates(roots)
    .with_no_client_auth();
    tls.alpn_protocols = vec![ALPN.to_vec()];
    let mut client = quinn::ClientConfig::new(Arc::new(
        quinn::crypto::rustls::QuicClientConfig::try_from(tls)?,
    ));
    client.transport_config(crate::tls::transport_config()?);
    let bind = if ticket.address.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    };
    let mut endpoint = Endpoint::client(bind.parse()?)?;
    endpoint.set_default_client_config(client);
    let connection = timeout(Duration::from_secs(15), async {
        let connection = endpoint.connect(ticket.address, "p2pshare.local")?.await?;
        let (mut send, mut recv) = connection.open_bi().await?;
        send.write_all(&ticket.secret).await?;
        send.finish()?;
        ensure!(recv.read_to_end(2).await? == b"OK", "pairing rejected");
        Ok::<_, anyhow::Error>(connection)
    })
    .await??;
    Ok((endpoint, connection))
}

#[cfg(test)]
mod tests {
    use super::*;
    // Test-only UDP impairment proxy, not a product relay. A bounded task set
    // applies delay and deterministic packet drops in both directions.
    #[tokio::test]
    async fn transfer_survives_twenty_ms_rtt_and_one_percent_packet_loss() {
        let scenario = async {
            let host =
                Host::bind("127.0.0.1:0".parse().unwrap(), "127.0.0.1".parse().unwrap()).unwrap();
            let target = host.endpoint.local_addr().unwrap();
            let socket = Arc::new(tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap());
            let mut ticket = decode(&host.ticket).unwrap();
            ticket.address = socket.local_addr().unwrap();
            let code = format!(
                "p2p3:{}",
                URL_SAFE_NO_PAD.encode(serde_json::to_vec(&ticket).unwrap())
            );
            let proxy = tokio::spawn(async move {
                let mut peer = None;
                let mut counter = 0u64;
                let mut bytes = vec![0; 65536];
                let mut forwards = tokio::task::JoinSet::new();
                loop {
                    let (length, source) = socket.recv_from(&mut bytes).await.unwrap();
                    let destination = if source == target {
                        if let Some(peer) = peer {
                            peer
                        } else {
                            continue;
                        }
                    } else {
                        peer = Some(source);
                        target
                    };
                    counter += 1;
                    while forwards.try_join_next().is_some() {}
                    if counter.is_multiple_of(100) || forwards.len() >= 256 {
                        continue;
                    }
                    let payload = bytes[..length].to_vec();
                    let socket = socket.clone();
                    forwards.spawn(async move {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        let _ = socket.send_to(&payload, destination).await;
                    });
                }
            });
            let directory = tempfile::tempdir().unwrap();
            let source = directory.path().join("source.bin");
            let destination = directory.path().join("received");
            std::fs::create_dir(&destination).unwrap();
            let bytes = vec![42; crate::BLOCK_SIZE + 17];
            std::fs::write(&source, &bytes).unwrap();
            let (host, guest) = tokio::join!(host.accept(), join(&code));
            let (_he, hc) = host.unwrap();
            let (_ge, gc) = guest.unwrap();
            let (sent, received) = tokio::join!(
                crate::send_file(&gc, &source),
                crate::receive_file(&hc, &destination, bytes.len() as u64)
            );
            assert_eq!(sent.unwrap().payload_bytes, bytes.len() as u64);
            assert_eq!(std::fs::read(received.unwrap()).unwrap(), bytes);
            gc.close(0u32.into(), b"done");
            hc.close(0u32.into(), b"done");
            proxy.abort();
        };
        timeout(Duration::from_secs(20), scenario).await.unwrap();
    }
    #[tokio::test]
    async fn wrong_secret_does_not_consume_legitimate_ticket() {
        let host =
            Host::bind("127.0.0.1:0".parse().unwrap(), "127.0.0.1".parse().unwrap()).unwrap();
        let good = host.ticket.clone();
        let mut altered = decode(&good).unwrap();
        altered.secret[0] ^= 1;
        let bad = format!(
            "p2p3:{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&altered).unwrap())
        );
        let accept = tokio::spawn(host.accept());
        assert!(join(&bad).await.is_err());
        let (_client, connection) = join(&good).await.unwrap();
        let (_host, peer) = accept.await.unwrap().unwrap();
        connection.close(0u32.into(), b"done");
        peer.close(0u32.into(), b"done");
    }

    #[tokio::test]
    async fn substituted_certificate_is_rejected_before_pairing() {
        let host =
            Host::bind("127.0.0.1:0".parse().unwrap(), "127.0.0.1".parse().unwrap()).unwrap();
        let good = host.ticket.clone();
        let mut altered = decode(&good).unwrap();
        let unrelated = rcgen::generate_simple_self_signed(vec!["p2pshare.local".into()]).unwrap();
        altered.certificate = unrelated.cert.der().to_vec();
        let bad = format!(
            "p2p3:{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&altered).unwrap())
        );
        let accept = tokio::spawn(host.accept());
        assert!(join(&bad).await.is_err());
        let (_client, connection) = join(&good).await.unwrap();
        let (_host, peer) = accept.await.unwrap().unwrap();
        connection.close(0u32.into(), b"done");
        peer.close(0u32.into(), b"done");
    }
    #[tokio::test]
    async fn ticket_connects_and_is_case_sensitive() {
        let host =
            Host::bind("127.0.0.1:0".parse().unwrap(), "127.0.0.1".parse().unwrap()).unwrap();
        assert!(decode(&host.ticket.to_uppercase()).is_err());
        let ticket = host.ticket.clone();
        let (server, client) = tokio::join!(host.accept(), join(&ticket));
        let (_se, sc) = server.unwrap();
        let (_ce, cc) = client.unwrap();
        cc.close(0u32.into(), b"done");
        sc.close(0u32.into(), b"done");
    }
    #[tokio::test]
    async fn expired_and_oversized_tickets_are_rejected() {
        let host =
            Host::bind("127.0.0.1:0".parse().unwrap(), "127.0.0.1".parse().unwrap()).unwrap();
        let mut ticket = decode(&host.ticket).unwrap();
        ticket.expires = 0;
        let expired = format!(
            "p2p3:{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&ticket).unwrap())
        );
        assert!(join(&expired).await.is_err());
        assert!(decode(&"x".repeat(LIMIT + 1)).is_err());
    }
}
