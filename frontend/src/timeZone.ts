export const DEVICE_TIME_ZONE = 'device'

const partFormatters = new Map<string, Intl.DateTimeFormat>()
const displayFormatters = new Map<string, Intl.DateTimeFormat>()

export function isValidTimeZone(value: string) {
  if (value === DEVICE_TIME_ZONE) return true
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export function resolveTimeZone(value: string) {
  return value === DEVICE_TIME_ZONE ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' : value
}

export function timeZoneLabel(value: string) {
  const names: Record<string, string> = { 'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Europe/Kiev': 'Europe/Kyiv' }
  const zone = resolveTimeZone(value)
  const canonicalZone = names[zone] ?? zone
  const label = value === DEVICE_TIME_ZONE ? `Device: ${canonicalZone}` : (names[value] ?? value).replaceAll('_', ' ').replaceAll('/', ' / ')
  const offset = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(new Date()).find(({ type }) => type === 'timeZoneName')?.value ?? 'GMT'
  return `${label} ${offset === 'GMT' ? 'GMT+00:00' : offset}`
}

export function availableTimeZones(current: string) {
  const fallback = ['Africa/Johannesburg', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/New_York', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'Europe/London', 'Europe/Paris', 'Pacific/Auckland']
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : fallback
  return [...new Set(['UTC', ...zones, ...(current !== DEVICE_TIME_ZONE && isValidTimeZone(current) ? [current] : [])])]
    .filter((zone) => !zone.includes('GMT'))
    .sort((a, b) => a.localeCompare(b))
}

function dateTimeFormatter(timeZone: string) {
  const zone = resolveTimeZone(timeZone)
  let formatter = partFormatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
    partFormatters.set(zone, formatter)
  }
  return formatter
}

function zonedParts(date: Date, timeZone: string) {
  const parts = dateTimeFormatter(timeZone).formatToParts(date)
  return Object.fromEntries(parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]))
}

export function dateTimeInputValue(date: Date, timeZone: string) {
  const p = zonedParts(date, timeZone)
  return `${p.year.padStart(4, '0')}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

export function tripTimeError(instant: Date | undefined, now = new Date()) {
  if (!instant || !Number.isFinite(instant.getTime())) return 'Enter a valid local date and time.'
  if (instant <= now) return 'Choose a trip time in the future.'
  const forecastEnd = new Date(now)
  forecastEnd.setUTCHours(0, 0, 0, 0)
  forecastEnd.setUTCDate(forecastEnd.getUTCDate() + 7)
  if (instant >= forecastEnd) return 'Choose a trip time within the available seven-day forecast.'
  return ''
}

export function formatTime(value: string | number | Date, timeZone: string) {
  const zone = resolveTimeZone(timeZone)
  let formatter = displayFormatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, { timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    displayFormatters.set(zone, formatter)
  }
  return formatter.format(new Date(value))
}

/** Return every instant matching a wall time. Gaps return none; repeated times return two. */
export function wallTimeInstants(value: string, timeZone: string): Date[] {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !isValidTimeZone(timeZone)) return []
  const wall = new Date(`${value}:00Z`)
  if (!Number.isFinite(wall.getTime()) || wall.toISOString().slice(0, 16) !== value) return []
  const wallMs = wall.getTime()
  const offsets = new Set<number>()
  for (const hours of [-48, -24, -12, 0, 12, 24, 48]) {
    const sampleMs = wallMs + hours * 3_600_000
    const parts = zonedParts(new Date(sampleMs), timeZone)
    const represented = Date.parse(`${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`)
    if (Number.isFinite(represented)) offsets.add(represented - sampleMs)
  }
  return [...offsets].map((offset) => new Date(wallMs - offset))
    .filter((instant) => dateTimeInputValue(instant, timeZone) === value)
    .sort((a, b) => a.getTime() - b.getTime())
}
