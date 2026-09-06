//! V3 data plane used by the opt-in desktop preview; Android integration pending.
//! Callers own pairing, user consent, quotas, cancellation and trusted storage.
pub mod pairing;
pub mod tls;

use anyhow::{Result, bail, ensure};
use fs2::FileExt;
use quinn::{Connection, RecvStream, SendStream};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

pub const BLOCK_SIZE: usize = 1024 * 1024;
const MAX_BLOCKS: usize = 262144;
const MAX_MANIFEST: usize = 24 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    #[serde(default)]
    pub name: String,
    pub version: u32,
    pub size: u64,
    pub block_size: u32,
    pub digest: String,
    pub blocks: Vec<String>,
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Manifest {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.name.len() <= 255 && !self.name.chars().any(char::is_control),
            "invalid display name"
        );
        ensure!(self.version == 3, "unsupported protocol version");
        ensure!(
            self.block_size as usize == BLOCK_SIZE,
            "unsupported block size"
        );
        ensure!(
            self.size <= (MAX_BLOCKS * BLOCK_SIZE) as u64,
            "file exceeds transfer limit"
        );
        ensure!(
            self.blocks.len() == self.size.div_ceil(BLOCK_SIZE as u64) as usize,
            "invalid block count"
        );
        ensure!(
            valid_hash(&self.digest) && self.blocks.iter().all(|h| valid_hash(h)),
            "invalid digest"
        );
        Ok(())
    }

    fn length(&self, index: usize) -> usize {
        (self.size - index as u64 * BLOCK_SIZE as u64).min(BLOCK_SIZE as u64) as usize
    }
}

async fn read_block(file: &mut tokio::fs::File, index: usize, bytes: &mut [u8]) -> Result<()> {
    file.seek(std::io::SeekFrom::Start(index as u64 * BLOCK_SIZE as u64))
        .await?;
    file.read_exact(bytes).await?;
    Ok(())
}

pub async fn manifest(path: &Path) -> Result<Manifest> {
    let mut file = tokio::fs::File::open(path).await?;
    let metadata = file.metadata().await?;
    ensure!(metadata.is_file(), "source must be a regular file");
    let size = metadata.len();
    ensure!(
        size <= (MAX_BLOCKS * BLOCK_SIZE) as u64,
        "file exceeds transfer limit"
    );
    let mut result = Manifest {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .chars()
            .filter(|c| !c.is_control())
            .take(60)
            .collect(),
        version: 3,
        size,
        block_size: BLOCK_SIZE as u32,
        digest: String::new(),
        blocks: Vec::new(),
    };
    let mut whole = blake3::Hasher::new();
    let mut buffer = vec![0; BLOCK_SIZE];
    for index in 0..size.div_ceil(BLOCK_SIZE as u64) as usize {
        let bytes = &mut buffer[..result.length(index)];
        read_block(&mut file, index, bytes).await?;
        whole.update(bytes);
        result.blocks.push(blake3::hash(bytes).to_hex().to_string());
    }
    result.digest = whole.finalize().to_hex().to_string();
    result.validate()?;
    Ok(result)
}

async fn write_frame(send: &mut SendStream, bytes: &[u8]) -> Result<()> {
    ensure!(bytes.len() <= MAX_MANIFEST, "frame exceeds limit");
    send.write_all(&(bytes.len() as u32).to_be_bytes()).await?;
    send.write_all(bytes).await?;
    Ok(())
}

async fn read_frame(recv: &mut RecvStream, limit: usize) -> Result<Vec<u8>> {
    let mut prefix = [0; 4];
    recv.read_exact(&mut prefix).await?;
    let size = u32::from_be_bytes(prefix) as usize;
    ensure!(size <= limit, "frame exceeds limit");
    let mut bytes = vec![0; size];
    recv.read_exact(&mut bytes).await?;
    Ok(bytes)
}

#[derive(Debug, Serialize)]
pub struct TransferResult {
    pub source_bytes: u64,
    pub payload_bytes: u64,
    pub reused_bytes: u64,
    pub digest: String,
}

/// Send one file on a fresh bidirectional stream. Await receiver verification.
/// Prehashing is deliberate in v3-alpha; measure it in end-to-end timings.
pub async fn send_file(connection: &Connection, source: &Path) -> Result<TransferResult> {
    send_file_with_progress(connection, source, |_, _| {}).await
}

pub async fn send_file_with_progress(
    connection: &Connection,
    source: &Path,
    mut progress: impl FnMut(u64, u64),
) -> Result<TransferResult> {
    let offer = manifest(source).await?;
    progress(0, offer.size);
    let (mut send, mut recv) = connection.open_bi().await?;
    write_frame(&mut send, &serde_json::to_vec(&offer)?).await?;
    let missing = read_frame(&mut recv, MAX_BLOCKS).await?;
    ensure!(missing.len() == offer.blocks.len(), "invalid resume map");
    ensure!(missing.iter().all(|b| *b <= 1), "invalid resume bit");
    let mut file = tokio::fs::File::open(source).await?;
    let mut buffer = vec![0; BLOCK_SIZE];
    let mut payload_bytes = 0;
    let reused_bytes: u64 = missing
        .iter()
        .enumerate()
        .filter(|(_, n)| **n == 0)
        .map(|(i, _)| offer.length(i) as u64)
        .sum();
    progress(reused_bytes, offer.size);
    for (index, needed) in missing.iter().enumerate() {
        if *needed == 0 {
            continue;
        }
        let bytes = &mut buffer[..offer.length(index)];
        read_block(&mut file, index, bytes).await?;
        ensure!(
            blake3::hash(bytes).to_hex().as_str() == offer.blocks[index],
            "source changed during transfer"
        );
        send.write_all(bytes).await?;
        payload_bytes += bytes.len() as u64;
        progress(reused_bytes + payload_bytes, offer.size);
    }
    send.finish()?;
    let receipt = recv.read_to_end(64).await?;
    ensure!(
        receipt == offer.digest.as_bytes(),
        "receiver did not verify completion"
    );
    Ok(TransferResult {
        source_bytes: offer.size,
        payload_bytes,
        reused_bytes: offer.size - payload_bytes,
        digest: offer.digest,
    })
}

