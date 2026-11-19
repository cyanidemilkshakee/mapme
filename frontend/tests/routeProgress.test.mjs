import assert from 'node:assert/strict'
import test from 'node:test'
import { firstCheckpointAfter, indexRoute, matchRoute } from '../src/routeProgress.ts'

test('indexes road legs independently and reports along-route mileage', () => {
  const route = indexRoute([[[0, 0], [0, 1]], [[0, 1], [0, 2]]], [100, 80])
  const match = matchRoute(route, { lat: 0.0001, lon: 1.5 })
  assert.equal(match.legIndex, 1)
  assert.equal(match.miles, 140)
  assert.ok(match.distanceFromRoute > 10 && match.distanceFromRoute < 12)
})

test('continues progress across the antimeridian', () => {
  const route = indexRoute([[[10, 179.8], [10, 180.2]]], [40])
  const match = matchRoute(route, { lat: 10, lon: -179.9 })
  assert.ok(Math.abs(match.miles - 30) < 0.0001)
  assert.ok(match.distanceFromRoute < 1)
})

test('uses previous progress at a crossing instead of jumping ahead', () => {
  const route = indexRoute([[[0, 0], [0, 1], [0, 0]]], [100])
  assert.equal(matchRoute(route, { lat: 0, lon: 0.5 }, 10).miles, 25)
  assert.equal(matchRoute(route, { lat: 0, lon: 0.5 }, 80).miles, 75)
  assert.equal(firstCheckpointAfter([{ distance_miles: 25 }, { distance_miles: 25 }, { distance_miles: 40 }], 25), 2)
})
