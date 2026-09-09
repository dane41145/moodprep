import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { convertSvgs, svgRenderDensity } from './processor'

// The reported failure: SVG intake had been throwing `Input image exceeds pixel
// limit` on every file since August. `convertSvgs` rendered at a hardcoded
// density of 600, which is a resolution for the drawing's own stated size and
// not an output size, so a seal declared at 535 mm asked librsvg for a raster of
// about 158 gigapixels. Every one of the eight SVGs in the user's collection
// threw, went onto `failed`, stayed on disk as .svg, and was retried and failed
// again on the next launch. These fixtures are modelled on the real files:
// physical units (mm, pt) over a large viewBox, which is what a vector exported
// from Illustrator, Inkscape or potrace looks like.

const TARGET = 2048
const OLD_HARDCODED_DENSITY = 600

let folders: string[] = []

afterEach(async () => {
  for (const folder of folders) {
    if (folder.startsWith(os.tmpdir())) await fs.rm(folder, { recursive: true, force: true })
  }
  folders = []
})

async function folderWith(files: Record<string, string>) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'moodprep-svg-test-'))
  folders.push(folder)
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(folder, name), body)
  return folder
}

// Seal_of_the_President_of_the_Philippines.svg is 535.35 mm square over a
// matching viewBox — 1518 px at the default density, and the worst of the eight.
function millimetreSeal(millimetres: number, units: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${millimetres}mm" height="${millimetres}mm" viewBox="0 0 ${units} ${units}">`
    + `<rect width="${units}" height="${units}" fill="#f5f1e8"/>`
    + `<circle cx="${units / 2}" cy="${units / 2}" r="${units * 0.44}" fill="none" stroke="#1c3f94" stroke-width="${units * 0.02}"/>`
    + `<circle cx="${units / 2}" cy="${units / 2}" r="${units * 0.2}" fill="#c8102e"/>`
    + `</svg>`
}

// 02_vba_logo_rot_anthrazit_svg.svg is 795 x 473 pt, a potrace export.
function pointLogo(width: number, height: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}pt" height="${height}pt" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" fill="#ffffff"/>`
    + `<rect x="${width * 0.1}" y="${height * 0.2}" width="${width * 0.8}" height="${height * 0.6}" fill="#3d3d3b"/>`
    + `</svg>`
}

async function size(file: string) {
  const { width, height } = await sharp(file).metadata()
  return { width, height }
}

describe('converting SVG sources during intake', () => {
  it('converts a large-viewBox SVG that the old fixed density could not render at all', async () => {
    const folder = await folderWith({ 'seal.svg': millimetreSeal(535.35, 535.35) })
    const source = path.join(folder, 'seal.svg')
    const original = await fs.readFile(source)

    // State the defect: the density this used to be pinned at still cannot
    // render this file, so the test would pass for the wrong reason if the
    // fixture were merely small.
    await expect(
      sharp(source, { density: OLD_HARDCODED_DENSITY, failOn: 'none' })
        .resize({ width: TARGET, height: TARGET, fit: 'inside', withoutEnlargement: false })
        .png()
        .toBuffer(),
    ).rejects.toThrow(/pixel limit/i)

    const result = await convertSvgs(folder, false)
    expect(result.failed).toEqual([])
    expect(result.convertedCount).toBe(1)
    expect(await size(path.join(folder, 'seal.png'))).toEqual({ width: TARGET, height: TARGET })
    // The recorded behaviour either side of the render is untouched: the source
    // leaves the working folder and is preserved byte for byte.
    await expect(fs.access(source)).rejects.toThrow()
    expect(await fs.readFile(path.join(result.backupFolder, 'seal.svg'))).toEqual(original)
  })

  it('converts every shape of declared size, not only the one that was measured', async () => {
    const folder = await folderWith({
      // Physical units: the raster grows with the SQUARE of the density.
      'seal.svg': millimetreSeal(535.35, 535.35),
      'small-seal.svg': millimetreSeal(96.85, 96.72),
      'logo.svg': pointLogo(795, 473),
      // Unitless: the raster grows linearly with it, needing a density an order
      // of magnitude higher for the same output.
      'unitless.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#df4a34"/></svg>',
      // A viewBox alone, already past the target: nothing to scale up.
      'wide.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4000 3000"><rect width="4000" height="3000" fill="#181713"/></svg>',
    })

    const result = await convertSvgs(folder, false)
    expect(result.failed).toEqual([])
    expect(result.convertedCount).toBe(5)
    for (const name of ['seal', 'small-seal', 'logo', 'unitless', 'wide']) {
      const { width, height } = await size(path.join(folder, `${name}.png`))
      expect(Math.max(width ?? 0, height ?? 0), name).toBe(TARGET)
    }
  })

  it('renders the raster at the size actually wanted, whatever the units', async () => {
    // A 2048 px PNG can be produced from any raster at all — the resize will
    // enlarge a 275 px one to fit — so the output size alone does not say the
    // density was chosen well. What matters is the raster behind it: at or just
    // over the target, so the PNG is a downscale rather than a soft enlargement,
    // and a few megapixels rather than the hundreds a fixed density asked for.
    // These four want densities from 72 to 737, which is why no constant works.
    const folder = await folderWith({
      'seal.svg': millimetreSeal(535.35, 535.35),
      'small-seal.svg': millimetreSeal(96.85, 96.72),
      'logo.svg': pointLogo(795, 473),
      'unitless.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#df4a34"/></svg>',
    })
    for (const name of ['seal', 'small-seal', 'logo', 'unitless']) {
      const file = path.join(folder, `${name}.svg`)
      const density = await svgRenderDensity(file)
      const { width, height } = await sharp(file, { density, failOn: 'none' }).metadata()
      const longest = Math.max(width ?? 0, height ?? 0)
      expect(longest, `${name} raster is not under the target`).toBeGreaterThanOrEqual(TARGET)
      expect(longest, `${name} raster overshoots the target`).toBeLessThan(TARGET * 1.5)
      expect((width ?? 0) * (height ?? 0), `${name} raster is not a sane size`).toBeLessThan(20_000_000)
    }
  })

  it('leaves a drawing already past the target at the default density', async () => {
    // Nothing to gain by rendering a 4000 px viewBox larger still just to throw
    // the extra away in the resize.
    const folder = await folderWith({
      'wide.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4000 3000"><rect width="4000" height="3000" fill="#181713"/></svg>',
    })
    expect(await svgRenderDensity(path.join(folder, 'wide.svg'))).toBe(72)
  })

  it('leaves a source it cannot render on disk and reports why', async () => {
    const folder = await folderWith({ 'broken.svg': 'this is not markup at all' })
    const result = await convertSvgs(folder, false)
    expect(result.convertedCount).toBe(0)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].path).toBe(path.join(folder, 'broken.svg'))
    expect(result.failed[0].reason).toBeTruthy()
    // Refusing is recoverable, so the file stays where it is and nothing is
    // left half-moved into the backup folder.
    await expect(fs.access(path.join(folder, 'broken.svg'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(result.backupFolder, 'broken.svg'))).rejects.toThrow()
  })
})
