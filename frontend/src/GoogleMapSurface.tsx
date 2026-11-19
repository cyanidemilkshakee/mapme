import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Tooltip from '@mui/material/Tooltip'
import type { Instance as PopperInstance } from '@popperjs/core'
import { Icon } from './MaterialIcons'
import { fahrenheitFromCelsius, isTemperature, TEMPERATURE_GRADIENT, TEMPERATURE_STOPS, temperatureRaster } from './temperatureHeatmap'
import type { TemperatureHeatmap } from './temperatureHeatmap'

export type MapPoint = google.maps.LatLngLiteral
export type MapDriverDetails = { name: string; vehicleNumber: string; employeeId: string }
export type MapPin = { id: string; position: MapPoint; label: string; title: string; color: string; onClick: () => void; driverDetails?: MapDriverDetails }
export type MapCheckpoint = { position: MapPoint; index: number; color: string; pattern?: 'dash' | 'dot' }
export type MapRouteLine = { coordinates: [number, number][]; index: number }
export type MapRoute = { id: string; paths: [number, number][][] }
export type MapPopup = { position: MapPoint; title: string; content: ReactNode }

type MapWindow = Window & { __mapmeMapReady?: () => void; gm_authFailure?: () => void }
const authEvent = 'mapme-maps-auth'
const authMessage = 'Google Maps rejected the browser key. Check HTTP referrer restrictions, Maps JavaScript API access, and billing.'
const coldest = TEMPERATURE_STOPS[0].celsius
const hottest = TEMPERATURE_STOPS[TEMPERATURE_STOPS.length - 1].celsius
const temperatureTicks = Array.from({ length: 5 }, (_, index) => coldest + (hottest - coldest) * index / 4)
const mapBounds: google.maps.LatLngBoundsLiteral = {
  north: 85.05112878,
  south: -85.05112878,
  // Google Maps treats the exact -180/180 pair as an unrestricted longitude range.
  west: -179.999999,
  east: 179.999999,
}
let pendingMap: Promise<typeof google.maps> | undefined

function loadGoogleMaps() {
  if (window.google?.maps?.Map) return Promise.resolve(window.google.maps)
  pendingMap ??= (async () => {
    const response = await fetch('/api/maps/config', { cache: 'no-store' })
    if (!response.ok) throw new Error('Could not load the Google Maps configuration.')
    const { browserKey } = await response.json() as { browserKey?: string }
    if (!browserKey) throw new Error('Set GOOGLE_MAPS_BROWSER_KEY on the server to display the Google map.')
    return new Promise<typeof google.maps>((resolve, reject) => {
      const mapWindow = window as MapWindow
      const script = document.createElement('script')
      const timeout = window.setTimeout(() => fail('Google Maps did not load. Check your network connection.'), 15_000)
      function cleanUp() {
        clearTimeout(timeout)
        delete mapWindow.__mapmeMapReady
      }
      function fail(message: string) {
        cleanUp()
        script.remove()
        reject(new Error(message))
      }
      mapWindow.__mapmeMapReady = () => {
        cleanUp()
        if (window.google?.maps?.Map) resolve(window.google.maps)
        else fail('Google Maps did not initialize.')
      }
      mapWindow.gm_authFailure = () => {
        window.dispatchEvent(new Event(authEvent))
        fail(authMessage)
      }
      const params = new URLSearchParams({ key: browserKey, v: 'quarterly', loading: 'async', callback: '__mapmeMapReady' })
      script.src = `https://maps.googleapis.com/maps/api/js?${params}`
      script.async = true
      script.onerror = () => fail('Google Maps could not be downloaded.')
      document.head.append(script)
    })
  })().catch((error: unknown) => {
    pendingMap = undefined
    throw error
  })
  return pendingMap
}