/// Receive a consented transfer into an application-private directory.
/// One active writer per directory/digest is required (enforced by a lock file).
/// Final file uses a digest-derived name; remote filenames never become paths.
/// Partial files are rehashed on reconnect, so no bitmap can falsely claim durability.
pub async fn receive_file(
    connection: &Connection,
    directory: &Path,
    quota: u64,
) -> Result<PathBuf> {
    receive_file_with_progress(connection, directory, quota, |_, _| {}).await
}

pub async fn receive_file_with_progress(
    connection: &Connection,
    directory: &Path,
    quota: u64,
    mut progress: impl FnMut(&Manifest, u64),
) -> Result<PathBuf> {
    let (mut send, mut recv) = connection.accept_bi().await?;
    let offer: Manifest = serde_json::from_slice(&read_frame(&mut recv, MAX_MANIFEST).await?)?;
    offer.validate()?;
    ensure!(offer.size <= quota, "receiver quota exceeded");
    let partial = directory.join(format!("{}.part", offer.digest));
    let completed = directory.join(&offer.digest);
    let lock_path = directory.join(format!("{}.lock", offer.digest));
    let lock = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)?;
    lock.try_lock_exclusive()?;
    // OS advisory lock is released even on process death. Keep the inode in place
    // to avoid a remove/recreate race admitting two writers.
    let _guard = lock;
    // Lost completion receipts are idempotent: verify existing content, request
    // no payload, and acknowledge it again. Never truncate a completed file.
    if let Ok(metadata) = tokio::fs::symlink_metadata(&completed).await {
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "invalid completed file"
        );
        ensure!(
            metadata.len() == offer.size && manifest(&completed).await?.digest == offer.digest,
            "completed destination integrity mismatch"
        );
        write_frame(&mut send, &vec![0; offer.blocks.len()]).await?;
        let mut extra = [0];
        ensure!(
            recv.read(&mut extra).await?.is_none(),
            "unexpected duplicate payload"
        );
        progress(&offer, offer.size);
        send.write_all(offer.digest.as_bytes()).await?;
        send.finish()?;
        return Ok(completed);
    }
    if let Ok(metadata) = tokio::fs::symlink_metadata(&partial).await {
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "invalid partial file"
        );
    }
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&partial)
        .await?;
    let existing_size = file.metadata().await?.len();
    let mut missing = vec![1; offer.blocks.len()];
    let mut buffer = vec![0; BLOCK_SIZE];
    for (index, needed) in missing.iter_mut().enumerate() {
        let length = offer.length(index);
        if existing_size >= index as u64 * BLOCK_SIZE as u64 + length as u64 {
            let bytes = &mut buffer[..length];
            read_block(&mut file, index, bytes).await?;
            if blake3::hash(bytes).to_hex().as_str() == offer.blocks[index] {
                *needed = 0;
            }
        }
    }
    let required_bytes: u64 = missing
        .iter()
        .enumerate()
        .filter(|(_, n)| **n == 1)
        .map(|(i, _)| offer.length(i) as u64)
        .sum();
    // Conservative preflight, not an atomic disk reservation. Still handle all
    // write/sync errors: another process may consume capacity after this check.
    ensure!(
        fs2::available_space(directory)? >= required_bytes,
        "insufficient free space"
    );
    file.set_len(offer.size).await?;
    let mut verified: u64 = missing
        .iter()
        .enumerate()
        .filter(|(_, n)| **n == 0)
        .map(|(i, _)| offer.length(i) as u64)
        .sum();
    progress(&offer, verified);
    write_frame(&mut send, &missing).await?;
    for (index, needed) in missing.iter().enumerate() {
        if *needed == 0 {
            continue;
        }
        let bytes = &mut buffer[..offer.length(index)];
        recv.read_exact(bytes).await?;
        ensure!(
            blake3::hash(bytes).to_hex().as_str() == offer.blocks[index],
            "block integrity failure"
        );
        file.seek(std::io::SeekFrom::Start(index as u64 * BLOCK_SIZE as u64))
            .await?;
        file.write_all(bytes).await?;
        verified += bytes.len() as u64;
        progress(&offer, verified);
    }
    let mut extra = [0];
    if recv.read(&mut extra).await?.is_some() {
        bail!("unexpected trailing payload");
    }
    file.flush().await?;
    file.sync_all().await?;
    drop(file);
    ensure!(
        manifest(&partial).await?.digest == offer.digest,
        "whole-file integrity failure"
    );
    // Hard-link publication is atomic and refuses an existing destination.
    tokio::fs::hard_link(&partial, &completed).await?;
    tokio::fs::remove_file(&partial).await?;
    #[cfg(unix)]
    std::fs::File::open(directory)?.sync_all()?;
    send.write_all(offer.digest.as_bytes()).await?;
    send.finish()?;
    Ok(completed)
}
