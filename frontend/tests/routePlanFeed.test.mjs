import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodePolyline, readRouteFeed } from '../src/routePlanFeed.ts'

test('polyline6 decoder preserves signed coordinate deltas', () => {
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [
    [3.85, -12.02], [4.07, -12.095], [4.3252, -12.6453],
  ])
  assert.throws(() => decodePolyline('_'), /incomplete/)
})

test('feed delivers an initial plan and delayed playback in order', async () => {
  const events = []
  const encoder = new TextEncoder()
  const input = encoder.encode('{"type":"plan","name":"Québec"}\n{"type":"playback"}\n')
  const stream = new ReadableStream({
    start(controller) {
      for (const byte of input) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  })
  await readRouteFeed(stream, (event) => events.push(event))
  assert.deepEqual(events, [{ type: 'plan', name: 'Québec' }, { type: 'playback' }])
})

test('feed rejects truncated updates', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"plan"}\n{"type":"play'))
      controller.close()
    },
  })
  const events = []
  await assert.rejects(readRouteFeed(stream, (event) => events.push(event)), /ended before/)
  assert.deepEqual(events, [{ type: 'plan' }])
})