function fitRoute(map: google.maps.Map, paths: [number, number][][]) {
  const longitudes: number[] = []
  let south = 90, north = -90
  for (const path of paths) for (const [lat, lon] of path) {
    south = Math.min(south, lat)
    north = Math.max(north, lat)
    longitudes.push(((lon % 360) + 360) % 360)
  }
  if (!longitudes.length) return
  longitudes.sort((a, b) => a - b)
  const wrap = (x: number) => ((x + 180) % 360 + 360) % 360 - 180
  let largestGap = -1
  let gapAfter = 0
  for (let index = 0; index < longitudes.length; index += 1) {
    const next = longitudes[(index + 1) % longitudes.length] + (index === longitudes.length - 1 ? 360 : 0)
    const gap = next - longitudes[index]
    if (gap > largestGap) {
      largestGap = gap
      gapAfter = index
    }
  }
  const west = wrap(longitudes[(gapAfter + 1) % longitudes.length])
  const east = wrap(longitudes[gapAfter])
  map.fitBounds({ south, north, west, east }, {
    top: 36, left: 32, bottom: 65, right: 64,
  })
}

function MarkerOverlay({ map, pin }: { map: google.maps.Map; pin: MapPin }) {
  const [anchor] = useState(() => {
    const element = document.createElement('div')
    element.className = 'google-map-pin-anchor'
    return element
  })
  const popper = useRef<PopperInstance | null>(null)
  const position = useRef(pin.position)
  const repaint = useRef<() => void>(() => {})
  const { lat, lng } = pin.position
  useEffect(() => {
    const overlay = new google.maps.OverlayView()
    overlay.onAdd = () => {
      google.maps.OverlayView.preventMapHitsAndGesturesFrom(anchor)
      overlay.getPanes()?.overlayMouseTarget.append(anchor)
    }
    overlay.draw = () => {
      const point = overlay.getProjection()?.fromLatLngToDivPixel(position.current)
      if (point) {
        anchor.style.transform = `translate(${point.x}px, ${point.y}px) translate(-50%, -50%)`
        void popper.current?.update()
      }
    }
    overlay.onRemove = () => anchor.remove()
    repaint.current = () => overlay.draw()
    overlay.setMap(map)
    return () => {
      overlay.setMap(null)
      repaint.current = () => {}
    }
  }, [anchor, map])
  useEffect(() => {
    position.current = { lat, lng }
    repaint.current()
  }, [lat, lng])

  const boundary = map.getDiv()
  const modifiers = useMemo(() => [
    { name: 'flip', options: { boundary, padding: 8, fallbackPlacements: ['left', 'bottom', 'top'] } },
    { name: 'preventOverflow', options: { boundary, padding: 8 } },
  ], [boundary])
  const { driverDetails } = pin
  const button = <button type="button" className="google-map-pin" aria-label={pin.title}
    title={driverDetails ? undefined : pin.title} style={{ backgroundColor: pin.color }} onClick={pin.onClick}>{pin.label}</button>
  return createPortal(driverDetails ? <Tooltip
    title={<div className="map-driver-pin-card">
      <div className="map-driver-pin-heading"><Icon name="truck" size={21} /><strong>Driver</strong><span>{driverDetails.name}</span></div>
      <dl>
        <div><dt>Vehicle number</dt><dd>{driverDetails.vehicleNumber}</dd></div>
        <div><dt>Employee ID</dt><dd>{driverDetails.employeeId}</dd></div>
      </dl>
    </div>}
    describeChild placement="right" enterDelay={0} leaveDelay={150} enterTouchDelay={0} leaveTouchDelay={6000}
    slotProps={{
      popper: {
        container: boundary.parentElement ?? boundary, modifiers, popperRef: popper,
        sx: { '&[data-popper-reference-hidden]': { visibility: 'hidden', pointerEvents: 'none' } },
      },
      tooltip: { sx: { backgroundColor: 'transparent', padding: 0 } },
    }}
  >{button}</Tooltip> : button, anchor)
}

