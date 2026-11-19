import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dateTimeInputValue, formatTime, isValidTimeZone, timeZoneLabel, wallTimeInstants } from '../src/timeZone.ts'

test('converts scheduled wall times in the selected zone, including fractional-hour offsets', () => {
  assert.equal(wallTimeInstants('2026-06-01T09:15', 'Asia/Kathmandu')[0].toISOString(), '2026-06-01T03:30:00.000Z')
  assert.equal(dateTimeInputValue(new Date('2026-06-01T03:30:00Z'), 'Asia/Kathmandu'), '2026-06-01T09:15')
  assert.deepEqual(wallTimeInstants('2026-02-30T12:00', 'UTC'), [])
  assert.equal(isValidTimeZone('not/a-zone'), false)
})

test('rejects nonexistent times and offers both occurrences during clock changes', () => {
  assert.deepEqual(wallTimeInstants('2026-03-08T02:30', 'America/New_York'), [])
  assert.deepEqual(wallTimeInstants('2026-11-01T01:30', 'America/New_York').map((date) => date.toISOString()), [
    '2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z',
  ])
  assert.deepEqual(wallTimeInstants('2026-04-05T01:45', 'Australia/Lord_Howe').map((date) => date.toISOString()), [
    '2026-04-04T14:45:00.000Z', '2026-04-04T15:15:00.000Z',
  ])
})

test('omits offsets from trip times and includes them in time-zone choices', () => {
  assert.doesNotMatch(formatTime('2026-01-01T12:00:00Z', 'Asia/Kolkata'), /GMT|UTC|\+\d/)
  assert.match(formatTime('2026-01-01T12:00:00Z', 'UTC'), /12/)
  assert.equal(timeZoneLabel('Asia/Calcutta'), 'Asia / Kolkata GMT+05:30')
  assert.equal(timeZoneLabel('UTC'), 'UTC GMT+00:00')
})
