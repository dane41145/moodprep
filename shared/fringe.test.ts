import { describe, expect, it } from 'vitest'
import { recompositeFringe, type Rgb } from './fringe'

// A 32x32 field: white on the left, artwork on the right, and one column
// between them holding an exact half-and-half blend of the two — the pixel an
// anti-aliased edge actually lays down, and the one no match tolerance can
// reach without also reaching the artwork. The artwork is two colours, gold
// over the top half and red below, because a three-colour edge is where a
// naive reference goes wrong.
const WHITE: Rgb = [255, 255, 255]
const RED: Rgb = [196, 68, 42]
const GOLD: Rgb = [232, 185, 63]
const BLACK: Rgb = [0, 0, 0]
const SIZE = 32
const JOIN = 16
const SPLIT = 12

const half = (colour: Rgb): Rgb => [
  Math.round((WHITE[0] + colour[0]) / 2),
  Math.round((WHITE[1] + colour[1]) / 2),
  Math.round((WHITE[2] + colour[2]) / 2),
]

function field(blendAt?: { y: number; colour: Rgb }) {
  const pixels = new Uint8Array(SIZE * SIZE * 3)
  const mask = new Uint8Array(SIZE * SIZE)
  for (let y = 0; y < SIZE; y += 1) {
    const artwork = y < SPLIT ? GOLD : RED
    for (let x = 0; x < SIZE; x += 1) {
      const index = (y * SIZE) + x
      const colour = x < JOIN ? WHITE : x === JOIN ? (blendAt && blendAt.y === y ? blendAt.colour : half(artwork)) : artwork
      pixels[index * 3] = colour[0]
      pixels[index * 3 + 1] = colour[1]
      pixels[index * 3 + 2] = colour[2]
      // The fill itself only ever reaches the pixels that are white outright.
      if (x < JOIN) mask[index] = 1
    }
  }
  return { pixels, mask }
}

const run = (blendAt?: { y: number; colour: Rgb }) => {
  const { pixels, mask } = field(blendAt)
  const output = Uint8Array.from(pixels)
  // The fill's own work: the pixels that were white become black.
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue
    output[index * 3] = 0; output[index * 3 + 1] = 0; output[index * 3 + 2] = 0
  }
  const changed = recompositeFringe(pixels, output, SIZE, SIZE, 3, mask, WHITE, BLACK)
  return { output, changed }
}

const at = (buffer: ArrayLike<number>, x: number, y: number): Rgb =>
  [buffer[((y * SIZE) + x) * 3], buffer[((y * SIZE) + x) * 3 + 1], buffer[((y * SIZE) + x) * 3 + 2]]

const near = (got: Rgb, want: Rgb, slack = 4) => got.every((value, index) => Math.abs(value - want[index]) <= slack)

describe('re-compositing the edge a fill leaves behind', () => {
  it('puts a half-covered pixel over the new colour instead of leaving it pale', () => {
    const { output, changed } = run()
    expect(changed).toBeGreaterThan(0)
    // Half of the red over black is half of the red, give or take rounding.
    const got = at(output, JOIN, 20)
    expect(near(got, [RED[0] / 2, RED[1] / 2, RED[2] / 2])).toBe(true)
  })

  // The same edge, a few rows up, is a blend with a different colour. Reading
  // the red as its reference would leave a green-grey smudge along the gold.
  it('reads each stretch of the edge against the colour it actually meets', () => {
    const { output } = run()
    const got = at(output, JOIN, 4)
    expect(near(got, [GOLD[0] / 2, GOLD[1] / 2, GOLD[2] / 2])).toBe(true)
  })

  it('leaves the artwork on the far side of the blend exactly as it was', () => {
    const { output } = run()
    expect(at(output, JOIN + 6, 20)).toEqual(RED)
    expect(at(output, JOIN + 6, 4)).toEqual(GOLD)
  })

  // A colour that is not on the line between the two is not a blend of them,
  // and pulling it towards the new colour would be inventing rather than
  // restoring.
  it('does not touch a colour that lies well off that line', () => {
    const blue: Rgb = [40, 60, 220]
    const { output } = run({ y: 20, colour: blue })
    expect(at(output, JOIN, 20)).toEqual(blue)
  })

  // Nothing to measure coverage against means nothing to do: a mask that fills
  // the frame must not have the last few pixels guessed at.
  it('does nothing when there is no artwork colour to measure against', () => {
    const pixels = new Uint8Array(SIZE * SIZE * 3).fill(255)
    const mask = new Uint8Array(SIZE * SIZE).fill(1)
    const output = Uint8Array.from(pixels)
    expect(recompositeFringe(pixels, output, SIZE, SIZE, 3, mask, WHITE, BLACK)).toBe(0)
  })
})
