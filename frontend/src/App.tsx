import { lazy, Suspense, useCallback, useContext, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import CircularProgress from '@mui/material/CircularProgress'
import CssBaseline from '@mui/material/CssBaseline'
import IconButton from '@mui/material/IconButton'
import InputBase from '@mui/material/InputBase'
import Paper from '@mui/material/Paper'
import Slider from '@mui/material/Slider'
import Typography from '@mui/material/Typography'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import { Icon } from './MaterialIcons'
import { buildRouteSegments, geometryDistance, routeGeometry } from './routeGeometry'
import type { RouteGeometryCheckpoint } from './routeGeometry'
import { decodePolyline, readRouteFeed } from './routePlanFeed'
import type { PackedForecast } from './routePlanFeed'
import { recommendRoute } from './routeRecommendation'
import type { RouteMetrics } from './routeRecommendation'
import GoogleMapSurface from './GoogleMapSurface'
import type { MapCheckpoint, MapPin, MapPoint, MapPopup, MapRoute } from './GoogleMapSurface'
import { firstCheckpointAfter, indexRoute, matchRoute } from './routeProgress'
import type { RouteMatch } from './routeProgress'
import { useTripGps } from './useTripGps'
import type { GpsFix } from './useTripGps'
import { riskColors, riskNames } from './weatherRisk'
import type { Risk } from './weatherRisk'
import { isTemperature } from './temperatureHeatmap'
import type { TemperatureHeatmap } from './temperatureHeatmap'
import { TimeZoneContext } from './TimeZoneContext'
import { DEVICE_TIME_ZONE, dateTimeInputValue, formatTime, isValidTimeZone, tripTimeError, wallTimeInstants } from './timeZone'
import './App.css'
import './Planner.css'

const SettingsPage = lazy(() => import('./SettingsPage'))

function createAppTheme(mode: 'light' | 'dark') {
  return createTheme({
    palette: {
      mode,
      primary: { main: mode === 'dark' ? '#c0d3a9' : '#315e47' },
      success: { main: mode === 'dark' ? '#a7c9a9' : '#286344' },
      error: { main: mode === 'dark' ? '#f28b82' : '#b3261e' },
      background: { default: mode === 'dark' ? '#1e231f' : '#f2f0e8', paper: mode === 'dark' ? '#252a27' : '#fffdf8' },
    },
    typography: {
      fontFamily: "'Poppins', 'Avenir Next', sans-serif",
      button: { textTransform: 'none', fontWeight: 500 },
    },
    shape: { borderRadius: 10 },
    components: {
      MuiCssBaseline: { styleOverrides: { body: { margin: 0 } } },
      MuiButtonBase: { defaultProps: { disableRipple: true } },
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    },
  })
}

const PLAYBACK_HOURS = 49

const MAX_TRIP_DESTINATIONS = 5
const MILES_TO_KILOMETERS = 1.609344
const POUNDS_TO_KILOGRAMS = 0.45359237
const KILOGRAMS_TO_POUNDS = 1 / POUNDS_TO_KILOGRAMS
type DistanceUnit = 'mi' | 'km'
type TemperatureUnit = 'f' | 'c'
const DRIVER_DISPLAY = { name: 'Alex Morgan', vehicleNumber: 'TRK-7K42Q', employeeId: 'EMP-9C31X' }

function formatDistance(miles: number, unit: DistanceUnit) {
  const value = unit === 'km' ? miles * MILES_TO_KILOMETERS : miles
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`
}

function formatSpeed(milesPerHour: number | null | undefined, unit: DistanceUnit) {
  if (milesPerHour === null || milesPerHour === undefined) return 'unavailable'
  const value = unit === 'km' ? milesPerHour * MILES_TO_KILOMETERS : milesPerHour
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit === 'km' ? 'km/h' : 'mph'}`
}

function formatPrecipitation(inchesPerHour: number | null | undefined, unit: DistanceUnit) {
  if (inchesPerHour === null || inchesPerHour === undefined) return 'unavailable'
  const metric = unit === 'km'
  const value = metric ? inchesPerHour * 25.4 : inchesPerHour
  return `${value.toLocaleString(undefined, { maximumFractionDigits: metric ? 1 : 2 })} ${metric ? 'mm/hr' : 'in/hr'}`
}

function formatTemperature(fahrenheit: number | null | undefined, unit: TemperatureUnit) {
  if (fahrenheit === null || fahrenheit === undefined) return 'unavailable'
  const value = unit === 'c' ? (fahrenheit - 32) * 5 / 9 : fahrenheit
  return `${Math.round(value)}°${unit.toUpperCase()}`
}

function formatWeight(pounds: number, unit: DistanceUnit) {
  const value = unit === 'km' ? pounds * POUNDS_TO_KILOGRAMS : pounds
  return `${Math.round(value).toLocaleString()} ${unit === 'km' ? 'kg' : 'lb'}`
}

function formatRiskReason(reason: string, unit: DistanceUnit) {
  if (unit === 'mi') return reason
  const number = (value: string, factor: number, fractionDigits = 0) => {
    const parsed = Number(value.replaceAll(',', ''))
    return (parsed * factor).toLocaleString(undefined, { maximumFractionDigits: fractionDigits })
  }
  return reason
    .replace(/([\d,]+(?:\.\d+)?)(?:–([\d,]+(?:\.\d+)?))?(\+)? mph/g, (_match, start: string, end: string | undefined, plus: string | undefined) =>
      `${number(start, MILES_TO_KILOMETERS)}${end ? `–${number(end, MILES_TO_KILOMETERS)}` : ''}${plus ?? ''} km/h`)
    .replace(/([\d,]+(?:\.\d+)?)(?:–([\d,]+(?:\.\d+)?))? in\/hr/g, (_match, start: string, end: string | undefined) =>
      `${number(start, 25.4, 1)}${end ? `–${number(end, 25.4, 1)}` : ''} mm/hr`)
    .replace(/([\d,]+(?:\.\d+)?) lb/g, (_match, value: string) => `${number(value, POUNDS_TO_KILOGRAMS)} kg`)
}

function isTextEntryTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && (
    target.isContentEditable
    || Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
  )
}

type Forecast = {
  offset_hour: number
  risk: Risk
  risk_index: number
  reasons: string[]
  wind_mph: number | null
  rain_in_hr: number | null
  snow_in_hr: number | null
  time: string | null
}

type Checkpoint = RouteGeometryCheckpoint & {
  miles_to_next: number
  latitude: number
  longitude: number
  eta: string
  forecast: Forecast[]
}

type RouteStep = {
  instruction: string
  distance_miles: number
  duration_minutes: number
  start_miles?: number
}

type RouteLeg = {
  start_label: string
  end_label: string
  route_alternative?: number
  available_alternatives?: number
  start_country?: string | null
  end_country?: string | null
  crosses_border?: boolean
  distance_miles: number
  duration_minutes: number
  departure_time: string
  arrival_time: string
  steps: RouteStep[]
  coordinates?: [number, number][]
  encoded_geometry?: string
  geometry_pending?: boolean
}

type RouteOption = {
  id: string
  name: string
  departure_time?: string
  distance_miles: number
  duration_minutes: number
  coordinates: [number, number][]
  steps: RouteStep[]
  legs?: RouteLeg[]
  countries?: string[]
  checkpoints: Checkpoint[]
  metrics_by_hour: RouteMetrics[]
  details_pending?: boolean
  preview_leg_weather?: { risk: Risk; count: number; total: number }[]
  road_legs?: Pick<RouteLeg, 'coordinates' | 'distance_miles'>[]
  playback?: { series: PackedForecast[][]; reasons: string[] }
}

type PlanResult = {
  origin: { lat: number; lon: number; label: string; country?: string }
  destination: { lat: number; lon: number; label: string; country?: string }
  stops?: { lat: number; lon: number; label: string; country?: string }[]
  departure_time: string
  requested_time?: string
  time_mode?: TimeMode
  load_weight_lb: number
  checkpoint_interval_miles: number
  routes: RouteOption[]
  recommended_route_id: string | null
  route_warning?: string | null
  weather_warning?: string | null
  source_notice: string
  routing_source: string
  weather_source: string
}

type PlanUpdate =
  | { type: 'plan'; plan: PlanResult }
  | { type: 'details'; route_id: string; legs: Pick<RouteLeg, 'steps' | 'encoded_geometry'>[]; checkpoints?: Checkpoint[] }
  | { type: 'playback'; route_id: string; series: PackedForecast[][]; reasons: string[]; metrics: RouteMetrics[] }
  | { type: 'playback_error'; route_id: string }

type DisplayedTrip = {
  key: string
  waypointKey: string
  result: PlanResult
  finished: boolean
  failedPlayback: string[]
}

function unpackLeg(leg: RouteLeg): RouteLeg {
  if (!leg.encoded_geometry) return leg
  const { encoded_geometry, ...fields } = leg
  return { ...fields, coordinates: decodePolyline(encoded_geometry), geometry_pending: false }
}

function roadLegs(legs: RouteLeg[] | undefined) {
  return legs?.map(({ coordinates, distance_miles }) => ({ coordinates, distance_miles }))
}

function unpackPlan(plan: PlanResult): PlanResult {
  return { ...plan, routes: plan.routes.map((route) => {
    const legs = route.legs?.map(unpackLeg)
    return { ...route, legs, road_legs: roadLegs(legs), details_pending: true }
  }) }
}

function applyPlanUpdate(plan: PlanResult, update: Exclude<PlanUpdate, { type: 'plan' | 'playback_error' }>): PlanResult {
  return { ...plan, routes: plan.routes.map((route) => {
    if (route.id !== update.route_id) return route
    if (update.type === 'playback') {
      return {
        ...route,
        metrics_by_hour: [route.metrics_by_hour[0], ...update.metrics],
        playback: { series: update.series, reasons: update.reasons },
      }
    }
    const legs = route.legs?.map((leg, index) => unpackLeg({ ...leg, ...update.legs[index] }))
    return {
      ...route, legs, steps: legs?.flatMap((leg) => leg.steps) ?? [], details_pending: false,
      checkpoints: update.checkpoints ?? route.checkpoints,
      preview_leg_weather: undefined,
      road_legs: update.legs.some((leg) => leg.encoded_geometry) ? roadLegs(legs) : route.road_legs,
    }
  }) }
}

function checkpointRisk(route: RouteOption, index: number, hour: number): Risk {
  const packed = route.playback?.series[index]?.[hour - 1]
  return packed ? riskNames[packed[0]] ?? 'Unavailable' : route.checkpoints[index]?.forecast[hour]?.risk ?? 'Unavailable'
}

function checkpointForecast(route: RouteOption, index: number, hour: number): Forecast | undefined {
  const checkpoint = route.checkpoints[index]
  if (!checkpoint) return undefined
  const packed = route.playback?.series[index]?.[hour - 1]
  if (!packed) return checkpoint.forecast[hour]
  const [risk, wind, rain, snow, reasons] = packed
  const firstTime = checkpoint.forecast[0]?.time
  return {
    offset_hour: hour, risk: riskNames[risk] ?? 'Unavailable', risk_index: risk,
    wind_mph: wind, rain_in_hr: rain, snow_in_hr: snow,
    reasons: reasons.map((code) => route.playback!.reasons[code]),
    time: firstTime ? new Date(Date.parse(firstTime) + hour * 3_600_000).toISOString() : null,
  }
}

type TimeMode = 'departure' | 'arrival'
type ScheduleMode = 'now' | TimeMode

type Coordinates = { lat: number; lon: number; label?: string; country?: string }
type LocationSuggestion = Coordinates & { name: string; detail: string; label: string; attributions?: Attribution[] }
type TripDestination = { id: string; query: string; selection: LocationSuggestion | null }

function waypointRole(index: number, total: number) {
  if (index === 0) return 'Start'
  return index === total - 1 ? 'Destination' : 'Stop'
}

function RouteWaypointBadge({ index, total }: { index: number; total: number }) {
  const role = waypointRole(index, total).toLowerCase()
  return <span className={`route-waypoint-badge ${role}`} aria-label={`${waypointLetter(index)} ${role}`}>{waypointLetter(index)}</span>
}

function routeLegsFor(route: RouteOption, result: PlanResult): RouteLeg[] {
  if (route.legs?.length) return route.legs
  return [{
    start_label: result.origin.label,
    end_label: result.destination.label,
    distance_miles: route.distance_miles,
    duration_minutes: route.duration_minutes,
    departure_time: route.departure_time ?? result.departure_time,
    arrival_time: route.checkpoints.at(-1)?.eta ?? result.departure_time,
    steps: route.steps,
  }]
}

function routeCountries(route: RouteOption): string[] {
  const compact = (values: Array<string | null | undefined>) => values.reduce<string[]>((result, country) => {
    const clean = country?.trim()
    if (clean && result.at(-1)?.toLocaleLowerCase() !== clean.toLocaleLowerCase()) result.push(clean)
    return result
  }, [])
  const waypointCountries = compact(route.countries ?? [])
  const legCountries = compact(route.legs?.flatMap((leg) => [leg.start_country, leg.end_country]) ?? [])
  return legCountries.length > waypointCountries.length ? legCountries : waypointCountries
}

function routeWeatherByLeg(route: RouteOption, result: PlanResult, hour: number) {
  if (hour === 0 && route.preview_leg_weather) return route.preview_leg_weather
  const legs = routeLegsFor(route, result)
  let cumulative = 0
  const summaries = legs.map((leg) => {
    const start = cumulative
    cumulative += leg.distance_miles
    return { start, end: cumulative, rank: -1, count: 0, total: 0 }
  })
  route.checkpoints.forEach((checkpoint, index) => {
    const risk = checkpointRisk(route, index, hour)
    const rank = riskNames.indexOf(risk)
    const update = (summary: (typeof summaries)[number]) => {
      summary.total += 1
      if (risk !== 'Unavailable') {
        summary.count += 1
        summary.rank = Math.max(summary.rank, rank)
      }
    }
    if (checkpoint.leg_index !== undefined) {
      const summary = summaries[checkpoint.leg_index]
      if (summary) update(summary)
    } else {
      for (const summary of summaries) {
        if (checkpoint.distance_miles >= summary.start - 0.1 && checkpoint.distance_miles <= summary.end + 0.1) update(summary)
      }
    }
  })
  return summaries.map(({ rank, count, total }) => ({ risk: riskNames[rank] ?? 'Unavailable', count, total }))
}

