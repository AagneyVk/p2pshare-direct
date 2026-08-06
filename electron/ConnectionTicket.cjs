const crypto = require('node:crypto')

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const DECODE = new Map(Array.from(ALPHABET).map((c, i) => [c, i]))
DECODE.set('O', 0); DECODE.set('I', 1); DECODE.set('L', 1)
const FIXED_PORT = 45882

function crc16(bytes) {
  let crc = 0xffff
  for (const byte of bytes) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff
  }
  return crc
}

function base32Encode(bytes) {
  let bits = 0, value = 0, out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out.match(/.{1,4}/g).join('-')
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^0-9A-Z]/g, '')
  let bits = 0, value = 0
  const out = []
  for (const char of clean) {
    const digit = DECODE.get(char)
    if (digit === undefined) throw new Error(`Invalid ticket character: ${char}`)
    value = (value << 5) | digit; bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8 }
  }
  return Buffer.from(out)
}

function encodeTicket(endpoint, secret = crypto.randomBytes(10)) {
  const octets = String(endpoint.address).split('.').map(Number)
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error('Ticket requires IPv4')
  const mapped = Number(endpoint.port) !== FIXED_PORT
  const payload = Buffer.alloc(4 + 1 + (mapped ? 2 : 0) + 10)
  octets.forEach((n, i) => payload[i] = n)
  payload[4] = mapped ? 1 : 0
  let offset = 5
  if (mapped) { payload.writeUInt16BE(endpoint.port, offset); offset += 2 }
  Buffer.from(secret).copy(payload, offset, 0, 10)
  const framed = Buffer.alloc(payload.length + 2)
  payload.copy(framed); framed.writeUInt16BE(crc16(payload), payload.length)
  return { code: base32Encode(framed), secret: Buffer.from(secret), endpoint }
}

function decodeTicket(code) {
  const framed = base32Decode(code)
  if (framed.length !== 17 && framed.length !== 19) throw new Error('Invalid connection ticket length')
  const payload = framed.subarray(0, framed.length - 2)
  if (crc16(payload) !== framed.readUInt16BE(framed.length - 2)) throw new Error('Connection ticket checksum failed')
  const mapped = payload[4] === 1
  if (mapped !== (framed.length === 19)) throw new Error('Invalid connection ticket flags')
  let offset = 5
  const port = mapped ? payload.readUInt16BE(offset) : FIXED_PORT
  if (mapped) offset += 2
  return {
    endpoint: { address: Array.from(payload.subarray(0, 4)).join('.'), port },
    secret: Buffer.from(payload.subarray(offset, offset + 10)),
  }
}

module.exports = { FIXED_PORT, encodeTicket, decodeTicket, crc16, base32Encode, base32Decode }
