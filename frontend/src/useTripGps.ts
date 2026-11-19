import { useEffect, useState, useSyncExternalStore } from 'react'

export type GpsFix = { lat: number; lon: number; accuracy: number; timestamp: number }

function observeVisibility(update: () => void) {
  document.addEventListener('visibilitychange', update)
  return () => document.removeEventListener('visibilitychange', update)
}

export function useTripGps(active: boolean) {
  const [fix, setFix] = useState<GpsFix | null>(null)
  const [message, setMessage] = useState('')
  const visible = useSyncExternalStore(observeVisibility, () => !document.hidden)
  useEffect(() => {
    if (!active || !navigator.geolocation) return
    let cancelled = false
    let expiry = 0
    let watch: number | undefined
    let latest = 0
    queueMicrotask(() => {
      if (cancelled) return
      setFix(null)
      setMessage('')
      try {
        watch = navigator.geolocation.watchPosition(({ coords, timestamp }) => {
          if (cancelled) return
          const { latitude: lat, longitude: lon, accuracy } = coords
          if (![lat, lon, accuracy, timestamp].every(Number.isFinite) || accuracy < 0
            || timestamp <= latest || Date.now() - timestamp > 30_000) return
          latest = timestamp
          clearTimeout(expiry)
          setFix({ lat, lon, accuracy, timestamp })
          setMessage('')
          expiry = window.setTimeout(() => {
            setFix(null)
            setMessage('GPS signal is stale. Waiting for a new location.')
          }, 30_000)
        }, (error) => {
          if (cancelled) return
          if (error.code === 1) setFix(null)
          setMessage(error.code === 1
            ? 'Location permission is off. Allow location in your browser to follow this trip.'
            : 'Waiting for a GPS signal.')
        }, { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 })
      } catch {
        setMessage('Could not start live location. Check the browser location settings.')
      }
    })
    return () => {
      cancelled = true
      clearTimeout(expiry)
      if (watch !== undefined) navigator.geolocation.clearWatch(watch)
    }
  }, [active])
  const status = !active ? '' : !visible ? 'Live GPS resumes when this tab is visible.'
    : !navigator.geolocation ? 'Live location is unavailable in this browser.' : message
  return { fix: active && visible ? fix : null, message: status }
}
