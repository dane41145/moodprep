import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { padToSquare } from './processor'

// The reported failure: Musée_Européen_de_la_Bière,_Beer_coaster_pic-168.JPG is
// 2776 x 2443, a round mat photographed at a steep angle. Image models take the
// output frame from the input frame, so asking for a circle inside an oblong
// canvas gets a compromise — an ellipse. The coaster preset squares the canvas
// before sending so a true circle is the natural thing to draw.
async function photo(width: number, height: number) {
  return sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<rect width="${width}" height="${height}" fill="#8a6a4a"/>`
    + `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${width * 0.4}" ry="${height * 0.36}" fill="#e8d5ae"/>`
    + `</svg>`,
  )).jpeg({ quality: 90 }).toBuffer()
}

async function size(buffer: Buffer) {
  const { width, height } = await sharp(buffer).metadata()
  return { width, height }
}

async function pixel(buffer: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const offset = (y * info.width + x) * info.channels
  return [data[offset], data[offset + 1], data[offset + 2]]
}

describe('squaring the canvas before a coaster reconstruction', () => {
  it('pads a landscape photo out to a square on the long edge', async () => {
    const padded = await padToSquare(await photo(2776, 2443))
    expect(await size(padded)).toEqual({ width: 2776, height: 2776 })
  })

  it('pads a portrait photo the same way', async () => {
    const padded = await padToSquare(await photo(1200, 2000))
    expect(await size(padded)).toEqual({ width: 2000, height: 2000 })
  })

  it('centres the original so the subject does not drift off-axis', async () => {
    const padded = await padToSquare(await photo(400, 300))
    // 100px of padding split evenly: 50 above, 50 below.
    const [, , topBlue] = await pixel(padded, 200, 10)
    const [, , bottomBlue] = await pixel(padded, 200, 390)
    expect(topBlue).toBeLessThan(20)
    expect(bottomBlue).toBeLessThan(20)
    // The photographed surface still starts at the same offset on both sides.
    const [topSurface] = await pixel(padded, 5, 60)
    const [bottomSurface] = await pixel(padded, 5, 339)
    expect(topSurface).toBeGreaterThan(60)
    expect(bottomSurface).toBeGreaterThan(60)
  })

  it('pads with pure black, which is the surround the preset asks for anyway', async () => {
    const padded = await padToSquare(await photo(400, 300))
    expect(await pixel(padded, 8, 8)).toEqual([0, 0, 0])
    expect(await pixel(padded, 392, 392)).toEqual([0, 0, 0])
  })

  it('returns an already-square image untouched rather than re-encoding it', async () => {
    const square = await photo(800, 800)
    expect(await padToSquare(square)).toBe(square)
  })
})
