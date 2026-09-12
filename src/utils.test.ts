import { describe, expect, it } from 'vitest'
import { appendRevision, peekRevision, areKnownDistinct, BORDER_DEFAULT, BORDER_MAX, BORDER_MIN, borderedSize, borderFromPixels, borderPixels, clampBorder, ROTATION_LIMIT, buildPromptAuthorInstruction, bulkTagAction, bulkTagState, cleanAuthoredPrompt, selectionRange, brushMaxPixels, brushPixelsFromSize, brushPixelsFromSlider, brushSizeFromPixels, brushSliderPosition, BRUSH_MIN_PIXELS, BRUSH_SLIDER_STEPS, buildGeminiPresetPrompt, canAcceptQuality, cropPixelSize, describeSortValue, exactDuplicateGroups, formatTimestamp, GEMINI_PRESETS, hammingHex, naturalSortDirection, nearDuplicateGroups, composeStageRotation, isTextEntryElement, normalizedPointInRect, normalizeHexColor, sortImages, squareCropInsets, pointerOverVisibleImage, stageImageGeometry, stageViewFraction, stageViewOffset, undoRedoIntent, visibleImageRect } from './utils'
import type { ImageRecord } from '../shared/types'
import { modelForSize, modelsForSize } from '../shared/models'

function image(overrides: Partial<ImageRecord> & Pick<ImageRecord, 'id' | 'exactHash' | 'perceptualHash'>): ImageRecord {
  return {
    path: `/tmp/${overrides.id}.jpg`,
    name: `${overrides.id}.jpg`,
    extension: 'jpg',
    mimeType: 'image/jpeg',
    width: 1000,
    height: 800,
    bytes: 100_000,
    modifiedAt: '2026-01-01T00:00:00.000Z',
    addedAt: '2026-01-01T00:00:00.000Z',
    thumbnailDataUrl: '',
    quality: { score: 70, label: 'Good', detailScore: 50, reasons: [] },
    suggestedIssues: [],
    ...overrides,
  }
}

