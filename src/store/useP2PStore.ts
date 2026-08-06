import { create } from 'zustand'
import { useCallback } from 'react'
import { getNativeBridge, type NativeEvent } from '../native/NativeBridge'
import { prepareFileForTransfer } from '../webrtc/compression'
import type { ChatMessage, ConnectionState, FileTransferState } from '../webrtc/models'

interface P2PStore {
  state: ConnectionState
  sessionCode: string
  role: 'host' | 'guest' | null
  errorMsg: string
  messages: ChatMessage[]
  transfers: Record<string, FileTransferState>
  initialized: boolean
  init: () => void
  createSession: () => Promise<void>
  joinSession: (code: string) => Promise<void>
  sendMessage: (text: string) => void
  sendFile: (file: File) => void
  disconnect: () => void
  clearError: () => void
}

let unsubscribe: (() => void) | null = null

export const useP2PStore = create<P2PStore>((set, get) => ({
  state: 'idle',
  sessionCode: '',
  role: null,
  errorMsg: '',
  messages: [],
  transfers: {},
  initialized: false,

  init() {
    if (get().initialized) return
    const bridge = getNativeBridge()
    if (!bridge) {
      set({ initialized: true, errorMsg: 'P2PShare requires the Electron desktop app for direct transfers.' })
      return
    }
    const onEvent = (event: NativeEvent) => {
      if (event.type === 'state') set({ state: event.state })
      else if (event.type === 'session_code') set({ sessionCode: event.code })
      else if (event.type === 'error') set({ errorMsg: event.message })
      else if (event.type === 'chat') {
        set((s) => ({ messages: [...s.messages, {
          id: event.id, text: event.text, ts: event.ts, self: event.self, acked: event.acked,
        }] }))
      } else if (event.type === 'chat_ack') {
        set((s) => ({ messages: s.messages.map((m) => m.id === event.id ? { ...m, acked: true } : m) }))
      } else if (event.type === 'transfer') {
        set((s) => ({ transfers: { ...s.transfers, [event.transfer.id]: event.transfer } }))
      }
    }
    unsubscribe?.()
    unsubscribe = bridge.subscribe(onEvent)
    set({ initialized: true })
  },

  async createSession() {
    const bridge = getNativeBridge()
    if (!bridge) return set({ errorMsg: 'Direct native bridge unavailable' })
    try {
      const code = await bridge.createSession()
      set({ sessionCode: code, role: 'host', state: 'waiting', errorMsg: '' })
    } catch (error) {
      set({ errorMsg: String(error), state: 'idle' })
    }
  },

  async joinSession(code: string) {
    const bridge = getNativeBridge()
    if (!bridge) return set({ errorMsg: 'Direct native bridge unavailable' })
    const normalized = code.toUpperCase().trim()
    set({ sessionCode: normalized, role: 'guest', state: 'joining', errorMsg: '' })
    try {
      await bridge.joinSession(normalized)
      set({ state: 'connecting' })
    } catch (error) {
      set({ errorMsg: String(error), state: 'idle' })
    }
  },

  sendMessage(text: string) {
    const bridge = getNativeBridge()
    if (!bridge) return set({ errorMsg: 'Direct native bridge unavailable' })
    bridge.sendMessage(text).then((id) => {
      set((s) => ({ messages: [...s.messages, { id, text, ts: Date.now(), self: true, acked: false }] }))
    }).catch((error) => set({ errorMsg: String(error) }))
  },

  sendFile(file: File) {
    const bridge = getNativeBridge()
    if (!bridge) return set({ errorMsg: 'Direct native bridge unavailable' })
    void (async () => {
      const pendingId = `pending-${crypto.randomUUID()}`
      try {
        const prepared = await prepareFileForTransfer(file)
        const pending: FileTransferState = {
          id: pendingId, name: file.name, size: prepared.file.size, progress: 0,
          speed: 0, done: false, valid: null, incoming: false,
        }
        set((s) => ({ transfers: { ...s.transfers, [pendingId]: pending } }))
        const id = await bridge.sendFile(
          prepared.file, prepared.encoding, prepared.originalSize, file.type || 'application/octet-stream',
        )
        set((s) => {
          const current = s.transfers[pendingId]
          const next = { ...s.transfers }
          delete next[pendingId]
          if (current) next[id] = { ...current, id }
          return { transfers: next }
        })
      } catch (error) {
        set((s) => {
          const next = { ...s.transfers }
          delete next[pendingId]
          return { transfers: next, errorMsg: String(error) }
        })
      }
    })()
  },

  disconnect() {
    getNativeBridge()?.disconnect().catch(() => undefined)
    set({ state: 'idle', sessionCode: '', role: null, messages: [], transfers: {}, errorMsg: '' })
  },

  clearError() { set({ errorMsg: '' }) },
}))

export function useTransfer(id: string): FileTransferState | undefined {
  return useP2PStore(useCallback((s: P2PStore) => s.transfers[id], [id]))
}

export function useTransfers(): Record<string, FileTransferState> {
  return useP2PStore((s) => s.transfers)
}
