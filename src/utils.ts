import type { CropInsets, ImageRecord, ImageSize, IssueType } from '../shared/types'

export type DuplicateGroup = {
  id: string
  type: 'exact' | 'near'
  images: ImageRecord[]
  recommendedId: string
}

const KNOWN_DISTINCT_PAIRS = [
  ['f5d94b02-4bad-49fa-bd39-2286e93cff02.jpeg', 'aa83daf2-8570-4d07-a102-0ad552be3d6c.jpeg'],
  ['article_0128_1.jpg', '298120768_381303324194705_837676053749131888_n.png'],
] as const

export function areKnownDistinct(left: string, right: string) {
  return KNOWN_DISTINCT_PAIRS.some(([first, second]) =>
    (left === first && right === second) || (left === second && right === first),
  )
}

export function hammingHex(left: string, right: string) {
  let bits = BigInt(`0x${left}`) ^ BigInt(`0x${right}`)
  let distance = 0
  while (bits) {
    bits &= bits - 1n
    distance += 1
  }
  return distance
}

function numberedCopySuffix(name: string) {
  return /\s*\(\d+\)(?=\.[^.]+$)/i.test(name) ? 1 : 0
}

function bestImage(images: ImageRecord[], preferOriginalFilename = false) {
  return [...images].sort((a, b) => {
    if (preferOriginalFilename) {
      const nameDifference = numberedCopySuffix(a.name) - numberedCopySuffix(b.name)
      if (nameDifference) return nameDifference
    }
    return b.quality.score - a.quality.score || b.width * b.height - a.width * a.height || a.name.localeCompare(b.name)
  })[0]
}

// A copy the user made on purpose is not an accidental duplicate. It is held
// out of both groupings while its source is still in the collection, so the
// duplicate review never offers to delete work that was deliberately forked.
export function exactDuplicateGroups(images: ImageRecord[], intentionalCopies: ReadonlySet<string> = new Set()): DuplicateGroup[] {
  const byHash = new Map<string, ImageRecord[]>()
  for (const image of images) {
    if (intentionalCopies.has(image.path)) continue
    byHash.set(image.exactHash, [...(byHash.get(image.exactHash) ?? []), image])
  }
  return [...byHash.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([hash, group]) => ({ id: hash, type: 'exact' as const, images: group, recommendedId: bestImage(group, true).id }))
    .sort((a, b) => b.images.length - a.images.length)
}

export function nearDuplicateGroups(images: ImageRecord[], threshold = 5, intentionalCopies: ReadonlySet<string> = new Set()): DuplicateGroup[] {
  const considered = images.filter((image) => !intentionalCopies.has(image.path))
  const representatives = [...new Map(considered.map((image) => [image.exactHash, image])).values()]
    .filter((image) => image.perceptualHash)
  const parent = representatives.map((_, index) => index)
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]))
  const union = (left: number, right: number) => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent[b] = a
  }
  for (let left = 0; left < representatives.length; left += 1) {
    for (let right = left + 1; right < representatives.length; right += 1) {
      const a = representatives[left]
      const b = representatives[right]
      if (areKnownDistinct(a.name.toLowerCase(), b.name.toLowerCase())) continue
      const aspectA = a.width / Math.max(a.height, 1)
      const aspectB = b.width / Math.max(b.height, 1)
      if (Math.abs(aspectA - aspectB) / Math.max(aspectA, aspectB) > 0.12) continue
      if (hammingHex(a.perceptualHash!, b.perceptualHash!) <= threshold) union(left, right)
    }
  }
  const components = new Map<number, ImageRecord[]>()
  representatives.forEach((image, index) => {
    const root = find(index)
    components.set(root, [...(components.get(root) ?? []), image])
  })
  return [...components.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      id: group.map((image) => image.id).sort().join(':'),
      type: 'near' as const,
      images: group,
      recommendedId: bestImage(group).id,
    }))
    .sort((a, b) => b.images.length - a.images.length)
}

const ISSUE_INSTRUCTIONS: Record<IssueType, string> = {
  border: 'Remove the accidental outer border or edge line while preserving every intentional outline inside the artwork.',
  crop: 'Crop only unnecessary surrounding material and keep the complete intended artwork visible.',
  texture: 'Remove photographed paper, fabric, print, grain, distress, and surface texture; make intended color areas clean and solid.',
  perspective: 'Make the design completely flat, straight, front-facing, and purely two-dimensional; remove perspective, depth, bevels, and cast shadows.',
  rotation_needed: 'Rotate the artwork so its text baselines and structure sit perfectly level, extending the background naturally where the correction exposes new canvas.',
  watermark: 'Remove the overlaid watermark only where I have the rights to the source image, reconstructing the underlying artwork consistently.',
  background: 'Separate the intended artwork from its photographed surroundings and replace the surroundings with one clean, uniform background.',
  low_quality: 'Faithfully reconstruct the artwork at high resolution, repairing compression, blur, jagged edges, fading, and accidental imperfections.',
  off_center: 'Centre the intended artwork with visually symmetrical margins without changing its proportions.',
}

export type GeminiPresetId = 'standard' | 'despeckle' | 'edges' | 'concentric' | 'outpaint' | 'flat_background' | 'coaster' | 'reimagine' | 'custom'

