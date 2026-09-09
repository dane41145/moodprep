import { describe, expect, it } from 'vitest'
import { labDistance, mapToPalette, parseHexColour, rgbToLab } from './palette'

const CREAM = '#e8dcc0'
const RED = '#c8402f'
const GREEN = '#2f6b3a'
const WHITE = '#ffffff'

function image(colours: string[], perColour: number, channels = 3) {
  const pixels = new Uint8Array(colours.length * perColour * channels)
  colours.forEach((hex, index) => {
    const [r, g, b] = parseHexColour(hex)
    for (let i = 0; i < perColour; i += 1) {
      const at = ((index * perColour) + i) * channels
      pixels[at] = r; pixels[at + 1] = g; pixels[at + 2] = b
      if (channels === 4) pixels[at + 3] = 180
    }
  })
  return pixels
}
const at = (pixels: Uint8Array, index: number, channels = 3) => [pixels[index * channels], pixels[(index * channels) + 1], pixels[(index * channels) + 2]]

describe('flattening to a detected palette', () => {
  it('snaps every pixel to exactly one of the swatches', () => {
    // Noisy versions of the inks, the way JPEG leaves them.
    const pixels = image(['#e6dabe', '#c7422e', '#306a3b', '#fdfdfd'], 5)
    const used = mapToPalette(pixels, 3, [CREAM, RED, GREEN, WHITE])
    expect(used).toBe(4)
    expect(at(pixels, 0)).toEqual(parseHexColour(CREAM))
    expect(at(pixels, 5)).toEqual(parseHexColour(RED))
    expect(at(pixels, 10)).toEqual(parseHexColour(GREEN))
    expect(at(pixels, 15)).toEqual(parseHexColour(WHITE))
  })

  // The failure this replaces: a small ink was merged into the dominant paper
  // colour because a count-driven quantiser had spent its slots on the paper.
  // Here the palette is given, so the red goes to the red however few pixels
  // carry it.
  it('keeps a small ink even when the paper dominates', () => {
    const pixels = image([CREAM, RED], 1)
    const big = new Uint8Array(3 * 5000)
    for (let i = 0; i < 4999; i += 1) big.set(at(pixels, 0), i * 3)
    big.set(at(pixels, 1), 4999 * 3)
    const used = mapToPalette(big, 3, [CREAM, RED, GREEN])
    expect(at(big, 4999)).toEqual(parseHexColour(RED))
    expect(used).toBe(2)
  })

  it('reports how many swatches were actually used', () => {
    const pixels = image([CREAM, WHITE], 10)
    expect(mapToPalette(pixels, 3, [CREAM, RED, GREEN, WHITE])).toBe(2)
  })

  it('walks an RGBA buffer without disturbing alpha', () => {
    const pixels = image([CREAM, RED], 10, 4)
    mapToPalette(pixels, 4, [CREAM, RED])
    for (let i = 0; i < 20; i += 1) expect(pixels[(i * 4) + 3]).toBe(180)
  })

  it('does nothing with no swatches', () => {
    const pixels = image([RED], 3)
    expect(mapToPalette(pixels, 3, [])).toBe(0)
    expect(at(pixels, 0)).toEqual(parseHexColour(RED))
  })

  it('judges nearness in Lab, not in RGB', () => {
    // Two colours equidistant in RGB from a probe can be far apart perceptually.
    const probe = rgbToLab(128, 128, 128)
    expect(labDistance(probe, rgbToLab(120, 120, 120))).toBeLessThan(labDistance(probe, rgbToLab(128, 128, 200)))
  })
})
