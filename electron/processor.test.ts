import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { analyzeImageQuality, authorPrompt, commitProcessedImage, convertSvgs, detectBackgroundColor, detectPalette, aiEdit, loadEditorPreview, processImage, refreshImage, scanFolder } from './processor'
import { hammingHex } from '../src/utils'
import { PROMPT_AUTHOR_MODEL } from '../shared/models'

const EMPTY = { left: 0, right: 0, top: 0, bottom: 0 }

describe('local image pipeline', () => {
  let fixtureFolder = ''

  beforeAll(async () => {
    fixtureFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'moodprep-test-'))
    const pixels = await sharp({
      create: { width: 180, height: 120, channels: 3, background: '#ffffff' },
    })
      .composite([{ input: Buffer.from('<svg width="100" height="70"><rect width="100" height="70" fill="#df4a34"/><circle cx="50" cy="35" r="22" fill="#181713"/></svg>'), left: 40, top: 25 }])
      .png()
      .toBuffer()
    await fs.writeFile(path.join(fixtureFolder, 'mark.png'), pixels)
    await fs.writeFile(path.join(fixtureFolder, 'mark-copy.png'), pixels)
    await sharp(pixels).jpeg({ quality: 72 }).toFile(path.join(fixtureFolder, 'mark-compressed.jpg'))
    await fs.writeFile(path.join(fixtureFolder, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#f5f1e8"/><text x="20" y="70" font-size="34">Mood</text></svg>')
  })

  afterAll(async () => {
    if (fixtureFolder.startsWith(os.tmpdir())) await fs.rm(fixtureFolder, { recursive: true, force: true })
  })

  it('indexes raster and SVG files with stable hashes and thumbnails', async () => {
    const result = await scanFolder(fixtureFolder, false)
    expect(result.images).toHaveLength(4)
    expect(result.images.every((image) => image.thumbnailDataUrl.startsWith('data:image/jpeg;base64,'))).toBe(true)
    const original = result.images.find((image) => image.name === 'mark.png')!
    const copy = result.images.find((image) => image.name === 'mark-copy.png')!
    const compressed = result.images.find((image) => image.name === 'mark-compressed.jpg')!
    expect(original.exactHash).toBe(copy.exactHash)
    expect(original.exactHash).not.toBe(compressed.exactHash)
    expect(hammingHex(original.perceptualHash!, compressed.perceptualHash!)).toBeLessThanOrEqual(5)
  })

  it('creates a non-destructive processed preview', async () => {
    const source = path.join(fixtureFolder, 'mark.png')
    const before = await fs.readFile(source)
    const result = await processImage({
      projectPath: fixtureFolder,
      imagePath: source,
      crop: { left: 2, right: 2, top: 2, bottom: 2 },
      trim: true,
      center: true,
      background: '#ffffff',
      upscale: 2,
      outputFormat: 'png',
      paletteColors: 0,
    })
    expect(result.width).toBeGreaterThan(180)
    expect(result.quality.score).toBeGreaterThanOrEqual(0)
    expect(result.quality.score).toBeLessThanOrEqual(100)
    expect(result.thumbnailDataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(await fs.readFile(source)).toEqual(before)
    expect((await fs.stat(result.outputPath)).isFile()).toBe(true)
  })

  it('paints selected areas with the chosen background without AI', async () => {
    const source = path.join(fixtureFolder, 'paint-background.png')
    await sharp({ create: { width: 200, height: 150, channels: 3, background: '#f2c51b' } })
      .composite([{ input: Buffer.from('<svg width="40" height="40"><rect width="40" height="40" fill="#173b78"/></svg>'), left: 15, top: 15 }])
      .png()
      .toFile(source)
    const result = await processImage({
      projectPath: fixtureFolder,
      imagePath: source,
      crop: { left: 0, right: 0, top: 0, bottom: 0 },
      trim: false,
      center: false,
      background: '#f2c51b',
      upscale: 1,
      outputFormat: 'png',
      paletteColors: 0,
      paintStrokes: [{ points: [{ x: 0.175, y: 0.233 }], size: 0.3 }],
    })
    const painted = await sharp(result.outputPath).extract({ left: 35, top: 35, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
    expect([...painted.slice(0, 3)]).toEqual([242, 197, 27])
    const original = await sharp(source).extract({ left: 35, top: 35, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
    expect([...original.slice(0, 3)]).toEqual([23, 59, 120])
  })

  // Strokes used to take their colour from the request, so a second colour meant
  // committing the first one and waiting for the pipeline before it could be
  // chosen. Each stroke now carries its own, and one pass lays down both.
  it('paints each pending stroke in the colour it was drawn with', async () => {
    const source = path.join(fixtureFolder, 'two-colour-strokes.png')
    await sharp({ create: { width: 200, height: 150, channels: 3, background: '#ffffff' } }).png().toFile(source)
    const result = await processImage({
      projectPath: fixtureFolder,
      imagePath: source,
      crop: { left: 0, right: 0, top: 0, bottom: 0 },
      trim: false,
      center: false,
      background: '#f2c51b',
      upscale: 1,
      outputFormat: 'png',
      paletteColors: 0,
      paintStrokes: [
        { points: [{ x: 0.25, y: 0.5 }], size: 0.2, color: '#000000' },
        { points: [{ x: 0.75, y: 0.5 }], size: 0.2, color: '#df4a34' },
      ],
    })
    const at = async (x: number, y: number) => [...(await sharp(result.outputPath).extract({ left: x, top: y, width: 1, height: 1 }).removeAlpha().raw().toBuffer()).slice(0, 3)]
    expect(await at(50, 75)).toEqual([0, 0, 0])
    expect(await at(150, 75)).toEqual([223, 74, 52])
  })

  // Strokes recorded before they carried a colour still paint the background.
  it('falls back to the request colour for a stroke with none of its own', async () => {
    const source = path.join(fixtureFolder, 'colourless-stroke.png')
    await sharp({ create: { width: 200, height: 150, channels: 3, background: '#ffffff' } }).png().toFile(source)
    const result = await processImage({
      projectPath: fixtureFolder,
      imagePath: source,
      crop: { left: 0, right: 0, top: 0, bottom: 0 },
      trim: false,
      center: false,
      background: '#173b78',
      upscale: 1,
      outputFormat: 'png',
      paletteColors: 0,
      paintStrokes: [{ points: [{ x: 0.5, y: 0.5 }], size: 0.2 }],
    })
    const painted = await sharp(result.outputPath).extract({ left: 100, top: 75, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
    expect([...painted.slice(0, 3)]).toEqual([23, 59, 120])
  })

  // Writing the prompt is a reading job: the same endpoint as the edit, asking
  // for text back, on the fixed light model rather than whichever model is
  // selected to redraw the artwork.
  describe('writing a prompt for one image', () => {
    const reply = (text: string) => new Response(JSON.stringify({
      steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })

    it('sends the image and the instruction to the fixed light model and returns the text', async () => {
      let sent: Record<string, unknown> = {}
      const result = await authorPrompt(
        { imagePath: path.join(fixtureFolder, 'mark.png'), instruction: 'Study this image and write the instruction.' },
        'test-key',
        async (_url, init) => { sent = JSON.parse(String(init?.body)); return reply('Remove the foxing and flatten the board texture.') },
      )
      expect(result.prompt).toBe('Remove the foxing and flatten the board texture.')
      expect(result.model).toBe(PROMPT_AUTHOR_MODEL)
      expect(sent.model).toBe(PROMPT_AUTHOR_MODEL)
      expect(sent.response_format).toEqual({ type: 'text' })
      const input = sent.input as Array<{ type: string; text?: string; data?: string }>
      expect(input[0]).toEqual({ type: 'text', text: 'Study this image and write the instruction.' })
      expect(input[1].type).toBe('image')
      expect(String(input[1].data).length).toBeGreaterThan(0)
    })

    it('asks for a key rather than calling without one', async () => {
      await expect(authorPrompt({ imagePath: path.join(fixtureFolder, 'mark.png'), instruction: 'Study this image.' }, ''))
        .rejects.toThrow('Add a Gemini API key in Settings first.')
    })

    it('says so when the reply carries no text at all', async () => {
      await expect(authorPrompt(
        { imagePath: path.join(fixtureFolder, 'mark.png'), instruction: 'Study this image.' },
        'test-key',
        async () => new Response(JSON.stringify({ steps: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
      )).rejects.toThrow(/no prompt for this image/i)
    })
  })

  it('describes a Gemini policy block as a decline rather than a connection failure', async () => {
    const response = new Response(JSON.stringify({ error: { message: 'Request blocked due to copyright safety policy' } }), { status: 400, headers: { 'content-type': 'application/json' } })
    await expect(aiEdit({ projectPath: fixtureFolder, imagePath: path.join(fixtureFolder, 'mark.png'), prompt: 'Faithfully restore this supplied image.', imageSize: '1K' }, 'test-key', async () => response))
      .rejects.toThrow('Gemini declined this request under its policy')
  })

  it('adds canvas only to the side where artwork touches an edge before a Gemini request', async () => {
    const source = path.join(fixtureFolder, 'top-edge-contact.png')
    await sharp({ create: { width: 200, height: 150, channels: 3, background: '#ffffff' } })
      .composite([{ input: Buffer.from('<svg width="60" height="55"><rect width="60" height="55" fill="#173b78"/></svg>'), left: 70, top: 0 }])
      .png()
      .toFile(source)
    let sentImage: Buffer | undefined
    const resultImage = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#f2c51b' } }).png().toBuffer()
    const networkFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { input: Array<{ type: string; data?: string; mime_type?: string }> }
      const imagePart = body.input.find((part) => part.type === 'image')
      sentImage = Buffer.from(imagePart?.data ?? '', 'base64')
      expect(imagePart?.mime_type).toBe('image/png')
      return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: resultImage.toString('base64') }] }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    await aiEdit({ projectPath: fixtureFolder, imagePath: source, prompt: 'Complete the missing artwork on every edge.', imageSize: '2K', completeEdges: true, canvasBackground: '#ffffff' }, 'test-key', networkFetch)
    const metadata = await sharp(sentImage!).metadata()
    expect(metadata.width).toBe(200)
    expect(metadata.height).toBeGreaterThan(150)
  })

  it('applies a square background brush with square corners', async () => {
    const source = path.join(fixtureFolder, 'square-brush.png')
    await sharp({ create: { width: 120, height: 120, channels: 3, background: '#173b78' } }).png().toFile(source)
    const result = await processImage({
      projectPath: fixtureFolder,
      imagePath: source,
      crop: { left: 0, right: 0, top: 0, bottom: 0 },
      trim: false,
      center: false,
      background: '#f2c51b',
      upscale: 1,
      outputFormat: 'png',
      paletteColors: 0,
      paintStrokes: [{ points: [{ x: 0.5, y: 0.5 }], size: 0.2, shape: 'square' }],
    })
    const corner = await sharp(result.outputPath).extract({ left: 49, top: 49, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
    expect([...corner.slice(0, 3)]).toEqual([242, 197, 27])
    const outside = await sharp(result.outputPath).extract({ left: 46, top: 46, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
    expect([...outside.slice(0, 3)]).toEqual([23, 59, 120])
  })

  it('paints every image edge and preserves the full canvas even when trim was requested', async () => {
    const source = path.join(fixtureFolder, 'edge-brush.png')
    await sharp({ create: { width: 120, height: 90, channels: 3, background: '#173b78' } }).png().toFile(source)
    const result = await processImage({
      projectPath: fixtureFolder,
      imagePath: source,
      crop: { left: 0, right: 0, top: 0, bottom: 0 },
      trim: true,
      center: true,
      background: '#f2c51b',
      upscale: 1,
      outputFormat: 'png',
      paletteColors: 0,
      paintStrokes: [
        { points: [{ x: 0, y: 0 }], size: 0.1 },
        { points: [{ x: 1, y: 0 }], size: 0.1, shape: 'square' },
        { points: [{ x: 0, y: 1 }], size: 0.1 },
        { points: [{ x: 1, y: 1 }], size: 0.1, shape: 'square' },
      ],
    })
    expect(result.width).toBe(120)
    expect(result.height).toBe(90)
    const pixels = await sharp(result.outputPath).removeAlpha().raw().toBuffer()
    const pixelAt = (x: number, y: number) => [...pixels.slice(((y * 120) + x) * 3, (((y * 120) + x) * 3) + 3)]
    expect(pixelAt(0, 0)).toEqual([242, 197, 27])
    expect(pixelAt(119, 0)).toEqual([242, 197, 27])
    expect(pixelAt(0, 89)).toEqual([242, 197, 27])
    expect(pixelAt(119, 89)).toEqual([242, 197, 27])
  })

  it('rotates an image by a fine angle without cropping its corners', async () => {
    const source = path.join(fixtureFolder, 'slightly-tilted.png')
    await sharp({ create: { width: 160, height: 100, channels: 3, background: '#173b78' } }).png().toFile(source)
    const result = await processImage({
      projectPath: fixtureFolder,
      imagePath: source,
      crop: { left: 0, right: 0, top: 0, bottom: 0 },
      trim: false,
      center: false,
      background: '#f2c51b',
      upscale: 1,
      outputFormat: 'png',
      paletteColors: 0,
      rotation: 2.5,
    })
    expect(result.width).toBeGreaterThan(160)
    expect(result.height).toBeGreaterThan(100)
    const corner = await sharp(result.outputPath).extract({ left: 0, top: 0, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
    expect([...corner.slice(0, 3)]).toEqual([242, 197, 27])
  })

  it('centres detected artwork with symmetric margins after trimming', async () => {
    const source = path.join(fixtureFolder, 'off-centre.png')
    await sharp({ create: { width: 500, height: 300, channels: 3, background: '#f8f6ef' } })
      .composite([{ input: Buffer.from('<svg width="160" height="100"><rect width="160" height="100" rx="8" fill="#171612"/></svg>'), left: 45, top: 35 }])
      .png()
      .toFile(source)
    const result = await processImage({
      projectPath: fixtureFolder,
      imagePath: source,
      crop: { left: 0, right: 0, top: 0, bottom: 0 },
      trim: true,
      center: true,
      background: '#f8f6ef',
      upscale: 1,
      outputFormat: 'png',
      paletteColors: 0,
    })
    const { width, height } = await sharp(result.outputPath).metadata()
    expect(width).toBeGreaterThanOrEqual(172)
    expect(width).toBeLessThanOrEqual(176)
    expect(height).toBeGreaterThanOrEqual(108)
    expect(height).toBeLessThanOrEqual(112)
  })

  it('detects the dominant artwork background rather than defaulting to white', async () => {
    const source = path.join(fixtureFolder, 'yellow-background.png')
    await sharp({ create: { width: 240, height: 180, channels: 3, background: '#f2c51b' } })
      .composite([{ input: Buffer.from('<svg width="80" height="80"><circle cx="40" cy="40" r="35" fill="#b72f22"/></svg>'), left: 80, top: 50 }])
      .png()
      .toFile(source)
    const result = await detectBackgroundColor(source)
    const red = Number.parseInt(result.color.slice(1, 3), 16)
    const green = Number.parseInt(result.color.slice(3, 5), 16)
    const blue = Number.parseInt(result.color.slice(5, 7), 16)
    expect(red).toBeGreaterThan(220)
    expect(green).toBeGreaterThan(170)
    expect(blue).toBeLessThan(70)
  })

  it('flags a detached stock-credit line as a likely watermark', async () => {
    const source = path.join(fixtureFolder, 'stock-credit-example.png')
    await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#fff"/><path d="M70 35h460v320H70z" fill="#e5ba27"/><circle cx="300" cy="175" r="105" fill="#173b78"/><text x="230" y="397" font-family="Arial" font-size="11" fill="#222">stock.example - A1B2</text></svg>'))
      .png()
      .toFile(source)
    const result = await refreshImage(fixtureFolder, source)
    expect(result.suggestedIssues).toContain('watermark')
    await fs.rm(source)
  })

  it('detects an intended four-colour palette despite JPEG noise and antialiased transitions', async () => {
    const source = path.join(fixtureFolder, 'four-colour-noisy.jpg')
    await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#e34927"/><circle cx="230" cy="300" r="165" fill="#183b77"/><path d="M430 95h370v185H430z" fill="#f7f3e7"/><path d="M430 320h370v185H430z" fill="#e9b92d"/><path d="M90 520L810 80" fill="none" stroke="#f7f3e7" stroke-width="18"/></svg>'))
      .jpeg({ quality: 68, chromaSubsampling: '4:2:0' })
      .toFile(source)
    const result = await detectPalette(source)
    expect(result.recommendedColors).toBe(4)
    expect(result.swatches).toHaveLength(4)
    expect(result.confidence).toBeGreaterThan(0.8)
  })

  it('loads a high-resolution editor preview rather than the card thumbnail', async () => {
    const source = path.join(fixtureFolder, 'editor-detail.png')
    await sharp({ create: { width: 1400, height: 900, channels: 3, background: '#e9d79f' } }).png().toFile(source)
    const result = await loadEditorPreview(source)
    expect(result.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
    const metadata = await sharp(Buffer.from(result.dataUrl.split(',')[1], 'base64')).metadata()
    expect(metadata.width).toBe(1400)
    expect(metadata.height).toBe(900)
  })

  it('refreshes only one image with its new dimensions, hash, and quality', async () => {
    const source = path.join(fixtureFolder, 'single-refresh.png')
    await sharp({ create: { width: 160, height: 100, channels: 3, background: '#d85a3f' } }).png().toFile(source)
    const before = await refreshImage(fixtureFolder, source)
    await sharp({ create: { width: 1280, height: 800, channels: 3, background: '#d85a3f' } }).png().toFile(source)
    const refreshed = await refreshImage(fixtureFolder, source)
    expect(refreshed.id).not.toBe(before.id)
    expect(refreshed.width).toBe(1280)
    expect(refreshed.quality.score).toBeGreaterThan(before.quality.score)
  })

  it('scores crisp, clean flat artwork above the replacement threshold', async () => {
    const source = path.join(fixtureFolder, 'clean-reconstruction.jpg')
    await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="720"><rect width="1440" height="720" fill="#142342"/><path fill="#f2b92b" d="M720 70l48 190 165-108-104 169 197 20-191 56 132 149-164-112-45 194-4-199-186 70 159-120-174-98 193 52z"/><path fill="#f2b92b" d="M105 520h1230v85H105z"/></svg>'))
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
      .toFile(source)
    const result = await analyzeImageQuality(source)
    expect(result.quality.score).toBeGreaterThan(80)
    expect(result.quality.reasons).toContain('1.0 MP with crisp edges and clean colour')
  })

  it('does not reward a large image when its edges are blurred and ghosted', async () => {
    const source = path.join(fixtureFolder, 'large-but-degraded.jpg')
    const artwork = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="976"><rect width="1200" height="976" fill="#f3ebe5"/><g fill="none" stroke="#198c62" stroke-width="22" opacity=".35"><path d="M145 690Q360 110 790 650"/><path d="M175 690Q390 110 820 650"/><path d="M205 690Q420 110 850 650"/></g><path fill="#168b61" d="M630 190c85 0 145 73 145 156 0 65-36 112-74 151l171 260-111 49-171-268-82 251-118-35 104-340c25-82 45-224 136-224z"/></svg>'))
      .blur(2.4)
      .jpeg({ quality: 48 })
      .toBuffer()
    await fs.writeFile(source, artwork)
    const result = await analyzeImageQuality(source)
    expect(result.quality.score).toBeLessThan(81)
    expect(result.quality.reasons.some((reason) => reason.includes('ghosted edges') || reason.includes('Colour bleed'))).toBe(true)
  })

  it('flattens compression-like colour variation into a small clean palette', async () => {
    const source = path.join(fixtureFolder, 'flat-logo.png')
    await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="r"><stop stop-color="#ef2d20"/><stop offset="1" stop-color="#ff3b25"/></linearGradient></defs><rect width="320" height="180" fill="url(#r)"/><path d="M45 95h230v45H45z" fill="#162b68"/><text x="78" y="130" font-size="42" fill="#fff">LOGO</text></svg>'))
      .png()
      .toFile(source)
    const result = await processImage({
      projectPath: fixtureFolder,
      imagePath: source,
      crop: { left: 0, right: 0, top: 0, bottom: 0 },
      trim: false,
      center: false,
      background: '#ffffff',
      upscale: 1,
      outputFormat: 'png',
      paletteColors: 8,
    })
    const { data, info } = await sharp(result.outputPath).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const colours = new Set<string>()
    for (let offset = 0; offset < data.length; offset += info.channels) colours.add(`${data[offset]},${data[offset + 1]},${data[offset + 2]}`)
    expect(colours.size).toBeLessThanOrEqual(8)
  })

  // The bug this guards: the panel detected six colours including a red and a
  // green, and the flatten returned a monochrome brown. Detection and flatten
  // were different algorithms; now the flatten maps to what detection found.
  it('keeps small inks when flattening a design dominated by a paper gradient', async () => {
    const source = path.join(fixtureFolder, 'small-inks.png')
    await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360"><defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#efe4cc"/><stop offset="1" stop-color="#d6c4a3"/></linearGradient></defs><rect width="360" height="360" fill="url(#p)"/><rect x="40" y="40" width="46" height="46" fill="#c8402f"/><rect x="260" y="260" width="46" height="46" fill="#2f6b3a"/></svg>'))
      .png()
      .toFile(source)
    const analysis = await detectPalette(source)
    const result = await processImage({
      projectPath: fixtureFolder,
      imagePath: source,
      crop: { left: 0, right: 0, top: 0, bottom: 0 },
      trim: false,
      center: false,
      background: '#ffffff',
      upscale: 1,
      outputFormat: 'png',
      paletteColors: analysis.recommendedColors,
    })
    const { data, info } = await sharp(result.outputPath).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const read = (x: number, y: number) => { const o = ((y * info.width) + x) * info.channels; return [data[o], data[o + 1], data[o + 2]] }
    const red = read(63, 63)
    const green = read(283, 283)
    expect(red[0]).toBeGreaterThan(red[1] + 60)
    expect(green[1]).toBeGreaterThan(green[0] + 25)
    const colours = new Set<string>()
    for (let offset = 0; offset < data.length; offset += info.channels) colours.add(`${data[offset]},${data[offset + 1]},${data[offset + 2]}`)
    expect(colours.size).toBeLessThanOrEqual(analysis.recommendedColors)
  })

  it('commits an accepted preview and keeps the replaced source for reference', async () => {
    const source = path.join(fixtureFolder, 'mark.png')
    const original = await fs.readFile(source)
    const preview = await processImage({
      projectPath: fixtureFolder,
      imagePath: source,
      crop: { left: 5, right: 5, top: 5, bottom: 5 },
      trim: false,
      center: false,
      background: '#ffffff',
      upscale: 2,
      outputFormat: 'png',
      paletteColors: 0,
    })
    const committed = await commitProcessedImage(fixtureFolder, source, preview.outputPath)
    expect(await fs.readFile(committed.backupPath)).toEqual(original)
    expect((await sharp(committed.outputPath).metadata()).width).toBeGreaterThan(180)
    const rescanned = await scanFolder(fixtureFolder, false)
    const rescannedMark = rescanned.images.find((image) => image.name === 'mark.png')
    expect(rescannedMark?.processed).toBe(true)
    expect(rescannedMark?.quality.score).toBeGreaterThanOrEqual(0)
  })

  // The border is added outside the artwork, in the working colour, after the
  // upscale and the palette flatten — so its width is real output pixels rather
  // than the upscale's multiple of them, and its colour is the one that was
  // picked rather than whatever the quantiser rounded it to.
  it('frames the image in the working colour without covering any of it', async () => {
    const source = path.join(fixtureFolder, 'border-source.png')
    await sharp({ create: { width: 180, height: 120, channels: 3, background: '#ffffff' } })
      .composite([{ input: Buffer.from('<svg width="100" height="70"><rect width="100" height="70" fill="#181713"/></svg>'), left: 40, top: 25 }])
      .png().toFile(source)
    const plain = await processImage({
      projectPath: fixtureFolder, imagePath: source, crop: EMPTY, trim: false, center: false,
      background: '#ffffff', upscale: 1, outputFormat: 'png', paletteColors: 0,
    })
    const framed = await processImage({
      projectPath: fixtureFolder, imagePath: source, crop: EMPTY, trim: false, center: false,
      background: '#ffffff', upscale: 1, outputFormat: 'png', paletteColors: 0,
      border: { width: 0.05, colour: '#00ff00' },
    })
    // 5% of the shorter edge (120) is 6px, added on all four sides.
    expect(framed.width).toBe(plain.width + 12)
    expect(framed.height).toBe(plain.height + 12)

    const { data, info } = await sharp(framed.outputPath).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const at = (x: number, y: number) => {
      const index = ((y * info.width) + x) * info.channels
      return [data[index], data[index + 1], data[index + 2]]
    }
    // Every corner and every edge midpoint is exactly the colour asked for.
    for (const [x, y] of [[0, 0], [info.width - 1, 0], [0, info.height - 1], [info.width - 1, info.height - 1],
                          [Math.floor(info.width / 2), 0], [0, Math.floor(info.height / 2)]]) {
      expect(at(x, y), `${x},${y}`).toEqual([0, 255, 0])
    }
    // Just inside the border the original artwork is untouched, not overpainted.
    expect(at(6, 6)).toEqual([255, 255, 255])
    const centre = at(Math.floor(info.width / 2), Math.floor(info.height / 2))
    expect(centre[0]).toBeLessThan(60)
    expect(centre[1]).toBeLessThan(60)
  })

  it('measures the border against the upscaled output, not the source', async () => {
    // Applied after the upscale, so a 5% border stays 5% of what is saved
    // rather than being multiplied by the upscale factor.
    const source = path.join(fixtureFolder, 'border-upscale-source.png')
    await sharp({ create: { width: 180, height: 120, channels: 3, background: '#ffffff' } }).png().toFile(source)
    const framed = await processImage({
      projectPath: fixtureFolder, imagePath: source, crop: EMPTY, trim: false, center: false,
      background: '#ffffff', upscale: 2, outputFormat: 'png', paletteColors: 0,
      border: { width: 0.05, colour: '#ff00ff' },
    })
    // 180x120 upscaled to 360x240; 5% of the shorter edge (240) is 12px.
    expect(framed.width).toBe(360 + 24)
    expect(framed.height).toBe(240 + 24)
  })

  it('converts SVG files in place and moves their sources to the originals folder', async () => {
    const source = path.join(fixtureFolder, 'vector.svg')
    const original = await fs.readFile(source)
    const result = await convertSvgs(fixtureFolder, false)
    expect(result.convertedCount).toBe(1)
    expect(result.failed).toEqual([])
    await expect(fs.access(source)).rejects.toThrow()
    expect(await fs.readFile(path.join(result.backupFolder, 'vector.svg'))).toEqual(original)
    expect((await sharp(path.join(fixtureFolder, 'vector.png')).metadata()).format).toBe('png')
  })
})

// Two providers, two entirely different request and response shapes. The
// adapter is the only place that knows the difference, so it is the only place
// worth testing: everything after it — isolate-on-black, the preview write, the
// thumbnail — is shared.
describe('choosing a reconstruction model', () => {
  let modelFolder = ''
  const folder = () => modelFolder
  const source = () => path.join(modelFolder, 'model-choice.png')
  const resultImage = async () => sharp({ create: { width: 24, height: 24, channels: 3, background: '#f2c51b' } }).png().toBuffer()

  beforeAll(async () => {
    modelFolder = await fs.mkdtemp(path.join(os.tmpdir(), 'moodprep-model-test-'))
    await sharp({ create: { width: 60, height: 60, channels: 3, background: '#173b78' } }).png().toFile(source())
  })

  afterAll(async () => {
    if (modelFolder.startsWith(os.tmpdir())) await fs.rm(modelFolder, { recursive: true, force: true })
  })

  it('defaults to Flash Lite when no model is named', async () => {
    let sentModel = ''
    const image = await resultImage()
    await aiEdit({ projectPath: folder(), imagePath: source(), prompt: 'Faithfully restore this supplied image.', imageSize: '1K' }, 'test-key', async (_url, init) => {
      sentModel = (JSON.parse(String(init?.body)) as { model: string }).model
      return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: image.toString('base64') }] }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    expect(sentModel).toBe('gemini-3.1-flash-lite-image')
  })

  it('sends an unknown model id to the default rather than to the API', async () => {
    let sentModel = ''
    const image = await resultImage()
    await aiEdit({ projectPath: folder(), imagePath: source(), prompt: 'Faithfully restore this supplied image.', imageSize: '1K', model: 'not-a-real-model' }, 'test-key', async (_url, init) => {
      sentModel = (JSON.parse(String(init?.body)) as { model: string }).model
      return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: image.toString('base64') }] }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    expect(sentModel).toBe('gemini-3.1-flash-lite-image')
  })

  it('routes a Gemini model to Google with the key in the Google header', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const image = await resultImage()
    await aiEdit({ projectPath: folder(), imagePath: source(), prompt: 'Faithfully restore this supplied image.', imageSize: '1K', model: 'gemini-3-pro-image' }, 'google-key', async (url, init) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> })
      return new Response(JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: image.toString('base64') }] }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    expect(seen[0].url).toContain('generativelanguage.googleapis.com')
    expect(seen[0].headers['x-goog-api-key']).toBe('google-key')
  })

  // DashScope answers with a temporary URL rather than the image, so the
  // adapter has to make a second request before anything can be written.
  it('routes Qwen to DashScope and downloads the image it points at', async () => {
    const image = await resultImage()
    const calls: string[] = []
    const result = await aiEdit({ projectPath: folder(), imagePath: source(), prompt: 'Faithfully restore this supplied image.', imageSize: '1K', model: 'qwen-image-3.0' }, 'qwen-key', async (url, init) => {
      calls.push(String(url))
      if (String(url).includes('dashscope')) {
        const body = JSON.parse(String(init?.body)) as { model: string; parameters: { watermark: boolean; size: string }; input: { messages: Array<{ content: Array<{ image?: string; text?: string }> }> } }
        expect(body.model).toBe('qwen-image-3.0')
        // The watermark defaults on at DashScope and would deface every result.
        expect(body.parameters.watermark).toBe(false)
        expect(body.parameters.size).toBe('1024*1024')
        expect(body.input.messages[0].content[0].image).toMatch(/^data:image\/png;base64,/)
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer qwen-key')
        return new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ image: 'https://example.test/result.png' }] } }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(image, { status: 200, headers: { 'content-type': 'image/png' } })
    })
    expect(calls[0]).toContain('dashscope')
    expect(calls[1]).toBe('https://example.test/result.png')
    expect(result.model).toBe('qwen-image-3.0')
    expect(result.width).toBe(24)
  })

  it('reports a Qwen failure as a Qwen failure, not a network problem', async () => {
    await expect(aiEdit({ projectPath: folder(), imagePath: source(), prompt: 'Faithfully restore this supplied image.', imageSize: '1K', model: 'qwen-image-3.0' }, 'qwen-key',
      async () => new Response(JSON.stringify({ message: 'InvalidApiKey' }), { status: 401, headers: { 'content-type': 'application/json' } })))
      .rejects.toThrow('Qwen API: InvalidApiKey')
  })

  it('says so when Qwen returns a URL that cannot be fetched', async () => {
    await expect(aiEdit({ projectPath: folder(), imagePath: source(), prompt: 'Faithfully restore this supplied image.', imageSize: '1K', model: 'qwen-image-3.0' }, 'qwen-key',
      async (url) => String(url).includes('dashscope')
        ? new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ image: 'https://example.test/gone.png' }] } }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('', { status: 404 })))
      .rejects.toThrow('could not be downloaded')
  })
})
