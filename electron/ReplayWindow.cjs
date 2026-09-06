// Match the native v2 replay policy. Update only after AEAD authentication.
class ReplayWindow {
  constructor() { this.clear() }
  clear() { this.highest = 0n; this.bits = 0n }
  accept(counter) {
    if (counter <= 0n || counter > 0xffffffffffffffffn) return false
    if (counter > this.highest) {
      const shift = counter - this.highest
      this.bits = shift >= 64n ? 1n : BigInt.asUintN(64, (this.bits << shift) | 1n)
      this.highest = counter
      return true
    }
    const behind = this.highest - counter
    if (behind >= 64n) return false
    const bit = 1n << behind
    if (this.bits & bit) return false
    this.bits |= bit
    return true
  }
}
module.exports = { ReplayWindow }
