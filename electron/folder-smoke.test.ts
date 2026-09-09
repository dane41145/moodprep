import { describe, expect, it } from 'vitest'
import { scanFolder } from './processor'
import { exactDuplicateGroups } from '../src/utils'
import { KNOWN_CLEAN_WATERMARK_FILENAMES } from '../shared/types'

const smokeFolder = process.env.MOODPREP_SMOKE_FOLDER

describe.skipIf(!smokeFolder)('real-folder smoke scan', () => {
  it('scans the supplied collection without aborting on an individual image', async () => {
    const result = await scanFolder(smokeFolder!, false)
    expect(result.images.length).toBeGreaterThan(0)
    expect(exactDuplicateGroups(result.images).length).toBeGreaterThanOrEqual(0)
    const alamyExample = result.images.find((image) => image.name.toLowerCase() === 'c7c88becbd9c40b6c3b683953299d157.jpg')
    if (alamyExample) expect(alamyExample.suggestedIssues).toContain('watermark')
    const xiaohongshuExample = result.images.find((image) => image.name.toLowerCase() === '8990bc780dd308b577129313f9398b53.jpg')
    if (xiaohongshuExample) expect(xiaohongshuExample.suggestedIssues).toContain('watermark')
    for (const image of result.images.filter((candidate) => KNOWN_CLEAN_WATERMARK_FILENAMES.has(candidate.name.toLowerCase()))) {
      expect(image.suggestedIssues).not.toContain('watermark')
    }
  }, 180_000)
})
