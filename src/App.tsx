import { useEffect } from 'react'
import { useP2PStore } from './store/useP2PStore'
import HomeScreen from './screens/HomeScreen'
import HostScreen from './screens/HostScreen'
import JoinScreen from './screens/JoinScreen'
import ChatScreen from './screens/ChatScreen'

export default function App() {
  const { state, init } = useP2PStore()

  // Init exactly once on mount — guard inside init() prevents double-init
  useEffect(() => {
    init()
  }, [])

  // Screen routing — HostScreen stays mounted through 'connecting' state
  // so it does NOT unmount exactly when ICE connects
  const screen = state === 'connected'
    ? <ChatScreen />
    : state === 'waiting' || state === 'creating' || state === 'connecting'
      ? <HostScreen />
      : state === 'joining'
        ? <JoinScreen joining />
        : <HomeScreen />

  return screen
}
