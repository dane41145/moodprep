import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction } from 'react'
import { createPortal } from 'react-dom'
import {
  Aperture,
  Archive,
  ArrowDownUp,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  Copy,
  CopyPlus,
  Crop,
  Droplet,
  Eye,
  FolderOpen,
  Image as ImageIcon,
  Images,
  KeyRound,
  Layers,
  LoaderCircle,
  Minus,
  Paintbrush,
  PaintBucket,
  Pipette,
  RotateCw,
  RotateCcw,
  ScanSearch,
  Search,
  Settings,
  Ratio,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Upload,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
  Redo2,
} from 'lucide-react'
import { RECOLOUR_VARIATIONS } from '../shared/recolour'
import { LanguageContext, LANGUAGES, localeFor, readStoredLanguage, storeLanguage, translate, useLanguage, type Language, type Translate } from './i18n'
import { AI_BACKDROPS, AI_MODELS, backdropById, DEFAULT_AI_BACKDROP, DEFAULT_AI_MODEL, DEFAULT_QWEN_REGION, IMAGE_SIZES, modelById, modelForSize, modelsForSize, PROVIDER_LABELS, QWEN_REGIONS, type AiProvider, type QwenRegion } from '../shared/models'
import { ISSUE_TYPES, KNOWN_CLEAN_WATERMARK_FILENAMES, type CropInsets, type ImageDecision, type ImageRecord, type IssueType, type Notice, type PaintBrushShape, type PaintPoint, type PaintStroke, type PaletteAnalysisResult, type ProcessRequest, type ProcessResult, type ProjectState, type ImageSize, type ScanResult, type SvgConversionResult } from '../shared/types'
import { appendRevision, peekRevision, backdropPhrase, translateQualityReason, BORDER_DEFAULT, ROTATION_LIMIT, BORDER_MAX, BORDER_MIN, borderedSize, borderPixels, brushMaxPixels, clampBorder, bulkTagAction, bulkTagState, brushPixelsFromSize, brushPixelsFromSlider, brushSizeFromPixels, brushSliderPosition, BRUSH_MIN_PIXELS, BRUSH_SLIDER_STEPS, buildGeminiPrompt, buildGeminiPresetPrompt, buildPromptAuthorInstruction, cleanAuthoredPrompt, canAcceptQuality, cropPixelSize, describeSortValue, isTextEntryElement, undoRedoIntent, exactDuplicateGroups, formatBytes, GEMINI_PRESETS, humanIssue, naturalSortDirection, nearDuplicateGroups, normalizedPointInRect, normalizeHexColor, pointerOverVisibleImage, visibleImageRect, selectionRange, QUALITY_RECOMMENDED_SCORE, sortDirectionLabel, sortImages, SORT_OPTIONS, squareCropInsets, stageImageGeometry, stageViewFraction, stageViewOffset, type DuplicateGroup, type GeminiPresetId, type SortDirection, type SortKey } from './utils'

// The workflow used to be three wizard steps in a sidebar. Everything now
// lives on one library screen; these quick filters are both the collection's
// headline counts and the way to narrow the grid.
// White and black first, because the rest of the pipeline leans on them — a
// coaster isolated on black is swapped to white from here in one click — then
// the greys a blank tee is actually stocked in, lightest first. Ash and
// athletic heather are the pale blanks most designs are printed on; sport grey
// and dark heather the darker pair. The image's own colours follow these.
// Cards mounted per step. Enough to fill the tallest window twice over, so
// the next batch is always fetched before the user reaches the end of this one.
const GRID_PAGE = 120

// Not garment colours: two colours no vintage printed label is ever going to
// contain, offered so a fill or a replace can be keyed. To swap one colour for
// another where the first also appears somewhere it must not change, fill the
// region with a key first — nothing else in the artwork can match it — then
// Replace that key globally with the colour you actually want. They live in
// their own row after the garment blanks because they are a tool rather than a
// thing to judge the design against, and they must never be a garment preset.
const KEY_COLOURS: Array<{ color: string; label: string }> = [
  { color: '#ff00ff', label: 'Key magenta' },
  { color: '#00ff00', label: 'Key green' },
]

const GARMENT_COLOURS: Array<{ color: string; label: string }> = [
  { color: '#ffffff', label: 'Pure white' },
  { color: '#000000', label: 'Pure black' },
  { color: '#dfe0e2', label: 'Ash' },
  { color: '#bfc1c3', label: 'Athletic heather' },
  { color: '#97999b', label: 'Sport grey' },
  { color: '#3f4448', label: 'Dark heather' },
]

type QuickFilter = 'all' | 'flagged' | 'processed' | 'clean'

// Click-to-sample tools that share the paint capture layer.
type SampleMode = 'pick' | 'fill' | 'replace' | null
type CanvasTool = 'crop' | 'paint' | 'pick' | 'fill' | 'replace'

// Lucide has no glyph for swapping one colour for another. Blend, the nearest
// thing, is two thin overlapping circles that read as decoration rather than a
// tool at the 16px the strip uses — beside the crisp crop, brush, pipette and
// bucket shapes it looked like a missing icon. This says the actual operation
// in the same stroke language: the new colour laid over the old one.
function ReplaceColour({ size = 16 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2" width="13" height="13" rx="2.5" />
      <rect x="9" y="9" width="13" height="13" rx="2.5" fill="currentColor" />
    </svg>
  )
}

// The five pointer modes are mutually exclusive, so they are presented as one
// strip with only the active tool's options showing beneath it.
const CANVAS_TOOLS: Array<{ id: CanvasTool; label: string; icon: (props: { size?: number }) => ReactNode; hint: string }> = [
  { id: 'crop', label: 'Crop', icon: Crop, hint: 'Drag the frame on the preview' },
  { id: 'paint', label: 'Paint', icon: Paintbrush, hint: 'Brush the working colour onto the image' },
  { id: 'pick', label: 'Pick', icon: Pipette, hint: 'Click the preview to take its colour' },
  { id: 'fill', label: 'Fill', icon: PaintBucket, hint: 'Click an area to flood it with the working colour' },
  { id: 'replace', label: 'Replace', icon: ReplaceColour, hint: 'Click a colour to swap it for the working colour everywhere' },
]

const EMPTY_CROP: CropInsets = { left: 0, right: 0, top: 0, bottom: 0 }

const QUICK_FILTERS: Array<{ id: QuickFilter; label: string }> = [
  { id: 'all', label: 'All images' },
  { id: 'flagged', label: 'Needs work' },
  { id: 'processed', label: 'Processed' },
  { id: 'clean', label: 'Untouched' },
]

const SORT_STORAGE_KEY = 'moodprep.librarySort'

// The chosen order is a working preference, not project data, so it is kept
// per machine rather than written into the folder's project.json.
function readStoredSort(): { key: SortKey; direction: SortDirection } {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SORT_STORAGE_KEY) ?? 'null')
    const key = SORT_OPTIONS.find((option) => option.id === stored?.key)?.id
    if (!key) return { key: 'name', direction: 'asc' }
    return { key, direction: stored?.direction === 'desc' ? 'desc' : 'asc' }
  } catch {
    return { key: 'name', direction: 'asc' }
  }
}