function RouteLegSummaries({ route, result, distanceUnit, forecastHour, className = '' }: {
  route: RouteOption
  result: PlanResult
  distanceUnit: DistanceUnit
  forecastHour: number
  className?: string
}) {
  const timeZone = useContext(TimeZoneContext)
  const legs = routeLegsFor(route, result)
  const legWeather = routeWeatherByLeg(route, result, forecastHour)
  const totalWaypoints = legs.length + 1
  return (
    <span className={`route-leg-summaries ${className}`.trim()}>
      {legs.map((leg, index) => {
        const weather = legWeather[index]
        return <span className="route-leg-summary" key={`${route.id}-summary-leg-${index}`}>
          <strong className="route-leg-summary-title">
            Leg {index + 1}: {waypointLetter(index)} {waypointRole(index, totalWaypoints)} → {waypointLetter(index + 1)} {waypointRole(index + 1, totalWaypoints)}
          </strong>
          <span className="route-leg-summary-pair">
            <span className="route-leg-summary-place">
              <RouteWaypointBadge index={index} total={totalWaypoints} />
              <span><small>{waypointRole(index, totalWaypoints)}</small><b>{leg.start_label}</b></span>
            </span>
            <span className="route-waypoint-arrow" aria-hidden="true">→</span>
            <span className="route-leg-summary-place">
              <RouteWaypointBadge index={index + 1} total={totalWaypoints} />
              <span><small>{waypointRole(index + 1, totalWaypoints)}</small><b>{leg.end_label}</b></span>
            </span>
          </span>
          <span className="route-leg-summary-meta">
            <span>Leg option {leg.route_alternative ?? 1} of {leg.available_alternatives ?? 1}</span>
            <span>{formatDistance(leg.distance_miles, distanceUnit)}</span>
            <span>{formatDuration(leg.duration_minutes)}</span>
            <span>arrives {formatTime(leg.arrival_time, timeZone)}</span>
            <span className="route-leg-summary-risk risk-text" data-risk={weather.risk}>
              {weather.count ? `Highest risk: ${weather.risk} · ${weather.count}/${weather.total} checkpoints covered` : 'Forecast unavailable'}
            </span>
          </span>
          {leg.crosses_border && leg.start_country && leg.end_country && <span className="route-leg-summary-border">Stops in {leg.start_country} and {leg.end_country}</span>}
        </span>
      })}
    </span>
  )
}

function routePlaceLabel(name: string, address: string) {
  const cleanName = name.trim()
  const cleanAddress = address.trim()
  if (!cleanAddress || cleanAddress.toLocaleLowerCase().includes(cleanName.toLocaleLowerCase())) return cleanAddress || cleanName
  return `${cleanName}, ${cleanAddress}`
}

function locationSearchUrl(query: string, nearbyLocation: Coordinates | null, nearbyQuery: string) {
  const params = new URLSearchParams({ q: query })
  if (nearbyLocation) {
    params.set('near_lat', String(nearbyLocation.lat))
    params.set('near_lon', String(nearbyLocation.lon))
    if (nearbyLocation.country) params.set('near_country', nearbyLocation.country)
  } else if (nearbyQuery.trim()) {
    params.set('nearby_query', nearbyQuery.trim())
  }
  return `/api/locations/search?${params}`
}

function sameLocation(first: { label?: string; lat?: number; lon?: number } | null | undefined, second: { label?: string; lat?: number; lon?: number } | null | undefined) {
  if (!first || !second) return false
  const normalize = (value: string) => value.normalize('NFKD').toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()
  const firstLabel = normalize(first.label ?? '')
  const secondLabel = normalize(second.label ?? '')
  if (firstLabel && secondLabel && firstLabel === secondLabel) return true
  if (![first.lat, first.lon, second.lat, second.lon].every((value) => typeof value === 'number' && Number.isFinite(value))) return false
  return geometryDistance([first.lat!, first.lon!], [second.lat!, second.lon!]) <= 0.02
}

function waypointLetter(index: number) {
  let remaining = index + 1
  let label = ''
  while (remaining > 0) {
    remaining -= 1
    label = String.fromCharCode(65 + remaining % 26) + label
    remaining = Math.floor(remaining / 26)
  }
  return label
}

function InputWaypointIcon({ letter, end = false }: { letter: string; end?: boolean }) {
  return <span className={'waypoint-input-icon' + (end ? ' end' : '')} aria-hidden="true">{letter}</span>
}

type Attribution = { name: string; url: string }
type PlacePhoto = { url: string; title: string; authors?: Attribution[]; source_url?: string }
type NearbyPlace = {
  id: string
  attributions?: Attribution[]
  name: string
  detail: string
  address: string
  country?: string | null
  lat: number
  lon: number
  photos: PlacePhoto[]
  category?: string | null
  website?: string | null
  phone?: string | null
  opening_hours?: string | null
}
type NearbySearchState = { category: string | null; loading: boolean; error: string; places: NearbyPlace[] }
type LocationWeatherDetails = {
  location_name: string
  place_id?: string | null
  attributions?: Attribution[]
  address: string
  photos: PlacePhoto[]
  category: string | null
  website: string | null
  phone: string | null
  opening_hours: string | null
  location_error?: string | null
  observed_at?: string | null
  country?: string | null
  load_weight_lb?: number
  condition: string | null
  temperature_f: number | null
  feels_like_f: number | null
  humidity_percent: number | null
  wind_mph: number | null
  gust_mph: number | null
  rain_in_hr: number | null
  snow_in_hr: number | null
  risk: Risk
  risk_reasons: string[]
}
type MapLocationSelection = Coordinates & {
  generation: number
  loading: boolean
  error?: string
  details?: LocationWeatherDetails
}
type SelectedPlace = {
  id: string
  attributions?: Attribution[]
  name: string
  address: string
  country?: string | null
  lat: number
  lon: number
  photos: PlacePhoto[]
  category?: string | null
  website?: string | null
  phone?: string | null
  opening_hours?: string | null
  weather?: LocationWeatherDetails
  loading: boolean
  error?: string
}
const nearbyCategories = [
  { key: 'gas_stations', label: 'Gas Stations', icon: 'gasStation' },
  { key: 'restaurants', label: 'Restaurants', icon: 'restaurant' },
  { key: 'train_stations', label: 'Train Stations', icon: 'trainStation' },
  { key: 'pharmacies', label: 'Pharmacies', icon: 'pharmacy' },
  { key: 'hotels', label: 'Hotels', icon: 'hotel' },
  { key: 'parking', label: 'Parking', icon: 'parking' },
  { key: 'fast_food', label: 'Fast Food', icon: 'fastFood' },
  { key: 'cafes', label: 'Cafes', icon: 'cafe' },
] as const

