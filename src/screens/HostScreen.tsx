import { useP2PStore } from '../store/useP2PStore'
import { useState } from 'react'
import { getNativeBridge } from '../native/NativeBridge'
import { Btn, CodeDisplay, Spinner, Badge, Divider } from '../components/Ui'

export default function HostScreen() {
  const { sessionCode, state, disconnect } = useP2PStore()
  const [copyStatus, setCopyStatus] = useState('')

  const copyCode = async () => {
    if (!sessionCode) return
    try {
      const bridge = getNativeBridge()
      if (bridge?.copyTicket) await bridge.copyTicket()
      else await navigator.clipboard.writeText(sessionCode)
      setCopyStatus('Ticket copied. Share it privately.')
    } catch { setCopyStatus('Could not copy. Select the ticket and copy it manually.') }
  }

  // Show connecting state inline instead of switching screens
  // This prevents the component from unmounting exactly when ICE connects
  const statusText =
    state === 'creating'   ? '● CREATING...'    :
    state === 'waiting'    ? '● WAITING'         :
    state === 'connecting' ? '● CONNECTING...'   : '● ...'

  return (
    <div className="screen" style={{ maxWidth: 480, justifyContent: 'center' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 40 }}>
        <Btn ghost sm onClick={disconnect}>&lt; CANCEL</Btn>
        <Badge text={statusText} dim={state === 'creating'} />
      </div>

      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <div className="screen__sub" style={{ marginBottom: 20, letterSpacing: '0.1em' }}>
          SHARE THIS CONNECTION TICKET WITH THE OTHER DEVICE
        </div>

        {state === 'creating' ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 100 }}>
            <Spinner />
          </div>
        ) : (
          <CodeDisplay code={sessionCode} />
        )}

        {sessionCode && (
          <div style={{ marginTop: 12 }}>
            <Btn ghost sm onClick={copyCode}>COPY CODE</Btn>
            <p role="status" className="screen__sub">{copyStatus}</p>
          </div>
        )}
        {sessionCode.startsWith('p2p3:') && <p className="screen__sub">PRIVATE · EXPIRES IN 5 MINUTES · ONE GUEST<br />Both desktops must use QUIC preview on a reachable direct network. Creating a session permits its guest to send files.</p>}
      </div>

      <Divider />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', marginTop: 20 }}>
        {state === 'waiting' && (
          <>
            <Spinner />
            <span className="screen__sub">WAITING FOR OTHER DEVICE TO JOIN...</span>
          </>
        )}
        {state === 'connecting' && (
          <>
            <Spinner />
            <span style={{ fontFamily: 'monospace', fontSize: 13 }}>ESTABLISHING P2P CONNECTION...</span>
          </>
        )}
      </div>

      <div style={{ marginTop: 'auto', paddingTop: 40 }}>
        <Divider />
        <div className="screen__sub" style={{ marginTop: 12, lineHeight: 1.8 }}>
          HOW IT WORKS:<br />
          1. OTHER DEVICE OPENS APP AND CLICKS "JOIN SESSION"<br />
          2. THEY ENTER YOUR CONNECTION TICKET<br />
          3. THE DIRECT ENCRYPTED CONNECTION IS AUTHENTICATED AUTOMATICALLY
        </div>
      </div>
    </div>
  )
}
