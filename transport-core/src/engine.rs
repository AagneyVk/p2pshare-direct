//! Local JSON-lines adapter. No network/file payload crosses the UI boundary.
use anyhow::{Result, ensure};
use crate::{pairing, receive_file_with_progress, send_file_with_progress};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    net::IpAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, Semaphore, mpsc},
    task::JoinSet,
};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Host {
        id: String,
        ip: IpAddr,
        directory: PathBuf,
    },
    Join {
        id: String,
        ticket: String,
        directory: PathBuf,
    },
    Send {
        id: String,
        path: PathBuf,
    },
}

type Events = mpsc::Sender<Value>;
type Session = Arc<Mutex<Option<(quinn::Endpoint, quinn::Connection)>>>;
const QUOTA: u64 = 256 * 1024 * 1024 * 1024;

async fn receive_loop(connection: quinn::Connection, directory: PathBuf, events: Events) {
    let mut remaining = QUOTA;
    for _ in 0..1024 {
        let started = Instant::now();
        let mut last = Instant::now() - Duration::from_secs(1);
        let mut metadata = None;
        let result =
            receive_file_with_progress(&connection, &directory, remaining, |offer, done| {
                metadata = Some((offer.digest.clone(), offer.size, offer.name.clone()));
                if last.elapsed() >= Duration::from_millis(150) {
                    last = Instant::now();
                    let _ = events.try_send(json!({"event":"progress", "id":offer.digest,
                    "name":offer.name, "size":offer.size, "bytes":done, "incoming":true,
                    "speed":done as f64 / started.elapsed().as_secs_f64().max(0.001)}));
                }
            })
            .await;
        match result {
            Ok(path) => {
                let (digest, size, name) = metadata.expect("verified transfer reports metadata");
                remaining = remaining.saturating_sub(size.max(4096));
                if events
                    .send(json!({"event":"received", "id":digest, "name":name,
                    "size":size, "path":path}))
                    .await
                    .is_err()
                {
                    return;
                }
            }
            Err(_) => {
                let _ = events.send(json!({"event":"error", "message":"Receive failed or peer disconnected. Partial data is retained."})).await;
                connection.close(2u32.into(), b"receive failed");
                return;
            }
        }
    }
    connection.close(3u32.into(), b"session transfer limit");
    let _ = events.send(json!({"event":"error", "message":"Session transfer limit reached; create a new session"})).await;
}

pub async fn run<R, W>(input: R, mut stdout: W) -> Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (events, mut output) = mpsc::channel::<Value>(64);
    let writer = tokio::spawn(async move {
        while let Some(value) = output.recv().await {
            let mut bytes = serde_json::to_vec(&value)?;
            bytes.push(b'\n');
            stdout.write_all(&bytes).await?;
            stdout.flush().await?;
        }
        Ok::<_, anyhow::Error>(())
    });
    let session: Session = Arc::new(Mutex::new(None));
    let sending = Arc::new(Semaphore::new(1));
    let mut tasks = JoinSet::new();
    let mut input = BufReader::new(input);
    let mut started_session = false;
    loop {
        let mut line = Vec::new();
        let bytes = (&mut input)
            .take(16385)
            .read_until(b'\n', &mut line)
            .await?;
        if bytes == 0 {
            break;
        }
        ensure!(
            bytes <= 16384 && line.last() == Some(&b'\n'),
            "oversized command"
        );
        let command: Command = match serde_json::from_slice(&line) {
            Ok(command) => command,
            Err(_) => {
                events
                    .send(json!({"event":"error","message":"Invalid engine command"}))
                    .await?;
                continue;
            }
        };
        // Reap finished tasks so repeated sends do not grow task metadata forever.
        while tasks.try_join_next().is_some() {}
        match command {
            Command::Host { id, ip, directory } => {
                ensure!(!started_session, "one session per engine process");
                started_session = true;
                tokio::fs::create_dir_all(&directory).await?;
                let bind = if ip.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" };
                let host = pairing::Host::bind(bind.parse()?, ip)?;
                events
                    .send(json!({"event":"response", "id":id, "value":host.ticket}))
                    .await?;
                let events = events.clone();
                let session = session.clone();
                tasks.spawn(async move {
                    match host.accept().await {
                        Ok((endpoint, connection)) => {
                            *session.lock().await = Some((endpoint, connection.clone()));
                            let _ = events.send(json!({"event":"connected"})).await;
                            receive_loop(connection, directory, events).await;
                        }
                        Err(_) => {
                            let _ = events
                                .send(
                                    json!({"event":"error", "message":"Pairing expired or failed"}),
                                )
                                .await;
                        }
                    }
                });
            }
            Command::Join {
                id,
                ticket,
                directory,
            } => {
                ensure!(!started_session, "one session per engine process");
                started_session = true;
                tokio::fs::create_dir_all(&directory).await?;
                let events = events.clone();
                let session = session.clone();
                tasks.spawn(async move {
                    match pairing::join(&ticket).await {
                        Ok((endpoint, connection)) => {
                            *session.lock().await = Some((endpoint, connection.clone()));
                            let _ = events.send(json!({"event":"response", "id":id, "value":true})).await;
                            let _ = events.send(json!({"event":"connected"})).await;
                            receive_loop(connection, directory, events).await;
                        }
                        Err(_) => { let _ = events.send(json!({"event":"response", "id":id, "error":"Pairing failed: check ticket, expiry and direct reachability"})).await; }
                    }
                });
            }
            Command::Send { id, path } => {
                let connection = session.lock().await.as_ref().map(|(_, c)| c.clone());
                let permit = sending.clone().try_acquire_owned();
                let (Some(connection), Ok(permit)) = (connection, permit) else {
                    events.send(json!({"event":"response", "id":id, "error":"Not connected or a send is already active"})).await?;
                    continue;
                };
                let events = events.clone();
                tasks.spawn(async move {
                    let _permit = permit;
                    let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                    let started = Instant::now();
                    let mut last = started - Duration::from_secs(1);
                    let result = send_file_with_progress(&connection, &path, |bytes, size| {
                        if last.elapsed() >= Duration::from_millis(150) {
                            last = Instant::now();
                            let _ = events.try_send(json!({"event":"progress","id":id,"name":name,
                                "bytes":bytes,"size":size,"incoming":false,
                                "speed":bytes as f64 / started.elapsed().as_secs_f64().max(0.001)}));
                        }
                    }).await;
                    let message = match result {
                        Ok(result) => json!({"event":"response","id":id,"value":result}),
                        Err(_) => json!({"event":"response","id":id,"error":"Send failed; reconnect to resume verified blocks"}),
                    };
                    let _ = events.send(message).await;
                });
            }
        }
    }
    tasks.abort_all();
    if let Some((endpoint, connection)) = session.lock().await.take() {
        connection.close(0u32.into(), b"closed");
        endpoint.close(0u32.into(), b"closed");
    }
    drop(tasks);
    drop(events);
    writer.await??;
    Ok(())
}
