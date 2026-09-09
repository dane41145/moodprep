import { app, BrowserWindow, clipboard, dialog, ipcMain, net, safeStorage, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AuthoredPromptRequest, DuplicateDeletionGroup, ExportEntry, FillRequest, GeminiRequest, ProcessRequest, ProjectState } from '../shared/types'
import { analyzeImageQuality, authorPrompt, commitProcessedImage, revertCommittedImage, convertSvgs, detectBackgroundColor, detectDominantColors, detectPalette, detectRotation, duplicateImage, fillArea, exportSelection, aiEdit, loadEditorPreview, loadProject, processImage, prunePreviews, refreshImage, samplePixelColor, saveProject, scanFolder, testConnection } from './processor'
import { AI_MODELS, DEFAULT_QWEN_REGION, modelById, normaliseQwenWorkspace, QWEN_REGIONS, type AiProvider, type QwenRegion } from '../shared/models'

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(currentDirectory, '..')
const rendererDirectory = path.join(appRoot, 'dist')
// One encrypted file per provider. The Gemini filename is unchanged so an
// existing installation keeps the key it already has.
const KEY_FILES: Record<AiProvider, string> = { gemini: 'gemini-key.bin', qwen: 'qwen-key.bin' }
const KEY_ENVIRONMENT: Record<AiProvider, string> = { gemini: 'GEMINI_API_KEY', qwen: 'DASHSCOPE_API_KEY' }

// The Qwen workspace is part of the address, not a credential, so it is stored
// in plain text beside the encrypted keys rather than inside one.
function workspacePath() {
  return path.join(app.getPath('userData'), 'qwen-workspace.txt')
}

async function readWorkspace() {
  if (process.env.DASHSCOPE_WORKSPACE) return process.env.DASHSCOPE_WORKSPACE
  try { return (await fs.readFile(workspacePath(), 'utf8')).trim() } catch { return '' }
}

// Which Model Studio a key belongs to is part of the address too, and it is
// stored the same plain-text way. A value that is not one of the two regions —
// an older install, or a hand-edited file — falls back to the default rather
// than being sent as a host name.
function regionPath() {
  return path.join(app.getPath('userData'), 'qwen-region.txt')
}

async function readRegion(): Promise<QwenRegion> {
  const stored = process.env.DASHSCOPE_REGION ?? await fs.readFile(regionPath(), 'utf8').then((value) => value.trim()).catch(() => '')
  return QWEN_REGIONS.some((region) => region.id === stored) ? stored as QwenRegion : DEFAULT_QWEN_REGION
}

function keyPath(provider: AiProvider) {
  return path.join(app.getPath('userData'), KEY_FILES[provider])
}

async function readApiKey(provider: AiProvider) {
  const fromEnvironment = process.env[KEY_ENVIRONMENT[provider]]
  if (fromEnvironment) return fromEnvironment
  try {
    const encrypted = await fs.readFile(keyPath(provider))
    if (!safeStorage.isEncryptionAvailable()) return ''
    return safeStorage.decryptString(encrypted)
  } catch {
    return ''
  }
}

// The key that goes with whichever model the request names.
const providerFor = (model?: string) => modelById(model ?? '').provider