async function readApiResponse<T>(response: Response, fallback: string): Promise<T> {
  if (response.status === 429) {
    const seconds = Number(response.headers.get('Retry-After'))
    if (Number.isFinite(seconds) && seconds > 0) {
      const wait = seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${Math.ceil(seconds)} sec`
      throw new Error(`Too many requests. Try again in ${wait}.`)
    }
    throw new Error('Too many requests. Wait a moment and try again.')
  }
  const data = await response.json().catch(() => null)
  if (!response.ok || data === null) {
    throw new Error(data?.error ?? data?.detail ?? fallback)
  }
  return data as T
}

function formatDuration(minutes: number) {
  let remainder = Math.max(0, Math.round(minutes))
  const weeks = Math.floor(remainder / 10_080)
  remainder %= 10_080
  const days = Math.floor(remainder / 1_440)
  remainder %= 1_440
  const hours = Math.floor(remainder / 60)
  remainder %= 60
  const parts = []
  if (weeks) parts.push(`${weeks}w`)
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours} hr`)
  if (remainder || parts.length === 0) parts.push(`${remainder} min`)
  return parts.join(' ')
}

function formatLegCount(count: number) {
  return `${count} ${count === 1 ? 'leg' : 'legs'}`
}

function websiteHref(value: string) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`
}

function useLocationSuggestions(query: string, nearby: Coordinates | null = null, nearbyQuery = '') {
  const [dismissed, setDismissed] = useState(false)
  const [response, setResponse] = useState<{ url: string; matches: LocationSuggestion[]; error: string } | null>(null)
  const [selection, setSelection] = useState<{ url: string; index: number } | null>(null)
  const text = query.trim()
  const visible = !dismissed && Boolean(text)
  const url = text.length >= 2 ? locationSearchUrl(text, nearby, nearbyQuery) : ''
  const currentMatches = url && response?.url === url ? response.matches : []
  const matches = visible ? currentMatches : []
  const active = visible && url && selection?.url === url ? selection.index : -1
  const loading = Boolean(visible && url && response?.url !== url)

  useEffect(() => {
    if (!visible || !url) return
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(url, { signal: controller.signal })
        const data = await readApiResponse<{ results: LocationSuggestion[] }>(response, 'Location search is unavailable.')
        if (!controller.signal.aborted) setResponse({ url, matches: data.results ?? [], error: '' })
      } catch (error) {
        if (!controller.signal.aborted) {
          setResponse({ url, matches: [], error: error instanceof Error ? error.message : 'Location search is unavailable.' })
        }
      }
    }, 110)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [visible, url])

  function dismiss() {
    setDismissed(true)
    setSelection(null)
  }

  function move(direction: 1 | -1) {
    setDismissed(false)
    if (!currentMatches.length) return
    const count = currentMatches.length
    const index = active < 0 ? (direction === 1 ? 0 : count - 1) : (active + direction + count) % count
    setSelection({ url, index })
  }

  return {
    visible, matches, active, loading, dismiss, move, tooShort: !url,
    error: url && response?.url === url ? response.error : '',
    reopen: () => setDismissed(false),
  }
}

function activeSuggestionId(id: string, search: ReturnType<typeof useLocationSuggestions>) {
  return search.active >= 0 && search.matches[search.active] ? `${id}-option-${search.active}` : undefined
}

function SearchSuggestions({ id, name, search, onSelect, extra = false, hint }: {
  id: string
  name: string
  search: ReturnType<typeof useLocationSuggestions>
  onSelect: (suggestion: LocationSuggestion) => void
  extra?: boolean
  hint?: string
}) {
  const highlighted = activeSuggestionId(id, search)
  useEffect(() => {
    if (highlighted) document.getElementById(highlighted)?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])
  const message = search.tooShort ? 'Enter at least two characters.'
    : search.loading ? 'Searching locations…' : search.error || (!search.matches.length ? 'No locations found.' : '')
  const announcement = search.visible ? message || `${search.matches.length} locations found. Use the arrow keys to review them.` : ''
  return <>
    <span className="sr-only" role="status">{announcement}</span>
    {search.visible && <Paper elevation={3} className={extra ? 'extra-stop-suggestions' : 'location-suggestions'}>
      {hint && <p className="suggestion-message origin-fallback-notice">{hint}</p>}
      {message && <p className={`suggestion-message${search.error ? ' error' : ''}`}>{message}</p>}
      <div className="google-credit" aria-label="Search results source">Google Maps</div>
      <div id={id} role="listbox" aria-label={`${name} suggestions`} aria-busy={search.loading}>
        {search.matches.map((suggestion, index) => <ButtonBase
          type="button" role="option" tabIndex={-1} id={`${id}-option-${index}`}
          aria-selected={search.active === index} className={`location-suggestion${search.active === index ? ' active' : ''}`}
          key={`${suggestion.lat}-${suggestion.lon}-${index}`} onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(suggestion)}
        >
          <Icon name="mapPin" size={18} className="suggestion-pin" />
          <span><strong>{suggestion.name}</strong>{suggestion.detail && <small>{suggestion.detail}</small>}
            {suggestion.attributions?.length ? <small>{suggestion.attributions.map((credit) => credit.name).join(' · ')}</small> : null}
          </span>
        </ButtonBase>)}
      </div>
    </Paper>}
  </>
}

function ExtraDestinationInput({
  stop,
  stopNumber,
  nearbyLocation,
  nearbyQuery,
  canMoveUp,
  canMoveDown,
  onChange,
  onSelect,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  stop: TripDestination
  stopNumber: number
  nearbyLocation: Coordinates | null
  nearbyQuery: string
  canMoveUp: boolean
  canMoveDown: boolean
  onChange: (query: string) => void
  onSelect: (suggestion: LocationSuggestion) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onRemove: () => void
}) {
  const isSet = stop.selection?.label === stop.query.trim()
  const search = useLocationSuggestions(isSet ? '' : stop.query, nearbyLocation, nearbyQuery)
  const listId = `stop-suggestions-${stop.id}`

  return (
    <div className="extra-destination-wrap">
      <div className="location-field extra-destination-field">
        <InputWaypointIcon letter={waypointLetter(stopNumber)} end />
        <InputBase
          id={stop.id}
          value={stop.query}
          placeholder={`Stop ${stopNumber}`}
          autoComplete="off"
          inputProps={{
            'aria-label': `Stop ${stopNumber}`,
            role: 'combobox',
            'aria-autocomplete': 'list',
            'aria-expanded': search.visible,
            'aria-controls': search.visible ? listId : undefined,
            'aria-activedescendant': activeSuggestionId(listId, search),
          }}
          onFocus={search.reopen}
          onBlur={search.dismiss}
          onChange={(event) => { search.reopen(); onChange(event.target.value) }}
          onKeyDown={(event) => {
            if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !isSet && stop.query.trim().length >= 2) {
              event.preventDefault()
              search.move(event.key === 'ArrowDown' ? 1 : -1)
            } else if (event.key === 'Enter') {
              event.preventDefault()
              const match = search.matches[search.active] ?? search.matches[0]
              if (match) onSelect(match)
              else if (isSet && event.target instanceof HTMLInputElement) event.target.form?.requestSubmit()
            } else if (event.key === 'Escape') {
              search.dismiss()
            }
          }}
        />
        <div className="stop-order-controls" aria-label={`Reorder stop ${stopNumber}`}>
          <IconButton size="small" type="button" disabled={!canMoveUp} onClick={onMoveUp} aria-label={`Move stop ${stopNumber} up`} title="Move up"><Icon name="arrowUp" size={16} /></IconButton>
          <IconButton size="small" type="button" disabled={!canMoveDown} onClick={onMoveDown} aria-label={`Move stop ${stopNumber} down`} title="Move down"><Icon name="arrowDown" size={16} /></IconButton>
          <IconButton size="small" type="button" onClick={onRemove} aria-label={`Remove stop ${stopNumber}`} title="Remove stop"><Icon name="minus" size={16} /></IconButton>
        </div>
      </div>
      <SearchSuggestions id={listId} name={`Stop ${stopNumber}`} search={search} onSelect={onSelect} extra />
    </div>
  )
}

function AttributionLinks({ credits }: { credits?: Attribution[] }) {
  return credits?.map((credit) => /^https?:\/\//.test(credit.url)
    ? <a key={credit.name} href={credit.url} target="_blank" rel="noreferrer">{credit.name}</a>
    : <span key={credit.name}>{credit.name}</span>)
}

function CheckpointFacts({ checkpoint, forecast, unit }: { checkpoint: Checkpoint; forecast?: Forecast; unit: DistanceUnit }) {
  const timeZone = useContext(TimeZoneContext)
  const risk = forecast?.risk ?? 'Unavailable'
  return <>
    <strong className="risk-text" data-risk={risk}>{risk} weather risk</strong>
    <dl className="checkpoint-facts">
      <div><dt>Along route</dt><dd>{formatDistance(checkpoint.distance_miles, unit)}</dd></div>
      <div><dt>Estimated arrival</dt><dd>{formatTime(checkpoint.eta, timeZone)}</dd></div>
      <div><dt>Forecast time</dt><dd>{forecast?.time ? formatTime(forecast.time, timeZone) : 'Unavailable'}</dd></div>
      <div><dt>Wind</dt><dd>{formatSpeed(forecast?.wind_mph, unit)}</dd></div>
      <div><dt>Rain</dt><dd>{formatPrecipitation(forecast?.rain_in_hr, unit)}</dd></div>
      <div><dt>Snow</dt><dd>{formatPrecipitation(forecast?.snow_in_hr, unit)}</dd></div>
    </dl>
    <p className="checkpoint-reason">{forecast?.reasons.length ? forecast.reasons.map((reason) => formatRiskReason(reason, unit)).join(' · ')
      : risk === 'Unavailable' ? 'Forecast unavailable for this checkpoint and time.' : 'No weather thresholds exceeded.'}</p>
  </>
}

function RouteMap({
  result,
  currentLocation,
  originLocation,
  destinationSelection,
  centerLocationRequest,
  closeLocationPopupRequest,
  selectedRoute,
  recommendedRouteId,
  hoveredRouteId,
  onRoute,
  onRouteHover,
  forecastHour,
  selectedCheckpoint,
  checkpointFocusRequest,
  satellite,
  theme,
  gps,
  followingGps,
  onMapPan,
  distanceUnit,
  temperatureUnit,
  zoomShortcut,
  heatmapShortcutRequest,
  loadWeightLb,
  nearbySearch,
  focusedNearbyPlace,
  onNearbyComplete,
  onPlaceSelected,
  onNearbyPlaceSelect,
  onCheckpoint,
}: {
  result: PlanResult | null
  currentLocation: Coordinates | null
  originLocation: Coordinates | null
  destinationSelection: LocationSuggestion | null
  centerLocationRequest: number
  closeLocationPopupRequest: number
  selectedRoute: RouteOption | null
  recommendedRouteId: string | null
  hoveredRouteId: string | null
  onRoute: (id: string) => void
  onRouteHover: (id: string | null) => void
  forecastHour: number
  selectedCheckpoint: number | null
  checkpointFocusRequest: number
  satellite: boolean
  theme: 'light' | 'dark'
  gps: GpsFix | null
  followingGps: boolean
  onMapPan: () => void
  distanceUnit: DistanceUnit
  temperatureUnit: TemperatureUnit
  zoomShortcut: number
  heatmapShortcutRequest: number
  loadWeightLb: number
  nearbySearch: NearbySearchState
  focusedNearbyPlace: NearbyPlace | null
  onNearbyComplete: (category: string, places: NearbyPlace[], error: string) => void
  onPlaceSelected: (place: SelectedPlace | null) => void
  onNearbyPlaceSelect: (place: NearbyPlace) => void
  onCheckpoint: (index: number) => void
}) {
  const timeZone = useContext(TimeZoneContext)
  const [pin, setMapLocation] = useState<MapLocationSelection | null>(null)
  const mapLocation = pin?.generation === closeLocationPopupRequest ? pin : null
  const [map, setMap] = useState<google.maps.Map | null>(null)
  const [openPin, setOpenPin] = useState<string | null>(null)
  const [popupCheckpoint, setPopupCheckpoint] = useState<{ index: number; request: number } | null>(null)
  const [heatmapEnabled, setHeatmapEnabled] = useState(true)
  const [weather, setWeather] = useState<TemperatureHeatmap | null>(null)
  const [weatherMessage, setWeatherMessage] = useState('')
  const weatherRequest = useRef<AbortController | null>(null)
  const detailsRequest = useRef<AbortController | null>(null)
  const lastZoomShortcut = useRef(zoomShortcut)
  const handledHeatmapShortcut = useRef(heatmapShortcutRequest)
  const onMapLocationClick = useCallback(async ({ lat, lon }: Pick<Coordinates, 'lat' | 'lon'>, nearbyPlace?: NearbyPlace, placeId?: string) => {
    detailsRequest.current?.abort()
    const controller = new AbortController()
    detailsRequest.current = controller
    const generation = closeLocationPopupRequest
    setMapLocation({ lat, lon, generation, loading: true })
    setOpenPin('selected-location')
    setPopupCheckpoint(null)
    onPlaceSelected({
      id: nearbyPlace?.id ?? `map:${lat.toFixed(5)}:${lon.toFixed(5)}`,
      name: nearbyPlace?.name ?? 'Finding location…',
      address: nearbyPlace?.address ?? '',
      country: nearbyPlace?.country,
      lat,
      lon,
      photos: nearbyPlace?.photos ?? [],
      attributions: nearbyPlace?.attributions,
      category: nearbyPlace?.category,
      website: nearbyPlace?.website,
      phone: nearbyPlace?.phone,
      opening_hours: nearbyPlace?.opening_hours,
      loading: true,
    })
    const query = new URLSearchParams({
      lat: lat.toFixed(5),
      lon: lon.toFixed(5),
      load_weight_lb: String(loadWeightLb),
      photos: '0',
    })
    if (nearbyPlace?.id || placeId) query.set('place_id', nearbyPlace?.id ?? placeId!)
    try {
      const response = await fetch(`/api/locations/details?${query}`, { signal: controller.signal })
      const details = await readApiResponse<LocationWeatherDetails>(response, 'Weather details are unavailable.')
      if (!controller.signal.aborted) {
        setMapLocation({ lat, lon, generation, loading: false, details })
        const photos = [...(nearbyPlace?.photos ?? []), ...(details.photos ?? [])]
          .filter((photo: PlacePhoto, index: number, all: PlacePhoto[]) => all.findIndex((item) => item.url === photo.url) === index)
          .slice(0, 3)
        const place: SelectedPlace = {
          id: nearbyPlace?.id ?? `map:${lat.toFixed(5)}:${lon.toFixed(5)}`,
          name: nearbyPlace?.name ?? details.location_name,
          address: nearbyPlace?.address ?? details.address ?? details.location_name,
          country: nearbyPlace?.country ?? details.country,
          lat,
          lon,
          photos,
          attributions: details.attributions?.length ? details.attributions : nearbyPlace?.attributions,
          category: nearbyPlace?.category ?? details.category,
          website: nearbyPlace?.website ?? details.website,
          phone: nearbyPlace?.phone ?? details.phone,
          opening_hours: nearbyPlace?.opening_hours ?? details.opening_hours,
          weather: details,
          loading: false,
          error: details.location_error ?? undefined,
        }
        onPlaceSelected(place)
        const photoPlaceId = nearbyPlace?.id ?? placeId ?? details.place_id
        if (photoPlaceId && photos.length < 3) {
          const photoQuery = new URLSearchParams({ place_id: photoPlaceId })
          void fetch(`/api/locations/photos?${photoQuery}`, { signal: controller.signal })
            .then((response) => readApiResponse<{ photos: PlacePhoto[] }>(response, 'Photos unavailable.'))
            .then((data) => {
              if (controller.signal.aborted) return
              const unique = new Map(photos.map((photo) => [photo.url, photo]))
              for (const photo of data.photos) if (!unique.has(photo.url)) unique.set(photo.url, photo)
              onPlaceSelected({ ...place, photos: [...unique.values()].slice(0, 3) })
            })
            .catch(() => {})
        }
      }
    } catch (requestError) {
      if (!controller.signal.aborted) {
        const message = requestError instanceof Error ? requestError.message : 'Weather details are unavailable.'
        setMapLocation({
          lat,
          lon,
          generation,
          loading: false,
          error: message,
        })
        onPlaceSelected({
          id: nearbyPlace?.id ?? `map:${lat.toFixed(5)}:${lon.toFixed(5)}`,
          name: nearbyPlace?.name ?? 'Selected location',
          address: nearbyPlace?.address ?? '',
          country: nearbyPlace?.country,
          lat,
          lon,
          photos: nearbyPlace?.photos ?? [],
          category: nearbyPlace?.category,
          website: nearbyPlace?.website,
          phone: nearbyPlace?.phone,
          opening_hours: nearbyPlace?.opening_hours,
          loading: false,
          error: message,
        })
      }
    }
  }, [closeLocationPopupRequest, loadWeightLb, onPlaceSelected])

  useLayoutEffect(() => () => detailsRequest.current?.abort(), [closeLocationPopupRequest])
  const openNearbyPlace = useEffectEvent((place: NearbyPlace) => {
    void onMapLocationClick(place, place)
  })
  useEffect(() => {
    if (!focusedNearbyPlace) return
    const frame = window.requestAnimationFrame(() => openNearbyPlace(focusedNearbyPlace))
    return () => window.cancelAnimationFrame(frame)
  }, [focusedNearbyPlace])

  useEffect(() => {
    const category = nearbySearch.category
    if (!map || !category) return
    const position = map.getCenter()
    if (!position) return
    const controller = new AbortController()
    const query = new URLSearchParams({ category, lat: position.lat().toFixed(5), lon: position.lng().toFixed(5) })
    fetch(`/api/locations/nearby?${query}`, { signal: controller.signal })
      .then((response) => readApiResponse<{ results: NearbyPlace[] }>(response, 'Nearby search is unavailable.'))
      .then((data) => { if (!controller.signal.aborted) onNearbyComplete(category, data.results, '') })
      .catch((error: Error) => { if (!controller.signal.aborted) onNearbyComplete(category, [], error.message) })
    return () => controller.abort()
  }, [map, nearbySearch.category, onNearbyComplete])

  const refreshWeather = useEffectEvent(() => {
    const bounds = map?.getBounds()?.toJSON()
    if (!bounds) return
    weatherRequest.current?.abort()
    const controller = new AbortController()
    weatherRequest.current = controller
    const query = new URLSearchParams({
      north: String(bounds.north), south: String(bounds.south), west: String(bounds.west), east: String(bounds.east),
    })
    setWeatherMessage('Fetching current temperatures…')
    fetch(`/api/weather/heatmap?${query}`, { signal: controller.signal })
      .then((response) => readApiResponse<TemperatureHeatmap>(response, 'Current temperatures are unavailable.'))
      .then((data) => {
        if (controller.signal.aborted) return
        setWeather(data)
        const samples = data.points.filter((point) => point.surface === 'land')
        const missing = samples.filter((point) => !isTemperature(point.temperature_f)).length
        setWeatherMessage(data.coverage === 'water' ? 'Temperature coverage is unavailable over this water-only view.'
          : missing === samples.length
          ? 'Current temperatures are unavailable for this view.'
          : missing ? `${missing} of ${samples.length} temperature samples are unavailable.` : '')
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) return
        setWeather(null)
        setWeatherMessage(error.message)
      })
  })

  useEffect(() => {
    if (!map || !heatmapEnabled) return
    let timer = 0
    const cancelPending = () => {
      window.clearTimeout(timer)
      weatherRequest.current?.abort()
    }
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => refreshWeather(), 800)
    }
    const boundsListener = map.addListener('bounds_changed', cancelPending)
    const idleListener = map.addListener('idle', schedule)
    if (map.getBounds()) schedule()
    return () => {
      cancelPending()
      boundsListener.remove()
      idleListener.remove()
    }
  }, [map, heatmapEnabled])

  useEffect(() => {
    if (!map) return
    const delta = zoomShortcut - lastZoomShortcut.current
    lastZoomShortcut.current = zoomShortcut
    if (delta) map.setZoom(Math.max(1, Math.min(18, (map.getZoom() ?? 5) + delta)))
  }, [map, zoomShortcut])

  function toggleHeatmap() {
    if (heatmapEnabled) {
      weatherRequest.current?.abort()
      setWeather(null)
      setWeatherMessage('')
    }
    setHeatmapEnabled(!heatmapEnabled)
  }
  const toggleHeatmapFromShortcut = useEffectEvent(toggleHeatmap)
  useEffect(() => {
    const changes = heatmapShortcutRequest - handledHeatmapShortcut.current
    handledHeatmapShortcut.current = heatmapShortcutRequest
    if (changes % 2) toggleHeatmapFromShortcut()
  }, [heatmapShortcutRequest])

  const checkpoints = selectedRoute?.checkpoints
  const legs = selectedRoute?.road_legs ?? selectedRoute?.legs
  const coordinates = selectedRoute?.coordinates
  const distance = selectedRoute?.distance_miles ?? 0
  const road = useMemo(() => ({ checkpoints: checkpoints ?? [], legs, coordinates: coordinates ?? [], distance_miles: distance }), [checkpoints, legs, coordinates, distance])
  const paths = useMemo(() => routeGeometry(road).filter((path) => path.length > 1), [road])
  const segments = useMemo(() => buildRouteSegments(road, paths), [road, paths])
  const routeGeometryCache = useRef(new WeakMap<object, [number, number][][]>())
  const lastMapRoutes = useRef<MapRoute[]>([])
  const mapRoutes = useMemo(() => {
    const available = (result?.routes ?? []).flatMap((route) => {
      const routeLegs = route.road_legs ?? route.legs
      if (route.legs?.some((leg) => leg.geometry_pending)) return []
      const key = routeLegs ?? route.coordinates
      let routePaths = routeGeometryCache.current.get(key)
      if (!routePaths) {
        routePaths = routeGeometry({ legs: routeLegs, coordinates: route.coordinates, distance_miles: route.distance_miles }).filter((path) => path.length > 1)
        routeGeometryCache.current.set(key, routePaths)
      }
      return routePaths.length ? [{ id: route.id, paths: routePaths }] : []
    })
    if (available.length === lastMapRoutes.current.length && available.every((route, index) =>
      route.id === lastMapRoutes.current[index].id && route.paths === lastMapRoutes.current[index].paths)) return lastMapRoutes.current
    lastMapRoutes.current = available
    return available
  }, [result?.routes])
  const routePoints = useMemo<MapCheckpoint[]>(() => selectedRoute?.checkpoints.map((point, index) => {
    const risk = checkpointRisk(selectedRoute, index, forecastHour)
    return {
      index, position: { lat: point.latitude, lng: point.longitude }, color: riskColors[risk],
      pattern: risk === 'No Travel' ? 'dash' : risk === 'Unavailable' ? 'dot' : undefined,
    }
  }) ?? [], [selectedRoute, forecastHour])
  const point = (coordinate: Pick<Coordinates, 'lat' | 'lon'>): MapPoint => ({ lat: coordinate.lat, lng: coordinate.lon })
  const pins: MapPin[] = []
  let popup: MapPopup | null = null
  const contextPlace = mapLocation?.details
  if (mapLocation) {
    const position = point(mapLocation)
    const title = contextPlace?.location_name ?? (mapLocation.loading ? 'Finding location…' : 'Selected location')
    pins.push({ id: 'selected-location', position, title, label: '•', color: '#99582f', onClick: () => setOpenPin('selected-location') })
    if (openPin === 'selected-location') popup = { position, title, content: <>
      <strong>{title}</strong>
      <p>{contextPlace?.address || (mapLocation.loading ? 'Loading weather…' : mapLocation.error)}</p>
      {contextPlace && <p className="risk-text" data-risk={contextPlace.risk}>{contextPlace.risk} weather risk</p>}
    </> }
  }
  for (const place of nearbySearch.places) {
    pins.push({ id: place.id, position: point(place), title: place.name, label: '•', color: '#2764a5', onClick: () => onNearbyPlaceSelect(place) })
  }
  if (result) {
    const stops = [result.origin, ...(result.stops?.length ? result.stops : [result.destination])]
    const routeLegs = selectedRoute ? routeLegsFor(selectedRoute, result) : []
    stops.forEach((stop, index) => {
      const id = `waypoint-${index}`
      const position = point(stop)
      const title = `${waypointLetter(index)}, ${waypointRole(index, stops.length)}, ${stop.label}`
      pins.push({ id, position, title, label: waypointLetter(index), color: index === 0 ? '#157a70' : index === stops.length - 1 ? '#99582f' : '#2764a5',
        driverDetails: index === 0 ? DRIVER_DISPLAY : undefined,
        onClick: () => { setPopupCheckpoint(null); setOpenPin(id) } })
      const time = routeLegs[index - 1]?.arrival_time ?? selectedRoute?.departure_time ?? result.departure_time
      if (openPin === id) popup = { position, title, content: <><strong>{title}</strong><p>{index ? 'Estimated arrival' : 'Departure'} {formatTime(time, timeZone)}</p></> }
    })
  } else if (originLocation) {
    const position = point(originLocation)
    const title = `A, Start, ${originLocation.label ?? 'My location'}`
    pins.push({ id: 'starting-point', position, title, label: 'A', color: '#157a70', driverDetails: DRIVER_DISPLAY,
      onClick: () => { setPopupCheckpoint(null); setOpenPin('starting-point') } })
    if (openPin === 'starting-point') popup = { position, title, content: <><strong>{title}</strong><p>Starting point</p></> }
  }
  const gpsPoint = gps ?? (result ? null : currentLocation)
  const gpsMatchesOrigin = Boolean(gpsPoint && originLocation && Math.abs(gpsPoint.lat - originLocation.lat) < 0.0001 && Math.abs(gpsPoint.lon - originLocation.lon) < 0.0001)
  if (gpsPoint && !gpsMatchesOrigin) {
    pins.push({ id: 'device-location', position: point(gpsPoint), title: gps ? 'Live GPS position' : 'My location', label: '●', color: '#0e5ebd',
      driverDetails: gps ? DRIVER_DISPLAY : undefined,
      onClick: () => { setPopupCheckpoint(null); setOpenPin('device-location') } })
    if (openPin === 'device-location') popup = { position: point(gpsPoint), title: 'My location',
      content: gps ? <strong>GPS accuracy ±{Math.round(gps.accuracy)} m</strong> : <strong>My location</strong> }
  }

  const popupIndex = popupCheckpoint?.request === checkpointFocusRequest ? popupCheckpoint.index : null
  const popupPoint = popupIndex === null ? undefined : checkpoints?.[popupIndex]
  if (popupPoint && selectedRoute && popupIndex !== null && popupIndex === selectedCheckpoint) {
    popup = { position: { lat: popupPoint.latitude, lng: popupPoint.longitude }, title: 'Weather checkpoint', content:
      <CheckpointFacts checkpoint={popupPoint} forecast={checkpointForecast(selectedRoute, popupIndex, forecastHour)} unit={distanceUnit} /> }
  }

  const checkpoint = selectedCheckpoint === null ? undefined : checkpoints?.[selectedCheckpoint]
  const focus = useMemo(() => checkpoint && checkpointFocusRequest ? {
    position: { lat: checkpoint.latitude, lng: checkpoint.longitude }, request: checkpointFocusRequest,
  } : currentLocation && centerLocationRequest ? {
    position: { lat: currentLocation.lat, lng: currentLocation.lon }, zoom: 12, request: centerLocationRequest,
  } : !result && destinationSelection ? {
    position: { lat: destinationSelection.lat, lng: destinationSelection.lon }, zoom: 12, request: 0,
  } : null, [checkpoint, checkpointFocusRequest, currentLocation, centerLocationRequest, destinationSelection, result])
  const followFix = useMemo(() => gps ? { position: { lat: gps.lat, lng: gps.lon }, accuracy: gps.accuracy, follow: followingGps } : null, [followingGps, gps])

  return <>
    <GoogleMapSurface center={{ lat: 0, lng: 0 }} temperatureUnit={temperatureUnit}
      focus={focus} paths={paths} segments={segments} checkpoints={routePoints} pins={pins} temperature={weather}
      routes={mapRoutes} recommendedRouteId={recommendedRouteId} selectedRouteId={selectedRoute?.id ?? null} hoveredRouteId={hoveredRouteId}
      onRoute={onRoute} onRouteHover={onRouteHover}
      heatmapEnabled={heatmapEnabled} onToggleHeatmap={toggleHeatmap}
      satellite={satellite} theme={theme} activeCheckpoint={selectedCheckpoint} gps={followFix} popup={popup}
      onReady={setMap} onPan={onMapPan} onPopupClose={() => { setOpenPin(null); setPopupCheckpoint(null) }}
      onMapClick={(position, placeId) => void onMapLocationClick({ lat: position.lat, lon: position.lng }, undefined, placeId)}
      onCheckpoint={(index) => { setOpenPin(null); setPopupCheckpoint({ index, request: checkpointFocusRequest }); onCheckpoint(index) }}
    />
    {map && heatmapEnabled && weatherMessage && <div className="current-weather-status" role="status">{weatherMessage}</div>}
  </>
}

function LegSteps({ steps, distanceUnit }: { steps: RouteStep[]; distanceUnit: DistanceUnit }) {
  const [open, setOpen] = useState(false)
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{steps.length} steps</summary>
    {open && <ol>{steps.map((step, index) => <li key={index}>
      <span className="direction-number">{index + 1}</span>
      <span className="direction-copy">
        <strong>{step.instruction}</strong>
        <small>{formatDistance(step.distance_miles, distanceUnit)}, {formatDuration(step.duration_minutes)}</small>
      </span>
    </li>)}</ol>}
  </details>
}



function RouteDirections({ selectedRoute, selectedRouteLegs, distanceUnit, streamFinished }: {
  selectedRoute: RouteOption
  selectedRouteLegs: RouteLeg[]
  distanceUnit: DistanceUnit
  streamFinished: boolean
}) {
  const timeZone = useContext(TimeZoneContext)
  const [open, setOpen] = useState(false)
  const stepCount = selectedRoute.steps.length
  return <details className="result-disclosure route-directions" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Directions <span>{formatLegCount(selectedRouteLegs.length)} · {stepCount} {stepCount === 1 ? 'step' : 'steps'}</span></summary>
    {open && (selectedRoute.details_pending
      ? <p role="status">{streamFinished ? 'Directions unavailable.' : 'Loading directions…'}</p>
      : selectedRouteLegs.length
      ? <div className="route-leg-list">
        {selectedRouteLegs.map((leg, index) => (
          <section className="route-leg" key={`${selectedRoute.id}-leg-${index}`}>
            <div className="route-leg-heading">
              <strong className="route-leg-sequence">
                Leg {index + 1}: {waypointLetter(index)} {waypointRole(index, selectedRouteLegs.length + 1)} → {waypointLetter(index + 1)} {waypointRole(index + 1, selectedRouteLegs.length + 1)}
              </strong>
              <strong className="route-leg-itinerary">
                <span className="route-leg-endpoint"><RouteWaypointBadge index={index} total={selectedRouteLegs.length + 1} /><span>{waypointRole(index, selectedRouteLegs.length + 1)}: {leg.start_label}</span></span>
                <span className="route-waypoint-arrow" aria-hidden="true">→</span>
                <span className="route-leg-endpoint"><RouteWaypointBadge index={index + 1} total={selectedRouteLegs.length + 1} /><span>{waypointRole(index + 1, selectedRouteLegs.length + 1)}: {leg.end_label}</span></span>
              </strong>
              <small>{formatDistance(leg.distance_miles, distanceUnit)}, {formatDuration(leg.duration_minutes)}, arrives {formatTime(leg.arrival_time, timeZone)}</small>
            </div>
            {leg.crosses_border && leg.start_country && leg.end_country && <p className="route-leg-border">Stops in {leg.start_country} and {leg.end_country}</p>}
            {leg.steps.length
              ? <LegSteps steps={leg.steps} distanceUnit={distanceUnit} />
              : <p>Turn-by-turn directions are unavailable for this leg.</p>}
          </section>
        ))}
      </div>
      : <p>Turn-by-turn directions are unavailable for this route.</p>)}
  </details>
}

function RouteResults({ trip, route, hour, unit, previous, checkpointIndex, hoveredRouteId, onRoute, onRouteHover, onHour, onCheckpoint }: {
  trip: DisplayedTrip
  route: RouteOption
  hour: number
  unit: DistanceUnit
  previous: boolean
  checkpointIndex: number | null
  hoveredRouteId: string | null
  onRoute: (id: string) => void
  onRouteHover: (id: string | null) => void
  onHour: (hour: number) => void
  onCheckpoint: (index: number) => void
}) {
  const timeZone = useContext(TimeZoneContext)
  const { result, finished, failedPlayback } = trip
  const [legsOpen, setLegsOpen] = useState(false)
  const maxHour = Math.max(0, route.metrics_by_hour.length - 1)
  const { complete: comparisonReady, recommended } = useMemo(() => recommendRoute(result.routes, hour), [result.routes, hour])
  const recommendation = previous ? null : recommended
  const routeNumber = result.routes.indexOf(route) + 1
  const legs = routeLegsFor(route, result)
  const coverage = useMemo(() => {
    const summaries = routeWeatherByLeg(route, result, hour)
    let covered = 0
    let total = 0
    let rank = -1
    for (const summary of summaries) {
      total += summary.total
      covered += summary.count
      if (summary.count) rank = Math.max(rank, riskNames.indexOf(summary.risk))
    }
    return { covered, total, risk: riskNames[rank] ?? 'Unavailable' }
  }, [route, result, hour])
  const countries = routeCountries(route)
  const status = previous ? 'Previous plan' : !comparisonReady ? 'Route comparison incomplete at this hour'
    : recommendation ? `Route ${result.routes.indexOf(recommendation) + 1} recommended` : 'No route recommended'
  const viewTime = hour === 0 ? 'Weather at each checkpoint’s ETA' : `Weather ${hour} ${hour === 1 ? 'hour' : 'hours'} after each checkpoint’s ETA`
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setAnnouncement(`${status}. ${viewTime}.`), 200)
    return () => window.clearTimeout(timer)
  }, [status, viewTime])
  const isPlaybackUnavailable = finished || failedPlayback.includes(route.id)
  const index = checkpointIndex ?? 0
  const arrival = route.checkpoints.at(-1)?.eta
  const checkpoint = route.checkpoints[index]
  const selectWorst = () => {
    let worst = -1
    let firstWorst = -1
    for (const pointIndex of route.checkpoints.keys()) {
      const risk = checkpointRisk(route, pointIndex, hour)
      if (risk === 'Unavailable') continue
      const rank = riskNames.indexOf(risk)
      if (rank > worst) {
        worst = rank
        firstWorst = pointIndex
      }
    }
    if (firstWorst >= 0) onCheckpoint(firstWorst)
  }

  return <section className="planner-results" id="trip-results" aria-labelledby="trip-results-title">
    <div className="result-hero">
      <div className="result-heading">
        <h2 id="trip-results-title" tabIndex={-1}>Route outlook</h2>
        <span className="result-status" data-state={previous || !comparisonReady ? 'neutral' : recommendation ? 'recommended' : 'blocked'}>{status}</span>
      </div>
      <span className="sr-only" role="status">{announcement}</span>
      <p className="selected-route-label"><strong>Route {routeNumber}</strong>{route.name ? ` · ${route.name}` : ''}</p>
      <dl className="result-metrics">
        <div><dt>Distance</dt><dd>{formatDistance(route.distance_miles, unit)}</dd></div>
        <div><dt>Drive time</dt><dd>{formatDuration(route.duration_minutes)}</dd></div>
        <div><dt>Estimated arrival</dt><dd>{arrival ? formatTime(arrival, timeZone) : 'Unavailable'}</dd></div>
      </dl>
      <p className="result-coverage"><strong className="risk-text" data-risk={coverage.risk}>{coverage.covered ? `Highest risk: ${coverage.risk}` : 'Forecast unavailable'}</strong>
        {coverage.total > 0 && <span>{coverage.covered} of {coverage.total} checkpoints covered</span>}
      </p>
      <div className="result-links">
        <a href="#outlook-time-title">Forecast timing</a>
        {result.routes.length > 1 && <a href="#compare-routes-title">Compare routes</a>}
        {checkpoint && <a href="#checkpoint-title" onClick={() => {
          const panel = document.getElementById('route-checkpoints')
          if (panel instanceof HTMLDetailsElement) panel.open = true
        }}>Checkpoints</a>}
      </div>
      {result.time_mode === 'arrival' && result.requested_time && <p className="requested-arrival-time">Arrival requested by {formatTime(result.requested_time, timeZone)}.</p>}
      <p className="result-source">{result.source_notice}</p>
      <p className="google-credit">Routes and weather from Google Maps</p>
    </div>

    <section className="outlook-time" aria-labelledby="outlook-time-title">
      <div className="outlook-heading"><h3 id="outlook-time-title" tabIndex={-1}>Forecast timing</h3><span className="hour-offset" aria-hidden="true">+{hour} h</span></div>
      <p id="forecast-context">{viewTime}.</p>
      <Slider aria-label="Forecast shift in hours" slotProps={{ input: { 'aria-describedby': 'forecast-context' } }} getAriaValueText={(value) => value ? `${value} ${value === 1 ? 'hour' : 'hours'} after estimated arrival` : 'At estimated arrival'}
        disabled={!maxHour} min={0} max={PLAYBACK_HOURS - 1} step={1} value={hour}
        onChange={(_event, value) => onHour(Math.min(maxHour, value as number))} />
      <div className="outlook-actions">
        <ButtonBase type="button" disabled={!hour} aria-label="Move forecast one hour earlier" onClick={() => onHour(hour - 1)}>−1 h</ButtonBase>
        <ButtonBase type="button" disabled={hour >= maxHour} aria-label="Move forecast one hour later" onClick={() => onHour(hour + 1)}>+1 h</ButtonBase>
        <ButtonBase type="button" disabled={!hour} onClick={() => onHour(0)}>Reset</ButtonBase>
        {!maxHour && <span role="status">{isPlaybackUnavailable ? 'Later forecasts unavailable for this route.' : 'Loading later forecasts…'}</span>}
      </div>
    </section>

    <section className="route-comparison" aria-labelledby="compare-routes-title">
      <h3 id="compare-routes-title" tabIndex={-1}>{result.routes.length > 1 ? 'Compare routes' : 'Route option'}</h3>
      {result.routes.map((option, number) => {
        const active = option.id === route.id
        const pending = option.legs?.some((leg) => leg.geometry_pending)
        const metrics = option.metrics_by_hour[hour]
        const noTravel = metrics && (metrics.no_travel_miles > 0 || metrics.no_travel_checkpoints > 0)
        const missing = metrics && (metrics.unknown_miles > 0 || metrics.unknown_checkpoints > 0)
        return <article key={option.id} className="compare-option" data-selected={active} data-hovered={hoveredRouteId === option.id}
          onMouseEnter={() => { if (!pending) onRouteHover(option.id) }} onMouseLeave={() => onRouteHover(null)}
          onFocus={() => { if (!pending) onRouteHover(option.id) }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onRouteHover(null) }}>
          <div className="compare-heading">
            <ButtonBase type="button" className="compare-select" aria-label={`Show route ${number + 1}`} aria-pressed={active} disabled={pending} onClick={() => onRoute(option.id)}>
              <i aria-hidden="true" />Route {number + 1}
            </ButtonBase>
            {recommendation?.id === option.id && <span className="compare-note">Recommended</span>}
            {pending && <span className="compare-note">{finished ? 'Map unavailable' : 'Loading map…'}</span>}
          </div>
          {option.name && <p className="compare-road">{option.name}</p>}
          <dl className="compare-metrics">
            <div><dt>Distance</dt><dd>{formatDistance(option.distance_miles, unit)}</dd></div>
            <div><dt>Drive time</dt><dd>{formatDuration(option.duration_minutes)}</dd></div>
            <div><dt>High / severe</dt><dd>{metrics ? `${formatDistance(metrics.high_miles, unit)} / ${formatDistance(metrics.severe_miles, unit)}` : 'Unavailable'}</dd></div>
          </dl>
          {noTravel && <p className="risk-text compare-warning" data-risk="No Travel">No Travel at {metrics.no_travel_checkpoints} {metrics.no_travel_checkpoints === 1 ? 'checkpoint' : 'checkpoints'}{metrics.no_travel_miles > 0 ? ` · ${formatDistance(metrics.no_travel_miles, unit)}` : ''}</p>}
          {missing && <p className="risk-text compare-warning" data-risk="Unavailable">Forecast missing at {metrics.unknown_checkpoints} {metrics.unknown_checkpoints === 1 ? 'checkpoint' : 'checkpoints'}</p>}
        </article>
      })}
    </section>

    {result.route_warning && <Alert severity="warning" variant="outlined" role="status">{result.route_warning}</Alert>}
    {result.weather_warning && <Alert severity="warning" variant="outlined" role="status">{result.weather_warning}</Alert>}

    {checkpoint && <details id="route-checkpoints" className="result-disclosure checkpoint-panel">
      <summary id="checkpoint-title">Weather checkpoints <span>{route.checkpoints.length}</span></summary>
      <div className="checkpoint-actions">
        <ButtonBase type="button" disabled={index <= 0} onClick={() => onCheckpoint(index - 1)}>Previous</ButtonBase>
        <ButtonBase type="button" disabled={index + 1 >= route.checkpoints.length} onClick={() => onCheckpoint(index + 1)}>Next</ButtonBase>
        <ButtonBase type="button" disabled={!coverage.covered} onClick={selectWorst}>Highest risk</ButtonBase>
      </div>
      <p className="checkpoint-position" role="status">Checkpoint {index + 1} of {route.checkpoints.length} · {formatDistance(checkpoint.distance_miles, unit)} along route</p>
      <CheckpointFacts checkpoint={checkpoint} forecast={checkpointForecast(route, index, hour)} unit={unit} />
    </details>}
    <details className="result-disclosure" onToggle={(event) => setLegsOpen(event.currentTarget.open)}>
      <summary>Legs and stops <span>{formatLegCount(legs.length)}</span></summary>
      {legsOpen && <>
        {countries.length > 1 && <p>Waypoint countries: {countries.join(' → ')}</p>}
        <RouteLegSummaries route={route} result={result} distanceUnit={unit} forecastHour={hour} />
      </>}
    </details>
    <RouteDirections selectedRoute={route} selectedRouteLegs={legs} distanceUnit={unit} streamFinished={finished} />
  </section>
}

function plannedTimeAtMile(checkpoints: Checkpoint[], mile: number) {
  const index = firstCheckpointAfter(checkpoints, mile)
  const previous = checkpoints[index - 1]
  const next = checkpoints[index]
  if (!previous) return next ? Date.parse(next.eta) : null
  if (!next) return Date.parse(previous.eta)
  const start = Date.parse(previous.eta)
  return start + (Date.parse(next.eta) - start) * (mile - previous.distance_miles) / (next.distance_miles - previous.distance_miles)
}

function googleMapsDirections(stops: Coordinates[]) {
  const coords = ({ lat, lon }: Coordinates) => `${lat.toFixed(6)},${lon.toFixed(6)}`
  const destination = stops.at(-1)
  if (!destination) return null
  const query = new URLSearchParams({ api: '1', travelmode: 'driving', destination: coords(destination), dir_action: 'navigate' })
  if (stops.length > 1) query.set('waypoints', stops.slice(0, -1).map(coords).join('|'))
  return `https://www.google.com/maps/dir/?${query}`
}

