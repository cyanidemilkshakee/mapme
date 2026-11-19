export type RouteGeometryCheckpoint = {
  leg_index?: number
  geometry_fraction?: number
  segment_position?: number
  distance_miles: number
}

type RoadGeometry = {
  distance_miles: number
  coordinates: [number, number][]
  legs?: { coordinates?: [number, number][]; distance_miles: number }[]
}

export function routeGeometry(route: RoadGeometry) {
  const legCoordinates = route.legs?.map((leg) => leg.coordinates ?? [])
  const paths = legCoordinates?.length && legCoordinates.every((path) => path.length > 1)
    ? legCoordinates
    : [route.coordinates]
  let previousLongitude: number | undefined
  return paths.map((path) => path.map(([lat, lng]): [number, number] => {
    const longitude = previousLongitude === undefined ? lng : lng + 360 * Math.round((previousLongitude - lng) / 360)
    previousLongitude = longitude
    return [lat, longitude]
  }))
}

export function geometryDistance(a: [number, number], b: [number, number]) {
  const radians = Math.PI / 180
  const lat1 = a[0] * radians
  const lat2 = b[0] * radians
  const halfLongitudeDelta = (b[1] - a[1]) * radians / 2
  const haversine = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(halfLongitudeDelta) ** 2
  return 3958.7613 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, haversine))))
}

export function buildRouteSegments<T extends RouteGeometryCheckpoint>(route: RoadGeometry & { checkpoints: T[] }, paths: [number, number][][]) {
  const segments: { coordinates: [number, number][]; checkpoint: T; index: number }[] = []
  const grouped = paths.map((): number[] => [])
  const unassigned: number[] = []
  route.checkpoints.forEach((checkpoint, index) => {
    if (checkpoint.leg_index === undefined) unassigned.push(index)
    else grouped[checkpoint.leg_index]?.push(index)
  })
  let roadOffset = 0
  const totalMiles = route.checkpoints.at(-1)?.distance_miles ?? route.distance_miles
  paths.forEach((coordinates, legIndex) => {
    if (coordinates.length < 2) return
    const legMiles = paths.length === 1 ? totalMiles : route.legs![legIndex].distance_miles
    const anchored = grouped[legIndex].length > 1
      && !unassigned.length
      && grouped[legIndex].every((index) => route.checkpoints[index].segment_position !== undefined)

    if (anchored) {
      const pointAtVertex = (position: number): [number, number] => {
        const vertex = Math.floor(position)
        const fraction = position - vertex
        const [lat, lon] = coordinates[vertex]
        if (fraction === 0) return coordinates[vertex]
        const [nextLat, nextLon] = coordinates[vertex + 1]
        return [lat + (nextLat - lat) * fraction, lon + (nextLon - lon) * fraction]
      }
      const indices = grouped[legIndex]
      for (let offset = 0; offset + 1 < indices.length; offset++) {
        const index = indices[offset]
        const checkpoint = route.checkpoints[index]
        const start = checkpoint.segment_position!
        const end = route.checkpoints[indices[offset + 1]].segment_position!
        if (end <= start) continue
        const points = [pointAtVertex(start)]
        for (let vertex = Math.floor(start) + 1; vertex < end; vertex++) points.push(coordinates[vertex])
        points.push(pointAtVertex(end))
        segments.push({ coordinates: points, checkpoint, index })
      }
      roadOffset += legMiles
      return
    }

    const cumulative = [0]
    for (let index = 1; index < coordinates.length; index += 1) {
      cumulative.push(cumulative[index - 1] + geometryDistance(coordinates[index - 1], coordinates[index]))
    }
    const geometryLength = cumulative.at(-1)!
    let vertex = 1
    const pointAt = (distance: number): [number, number] => {
      while (vertex < cumulative.length - 1 && cumulative[vertex] < distance) vertex += 1
      const span = cumulative[vertex] - cumulative[vertex - 1]
      const fraction = span > 0 ? (distance - cumulative[vertex - 1]) / span : 0
      const [lat, lon] = coordinates[vertex - 1]
      const [nextLat, nextLon] = coordinates[vertex]
      return [lat + (nextLat - lat) * fraction, lon + (nextLon - lon) * fraction]
    }

    const indices = unassigned.length
      ? [...grouped[legIndex], ...unassigned].sort((a, b) => a - b)
      : grouped[legIndex]
    indices.forEach((index) => {
      const checkpoint = route.checkpoints[index]
      const next = route.checkpoints[index + 1]
      const start = Math.max(0, checkpoint.distance_miles - roadOffset)
      const end = Math.min(legMiles, (next?.distance_miles ?? totalMiles) - roadOffset)
      if (end <= start || !legMiles || !geometryLength) return
      const from = geometryLength * (checkpoint.geometry_fraction ?? start / legMiles)
      const to = geometryLength * (next?.geometry_fraction ?? end / legMiles)
      if (to <= from) return
      const path = [pointAt(from)]
      while (vertex < coordinates.length - 1 && cumulative[vertex] < to) {
        if (cumulative[vertex] > from) path.push(coordinates[vertex])
        vertex += 1
      }
      path.push(pointAt(to))
      segments.push({ coordinates: path, checkpoint, index })
    })
    roadOffset += legMiles
  })
  return segments
}