function assertInsideFolder(folder: string, target: string) {
  const root = path.resolve(folder)
  const resolved = path.resolve(target)
  const relative = path.relative(root, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('A deletion target was outside the selected image folder.')
  return resolved
}

async function fileHash(filename: string) {
  return createHash('sha256').update(await fs.readFile(filename)).digest('hex')
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    title: 'MoodPrep',
    backgroundColor: '#f2efe8',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(currentDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void window.loadFile(path.join(rendererDirectory, 'index.html'))
  }
}

app.whenReady().then(async () => {
  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Choose an image folder' })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('scan-folder', (_event, folder: string, recursive: boolean) => scanFolder(folder, recursive))
  ipcMain.handle('refresh-image', (_event, folder: string, imagePath: string) => refreshImage(folder, imagePath))
  ipcMain.handle('duplicate-image', (_event, folder: string, imagePath: string) => duplicateImage(folder, imagePath))
  ipcMain.handle('convert-svgs', (_event, folder: string, recursive: boolean) => convertSvgs(folder, recursive))
  ipcMain.handle('load-project', (_event, folder: string) => loadProject(folder))
  ipcMain.handle('save-project', (_event, state: ProjectState) => saveProject(state))
  ipcMain.handle('process-image', (_event, request: ProcessRequest) => processImage(request))
  ipcMain.handle('analyze-quality', (_event, imagePath: string) => analyzeImageQuality(imagePath))
  ipcMain.handle('detect-background', (_event, imagePath: string) => detectBackgroundColor(imagePath))
  ipcMain.handle('detect-rotation', (_event, imagePath: string) => detectRotation(imagePath))
  ipcMain.handle('detect-palette', (_event, imagePath: string) => detectPalette(imagePath))
  ipcMain.handle('detect-dominant-colors', (_event, imagePath: string, count?: number) => detectDominantColors(imagePath, count))
  ipcMain.handle('sample-pixel', (_event, imagePath: string, x: number, y: number) => samplePixelColor(imagePath, x, y))
  ipcMain.handle('fill-area', (_event, request: FillRequest) => fillArea(request))
  ipcMain.handle('prune-previews', (_event, folder: string, keep: string[]) => prunePreviews(folder, keep))
  ipcMain.handle('load-editor-preview', (_event, imagePath: string) => loadEditorPreview(imagePath))
  ipcMain.handle('commit-processed-image', (_event, folder: string, sourcePath: string, previewPath: string) => commitProcessedImage(folder, sourcePath, previewPath))
  ipcMain.handle('revert-committed-image', (_event, folder: string, sourcePath: string, backupPath: string) => revertCommittedImage(folder, sourcePath, backupPath))
  ipcMain.handle('ai-edit', async (_event, request: GeminiRequest) => aiEdit(request, await readApiKey(providerFor(request.model)), (input, init) => net.fetch(input, init), await readWorkspace(), await readRegion()))
  ipcMain.handle('author-prompt', async (_event, request: AuthoredPromptRequest) => authorPrompt(request, await readApiKey('gemini'), (input, init) => net.fetch(input, init)))
  ipcMain.handle('save-api-key', async (_event, provider: AiProvider, key: string) => {
    const normalized = key.trim()
    if (!normalized) throw new Error('Enter an API key first.')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable on this computer.')
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    await fs.writeFile(keyPath(provider), safeStorage.encryptString(normalized))
  })
  ipcMain.handle('api-key-status', async () => {
    const providers = [...new Set(AI_MODELS.map((model) => model.provider))]
    const entries = await Promise.all(providers.map(async (provider) => [provider, Boolean(await readApiKey(provider))] as const))
    return Object.fromEntries(entries) as Record<AiProvider, boolean>
  })
  ipcMain.handle('test-api-key', async (_event, provider: AiProvider) => testConnection(provider, await readApiKey(provider), (input, init) => net.fetch(input, init), await readWorkspace(), await readRegion()))
  ipcMain.handle('qwen-address', async () => ({ workspace: await readWorkspace(), region: await readRegion() }))
  ipcMain.handle('save-qwen-address', async (_event, address: { workspace: string; region: QwenRegion }) => {
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    await fs.writeFile(workspacePath(), normaliseQwenWorkspace(address.workspace))
    await fs.writeFile(regionPath(), QWEN_REGIONS.some((region) => region.id === address.region) ? address.region : DEFAULT_QWEN_REGION)
  })
  ipcMain.handle('delete-duplicates', async (_event, folder: string, groups: DuplicateDeletionGroup[]) => {
    let deletedCount = 0
    const failed: Array<{ path: string; reason: string }> = []
    for (const group of groups) {
      let keeperPath = ''
      let keeperHash = ''
      try {
        keeperPath = assertInsideFolder(folder, group.keeperPath)
        keeperHash = await fileHash(keeperPath)
      } catch (error) {
        for (const target of group.deletePaths) failed.push({ path: target, reason: `Could not verify keeper: ${error instanceof Error ? error.message : String(error)}` })
        continue
      }
      for (const target of group.deletePaths) {
        try {
          const resolved = assertInsideFolder(folder, target)
          if (resolved === keeperPath) throw new Error('Refusing to delete the chosen keeper.')
          if (await fileHash(resolved) !== keeperHash) throw new Error('File contents no longer match the chosen keeper.')
          await shell.trashItem(resolved)
          deletedCount += 1
        } catch (error) {
          failed.push({ path: target, reason: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    return { deletedCount, failed }
  })
  ipcMain.handle('delete-image', async (event, folder: string, imagePath: string) => {
    const resolved = assertInsideFolder(folder, imagePath)
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = {
      type: 'warning' as const,
      title: 'Delete image from folder?',
      message: `Move ${path.basename(resolved)} to Trash?`,
      detail: 'The image will be removed from this collection. Existing reference copies in moodprep-originals will be kept.',
      buttons: ['Cancel', 'Move to Trash'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const confirmation = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
    if (confirmation.response !== 1) return { deleted: false }
    await shell.trashItem(resolved)
    return { deleted: true }
  })
  // Deleting a selection asks once for the whole batch. Looping the single-image
  // handler would stack one native dialog per file, which is not a bulk action.
  ipcMain.handle('delete-images', async (event, folder: string, imagePaths: string[]) => {
    const targets = [...new Set(imagePaths)]
    if (targets.length === 0) return { deletedCount: 0, failed: [] }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const names = targets.map((target) => path.basename(target))
    const listed = names.slice(0, 8).join('\n')
    const options = {
      type: 'warning' as const,
      title: 'Delete images from folder?',
      message: targets.length === 1 ? `Move ${names[0]} to Trash?` : `Move ${targets.length} images to Trash?`,
      detail: `${listed}${names.length > 8 ? `\n…and ${names.length - 8} more` : ''}\n\nThey will be removed from this collection. Existing reference copies in moodprep-originals will be kept.`,
      buttons: ['Cancel', targets.length === 1 ? 'Move to Trash' : `Move ${targets.length} to Trash`],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }
    const confirmation = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)
    if (confirmation.response !== 1) return { deletedCount: 0, failed: [], cancelled: true }
    let deletedCount = 0
    const failed: Array<{ path: string; reason: string }> = []
    for (const target of targets) {
      try {
        await shell.trashItem(assertInsideFolder(folder, target))
        deletedCount += 1
      } catch (error) {
        failed.push({ path: target, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return { deletedCount, failed }
  })
  ipcMain.handle('clear-api-key', async (_event, provider: AiProvider) => {
    try { await fs.unlink(keyPath(provider)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  })
  ipcMain.handle('export-selection', (_event, folder: string, entries: ExportEntry[]) => exportSelection(folder, entries))
  ipcMain.handle('reveal-path', async (_event, target: string) => {
    const stat = await fs.stat(target)
    if (stat.isDirectory()) await shell.openPath(target)
    else shell.showItemInFolder(target)
  })
  ipcMain.handle('copy-text', (_event, text: string) => clipboard.writeText(text))

  if (process.argv.includes('--test-gemini-connection')) {
    const result = await testConnection('gemini', await readApiKey('gemini'), (input, init) => net.fetch(input, init))
    console.log(result.message)
    app.exit(result.ok ? 0 : 1)
    return
  }

  if (process.argv.includes('--test-gemini-edit')) {
    const temporaryFolder = await fs.mkdtemp(path.join(app.getPath('temp'), 'moodprep-gemini-smoke-'))
    try {
      const inputPath = path.join(temporaryFolder, 'input.png')
      await fs.writeFile(inputPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7b0AAAAASUVORK5CYII=', 'base64'))
      const result = await aiEdit({
        projectPath: temporaryFolder,
        imagePath: inputPath,
        prompt: 'Faithfully return this simple reference as a clean solid red square. Do not add text or other elements.',
        imageSize: '1K',
      }, await readApiKey('gemini'), (input, init) => net.fetch(input, init))
      console.log(`Gemini image edit succeeded at ${result.width} × ${result.height}`)
      app.exit(0)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      app.exit(1)
    } finally {
      await fs.rm(temporaryFolder, { recursive: true, force: true })
    }
    return
  }

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
