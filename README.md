# MoodPrep

MoodPrep is a local-first desktop workbench for preparing image collections before adding them to a Midjourney moodboard. It scans and reviews source folders without modifying their contents.

## What it does

- Indexes JPG, JPEG, PNG, WebP, and SVG files.
- Finds byte-for-byte copies with SHA-256.
- Suggests visually near-identical files with perceptual hashing.
- Recommends a keeper using resolution, detail, and compression signals.
- Prefers the unsuffixed filename over names ending in `(1)`, `(2)`, and so on when files are byte-identical.
- Deletes confirmed exact copies from the source folder by moving them to the operating system Trash after re-verifying their hashes.
- Converts SVG sources to 2048 px PNG during export.
- Applies non-destructive crop, border trim, centering, background flattening, resize, and format conversion.
- Constrains the crop frame to a perfect square with a 1:1 lock, correct on any source aspect ratio.
- Supports multi-label review for texture, perspective, background, watermark, quality, border, crop, and centering issues.
- Sends only explicitly requested reconstruction jobs to Gemini.
- Accepted edits replace the image in place; the previous file is kept in `moodprep-originals`.
- Presents the whole collection on one library screen, sorted by name, date added, date modified, file size, dimensions, quality, or file type.

## The interface

MoodPrep is a single library screen rather than a numbered wizard:

- The **grid** is the workspace. Search, filter by issue tag, sort, select several images to tag them at once, and open any image in the workbench.
- **Sorting** covers Name, Date Added, Date Modified, File Size, Dimensions, Quality, and File Type in either direction. Each card's second line shows whatever the collection is currently sorted by.
- **Quick filters** (All images, Needs work, Processed, Untouched) double as the collection's headline counts.
- **Duplicates** opens exact-copy and visual-match review over the grid, including keeper recommendations and the explicit delete action.
- **Collection** holds the scan statistics, format breakdown, the subfolder setting, rescan, and SVG conversion status.

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

The packaged DMG and ZIP are written to `dist/`.

## Project data

After opening an image folder, MoodPrep creates local working data:

```text
.moodprep/
  project.json
  previews/
  ai-cache/
moodboard-ready/
  manifest.json
```

Files in `previews/` are scratch: they are removed after each scan and whenever the workbench closes, unless the project still refers to one.

Original image files are read-only during scanning and processing. Excluding an image changes only the project decision. The explicit **Delete confirmed copies** action is the sole exception: after confirmation, it re-verifies every exact copy against the chosen keeper and moves it to the operating system Trash. Processed previews and exports are new files.

## Gemini key security

Enter the Gemini key in Settings. Electron encrypts it through the operating system credential service and stores the encrypted value in the application data directory, not the image folder. The renderer never reads the stored key. Gemini calls originate from the desktop process only when the user starts a reconstruction.

The key can alternatively be supplied as `GEMINI_API_KEY` in the launch environment. Do not commit secrets to this repository.

## Verification

```bash
npm test
npm run build
npm audit --omit=dev
```

The tests cover exact and perceptual matching, distinct-image exemptions, SVG scanning, deterministic processing, source preservation, SVG export, and manifest generation.
