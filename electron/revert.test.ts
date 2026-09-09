import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { commitProcessedImage, revertCommittedImage } from './processor'

// Replacing an original is the one action in the workbench that writes over a
// file the user brought in, and it sits next to the routine Apply button. It is
// reversible by design — the previous file is moved into the backup folder
// rather than discarded — which is what lets the workbench offer undo instead
// of a confirmation dialog in front of every save. These tests hold that
// promise: the undo must return the exact original bytes, and must refuse
// anything that would let it write outside the project or over a backup.
describe('undoing a replaced original', () => {
  let folder = ''
  const NAME = 'Weinfelder Bier.png'
  const source = () => path.join(folder, NAME)
  const previewPath = () => path.join(folder, '.moodprep', 'previews', 'edited.png')

  beforeEach(async () => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), 'moodprep-revert-test-'))
    await fs.mkdir(path.join(folder, '.moodprep', 'previews'), { recursive: true })
    await sharp({ create: { width: 40, height: 40, channels: 3, background: '#df4a34' } }).png().toFile(source())
    await sharp({ create: { width: 40, height: 40, channels: 3, background: '#3f715b' } }).png().toFile(previewPath())
  })

  afterEach(async () => {
    if (folder.startsWith(os.tmpdir())) await fs.rm(folder, { recursive: true, force: true })
  })

  it('restores the original byte for byte', async () => {
    const before = await fs.readFile(source())
    const committed = await commitProcessedImage(folder, source(), previewPath())
    const saved = await fs.readFile(source())
    expect(saved.equals(before)).toBe(false)

    await revertCommittedImage(folder, source(), committed.backupPath)
    const after = await fs.readFile(source())
    expect(after.equals(before)).toBe(true)
  })

  it('consumes the backup so the folder is left as it started', async () => {
    const committed = await commitProcessedImage(folder, source(), previewPath())
    await revertCommittedImage(folder, source(), committed.backupPath)
    await expect(fs.access(committed.backupPath)).rejects.toThrow()
    const strays = await fs.readdir(folder)
    expect(strays.filter((entry) => entry.includes('.tmp'))).toEqual([])
  })

  it('survives a commit and undo repeated on the same file', async () => {
    const before = await fs.readFile(source())
    for (let round = 0; round < 3; round += 1) {
      const committed = await commitProcessedImage(folder, source(), previewPath())
      await revertCommittedImage(folder, source(), committed.backupPath)
    }
    expect((await fs.readFile(source())).equals(before)).toBe(true)
  })

  it('refuses a backup path outside the originals folder', async () => {
    const committed = await commitProcessedImage(folder, source(), previewPath())
    const decoy = path.join(folder, 'decoy.png')
    await fs.copyFile(committed.backupPath, decoy)
    await expect(revertCommittedImage(folder, source(), decoy)).rejects.toThrow(/not a MoodPrep backup/i)
  })

  it('refuses to restore over a file inside the originals folder', async () => {
    const committed = await commitProcessedImage(folder, source(), previewPath())
    await expect(revertCommittedImage(folder, committed.backupPath, committed.backupPath)).rejects.toThrow(/Refusing to restore/i)
  })

  it('refuses to escape the project folder', async () => {
    const committed = await commitProcessedImage(folder, source(), previewPath())
    const outside = path.join(os.tmpdir(), 'moodprep-outside-target.png')
    await expect(revertCommittedImage(folder, outside, committed.backupPath)).rejects.toThrow()
  })

  // The undo affordance is offered in a toast that outlives the commit, so the
  // backup can be gone by the time it is pressed. That has to be a stated
  // failure, never a silent one that leaves the file missing.
  it('says so plainly when the backup has already been removed', async () => {
    const committed = await commitProcessedImage(folder, source(), previewPath())
    await fs.rm(committed.backupPath)
    await expect(revertCommittedImage(folder, source(), committed.backupPath)).rejects.toThrow(/no longer there/i)
    await expect(fs.access(source())).resolves.toBeUndefined()
  })
})
