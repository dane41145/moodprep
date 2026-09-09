// What a quality score is allowed to look like.
//
// The bands used to be High at 81, Medium at 55 and Low below that, each with
// its own colour: green, orange, red. Measured over this collection of 1352
// images that painted 62% of the library orange and 10% red — the median image
// scores 73, so the typical card carried a warning colour. A warning that fires
// on the ordinary case is not a warning, it is a background, and the genuinely
// poor images were indistinguishable from the merely average ones.
//
// So the middle is neutral now, and colour marks the exceptions. The edges are
// not round numbers picked by eye either: `Good` begins exactly where the
// workbench's own recommendation begins, so amber and red mean "below the line
// this app itself uses to decide whether a result may replace the original"
// rather than "below average". Over the same 1352 images this is 16% green,
// 46% neutral, 27% amber and 10% red.

export const QUALITY_RECOMMENDED_SCORE = 70

export type QualityLabel = 'Excellent' | 'Good' | 'Fair' | 'Poor'

// Ordered strongest first; the first band a score reaches is its band.
export const QUALITY_BANDS: Array<{ label: QualityLabel; from: number }> = [
  { label: 'Excellent', from: 85 },
  // Not a coincidence and not to be drifted apart: the neutral band starts at
  // the recommendation, so the colour on a card and the gate in the workbench
  // are telling the user the same thing.
  { label: 'Good', from: QUALITY_RECOMMENDED_SCORE },
  { label: 'Fair', from: 55 },
  { label: 'Poor', from: 0 },
]

export function qualityLabel(score: number): QualityLabel {
  return (QUALITY_BANDS.find((band) => score >= band.from) ?? QUALITY_BANDS[QUALITY_BANDS.length - 1]).label
}

export function canAcceptQuality(score: number) {
  return score >= QUALITY_RECOMMENDED_SCORE
}
