import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { KNOWN_CLEAN_WATERMARK_FILENAMES } from '../shared/types'
import { colourShifts, hueShiftTable, shiftPixels } from '../shared/recolour'
import { parseHex, swapBackdrop } from '../shared/backdrop'
import { recompositeFringe } from '../shared/fringe'
import { mapToPalette } from '../shared/palette'
import { qualityLabel } from '../shared/quality'
import { DEFAULT_QWEN_REGION, modelById, needsQwenWorkspace, PROMPT_AUTHOR_MODEL, qwenEndpoint, qwenRegionLabel, type AiProvider, type QwenRegion } from '../shared/models'
import type {
  AuthoredPromptRequest,
  AuthoredPromptResult,
  BackgroundColorResult,
  PaletteAnalysisResult,
  ConnectionResult,
  ExportEntry,
  ExportResult,
  GeminiRequest,
  GeminiResult,
  ImageRecord,
  IssueType,
  FillRequest,
  ProcessRequest,
  ProcessResult,
  ProjectState,
  RotationDetectionResult,
  ScanResult,
} from '../shared/types'

export type NetworkFetch = (input: string, init?: RequestInit) => Promise<Response>

const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.webp', '.svg'])
const BACKUP_DIRECTORY = 'moodprep-originals'
// Intake renders an SVG to a 2048 px PNG. SVG_BASE_DENSITY is sharp's own
// default and the baseline the natural size is read at; SVG_MAX_DENSITY only
// ever binds for a drawing under about 60 px, where it still reaches the
// target, and is there to bound a file whose size scales in some way
// `svgRenderDensity` has not measured before.
const SVG_TARGET_PIXELS = 2048
const SVG_BASE_DENSITY = 72
const SVG_MAX_DENSITY = 2400
const IGNORED_DIRECTORIES = new Set(['.moodprep', BACKUP_DIRECTORY, 'moodboard-ready', 'moodprep-app', 'node_modules', '.git'])

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

const KNOWN_REVIEW_EXAMPLES: Record<string, IssueType[]> = {
  'c7c88becbd9c40b6c3b683953299d157.jpg': ['watermark'],
  '8990bc780dd308b577129313f9398b53.jpg': ['watermark'],
  '7e6e77de6f05bc2910f7f37af4d32b33.jpg': ['texture'],
  'ca58596ff822025c92fa349bf0a7e681.jpg': ['texture'],
  'dd16275e46d0fbbdd7ad6ae37ee63b35.jpg': ['background'],
  'department_of_medical_sciences_logo.webp': ['low_quality'],
  'f38d7d685d8adecd1b432505fbad0b7c.jpg': ['low_quality'],
  'e850ec3ad487a0cbfe81bb5ed475e1cf.jpg': ['perspective'],
  'fbc99854a92524ef7f4313299adec755.jpg': ['perspective'],
  'fbc2234645a65025a76f6276b4761b44.jpg': ['background', 'low_quality'],
  '0e5547aa20188a1b5a49ca1d35d47690.jpg': ['background', 'low_quality', 'perspective'],
  '9d19045fcba719941220813d03a88e6c.jpg': ['border', 'crop'],
  'a1de2d9876338ef712ecb5558e5ae057.jpg': ['border', 'background'],
  '9c950878d4857bcb1bff8d742333232a.jpg': ['crop', 'off_center'],
  'bb60a32985cc12d02136774fe7d44145.jpg': ['border', 'low_quality'],
}

function safeStem(filename: string) {
  return path.basename(filename, path.extname(filename)).replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 100)
}

function dataUrl(mimeType: string, buffer: Buffer) {
  return `data:${mimeType};base64,${buffer.toString('base64')}`
}

async function collectFiles(root: string, recursive: boolean) {
  const files: string[] = []
  let ignoredFiles = 0

  async function visit(folder: string, depth: number) {
    const entries = await fs.readdir(folder, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.svg') {
        if (entry.isFile()) ignoredFiles += 1
        continue
      }
      const fullPath = path.join(folder, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue
        if (recursive && depth < 12) await visit(fullPath, depth + 1)
        continue
      }
      if (entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase())) files.push(fullPath)
      else if (entry.isFile()) ignoredFiles += 1
    }
  }

  await visit(root, 0)
  return { files, ignoredFiles }
}

