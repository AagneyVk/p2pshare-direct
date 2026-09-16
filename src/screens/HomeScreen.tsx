import { useEffect, useState } from 'react'
import { useP2PStore } from '../store/useP2PStore'
import { Btn, Divider } from '../components/Ui'
import { getNativeBridge } from '../native/NativeBridge'

export default function HomeScreen() {
  const { createSession, joinSession, state, errorMsg, clearError } = useP2PStore()
  const [view, setView] = useState<'home' | 'join'>('home')
  const [code, setCode] = useState('')
  const [joinError, setJoinError] = useState('')
  const [updateMessage, setUpdateMessage] = useState('')
  const [updateStage, setUpdateStage] = useState<'check' | 'download' | 'install'>('check')
  const [updateBusy, setUpdateBusy] = useState(false)
  const bridge = getNativeBridge()

  useEffect(() => {
    bridge?.updateInfo?.().then(info => {
      setUpdateMessage(info.packaged
        ? `P2P SHARE ${info.version}`
        : `SOURCE BUILD ${info.version} · USE GIT PULL OR INSTALL A RELEASE`)
    }).catch(() => setUpdateMessage('UPDATE STATUS UNAVAILABLE'))
  }, [])

  const handleUpdate = async () => {
    if (!bridge || updateBusy) return
    setUpdateBusy(true)
    try {
      if (updateStage === 'check') {
        setUpdateMessage('CHECKING VERIFIED GITHUB RELEASES…')
        const release = await bridge.checkForUpdate?.()
        if (release) {
          setUpdateMessage(`UPDATE AVAILABLE · ${release.tag}`)
          setUpdateStage('download')
        } else setUpdateMessage('YOU ARE ON THE LATEST RELEASE')
      } else if (updateStage === 'download') {
        setUpdateMessage('DOWNLOADING AND VERIFYING SHA-256…')
        const result = await bridge.downloadUpdate?.()
        setUpdateMessage(`VERIFIED ${result?.tag ?? 'UPDATE'} · READY TO INSTALL`)
        setUpdateStage('install')
      } else {
        setUpdateMessage('STARTING VERIFIED INSTALLER…')
        await bridge.installUpdate?.()
      }
    } catch (error) {
      setUpdateMessage(`UPDATE ERROR · ${error instanceof Error ? error.message : String(error)}`)
    } finally { setUpdateBusy(false) }
  }

  const handleCreate = async () => {
    clearError()
    await createSession()
  }

  const handleJoin = async () => {
    if (code.replace(/-/g, '').trim().length < 20) { setJoinError('ENTER THE FULL CONNECTION TICKET'); return }
    setJoinError('')
    clearError()
    await joinSession(code.trim())
  }

  return (
    <div className="screen" style={{ justifyContent: 'center', maxWidth: 480 }}>
      <div style={{ marginBottom: 48 }}>
        <div className="screen__title">P2P SHARE</div>
        <div className="screen__sub" style={{ marginTop: 6 }}>
          {bridge?.transport === 'quic' ? 'DIRECT QUIC · WINDOWS ↔ ANDROID · VERIFIED FILES' : 'LEGACY DESKTOP TRANSPORT'}
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

          {bridge?.updateInfo && (
            <div className="col" style={{ gap: 8 }}>
              <div className="screen__sub" style={{ textAlign: 'center', lineHeight: 1.6 }}>{updateMessage}</div>
              <Btn ghost sm disabled={updateBusy} onClick={handleUpdate} style={{ width: '100%', justifyContent: 'center' }}>
                {updateBusy ? 'PLEASE WAIT…' : updateStage === 'install' ? 'INSTALL UPDATE' : updateStage === 'download' ? 'DOWNLOAD UPDATE' : 'CHECK FOR UPDATES'}
              </Btn>
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
            onChange={e => { setCode(e.target.value.slice(0, 8192)); setJoinError('') }}
            onKeyDown={e => { if (e.key === 'Enter') handleJoin() }}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
            maxLength={8192}
            aria-label="Connection ticket"
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
