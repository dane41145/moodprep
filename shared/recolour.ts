// Deterministic palette shifting.
//
// These designs are good drawings whose exact colour choices are dated, not
// drawings that want different colours. So a red comes back a red and a pink
// comes back a pink: every hue keeps its identity and moves only to a
// different shade of itself. Nothing here calls a model, and nothing here is
// random — the same variation and amount produce the same image every time,
// on every machine.

export const RECOLOUR_VARIATIONS = 8

// Twelve control points, one every 30 degrees around the wheel. A hue is
// shifted by blending the two it sits between, so a gradient crossing a
// boundary moves smoothly rather than banding at it.
const CONTROL_POINTS = 12
const CONTROL_SPACING = 360 / CONTROL_POINTS

// The ceiling is half a control spacing less a degree: enough to read as a
// different shade, never enough for a hue to reach its neighbour's centre.
export const MAX_HUE_SHIFT = (CONTROL_SPACING / 2) - 1
// Saturation and lightness are where the range lives. Neither touches a hue's
// identity — a desaturated red and a deep red are both plainly red — so they
// can travel much further than the hue itself and are what actually makes one
// variation look unlike another.
const MAX_SATURATION_SHIFT = 0.34
const MAX_LIGHTNESS_SHIFT = 0.16

// A scheme has to read as one deliberate move, not as noise. Most of the shift
// is therefore common to every hue, which preserves the intervals between
// them, and only the remainder varies per hue. Independent per-hue shifts can
// close the gap between two neighbouring families until the design loses a
// distinction it was relying on.
const JITTER_SHARE = 0.35
const COMMON_SHARE = 1 - JITTER_SHARE

// Neutrals carry these designs: black linework, white paper, grey rules and
// the background behind everything. Shifting them would tint the whole image,
// so they are left exactly as they were. The exclusion fades in rather than
// switching, because a hard threshold leaves a coloured fringe along every
// anti-aliased edge — and these files are usually converted from SVG, so
// almost every edge is anti-aliased.
const NEUTRAL_SATURATION = 0.09
const NEUTRAL_SATURATION_FULL = 0.2
const NEUTRAL_DARK = 0.05
const NEUTRAL_DARK_FULL = 0.14
const NEUTRAL_LIGHT = 0.95
const NEUTRAL_LIGHT_FULL = 0.86

export type ColourShift = { hue: number; saturation: number; lightness: number }

// An integer hash rather than a seeded PRNG: no state, no sequence to depend
// on, and the same answer forever for a given variation.
function hashUnit(variation: number, point: number, channel: number) {
  let value = Math.imul(variation + 1, 73856093) ^ Math.imul(point + 2, 19349663) ^ Math.imul(channel + 1, 83492791)
  value = Math.imul(value ^ (value >>> 15), 2246822519)
  value = Math.imul(value ^ (value >>> 13), 3266489917)
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296
}

const signed = (unit: number) => (unit * 2) - 1
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

// 0 below `from`, 1 beyond `to`, eased in between, in either direction.
function ramp(value: number, from: number, to: number) {
  if (from === to) return value >= to ? 1 : 0
  const t = clamp((value - from) / (to - from), 0, 1)
  return t * t * (3 - (2 * t))
}

// Three golden-ratio sequences. Hashing the variation instead would cluster
// the schemes by chance and leave two of the eight looking the same as each
// other; stepping through low-discrepancy sequences spreads them evenly over
// the whole range, so every variation earns its place in the row.
const GOLDEN = [0.6180339887498949, 0.7548776662466927, 0.5698402909980532]
const sequence = (variation: number, channel: number) => {
  const value = (variation + 1) * GOLDEN[channel]
  return signed(value - Math.floor(value))
}

export function colourShifts(variation: number, amount: number): ColourShift[] {
  const strength = clamp(Number.isFinite(amount) ? amount : 0, 0, 1)
  const seed = Number.isFinite(variation) ? Math.trunc(variation) : 0
  const commonHue = sequence(seed, 0) * MAX_HUE_SHIFT * COMMON_SHARE
  const commonSaturation = sequence(seed, 1) * MAX_SATURATION_SHIFT * COMMON_SHARE
  const commonLightness = sequence(seed, 2) * MAX_LIGHTNESS_SHIFT * COMMON_SHARE
  return Array.from({ length: CONTROL_POINTS }, (_, point) => ({
    hue: clamp(commonHue + (signed(hashUnit(seed, point, 0)) * MAX_HUE_SHIFT * JITTER_SHARE), -MAX_HUE_SHIFT, MAX_HUE_SHIFT) * strength,
    saturation: clamp(commonSaturation + (signed(hashUnit(seed, point, 1)) * MAX_SATURATION_SHIFT * JITTER_SHARE), -MAX_SATURATION_SHIFT, MAX_SATURATION_SHIFT) * strength,
    lightness: clamp(commonLightness + (signed(hashUnit(seed, point, 2)) * MAX_LIGHTNESS_SHIFT * JITTER_SHARE), -MAX_LIGHTNESS_SHIFT, MAX_LIGHTNESS_SHIFT) * strength,
  }))
}

