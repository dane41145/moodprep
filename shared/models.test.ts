import { describe, expect, it } from 'vitest'
import { AI_BACKDROPS, AI_MODELS, modelById, modelForSize, modelsForSize, needsQwenWorkspace, normaliseQwenWorkspace, qwenEndpoint } from './models'

// A key issued since Alibaba's workspace upgrade begins `sk-ws-` and is only
// accepted by its own workspace host. Sending it to the shared regional host
// returns a 401 that looks like a bad key, so the address has to be built from
// the workspace and the missing workspace named before the request goes out.
describe('addressing a Qwen workspace', () => {
  it('accepts the id however it was copied', () => {
    expect(normaliseQwenWorkspace('ws-abc123')).toBe('ws-abc123')
    expect(normaliseQwenWorkspace('  ws-abc123  ')).toBe('ws-abc123')
    expect(normaliseQwenWorkspace('ws-abc123.ap-southeast-1.maas.aliyuncs.com')).toBe('ws-abc123')
    expect(normaliseQwenWorkspace('https://ws-abc123.ap-southeast-1.maas.aliyuncs.com/api/v1')).toBe('ws-abc123')
  })

  it('addresses the workspace host when there is one', () => {
    expect(qwenEndpoint('ws-abc123')).toBe('https://ws-abc123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
  })

  // The two Model Studio consoles are separate services and a key belongs to
  // one of them, so the region has to be part of the address. Beijing is the
  // domestic service, reached directly from the mainland.
  it('addresses the region the key was made in', () => {
    expect(qwenEndpoint('', 'beijing')).toContain('https://dashscope.aliyuncs.com/')
    expect(qwenEndpoint('', 'beijing')).not.toContain('dashscope-intl')
    expect(qwenEndpoint('ws-abc123', 'beijing')).toBe('https://ws-abc123.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation')
    expect(qwenEndpoint('ws-abc123', 'intl')).toContain('ap-southeast-1')
  })

  // An older install has no region file at all, and a hand-edited one could say
  // anything; neither may be pasted into a host name.
  it('falls back to the international host for an unknown region', () => {
    expect(qwenEndpoint('', undefined)).toContain('dashscope-intl.aliyuncs.com')
    expect(qwenEndpoint('', 'shanghai' as never)).toContain('dashscope-intl.aliyuncs.com')
    expect(qwenEndpoint('ws-abc123', 'shanghai' as never)).toContain('ap-southeast-1')
  })

  // Keys issued before the upgrade still work against the shared host.
  it('falls back to the shared host when there is none', () => {
    expect(qwenEndpoint('')).toContain('dashscope-intl.aliyuncs.com')
    expect(qwenEndpoint('   ')).toContain('dashscope-intl.aliyuncs.com')
  })

  it('knows which keys cannot reach the shared host', () => {
    expect(needsQwenWorkspace('sk-ws-abc', '')).toBe(true)
    expect(needsQwenWorkspace('sk-ws-abc', 'ws-abc123')).toBe(false)
    expect(needsQwenWorkspace('sk-oldstyle', '')).toBe(false)
  })
})

describe('the model registry', () => {
  it('offers the current Qwen image models', () => {
    const qwen = AI_MODELS.filter((model) => model.provider === 'qwen').map((model) => model.id)
    expect(qwen).toEqual(['qwen-image-3.0', 'qwen-image-3.0-pro'])
  })

  it('falls back to the default rather than sending an unknown id to an API', () => {
    expect(modelById('qwen-image-edit-plus').id).toBe('gemini-3.1-flash-lite-image')
  })
})


// A design is judged against the garment it will be printed on, and the greys a
// blank tee is stocked in run from very light to charcoal. Before 2026-09-06
// only the darker pair was here, so a design was never seen on the pale blanks
// most shirts actually are.
describe('the tee greys offered as a backdrop', () => {
  const luminance = (hex: string) => {
    const value = hex.replace('#', '')
    const [red, green, blue] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16))
    return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
  }
  const greys = ['ash', 'athletic', 'sport', 'heather']

  it('offers four, and both new ones are lighter than every grey that was here before', () => {
    const byId = Object.fromEntries(AI_BACKDROPS.map((backdrop) => [backdrop.id, backdrop]))
    for (const id of greys) expect(byId[id], id).toBeDefined()
    for (const id of ['ash', 'athletic']) {
      expect(luminance(byId[id].hex!), id).toBeGreaterThan(luminance(byId.sport.hex!))
      expect(luminance(byId[id].hex!), id).toBeGreaterThan(luminance(byId.heather.hex!))
    }
  })

  it('runs lightest to darkest, and stays between white and black', () => {
    const order = AI_BACKDROPS.filter((backdrop) => greys.includes(backdrop.id)).map((backdrop) => luminance(backdrop.hex!))
    expect(order).toEqual([...order].sort((left, right) => right - left))
    expect(order[0]).toBeLessThan(255)
    expect(order[order.length - 1]).toBeGreaterThan(0)
  })
})

