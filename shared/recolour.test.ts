import { describe, expect, it } from 'vitest'
import { colourShifts, hslToRgb, hueShiftTable, MAX_HUE_SHIFT, RECOLOUR_VARIATIONS, rgbToHsl, shiftColour, shiftPixels, shiftWeight } from './recolour'

const table = (variation: number, amount = 1) => hueShiftTable(colourShifts(variation, amount))
const hueOf = (rgb: { red: number; green: number; blue: number }) => rgbToHsl(rgb.red, rgb.green, rgb.blue).hue
// Signed distance between two hues, the short way round the wheel.
const hueGap = (a: number, b: number) => {
  const raw = ((a - b + 540) % 360) - 180
  return Math.abs(raw)
}

const RED = { red: 220, green: 32, blue: 30 }
const PINK = { red: 240, green: 120, blue: 170 }
const GREEN = { red: 20, green: 150, blue: 60 }
const BLUE = { red: 30, green: 70, blue: 200 }
const YELLOW = { red: 240, green: 210, blue: 40 }

describe('deterministic recolour', () => {
  // The whole promise of the feature: a red is still a red afterwards.
  it('keeps every hue inside its own family at full strength', () => {
    for (let variation = 1; variation <= RECOLOUR_VARIATIONS; variation += 1) {
      const map = table(variation)
      for (const colour of [RED, PINK, GREEN, BLUE, YELLOW]) {
        const before = hueOf(colour)
        const after = hueOf(shiftColour(colour.red, colour.green, colour.blue, map))
        expect(hueGap(after, before)).toBeLessThanOrEqual(MAX_HUE_SHIFT + 0.75)
      }
    }
  })

  it('actually changes the colour rather than returning it untouched', () => {
    for (let variation = 1; variation <= RECOLOUR_VARIATIONS; variation += 1) {
      const map = table(variation)
      const moved = [RED, PINK, GREEN, BLUE, YELLOW].filter((colour) => {
        const after = shiftColour(colour.red, colour.green, colour.blue, map)
        return after.red !== colour.red || after.green !== colour.green || after.blue !== colour.blue
      })
      expect(moved.length).toBe(5)
    }
  })

  it('gives a different scheme for every variation', () => {
    const results = new Set<string>()
    for (let variation = 1; variation <= RECOLOUR_VARIATIONS; variation += 1) {
      const map = table(variation)
      results.add([RED, PINK, GREEN, BLUE, YELLOW]
        .map((colour) => Object.values(shiftColour(colour.red, colour.green, colour.blue, map)).join(','))
        .join('|'))
    }
    expect(results.size).toBe(RECOLOUR_VARIATIONS)
  })

  it('returns the same image for the same variation, every time', () => {
    const once = shiftColour(RED.red, RED.green, RED.blue, table(3))
    const again = shiftColour(RED.red, RED.green, RED.blue, table(3))
    expect(again).toEqual(once)
  })

  // Linework, paper and the background hold these designs together. Tinting
  // them would recolour the whole image rather than the artwork.
  it('leaves blacks, whites and greys exactly as they were', () => {
    const map = table(2)
    for (const neutral of [[0, 0, 0], [255, 255, 255], [128, 128, 128], [246, 244, 240], [12, 12, 14]]) {
      const [red, green, blue] = neutral
      expect(shiftColour(red, green, blue, map)).toEqual({ red, green, blue })
    }
  })

  // A hard neutral cutoff leaves a coloured fringe on every anti-aliased edge,
  // and these files are usually converted from SVG, so the ramp matters.
  it('eases the exclusion in rather than switching it', () => {
    expect(shiftWeight(0, 0.5)).toBe(0)
    expect(shiftWeight(1, 0.5)).toBe(1)
    const partial = shiftWeight(0.14, 0.5)
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(1)
    // and monotonic, so no colour is shifted less than a duller one
    expect(shiftWeight(0.12, 0.5)).toBeLessThan(shiftWeight(0.18, 0.5))
  })

  // Independent per-hue shifts can close the gap between two neighbouring
  // families until the design loses a distinction it was relying on.
  it('preserves the intervals between neighbouring hues', () => {
    for (let variation = 1; variation <= RECOLOUR_VARIATIONS; variation += 1) {
      const map = table(variation)
      for (let hue = 0; hue < 360; hue += 10) {
        const first = hslToRgb(hue, 0.8, 0.5)
        const second = hslToRgb(hue + 30, 0.8, 0.5)
        const gap = hueGap(
          hueOf(shiftColour(first.red, first.green, first.blue, map)),
          hueOf(shiftColour(second.red, second.green, second.blue, map)),
        )
        expect(gap).toBeGreaterThan(12)
      }
    }
  })

  // A hard boundary between control points would band a gradient.
  it('shifts continuously around the wheel, including across the seam', () => {
    const map = table(5)
    for (let hue = 0; hue < 360; hue += 1) {
      const next = (hue + 1) % 360
      expect(Math.abs(map[next].hue - map[hue].hue)).toBeLessThan(2)
      expect(Math.abs(map[next].saturation - map[hue].saturation)).toBeLessThan(0.05)
    }
  })

  it('scales with the amount, and does nothing at zero', () => {
    const none = hueShiftTable(colourShifts(4, 0))
    expect(shiftColour(RED.red, RED.green, RED.blue, none)).toEqual(RED)
    const gentle = hueGap(hueOf(shiftColour(GREEN.red, GREEN.green, GREEN.blue, table(4, 0.25))), hueOf(GREEN))
    const full = hueGap(hueOf(shiftColour(GREEN.red, GREEN.green, GREEN.blue, table(4, 1))), hueOf(GREEN))
    expect(gentle).toBeLessThan(full)
  })

  it('walks a raw buffer in place across both channel counts', () => {
    const map = table(6)
    for (const channels of [3, 4]) {
      const pixels = new Uint8Array(channels * 2)
      pixels.set([RED.red, RED.green, RED.blue], 0)
      pixels.set([0, 0, 0], channels)
      if (channels === 4) { pixels[3] = 128; pixels[7] = 255 }
      shiftPixels(pixels, channels, map)
      const expected = shiftColour(RED.red, RED.green, RED.blue, map)
      expect([pixels[0], pixels[1], pixels[2]]).toEqual([expected.red, expected.green, expected.blue])
      // black untouched, and alpha never read or written
      expect([pixels[channels], pixels[channels + 1], pixels[channels + 2]]).toEqual([0, 0, 0])
      if (channels === 4) expect([pixels[3], pixels[7]]).toEqual([128, 255])
    }
  })

  it('round-trips RGB through HSL without drifting', () => {
    for (const colour of [RED, PINK, GREEN, BLUE, YELLOW, { red: 0, green: 0, blue: 0 }, { red: 255, green: 255, blue: 255 }]) {
      const { hue, saturation, lightness } = rgbToHsl(colour.red, colour.green, colour.blue)
      expect(hslToRgb(hue, saturation, lightness)).toEqual(colour)
    }
  })
})
