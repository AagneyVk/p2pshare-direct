export type PeerRole = 'host' | 'guest'
export type ConnectionState =
  | 'idle' | 'creating' | 'waiting' | 'joining'
  | 'connecting' | 'connected' | 'disconnected' | 'error'

export interface FileMeta {
  id:         string
  name:       string
  size:       number
  mimeType:   string
  hash:       string   // may be "hash-pending"; authoritative hash arrives in DONE frame
  chunks:     number
  chunkSize?: number
  originalSize?: number
  encoding?: 'none' | 'deflate'
}

export interface ChatMessage {
  id:    string
  text:  string
  ts:    number
  self:  boolean
  acked: boolean
}

export interface FileTransferState {
  id:       string
  name:     string
  size:     number
  progress: number
  speed:    number
  done:     boolean
  valid:    boolean | null
  incoming: boolean
}

export type AppMessage =
  | { type: 'chat';         id: string; payload: { text: string; ts: number } }
  | { type: 'file_offer';   id: string; payload: FileMeta }
  | { type: 'file_ack';     id: string; payload: Record<string, never> }
  | { type: 'flow_ack';     fileId: string; grantedBytes: number }
  | { type: 'window_ack';   fileId: string; windowIndex: number }
  | { type: 'delivery_ack'; payload: { id: string } }

export function buildChat(id: string, text: string): string {
  return JSON.stringify({ type: 'chat', id, payload: { text, ts: Date.now() } })
}
export function buildFileOffer(meta: FileMeta): string {
  return JSON.stringify({ type: 'file_offer', id: meta.id, payload: meta })
}
export function buildFileAck(fileId: string): string {
  return JSON.stringify({ type: 'file_ack', id: fileId, payload: {} })
}
export function buildFlowAck(fileId: string, grantedBytes: number): string {
  return JSON.stringify({ type: 'flow_ack', fileId, grantedBytes })
}
export function buildWindowAck(fileId: string, windowIndex: number): string {
  return JSON.stringify({ type: 'window_ack', fileId, windowIndex })
}
export function buildDeliveryAck(msgId: string): string {
  return JSON.stringify({ type: 'delivery_ack', payload: { id: msgId } })
}

export const FRAME_TYPE_CHUNK = 0x00
export const FRAME_TYPE_DONE  = 0xFF