// Measured against the live Gemini API on 2026-09-06, with the same prompt and
// the same image at each size. Flash Lite returned 1K and answered both 2K and
// 4K with HTTP 404 `Requested entity was not found` — an error that reads like
// a retired model id, which is why the user went looking for a prompt that was
// too long. The Complete edges prompt at 1K on Flash Lite succeeded and the
// identical prompt at 2K on Flash Lite 404'd, so it is the size and not the
// prompt. Flash and Pro served 1K, 2K and 4K.
describe('which model can serve which output size', () => {
  it('records Flash Lite as 1K only', () => {
    expect(modelById('gemini-3.1-flash-lite-image').sizes).toEqual(['1K'])
  })

  it('leaves the dearer Gemini tiers on every size', () => {
    expect(modelById('gemini-3.1-flash-image').sizes).toEqual(['1K', '2K', '4K'])
    expect(modelById('gemini-3-pro-image').sizes).toEqual(['1K', '2K', '4K'])
  })

  it('offers Flash Lite at 1K and drops it above that', () => {
    expect(modelsForSize('1K', 'gemini').map((model) => model.id)).toContain('gemini-3.1-flash-lite-image')
    expect(modelsForSize('2K', 'gemini').map((model) => model.id)).not.toContain('gemini-3.1-flash-lite-image')
    expect(modelsForSize('4K', 'gemini').map((model) => model.id)).not.toContain('gemini-3.1-flash-lite-image')
  })

  it('lists the models that can serve a size cheapest first', () => {
    // AI_MODELS is in price order, so the first entry is what to reach for.
    expect(modelsForSize('2K', 'gemini')[0].id).toBe('gemini-3.1-flash-image')
    expect(modelsForSize('1K', 'gemini')[0].id).toBe('gemini-3.1-flash-lite-image')
  })

  it('moves off a model that cannot serve the size, and stays put when it can', () => {
    expect(modelForSize('gemini-3.1-flash-lite-image', '1K')).toBe('gemini-3.1-flash-lite-image')
    expect(modelForSize('gemini-3.1-flash-lite-image', '2K')).toBe('gemini-3.1-flash-image')
    expect(modelForSize('gemini-3-pro-image', '4K')).toBe('gemini-3-pro-image')
  })

  it('keeps the user on their own provider where that provider can serve the size', () => {
    // Raising the size must not silently move a Qwen user onto Gemini.
    expect(modelForSize('qwen-image-3.0', '2K')).toBe('qwen-image-3.0')
    // Qwen serves no 4K at all, so there it has to cross over rather than fail.
    expect(modelById(modelForSize('qwen-image-3.0', '4K')).provider).toBe('gemini')
  })

  it('never offers a size the default model cannot serve', () => {
    for (const model of AI_MODELS) {
      expect(model.sizes.length, model.id).toBeGreaterThan(0)
      expect(model.sizes, model.id).toContain('1K')
    }
  })
})
