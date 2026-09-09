import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { isolateOnBlack } from './processor'

const DISC = '#e8d5ae'
const INK = '#b22222'
const hexOf = (c: { r: number; g: number; b: number }) => `${c.r},${c.g},${c.b}`

// A round coaster on a surround, encoded as JPEG so the flat fields carry real
// compression noise like the model's own output.
async function coaster(surround: string, extra = '') {
  return sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">`
    + `<rect width="400" height="400" fill="${surround}"/>`
    + `<circle cx="200" cy="200" r="170" fill="${DISC}"/>`
    + `<rect x="120" y="185" width="160" height="30" fill="${INK}"/>`
    + `<circle cx="200" cy="200" r="150" fill="none" stroke="${INK}" stroke-width="6"/>`
    + extra + `</svg>`,
  )).jpeg({ quality: 92 }).toBuffer()
}

async function pixels(buffer: Buffer, points: Array<[number, number]>) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return points.map(([x, y]) => {
    const offset = (y * info.width + x) * info.channels
    return hexOf({ r: data[offset], g: data[offset + 1], b: data[offset + 2] })
  })
}

describe('isolating the coaster on black', () => {
  it('snaps a near-black surround to exactly pure black', async () => {
    const before = await pixels(await coaster('#0b0b0d'), [[5, 5]])
    expect(before[0]).not.toBe('0,0,0')
    const [corner, farCorner] = await pixels(await isolateOnBlack(await coaster('#0b0b0d')), [[5, 5], [394, 394]])
    expect(corner).toBe('0,0,0')
    expect(farCorner).toBe('0,0,0')
  })

  it('keeps the coaster silhouette rather than dissolving it', async () => {
    // disc is centred at 200,200 with r=170, so y=120 is inside it and y=12 is clear of it
    const [inside, outside] = await pixels(await isolateOnBlack(await coaster('#0b0b0d')), [[200, 120], [200, 12]])
    expect(inside).not.toBe('0,0,0')
    expect(outside).toBe('0,0,0')
  })

  it('blackens a surround the model returned in some other colour', async () => {
    const [corner] = await pixels(await isolateOnBlack(await coaster('#d9b98a')), [[5, 5]])
    expect(corner).toBe('0,0,0')
  })

  it('flattens an uneven surround, not just a flat one', async () => {
    const gradient = '<defs><linearGradient id="g"><stop offset="0%" stop-color="#000000"/><stop offset="100%" stop-color="#191b1e"/></linearGradient></defs>'
      + '<rect width="400" height="400" fill="url(#g)"/>'
      + `<circle cx="200" cy="200" r="170" fill="${DISC}"/>`
    const buffer = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">${gradient}</svg>`)).jpeg({ quality: 92 }).toBuffer()
    const [left, right] = await pixels(await isolateOnBlack(buffer), [[5, 200], [394, 200]])
    expect(left).toBe('0,0,0')
    expect(right).toBe('0,0,0')
  })

  it('leaves dark artwork inside the coaster untouched', async () => {
    const withDarkMark = await coaster('#0b0b0d', '<circle cx="200" cy="270" r="26" fill="#0d0d0f"/>')
    const [mark] = await pixels(await isolateOnBlack(withDarkMark), [[200, 270]])
    // enclosed by the coaster, so the flood can never reach it
    expect(mark).not.toBe('0,0,0')
  })

  it('refuses rather than blacking out an image whose surround is not separable', async () => {
    // Surround the same colour as the coaster and nothing enclosing the middle,
    // so an unguarded flood would swallow the subject along with the background.
    const inseparable = await sharp(Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">`
      + `<rect width="400" height="400" fill="${DISC}"/>`
      + `<circle cx="200" cy="200" r="170" fill="${DISC}"/>`
      + `<rect x="120" y="300" width="160" height="30" fill="${INK}"/>`
      + `</svg>`)).jpeg({ quality: 92 }).toBuffer()
    const result = await isolateOnBlack(inseparable)
    const [centre, corner] = await pixels(result, [[200, 200], [5, 5]])
    expect(centre).not.toBe('0,0,0')
    expect(corner).not.toBe('0,0,0')
  })

  it('stops at whatever encloses the artwork rather than running past it', async () => {
    // Even in that degenerate case, an enclosing printed ring bounds the flood,
    // so the design inside the ring is never reached.
    const ringed = await coaster(DISC)
    const [insideRing] = await pixels(await isolateOnBlack(ringed), [[200, 200]])
    expect(insideRing).not.toBe('0,0,0')
  })
})
