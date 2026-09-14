import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { translate } from './i18n'
import { zh } from './locales/zh'
import { GEMINI_PRESETS, SORT_OPTIONS, humanIssue, buildGeminiPresetPrompt, buildPromptAuthorInstruction, backdropPhrase, cleanAuthoredPrompt, translateQualityReason } from './utils'
import { AI_BACKDROPS, AI_MODELS, QWEN_REGIONS } from '../shared/models'
import { ISSUE_TYPES } from '../shared/types'
import { QUALITY_BANDS } from '../shared/quality'

// Every key the renderer asks for must be in the Chinese dictionary. The keys
// are the English strings themselves, so a new string in the renderer has to
// be added here too, or a Chinese user sees English for it.
function rendererKeys() {
  const source = readFileSync(path.join(__dirname, 'App.tsx'), 'utf8')
  const keys = new Set<string>()
  for (const match of source.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(match[1].replace(/\\'/g, "'").replace(/\\n/g, '\n'))
  for (const match of source.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(match[1])
  // Ternary keys: t(cond ? 'a' : 'b', …)
  for (const match of source.matchAll(/\bt\([^)'"]*\?\s*'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'/g)) { keys.add(match[1]); keys.add(match[2]) }
  for (const match of source.matchAll(/\?\s*'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'\s*,\s*\{/g)) { keys.add(match[1]); keys.add(match[2]) }
  return keys
}

describe('the Chinese dictionary', () => {
  it('covers every string the renderer translates', () => {
    const missing = [...rendererKeys()].filter((key) => !(key in zh))
    expect(missing, `missing Chinese for:\n${missing.join('\n')}`).toEqual([])
  })

  it('covers the labels that come from data rather than JSX', () => {
    const fromData = [
      ...ISSUE_TYPES.map(humanIssue),
      ...QUALITY_BANDS.map((band) => band.label),
      ...SORT_OPTIONS.flatMap((option) => [option.label, option.ascending, option.descending]),
      ...GEMINI_PRESETS.flatMap((preset) => [preset.label, preset.description]),
      ...AI_MODELS.flatMap((model) => [model.label, model.note]),
      ...AI_BACKDROPS.map((backdrop) => backdrop.label),
      ...QWEN_REGIONS.flatMap((region) => [region.label, region.detail]),
      'Crop', 'Paint', 'Pick', 'Fill', 'Replace', 'All images', 'Needs work', 'Processed', 'Untouched',
      'Pure white', 'Pure black', 'Ash', 'Athletic heather', 'Sport grey', 'Dark heather', 'Key magenta', 'Key green', 'From this image',
      'Date unknown', 'Very small data size for its dimensions', 'Soft, spread, or ghosted edges', 'Colour bleed or uneven flat areas',
      'Use 2× or 4× Resize, then inspect edges at 100%.', 'Try PNG or lossless WebP to avoid adding more compression.',
      'Reconstruct with Gemini when local resizing cannot restore the line work.', 'Try Flatten colour noise before using reconstruction.',
      'No automated quality concerns detected; confirm the artwork visually.', 'English', 'Chinese (Simplified)',
    ]
    const missing = fromData.filter((key) => !(key in zh))
    expect(missing).toEqual([])
  })

  it('keeps every placeholder the English key carries', () => {
    const broken = Object.entries(zh).filter(([key, value]) => {
      const wanted = [...key.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
      const got = [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
      return wanted.join(',') !== got.join(',')
    }).map(([key]) => key)
    expect(broken).toEqual([])
  })
})

describe('translate', () => {
  it('fills placeholders and falls back to English for an unknown key', () => {
    expect(translate('zh', 'Indexed {n} images.', { n: 12 })).toBe('已索引 12 张图像。')
    expect(translate('en', 'Indexed {n} images.', { n: 12 })).toBe('Indexed 12 images.')
    expect(translate('zh', 'Not a key', { n: 1 })).toBe('Not a key')
  })
  it('translates the processor’s quality reasons by shape', () => {
    const t = (key: string, vars?: Record<string, string | number>) => translate('zh', key, vars)
    expect(translateQualityReason('Short edge is only 300 px', t)).toBe('短边只有 300 px')
    expect(translateQualityReason('2.1 MP with crisp edges and clean colour', t)).toContain('2.1')
    expect(translateQualityReason('Something new', t)).toBe('Something new')
  })
})

describe('Chinese prompts', () => {
  it('exist for every preset and carry the load-bearing sentences', () => {
    for (const preset of GEMINI_PRESETS) {
      const prompt = buildGeminiPresetPrompt(preset.id, ['border'], backdropPhrase('black', 'zh'), 'zh')
      if (preset.id === 'custom') { expect(prompt).toBe(''); continue }
      expect(prompt.length, preset.id).toBeGreaterThan(40)
      expect(prompt.replace(/MoodPrep/g, ''), preset.id).not.toMatch(/[a-z]{6,}/i)
    }
    const concentric = buildGeminiPresetPrompt('concentric', [], null, 'zh')
    expect(concentric).toContain('刚性的整体')
    expect(concentric).toContain('六个测量值必须全部相等')
    expect(concentric).toContain('一律以同心为准')
    expect(concentric).toContain('只移动，别的什么都不做')
    const coaster = buildGeminiPresetPrompt('coaster', [], backdropPhrase('black', 'zh'), 'zh')
    expect(coaster).toContain('同心与圆环位置')
    expect(coaster).toContain('纯黑色（#000000）')
    expect(coaster).toContain('只返回完成后的正方形图像')
    // None drops the surround paragraph in Chinese too.
    expect(buildGeminiPresetPrompt('standard', [], backdropPhrase('none', 'zh'), 'zh')).not.toContain('外围：')
    expect(buildGeminiPresetPrompt('standard', [], backdropPhrase('white', 'zh'), 'zh')).toContain('外围：')
  })
  it('asks the prompt author for Chinese and strips a Chinese preamble', () => {
    const instruction = buildPromptAuthorInstruction(['texture'], null, 'zh')
    expect(instruction).toContain('纹理')
    expect(instruction).toContain('中文')
    expect(instruction).toMatch(/只返回完成后的图像，保持相同的宽高比。$/)
    expect(cleanAuthoredPrompt('以下是提示词：\n去除污渍。只返回完成后的图像，保持相同的宽高比。')).toBe('去除污渍。只返回完成后的图像，保持相同的宽高比。')
    expect(cleanAuthoredPrompt('「去除污渍。」')).toBe('去除污渍。')
  })
})
