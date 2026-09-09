import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { detectRotation, processImage, scanFolder } from './processor'
import { composeStageRotation } from '../src/utils'

describe('automatic rotation detection', () => {
  let fixtureFolder = ''

  const stripes = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">'
    + '<rect width="480" height="320" fill="#ffffff"/>'
    + [60, 120, 180, 240].map((y) => `<rect x="40" y="${y}" width="400" height="14" fill="#181713"/>`).join('')
    + '</svg>',
  )
  const bars = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="480">'
    + '<rect width="320" height="480" fill="#ffffff"/>'
    + [60, 130, 200, 270].map((x) => `<rect x="${x}" y="40" width="14" height="400" fill="#181713"/>`).join('')
    + '</svg>',
  )
  // A round coaster: dominant circular border with modest text-like rows inside,
  // mirroring the badge scans that motivated the projection-profile detector.
  const coaster = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480">'
    + '<rect width="480" height="480" fill="#ffffff"/>'
    + '<circle cx="240" cy="240" r="210" fill="#f2e4c8" stroke="#181713" stroke-width="16"/>'
    + [180, 226, 272].map((y) => `<rect x="130" y="${y}" width="220" height="20" fill="#181713"/>`).join('')
    + '</svg>',
  )

  const writeFixture = async (name: string, source: Buffer, rotation: number) => {
    const target = path.join(fixtureFolder, name)
    let pipeline = sharp(source)
    if (rotation !== 0) pipeline = pipeline.rotate(rotation, { background: '#ffffff' })
    await pipeline.png().toFile(target)
    return target
  }

  beforeAll(async () => {
    fixtureFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'moodprep-rotation-test-'))
  })

  afterAll(async () => {
    if (fixtureFolder.startsWith(os.tmpdir())) await fs.rm(fixtureFolder, { recursive: true, force: true })
  })

  it('reports a level image as needing no rotation', async () => {
    const file = await writeFixture('level.png', stripes, 0)
    const result = await detectRotation(file)
    expect(result.rotation).toBe(0)
  })

  it('suggests the counter-rotation for clockwise-tilted horizontal structure', async () => {
    const file = await writeFixture('tilted-clockwise.png', stripes, 2.6)
    const result = await detectRotation(file)
    expect(result.rotation).toBeGreaterThanOrEqual(-2.9)
    expect(result.rotation).toBeLessThanOrEqual(-2.3)
  })

  it('suggests the counter-rotation for counter-clockwise-tilted vertical structure', async () => {
    const file = await writeFixture('tilted-counter.png', bars, -3.2)
    const result = await detectRotation(file)
    expect(result.rotation).toBeGreaterThanOrEqual(2.9)
    expect(result.rotation).toBeLessThanOrEqual(3.5)
  })

  it('levels tilted text rows inside a dominant circular border', async () => {
    const file = await writeFixture('coaster-tilted.png', coaster, 2.2)
    const result = await detectRotation(file)
    expect(result.rotation).toBeGreaterThanOrEqual(-2.6)
    expect(result.rotation).toBeLessThanOrEqual(-1.8)
  })

  it('leaves a level round coaster alone', async () => {
    const file = await writeFixture('coaster-level.png', coaster, 0)
    const result = await detectRotation(file)
    expect(result.rotation).toBe(0)
  })

  it('declines to guess outside the confident range instead of suggesting a wrong angle', async () => {
    const file = await writeFixture('tilted-far.png', stripes, 7.5)
    const result = await detectRotation(file)
    expect(result.rotation).toBe(0)
  })

  it('tags rotation-needed scans during folder indexing, and only those', async () => {
    const scanFixtures = await fs.mkdtemp(path.join(os.tmpdir(), 'moodprep-rotation-scan-'))
    try {
      await sharp(coaster).rotate(2.2, { background: '#ffffff' }).png().toFile(path.join(scanFixtures, 'tilted.png'))
      await sharp(coaster).png().toFile(path.join(scanFixtures, 'level.png'))
      const result = await scanFolder(scanFixtures, false)
      const tilted = result.images.find((image) => image.name === 'tilted.png')!
      const level = result.images.find((image) => image.name === 'level.png')!
      expect(tilted.suggestedIssues).toContain('rotation_needed')
      expect(level.suggestedIssues).not.toContain('rotation_needed')
    } finally {
      if (scanFixtures.startsWith(os.tmpdir())) await fs.rm(scanFixtures, { recursive: true, force: true })
    }
  })
})

describe('quarter turns', () => {
  let turnFolder = ''
  // 180 x 120 landscape with an off-centre mark, so a turn is detectable by
  // geometry rather than by symmetry alone.
  const landscape = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120">'
    + '<rect width="180" height="120" fill="#ffffff"/><rect x="10" y="10" width="60" height="20" fill="#181713"/>'
    + '</svg>',
  )

  beforeAll(async () => {
    turnFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'moodprep-turn-test-'))
    await sharp(landscape).png().toFile(path.join(turnFolder, 'landscape.png'))
  })

  afterAll(async () => {
    if (turnFolder.startsWith(os.tmpdir())) await fs.rm(turnFolder, { recursive: true, force: true })
  })

  const run = (rotation: number) => processImage({
    projectPath: turnFolder,
    imagePath: path.join(turnFolder, 'landscape.png'),
    crop: { left: 0, right: 0, top: 0, bottom: 0 },
    trim: false,
    center: false,
    background: '#ffffff',
    upscale: 1,
    outputFormat: 'png',
    paletteColors: 0,
    rotation,
  })

  it('swaps the output dimensions for a single quarter turn', async () => {
    const result = await run(composeStageRotation(1, 0))
    expect([result.width, result.height]).toEqual([120, 180])
  })

  it('keeps the dimensions for a half turn', async () => {
    const result = await run(composeStageRotation(2, 0))
    expect([result.width, result.height]).toEqual([180, 120])
  })

  it('sends three right turns as -90 degrees rather than clamping at 180', async () => {
    expect(composeStageRotation(3, 0)).toBe(-90)
    const result = await run(composeStageRotation(3, 0))
    expect([result.width, result.height]).toEqual([120, 180])
  })

  it('expands the canvas when a turn is combined with straightening', async () => {
    const result = await run(composeStageRotation(1, 4))
    expect(result.width).toBeGreaterThan(120)
    expect(result.height).toBeGreaterThan(180)
  })
})