function InfoPopup({ map, popup, onClose }: { map: google.maps.Map; popup: MapPopup; onClose: () => void }) {
  const [container] = useState(() => {
    const element = document.createElement('div')
    element.className = 'google-popup'
    return element
  })
  const close = useEffectEvent(() => onClose())
  const { lat, lng } = popup.position
  useEffect(() => {
    const window = new google.maps.InfoWindow({ content: container, ariaLabel: popup.title, position: { lat, lng }, maxWidth: 330 })
    const listener = window.addListener('closeclick', close)
    window.open({ map, shouldFocus: false })
    return () => { listener.remove(); window.close() }
  }, [container, lat, lng, map, popup.title])
  return createPortal(popup.content, container)
}

type SurfaceProps = {
  center: MapPoint
  temperatureUnit: 'c' | 'f'
  focus?: { position: MapPoint; zoom?: number; request: number } | null
  satellite: boolean
  heatmapEnabled: boolean
  onToggleHeatmap: () => void
  theme: 'light' | 'dark'
  paths: [number, number][][]
  routes: MapRoute[]
  recommendedRouteId: string | null
  selectedRouteId: string | null
  hoveredRouteId: string | null
  segments: MapRouteLine[]
  checkpoints: MapCheckpoint[]
  pins: MapPin[]
  temperature: TemperatureHeatmap | null
  activeCheckpoint: number | null
  gps?: { position: MapPoint; accuracy: number; follow: boolean } | null
  popup: MapPopup | null
  onPopupClose: () => void
  onReady: (map: google.maps.Map | null) => void
  onMapClick: (position: MapPoint, placeId?: string) => void
  onCheckpoint: (index: number) => void
  onRoute: (id: string) => void
  onRouteHover: (id: string | null) => void
  onPan: () => void
}

function TemperatureMapScale({ unit, routes }: { unit: 'c' | 'f'; routes: MapRoute[] }) {
  const label = (value: number) => unit === 'c'
    ? `${value}°C`
    : `${Math.round(fahrenheitFromCelsius(value))}°F`
  return <div className={`temperature-map-scale${routes.length ? ' has-routes' : ''}`} aria-label="Current air temperature scale">
    <strong>Current air temperature</strong>
    <div className="temperature-map-scale-gradient" style={{ backgroundImage: TEMPERATURE_GRADIENT }} aria-hidden="true" />
    <div className="temperature-map-scale-ticks" aria-hidden="true">
      {temperatureTicks.map((value) => <span key={value}>{label(value)}</span>)}
    </div>
  </div>
}

function weatherRuns(segments: MapRouteLine[], checkpoints: MapCheckpoint[]) {
  const weatherByIndex = new Map(checkpoints.map((checkpoint) => [checkpoint.index, checkpoint]))
  const runs: { coordinates: [number, number][]; color: string }[] = []
  let active: { coordinates: [number, number][]; color: string } | null = null
  const flush = () => { if (active) runs.push(active); active = null }
  const ordered = [...segments].sort((a, b) => a.index - b.index)
  for (const segment of ordered) {
    const weather = weatherByIndex.get(segment.index)
    if (!weather || weather.pattern === 'dot' || segment.coordinates.length < 2) {
      flush()
      continue
    }
    const first = segment.coordinates[0]
    const last = active?.coordinates.at(-1)
    const connected = last && Math.abs(last[0] - first[0]) < 1e-5 && Math.abs(last[1] - first[1]) < 1e-5
    if (active && active.color === weather.color && connected) {
      active.coordinates.push(...segment.coordinates.slice(1))
    } else {
      flush()
      active = { coordinates: [...segment.coordinates], color: weather.color }
    }
  }
  flush()
  return runs
}