// One entry per degree, each blended from the two control points it lies
// between, so the map is continuous all the way round including across 359→0.
export function hueShiftTable(shifts: ColourShift[]): ColourShift[] {
  return Array.from({ length: 360 }, (_, degree) => {
    const position = degree / CONTROL_SPACING
    const lower = Math.floor(position) % CONTROL_POINTS
    const upper = (lower + 1) % CONTROL_POINTS
    const blend = position - Math.floor(position)
    const from = shifts[lower]
    const to = shifts[upper]
    return {
      hue: from.hue + ((to.hue - from.hue) * blend),
      saturation: from.saturation + ((to.saturation - from.saturation) * blend),
      lightness: from.lightness + ((to.lightness - from.lightness) * blend),
    }
  })
}

export function rgbToHsl(red: number, green: number, blue: number) {
  const r = red / 255
  const g = green / 255
  const b = blue / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const lightness = (max + min) / 2
  const span = max - min
  if (span === 0) return { hue: 0, saturation: 0, lightness }
  const saturation = lightness > 0.5 ? span / (2 - max - min) : span / (max + min)
  const hue = max === r
    ? (((g - b) / span) + (g < b ? 6 : 0))
    : max === g
      ? (((b - r) / span) + 2)
      : (((r - g) / span) + 4)
  return { hue: hue * 60, saturation, lightness }
}

function channelFromHue(p: number, q: number, t: number) {
  let position = t
  if (position < 0) position += 1
  if (position > 1) position -= 1
  if (position < 1 / 6) return p + ((q - p) * 6 * position)
  if (position < 1 / 2) return q
  if (position < 2 / 3) return p + ((q - p) * ((2 / 3) - position) * 6)
  return p
}

export function hslToRgb(hue: number, saturation: number, lightness: number) {
  if (saturation <= 0) {
    const grey = Math.round(clamp(lightness, 0, 1) * 255)
    return { red: grey, green: grey, blue: grey }
  }
  const l = clamp(lightness, 0, 1)
  const s = clamp(saturation, 0, 1)
  const h = ((hue % 360) + 360) % 360 / 360
  const q = l < 0.5 ? l * (1 + s) : l + s - (l * s)
  const p = (2 * l) - q
  return {
    red: Math.round(clamp(channelFromHue(p, q, h + (1 / 3)), 0, 1) * 255),
    green: Math.round(clamp(channelFromHue(p, q, h), 0, 1) * 255),
    blue: Math.round(clamp(channelFromHue(p, q, h - (1 / 3)), 0, 1) * 255),
  }
}

// How much of the shift a given colour is allowed to receive: none for the
// neutrals and the near-black and near-white that hold a design together,
// easing to all of it for anything properly chromatic.
export function shiftWeight(saturation: number, lightness: number) {
  return ramp(saturation, NEUTRAL_SATURATION, NEUTRAL_SATURATION_FULL)
    * ramp(lightness, NEUTRAL_DARK, NEUTRAL_DARK_FULL)
    * ramp(lightness, NEUTRAL_LIGHT, NEUTRAL_LIGHT_FULL)
}

export function shiftColour(red: number, green: number, blue: number, table: ColourShift[]) {
  const { hue, saturation, lightness } = rgbToHsl(red, green, blue)
  const weight = shiftWeight(saturation, lightness)
  if (weight <= 0) return { red, green, blue }
  const shift = table[Math.min(359, Math.max(0, Math.round(hue))) % 360]
  return hslToRgb(
    hue + (shift.hue * weight),
    clamp(saturation + (shift.saturation * weight), 0, 1),
    clamp(lightness + (shift.lightness * weight), 0, 1),
  )
}

// In place over a raw RGB or RGBA buffer. Colours repeat heavily in this kind
// of artwork — flat fills, a handful of inks — so an exact-match cache turns
// several million conversions into a few thousand.
export function shiftPixels(pixels: Uint8Array | Uint8ClampedArray | Buffer, channels: number, table: ColourShift[]) {
  const cache = new Map<number, number>()
  for (let index = 0; index + channels <= pixels.length; index += channels) {
    const red = pixels[index]
    const green = pixels[index + 1]
    const blue = pixels[index + 2]
    const key = (red << 16) | (green << 8) | blue
    let packed = cache.get(key)
    if (packed === undefined) {
      const shifted = shiftColour(red, green, blue, table)
      packed = (shifted.red << 16) | (shifted.green << 8) | shifted.blue
      cache.set(key, packed)
    }
    pixels[index] = (packed >> 16) & 255
    pixels[index + 1] = (packed >> 8) & 255
    pixels[index + 2] = packed & 255
  }
  return pixels
}
