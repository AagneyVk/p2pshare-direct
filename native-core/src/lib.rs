use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use aes_gcm::aead::{Aead, Payload};
use hmac::{Hmac, Mac};
use napi::bindgen_prelude::{Buffer, Error, Result, Status};
use napi_derive::napi;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

type HmacSha256 = Hmac<Sha256>;
const MAGIC: u32 = 0x5132_5053;
const VERSION: u8 = 2;
const ENCRYPTED_TYPE: u8 = 17;

struct CryptoState {
    cipher: Aes256Gcm,
    send_prefix: [u8; 4],
    receive_prefix: [u8; 4],
    send_counter: u64,
    highest_received: u64,
    replay_window: u64,
}

#[napi]
pub struct PacketCrypto {
    state: Mutex<CryptoState>,
}

fn prefix(key: &[u8], role: &str) -> Result<[u8; 4]> {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key)
        .map_err(|_| Error::new(Status::InvalidArg, "invalid key"))?;
    mac.update(format!("nonce:{role}").as_bytes());
    let digest = mac.finalize().into_bytes();
    Ok(digest[..4].try_into().unwrap())
}

fn nonce(prefix: [u8; 4], counter: u64) -> [u8; 12] {
    let mut value = [0u8; 12];
    value[..4].copy_from_slice(&prefix);
    value[4..].copy_from_slice(&counter.to_be_bytes());
    value
}

fn accept_counter(state: &mut CryptoState, counter: u64) -> bool {
    if counter > state.highest_received {
        let shift = counter - state.highest_received;
        state.replay_window = if shift >= 64 { 1 } else { (state.replay_window << shift) | 1 };
        state.highest_received = counter;
        return true;
    }
    let behind = state.highest_received - counter;
    if behind >= 64 { return false; }
    let bit = 1u64 << behind;
    if state.replay_window & bit != 0 { return false; }
    state.replay_window |= bit;
    true
}

fn seal_packet(state: &mut CryptoState, plaintext: &[u8]) -> Result<Vec<u8>> {
    state.send_counter = state.send_counter.checked_add(1)
        .ok_or_else(|| Error::from_reason("packet counter exhausted"))?;
    let counter = state.send_counter;
    let counter_bytes = counter.to_be_bytes();
    let nonce_bytes = nonce(state.send_prefix, counter);
    let encrypted = state.cipher.encrypt(
        Nonce::from_slice(&nonce_bytes),
        Payload { msg: plaintext, aad: &counter_bytes },
    ).map_err(|_| Error::from_reason("AES-GCM encryption failed"))?;
    let mut output = Vec::with_capacity(14 + encrypted.len());
    output.extend_from_slice(&MAGIC.to_be_bytes());
    output.push(VERSION);
    output.push(ENCRYPTED_TYPE);
    output.extend_from_slice(&counter_bytes);
    output.extend_from_slice(&encrypted);
    Ok(output)
}

#[napi]
impl PacketCrypto {
    #[napi(constructor)]
    pub fn new(key: Buffer, role: String) -> Result<Self> {
        if key.len() != 32 || (role != "host" && role != "guest") {
            return Err(Error::new(Status::InvalidArg, "expected 32-byte key and host/guest role"));
        }
        let remote = if role == "host" { "guest" } else { "host" };
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| Error::new(Status::InvalidArg, "invalid AES key"))?;
        Ok(Self { state: Mutex::new(CryptoState {
            cipher,
            send_prefix: prefix(&key, &role)?,
            receive_prefix: prefix(&key, remote)?,
            send_counter: 0,
            highest_received: 0,
            replay_window: 0,
        }) })
    }

    #[napi]
    pub fn seal(&self, plaintext: Buffer) -> Result<Buffer> {
        let mut state = self.state.lock().map_err(|_| Error::from_reason("crypto state poisoned"))?;
        Ok(seal_packet(&mut state, &plaintext)?.into())
    }

    /// Benchmark/prototype primitive: crosses N-API once and seals many equal-sized
    /// packets natively. Output is length-prefixed so packet boundaries are retained.
    #[napi]
    pub fn seal_batch(&self, plaintexts: Vec<Buffer>) -> Result<Buffer> {
        let mut state = self.state.lock().map_err(|_| Error::from_reason("crypto state poisoned"))?;
        let estimated = plaintexts.iter().map(|p| p.len() + 34).sum();
        let mut output = Vec::with_capacity(estimated);
        for plaintext in plaintexts {
            let packet = seal_packet(&mut state, &plaintext)?;
            let len = u32::try_from(packet.len()).map_err(|_| Error::from_reason("packet too large"))?;
            output.extend_from_slice(&len.to_be_bytes());
            output.extend_from_slice(&packet);
        }
        Ok(output.into())
    }

    #[napi]
    pub fn open(&self, packet: Buffer) -> Result<Option<Buffer>> {
        if packet.len() < 30 || u32::from_be_bytes(packet[..4].try_into().unwrap()) != MAGIC ||
            packet[4] != VERSION || packet[5] != ENCRYPTED_TYPE {
            return Ok(None);
        }
        let counter = u64::from_be_bytes(packet[6..14].try_into().unwrap());
        let counter_bytes = counter.to_be_bytes();
        let mut state = self.state.lock().map_err(|_| Error::from_reason("crypto state poisoned"))?;
        let nonce_bytes = nonce(state.receive_prefix, counter);
        let plaintext = match state.cipher.decrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload { msg: &packet[14..], aad: &counter_bytes },
        ) {
            Ok(value) => value,
            Err(_) => return Ok(None),
        };
        if !accept_counter(&mut state, counter) { return Ok(None); }
        Ok(Some(plaintext.into()))
    }
}

