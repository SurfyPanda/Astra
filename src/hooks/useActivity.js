import { useEffect, useState } from 'react'

/**
 * Live feed of what the local agent runtime is doing (tool calls, permissions, turn
 * lifecycle) streamed from the OpenCode bridge at /proxy/activity.
 */
export function useActivity(limit = 24) {
  const [events, setEvents] = useState([])
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let source
    try {
      source = new EventSource('/proxy/activity')
    } catch {
      setConnected(false)
      return undefined
    }

    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    source.onmessage = (event) => {
      try {
        const entry = JSON.parse(event.data)
        setEvents((previous) => [entry, ...previous].slice(0, limit))
      } catch {
        // heartbeat line
      }
    }

    return () => source.close()
  }, [limit])

  return { events, connected }
}
