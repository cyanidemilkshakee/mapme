export type TemperatureHeatmap = {
  points: { latitude: number; longitude: number; temperature_f: number | null; surface: 'land' | 'water' }[]
  grid: { rows: number; columns: number; south: number; west: number; north: number; east: number }
  coverage: 'land' | 'mixed' | 'water' | 'outside-map'
  global_view: boolean
  land_mask: string | null
  mask_size: number
}

export const TEMPERATURE_STOPS = [
  { celsius: -90, color: '#d6f4ff' },
  { celsius: -70, color: '#e2d8fa' },
  { celsius: -50, color: '#f2e5ef' },
  { celsius: -40, color: '#c51b8a' },
  { celsius: -30, color: '#7500a8' },
  { celsius: -20, color: '#1600b3' },
  { celsius: -10, color: '#123cff' },
  { celsius: 0, color: '#00c9f3' },
  { celsius: 8, color: '#31edb5' },
  { celsius: 14, color: '#d7f22b' },
  { celsius: 20, color: '#ffd000' },
  { celsius: 24, color: '#ff7800' },
  { celsius: 27, color: '#f12200' },
  { celsius: 30, color: '#650000' },
  { celsius: 40, color: '#490416' },
  { celsius: 50, color: '#2c0818' },
]

export const fahrenheitFromCelsius = (celsius: number) => celsius * 9 / 5 + 32
export const isTemperature = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const minimum = TEMPERATURE_STOPS[0].celsius
const maximum = TEMPERATURE_STOPS[TEMPERATURE_STOPS.length - 1].celsius
export const TEMPERATURE_GRADIENT = `linear-gradient(to right, ${TEMPERATURE_STOPS.map(({ celsius, color }) =>
  `${color} ${(celsius - minimum) / (maximum - minimum) * 100}%`).join(', ')})`
const colorStepsPerDegree = 8
const palette = new Uint8ClampedArray(((maximum - minimum) * colorStepsPerDegree + 1) * 3)
const stops = TEMPERATURE_STOPS.map(({ celsius, color }) => ({ celsius, rgb: Number.parseInt(color.slice(1), 16) }))
let end = 1
for (let index = 0; index < palette.length / 3; index++) {
  const temperature = minimum + index / colorStepsPerDegree
  if (temperature > stops[end].celsius) end++
  const { celsius: start, rgb: from } = stops[end - 1]
  const { celsius: finish, rgb: to } = stops[end]
  const fraction = (temperature - start) / (finish - start)
  for (let channel = 0; channel < 3; channel++) {
    const shift = (2 - channel) * 8
    const a = (from >> shift) & 0xff
    const b = (to >> shift) & 0xff
    palette[index * 3 + channel] = a + (b - a) * fraction
  }
}

const radians = Math.PI / 180
const earthRadiusKm = 6371
const southPolarLimit = -60 * radians
const haversineDistance = (km: number) => Math.sin(km / (2 * earthRadiusKm)) ** 2

export function temperatureRaster({ grid, points, coverage, land_mask, mask_size: size }: TemperatureHeatmap) {
  const { north, south, west, east } = grid
  if ((coverage !== 'land' && coverage !== 'mixed') || !size || north <= south || east <= west) return null

  // The server packs one bit per pixel, row-major from the northwest corner.
  const land = land_mask ? atob(land_mask) : null
  if (coverage === 'mixed' && (!land || land.length * 8 !== size * size)) return null

  const samples = points.flatMap(({ latitude, longitude, surface, temperature_f }) => {
    if (surface !== 'land' || !isTemperature(temperature_f)) return []
    const lon = longitude * radians
    const longitudeTerms = Float64Array.from({ length: size }, (_, x) => {
      const column = (west + (x + 0.5) * (east - west) / size) * radians
      return Math.sin((lon - column) / 2) ** 2
    })
    const lat = latitude * radians
    return [{ lat, cosLat: Math.cos(lat), temperature: (temperature_f - 32) * 5 / 9, longitudeTerms }]
  })
  if (!samples.length) return null

  const top = Math.asinh(Math.tan(north * radians))
  const height = top - Math.asinh(Math.tan(south * radians))
  const pixels = new Uint8ClampedArray(size * size * 4)
  const spacingKm = Math.hypot(
    (north - south) * 111.32 / Math.max(1, grid.rows),
    (east - west) * 111.32 * Math.cos((north + south) / 2 * radians) / Math.max(1, grid.columns),
  )
  // Use the diagonal spacing to bridge neighboring sample cells at wide
  // zooms. A fixed local radius made a sparse world grid look like dots.
  const reachKm = Math.max(350, Math.min(6500, spacingKm * 1.15))
  const reach = haversineDistance(reachKm)
  const fullOpacityReach = haversineDistance(reachKm * 0.87)
  const distanceFloor = haversineDistance(Math.max(0.1, spacingKm * 0.12))
  const inverseReach = 1 / reach
  for (let y = 0; y < size; y++) {
    const latitude = Math.atan(Math.sinh(top - (y + 0.5) * height / size))
    const cosLatitude = Math.cos(latitude)
    const polar = latitude < southPolarLimit
    // The latitude term alone can rule out samples for this entire row.
    const row = samples.flatMap(({ lat, cosLat, temperature, longitudeTerms }) => {
      if ((lat < southPolarLimit) !== polar) return []
      const latitudeTerm = Math.sin((latitude - lat) / 2) ** 2
      return latitudeTerm < reach ? [{ latitudeTerm, cosineTerm: cosLatitude * cosLat, temperature, longitudeTerms }] : []
    })
    if (!row.length) continue
    for (let x = 0; x < size; x++) {
      const pixel = y * size + x
      if (land && !(land.charCodeAt(pixel >> 3) & (1 << (pixel & 7)))) continue

      let closest = reach
      let weighted = 0
      let weights = 0
      for (const sample of row) {
        const distance = sample.latitudeTerm + sample.cosineTerm * sample.longitudeTerms[x]
        if (distance >= reach) continue
        closest = Math.min(closest, distance)
        const taper = 1 - distance * inverseReach
        const weight = taper * taper / (distance + distanceFloor)
        weighted += sample.temperature * weight
        weights += weight
      }
      if (!weights) continue

      const temperature = Math.max(minimum, Math.min(maximum, weighted / weights))
      const color = Math.round((temperature - minimum) * colorStepsPerDegree) * 3
      const offset = pixel * 4
      pixels[offset] = palette[color]
      pixels[offset + 1] = palette[color + 1]
      pixels[offset + 2] = palette[color + 2]
      const fade = Math.min(1, (reach - closest) / (reach - fullOpacityReach))
      pixels[offset + 3] = 255 * fade * fade * (3 - 2 * fade)
    }
  }
  return { pixels, size, north, south }
}
