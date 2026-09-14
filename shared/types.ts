import type { AiProvider, QwenRegion } from './models'
import type { QualityLabel } from './quality'

export const ISSUE_TYPES = [
  'border',
  'crop',
  'texture',
  'perspective',
  'rotation_needed',
  'watermark',
  'background',
  'low_quality',
  'off_center',
] as const

export const KNOWN_CLEAN_WATERMARK_FILENAMES = new Set([
  '5f405bb46206cf209d4df98efbbd7a39.jpg',
  '83bb2ae47e6da3dfdb42f54ae4008bf7.jpg',
  '9d430c2b-31b6-427c-8d2c-6c555fa0d3ba.jpeg',
  'article_0128_1.jpg',
  'd71ad8a3a22a8aa6e6196160269b2074.jpg',
  'images.jpeg',
])

export type IssueType = (typeof ISSUE_TYPES)[number]

export type QualitySignal = {
  score: number
  label: QualityLabel
  detailScore: number
  reasons: string[]
}

export type ImageRecord = {
  id: string
  path: string
  name: string
  extension: string
  mimeType: string
  width: number
  height: number
  bytes: number
  exactHash: string
  perceptualHash: string | null
  // Filesystem timestamps captured at scan time so the library can sort by
  // Date Modified / Date Added without re-reading every file.
  modifiedAt: string
  addedAt: string
  thumbnailDataUrl: string
  quality: QualitySignal
  suggestedIssues: IssueType[]
  processed: boolean
}

export type ScanResult = {
  folder: string
  images: ImageRecord[]
  scannedAt: string
  ignoredFiles: number
  // How much of this scan was actual work. A launch that changed nothing
  // re-analyses none of them and finishes in well under a second.
  analysed: number
  reused: number
}

export type ImageDecision = {
  status: 'keep' | 'exclude'
  issues: IssueType[]
  sourcePath?: string
  processedAt?: string
  backupAcknowledged?: boolean
  outputPath?: string
  outputThumbnail?: string
  outputQuality?: QualitySignal
  notes?: string
  // Set on a copy made with Duplicate image: the path it was copied from.
  // Marks the pair as deliberate so duplicate review leaves it alone.
  duplicateOf?: string
}

export type ProjectState = {
  version: 1 | 2 | 3 | 4
  folder: string
  updatedAt: string
  decisions: Record<string, ImageDecision>
}

export type CropInsets = {
  left: number
  right: number
  top: number
  bottom: number
}

export type PaintPoint = {
  x: number
  y: number
}

export type PaintBrushShape = 'circle' | 'square'

export type PaintStroke = {
  points: PaintPoint[]
  size: number
  shape?: PaintBrushShape
  // The working colour at the moment the stroke was drawn. A stroke that took
  // its colour from the picker instead would change colour retroactively when
  // the picker moved, so painting a second colour meant applying the first one
  // and waiting for it. Absent means the request's background colour, which is
  // what strokes recorded before this carried.
  color?: string
}

export type ProcessRequest = {
  projectPath: string
  imagePath: string
  crop: CropInsets
  trim: boolean
  center: boolean
  background: string
  upscale: number
  outputFormat: 'png' | 'jpeg' | 'webp'
  paletteColors: number
  paintStrokes?: PaintStroke[]
  rotation?: number
  // Swap an already-isolated surround for another colour, re-compositing the
  // blended edge rather than flooding it.
  swapBackdrop?: { colour: string; tolerance: number }
  // Deterministic palette shift. Absent means leave the colours alone; the
  // variation picks which scheme, the amount how far it travels.
  recolour?: { variation: number; amount: number }
  // A border of the working colour added OUTSIDE the artwork, so nothing is
  // covered. `width` is a share of the shorter edge, not a pixel count.
  border?: { width: number; colour: string }
  // 1:1 crop lock. The renderer already sends square-equivalent percentages;
  // this makes the processor equalise the two sides after its own rounding, so
  // the saved crop is exactly square rather than a pixel off.
  squareCrop?: boolean
}

// What the model is asked to return. Not every model serves every size:
// `AiModel.sizes` in shared/models.ts says which, and it is not cosmetic.
export type ImageSize = '1K' | '2K' | '4K'

export type FillScope = 'contiguous' | 'global'

export type FillRequest = {
  projectPath: string
  imagePath: string
  x: number
  y: number
  color: string
  tolerance: number
  scope?: FillScope
}

export type ProcessResult = {
  outputPath: string
  thumbnailDataUrl: string
  width: number
  height: number
  quality: QualitySignal
}

export type QualityAnalysis = {
  width: number
  height: number
  bytes: number
  quality: QualitySignal
}

export type CommitResult = {
  outputPath: string
  backupPath: string
}

// A transient message, plus the way to take back what it reports when that
// action is reversible.
export type Notice = {
  message: string
  action?: { label: string; run: () => Promise<void> | void }
}

export type RevertResult = {
  outputPath: string
  restoredFrom: string
}

export type SvgConversionResult = {
  convertedCount: number
  backupFolder: string
  failed: Array<{ path: string; reason: string }>
}

export type QwenAddress = {
  workspace: string
  region: QwenRegion
}