#[napi]
pub fn sha256_file(path: String) -> Result<String> {
    let file = File::open(path).map_err(|error| Error::from_reason(error.to_string()))?;
    let mut reader = BufReader::with_capacity(1024 * 1024, file);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let count = reader.read(&mut buffer).map_err(|error| Error::from_reason(error.to_string()))?;
        if count == 0 { break; }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[napi]
pub fn zstd_compress_file(input_path: String, output_path: String, level: i32) -> Result<i64> {
    let input = BufReader::with_capacity(1024 * 1024,
        File::open(input_path).map_err(|error| Error::from_reason(error.to_string()))?);
    let mut output = BufWriter::with_capacity(1024 * 1024,
        File::create(output_path).map_err(|error| Error::from_reason(error.to_string()))?);
    zstd::stream::copy_encode(input, &mut output, level.clamp(1, 9))
        .map_err(|error| Error::from_reason(error.to_string()))?;
    output.flush().map_err(|error| Error::from_reason(error.to_string()))?;
    Ok(output.get_ref().metadata().map_err(|error| Error::from_reason(error.to_string()))?.len() as i64)
}

#[napi]
pub fn zstd_decompress_file(input_path: String, output_path: String) -> Result<i64> {
    let input = BufReader::with_capacity(1024 * 1024,
        File::open(input_path).map_err(|error| Error::from_reason(error.to_string()))?);
    let mut output = BufWriter::with_capacity(1024 * 1024,
        File::create(output_path).map_err(|error| Error::from_reason(error.to_string()))?);
    zstd::stream::copy_decode(input, &mut output)
        .map_err(|error| Error::from_reason(error.to_string()))?;
    output.flush().map_err(|error| Error::from_reason(error.to_string()))?;
    Ok(output.get_ref().metadata().map_err(|error| Error::from_reason(error.to_string()))?.len() as i64)
}

/// Compress independent regions concurrently. This deliberately creates independent
/// Zstd frames: receiver-side decoding/recovery can later operate per region.
#[napi]
pub fn zstd_compress_regions(input: Buffer, region_bytes: u32, level: i32, workers: u32) -> Result<Vec<Buffer>> {
    let region_bytes = usize::try_from(region_bytes).unwrap_or(0);
    if region_bytes == 0 { return Err(Error::new(Status::InvalidArg, "region_bytes must be > 0")); }
    let level = level.clamp(1, 9);
    let regions: Vec<Vec<u8>> = input.chunks(region_bytes).map(|chunk| chunk.to_vec()).collect();
    if regions.is_empty() { return Ok(Vec::new()); }

    let region_count = regions.len();
    let worker_count = usize::try_from(workers.max(1)).unwrap_or(1).min(region_count);
    let queue = Arc::new(Mutex::new(regions.into_iter().enumerate()));
    let results = Arc::new(Mutex::new(vec![None::<Vec<u8>>; region_count]));
    let mut handles = Vec::with_capacity(worker_count);

    for _ in 0..worker_count {
        let queue = Arc::clone(&queue);
        let results = Arc::clone(&results);
        handles.push(thread::spawn(move || -> std::result::Result<(), String> {
            loop {
                let next = queue.lock().map_err(|_| "region queue poisoned".to_string())?.next();
                let Some((index, region)) = next else { break };
                let encoded = zstd::bulk::compress(&region, level).map_err(|e| e.to_string())?;
                results.lock().map_err(|_| "region results poisoned".to_string())?[index] = Some(encoded);
            }
            Ok(())
        }));
    }
    for handle in handles {
        handle.join().map_err(|_| Error::from_reason("compression worker panicked"))?
            .map_err(Error::from_reason)?;
    }
    let mut guard = results.lock().map_err(|_| Error::from_reason("region results poisoned"))?;
    guard.drain(..).map(|value| value.map(Buffer::from)
        .ok_or_else(|| Error::from_reason("missing compressed region"))).collect()
}

#[napi]
pub fn zstd_decompress_regions(regions: Vec<Buffer>, expected_region_bytes: u32) -> Result<Buffer> {
    let expected = usize::try_from(expected_region_bytes).unwrap_or(0);
    if expected == 0 { return Err(Error::new(Status::InvalidArg, "expected_region_bytes must be > 0")); }
    let mut output = Vec::new();
    for region in regions {
        let decoded = zstd::bulk::decompress(&region, expected)
            .map_err(|error| Error::from_reason(error.to_string()))?;
        output.extend_from_slice(&decoded);
    }
    Ok(output.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonce_is_directional_and_stable() {
        let key = [7u8; 32];
        assert_ne!(prefix(&key, "host").unwrap(), prefix(&key, "guest").unwrap());
        assert_eq!(nonce([1, 2, 3, 4], 9), [1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 9]);
    }

    #[test]
    fn independent_zstd_regions_round_trip() {
        let source = vec![0x41u8; 1024 * 1024 + 137];
        let size = 256 * 1024;
        let regions: Vec<_> = source.chunks(size)
            .map(|chunk| zstd::bulk::compress(chunk, 1).unwrap()).collect();
        let mut decoded = Vec::new();
        for region in regions {
            decoded.extend(zstd::bulk::decompress(&region, size).unwrap());
        }
        assert_eq!(decoded, source);
    }
}
