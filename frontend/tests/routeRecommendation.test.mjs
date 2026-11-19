import assert from 'node:assert/strict'
import test from 'node:test'
import { recommendRoute } from '../src/routeRecommendation.ts'

const clear = {
  no_travel_miles: 0, no_travel_checkpoints: 0, unknown_miles: 0, unknown_checkpoints: 0,
  severe_miles: 0, high_miles: 0, average_risk: 0, duration_minutes: 60,
}

test('changes the recommendation with the forecast while preserving route identity and order', () => {
  const routes = [
    { id: 'route-1', metrics_by_hour: [clear, { ...clear, high_miles: 20 }] },
    { id: 'route-2', metrics_by_hour: [{ ...clear, duration_minutes: 65 }, clear] },
  ]
  assert.equal(recommendRoute(routes, 0).recommended.id, 'route-1')
  assert.equal(recommendRoute(routes, 1).recommended.id, 'route-2')
  assert.deepEqual(routes.map(({ id }) => id), ['route-1', 'route-2'])
})

test('blocks a recommendation for No Travel or missing forecast checkpoints with zero distance', () => {
  const routes = [
    { metrics_by_hour: [{ ...clear, no_travel_checkpoints: 1 }] },
    { metrics_by_hour: [{ ...clear, unknown_checkpoints: 1 }] },
  ]
  assert.deepEqual(recommendRoute(routes, 0), { complete: true, recommended: null })
})

test('distinguishes a failed alternate forecast from a complete comparison with no recommendation', () => {
  const routes = [{ metrics_by_hour: [clear, clear] }, { metrics_by_hour: [clear] }]
  assert.equal(recommendRoute(routes, 0).recommended, routes[0])
  assert.deepEqual(recommendRoute(routes, 1), { complete: false, recommended: null })
})
