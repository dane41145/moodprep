import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { duplicateImage, scanFolder } from './processor'

describe('duplicating an image for separate work', () => {
  let folder = ''

  beforeAll(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'moodprep-dup-test-'))
    await sharp({ create: { width: 120, height: 90, channels: 3, background: '#df4a34' } })
      .png().toFile(path.join(folder, 'Roundhouse Kick - Imperial Stout.png'))
  })

  afterAll(async () => {
    if (folder.startsWith(os.tmpdir())) await fs.rm(folder, { recursive: true, force: true })
  })

  const source = () => path.join(folder, 'Roundhouse Kick - Imperial Stout.png')

  it('names the copy after the original and keeps it beside it', async () => {
    const copy = await duplicateImage(folder, source())
    expect(copy.name).toBe('Roundhouse Kick - Imperial Stout copy.png')
    expect(path.dirname(copy.path)).toBe(folder)
  })

  it('copies the pixels exactly', async () => {
    const copy = await duplicateImage(folder, source())
    const [a, b] = await Promise.all([fs.readFile(source()), fs.readFile(copy.path)])
    expect(a.equals(b)).toBe(true)
  })

  it('numbers further copies instead of overwriting one', async () => {
    const names = new Set<string>()
    for (let index = 0; index < 3; index += 1) names.add((await duplicateImage(folder, source())).name)
    expect(names.size).toBe(3)
    for (const name of names) expect(name.startsWith('Roundhouse Kick - Imperial Stout copy')).toBe(true)
  })

  it('gives the copy its own identity in a rescan', async () => {
    const copy = await duplicateImage(folder, source())
    const result = await scanFolder(folder, false)
    const original = result.images.find((image) => image.path === source())!
    const duplicate = result.images.find((image) => image.path === copy.path)!
    expect(duplicate.id).not.toBe(original.id)
    // identical content, which is exactly why duplicate review must be told to skip it
    expect(duplicate.exactHash).toBe(original.exactHash)
  })

  it('refuses to duplicate outside the collection or from the originals folder', async () => {
    await expect(duplicateImage(folder, path.join(os.tmpdir(), 'elsewhere.png'))).rejects.toThrow(/outside the selected folder/)
    const backups = path.join(folder, 'moodprep-originals')
    await fs.mkdir(backups, { recursive: true })
    const inside = path.join(backups, 'kept.png')
    await fs.copyFile(source(), inside)
    await expect(duplicateImage(folder, inside)).rejects.toThrow(/originals folder/)
  })
})
