import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { fillArea, samplePixelColor } from './processor'

describe('pick and fill tools', () => {
  let folder = ''
  let source = ''

  // Two separate white gaps either side of a solid black bar, plus a red mark.
  // Filling one gap must not touch the other: that separation is the whole
  // reason a bucket is safer here than a global colour replace.
  const canvas = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">'
    + '<rect width="200" height="100" fill="#ffffff"/>'
    + '<rect x="98" y="0" width="8" height="100" fill="#181713"/>'
    + '<rect x="20" y="30" width="30" height="30" fill="#df4a34"/>'
    + '</svg>',
  )

  const pixel = async (file: string, x: number, y: number) => {
    const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const offset = (y * info.width + x) * info.channels
    return `${data[offset]},${data[offset + 1]},${data[offset + 2]}`
  }

  beforeAll(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'moodprep-fill-test-'))
    source = path.join(folder, 'canvas.png')
    await sharp(canvas).png().toFile(source)
  })

  afterAll(async () => {
    if (folder.startsWith(os.tmpdir())) await fs.rm(folder, { recursive: true, force: true })
  })

  const fill = (x: number, y: number, color: string, tolerance = 12) =>
    fillArea({ projectPath: folder, imagePath: source, x, y, color, tolerance })

  it('samples the colour under a normalised point', async () => {
    expect((await samplePixelColor(source, 0.05, 0.05)).color).toBe('#ffffff')
    expect((await samplePixelColor(source, 0.175, 0.45)).color).toBe('#df4a34')
    expect((await samplePixelColor(source, 0.51, 0.5)).color).toBe('#181713')
  })

  it('clamps a point on the outer edge instead of reading past the buffer', async () => {
    expect((await samplePixelColor(source, 1, 1)).color).toBe('#ffffff')
    expect((await samplePixelColor(source, 0, 0)).color).toBe('#ffffff')
  })

  it('fills the clicked region and leaves the disconnected one untouched', async () => {
    const result = await fill(0.35, 0.85, '#3f715b')
    expect(await pixel(result.outputPath, 70, 85)).toBe('63,113,91')   // clicked side
    expect(await pixel(result.outputPath, 150, 85)).toBe('255,255,255') // other side of the bar
  })

  it('stops at artwork rather than bleeding through it', async () => {
    const result = await fill(0.35, 0.85, '#3f715b')
    expect(await pixel(result.outputPath, 102, 50)).toBe('24,23,19')  // the black bar
    expect(await pixel(result.outputPath, 35, 45)).toBe('223,74,52')  // the red mark
  })

  it('produces a working revision with real dimensions and a thumbnail', async () => {
    const result = await fill(0.35, 0.85, '#3f715b')
    expect([result.width, result.height]).toEqual([200, 100])
    expect(result.thumbnailDataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(result.outputPath.includes(`.moodprep${path.sep}previews`)).toBe(true)
  })

  it('keeps a low tolerance from swallowing a clearly different colour', async () => {
    const result = await fill(0.35, 0.85, '#3f715b', 1)
    expect(await pixel(result.outputPath, 35, 45)).toBe('223,74,52')
  })

  it('refuses to write outside the palette of valid colours', async () => {
    const result = await fill(0.35, 0.85, 'not-a-colour')
    expect(await pixel(result.outputPath, 70, 85)).toBe('255,255,255')
  })

  it('replaces the colour everywhere when the scope is global', async () => {
    const result = await fillArea({
      projectPath: folder, imagePath: source, x: 0.35, y: 0.85,
      color: '#3f715b', tolerance: 12, scope: 'global',
    })
    // both sides of the dividing bar change, unlike a contiguous fill
    expect(await pixel(result.outputPath, 70, 85)).toBe('63,113,91')
    expect(await pixel(result.outputPath, 150, 85)).toBe('63,113,91')
  })

  it('leaves other colours alone when replacing globally', async () => {
    const result = await fillArea({
      projectPath: folder, imagePath: source, x: 0.35, y: 0.85,
      color: '#3f715b', tolerance: 12, scope: 'global',
    })
    expect(await pixel(result.outputPath, 102, 50)).toBe('24,23,19')
    expect(await pixel(result.outputPath, 35, 45)).toBe('223,74,52')
  })

  // The pixels where white meets the red mark are a blend of the two, so no
  // tolerance can reach them without also reaching the mark itself. Before the
  // re-composite this left a pale halo standing on the new colour — the defect
  // the Match slider could not fix at any setting.
  describe('the edge left behind', () => {
    let soft = ''
    const softCanvas = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">'
      + '<rect width="200" height="200" fill="#ffffff"/>'
      + '<circle cx="100" cy="100" r="60" fill="#c4442a"/>'
      + '<rect x="92" y="92" width="16" height="16" fill="#e8b93f"/>'
      + '</svg>',
    )

    beforeAll(async () => {
      soft = path.join(folder, 'soft.png')
      await sharp(softCanvas).png().toFile(soft)
    })

    // What is left of the white, not how bright the pixel is: a 64%-covered
    // edge pixel of red on black is correctly (125,43,27) and quite bright,
    // while the halo this fixes is pale in every channel at once.
    const whiteLeft = async (file: string) => {
      const original = await sharp(soft).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      const result = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      let worst = 0
      for (let index = 0; index < original.info.width * original.info.height; index += 1) {
        const offset = index * original.info.channels
        // Only the pixels that carried real white to begin with. The darkest of
        // a pixel's channels says how much white is in it — the red disc and the
        // gold square both have a channel far below this, their blends with
        // white do not.
        const white = Math.min(original.data[offset], original.data[offset + 1], original.data[offset + 2])
        if (white < 120) continue
        const left = Math.min(result.data[offset], result.data[offset + 1], result.data[offset + 2])
        if (left > worst) worst = left
      }
      return worst
    }

    it('leaves no pale halo when white is replaced with black', async () => {
      const result = await fillArea({
        projectPath: folder, imagePath: soft, x: 0.02, y: 0.02,
        color: '#000000', tolerance: 12, scope: 'global',
      })
      // Before the re-composite the half-covered pixels came through untouched,
      // leaving well over 150 of white standing against the new black.
      expect(await whiteLeft(result.outputPath)).toBeLessThan(40)
    })

    it('cleans the edge of a bucket fill too', async () => {
      const result = await fillArea({
        projectPath: folder, imagePath: soft, x: 0.02, y: 0.02,
        color: '#000000', tolerance: 12,
      })
      expect(await whiteLeft(result.outputPath)).toBeLessThan(40)
    })

    it('keeps the artwork itself at its own colour', async () => {
      const result = await fillArea({
        projectPath: folder, imagePath: soft, x: 0.02, y: 0.02,
        color: '#000000', tolerance: 12, scope: 'global',
      })
      expect(await pixel(result.outputPath, 100, 60)).toBe('196,68,42')  // inside the disc
      expect(await pixel(result.outputPath, 100, 100)).toBe('232,185,63') // the third colour
    })
  })

  it('defaults to a contiguous fill when no scope is given', async () => {
    const result = await fillArea({
      projectPath: folder, imagePath: source, x: 0.35, y: 0.85,
      color: '#3f715b', tolerance: 12,
    })
    expect(await pixel(result.outputPath, 150, 85)).toBe('255,255,255')
  })
})