describe('duplicate grouping', () => {
  it('counts bit differences in perceptual hashes', () => {
    expect(hammingHex('0000000000000000', '0000000000000003')).toBe(2)
  })

  it('groups exact copies and recommends the higher quality copy', () => {
    const groups = exactDuplicateGroups([
      image({ id: 'a', exactHash: 'same', perceptualHash: '0'.repeat(16), quality: { score: 40, label: 'Poor', detailScore: 20, reasons: [] } }),
      image({ id: 'b', exactHash: 'same', perceptualHash: '0'.repeat(16), quality: { score: 80, label: 'Good', detailScore: 70, reasons: [] } }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].recommendedId).toBe('b')
  })

  it('recommends the unsuffixed filename for byte-identical copies', () => {
    const groups = exactDuplicateGroups([
      image({ id: 'copy', name: 'brand (1).jpg', exactHash: 'same', perceptualHash: '0'.repeat(16) }),
      image({ id: 'original', name: 'brand.jpg', exactHash: 'same', perceptualHash: '0'.repeat(16) }),
    ])
    expect(groups[0].recommendedId).toBe('original')
  })

  it('does not confuse same-brand images with loose perceptual similarity', () => {
    const groups = nearDuplicateGroups([
      image({ id: 'a', exactHash: 'a', perceptualHash: '0000000000000000' }),
      image({ id: 'b', exactHash: 'b', perceptualHash: '00ff00ff00ff00ff' }),
    ])
    expect(groups).toHaveLength(0)
  })

  it('honours the explicitly distinct moodboard examples', () => {
    expect(areKnownDistinct('f5d94b02-4bad-49fa-bd39-2286e93cff02.jpeg', 'aa83daf2-8570-4d07-a102-0ad552be3d6c.jpeg')).toBe(true)
    const groups = nearDuplicateGroups([
      image({ id: 'a', name: 'f5d94b02-4bad-49fa-bd39-2286e93cff02.jpeg', exactHash: 'a', perceptualHash: '0000000000000000' }),
      image({ id: 'b', name: 'aa83daf2-8570-4d07-a102-0ad552be3d6c.jpeg', exactHash: 'b', perceptualHash: '0000000000000000' }),
    ])
    expect(groups).toHaveLength(0)
  })
})

describe('single workbench preview', () => {
  it('fits at 100% and creates scrollable centred space when zoomed', () => {
    const fitted = stageImageGeometry(900, 600, 1600, 900, 1)
    expect(fitted.canvasWidth).toBeLessThanOrEqual(900)
    expect(fitted.canvasHeight).toBeLessThanOrEqual(600)
    const zoomed = stageImageGeometry(900, 600, 1600, 900, 2)
    expect(zoomed.spaceWidth).toBeGreaterThan(900)
    expect(zoomed.spaceHeight).toBeGreaterThanOrEqual(600)
    expect(zoomed.left).toBeGreaterThanOrEqual(0)
    expect(zoomed.top).toBeGreaterThanOrEqual(0)
    expect(zoomed.left + zoomed.canvasWidth).toBeLessThanOrEqual(zoomed.spaceWidth)
    expect(zoomed.top + zoomed.canvasHeight).toBeLessThanOrEqual(zoomed.spaceHeight)
    expect(zoomed.spaceWidth - zoomed.canvasWidth).toBeGreaterThanOrEqual(32)
    expect(zoomed.spaceHeight - zoomed.canvasHeight).toBeGreaterThanOrEqual(32)
  })

  it('maps the complete painted rectangle, including its lower-left corner', () => {
    const bounds = { left: 120, right: 920, top: 80, bottom: 680, width: 800, height: 600 }
    expect(normalizedPointInRect(120, 680, bounds)).toEqual({ x: 0, y: 1 })
    expect(normalizedPointInRect(121, 679, bounds)).toEqual({ x: 0.00125, y: 599 / 600 })
    expect(normalizedPointInRect(920, 680, bounds)).toEqual({ x: 1, y: 1 })
    expect(normalizedPointInRect(119, 681, bounds)).toBeNull()
    expect(normalizedPointInRect(119, 681, bounds, true)).toEqual({ x: 0, y: 1 })
  })

  it('fits the complete rotated image within the preview at 100%', () => {
    const rotated = stageImageGeometry(900, 600, 1600, 900, 1, 10)
    const radians = 10 * Math.PI / 180
    const rotatedWidth = (rotated.canvasWidth * Math.cos(radians)) + (rotated.canvasHeight * Math.sin(radians))
    const rotatedHeight = (rotated.canvasWidth * Math.sin(radians)) + (rotated.canvasHeight * Math.cos(radians))
    expect(rotatedWidth).toBeLessThanOrEqual(900)
    expect(rotatedHeight).toBeLessThanOrEqual(600)
  })

  it('keeps a linear undo history and drops the redo branch after a new edit', () => {
    const first = appendRevision(['original'], 0, 'crop')
    const second = appendRevision(first.revisions, first.index, 'gemini')
    const branched = appendRevision(second.revisions, 1, 'resize')
    expect(branched).toEqual({ revisions: ['original', 'crop', 'resize'], index: 2 })
  })

  it('requires a score strictly over 80 for replacement', () => {
    expect(canAcceptQuality(69)).toBe(false)
    expect(canAcceptQuality(70)).toBe(true)
  })
})

// The straighten slider was ±10° while it only had to take the lean off a scan.
// Widened to ±45 on 2026-09-08 so a piece photographed properly askew can be
// brought upright without spending a quarter turn first.
describe('the straighten range', () => {
  const clampRotation = (value: number) => {
    if (!Number.isFinite(value)) return 0
    const rounded = Math.round(Math.max(-ROTATION_LIMIT, Math.min(ROTATION_LIMIT, value)) * 10) / 10
    return Object.is(rounded, -0) ? 0 : rounded
  }

  it('reaches 45 degrees each way', () => {
    expect(ROTATION_LIMIT).toBe(45)
    expect(clampRotation(45)).toBe(45)
    expect(clampRotation(-45)).toBe(-45)
    // What the old limit rejected and this one keeps.
    expect(clampRotation(32.4)).toBe(32.4)
    expect(clampRotation(-17.9)).toBe(-17.9)
  })

  it('stops at 45 rather than wrapping, because past it a quarter turn is shorter', () => {
    expect(clampRotation(90)).toBe(45)
    expect(clampRotation(-180)).toBe(-45)
  })

  it('keeps the tenth-of-a-degree step and never reports negative zero', () => {
    expect(clampRotation(3.14159)).toBe(3.1)
    expect(Object.is(clampRotation(-0.04), 0)).toBe(true)
  })

  it('stays inside what the processor accepts', () => {
    // processImage clamps to ±180; the renderer must never be the wider of the two.
    expect(ROTATION_LIMIT).toBeLessThanOrEqual(180)
  })

  it('fits the whole rotated image in the preview at the new extreme', () => {
    // At 45° the envelope is widest, so the fitted canvas has to shrink most.
    const rotated = stageImageGeometry(900, 600, 1600, 900, 1, ROTATION_LIMIT)
    const radians = (ROTATION_LIMIT * Math.PI) / 180
    const width = (rotated.canvasWidth * Math.cos(radians)) + (rotated.canvasHeight * Math.sin(radians))
    const height = (rotated.canvasWidth * Math.sin(radians)) + (rotated.canvasHeight * Math.cos(radians))
    expect(width).toBeLessThanOrEqual(900)
    expect(height).toBeLessThanOrEqual(600)
  })
})

describe('the added border', () => {
  it('defaults to a share of the shorter edge, not of the width', () => {
    // A 3000 x 600 banner: measured off the width, or the mean, a 4% border
    // would eat a quarter of the height while looking modest across the top.
    expect(borderPixels(BORDER_DEFAULT, 3000, 600)).toBe(24)
    expect(borderPixels(BORDER_DEFAULT, 600, 3000)).toBe(24)
    // Real images from the collection.
    expect(borderPixels(BORDER_DEFAULT, 736, 730)).toBe(29)
    expect(borderPixels(BORDER_DEFAULT, 2776, 2443)).toBe(98)
  })

  it('adds the border outside the artwork, so nothing is covered', () => {
    const framed = borderedSize(736, 730, BORDER_DEFAULT)
    expect(framed.edge).toBe(29)
    expect(framed.width).toBe(736 + 58)
    expect(framed.height).toBe(730 + 58)
  })

  it('keeps its proportion through a crop and an upscale', () => {
    // The same fraction on a half-size crop gives half the pixels, which is
    // what makes the border look the same rather than the same size.
    expect(borderPixels(BORDER_DEFAULT, 368, 365)).toBe(15)
    expect(borderPixels(BORDER_DEFAULT, 1472, 1460)).toBe(58)
  })

  it('round-trips a pixel width back to a fraction', () => {
    const fraction = borderFromPixels(29, 736, 730)
    expect(borderPixels(fraction, 736, 730)).toBe(29)
  })

  it('clamps to a sane range and survives a bad number', () => {
    expect(clampBorder(5)).toBe(BORDER_MAX)
    expect(clampBorder(-1)).toBe(BORDER_MIN)
    expect(clampBorder(Number.NaN)).toBe(BORDER_DEFAULT)
    // Never zero: a border that is on must be visible.
    expect(borderPixels(BORDER_MIN, 100, 100)).toBeGreaterThanOrEqual(1)
  })

  it('never lets the border swallow the image', () => {
    // At the maximum both borders together are 40% of the shorter edge, so the
    // artwork is always the larger part of what is saved.
    const framed = borderedSize(1000, 1000, BORDER_MAX)
    expect(framed.edge * 2).toBeLessThan(1000)
  })
})

// Reported 2026-09-07: "extremely problematic when the canvas is zoomed in on.
// For one, you can't change colors." One cause, very wide blast radius. The
// stage installs a document-level capture-phase pointerdown listener so a crop
// or paint start wins against overlapping renderer layers, and it decided
// whether a start belonged to the image by testing the pointer against the
// canvas element's `getBoundingClientRect`. That rectangle is the canvas's whole
// layout box, which the viewport clips visually but does not shrink — so above
// 1x it runs hundreds of pixels past the viewport, across the controls panel.
// Every start landing there was claimed, preventDefault'd and stopped, and React
// never saw the click. Crop is the default tool, so this was the default state.
describe('what a pointer start belongs to when the canvas is zoomed', () => {
  // The measured layout: a 1260px dialog gives the stage column ~717px, and the
  // viewport is inset 22px each side, 53px top and 48px bottom of a 729px body.
  const STAGE_WIDTH = 717
  const viewport = { left: 22, right: 695, top: 53, bottom: 681 }
  const PANEL_LEFT = STAGE_WIDTH  // the controls panel begins where the stage ends
  // Where the canvas actually sits, scrolled hard to the top left.
  const canvasAt = (zoom: number) => {
    const g = stageImageGeometry(viewport.right - viewport.left, viewport.bottom - viewport.top, 736, 730, zoom)
    return {
      left: viewport.left + g.left,
      right: viewport.left + g.left + g.canvasWidth,
      top: viewport.top + g.top,
      bottom: viewport.top + g.top + g.canvasHeight,
    }
  }

  it('reproduces the defect: above 1x the canvas rectangle covers the controls panel', () => {
    // This is the fact the old hit test was reading, and why it went wrong.
    expect(canvasAt(1).right).toBeLessThan(PANEL_LEFT)
    expect(canvasAt(2).right).toBeGreaterThan(PANEL_LEFT)
    expect(canvasAt(4).right).toBeGreaterThan(PANEL_LEFT)
    // At 2x it already reaches well past the viewport that clips it.
    expect(canvasAt(2).right - viewport.right).toBeGreaterThan(500)
  })

  it('does not claim a click on the controls panel at any zoom', () => {
    // A point in the Working colour block, to the right of the stage.
    const colourChip = { x: PANEL_LEFT + 60, y: 400 }
    for (const zoom of [1, 2, 3, 4]) {
      const canvas = canvasAt(zoom)
      expect(pointerOverVisibleImage(colourChip.x, colourChip.y, canvas, viewport), `zoom ${zoom}`).toBe(false)
    }
    // And at 2x the old test really would have claimed it, which is the bug.
    const canvas = canvasAt(2)
    expect(normalizedPointInRect(colourChip.x, colourChip.y, { ...canvas, width: canvas.right - canvas.left, height: canvas.bottom - canvas.top })).not.toBeNull()
  })

  it('does not claim a click on the footer or the toast below the stage', () => {
    // Replace original / Cancel sit below the body; the toast sits lower still.
    for (const zoom of [2, 4]) {
      const canvas = canvasAt(zoom)
      expect(pointerOverVisibleImage(300, viewport.bottom + 60, canvas, viewport), `footer ${zoom}`).toBe(false)
      expect(pointerOverVisibleImage(300, viewport.bottom + 200, canvas, viewport), `toast ${zoom}`).toBe(false)
    }
  })

  it('still claims a start that is genuinely on the visible image, at every zoom', () => {
    // The whole point: the fix must not make the image itself unclickable.
    const middle = { x: (viewport.left + viewport.right) / 2, y: (viewport.top + viewport.bottom) / 2 }
    for (const zoom of [1, 2, 3, 4]) {
      expect(pointerOverVisibleImage(middle.x, middle.y, canvasAt(zoom), viewport), `zoom ${zoom}`).toBe(true)
    }
  })

  it('claims the very edges of the visible image, which is where crop handles live', () => {
    const canvas = canvasAt(1)
    const visible = visibleImageRect(canvas, viewport)!
    for (const [x, y] of [[visible.left, visible.top], [visible.right, visible.top], [visible.left, visible.bottom], [visible.right, visible.bottom]]) {
      expect(pointerOverVisibleImage(x, y, canvas, viewport)).toBe(true)
    }
    // One pixel outside any edge is not the image.
    expect(pointerOverVisibleImage(visible.left - 1, visible.top + 10, canvas, viewport)).toBe(false)
    expect(pointerOverVisibleImage(visible.right + 1, visible.top + 10, canvas, viewport)).toBe(false)
    expect(pointerOverVisibleImage(visible.left + 10, visible.top - 1, canvas, viewport)).toBe(false)
    expect(pointerOverVisibleImage(visible.left + 10, visible.bottom + 1, canvas, viewport)).toBe(false)
  })

  it('intersects the two rectangles, and reports no overlap rather than a negative one', () => {
    expect(visibleImageRect({ left: 0, right: 100, top: 0, bottom: 100 }, { left: 50, right: 200, top: 25, bottom: 75 }))
      .toEqual({ left: 50, right: 100, top: 25, bottom: 75, width: 50, height: 50 })
    // Scrolled entirely out of view: not a rectangle at all.
    expect(visibleImageRect({ left: 0, right: 100, top: 0, bottom: 100 }, { left: 300, right: 400, top: 0, bottom: 100 })).toBeNull()
    // Touching edge-on encloses nothing, so it is no overlap either.
    expect(visibleImageRect({ left: 0, right: 100, top: 0, bottom: 100 }, { left: 100, right: 200, top: 0, bottom: 100 })).toBeNull()
  })

  it('treats a missing canvas or viewport as not the image', () => {
    expect(pointerOverVisibleImage(100, 100, null, viewport)).toBe(false)
    expect(pointerOverVisibleImage(100, 100, canvasAt(1), null)).toBe(false)
  })
})

// The reported failure: zoomed in and filling, every click threw the view back
// to the middle of the canvas. Each fill is its own revision, and the stage
// re-centred whenever the preview changed — so the tool you are most likely to
// be zoomed in for was the one that would not let you stay there.
describe('holding the view across a revision', () => {
  const viewport = (scrollLeft: number, scrollTop: number, space = 2000) => ({
    scrollLeft, scrollTop, scrollWidth: space, scrollHeight: space, clientWidth: 900, clientHeight: 600,
  })

  it('puts the same point back after a revision that does not resize the image', () => {
    const before = viewport(770, 1120)
    const view = stageViewFraction(before)
    // A fill returns the same dimensions, so the offsets come back untouched.
    expect(stageViewOffset(before, view)).toEqual({ scrollLeft: 770, scrollTop: 1120 })
  })

  it('keeps the same part of the artwork when the revision changes the dimensions', () => {
    // Looking a quarter of the way across and three quarters down.
    const view = stageViewFraction(viewport(0.25 * 1100 + 0, 0.75 * 1400 + 0, 2000))
    expect(view.x).toBeCloseTo(0.25, 6)
    expect(view.y).toBeCloseTo(0.75, 6)
    // A crop shrinks the scrollable space; the same fractions still frame the
    // same place, which a remembered pixel offset would not have done.
    const after = { scrollLeft: 0, scrollTop: 0, scrollWidth: 1400, scrollHeight: 1400, clientWidth: 900, clientHeight: 600 }
    const offset = stageViewOffset(after, view)
    expect(offset.scrollLeft).toBeCloseTo(0.25 * 500, 6)
    expect(offset.scrollTop).toBeCloseTo(0.75 * 800, 6)
  })

  it('reads an axis with nothing to scroll as the middle, so fit-to-window recentres', () => {
    // At 100% the image fits, so there is no position to remember. Zooming back
    // in must start from the centre rather than from a stale corner.
    const fitted = { scrollLeft: 0, scrollTop: 0, scrollWidth: 900, scrollHeight: 600, clientWidth: 900, clientHeight: 600 }
    expect(stageViewFraction(fitted)).toEqual({ x: .5, y: .5 })
    const zoomed = viewport(0, 0)
    expect(stageViewOffset(zoomed, stageViewFraction(fitted))).toEqual({ scrollLeft: 550, scrollTop: 700 })
  })

  it('survives a bounced or over-scrolled offset rather than storing it', () => {
    // Elastic scrolling on macOS reports offsets past both ends.
    expect(stageViewFraction(viewport(-40, 99999)).x).toBe(0)
    expect(stageViewFraction(viewport(-40, 99999)).y).toBe(1)
  })
})

describe('Gemini reconstruction presets', () => {
  it('provides distinct editable prompts for the common restoration modes', () => {
    expect(GEMINI_PRESETS.map((preset) => preset.id)).toEqual(['standard', 'despeckle', 'edges', 'concentric', 'outpaint', 'flat_background', 'coaster', 'reimagine', 'custom'])
    expect(buildGeminiPresetPrompt('despeckle', [])).toContain('background areas, dark foreground areas')
    expect(buildGeminiPresetPrompt('outpaint', [])).toContain('Extend only the existing artwork')
    expect(buildGeminiPresetPrompt('outpaint', [])).toContain('Do not add any new text, borders, frames')
    expect(buildGeminiPresetPrompt('outpaint', ['border', 'crop'])).not.toContain('Crop only unnecessary')
    expect(buildGeminiPresetPrompt('outpaint', ['border', 'crop'])).not.toContain('Restore symmetry')
    expect(buildGeminiPresetPrompt('flat_background', [])).toContain('one clean, perfectly uniform solid colour')
    expect(buildGeminiPresetPrompt('reimagine', [])).toContain('newly invented generic wording')
    expect(buildGeminiPresetPrompt('reimagine', [])).toContain('original alternatives')
    expect(buildGeminiPresetPrompt('custom', [])).toBe('')
  })

  it('keeps selected issue instructions in a specialised prompt', () => {
    expect(buildGeminiPresetPrompt('despeckle', ['watermark'])).toContain('Remove the overlaid watermark only where I have the rights')
  })
})

describe('hex colour entry', () => {
  it('accepts the forms people paste or type', () => {
    expect(normalizeHexColor('#c6c')).toBe('#cc66cc')
    expect(normalizeHexColor('#C6C3B3')).toBe('#c6c3b3')
    expect(normalizeHexColor('c6c3b3')).toBe('#c6c3b3')
    expect(normalizeHexColor('  #fff  ')).toBe('#ffffff')
    expect(normalizeHexColor('FFF')).toBe('#ffffff')
  })

  it('rejects incomplete or invalid text so typing is not clobbered', () => {
    expect(normalizeHexColor('#c6c3b')).toBeNull()
    expect(normalizeHexColor('')).toBeNull()
    expect(normalizeHexColor('rebeccapurple')).toBeNull()
    expect(normalizeHexColor('#12345g')).toBeNull()
  })
})

describe('quarter turns composed with fine straightening', () => {
  it('leaves a plain straightening angle untouched', () => {
    expect(composeStageRotation(0, 0)).toBe(0)
    expect(composeStageRotation(0, -3.4)).toBe(-3.4)
    expect(composeStageRotation(0, 10)).toBe(10)
  })

  it('normalises turns into the range the processor accepts', () => {
    expect(composeStageRotation(1, 0)).toBe(90)
    expect(composeStageRotation(2, 0)).toBe(180)
    expect(composeStageRotation(3, 0)).toBe(-90)
    expect(composeStageRotation(4, 0)).toBe(0)
  })

  it('combines a turn with straightening in a single angle', () => {
    expect(composeStageRotation(1, 2.5)).toBe(92.5)
    expect(composeStageRotation(3, 2.5)).toBe(-87.5)
    expect(composeStageRotation(3, -10)).toBe(-100)
    expect(composeStageRotation(2, -0.4)).toBe(179.6)
  })

  it('stays inside the processor clamp for every reachable combination', () => {
    for (let turns = 0; turns < 4; turns += 1) {
      for (let fine = -10; fine <= 10; fine += 0.5) {
        const total = composeStageRotation(turns, fine)
        expect(total).toBeGreaterThan(-180)
        expect(total).toBeLessThanOrEqual(180)
      }
    }
  })
})

// The deterministic re-composite gets the ordinary two-colour edge right, but
// a fringe smeared over a wide soft ramp, or one left where three colours meet,
// has no clean blend to solve. This preset is the fallback for those, so its
// whole value is that it asks for the fringe and for nothing else: a prompt
// that also carries issue tags, a surround colour or a fidelity argument gives
// the model licence to redraw the artwork it was only meant to tidy the edge of.
describe('clean edges preset', () => {
  it('is offered in the preset list with its own description', () => {
    const preset = GEMINI_PRESETS.find((entry) => entry.id === 'edges')
    expect(preset!.label).toBe('Clean edges')
  })

  it('asks for the fringe and forbids everything else', () => {
    const prompt = buildGeminiPresetPrompt('edges', ['border', 'crop', 'noise'])
    expect(prompt).toMatch(/halo, outline, or line of a previous colour/i)
    expect(prompt).toMatch(/change absolutely nothing else/i)
    expect(prompt).toMatch(/add nothing, remove nothing, redraw nothing/i)
    expect(prompt).toMatch(/same aspect ratio/i)
  })

  it('takes no backdrop and no issue instructions', () => {
    const prompt = buildGeminiPresetPrompt('edges', ['border', 'crop'], 'pure white, #ffffff')
    expect(prompt).not.toContain('pure white')
    expect(prompt).not.toContain('Surround:')
    expect(prompt).not.toContain('Crop only unnecessary')
  })
})

// Replaced the deterministic `Recentre inner content` tool on 2026-09-06. The
// two screenshots that prompted it: a Château Bellevue roundel whose red disc
// sits off-centre inside its black ring, and a Bixel oval whose black margin is
// thin at top and bottom and thick at the sides. One shape inside another, and
// the band between them should be one width all the way round.
// Which model a preset can be sent to is not a taste question: it falls out of
// the size the preset needs and the sizes each model actually serves. Measured
// on 2026-09-06 — see the size tests in shared/models.test.ts.
describe('the model a preset can be sent to', () => {
  const floor = (id: GeminiPresetId) => GEMINI_PRESETS.find((preset) => preset.id === id)!.minSize

  it('keeps Complete edges and Photographed coaster at 2K, and everything else at 1K', () => {
    expect(floor('outpaint')).toBe('2K')
    expect(floor('coaster')).toBe('2K')
    for (const preset of GEMINI_PRESETS) {
      if (preset.id === 'outpaint' || preset.id === 'coaster') continue
      expect(preset.minSize, preset.id).toBe('1K')
    }
  })

  it('drops Flash Lite from the two presets it cannot serve, and defaults them to Flash', () => {
    for (const id of ['outpaint', 'coaster'] as GeminiPresetId[]) {
      const offered = modelsForSize(floor(id), 'gemini').map((model) => model.id)
      expect(offered, id).not.toContain('gemini-3.1-flash-lite-image')
      expect(offered[0], id).toBe('gemini-3.1-flash-image')
    }
  })

  it('leaves Flash Lite as the default everywhere else', () => {
    for (const preset of GEMINI_PRESETS) {
      if (preset.minSize !== '1K') continue
      expect(modelsForSize(preset.minSize, 'gemini')[0].id, preset.id).toBe('gemini-3.1-flash-lite-image')
    }
  })

  it('moves a Flash Lite user onto Flash when the preset needs 2K', () => {
    expect(modelForSize('gemini-3.1-flash-lite-image', floor('coaster'))).toBe('gemini-3.1-flash-image')
  })
})

describe('even the border preset', () => {
  it('is offered in the preset list with its own description', () => {
    const preset = GEMINI_PRESETS.find((entry) => entry.id === 'concentric')
    expect(preset!.label).toBe('Even the border')
    expect(preset!.description).toMatch(/same width the whole way round/i)
  })

  it('states the measurable test rather than only asking for centring', () => {
    // "Centre it" is what the model already thinks it is doing. Six named
    // measurements that must come out equal is something it can check itself.
    const prompt = buildGeminiPresetPrompt('concentric', [])
    expect(prompt).toMatch(/exactly the same width the whole way round/i)
    expect(prompt).toMatch(/top, at the bottom, at the left, at the right, and on both diagonals/i)
    expect(prompt).toMatch(/all six measurements must come out equal/i)
    expect(prompt).toMatch(/single common centre/i)
  })

  it('names the case where the reference itself is out of register', () => {
    // The coaster preset learned this the hard way: asked for symmetry and for
    // fidelity in the same breath, fidelity wins and the result comes back
    // faithfully lopsided. The regularisation has to be stated as outranking
    // the reference, in as many words.
    const prompt = buildGeminiPresetPrompt('concentric', [])
    expect(prompt).toMatch(/deliberate regularisation, not a restoration/i)
    expect(prompt).toMatch(/not as it actually came off the press/i)
    expect(prompt).toMatch(/concentricity wins/i)
  })

  it('moves the shape and licenses nothing else', () => {
    const prompt = buildGeminiPresetPrompt('concentric', [])
    expect(prompt).toMatch(/Move, and do nothing else/i)
    for (const forbidden of ['redraw', 'restyle', 'resize', 'straighten', 'recolour', 'sharpen', 're-letter']) {
      expect(prompt.toLowerCase(), forbidden).toContain(forbidden)
    }
    expect(prompt).toMatch(/add nothing and remove nothing/i)
    // The vacated space is the thing the deterministic tool got right and a
    // model will happily leave as a ghost, so it is asked for explicitly.
    expect(prompt).toMatch(/no seam, halo, outline, shadow or ghost/i)
    expect(prompt).toMatch(/same aspect ratio/i)
  })

  it('takes no backdrop and no issue instructions, like the other single-job presets', () => {
    const prompt = buildGeminiPresetPrompt('concentric', ['border', 'crop'], 'pure white, #ffffff')
    expect(prompt).not.toContain('pure white')
    expect(prompt).not.toContain('Surround:')
    expect(prompt).not.toContain('Crop only unnecessary')
    expect(prompt).not.toMatch(/ {2,}/)
  })
})

describe('photographed coaster preset', () => {
  it('is offered in the preset list with its own description', () => {
    const preset = GEMINI_PRESETS.find((entry) => entry.id === 'coaster')
    expect(preset).toBeDefined()
    expect(preset!.label).toBe('Photographed coaster')
  })

  it('asks for the three corrections these scans need', () => {
    const prompt = buildGeminiPresetPrompt('coaster', [])
    // true shape rather than the camera's ellipse
    expect(prompt).toMatch(/mathematically perfect circle/i)
    expect(prompt).toMatch(/never an ellipse/i)
    expect(prompt).toMatch(/perspective/i)
    // age damage
    expect(prompt).toMatch(/foxing/i)
    expect(prompt).toMatch(/stains/i)
    // the coaster's own silhouette is kept, on a pure black field
    expect(prompt).toMatch(/pure black, #000000/)
    expect(prompt).toMatch(/outline .*complete and intact/i)
    expect(prompt).toMatch(/do not extend the coaster's own background colour outwards/i)
    expect(prompt).toMatch(/no gradient, vignette, texture, shadow, glow, noise/i)
  })

  // The failure this preset kept producing was not an ellipse but a faithful
  // one: vintage coasters really were printed off-register, so an inner disc
  // genuinely sits off-centre on the object. Asking for fidelity to the
  // reference and for symmetry at the same time let fidelity win, and the
  // result came back lopsided in a way that is useless on a T-shirt. The
  // prompt has to name that case and say which instruction outranks the other.
  it('demands one shared centre and equal ring widths, overriding fidelity', () => {
    const prompt = buildGeminiPresetPrompt('coaster', [])
    expect(prompt).toMatch(/concentricity and ring placement/i)
    expect(prompt).toMatch(/out of register/i)
    expect(prompt).toMatch(/one single common centre/i)
    expect(prompt).toMatch(/exactly the same width the whole way round/i)
    // A measurable check beats an adjective.
    expect(prompt).toMatch(/all six measurements must come out equal/i)
    // Fidelity must be explicitly scoped out of geometry, in both places that
    // could otherwise be read as demanding the printed asymmetry back.
    expect(prompt).toMatch(/overrides fidelity to the reference/i)
    expect(prompt).toMatch(/it does not govern where a ring sits/i)
    expect(prompt).toMatch(/never copied from the reference/i)
  })

  it('centres the piece in the square canvas rather than merely fitting it', () => {
    const prompt = buildGeminiPresetPrompt('coaster', [])
    expect(prompt).toMatch(/margin above, below, to the left of and to the right of the silhouette must be equal/i)
  })

  // Gemini de-yellows correctly but was doing it to the whole frame, and
  // subtracting yellow globally is exactly the operation that turns vermilion
  // into red and coral into crimson. The age correction the preset wants was
  // eating the ink colours it must not touch, so the prompt has to confine the
  // correction to the substrate and name the specific hue shifts to avoid.
  it('confines the age correction to the substrate and pins the ink hues', () => {
    const prompt = buildGeminiPresetPrompt('coaster', [])
    // the correction is scoped, and the mechanism is named so it cannot be
    // mistaken for a general instruction to leave colour alone
    expect(prompt).toMatch(/apply that correction to those neutral areas alone/i)
    expect(prompt).toMatch(/do not apply a global white balance/i)
    expect(prompt).toMatch(/turns an orange into a red and a coral into a crimson/i)
    expect(prompt).toMatch(/the substrate is ageing, the inks are not/i)
    // the specific losses seen on real coasters
    expect(prompt).toMatch(/vermilion stays orange-red/i)
    expect(prompt).toMatch(/stays pink and must not deepen into crimson or maroon/i)
    expect(prompt).toMatch(/the warmth is the ink, not the damage/i)
    // and no tasteful muting
    expect(prompt).toMatch(/do not mute, dull, deepen, darken, sober, or harmonise/i)
  })

  // The Condition paragraph used to license exactly the global correction the
  // Colour paragraph forbids; the two must not contradict each other.
  it('does not license a global cast removal in the damage list', () => {
    const prompt = buildGeminiPresetPrompt('coaster', [])
    expect(prompt).toMatch(/the lighting's colour cast on neutral areas/i)
    expect(prompt).not.toMatch(/uneven lighting, colour cast, and camera blur/i)
    expect(prompt).toMatch(/restore it to that ink's own colour/i)
    expect(prompt).toMatch(/ink colours are copied from the reference exactly and never corrected/i)
  })

  it('keeps printed rings and the silhouette while removing the surroundings', () => {
    const prompt = buildGeminiPresetPrompt('coaster', [])
    expect(prompt).toMatch(/keep every printed ring/i)
    expect(prompt).toMatch(/flatten away the coaster's physical thickness/i)
    expect(prompt).toMatch(/do not add a drop shadow, rim light, halo, outline, or seam/i)
  })

  it('still carries the fidelity guarantee and selected issue tags', () => {
    const prompt = buildGeminiPresetPrompt('coaster', ['low_quality'])
    expect(prompt).toContain('Preserve the exact wording')
    expect(prompt).toMatch(/high resolution/i)
  })

  // A coaster shot at a steep angle came back as an ellipse. The cause was the
  // prompt demanding the source aspect ratio back: the disc cannot be a circle
  // and also fill an oblong frame, so the model split the difference. The
  // preset now pads the input to a square and asks for a square in return.
  it('never asks for the source aspect ratio back, which is what forced the ellipse', () => {
    const prompt = buildGeminiPresetPrompt('coaster', ['perspective'])
    expect(prompt).not.toMatch(/same aspect ratio/i)
    expect(prompt).toMatch(/the canvas you are given is square/i)
    expect(prompt).toMatch(/return a square image/i)
    expect(prompt).toMatch(/do not return a rectangular image/i)
  })

  it('makes geometry the priority and names the extreme-angle case', () => {
    const prompt = buildGeminiPresetPrompt('coaster', [])
    expect(prompt).toMatch(/geometry is the single most important requirement/i)
    expect(prompt).toMatch(/geometry wins/i)
    expect(prompt).toMatch(/severely foreshortened|almost edge-on/i)
    expect(prompt).toMatch(/do not merely rotate/i)
    expect(prompt).toMatch(/identical measured across every axis/i)
  })

  it('asks for the design\'s own symmetry back, not just an unskewed outline', () => {
    const prompt = buildGeminiPresetPrompt('coaster', [])
    expect(prompt).toMatch(/concentric printed rings share one common centre/i)
    expect(prompt).toMatch(/evenly spaced and equally sized/i)
    expect(prompt).toMatch(/outline's centre coincides with the design's centre/i)
  })

  // The other presets still return the frame they were given; only the coaster
  // preset is allowed to change shape.
  it('leaves the aspect-ratio instruction alone for every other preset', () => {
    for (const preset of ['standard', 'despeckle', 'flat_background', 'reimagine'] as const) {
      expect(buildGeminiPresetPrompt(preset, []), preset).toMatch(/same aspect ratio/i)
    }
  })
})

describe('undo and redo shortcuts', () => {
  const press = (key: string, modifiers: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }> = {}) =>
    ({ key, metaKey: false, ctrlKey: false, shiftKey: false, ...modifiers })

  it('maps the platform shortcuts to history actions', () => {
    expect(undoRedoIntent(press('z', { metaKey: true }), false)).toBe('undo')
    expect(undoRedoIntent(press('z', { ctrlKey: true }), false)).toBe('undo')
    expect(undoRedoIntent(press('Z', { metaKey: true, shiftKey: true }), false)).toBe('redo')
    expect(undoRedoIntent(press('y', { ctrlKey: true }), false)).toBe('redo')
  })

  it('ignores the key without its modifier', () => {
    expect(undoRedoIntent(press('z'), false)).toBeNull()
    expect(undoRedoIntent(press('a', { metaKey: true }), false)).toBeNull()
  })

  it('never steals undo from a text field being edited', () => {
    expect(undoRedoIntent(press('z', { metaKey: true }), true)).toBeNull()
    expect(undoRedoIntent(press('z', { metaKey: true, shiftKey: true }), true)).toBeNull()
  })

  it('recognises which elements own their own undo stack', () => {
    expect(isTextEntryElement({ tagName: 'INPUT' })).toBe(true)
    expect(isTextEntryElement({ tagName: 'textarea' })).toBe(true)
    expect(isTextEntryElement({ tagName: 'SELECT' })).toBe(true)
    expect(isTextEntryElement({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isTextEntryElement({ tagName: 'DIV' })).toBe(false)
    expect(isTextEntryElement({ tagName: 'BUTTON' })).toBe(false)
    expect(isTextEntryElement(null)).toBe(false)
  })
})

describe('deliberate copies are not accidental duplicates', () => {
  const pair = () => [
    image({ id: 'original', exactHash: 'same', perceptualHash: '0'.repeat(16) }),
    image({ id: 'copy', exactHash: 'same', perceptualHash: '0'.repeat(16) }),
  ]

  it('groups identical files as exact copies by default', () => {
    expect(exactDuplicateGroups(pair())).toHaveLength(1)
  })

  it('leaves a deliberate copy out of exact grouping', () => {
    const images = pair()
    const groups = exactDuplicateGroups(images, new Set([images[1].path]))
    expect(groups).toHaveLength(0)
  })

  it('leaves a deliberate copy out of near-match suggestions once it has been edited', () => {
    // Editing the copy changes its content hash, so the pair stops being an
    // exact match and would otherwise resurface as a visual near-match.
    const edited = [
      image({ id: 'original', exactHash: 'one', perceptualHash: '0'.repeat(16) }),
      image({ id: 'copy', exactHash: 'two', perceptualHash: '0'.repeat(15) + '3' }),
    ]
    expect(nearDuplicateGroups(edited)).toHaveLength(1)
    expect(nearDuplicateGroups(edited, 5, new Set([edited[1].path]))).toHaveLength(0)
  })

  it('still reviews other duplicates in the same collection', () => {
    const images = [
      ...pair(),
      image({ id: 'other-a', exactHash: 'other', perceptualHash: 'f'.repeat(16) }),
      image({ id: 'other-b', exactHash: 'other', perceptualHash: 'f'.repeat(16) }),
    ]
    const groups = exactDuplicateGroups(images, new Set([images[1].path]))
    expect(groups).toHaveLength(1)
    expect(groups[0].images.map((entry) => entry.id).sort()).toEqual(['other-a', 'other-b'])
  })
})

describe('library sorting', () => {
  const collection = () => [
    image({ id: 'b', name: 'scan 10.jpg', exactHash: 'b', perceptualHash: null, extension: 'png', bytes: 300, width: 100, height: 100, modifiedAt: '2026-03-01T00:00:00.000Z', addedAt: '2026-05-01T00:00:00.000Z', quality: { score: 90, label: 'Excellent', detailScore: 80, reasons: [] } }),
    image({ id: 'a', name: 'scan 2.jpg', exactHash: 'a', perceptualHash: null, extension: 'jpg', bytes: 900, width: 400, height: 400, modifiedAt: '2026-06-01T00:00:00.000Z', addedAt: '2026-02-01T00:00:00.000Z', quality: { score: 40, label: 'Poor', detailScore: 20, reasons: [] } }),
    image({ id: 'c', name: 'scan 3.jpg', exactHash: 'c', perceptualHash: null, extension: 'webp', bytes: 600, width: 200, height: 200, modifiedAt: '2026-01-01T00:00:00.000Z', addedAt: '2026-08-01T00:00:00.000Z', quality: { score: 70, label: 'Good', detailScore: 50, reasons: [] } }),
  ]
  const order = (key: Parameters<typeof sortImages>[1], direction: Parameters<typeof sortImages>[2]) =>
    sortImages(collection(), key, direction).map((entry) => entry.id)

  it('collates numbered filenames numerically rather than as text', () => {
    expect(order('name', 'asc')).toEqual(['a', 'c', 'b'])
    expect(order('name', 'desc')).toEqual(['b', 'c', 'a'])
  })

  it('sorts by date modified, date added, file size, dimensions and quality independently', () => {
    expect(order('modified', 'desc')).toEqual(['a', 'b', 'c'])
    expect(order('added', 'desc')).toEqual(['c', 'b', 'a'])
    expect(order('size', 'desc')).toEqual(['a', 'c', 'b'])
    expect(order('dimensions', 'desc')).toEqual(['a', 'c', 'b'])
    expect(order('quality', 'desc')).toEqual(['b', 'c', 'a'])
    expect(order('type', 'asc')).toEqual(['a', 'b', 'c'])
  })

  it('leaves the source collection untouched', () => {
    const images = collection()
    sortImages(images, 'size', 'asc')
    expect(images.map((entry) => entry.id)).toEqual(['b', 'a', 'c'])
  })

  it('breaks ties by name in both directions so the order never shuffles', () => {
    const tied = [
      image({ id: 'z', name: 'zebra.jpg', exactHash: 'z', perceptualHash: null, bytes: 500 }),
      image({ id: 'm', name: 'mango.jpg', exactHash: 'm', perceptualHash: null, bytes: 500 }),
    ]
    expect(sortImages(tied, 'size', 'desc').map((entry) => entry.id)).toEqual(['m', 'z'])
    expect(sortImages(tied, 'size', 'asc').map((entry) => entry.id)).toEqual(['m', 'z'])
  })

  it('groups records with no usable timestamp instead of dating them to 1970', () => {
    const undated = [
      image({ id: 'known', exactHash: 'k', perceptualHash: null, addedAt: '2026-04-01T00:00:00.000Z' }),
      image({ id: 'legacy', exactHash: 'l', perceptualHash: null, addedAt: undefined as unknown as string }),
      image({ id: 'epoch', exactHash: 'e', perceptualHash: null, addedAt: new Date(0).toISOString() }),
    ]
    expect(sortImages(undated, 'added', 'desc').map((entry) => entry.id)).toEqual(['known', 'epoch', 'legacy'])
    expect(formatTimestamp(new Date(0).toISOString())).toBe('Date unknown')
    expect(formatTimestamp(undefined)).toBe('Date unknown')
  })

  it('describes the active sort key on the card and defaults the direction per key', () => {
    const [, sample] = collection()
    expect(describeSortValue(sample, 'size')).toBe('900 B')
    expect(describeSortValue(sample, 'type')).toBe('JPG')
    expect(describeSortValue(sample, 'dimensions')).toBe('400 × 400')
    expect(describeSortValue(sample, 'name')).toBe('400 × 400')
    expect(describeSortValue(sample, 'modified')).toContain('2026')
    expect(naturalSortDirection('name')).toBe('asc')
    expect(naturalSortDirection('added')).toBe('desc')
    expect(naturalSortDirection('size')).toBe('desc')
  })
})

describe('1:1 crop lock', () => {
  // The image behind the reported coaster problem: 2776 x 2443, so a square in
  // pixels is emphatically not a square in percentages.
  const W = 2776
  const H = 2443
  const squareness = (crop: Parameters<typeof cropPixelSize>[0]) => {
    const { width, height } = cropPixelSize(crop, W, H)
    return Math.abs(width - height)
  }

  it('produces an equal pixel width and height on a non-square image', () => {
    const locked = squareCropInsets({ left: 10, right: 10, top: 0, bottom: 0 }, W, H, ['right'])
    expect(squareness(locked)).toBeLessThanOrEqual(1)
    const { width, height } = cropPixelSize(locked, W, H)
    expect(width).toBeGreaterThan(2000)
    expect(height).toBeGreaterThan(2000)
  })

  it('stays square whichever edge or corner is dragged', () => {
    const drags: Array<Array<'left' | 'right' | 'top' | 'bottom'>> = [
      ['left'], ['right'], ['top'], ['bottom'],
      ['top', 'left'], ['top', 'right'], ['bottom', 'left'], ['bottom', 'right'],
    ]
    for (const edges of drags) {
      const locked = squareCropInsets({ left: 12, right: 8, top: 21, bottom: 4 }, W, H, edges)
      expect(squareness(locked), `edges ${edges.join('+')} must stay square`).toBeLessThanOrEqual(1)
      expect(locked.left).toBeGreaterThanOrEqual(0)
      expect(locked.right).toBeGreaterThanOrEqual(0)
      expect(locked.top).toBeGreaterThanOrEqual(0)
      expect(locked.bottom).toBeGreaterThanOrEqual(0)
      expect(locked.left + locked.right).toBeLessThan(100)
      expect(locked.top + locked.bottom).toBeLessThan(100)
    }
  })

  it('pins the edge that is not being dragged so the frame grows away from the handle', () => {
    // Dragging the right edge must leave the left edge where it was.
    const right = squareCropInsets({ left: 15, right: 30, top: 5, bottom: 5 }, W, H, ['right'])
    expect(right.left).toBeCloseTo(15, 3)
    // Dragging the left edge must leave the right edge where it was.
    const left = squareCropInsets({ left: 30, right: 15, top: 5, bottom: 5 }, W, H, ['left'])
    expect(left.right).toBeCloseTo(15, 3)
  })

  it('squares the existing frame about its centre when the lock is switched on', () => {
    const before = { left: 10, right: 10, top: 5, bottom: 5 }
    const locked = squareCropInsets(before, W, H, [])
    expect(squareness(locked)).toBeLessThanOrEqual(1)
    // Centred: the two insets on each axis stay balanced.
    expect(locked.left).toBeCloseTo(locked.right, 2)
    expect(locked.top).toBeCloseTo(locked.bottom, 2)
    // And it fits inside the frame it started from rather than growing past it.
    const { width } = cropPixelSize(locked, W, H)
    expect(width).toBeLessThanOrEqual(cropPixelSize(before, W, H).width + 1)
  })

  it('never asks for a square larger than the short edge, however far the drag goes', () => {
    const locked = squareCropInsets({ left: 0, right: 0, top: 0, bottom: 0 }, W, H, ['right'])
    const { width, height } = cropPixelSize(locked, W, H)
    expect(width).toBeLessThanOrEqual(Math.min(W, H))
    expect(height).toBeLessThanOrEqual(Math.min(W, H))
    expect(squareness(locked)).toBeLessThanOrEqual(1)
  })

  it('holds on a portrait image as well as a landscape one', () => {
    const portrait = squareCropInsets({ left: 5, right: 5, top: 10, bottom: 10 }, 1200, 2000, ['bottom'])
    const { width, height } = cropPixelSize(portrait, 1200, 2000)
    expect(Math.abs(width - height)).toBeLessThanOrEqual(1)
  })

  it('reports the pixel size the crop will produce', () => {
    expect(cropPixelSize({ left: 0, right: 0, top: 0, bottom: 0 }, W, H)).toEqual({ width: W, height: H })
    expect(cropPixelSize({ left: 25, right: 25, top: 0, bottom: 0 }, 1000, 800)).toEqual({ width: 500, height: 800 })
  })

  // Each inset rounds to pixels independently, so a locked frame can compute to
  // 1507 x 1508. The processor equalises that; the readout must show the same
  // number the saved file will have rather than the arithmetic before it.
  it('reports an exactly square size when the lock is on, matching the saved file', () => {
    const locked = squareCropInsets({ left: 6, right: 40, top: 8, bottom: 30 }, W, H, ['right'])
    const free = cropPixelSize(locked, W, H)
    const square = cropPixelSize(locked, W, H, true)
    expect(square.width).toBe(square.height)
    expect(square.width).toBe(Math.min(free.width, free.height))
  })
})

describe('paint brush sizing', () => {
  // The coaster this workbench was built around.
  const W = 2776
  const H = 2443

  it('reaches a single source pixel at the bottom of the slider', () => {
    expect(brushPixelsFromSlider(0, W, H)).toBe(BRUSH_MIN_PIXELS)
    expect(brushPixelsFromSlider(0, W, H)).toBe(1)
    // One pixel of a 2443px short edge; the old 0.5% floor was twelve.
    expect(brushSizeFromPixels(1, W, H)).toBeCloseTo(1 / 2443, 12)
  })

  it('spans one pixel to a broad brush across the track', () => {
    expect(brushPixelsFromSlider(BRUSH_SLIDER_STEPS, W, H)).toBe(brushMaxPixels(W, H))
    expect(brushMaxPixels(W, H)).toBe(Math.round(2443 * 0.16))
  })

  // A linear track would put every size below 40px in its first 1% of travel.
  // The logarithmic one gives the small end real room: the first tenth of the
  // slider must still be a fine brush.
  it('gives the fine sizes a usable share of the travel', () => {
    expect(brushPixelsFromSlider(BRUSH_SLIDER_STEPS * 0.1, W, H)).toBeLessThan(3)
    expect(brushPixelsFromSlider(BRUSH_SLIDER_STEPS * 0.5, W, H)).toBeLessThan(brushMaxPixels(W, H) / 4)
  })

  // Sizes are whole pixels, so several slider positions mean the same brush and
  // the thumb settles on the canonical one. What must hold is that settling
  // there does not change the brush: position, size and pixels stay consistent.
  it('round-trips a chosen size without drifting to another brush', () => {
    for (const position of [0, 120, 375, 500, 800, BRUSH_SLIDER_STEPS]) {
      const pixels = brushPixelsFromSlider(position, W, H)
      const size = brushSizeFromPixels(pixels, W, H)
      expect(brushPixelsFromSize(size, W, H)).toBe(pixels)
      expect(brushPixelsFromSlider(brushSliderPosition(size, W, H), W, H)).toBe(pixels)
    }
  })

  // Size is stored as a fraction of the shorter edge, so the same stroke has to
  // stay the same physical mark when a revision changes the pixel dimensions.
  it('keeps a stored fraction meaningful across a resize', () => {
    const size = brushSizeFromPixels(24, W, H)
    expect(brushPixelsFromSize(size, W * 2, H * 2)).toBe(48)
  })

  it('never returns a size below one pixel, whatever it is handed', () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(brushPixelsFromSize(bad, W, H)).toBeGreaterThanOrEqual(BRUSH_MIN_PIXELS)
      expect(brushPixelsFromSlider(bad, W, H)).toBeGreaterThanOrEqual(BRUSH_MIN_PIXELS)
    }
    // A tiny thumbnail must still offer more than a single size.
    expect(brushMaxPixels(4, 4)).toBeGreaterThan(BRUSH_MIN_PIXELS)
  })
})


describe('backdrop colour in the prompts', () => {
  // The surround colour is a prompt decision, not a post-process: the model has
  // to be told, or it returns black and the deterministic pass is left forcing
  // a colour the artwork was never composited against.
  it('names the chosen colour in the coaster prompt', () => {
    const black = buildGeminiPresetPrompt('coaster', [])
    expect(black).toContain('pure black, #000000')
    const grey = buildGeminiPresetPrompt('coaster', [], 'a flat mid grey, #97999b')
    expect(grey).toContain('a flat mid grey, #97999b')
    expect(grey).not.toContain('pure black, #000000')
  })

  it('carries a surround instruction into every preset that produces one', () => {
    for (const preset of ['standard', 'despeckle', 'flat_background', 'coaster', 'reimagine'] as const) {
      expect(buildGeminiPresetPrompt(preset, [], 'pure white, #ffffff'), preset).toContain('pure white, #ffffff')
    }
  })

  // Complete edges continues the artwork's own background outwards. Naming a
  // backdrop there would contradict the one thing that preset exists to do.
  it('leaves Complete edges and Custom alone', () => {
    expect(buildGeminiPresetPrompt('outpaint', [], 'pure white, #ffffff')).not.toContain('pure white')
    expect(buildGeminiPresetPrompt('custom', [], 'pure white, #ffffff')).toBe('')
  })

  it('forbids a halo between the artwork and the surround', () => {
    expect(buildGeminiPresetPrompt('standard', [])).toMatch(/drop shadow, rim light, halo, outline, keyline, or seam/i)
  })

  // `None` is the default: the request must then say nothing at all about what
  // colour the background should be, and must not leave the gap where the
  // surround paragraph used to sit.
  it('says nothing about a surround when the backdrop is None', () => {
    for (const preset of ['standard', 'despeckle', 'flat_background', 'reimagine'] as const) {
      const prompt = buildGeminiPresetPrompt(preset, [], null)
      expect(prompt, preset).not.toContain('Surround:')
      expect(prompt, preset).not.toMatch(/#[0-9a-f]{6}/i)
      expect(prompt, preset).not.toMatch(/ {2,}/)
    }
  })

  // The coaster preset removes the photographed table, so it still has to say
  // what goes there — but with None it names no colour.
  it('keeps the coaster surround flat but unnamed when the backdrop is None', () => {
    const prompt = buildGeminiPresetPrompt('coaster', [], null)
    expect(prompt).toContain('a single flat colour')
    expect(prompt).not.toMatch(/#[0-9a-f]{6}/i)
    expect(prompt).not.toMatch(/ {2,}/)
  })
})



describe('bulk selection', () => {
  // Toggling each image on its own is not a bulk edit: on a mixed selection it
  // swaps which images carry the tag and leaves the selection just as mixed.
  it('reports a tag as all, some, or none across the selection', () => {
    expect(bulkTagState([['border'], ['border']], 'border')).toBe('all')
    expect(bulkTagState([['border'], []], 'border')).toBe('some')
    expect(bulkTagState([[], ['crop']], 'border')).toBe('none')
    expect(bulkTagState([], 'border')).toBe('none')
  })

  // A press always ends somewhere visible: on, unless it was already on
  // everything, in which case off.
  it('adds the tag unless every image already carries it', () => {
    expect(bulkTagAction('none')).toBe('add')
    expect(bulkTagAction('some')).toBe('add')
    expect(bulkTagAction('all')).toBe('remove')
  })

  it('takes a shift-click range in the order the grid is showing', () => {
    const shown = ['a', 'b', 'c', 'd', 'e']
    expect(selectionRange(shown, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(selectionRange(shown, 'd', 'b')).toEqual(['b', 'c', 'd'])
    expect(selectionRange(shown, 'c', 'c')).toEqual(['c'])
  })

  // An anchor that has been filtered out of the grid since it was clicked must
  // not select a range measured against a list it is not in.
  it('falls back to the clicked image when the anchor is no longer shown', () => {
    expect(selectionRange(['a', 'b'], 'zz', 'b')).toEqual(['b'])
    expect(selectionRange(['a', 'b'], 'a', 'zz')).toEqual([])
  })
})


describe('writing a prompt for one image', () => {
  // The presets are the same words for every coaster. This exists for the image
  // whose damage or geometry is peculiar to it, so the instruction has to force
  // the model to look rather than restate the standard cleanup.
  it('demands the faults of this image rather than a general cleanup', () => {
    const instruction = buildPromptAuthorInstruction([])
    expect(instruction).toMatch(/what is actually in front of you/i)
    expect(instruction).toMatch(/A generic instruction is worthless here/i)
  })

  // A person means "make it good on a T-shirt". An image model told about a
  // T-shirt draws a T-shirt, so the garment is named here and banned there.
  it('names the garment to the writer and forbids it in what gets written', () => {
    const instruction = buildPromptAuthorInstruction([])
    expect(instruction).toMatch(/printed on garments and used as reference in a Midjourney moodboard/i)
    expect(instruction).toMatch(/never ask for a mockup, a garment, a shirt, a person/i)
  })

  it('carries the house rules the presets are built on', () => {
    const instruction = buildPromptAuthorInstruction([])
    expect(instruction).toMatch(/exact wording, spelling, letter shapes/i)
    expect(instruction).toMatch(/forbid redesigning, simplifying, translating/i)
    expect(instruction).toContain('Return only the finished image at the same aspect ratio.')
    expect(instruction).toMatch(/no markdown/i)
  })

  it('passes the flagged issues on as things already noticed', () => {
    const instruction = buildPromptAuthorInstruction(['border', 'perspective'])
    expect(instruction).toContain('Border, Perspective')
    expect(instruction).toMatch(/do not assert a fault that is not visible/i)
    expect(buildPromptAuthorInstruction([])).not.toMatch(/already flagged/i)
  })

  // The backdrop squares decide the surround for a preset; a bespoke prompt has
  // to obey the same choice, including None, which asks for nothing.
  it('follows the backdrop choice, including asking for no colour at all', () => {
    expect(buildPromptAuthorInstruction([], 'pure black, #000000')).toContain('pure black, #000000')
    const none = buildPromptAuthorInstruction([], null)
    expect(none).toMatch(/Say nothing about changing the background or surround colour/i)
    expect(none).not.toMatch(/#[0-9a-f]{6}/i)
  })

  describe('tidying what comes back', () => {
    it('unwraps a fenced block', () => {
      expect(cleanAuthoredPrompt('```\nRemove the foxing.\n```')).toBe('Remove the foxing.')
      expect(cleanAuthoredPrompt('```text\nRemove the foxing.\n```')).toBe('Remove the foxing.')
    })

    it('drops an introduction the model wrote for itself', () => {
      expect(cleanAuthoredPrompt('Here is the prompt: Remove the foxing.')).toBe('Remove the foxing.')
      expect(cleanAuthoredPrompt('**Prompt:** Remove the foxing.')).toBe('Remove the foxing.')
      expect(cleanAuthoredPrompt('Prompt for this image: Remove the foxing.')).toBe('Remove the foxing.')
    })

    it('unwraps a quoted instruction and leaves an ordinary one alone', () => {
      expect(cleanAuthoredPrompt('"Remove the foxing."')).toBe('Remove the foxing.')
      expect(cleanAuthoredPrompt('Remove the foxing. Keep the "Spruce 4436" lettering exactly.')).toBe('Remove the foxing. Keep the "Spruce 4436" lettering exactly.')
    })
  })
})

describe('peeking at the previous revision', () => {
  const revisions = ['original', 'first', 'second']
  it('shows the revision behind the working one while held', () => {
    expect(peekRevision(revisions, 2, true)).toBe('first')
    expect(peekRevision(revisions, 1, true)).toBe('original')
  })
  it('shows nothing when not held or when there is nothing behind', () => {
    expect(peekRevision(revisions, 2, false)).toBeNull()
    expect(peekRevision(revisions, 0, true)).toBeNull()
  })
})