// `minSize` is the smallest output a preset is worth running at, and it decides
// which models the preset can be sent to: a model that cannot serve that size
// is dropped from the menu rather than offered and then failing. Complete edges
// and Photographed coaster want 2K because their sources are around 3000 px,
// and that is exactly why Flash Lite — 1K only — cannot run either of them.
export const GEMINI_PRESETS: Array<{ id: GeminiPresetId; label: string; description: string; minSize: ImageSize }> = [
  { id: 'standard', label: 'Standard', description: 'Faithful cleanup based on the selected issue tags.', minSize: '1K' },
  { id: 'despeckle', label: 'Clean spots', description: 'Remove accidental flecks and special-effect noise across both foreground and background.', minSize: '1K' },
  { id: 'edges', label: 'Clean edges', description: 'Remove a leftover halo or fringe of a previous colour along the edges, and change nothing else.', minSize: '1K' },
  { id: 'concentric', label: 'Even the border', description: 'Centre a shape inside the one around it so the band between them is the same width the whole way round.', minSize: '1K' },
  { id: 'outpaint', label: 'Complete edges', description: 'Add background-coloured canvas only where existing artwork touches an edge, then continue that clipped artwork.', minSize: '2K' },
  { id: 'flat_background', label: 'Flat background', description: 'Replace gradients, glows, and vignettes behind the artwork with one solid colour.', minSize: '1K' },
  { id: 'coaster', label: 'Photographed coaster', description: 'Vintage beer mats and labels shot on a table: square up the camera angle even from a steep view, true up off-register rings to one shared centre, clean age damage, and cut the coaster out onto pure black.', minSize: '2K' },
  { id: 'reimagine', label: 'Reimagine design', description: 'Keep the era, mood, palette, and layout essence while creating new wording and original imagery.', minSize: '1K' },
  { id: 'custom', label: 'Custom', description: 'Start with a blank prompt; Gemini still receives the current working image.', minSize: '1K' },
]

const issueInstructions = (issues: IssueType[]) => issues.map((issue) => ISSUE_INSTRUCTIONS[issue]).join(' ')
const fidelityInstruction = 'Preserve the exact wording, spelling, letter shapes, colors, proportions, composition, and recognizable identity. Do not redesign, simplify, translate, or add unrelated elements.'

// Every preset that produces a surround says what colour it should be, unless
// the backdrop is None: a null phrase means the prompt asks for no background
// colour at all, so the surround paragraph is left out entirely. Complete edges
// is the other exception — it continues the artwork's own background outwards,
// so naming a backdrop there would contradict the instruction it exists for.
const backdropInstruction = (phrase: string | null) => phrase === null ? '' : `Surround: fill every part of the canvas that is not the artwork itself with ${phrase}, absolutely uniform, with no gradient, vignette, texture, shadow, glow, noise, lighting variation, or colour drift of any kind. Do not add a drop shadow, rim light, halo, outline, keyline, or seam between the artwork and that surround.`

export function buildGeminiPresetPrompt(preset: GeminiPresetId, issues: IssueType[], backdrop: string | null = 'pure black, #000000') {
  // Omitting the surround paragraph leaves the gap it used to fill, so the
  // seams between the remaining paragraphs are closed up here.
  return buildPresetPrompt(preset, issues, backdrop).replace(/ {2,}/g, ' ').trim()
}

