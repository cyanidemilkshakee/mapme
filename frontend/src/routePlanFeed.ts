export type PackedForecast = [risk: number, wind: number | null, rain: number | null, snow: number | null, reasons: number[]]

export function decodePolyline(encoded: string): [number, number][] {
  const coordinates: [number, number][] = []
  let position = 0
  let latitude = 0
  let longitude = 0

  function readDelta() {
    let value = 0
    for (let shift = 0; shift <= 30; shift += 5) {
      const part = encoded.charCodeAt(position++) - 63
      if (!Number.isInteger(part) || part < 0 || part > 63) throw new Error('Route geometry is incomplete.')
      value |= (part & 31) << shift
      if (part < 32) return (value & 1 ? ~(value >>> 1) : value >>> 1)
    }
    throw new Error('Route geometry is invalid.')
  }

  while (position < encoded.length) {
    latitude += readDelta()
    longitude += readDelta()
    coordinates.push([latitude / 1_000_000, longitude / 1_000_000])
  }
  return coordinates
}

export async function readRouteFeed<T>(stream: ReadableStream<Uint8Array>, onEvent: (event: T) => void | Promise<void>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let fragments: string[] = []

  async function receive(text: string) {
    const lines = text.split('\n')
    for (let index = 0; index < lines.length - 1; index++) {
      fragments.push(lines[index])
      const line = fragments.join('')
      fragments = []
      if (line.trim()) {
        const update = onEvent(JSON.parse(line) as T)
        if (update) await update
      }
    }
    if (lines.at(-1)) fragments.push(lines.at(-1)!)
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      await receive(decoder.decode(value, { stream: true }))
    }
    await receive(decoder.decode())
    if (fragments.join('').trim()) throw new Error('The route update ended before all data arrived.')
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}
