import { geometryDistance } from './routeGeometry.ts'

type Coordinate = [number, number]
type Segment = { a: Coordinate; b: Coordinate; start: number; end: number; legIndex: number }
type Bounds = { south: number; north: number; west: number; east: number }
type Node = Bounds & { left?: Node; right?: Node; start: number; end: number }
type RouteIndex = { segments: Segment[]; root: Node; distance: number }
export type RouteMatch = { distanceFromRoute: number; miles: number; legIndex: number }
const METERS_PER_DEGREE = 111_195

export function indexRoute(paths: Coordinate[][], legMiles: number[]): RouteIndex | null {
  const segments: Segment[] = []
  let offset = 0
  paths.forEach((path, legIndex) => {
    const lengths = path.slice(1).map((point, index) => geometryDistance(path[index], point))
    const total = lengths.reduce((sum, length) => sum + length, 0)
    const distance = legMiles[legIndex] ?? total
    let miles = offset
    lengths.forEach((length, index) => {
      const end = miles + (total ? length * distance / total : 0)
      if (length) segments.push({ a: path[index], b: path[index + 1], start: miles, end, legIndex })
      miles = end
    })
    offset += distance
  })
  if (!segments.length) return null

  function build(start: number, end: number): Node {
    if (end - start > 8) {
      const mid = start + Math.floor((end - start) / 2)
      const left = build(start, mid), right = build(mid, end)
      return { start, end, left, right, south: Math.min(left.south, right.south), north: Math.max(left.north, right.north),
        west: Math.min(left.west, right.west), east: Math.max(left.east, right.east) }
    }
    const bounds = { south: Infinity, north: -Infinity, west: Infinity, east: -Infinity }
    for (let i = start; i < end; i++) {
      const { a, b } = segments[i]
      bounds.south = Math.min(bounds.south, a[0], b[0])
      bounds.north = Math.max(bounds.north, a[0], b[0])
      bounds.west = Math.min(bounds.west, a[1], b[1])
      bounds.east = Math.max(bounds.east, a[1], b[1])
    }
    return { start, end, ...bounds }
  }
  return { segments, root: build(0, segments.length), distance: offset }
}

export function matchRoute(index: RouteIndex, point: { lat: number; lon: number }, previousMiles?: number): RouteMatch | null {
  const { lat } = point
  const { root, segments } = index
  const lon = point.lon + 360 * Math.round(((root.east + root.west) / 2 - point.lon) / 360)
  const lngScale = METERS_PER_DEGREE * Math.max(0.01, Math.cos(lat * Math.PI / 180))
  let best: RouteMatch | null = null
  let closest = Infinity
  const bound = (node: Node) => Math.hypot(
    Math.max(node.south - lat, 0, lat - node.north) * METERS_PER_DEGREE,
    Math.max(node.west - lon, 0, lon - node.east) * lngScale,
  )
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()!
    if (bound(node) > closest + 12) continue
    if (node.left && node.right) {
      if (bound(node.left) < bound(node.right)) stack.push(node.right, node.left)
      else stack.push(node.left, node.right)
      continue
    }
    for (let i = node.start; i < node.end; i++) {
      const { a, b, start, end, legIndex } = segments[i]
      const x = (a[1] - lon) * lngScale, y = (a[0] - lat) * METERS_PER_DEGREE
      const dx = (b[1] - a[1]) * lngScale, dy = (b[0] - a[0]) * METERS_PER_DEGREE
      const fraction = Math.max(0, Math.min(1, -(x * dx + y * dy) / (dx * dx + dy * dy)))
      const distanceFromRoute = Math.hypot(x + dx * fraction, y + dy * fraction)
      const miles = start + fraction * (end - start)
      closest = Math.min(closest, distanceFromRoute)
      const tie = best !== null && previousMiles !== undefined && Math.abs(distanceFromRoute - best.distanceFromRoute) <= 12
      if (best === null || (tie ? Math.abs(miles - previousMiles) < Math.abs(best.miles - previousMiles) : distanceFromRoute < best.distanceFromRoute)) {
        best = { distanceFromRoute, miles, legIndex }
      }
    }
  }
  return best
}

export function firstCheckpointAfter(points: { distance_miles: number }[], miles: number) {
  let first = 0, last = points.length
  while (first < last) {
    const mid = first + Math.floor((last - first) / 2)
    if (points[mid].distance_miles <= miles) first = mid + 1
    else last = mid
  }
  return first
}