function NativeRouteLines({ map, routes, paths, recommendedRouteId, selectedRouteId, hoveredRouteId, segments, checkpoints, theme, onRoute, onRouteHover }: Pick<SurfaceProps,
  'routes' | 'paths' | 'recommendedRouteId' | 'selectedRouteId' | 'hoveredRouteId' | 'segments' | 'checkpoints' | 'theme' | 'onRoute' | 'onRouteHover'
> & { map: google.maps.Map }) {
  const selectRoute = useEffectEvent(onRoute)
  const hoverRoute = useEffectEvent(onRouteHover)
  useEffect(() => {
    const polylines: google.maps.Polyline[] = []
    const listeners: google.maps.MapsEventListener[] = []
    const routeOptions = routes.length ? routes : paths.length ? [{ id: 'active-route', paths }] : []
    const ordered = [...routeOptions].sort((a, b) => {
      const rank = (id: string) => id === selectedRouteId ? 2 : id === recommendedRouteId ? 1 : 0
      return rank(a.id) - rank(b.id)
    })
    const mapPath = (coordinates: [number, number][]) => coordinates.map(([lat, lng]) => new google.maps.LatLng(lat, lng, true))
    for (const route of ordered) {
      const emphasized = route.id === selectedRouteId || route.id === recommendedRouteId
      const color = hoveredRouteId === route.id ? '#00a6a0' : emphasized ? '#1765d1' : theme === 'dark' ? '#8b99a9' : '#687685'
      const width = emphasized || hoveredRouteId === route.id ? 7 : 5
      for (const coordinates of route.paths) {
        if (coordinates.length < 2) continue
        const path = mapPath(coordinates)
        const outline = new google.maps.Polyline({
          map, path, clickable: false, geodesic: false,
          strokeColor: theme === 'dark' ? '#1c2733' : '#ffffff', strokeOpacity: 0.94, strokeWeight: width + 4,
          zIndex: emphasized ? 21 : 10,
        })
        const line = new google.maps.Polyline({
          map, path, clickable: true, geodesic: false,
          strokeColor: color, strokeOpacity: 0.98, strokeWeight: width,
          zIndex: emphasized ? 22 : 11,
        })
        polylines.push(outline, line)
        if (route.id !== 'active-route') {
          listeners.push(line.addListener('click', (event: google.maps.PolyMouseEvent) => {
            event.stop()
            selectRoute(route.id)
          }))
          listeners.push(line.addListener('mouseover', () => hoverRoute(route.id)))
          listeners.push(line.addListener('mouseout', () => hoverRoute(null)))
        }
      }
    }

    for (const run of weatherRuns(segments, checkpoints)) {
      if (run.coordinates.length < 2) continue
      polylines.push(new google.maps.Polyline({
        map, path: mapPath(run.coordinates), clickable: false, geodesic: false,
        strokeColor: run.color, strokeOpacity: 1, strokeWeight: 5, zIndex: 30,
      }))
    }
    return () => {
      listeners.forEach((listener) => listener.remove())
      polylines.forEach((polyline) => polyline.setMap(null))
    }
  }, [map, routes, paths, recommendedRouteId, selectedRouteId, hoveredRouteId, segments, checkpoints, theme])
  return null
}

