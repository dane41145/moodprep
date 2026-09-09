// The image models the workbench can send a reconstruction to.
//
// Flash Lite is the default because it is the cheapest thing that does this job
// well: roughly a third of the price of Flash at 1K, and these are small flat
// graphics rather than photographs. The dearer Gemini tiers are here for the
// cases Flash Lite cannot hold, and Qwen is here because it renders lettering
// more faithfully than anything else at this price — which matters when the
// library is German blackletter, French, Thai and Bengali, and every prompt
// demands the original wording back untouched.

import type { ImageSize } from './types'

export type AiProvider = 'gemini' | 'qwen'

export type AiModel = {
  id: string
  provider: AiProvider
  label: string
  note: string
  // The output sizes this model will actually serve, and not a cosmetic list.
  // Measured against the live API on 2026-09-06: Flash Lite returns 1K and
  // answers a 2K or 4K request with HTTP 404 `Requested entity was not found`,
  // which reads like a retired model id rather than an unsupported size and
  // sent the user hunting for a bad prompt. Flash and Pro serve all three.
  sizes: ImageSize[]
}

export const AI_MODELS: AiModel[] = [
  { id: 'gemini-3.1-flash-lite-image', provider: 'gemini', label: 'Flash Lite', note: 'Cheapest and fastest, and 1K only. The default; try it before anything dearer.', sizes: ['1K'] },
  { id: 'gemini-3.1-flash-image', provider: 'gemini', label: 'Flash', note: 'Google’s mid tier — roughly three times Flash Lite. Serves every size.', sizes: ['1K', '2K', '4K'] },
  { id: 'gemini-3-pro-image', provider: 'gemini', label: 'Pro', note: 'Highest fidelity and the dearest. Worth it for difficult reconstructions.', sizes: ['1K', '2K', '4K'] },
  { id: 'qwen-image-3.0', provider: 'qwen', label: 'Qwen Image 3', note: 'Alibaba. The strongest of these at keeping printed lettering exact.', sizes: ['1K', '2K'] },
  { id: 'qwen-image-3.0-pro', provider: 'qwen', label: 'Qwen Image 3 Pro', note: 'Alibaba\u2019s higher-fidelity tier, for reconstructions the standard model cannot hold.', sizes: ['1K', '2K'] },
]

export const DEFAULT_AI_MODEL = 'gemini-3.1-flash-lite-image'

// Writing a prompt is a reading job, not a drawing one, so it goes to the text
// sibling of the cheapest image model rather than to whichever model the user
// has selected for the reconstruction. It is deliberately fixed: the choice
// beside the prompt box is about what will redraw the artwork, and making the
// author of the prompt another decision would only add a second thing to get
// wrong. It shares the Gemini key, so it needs no setting of its own. If Google
// retires this id the failure is a plain 'model not found' naming it, and this
// constant is the only place to change.
export const PROMPT_AUTHOR_MODEL = 'gemini-3.1-flash-lite'

export function modelById(id: string): AiModel {
  return AI_MODELS.find((model) => model.id === id) ?? AI_MODELS.find((model) => model.id === DEFAULT_AI_MODEL)!
}

export const IMAGE_SIZES: ImageSize[] = ['1K', '2K', '4K']

export function modelServesSize(model: AiModel, size: ImageSize) {
  return model.sizes.includes(size)
}

// The models that can actually return this size, cheapest first — AI_MODELS is
// in price order, so the first entry is the one to reach for. This is what the
// model menu is built from rather than the whole registry: a model that cannot
// serve the size the preset needs is not a choice, it is a 404 waiting to
// happen, and offering it is what made the failure look like a prompt problem.
export function modelsForSize(size: ImageSize, provider?: AiProvider) {
  return AI_MODELS.filter((model) => modelServesSize(model, size) && (!provider || model.provider === provider))
}

// The model to fall back to when the chosen one cannot serve the wanted size.
// Keeps the user's provider where that provider has something suitable, so
// raising the size does not silently move them from Qwen to Gemini.
export function modelForSize(preferredId: string, size: ImageSize) {
  const preferred = modelById(preferredId)
  if (modelServesSize(preferred, size)) return preferred.id
  return (modelsForSize(size, preferred.provider)[0] ?? modelsForSize(size)[0] ?? modelById(DEFAULT_AI_MODEL)).id
}

export const PROVIDER_LABELS: Record<AiProvider, string> = { gemini: 'Gemini', qwen: 'Qwen' }

