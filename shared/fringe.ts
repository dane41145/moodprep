// Cleaning the edge left behind when one colour is replaced by another.
//
// A fill or a global replace can only ever swap pixels that *are* the old
// colour. The pixels where that colour meets the artwork are not: they are a
// blend of the two, laid down by the anti-aliasing (and smeared further by JPEG
// compression). Widening the match tolerance until it reaches them is not a way
// out — by the time the radius is wide enough to include a half-and-half pixel
// it is also wide enough to include the artwork itself, so the edge is cleaned
// by wrecking the thing it borders. That is exactly what the Match slider does
// at the top of its travel.
//
// The blend does not have to be matched, because it is a known quantity. For a
// pixel P that is artwork colour C over the old colour B at coverage a,
//
//     P = a·C + (1-a)·B   and   out = a·C + (1-a)·T = P + (1-a)·(T - B)
//
// so only the share of B has to be recovered, never the artwork colour. That
// share is the projection of P onto the line from B to C, which needs C — read
// locally, just past the blend, so a pale edge and a dark edge each get their
// own. `shared/backdrop.ts` makes the same argument for the frame-connected
// surround; this is the same re-composite driven by an arbitrary mask, so it
// serves the bucket and the global replace as well.

export type Rgb = [number, number, number]

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

const distanceFrom = (pixels: ArrayLike<number>, offset: number, colour: Rgb) => {
  const red = pixels[offset] - colour[0]
  const green = pixels[offset + 1] - colour[1]
  const blue = pixels[offset + 2] - colour[2]
  return Math.sqrt((red * red) + (green * green) + (blue * blue))
}

// The blend is only ever a few pixels deep, and it scales with the image.
export function fringeBand(width: number, height: number) {
  return Math.max(2, Math.round(Math.min(width, height) / 700))
}

export function recompositeFringe(
  source: ArrayLike<number>,
  output: Uint8Array | Uint8ClampedArray | Buffer,
  width: number,
  height: number,
  channels: number,
  mask: Uint8Array,
  from: Rgb,
  to: Rgb,
  band = fringeBand(width, height),
): number {
  // Which pixels are the blend: not the replaced colour themselves, but close
  // enough to it spatially to be the ramp running into it.
  const fringe = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width) + x
      if (mask[index]) continue
      let near = false
      for (let dy = -band; dy <= band && !near; dy += 1) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -band; dx <= band; dx += 1) {
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          if (mask[(ny * width) + nx]) { near = true; break }
        }
      }
      if (near) fringe[index] = 1
    }
  }

  // The artwork colour the blend is running into: a nearby solid pixel that is
  // neither the replaced colour nor part of the ramp itself. Of the candidates
  // the one taken is the one that best explains this pixel — the one whose line
  // out of the replaced colour passes closest to it. Simply taking the most
  // different colour nearby gets a two-colour edge right and a three-colour one
  // wrong: gold lettering that meets the same white background would be read as
  // a blend of white and the red beside it and pulled towards the new colour.
  const search = band * 4
  const referenceFor = (x: number, y: number, offset: number): Rgb | null => {
    let closest = Infinity
    let found: Rgb | null = null
    for (let dy = -search; dy <= search; dy += 1) {
      const ny = y + dy
      if (ny < 0 || ny >= height) continue
      for (let dx = -search; dx <= search; dx += 1) {
        const nx = x + dx
        if (nx < 0 || nx >= width) continue
        const index = (ny * width) + nx
        if (mask[index] || fringe[index]) continue
        const candidate = index * channels
        if (distanceFrom(source, candidate, from) <= 12) continue
        const axis: Rgb = [source[candidate] - from[0], source[candidate + 1] - from[1], source[candidate + 2] - from[2]]
        const length = (axis[0] * axis[0]) + (axis[1] * axis[1]) + (axis[2] * axis[2])
        const along = ((source[offset] - from[0]) * axis[0]) + ((source[offset + 1] - from[1]) * axis[1]) + ((source[offset + 2] - from[2]) * axis[2])
        const coverage = clamp(along / length, 0, 1)
        let residual = 0
        for (let channel = 0; channel < 3; channel += 1) {
          const off = (source[offset + channel] - from[channel]) - (coverage * axis[channel])
          residual += off * off
        }
        const scaled = residual / length
        if (scaled < closest) {
          closest = scaled
          found = [source[candidate], source[candidate + 1], source[candidate + 2]]
        }
      }
    }
    return found
  }

  const delta: Rgb = [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
  let changed = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width) + x
      if (!fringe[index]) continue
      const offset = index * channels
      const reference = referenceFor(x, y, offset)
      if (!reference) continue
      // How much of the artwork colour this pixel holds: P projected onto the
      // line from the replaced colour to it. Whatever is left is the old colour
      // and is the only part that moves.
      const axis: Rgb = [reference[0] - from[0], reference[1] - from[1], reference[2] - from[2]]
      const length = (axis[0] * axis[0]) + (axis[1] * axis[1]) + (axis[2] * axis[2])
      if (length <= 0) continue
      const along = ((source[offset] - from[0]) * axis[0]) + ((source[offset + 1] - from[1]) * axis[1]) + ((source[offset + 2] - from[2]) * axis[2])
      const coverage = clamp(along / length, 0, 1)
      // Only a pixel that actually sits on the line between the two colours is
      // a blend of them. One that sits well off it is a third colour meeting
      // the edge — a gold letter against white beside red — and moving that
      // towards the new colour would be inventing, not re-compositing.
      let residual = 0
      for (let channel = 0; channel < 3; channel += 1) {
        const off = (source[offset + channel] - from[channel]) - (coverage * axis[channel])
        residual += off * off
      }
      if (residual > length * 0.0625) continue
      const share = 1 - coverage
      if (share <= 0.004) continue
      for (let channel = 0; channel < 3; channel += 1) {
        output[offset + channel] = Math.round(clamp(source[offset + channel] + (share * delta[channel]), 0, 255))
      }
      changed += 1
    }
  }
  return changed
}