function TrafficCanvas({ map, checkpoints, temperature, activeCheckpoint, onMapClick, onCheckpoint }: Pick<SurfaceProps,
  'checkpoints' | 'temperature' | 'activeCheckpoint' | 'onMapClick' | 'onCheckpoint'
> & { map: google.maps.Map }) {
  const state = useRef({ checkpoints, temperature, activeCheckpoint })
  const render = useRef<() => void>(() => {})
  const click = useEffectEvent(onMapClick)
  const select = useEffectEvent(onCheckpoint)
  useEffect(() => {
    const canvas = document.createElement('canvas')
    canvas.className = 'google-weather-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    const ctx = canvas.getContext('2d')
    const temperatureCanvas = document.createElement('canvas')
    const temperatureContext = temperatureCanvas.getContext('2d')
    let temperatureSource: TemperatureHeatmap | null = null
    let temperatureBounds: { north: number; south: number; west: number; east: number } | null = null
    const overlay = new google.maps.OverlayView()
    let frame = 0
    let grid = new Map<string, { x: number; y: number; index: number }[]>()
    const cellKey = (x: number, y: number) => `${Math.floor(x / 24)}:${Math.floor(y / 24)}`
    let origin: google.maps.Point | null = null

    function draw() {
      frame = 0
      const projection = overlay.getProjection()
      const center = map.getCenter()
      if (!ctx || !projection || !center) return
      const { clientWidth: width, clientHeight: height } = map.getDiv()
      if (!width || !height) return
      const topLeft = projection.fromContainerPixelToLatLng(new google.maps.Point(0, 0), true)
      if (!topLeft) return
      origin = projection.fromLatLngToDivPixel(topLeft)
      if (!origin) return
      canvas.style.transform = `translate(${origin.x}px, ${origin.y}px)`
      const scale = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.round(width * scale), h = Math.round(height * scale)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        canvas.style.width = `${width}px`
        canvas.style.height = `${height}px`
      }
      ctx.resetTransform()
      ctx.clearRect(0, 0, w, h)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)

      const scene = state.current
      const wrap = (longitude: number, near: number) => longitude + 360 * Math.round((near - longitude) / 360)
      const pixelsPerWorld = projection.getWorldWidth()
      const project = (latitude: number, longitude: number) =>
        projection.fromLatLngToDivPixel(new google.maps.LatLng(latitude, longitude, true))
      if (temperatureContext && scene.temperature !== temperatureSource) {
        temperatureSource = scene.temperature
        temperatureBounds = null
        const raster = temperatureSource && temperatureRaster(temperatureSource)
        if (raster && temperatureSource) {
          temperatureCanvas.width = temperatureCanvas.height = raster.size
          temperatureContext.putImageData(new ImageData(raster.pixels, raster.size, raster.size), 0, 0)
          temperatureBounds = { ...temperatureSource.grid, north: raster.north, south: raster.south }
        }
      }
      if (temperatureBounds && pixelsPerWorld > 0) {
        const span = temperatureBounds.east - temperatureBounds.west
        const west = wrap(temperatureBounds.west, center.lng() - span / 2)
        const top = project(temperatureBounds.north, west)
        const bottom = project(temperatureBounds.south, west)
        if (top && bottom) {
          const left = top.x - origin.x
          const fieldWidth = span / 360 * pixelsPerWorld
          const firstVisible = left + Math.ceil((-fieldWidth - left) / pixelsPerWorld) * pixelsPerWorld
          ctx.globalAlpha = temperatureSource?.global_view ? 0.78 : 0.68
          for (let x = firstVisible; x < width; x += pixelsPerWorld) {
            ctx.drawImage(temperatureCanvas, x, top.y - origin.y, fieldWidth, bottom.y - top.y)
          }
          ctx.globalAlpha = 1
        }
      }

      grid = new Map()
      for (const point of scene.checkpoints) {
        const projectedPoint = project(point.position.lat, wrap(point.position.lng, center.lng()))
        if (!projectedPoint) continue
        const x = projectedPoint.x - origin.x, y = projectedPoint.y - origin.y
        if (x < -25 || x > width + 25 || y < -25 || y > height + 25) continue
        const key = cellKey(x, y)
        const neighbors = grid.get(key) ?? []
        neighbors.push({ x, y, index: point.index })
        grid.set(key, neighbors)
        ctx.beginPath()
        if (point.pattern === 'dash') ctx.rect(x - 5, y - 5, 10, 10)
        else ctx.arc(x, y, point.pattern === 'dot' ? 3.5 : 5, 0, 2 * Math.PI)
        ctx.fillStyle = point.pattern === 'dot' ? '#8793a0' : point.color
        ctx.fill()
        ctx.strokeStyle = point.pattern === 'dot' ? '#23303b' : '#fff'
        ctx.lineWidth = point.pattern === 'dot' ? 1 : 2
        ctx.stroke()
        if (point.index === scene.activeCheckpoint) {
          ctx.beginPath()
          ctx.arc(x, y, 10, 0, 2 * Math.PI)
          ctx.strokeStyle = '#174a8d'
          ctx.lineWidth = 3
          ctx.stroke()
        }
      }
    }
    function schedule() {
      if (!frame) frame = window.requestAnimationFrame(draw)
    }
    overlay.onAdd = () => overlay.getPanes()?.overlayLayer.append(canvas)
    overlay.draw = schedule
    overlay.onRemove = () => canvas.remove()
    render.current = schedule
    overlay.setMap(map)
    const listener = map.addListener('click', (event: google.maps.MapMouseEvent | google.maps.IconMouseEvent) => {
      if (!event.latLng) return
      const point = overlay.getProjection()?.fromLatLngToContainerPixel(event.latLng)
      let nearest: number | undefined
      if (point) {
        const radius = window.matchMedia('(any-pointer: coarse)').matches ? 20 : 13
        let best = radius * radius
        for (let row = -1; row <= 1; row++) for (let column = -1; column <= 1; column++) {
          for (const neighbor of grid.get(cellKey(point.x + column * 24, point.y + row * 24)) ?? []) {
            const squared = (point.x - neighbor.x) ** 2 + (point.y - neighbor.y) ** 2
            if (squared <= best) { best = squared; nearest = neighbor.index }
          }
        }
      }
      if ('placeId' in event) event.stop()
      if (nearest !== undefined) select(nearest)
      else click(event.latLng.toJSON(), 'placeId' in event ? event.placeId ?? undefined : undefined)
    })
    return () => {
      cancelAnimationFrame(frame)
      listener.remove()
      overlay.setMap(null)
      render.current = () => {}
    }
  }, [map])
  useEffect(() => {
    state.current = { checkpoints, temperature, activeCheckpoint }
    render.current()
  }, [checkpoints, temperature, activeCheckpoint])
  return null
}