function buildPresetPrompt(preset: GeminiPresetId, issues: IssueType[], backdrop: string | null) {
  const instructions = issueInstructions(issues)
  const surround = backdropInstruction(backdrop)
  // The coaster preset must still say what happens to the photographed table it
  // is removing, so with None it asks only for one flat colour and names none.
  const coasterFill = backdrop === null ? 'a single flat colour' : backdrop
  if (preset === 'despeckle') {
    return `Faithfully clean and reconstruct the supplied reference as a production-ready graphic. Remove every accidental spot, speckle, dust fleck, pitted mark, stain, grain particle, and special-effect noise from the entire image, including light background areas, dark foreground areas, and coloured fills. Reconstruct affected outlines and flat colour areas cleanly. ${surround} Preserve intentional dots that belong to punctuation, lettering, eyes, decorative rays, or deliberately drawn shapes. ${instructions} ${fidelityInstruction} Return only the finished image at the same aspect ratio.`
  }
  // The one job of this preset is the fringe a fill or a replace can leave
  // behind, so it says that and nothing else — no surround, no issue tags, no
  // fidelity paragraph to argue with. Anything more invites a redraw.
  if (preset === 'edges') {
    return 'The edges in this image carry a thin leftover fringe: a pale halo, outline, or line of a previous colour that belongs to neither the artwork nor the background it now sits on. Remove it. Blend each of those pixels into the two colours they sit between so every edge is clean, sharp, and evenly anti-aliased. Change absolutely nothing else: keep every colour, shape, letter, line, thickness, proportion, and the background exactly as they are. Add nothing, remove nothing, redraw nothing. Return only the corrected image at the same aspect ratio.'
  }
  // The single-job discipline that `edges` established, applied to register.
  // It carries no surround, no issue tags and no fidelity paragraph for the
  // same reason: this preset moves one shape and must not be handed a licence
  // to redraw anything. It replaced the deterministic `Recentre inner content`
  // tool on 2026-09-06 — see memory.md for why that never worked in practice.
  if (preset === 'concentric') {
    return `One shape in this image sits inside another — a disc inside a ring, a printed panel inside a border, an oval label on a rectangular field — and it is off-centre, so the band of space around it is thicker on one side than on the other. Move the inner shape so that band is exactly the same width the whole way round. Measure it at the top, at the bottom, at the left, at the right, and on both diagonals: all six measurements must come out equal.

Where several elements are concentric — the outer silhouette, each printed ring, rule, border and roundel, and the central field — every one of them must end up sharing a single common centre, and any curved lettering must sit on an arc concentric with those rings, holding a constant distance from the edge all the way around. If the whole design sits within the canvas, its margin to the canvas edge must be equal on all four sides as well, so the design sits at the exact centre of the frame.

This is a deliberate regularisation, not a restoration. These pieces were printed on fast presses and the physical object really is out of register, so the reference genuinely does show the inner shape nudged to one side; reproducing that faithfully is exactly what is not wanted here. Return the design as the press intended it, not as it actually came off the press. Where the reference and true concentricity disagree, concentricity wins.

Move, and do nothing else. Do not redraw, restyle, resize, rescale, straighten, rotate, recolour, clean, sharpen, denoise or re-letter anything. Keep every colour, shape, letter, line, thickness, proportion, texture and edge exactly as it is, including any grain, wear, damage or printing artefacts — they are not your concern in this task. Add nothing and remove nothing. Fill whatever space the move opens up with the colour that already surrounds the shape on that side, so no seam, halo, outline, shadow or ghost is left where the shape used to sit. Return only the corrected image at the same aspect ratio.`
  }
  if (preset === 'outpaint') {
    return 'Extend only the existing artwork that is visibly cut off by a canvas edge. MoodPrep has added matching background-coloured canvas only on the affected sides. Continue each clipped shape naturally into that new space until it is complete and no longer touches the edge. Keep the existing background, composition, wording, characters, colours, proportions, and drawing style unchanged. Do not add any new text, borders, frames, symbols, logos, characters, objects, scenery, decorations, or design elements. Do not redesign or rearrange anything. Modify only the cropped parts already intersecting an original edge, and return only the completed image.'
  }
  if (preset === 'flat_background') {
    return `Faithfully reconstruct the supplied reference as a production-ready graphic. Replace every gradient, vignette, glow, colour fade, and uneven tonal transition in the background with one clean, perfectly uniform solid colour matching the dominant intended background hue. Preserve all foreground artwork, lettering, internal colours, outlines, and intentional subject shading. Remove background halos or colour fringing around the subject and leave crisp, natural edges. ${surround} ${instructions} ${fidelityInstruction} Return only the finished image at the same aspect ratio.`
  }
  if (preset === 'coaster') {
    return `The supplied reference is a vintage beer coaster, beer mat, or bottle label photographed on a table or board. Rebuild it as a clean, production-ready flat graphic. Correct geometry is the single most important requirement of this task and outranks every other consideration, including staying faithful to how the photograph was framed.

Geometry and symmetry (highest priority): the piece was photographed from an angle and may be severely foreshortened, strongly tilted, or seen almost edge-on, so treat the photograph as a perspective projection and recover the object's true front-on shape. Fully undo that projection — do not merely rotate the image, straighten it a little, or partially reduce the skew. Rebuild the piece exactly as a flatbed scanner would record it: perfectly flat, square-on, and viewed from directly above its centre. Restore its true manufactured shape rather than the shape the camera recorded. A round coaster must come back as a mathematically perfect circle whose diameter is identical measured across every axis — horizontal, vertical, and both diagonals — never an ellipse, oval, egg, or tilted disc, however elliptical it appears in the photograph. A square or rectangular mat must have straight parallel edges, equal opposite sides, and genuine 90-degree corners. An oval, shield, or scalloped shape keeps its own axis of symmetry. Remove all keystoning, foreshortening, lean, curl, and page-tilt completely. The design's own symmetry must be restored as well: concentric printed rings share one common centre and are truly circular, the outline's centre coincides with the design's centre, radial elements such as stars, rays, ticks, and scallops are evenly spaced and equally sized around that centre, and every line of curved lettering sits on a smooth, even, concentric arc with a constant cap height. Vertical elements must stand upright and horizontal rules must be level. If faithfully reproducing the photographed appearance would conflict with achieving true, regular, symmetrical geometry, the geometry wins.

Concentricity and ring placement (the most common failure by far, and it is not caused by the camera): these pieces were printed on fast presses and the physical object is very often genuinely out of register, so on the real coaster the inner disc sits slightly off-centre inside the outer ring and the band of colour between them is visibly thicker on one side than the other. Reproducing that faithfully is wrong here. Every concentric element — the outer silhouette, each printed ring, rule, border and roundel, and the central field — must share one single common centre. The band between any two neighbouring rings must therefore be exactly the same width the whole way round: measure it at the top, at the bottom, at the left, at the right, and on both diagonals, and all six measurements must come out equal. A ring that is thicker at the bottom than the top, an inner circle nudged towards one side, a border that crowds one edge of the piece while leaving a wide gap at the other, or a design whose centre does not coincide with the silhouette's centre is wrong however plainly the reference shows it. Curved lettering must sit on an arc concentric with those same rings, holding a constant distance from the edge all the way around. Treat this as a deliberate regularisation rather than a restoration: return the design as the press intended it, not as it actually came off the press. This requirement overrides fidelity to the reference. Fidelity governs the wording, the illustration, the typography and the colours; it does not govern where a ring sits.

Framing: the canvas you are given is square. Return a square image of the same proportions, with the corrected piece centred in it and its full silhouette comfortably inside the frame, not touching or overflowing the edges. The black margin above, below, to the left of and to the right of the silhouette must be equal, so the piece sits at the exact centre of the canvas. Do not crop the piece, do not re-crop the canvas to the subject, and do not return a rectangular image.

Background: remove the photographed table, board, cloth, or surface entirely, and flatten away the coaster's physical thickness, bevel, and any three-dimensional edge so only its flat silhouette remains. Keep the coaster's own outline — almost always a circle — complete and intact, with a clean, sharp, even edge; that silhouette is the subject and must not be altered, cropped, or dissolved. Fill every part of the canvas outside that outline with ${coasterFill}, absolutely uniform, with no gradient, vignette, texture, shadow, glow, noise, lighting variation, or colour drift of any kind. Do not extend the coaster's own background colour outwards into the canvas. Do not add a drop shadow, rim light, halo, outline, or seam around the silhouette. The finished image should read as the flat coaster artwork sitting on a perfectly uniform field of that colour. Keep every printed ring, border line, rule, and frame that belongs to the design — remove only the surroundings it was resting on.

Condition: remove the damage the object has accumulated with age — foxing, brown spots, water and beer stains, dirt, dust, fibre flecks, scuffs, creases, dents, nicks, worn edges, fading patches, mould marks, and the pitted cardboard or paper-board texture. Remove photographic artefacts too: glare, hotspots, cast shadows, uneven lighting, the lighting's colour cast on neutral areas, and camera blur. Reconstruct the artwork cleanly underneath so colour areas end up flat and solid and every outline is crisp and unbroken. Where a printed area has faded, restore it to that ink's own colour, not to a colour you would expect it to have been; read Colour below before changing any hue.

Colour: the only colour correction wanted here is the removal of age from the substrate. Where the board, card or paper was originally white, cream, or another near-neutral, neutralise the yellow-brown ageing cast and give back the clean neutral it was printed on. Apply that correction to those neutral areas alone. Do not apply a global white balance, a global colour-cast removal, a global rebalance, or a global desaturation across the whole frame. Pulling yellow out of the entire image is precisely what turns an orange into a red and a coral into a crimson, and it is the most damaging thing that can be done to this artwork — the substrate is ageing, the inks are not.

Every chromatic printed ink comes back at its own exact hue, saturation and brightness: sample the colour as printed and reproduce that colour. Do not shift a hue towards a more typical, more expected, more canonical, or more tasteful version of itself, and never assume a warm colour is a faded version of a cooler one — the warmth is the ink, not the damage. A vivid orange-red or vermilion stays orange-red and must not settle into a plain red. A coral, salmon, pink, or rose stays pink and must not deepen into crimson or maroon. A warm red stays warm rather than becoming a neutral primary red. Oranges stay orange. Greens, blues, golds, and yellows likewise keep the exact hue they were printed in rather than drifting towards a standard version of that colour. Do not mute, dull, deepen, darken, sober, or harmonise the palette, and do not make the colours more coherent with one another than they were printed: these inks were chosen to be loud and that vividness is the point of the design. If a colour strikes you as surprisingly bright, unusually warm, or slightly wrong for the subject, it is correct as printed — keep it exactly.

${instructions} ${fidelityInstruction} Preserve the original wording, spelling, language, typography, emblems, illustration, and colour identity exactly as printed; restore them faithfully rather than redrawing or modernising them. That fidelity applies to what the design says and shows, not to how accurately it was printed or photographed: geometry, symmetry, concentricity and centring are corrected to true, never copied from the reference, while the printed ink colours are copied from the reference exactly and never corrected. Return only the finished square image.`
  }
  if (preset === 'reimagine') {
    return `Use the supplied image as a creative reference for its visual era, graphic genre, colour mood, compositional rhythm, and broad typography feel, then create a new and original non-identical design. Preserve the essence and overall theme rather than the protected identity. Replace every title, name, slogan, and line of wording with newly invented generic wording that suits the theme. Replace protected logos, emblems, and distinctive character likenesses with original alternatives. Do not reproduce the original names, exact lettering, trademarked symbols, or exact character design. Keep the result recognisably inspired by the same kind of vintage design without being a copy. ${surround} ${instructions} Return only the finished original graphic at the same aspect ratio.`
  }
  if (preset === 'custom') return ''
  return `Faithfully clean and reconstruct the supplied reference as a production-ready graphic. ${instructions || 'Preserve the complete artwork and improve only accidental technical defects.'} ${surround} ${fidelityInstruction} Do not invent missing content. Return only the finished image at the same aspect ratio.`
}