function assertPathInside(root: string, target: string, label: string) {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside the selected image folder.`)
  }
  return { resolvedTarget, relative }
}

async function unusedPath(desiredPath: string) {
  const extension = path.extname(desiredPath)
  const stem = path.basename(desiredPath, extension)
  const folder = path.dirname(desiredPath)
  let candidate = desiredPath
  let number = 2
  while (true) {
    try {
      await fs.access(candidate)
      candidate = path.join(folder, `${stem}-${number}${extension}`)
      number += 1
    } catch {
      return candidate
    }
  }
}

async function backupDestination(root: string, relativeSource: string) {
  const desired = path.join(root, BACKUP_DIRECTORY, relativeSource)
  await fs.mkdir(path.dirname(desired), { recursive: true })
  return unusedPath(desired)
}

// The density that renders one SVG at about SVG_TARGET_PIXELS on its longest
// side. A fixed density cannot do this job, because a density is a resolution
// for the file's own stated size rather than an output size: the hardcoded 600
// that stood here until 2026-09-06 rasterised every SVG in this collection past
// sharp's input pixel limit, so all eight threw `Input image exceeds pixel
// limit`, were pushed onto `failed`, left on disk as .svg, and retried and
// failed again on the next launch — intake had been silently broken since
// August. The 500 mm Philippines seal wanted 158 gigapixels; the smallest file
// here, a 210 mm logo, still wanted 3.2.
//
// How the raster responds to the density is a property of the file, so it is
// measured rather than assumed. librsvg resolves a width given in physical
// units (mm, pt, cm, in) through the density, and libvips then scales that
// render by density/72 on top, so those files grow with the SQUARE of the
// density, while a unitless, px or percentage width grows linearly with it —
// on this collection that is the difference between a density of 84 and one of
// 7000. Reading the size at the default density and again at twice it gives the
// exponent, and the density that lands the longest side on the target follows
// from it. Both reads are safe: the second only happens for a file smaller than
// the target, which caps it at four times a sub-2048 side, well inside the
// limit that the old constant blew through.
export async function svgRenderDensity(svgPath: string) {
  const longestSideAt = async (density: number) => {
    const metadata = await sharp(svgPath, { density, failOn: 'none' }).metadata()
    return Math.max(metadata.width ?? 0, metadata.height ?? 0)
  }
  const natural = await longestSideAt(SVG_BASE_DENSITY)
  // Already large enough, or a size that cannot be read: the resize does the rest.
  if (!natural || natural >= SVG_TARGET_PIXELS) return SVG_BASE_DENSITY
  const doubled = await longestSideAt(SVG_BASE_DENSITY * 2)
  // A size that does not answer to the density has nothing to solve for.
  if (doubled <= natural) return SVG_BASE_DENSITY
  const exponent = Math.log(doubled / natural) / Math.log(2)
  const wanted = SVG_BASE_DENSITY * (SVG_TARGET_PIXELS / natural) ** (1 / exponent)
  // Round up rather than to nearest, so the raster lands on or just over the
  // target and is downscaled into place instead of being enlarged from under it.
  return Math.min(SVG_MAX_DENSITY, Math.max(SVG_BASE_DENSITY, Math.ceil(wanted)))
}

export async function convertSvgs(folder: string, recursive: boolean) {
  const root = path.resolve(folder)
  const collected = await collectFiles(root, recursive)
  const svgPaths = collected.files.filter((filename) => path.extname(filename).toLowerCase() === '.svg')
  let convertedCount = 0
  const failed: Array<{ path: string; reason: string }> = []
  for (const svgPath of svgPaths) {
    let temporaryPath = ''
    let backupPath = ''
    try {
      const { relative } = assertPathInside(root, svgPath, 'SVG source')
      const density = await svgRenderDensity(svgPath)
      const rendered = await sharp(svgPath, { density, failOn: 'none' })
        .resize({ width: SVG_TARGET_PIXELS, height: SVG_TARGET_PIXELS, fit: 'inside', withoutEnlargement: false })
        .png({ compressionLevel: 8 })
        .toBuffer()
      const desiredPng = path.join(path.dirname(svgPath), `${path.basename(svgPath, path.extname(svgPath))}.png`)
      const outputPath = await unusedPath(desiredPng)
      temporaryPath = `${outputPath}.moodprep-${process.pid}.tmp`
      await fs.writeFile(temporaryPath, rendered)
      backupPath = await backupDestination(root, relative)
      await fs.rename(svgPath, backupPath)
      try {
        await fs.rename(temporaryPath, outputPath)
      } catch (error) {
        await fs.rename(backupPath, svgPath)
        throw error
      }
      convertedCount += 1
    } catch (error) {
      if (temporaryPath) await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
      failed.push({ path: svgPath, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { convertedCount, backupFolder: path.join(root, BACKUP_DIRECTORY), failed }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

async function perceptualHash(imagePath: string) {
  try {
    const pixels = await sharp(imagePath, { density: 180, failOn: 'none' })
      .rotate()
      .greyscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer()
    let bits = 0n
    let bit = 0n
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        if (pixels[y * 9 + x] > pixels[y * 9 + x + 1]) bits |= 1n << bit
        bit += 1n
      }
    }
    return bits.toString(16).padStart(16, '0')
  } catch {
    return null
  }
}

async function visualSignals(imagePath: string, width: number, height: number, bytes: number) {
  let detailScore = 0
  let borderLikely = false
  let watermarkLikely = false
  let edgeCrispness = 0
  let edgeDensity = 0
  let cleanlinessScore = 0
  let graphicConfidence = 0
  try {
    const { data, info } = await sharp(imagePath, { density: 180, failOn: 'none' })
      .rotate()
      .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const sampleWidth = info.width
    const sampleHeight = info.height
    const channels = info.channels
    const luminance = new Float32Array(sampleWidth * sampleHeight)
    const colourBins = new Map<number, number>()
    for (let index = 0; index < sampleWidth * sampleHeight; index += 1) {
      const offset = index * channels
      const red = data[offset]
      const green = data[offset + 1]
      const blue = data[offset + 2]
      luminance[index] = red * 0.2126 + green * 0.7152 + blue * 0.0722
      const colourBin = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4)
      colourBins.set(colourBin, (colourBins.get(colourBin) ?? 0) + 1)
    }

    let visibleEdges = 0
    let crispEdges = 0
    let flatPixels = 0
    let flatVariation = 0
    let sampledPixels = 0
    let edgeStrength = 0
    for (let y = 1; y < sampleHeight - 1; y += 1) {
      for (let x = 1; x < sampleWidth - 1; x += 1) {
        const index = y * sampleWidth + x
        const horizontal = Math.abs(luminance[index + 1] - luminance[index - 1]) / 2
        const vertical = Math.abs(luminance[index + sampleWidth] - luminance[index - sampleWidth]) / 2
        const gradient = Math.hypot(horizontal, vertical)
        sampledPixels += 1
        if (gradient > 5) {
          visibleEdges += 1
          edgeStrength += gradient
        }
        if (gradient > 30) crispEdges += 1
        if (gradient < 3) {
          flatPixels += 1
          flatVariation += Math.abs(luminance[index + 1] - luminance[index])
            + Math.abs(luminance[index + sampleWidth] - luminance[index])
        }
      }
    }
    edgeDensity = visibleEdges / Math.max(sampledPixels, 1)
    edgeCrispness = crispEdges / Math.max(visibleEdges, 1)
    const averageEdgeStrength = edgeStrength / Math.max(visibleEdges, 1)
    const flatNoise = flatVariation / Math.max(flatPixels, 1)

    const colourCounts = [...colourBins.values()].sort((a, b) => b - a)
    const sampleArea = sampleWidth * sampleHeight
    const coverage = (count: number) => colourCounts.slice(0, count).reduce((sum, value) => sum + value, 0) / Math.max(sampleArea, 1)
    const topEightCoverage = coverage(8)
    const topSixteenCoverage = coverage(16)
    const clampScore = (value: number) => Math.max(0, Math.min(100, value))
    graphicConfidence = Math.max(0, Math.min(1, (topSixteenCoverage - 0.58) / 0.32))
    const graphicSharpness = clampScore(((edgeCrispness - 0.28) / 0.42) * 100)
    const naturalSharpness = clampScore(((averageEdgeStrength - 12) / 42) * 100)
    const sharpnessScore = graphicSharpness * graphicConfidence + naturalSharpness * (1 - graphicConfidence)
    const paletteCleanliness = clampScore(((topEightCoverage - 0.65) / 0.30) * 100)
    const flatCleanliness = clampScore(((2.2 - flatNoise) / 1.9) * 100)
    let graphicCleanliness = paletteCleanliness * 0.65 + flatCleanliness * 0.35
    if (edgeDensity > 0.23) graphicCleanliness -= Math.min(18, ((edgeDensity - 0.23) / 0.17) * 18)
    cleanlinessScore = clampScore(graphicCleanliness * graphicConfidence + 80 * (1 - graphicConfidence))
    detailScore = Math.round(sharpnessScore * 0.5 + cleanlinessScore * 0.5)

    const lineStats = (positions: number[][]) => {
      const values: number[] = []
      for (const [x, y] of positions) {
        const offset = (y * sampleWidth + x) * channels
        values.push((data[offset] + data[offset + 1] + data[offset + 2]) / 3)
      }
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
      return { mean, variance }
    }
    const horizontalInset = Math.min(sampleWidth - 1, Math.max(1, Math.round(sampleWidth * 0.06)))
    const verticalInset = Math.min(sampleHeight - 1, Math.max(1, Math.round(sampleHeight * 0.06)))
    const top = lineStats(Array.from({ length: sampleWidth }, (_, x) => [x, 0]))
    const topInner = lineStats(Array.from({ length: sampleWidth }, (_, x) => [x, verticalInset]))
    const bottom = lineStats(Array.from({ length: sampleWidth }, (_, x) => [x, sampleHeight - 1]))
    const bottomInner = lineStats(Array.from({ length: sampleWidth }, (_, x) => [x, sampleHeight - 1 - verticalInset]))
    const left = lineStats(Array.from({ length: sampleHeight }, (_, y) => [0, y]))
    const leftInner = lineStats(Array.from({ length: sampleHeight }, (_, y) => [horizontalInset, y]))
    const right = lineStats(Array.from({ length: sampleHeight }, (_, y) => [sampleWidth - 1, y]))
    const rightInner = lineStats(Array.from({ length: sampleHeight }, (_, y) => [sampleWidth - 1 - horizontalInset, y]))
    borderLikely = [
      [top, topInner],
      [bottom, bottomInner],
      [left, leftInner],
      [right, rightInner],
    ].some(([edge, inner]) => edge.variance < 90 && Math.abs(edge.mean - inner.mean) > 22)

    const rowSignals = Array.from({ length: sampleHeight }, (_, y) => {
      let dark = 0
      let brightNeutral = 0
      for (let x = 0; x < sampleWidth; x += 1) {
        const offset = (y * sampleWidth + x) * channels
        const red = data[offset]
        const green = data[offset + 1]
        const blue = data[offset + 2]
        const lightness = luminance[y * sampleWidth + x]
        if (lightness < 175) dark += 1
        if (lightness > 238 && Math.max(red, green, blue) - Math.min(red, green, blue) < 12) brightNeutral += 1
      }
      return { dark: dark / sampleWidth, brightNeutral: brightNeutral / sampleWidth }
    })
    const captionStart = Math.floor(sampleHeight * 0.88)
    let clusterStart = -1
    for (let y = captionStart; y <= sampleHeight; y += 1) {
      const signal = rowSignals[y]
      const captionInk = signal && signal.dark >= 0.025 && signal.dark <= 0.35 && signal.brightNeutral >= 0.55
      if (captionInk && clusterStart < 0) clusterStart = y
      const clusterEnded = clusterStart >= 0 && (!captionInk || y === sampleHeight)
      if (!clusterEnded) continue
      const clusterLength = y - clusterStart
      const gap = rowSignals.slice(Math.max(captionStart - 8, clusterStart - 8), clusterStart)
      const clearGapRows = gap.filter((row) => row.dark < 0.01 && row.brightNeutral > 0.82).length
      const sitsAtExtremeBottom = clusterStart >= Math.floor(sampleHeight * 0.94)
      if (clusterLength >= 2 && clusterLength <= 4 && clearGapRows >= 2 && sitsAtExtremeBottom) watermarkLikely = true
      clusterStart = -1
    }
  } catch {
    detailScore = 0
  }

  const megapixels = (width * height) / 1_000_000
  const shortEdge = Math.min(width, height)
  const resolutionScore = Math.max(15, Math.min(100, 30 + Math.log2(Math.max(shortEdge, 64) / 128) * 18))
  const bytesPerPixel = width * height > 0 ? bytes / (width * height) : 0
  const compressionPenalty = bytesPerPixel > 0 && bytesPerPixel < 0.04 ? 12 : bytesPerPixel > 0 && bytesPerPixel < 0.07 ? 6 : 0
  const fidelityScore = detailScore
  const score = Math.max(0, Math.min(100, Math.round(resolutionScore * 0.30 + fidelityScore * 0.70 - compressionPenalty)))
  const reasons: string[] = []
  if (shortEdge < 512) reasons.push(`Short edge is only ${shortEdge} px`)
  if (megapixels < 0.4) reasons.push(`${megapixels.toFixed(2)} megapixels`)
  if (compressionPenalty) reasons.push('Very small data size for its dimensions')
  if (graphicConfidence > 0.55 && edgeCrispness < 0.60) reasons.push('Soft, spread, or ghosted edges')
  if (graphicConfidence > 0.55 && cleanlinessScore < 65) reasons.push('Colour bleed or uneven flat areas')
  if (reasons.length === 0) reasons.push(`${megapixels.toFixed(1)} MP with crisp edges and clean colour`)
  const label = qualityLabel(score)
  return { quality: { score, label, detailScore, reasons } as const, borderLikely, watermarkLikely }
}

export async function analyzeImageQuality(imagePath: string) {
  const [metadata, stat] = await Promise.all([
    sharp(imagePath, { density: 180, failOn: 'none' }).rotate().metadata(),
    fs.stat(imagePath),
  ])
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  const signals = await visualSignals(imagePath, width, height, stat.size)
  return { width, height, bytes: stat.size, quality: signals.quality }
}

export async function loadEditorPreview(imagePath: string) {
  const preview = await sharp(imagePath, { density: 240, failOn: 'none' })
    .rotate()
    .resize(3200, 3200, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#f4f1ea' })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer()
  return { dataUrl: dataUrl('image/jpeg', preview) }
}

async function hasProcessedBackup(root: string, imagePath: string) {
  const relative = path.relative(root, imagePath)
  const filename = path.basename(relative)
  const extension = path.extname(filename)
  const stem = path.basename(filename, extension)
  const backupFolder = path.join(root, BACKUP_DIRECTORY, path.dirname(relative))
  try {
    const entries = await fs.readdir(backupFolder)
    return entries.some((entry) => {
      if (entry === filename) return true
      if (path.extname(entry).toLowerCase() !== extension.toLowerCase()) return false
      const entryStem = path.basename(entry, path.extname(entry))
      return entryStem.startsWith(`${stem}-`) && /^\d+$/.test(entryStem.slice(stem.length + 1))
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function fileTimestamp(value: Date | undefined, fallback?: Date): string {
  const time = value?.getTime()
  if (time && Number.isFinite(time) && time > 0) return value!.toISOString()
  const fallbackTime = fallback?.getTime()
  if (fallbackTime && Number.isFinite(fallbackTime) && fallbackTime > 0) return fallback!.toISOString()
  return new Date(0).toISOString()
}

// Every field of an ImageRecord is derived from the bytes of one file, and
// deriving them costs about four sharp decodes — a thumbnail, a perceptual
// hash, the quality signals and the rotation estimate. Measured on this
// collection that is 35 ms an image, so a folder of 1354 spent 48 seconds on
// every launch re-deriving results that had not changed. The scan therefore
// keeps what it worked out last time and only re-inspects a file whose size or
// modification time has moved.
//
// The version is part of the key. Anything that changes what `inspectImage`
// returns — a new signal, a different quality formula, another suggested issue
// — must bump it, or the collection keeps showing scores from the old rule.
const SCAN_CACHE_VERSION = 2

type ScanCacheEntry = { size: number; mtimeMs: number; record: ImageRecord }
type ScanCacheFile = { version: number; entries: Record<string, ScanCacheEntry> }

function scanCachePath(root: string) {
  return path.join(root, '.moodprep', 'scan-cache.json')
}

async function readScanCache(root: string): Promise<Map<string, ScanCacheEntry>> {
  try {
    const contents = await fs.readFile(scanCachePath(root), 'utf8')
    const parsed = JSON.parse(contents) as ScanCacheFile
    if (parsed.version !== SCAN_CACHE_VERSION || !parsed.entries) return new Map()
    return new Map(Object.entries(parsed.entries))
  } catch {
    // A missing, truncated or hand-edited cache is not an error: it only means
    // this scan does the work the last one would have saved.
    return new Map()
  }
}

async function writeScanCache(root: string, entries: Map<string, ScanCacheEntry>) {
  try {
    const directory = path.join(root, '.moodprep')
    await fs.mkdir(directory, { recursive: true })
    const destination = scanCachePath(root)
    const temporary = destination + '.tmp'
    const payload: ScanCacheFile = { version: SCAN_CACHE_VERSION, entries: Object.fromEntries(entries) }
    await fs.writeFile(temporary, JSON.stringify(payload))
    await fs.rename(temporary, destination)
  } catch {
    // A read-only folder or a full disk costs the next scan its head start and
    // nothing else, so it must never fail the scan itself.
  }
}

async function inspectImage(root: string, imagePath: string): Promise<ImageRecord> {
  const extension = path.extname(imagePath).toLowerCase()
  const [stat, fileBuffer] = await Promise.all([fs.stat(imagePath), fs.readFile(imagePath)])
  const exactHash = createHash('sha256').update(fileBuffer).digest('hex')
  const pipeline = sharp(fileBuffer, { density: 240, failOn: 'none' }).rotate()
  const metadata = await pipeline.metadata()
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  const [thumbnail, pHash, signals, processed, rotationSuggestion] = await Promise.all([
    pipeline
      .clone()
      .resize(300, 210, { fit: 'contain', background: '#f4f1ea', withoutEnlargement: true })
      .flatten({ background: '#f4f1ea' })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer(),
    perceptualHash(imagePath),
    visualSignals(imagePath, width, height, stat.size),
    hasProcessedBackup(root, imagePath),
    detectRotation(imagePath).catch(() => ({ rotation: 0, confidence: 0 })),
  ])
  const suggestedIssues: IssueType[] = []
  if (Math.min(width, height) < 512 || width * height < 400_000) suggestedIssues.push('low_quality')
  if (signals.borderLikely) suggestedIssues.push('border')
  if (rotationSuggestion.rotation !== 0) suggestedIssues.push('rotation_needed')
  if (signals.watermarkLikely && !KNOWN_CLEAN_WATERMARK_FILENAMES.has(path.basename(imagePath).toLowerCase())) suggestedIssues.push('watermark')
  for (const issue of KNOWN_REVIEW_EXAMPLES[path.basename(imagePath).toLowerCase()] ?? []) {
    if (!suggestedIssues.includes(issue)) suggestedIssues.push(issue)
  }
  return {
    id: exactHash.slice(0, 16) + '-' + createHash('sha1').update(imagePath).digest('hex').slice(0, 8),
    path: imagePath,
    name: path.basename(imagePath),
    extension: extension.slice(1),
    mimeType: MIME_TYPES[extension] ?? 'application/octet-stream',
    width,
    height,
    bytes: stat.size,
    exactHash,
    perceptualHash: pHash,
    modifiedAt: fileTimestamp(stat.mtime),
    // Filesystems that do not record a creation time report an epoch or
    // zeroed birthtime; fall back to the modification time rather than
    // sorting those files as if they arrived in 1970.
    addedAt: fileTimestamp(stat.birthtime, stat.mtime),
    thumbnailDataUrl: dataUrl('image/jpeg', thumbnail),
    quality: signals.quality,
    suggestedIssues,
    processed,
  }
}

export async function scanFolder(folder: string, recursive: boolean): Promise<ScanResult> {
  const root = path.resolve(folder)
  const stat = await fs.stat(root)
  if (!stat.isDirectory()) throw new Error('The selected path is not a folder.')
  const collected = await collectFiles(root, recursive)
  const cache = await readScanCache(root)
  const fresh = new Map<string, ScanCacheEntry>()
  let analysed = 0
  const inspected = await mapLimit(collected.files, 5, async (imagePath) => {
    try {
      const stat = await fs.stat(imagePath)
      const cached = cache.get(imagePath)
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        fresh.set(imagePath, cached)
        // Whether a file has a backup depends on the originals folder rather
        // than on the file, so it is re-read — it costs a directory listing,
        // not a decode, and it is what marks a card as processed.
        return { ...cached.record, processed: await hasProcessedBackup(root, imagePath) }
      }
      const record = await inspectImage(root, imagePath)
      analysed += 1
      fresh.set(imagePath, { size: stat.size, mtimeMs: stat.mtimeMs, record })
      return record
    } catch {
      return null
    }
  })
  const images = inspected.filter((image): image is ImageRecord => image !== null)
  // Writing 1354 records back costs more than the scan saved when nothing has
  // changed, so it only happens when the cache would actually be different.
  if (analysed > 0 || fresh.size !== cache.size) await writeScanCache(root, fresh)
  return {
    folder: root,
    images,
    scannedAt: new Date().toISOString(),
    ignoredFiles: collected.ignoredFiles + inspected.length - images.length,
    analysed,
    reused: images.length - analysed,
  }
}

// Makes a working copy of an image so the same source can be taken in two
// directions — a different crop each, for instance. The copy is a sibling in
// the same folder with a " copy" suffix, which reads naturally and avoids the
// "(1)" pattern the duplicate review treats as an accidental numbered copy.
export async function duplicateImage(folder: string, imagePath: string) {
  const root = path.resolve(folder)
  const resolved = path.resolve(imagePath)
  const relative = path.relative(root, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The image was outside the selected folder.')
  if (relative.startsWith(`${BACKUP_DIRECTORY}${path.sep}`)) throw new Error('Refusing to duplicate a file inside the originals folder.')
  const extension = path.extname(resolved)
  const stem = path.basename(resolved, extension)
  const target = await unusedPath(path.join(path.dirname(resolved), `${stem} copy${extension}`))
  await fs.copyFile(resolved, target)
  return inspectImage(root, target)
}

export async function refreshImage(folder: string, imagePath: string) {
  const root = path.resolve(folder)
  const resolved = path.resolve(imagePath)
  const relative = path.relative(root, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The image was outside the selected folder.')
  return inspectImage(root, resolved)
}

export async function loadProject(folder: string): Promise<ProjectState | null> {
  try {
    const contents = await fs.readFile(path.join(folder, '.moodprep', 'project.json'), 'utf8')
    return JSON.parse(contents) as ProjectState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function saveProject(state: ProjectState) {
  const projectDirectory = path.join(state.folder, '.moodprep')
  await fs.mkdir(projectDirectory, { recursive: true })
  const destination = path.join(projectDirectory, 'project.json')
  const temporary = destination + '.tmp'
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8')
  await fs.rename(temporary, destination)
}

function validateColor(color: string) {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : '#ffffff'
}

function parseHexColor(color: string) {
  const value = validateColor(color).slice(1)
  return {
    red: parseInt(value.slice(0, 2), 16),
    green: parseInt(value.slice(2, 4), 16),
    blue: parseInt(value.slice(4, 6), 16),
  }
}

export async function detectBackgroundColor(imagePath: string) {
  const { data, info } = await sharp(imagePath, { density: 180, failOn: 'none' })
    .rotate()
    .resize(160, 160, { fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .blur(1.4)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const buckets = new Map<number, { count: number; red: number; green: number; blue: number }>()
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const red = data[offset]
    const green = data[offset + 1]
    const blue = data[offset + 2]
    const key = (red >> 5) << 6 | (green >> 5) << 3 | (blue >> 5)
    const bucket = buckets.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 }
    bucket.count += 1
    bucket.red += red
    bucket.green += green
    bucket.blue += blue
    buckets.set(key, bucket)
  }
  const dominant = [...buckets.values()].sort((left, right) => right.count - left.count)[0]
  if (!dominant?.count) return { color: '#ffffff' }
  const channel = (value: number) => Math.round(value / dominant.count).toString(16).padStart(2, '0')
  return { color: `#${channel(dominant.red)}${channel(dominant.green)}${channel(dominant.blue)}` }
}

// Suggests the rotation that levels the artwork. Works by projection-profile
// deskew: strong edge points are rotated by each candidate angle and scored by
// how sharply their row and column projections concentrate, which peaks when
// text baselines, banners, or an elongated subject sit level. This survives
// round coasters, badges, and curved ornaments where straight edges are scarce.
// The candidate angle is applied exactly like the manual tool (sharp/CSS
// clockwise-positive rotation), so the best-scoring angle is the suggestion.
// Deliberately deterministic: no API call, like detectBackgroundColor.
const ROTATION_LIMIT = 10

type EdgePoints = { xs: Float64Array; ys: Float64Array; weights: Float64Array; count: number }

function collectEdgePoints(data: Uint8Array | Buffer, width: number, height: number): EdgePoints {
  const centerX = width / 2
  const centerY = height / 2
  const xs = new Float64Array(width * height)
  const ys = new Float64Array(width * height)
  const weights = new Float64Array(width * height)
  let magnitudeSum = 0
  let count = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x
      const gradientX = (data[index - width + 1] + 2 * data[index + 1] + data[index + width + 1])
        - (data[index - width - 1] + 2 * data[index - 1] + data[index + width - 1])
      const gradientY = (data[index + width - 1] + 2 * data[index + width] + data[index + width + 1])
        - (data[index - width - 1] + 2 * data[index - width] + data[index - width + 1])
      const magnitude = Math.hypot(gradientX, gradientY)
      if (magnitude < 1) continue
      xs[count] = x - centerX
      ys[count] = y - centerY
      weights[count] = magnitude
      magnitudeSum += magnitude
      count += 1
    }
  }
  const strongThreshold = count ? (magnitudeSum / count) * 1.5 : 0
  let kept = 0
  for (let index = 0; index < count; index += 1) {
    if (weights[index] < strongThreshold) continue
    xs[kept] = xs[index]
    ys[kept] = ys[index]
    weights[kept] = weights[index]
    kept += 1
  }
  return { xs, ys, weights, count: kept }
}

function projectionSharpness(points: EdgePoints, degrees: number, binSize: number, binCount: number) {
  const radians = (degrees * Math.PI) / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const half = binCount / 2
  const rows = new Float64Array(binCount)
  const columns = new Float64Array(binCount)
  for (let index = 0; index < points.count; index += 1) {
    const x = points.xs[index]
    const y = points.ys[index]
    const weight = points.weights[index]
    const rotatedY = (x * sine + y * cosine) / binSize + half
    const rotatedX = (x * cosine - y * sine) / binSize + half
    if (rotatedY >= 0 && rotatedY < binCount) rows[Math.floor(rotatedY)] += weight
    if (rotatedX >= 0 && rotatedX < binCount) columns[Math.floor(rotatedX)] += weight
  }
  let score = 0
  for (let bin = 1; bin < binCount; bin += 1) {
    const rowStep = rows[bin] - rows[bin - 1]
    const columnStep = columns[bin] - columns[bin - 1]
    score += rowStep * rowStep + columnStep * columnStep
  }
  return score
}

// Acceptance gates, calibrated against this collection's real scans and level
// vector art. A suggestion must beat the level score clearly (improvement),
// stand out from the whole curve rather than being one bump among many
// (prominence — ornament hatching and curved text produce noisy multi-modal
// curves), and sit in the range where human-evident tilts live: sub-0.5°
// corrections are imperceptible, while every calibrated peak beyond 4.5° was
// an ornament alias, so those report "no confident tilt" instead of a wrong
// angle. Curved-text-only badges have no straight rows at all and correctly
// fail these gates rather than receiving an arbitrary rotation.
const MINIMUM_IMPROVEMENT = 0.15
const MINIMUM_PROMINENCE = 0.5
const MINIMUM_ANGLE = 0.5
const MAXIMUM_ANGLE = 4.5

export function detectRotationFromGreyscale(data: Uint8Array | Buffer, width: number, height: number): RotationDetectionResult {
  if (width < 16 || height < 16) return { rotation: 0, confidence: 0 }
  const points = collectEdgePoints(data, width, height)
  if (points.count < 64) return { rotation: 0, confidence: 0 }
  const binSize = 2
  const binCount = Math.ceil(Math.hypot(width, height) / binSize) + 2
  const score = (degrees: number) => projectionSharpness(points, degrees, binSize, binCount)

  const curve: number[] = []
  let bestIndex = 0
  for (let step = 0; step <= (ROTATION_LIMIT * 2) / 0.25; step += 1) {
    curve.push(score(-ROTATION_LIMIT + step * 0.25))
    if (curve[step] > curve[bestIndex]) bestIndex = step
  }
  const levelScore = curve[(ROTATION_LIMIT / 0.25)]
  if (levelScore === 0) return { rotation: 0, confidence: 0 }
  let bestAngle = -ROTATION_LIMIT + bestIndex * 0.25
  let bestScore = curve[bestIndex]
  for (let degrees = bestAngle - 0.2; degrees <= bestAngle + 0.2 + 1e-9; degrees += 0.05) {
    if (degrees < -ROTATION_LIMIT || degrees > ROTATION_LIMIT) continue
    const candidate = score(degrees)
    if (candidate > bestScore) {
      bestScore = candidate
      bestAngle = degrees
    }
  }

  const median = [...curve].sort((left, right) => left - right)[Math.floor(curve.length / 2)]
  const improvement = bestScore / levelScore - 1
  const prominence = median > 0 ? bestScore / median - 1 : 0
  const confidence = Math.min(1, Math.min(improvement / MINIMUM_IMPROVEMENT, prominence / MINIMUM_PROMINENCE) / 2)
  const magnitude = Math.abs(bestAngle)
  if (improvement < MINIMUM_IMPROVEMENT || prominence < MINIMUM_PROMINENCE || magnitude < MINIMUM_ANGLE || magnitude > MAXIMUM_ANGLE) {
    return { rotation: 0, confidence }
  }
  const rotation = Math.round(bestAngle * 10) / 10
  return { rotation: Object.is(rotation, -0) ? 0 : rotation, confidence }
}

export async function detectRotation(imagePath: string): Promise<RotationDetectionResult> {
  const { data, info } = await sharp(imagePath, { density: 180, failOn: 'none' })
    .rotate()
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return detectRotationFromGreyscale(data, info.width, info.height)
}

type LabColor = { lightness: number; a: number; b: number }

function rgbToLab(red: number, green: number, blue: number): LabColor {
  const linear = (channel: number) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  const r = linear(red)
  const g = linear(green)
  const b = linear(blue)
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883
  const transform = (value: number) => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116
  const fx = transform(x)
  const fy = transform(y)
  const fz = transform(z)
  return { lightness: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

function labDistance(left: LabColor, right: LabColor) {
  return Math.hypot(left.lightness - right.lightness, left.a - right.a, left.b - right.b)
}

function rgbHex(red: number, green: number, blue: number) {
  return `#${[red, green, blue].map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0')).join('')}`
}

// Forces everything outside the coaster onto pure black. The coaster's own
// outline is kept — that is the point of the treatment, since a known uniform
// black can be swapped for any colour later with Replace, while an extended
// field is baked in and cannot be recovered.
//
// The surround is found by flooding inward from the frame edge, so the fill
// stops at the coaster and dark artwork inside it is never reachable. If that
// flood escapes into the middle of the frame the surround was not separable
// from the subject, and the image is returned untouched rather than blacked
// out: refusing is recoverable, destroying the artwork is not.
function labOfCache() {
  const cache = new Map<number, LabColor>()
  return (red: number, green: number, blue: number) => {
    const key = (red << 16) | (green << 8) | blue
    const hit = cache.get(key)
    if (hit) return hit
    const value = rgbToLab(red, green, blue)
    cache.set(key, value)
    return value
  }
}

// Pads an image out to a square, centred, on pure black.
//
// Image models take their output frame from the input frame. A coaster
// photographed at an angle sits in an oblong photo, so the model returns the
// disc squashed to fit that oblong however emphatically the prompt asks for a
// circle — which is exactly how a steeply angled shot came back as an ellipse.
// Squaring the frame first removes the conflict, and a regular circle becomes
// the natural thing to draw. Black is deliberate: it is also the surround the
// coaster preset asks for, so the padding reads as the target rather than as
// more table to clean off. An already-square image is returned untouched.
export async function padToSquare(input: Buffer) {
  const pipeline = sharp(input, { density: 180, failOn: 'none' }).rotate()
  const metadata = await pipeline.metadata()
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (!width || !height || width === height) return input
  const side = Math.max(width, height)
  const horizontal = side - width
  const vertical = side - height
  return pipeline.extend({
    left: Math.floor(horizontal / 2),
    right: Math.ceil(horizontal / 2),
    top: Math.floor(vertical / 2),
    bottom: Math.ceil(vertical / 2),
    background: '#000000',
  }).png().toBuffer()
}

export async function isolateOnBlack(input: Buffer, colour = '#000000', tolerance = 16) {
  const { data, info } = await sharp(input, { failOn: 'none' }).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  if (width < 8 || height < 8) return input

  // Seed from the frame's own corners: whatever the surround came back as, that
  // is what gets replaced, so an off-black or an unexpected colour both work.
  const toLab = labOfCache()
  const patch = Math.max(2, Math.round(Math.min(width, height) * 0.02))
  let red = 0
  let green = 0
  let blue = 0
  let samples = 0
  for (const [startX, startY] of [[0, 0], [width - patch, 0], [0, height - patch], [width - patch, height - patch]]) {
    for (let y = startY; y < startY + patch; y += 1) {
      for (let x = startX; x < startX + patch; x += 1) {
        const offset = (y * width + x) * channels
        red += data[offset]
        green += data[offset + 1]
        blue += data[offset + 2]
        samples += 1
      }
    }
  }
  if (!samples) return input
  const seed = toLab(Math.round(red / samples), Math.round(green / samples), Math.round(blue / samples))

  const mask = new Uint8Array(width * height)
  const visited = new Uint8Array(width * height)
  const stack: number[] = []
  let filled = 0
  const push = (x: number, y: number) => {
    const index = y * width + x
    if (visited[index]) return
    visited[index] = 1
    if (labDistance(toLab(data[index * channels], data[index * channels + 1], data[index * channels + 2]), seed) > tolerance) return
    mask[index] = 1
    filled += 1
    stack.push(index)
  }
  for (let x = 0; x < width; x += 1) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y)
    push(width - 1, y)
  }
  while (stack.length) {
    const index = stack.pop()!
    const x = index % width
    const y = (index - x) / width
    if (x > 0) push(x - 1, y)
    if (x < width - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < height - 1) push(x, y + 1)
  }

  // Leak guard. A single centre pixel is not enough — it can land on dark
  // artwork and hide a flood that swallowed everything around it. Instead the
  // central fifth of the frame, which any centred coaster covers, must come
  // back essentially untouched; if the flood got in there it did not stop at
  // the subject and the result would be a blacked-out image.
  let centreTotal = 0
  let centreFilled = 0
  for (let y = Math.floor(height * 0.4); y < Math.ceil(height * 0.6); y += 1) {
    for (let x = Math.floor(width * 0.4); x < Math.ceil(width * 0.6); x += 1) {
      centreTotal += 1
      centreFilled += mask[y * width + x]
    }
  }
  if (!centreTotal || centreFilled > centreTotal * 0.05) return input
  if (filled > width * height * 0.9) return input

  const output = Buffer.from(data)
  const [red_, green_, blue_] = parseHex(colour)
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue
    const offset = index * channels
    output[offset] = red_
    output[offset + 1] = green_
    output[offset + 2] = blue_
  }
  return sharp(output, { raw: { width, height, channels } }).png().toBuffer()
}

// Reads the true colour of one pixel from the working file rather than from
// the JPEG preview shown on screen, so a sampled colour matches what a fill
// will actually match against.
export async function samplePixelColor(imagePath: string, x: number, y: number): Promise<BackgroundColorResult> {
  const { data, info } = await sharp(imagePath, { density: 180, failOn: 'none' })
    .rotate()
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const px = Math.max(0, Math.min(info.width - 1, Math.round(x * (info.width - 1))))
  const py = Math.max(0, Math.min(info.height - 1, Math.round(y * (info.height - 1))))
  const offset = (py * info.width + px) * info.channels
  return { color: rgbHex(data[offset], data[offset + 1], data[offset + 2]) }
}

// Paint-bucket fill: replaces the contiguous region of similar pixels around
// the clicked point with one exact colour. Contiguity is what makes it usable
// on these labels — a tolerance wide enough to swallow a whole photographed
// background would otherwise also swallow matching tones inside the artwork.
export async function fillArea(request: FillRequest): Promise<ProcessResult> {
  const source = sharp(request.imagePath, { density: 180, failOn: 'none' }).rotate().flatten({ background: '#ffffff' })
  const { data, info } = await source.removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const target = parseHexColor(validateColor(request.color))
  const tolerance = Number.isFinite(request.tolerance) ? Math.max(0, Math.min(100, request.tolerance)) : 12

  const startX = Math.max(0, Math.min(width - 1, Math.round(request.x * (width - 1))))
  const startY = Math.max(0, Math.min(height - 1, Math.round(request.y * (height - 1))))
  const startOffset = (startY * width + startX) * channels
  const seed = rgbToLab(data[startOffset], data[startOffset + 1], data[startOffset + 2])
  // Tolerance is a percentage of a generous Lab radius, so the slider reads the
  // same way on any image regardless of its palette.
  const radius = (tolerance / 100) * 60

  const output = Buffer.from(data)
  const cache = new Map<number, LabColor>()
  const labAt = (offset: number) => {
    const key = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2]
    const hit = cache.get(key)
    if (hit) return hit
    const value = rgbToLab(data[offset], data[offset + 1], data[offset + 2])
    cache.set(key, value)
    return value
  }
  // The pixels that were the replaced colour outright. The ones that were only
  // partly it — the anti-aliased ramp along every edge — are re-composited
  // afterwards from this mask rather than matched by tolerance.
  const mask = new Uint8Array(width * height)
  const replaced: [number, number, number] = [data[startOffset], data[startOffset + 1], data[startOffset + 2]]
  const wanted: [number, number, number] = [target.red, target.green, target.blue]
  const paint = (offset: number) => {
    mask[offset / channels] = 1
    output[offset] = target.red
    output[offset + 1] = target.green
    output[offset + 2] = target.blue
  }

  // Global scope replaces the clicked colour everywhere at once. Flat two-colour
  // artwork has that colour in many disconnected pockets — inside letters,
  // between rings, outside the disc — so filling each one by hand is hopeless.
  // Pixels on the anti-aliased ramp between the two colours are re-composited
  // by `recompositeFringe` rather than matched: the tolerance decides only what
  // *is* the old colour, never what is a blend of it.
  if (request.scope === 'global') {
    for (let offset = 0; offset < output.length; offset += channels) {
      if (labDistance(labAt(offset), seed) <= radius) paint(offset)
    }
    recompositeFringe(data, output, width, height, channels, mask, replaced, wanted)
    const encodedGlobal = await sharp(output, { raw: { width, height, channels } }).png({ compressionLevel: 8 }).toBuffer()
    const globalPath = await writePreview(request.projectPath, request.imagePath + '-replace', encodedGlobal, 'png')
    const globalQuality = (await visualSignals(globalPath, width, height, encodedGlobal.length)).quality
    const globalThumb = await sharp(encodedGlobal).resize(520, 420, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
    return { outputPath: globalPath, thumbnailDataUrl: dataUrl('image/jpeg', globalThumb), width, height, quality: globalQuality }
  }

  const visited = new Uint8Array(width * height)
  const stack: number[] = []
  const push = (x: number, y: number) => {
    const index = y * width + x
    if (visited[index]) return
    visited[index] = 1
    const offset = index * channels
    if (labDistance(labAt(offset), seed) > radius) return
    paint(offset)
    stack.push(index)
  }
  push(startX, startY)
  while (stack.length) {
    const index = stack.pop()!
    const x = index % width
    const y = (index - x) / width
    if (x > 0) push(x - 1, y)
    if (x < width - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < height - 1) push(x, y + 1)
  }
  recompositeFringe(data, output, width, height, channels, mask, replaced, wanted)

  const encoded = await sharp(output, { raw: { width, height, channels } }).png({ compressionLevel: 8 }).toBuffer()
  const outputPath = await writePreview(request.projectPath, request.imagePath + '-fill', encoded, 'png')
  const quality = (await visualSignals(outputPath, width, height, encoded.length)).quality
  const thumbnail = await sharp(encoded).resize(520, 420, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
  return { outputPath, thumbnailDataUrl: dataUrl('image/jpeg', thumbnail), width, height, quality }
}

// The handful of colours actually worth one click. This delegates to the
// palette analysis rather than counting raw pixel buckets: on a flat two-colour
// design, bucket counting returns the ink, then four shades of the anti-aliased
// ramp between ink and background, which are not colours anyone wants to paint
// with. The palette analysis already discounts edge transitions and JPEG
// deviation, so it yields the intended colours instead.
export async function detectDominantColors(imagePath: string, count = 5): Promise<string[]> {
  const analysis = await detectPalette(imagePath)
  return analysis.swatches.slice(0, Math.max(1, Math.min(8, count)))
}

export async function detectPalette(imagePath: string) {
  const { data, info } = await sharp(imagePath, { density: 180, failOn: 'none' })
    .rotate()
    .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return analysePalette(data, info.width, info.height, info.channels)
}

// The analysis proper, over a small flattened RGB buffer. Shared by the panel's
// detection and by the flatten itself, so the two can never disagree about
// which colours a design is made of.
export function analysePalette(data: Buffer, width: number, height: number, channels: number): PaletteAnalysisResult {
  const buckets = new Map<number, { weight: number; red: number; green: number; blue: number }>()
  let totalWeight = 0
  const channelDistance = (first: number, second: number) => {
    const firstOffset = first * channels
    const secondOffset = second * channels
    return Math.max(
      Math.abs(data[firstOffset] - data[secondOffset]),
      Math.abs(data[firstOffset + 1] - data[secondOffset + 1]),
      Math.abs(data[firstOffset + 2] - data[secondOffset + 2]),
    )
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      const offset = index * channels
      const horizontal = x + 1 < width ? channelDistance(index, index + 1) : 0
      const vertical = y + 1 < height ? channelDistance(index, index + width) : 0
      const localGradient = Math.max(horizontal, vertical)
      const weight = localGradient > 28 ? 0.08 : localGradient > 14 ? 0.3 : 1
      const red = data[offset]
      const green = data[offset + 1]
      const blue = data[offset + 2]
      const key = ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3)
      const bucket = buckets.get(key) ?? { weight: 0, red: 0, green: 0, blue: 0 }
      bucket.weight += weight
      bucket.red += red * weight
      bucket.green += green * weight
      bucket.blue += blue * weight
      buckets.set(key, bucket)
      totalWeight += weight
    }
  }

  type Cluster = { weight: number; red: number; green: number; blue: number; lab: LabColor }
  const clusters: Cluster[] = []
  const minimumBinWeight = Math.max(0.2, totalWeight * 0.00008)
  const bins = [...buckets.values()]
    .filter((bucket) => bucket.weight >= minimumBinWeight)
    .map((bucket) => {
      const red = bucket.red / bucket.weight
      const green = bucket.green / bucket.weight
      const blue = bucket.blue / bucket.weight
      return { ...bucket, red, green, blue, lab: rgbToLab(red, green, blue) }
    })
    .sort((left, right) => right.weight - left.weight)

  for (const bin of bins) {
    let closest: Cluster | undefined
    let closestDistance = Number.POSITIVE_INFINITY
    for (const cluster of clusters) {
      const distance = labDistance(bin.lab, cluster.lab)
      if (distance < closestDistance) {
        closest = cluster
        closestDistance = distance
      }
    }
    if (closest && closestDistance <= 8.5) {
      const combinedWeight = closest.weight + bin.weight
      closest.red = (closest.red * closest.weight + bin.red * bin.weight) / combinedWeight
      closest.green = (closest.green * closest.weight + bin.green * bin.weight) / combinedWeight
      closest.blue = (closest.blue * closest.weight + bin.blue * bin.weight) / combinedWeight
      closest.weight = combinedWeight
      closest.lab = rgbToLab(closest.red, closest.green, closest.blue)
    } else {
      clusters.push({ weight: bin.weight, red: bin.red, green: bin.green, blue: bin.blue, lab: bin.lab })
    }
  }

  const minimumClusterWeight = Math.max(3, totalWeight * 0.004)
  const significant = clusters
    .filter((cluster) => cluster.weight >= minimumClusterWeight)
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 16)
  const selected = significant.length >= 2 ? significant : clusters.sort((left, right) => right.weight - left.weight).slice(0, 2)
  const retainedWeight = selected.reduce((sum, cluster) => sum + cluster.weight, 0)
  let minimumSeparation = 30
  for (let left = 0; left < selected.length; left += 1) {
    for (let right = left + 1; right < selected.length; right += 1) {
      minimumSeparation = Math.min(minimumSeparation, labDistance(selected[left].lab, selected[right].lab))
    }
  }
  const coverage = retainedWeight / Math.max(totalWeight, 1)
  const confidence = Math.max(0, Math.min(1, coverage * Math.min(1, minimumSeparation / 12)))
  return {
    recommendedColors: Math.max(2, Math.min(16, selected.length)),
    swatches: selected.map((cluster) => rgbHex(cluster.red, cluster.green, cluster.blue)),
    confidence: Math.round(confidence * 100) / 100,
    candidates: [...clusters].sort((left, right) => right.weight - left.weight).slice(0, 16).map((cluster) => rgbHex(cluster.red, cluster.green, cluster.blue)),
  }
}

async function detectContentBounds(buffer: Buffer) {
  const metadata = await sharp(buffer).metadata()
  const sourceWidth = metadata.width ?? 1
  const sourceHeight = metadata.height ?? 1
  const scale = Math.min(1, 900 / Math.max(sourceWidth, sourceHeight))
  const width = Math.max(1, Math.round(sourceWidth * scale))
  const height = Math.max(1, Math.round(sourceHeight * scale))
  const { data, info } = await sharp(buffer)
    .resize(width, height, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const channels = info.channels
  const borderSamples: Array<[number, number, number]> = []
  const inset = Math.max(1, Math.round(Math.min(width, height) * 0.015))
  const addSample = (x: number, y: number) => {
    const offset = (y * width + x) * channels
    borderSamples.push([data[offset], data[offset + 1], data[offset + 2]])
  }
  const stride = Math.max(1, Math.floor(Math.max(width, height) / 240))
  for (let x = 0; x < width; x += stride) {
    addSample(x, Math.min(inset, height - 1))
    addSample(x, Math.max(0, height - 1 - inset))
  }
  for (let y = 0; y < height; y += stride) {
    addSample(Math.min(inset, width - 1), y)
    addSample(Math.max(0, width - 1 - inset), y)
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 255
  const background = [0, 1, 2].map((channel) => median(borderSamples.map((sample) => sample[channel])))
  const borderDistances = borderSamples.map((sample) => Math.max(...sample.map((value, channel) => Math.abs(value - background[channel])))).sort((a, b) => a - b)
  const noise = borderDistances[Math.floor(borderDistances.length * 0.9)] ?? 0
  const threshold = Math.min(58, Math.max(18, noise + 10))
  const rowCounts = new Uint32Array(height)
  const columnCounts = new Uint32Array(width)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels
      const distance = Math.max(
        Math.abs(data[offset] - background[0]),
        Math.abs(data[offset + 1] - background[1]),
        Math.abs(data[offset + 2] - background[2]),
      )
      if (distance > threshold) {
        rowCounts[y] += 1
        columnCounts[x] += 1
      }
    }
  }
  const minimumRowPixels = Math.max(2, Math.round(width * 0.003))
  const minimumColumnPixels = Math.max(2, Math.round(height * 0.003))
  let top = 0
  let bottom = height - 1
  let left = 0
  let right = width - 1
  while (top < height && rowCounts[top] < minimumRowPixels) top += 1
  while (bottom >= top && rowCounts[bottom] < minimumRowPixels) bottom -= 1
  while (left < width && columnCounts[left] < minimumColumnPixels) left += 1
  while (right >= left && columnCounts[right] < minimumColumnPixels) right -= 1
  if (top >= height || left >= width || bottom < top || right < left) {
    return { left: 0, top: 0, width: sourceWidth, height: sourceHeight }
  }
  const toSourceX = sourceWidth / width
  const toSourceY = sourceHeight / height
  const sourceLeft = Math.max(0, Math.floor(left * toSourceX))
  const sourceTop = Math.max(0, Math.floor(top * toSourceY))
  const sourceRight = Math.min(sourceWidth, Math.ceil((right + 1) * toSourceX))
  const sourceBottom = Math.min(sourceHeight, Math.ceil((bottom + 1) * toSourceY))
  return { left: sourceLeft, top: sourceTop, width: Math.max(1, sourceRight - sourceLeft), height: Math.max(1, sourceBottom - sourceTop) }
}

async function writePreview(projectPath: string, sourcePath: string, buffer: Buffer, extension: string) {
  const previewDirectory = path.join(projectPath, '.moodprep', 'previews')
  await fs.mkdir(previewDirectory, { recursive: true })
  const digest = createHash('sha1').update(buffer).digest('hex').slice(0, 10)
  const filename = `${safeStem(sourcePath)}-${digest}.${extension}`
  const outputPath = path.join(previewDirectory, filename)
  await fs.writeFile(outputPath, buffer)
  return outputPath
}

// Removes every preview that nothing refers to any more. A preview is scratch:
// each revision writes a new one, a commit re-encodes the chosen one into the
// source file, and nothing ever pointed back at the rest — measured on
// 2026-09-09 the folder held 4,686 files and 5.8 GB with not one of them
// referenced by project.json, growing by up to a gigabyte a working day. It is
// pruned when a folder is scanned and when the workbench closes, keeping only
// the paths the project still names (a legacy `outputPath`). Anything that
// cannot be removed is left for the next pass rather than failing the caller.
export async function prunePreviews(folder: string, keep: string[]): Promise<{ removed: number; bytes: number }> {
  const root = path.resolve(folder)
  const previewDirectory = path.join(root, '.moodprep', 'previews')
  const wanted = new Set(keep.filter(Boolean).map((target) => path.resolve(target)))
  let entries: string[]
  try { entries = await fs.readdir(previewDirectory) } catch { return { removed: 0, bytes: 0 } }
  let removed = 0
  let bytes = 0
  for (const entry of entries) {
    const target = path.join(previewDirectory, entry)
    if (wanted.has(target)) continue
    try {
      const stat = await fs.stat(target)
      if (!stat.isFile()) continue
      await fs.unlink(target)
      removed += 1
      bytes += stat.size
    } catch { /* A file already gone, or one that cannot be removed, waits for the next pass. */ }
  }
  return { removed, bytes }
}

export async function processImage(request: ProcessRequest): Promise<ProcessResult> {
  const input = sharp(request.imagePath, { density: 300, failOn: 'none' }).rotate()
  const inputMetadata = await input.metadata()
  if (!inputMetadata.width || !inputMetadata.height) throw new Error('Could not read the image dimensions.')

  const paintStrokes = (request.paintStrokes ?? []).filter((stroke) => stroke.points.length > 0)
  let preparedInput = input
  if (paintStrokes.length > 0) {
    const width = inputMetadata.width
    const height = inputMetadata.height
    const shortestEdge = Math.min(width, height)
    const shapes = paintStrokes.map((stroke) => {
      // Each stroke carries the colour it was drawn in, so a black stroke and a
      // red one can be pending together and land in one pass.
      const color = validateColor(stroke.color ?? request.background)
      const size = Math.max(0.005, Math.min(0.3, stroke.size)) * shortestEdge
      const points = stroke.points.map((point) => ({
        x: Math.max(0, Math.min(1, point.x)) * width,
        y: Math.max(0, Math.min(1, point.y)) * height,
      }))
      if (stroke.shape === 'square') {
        return points.map((point) => `<rect x="${point.x - (size / 2)}" y="${point.y - (size / 2)}" width="${size}" height="${size}" fill="${color}"/>`).join('')
      }
      if (points.length === 1) return `<circle cx="${points[0].x}" cy="${points[0].y}" r="${size / 2}" fill="${color}"/>`
      return `<polyline points="${points.map((point) => `${point.x},${point.y}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${size}" stroke-linecap="round" stroke-linejoin="round"/>`
    }).join('')
    const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${shapes}</svg>`)
    preparedInput = input.composite([{ input: overlay, left: 0, top: 0 }])
  }

  const cropLeft = Math.round((request.crop.left / 100) * inputMetadata.width)
  const cropRight = Math.round((request.crop.right / 100) * inputMetadata.width)
  const cropTop = Math.round((request.crop.top / 100) * inputMetadata.height)
  const cropBottom = Math.round((request.crop.bottom / 100) * inputMetadata.height)
  let cropWidth = Math.max(1, inputMetadata.width - cropLeft - cropRight)
  let cropHeight = Math.max(1, inputMetadata.height - cropTop - cropBottom)
  if (request.squareCrop) {
    // Each inset rounds to pixels on its own, so a frame the renderer made
    // square can land a pixel out. Take the shorter side rather than growing
    // past the frame the user positioned.
    const side = Math.max(1, Math.min(cropWidth, cropHeight))
    cropWidth = side
    cropHeight = side
  }

  const stage = preparedInput.extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
  let buffer = await stage.png().toBuffer()
  const rotation = Number.isFinite(request.rotation) ? Math.max(-180, Math.min(180, request.rotation ?? 0)) : 0
  if (Math.abs(rotation) >= 0.05) {
    buffer = await sharp(buffer)
      .rotate(rotation, { background: validateColor(request.background) })
      .png()
      .toBuffer()
  }
  const preservePaintedCanvas = paintStrokes.length > 0
  if (!preservePaintedCanvas && (request.trim || request.center)) {
    const bounds = await detectContentBounds(buffer)
    buffer = await sharp(buffer).extract(bounds).png().toBuffer()
  }
  if (!preservePaintedCanvas && request.center) {
    const contentMetadata = await sharp(buffer).metadata()
    const contentWidth = contentMetadata.width ?? cropWidth
    const contentHeight = contentMetadata.height ?? cropHeight
    const targetWidth = request.trim ? Math.ceil(contentWidth * 1.08) : cropWidth
    const targetHeight = request.trim ? Math.ceil(contentHeight * 1.08) : cropHeight
    const left = Math.floor((targetWidth - contentWidth) / 2)
    const right = targetWidth - contentWidth - left
    const top = Math.floor((targetHeight - contentHeight) / 2)
    const bottom = targetHeight - contentHeight - top
    buffer = await sharp(buffer)
      .extend({ top, bottom, left, right, background: validateColor(request.background) })
      .png()
      .toBuffer()
  }

  let output = sharp(buffer).flatten({ background: validateColor(request.background) })
  // Before the upscale, so the shift runs over the smaller buffer, and before
  // any palette flattening, which would otherwise quantise the old colours and
  // leave the shift to work on whatever survived.
  if (request.recolour && request.recolour.amount > 0) {
    const flattened = await output.png().toBuffer()
    const raw = await sharp(flattened).raw().toBuffer({ resolveWithObject: true })
    shiftPixels(raw.data, raw.info.channels, hueShiftTable(colourShifts(request.recolour.variation, request.recolour.amount)))
    output = sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: raw.info.channels } })
  }
  if (request.upscale > 1) {
    const metadata = await output.metadata()
    output = output.resize({
      width: Math.round((metadata.width ?? cropWidth) * request.upscale),
      height: Math.round((metadata.height ?? cropHeight) * request.upscale),
      kernel: sharp.kernel.lanczos3,
    })
  }
  const paletteColors = Number.isFinite(request.paletteColors)
    ? Math.max(0, Math.min(32, Math.round(request.paletteColors)))
    : 0
  if (paletteColors >= 2) {
    // Quantise to the palette the analysis finds, never to a bare count. A
    // general-purpose quantiser given "6" spends its slots on the paper's
    // gradient and merges the small inks; the analysis is what found those
    // inks in the first place, so the flatten maps to them.
    const full = await output.png().toBuffer()
    const small = await sharp(full).resize(320, 320, { fit: 'inside', withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const analysis = analysePalette(small.data, small.info.width, small.info.height, small.info.channels)
    const swatches = analysis.candidates.slice(0, paletteColors)
    const raw = await sharp(full).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    mapToPalette(raw.data, raw.info.channels, swatches)
    output = sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: raw.info.channels } })
  }
  // The border goes on last: after the upscale so its width is in real output
  // pixels rather than being multiplied by it, and after the palette flatten so
  // the colour the user picked is the colour that lands rather than whatever
  // the quantiser rounded it to. It extends the canvas rather than painting
  // over the edge, so no artwork is covered.
  if (request.border && request.border.width > 0) {
    const bordered = await output.png().toBuffer()
    const metadata = await sharp(bordered).metadata()
    const shorter = Math.max(1, Math.min(metadata.width ?? 1, metadata.height ?? 1))
    const edge = Math.max(1, Math.round(Math.min(0.2, Math.max(0.005, request.border.width)) * shorter))
    output = sharp(bordered).extend({
      top: edge, bottom: edge, left: edge, right: edge,
      background: validateColor(request.border.colour),
    })
  }
  const encoded = request.outputFormat === 'jpeg'
    ? await output.jpeg({ quality: paletteColors >= 2 ? 100 : 94, chromaSubsampling: paletteColors >= 2 ? '4:4:4' : '4:2:0', mozjpeg: true }).toBuffer()
    : request.outputFormat === 'webp'
      ? await output.webp(paletteColors >= 2 ? { lossless: true } : { quality: 94, smartSubsample: true }).toBuffer()
      : await output.png({ compressionLevel: 8 }).toBuffer()
  const outputPath = await writePreview(request.projectPath, request.imagePath, encoded, request.outputFormat === 'jpeg' ? 'jpg' : request.outputFormat)
  const resultMetadata = await sharp(encoded).metadata()
  const quality = (await visualSignals(outputPath, resultMetadata.width ?? 0, resultMetadata.height ?? 0, encoded.length)).quality
  const thumbnail = await sharp(encoded).resize(520, 420, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
  return {
    outputPath,
    thumbnailDataUrl: dataUrl('image/jpeg', thumbnail),
    width: resultMetadata.width ?? 0,
    height: resultMetadata.height ?? 0,
    quality,
  }
}

export async function commitProcessedImage(folder: string, sourcePath: string, previewPath: string) {
  const root = path.resolve(folder)
  const source = assertPathInside(root, sourcePath, 'Source image')
  const preview = assertPathInside(root, previewPath, 'Processed preview')
  if (source.relative.startsWith(`${BACKUP_DIRECTORY}${path.sep}`)) {
    throw new Error('Refusing to replace a file inside the originals folder.')
  }
  if (!preview.relative.startsWith(`.moodprep${path.sep}previews${path.sep}`)) {
    throw new Error('The proposed image is not a MoodPrep preview.')
  }

  const previewExtension = path.extname(preview.resolvedTarget).toLowerCase()
  if (!SUPPORTED.has(previewExtension) || previewExtension === '.svg') {
    throw new Error('The proposed image has an unsupported output format.')
  }
  const sourceExtension = path.extname(source.resolvedTarget).toLowerCase()
  const previewBuffer = await fs.readFile(preview.resolvedTarget)
  const replacementPipeline = sharp(previewBuffer).rotate()
  const replacement = sourceExtension === '.jpg' || sourceExtension === '.jpeg'
    ? await replacementPipeline.jpeg({ quality: 94, mozjpeg: true }).toBuffer()
    : sourceExtension === '.webp'
      ? await replacementPipeline.webp({ quality: 94, smartSubsample: true }).toBuffer()
      : await replacementPipeline.png({ compressionLevel: 8 }).toBuffer()
  const outputPath = source.resolvedTarget
  const temporaryPath = `${outputPath}.moodprep-${process.pid}.tmp`
  await fs.writeFile(temporaryPath, replacement)
  const backupPath = await backupDestination(root, source.relative)
  await fs.rename(source.resolvedTarget, backupPath)
  try {
    await fs.rename(temporaryPath, outputPath)
  } catch (error) {
    await fs.rename(backupPath, source.resolvedTarget).catch(() => undefined)
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
  return { outputPath, backupPath }
}

// The inverse of commitProcessedImage. Replacing an original is reversible by
// design — the previous file is moved into the backup folder rather than
// discarded — so the workbench can offer a real undo instead of asking the
// user to confirm every save. The same rename dance keeps it atomic: the
// replacement is only discarded once the backup is safely back in place.
export async function revertCommittedImage(folder: string, sourcePath: string, backupPath: string) {
  const root = path.resolve(folder)
  const source = assertPathInside(root, sourcePath, 'Source image')
  const backup = assertPathInside(root, backupPath, 'Backup image')
  if (!backup.relative.startsWith(`${BACKUP_DIRECTORY}${path.sep}`)) {
    throw new Error('That file is not a MoodPrep backup, so it cannot be restored.')
  }
  if (source.relative.startsWith(`${BACKUP_DIRECTORY}${path.sep}`)) {
    throw new Error('Refusing to restore over a file inside the originals folder.')
  }
  try {
    await fs.access(backup.resolvedTarget)
  } catch {
    throw new Error('The backed-up original is no longer there, so this cannot be undone.')
  }
  const outputPath = source.resolvedTarget
  const temporaryPath = `${outputPath}.moodprep-undo-${process.pid}.tmp`
  // Move the replacement aside rather than deleting it, so a failure part way
  // through can put things back exactly as they were.
  let replacementMoved = false
  try {
    await fs.rename(outputPath, temporaryPath)
    replacementMoved = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await fs.rename(backup.resolvedTarget, outputPath)
  } catch (error) {
    if (replacementMoved) await fs.rename(temporaryPath, outputPath).catch(() => undefined)
    throw error
  }
  await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
  return { outputPath, restoredFrom: backup.resolvedTarget }
}

function friendlyNetworkError(error: unknown) {
  if (error instanceof Error && error.name === 'AbortError') {
    return new Error('Gemini did not respond within three minutes. Check the proxy or VPN connection and try again.')
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new Error(`Could not reach the Gemini service through the current network or proxy. Check Settings → Test connection, then try again. (${detail})`)
}

function isGeminiPolicyMessage(message: string) {
  return /copyright|policy|safety|blocked|refus|prohibited|not allowed/i.test(message)
}

function geminiPolicyDecline() {
  return new Error('Gemini declined this request under its policy. MoodPrep cannot override that decision. Try Reimagine design for a new, non-identical concept with different wording, or use deterministic local tools or a source you have the rights to edit.')
}

async function detectEdgeExtensions(input: Buffer) {
  const { data, info } = await sharp(input, { density: 180, failOn: 'none' })
    .rotate()
    .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const cornerSize = Math.max(2, Math.round(Math.min(width, height) * 0.04))
  const cornerPixels: Array<[number, number, number]> = []
  for (const [startX, startY] of [[0, 0], [width - cornerSize, 0], [0, height - cornerSize], [width - cornerSize, height - cornerSize]]) {
    for (let y = startY; y < startY + cornerSize; y += 1) {
      for (let x = startX; x < startX + cornerSize; x += 1) {
        const offset = (y * width + x) * channels
        cornerPixels.push([data[offset], data[offset + 1], data[offset + 2]])
      }
    }
  }
  const median = (values: number[]) => values.sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 255
  const background = [0, 1, 2].map((channel) => median(cornerPixels.map((pixel) => pixel[channel])))
  const differsFromBackground = (x: number, y: number) => {
    const offset = (y * width + x) * channels
    return Math.max(
      Math.abs(data[offset] - background[0]),
      Math.abs(data[offset + 1] - background[1]),
      Math.abs(data[offset + 2] - background[2]),
    ) > 50
  }
  const contactCoverage = {
    top: Array.from({ length: width }, (_, x) => differsFromBackground(x, 0)).filter(Boolean).length / width,
    bottom: Array.from({ length: width }, (_, x) => differsFromBackground(x, height - 1)).filter(Boolean).length / width,
    left: Array.from({ length: height }, (_, y) => differsFromBackground(0, y)).filter(Boolean).length / height,
    right: Array.from({ length: height }, (_, y) => differsFromBackground(width - 1, y)).filter(Boolean).length / height,
  }
  const expansionFor = (coverage: number) => coverage >= 0.08 ? Math.min(0.2, 0.08 + coverage * 0.12) : 0
  return {
    top: expansionFor(contactCoverage.top),
    bottom: expansionFor(contactCoverage.bottom),
    left: expansionFor(contactCoverage.left),
    right: expansionFor(contactCoverage.right),
  }
}


export async function testConnection(provider: AiProvider, apiKey: string, networkFetch: NetworkFetch = globalThis.fetch, workspace = '', region: QwenRegion = DEFAULT_QWEN_REGION): Promise<ConnectionResult> {
  if (!apiKey) return { ok: false, message: `No ${provider === 'qwen' ? 'Qwen' : 'Gemini'} API key is stored.` }
  try {
    if (provider === 'qwen') {
      if (needsQwenWorkspace(apiKey, workspace)) {
        return { ok: false, message: 'This key is workspace-scoped (it begins sk-ws-), so it needs the Workspace ID from the same Model Studio console. Add it above and test again.' }
      }
      // DashScope has no cheap metadata endpoint, so the test is a deliberately
      // malformed generation call: a 401 means the key is wrong, and anything
      // else means the key was accepted and the endpoint is reachable.
      const response = await networkFetch(qwenEndpoint(workspace, region), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'qwen-image-3.0', input: { messages: [] } }),
      })
      if (response.status === 401 || response.status === 403) {
        const other = region === 'beijing' ? 'International' : 'China'
        return { ok: false, message: `Qwen rejected that API key on the ${qwenRegionLabel(region)} endpoint. A key belongs to one region only, so if it was made in the other Model Studio console, switch the region above to ${other} and test again. Otherwise check the key and the Workspace ID come from the same console.` }
      }
      return { ok: true, message: `Reached Qwen on the ${qwenRegionLabel(region)} endpoint. Image reconstruction is ready.` }
    }
    const response = await networkFetch('https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-lite-image', {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
    })
    if (response.ok) return { ok: true, message: 'Connected to Gemini successfully. Image reconstruction is ready.' }
    const payload = await response.json().catch(() => ({})) as { error?: { message?: string } }
    return { ok: false, message: payload.error?.message ?? `Gemini rejected the connection test (${response.status}).` }
  } catch (error) {
    return { ok: false, message: friendlyNetworkError(error).message }
  }
}

// Reading one image and writing the reconstruction prompt for it. The same
// endpoint as the edit, asking for text back instead of an image, on the fixed
// light model. The instruction comes from the renderer, which is where the
// preset prompts are written and where the house rules already live.
export async function authorPrompt(request: AuthoredPromptRequest, apiKey: string, networkFetch: NetworkFetch = globalThis.fetch): Promise<AuthoredPromptResult> {
  if (!apiKey) throw new Error('Add a Gemini API key in Settings first.')
  const input = await fs.readFile(request.imagePath)
  const mimeType = MIME_TYPES[path.extname(request.imagePath).toLowerCase()] ?? 'image/jpeg'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 90_000)
  try {
    const response = await networkFetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        model: PROMPT_AUTHOR_MODEL,
        input: [
          { type: 'text', text: request.instruction },
          { type: 'image', mime_type: mimeType, data: input.toString('base64') },
        ],
        response_format: { type: 'text' },
      }),
      signal: controller.signal,
    })
    const payload = await response.json() as Record<string, unknown>
    if (!response.ok) {
      const apiMessage = (payload.error as { message?: string } | undefined)?.message
      if (apiMessage && isGeminiPolicyMessage(apiMessage)) throw geminiPolicyDecline()
      throw new Error(`Gemini API: ${apiMessage ?? `request failed (${response.status}).`}`)
    }
    const steps = payload.steps as Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> | undefined
    const parts = (steps ?? []).filter((step) => step.type === 'model_output').flatMap((step) => step.content ?? [])
    const prompt = parts.filter((part) => part.type === 'text').map((part) => part.text).filter(Boolean).join('\n').trim()
    if (!prompt) throw new Error('Gemini returned no prompt for this image. Try again, or write the instruction yourself.')
    return { prompt, model: PROMPT_AUTHOR_MODEL }
  } catch (error) {
    throw friendlyNetworkError(error)
  } finally {
    clearTimeout(timeout)
  }
}

type EditReply = { image: Buffer; mimeType: string; text: string }

async function callGemini(model: string, prompt: string, input: Buffer, mimeType: string, imageSize: string, apiKey: string, networkFetch: NetworkFetch, signal: AbortSignal): Promise<EditReply> {
  const response = await networkFetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      model,
      input: [
        { type: 'text', text: prompt },
        { type: 'image', mime_type: mimeType, data: input.toString('base64') },
      ],
      response_format: { type: 'image', mime_type: 'image/jpeg', image_size: imageSize },
    }),
    signal,
  })
  const payload = await response.json() as Record<string, unknown>
  if (!response.ok) {
    const apiMessage = (payload.error as { message?: string } | undefined)?.message
    if (apiMessage && isGeminiPolicyMessage(apiMessage)) throw geminiPolicyDecline()
    throw new Error(`Gemini API: ${apiMessage ?? `request failed (${response.status}).`}`)
  }
  const steps = payload.steps as Array<{ type?: string; content?: Array<{ type?: string; text?: string; data?: string; mime_type?: string }> }> | undefined
  const parts = (steps ?? []).filter((step) => step.type === 'model_output').flatMap((step) => step.content ?? [])
  const imagePart = parts.find((part) => part.type === 'image' && part.data)
  const text = parts.filter((part) => part.type === 'text').map((part) => part.text).filter(Boolean).join('\n')
  if (!imagePart?.data && isGeminiPolicyMessage(text)) throw geminiPolicyDecline()
  if (!imagePart?.data) throw new Error('Gemini returned no image. Try a more explicit edit instruction.')
  return { image: Buffer.from(imagePart.data, 'base64'), mimeType: imagePart.mime_type ?? 'image/png', text }
}

// DashScope answers with a temporary URL rather than the image itself, so the
// result has to be fetched a second time before it can be written anywhere.
async function callQwen(model: string, prompt: string, input: Buffer, mimeType: string, imageSize: string, apiKey: string, networkFetch: NetworkFetch, signal: AbortSignal, workspace: string, region: QwenRegion): Promise<EditReply> {
  const side = imageSize === '1K' ? 1024 : 2048
  if (needsQwenWorkspace(apiKey, workspace)) throw new Error('Qwen API: this key is workspace-scoped, so it needs the Workspace ID from the same Model Studio console. Add it in Settings.')
  const response = await networkFetch(qwenEndpoint(workspace, region), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      input: {
        messages: [{
          role: 'user',
          content: [
            { image: `data:${mimeType};base64,${input.toString('base64')}` },
            { text: prompt },
          ],
        }],
      },
      // The watermark defaults on, which would deface every result.
      parameters: { n: 1, watermark: false, prompt_extend: false, size: `${side}*${side}` },
    }),
    signal,
  })
  const payload = await response.json() as Record<string, unknown>
  if (!response.ok) {
    const apiMessage = (payload as { message?: string }).message ?? (payload as { code?: string }).code
    if (apiMessage && isGeminiPolicyMessage(apiMessage)) throw geminiPolicyDecline()
    throw new Error(`Qwen API: ${apiMessage ?? `request failed (${response.status}).`}`)
  }
  const choices = (payload.output as { choices?: Array<{ message?: { content?: Array<{ image?: string; text?: string }> } }> } | undefined)?.choices ?? []
  const content = choices.flatMap((choice) => choice.message?.content ?? [])
  const url = content.find((part) => part.image)?.image
  const text = content.map((part) => part.text).filter(Boolean).join('\n')
  if (!url && isGeminiPolicyMessage(text)) throw geminiPolicyDecline()
  if (!url) throw new Error('Qwen returned no image. Try a more explicit edit instruction.')
  const download = await networkFetch(url, { signal })
  if (!download.ok) throw new Error(`Qwen produced an image but it could not be downloaded (${download.status}).`)
  const bytes = Buffer.from(await download.arrayBuffer())
  const downloadType = download.headers?.get?.('content-type') ?? ''
  const resolved = downloadType.startsWith('image/')
    ? downloadType
    : url.includes('.jpg') || url.includes('.jpeg') ? 'image/jpeg' : 'image/png'
  return { image: bytes, mimeType: resolved, text }
}

export async function aiEdit(request: GeminiRequest, apiKey: string, networkFetch: NetworkFetch = globalThis.fetch, workspace = '', region: QwenRegion = DEFAULT_QWEN_REGION): Promise<GeminiResult> {
  const chosen = modelById(request.model ?? '')
  if (!apiKey) throw new Error(`Add a ${chosen.provider === 'qwen' ? 'Qwen' : 'Gemini'} API key in Settings first.`)
  if (request.prompt.trim().length < 12) throw new Error('Describe the requested edit in a little more detail.')
  let input: Buffer = await fs.readFile(request.imagePath)
  const extension = path.extname(request.imagePath).toLowerCase()
  let mimeType = MIME_TYPES[extension] ?? 'image/jpeg'
  if (request.completeEdges) {
    const pipeline = sharp(input, { density: 180, failOn: 'none' }).rotate()
    const metadata = await pipeline.metadata()
    const width = metadata.width ?? 1
    const height = metadata.height ?? 1
    const extensions = await detectEdgeExtensions(input)
    const shortestEdge = Math.min(width, height)
    const top = Math.round(shortestEdge * extensions.top)
    const bottom = Math.round(shortestEdge * extensions.bottom)
    const left = Math.round(shortestEdge * extensions.left)
    const right = Math.round(shortestEdge * extensions.right)
    const detectedBackground = request.canvasBackground ?? (await detectBackgroundColor(request.imagePath)).color
    if (top + bottom + left + right > 0) {
      input = await pipeline.extend({ top, bottom, left, right, background: validateColor(detectedBackground) }).png().toBuffer()
      mimeType = 'image/png'
    }
  }
  if (request.squareCanvas) {
    const padded = await padToSquare(input)
    if (padded !== input) {
      input = padded
      mimeType = 'image/png'
    }
  }
  const model = chosen.id
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 180_000)
  try {
    const reply = chosen.provider === 'qwen'
      ? await callQwen(model, request.prompt.trim(), input, mimeType, request.imageSize, apiKey, networkFetch, controller.signal, workspace, region)
      : await callGemini(model, request.prompt.trim(), input, mimeType, request.imageSize, apiKey, networkFetch, controller.signal)
    let resultBuffer = reply.image
    const responseText = reply.text
    // PNG afterwards: the pass creates large flat fields, and re-encoding them
    // as JPEG would reintroduce ringing around the very edges it just cleaned.
    let resultExtension = reply.mimeType.includes('jpeg') ? 'jpg' : reply.mimeType.includes('webp') ? 'webp' : 'png'
    if (request.isolateOn) {
      resultBuffer = await isolateOnBlack(resultBuffer, request.isolateOn)
      resultExtension = 'png'
    }
    const outputPath = await writePreview(request.projectPath, request.imagePath + '-' + chosen.provider, resultBuffer, resultExtension)
    const metadata = await sharp(resultBuffer).metadata()
    const quality = (await visualSignals(outputPath, metadata.width ?? 0, metadata.height ?? 0, resultBuffer.length)).quality
    const thumbnail = await sharp(resultBuffer).resize(520, 420, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer()
    return {
      outputPath,
      thumbnailDataUrl: dataUrl('image/jpeg', thumbnail),
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      quality,
      model,
      responseText: responseText || undefined,
    }
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith('Gemini API:') || error.message.startsWith('Qwen API:') || error.message.startsWith('Gemini declined') || error.message.includes('returned no image') || error.message.includes('could not be downloaded'))) throw error
    throw friendlyNetworkError(error)
  } finally {
    clearTimeout(timeout)
  }
}

async function uniqueDestination(folder: string, desiredName: string) {
  const extension = path.extname(desiredName)
  const stem = path.basename(desiredName, extension)
  let candidate = path.join(folder, desiredName)
  let number = 2
  while (true) {
    try {
      await fs.access(candidate)
      candidate = path.join(folder, `${stem}-${number}${extension}`)
      number += 1
    } catch {
      return candidate
    }
  }
}

export async function exportSelection(folder: string, entries: ExportEntry[]): Promise<ExportResult> {
  const outputFolder = path.join(folder, 'moodboard-ready')
  await fs.mkdir(outputFolder, { recursive: true })
  const manifestEntries: Array<Record<string, unknown>> = []
  for (const entry of entries) {
    let selectedPath = entry.outputPath || entry.sourcePath
    let desiredName = path.basename(selectedPath)
    if (!entry.outputPath && path.extname(selectedPath).toLowerCase() === '.svg') {
      const rendered = await sharp(selectedPath, { density: 600 })
        .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: false })
        .png()
        .toBuffer()
      const destination = await uniqueDestination(outputFolder, `${safeStem(selectedPath)}.png`)
      await fs.writeFile(destination, rendered)
      selectedPath = destination
      desiredName = path.basename(destination)
    } else {
      const destination = await uniqueDestination(outputFolder, desiredName)
      await fs.copyFile(selectedPath, destination)
      selectedPath = destination
      desiredName = path.basename(destination)
    }
    manifestEntries.push({
      imageId: entry.imageId,
      original: entry.sourcePath,
      exported: desiredName,
      processed: Boolean(entry.outputPath),
      issues: entry.issues,
    })
  }
  const manifestPath = path.join(outputFolder, 'manifest.json')
  await fs.writeFile(manifestPath, JSON.stringify({ exportedAt: new Date().toISOString(), images: manifestEntries }, null, 2), 'utf8')
  return { outputFolder, count: entries.length, manifestPath }
}