export type GeminiRequest = {
  projectPath: string
  imagePath: string
  prompt: string
  // Which model to send this to. Absent falls back to the default.
  model?: string
  imageSize: ImageSize
  completeEdges?: boolean
  canvasBackground?: string
  // The colour the artwork is cut out onto. Absent leaves the surround alone.
  isolateOn?: string
  // Pads the input out to a square on pure black before sending. Image models
  // follow the frame they are given, so a coaster photographed at an angle
  // inside an oblong frame comes back as an ellipse no matter how the prompt is
  // worded. A square frame is what lets the circle be a circle.
  squareCanvas?: boolean
}

// Asking a vision model to read one image and write the reconstruction prompt
// for it. The instruction is built in the renderer beside the preset prompts,
// so the main process only carries the call.
export type AuthoredPromptRequest = {
  imagePath: string
  instruction: string
}

export type AuthoredPromptResult = {
  prompt: string
  model: string
}

export type GeminiResult = ProcessResult & {
  model: string
  responseText?: string
}

export type ExportEntry = {
  imageId: string
  sourcePath: string
  outputPath?: string
  issues: IssueType[]
}

export type ExportResult = {
  outputFolder: string
  count: number
  manifestPath: string
}

export type ConnectionResult = {
  ok: boolean
  message: string
}

export type BackgroundColorResult = {
  color: string
}

export type RotationDetectionResult = {
  rotation: number
  confidence: number
}

export type PaletteAnalysisResult = {
  recommendedColors: number
  // The recommended palette: the first `recommendedColors` candidates.
  swatches: string[]
  confidence: number
  // Every distinct colour the analysis found, strongest first, up to 16. A
  // manual count of N flattens to the first N of these, so the interface can
  // show exactly what any count will produce without asking again.
  candidates: string[]
}

export type EditorPreviewResult = {
  dataUrl: string
}

export type DuplicateDeletionGroup = {
  keeperPath: string
  deletePaths: string[]
}

export type DuplicateDeletionResult = {
  deletedCount: number
  failed: Array<{ path: string; reason: string }>
}

// The words a native delete dialog shows, supplied by the renderer so the
// dialog follows the interface language. Absent means the English defaults.
export type DeletionLabels = {
  title: string
  message: string
  detail: string
  cancel: string
  confirm: string
}

export type ImageDeletionResult = {
  deleted: boolean
}

// One confirmation covers the whole selection, so the result counts what went
// and names what did not rather than answering yes or no.
export type BulkDeletionResult = {
  deletedCount: number
  failed: Array<{ path: string; reason: string }>
  cancelled?: boolean
}

export type MoodPrepApi = {
  selectFolder: () => Promise<string | null>
  scanFolder: (folder: string, recursive: boolean) => Promise<ScanResult>
  refreshImage: (folder: string, imagePath: string) => Promise<ImageRecord>
  duplicateImage: (folder: string, imagePath: string) => Promise<ImageRecord>
  convertSvgs: (folder: string, recursive: boolean) => Promise<SvgConversionResult>
  loadProject: (folder: string) => Promise<ProjectState | null>
  saveProject: (state: ProjectState) => Promise<void>
  processImage: (request: ProcessRequest) => Promise<ProcessResult>
  analyzeQuality: (imagePath: string) => Promise<QualityAnalysis>
  detectBackground: (imagePath: string) => Promise<BackgroundColorResult>
  detectRotation: (imagePath: string) => Promise<RotationDetectionResult>
  samplePixel: (imagePath: string, x: number, y: number) => Promise<BackgroundColorResult>
  fillArea: (request: FillRequest) => Promise<ProcessResult>
  detectPalette: (imagePath: string) => Promise<PaletteAnalysisResult>
  detectDominantColors: (imagePath: string, count?: number) => Promise<string[]>
  // Deletes every preview not named in `keep`. Previews are scratch files, so
  // this runs after a scan and when the workbench closes.
  prunePreviews: (folder: string, keep: string[]) => Promise<{ removed: number; bytes: number }>
  loadEditorPreview: (imagePath: string) => Promise<EditorPreviewResult>
  commitProcessedImage: (folder: string, sourcePath: string, previewPath: string) => Promise<CommitResult>
  revertCommittedImage: (folder: string, sourcePath: string, backupPath: string) => Promise<RevertResult>
  aiEdit: (request: GeminiRequest) => Promise<GeminiResult>
  authorPrompt: (request: AuthoredPromptRequest) => Promise<AuthoredPromptResult>
  saveApiKey: (provider: AiProvider, key: string) => Promise<void>
  // One flag per provider, so the interface can say which connections are live.
  apiKeyStatus: () => Promise<Record<AiProvider, boolean>>
  // Where the Qwen request is addressed: the workspace and which of the two
  // Model Studio regions the key belongs to. Neither is a credential.
  qwenAddress: () => Promise<QwenAddress>
  saveQwenAddress: (address: QwenAddress) => Promise<void>
  clearApiKey: (provider: AiProvider) => Promise<void>
  testApiKey: (provider: AiProvider) => Promise<ConnectionResult>
  deleteDuplicates: (folder: string, groups: DuplicateDeletionGroup[]) => Promise<DuplicateDeletionResult>
  deleteImage: (folder: string, imagePath: string, labels?: DeletionLabels) => Promise<ImageDeletionResult>
  deleteImages: (folder: string, imagePaths: string[], labels?: DeletionLabels) => Promise<BulkDeletionResult>
  exportSelection: (folder: string, entries: ExportEntry[]) => Promise<ExportResult>
  revealPath: (path: string) => Promise<void>
  copyText: (text: string) => Promise<void>
}
