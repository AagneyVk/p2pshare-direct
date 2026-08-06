import type { ConnectionState } from '../webrtc/models'

export type NativeTransferEvent = {
  id: string
  name: string
  size: number
  progress: number
  speed: number
  done: boolean
  valid: boolean | null
  incoming: boolean
}

export type NativeEvent =
  | { type: 'state'; state: ConnectionState }
  | { type: 'session_code'; code: string }
  | { type: 'chat'; id: string; text: string; ts: number; self: boolean; acked: boolean }
  | { type: 'chat_ack'; id: string }
  | { type: 'transfer'; transfer: NativeTransferEvent }
  | { type: 'error'; message: string }

export interface NativeBridgeApi {
  createSession(): Promise<string>
  joinSession(code: string): Promise<void>
  sendMessage(text: string): Promise<string>
  sendFile(file: File, encoding?: 'none' | 'deflate' | 'zstd', originalSize?: number, originalMimeType?: string): Promise<string>
  disconnect(): Promise<void>
  subscribe(cb: (event: NativeEvent) => void): () => void
}

declare global {
  interface Window {
    p2pNativeBridge?: NativeBridgeApi
  }
}

export function getNativeBridge(): NativeBridgeApi | null {
  return window.p2pNativeBridge ?? null
}
