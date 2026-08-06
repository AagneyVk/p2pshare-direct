import { useRef, useState, useEffect } from 'react'
import { useP2PStore } from '../store/useP2PStore'
import { Btn, Badge, Divider, ProgressBar, FilePick } from '../components/Ui'
import type { ChatMessage, FileTransferState } from '../webrtc/models'

export default function ChatScreen() {
  const { messages, transfers, sendMessage, sendFile, disconnect } = useP2PStore()
  const [text, setText] = useState('')
  const bottomRef  = useRef<HTMLDivElement>(null)
  const inputRef   = useRef<HTMLInputElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  const handleSend = () => {
    const t = text.trim()
    if (!t) return
    sendMessage(t)
    setText('')
    inputRef.current?.focus()
  }

  const transferList = Object.values(transfers)

  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      maxWidth: 720,
      margin: '0 auto',
      padding: '0 16px',
    }}>

      {/* ── Header ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 0',
        borderBottom: '1px solid #222',
        flexShrink: 0,
      }}>
        <Badge text="● CONNECTED" />
        <span style={{ flex: 1 }} />
        <Btn ghost sm onClick={disconnect}>DISCONNECT</Btn>
      </div>

      {/* ── File transfers ── */}
      {transferList.length > 0 && (
        <div style={{ flexShrink: 0, padding: '10px 0', borderBottom: '1px solid #222' }}>
          {transferList.map(t => <TransferRow key={t.id} t={t} />)}
        </div>
      )}

      {/* ── Messages ── */}
      <div className="message-list" style={{ flex: 1 }}>
        {messages.length === 0 && (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#555', fontFamily: 'monospace', fontSize: 12, textAlign: 'center',
            padding: 32,
          }}>
            NATIVE P2P ENGINE ACTIVE<br />
            <span style={{ color: '#333', marginTop: 8, display: 'block' }}>
              TYPE A MESSAGE OR SEND A FILE BELOW
            </span>
          </div>
        )}
        {messages.map(m => <MessageBubble key={m.id} msg={m} />)}
        <div ref={bottomRef} />
      </div>

      {/* ── Input ── */}
      <div style={{
        display: 'flex',
        gap: 8,
        padding: '12px 0',
        borderTop: '1px solid #222',
        flexShrink: 0,
      }}>
        <input
          ref={inputRef}
          className="input"
          style={{ flex: 1 }}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
          placeholder="TYPE MESSAGE..."
          autoFocus
        />
        <Btn onClick={handleSend} disabled={!text.trim()}>SEND</Btn>
        <FilePick onFile={sendFile} />
      </div>
    </div>
  )
}

// ── Message bubble ────────────────────────────────────────────────
function MessageBubble({ msg }: { msg: ChatMessage }) {
  const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <div className={`msg ${msg.self ? 'self' : ''}`}>
      <div className="msg__bubble">{msg.text}</div>
      <div className="msg__meta">
        {time}
        {msg.self && <span style={{ marginLeft: 4 }}>{msg.acked ? '✓✓' : '✓'}</span>}
      </div>
    </div>
  )
}

// ── File transfer row ─────────────────────────────────────────────
function TransferRow({ t }: { t: FileTransferState }) {
  const dir      = t.incoming ? '↓' : '↑'
  const transferred = Math.min(t.size, Math.max(0, Math.round(t.progress * t.size)))

  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
    if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${bytes} B`
  }

  const sizeStr  = t.size >= 1_048_576
    ? `${(t.size / 1_048_576).toFixed(1)} MB`
    : `${(t.size / 1024).toFixed(0)} KB`

  const transferStr = `${t.incoming ? 'DOWNLOADED' : 'UPLOADED'} ${formatBytes(transferred)} / ${formatBytes(t.size)}`

  return (
    <div className="transfer-row">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <div className="transfer-name" style={{ flex: 1, marginRight: 12 }}>
          <span style={{ marginRight: 6, color: '#888' }}>{dir}</span>
          {t.name}
        </div>
        <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#888', flexShrink: 0 }}>
          {t.done
            ? (t.valid ? '✓ VERIFIED' : '✗ HASH FAIL')
            : sizeStr
          }
        </div>
      </div>
      <ProgressBar value={t.progress} />
      <div className="transfer-meta">{transferStr}</div>
    </div>
  )
}
