import assert from 'node:assert/strict'
import test from 'node:test'
import { fahrenheitFromCelsius, temperatureRaster } from '../src/temperatureHeatmap.ts'

const sample = (latitude, longitude, celsius, surface = 'land') => ({
  latitude, longitude, temperature_f: fahrenheitFromCelsius(celsius), surface,
})

function raster(points, bounds = {}, landMask = null, globalView = false) {
  return temperatureRaster({
    points,
    grid: { rows: 3, columns: 3, south: -1, north: 1, west: -1, east: 1, ...bounds },
    coverage: landMask ? 'mixed' : 'land',
    global_view: globalView,
    land_mask: landMask,
    mask_size: 8,
  })
}

function pixel({ pixels, size }, x, y) {
  const offset = (y * size + x) * 4
  return [...pixels.slice(offset, offset + 4)]
}

test('blends colors smoothly between nearby temperatures', () => {
  const field = raster([sample(0, -0.01, 20), sample(0, 0.01, 24)], { south: -0.01, north: 0.01, west: -0.01, east: 0.01 })
  const colors = Array.from({ length: 8 }, (_, x) => pixel(field, x, 3))
  assert.ok(colors.every((color, index) => index === 0 || color[1] <= colors[index - 1][1]))
  assert.equal(new Set(colors.map((color) => color.join(','))).size, 8)
  assert.deepEqual(pixel(raster([sample(0, 0, 22)]), 3, 3), [255, 164, 0, 255])
})

test('keeps water clear and ignores offshore samples across the date line', () => {
  const mask = Buffer.alloc(8, 0b11110000).toString('base64')
  for (const globalView of [false, true]) {
    const field = raster([sample(0, -179.5, 20), sample(0, 179.9, 52, 'water')], { west: 179, east: 181 }, mask, globalView)
    assert.deepEqual(pixel(field, 3, 3), [0, 0, 0, 0])
    assert.deepEqual(pixel(field, 4, 3), [255, 208, 0, 255])
  }
})

test('distinguishes polar temperatures and fades out past the maximum distance', () => {
  const antarctica = { south: -81, north: -79 }
  const cold = raster([sample(-80, 0, -70)], antarctica)
  const milder = raster([sample(-80, 0, -50)], antarctica)
  assert.deepEqual(pixel(cold, 4, 4), [226, 216, 250, 255])
  assert.deepEqual(pixel(milder, 4, 4), [242, 229, 239, 255])
  assert.notDeepEqual(pixel(raster([sample(0, 0, 31)]), 4, 4), pixel(raster([sample(0, 0, 47.6)]), 4, 4))
  const field = raster([sample(0, 0.5, 22)], { west: 0, east: 8 })
  assert.equal(pixel(field, 0, 3)[3], 255)
  assert.ok(pixel(field, 3, 3)[3] > 0 && pixel(field, 3, 3)[3] < 255)
  assert.equal(pixel(field, 4, 3)[3], 0)
  const clustered = raster([0.5, 0.6, 0.7, 0.8].map((longitude) => sample(0, longitude, 22)), { west: 0, east: 12 })
  assert.equal(pixel(clustered, 7, 3)[3], 0)
})

test('bridges the space between widely separated samples in a continental view', () => {
  const field = raster([sample(0, -46.75, 20), sample(0, 27.25, 24)], { south: -25, north: 25, west: -78, east: 78, columns: 4 })
  assert.deepEqual(pixel(field, 3, 3), [255, 164, 0, 255])
})

test('keeps southern polar temperatures independent of nearby temperate readings', () => {
  const samples = [sample(-62, 0, -30), sample(-59, 0, 30)]
  const field = raster(samples, { south: -68, north: -55 })
  assert.deepEqual(pixel(field, 4, 4), [117, 0, 168, 255])
})
