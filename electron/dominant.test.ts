import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { detectDominantColors } from './processor'

describe('dominant colours for the preset row', () => {
  let folder = ''

  beforeAll(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'moodprep-dominant-'))
    // A flat two-colour design with anti-aliased curves, saved as JPEG: the
    // shapes create a whole ramp between ink and background, and none of those
    // in-between shades belong in a colour picker.
    await sharp(Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">'
      + '<rect width="300" height="300" fill="#ffffff"/>'
      + '<circle cx="150" cy="150" r="110" fill="none" stroke="#b02321" stroke-width="14"/>'
      + '<circle cx="150" cy="150" r="60" fill="#b02321"/>'
      + '</svg>')).jpeg({ quality: 88 }).toFile(path.join(folder, 'two-colour.jpg'))
  })

  afterAll(async () => {
    if (folder.startsWith(os.tmpdir())) await fs.rm(folder, { recursive: true, force: true })
  })

  const run = (name: string, count?: number) => detectDominantColors(path.join(folder, name), count)

  it('returns the intended colours, not the anti-aliased ramp between them', async () => {
    const colours = await run('two-colour.jpg', 6)
    expect(colours.length).toBeLessThanOrEqual(3)
    expect(colours.some((colour) => /^#f[cdef]/.test(colour))).toBe(true)
    expect(colours.some((colour) => /^#[ab]/.test(colour))).toBe(true)
    // nothing from the middle of the ramp, e.g. a washed pink
    expect(colours.some((colour) => /^#[cd][6-9a-f]/.test(colour))).toBe(false)
  })

  it('honours the requested count and returns valid hex codes', async () => {
    const colours = await run('two-colour.jpg', 1)
    expect(colours.length).toBe(1)
    for (const colour of colours) expect(colour).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('copes with a single-colour image', async () => {
    await sharp({ create: { width: 60, height: 60, channels: 3, background: '#123456' } }).png().toFile(path.join(folder, 'one.png'))
    const colours = await run('one.png', 5)
    expect(colours.length).toBeGreaterThanOrEqual(1)
    expect(colours[0]).toMatch(/^#1[0-3][2-5][0-6][4-6][0-9a-f]$/)
  })
})
