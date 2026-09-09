import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Electron resolves -webkit-app-region rectangles natively from geometry alone,
// so a dialog stacked above the top bar does NOT occlude its drag region: a
// mousedown there starts a window drag and never reaches the page.
// This silently disabled crop handles and Paint with background over the lower
// left of the workbench preview. Every full-window overlay must therefore
// declare -webkit-app-region: no-drag to subtract the drag regions beneath it.

const styles = readFileSync(path.join(__dirname, 'styles.css'), 'utf8')

function declarationBlock(selector: string) {
  const start = styles.indexOf(`${selector} {`)
  expect(start, `styles.css must contain a rule for "${selector}"`).toBeGreaterThanOrEqual(0)
  return styles.slice(start, styles.indexOf('}', start))
}

describe('native window-drag regions never block overlay input', () => {
  it('declares drag regions only where expected', () => {
    // Selector text is read from a comment-stripped copy: the pattern that
    // finds it spans newlines, so a comment written above a drag rule would
    // otherwise be swallowed into the selector and fail this for no reason.
    const withoutComments = styles.replace(/\/\*[\s\S]*?\*\//g, '')
    const dragSelectors = [...withoutComments.matchAll(/^([^{@]+)\{[^}]*-webkit-app-region:\s*drag/gm)].map((match) => match[1].trim())
    expect(dragSelectors.sort()).toEqual(['.topbar', '.welcome-header'])
  })

  it('subtracts every drag region under each full-window overlay', () => {
    for (const overlay of ['.modal-backdrop', '.busy-overlay']) {
      const block = declarationBlock(overlay)
      expect(block, `${overlay} must cover the whole window so its no-drag region masks the top bar`).toContain('position: fixed')
      expect(block, `${overlay} must cover the whole window so its no-drag region masks the top bar`).toContain('inset: 0')
      expect(block, `${overlay} must declare -webkit-app-region: no-drag or clicks over it start a window drag`).toContain('-webkit-app-region: no-drag')
    }
  })
})
