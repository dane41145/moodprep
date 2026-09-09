// Flattening to the detected palette.
//
// Detection and flattening used to be two different algorithms. The analysis
// discounts anti-aliased ramps and compression noise and finds the inks a
// design was actually printed with. The flattening then handed only a colour
// *count* to a general-purpose quantiser, which minimises total pixel error and
// therefore spends its budget on whatever covers the most pixels — the paper's
// gradient — and merges the small inks. On a cream coaster a red and a green
// became one brown while the panel showed six swatches that included both.
//
// So the flatten maps every pixel to the nearest of the swatches the analysis
// found. What the panel shows is exactly what is produced.

export type LabColor = { lightness: number; a: number; b: number }

export function rgbToLab(red: number, green: number, blue: number): LabColor {
  const linear = (channel: number) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  const r = linear(red)
  const g = linear(green)
  const b = linear(blue)
  const x = ((r * 0.4124) + (g * 0.3576) + (b * 0.1805)) / 0.95047
  const y = (r * 0.2126) + (g * 0.7152) + (b * 0.0722)
  const z = ((r * 0.0193) + (g * 0.1192) + (b * 0.9505)) / 1.08883
  const transform = (value: number) => value > 0.008856 ? Math.cbrt(value) : (7.787 * value) + (16 / 116)
  const fx = transform(x)
  const fy = transform(y)
  const fz = transform(z)
  return { lightness: (116 * fy) - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

export function labDistance(left: LabColor, right: LabColor) {
  return Math.hypot(left.lightness - right.lightness, left.a - right.a, left.b - right.b)
}

export function parseHexColour(hex: string): [number, number, number] {
  const text = hex.trim().replace('#', '')
  const full = text.length === 3 ? text.split('').map((character) => character + character).join('') : text
  return [parseInt(full.slice(0, 2), 16) || 0, parseInt(full.slice(2, 4), 16) || 0, parseInt(full.slice(4, 6), 16) || 0]
}

// In place. Returns how many of the swatches were actually used, which is the
// honest answer to "how many colours is this now".
export function mapToPalette(pixels: Uint8Array | Uint8ClampedArray | Buffer, channels: number, swatches: string[]): number {
  const palette = swatches.map(parseHexColour)
  if (palette.length === 0) return 0
  const labs = palette.map(([red, green, blue]) => rgbToLab(red, green, blue))
  // Flat artwork repeats a few thousand distinct colours across millions of
  // pixels, so an exact-colour cache does nearly all of the work.
  const cache = new Map<number, number>()
  const used = new Set<number>()
  for (let index = 0; index + channels <= pixels.length; index += channels) {
    const red = pixels[index]
    const green = pixels[index + 1]
    const blue = pixels[index + 2]
    const key = (red << 16) | (green << 8) | blue
    let chosen = cache.get(key)
    if (chosen === undefined) {
      const lab = rgbToLab(red, green, blue)
      let best = 0
      let bestDistance = Number.POSITIVE_INFINITY
      for (let swatch = 0; swatch < labs.length; swatch += 1) {
        const distance = labDistance(lab, labs[swatch])
        if (distance < bestDistance) { bestDistance = distance; best = swatch }
      }
      chosen = best
      cache.set(key, chosen)
    }
    used.add(chosen)
    const [r, g, b] = palette[chosen]
    pixels[index] = r
    pixels[index + 1] = g
    pixels[index + 2] = b
  }
  return used.size
}
