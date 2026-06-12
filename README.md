# BigComics Chapters Downloader

A friendly Tampermonkey/Violentmonkey userscript.js that lets you download manga chapters from [BigComics](https://bigcomics.jp/) as ZIP or CBZ archives, one chapter at a time or an entire series in one click.

---

## Features

- **Single chapter download** — captures the current episode and packages it into an archive
- **Full series download** — iterates through all chapter links found on the page and downloads each one sequentially
- **RTL spread support** — correctly handles right-to-left manga layouts and two-page spreads; pages are always saved in reading order
- **Automatic fullscreen** — enters fullscreen before capturing to get the highest available canvas resolution
- **Duplicate frame detection** — fingerprints each canvas in PNG regardless of output format, so transitional or repeated frames are never saved twice
- **Flexible image format** — choose between PNG (lossless), JPG, or WebP; quality slider for lossy formats (default 95%)
- **Flexible archive format** — choose between ZIP and CBZ
- **Persistent preferences** — all settings are saved to `localStorage` and restored on the next visit
- **Clean filenames** — archives and internal folders are named `Series Title - Episode Title`, with filesystem-unsafe characters sanitized automatically

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
┌─────────────────────────────┐
│ ⬇ BigComics Downloader   ⚙ │
│ Ready.                       │
│ ┌──────────────────────────┐ │
│ │  ⬇ Download this chapter │ │
│ └──────────────────────────┘ │
│ ┌──────────────────────────┐ │
│ │  📚 Download full series  │ │
│ └──────────────────────────┘ │
│ Archive format:              │
│  [ ZIP ]  [ CBZ ]            │
└─────────────────────────────┘
```

### Download this chapter
Captures every page of the currently open episode, then triggers a download of the archive.

### Download full series
Finds all episode links on the current page, navigates to each one in sequence, captures its pages, and downloads one archive per chapter. Chapter archives are prefixed with a zero-padded index (`001_`, `002_`, …) to keep them in order.

### Settings (⚙)
Click the gear icon in the title bar to open the settings overlay:

| Setting | Options | Default |
|---|---|---|
| Image format | PNG · JPG · WEBP | PNG |
| Quality | 1–100% (JPG/WEBP only) | 95% |

All preferences are stored in `localStorage` under the keys `bc-dl-format`, `bc-dl-imgfmt`, and `bc-dl-quality`.

---

## Output format

Each archive contains a single folder named after the series and episode:

```
SeriesTitle - EpisodeTitle.zip (or .cbz)
└── SeriesTitle - EpisodeTitle/
    ├── 001.png
    ├── 002.png
    └── ...
```

File extensions match the chosen image format (`001.jpg`, `001.webp`, etc.).

---

## Advanced configuration

A set of timing constants at the top of the script can be tweaked if your connection or device is slow:

| Constant | Default | Description |
|---|---|---|
| `STABLE_CHECKS` | `3` | Consecutive identical canvas reads required to consider a page fully loaded |
| `STABLE_INTERVAL` | `250` ms | Interval between canvas stability checks |
| `AFTER_CLICK_WAIT` | `400` ms | Wait after clicking "next page" before checking stability |
| `MAX_PAGES` | `200` | Safety cap — stops capturing after this many pages |
| `STUCK_LIMIT` | `5` | Clicks that yield no new pages before treating it as the end of the chapter |
| `BETWEEN_CHAPTERS` | `2000` ms | Wait between chapters during a full series download |
| `FULLSCREEN_WAIT` | `1200` ms | Wait after entering fullscreen for the canvas to resize |

---

## Requirements

- A Chromium or Firefox-based browser with Tampermonkey or Violentmonkey
- An active BigComics account with access to the episode you want to download
- [JSZip 3.10.1](https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js) — loaded automatically via `@require`

---


## Disclaimer

This script is intended for personal use only. Downloading content you have legitimate access to for offline reading may be permitted under applicable law, but redistribution of downloaded material is not. Use responsibly and in accordance with BigComics' terms of service.