function TripGpsPanel({ trip, route, fix, match, offRoute, following, message, unit, onFollow, onReplan }: {
  trip: PlanResult
  route: RouteOption
  fix: GpsFix | null
  match: RouteMatch | null
  offRoute: boolean
  following: boolean
  message: string
  unit: DistanceUnit
  onFollow: () => void
  onReplan: () => void
}) {
  const timeZone = useContext(TimeZoneContext)
  let eta: number | null = null
  let nextWeather: { distance: number; forecast?: Forecast; eta: number } | undefined
  let approachingRisk: { distance: number; risk: Risk } | undefined
  let nextStep: string | undefined
  if (fix && match && !offRoute && fix.accuracy <= 100) {
    const currentTime = plannedTimeAtMile(route.checkpoints, match.miles)
    const finalTime = route.checkpoints.at(-1)?.eta
    if (currentTime !== null && finalTime) {
      eta = fix.timestamp + Math.max(0, Date.parse(finalTime) - currentTime)
      for (let index = firstCheckpointAfter(route.checkpoints, match.miles); index < route.checkpoints.length; index++) {
        const point = route.checkpoints[index]
        const arrival = fix.timestamp + Math.max(0, Date.parse(point.eta) - currentTime)
        const base = point.forecast[0]?.time
        const shift = base ? Math.round((arrival - Date.parse(base)) / 3_600_000) : NaN
        const forecast = Number.isInteger(shift) && shift >= 0 ? checkpointForecast(route, index, shift) : undefined
        const distance = point.distance_miles - match.miles
        nextWeather ??= { distance, forecast, eta: arrival }
        const risk = forecast?.risk ?? 'Unavailable'
        if (risk !== 'Low' && risk !== 'Moderate') {
          approachingRisk = { distance, risk }
          break
        }
      }
    }
    const legs = routeLegsFor(route, trip)
    const legOffset = legs.slice(0, match.legIndex).reduce((sum, leg) => sum + leg.distance_miles, 0)
    const next = legs[match.legIndex]?.steps.find((step) => step.start_miles !== undefined && legOffset + step.start_miles > match.miles + 0.01)
    nextStep = next?.instruction
  }

  const stops = trip.stops?.length ? trip.stops : [trip.destination]
  const remainingStops = stops.slice(match?.legIndex ?? 0)
  // Mobile web Maps URLs support up to three intermediate waypoints.
  const nextStopOnly = remainingStops.length > 4
  const navigationLink = googleMapsDirections(nextStopOnly ? remainingStops.slice(0, 1) : remainingStops)
  const status = message || (!fix ? 'Waiting for GPS…' : fix.accuracy > 100 ? 'GPS accuracy is low. Waiting for a better position.'
    : offRoute ? 'You appear to be off the planned route.' : !match ? 'Locating you on the route…' : 'On the planned route')
  return <section className="gps-panel" aria-labelledby="gps-panel-title">
    <h3 id="gps-panel-title">Live trip</h3>
    <p role="status">{status}</p>
    {fix && <p>GPS accuracy ±{Math.round(fix.accuracy)} m</p>}
    {match && eta !== null && <dl className="checkpoint-facts">
      <div><dt>Distance remaining</dt><dd>{formatDistance(Math.max(0, route.distance_miles - match.miles), unit)}</dd></div>
      <div><dt>ETA at planned pace</dt><dd>{formatTime(eta, timeZone)}</dd></div>
    </dl>}
    {nextStep && <p><strong>Upcoming on the planned route</strong> · {nextStep}</p>}
    {nextWeather && <p>
      <strong>Next weather checkpoint</strong> · {formatDistance(nextWeather.distance, unit)} ahead, ETA {formatTime(nextWeather.eta, timeZone)}
      <span className="risk-text gps-risk" data-risk={nextWeather.forecast?.risk ?? 'Unavailable'}>{nextWeather.forecast?.risk ?? 'Forecast unavailable for updated ETA'}</span>
    </p>}
    {approachingRisk && <p className="risk-text" data-risk={approachingRisk.risk}>{approachingRisk.risk === 'Unavailable' ? 'Forecast gap' : approachingRisk.risk} {formatDistance(approachingRisk.distance, unit)} ahead</p>}
    <div className="gps-actions">
      <ButtonBase type="button" aria-pressed={following} onClick={onFollow}>{following ? 'Pause map following' : 'Follow on map'}</ButtonBase>
      {offRoute && <ButtonBase type="button" disabled={!fix || fix.accuracy > 100} onClick={onReplan}>Replan from GPS</ButtonBase>}
      {navigationLink && <a href={navigationLink} target="_blank" rel="noreferrer">{nextStopOnly ? 'Navigate to next stop in Google Maps' : 'Navigate in Google Maps'}</a>}
    </div>
    <p className="gps-note">Google Maps calculates its own driving route when opened.</p>
  </section>
}

