import { describe, expect, it } from 'vitest'
import { canAcceptQuality, QUALITY_BANDS, QUALITY_RECOMMENDED_SCORE, qualityLabel } from './quality'

// Measured over the user's 1352 images: median 73, p25 64, p75 82. Under the
// old bands (High 81, Medium 55) that put 62% of the library in orange and 10%
// in red, so the typical card carried a warning colour and the genuinely poor
// images did not stand out from the ordinary ones.
describe('quality bands', () => {
  it('puts the ordinary score in the neutral band rather than a warning one', () => {
    for (const score of [70, 73, 76, 80, 84]) expect(qualityLabel(score), String(score)).toBe('Good')
  })

  // The whole point of where the neutral band starts: amber and red mean
  // "below the line this app itself uses to decide whether a result may replace
  // the original", not "below average".
  it('starts the neutral band exactly at the workbench recommendation', () => {
    const good = QUALITY_BANDS.find((band) => band.label === 'Good')!
    expect(good.from).toBe(QUALITY_RECOMMENDED_SCORE)
    expect(canAcceptQuality(good.from)).toBe(true)
    expect(canAcceptQuality(good.from - 1)).toBe(false)
    expect(qualityLabel(good.from - 1)).toBe('Fair')
  })

  it('reserves the colours for the ends', () => {
    expect(qualityLabel(85)).toBe('Excellent')
    expect(qualityLabel(99)).toBe('Excellent')
    expect(qualityLabel(69)).toBe('Fair')
    expect(qualityLabel(55)).toBe('Fair')
    expect(qualityLabel(54)).toBe('Poor')
    expect(qualityLabel(0)).toBe('Poor')
  })

  it('bands every possible score exactly once, strongest first', () => {
    for (let score = 0; score <= 100; score += 1) expect(qualityLabel(score)).toBeDefined()
    const edges = QUALITY_BANDS.map((band) => band.from)
    expect(edges).toEqual([...edges].sort((left, right) => right - left))
    expect(edges[edges.length - 1]).toBe(0)
  })
})