// What colour the artwork is cut out onto. `None` is the default and is not a
// colour at all: it names no backdrop in the prompt, so nothing in the request
// asks for the background to change. The named colours are the ones a design is
// actually judged against — black shows a silhouette most clearly, the tee greys
// and white are what it will be worn on. `hex` being null means there is nothing
// for the deterministic isolation pass to enforce; `phrase` being null means the
// prompt says nothing about a surround.
export type AiBackdrop = { id: string; label: string; hex: string | null; phrase: string | null; swatch: string | null }

export const AI_BACKDROPS: AiBackdrop[] = [
  { id: 'none', label: 'None', hex: null, phrase: null, swatch: null },
  { id: 'black', label: 'Black', hex: '#000000', phrase: 'pure black, #000000', swatch: '#000000' },
  { id: 'white', label: 'White', hex: '#ffffff', phrase: 'pure white, #ffffff', swatch: '#ffffff' },
  // The tee greys, lightest first. Ash and athletic heather are the two pale
  // blanks most designs are actually printed on, and a design judged only
  // against white, sport grey and charcoal has never been seen on either.
  { id: 'ash', label: 'Ash', hex: '#dfe0e2', phrase: 'a flat very light grey, #dfe0e2', swatch: '#dfe0e2' },
  { id: 'athletic', label: 'Athletic heather', hex: '#bfc1c3', phrase: 'a flat light grey, #bfc1c3', swatch: '#bfc1c3' },
  { id: 'sport', label: 'Sport grey', hex: '#97999b', phrase: 'a flat mid grey, #97999b', swatch: '#97999b' },
  { id: 'heather', label: 'Dark heather', hex: '#3f4448', phrase: 'a flat dark charcoal, #3f4448', swatch: '#3f4448' },
  { id: 'auto', label: 'Auto', hex: null, phrase: 'one flat, uniform colour of your own choosing that suits this artwork and makes it sit up — do not default to white', swatch: 'auto' },
]

export const DEFAULT_AI_BACKDROP = 'none'

export function backdropById(id: string): AiBackdrop {
  return AI_BACKDROPS.find((backdrop) => backdrop.id === id) ?? AI_BACKDROPS[0]
}

// A workspace-scoped DashScope key (one beginning `sk-ws-`) is only accepted by
// its own workspace host; the shared regional host rejects it. The workspace is
// therefore part of the address, not of the credential, and the user pastes it
// as `ws-xxxxxxxx` or as a whole hostname or URL. Only the first label matters.
export function normaliseQwenWorkspace(value: string) {
  const trimmed = value.trim().replace(/^https?:\/\//, '')
  return trimmed.split(/[/.]/)[0].trim()
}

// Model Studio runs as two separate services, and a key belongs to exactly one
// of them: a key made in the Beijing console is rejected by Singapore and the
// other way round. There is no way to tell which a key is from by looking at
// it, so the region is a setting rather than something to detect, and its only
// symptom when wrong is a 401 that reads like a bad key.
export type QwenRegion = 'intl' | 'beijing'

export const QWEN_REGIONS: Array<{ id: QwenRegion; label: string; detail: string }> = [
  { id: 'intl', label: 'International', detail: 'Singapore · dashscope-intl.aliyuncs.com' },
  { id: 'beijing', label: 'China', detail: 'Beijing · dashscope.aliyuncs.com' },
]

export const DEFAULT_QWEN_REGION: QwenRegion = 'intl'

const QWEN_HOSTS: Record<QwenRegion, { shared: string; workspace: string }> = {
  intl: { shared: 'dashscope-intl.aliyuncs.com', workspace: 'ap-southeast-1.maas.aliyuncs.com' },
  beijing: { shared: 'dashscope.aliyuncs.com', workspace: 'cn-beijing.maas.aliyuncs.com' },
}

export function qwenEndpoint(workspace: string, region: QwenRegion = DEFAULT_QWEN_REGION) {
  const id = normaliseQwenWorkspace(workspace)
  const hosts = QWEN_HOSTS[region] ?? QWEN_HOSTS[DEFAULT_QWEN_REGION]
  const host = id
    ? `${id}.${hosts.workspace}`
    // Keys issued before the workspace upgrade still use the shared host.
    : hosts.shared
  return `https://${host}/api/v1/services/aigc/multimodal-generation/generation`
}

export function qwenRegionLabel(region: QwenRegion) {
  return (QWEN_REGIONS.find((entry) => entry.id === region) ?? QWEN_REGIONS[0]).label
}

// A key beginning `sk-ws-` cannot reach the shared host at all, so the missing
// workspace is worth naming before the request rather than after a 401.
export const needsQwenWorkspace = (apiKey: string, workspace: string) => apiKey.startsWith('sk-ws-') && !normaliseQwenWorkspace(workspace)
