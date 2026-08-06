import { useState } from 'react'
import { useP2PStore } from '../store/useP2PStore'
import { Btn, Divider } from '../components/Ui'

export default function HomeScreen() {
  const { createSession, joinSession, state, errorMsg, clearError } = useP2PStore()
  const [view, setView] = useState<'home' | 'join'>('home')
  const [code, setCode] = useState('')
  const [joinError, setJoinError] = useState('')

  const handleCreate = async () => {
    clearError()
    await createSession()
  }

  const handleJoin = async () => {
    if (code.replace(/-/g, '').trim().length < 20) { setJoinError('ENTER THE FULL CONNECTION TICKET'); return }
    setJoinError('')
    clearError()
    await joinSession(code.trim().toUpperCase())
  }

  return (
    <div className="screen" style={{ justifyContent: 'center', maxWidth: 480 }}>
      <div style={{ marginBottom: 48 }}>
        <div className="screen__title">P2P SHARE</div>
        <div className="screen__sub" style={{ marginTop: 6 }}>
          website UI + native transport engine for max throughput
        </div>
      </div>

      {view === 'home' && (
        <div className="col">
          <div className="screen__sub" style={{ marginBottom: 8 }}>WHAT DO YOU WANT TO DO?</div>

          <Btn onClick={handleCreate} style={{ width: '100%', justifyContent: 'center' }}>
            CREATE SESSION
          </Btn>

          <Btn ghost onClick={() => { setView('join'); setJoinError('') }}
            style={{ width: '100%', justifyContent: 'center' }}>
            JOIN SESSION
          </Btn>

          {(errorMsg) && (
            <div style={{ marginTop: 12, color: '#fff', fontFamily: 'monospace', fontSize: 12 }}>
              ERROR: {errorMsg}
            </div>
          )}

          <Divider />

          <div className="screen__sub" style={{ textAlign: 'center', lineHeight: 1.8 }}>
            UI RUNS IN YOUR BROWSER<br />
            TRANSFER RUNS IN NATIVE ENGINE<br />
            DIRECT P2P PATH WHEN AVAILABLE
          </div>
        </div>
      )}

      {view === 'join' && (
        <div className="col">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <Btn ghost sm onClick={() => { setView('home'); setCode('') }}>
              &lt; BACK
            </Btn>
            <span className="screen__sub">ENTER CONNECTION TICKET</span>
          </div>

          <input
            className="input large"
            value={code}
            onChange={e => { setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40)); setJoinError('') }}
            onKeyDown={e => { if (e.key === 'Enter') handleJoin() }}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
            maxLength={40}
            autoFocus
            spellCheck={false}
          />

          {joinError && (
            <div style={{ fontSize: 12, color: '#fff', fontFamily: 'monospace' }}>{joinError}</div>
          )}
          {errorMsg && (
            <div style={{ fontSize: 12, color: '#fff', fontFamily: 'monospace' }}>ERROR: {errorMsg}</div>
          )}

          <Btn
            onClick={handleJoin}
            disabled={code.replace(/-/g, '').length < 20}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            JOIN
          </Btn>
        </div>
      )}
    </div>
  )
}