function defaultDecision(image: ImageRecord): ImageDecision {
  return {
    status: 'keep',
    issues: image.processed ? [] : image.suggestedIssues,
    sourcePath: image.path,
    processedAt: image.processed ? new Date().toISOString() : undefined,
    backupAcknowledged: image.processed || undefined,
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// The wording of the native delete confirmation, in the interface language.
function deletionLabels(t: Translate, names: string[]) {
  const listed = names.slice(0, 8).join('\n') + (names.length > 8 ? '\n' + t('…and {n} more', { n: names.length - 8 }) : '')
  return {
    title: names.length === 1 ? t('Delete image from folder?') : t('Delete images from folder?'),
    message: names.length === 1 ? t('Move {name} to Trash?', { name: names[0] }) : t('Move {n} images to Trash?', { n: names.length }),
    detail: (names.length === 1 ? '' : listed + '\n\n') + t('They will be removed from this collection. Existing reference copies in moodprep-originals will be kept.'),
    cancel: t('Cancel'),
    confirm: names.length === 1 ? t('Move to Trash') : t('Move {n} to Trash', { n: names.length }),
  }
}

function qualitySuggestion(reason: string) {
  if (reason.startsWith('Short edge') || reason.includes('megapixels')) return 'Use 2× or 4× Resize, then inspect edges at 100%.'
  if (reason.includes('small data size')) return 'Try PNG or lossless WebP to avoid adding more compression.'
  if (reason.includes('Soft, spread, or ghosted edges')) return 'Reconstruct with Gemini when local resizing cannot restore the line work.'
  if (reason.includes('Colour bleed or uneven flat areas')) return 'Try Flatten colour noise before using reconstruction.'
  return 'No automated quality concerns detected; confirm the artwork visually.'
}

export default function App() {
  // The interface language is a per-machine preference, like the sort order.
  const [language, setLanguageState] = useState<Language>(readStoredLanguage)
  const t = useCallback<Translate>((key, vars) => translate(language, key, vars), [language])
  const setLanguage = (next: Language) => { setLanguageState(next); storeLanguage(next) }
  useEffect(() => { document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en' }, [language])
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [decisions, setDecisions] = useState<Record<string, ImageDecision>>({})
  const [recursive, setRecursive] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  // A notice is a message and, when the action it reports can be taken back,
  // the way to take it back. Undo beats a confirmation dialog for anything
  // reversible: a dialog in front of a routine save is clicked through within
  // a day and then stops catching the misclick it was added for.
  const [notice, setNoticeState] = useState<Notice | null>(null)
  // Most notices are just a line of text, so the setter takes a bare string as
  // well and wraps it. Only the ones that can be taken back pass an action.
  const setNotice = useCallback((value: string | Notice | null) => {
    setNoticeState(typeof value === 'string' ? { message: value } : value)
  }, [])
  const [refreshingPaths, setRefreshingPaths] = useState<Set<string>>(new Set())
  // What the last intake could not convert. A toast is the wrong and only home
  // for this: an SVG that fails is left on disk and retried on the next launch,
  // so the same files fail every time and the one line that said so has scrolled
  // away five seconds later. Held here so the Collection sheet, which owns SVG
  // conversion status, can name the files and say why.
  const [svgFailures, setSvgFailures] = useState<SvgConversionResult['failed']>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [collectionOpen, setCollectionOpen] = useState(false)
  const [duplicatesTab, setDuplicatesTab] = useState<'exact' | 'near' | null>(null)
  const [keyStatus, setKeyStatus] = useState<Record<AiProvider, boolean>>({ gemini: false, qwen: false })

  useEffect(() => {
    window.moodprep?.apiKeyStatus().then(setKeyStatus).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!scan) return
    const timeout = window.setTimeout(() => {
      const state: ProjectState = {
        version: 4,
        folder: scan.folder,
        updatedAt: new Date().toISOString(),
        decisions,
      }
      window.moodprep.saveProject(state).catch((error) => setNotice(t('Could not save project: {error}', { error: errorMessage(error) })))
    }, 500)
    return () => window.clearTimeout(timeout)
  }, [decisions, scan])

  const intentionalCopies = useMemo(() => {
    const present = new Set((scan?.images ?? []).map((image) => image.path))
    return new Set(
      Object.values(decisions)
        .filter((decision) => decision.duplicateOf && present.has(decision.duplicateOf) && decision.sourcePath)
        .map((decision) => decision.sourcePath!),
    )
  }, [decisions, scan])
  const exactGroups = useMemo(() => exactDuplicateGroups(scan?.images ?? [], intentionalCopies), [scan, intentionalCopies])
  const nearGroups = useMemo(() => nearDuplicateGroups(scan?.images ?? [], 5, intentionalCopies), [scan, intentionalCopies])
  const excluded = Object.values(decisions).filter((decision) => decision.status === 'exclude').length
  const openFolder = async () => {
    try {
      const folder = await window.moodprep.selectFolder()
      if (!folder) return
      await runScan(folder)
    } catch (error) {
      setNotice(errorMessage(error))
    }
  }

  const runScan = async (folder = scan?.folder) => {
    if (!folder) return
    setBusy(t('Scanning images and updating quality scores…'))
    try {
      const conversion = await window.moodprep.convertSvgs(folder, recursive)
      const [result, stored] = await Promise.all([
        window.moodprep.scanFolder(folder, recursive),
        window.moodprep.loadProject(folder),
      ])
      const nextDecisions: Record<string, ImageDecision> = {}
      const storedByPath = new Map(
        Object.values(stored?.decisions ?? {})
          .filter((decision) => decision.sourcePath)
          .map((decision) => [decision.sourcePath!, decision]),
      )
      for (const image of result.images) {
        const existing = stored?.decisions[image.id] ?? storedByPath.get(image.path)
        const migrateDetections = existing && stored && stored.version < 3
        const previousIssues = migrateDetections && KNOWN_CLEAN_WATERMARK_FILENAMES.has(image.name.toLowerCase())
          ? existing.issues.filter((issue) => issue !== 'watermark')
          : existing?.issues
        // Version 4 adds automatic tilt detection: union only the fresh
        // rotation tag into stored decisions, so tags the user removed for
        // other issue types stay removed.
        const migrateRotation = existing && stored && stored.version < 4
        const migratedExisting = migrateDetections
          ? { ...existing, issues: [...new Set([...(previousIssues ?? []), ...image.suggestedIssues])] }
          : migrateRotation && image.suggestedIssues.includes('rotation_needed') && !existing.issues.includes('rotation_needed')
            ? { ...existing, issues: [...existing.issues, 'rotation_needed' as IssueType] }
            : existing
        const processedEvidence = image.processed || Boolean(existing?.outputPath)
        if (processedEvidence && !existing?.backupAcknowledged) {
          nextDecisions[image.id] = {
            ...(migratedExisting ?? defaultDecision(image)),
            issues: [],
            sourcePath: image.path,
            processedAt: new Date().toISOString(),
            backupAcknowledged: true,
          }
        } else {
          nextDecisions[image.id] = { ...(migratedExisting ?? defaultDecision(image)), sourcePath: image.path }
        }
      }
      setScan(result)
      setDecisions(nextDecisions)
      setSvgFailures(conversion.failed)
      void prunePreviews(folder, nextDecisions)
      const conversionNote = conversion.convertedCount
        ? ' ' + t(conversion.convertedCount === 1 ? 'Converted {n} SVG file to PNG; the SVG is in moodprep-originals.' : 'Converted {n} SVG files to PNG; the SVG files are in moodprep-originals.', { n: conversion.convertedCount })
        : ''
      // Say which way round the failure is. These files stay on disk and are
      // tried again on every launch, so a count with no verb read as a passing
      // hiccup rather than as a collection that will never finish converting.
      const failureNote = conversion.failed.length
        ? ' ' + t(conversion.failed.length === 1 ? '{n} SVG file could not be converted — see Collection.' : '{n} SVG files could not be converted — see Collection.', { n: conversion.failed.length })
        : ''
      setNotice(t('Indexed {n} images.', { n: result.images.length }) + conversionNote + failureNote)
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  // Previews are scratch: each revision writes one, a commit re-encodes the
  // chosen one into the source, and nothing points at the rest. They are
  // cleared after a scan and whenever the workbench closes, keeping only what
  // the project still names, so the folder no longer grows by the gigabyte.
  const prunePreviews = (folder: string, current: Record<string, ImageDecision>) =>
    window.moodprep.prunePreviews(folder, Object.values(current).map((decision) => decision.outputPath ?? '').filter(Boolean)).catch(() => undefined)

  const updateDecision = (imageId: string, update: Partial<ImageDecision>) => {
    setDecisions((current) => ({ ...current, [imageId]: { ...current[imageId], ...update } }))
  }

  // After an undo the file on disk is the original again, so the card has to be
  // re-read rather than patched: its dimensions, quality and thumbnail all
  // belong to the version that was just put back.
  const refreshRevertedImage = (restored: ImageRecord) => {
    const folder = scan?.folder
    if (!folder) return
    setRefreshingPaths((current) => new Set(current).add(restored.path))
    void window.moodprep.refreshImage(folder, restored.path)
      .then((refreshed) => {
        setScan((current) => current ? { ...current, images: current.images.map((image) => image.path === refreshed.path ? refreshed : image) } : current)
      })
      .catch(() => undefined)
      .finally(() => setRefreshingPaths((current) => {
        const next = new Set(current)
        next.delete(restored.path)
        return next
      }))
  }

  const refreshCommittedImage = (replaced: ImageRecord, accepted: ProcessResult) => {
    const folder = scan?.folder
    if (!folder) return
    setScan((current) => current ? {
      ...current,
      images: current.images.map((image) => image.id === replaced.id ? {
        ...image,
        width: accepted.width,
        height: accepted.height,
        thumbnailDataUrl: accepted.thumbnailDataUrl,
        quality: accepted.quality,
        processed: true,
      } : image),
    } : current)
    setRefreshingPaths((current) => new Set(current).add(replaced.path))
    void window.moodprep.refreshImage(folder, replaced.path)
      .then((refreshed) => {
        setScan((current) => current ? { ...current, images: current.images.map((image) => image.path === refreshed.path ? refreshed : image) } : current)
        setDecisions((current) => {
          const previous = current[replaced.id] ?? Object.values(current).find((decision) => decision.sourcePath === replaced.path) ?? defaultDecision(refreshed)
          const next = { ...current }
          delete next[replaced.id]
          next[refreshed.id] = {
            ...previous,
            issues: [],
            sourcePath: refreshed.path,
            processedAt: previous.processedAt ?? new Date().toISOString(),
            backupAcknowledged: true,
            outputPath: undefined,
            outputThumbnail: undefined,
            outputQuality: undefined,
          }
          return next
        })
      })
      .catch((error) => setNotice(t('The image was saved, but its card could not be refreshed: {error}', { error: errorMessage(error) })))
      .finally(() => setRefreshingPaths((current) => {
        const next = new Set(current)
        next.delete(replaced.path)
        return next
      }))
  }

  const duplicateImage = async (source: ImageRecord) => {
    const folder = scan?.folder
    if (!folder) return
    setBusy(t('Duplicating {name}…', { name: source.name }))
    try {
      const copy = await window.moodprep.duplicateImage(folder, source.path)
      setScan((current) => {
        if (!current) return current
        const index = current.images.findIndex((image) => image.path === source.path)
        const images = [...current.images]
        images.splice(index < 0 ? images.length : index + 1, 0, copy)
        return { ...current, images }
      })
      setDecisions((current) => ({
        ...current,
        [copy.id]: {
          ...(current[source.id] ?? defaultDecision(copy)),
          sourcePath: copy.path,
          duplicateOf: source.path,
          processedAt: undefined,
          backupAcknowledged: undefined,
          outputPath: undefined,
          outputThumbnail: undefined,
          outputQuality: undefined,
        },
      }))
      setNotice(t('Created {name}. It keeps the same tags and is left out of duplicate review.', { name: copy.name }))
    } catch (error) {
      setNotice(t('Could not duplicate {name}: {error}', { name: source.name, error: errorMessage(error) }))
    } finally {
      setBusy(null)
    }
  }

  const removeDeletedImage = (deleted: ImageRecord) => {
    setScan((current) => current ? { ...current, images: current.images.filter((image) => image.path !== deleted.path) } : current)
    setDecisions((current) => {
      const next = { ...current }
      for (const [id, decision] of Object.entries(next)) {
        if (id === deleted.id || decision.sourcePath === deleted.path) delete next[id]
      }
      return next
    })
  }

  // One state update for a whole batch: removing them one at a time re-renders
  // the grid per file and makes a ten-image delete look like a stutter.
  const removeDeletedImages = (deleted: ImageRecord[]) => {
    if (deleted.length === 0) return
    const paths = new Set(deleted.map((image) => image.path))
    const ids = new Set(deleted.map((image) => image.id))
    setScan((current) => current ? { ...current, images: current.images.filter((image) => !paths.has(image.path)) } : current)
    setDecisions((current) => {
      const next = { ...current }
      for (const [id, decision] of Object.entries(next)) {
        if (ids.has(id) || paths.has(decision.sourcePath ?? '')) delete next[id]
      }
      return next
    })
  }

  const chooseKeeper = (group: DuplicateGroup, keeperId: string) => {
    setDecisions((current) => {
      const next = { ...current }
      for (const image of group.images) next[image.id] = { ...next[image.id], status: image.id === keeperId ? 'keep' : 'exclude' }
      return next
    })
  }

  const deleteConfirmedDuplicates = async () => {
    if (!scan) return
    const groups = exactGroups.flatMap((group) => {
      const keeper = group.images.find((image) => decisions[image.id]?.status !== 'exclude')
      const deletePaths = group.images.filter((image) => decisions[image.id]?.status === 'exclude').map((image) => image.path)
      return keeper && deletePaths.length ? [{ keeperPath: keeper.path, deletePaths }] : []
    })
    const count = groups.reduce((sum, group) => sum + group.deletePaths.length, 0)
    if (!count) {
      setNotice(t('Choose a keeper in at least one exact-match group first.'))
      return
    }
    const confirmed = window.confirm(t(count === 1 ? 'Delete {n} confirmed exact copy from this folder?' : 'Delete {n} confirmed exact copies from this folder?', { n: count }) + '\n\n' + t('Each file is verified against its chosen keeper, then moved to the macOS Trash.'))
    if (!confirmed) return
    setBusy(t(count === 1 ? 'Deleting {n} verified duplicate copy…' : 'Deleting {n} verified duplicate copies…', { n: count }))
    try {
      const result = await window.moodprep.deleteDuplicates(scan.folder, groups)
      await runScan(scan.folder)
      setNotice(result.failed.length
        ? t('Deleted {n} copies; {failed} could not be verified or removed.', { n: result.deletedCount, failed: result.failed.length })
        : t('Deleted {n} confirmed copies from the folder. They can still be recovered from Trash.', { n: result.deletedCount }))
    } catch (error) {
      setNotice(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  if (!scan) {
    return (
      <LanguageContext.Provider value={{ language, t }}>
      <div className="welcome-shell">
        <div className="welcome-noise" />
        <header className="welcome-header">
          <Logo />
          <button className="icon-button light" onClick={() => setSettingsOpen(true)} aria-label={t('Open settings')}><Settings size={19} /></button>
        </header>
        <main className="welcome-main">
          <div className="eyebrow"><Sparkles size={15} /> {t('Local image preparation')}</div>
          <h1>{t('Clean the noise.')}<br /><em>{t('Keep the style.')}</em></h1>
          <p>{t('Review duplicates and repair technical defects directly in your Midjourney moodboard folder. Replaced originals are kept for reference.')}</p>
          <button className="primary-button large" onClick={openFolder} disabled={Boolean(busy)}>
            {busy ? <LoaderCircle className="spin" size={20} /> : <FolderOpen size={20} />}
            {t('Choose image folder')}
          </button>
          <div className="welcome-features">
            <span><Check size={15} /> {t('Originals backed up automatically')}</span>
            <span><Check size={15} /> {t('SVG, JPG, PNG & WebP')}</span>
            <span><Check size={15} /> {t('AI only when you approve')}</span>
          </div>
        </main>
        <div className="welcome-art" aria-hidden="true">
          <div className="frame frame-one"><ImageIcon /></div>
          <div className="frame frame-two"><Aperture /></div>
          <div className="frame frame-three"><Crop /></div>
        </div>
        {busy && <BusyOverlay message={busy} />}
        {settingsOpen && <SettingsDialog keyStatus={keyStatus} onStatus={setKeyStatus} language={language} onLanguage={setLanguage} onClose={() => setSettingsOpen(false)} />}
        {notice && <Toast notice={notice} onClose={() => setNotice(null)} />}
      </div>
      </LanguageContext.Provider>
    )
  }

  const exactCopies = exactGroups.reduce((sum, group) => sum + group.images.length - 1, 0)
  const duplicateAttention = exactCopies + nearGroups.length

  return (
    <LanguageContext.Provider value={{ language, t }}>
    <div className="app-shell">
      <header className="topbar">
        <Logo />
        <div className="topbar-folder">
          <span>{t('Collection')}</span>
          <button className="folder-button" title={t('Reveal {folder}', { folder: scan.folder })} onClick={() => window.moodprep.revealPath(scan.folder)}>
            <FolderOpen size={14} /> {scan.folder.split('/').pop()}
          </button>
        </div>
        <div className="topbar-actions">
          <button className={`chip-button ${duplicateAttention ? 'attention' : ''}`} onClick={() => setDuplicatesTab(exactCopies ? 'exact' : 'near')}>
            <Copy size={15} /> {t('Duplicates')} {duplicateAttention > 0 && <b>{duplicateAttention}</b>}
          </button>
          <button className="chip-button" onClick={() => setCollectionOpen(true)}><ScanSearch size={15} /> {t('Collection')}</button>
          <button className="icon-button" onClick={() => runScan()} aria-label={t('Rescan folder')} title={t('Rescan folder')}><RotateCcw size={17} /></button>
          <button className="icon-button" onClick={openFolder} aria-label={t('Change folder')} title={t('Open a different folder')}><FolderOpen size={17} /></button>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label={t('Open settings')} title={t('Settings')}><Settings size={17} /></button>
        </div>
      </header>

      <LibraryView
        scan={scan}
        decisions={decisions}
        excluded={excluded}
        updateDecision={updateDecision}
        refreshingPaths={refreshingPaths}
        keyStatus={keyStatus}
        openSettings={() => setSettingsOpen(true)}
        exactCopies={exactCopies}
        nearGroupCount={nearGroups.length}
        openDuplicates={setDuplicatesTab}
        onNotice={setNotice}
        onBusy={setBusy}
        onCommitted={refreshCommittedImage}
        onReverted={refreshRevertedImage}
        onDeleted={removeDeletedImage}
        onDeletedMany={removeDeletedImages}
        onDuplicated={duplicateImage}
        onEditorClosed={() => void prunePreviews(scan.folder, decisions)}
      />

      {duplicatesTab && <DuplicatesDialog tab={duplicatesTab} setTab={setDuplicatesTab} exactGroups={exactGroups} nearGroups={nearGroups} decisions={decisions} chooseKeeper={chooseKeeper} updateDecision={updateDecision} onDelete={deleteConfirmedDuplicates} onClose={() => setDuplicatesTab(null)} />}
      {collectionOpen && <CollectionDialog scan={scan} exactCopies={exactCopies} nearGroupCount={nearGroups.length} excluded={excluded} recursive={recursive} setRecursive={setRecursive} svgFailures={svgFailures} onRescan={() => runScan()} onChangeFolder={openFolder} onClose={() => setCollectionOpen(false)} />}
      {busy && <BusyOverlay message={busy} />}
      {settingsOpen && <SettingsDialog keyStatus={keyStatus} onStatus={setKeyStatus} language={language} onLanguage={setLanguage} onClose={() => setSettingsOpen(false)} />}
      {notice && <Toast notice={notice} onClose={() => setNotice(null)} />}
    </div>
    </LanguageContext.Provider>
  )
}

function Logo() {
  return <div className="logo"><span><Aperture size={22} /></span><strong>MoodPrep</strong></div>
}

function CollectionDialog({ scan, exactCopies, nearGroupCount, excluded, recursive, setRecursive, svgFailures, onRescan, onChangeFolder, onClose }: {
  scan: ScanResult
  exactCopies: number
  nearGroupCount: number
  excluded: number
  recursive: boolean
  setRecursive: (value: boolean) => void
  svgFailures: SvgConversionResult['failed']
  onRescan: () => void
  onChangeFolder: () => void
  onClose: () => void
}) {
  const formats = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const image of scan.images) counts[image.extension.toUpperCase()] = (counts[image.extension.toUpperCase()] ?? 0) + 1
    return Object.entries(counts).sort((a, b) => b[1] - a[1])
  }, [scan.images])
  const lowQuality = scan.images.filter((image) => image.suggestedIssues.includes('low_quality')).length
  const svgCount = scan.images.filter((image) => image.extension === 'svg').length
  const { t, language } = useLanguage()
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t('Collection')}>
      <div className="sheet-dialog">
        <header>
          <div><span>{t('Collection')}</span><strong title={scan.folder}>{scan.folder}</strong></div>
          <button className="icon-button" onClick={onClose} aria-label={t('Close')}><X size={18} /></button>
        </header>
        <div className="sheet-body">
          <div className="stat-grid">
            <StatCard icon={ImageIcon} value={scan.images.length} label={t('Images indexed')} accent="ink" />
            <StatCard icon={Copy} value={exactCopies} label={t('Exact copies')} accent="red" />
            <StatCard icon={ScanSearch} value={nearGroupCount} label={t('Near-match groups')} accent="orange" />
            <StatCard icon={CircleAlert} value={lowQuality} label={t('Low-quality flags')} accent="blue" />
          </div>
          <div className="split-grid">
            <div className="panel">
              <div className="panel-heading"><div><span>{t('Collection makeup')}</span><h3>{t('Formats')}</h3></div><small>{t('{n} unsupported files ignored', { n: scan.ignoredFiles })}</small></div>
              <div className="format-list">
                {formats.map(([format, count]) => (
                  <div key={format}><strong>{format}</strong><span><i style={{ width: `${(count / scan.images.length) * 100}%` }} /></span><b>{count}</b></div>
                ))}
              </div>
              <label className="toggle-row">
                <span><strong>{t('Include subfolders')}</strong><small>{t('Scan nested image folders up to 12 levels')}</small></span>
                <input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />
                <i />
              </label>
              <button className="text-button" onClick={onRescan}><RotateCcw size={15} /> {t('Rescan with this setting')}</button>
            </div>
            <div className="panel conversion-panel">
              <div className="conversion-icon"><span>SVG</span><ChevronRight /><span>PNG</span></div>
              {/* A file that fails is left on disk and tried again on the next
                  launch, so an unconverted SVG is "pending" only until it has
                  been tried. Once intake has reported one, calling it pending
                  is the thing that hid a broken conversion for weeks. */}
              <h3>{svgFailures.length
                ? t(svgFailures.length === 1 ? '{n} vector file could not be converted' : '{n} vector files could not be converted', { n: svgFailures.length })
                : svgCount ? t(svgCount === 1 ? '{n} vector file pending' : '{n} vector files pending', { n: svgCount }) : t('SVG conversion complete')}</h3>
              <p>{t('SVG sources become clean 2048 px PNG files during intake. Source vectors move to moodprep-originals for reference.')}</p>
              {svgFailures.length > 0 && (
                <ul className="conversion-failures">
                  {svgFailures.map((failure) => (
                    <li key={failure.path}>
                      <strong title={failure.path}>{failure.path.split('/').pop()}</strong>
                      <small>{failure.reason}</small>
                    </li>
                  ))}
                </ul>
              )}
              <div className="safe-note">
                {svgFailures.length
                  ? <><CircleAlert size={16} /> {t('These stay as SVG and are retried on every scan')}</>
                  : <><Check size={16} /> {t('Replaced originals are backed up')}</>}
              </div>
            </div>
          </div>
        </div>
        <footer>
          <span><Check size={15} /> {t('{included} of {total} images included · scanned {time}', { included: scan.images.length - excluded, total: scan.images.length, time: new Date(scan.scannedAt).toLocaleTimeString(localeFor(language), { hour: '2-digit', minute: '2-digit' }) })}{scan.analysed > 0 ? t(' · {n} new or changed', { n: scan.analysed }) : scan.images.length > 0 ? t(' · nothing changed since the last scan') : ''}</span>
          <div>
            <button className="secondary-button" onClick={onChangeFolder}><FolderOpen size={16} /> {t('Change folder')}</button>
            <button className="primary-button" onClick={onClose}>{t('Done')}</button>
          </div>
        </footer>
      </div>
    </div>
  )
}

function DuplicatesDialog({ tab, setTab, exactGroups, nearGroups, decisions, chooseKeeper, updateDecision, onDelete, onClose }: {
  tab: 'exact' | 'near'
  setTab: (tab: 'exact' | 'near') => void
  exactGroups: DuplicateGroup[]
  nearGroups: DuplicateGroup[]
  decisions: Record<string, ImageDecision>
  chooseKeeper: (group: DuplicateGroup, imageId: string) => void
  updateDecision: (id: string, update: Partial<ImageDecision>) => void
  onDelete: () => void
  onClose: () => void
}) {
  const groups = tab === 'exact' ? exactGroups : nearGroups
  const exactExcluded = exactGroups.flatMap((group) => group.images).filter((image) => decisions[image.id]?.status === 'exclude').length
  const { t } = useLanguage()
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t('Duplicates')}>
      <div className="sheet-dialog wide">
        <header>
          <div><span>{t('Duplicates')}</span><strong>{t('Keep the strongest version')}</strong></div>
          <button className="icon-button" onClick={onClose} aria-label={t('Close')}><X size={18} /></button>
        </header>
        <div className="sheet-body">
          <p className="sheet-note">{t('Exact copies are certain. Near matches are suggestions only — related brand artwork should remain separate.')}</p>
          <div className="tab-row">
            <button className={tab === 'exact' ? 'active' : ''} onClick={() => setTab('exact')}>{t('Exact copies')} <span>{exactGroups.length}</span></button>
            <button className={tab === 'near' ? 'active' : ''} onClick={() => setTab('near')}>{t('Visual matches')} <span>{nearGroups.length}</span></button>
            {tab === 'exact' && exactGroups.length > 0 && <button className="apply-recommended" onClick={() => exactGroups.forEach((group) => chooseKeeper(group, group.recommendedId))}><Sparkles size={13} /> {t('Apply all recommendations')}</button>}
            {tab === 'exact' && exactExcluded > 0 && <button className="delete-duplicates" onClick={onDelete}><Trash2 size={13} /> {t(exactExcluded === 1 ? 'Delete {n} confirmed copy' : 'Delete {n} confirmed copies', { n: exactExcluded })}</button>}
          </div>
          {groups.length === 0 ? (
            <EmptyState icon={Copy} title={tab === 'exact' ? t('No exact copies found') : t('No close visual matches found')} body={t('Nothing needs your attention in this category.')} />
          ) : (
            <div className="duplicate-list">
              {groups.map((group, index) => (
                <div className="duplicate-group" key={group.id}>
                  <div className="duplicate-heading">
                    <div><span>{group.type === 'exact' ? t('Exact match') : t('Review match')} {String(index + 1).padStart(2, '0')}</span><strong>{t('{n} versions', { n: group.images.length })}</strong></div>
                    <button className="text-button" onClick={() => group.images.forEach((image) => updateDecision(image.id, { status: 'keep' }))}>{t('Keep all as different')}</button>
                  </div>
                  <div className="duplicate-images">
                    {group.images.map((image) => {
                      const selected = decisions[image.id]?.status === 'keep' && group.images.filter((candidate) => decisions[candidate.id]?.status === 'keep').length === 1
                      const recommended = image.id === group.recommendedId
                      return (
                        <button key={image.id} className={`duplicate-card ${selected ? 'selected' : ''}`} onClick={() => chooseKeeper(group, image.id)}>
                          <div className="duplicate-thumb"><img src={image.thumbnailDataUrl} alt="" />{recommended && <span className="recommendation"><Sparkles size={12} /> {t('Recommended')}</span>}</div>
                          <div className="duplicate-meta"><strong title={image.name}>{image.name}</strong><span>{image.width} × {image.height} · {formatBytes(image.bytes)}</span></div>
                          <div className="quality-line"><i style={{ width: `${image.quality.score}%` }} /><span>{image.quality.score}</span></div>
                          <div className="keeper-choice"><span>{selected ? <Check size={15} /> : null}</span>{selected ? t('Chosen keeper') : t('Choose this one')}</div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <footer>
          <span><Check size={15} /> {t('Excluded copies stay on disk until you delete them explicitly')}</span>
          <button className="primary-button" onClick={onClose}>{t('Back to library')}</button>
        </footer>
      </div>
    </div>
  )
}

function LibraryView({ scan, decisions, excluded, updateDecision, refreshingPaths, keyStatus, openSettings, exactCopies, nearGroupCount, openDuplicates, onNotice, onBusy, onCommitted, onReverted, onDeleted, onDeletedMany, onDuplicated, onEditorClosed }: {
  scan: ScanResult
  decisions: Record<string, ImageDecision>
  excluded: number
  updateDecision: (id: string, update: Partial<ImageDecision>) => void
  refreshingPaths: Set<string>
  keyStatus: Record<AiProvider, boolean>
  openSettings: () => void
  exactCopies: number
  nearGroupCount: number
  openDuplicates: (tab: 'exact' | 'near') => void
  onNotice: (notice: string | Notice) => void
  onBusy: (message: string | null) => void
  onCommitted: (image: ImageRecord, accepted: ProcessResult) => void
  onReverted: (image: ImageRecord) => void
  onDeleted: (image: ImageRecord) => void
  onDeletedMany: (images: ImageRecord[]) => void
  onDuplicated: (image: ImageRecord) => void
  onEditorClosed: () => void
}) {
  const { t, language } = useLanguage()
  const [search, setSearch] = useState('')
  const [issueFilter, setIssueFilter] = useState<IssueType | 'all'>('all')
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all')
  const [sort, setSort] = useState(readStoredSort)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deletingSelection, setDeletingSelection] = useState(false)
  // How many cards are mounted. Every card carries its thumbnail inline, so the
  // whole collection at once is 16 MB of DOM: measured on 1352 images that is
  // 1.3 seconds of blocked main thread before the browser even starts decoding
  // 1352 JPEGs. A screenful at a time costs 163 ms and the rest arrives as it
  // is scrolled to. Filtering, sorting, selection and the counts all still work
  // on the whole list — only the DOM is windowed.
  const [mounted, setMounted] = useState(GRID_PAGE)
  const gridSentinel = useRef<HTMLDivElement | null>(null)
  const [editing, setEditing] = useState<ImageRecord | null>(null)
  // Where a shift-click measures from: the last checkbox actually touched.
  const selectionAnchor = useRef<string | null>(null)

  useEffect(() => {
    try { window.localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort)) } catch { /* A blocked storage quota must not break sorting. */ }
  }, [sort])

  // Resolve each image's decision once per change rather than per filter pass:
  // the fallback lookup scans every decision, and a large collection would pay
  // that cost several times over on every render.
  const resolved = useMemo(() => scan.images.map((image) => ({
    image,
    decision: decisions[image.id] ?? Object.values(decisions).find((entry) => entry.sourcePath === image.path) ?? defaultDecision(image),
    excluded: decisions[image.id]?.status === 'exclude',
  })), [scan.images, decisions])
  const decisionById = useMemo(() => new Map(resolved.map((entry) => [entry.image.id, entry.decision])), [resolved])

  const counts = useMemo(() => {
    const included = resolved.filter((entry) => !entry.excluded)
    const isProcessed = (entry: typeof included[number]) => Boolean(entry.decision.outputPath || entry.decision.processedAt || entry.image.processed)
    return {
      all: included.length,
      flagged: included.filter((entry) => entry.decision.issues.length > 0).length,
      processed: included.filter(isProcessed).length,
      clean: included.filter((entry) => entry.decision.issues.length === 0 && !isProcessed(entry)).length,
    }
  }, [resolved])

  const images = useMemo(() => {
    const term = search.trim().toLowerCase()
    const matching = resolved.filter(({ image, decision, excluded: isExcluded }) => {
      if (isExcluded) return false
      if (term && !image.name.toLowerCase().includes(term)) return false
      if (issueFilter !== 'all' && !decision.issues.includes(issueFilter)) return false
      const isProcessed = Boolean(decision.outputPath || decision.processedAt || image.processed)
      if (quickFilter === 'flagged' && decision.issues.length === 0) return false
      if (quickFilter === 'processed' && !isProcessed) return false
      if (quickFilter === 'clean' && (decision.issues.length > 0 || isProcessed)) return false
      return true
    }).map((entry) => entry.image)
    return sortImages(matching, sort.key, sort.direction)
  }, [resolved, search, issueFilter, quickFilter, sort])

  // The images the bar is actually about. A selection made before a filter
  // changed can hold images the grid is no longer showing, and every bulk
  // action — deletion above all — must be able to say so rather than acting on
  // work the user cannot see.
  const shownIds = useMemo(() => images.map((image) => image.id), [images])
  const selectedShown = useMemo(() => images.filter((image) => selected.has(image.id)), [images, selected])
  const hiddenSelected = selected.size - selectedShown.length

  const toggleSelected = (imageId: string, extend = false) => {
    setSelected((current) => {
      const next = new Set(current)
      const anchor = selectionAnchor.current
      // Shift-click fills in everything between the last checkbox touched and
      // this one, which is what turns twenty clicks into two.
      const span = extend && anchor && anchor !== imageId ? selectionRange(shownIds, anchor, imageId) : [imageId]
      const turningOn = span.length > 1 ? true : !next.has(imageId)
      for (const id of span) {
        if (turningOn) next.add(id)
        else next.delete(id)
      }
      return next
    })
    selectionAnchor.current = imageId
  }
  const selectAllShown = () => {
    setSelected(new Set(shownIds))
    selectionAnchor.current = shownIds[shownIds.length - 1] ?? null
  }
  const clearSelection = () => {
    setSelected(new Set())
    selectionAnchor.current = null
  }
  const keepOnlyShown = () => setSelected(new Set(selectedShown.map((image) => image.id)))

  // A tag reads its state from the selection and a press ends in that state on
  // every image, rather than flipping each one against the others.
  const tagStates = useMemo(() => {
    const lists = [...selected].map((id) => decisionById.get(id)?.issues ?? [])
    return Object.fromEntries(ISSUE_TYPES.map((issue) => [issue, bulkTagState(lists, issue)])) as Record<IssueType, ReturnType<typeof bulkTagState>>
  }, [selected, decisionById])

  const applyIssue = (issue: IssueType) => {
    const action = bulkTagAction(tagStates[issue])
    for (const id of selected) {
      const issues = decisions[id]?.issues ?? []
      if (action === 'add' && !issues.includes(issue)) updateDecision(id, { issues: [...issues, issue] })
      if (action === 'remove' && issues.includes(issue)) updateDecision(id, { issues: issues.filter((item) => item !== issue) })
    }
  }

  const deleteSelected = async () => {
    const targets = scan.images.filter((image) => selected.has(image.id))
    if (targets.length === 0 || deletingSelection) return
    setDeletingSelection(true)
    try {
      const result = await window.moodprep.deleteImages(scan.folder, targets.map((image) => image.path), deletionLabels(t, targets.map((image) => image.name)))
      if (result.cancelled) return
      const failedPaths = new Set(result.failed.map((entry) => entry.path))
      const removed = targets.filter((image) => !failedPaths.has(image.path))
      if (removed.length > 0) {
        onDeletedMany(removed)
        setSelected((current) => {
          const next = new Set(current)
          for (const image of removed) next.delete(image.id)
          return next
        })
      }
      if (result.failed.length > 0) {
        onNotice(t('{n} moved to Trash · {failed} could not be deleted: {reason}', { n: removed.length, failed: result.failed.length, reason: result.failed[0].reason }))
      } else if (removed.length > 0) {
        onNotice(t(removed.length === 1 ? '{n} image moved to Trash. They can still be recovered from there.' : '{n} images moved to Trash. They can still be recovered from there.', { n: removed.length }))
      }
    } catch (error) {
      onNotice(t('Could not delete the selection: {error}', { error: errorMessage(error) }))
    } finally {
      setDeletingSelection(false)
    }
  }
  // A new filter, search or sort is a new list, so the window starts again.
  useEffect(() => { setMounted(GRID_PAGE) }, [images])

  // Extend as the end comes into view rather than on a scroll handler, so the
  // work happens once per batch instead of once per frame.
  useEffect(() => {
    const sentinel = gridSentinel.current
    if (!sentinel || mounted >= images.length) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setMounted((current) => Math.min(current + GRID_PAGE, images.length))
    }, { rootMargin: '600px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [mounted, images.length])

  // Selecting is a keyboard job as much as a pointer one: Escape is the way out
  // of a selection everywhere else, and Select all needs its shortcut. Both stay
  // out of the way of the workbench, which owns the keyboard while it is open.
  useEffect(() => {
    if (editing) return
    const onKey = (event: KeyboardEvent) => {
      if (isTextEntryElement(event.target as HTMLElement | null)) return
      if (event.key === 'Escape' && selected.size > 0) {
        clearSelection()
        return
      }
      if (event.key.toLowerCase() === 'a' && (event.metaKey || event.ctrlKey) && images.length > 0) {
        event.preventDefault()
        selectAllShown()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, images, selected.size])

  // Picking a different key restores that key's natural reading order — names
  // ascend, dates and sizes lead with the newest and largest — so the list is
  // never left sorted oldest-first just because the previous key was a name.
  const changeSortKey = (key: SortKey) => setSort({ key, direction: naturalSortDirection(key) })
  const toggleSortDirection = () => setSort((current) => ({ ...current, direction: current.direction === 'asc' ? 'desc' : 'asc' }))
  const filtered = images.length !== counts[quickFilter] || Boolean(search.trim()) || issueFilter !== 'all'

  return (
    <main className="library">
      <div className="library-toolbar">
        <div className="filter-chips" role="group" aria-label={t('Quick filters')}>
          {QUICK_FILTERS.map((filter) => (
            <button key={filter.id} className={quickFilter === filter.id ? 'active' : ''} onClick={() => setQuickFilter(filter.id)} aria-pressed={quickFilter === filter.id}>
              {t(filter.label)} <b>{counts[filter.id]}</b>
            </button>
          ))}
          <span className="chip-divider" />
          <button className="link-chip" onClick={() => openDuplicates('exact')}><Copy size={13} /> {t(exactCopies === 1 ? '{n} exact copy' : '{n} exact copies', { n: exactCopies })}</button>
          <button className="link-chip" onClick={() => openDuplicates('near')}><Layers size={13} /> {t(nearGroupCount === 1 ? '{n} near match' : '{n} near matches', { n: nearGroupCount })}</button>
          {excluded > 0 && <span className="excluded-chip">{t('{n} excluded', { n: excluded })}</span>}
        </div>
        <div className="toolbar-controls">
          <label className="search-box"><Search size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('Search filenames')} /></label>
          <select value={issueFilter} onChange={(event) => setIssueFilter(event.target.value as IssueType | 'all')} aria-label={t('Filter by issue')}>
            <option value="all">{t('All issues')}</option>
            {ISSUE_TYPES.map((issue) => <option key={issue} value={issue}>{t(humanIssue(issue))}</option>)}
          </select>
          <div className="sort-control">
            <ArrowDownUp size={15} />
            <select value={sort.key} onChange={(event) => changeSortKey(event.target.value as SortKey)} aria-label={t('Sort images by')}>
              {SORT_OPTIONS.map((option) => <option key={option.id} value={option.id}>{t(option.label)}</option>)}
            </select>
            <button onClick={toggleSortDirection} title={t('Reverse the sort order')} aria-label={t('Sorted {order}. Reverse the order.', { order: t(sortDirectionLabel(sort.key, sort.direction)) })}>
              {t(sortDirectionLabel(sort.key, sort.direction))}
            </button>
          </div>
          <span className="image-count"><Images size={14} /> {filtered ? t('{n} of {total} shown', { n: images.length, total: counts.all }) : t('{n} shown', { n: images.length })}</span>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar" role="toolbar" aria-label={t('{n} images selected', { n: selected.size })}>
          <div className="bulk-count">
            <strong>{t('{n} selected', { n: selected.size })}</strong>
            {hiddenSelected > 0 && <button className="bulk-hidden" onClick={keepOnlyShown} title={t('Drop the images the current filters are hiding from this selection')}>{t('{n} not shown here · keep only visible', { n: hiddenSelected })}</button>}
          </div>
          <div className="bulk-picks">
            <button onClick={selectAllShown} disabled={selectedShown.length === images.length}>{t('Select all {n}', { n: images.length })}</button>
            <button onClick={clearSelection}>{t('Clear')}</button>
          </div>
          <div className="bulk-tags" role="group" aria-label={t('Tags for the selection')}>
            {ISSUE_TYPES.map((issue) => {
              const state = tagStates[issue]
              return (
                <button
                  key={issue}
                  className={`bulk-tag ${state}`}
                  aria-pressed={state === 'all'}
                  onClick={() => applyIssue(issue)}
                  title={t(state === 'all' ? 'Remove {tag} from all {n}' : state === 'some' ? 'Add {tag} to all {n} — some already have it' : 'Add {tag} to all {n}', { tag: t(humanIssue(issue)), n: selected.size })}
                >
                  <span className="bulk-tag-state" aria-hidden="true">{state === 'all' ? <Check size={11} /> : state === 'some' ? <Minus size={11} /> : null}</span>
                  {t(humanIssue(issue))}
                </button>
              )
            })}
          </div>
          <button className="bulk-delete" onClick={deleteSelected} disabled={deletingSelection}>
            {deletingSelection ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />} {t('Delete {n}…', { n: selected.size })}
          </button>
        </div>
      )}

      <div className="library-body">
        {images.length === 0 ? (
          <EmptyState icon={Images} title={t('No images match these filters')} body={t('Clear the search, issue filter, or quick filter to see the rest of the collection.')} />
        ) : (
          <div className="image-grid">
            {images.slice(0, mounted).map((image) => {
              const decision = decisionById.get(image.id) ?? defaultDecision(image)
              const displayedQuality = decision.outputQuality ?? image.quality
              const refreshing = refreshingPaths.has(image.path)
              return (
                <article className={`image-card ${selected.has(image.id) ? 'selected' : ''} ${refreshing ? 'refreshing' : ''}`} key={image.id}>
                  <button className="select-check" disabled={refreshing} onClick={(event) => toggleSelected(image.id, event.shiftKey)} aria-label={t('Select {name}', { name: image.name })} title={t('Select · shift-click to select a range')}>{selected.has(image.id) && <Check size={14} />}</button>
                  <button className="image-open" disabled={refreshing} onClick={() => setEditing(image)}>
                    <div className="image-preview"><img src={decision.outputThumbnail || image.thumbnailDataUrl} alt="" />{(decision.outputPath || decision.processedAt || image.processed) && <span className="processed-mark"><WandSparkles size={13} /> {t('Processed')}</span>}{refreshing && <span className="refreshing-mark"><LoaderCircle className="spin" size={12} /> {t('Updating')}</span>}</div>
                    <div className="image-card-body"><strong title={image.name}>{image.name}</strong><span>{t(describeSortValue(image, sort.key, localeFor(language)))} · <b className={`quality-${displayedQuality.label.toLowerCase()}`}>{t(displayedQuality.label)} {displayedQuality.score}/100</b></span></div>
                  </button>
                  <div className="tag-strip">
                    {decision.issues.slice(0, 2).map((issue) => <span key={issue}>{t(humanIssue(issue))}</span>)}
                    {decision.issues.length > 2 && <span>+{decision.issues.length - 2}</span>}
                    {decision.issues.length === 0 && <span className="clean-tag">{t('No fixes')}</span>}
                  </div>
                </article>
              )
            })}
          </div>
        )}
        {mounted < images.length && (
          <div className="grid-more" ref={gridSentinel}>
            <LoaderCircle className="spin" size={14} /> {t('{n} more', { n: images.length - mounted })}
          </div>
        )}
      </div>

      {editing && <EditorDialog image={editing} decision={decisions[editing.id]} projectPath={scan.folder} keyStatus={keyStatus} openSettings={openSettings} onUpdate={(update) => updateDecision(editing.id, update)} onNotice={onNotice} onBusy={onBusy} onCommitted={(image, accepted) => {
        setSelected((current) => {
          const next = new Set(current)
          next.delete(image.id)
          return next
        })
        onCommitted(image, accepted)
      }} onReverted={onReverted} onDeleted={(image) => {
        setSelected((current) => {
          const next = new Set(current)
          next.delete(image.id)
          return next
        })
        onDeleted(image)
      }} onDuplicated={onDuplicated} onClose={() => { setEditing(null); onEditorClosed() }} />}
    </main>
  )
}

type CropDrag = {
  edges: Array<keyof CropInsets>
  move: boolean
  startX: number
  startY: number
  startCrop: CropInsets
}

const CROP_HANDLES: Array<{ className: string; label: string; edges: Array<keyof CropInsets> }> = [
  { className: 'top-left', label: 'Crop top left corner', edges: ['top', 'left'] },
  { className: 'top', label: 'Crop top edge', edges: ['top'] },
  { className: 'top-right', label: 'Crop top right corner', edges: ['top', 'right'] },
  { className: 'right', label: 'Crop right edge', edges: ['right'] },
  { className: 'bottom-right', label: 'Crop bottom right corner', edges: ['bottom', 'right'] },
  { className: 'bottom', label: 'Crop bottom edge', edges: ['bottom'] },
  { className: 'bottom-left', label: 'Crop bottom left corner', edges: ['bottom', 'left'] },
  { className: 'left', label: 'Crop left edge', edges: ['left'] },
]

type CropSource = { name: string; width: number; height: number; thumbnailDataUrl: string }
// The guide is a concentric reference circle for the eye, drawn and never sent.
type PaintCapture = { host: HTMLElement; left: number; top: number; width: number; height: number }

function ImageStage({ image, crop, onChange, zoom, rotation, cropEnabled, squareCrop, paintEnabled, paintStrokes, paintColor, brushSize, brushShape, showLevelGrid, sampleMode, onSample, onPaint, onStrokeEnd }: {
  image: CropSource
  crop: CropInsets
  onChange: (crop: CropInsets) => void
  zoom: number
  rotation: number
  cropEnabled: boolean
  squareCrop: boolean
  paintEnabled: boolean
  paintStrokes: PaintStroke[]
  paintColor: string
  brushSize: number
  brushShape: PaintBrushShape
  showLevelGrid: boolean
  // The shift as it will be applied, drawn live over the image whether or not
  // the tool is active: like a crop, it keeps applying once set.
  sampleMode: SampleMode
  onSample: (point: PaintPoint) => void
  onPaint: Dispatch<SetStateAction<PaintStroke[]>>
  // Pointer-up on a stroke. The brush is a direct tool, so this is the commit.
  onStrokeEnd: () => void
}) {
  const { t } = useLanguage()
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<CropDrag | null>(null)
  const paintStrokeRef = useRef<number | null>(null)
  const onPaintRef = useRef(onPaint)
  const onStrokeEndRef = useRef(onStrokeEnd)
  const [viewport, setViewport] = useState({ width: 1, height: 1 })
  const [brushPreview, setBrushPreview] = useState<{ x: number; y: number } | null>(null)
  const [paintCapture, setPaintCapture] = useState<PaintCapture | null>(null)
  const round = (value: number) => Math.round(value * 10) / 10
  const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))

  useEffect(() => { onPaintRef.current = onPaint }, [onPaint])
  useEffect(() => { onStrokeEndRef.current = onStrokeEnd }, [onStrokeEnd])
  // Only a stroke that was actually drawing counts as finished.
  const finishStroke = () => {
    if (paintStrokeRef.current === null) return
    paintStrokeRef.current = null
    onStrokeEndRef.current()
  }

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const measure = () => setViewport({ width: Math.max(1, element.clientWidth), height: Math.max(1, element.clientHeight) })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const geometry = stageImageGeometry(viewport.width, viewport.height, image.width, image.height, zoom, rotation)
  // Screen pixels per image pixel. The canvas keeps the image's aspect, so
  // one factor covers both axes.
  const stageScale = geometry.canvasWidth / Math.max(1, image.width)

  // Where the user is looking, held as fractions of the scrollable space rather
  // than as pixel offsets, so a revision with different dimensions — a crop, a
  // quarter turn — still shows the same part of the artwork.
  const viewRef = useRef({ x: .5, y: .5 })
  const rememberView = () => {
    const element = viewportRef.current
    if (element) viewRef.current = stageViewFraction(element)
  }

  // Placing the view is keyed on the shape of the scrollable space and
  // deliberately NOT on the preview bytes. It used to be keyed on the preview,
  // and that is what threw the stage back to the middle of the canvas on every
  // fill: each fill is its own revision, so the data URL changed on every
  // click, so the view jumped away from the spot the user was zoomed in on and
  // working at. Restoring the zoom level alone did not save it — the zoom was
  // put back and the scroll was not. Only a change that actually moves the
  // artwork under the viewport — a new zoom, a resized window, a revision with
  // new dimensions — re-places the view now, and it is re-placed where the user
  // was rather than at the centre.
  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const animation = requestAnimationFrame(() => {
      const offset = stageViewOffset(element, viewRef.current)
      element.scrollLeft = offset.scrollLeft
      element.scrollTop = offset.scrollTop
      rememberView()
    })
    return () => cancelAnimationFrame(animation)
  }, [geometry.spaceWidth, geometry.spaceHeight])

  const startCropDrag = (pointerId: number, clientX: number, clientY: number, edges: Array<keyof CropInsets>, move = false) => {
    try { canvasRef.current?.setPointerCapture(pointerId) } catch { /* Document capture still keeps the drag responsive inside the window. */ }
    dragRef.current = { edges, move, startX: clientX, startY: clientY, startCrop: crop }
  }

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, edges: Array<keyof CropInsets>, move = false) => {
    event.preventDefault()
    event.stopPropagation()
    startCropDrag(event.pointerId, event.clientX, event.clientY, edges, move)
  }

  const moveCropDrag = (clientX: number, clientY: number) => {
    const drag = dragRef.current
    const bounds = canvasRef.current?.getBoundingClientRect()
    if (!drag || !bounds) return
    const deltaX = ((clientX - drag.startX) / bounds.width) * 100
    const deltaY = ((clientY - drag.startY) / bounds.height) * 100
    const next = { ...drag.startCrop }
    if (drag.move) {
      const cropWidth = 100 - drag.startCrop.left - drag.startCrop.right
      const cropHeight = 100 - drag.startCrop.top - drag.startCrop.bottom
      next.left = round(clamp(drag.startCrop.left + deltaX, 0, 100 - cropWidth))
      next.right = round(100 - cropWidth - next.left)
      next.top = round(clamp(drag.startCrop.top + deltaY, 0, 100 - cropHeight))
      next.bottom = round(100 - cropHeight - next.top)
    } else {
      if (drag.edges.includes('left')) next.left = round(clamp(drag.startCrop.left + deltaX, 0, 95 - drag.startCrop.right))
      if (drag.edges.includes('right')) next.right = round(clamp(drag.startCrop.right - deltaX, 0, 95 - drag.startCrop.left))
      if (drag.edges.includes('top')) next.top = round(clamp(drag.startCrop.top + deltaY, 0, 95 - drag.startCrop.bottom))
      if (drag.edges.includes('bottom')) next.bottom = round(clamp(drag.startCrop.bottom - deltaY, 0, 95 - drag.startCrop.top))
    }
    // A move keeps the frame's size, so a locked frame stays locked without
    // help; only a resize has to be squared back up.
    onChange(squareCrop && !drag.move ? squareCropInsets(next, image.width, image.height, drag.edges) : next)
  }

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => moveCropDrag(event.clientX, event.clientY)

  useEffect(() => {
    if (paintEnabled) return
    paintStrokeRef.current = null
    setBrushPreview(null)
  }, [paintEnabled])

  // The capture layer serves painting and the click-to-sample tools alike, so
  // pick and fill land on the same reliable image rectangle as a brush stroke.
  const stageInteractive = paintEnabled || sampleMode !== null
  useEffect(() => {
    if (!stageInteractive) {
      setPaintCapture(null)
      return
    }
    const viewportElement = viewportRef.current
    const canvasElement = canvasRef.current
    const host = viewportElement?.closest('.comparison-stage') as HTMLElement | null
    if (!viewportElement || !canvasElement || !host) return
    const updateCapture = () => {
      const visible = visibleImageRect(canvasElement.getBoundingClientRect(), viewportElement.getBoundingClientRect())
      if (!visible) {
        setPaintCapture(null)
        return
      }
      const hostBounds = host.getBoundingClientRect()
      setPaintCapture({ host, left: visible.left - hostBounds.left, top: visible.top - hostBounds.top, width: visible.width, height: visible.height })
    }
    updateCapture()
    const animation = requestAnimationFrame(updateCapture)
    const observer = new ResizeObserver(updateCapture)
    observer.observe(viewportElement)
    observer.observe(canvasElement)
    viewportElement.addEventListener('scroll', updateCapture, { passive: true })
    window.addEventListener('resize', updateCapture)
    return () => {
      cancelAnimationFrame(animation)
      observer.disconnect()
      viewportElement.removeEventListener('scroll', updateCapture)
      window.removeEventListener('resize', updateCapture)
    }
  }, [stageInteractive, geometry.canvasWidth, geometry.canvasHeight, geometry.left, geometry.top, image.thumbnailDataUrl])

  const paintPoint = (clientX: number, clientY: number, allowOutside: boolean) => {
    const bounds = canvasRef.current?.getBoundingClientRect()
    return bounds ? normalizedPointInRect(clientX, clientY, bounds, allowOutside) : null
  }
  // Whether a pointer START belongs to the image. It is deliberately a
  // different question from `paintPoint`, which maps a point onto the image and
  // is right to work off the whole canvas: once a stroke or a crop drag is under
  // way the pointer may travel outside the visible area and must still map to
  // the correct pixel. Claiming a START that far out is what broke the app above
  // 1x — the canvas layout rectangle runs hundreds of pixels past the viewport
  // that clips it, across the controls panel, the footer and the toast.
  const startsOnImage = (clientX: number, clientY: number) => pointerOverVisibleImage(
    clientX,
    clientY,
    canvasRef.current?.getBoundingClientRect() ?? null,
    viewportRef.current?.getBoundingClientRect() ?? null,
  )
  const startPaint = (pointerId: number, clientX: number, clientY: number, captureTarget?: HTMLElement | null) => {
    if (!paintEnabled) return false
    const point = paintPoint(clientX, clientY, false)
    if (!point) return false
    try { (captureTarget ?? canvasRef.current)?.setPointerCapture(pointerId) } catch { /* Document capture still keeps the stroke responsive inside the window. */ }
    setBrushPreview(point)
    onPaintRef.current((current) => {
      paintStrokeRef.current = current.length
      return [...current, { points: [point], size: brushSize, shape: brushShape, color: paintColor }]
    })
    return true
  }
  const sampleAt = (clientX: number, clientY: number) => {
    const point = paintPoint(clientX, clientY, false)
    if (point) onSample(point)
    return Boolean(point)
  }
  const beginPaint = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (sampleMode) {
      if (event.button !== 0 || event.isPrimary === false) return
      if (!sampleAt(event.clientX, event.clientY)) return
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (!paintEnabled || event.button !== 0 || event.isPrimary === false || paintStrokeRef.current !== null) return
    if (!startPaint(event.pointerId, event.clientX, event.clientY, event.currentTarget)) return
    event.preventDefault()
    event.stopPropagation()
  }
  const movePaintAt = (clientX: number, clientY: number) => {
    if (!paintEnabled) return
    const index = paintStrokeRef.current
    const point = paintPoint(clientX, clientY, index !== null)
    if (!point) {
      if (index === null) setBrushPreview(null)
      return
    }
    setBrushPreview(point)
    if (index === null) return
    onPaintRef.current((current) => {
      const stroke = current[index]
      if (!stroke) return current
      const previous = stroke.points[stroke.points.length - 1]
      if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.002) return current
      const distanceInShortestEdges = previous
        ? Math.hypot((point.x - previous.x) * image.width, (point.y - previous.y) * image.height) / Math.min(image.width, image.height)
        : 0
      const steps = Math.max(1, Math.ceil(distanceInShortestEdges / Math.max(brushSize * 0.35, 0.001)))
      const addedPoints = previous
        ? Array.from({ length: steps }, (_, step) => ({
            x: previous.x + ((point.x - previous.x) * (step + 1)) / steps,
            y: previous.y + ((point.y - previous.y) * (step + 1)) / steps,
          }))
        : [point]
      const next = [...current]
      next[index] = { ...stroke, points: [...stroke.points, ...addedPoints] }
      return next
    })
  }
  const movePaint = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (paintStrokeRef.current !== null) {
      event.preventDefault()
      event.stopPropagation()
    }
    movePaintAt(event.clientX, event.clientY)
  }
  const endInteraction = (event?: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    finishStroke()
    if (event?.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  useEffect(() => {
    if (!paintEnabled && !cropEnabled && !sampleMode) return

    const excludedControl = (target: EventTarget | null) => target instanceof Element
      && Boolean(target.closest('.revision-actions, .stage-zoom-controls, .original-peek'))

    const cropActionAt = (clientX: number, clientY: number) => {
      const bounds = canvasRef.current?.getBoundingClientRect()
      if (!bounds) return null
      const frame = {
        left: bounds.left + (bounds.width * crop.left) / 100,
        right: bounds.right - (bounds.width * crop.right) / 100,
        top: bounds.top + (bounds.height * crop.top) / 100,
        bottom: bounds.bottom - (bounds.height * crop.bottom) / 100,
      }
      const tolerance = 22
      const middleX = (frame.left + frame.right) / 2
      const middleY = (frame.top + frame.bottom) / 2
      const near = (value: number, target: number) => Math.abs(value - target) <= tolerance
      const horizontal = near(clientX, frame.left) ? 'left' : near(clientX, frame.right) ? 'right' : null
      const vertical = near(clientY, frame.top) ? 'top' : near(clientY, frame.bottom) ? 'bottom' : null
      const atHorizontalHandle = horizontal && (near(clientY, frame.top) || near(clientY, middleY) || near(clientY, frame.bottom))
      const atVerticalHandle = vertical && (near(clientX, frame.left) || near(clientX, middleX) || near(clientX, frame.right))
      if (atHorizontalHandle || atVerticalHandle) {
        return { edges: [vertical, horizontal].filter(Boolean) as Array<keyof CropInsets>, move: false }
      }
      const inside = clientX >= frame.left && clientX <= frame.right && clientY >= frame.top && clientY <= frame.bottom
      return inside ? { edges: [] as Array<keyof CropInsets>, move: true } : null
    }

    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.isPrimary === false || excludedControl(event.target)) return
      // Nothing is claimed, prevented or stopped unless the start is genuinely
      // over the visible image: everything below this line takes the event away
      // from the rest of the page.
      if (!startsOnImage(event.clientX, event.clientY)) return
      const point = paintPoint(event.clientX, event.clientY, false)
      if (!point) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (sampleMode) onSample(point)
      else if (paintEnabled) startPaint(event.pointerId, event.clientX, event.clientY, canvasRef.current)
      else {
        const action = cropActionAt(event.clientX, event.clientY)
        if (action) startCropDrag(event.pointerId, event.clientX, event.clientY, action.edges, action.move)
      }
    }
    const pointerMove = (event: PointerEvent) => {
      if (paintStrokeRef.current === null && dragRef.current === null) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (paintStrokeRef.current !== null) movePaintAt(event.clientX, event.clientY)
      else moveCropDrag(event.clientX, event.clientY)
    }
    const pointerEnd = (event: PointerEvent) => {
      if (paintStrokeRef.current === null && dragRef.current === null) return
      event.preventDefault()
      event.stopImmediatePropagation()
      dragRef.current = null
      finishStroke()
      try {
        if (canvasRef.current?.hasPointerCapture(event.pointerId)) canvasRef.current.releasePointerCapture(event.pointerId)
      } catch { /* The pointer may already have been released by the browser. */ }
    }

    document.addEventListener('pointerdown', pointerDown, true)
    document.addEventListener('pointermove', pointerMove, true)
    document.addEventListener('pointerup', pointerEnd, true)
    document.addEventListener('pointercancel', pointerEnd, true)
    return () => {
      document.removeEventListener('pointerdown', pointerDown, true)
      document.removeEventListener('pointermove', pointerMove, true)
      document.removeEventListener('pointerup', pointerEnd, true)
      document.removeEventListener('pointercancel', pointerEnd, true)
    }
  }, [paintEnabled, cropEnabled, sampleMode, onSample, crop, brushSize, brushShape, image.width, image.height])
  return (
    <>
      <div ref={viewportRef} className="stage-image-viewport" onScroll={rememberView}>
        <div className="stage-zoom-space" style={{ width: geometry.spaceWidth, height: geometry.spaceHeight }}>
          <div
          ref={canvasRef}
          className={`stage-image-canvas ${paintEnabled ? 'painting' : ''}`}
          style={{
            width: geometry.canvasWidth,
            height: geometry.canvasHeight,
            left: geometry.left,
            top: geometry.top,
            transform: `rotate(${rotation}deg)`,
            transformOrigin: 'center center',
          }}
          onPointerDown={beginPaint}
          onPointerMove={(event) => { if (paintEnabled) movePaint(event); else moveDrag(event) }}
          onPointerUp={endInteraction}
          onPointerCancel={endInteraction}
          onPointerLeave={() => { if (paintStrokeRef.current === null) setBrushPreview(null) }}
          >
            <img src={image.thumbnailDataUrl} alt={image.name} draggable={false} />
            {(paintStrokes.length > 0 || (paintEnabled && brushPreview)) && (
              <svg className="paint-overlay" viewBox={`0 0 ${image.width} ${image.height}`} preserveAspectRatio="none" aria-hidden="true">
              {paintStrokes.map((stroke, index) => {
                const points = stroke.points.map((point) => `${point.x * image.width},${point.y * image.height}`).join(' ')
                const strokeWidth = stroke.size * Math.min(image.width, image.height)
                // The colour the stroke was drawn in, not the one the picker is
                // showing now: the preview has to match what Apply will produce.
                const ink = stroke.color ?? paintColor
                if (stroke.shape === 'square') {
                  return <g key={index}>{stroke.points.map((point, pointIndex) => <rect key={pointIndex} x={(point.x * image.width) - (strokeWidth / 2)} y={(point.y * image.height) - (strokeWidth / 2)} width={strokeWidth} height={strokeWidth} fill={ink} />)}</g>
                }
                return stroke.points.length === 1
                  ? <circle key={index} cx={stroke.points[0].x * image.width} cy={stroke.points[0].y * image.height} r={strokeWidth / 2} fill={ink} />
                  : <polyline key={index} points={points} fill="none" stroke={ink} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
              })}
              {paintEnabled && brushPreview && (() => {
                const size = brushSize * Math.min(image.width, image.height)
                const x = brushPreview.x * image.width
                const y = brushPreview.y * image.height
                const shared = { fill: paintColor, fillOpacity: 0.22, stroke: 'white', strokeWidth: 1.5, vectorEffect: 'non-scaling-stroke' as const }
                // A one-pixel brush has no footprint worth drawing, so show the
                // precise crosshair every paint tool falls back to instead of a
                // ring too small to aim with. Arms are sized in image units from
                // the stage scale so they stay a constant size on screen.
                if (size * stageScale < 9) {
                  const arm = 7 / stageScale
                  const gap = 2 / stageScale
                  return (
                    <g className="brush-cursor" stroke="white" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinecap="round">
                      <line x1={x - arm} y1={y} x2={x - gap} y2={y} />
                      <line x1={x + gap} y1={y} x2={x + arm} y2={y} />
                      <line x1={x} y1={y - arm} x2={x} y2={y - gap} />
                      <line x1={x} y1={y + gap} x2={x} y2={y + arm} />
                    </g>
                  )
                }
                return brushShape === 'square'
                  ? <rect className="brush-cursor" x={x - (size / 2)} y={y - (size / 2)} width={size} height={size} {...shared} />
                  : <circle className="brush-cursor" cx={x} cy={y} r={size / 2} {...shared} />
              })()}
              </svg>
            )}
          </div>
          {showLevelGrid && (() => {
            // Sized to the image's rotation envelope rather than the whole
            // stage: a grid over the empty surround reads as texture, not as a
            // reference. It is a sibling of the canvas, never a child, so its
            // lines stay true horizontal and vertical while the image turns.
            const radians = (Math.abs(rotation) * Math.PI) / 180
            const cosine = Math.abs(Math.cos(radians))
            const sine = Math.abs(Math.sin(radians))
            const width = (geometry.canvasWidth * cosine) + (geometry.canvasHeight * sine)
            const height = (geometry.canvasWidth * sine) + (geometry.canvasHeight * cosine)
            return (
              <div
                className="level-grid"
                aria-hidden="true"
                style={{
                  left: geometry.left + ((geometry.canvasWidth - width) / 2),
                  top: geometry.top + ((geometry.canvasHeight - height) / 2),
                  width,
                  height,
                }}
              />
            )
          })()}
          {cropEnabled && (
            // The frame is a sibling of the image canvas rather than a child of
            // it. The canvas clips its overflow so paint strokes stop at the
            // image edge, which also cut every handle in half; out here the
            // handles can sit clear of the artwork. Crop is disabled while a
            // rotation is pending, so the frame never needs the canvas's turn.
            <div
              className="crop-layer"
              style={{ left: geometry.left, top: geometry.top, width: geometry.canvasWidth, height: geometry.canvasHeight }}
            >
              {/* Four shades rather than one outward box-shadow: unclipped, a
                  999px shadow would dim the whole stage instead of the image. */}
              <div className="crop-shade" style={{ left: 0, right: 0, top: 0, height: `${crop.top}%` }} />
              <div className="crop-shade" style={{ left: 0, right: 0, bottom: 0, height: `${crop.bottom}%` }} />
              <div className="crop-shade" style={{ left: 0, width: `${crop.left}%`, top: `${crop.top}%`, bottom: `${crop.bottom}%` }} />
              <div className="crop-shade" style={{ right: 0, width: `${crop.right}%`, top: `${crop.top}%`, bottom: `${crop.bottom}%` }} />
              <div
                className={`crop-frame ${showLevelGrid ? 'no-thirds' : ''}`}
                style={{ left: `${crop.left}%`, right: `${crop.right}%`, top: `${crop.top}%`, bottom: `${crop.bottom}%` }}
                onPointerDown={(event) => beginDrag(event, [], true)}
              >
                <span className="crop-move-hint">{crop.left + crop.right + crop.top + crop.bottom === 0 ? t('Drag a handle inward to crop') : squareCrop ? t('Locked to 1:1 · drag to reposition') : t('Drag to reposition')}</span>
                {CROP_HANDLES.map((handle) => (
                  <button
                  key={handle.className}
                  type="button"
                  className={`crop-handle ${handle.className}`}
                  aria-label={t(handle.label)}
                  onPointerDown={(event) => beginDrag(event, handle.edges)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {stageInteractive && paintCapture && createPortal(
        <div
          className={`paint-input-capture ${sampleMode ? `tool-${sampleMode}` : ''}`}
          style={{ left: paintCapture.left, top: paintCapture.top, width: paintCapture.width, height: paintCapture.height }}
          onPointerDown={beginPaint}
          onPointerMove={movePaint}
          onPointerUp={endInteraction}
          onPointerCancel={endInteraction}
          onPointerLeave={() => { if (paintStrokeRef.current === null) setBrushPreview(null) }}
          onWheel={(event) => {
            const viewportElement = viewportRef.current
            if (!viewportElement) return
            event.preventDefault()
            event.stopPropagation()
            viewportElement.scrollBy({ left: event.deltaX, top: event.deltaY })
          }}
          aria-hidden="true"
        />,
        paintCapture.host,
      )}
    </>
  )
}

function EditorDialog({ image, decision, projectPath, keyStatus, openSettings, onUpdate, onNotice, onBusy, onCommitted, onReverted, onDeleted, onDuplicated, onClose }: {
  image: ImageRecord
  decision: ImageDecision
  projectPath: string
  keyStatus: Record<AiProvider, boolean>
  openSettings: () => void
  onUpdate: (update: Partial<ImageDecision>) => void
  onNotice: (notice: string | Notice) => void
  onBusy: (message: string | null) => void
  onCommitted: (image: ImageRecord, accepted: ProcessResult) => void
  onReverted: (image: ImageRecord) => void
  onDeleted: (image: ImageRecord) => void
  onDuplicated: (image: ImageRecord) => void
  onClose: () => void
}) {
  const { t, language } = useLanguage()
  const startsFromProcessedResult = Boolean(decision.outputPath)
  const [timeline, setTimeline] = useState<{ revisions: ProcessResult[]; index: number }>(() => ({
    revisions: [{
      outputPath: decision.outputPath ?? image.path,
      thumbnailDataUrl: decision.outputThumbnail ?? image.thumbnailDataUrl,
      width: image.width,
      height: image.height,
      quality: decision.outputQuality ?? image.quality,
    }],
    index: 0,
  }))
  const working = timeline.revisions[timeline.index]
  const [crop, setCrop] = useState<CropInsets>(EMPTY_CROP)
  // 1:1 is a mode rather than a value, so it survives moving between revisions
  // the way the active tool does.
  const [squareCrop, setSquareCrop] = useState(false)
  const [trim, setTrim] = useState(!startsFromProcessedResult && decision.issues.includes('border'))
  const [center, setCenter] = useState(!startsFromProcessedResult && decision.issues.includes('off_center'))
  const [background, setBackground] = useState('#ffffff')
  const [automaticBackground, setAutomaticBackground] = useState(true)
  // The hex field keeps its own text while it is being edited; the committed
  // colour only changes once the text is a complete colour.
  const [backgroundText, setBackgroundText] = useState('#ffffff')
  useEffect(() => setBackgroundText(background), [background])
  const chooseBackground = (value: string) => {
    setBackground(value)
    setAutomaticBackground(false)
  }
  const typeBackgroundHex = (value: string) => {
    setBackgroundText(value)
    const normalized = normalizeHexColor(value)
    if (normalized) chooseBackground(normalized)
  }
  const [upscale, setUpscale] = useState(!startsFromProcessedResult && decision.issues.includes('low_quality') ? 2 : 1)
  // Stored as a share of the shorter edge so it keeps its proportion across a
  // revision, a crop and an upscale; chosen and shown in pixels, as brush size is.
  const [borderOn, setBorderOn] = useState(false)
  const [borderWidth, setBorderWidth] = useState(BORDER_DEFAULT)
  const [swapBackdropOn, setSwapBackdropOn] = useState(false)
  const [backdropTolerance, setBackdropTolerance] = useState(0.12)
  const [recolour, setRecolour] = useState(false)
  const [recolourVariation, setRecolourVariation] = useState(1)
  const [recolourAmount, setRecolourAmount] = useState(0.6)
  const [flattenPalette, setFlattenPalette] = useState(false)
  const [paletteMode, setPaletteMode] = useState<'auto' | number>('auto')
  const [paletteAnalysis, setPaletteAnalysis] = useState<PaletteAnalysisResult | null>(null)
  const [paletteDetecting, setPaletteDetecting] = useState(false)
  const [paintEnabled, setPaintEnabled] = useState(false)
  const [paintStrokes, setPaintStrokes] = useState<PaintStroke[]>([])
  const [paintRedoStrokes, setPaintRedoStrokes] = useState<PaintStroke[]>([])
  // Kept exact rather than a render behind: the flush below reads it inside a
  // promise callback, where React state would still be the previous value.
  const paintStrokesRef = useRef<PaintStroke[]>([])
  const paintingRef = useRef(false)
  const [brushSize, setBrushSize] = useState(0.07)
  const [brushShape, setBrushShape] = useState<PaintBrushShape>('circle')
  const [rotation, setRotation] = useState(0)
  const [rotationDetecting, setRotationDetecting] = useState(false)
  const [pendingIssueRemoval, setPendingIssueRemoval] = useState<IssueType | null>(null)
  const [imageColours, setImageColours] = useState<string[]>([])
  // The level grid has no button of its own: it appears while the Straighten
  // group is engaged, so a level reference is available at 0° too — that is
  // the only thing the old manual toggle was still good for.
  const [straightening, setStraightening] = useState(false)
  const [sampleMode, setSampleMode] = useState<SampleMode>(null)
  const [fillTolerance, setFillTolerance] = useState(12)
  const [filling, setFilling] = useState(false)
  const [format, setFormat] = useState<'png' | 'jpeg' | 'webp'>(image.extension === 'webp' ? 'webp' : image.extension === 'png' ? 'png' : 'jpeg')
  const [geminiPreset, setGeminiPreset] = useState<GeminiPresetId>('standard')
  const [prompt, setPrompt] = useState(() => buildGeminiPrompt(decision.issues, language))
  const [imageSize, setImageSize] = useState<ImageSize>('1K')
  const [aiModel, setAiModel] = useState<string>(DEFAULT_AI_MODEL)
  const [aiBackdrop, setAiBackdrop] = useState<string>(DEFAULT_AI_BACKDROP)
  const [authoring, setAuthoring] = useState(false)
  const [authored, setAuthored] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [deleting, setDeleting] = useState(false)
  const [filenameCopied, setFilenameCopied] = useState(false)
  const [qualityOverride, setQualityOverride] = useState(false)
  // Holding Before shows the previous revision without moving through the
  // history: nothing is undone, the redo branch is untouched and no pending
  // control is reset, so a result can be compared with what it replaced and
  // then worked on as if the glance had never happened.
  const [peeking, setPeeking] = useState(false)
  const peekTarget = peekRevision(timeline.revisions, timeline.index, peeking)
  const visibleResult = peekTarget ?? working
  useEffect(() => setQualityOverride(false), [working.outputPath])
  const [editorPreview, setEditorPreview] = useState<{ path: string; dataUrl: string } | null>(null)
  // The last few previews are kept so flicking between a result and what came
  // before it is instant rather than a round trip each way.
  const previewCache = useRef(new Map<string, string>())
  useEffect(() => {
    const target = visibleResult.outputPath
    const cached = previewCache.current.get(target)
    if (cached) {
      setEditorPreview({ path: target, dataUrl: cached })
      return
    }
    let cancelled = false
    window.moodprep.loadEditorPreview(target)
      .then((result) => {
        previewCache.current.set(target, result.dataUrl)
        while (previewCache.current.size > 6) previewCache.current.delete(previewCache.current.keys().next().value!)
        if (!cancelled) setEditorPreview({ path: target, dataUrl: result.dataUrl })
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [visibleResult.outputPath])
  useEffect(() => {
    if (!decision.outputPath || decision.outputQuality) return
    let cancelled = false
    window.moodprep.analyzeQuality(decision.outputPath)
      .then((analysis) => {
        if (cancelled) return
        setTimeline((current) => ({
          ...current,
          revisions: current.revisions.map((revision, index) => index === 0 ? { ...revision, width: analysis.width, height: analysis.height, quality: analysis.quality } : revision),
        }))
        onUpdate({ outputQuality: analysis.quality })
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [decision.outputPath, decision.outputQuality, onUpdate])
  useEffect(() => {
    if (!automaticBackground) return
    let cancelled = false
    window.moodprep.detectBackground(working.outputPath)
      .then((result) => { if (!cancelled) setBackground(result.color) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [automaticBackground, working.outputPath])
  useEffect(() => {
    if (!flattenPalette) return
    let cancelled = false
    setPaletteDetecting(true)
    setPaletteAnalysis(null)
    window.moodprep.detectPalette(working.outputPath)
      .then((result) => { if (!cancelled) setPaletteAnalysis(result) })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setPaletteDetecting(false) })
    return () => { cancelled = true }
  }, [flattenPalette, working.outputPath])

  useEffect(() => {
    let cancelled = false
    window.moodprep.detectDominantColors(working.outputPath, 6)
      .then((colours) => { if (!cancelled) setImageColours(colours) })
      .catch(() => { if (!cancelled) setImageColours([]) })
    return () => { cancelled = true }
  }, [working.outputPath])

  const useAutomaticBackground = async () => {
    setAutomaticBackground(true)
    try {
      const result = await window.moodprep.detectBackground(working.outputPath)
      setBackground(result.color)
      onNotice(t('Background detected as {colour}.', { colour: result.color.toUpperCase() }))
    } catch (error) {
      onNotice(t('Could not detect the background: {error}', { error: errorMessage(error) }))
    }
  }
  const applyIssues = (issues: IssueType[]) => {
    onUpdate({ issues })
    setPrompt(buildGeminiPresetPrompt(geminiPreset, issues, backdropPhrase(aiBackdrop, language), language))
  }
  // Adding a tag is a cheap, reversible note. Removing one asserts the issue
  // does not apply to this image, which changes what the collection records,
  // so it is confirmed rather than toggled away on a single stray click.
  const toggleIssue = (issue: IssueType) => {
    if (decision.issues.includes(issue)) {
      setPendingIssueRemoval((current) => current === issue ? null : issue)
      return
    }
    setPendingIssueRemoval(null)
    applyIssues([...decision.issues, issue])
  }
  const confirmIssueRemoval = () => {
    if (!pendingIssueRemoval) return
    applyIssues(decision.issues.filter((item) => item !== pendingIssueRemoval))
    setPendingIssueRemoval(null)
  }
  // Processing clears resolved tags on its own; drop a stale prompt if that happens.
  useEffect(() => {
    if (pendingIssueRemoval && !decision.issues.includes(pendingIssueRemoval)) setPendingIssueRemoval(null)
  }, [decision.issues, pendingIssueRemoval])
  // The backdrop is written into the prompt, so changing it rewrites the
  // prompt the same way changing the preset does.
  // Read this image and write the instruction for it. The result lands in the
  // box as an ordinary editable prompt and the preset becomes Custom, because
  // that is what it now is: leaving it on a preset would let the next backdrop
  // or preset change quietly overwrite the bespoke text.
  const writePromptForImage = async () => {
    if (authoring) return
    setAuthoring(true)
    try {
      const result = await window.moodprep.authorPrompt({
        imagePath: working.outputPath,
        instruction: buildPromptAuthorInstruction(decision.issues, backdropPhrase(aiBackdrop, language), language),
      })
      const written = cleanAuthoredPrompt(result.prompt)
      if (!written) throw new Error(t('The reply came back empty.'))
      setGeminiPreset('custom')
      setPrompt(written)
      setAuthored(true)
      onNotice(t('Wrote a prompt for this image. Read it before running it — it is editable like any other.'))
    } catch (error) {
      onNotice(t('Could not write a prompt for this image: {error}', { error: errorMessage(error) }))
    } finally {
      setAuthoring(false)
    }
  }

  const chooseBackdrop = (id: string) => {
    setAiBackdrop(id)
    setPrompt(buildGeminiPresetPrompt(geminiPreset, decision.issues, backdropPhrase(id, language), language))
  }
  const chooseGeminiPreset = (preset: GeminiPresetId) => {
    setGeminiPreset(preset)
    setAuthored(false)
    setPrompt(buildGeminiPresetPrompt(preset, decision.issues, backdropPhrase(aiBackdrop, language), language))
    // The preset's own floor rather than a list of ids, and the size then
    // decides the model: Flash Lite serves 1K only, so a preset that needs 2K
    // has to move off it or every request comes back as a 404 that reads like
    // a bad model id. Measured against the live API on 2026-09-06.
    const floor = GEMINI_PRESETS.find((entry) => entry.id === preset)?.minSize ?? '1K'
    const size = IMAGE_SIZES.indexOf(imageSize) < IMAGE_SIZES.indexOf(floor) ? floor : imageSize
    setImageSize(size)
    setAiModel((current) => modelForSize(current, size))
  }

  // Raising the size can outrun the chosen model, so the two are reconciled in
  // one place: the size is what the work needs, the model follows it.
  const chooseImageSize = (size: ImageSize) => {
    setImageSize(size)
    setAiModel((current) => modelForSize(current, size))
  }
  // Each step clears exactly what it consumed, and nothing else. A blanket
  // reset made sense while one button applied everything at once; with a button
  // per group it would throw away pending work in groups the user never
  // touched — apply a crop and lose the rotation you had dialled in.
  // `squareCrop` and `paletteMode` are deliberately absent from all of these:
  // they are modes rather than pending operations, and a mode survives.
  const resetCrop = () => setCrop(EMPTY_CROP)
  const resetStraighten = () => setRotation(0)
  const resetPaint = () => {
    setPaintEnabled(false)
    paintStrokesRef.current = []
    setPaintStrokes([])
    setPaintRedoStrokes([])
  }
  const resetAdjustments = () => {
    setTrim(false)
    setCenter(false)
    setBorderOn(false)
    setSwapBackdropOn(false)
    setRecolour(false)
    setFlattenPalette(false)
    setPaletteAnalysis(null)
  }
  const resetOutput = () => setUpscale(1)
  // Moving between revisions is the one case that still clears everything: the
  // base every pending control was dialled in against has been swapped out.
  const resetOperationControls = () => {
    resetCrop()
    resetStraighten()
    resetPaint()
    resetAdjustments()
    resetOutput()
    setPaletteMode('auto')
    // Zoom is deliberately not reset here. These controls are reset so an
    // operation cannot be applied twice, and zoom is not an operation — it is
    // how the user is looking at the image, like the scroll position, and it
    // is never sent to the processor. Resetting it threw the user back to
    // fit-to-window on every revision, which meant on every fill, every paint
    // batch and every Undo: exactly the clicks you are most likely to be
    // zoomed in for. Fill used to save and restore it by hand to work around
    // this; nothing has to now.
  }
  // A revision clears what produced it and leaves the rest alone. Fill, Replace
  // and a reconstruction consume no pending control at all, so they pass
  // nothing and every dialled-in setting survives them.
  const addRevision = (result: ProcessResult, reset: () => void = () => undefined) => {
    setTimeline((current) => appendRevision(current.revisions, current.index, result))
    reset()
  }
  // One step of the pipeline, run on its own. Every local operation goes
  // through this: a quarter turn applied as it is clicked, and each group's own
  // Apply button. The single `Apply local changes` button that used to run all
  // of them together is gone (2026-09-08) — with Undo and Redo covering the
  // risk it was a confirmation of decisions already made, and batching
  // unrelated operations meant pressing it could not be predicted from any one
  // control. Fields not named default to neutral, so a step can never carry a
  // setting from a group the user was not applying.
  const applyStep = async (busyLabel: string, describe: (revision: number) => string, request: Partial<ProcessRequest>, reset: () => void) => {
    onBusy(busyLabel)
    try {
      const result = await window.moodprep.processImage({
        projectPath,
        imagePath: working.outputPath,
        crop: { left: 0, right: 0, top: 0, bottom: 0 },
        trim: false,
        center: false,
        background,
        upscale: 1,
        outputFormat: format,
        paletteColors: 0,
        ...request,
      })
      addRevision(result, reset)
      onNotice(describe(timeline.index + 1))
    } catch (error) { onNotice(errorMessage(error)) } finally { onBusy(null) }
  }
  const applyCrop = () => applyStep(
    t('Applying the crop…'),
    (revision) => t('Crop applied · revision {n}. Undo remains available.', { n: revision }),
    { crop, squareCrop: squareCrop || undefined },
    resetCrop,
  )
  const applyStraighten = () => applyStep(
    t('Straightening…'),
    (revision) => t('Straightened {degrees}° · revision {n}. Undo remains available.', { degrees: rotation.toFixed(1), n: revision }),
    { rotation },
    resetStraighten,
  )
  const applyOutput = () => applyStep(
    t('Resizing…'),
    (revision) => t('Resized {factor}× · revision {n}. Undo remains available.', { factor: upscale, n: revision }),
    { upscale },
    resetOutput,
  )
  const applyAdjustments = async () => {
    let paletteColors = 0
    if (flattenPalette) {
      if (paletteMode === 'auto') {
        try {
          const analysis = paletteAnalysis ?? await window.moodprep.detectPalette(working.outputPath)
          paletteColors = analysis.recommendedColors
        } catch (error) { onNotice(errorMessage(error)); return }
      } else {
        paletteColors = paletteMode
      }
    }
    await applyStep(
      t('Applying the adjustments…'),
      (revision) => t(paletteColors ? 'Adjustments applied with {colours} palette colours · revision {n}. Undo remains available.' : 'Adjustments applied · revision {n}. Undo remains available.', { colours: paletteColors, n: revision }),
      {
        trim,
        center,
        paletteColors,
        border: borderOn ? { width: borderWidth, colour: background } : undefined,
        swapBackdrop: swapBackdropOn ? { colour: background, tolerance: backdropTolerance } : undefined,
        recolour: recolour ? { variation: recolourVariation, amount: recolourAmount } : undefined,
      },
      resetAdjustments,
    )
  }
  // What each group has waiting, so its own Apply can say so and stay disabled
  // until there is something to do.
  const cropPending = crop.left !== 0 || crop.right !== 0 || crop.top !== 0 || crop.bottom !== 0
  const adjustmentsPending = trim || center || borderOn || swapBackdropOn || recolour || flattenPalette
  // Sizes at or above what this preset needs. Below the floor is not a choice:
  // Complete edges and Photographed coaster are pointless at 1K, and offering
  // it is what let Flash Lite look like a valid pairing for them.
  const presetFloor = GEMINI_PRESETS.find((entry) => entry.id === geminiPreset)?.minSize ?? '1K'
  const sizeChoices = IMAGE_SIZES.slice(IMAGE_SIZES.indexOf(presetFloor))
  const chosenModel = modelById(aiModel)
  const modelReady = keyStatus[chosenModel.provider]
  const runGemini = async () => {
    if (!modelReady) { openSettings(); return }
    onBusy(t('{provider} is reconstructing this image. This can take a minute…', { provider: PROVIDER_LABELS[chosenModel.provider] }))
    try {
      const result = await window.moodprep.aiEdit({
        projectPath,
        imagePath: working.outputPath,
        prompt,
        // Reconciled once more on the way out. The menus already exclude a
        // model that cannot serve the chosen size, but this is the pairing that
        // returns HTTP 404 `Requested entity was not found` — an error naming
        // nothing — so it is worth making impossible rather than merely unlikely.
        model: modelForSize(chosenModel.id, imageSize),
        imageSize,
        completeEdges: geminiPreset === 'outpaint' || undefined,
        canvasBackground: geminiPreset === 'outpaint' ? background : undefined,
        isolateOn: geminiPreset === 'coaster' ? (backdropById(aiBackdrop).hex ?? undefined) : undefined,
        squareCanvas: geminiPreset === 'coaster' || undefined,
      })
      addRevision(result)
      onNotice(t('{model} revision applied. Inspect lettering and geometry; Undo remains available.', { model: t(chosenModel.label) }))
    } catch (error) { onNotice(errorMessage(error)) } finally { onBusy(null) }
  }
  const moveToRevision = (index: number) => {
    setTimeline((current) => ({ ...current, index: Math.max(0, Math.min(index, current.revisions.length - 1)) }))
    resetOperationControls()
  }
  const updatePaintStrokes: Dispatch<SetStateAction<PaintStroke[]>> = (update) => {
    setPaintRedoStrokes([])
    setPaintStrokes((current) => {
      const next = typeof update === 'function' ? (update as (value: PaintStroke[]) => PaintStroke[])(current) : update
      paintStrokesRef.current = next
      return next
    })
  }
  // Paint applies as the brush lifts, the way Fill applies as you click. There
  // is no Apply button because a brush is a direct tool: what you drew is what
  // the image now is, and Undo takes back one stroke at a time. The full-screen
  // busy overlay is deliberately not used — it would flash on every stroke —
  // so the stroke stays drawn on the preview until its revision arrives, which
  // is the same picture either way.
  //
  // Runs are serialised rather than fired per stroke: painting is quick and the
  // round trip is not, so a stroke drawn while one is still in the pipeline is
  // picked up by the next run instead of racing it from a stale base.
  const flushStrokes = async () => {
    if (paintingRef.current) return
    const sending = paintStrokesRef.current
    if (sending.length === 0) return
    const count = sending.length
    paintingRef.current = true
    try {
      const result = await window.moodprep.processImage({
        projectPath,
        imagePath: working.outputPath,
        crop: EMPTY_CROP,
        trim: false,
        center: false,
        background,
        upscale: 1,
        outputFormat: format,
        paletteColors: 0,
        paintStrokes: sending.slice(0, count),
      })
      setPaintStrokes((current) => {
        // Only what was sent is cleared; anything drawn since is still pending.
        const remaining = current.slice(count)
        paintStrokesRef.current = remaining
        return remaining
      })
      addRevision(result)
    } catch (error) {
      onNotice(t('Could not paint that stroke: {error}', { error: errorMessage(error) }))
    } finally {
      paintingRef.current = false
      if (paintStrokesRef.current.length > 0) void flushStrokes()
    }
  }
  const undoWorkbench = () => {
    if (paintStrokes.length > 0) {
      const stroke = paintStrokes[paintStrokes.length - 1]
      setPaintStrokes((current) => current.slice(0, -1))
      setPaintRedoStrokes((current) => [...current, stroke])
      return
    }
    moveToRevision(timeline.index - 1)
  }
  const redoWorkbench = () => {
    if (paintRedoStrokes.length > 0) {
      const stroke = paintRedoStrokes[paintRedoStrokes.length - 1]
      setPaintRedoStrokes((current) => current.slice(0, -1))
      setPaintStrokes((current) => [...current, stroke])
      return
    }
    moveToRevision(timeline.index + 1)
  }
  // Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z drive the same history as the on-screen
  // buttons, including the pending paint strokes they step through.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const intent = undoRedoIntent(event, isTextEntryElement(event.target as HTMLElement | null))
      if (!intent) return
      event.preventDefault()
      event.stopPropagation()
      if (intent === 'undo') undoWorkbench()
      else redoWorkbench()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })
  const returnToOriginal = () => {
    if (timeline.index !== 0) {
      moveToRevision(0)
      return
    }
    setPaintStrokes([])
    setPaintRedoStrokes([])
  }
  const toggleBackgroundPaint = () => {
    setSampleMode(null)
    setPaintEnabled((enabled) => {
      const next = !enabled
      if (next && (trim || center)) {
        setTrim(false)
        setCenter(false)
      }
      return next
    })
  }
  // Honour a Rotation Needed tag the way border/off-centre tags pre-fill their
  // controls: suggest the detected angle once when the workbench opens.
  useEffect(() => {
    if (startsFromProcessedResult || !decision.issues.includes('rotation_needed')) return
    let cancelled = false
    setRotationDetecting(true)
    window.moodprep.detectRotation(working.outputPath)
      .then((result) => {
        if (cancelled || result.rotation === 0) return
        setRotationDegrees(result.rotation)
        onNotice(t('Auto-straighten suggests {degrees}° from its Rotation Needed tag. Fine-tune with the slider, then apply local changes.', { degrees: result.rotation.toFixed(1) }))
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setRotationDetecting(false) })
    return () => { cancelled = true }
    // Mount-only by design: the suggestion belongs to the image the dialog opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const useAutomaticRotation = async () => {
    setRotationDetecting(true)
    try {
      const result = await window.moodprep.detectRotation(working.outputPath)
      if (result.rotation === 0) {
        setRotationDegrees(0)
        onNotice(t('No confident tilt detected; the artwork already reads as level.'))
      } else {
        setRotationDegrees(result.rotation)
        onNotice(t('Auto-straighten suggests {degrees}°. Fine-tune with the slider, then apply local changes.', { degrees: result.rotation.toFixed(1) }))
      }
    } catch (error) {
      onNotice(t('Could not analyze the rotation: {error}', { error: errorMessage(error) }))
    } finally {
      setRotationDetecting(false)
    }
  }
  // Pure white and pure black are always offered: they are the two values the
  // rest of the pipeline leans on, and a coaster isolated on black is swapped
  // to white from here in one click. The two standard tee greys follow, so a
  // design can be judged on the garment it will be printed on. The image's own
  // dominant colours come last, deduplicated against all four so the row never
  // shows the same chip twice.
  const presetColours = useMemo(() => {
    const entries: Array<{ color: string; label: string }> = [...GARMENT_COLOURS, ...KEY_COLOURS]
    for (const colour of imageColours) {
      const normalized = normalizeHexColor(colour)
      if (!normalized || entries.some((entry) => entry.color === normalized)) continue
      entries.push({ color: normalized, label: 'From this image' })
    }
    return entries
  }, [imageColours])

  const colourControls = () => (
    <div className="colour-control">
      <div className="colour-main">
        <label className="colour-chip" title={t('Open the system colour picker')}>
          <span style={{ background }} aria-hidden="true" />
          <input type="color" value={background} onChange={(event) => chooseBackground(event.target.value)} aria-label={t('Working colour')} />
        </label>
        <label className="colour-hex">
          <span aria-hidden="true">#</span>
          <input
            type="text"
            value={backgroundText.replace(/^#/, '')}
            onChange={(event) => typeBackgroundHex(event.target.value)}
            onBlur={() => setBackgroundText(background)}
            spellCheck={false}
            autoComplete="off"
            maxLength={6}
            aria-label={t('Working colour hex code')}
            title={t('Type or paste a hex code')}
          />
        </label>
        <button type="button" className={`colour-auto ${automaticBackground ? 'active' : ''}`} onClick={useAutomaticBackground} title={t("Detect the image's dominant background colour")}><Sparkles size={12} /> {t('Auto')}</button>
      </div>
      <div className="colour-presets">
        {presetColours.map((preset, index) => (
          <Fragment key={preset.color}>
            {/* the note introduces the sampled colours rather than trailing them */}
            {index === GARMENT_COLOURS.length && <span className="colour-presets-note">{t('for keying a fill')}</span>}
            {index === GARMENT_COLOURS.length + KEY_COLOURS.length && <span className="colour-presets-note">{t('from this image')}</span>}
            <button
              type="button"
              className={`colour-preset ${background.toLowerCase() === preset.color ? 'active' : ''}`}
              style={{ background: preset.color }}
              onClick={() => chooseBackground(preset.color)}
              title={`${t(preset.label)} · ${preset.color.toUpperCase()}`}
              aria-label={`${t(preset.label)} ${preset.color}`}
            />
          </Fragment>
        ))}
      </div>
    </div>
  )
  const activeTool: CanvasTool = sampleMode ?? (paintEnabled ? 'paint' : 'crop')
  const selectTool = (tool: CanvasTool) => {
    if (tool === 'paint') {
      setSampleMode(null)
      setPaintEnabled(true)
      // Auto-trim and centring would crop away freshly painted edge pixels.
      setTrim(false)
      setCenter(false)
      return
    }
    setPaintEnabled(false)
    setSampleMode(tool === 'crop' ? null : tool)
  }
  const handleStageSample = async (point: PaintPoint) => {
    if (sampleMode === 'pick') {
      try {
        const picked = await window.moodprep.samplePixel(working.outputPath, point.x, point.y)
        setBackground(picked.color)
        setAutomaticBackground(false)
        setSampleMode(null)
        onNotice(t('Picked {colour} from the image. It is now the fill and background colour.', { colour: picked.color.toUpperCase() }))
      } catch (error) {
        onNotice(t('Could not read that pixel: {error}', { error: errorMessage(error) }))
      }
      return
    }
    if ((sampleMode !== 'fill' && sampleMode !== 'replace') || filling) return
    setFilling(true)
    try {
      const result = await window.moodprep.fillArea({
        projectPath,
        imagePath: working.outputPath,
        x: point.x,
        y: point.y,
        color: background,
        tolerance: fillTolerance,
        scope: sampleMode === 'replace' ? 'global' : 'contiguous',
      })
      // Fill is a click-repeat tool: the zoom and the scroll position the user
      // is working at both survive the revision on their own now.
      addRevision(result)
      onNotice(t(sampleMode === 'replace'
        ? 'Replaced that colour with {colour} across the whole image · revision {n}. Undo remains available.'
        : 'Filled with {colour} · revision {n}. Undo remains available.', { colour: background.toUpperCase(), n: timeline.index + 1 }))
    } catch (error) {
      onNotice(t(sampleMode === 'replace' ? 'Could not replace that colour: {error}' : 'Could not fill that area: {error}', { error: errorMessage(error) }))
    } finally {
      setFilling(false)
    }
  }
  // A quarter turn is applied as it is clicked rather than held pending. It is
  // the one rotation that costs nothing to commit — 90° is a transpose, not a
  // resample, so turning now and straightening afterwards is no worse than
  // composing the two — and holding it pending was what disabled crop and
  // painting until the batch was applied, on an image the user had merely
  // stood upright. The ±10° slider still composes and still waits for Apply.
  const turnQuarter = (delta: number) => {
    setPaintEnabled(false)
    void applyStep(
      t('Turning the image…'),
      (revision) => t(delta < 0 ? 'Turned 90° left · revision {n}. Undo remains available.' : 'Turned 90° right · revision {n}. Undo remains available.', { n: revision }),
      { rotation: delta < 0 ? -90 : 90 },
      () => undefined,
    )
  }
  const resetRotation = () => {
    setRotationDegrees(0)
  }
  const setRotationDegrees = (value: number) => {
    if (!Number.isFinite(value)) return
    const rounded = Math.round(Math.max(-ROTATION_LIMIT, Math.min(ROTATION_LIMIT, value)) * 10) / 10
    setRotation(Object.is(rounded, -0) ? 0 : rounded)
    if (rounded !== 0) { setPaintEnabled(false); setSampleMode(null) }
  }
  // One angle for both the live preview and the processor. Quarter turns are no
  // longer part of it: they are applied as they are clicked, so the only
  // rotation still waiting for Apply is the fine slider.
  const stageRotation = rotation
  // Like a crop, the shift keeps applying once set even after the tool is put
  // away; only the ring itself belongs to the tool.
  const rotationChanged = rotation !== 0
  const hasModifiedResult = working.outputPath !== image.path
  const qualityAccepted = canAcceptQuality(working.quality.score)
  const qualityCanReplace = qualityAccepted || qualityOverride
  const qualityDelta = working.quality.score - image.quality.score
  const qualitySuggestions = [...new Set(working.quality.reasons.map(qualitySuggestion))]
  const acceptWorking = async () => {
    if (!hasModifiedResult || !qualityCanReplace) return
    // Undo has to put the decision back as well as the file: committing clears
    // the issue tags and marks the image processed, and a restored original
    // still has whatever was wrong with it.
    const previousDecision: Partial<ImageDecision> = {
      issues: decision.issues,
      sourcePath: decision.sourcePath,
      processedAt: decision.processedAt,
      backupAcknowledged: decision.backupAcknowledged,
      outputPath: decision.outputPath,
      outputThumbnail: decision.outputThumbnail,
      outputQuality: decision.outputQuality,
    }
    onBusy(t('Backing up the original and saving the approved image…'))
    try {
      const committed = await window.moodprep.commitProcessedImage(projectPath, image.path, working.outputPath)
      onUpdate({
        issues: [],
        sourcePath: image.path,
        processedAt: new Date().toISOString(),
        backupAcknowledged: true,
        outputPath: image.path,
        outputThumbnail: working.thumbnailDataUrl,
        outputQuality: working.quality,
      })
      onClose()
      onCommitted(image, working)
      onNotice({
        message: t('Saved over {name} — previous version kept in moodprep-originals.', { name: image.name }),
        action: {
          label: t('Undo'),
          run: async () => {
            try {
              await window.moodprep.revertCommittedImage(projectPath, image.path, committed.backupPath)
              onUpdate(previousDecision)
              onReverted(image)
              onNotice(t('Put {name} back. The saved version was discarded.', { name: image.name }))
            } catch (error) {
              onNotice(t('Could not undo that save: {error}', { error: errorMessage(error) }))
            }
          },
        },
      })
    } catch (error) {
      onNotice(errorMessage(error))
    } finally {
      onBusy(null)
    }
  }
  const deleteImage = async () => {
    setDeleting(true)
    try {
      const result = await window.moodprep.deleteImage(projectPath, image.path, deletionLabels(t, [image.name]))
      if (!result.deleted) return
      onClose()
      onDeleted(image)
      onNotice(t('{name} was moved to Trash. Reference backups were kept.', { name: image.name }))
    } catch (error) {
      onNotice(t('Could not delete {name}: {error}', { name: image.name, error: errorMessage(error) }))
    } finally {
      setDeleting(false)
    }
  }
  const copyFilename = async () => {
    try {
      try {
        await window.moodprep.copyText(image.name)
      } catch {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(image.name)
        } else {
          const textarea = document.createElement('textarea')
          textarea.value = image.name
          textarea.setAttribute('readonly', '')
          textarea.style.position = 'fixed'
          textarea.style.opacity = '0'
          document.body.appendChild(textarea)
          textarea.select()
          const copied = document.execCommand('copy')
          textarea.remove()
          if (!copied) throw new Error(t('The system clipboard rejected the copy request.'))
        }
      }
      setFilenameCopied(true)
      window.setTimeout(() => setFilenameCopied(false), 1800)
      onNotice(t('Copied {name}', { name: image.name }))
    } catch (error) {
      onNotice(t('Could not copy the filename: {error}', { error: errorMessage(error) }))
    }
  }
  return (
    <div className="modal-backdrop editor-backdrop" role="dialog" aria-modal="true" aria-label={t('Edit {name}', { name: image.name })}>
      <div className="editor-dialog">
        <header><div><span>{t('Processing workbench')}</span><button type="button" className={`filename-copy ${filenameCopied ? 'copied' : ''}`} onClick={copyFilename} title={t('Copy full filename')} aria-label={t('Copy full filename: {name}', { name: image.name })}><strong>{image.name}</strong>{filenameCopied ? <><Check size={13} /><em>{t('Copied')}</em></> : <><Copy size={13} /><em>{t('Copy')}</em></>}</button></div><button className="icon-button" onClick={onClose} aria-label={t('Close')}><X size={19} /></button></header>
        <div className="editor-body">
          <div className="comparison-stage">
            <div className="compare-label">{peekTarget ? (timeline.index - 1 === 0 ? t('Before · original') : t('Before · revision {n}', { n: timeline.index - 1 })) : timeline.index === 0 ? t('Original') : t('Working revision {n} of {total}', { n: timeline.index, total: timeline.revisions.length - 1 })}</div>
            <ImageStage
              image={{
                name: image.name,
                width: visibleResult.width,
                height: visibleResult.height,
                thumbnailDataUrl: editorPreview?.path === visibleResult.outputPath ? editorPreview.dataUrl : visibleResult.thumbnailDataUrl,
              }}
              crop={crop}
              onChange={setCrop}
              zoom={zoom}
              rotation={peekTarget ? 0 : stageRotation}
              cropEnabled={activeTool === 'crop' && !rotationChanged && !peekTarget}
              squareCrop={squareCrop}
              paintEnabled={paintEnabled && !peekTarget}
              paintStrokes={peekTarget ? [] : paintStrokes}
              paintColor={background}
              brushSize={brushSize}
              brushShape={brushShape}
              showLevelGrid={rotationChanged || straightening}
              sampleMode={peekTarget ? null : sampleMode}
              onSample={handleStageSample}
              onPaint={updatePaintStrokes}
              onStrokeEnd={() => void flushStrokes()}
            />
            <div className="revision-actions" aria-label={t('Revision history controls')}>
              <button type="button" onClick={undoWorkbench} disabled={paintStrokes.length === 0 && timeline.index === 0} title={t('Undo (⌘Z)')}><Undo2 size={13} /> {t('Undo')}</button>
              <button type="button" onClick={redoWorkbench} disabled={paintRedoStrokes.length === 0 && timeline.index >= timeline.revisions.length - 1} title={t('Redo (⇧⌘Z)')}><Redo2 size={13} /> {t('Redo')}</button>
              <button type="button" onClick={returnToOriginal} disabled={paintStrokes.length === 0 && paintRedoStrokes.length === 0 && timeline.index === 0}><RotateCcw size={13} /> {t('Return to original')}</button>
              <button
                type="button"
                className={`peek ${peekTarget ? 'active' : ''}`}
                disabled={timeline.index === 0}
                onPointerDown={(event) => { event.preventDefault(); setPeeking(true) }}
                onPointerUp={() => setPeeking(false)}
                onPointerLeave={() => setPeeking(false)}
                onPointerCancel={() => setPeeking(false)}
                onKeyDown={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); setPeeking(true) } }}
                onKeyUp={() => setPeeking(false)}
                onBlur={() => setPeeking(false)}
                title={t('Hold to see the previous revision without changing anything')}
              ><Eye size={13} /> {t('Before')}</button>
            </div>
            <div className="stage-zoom-controls" aria-label={t('Preview zoom controls')}>
              <button type="button" onClick={() => setZoom((value) => Math.max(1, value - .25))} disabled={zoom <= 1} aria-label={t('Zoom out')}><ZoomOut size={14} /></button>
              <button type="button" className="zoom-level" onClick={() => setZoom(1)} title={t('Fit image to window')}>{Math.round(zoom * 100)}%</button>
              <button type="button" onClick={() => setZoom((value) => Math.min(4, value + .25))} disabled={zoom >= 4} aria-label={t('Zoom in')}><ZoomIn size={14} /></button>
            </div>
            <div className="stage-meta"><span>{visibleResult.width} × {visibleResult.height}</span><span>{formatBytes(image.bytes)}</span><span>{t('Quality {score}/100', { score: visibleResult.quality.score })}</span></div>
          </div>
          <div className="editor-controls">
            <section>
              <div className="control-heading"><span>{t('Issue tags')}</span><small>{t('Select everything that should change')}</small></div>
              <div className="issue-chips">{ISSUE_TYPES.map((issue) => (
                <button
                  key={issue}
                  className={`${decision.issues.includes(issue) ? 'active' : ''} ${pendingIssueRemoval === issue ? 'removing' : ''}`}
                  onClick={() => toggleIssue(issue)}
                  aria-pressed={decision.issues.includes(issue)}
                  title={t(decision.issues.includes(issue) ? 'Remove the {tag} tag' : 'Tag this image as {tag}', { tag: t(humanIssue(issue)) })}
                >{decision.issues.includes(issue) && <Check size={12} />}{t(humanIssue(issue))}</button>
              ))}</div>
              {pendingIssueRemoval && (
                <div className="issue-confirm" role="alert">
                  <CircleAlert size={15} />
                  <span><strong>{t('Remove the {tag} tag?', { tag: t(humanIssue(pendingIssueRemoval)) })}</strong><small>{t('This records that the issue does not apply to this image.')}</small></span>
                  <button type="button" className="issue-confirm-cancel" onClick={() => setPendingIssueRemoval(null)}>{t('Keep it')}</button>
                  <button type="button" className="issue-confirm-accept" onClick={confirmIssueRemoval}><Check size={13} /> {t('Remove tag')}</button>
                </div>
              )}
            </section>
            <section className={`quality-review ${hasModifiedResult && !qualityAccepted ? 'warning' : ''}`}>
              <div className="control-heading"><span>{t('Revision quality')}</span><small>{t('Automated signal · verify visually')}</small></div>
              <div className="quality-score-row">
                <div><small>{t('Original')}</small><strong>{image.quality.score}</strong></div>
                <ChevronRight size={16} />
                <div><small>{hasModifiedResult ? t('This revision') : t('Current image')}</small><strong>{working.quality.score}</strong></div>
                {hasModifiedResult && <span className={`quality-delta ${qualityDelta > 0 ? 'positive' : qualityDelta < 0 ? 'negative' : ''}`}>{qualityDelta > 0 ? '+' : ''}{qualityDelta}</span>}
                <span className={`quality-verdict ${qualityAccepted ? 'ready' : ''}`}>{qualityAccepted ? t('Recommended') : t('Below {n}', { n: QUALITY_RECOMMENDED_SCORE })}</span>
              </div>
              <div className="quality-detail-columns">
                <div><strong>{t('What the score noticed')}</strong><ul>{working.quality.reasons.map((reason) => <li key={reason}>{translateQualityReason(reason, t)}</li>)}</ul></div>
                <div><strong>{t('Suggested next step')}</strong><ul>{qualitySuggestions.map((suggestion) => <li key={suggestion}>{t(suggestion)}</li>)}</ul></div>
              </div>
              {hasModifiedResult && !qualityAccepted && (
                <label className="quality-override">
                  <input type="checkbox" checked={qualityOverride} onChange={(event) => setQualityOverride(event.target.checked)} />
                  <span><strong>{t('Replace despite the warning')}</strong><small>{t('I inspected the revision and prefer it to the original.')}</small></span>
                </label>
              )}
            </section>
            <section>
              <div className="control-heading"><span>{t('Precise local tools')}</span><small>{t('No API call · fully deterministic')}</small></div>

              <div className="tool-group">
                <div className="tool-group-heading"><span>{t('Canvas tool')}</span><small>{rotationChanged ? t('Apply or reset the rotation to use these') : t('One at a time, used directly on the preview')}</small></div>
                <div className="tool-strip" role="group" aria-label={t('Canvas tool')}>
                  {CANVAS_TOOLS.map((tool) => {
                    const Icon = tool.icon
                    return (
                      <button
                        key={tool.id}
                        type="button"
                        className={activeTool === tool.id ? 'active' : ''}
                        onClick={() => selectTool(tool.id)}
                        aria-pressed={activeTool === tool.id}
                        disabled={rotationChanged || ((tool.id === 'fill' || tool.id === 'replace') && filling)}
                        title={rotationChanged ? t('Apply or reset the rotation first') : t(tool.hint)}
                      >
                        {(tool.id === 'fill' || tool.id === 'replace') && filling && activeTool === tool.id ? <LoaderCircle className="spin" size={16} /> : <Icon size={16} />}
                        <span>{t(tool.label)}</span>
                      </button>
                    )
                  })}
                </div>

                {activeTool === 'crop' && (
                  <div className="tool-options">
                    <div className="tool-options-row">
                      <span className="tool-note">{t('Drag the frame’s edges, corners, or centre.')}</span>
                      <button type="button" className="tool-reset" onClick={() => { setCrop(EMPTY_CROP); }} disabled={Object.values(crop).every((value) => value === 0)}><RotateCcw size={12} /> {t('Reset')}</button>
                    </div>
                    <button
                      type="button"
                      className={`crop-lock ${squareCrop ? 'active' : ''}`}
                      aria-pressed={squareCrop}
                      onClick={() => setSquareCrop((current) => {
                        const next = !current
                        // Switching the lock on squares whatever frame is already
                        // there, so the toggle is immediately truthful.
                        if (next) setCrop((frame) => squareCropInsets(frame, working.width, working.height, []))
                        return next
                      })}
                      title={t('Constrain the crop frame to a perfect square')}
                    >
                      <Ratio size={13} /> <span>{t('1:1 square')}</span><b>{squareCrop ? t('On') : t('Off')}</b>
                    </button>
                    <div className="crop-values" aria-label={t('Crop margins')}>
                      <span>L <b>{Math.round(crop.left)}%</b></span>
                      <span>R <b>{Math.round(crop.right)}%</b></span>
                      <span>T <b>{Math.round(crop.top)}%</b></span>
                      <span>B <b>{Math.round(crop.bottom)}%</b></span>
                    </div>
                    <span className="crop-size">{t('Output {size}', { size: (() => { const size = cropPixelSize(crop, working.width, working.height, squareCrop); return `${size.width} × ${size.height} px` })() })}</span>
                    <button type="button" className="apply-step" onClick={applyCrop} disabled={!cropPending}>{t('Apply crop')}</button>
                  </div>
                )}

                {activeTool === 'paint' && (
                  <div className="tool-options">
                    <label className="tool-slider">{t('Brush')} <input type="range" min="0" max={BRUSH_SLIDER_STEPS} step="1" value={brushSliderPosition(brushSize, working.width, working.height)} onChange={(event) => setBrushSize(brushSizeFromPixels(brushPixelsFromSlider(Number(event.target.value), working.width, working.height), working.width, working.height))} aria-label={t('Background paint brush size in source pixels')} /><b>{brushPixelsFromSize(brushSize, working.width, working.height)} px</b></label>
                    <div className="tool-options-row">
                      <span className="tool-note">{t('Paints with the working colour below. Each stroke lands as you lift the brush and Undo takes back one stroke at a time, so there is nothing to apply. Sized in source pixels, from {min} to {max}; below about nine screen pixels the brush shows a crosshair instead of a ring.', { min: BRUSH_MIN_PIXELS, max: brushMaxPixels(working.width, working.height) })}</span>
                      <div className="brush-shapes" role="group" aria-label={t('Background paint brush shape')}>
                        <button type="button" className={brushShape === 'circle' ? 'active' : ''} onClick={() => setBrushShape('circle')} aria-pressed={brushShape === 'circle'} title={t('Circle brush')}><Circle size={12} /> {t('Circle')}</button>
                        <button type="button" className={brushShape === 'square' ? 'active' : ''} onClick={() => setBrushShape('square')} aria-pressed={brushShape === 'square'} title={t('Square brush')}><Square size={12} /> {t('Square')}</button>
                      </div>
                    </div>
                  </div>
                )}

                {activeTool === 'pick' && (
                  <div className="tool-options">
                    <span className="tool-note">{t('Click the preview to take that pixel’s colour. It becomes the working colour below.')}</span>
                  </div>
                )}

                {activeTool === 'replace' && (
                  <div className="tool-options">
                    <label className="tool-slider">{t('Match')} <input type="range" min="1" max="60" step="1" value={fillTolerance} onChange={(event) => setFillTolerance(Number(event.target.value))} aria-label={t('Replace colour match tolerance')} /><b>{fillTolerance}%</b></label>
                    <span className="tool-note">{t('Click any colour to swap it for the working colour ')}<strong>{t('everywhere in the image')}</strong>{t(', including pockets the bucket cannot reach. Soft edges are eased across, so lettering stays clean.')}</span>
                  </div>
                )}
                {activeTool === 'fill' && (
                  <div className="tool-options">
                    <label className="tool-slider">{t('Match')} <input type="range" min="1" max="60" step="1" value={fillTolerance} onChange={(event) => setFillTolerance(Number(event.target.value))} aria-label={t('Fill colour match tolerance')} /><b>{fillTolerance}%</b></label>
                    <span className="tool-note">{t('Click an area to flood it with the working colour. Each fill is its own revision, so ⌘Z steps back one fill.')}</span>
                  </div>
                )}
              </div>

              <div className="tool-group">
                <div className="tool-group-heading"><span>{t('Working colour')}</span><small>{t('Paint, fill, straighten canvas & centring')}</small></div>
                {colourControls()}
              </div>

              <div
                className={`tool-group ${rotationChanged ? 'engaged' : ''}`}
                onFocusCapture={() => setStraightening(true)}
                onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setStraightening(false) }}
              >
                <div className="tool-group-heading"><span>{t('Straighten')}</span><small>{t('±{n}° · quarter turns apply at once', { n: ROTATION_LIMIT })}</small></div>
                <div className="rotation-tool">
                  <input type="range" min={-ROTATION_LIMIT} max={ROTATION_LIMIT} step="0.1" value={rotation} onChange={(event) => setRotationDegrees(Number(event.target.value))} aria-label={t('Image rotation in degrees')} />
                  <label className="rotation-value"><input type="number" min={-ROTATION_LIMIT} max={ROTATION_LIMIT} step="0.1" value={rotation.toFixed(1)} onChange={(event) => setRotationDegrees(Number(event.target.value))} aria-label={t('Rotation degrees')} /><span>°</span></label>
                  <button type="button" className="rotation-auto" onClick={useAutomaticRotation} disabled={rotationDetecting} aria-label={t('Detect the rotation that levels the artwork')} title={t('Detect the rotation that levels the artwork')}>{rotationDetecting ? <LoaderCircle className="spin" size={12} /> : <Sparkles size={12} />} {t('Auto')}</button>
                </div>
                <div className="rotation-quarters">
                  <button type="button" onClick={() => turnQuarter(-1)} aria-label={t('Rotate 90 degrees left')} title={t('Rotate 90° left')}><RotateCcw size={13} /> 90°</button>
                  <button type="button" onClick={() => turnQuarter(1)} aria-label={t('Rotate 90 degrees right')} title={t('Rotate 90° right')}><RotateCw size={13} /> 90°</button>
                  <button type="button" className="rotation-reset" onClick={resetRotation} disabled={!rotationChanged} aria-label={t('Reset image rotation')} title={t('Reset rotation')}><RotateCcw size={13} /></button>
                </div>
                <button type="button" className="apply-step" onClick={applyStraighten} disabled={!rotationChanged}>{t('Apply rotation')}</button>
              </div>

              <div className="tool-group">
                <div className="tool-group-heading"><span>{t('Adjustments')}</span><small>{t('Tick what you want, then apply')}</small></div>
                <label className="adjust-row" title={paintEnabled ? t('Turn off Paint before using Auto-trim') : undefined}>
                  <input type="checkbox" checked={trim} onChange={(event) => setTrim(event.target.checked)} disabled={paintEnabled} />
                  <span><strong>{t('Auto-trim border')}</strong><small>{t('Cut away blank surrounding margin')}</small></span>
                </label>
                <label className="adjust-row" title={paintEnabled ? t('Turn off Paint before centring content') : undefined}>
                  <input type="checkbox" checked={center} onChange={(event) => setCenter(event.target.checked)} disabled={paintEnabled} />
                  <span><strong>{t('Centre content')}</strong><small>{t('Even margins in the working colour')}</small></span>
                </label>
                <label className="adjust-row">
                  <input type="checkbox" checked={borderOn} onChange={(event) => setBorderOn(event.target.checked)} />
                  <span><strong>{t('Add border')}</strong><small>{t('Frame the artwork in the working colour')}</small></span>
                </label>
                {borderOn && (() => {
                  const edge = borderPixels(borderWidth, working.width, working.height)
                  const framed = borderedSize(working.width, working.height, borderWidth)
                  return (
                    <div className="tool-options">
                      <label className="tool-slider">{t('Width')} <input type="range" min={Math.round(BORDER_MIN * 1000)} max={Math.round(BORDER_MAX * 1000)} step="1" value={Math.round(borderWidth * 1000)} onChange={(event) => setBorderWidth(clampBorder(Number(event.target.value) / 1000))} aria-label={t('Border width')} /><b>{edge} px</b></label>
                      <span className="tool-note">{t('Added outside the artwork in the working colour, so nothing is covered and the saved image becomes {width} × {height} px. The width is a share of the shorter edge ({share}%), so it keeps its proportion if the image is cropped or upscaled.', { width: framed.width, height: framed.height, share: (borderWidth * 100).toFixed(1) })}</span>
                    </div>
                  )
                })()}
                <label className="adjust-row">
                  <input type="checkbox" checked={swapBackdropOn} onChange={(event) => setSwapBackdropOn(event.target.checked)} />
                  <span><strong>{t('Replace backdrop')}</strong><small>{t('Put the cut-out on the working colour, edges and all')}</small></span>
                </label>
                {swapBackdropOn && (
                  <div className="tool-options">
                    <label className="tool-slider">{t('Match')} <input type="range" min="1" max="60" step="1" value={Math.round(backdropTolerance * 100)} onChange={(event) => setBackdropTolerance(Number(event.target.value) / 100)} aria-label={t('Backdrop match tolerance')} /><b>{Math.round(backdropTolerance * 100)}%</b></label>
                    <span className="tool-note">{t('Swaps the flat surround the reconstruction produced for the working colour below. Unlike Fill, the blended pixels along the edge are re-composited onto the new colour rather than left behind, so there is no line to paint over. Only the surround connected to the frame is touched — a dark area enclosed by the artwork stays put.')}</span>
                  </div>
                )}
                <label className="adjust-row">
                  <input type="checkbox" checked={recolour} onChange={(event) => setRecolour(event.target.checked)} />
                  <span><strong>{t('Recolour')}</strong><small>{t('Same hues, new shades — a red stays a red')}</small></span>
                </label>
                {recolour && (
                  <div className="tool-options">
                    <div className="recolour-variations" role="group" aria-label={t('Recolour variation')}>
                      {Array.from({ length: RECOLOUR_VARIATIONS }, (_, index) => index + 1).map((variation) => (
                        <button
                          key={variation}
                          type="button"
                          className={recolourVariation === variation ? 'active' : ''}
                          onClick={() => setRecolourVariation(variation)}
                          aria-pressed={recolourVariation === variation}
                          aria-label={t('Recolour variation {n}', { n: variation })}
                        >{variation}</button>
                      ))}
                    </div>
                    <label className="tool-slider">{t('Shift')} <input type="range" min="5" max="100" step="5" value={Math.round(recolourAmount * 100)} onChange={(event) => setRecolourAmount(Number(event.target.value) / 100)} aria-label={t('Recolour shift amount')} /><b>{Math.round(recolourAmount * 100)}%</b></label>
                    <span className="tool-note">{t('Every hue moves to a different shade of itself and never past its neighbour, so the design keeps its colour relationships. Blacks, whites, greys and the background are left alone. Each variation is a fixed scheme, so the same number always gives the same result.')}</span>
                  </div>
                )}
                <label className="adjust-row">
                  <input type="checkbox" checked={flattenPalette} onChange={(event) => setFlattenPalette(event.target.checked)} />
                  <span><strong>{t('Flatten colour noise')}</strong><small>{t('Detect intended colours; ignore compression')}</small>{flattenPalette && paletteAnalysis && <span className="palette-detection"><span className="palette-swatches" aria-hidden="true">{paletteAnalysis.swatches.map((swatch, index) => <i key={`${swatch}-${index}`} style={{ background: swatch }} />)}</span>{t('{n} colours detected', { n: paletteAnalysis.recommendedColors })}</span>}</span>
                  <PaletteCountPicker value={paletteMode} onChange={setPaletteMode} analysis={paletteAnalysis} detecting={paletteDetecting} disabled={!flattenPalette} />
                </label>
                <button type="button" className="apply-step" onClick={applyAdjustments} disabled={!adjustmentsPending}>{t('Apply adjustments')}</button>
              </div>

              <div className="tool-group">
                <div className="tool-group-heading"><span>{t('Output')}</span><small>{t('Applies to the saved revision')}</small></div>
                <div className="output-row">
                  <label>{t('Resize')} <select value={upscale} onChange={(event) => setUpscale(Number(event.target.value))}><option value="1">{t('Original')}</option><option value="2">2×</option><option value="4">4×</option></select></label>
                  <label>{t('Format')} <select value={format} onChange={(event) => setFormat(event.target.value as typeof format)}><option value="png">PNG</option><option value="jpeg">JPG</option><option value="webp">WebP</option></select></label>
                </div>
                <button type="button" className="apply-step" onClick={applyOutput} disabled={upscale === 1}>{t('Apply resize')}</button>
                <span className="tool-note">{t('Format is not an operation: it is how the next revision you apply gets encoded, whichever group applies it.')}</span>
              </div>
            </section>
            <section className="ai-section">
              <div className="control-heading"><span><Sparkles size={15} /> {t('Gemini reconstruction')}</span><small>{t('Best for texture, perspective and difficult backgrounds')}</small></div>
              <div className="gemini-presets" aria-label={t('Gemini reconstruction preset')}>
                {GEMINI_PRESETS.map((preset) => <button key={preset.id} type="button" className={geminiPreset === preset.id ? 'active' : ''} onClick={() => chooseGeminiPreset(preset.id)} aria-pressed={geminiPreset === preset.id}>{t(preset.label)}</button>)}
              </div>
              <div className="gemini-preset-description">
                <span>{authored && geminiPreset === 'custom' ? t('Written for this image from what the model can see in it.') : t(GEMINI_PRESETS.find((preset) => preset.id === geminiPreset)?.description ?? '')}</span>
                <button type="button" className="write-prompt" onClick={writePromptForImage} disabled={authoring || !keyStatus.gemini} title={keyStatus.gemini ? t('Look at this image and write a prompt for its own faults and peculiarities') : t('Add a Gemini API key in Settings first')}>
                  {authoring ? <><LoaderCircle className="spin" size={12} /> {t('Reading the image…')}</> : <><Sparkles size={12} /> {t('Write a prompt for this image')}</>}
                </button>
              </div>
              <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} aria-label={t('Gemini reconstruction prompt')} placeholder={geminiPreset === 'custom' ? t('Describe exactly what you want Gemini to do with the current image…') : undefined} />
              <div className="ai-model-row">
                <select value={aiModel} onChange={(event) => setAiModel(event.target.value)} aria-label={t('Reconstruction model')}>
                  {modelsForSize(imageSize).map((model) => <option key={model.id} value={model.id}>{PROVIDER_LABELS[model.provider]} · {t(model.label)}{keyStatus[model.provider] ? '' : t(' (no key)')}</option>)}
                </select>
                <div className="ai-backdrops" role="radiogroup" aria-label={t('Backdrop colour')} title={geminiPreset === 'outpaint' ? t('Complete edges continues the artwork’s own background, so it sets no backdrop') : geminiPreset === 'edges' ? t('Clean edges changes nothing but the fringe, so it sets no backdrop') : geminiPreset === 'concentric' ? t('Even the border only moves a shape, so it sets no backdrop') : t('The colour the artwork is put on')}>
                  {AI_BACKDROPS.map((backdrop) => (
                    <button
                      key={backdrop.id}
                      type="button"
                      role="radio"
                      aria-checked={aiBackdrop === backdrop.id}
                      aria-label={t(backdrop.label)}
                      title={backdrop.id === 'none' ? t('Say nothing about the background — leave it to the preset') : t(backdrop.label)}
                      className={`ai-backdrop ${backdrop.swatch === null ? 'none' : backdrop.swatch === 'auto' ? 'auto' : ''} ${aiBackdrop === backdrop.id ? 'active' : ''}`}
                      style={backdrop.swatch && backdrop.swatch !== 'auto' ? { background: backdrop.swatch } : undefined}
                      disabled={geminiPreset === 'outpaint' || geminiPreset === 'custom' || geminiPreset === 'edges' || geminiPreset === 'concentric'}
                      onClick={() => chooseBackdrop(backdrop.id)}
                    >{backdrop.swatch === 'auto' ? <Sparkles size={12} /> : null}</button>
                  ))}
                </div>
                <small>{t(chosenModel.note)}</small>
              </div>
              <div className="ai-actions"><select value={imageSize} onChange={(event) => chooseImageSize(event.target.value as ImageSize)} aria-label={t('Output size')}>{sizeChoices.map((size) => <option key={size} value={size}>{size}</option>)}</select><button className="ai-button" onClick={runGemini} disabled={modelReady && prompt.trim().length < 12} title={modelReady && prompt.trim().length < 12 ? t('Enter a custom prompt first') : undefined}>{modelReady ? <><Sparkles size={16} /> {t('Reconstruct with {provider}', { provider: PROVIDER_LABELS[chosenModel.provider] })}</> : <><KeyRound size={16} /> {t('Add {provider} key', { provider: PROVIDER_LABELS[chosenModel.provider] })}</>}</button></div>
              {geminiPreset === 'outpaint' && <p className="gemini-mode-note"><Sparkles size={13} /> {t('MoodPrep will add matching canvas only on sides where artwork touches the edge.')}</p>}
              {geminiPreset === 'coaster' && <p className="gemini-mode-note"><Sparkles size={13} /> {t('Pads the photo out to a square first, so even a steeply angled shot returns as a true circle rather than an ellipse. Rings are trued up to one shared centre, so an inner disc that was printed off-register comes back even all the way round rather than faithfully lopsided. Clears age spots and board texture while de-yellowing only the paper, so vermilion and coral inks stay vivid instead of settling into plain red.')} {aiBackdrop === 'none' ? t('Names no backdrop colour, so the model is not asked to change one; pick a square beside the model menu to set it, or swap it later with Replace.') : t('Puts the mat on {colour} — swap that for any colour later with Replace.', { colour: t(backdropById(aiBackdrop).label).toLowerCase() })} {t('The result is square; raise the output to 4K, or apply Resize afterwards, for large prints.')}</p>}
              {geminiPreset === 'reimagine' && <p className="gemini-mode-note"><Sparkles size={13} /> {t('This intentionally creates new wording and non-identical imagery while keeping the design’s essence.')}</p>}
              <p>{t('Generated edits can alter text. Always compare spelling, proportions and line work before accepting.')}</p>
            </section>
          </div>
        </div>
        <footer className="editor-footer">
          <button className="duplicate-image-button" onClick={() => onDuplicated(image)} title={t('Add a second copy of this image to the folder so it can be worked on differently')}><CopyPlus size={15} /> {t('Duplicate')}</button>
          <button className="delete-image-button" onClick={deleteImage} disabled={deleting}>{deleting ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />} {t('Delete image…')}</button>
          <div className={`quality-gate ${hasModifiedResult && !qualityAccepted && !qualityOverride ? 'blocked' : ''}`}>
            {hasModifiedResult ? qualityAccepted ? <><Check size={14} /><span>{t('{score}/100 · recommended', { score: working.quality.score })}</span></> : qualityOverride ? <><CircleAlert size={14} /><span>{t('{score}/100 · override acknowledged', { score: working.quality.score })}</span></> : <><CircleAlert size={14} /><span>{t('{score}/100 · review warning above', { score: working.quality.score })}</span></> : <span>{t('Apply a change to create a revision')}</span>}
          </div>
          <button className="text-button" onClick={onClose}>{t('Cancel')}</button>
          <button className="primary-button" disabled={!hasModifiedResult || !qualityCanReplace} onClick={acceptWorking} title={hasModifiedResult && !qualityAccepted && !qualityOverride ? t('Review and acknowledge the quality warning first') : undefined}><Check size={16} /> {qualityOverride ? t('Replace with warning') : t('Replace original')}</button>
        </footer>
      </div>
    </div>
  )
}

function SettingsDialog({ keyStatus, onStatus, language, onLanguage, onClose }: { keyStatus: Record<AiProvider, boolean>; onStatus: (status: Record<AiProvider, boolean>) => void; language: Language; onLanguage: (language: Language) => void; onClose: () => void }) {
  const { t } = useLanguage()
  // One panel per provider rather than one key field: the models come from two
  // companies, the keys are not interchangeable, and either can be connected on
  // its own. Local tools need neither.
  const providers = useMemo(() => [...new Set(AI_MODELS.map((model) => model.provider))], [])
  const [provider, setProvider] = useState<AiProvider>(providers[0])
  const [key, setKey] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [qwenRegion, setQwenRegion] = useState<QwenRegion>(DEFAULT_QWEN_REGION)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const connected = keyStatus[provider]
  const label = PROVIDER_LABELS[provider]
  const refresh = async () => onStatus(await window.moodprep.apiKeyStatus())
  useEffect(() => { window.moodprep.qwenAddress().then((address) => { setWorkspace(address.workspace); setQwenRegion(address.region) }).catch(() => undefined) }, [])
  const choose = (next: AiProvider) => { setProvider(next); setKey(''); setError(null); setTestResult(null) }
  const save = async () => {
    setSaving(true); setError(null)
    try {
      if (provider === 'qwen') await window.moodprep.saveQwenAddress({ workspace, region: qwenRegion })
      await window.moodprep.saveApiKey(provider, key); setKey(''); await refresh(); onClose()
    }
    catch (issue) { setError(errorMessage(issue)) }
    finally { setSaving(false) }
  }
  const clear = async () => {
    await window.moodprep.clearApiKey(provider); await refresh(); setKey(''); setTestResult(null)
  }
  const testConnection = async () => {
    setSaving(true); setError(null); setTestResult(null)
    try {
      if (provider === 'qwen') await window.moodprep.saveQwenAddress({ workspace, region: qwenRegion })
      setTestResult(await window.moodprep.testApiKey(provider))
    }
    catch (issue) { setError(errorMessage(issue)) }
    finally { setSaving(false) }
  }
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t('Settings')}>
      <div className="settings-dialog">
        <header><div><span><KeyRound size={18} /></span><div><strong>{t('Settings')}</strong><small>{t('Language, and the optional reconstruction connections')}</small></div></div><button className="icon-button" onClick={onClose} aria-label={t('Close')}><X size={18} /></button></header>
        <div className="settings-body">
          {/* The language is a per-machine preference and applies the moment it
              is chosen; the native delete dialogs and the preset prompts follow
              it too, so a Chinese-only user is never handed English to edit. */}
          <div className="language-field">
            <span>{t('Language')}</span>
            <div className="region-choice" role="group" aria-label={t('Language')}>
              {LANGUAGES.map((entry) => (
                <button key={entry.id} type="button" className={language === entry.id ? 'active' : ''} aria-pressed={language === entry.id} onClick={() => onLanguage(entry.id)}>
                  <strong>{entry.native}</strong><small>{t(entry.label)}</small>
                </button>
              ))}
            </div>
          </div>
          <div className="provider-tabs" role="group" aria-label={t('Provider')}>
            {providers.map((entry) => (
              <button key={entry} type="button" className={provider === entry ? 'active' : ''} onClick={() => choose(entry)} aria-pressed={provider === entry}>
                {PROVIDER_LABELS[entry]}{keyStatus[entry] ? <Check size={12} /> : null}
              </button>
            ))}
          </div>
          <div className={`key-status ${connected ? 'connected' : ''}`}><span>{connected ? <Check size={16} /> : <CircleAlert size={16} />}</span><div><strong>{connected ? t('{provider} key securely stored', { provider: label }) : t('No {provider} key stored', { provider: label })}</strong><small>{connected ? t('Encrypted by the operating system and never exposed to the interface.') : t('Local tools still work without it.')}</small></div></div>
          <label>{t('{provider} API key', { provider: label })}<input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={connected ? t('Enter a replacement key') : t('Paste key')} autoComplete="off" /></label>
          {provider === 'qwen' && (
            <>
              <div className="region-field">
                <span>{t('Model Studio region')}</span>
                <div className="region-choice" role="group" aria-label={t('Model Studio region')}>
                  {QWEN_REGIONS.map((region) => (
                    <button key={region.id} type="button" className={qwenRegion === region.id ? 'active' : ''} aria-pressed={qwenRegion === region.id} onClick={() => { setQwenRegion(region.id); setTestResult(null) }}>
                      <strong>{t(region.label)}</strong><small>{t(region.detail)}</small>
                    </button>
                  ))}
                </div>
              </div>
              <label>{t('Workspace ID')}<input type="text" value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="ws-xxxxxxxx" autoComplete="off" spellCheck={false} /></label>
            </>
          )}
          <p>{provider === 'qwen'
            ? t('A Model Studio key from Alibaba Cloud. The two consoles are separate services and a key works with only one of them, so pick the region it was created in — {region}. Keys issued since the workspace upgrade begin sk-ws- and are only accepted by their own workspace address, so the Workspace ID above is required for those; an older sk- key can leave it blank.', { region: qwenRegion === 'beijing' ? t('China (Beijing), reached directly from the mainland; a Singapore key will be rejected here') : t('International (Singapore); a Beijing key will be rejected here') })
            : t('The key is sent only to Google when you start a reconstruction. It is never written into the project folder.')}</p>
          {connected && <button className="secondary-button full" onClick={testConnection} disabled={saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <ScanSearch size={16} />} {t('Test connection')}</button>}
          {testResult && <div className={`connection-result ${testResult.ok ? 'success' : 'failure'}`}>{testResult.ok ? <Check size={16} /> : <CircleAlert size={16} />}<span>{testResult.message}</span></div>}
          {error && <div className="inline-error">{error}</div>}
        </div>
        <footer>{connected ? <button className="danger-text" onClick={clear}>{t('Remove stored key')}</button> : <span />}<div><button className="text-button" onClick={onClose}>{t('Cancel')}</button><button className="primary-button" onClick={save} disabled={!key.trim() || saving}>{saving ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />} {t('Save securely')}</button></div></footer>
      </div>
    </div>
  )
}

function StatCard({ icon: Icon, value, label, accent }: { icon: typeof ImageIcon; value: number; label: string; accent: string }) {
  return <div className={`stat-card ${accent}`}><span><Icon size={20} /></span><div><strong>{value}</strong><small>{label}</small></div></div>
}

function EmptyState({ icon: Icon, title, body }: { icon: typeof Copy; title: string; body: string }) {
  return <div className="empty-state"><span><Icon size={26} /></span><strong>{title}</strong><p>{body}</p></div>
}

function BusyOverlay({ message }: { message: string }) {
  const { t } = useLanguage()
  return <div className="busy-overlay"><div><LoaderCircle className="spin" size={28} /><strong>{message}</strong><span>{t('Replaced originals are kept in moodprep-originals')}</span></div></div>
}

// The colour count is chosen by looking at colours, not at a number. Every
// option previews the exact swatches that count will flatten to, taken from one
// analysis, so the picker never has to ask the processor again — and what it
// shows is what the flatten produces.
function PaletteCountPicker({ value, onChange, analysis, detecting, disabled }: {
  value: 'auto' | number
  onChange: (value: 'auto' | number) => void
  analysis: PaletteAnalysisResult | null
  detecting: boolean
  disabled: boolean
}) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const [placement, setPlacement] = useState<{ left: number; top: number; up: boolean } | null>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (target?.closest('.palette-menu') || anchor.current?.contains(target)) return
      setOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', escape) }
  }, [open])
  const toggle = () => {
    if (open) { setOpen(false); return }
    const rect = anchor.current?.getBoundingClientRect()
    if (!rect) return
    // Opens upward when the panel is near the bottom of the window, so the
    // list is never clipped by the scrolling controls column.
    const up = window.innerHeight - rect.bottom < 380
    setPlacement({ left: rect.right, top: up ? rect.top - 4 : rect.bottom + 4, up })
    setOpen(true)
  }
  const candidates = analysis?.candidates ?? []
  const swatchesFor = (count: number) => candidates.slice(0, count)
  const shownCount = value === 'auto' ? (analysis?.recommendedColors ?? 0) : value
  const label = value === 'auto' ? (detecting ? t('Auto · detecting…') : analysis ? t('Auto · {n}', { n: analysis.recommendedColors }) : t('Auto')) : t('{n} colours', { n: value })
  const swatches = (colours: string[]) => <span className="palette-swatches" aria-hidden="true">{colours.map((colour, index) => <i key={`${colour}-${index}`} style={{ background: colour }} />)}</span>
  return (
    <>
      <button ref={anchor} type="button" className="palette-picker" disabled={disabled} onClick={(event) => { event.preventDefault(); event.stopPropagation(); toggle() }} aria-haspopup="listbox" aria-expanded={open} aria-label={t('Palette colours')}>
        {shownCount > 0 && candidates.length > 0 && swatches(swatchesFor(shownCount))}<span>{label}</span><ChevronDown size={12} />
      </button>
      {open && placement && createPortal(
        <div className="palette-menu" role="listbox" style={{ left: placement.left, top: placement.top, transform: `translate(-100%, ${placement.up ? '-100%' : '0'})` }}>
          <button type="button" role="option" aria-selected={value === 'auto'} className={value === 'auto' ? 'active' : ''} onClick={() => { onChange('auto'); setOpen(false) }}>
            <span>{analysis ? t('Auto · {n} detected', { n: analysis.recommendedColors }) : t('Auto')}</span>{analysis && swatches(analysis.swatches)}
          </button>
          {Array.from({ length: 15 }, (_, index) => index + 2).map((count) => {
            const available = count <= candidates.length
            return (
              <button key={count} type="button" role="option" aria-selected={value === count} className={value === count ? 'active' : ''} disabled={!available} title={available ? undefined : t('The analysis found fewer distinct colours than this')} onClick={() => { onChange(count); setOpen(false) }}>
                <span>{t('{n} colours', { n: count })}</span>{available && swatches(swatchesFor(count))}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}

function Toast({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  const { t } = useLanguage()
  const [running, setRunning] = useState(false)
  const [hovering, setHovering] = useState(false)
  // An undoable notice stays up long enough to notice and reach, and hovering
  // holds it there — a toast that vanishes while the pointer is travelling
  // towards its own Undo is worse than no undo at all.
  const life = notice.action ? 12000 : 5200
  useEffect(() => {
    if (hovering || running) return
    const timeout = window.setTimeout(onClose, life)
    return () => window.clearTimeout(timeout)
  }, [onClose, life, hovering, running])
  const act = async () => {
    if (!notice.action || running) return
    setRunning(true)
    try {
      await notice.action.run()
      onClose()
    } finally {
      setRunning(false)
    }
  }
  return (
    <div
      className={`toast ${notice.action ? 'with-action' : ''}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      role={notice.action ? 'alertdialog' : 'status'}
    >
      <span><Check size={15} /></span>
      <p>{notice.message}</p>
      {notice.action && (
        <button type="button" className="toast-action" onClick={act} disabled={running}>
          {running ? <LoaderCircle className="spin" size={13} /> : <Undo2 size={13} />} {notice.action.label}
        </button>
      )}
      <button onClick={onClose} aria-label={t('Dismiss')}><X size={14} /></button>
    </div>
  )
}
