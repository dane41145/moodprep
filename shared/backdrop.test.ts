import { describe, expect, it } from 'vitest'
import { parseHex, sampleBackdrop, swapBackdrop } from './backdrop'

// A cut-out on a flat surround, with a genuinely blended edge: the band where
// the artwork meets the surround is a mixture of the two, which is exactly what
// a flood fill cannot handle and what leaves a line behind.
const SIZE = 200
const BLACK: [number, number, number] = [0, 0, 0]
const CREAM: [number, number, number] = [247, 233, 204]
const RADIUS = 70

function cutout(surround: [number, number, number] = BLACK, artwork: [number, number, number] = CREAM) {
  const pixels = new Uint8Array(SIZE * SIZE * 3)
  const centre = (SIZE - 1) / 2
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const distance = Math.hypot(x - centre, y - centre)
      // Coverage ramps over two pixels, the way an anti-aliased edge does.
      const coverage = Math.min(1, Math.max(0, (RADIUS + 1 - distance) / 2))
      const at = ((y * SIZE) + x) * 3
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[at + channel] = Math.round((artwork[channel] * coverage) + (surround[channel] * (1 - coverage)))
      }
    }
  }
  return pixels
}

const read = (pixels: Uint8Array, x: number, y: number) => {
  const at = ((y * SIZE) + x) * 3
  return [pixels[at], pixels[at + 1], pixels[at + 2]] as [number, number, number]
}
const near = (a: number[], b: number[], within: number) => a.every((value, index) => Math.abs(value - b[index]) <= within)

describe('swapping an isolated backdrop', () => {
  const centre = Math.round((SIZE - 1) / 2)

  it('reads the surround from the frame rather than being told', () => {
    expect(sampleBackdrop(cutout(), SIZE, SIZE, 3)).toEqual([0, 0, 0])
    expect(sampleBackdrop(cutout([255, 255, 255]), SIZE, SIZE, 3)).toEqual([255, 255, 255])
  })

  it('replaces the surround with the target exactly', () => {
    const pixels = cutout()
    expect(swapBackdrop(pixels, SIZE, SIZE, 3, [200, 40, 30], 0.1).changed).toBe(true)
    expect(read(pixels, 2, 2)).toEqual([200, 40, 30])
    expect(read(pixels, SIZE - 3, SIZE - 3)).toEqual([200, 40, 30])
  })

  it('leaves the artwork itself alone', () => {
    const pixels = cutout()
    swapBackdrop(pixels, SIZE, SIZE, 3, [200, 40, 30], 0.1)
    expect(read(pixels, centre, centre)).toEqual(CREAM)
  })

  // The point of the whole exercise: no pixel along the edge may be left
  // holding a trace of the old surround. Walking outward from the artwork, the
  // colour must go from artwork to target without passing through anything
  // darker than either — which is what the leftover line was.
  it('leaves no darker line where the old surround met the artwork', () => {
    const pixels = cutout()
    const target: [number, number, number] = [247, 233, 204]
    swapBackdrop(pixels, SIZE, SIZE, 3, target, 0.1)
    for (let r = RADIUS - 6; r <= RADIUS + 6; r += 1) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const sample = read(pixels, centre + (dx * r), centre + (dy * r))
        // Artwork and target are the same cream here, so every pixel across the
        // join must be that cream. A fill would leave a grey ring instead.
        expect(near(sample, target, 6)).toBe(true)
      }
    }
  })

  it('carries a partly covered edge pixel onto the new surround proportionally', () => {
    const pixels = cutout()
    swapBackdrop(pixels, SIZE, SIZE, 3, [0, 0, 255], 0.1)
    // Half-covered cream over blue should land near the midpoint of the two,
    // not at either extreme and not at the old blend with black.
    const edge = read(pixels, centre + RADIUS, centre)
    expect(edge[2]).toBeGreaterThan(90)
    expect(edge[0]).toBeGreaterThan(60)
  })

  it('refuses when the flood would swallow the subject', () => {
    // An all-one-colour frame: the flood reaches everything, so there is no
    // subject to protect and the pass must decline rather than blank the image.
    const flat = new Uint8Array(SIZE * SIZE * 3)
    const result = swapBackdrop(flat, SIZE, SIZE, 3, [200, 40, 30], 0.5)
    expect(result.changed).toBe(false)
    expect(read(flat, centre, centre)).toEqual([0, 0, 0])
  })

  it('does not swap a dark area enclosed by the artwork', () => {
    const pixels = cutout()
    // Punch a black hole in the middle of the disc; it is not connected to the
    // frame, so it must survive.
    for (let y = centre - 8; y <= centre + 8; y += 1) {
      for (let x = centre - 8; x <= centre + 8; x += 1) {
        const at = ((y * SIZE) + x) * 3
        pixels[at] = 0; pixels[at + 1] = 0; pixels[at + 2] = 0
      }
    }
    swapBackdrop(pixels, SIZE, SIZE, 3, [200, 40, 30], 0.1)
    expect(read(pixels, centre, centre)).toEqual([0, 0, 0])
  })

  it('works from a white surround as well as a black one', () => {
    const pixels = cutout([255, 255, 255], [40, 60, 120])
    expect(swapBackdrop(pixels, SIZE, SIZE, 3, [0, 0, 0], 0.1).changed).toBe(true)
    expect(read(pixels, 2, 2)).toEqual([0, 0, 0])
    expect(read(pixels, centre, centre)).toEqual([40, 60, 120])
  })

  it('walks an RGBA buffer without disturbing alpha', () => {
    const rgb = cutout()
    const rgba = new Uint8Array(SIZE * SIZE * 4)
    for (let index = 0; index < SIZE * SIZE; index += 1) {
      rgba[index * 4] = rgb[index * 3]
      rgba[(index * 4) + 1] = rgb[(index * 3) + 1]
      rgba[(index * 4) + 2] = rgb[(index * 3) + 2]
      rgba[(index * 4) + 3] = 210
    }
    swapBackdrop(rgba, SIZE, SIZE, 4, [200, 40, 30], 0.1)
    for (let index = 0; index < SIZE * SIZE; index += 613) expect(rgba[(index * 4) + 3]).toBe(210)
  })

  it('parses the hex forms the interface produces', () => {
    expect(parseHex('#000000')).toEqual([0, 0, 0])
    expect(parseHex('f7e9cc')).toEqual([247, 233, 204])
    expect(parseHex('#fff')).toEqual([255, 255, 255])
  })
})
