// Swapping the isolated surround for another colour.
//
// The coaster pass cuts the artwork out onto a flat surround, and black is
// often not the colour you want behind it. Flooding that surround with a new
// colour leaves a thin line along every edge, because the pixels where the
// artwork meets the surround are neither: they are a blend of the two, and no
// tolerance setting can be both wide enough to catch them and narrow enough to
// spare the artwork.
//
// They do not need to be caught. A blend is a known quantity. If a pixel P is
// artwork colour C laid over surround B at coverage a, then P = a·C + (1-a)·B,
// and putting the same artwork over a new surround T gives
//
//     out = a·C + (1-a)·T = P + (1-a)·(T - B)
//
// so the artwork colour never has to be recovered — only its coverage. That is
// a re-composite rather than a fill, and it leaves no line to paint over.

export type BackdropResult = { changed: boolean; filled: number }

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

export function parseHex(hex: string): [number, number, number] {
  const text = hex.replace('#', '')
  const full = text.length === 3 ? text.split('').map((character) => character + character).join('') : text
  return [
    parseInt(full.slice(0, 2), 16) || 0,
    parseInt(full.slice(2, 4), 16) || 0,
    parseInt(full.slice(4, 6), 16) || 0,
  ]
}

const apart = (pixels: ArrayLike<number>, offset: number, colour: [number, number, number]) => Math.max(
  Math.abs(pixels[offset] - colour[0]),
  Math.abs(pixels[offset + 1] - colour[1]),
  Math.abs(pixels[offset + 2] - colour[2]),
)

// The surround's own colour, read from the four corners. Whatever the pass
// actually produced is what gets replaced, so an off-black or an unexpected
// colour both work without being told.
export function sampleBackdrop(pixels: ArrayLike<number>, width: number, height: number, channels: number): [number, number, number] {
  const patch = Math.max(2, Math.round(Math.min(width, height) * 0.02))
  const totals = [0, 0, 0]
  let samples = 0
  for (const [startX, startY] of [[0, 0], [width - patch, 0], [0, height - patch], [width - patch, height - patch]]) {
    for (let y = startY; y < startY + patch; y += 1) {
      for (let x = startX; x < startX + patch; x += 1) {
        const offset = ((y * width) + x) * channels
        totals[0] += pixels[offset]
        totals[1] += pixels[offset + 1]
        totals[2] += pixels[offset + 2]
        samples += 1
      }
    }
  }
  return samples === 0 ? [0, 0, 0] : [Math.round(totals[0] / samples), Math.round(totals[1] / samples), Math.round(totals[2] / samples)]
}

export function swapBackdrop(
  pixels: Uint8Array | Uint8ClampedArray | Buffer,
  width: number,
  height: number,
  channels: number,
  target: [number, number, number],
  tolerance: number,
): BackdropResult {
  if (width < 8 || height < 8) return { changed: false, filled: 0 }
  const backdrop = sampleBackdrop(pixels, width, height, channels)
  const reach = Math.round(clamp(tolerance, 0, 1) * 160)

  // The surround is whatever is connected to the frame's edge. Flooding from
  // the border rather than matching by colour is what stops a dark area inside
  // the artwork being swapped as well.
  const mask = new Uint8Array(width * height)
  const visited = new Uint8Array(width * height)
  const stack: number[] = []
  let filled = 0
  const push = (x: number, y: number) => {
    const index = (y * width) + x
    if (visited[index]) return
    visited[index] = 1
    if (apart(pixels, index * channels, backdrop) > reach) return
    mask[index] = 1
    filled += 1
    stack.push(index)
  }
  for (let x = 0; x < width; x += 1) { push(x, 0); push(x, height - 1) }
  for (let y = 0; y < height; y += 1) { push(0, y); push(width - 1, y) }
  while (stack.length) {
    const index = stack.pop()!
    const x = index % width
    const y = (index - x) / width
    if (x > 0) push(x - 1, y)
    if (x < width - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < height - 1) push(x, y + 1)
  }

  // The same leak guard the isolation pass uses: the middle of the frame must
  // come back essentially untouched, or the flood did not stop at the subject.
  let centreTotal = 0
  let centreFilled = 0
  for (let y = Math.floor(height * 0.4); y < Math.ceil(height * 0.6); y += 1) {
    for (let x = Math.floor(width * 0.4); x < Math.ceil(width * 0.6); x += 1) {
      centreTotal += 1
      centreFilled += mask[(y * width) + x]
    }
  }
  if (!centreTotal || centreFilled > centreTotal * 0.05) return { changed: false, filled: 0 }
  if (filled === 0 || filled > width * height * 0.97) return { changed: false, filled: 0 }

  // The blended band, a few pixels deep, is where the line comes from.
  const band = Math.max(2, Math.round(Math.min(width, height) / 700))
  const fringe = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width) + x
      if (mask[index]) continue
      let near = false
      for (let dy = -band; dy <= band && !near; dy += 1) {
        for (let dx = -band; dx <= band; dx += 1) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          if (mask[(ny * width) + nx]) { near = true; break }
        }
      }
      if (near) fringe[index] = 1
    }
  }

  // Coverage needs something to be measured against: the artwork's own colour
  // just past the blend. Taken locally so a pale edge and a dark edge each get
  // their own reference rather than one global guess.
  const search = band * 3
  const referenceFor = (x: number, y: number) => {
    let best = 0
    for (let dy = -search; dy <= search; dy += 1) {
      for (let dx = -search; dx <= search; dx += 1) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const index = (ny * width) + nx
        if (mask[index] || fringe[index]) continue
        const distance = apart(pixels, index * channels, backdrop)
        if (distance > best) best = distance
      }
    }
    return best
  }

  const delta: [number, number, number] = [target[0] - backdrop[0], target[1] - backdrop[1], target[2] - backdrop[2]]
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width) + x
      const offset = index * channels
      if (mask[index]) {
        pixels[offset] = target[0]
        pixels[offset + 1] = target[1]
        pixels[offset + 2] = target[2]
        continue
      }
      if (!fringe[index]) continue
      const reference = referenceFor(x, y)
      if (reference <= 0) continue
      const coverage = clamp(apart(pixels, offset, backdrop) / reference, 0, 1)
      if (coverage >= 0.995) continue
      const share = 1 - coverage
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round(clamp(pixels[offset + channel] + (share * delta[channel]), 0, 255))
      }
    }
  }
  return { changed: true, filled }
}
