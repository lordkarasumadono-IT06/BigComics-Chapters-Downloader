# BigComics Chapters Downloader

A friendly Tampermonkey/Violentmonkey userscript that lets you **download manga chapters from [BigComics](https://bigcomics.jp/)** as ZIP or CBZ archives — in one click, directly from your browser.

No external tools required. Works on Chrome, Firefox, and Edge.

---

## Features

- **Single chapter download** — captures the current episode and packages it into an archive
- **RTL spread support** — correctly handles right-to-left manga layouts and two-page spreads; pages are always saved in reading order
- **Automatic fullscreen** — enters fullscreen before capturing to get the highest available canvas resolution
- **Duplicate frame detection** — fingerprints each canvas in PNG regardless of output format, so transitional or repeated frames are never saved twice, with in-place retries for slow-loading pages
- **Cover image** — fetches the episode's cover image (full-res when available) and prepends it as page 1 of the archive
- **Automatic metadata detection & embedding** — Author, Publisher, and Publication date are scraped straight off the episode page and, if enabled, embedded into every image (PNG iTXt chunks; JPEG/WEBP EXIF, including Windows XP* tags for full Unicode support) and into a `ComicInfo.xml` at the archive root (ComicRack/Anansi schema — read by Komga, Kavita, YACReader, CDisplayEx, and similar readers). Manual override fields are available in Settings for the rare case auto-detection gets it wrong.
- **Page-count verification** — cross-checks the collected page count against the viewer's own page counter and warns (in the status line / console) if pages may be missing
- **Flexible image format** — choose between PNG (lossless), JPG, or WebP; quality slider for lossy formats (default 95%)
- **Flexible archive format** — choose between ZIP and CBZ
- **Persistent preferences** — all settings are saved to `localStorage` and restored on the next visit
- **Clean filenames** — archives and internal files are named `Series Title - Episode Title`, with filesystem-unsafe characters sanitized automatically

---

## Installation

1. Install a userscript manager in your browser:
   - [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari)
   - [Violentmonkey](https://violentmonkey.github.io/) (Chrome, Firefox, Edge)

2. Click the link below to install the script directly, or copy the raw `.js` file and create a new script manually in your userscript manager:

   > **[Install BigComics Chapter Downloader](https://github.com/lordkarasumadono-IT06/BigComics-Chapters-Downloader/raw/refs/heads/main/BigComics-Chapter-Downloader.user.js)**

3. Navigate to any episode on `https://bigcomics.jp/episodes/*` — the panel will appear automatically in the bottom-right corner.

---

## Usage

The panel is injected into the page once the viewer is ready.

```
⬇ BigComics Downloader          ⚙
Ready.

⬇ Download this chapter 

Archive format:
[ ZIP ]   [ CBZ ]
```

### Download this chapter
Captures every page of the currently open episode (cover included), embeds metadata if enabled, then triggers a download of the archive. The status line shows live progress (pages collected, cover fetch, archive build) and any page-count warning.

### Settings (⚙)
Click the gear icon in the title bar to open the settings overlay:

| Setting | Options | Default |
|---|---|---|
| Image format | PNG · JPG · WEBP | PNG |
| Quality | 1–100% (JPG/WEBP only) | 95% |
| Embed metadata in images | on/off | on |
| Author / Publisher / Date override | free text (auto-detected if left empty) | empty (auto-detect) |

The overlay also shows a live preview of the auto-detected Author/Publisher/Date, re-scanned each time it's opened.

All preferences are stored in `localStorage` under the keys `bc-dl-format`, `bc-dl-imgfmt`, `bc-dl-quality`, `bc-dl-meta-enabled`, `bc-dl-meta-author`, `bc-dl-meta-publisher`, and `bc-dl-meta-date`.

---

## Output format

Each archive contains a folder named after the series and episode, with each page prefixed the same way, plus `ComicInfo.xml` at the archive root when metadata embedding is enabled:

```
SeriesTitle - EpisodeTitle.zip (or .cbz)
└── SeriesTitle - EpisodeTitle/
    ├── ComicInfo.xml
    ├── SeriesTitle - EpisodeTitle_001.png   ← cover
    ├── SeriesTitle - EpisodeTitle_002.png
    └── ...
```

File extensions match the chosen image format (`_001.jpg`, `_001.webp`, etc.); the cover is always saved as JPEG regardless of the chosen format.

---

## Fixing file dates (optional)

Since browsers always stamp downloaded files with the download time, an included helper script — `set_file_dates_from_metadata.py` (stdlib only, no dependencies) — reads the publication date embedded by the userscript in each image (PNG "Creation Time" chunk, or JPEG/WEBP EXIF DateTime) and applies it to the file's OS-level Modified date (and Created date, Windows only):

```
python set_file_dates_from_metadata.py <folder or files...>
```

It recurses into folders and only processes `.png`/`.jpg`/`.jpeg`/`.webp` files.

---

## Advanced configuration

A set of timing constants at the top of the script can be tweaked if your connection or device is slow:

| Constant | Default | Description |
|---|---|---|
| `STABLE_CHECKS` | `3` | Consecutive identical canvas reads required to consider a page fully loaded |
| `STABLE_INTERVAL` | `250` ms | Interval between canvas stability checks |
| `AFTER_CLICK_WAIT` | `600` ms | Wait after clicking "next page" before checking stability |
| `MAX_PAGES` | `200` | Safety cap — stops capturing after this many pages |
| `STUCK_LIMIT` | `7` | Rounds with genuinely no new pages (even after in-place retries) before treating it as the end of the chapter |
| `FULLSCREEN_WAIT` | `1200` ms | Wait after entering fullscreen for the canvas to resize |
| `SETTLE_TIMEOUT` | `6000` ms | Max time `waitStableCanvases` waits for a round to settle |
| `MAX_SAME_RETRIES` | `4` | In-place re-checks if a page looks unchanged from the previous round (slow image load) |
| `SAME_RETRY_WAIT` | `900` ms | Wait between in-place re-checks |

---

## Requirements

- A Chromium or Firefox-based browser with Tampermonkey or Violentmonkey
- [JSZip 3.10.1](https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js) — loaded automatically via `@require`

---

## Compatibility

Tested on:

| Browser | Userscript manager |
|---|---|
| Chrome / Chromium | Tampermonkey, Violentmonkey |
| Firefox | Tampermonkey, Violentmonkey |
| Edge | Tampermonkey |

The script targets `https://bigcomics.jp/episodes/*` and is compatible with the BigComics web manga reader (current version: 6.1).

---

## Disclaimer

This script is intended for personal use only. Downloading content you have legitimate access to for offline reading may be permitted under applicable law, but redistribution of downloaded material is not. Use responsibly and in accordance with BigComics' terms of service.