export default function GoogleMapSurface(props: SurfaceProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [map, setMap] = useState<google.maps.Map | null>(null)
  const [error, setError] = useState('')
  const [attempt, retry] = useState(0)
  const firstCenter = useEffectEvent(() => props.center)
  const onReady = useEffectEvent(props.onReady)
  const onPan = useEffectEvent(props.onPan)
  const fitPaths = useMemo(() => props.routes.flatMap((route) => route.paths), [props.routes])
  const fitKey = useMemo(() => [...new Set(fitPaths.map((path) => {
    const first = path[0]
    const last = path.at(-1)
    return first && last
      ? `${first[0].toFixed(3)},${first[1].toFixed(3)}:${last[0].toFixed(3)},${last[1].toFixed(3)}`
      : ''
  }).filter(Boolean))].sort().join('|'), [fitPaths])
  const lastFit = useRef<{ map: google.maps.Map; key: string } | null>(null)
  useEffect(() => {
    let active = true
    let drag: google.maps.MapsEventListener | undefined
    const host = ref.current
    if (!host) return
    const unauthorized = () => { if (active) setError(authMessage) }
    window.addEventListener(authEvent, unauthorized)
    void loadGoogleMaps().then((maps) => {
      if (!active) return
      const instance = new maps.Map(host, {
        center: firstCenter(), zoom: 1, minZoom: 1, maxZoom: 18, streetViewControl: false, fullscreenControl: false,
        mapTypeControl: false, cameraControl: false, zoomControl: false, rotateControl: false, scaleControl: true, gestureHandling: 'greedy',
        restriction: { latLngBounds: mapBounds, strictBounds: true },
        colorScheme: props.theme === 'dark' ? 'DARK' : 'LIGHT',
      })
      drag = instance.addListener('dragstart', onPan)
      setMap(instance)
      onReady(instance)
    }).catch((reason: Error) => { if (active) setError(reason.message) })
    return () => {
      active = false
      window.removeEventListener(authEvent, unauthorized)
      drag?.remove()
      onReady(null)
      host.replaceChildren()
      setMap(null)
    }
  }, [attempt, props.theme])
  useEffect(() => {
    map?.setMapTypeId(props.satellite ? 'hybrid' : 'roadmap')
  }, [map, props.satellite])
  useEffect(() => {
    if (!map) return
    if (!fitPaths.length) {
      lastFit.current = null
      return
    }
    if (lastFit.current?.map === map && lastFit.current.key === fitKey) return
    fitRoute(map, fitPaths)
    lastFit.current = { map, key: fitKey }
  }, [map, fitKey, fitPaths])
  const focus = props.focus
  useEffect(() => {
    if (!map || !focus) return
    map.setCenter(focus.position)
    if (focus.zoom) map.setZoom(focus.zoom)
  }, [map, focus])
  const fix = props.gps
  const accuracyCircle = useRef<google.maps.Circle | null>(null)
  useEffect(() => {
    if (!map || !fix) {
      accuracyCircle.current?.setMap(null)
      accuracyCircle.current = null
      return
    }
    accuracyCircle.current ??= new google.maps.Circle({
      map, clickable: false, strokeColor: '#0956b2', strokeWeight: 1, fillOpacity: 0.14, fillColor: '#1778df',
    })
    accuracyCircle.current.setOptions({ map, center: fix.position, radius: fix.accuracy })
    if (fix.follow) map.setCenter(fix.position)
  }, [map, fix])
  useEffect(() => () => { accuracyCircle.current?.setMap(null); accuracyCircle.current = null }, [map])
  return <>
    <div className="google-map-canvas" ref={ref} aria-label="Google Maps" />
    {error ? <div className="google-map-status" role="status">
      <p>{error}</p>
      <button type="button" onClick={() => { setError(''); retry((n) => n + 1) }}>Retry map</button>
    </div> : !map && <div className="google-map-status" role="status">Loading Google Maps…</div>}
    {map && !error && <>
      {props.heatmapEnabled && props.temperature?.points.some(({ temperature_f }) => isTemperature(temperature_f)) &&
        <TemperatureMapScale unit={props.temperatureUnit} routes={props.routes} />}
      <div className="map-zoom-controls" role="group" aria-label="Map controls">
        <button type="button" className="map-weather-toggle" aria-label="Temperature heatmap" aria-pressed={props.heatmapEnabled} title={props.heatmapEnabled ? 'Hide temperature heatmap' : 'Show temperature heatmap'} onClick={props.onToggleHeatmap}><Icon name="weather" size={20} /></button>
        <button type="button" aria-label="Zoom in" onClick={() => map.setZoom(Math.min(18, (map.getZoom() ?? 5) + 1))}><Icon name="plus" size={20} /></button>
        <button type="button" aria-label="Zoom out" onClick={() => map.setZoom(Math.max(1, (map.getZoom() ?? 5) - 1))}><Icon name="minus" size={20} /></button>
      </div>
      <NativeRouteLines
        map={map}
        routes={props.routes}
        paths={props.paths}
        recommendedRouteId={props.recommendedRouteId}
        selectedRouteId={props.selectedRouteId}
        hoveredRouteId={props.hoveredRouteId}
        segments={props.segments}
        checkpoints={props.checkpoints}
        theme={props.theme}
        onRoute={props.onRoute}
        onRouteHover={props.onRouteHover}
      />
      <TrafficCanvas
        map={map}
        checkpoints={props.checkpoints}
        temperature={props.temperature}
        activeCheckpoint={props.activeCheckpoint}
        onMapClick={props.onMapClick}
        onCheckpoint={props.onCheckpoint}
      />
      {props.pins.map((pin) => <MarkerOverlay map={map} key={pin.id} pin={pin} />)}
      {props.popup && <InfoPopup map={map} popup={props.popup} onClose={props.onPopupClose} />}
    </>}
  </>
}