// Asking a vision model to write the prompt for one particular image.
//
// The presets are general by design — they are the same words for every coaster
// — and a bespoke instruction is worth having precisely where they run out: an
// image whose damage, geometry or palette is peculiar to it. So the whole point
// of this instruction is to force the model to describe what it can actually
// see rather than return a tidier version of the standard cleanup.
//
// The target is stated as properties rather than as a destination. Naming the
// T-shirt is what a person means, but an image model told about a T-shirt draws
// a T-shirt, so the garment is described here — to the model writing the words
// — and forbidden there, in the words it writes.
export function buildPromptAuthorInstruction(issues: IssueType[], backdrop: string | null = null) {
  const flagged = issues.length > 0
    ? `The person preparing this image has already flagged: ${issues.map(humanIssue).join(', ')}. Cover those where you can see them, and do not assert a fault that is not visible to you. `
    : ''
  const surround = backdrop === null
    ? 'Say nothing about changing the background or surround colour; leave that decision alone unless a photographed surface has to be removed. '
    : `The instruction must ask for every part of the canvas that is not the artwork to be filled with ${backdrop}, absolutely uniform, with no gradient, texture, shadow, glow, halo or seam between the artwork and that surround. `
  return `You are looking at one image from a collection of vintage printed graphics — beer mats, bottle labels, crests, packaging, advertising — which are being cleaned up so they can be printed on garments and used as reference in a Midjourney moodboard. Study this particular image and write the instruction that will be handed to an image-editing model to reconstruct it.

Write about what is actually in front of you. Name this image's own faults and peculiarities: the damage and dirt that are really present, the geometry that is really out, the lettering, illustration and emblems it really carries, the colours it is really printed in, and anything unusual about it that a general cleanup instruction would miss. A generic instruction is worthless here — the whole value is in naming what this image in particular needs.

${flagged}Describe the finished graphic in terms of its properties: flat solid areas of colour, crisp unbroken outlines, even anti-aliasing, no photographic surface, no paper or board texture, no glare, cast shadow, vignette, blur or compression noise, and enough contrast to stay legible when it is reproduced small. It should read as one clean piece of flat artwork rather than a photograph of an object.

The design's identity is not yours to change. Require the exact wording, spelling, letter shapes, typography, illustration, emblems, proportions, composition and printed ink colours to be preserved, and forbid redesigning, simplifying, translating, modernising, restyling or adding anything that is not already there. ${surround}

The instruction covers the artwork alone. It must never ask for a mockup, a garment, a shirt, a person, a scene, a room, a frame, a border, a caption, a watermark, a signature or any presentation of the design on a product.

Reply with the instruction itself and nothing else: one to three short paragraphs of plain prose, under 200 words, written as direct commands to the editing model. No title, no preamble, no numbered list, no markdown, no quotation marks, and no explanation of your reasoning. End with this sentence exactly: Return only the finished image at the same aspect ratio.`
}

