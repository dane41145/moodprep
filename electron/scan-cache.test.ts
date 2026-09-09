import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { scanFolder } from './processor'

// Deriving one ImageRecord costs about four sharp decodes, so a folder of any
// size spent the same tens of seconds on every launch re-deriving results that
// had not changed. The scan now keeps them and re-inspects only what moved.
describe('scanning only what changed', () => {
  let folder = ''

  const write = async (name: string, colour: string, size = 80) => {
    await sharp({ create: { width: size, height: size, channels: 3, background: colour } })
      .png().toFile(path.join(folder, name))
  }

  beforeAll(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'moodprep-scan-cache-'))
    await write('one.png', '#c4442a')
    await write('two.png', '#3f715b')
    await write('three.png', '#e8b93f')
  })

  afterAll(async () => {
    if (folder.startsWith(os.tmpdir())) await fs.rm(folder, { recursive: true, force: true })
  })

  const cacheFile = () => path.join(folder, '.moodprep', 'scan-cache.json')

  it('does the work once and reuses it exactly', async () => {
    const cold = await scanFolder(folder, false)
    expect(cold.analysed).toBe(3)
    expect(cold.reused).toBe(0)

    const warm = await scanFolder(folder, false)
    expect(warm.analysed).toBe(0)
    expect(warm.reused).toBe(3)
    // Reused has to mean identical, not merely similar: a cheaper record that
    // differed anywhere would be a silent regression in every score and hash.
    expect(warm.images).toEqual(cold.images)
  })

  it('re-inspects only the file that changed', async () => {
    await write('two.png', '#123456')
    const result = await scanFolder(folder, false)
    expect(result.analysed).toBe(1)
    expect(result.reused).toBe(2)
    expect(result.images.find((image) => image.name === 'two.png')).toBeDefined()
  })

  // Content can change without the size changing, and a file can be replaced
  // with one of a different size in the same instant. Both halves of the key
  // are load-bearing.
  it('notices a changed size even when the timestamp is held still', async () => {
    const target = path.join(folder, 'three.png')
    const before = await fs.stat(target)
    await write('three.png', '#e8b93f', 240)
    await fs.utimes(target, before.atime, before.mtime)
    const result = await scanFolder(folder, false)
    expect(result.analysed).toBe(1)
    expect(result.images.find((image) => image.name === 'three.png')!.width).toBe(240)
  })

  it('analyses a new file alone and drops a deleted one', async () => {
    await write('four.png', '#7d5ba6')
    const added = await scanFolder(folder, false)
    expect(added.analysed).toBe(1)
    expect(added.images).toHaveLength(4)

    await fs.rm(path.join(folder, 'four.png'))
    const removed = await scanFolder(folder, false)
    expect(removed.analysed).toBe(0)
    expect(removed.images.map((image) => image.name)).not.toContain('four.png')
    // and the deleted file is gone from the cache rather than waiting to
    // reappear the next time something else changes
    const stored = JSON.parse(await fs.readFile(cacheFile(), 'utf8')) as { entries: Record<string, unknown> }
    expect(Object.keys(stored.entries).some((key) => key.endsWith('four.png'))).toBe(false)
  })

  it('ignores a cache written by a different version of the analysis', async () => {
    const stored = JSON.parse(await fs.readFile(cacheFile(), 'utf8')) as { version: number }
    await fs.writeFile(cacheFile(), JSON.stringify({ ...stored, version: stored.version - 1 }))
    const result = await scanFolder(folder, false)
    expect(result.analysed).toBe(result.images.length)
  })

  it('treats an unreadable cache as no cache rather than failing the scan', async () => {
    await fs.writeFile(cacheFile(), '{ this is not json')
    const result = await scanFolder(folder, false)
    expect(result.images.length).toBeGreaterThan(0)
    expect(result.analysed).toBe(result.images.length)
  })
})