function App() {
  const [page, setPage] = useState<'map' | 'settings'>(() => window.location.pathname.replace(/\/$/, '') === '/settings' ? 'settings' : 'map')
  const [searchOpen, setSearchOpen] = useState(false)
  const [editingTrip, setEditingTrip] = useState(false)
  const [mapExpanded, setMapExpanded] = useState(false)
  const [tracking, setTracking] = useState(false)
  const [followingGps, setFollowingGps] = useState(false)
  const { fix: gpsFix, message: gpsMessage } = useTripGps(tracking && page === 'map')
  const lastGpsMatch = useRef<{ index: NonNullable<ReturnType<typeof indexRoute>>; match: RouteMatch | null; missed: number } | null>(null)
  const [gpsMatch, setGpsMatch] = useState<typeof lastGpsMatch.current>(null)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => localStorage.getItem('truck-routing-theme') === 'dark' ? 'dark' : 'light')
  const muiTheme = useMemo(() => createAppTheme(theme), [theme])
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>(() => localStorage.getItem('truck-routing-distance-unit') === 'km' ? 'km' : 'mi')
  const [temperatureUnit, setTemperatureUnit] = useState<TemperatureUnit>(() => {
    const saved = localStorage.getItem('truck-routing-temperature-unit')
    if (saved === 'c' || saved === 'f') return saved
    return localStorage.getItem('truck-routing-distance-unit') === 'km' ? 'c' : 'f'
  })
  const [zoomShortcut, setZoomShortcut] = useState(0)
  const [heatmapShortcutRequest, setHeatmapShortcutRequest] = useState(0)
  const [timeZone, setTimeZone] = useState(() => {
    const stored = localStorage.getItem('mapme-time-zone')
    return stored && isValidTimeZone(stored) ? stored : DEVICE_TIME_ZONE
  })
  const [origin, setOrigin] = useState('')
  const [originCoordinates, setOriginCoordinates] = useState<Coordinates | null>(null)
  const [deviceLocation, setDeviceLocation] = useState<Coordinates | null>(null)
  const [locationNotice, setLocationNotice] = useState('')
  const [locationAccess, setLocationAccess] = useState<'checking' | 'available' | 'unavailable'>('checking')
  const [destination, setDestination] = useState('')
  const [destinationId, setDestinationId] = useState('destination-0')
  const [destinationSelection, setDestinationSelection] = useState<LocationSuggestion | null>(null)
  const [extraDestinations, setExtraDestinations] = useState<TripDestination[]>([])
  const [scheduleTime, setScheduleTime] = useState('')
  const [scheduleOccurrence, setScheduleOccurrence] = useState(0)
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('now')
  const [loadWeight, setLoadWeight] = useState(() => distanceUnit === 'km' ? String(Math.round(38500 * POUNDS_TO_KILOGRAMS)) : '38500')
  const [weightPounds, setWeightPounds] = useState<number | null>(38500)
  const [intervalMiles, setIntervalMiles] = useState(25)
  const [nearbySearch, setNearbySearch] = useState<NearbySearchState>({ category: null, loading: false, error: '', places: [] })
  const [focusedNearbyPlace, setFocusedNearbyPlace] = useState<NearbyPlace | null>(null)
  const [selectedPlace, setSelectedPlace] = useState<SelectedPlace | null>(null)
  const [requestedHour, setForecastHour] = useState(0)
  const [checkpointSelection, setCheckpointSelection] = useState<{ routeId: string; index: number } | null>(null)
  const [checkpointFocusRequest, setCheckpointFocusRequest] = useState(0)
  const numericInputUntil = useRef(0)
  const sliderFrame = useRef(0)
  const [satellite, setSatellite] = useState(false)
  const [centerLocationRequest, setCenterLocationRequest] = useState(0)
  const [closeLocationPopupRequest, setCloseLocationPopupRequest] = useState(0)
  const [plannedTrip, setResult] = useState<DisplayedTrip | null>(null)
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null)
  const [hoveredRouteId, setHoveredRouteId] = useState<string | null>(null)
  const handlePlaceSelected = useCallback((place: SelectedPlace | null) => {
    const active = document.activeElement
    if (place?.loading && !active?.closest('.place-details')) {
      placeOpener.current = active instanceof HTMLElement && active !== document.body ? active : null
    }
    setSelectedPlace(place)
    setFocusedNearbyPlace((current) => current && current.id !== place?.id ? null : current)
  }, [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const locationRequested = useRef(false)
  const locationRequestId = useRef(0)
  const manualOrigin = useRef(false)
  const stopSequence = useRef(0)
  const focusAfterRender = useRef<string | null>(null)
  const placeOpener = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!focusAfterRender.current) return
    const element = document.getElementById(focusAfterRender.current)
    focusAfterRender.current = null
    if (element?.id === 'trip-results-title') {
      element.closest('.planner-card')?.scrollTo({ top: 0 })
      element.focus({ preventScroll: true })
      return
    }
    element?.focus()
  })
  const routeRequest = useRef<{ controller: AbortController; key: string; draft: string } | null>(null)
  const destinationIsSet = destinationSelection?.label === destination.trim()
  const destinationCount = (destinationIsSet ? 1 : 0) + extraDestinations.length
  const showOrigin = destinationIsSet || (searchOpen && (locationAccess === 'unavailable' || Boolean(origin && origin !== 'My location')))
  const nearbyOriginQuery = !originCoordinates && origin.trim() && origin.trim().toLocaleLowerCase() !== 'my location' ? origin.trim() : ''
  const nearbyOriginCoordinates = nearbyOriginQuery ? null : originCoordinates
  const originSearch = useLocationSuggestions(showOrigin && !originCoordinates && origin.toLocaleLowerCase() !== 'my location' ? origin : '')
  const destinationSearch = useLocationSuggestions(destinationIsSet ? '' : destination, nearbyOriginCoordinates, nearbyOriginQuery)

  function nearbyContextBeforeExtra(index: number) {
    const previous = index === 0
      ? { query: destination, selection: destinationSelection }
      : extraDestinations[index - 1]
    if (previous?.selection && previous.selection.label === previous.query.trim()) {
      return { nearbyLocation: previous.selection, nearbyQuery: '' }
    }
    if (previous?.query.trim()) return { nearbyLocation: null, nearbyQuery: previous.query.trim() }
    return { nearbyLocation: nearbyOriginCoordinates, nearbyQuery: nearbyOriginQuery }
  }

  function findWaypointConflict(candidate: Coordinates, excludeStopId?: string, ignoreDestination = false, ignoreOrigin = false) {
    const start = originCoordinates ?? (origin.trim() ? { label: origin.trim() } : null)
    const candidateLabel = candidate.label ?? 'That location'
    if (!ignoreOrigin && sameLocation(candidate, start)) return `“${candidateLabel}” is already the starting point.`
    if (!ignoreDestination && destinationSelection && destinationSelection.label === destination.trim() && sameLocation(candidate, destinationSelection)) {
      return `“${candidateLabel}” is already in the trip.`
    }
    const duplicateStop = extraDestinations.find((stop) => stop.id !== excludeStopId && stop.selection && stop.selection.label === stop.query.trim() && sameLocation(candidate, stop.selection))
    if (duplicateStop) return `“${candidateLabel}” is already in the trip.`
    return ''
  }

  useEffect(() => {
    const onPopState = () => {
      const next = window.location.pathname.replace(/\/$/, '') === '/settings' ? 'settings' : 'map'
      if (next === 'map' && page === 'settings') focusAfterRender.current = 'settings-trigger'
      setPage(next)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [page])

  useEffect(() => { localStorage.setItem('truck-routing-theme', theme) }, [theme])
  useEffect(() => { localStorage.setItem('truck-routing-distance-unit', distanceUnit) }, [distanceUnit])
  useEffect(() => { localStorage.setItem('truck-routing-temperature-unit', temperatureUnit) }, [temperatureUnit])
  useEffect(() => { localStorage.setItem('mapme-time-zone', timeZone) }, [timeZone])
  function changeDistanceUnit(unit: DistanceUnit) {
    if (unit === distanceUnit) return
    if (weightPounds !== null) {
      const value = unit === 'km' ? weightPounds * POUNDS_TO_KILOGRAMS : weightPounds
      setLoadWeight(String(Number(value.toFixed(3))))
    }
    setDistanceUnit(unit)
  }

  function saveSettings(settings: { theme: 'light' | 'dark'; distanceUnit: DistanceUnit; temperatureUnit: TemperatureUnit; timeZone: string }) {
    if (settings.timeZone !== timeZone) {
      const instants = wallTimeInstants(scheduleTime, timeZone)
      const instant = scheduleMode === 'now' ? new Date() : instants[scheduleOccurrence] ?? instants[0]
      if (instant) {
        const value = dateTimeInputValue(instant, settings.timeZone)
        const occurrence = wallTimeInstants(value, settings.timeZone).findIndex((candidate) => candidate.getTime() === instant.getTime())
        setScheduleTime(value)
        setScheduleOccurrence(Math.max(0, occurrence))
      }
      setTimeZone(settings.timeZone)
    }
    setTheme(settings.theme)
    changeDistanceUnit(settings.distanceUnit)
    setTemperatureUnit(settings.temperatureUnit)
  }

  function changeLoadWeight(value: string) {
    numericInputUntil.current = performance.now() + 140
    const number = Number(value)
    setLoadWeight(value)
    setWeightPounds(value.trim() && Number.isFinite(number) ? Math.round(number * (distanceUnit === 'km' ? KILOGRAMS_TO_POUNDS : 1)) : null)
    setError('')
  }

  function navigatePage(nextPage: 'map' | 'settings') {
    const nextPath = nextPage === 'settings' ? '/settings' : '/'
    if (window.location.pathname !== nextPath) window.history.pushState({ page: nextPage }, '', nextPath)
    if (nextPage === 'map') focusAfterRender.current = 'settings-trigger'
    setPage(nextPage)
  }

  const locateUser = useCallback((mode: 'initial' | 'center' | 'origin') => {
    const requestId = ++locationRequestId.current
    const unavailable = () => {
      if (requestId !== locationRequestId.current) return
      setLocationAccess('unavailable')
      if (mode !== 'initial') setLocationNotice('Device location is unavailable.')
    }
    if (!navigator.geolocation) {
      unavailable()
      return
    }
    setLocationAccess('checking')
    setLocationNotice('')
    try {
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => {
          if (requestId !== locationRequestId.current) return
          const location = { lat: coords.latitude, lon: coords.longitude, label: 'My location' }
          setLocationAccess('available')
          setDeviceLocation(location)
          if (mode === 'center') {
            setCenterLocationRequest((request) => request + 1)
            return
          }
          if (mode === 'initial' && manualOrigin.current) return
          manualOrigin.current = mode === 'origin'
          setOriginCoordinates(location)
          setOrigin(location.label)
          setError('')
        },
        unavailable,
        { enableHighAccuracy: false, maximumAge: 300_000, timeout: 12_000 },
      )
    } catch {
      unavailable()
    }
  }, [])

  useEffect(() => {
    if (page !== 'map' || locationRequested.current) return
    locationRequested.current = true
    locateUser('initial')
  }, [locateUser, page])

  const handleGlobalKeys = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (page !== 'map' || event.defaultPrevented || event.isComposing || isTextEntryTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === '/' && !document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) {
      event.preventDefault()
      event.stopPropagation()
      if (mapExpanded || (result && !editingTrip)) {
        focusAfterRender.current = 'destination'
        setMapExpanded(false)
        if (result) setEditingTrip(true)
      } else {
        document.getElementById('destination')?.focus()
      }
      return
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      event.stopPropagation()
      setZoomShortcut((current) => current + 1)
      return
    }
    if (event.key === '-' || event.key === '_') {
      event.preventDefault()
      event.stopPropagation()
      setZoomShortcut((current) => current - 1)
      return
    }
    if (event.key.toLowerCase() === 's') {
      event.preventDefault()
      event.stopPropagation()
      setSatellite((current) => !current)
      return
    }
    if (event.key.toLowerCase() === 'h') {
      event.preventDefault()
      event.stopPropagation()
      setHeatmapShortcutRequest((request) => request + 1)
      return
    }
    if (event.key === 'Escape' && selectedPlace) {
      event.preventDefault()
      event.stopPropagation()
      dismissLocationDetails(true)
    }
  })
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => handleGlobalKeys(event)
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const allDestinationsSet = destinationIsSet && extraDestinations.every((stop) => stop.selection?.label === stop.query.trim())
  const loadWeightMax = distanceUnit === 'km' ? 200000 * POUNDS_TO_KILOGRAMS : 200000
  const tripWeightValid = weightPounds !== null && Number(loadWeight) >= 0 && Number(loadWeight) <= loadWeightMax
  const scheduleInstants = useMemo(() => wallTimeInstants(scheduleTime, timeZone), [scheduleTime, timeZone])
  const scheduleInstant = scheduleInstants[scheduleOccurrence] ?? scheduleInstants[0]
  const scheduleError = scheduleMode === 'now' ? '' : tripTimeError(scheduleInstant)
  const scheduleValid = !scheduleError
  const tripSettingsValid = scheduleValid && tripWeightValid
  const settingsKey = [scheduleMode, scheduleMode === 'now' ? null : scheduleInstant?.toISOString() ?? scheduleTime, weightPounds, intervalMiles]

  function tripWaypointsKey(stops: Array<{ label: string; lat?: number; lon?: number; country?: string }>) {
    const waypoint = ({ lat, lon, label, country }: { lat?: number; lon?: number; label?: string; country?: string }) =>
      [lat, lon, label?.trim(), country || null]
    return JSON.stringify([originCoordinates && waypoint(originCoordinates), stops.map(waypoint)])
  }

  const waypointKey = allDestinationsSet && originCoordinates
    ? tripWaypointsKey([destinationSelection!, ...extraDestinations.map((stop) => stop.selection!)]) : null
  const planKey = waypointKey && tripSettingsValid ? JSON.stringify([waypointKey, settingsKey]) : null
  const draftKey = planKey ?? JSON.stringify([
    originCoordinates, origin, destination, destinationSelection, extraDestinations, settingsKey, loadWeight,
  ])
  const displayedTrip = waypointKey && plannedTrip?.waypointKey === waypointKey ? plannedTrip : null
  const result = displayedTrip?.result ?? null
  const previousPlan = Boolean(displayedTrip && (displayedTrip.key !== planKey || loading))
  const selectedRoute = result?.routes.find((route) => route.id === selectedRouteId) ?? result?.routes[0] ?? null
  const forecastHour = Math.min(requestedHour, Math.max(0, (selectedRoute?.metrics_by_hour.length ?? 1) - 1))
  const recommendedRouteId = result && !previousPlan ? recommendRoute(result.routes, forecastHour).recommended?.id ?? null : null
  const selectedCheckpoint = checkpointSelection && checkpointSelection.routeId === selectedRoute?.id
    && selectedRoute.checkpoints[checkpointSelection.index] ? checkpointSelection.index : null
  const gpsGeometry = selectedRoute?.road_legs ?? selectedRoute?.legs
  const gpsCoordinates = selectedRoute?.coordinates
  const gpsDistance = selectedRoute?.distance_miles ?? 0
  const gpsRoute = useMemo(() => {
    if (!tracking || !gpsCoordinates) return null
    const paths = routeGeometry({ legs: gpsGeometry, coordinates: gpsCoordinates, distance_miles: gpsDistance })
    return indexRoute(paths, gpsGeometry?.map((leg) => leg.distance_miles) ?? [gpsDistance])
  }, [gpsCoordinates, gpsDistance, gpsGeometry, tracking])
  useEffect(() => {
    if (!gpsRoute) {
      lastGpsMatch.current = null
      return
    }
    if (!gpsFix || gpsFix.accuracy > 100) return
    const previous = lastGpsMatch.current?.index === gpsRoute ? lastGpsMatch.current : null
    const match = matchRoute(gpsRoute, gpsFix, previous?.match?.miles)
    if (!match) return
    const missed = match.distanceFromRoute > Math.max(55, 2 * gpsFix.accuracy)
    const update = {
      index: gpsRoute,
      match: missed ? previous?.match ?? null : match,
      missed: missed ? (previous?.missed ?? 0) + 1 : 0,
    }
    lastGpsMatch.current = update
    setGpsMatch(update)
  }, [gpsFix, gpsRoute])
  const currentGpsMatch = gpsMatch?.index === gpsRoute ? gpsMatch : null
  const editorVisible = !result || editingTrip
  const nearbyCategoryLabel = nearbyCategories.find((category) => category.key === nearbySearch.category)?.label ?? 'Nearby places'

  const completeNearbySearch = useCallback((category: string, places: NearbyPlace[], searchError: string) => {
    setNearbySearch((current) => current.category === category
      ? { ...current, loading: false, places, error: searchError }
      : current)
  }, [])

  function toggleNearbySearch(category: string) {
    dismissLocationDetails()
    setNearbySearch((current) => current.category === category
      ? { category: null, loading: false, error: '', places: [] }
      : { category, loading: true, error: '', places: [] })
  }

  function makeStopId() {
    stopSequence.current += 1
    return `trip-stop-${stopSequence.current}`
  }

  function dismissLocationDetails(restoreFocus = false) {
    setSelectedPlace(null)
    setFocusedNearbyPlace(null)
    setCloseLocationPopupRequest((request) => request + 1)
    if (restoreFocus) {
      const opener = placeOpener.current
      if (opener?.isConnected) opener.focus()
      else focusAfterRender.current = 'route-map'
      placeOpener.current = null
    }
  }

  function addEmptyStop() {
    if (!destinationIsSet || destinationCount >= MAX_TRIP_DESTINATIONS) return
    const id = makeStopId()
    setExtraDestinations((stops) => [...stops, { id, query: '', selection: null }])
    focusAfterRender.current = id
    dismissLocationDetails()
    setResult(null)
    setSelectedRouteId(null)
    setError('')
  }

  function updateExtraStop(id: string, query: string, selection: LocationSuggestion | null = null) {
    if (selection) {
      const conflict = findWaypointConflict(selection, id)
      if (conflict) {
        setError(`${conflict} Choose a different stop.`)
        return
      }
    }
    setExtraDestinations((stops) => stops.map((stop) => stop.id === id ? { ...stop, query, selection } : stop))
    if (selection) {
      setSelectedPlace(null)
      setFocusedNearbyPlace(null)
      setCloseLocationPopupRequest((request) => request + 1)
    }
    setResult(null)
    setSelectedRouteId(null)
    setError('')
  }

  function moveDestination(index: number, direction: -1 | 1) {
    const destinations: TripDestination[] = [
      { id: destinationId, query: destination, selection: destinationSelection },
      ...extraDestinations,
    ]
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= destinations.length) return
    ;[destinations[index], destinations[nextIndex]] = [destinations[nextIndex], destinations[index]]
    setDestinationId(destinations[0].id)
    setDestination(destinations[0].query)
    setDestinationSelection(destinations[0].selection)
    setExtraDestinations(destinations.slice(1))
    setResult(null)
    setSelectedRouteId(null)
    setError('')
  }

  function removeExtraStop(id: string) {
    const index = extraDestinations.findIndex((stop) => stop.id === id)
    focusAfterRender.current = (extraDestinations[index + 1] ?? extraDestinations[index - 1])?.id ?? 'add-stop'
    setExtraDestinations((stops) => stops.filter((stop) => stop.id !== id))
    setResult(null)
    setSelectedRouteId(null)
    setError('')
  }

  function addStopFromPlace(place: SelectedPlace) {
    if (!destinationIsSet || destinationCount >= MAX_TRIP_DESTINATIONS) return
    const label = routePlaceLabel(place.name, place.address)
    const selection: LocationSuggestion = {
      name: place.name,
      detail: place.address,
      label,
      lat: place.lat,
      lon: place.lon,
      country: place.country ?? undefined,
    }
    const conflict = findWaypointConflict(selection)
    if (conflict) {
      setError(`${conflict} Choose a different stop.`)
      return
    }
    setExtraDestinations((stops) => [...stops, { id: makeStopId(), query: selection.label, selection }])
    dismissLocationDetails()
    setResult(null)
    setSelectedRouteId(null)
    setError('')
  }

  function selectDestination(suggestion: LocationSuggestion) {
    const conflict = findWaypointConflict(suggestion, undefined, true)
    if (conflict) {
      setError(`${conflict} Choose a different destination.`)
      return
    }
    setDestination(suggestion.label)
    setDestinationSelection(suggestion)
    destinationSearch.dismiss()
    setResult(null)
    setSelectedRouteId(null)
    setSearchOpen(true)
    setNearbySearch({ category: null, loading: false, error: '', places: [] })
    dismissLocationDetails()
    setError('')
  }

  function routeToPlace(place: SelectedPlace) {
    const label = routePlaceLabel(place.name, place.address)
    const suggestion: LocationSuggestion = {
      name: place.name,
      detail: place.address,
      label,
      lat: place.lat,
      lon: place.lon,
      country: place.country ?? undefined,
    }
    selectDestination(suggestion)
  }

  function setPlaceAsOrigin(place: SelectedPlace) {
    const label = routePlaceLabel(place.name, place.address)
    const conflict = findWaypointConflict({ label, lat: place.lat, lon: place.lon }, undefined, false, true)
    if (conflict) {
      setError(`${conflict} Choose a different starting point.`)
      return
    }
    manualOrigin.current = true
    setOrigin(label)
    setOriginCoordinates({ lat: place.lat, lon: place.lon, label, country: place.country ?? undefined })
    dismissLocationDetails()
    setResult(null)
    setSelectedRouteId(null)
    setError('')
  }

  function selectOriginSuggestion(suggestion: LocationSuggestion) {
    const conflict = findWaypointConflict(suggestion, undefined, false, true)
    if (conflict) {
      setError(`${conflict} Choose a different starting point.`)
      return
    }
    manualOrigin.current = true
    setOrigin(suggestion.label)
    setOriginCoordinates({
      lat: suggestion.lat,
      lon: suggestion.lon,
      label: suggestion.label,
      country: suggestion.country,
    })
    originSearch.dismiss()
    setResult(null)
    setSelectedRouteId(null)
    setError('')
  }

  function handleOriginKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !originCoordinates && origin.trim().length >= 2) {
      event.preventDefault()
      originSearch.move(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (originCoordinates && originCoordinates.label === origin.trim()) {
        void planRoute()
        return
      }
      if (originSearch.loading) return
      const suggestion = originSearch.matches[originSearch.active] ?? originSearch.matches[0]
      if (suggestion) selectOriginSuggestion(suggestion)
      else setError('Choose a starting point from the location suggestions.')
    } else if (event.key === 'Escape') {
      originSearch.dismiss()
    }
  }

  function selectNearbyPlace(place: NearbyPlace) {
    const opener = document.activeElement
    placeOpener.current = opener instanceof HTMLElement && opener !== document.body ? opener : null
    setMapExpanded(false)
    focusAfterRender.current = 'place-title'
    setFocusedNearbyPlace(place)
    setSelectedPlace({
      id: place.id,
      attributions: place.attributions,
      name: place.name,
      address: place.address || place.detail,
      country: place.country,
      lat: place.lat,
      lon: place.lon,
      photos: place.photos,
      category: place.category,
      website: place.website,
      phone: place.phone,
      opening_hours: place.opening_hours,
      loading: true,
    })
  }

  function handleDestinationKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !destinationIsSet && destination.trim().length >= 2) {
      event.preventDefault()
      destinationSearch.move(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (loading || destinationSearch.loading) return
      if (destinationIsSet && destinationSelection) {
        void planRoute(destinationSelection)
        return
      }
      const suggestion = destinationSearch.matches[destinationSearch.active] ?? destinationSearch.matches[0]
      if (suggestion) selectDestination(suggestion)
      else if (destination.trim()) {
        destinationSearch.dismiss()
        void planRoute({ label: destination.trim() })
      }
    } else if (event.key === 'Escape') {
      destinationSearch.dismiss()
    }
  }

  async function planRoute(target: { label: string; lat?: number; lon?: number; country?: string } | null = destinationSelection) {
    const timeError = scheduleMode === 'now' ? '' : tripTimeError(scheduleInstant)
    if (timeError || !tripWeightValid) {
      setError(timeError || 'Complete the required load weight and checkpoint settings to plan this trip.')
      return
    }
    if (!target) {
      setError('Choose a destination from the location suggestions first.')
      return
    }
    if (extraDestinations.some((stop) => !stop.selection || stop.selection.label !== stop.query.trim())) {
      setError('Choose a location for every added stop before planning the trip.')
      return
    }
    if (!originCoordinates) {
      setError(origin.trim()
        ? 'Choose a starting point from the location suggestions before planning this route.'
        : 'Location is unavailable. Choose a starting point before planning this route.')
      return
    }
    const stops = [target, ...extraDestinations.map((stop) => stop.selection!)]
    const waypoints = [originCoordinates, ...stops]
    for (let first = 0; first < waypoints.length; first += 1) {
      for (let second = first + 1; second < waypoints.length; second += 1) {
        if (sameLocation(waypoints[first], waypoints[second])) {
          setError(`${waypointLetter(first)} and ${waypointLetter(second)} cannot use the same location. Choose a different place for each waypoint.`)
          return
        }
      }
    }
    let requestWaypointsKey = tripWaypointsKey(stops)
    const key = JSON.stringify([requestWaypointsKey, settingsKey])
    if (routeRequest.current?.key === key && !routeRequest.current.controller.signal.aborted) return
    routeRequest.current?.controller.abort()
    const controller = new AbortController()
    routeRequest.current = { controller, key, draft: draftKey }
    setLoading(true)
    setError('')
    const sameTrip = displayedTrip?.waypointKey === requestWaypointsKey
    if (!sameTrip) {
      window.cancelAnimationFrame(sliderFrame.current)
      setForecastHour(0)
    }
    let completedKey: string | null = null
    try {
      const response = await fetch('/api/route-plans?delivery=progressive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          origin_coordinates: originCoordinates,
          origin_label: originCoordinates.label ?? origin,
          stops: stops.map((stop) => ({
            label: stop.label,
            country: stop.country,
            ...(typeof stop.lat === 'number' && typeof stop.lon === 'number'
              ? { coordinates: { lat: stop.lat, lon: stop.lon, country: stop.country } }
              : {}),
          })),
          requested_time: (scheduleMode === 'now' ? new Date() : scheduleInstant!).toISOString(),
          time_mode: scheduleMode === 'arrival' ? 'arrival' : 'departure',
          load_weight_lb: weightPounds,
          checkpoint_interval_miles: intervalMiles,
        }),
      })
      function showPlan(data: PlanResult, finished: boolean) {
        completedKey = key
        if (!destinationIsSet) {
          const firstStop = data.stops?.[0] ?? data.destination
          const selectedFirstStop: LocationSuggestion = { ...firstStop, name: firstStop.label, detail: '' }
          requestWaypointsKey = tripWaypointsKey([selectedFirstStop, ...stops.slice(1)])
          completedKey = JSON.stringify([requestWaypointsKey, settingsKey])
          setDestination(firstStop.label)
          setDestinationSelection(selectedFirstStop)
          destinationSearch.dismiss()
        }
        if (routeRequest.current?.controller === controller) {
          routeRequest.current.draft = completedKey
          routeRequest.current.key = completedKey
        }
        if (!sameTrip && !editingTrip) {
          if (document.activeElement?.closest('.trip-form')) focusAfterRender.current = 'trip-results-title'
        }
        setResult({ key: completedKey, waypointKey: requestWaypointsKey, result: data, finished, failedPlayback: [] })
        setSelectedRouteId((currentId) => {
          const previousRoute = sameTrip && displayedTrip?.result.routes.find((route) => route.id === currentId)
          const choices = previousRoute ? previousRoute.legs?.map((leg) => leg.route_alternative) : undefined
          const matchingRoute = choices && data.routes.find((route) => route.legs?.length === choices.length
            && route.legs.every((leg, index) => leg.route_alternative === choices[index]))
          return matchingRoute?.id ?? data.recommended_route_id ?? data.routes[0]?.id ?? null
        })
        setCheckpointSelection(null)
        setCheckpointFocusRequest(0)
        setLoading(false)
        dismissLocationDetails()
      }

      if (response.ok && response.body && response.headers.get('content-type')?.includes('application/x-ndjson')) {
        await readRouteFeed<PlanUpdate>(response.body, (update) => {
          if (controller.signal.aborted) return
          if (update.type === 'plan') {
            showPlan(unpackPlan(update.plan), false)
            // Give React a task boundary to commit the initial route before decoding playback.
            return new Promise<void>((resolve) => window.setTimeout(resolve, 0))
          }
          if (update.type === 'playback_error') {
            setResult((current) => current && current.key === completedKey
              ? { ...current, failedPlayback: [...current.failedPlayback, update.route_id] } : current)
            return
          }
          setResult((current) => current && current.key === completedKey
            ? { ...current, result: applyPlanUpdate(current.result, update) }
            : current)
        })
        if (!controller.signal.aborted && !completedKey) throw new Error('The routing service returned an empty plan.')
      } else {
        const fallback = response.status === 504
          ? 'Route planning timed out. Try again, or use wider weather checkpoint spacing for a long trip.'
          : 'Could not plan this trip. Check the API connection and try again.'
        const data = await readApiResponse<PlanResult>(response, fallback)
        if (!controller.signal.aborted) showPlan(data, true)
      }
    } catch (requestError) {
      if (!controller.signal.aborted) {
        if (!completedKey) setError(requestError instanceof Error ? requestError.message : 'Could not plan this trip.')
      }
    } finally {
      if (routeRequest.current?.controller === controller) {
        if (completedKey) setResult((current) => current && current.key === completedKey
          ? { ...current, finished: true } : current)
        routeRequest.current = null
        setLoading(false)
      }
    }
  }

  const runAutomaticPlan = useEffectEvent(() => {
    if (!routeRequest.current || routeRequest.current.controller.signal.aborted) void planRoute()
  })
  useLayoutEffect(() => {
    if (routeRequest.current && (page !== 'map' || routeRequest.current.draft !== draftKey)) {
      routeRequest.current.controller.abort()
    }
  }, [draftKey, page])

  useEffect(() => {
    if (!planKey || plannedTrip?.key === planKey || page !== 'map') return
    const delay = numericInputUntil.current - performance.now()
    if (delay <= 0) {
      runAutomaticPlan()
      return
    }
    const timer = window.setTimeout(() => runAutomaticPlan(), delay)
    return () => window.clearTimeout(timer)
  }, [planKey, plannedTrip?.key, page])

  useEffect(() => () => {
    routeRequest.current?.controller.abort()
    window.cancelAnimationFrame(sliderFrame.current)
  }, [])

  async function submitTrip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!tripSettingsValid) {
      setError(scheduleError || 'Complete the required load weight and checkpoint settings to plan this trip.')
      return
    }
    if (!allDestinationsSet) {
      setError('Choose a location for every destination and stop before planning the trip.')
      return
    }
    await planRoute()
  }

  function toggleTracking() {
    if (!tracking && !selectedRoute) return
    setTracking(!tracking)
    setFollowingGps(!tracking)
  }

  function replanFromGps() {
    if (!gpsFix || gpsFix.accuracy > 100 || !destinationSelection || !result) return
    const newOrigin = { lat: gpsFix.lat, lon: gpsFix.lon, label: 'Current GPS position' }
    let remaining: TripDestination[] = [{ id: destinationId, query: destination, selection: destinationSelection }, ...extraDestinations]
      .slice(currentGpsMatch?.match?.legIndex ?? 0)
    if (remaining.length > 1 && sameLocation(newOrigin, remaining[0].selection)) remaining = remaining.slice(1)
    if (!remaining.length || remaining.some((stop) => sameLocation(newOrigin, stop.selection))) {
      setError('Your GPS position is already at a remaining waypoint.')
      return
    }
    manualOrigin.current = true
    setOrigin(newOrigin.label)
    setOriginCoordinates(newOrigin)
    setDestinationId(remaining[0].id)
    setDestination(remaining[0].query)
    setDestinationSelection(remaining[0].selection)
    setExtraDestinations(remaining.slice(1))
    setScheduleMode('now')
    window.cancelAnimationFrame(sliderFrame.current)
    setForecastHour(0)
    setError('')
  }

  function changeForecastHour(hour: number) {
    window.cancelAnimationFrame(sliderFrame.current)
    sliderFrame.current = window.requestAnimationFrame(() => setForecastHour(hour))
  }

  function selectCheckpoint(index: number, pan = false) {
    if (!selectedRoute) return
    setCheckpointSelection({ routeId: selectedRoute.id, index })
    if (pan) setCheckpointFocusRequest((previous) => previous + 1)
  }

  function toggleTripEditor() {
    setEditingTrip(!editingTrip)
    setMapExpanded(false)
    focusAfterRender.current = editingTrip ? 'trip-results-title' : 'destination'
  }

  function selectRoute(id: string) {
    setSelectedRouteId(id)
    setCheckpointSelection(null)
    setCheckpointFocusRequest(0)
  }

  if (page === 'settings') {
    return <ThemeProvider theme={muiTheme}><CssBaseline />
      <Suspense fallback={<main className="settings-shell" role="status">Loading settings…</main>}>
        <SettingsPage theme={theme} distanceUnit={distanceUnit} temperatureUnit={temperatureUnit} timeZone={timeZone} onSave={saveSettings} onBack={() => navigatePage('map')} />
      </Suspense>
    </ThemeProvider>
  }

  return (
    <ThemeProvider theme={muiTheme}>
    <TimeZoneContext.Provider value={timeZone}>
    <CssBaseline />
    <Box className={`app-shell planning-shell${searchOpen || result || selectedPlace ? ' planner-active' : ''}${mapExpanded ? ' map-expanded' : ''}`} data-theme={theme}>
      {result && !mapExpanded && <a className="skip-link" href="#trip-results-title">Skip to route results</a>}
      <a className="skip-link" href="#route-map">Skip to map</a>
      <Paper component="aside" elevation={0} className="planner-card" aria-label="Route planner">
        <h1 className="sr-only">Route planner</h1>
        <header className={`planner-header${result || tracking ? '' : ' planner-header-empty'}`}>
          <div>
            {(result || tracking) && <ButtonBase type="button" className="planner-action gps-toggle" aria-pressed={tracking}
              disabled={!tracking && previousPlan} onClick={toggleTracking}>{tracking ? 'Stop GPS' : 'Follow trip'}</ButtonBase>}
            {result && <ButtonBase type="button" className="planner-action edit-trip" aria-expanded={editorVisible} aria-controls="trip-editor" onClick={toggleTripEditor}>{editingTrip ? 'Done editing' : 'Edit trip'}</ButtonBase>}
            <ButtonBase type="button" className="planner-action map-panel-toggle" aria-expanded={!mapExpanded} aria-controls="planner-content" onClick={() => setMapExpanded((visible) => !visible)}>{mapExpanded ? result ? 'Trip details' : 'Trip planner' : 'Show map'}</ButtonBase>
          </div>
        </header>
        <div className="planner-content" id="planner-content">
        <Box component="form" id="trip-editor" hidden={!editorVisible} className="trip-form" onSubmit={submitTrip}>
          <div className="search-panel">
            <div className="search-fields">
              {showOrigin && <label className="waypoint-label" htmlFor="origin">Starting point</label>}
              {showOrigin && <div className="location-field origin-field has-destination">
                <InputWaypointIcon letter="A" />
                <InputBase
                  id="origin"
                  inputProps={{
                    'aria-label': 'Starting point',
                    role: 'combobox',
                    'aria-autocomplete': 'list',
                    'aria-expanded': originSearch.visible,
                    'aria-controls': originSearch.visible ? 'origin-suggestions' : undefined,
                    'aria-activedescendant': activeSuggestionId('origin-suggestions', originSearch),
                  }}
                  value={origin}
                  onFocus={() => { setSearchOpen(true); originSearch.reopen() }}
                  onBlur={originSearch.dismiss}
                  onChange={(event) => {
                    originSearch.reopen()
                    manualOrigin.current = true
                    setOrigin(event.target.value)
                    setOriginCoordinates(null)
                    setResult(null)
                    setSelectedRouteId(null)
                    setError('')
                  }}
                  onKeyDown={handleOriginKeyDown}
                  placeholder="Starting point"
                  autoComplete="off"
                  required={!originCoordinates}
                />
                <IconButton className="icon-button locate-button" type="button" onClick={() => locateUser('origin')} title="Use my location" aria-label="Use my location"><Icon name="currentLocation" /></IconButton>
              </div>}
              <SearchSuggestions id="origin-suggestions" name="Starting point" search={originSearch} onSelect={selectOriginSuggestion} />
              {destinationIsSet && locationAccess === 'unavailable' && !originCoordinates && <div className="origin-location-hint" role="status">Location is unavailable. Choose a starting point to prioritize nearby search results.</div>}
              <div className="location-field destination-field">
                {destination.trim() && <InputWaypointIcon letter="B" end />}
                <InputBase
                  id="destination"
                  inputProps={{
                    'aria-label': 'Destination',
                    'aria-keyshortcuts': '/',
                    role: 'combobox',
                    'aria-autocomplete': 'list',
                    'aria-expanded': destinationSearch.visible,
                    'aria-controls': destinationSearch.visible ? 'destination-suggestions' : undefined,
                    'aria-activedescendant': activeSuggestionId('destination-suggestions', destinationSearch),
                  }}
                  value={destination}
                  onFocus={() => { setSearchOpen(true); destinationSearch.reopen() }}
                  onBlur={destinationSearch.dismiss}
                  onChange={(event) => {
                    destinationSearch.reopen()
                    setDestination(event.target.value)
                    setDestinationSelection(null)
                    setResult(null)
                    setSelectedRouteId(null)
                    dismissLocationDetails()
                    setError('')
                  }}
                  onKeyDown={handleDestinationKeyDown}
                  placeholder="Where to?"
                  autoComplete="off"
                  required
                />
                {destinationIsSet && extraDestinations.length > 0 && <ButtonBase
                  className="stop-order-button"
                  type="button"
                  onClick={() => moveDestination(0, 1)}
                  aria-label="Move first destination down"
                  title="Move down"
                ><Icon name="arrowDown" size={16} /></ButtonBase>}
              </div>
              {extraDestinations.map((stop, index) => {
                const context = nearbyContextBeforeExtra(index)
                return <ExtraDestinationInput
                    key={stop.id}
                    stop={stop}
                    stopNumber={index + 2}
                    nearbyLocation={context.nearbyLocation}
                    nearbyQuery={context.nearbyQuery}
                    canMoveUp
                    canMoveDown={index < extraDestinations.length - 1}
                    onChange={(query) => updateExtraStop(stop.id, query)}
                    onSelect={(selection) => updateExtraStop(stop.id, selection.label, selection)}
                    onMoveUp={() => moveDestination(index + 1, -1)}
                    onMoveDown={() => moveDestination(index + 1, 1)}
                    onRemove={() => removeExtraStop(stop.id)}
                  />
              })}
            </div>
            {destinationIsSet && (destinationCount < MAX_TRIP_DESTINATIONS
              ? <Button id="add-stop" className="add-stop-button" type="button" variant="text" startIcon={<Icon name="plus" size={17} />} onClick={addEmptyStop}>Add stop</Button>
              : <p className="destination-limit">Maximum {MAX_TRIP_DESTINATIONS} destinations per trip</p>)}
            {!destinationIsSet && <div className="nearby-panel" aria-label="Find Nearby">
              <strong>Find Nearby</strong>
              <div className="nearby-list" role="group" aria-label="Nearby categories">
                {nearbyCategories.map(({ key, label, icon }) => (
                  <ButtonBase
                    className={'nearby-category' + (nearbySearch.category === key ? ' active' : '')}
                    type="button"
                    aria-pressed={nearbySearch.category === key}
                    aria-label={`Find nearby ${label.toLowerCase()}`}
                    title={`Find nearby ${label.toLowerCase()}`}
                    key={key}
                    onClick={() => toggleNearbySearch(key)}
                  >
                    <Icon name={icon} size={19} />
                    <span>{label}</span>
                  </ButtonBase>
                ))}
              </div>
            </div>}
          </div>
          {nearbySearch.category && !destinationIsSet && <Paper component="section" elevation={0} className="nearby-results" aria-label={`${nearbyCategoryLabel} nearby`} aria-live="polite">
            <div className="nearby-results-heading">
              <strong>{nearbyCategoryLabel}</strong>
              <span className="google-credit">Google Maps</span>
            </div>
            <small className="nearby-results-note">Within {formatDistance(3.5 / MILES_TO_KILOMETERS, distanceUnit)} of the map center</small>
            {nearbySearch.loading
              ? <p>Searching nearby places…</p>
              : nearbySearch.error
                ? <p className="nearby-results-error" role="alert">{nearbySearch.error}</p>
                : nearbySearch.places.length
                  ? <ul className="nearby-results-list">
                    {nearbySearch.places.slice(0, 8).map((place) => (
                      <li key={place.id}>
                        <ButtonBase
                          type="button"
                          className={focusedNearbyPlace?.id === place.id ? 'selected' : ''}
                          onClick={() => selectNearbyPlace(place)}
                        >
                          <Icon name="mapPin" size={16} />
                          <span><strong>{place.name}</strong><small>{place.detail}</small></span>
                        </ButtonBase>
                      </li>
                    ))}
                  </ul>
                  : <p>No places found within {formatDistance(3.5 / MILES_TO_KILOMETERS, distanceUnit)}.</p>}
          </Paper>}
          <SearchSuggestions id="destination-suggestions" name="Destination" search={destinationSearch} onSelect={selectDestination}
            hint={locationAccess === 'unavailable' && !nearbyOriginCoordinates && !nearbyOriginQuery
              ? 'Device location is unavailable. Choose a starting point to prioritize nearby places.'
              : undefined}
          />
          {destinationIsSet && <section className="trip-settings" id="trip-settings" aria-label="Trip settings">
            <div className="interval-row">
              <span className="setting-caption">Route timing</span>
              <div className="segmented-control" role="group" aria-label="Trip timing">
                {([['now', 'Leave now'], ['departure', 'Depart at'], ['arrival', 'Arrive by']] as const).map(([mode, label]) => (
                  <ButtonBase key={mode} type="button" className={scheduleMode === mode ? 'active' : ''} aria-pressed={scheduleMode === mode} onClick={() => {
                    if (mode === scheduleMode) return
                    if (mode !== 'now') { setScheduleTime(''); setScheduleOccurrence(0) }
                    setError('')
                    setScheduleMode(mode)
                  }}>{label}</ButtonBase>
                ))}
              </div>
            </div>
            <div className="settings-grid">
              {scheduleMode !== 'now' && <div className="settings-field">
                <label htmlFor="trip-time">
                <span>{scheduleMode === 'departure' ? 'Departure time' : 'Arrival time'}</span>
                </label>
                <InputBase id="trip-time" type="datetime-local" value={scheduleTime} inputProps={{ 'aria-invalid': !scheduleValid, 'aria-describedby': scheduleValid ? undefined : 'trip-time-error' }} onChange={(event) => { numericInputUntil.current = performance.now() + 140; setScheduleTime(event.target.value); setScheduleOccurrence(0); setError('') }} required />
                {!scheduleValid && <small className="field-error" id="trip-time-error">{scheduleError}</small>}
                {scheduleInstants.length > 1 && <div className="schedule-occurrence">
                  <small>This time occurs twice because the clocks change.</small>
                  <div className="segmented-control" role="group" aria-label="Time occurrence">
                    {['First occurrence', 'Second occurrence'].map((label, index) => <ButtonBase key={label} type="button" className={scheduleOccurrence === index ? 'active' : ''} aria-pressed={scheduleOccurrence === index} onClick={() => setScheduleOccurrence(index)}>{label}</ButtonBase>)}
                  </div>
                </div>}
              </div>}
              <div className="settings-field">
                <label htmlFor="weight">Load weight ({distanceUnit === 'km' ? 'kg' : 'lb'})</label>
                <InputBase id="weight" type="number" inputProps={{ min: 0, max: loadWeightMax, step: 'any', 'aria-invalid': !tripWeightValid, 'aria-describedby': tripWeightValid ? undefined : 'trip-weight-error' }} value={loadWeight} onChange={(event) => changeLoadWeight(event.target.value)} required />
                {!tripWeightValid && <small className="field-error" id="trip-weight-error">Enter a weight from 0 to {formatWeight(200000, distanceUnit)}.</small>}
              </div>
            </div>
            <div className="interval-row">
              <span className="setting-caption">Weather checkpoints *</span>
              <div className="segmented-control" role="group" aria-label="Weather checkpoint spacing">
                {[10, 25, 50].map((distance) => <ButtonBase key={distance} type="button" className={intervalMiles === distance ? 'active' : ''} aria-pressed={intervalMiles === distance} onClick={() => { setIntervalMiles(distance); setError('') }}>{formatDistance(distance, distanceUnit)}</ButtonBase>)}
              </div>
            </div>
          </section>}

        </Box>

          <div className="route-update-status" role="status">{loading && <><CircularProgress className="spinner" size={15} thickness={5} aria-hidden="true" /> {previousPlan ? 'Showing the previous plan while routes update…' : 'Finding routes and checking the forecast…'}</>}</div>

          {error && <Alert
            severity="error"
            variant="outlined"
            icon={false}
            className="error-box"
            role="alert"
            sx={{
              display: 'grid',
              gap: 0.5,
              mt: 1,
              p: '14px 16px',
              '& .MuiAlert-message': {
                display: 'grid',
                gap: 0.75,
                width: '100%',
                p: 0,
              },
              '& .MuiAlert-message > .MuiTypography-root': {
                display: 'block',
                m: 0,
                lineHeight: 1.5,
              },
            }}
          ><Typography component="strong" variant="subtitle2">Couldn’t plan this trip</Typography><Typography component="span" variant="body2">{error}</Typography>{planKey && !loading && <Button size="small" onClick={() => void planRoute()}>Retry planning</Button>}</Alert>}

        {selectedPlace && <Paper component="section" elevation={0} className="place-details" aria-labelledby="place-title">
          <div className="place-details-heading">
            <div><span>{selectedPlace.category || 'Selected location'}</span><strong id="place-title" tabIndex={-1}>{selectedPlace.name}</strong></div>
            <IconButton className="place-close" type="button" onClick={() => dismissLocationDetails(true)} aria-label="Close location details" title="Close location details"><Icon name="minus" size={19} /></IconButton>
          </div>
          <div className="place-photos" aria-label="Location photos">
            {selectedPlace.photos.length
              ? selectedPlace.photos.map((photo) => <figure key={photo.url}>
                <img src={photo.url} alt={photo.title} loading="lazy" onError={(event) => { event.currentTarget.hidden = true }} />
                {photo.authors?.length ? <figcaption><AttributionLinks credits={photo.authors} /></figcaption> : null}
              </figure>)
              : <div className="place-photo-placeholder">{selectedPlace.loading ? 'Finding photos…' : 'No photos available for this location'}</div>}
          </div>
          <p className="place-address">{selectedPlace.address || 'Address unavailable'}</p>
          <p className="google-credit">Google Maps <AttributionLinks credits={selectedPlace.attributions} /></p>
          {selectedPlace.loading && <p className="place-status" role="status">Loading location details…</p>}
          {selectedPlace.error && <p className="place-status error" role="status">{selectedPlace.error}</p>}
          {selectedPlace.weather && <div className="place-weather">
            <strong>{selectedPlace.weather.condition ?? 'Weather unavailable'}{selectedPlace.weather.temperature_f === null ? '' : `, ${formatTemperature(selectedPlace.weather.temperature_f, temperatureUnit)}`}</strong>
            <span>Feels like {formatTemperature(selectedPlace.weather.feels_like_f, temperatureUnit)}, humidity {selectedPlace.weather.humidity_percent ?? 'unavailable'}%</span>
            <span>Wind {formatSpeed(selectedPlace.weather.wind_mph, distanceUnit)}, gusts {formatSpeed(selectedPlace.weather.gust_mph, distanceUnit)}</span>
            <span>Rain {formatPrecipitation(selectedPlace.weather.rain_in_hr, distanceUnit)}, snow {formatPrecipitation(selectedPlace.weather.snow_in_hr, distanceUnit)}</span>
            <span>Truck weather risk <b className="risk-text" data-risk={selectedPlace.weather.risk}>{selectedPlace.weather.risk}</b></span>
          </div>}
          {(selectedPlace.website || selectedPlace.phone || selectedPlace.opening_hours) && <div className="place-contact">
            {selectedPlace.website && <a href={websiteHref(selectedPlace.website)} target="_blank" rel="noreferrer">Website</a>}
            {selectedPlace.phone && <a href={`tel:${selectedPlace.phone.replace(/[^+\d]/g, '')}`}>{selectedPlace.phone}</a>}
            {selectedPlace.opening_hours && <span>{selectedPlace.opening_hours}</span>}
          </div>}
          <div className="place-actions">
            <Button type="button" variant="contained" disableElevation className="place-directions" onClick={() => routeToPlace(selectedPlace)} startIcon={<Icon name="mapPin" size={17} />}>Directions</Button>
            {destinationIsSet && <ButtonBase type="button" className="place-add-stop" disabled={destinationCount >= MAX_TRIP_DESTINATIONS} title={destinationCount >= MAX_TRIP_DESTINATIONS ? 'Maximum 5 destinations per trip' : 'Add stop'} onClick={() => addStopFromPlace(selectedPlace)}><Icon name="plus" size={17} /> Add stop</ButtonBase>}
            <ButtonBase type="button" className="place-origin" onClick={() => setPlaceAsOrigin(selectedPlace)}><Icon name="currentLocation" size={17} /> Set as starting point</ButtonBase>
          </div>
        </Paper>}

        {tracking && result && selectedRoute && !previousPlan && <TripGpsPanel
          trip={result} route={selectedRoute} fix={gpsFix} match={currentGpsMatch?.match ?? null}
          offRoute={Boolean(currentGpsMatch && currentGpsMatch.missed >= 3)} following={followingGps}
          message={gpsMessage} unit={distanceUnit} onFollow={() => setFollowingGps((current) => !current)} onReplan={replanFromGps}
        />}
        {displayedTrip && selectedRoute && <RouteResults trip={displayedTrip} route={selectedRoute} hour={forecastHour}
          unit={distanceUnit} previous={previousPlan} checkpointIndex={selectedCheckpoint} hoveredRouteId={hoveredRouteId}
          onRoute={selectRoute} onRouteHover={setHoveredRouteId} onHour={changeForecastHour} onCheckpoint={(index) => selectCheckpoint(index, true)}
        />}
        </div>
      </Paper>

      <Box component="main" id="route-map" tabIndex={-1} className="map-pane" aria-label="Route map">
      <RouteMap result={result} currentLocation={deviceLocation} originLocation={originCoordinates} destinationSelection={destinationSelection}
          centerLocationRequest={centerLocationRequest} closeLocationPopupRequest={closeLocationPopupRequest}
          selectedRoute={selectedRoute} forecastHour={forecastHour}
          recommendedRouteId={recommendedRouteId} hoveredRouteId={hoveredRouteId} onRoute={selectRoute} onRouteHover={setHoveredRouteId}
          selectedCheckpoint={selectedCheckpoint} checkpointFocusRequest={checkpointFocusRequest} onCheckpoint={selectCheckpoint}
          satellite={satellite} theme={theme} gps={gpsFix} followingGps={followingGps}
          zoomShortcut={zoomShortcut} heatmapShortcutRequest={heatmapShortcutRequest}
          onMapPan={() => { if (tracking) setFollowingGps(false) }} distanceUnit={distanceUnit} temperatureUnit={temperatureUnit} loadWeightLb={result?.load_weight_lb ?? (tripWeightValid ? weightPounds! : Number.NaN)}
          nearbySearch={nearbySearch} focusedNearbyPlace={focusedNearbyPlace} onNearbyComplete={completeNearbySearch}
          onPlaceSelected={handlePlaceSelected} onNearbyPlaceSelect={selectNearbyPlace}
        />
        <div className="map-toolbar" role="group" aria-label="Map options">
          <IconButton className="map-icon-button" type="button" onClick={() => { if (gpsFix) setFollowingGps(true); else locateUser('center') }} aria-label="Center on my location" title="Center on my location"><Icon name="currentLocation" /></IconButton>
          <IconButton className={'map-icon-button' + (satellite ? ' active' : '')} type="button" onClick={() => setSatellite((value) => !value)} aria-label="Satellite imagery" aria-pressed={satellite} title={satellite ? 'Switch to street map' : 'Switch to satellite imagery'}><Icon name="satellite" /></IconButton>
          <IconButton id="settings-trigger" className="map-icon-button" type="button" onClick={() => navigatePage('settings')} aria-label="Open settings" title="Settings"><Icon name="settings" /></IconButton>
        </div>
        {locationNotice && <div className="location-notice" role="status">{locationNotice}</div>}
        {previousPlan && <div className="map-previous-label">Previous plan{loading ? ' · Updating routes' : ''}</div>}
        {result && selectedRoute && <div className="map-route-legend" aria-label="Route map legend">
          {recommendedRouteId && <span><i className="recommended-route-swatch" />Recommended route</span>}
          {result.routes.length > 1 && <span><i className="alternative-route-swatch" />Other routes</span>}
          <span>Selected route shows weather risk</span>
          {result.routes.length > 1 && <span>Hover or select a route to highlight it</span>}
        </div>}

      </Box>
    </Box>
    </TimeZoneContext.Provider>
    </ThemeProvider>
  )
}
export default App