// Models introduce themselves however they like. The prompt box holds the
// instruction and nothing else, so a fenced block, a "Here is the prompt:"
// opener or a wrapping pair of quotes is stripped rather than left for the user
// to delete by hand before every run.
export function cleanAuthoredPrompt(text: string) {
  let cleaned = text.trim()
  const fenced = cleaned.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i)
  if (fenced) cleaned = fenced[1].trim()
  cleaned = cleaned.replace(/^\**\s*(?:here(?:'|\u2019)?s|here is|here are)?\s*(?:the\s+)?(?:suggested\s+|custom\s+|bespoke\s+)?prompt\b[^:\n]{0,40}:\**\s*/i, '')
  cleaned = cleaned.replace(/^\s*(?:\*\*)?here(?:'|\u2019)?s[^:\n]{0,80}:\s*/i, '')
  if (/^["\u201c][\s\S]*["\u201d]$/.test(cleaned)) cleaned = cleaned.slice(1, -1).trim()
  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}

export function buildGeminiPrompt(issues: IssueType[]) {
  return buildGeminiPresetPrompt('standard', issues)
}

// Bulk tagging over a mixed selection.
//
// Toggling each image independently was the old behaviour and it is not a bulk
// edit at all: on a selection where two images carry Border and two do not, one
// press swaps which two have it. Nothing on screen said which state you were
// in, and there was no way to say "all of these are Border". A tag is therefore
// a three-state control — every one, some, none — and a press always ends in a
// state you can see: on unless it was already on everything.
export type BulkTagState = 'all' | 'some' | 'none'

export function bulkTagState(issueLists: IssueType[][], issue: IssueType): BulkTagState {
  if (issueLists.length === 0) return 'none'
  const carrying = issueLists.filter((issues) => issues.includes(issue)).length
  if (carrying === 0) return 'none'
  return carrying === issueLists.length ? 'all' : 'some'
}

export function bulkTagAction(state: BulkTagState): 'add' | 'remove' {
  return state === 'all' ? 'remove' : 'add'
}

// Shift-clicking selects everything between the last checkbox touched and this
// one, in the order the grid is actually showing — the sort and the filters
// have already decided that order, so the range follows the eye rather than the
// underlying collection.
export function selectionRange(visibleIds: string[], anchorId: string, targetId: string): string[] {
  const anchor = visibleIds.indexOf(anchorId)
  const target = visibleIds.indexOf(targetId)
  if (anchor === -1 || target === -1) return target === -1 ? [] : [targetId]
  const [from, to] = anchor <= target ? [anchor, target] : [target, anchor]
  return visibleIds.slice(from, to + 1)
}

export function humanIssue(issue: IssueType) {
  return issue.replace('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

// Library sorting. Every key falls back to a name comparison so equal values
// (identical byte counts, a filesystem with one-second timestamp resolution)
// still produce a stable, repeatable order rather than shuffling between
// renders.
export type SortKey = 'name' | 'added' | 'modified' | 'size' | 'dimensions' | 'quality' | 'type'
export type SortDirection = 'asc' | 'desc'

export const SORT_OPTIONS: Array<{ id: SortKey; label: string; ascending: string; descending: string; naturalDirection: SortDirection }> = [
  { id: 'name', label: 'Name', ascending: 'A → Z', descending: 'Z → A', naturalDirection: 'asc' },
  { id: 'added', label: 'Date Added', ascending: 'Oldest first', descending: 'Newest first', naturalDirection: 'desc' },
  { id: 'modified', label: 'Date Modified', ascending: 'Oldest first', descending: 'Newest first', naturalDirection: 'desc' },
  { id: 'size', label: 'File Size', ascending: 'Smallest first', descending: 'Largest first', naturalDirection: 'desc' },
  { id: 'dimensions', label: 'Dimensions', ascending: 'Smallest first', descending: 'Largest first', naturalDirection: 'desc' },
  { id: 'quality', label: 'Quality', ascending: 'Lowest first', descending: 'Highest first', naturalDirection: 'desc' },
  { id: 'type', label: 'File Type', ascending: 'A → Z', descending: 'Z → A', naturalDirection: 'asc' },
]

export function sortOption(key: SortKey) {
  return SORT_OPTIONS.find((option) => option.id === key) ?? SORT_OPTIONS[0]
}

export function naturalSortDirection(key: SortKey): SortDirection {
  return sortOption(key).naturalDirection
}

export function sortDirectionLabel(key: SortKey, direction: SortDirection) {
  const option = sortOption(key)
  return direction === 'asc' ? option.ascending : option.descending
}

// Records scanned before timestamps were captured, and files on filesystems
// that report no creation time, carry an epoch value. Treat those as 0 so they
// group together instead of interleaving with real dates.
export function timestampValue(value: string | undefined) {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function compareNames(a: ImageRecord, b: ImageRecord) {
  // Numeric collation keeps "scan 2.jpg" ahead of "scan 10.jpg"; the path
  // tie-breaks identically named files from different subfolders.
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.path.localeCompare(b.path)
}

export function sortImages(images: ImageRecord[], key: SortKey, direction: SortDirection): ImageRecord[] {
  const sign = direction === 'asc' ? 1 : -1
  const rank = (image: ImageRecord) => {
    switch (key) {
      case 'added': return timestampValue(image.addedAt)
      case 'modified': return timestampValue(image.modifiedAt)
      case 'size': return image.bytes
      case 'dimensions': return image.width * image.height
      case 'quality': return image.quality.score
      default: return 0
    }
  }
  return [...images].sort((a, b) => {
    if (key === 'name') return sign * compareNames(a, b)
    if (key === 'type') return sign * (a.extension.localeCompare(b.extension) || 0) || compareNames(a, b)
    return sign * (rank(a) - rank(b)) || compareNames(a, b)
  })
}

export function formatTimestamp(value: string | undefined) {
  const time = timestampValue(value)
  if (!time) return 'Date unknown'
  return new Date(time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

// The card's secondary line shows whatever the collection is sorted by, so the
// ordering on screen is always readable rather than implied.
export function describeSortValue(image: ImageRecord, key: SortKey) {
  switch (key) {
    case 'added': return formatTimestamp(image.addedAt)
    case 'modified': return formatTimestamp(image.modifiedAt)
    case 'size': return formatBytes(image.bytes)
    case 'type': return image.extension.toUpperCase()
    default: return `${image.width} × ${image.height}`
  }
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function stageImageGeometry(viewportWidth: number, viewportHeight: number, imageWidth: number, imageHeight: number, zoom: number, rotation = 0) {
  const safeViewportWidth = Math.max(1, viewportWidth)
  const safeViewportHeight = Math.max(1, viewportHeight)
  const safeImageWidth = Math.max(1, imageWidth)
  const safeImageHeight = Math.max(1, imageHeight)
  const radians = (Math.abs(rotation) * Math.PI) / 180
  const cosine = Math.abs(Math.cos(radians))
  const sine = Math.abs(Math.sin(radians))
  const rotatedImageWidth = (safeImageWidth * cosine) + (safeImageHeight * sine)
  const rotatedImageHeight = (safeImageWidth * sine) + (safeImageHeight * cosine)
  // Keep native overlay scrollbars outside the image itself. macOS draws the
  // horizontal scrollbar over the bottom of an overflow container, so a zoomed
  // canvas with no surrounding space otherwise acquires a real pointer dead zone.
  const interactionGutter = 32
  const fit = Math.min(Math.max(1, safeViewportWidth - interactionGutter) / rotatedImageWidth, Math.max(1, safeViewportHeight - interactionGutter) / rotatedImageHeight)
  // Give the DOM element its real zoomed dimensions. Scaling a smaller box with
  // CSS makes its layout rectangle disagree with the visible image and can clip
  // an entire input strip at the scroll viewport's left or bottom edge.
  const canvasWidth = Math.max(1, safeImageWidth * fit * zoom)
  const canvasHeight = Math.max(1, safeImageHeight * fit * zoom)
  const rotatedWidth = (canvasWidth * cosine) + (canvasHeight * sine)
  const rotatedHeight = (canvasWidth * sine) + (canvasHeight * cosine)
  const spaceWidth = Math.max(safeViewportWidth, rotatedWidth + interactionGutter)
  const spaceHeight = Math.max(safeViewportHeight, rotatedHeight + interactionGutter)
  return {
    canvasWidth,
    canvasHeight,
    spaceWidth,
    spaceHeight,
    left: (spaceWidth - canvasWidth) / 2,
    top: (spaceHeight - canvasHeight) / 2,
  }
}

// The added border, as a share of the image's SHORTER edge — the same
// convention brush size uses, so it keeps its proportion across a revision, a
// crop and an upscale instead of being a pixel count that means something
// different on every image. The shorter edge rather than the width, the mean or
// the diagonal, because a uniform border is bounded by the dimension it can
// most easily overwhelm: on a 3000 x 600 banner a border measured off the mean
// would eat a quarter of the height while looking modest against the width.
// 4% is the default: clearly a frame at a glance, and still a frame rather than
// the subject — 29px on a 736 x 730 label, 98px on a 2776 x 2443 coaster.
// How far the straighten slider travels. It was ±10° while it existed only to
// take the lean off a scan; ±45 was asked for on 2026-09-08 so a piece that was
// photographed properly askew can be brought upright without spending a quarter
// turn first. Past 45 a quarter turn is the shorter way round, and those are
// their own buttons. The processor already accepted anything up to ±180, so
// this is the renderer's limit alone; `detectRotation`'s acceptance gates are
// unchanged, because they were calibrated by measurement against real coasters
// and widening them without measuring again would only invent confident wrong
// answers.
export const ROTATION_LIMIT = 45

export const BORDER_DEFAULT = 0.04
export const BORDER_MIN = 0.005
export const BORDER_MAX = 0.2

export function clampBorder(fraction: number) {
  if (!Number.isFinite(fraction)) return BORDER_DEFAULT
  return Math.min(BORDER_MAX, Math.max(BORDER_MIN, fraction))
}

// Chosen and displayed in pixels, stored as a fraction: the convention the
// brush set. At least one pixel, or the border is a setting that does nothing.
export function borderPixels(fraction: number, imageWidth: number, imageHeight: number) {
  const shorter = Math.max(1, Math.min(imageWidth, imageHeight))
  return Math.max(1, Math.round(clampBorder(fraction) * shorter))
}

export function borderFromPixels(pixels: number, imageWidth: number, imageHeight: number) {
  const shorter = Math.max(1, Math.min(imageWidth, imageHeight))
  return clampBorder(pixels / shorter)
}

// What the border does to the saved size: it is added outside the artwork, so
// nothing is covered and both sides of each axis grow.
export function borderedSize(imageWidth: number, imageHeight: number, fraction: number) {
  const edge = borderPixels(fraction, imageWidth, imageHeight)
  return { width: imageWidth + (edge * 2), height: imageHeight + (edge * 2), edge }
}

// The part of the zoomed image the user can actually see and touch: the canvas
// rectangle clipped to the scroll viewport that shows it. The two are the same
// rectangle at fit-to-window and diverge the moment the image is zoomed, because
// `getBoundingClientRect` reports the canvas's whole layout rectangle while the
// viewport's `overflow: auto` clips what is drawn. Measured on the 736 x 730
// Château Bellevue label in a 1260px dialog: at 1x the canvas ends 36px short of
// the viewport, at 2x it reaches 545px past it and at 4x 1747px past — straight
// across the controls panel, the footer and the toast.
//
// This is the rectangle a pointer start must be judged against. Judging it
// against the unclipped canvas is what made every control in the right-hand
// panel dead above 1x: a document-level capture-phase handler claimed the
// pointerdown, called preventDefault and stopImmediatePropagation, and React
// never saw the click on the colour chip.
export function visibleImageRect(
  canvas: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  viewport: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
) {
  const left = Math.max(canvas.left, viewport.left)
  const right = Math.min(canvas.right, viewport.right)
  const top = Math.max(canvas.top, viewport.top)
  const bottom = Math.min(canvas.bottom, viewport.bottom)
  if (right <= left || bottom <= top) return null
  return { left, right, top, bottom, width: right - left, height: bottom - top }
}

// Whether a pointer start belongs to the image at all. Only a start: once a
// drag or a stroke is under way the pointer may legitimately travel outside the
// visible rectangle, and those moves are normalised against the full canvas so
// they still map to the right image pixel and clamp at the image's own edge.
export function pointerOverVisibleImage(
  clientX: number,
  clientY: number,
  canvas: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'> | null,
  viewport: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'> | null,
) {
  if (!canvas || !viewport) return false
  const visible = visibleImageRect(canvas, viewport)
  if (!visible) return false
  return clientX >= visible.left && clientX <= visible.right && clientY >= visible.top && clientY <= visible.bottom
}

// What the stage viewport is looking at, and how to put it back. The pair is
// how a fill, a paint batch or an Undo keeps the view the user was working at
// instead of throwing them to the middle of the canvas. It is deliberately
// expressed as fractions of the scrollable space rather than as pixel offsets:
// a revision can change the image's dimensions — a crop, a quarter turn, an
// upscale — and the same fraction still shows the same part of the artwork,
// while the same pixel offset would not.
export type StageViewMetrics = {
  scrollLeft: number
  scrollTop: number
  scrollWidth: number
  scrollHeight: number
  clientWidth: number
  clientHeight: number
}

export function stageViewFraction(metrics: StageViewMetrics) {
  const spaceX = metrics.scrollWidth - metrics.clientWidth
  const spaceY = metrics.scrollHeight - metrics.clientHeight
  // An axis with nothing to scroll has no position to remember, so it reads as
  // the middle: zooming out to fit and back in starts from the centre again.
  return {
    x: spaceX > 0 ? Math.min(1, Math.max(0, metrics.scrollLeft / spaceX)) : .5,
    y: spaceY > 0 ? Math.min(1, Math.max(0, metrics.scrollTop / spaceY)) : .5,
  }
}

export function stageViewOffset(metrics: StageViewMetrics, view: { x: number; y: number }) {
  return {
    scrollLeft: Math.max(0, (metrics.scrollWidth - metrics.clientWidth) * view.x),
    scrollTop: Math.max(0, (metrics.scrollHeight - metrics.clientHeight) * view.y),
  }
}

// 1:1 crop lock. Crop insets are percentages of each axis, so a square in
// pixels is NOT a square in percentages: on a 2776 x 2443 image a 50% wide
// frame must be 56.8% tall to come back square. Everything here works in
// pixels and converts back, which is what makes the lock hold on any aspect
// ratio.
export function squareCropInsets(crop: CropInsets, imageWidth: number, imageHeight: number, edges: Array<keyof CropInsets>): CropInsets {
  const width = Math.max(1, imageWidth)
  const height = Math.max(1, imageHeight)
  const pixelWidth = ((100 - crop.left - crop.right) / 100) * width
  const pixelHeight = ((100 - crop.top - crop.bottom) / 100) * height
  const draggedHorizontal = edges.includes('left') || edges.includes('right')
  const draggedVertical = edges.includes('top') || edges.includes('bottom')

  // A corner drag defines both dimensions at once, so the square encloses the
  // pointer rather than snapping inside it. A single edge drives its own axis,
  // and a toggle with no drag (empty edges) squares the frame that is there.
  let side: number
  if (draggedHorizontal && draggedVertical) side = Math.max(pixelWidth, pixelHeight)
  else if (draggedVertical) side = pixelHeight
  else if (draggedHorizontal) side = pixelWidth
  else side = Math.min(pixelWidth, pixelHeight)

  const maximum = Math.min(width, height)
  side = Math.min(maximum, Math.max(Math.min(maximum, 8), side))

  // Keep the edge the drag did not touch pinned, so the frame grows away from
  // the handle being held. With both or neither edge held, hold the centre.
  const place = (lead: number, trail: number, dimension: number, leadHeld: boolean, trailHeld: boolean) => {
    const span = (side / dimension) * 100
    const start = leadHeld && !trailHeld
      ? 100 - trail - span
      : trailHeld && !leadHeld
        ? lead
        : lead + (((100 - lead - trail) - span) / 2)
    const clamped = Math.min(100 - span, Math.max(0, start))
    return { lead: clamped, trail: 100 - span - clamped }
  }

  const horizontal = place(crop.left, crop.right, width, edges.includes('left'), edges.includes('right'))
  const vertical = place(crop.top, crop.bottom, height, edges.includes('top'), edges.includes('bottom'))
  const precise = (value: number) => Math.round(Math.max(0, value) * 1000) / 1000
  return {
    left: precise(horizontal.lead),
    right: precise(horizontal.trail),
    top: precise(vertical.lead),
    bottom: precise(vertical.trail),
  }
}

// The pixel size the current crop will produce, for the readout beside the
// frame — a lock that claims 1:1 should be able to show it. Mirrors the
// processor's arithmetic exactly, including the square equalisation, so the
// readout never promises a size the saved file will not have: each inset rounds
// to pixels on its own, which can otherwise leave 1507 x 1508 on screen.
export function cropPixelSize(crop: CropInsets, imageWidth: number, imageHeight: number, square = false) {
  const left = Math.round((crop.left / 100) * imageWidth)
  const right = Math.round((crop.right / 100) * imageWidth)
  const top = Math.round((crop.top / 100) * imageHeight)
  const bottom = Math.round((crop.bottom / 100) * imageHeight)
  const width = Math.max(1, imageWidth - left - right)
  const height = Math.max(1, imageHeight - top - bottom)
  if (!square) return { width, height }
  const side = Math.max(1, Math.min(width, height))
  return { width: side, height: side }
}

export function normalizedPointInRect(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>,
  clampOutside = false,
) {
  if (bounds.width <= 0 || bounds.height <= 0) return null
  if (!clampOutside && (clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom)) return null
  return {
    x: Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width)),
    y: Math.min(1, Math.max(0, (clientY - bounds.top) / bounds.height)),
  }
}

export function appendRevision<T>(revisions: T[], index: number, revision: T) {
  const next = [...revisions.slice(0, index + 1), revision]
  return { revisions: next, index: next.length - 1 }
}

// The bands, the recommendation and the acceptance rule are one definition in
// `shared/quality.ts`, shared with the process that computes the score. They
// are re-exported here because this is where the renderer looks for them.
export { canAcceptQuality, QUALITY_BANDS, QUALITY_RECOMMENDED_SCORE, qualityLabel, type QualityLabel } from '../shared/quality'

// Accepts what people actually paste or type into a colour field: with or
// without the leading hash, upper or lower case, 3-digit shorthand or 6-digit.
// Returns the canonical 6-digit lowercase form the colour input requires, or
// null while the text is not yet a complete colour.
export function normalizeHexColor(value: string) {
  const trimmed = value.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(trimmed)) return null
  const expanded = trimmed.length === 3 ? trimmed.split('').map((character) => character + character).join('') : trimmed
  return `#${expanded.toLowerCase()}`
}

// Quarter turns are a separate orientation control that composes with the
// ±10° straightening slider. The combined angle is normalised into the
// (-180, 180] range the processor accepts, so three right turns are sent as
// -90° rather than being clamped away at 180°.
// Currently unused: quarter turns apply the moment they are clicked rather
// than composing with the pending straighten slider, so there is no longer a
// pair to normalise. Kept, with its tests, because the live-preview work may
// reinstate a pending turn and this repository has no version history to
// recover it from.
export function composeStageRotation(quarterTurns: number, fineDegrees: number) {
  const wrapped = (((quarterTurns * 90 + fineDegrees) % 360) + 360) % 360
  const signed = wrapped > 180 ? wrapped - 360 : wrapped
  return Math.round(signed * 10) / 10
}

export type UndoRedoIntent = 'undo' | 'redo' | null

// Maps a keystroke to a history action. Kept pure so the rules stay testable:
// the important one is that a shortcut never fires while the caret is in a text
// field, where the same keys must keep doing the browser's own text undo.
export function undoRedoIntent(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  editingText: boolean,
): UndoRedoIntent {
  if (editingText) return null
  if (!event.metaKey && !event.ctrlKey) return null
  const key = event.key.toLowerCase()
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
  // Windows and Linux users reach for Ctrl+Y; harmless to honour on any platform.
  if (key === 'y' && !event.shiftKey) return 'redo'
  return null
}

// Text-entry targets keep their own native undo stack.
export function isTextEntryElement(element: { tagName?: string; isContentEditable?: boolean } | null) {
  if (!element) return false
  if (element.isContentEditable) return true
  const tag = (element.tagName ?? '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

// Brush size is stored as a fraction of the image's shorter edge so it survives
// a change of revision and a resize, but it is chosen in source pixels — the
// only unit that means anything when the job is to touch out a single speck. A
// linear pixel track would spend almost all of its travel on sizes nobody uses,
// so the slider is logarithmic: every step is the same proportional change,
// from one pixel up to a broad brush.
export const BRUSH_MIN_PIXELS = 1
export const BRUSH_SLIDER_STEPS = 1000
const BRUSH_MAX_SHORTEST_EDGE_FRACTION = 0.16

const shortestEdge = (imageWidth: number, imageHeight: number) => Math.max(1, Math.min(imageWidth, imageHeight))

export function brushMaxPixels(imageWidth: number, imageHeight: number) {
  return Math.max(BRUSH_MIN_PIXELS + 1, Math.round(shortestEdge(imageWidth, imageHeight) * BRUSH_MAX_SHORTEST_EDGE_FRACTION))
}

export function brushPixelsFromSize(size: number, imageWidth: number, imageHeight: number) {
  const pixels = Math.round(size * shortestEdge(imageWidth, imageHeight))
  return Math.min(brushMaxPixels(imageWidth, imageHeight), Math.max(BRUSH_MIN_PIXELS, Number.isFinite(pixels) ? pixels : BRUSH_MIN_PIXELS))
}

export function brushSizeFromPixels(pixels: number, imageWidth: number, imageHeight: number) {
  const clamped = Math.min(brushMaxPixels(imageWidth, imageHeight), Math.max(BRUSH_MIN_PIXELS, Math.round(pixels)))
  return clamped / shortestEdge(imageWidth, imageHeight)
}

export function brushSliderPosition(size: number, imageWidth: number, imageHeight: number) {
  const pixels = brushPixelsFromSize(size, imageWidth, imageHeight)
  const maximum = brushMaxPixels(imageWidth, imageHeight)
  return Math.round((Math.log(pixels / BRUSH_MIN_PIXELS) / Math.log(maximum / BRUSH_MIN_PIXELS)) * BRUSH_SLIDER_STEPS)
}

export function brushPixelsFromSlider(position: number, imageWidth: number, imageHeight: number) {
  const maximum = brushMaxPixels(imageWidth, imageHeight)
  const travel = Math.min(1, Math.max(0, position / BRUSH_SLIDER_STEPS))
  const pixels = Math.round(BRUSH_MIN_PIXELS * Math.pow(maximum / BRUSH_MIN_PIXELS, travel))
  return Math.min(maximum, Math.max(BRUSH_MIN_PIXELS, Number.isFinite(pixels) ? pixels : BRUSH_MIN_PIXELS))
}

