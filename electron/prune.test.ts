import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prunePreviews } from './processor'

// Previews are scratch files, and until 2026-09-09 nothing ever removed one:
// the folder held 4,686 files and 5.8 GB, none of them referenced. The prune
// must clear exactly the unreferenced ones and touch nothing else.
describe('pruning unreferenced previews', () => {
  let folder = ''
  const previews = () => path.join(folder, '.moodprep', 'previews')

  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'moodprep-prune-test-'))
    await fs.mkdir(previews(), { recursive: true })
    await fs.writeFile(path.join(previews(), 'kept.png'), 'kept')
    await fs.writeFile(path.join(previews(), 'stale-one.png'), 'stale')
    await fs.writeFile(path.join(previews(), 'stale-two.jpg'), 'stale!')
    await fs.writeFile(path.join(folder, 'label.jpg'), 'source')
  })

  afterEach(async () => {
    if (folder.startsWith(os.tmpdir())) await fs.rm(folder, { recursive: true, force: true })
  })

  it('removes every preview the project does not name and keeps the ones it does', async () => {
    const result = await prunePreviews(folder, [path.join(previews(), 'kept.png'), ''])
    expect(result.removed).toBe(2)
    expect(result.bytes).toBe('stale'.length + 'stale!'.length)
    expect((await fs.readdir(previews())).sort()).toEqual(['kept.png'])
  })

  it('never reaches outside the previews folder', async () => {
    await prunePreviews(folder, [])
    await expect(fs.readFile(path.join(folder, 'label.jpg'), 'utf8')).resolves.toBe('source')
    expect(await fs.readdir(previews())).toEqual([])
  })

  it('is a no-op on a folder that has no previews yet', async () => {
    await fs.rm(previews(), { recursive: true, force: true })
    await expect(prunePreviews(folder, [])).resolves.toEqual({ removed: 0, bytes: 0 })
  })
})
