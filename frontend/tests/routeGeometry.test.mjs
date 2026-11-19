import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRouteSegments, geometryDistance, routeGeometry } from '../src/routeGeometry.ts'

test('route paths preserve snapped leg endpoints without drawing a connector', () => {
  const route = {
    distance_miles: 20,
    coordinates: [[0, 0], [0, 1], [0, 1.01], [0, 2]],
    legs: [
      { distance_miles: 10, coordinates: [[0, 0], [0, 1]] },
      { distance_miles: 10, coordinates: [[0, 1.01], [0, 2]] },
    ],
    checkpoints: [
      { distance_miles: 0, leg_index: 0, geometry_fraction: 0 },
      { distance_miles: 10, leg_index: 0, geometry_fraction: 1 },
      { distance_miles: 10, leg_index: 1, geometry_fraction: 0 },
      { distance_miles: 20, leg_index: 1, geometry_fraction: 1 },
    ],
  }
  const paths = routeGeometry(route)
  const segments = buildRouteSegments(route, paths)
  assert.deepEqual(segments.map(({ coordinates }) => coordinates), paths)
  assert.deepEqual(segments.map(({ checkpoint }) => checkpoint), [route.checkpoints[0], route.checkpoints[2]])
})

test('risk segment boundaries follow the backend checkpoint position on the road', () => {
  const route = {
    distance_miles: 10,
    coordinates: [[0, 0], [0, 0.5], [0, 1]],
    checkpoints: [
      { distance_miles: 0, leg_index: 0, geometry_fraction: 0 },
      { distance_miles: 5, leg_index: 0, geometry_fraction: 0.75 },
      { distance_miles: 10, leg_index: 0, geometry_fraction: 1 },
    ],
  }
  const segments = buildRouteSegments(route, routeGeometry(route))
  assert.deepEqual(segments[0].coordinates, [[0, 0], [0, 0.5], [0, 0.75]])
  assert.deepEqual(segments[1].coordinates, [[0, 0.75], [0, 1]])
})

test('a route crossing the antimeridian takes the short path', () => {
  const route = { distance_miles: 14, coordinates: [[0, 179.9], [0, -179.9]] }
  const [[first, last]] = routeGeometry(route)
  assert.ok(Math.abs(last[1] - first[1]) < 1)
  assert.ok(geometryDistance(first, last) < 14)
  assert.ok(Number.isFinite(geometryDistance([0, 0], [0, 180])))
})

test('server vertex offsets segment geometry without browser distance calculations', () => {
  const route = {
    distance_miles: 10,
    coordinates: [[0, 179.9], [0, -179.9], [0.3, -179.8]],
    checkpoints: [
      { distance_miles: 0, leg_index: 0, segment_position: 0 },
      { distance_miles: 5, leg_index: 0, segment_position: 1.5 },
      { distance_miles: 10, leg_index: 0, segment_position: 2 },
    ],
  }
  const geometry = routeGeometry(route)
  const segments = buildRouteSegments(route, geometry)
  assert.deepEqual(segments.map((segment) => segment.index), [0, 1])
  assert.deepEqual(segments[0].coordinates[1], geometry[0][1])
  assert.deepEqual(segments[0].coordinates.at(-1), segments[1].coordinates[0])
  assert.equal(segments[1].coordinates[0][0], 0.15)
  assert.ok(Math.abs(segments[1].coordinates[0][1] - 180.15) < 1e-9)
})
