import { useP2PStore } from '../store/useP2PStore'
import { Spinner, Divider, Btn } from '../components/Ui'

interface Props { joining?: boolean }

export default function JoinScreen({ joining }: Props) {
  const { state, disconnect } = useP2PStore()

  return (
    <div className="screen" style={{ maxWidth: 480, justifyContent: 'center' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 32 }}>
          <Spinner />
        </div>

        <div style={{ fontFamily: 'monospace', fontSize: 16, marginBottom: 12 }}>
          {state === 'joining'    && 'FETCHING SESSION...'}
          {state === 'connecting' && 'ESTABLISHING P2P CONNECTION...'}
        </div>

        <div className="screen__sub">
          {state === 'joining'    && 'DECODING DIRECT ENDPOINT TICKET'}
          {state === 'connecting' && 'AUTHENTICATING ENCRYPTED UDP SESSION'}
        </div>

        <Divider />

        <Btn ghost sm onClick={disconnect} style={{ marginTop: 16 }}>
          CANCEL
        </Btn>
      </div>
    </div>
  )
}
