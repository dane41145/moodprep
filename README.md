# MoodPrep

[中文说明](README.zh-CN.md)

MoodPrep is a local-first desktop workbench for preparing image collections before adding them to a Midjourney moodboard. It scans and reviews source folders without modifying their contents.

## What it does

- Indexes JPG, JPEG, PNG, WebP, and SVG files.
- Finds byte-for-byte copies with SHA-256.
- Suggests visually near-identical files with perceptual hashing.
- Recommends a keeper using resolution, detail, and compression signals.
- Prefers the unsuffixed filename over names ending in `(1)`, `(2)`, and so on when files are byte-identical.
- Deletes confirmed exact copies from the source folder by moving them to the operating system Trash after re-verifying their hashes.
- Converts SVG sources to 2048 px PNG during intake, at a render density derived from each file's own size.
- Applies non-destructive crop, border trim, centering, background flattening, resize, and format conversion.
- Constrains the crop frame to a perfect square with a 1:1 lock, correct on any source aspect ratio.
- Supports multi-label review for texture, perspective, background, watermark, quality, border, crop, and centering issues.
- Sends only explicitly requested reconstruction jobs to an image model: Gemini (Flash Lite, Flash, Pro) or Alibaba's Qwen Image, chosen per job.
- Accepted edits replace the image in place; the previous file is kept in `moodprep-originals`, and the save can be undone from the toast.
- Presents the whole collection on one library screen, sorted by name, date added, date modified, file size, dimensions, quality, or file type.

## The interface

MoodPrep is a single library screen rather than a numbered wizard:

- The **grid** is the workspace. Search, filter by issue tag, sort, select several images to tag them at once, and open any image in the workbench.
- **Sorting** covers Name, Date Added, Date Modified, File Size, Dimensions, Quality, and File Type in either direction. Each card's second line shows whatever the collection is currently sorted by.
- **Quick filters** (All images, Needs work, Processed, Untouched) double as the collection's headline counts.
- **Duplicates** opens exact-copy and visual-match review over the grid, including keeper recommendations and the explicit delete action.
- **Collection** holds the scan statistics, format breakdown, the subfolder setting, rescan, and SVG conversion status.

## Language

Settings offers English and Simplified Chinese. The choice applies immediately, covers the whole interface and the native delete dialogs, and switches the reconstruction prompts and the prompt-writing instruction to Chinese so they can be read and edited without English.

## Run it

For development:

```bash
npm install
npm run dev
```

Build and package for Apple Silicon macOS:

```bash
npm run package:mac
```

The packaged DMG and ZIP are written to `release/`. For day-to-day use, `npm run app` rebuilds, installs to `/Applications/MoodPrep.app` and relaunches it.

## Project data

After opening an image folder, MoodPrep creates local working data:

```text
.moodprep/
  project.json      decisions and issue tags
  scan-cache.json   per-file analysis, keyed by size and mtime
  previews/         scratch revisions, pruned automatically
moodprep-originals/ every file that was replaced
```

Files in `previews/` are scratch: they are removed after each scan and whenever the workbench closes, unless the project still refers to one.

Original image files are read-only during scanning and processing. Excluding an image changes only the project decision. The explicit **Delete confirmed copies** action is the sole exception: after confirmation, it re-verifies every exact copy against the chosen keeper and moves it to the operating system Trash. Processed previews and exports are new files.

## API key security

Enter the Gemini or Qwen key in Settings. Electron encrypts it through the operating system credential service and stores the encrypted value in the application data directory, not the image folder. The renderer never reads the stored key. Gemini calls originate from the desktop process only when the user starts a reconstruction.

The keys can alternatively be supplied as `GEMINI_API_KEY` and `DASHSCOPE_API_KEY` in the launch environment; Qwen also takes `DASHSCOPE_WORKSPACE` and `DASHSCOPE_REGION`. Do not commit secrets to this repository.

## Verification

```bash
npm test
npm run build
npm audit --omit=dev
```

The tests cover duplicate matching, SVG intake, the scan cache, every deterministic image operation, source preservation and undo, preview pruning, and the prompt and model-selection rules.

## Working on it

`AGENTS.md` and `memory.md` are the product record: `memory.md` lists every behaviour the app has committed to and why, and any change is expected to read it first and keep those behaviours. Pure image algorithms live in `shared/` and are used by both the Electron process and the renderer.
