# OutfitMemory 📸💜

**A private, local-first outfit journal.** Take one photo a day, and OutfitMemory turns it into a beautiful, searchable style memory — a calendar of looks, streaks, stats, and a Spotify-Wrapped-style yearly recap.

No account. No cloud. No server. Your photos never leave your device.

> Open website → choose folder → take photo → save outfit. That's the whole workflow.

## Features

- **Camera-first capture** — "Add Today's Outfit" opens your phone's camera directly. Photos are auto-resized (≤1600 px), compressed to WebP (~200–500 KB), and thumbnailed for fast scrolling. No required text entry.
- **Timeline** — Apple-Photos-style gallery grouped by month, plus a calendar view with photo-filled day cells (tap an empty past day to back-fill it).
- **Search & filter** — notes, tags, dates, favorites, months, and automatically-detected outfit colors.
- **Stats** — outfits recorded, current/longest streak, most photographed month, busiest weekday, most-worn colors, last-12-months chart.
- **OutfitMemory Wrapped** — an auto-advancing, story-style yearly recap.
- **Memories** — "On this day last year…" resurfaces old looks.
- **Themes** — Light, Dark, Mono, Retro Magazine, and Polaroid Scrapbook (plus Auto).
- **PWA** — installable on your home screen, works fully offline.
- **Backup / restore** — export `metadata.json` or a full ZIP archive; import merges cleanly.

## Running locally

It's a fully static site — any file server works:

```bash
cd OutfitMemory
python3 -m http.server 3090
# → http://localhost:3090
```

No build step, no dependencies, no `npm install`. (Opening `index.html` via `file://` won't work — ES modules and the camera APIs need http(s).)

## Deploying to GitHub Pages

1. Push this repository to GitHub.
2. **Settings → Pages → Source: Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Done. The app works under a project subpath (all URLs are relative), e.g. `https://<user>.github.io/OutfitMemory/`.

`.nojekyll` is included so Pages serves files verbatim. When you change any asset, bump the `CACHE` version in `sw.js` so installed clients pick up the update.

## Privacy architecture

OutfitMemory is *local-first by construction*, not by promise:

| Data | Where it lives | Leaves your device? |
|---|---|---|
| Photos & thumbnails | A folder **you** choose (File System Access API) — or private browser storage (IndexedDB) where folder access isn't supported | Never |
| `metadata.json` (dates, notes, tags, colors) | Same folder / browser storage, mirrored to `localStorage` for crash recovery | Never |
| Settings (theme, last view) | `localStorage` | Never |

- **No network calls at all.** The page ships a `Content-Security-Policy` that only allows same-origin requests — the app is *incapable* of phoning home, by policy the browser enforces.
- **EXIF stripped.** Photos are re-encoded through a canvas on save, which removes all metadata (GPS location, device model, etc.) from stored files.
- **You own the archive.** It's a plain folder:

```
OutfitMemory/
├── Photos/2026/07/outfit_2026-07-21.webp
├── Thumbnails/2026/07/outfit_2026-07-21_thumb.webp
└── metadata.json
```

Readable in 20 years with no app at all. `metadata.json` is derived data in spirit — Settings → **Rescan folder** can rebuild entries (and regenerate thumbnails) from the photos alone.

### Metadata schema

```json
{
  "app": "OutfitMemory",
  "schema": 1,
  "entries": [{
    "id": "2026-07-21-001",
    "date": "2026-07-21",
    "time": "08:12",
    "image": "Photos/2026/07/outfit_2026-07-21.webp",
    "thumbnail": "Thumbnails/2026/07/outfit_2026-07-21_thumb.webp",
    "favorite": false,
    "notes": "",
    "tags": [],
    "colors": ["navy", "white"],
    "palette": [{ "name": "navy", "hex": "#26324f", "share": 0.31 }],
    "weather": null
  }]
}
```

Unknown fields are preserved on load/save, so future features (and other tools) can extend entries without migrations.

## Browser support & limitations

| Platform | Photo storage | Notes |
|---|---|---|
| **Chrome / Edge (desktop)** | ✅ Real folder you choose | Best experience. Pick "Allow on every visit" to skip the unlock tap. |
| **Android (Chrome etc.)** | Private browser storage | Mobile browsers don't offer a folder picker yet. Camera capture works great; use Export for backups you own. |
| **iPhone / iPad (Safari)** | Private browser storage | Install via Share → *Add to Home Screen* — the installed app has its own, more durable storage. |
| **Firefox** | Private browser storage | No File System Access API. |

In browser-storage mode the app requests *persistent storage* to prevent eviction, shows usage in Settings, and (on Chromium desktop) offers one-tap migration to a real folder later. **Heads-up:** clearing site data in browser-storage mode deletes your photos — export a ZIP first.

## Project structure

```
index.html            app shell (CSP, inputs, containers)
css/                  base tokens+chrome · components · themes
js/
  app.js              boot, routing, tab bar, theme, SW registration
  store.js            state, metadata CRUD, export/import, migration
  imagePipeline.js    decode → resize → compress → thumbnail
  colors.js           dominant-color analyzer (first "AI" plugin point)
  storage/            folderStorage (FS Access) · browserStorage (IndexedDB)
  views/              gallery · calendar · stats · wrapped · detail · capture · settings · onboarding
  ui/                 dom helpers · svg icons
  util/               dates/streaks · idb wrapper · zip writer+reader
sw.js                 offline cache (bump CACHE on deploy)
manifest.webmanifest  PWA manifest (+ "Add Outfit" shortcut)
scripts/generate_icons.py  regenerates PNG icons from the SVG design
```

## Future AI (designed-for, not required)

The metadata is deliberately extensible; analyzers run on-device and write fields beside the photo:

- **Color extraction** — ✅ already implemented (`colors.js`, ~1 ms/photo, no ML).
- **Similar outfit search** — add per-photo embeddings (e.g. MobileCLIP via WebGPU/ONNX-runtime-web) stored as an `embedding` field; cosine-match for "show outfits like this".
- **Style evolution / Wrapped+** — richer yearly summaries from colors + embeddings.
- **Clothing detection** — a small on-device segmentation model writing `items: ["shirt", "jeans", …]`.

All of these slot into the pipeline in `imagePipeline.js → processPhoto()` without schema migrations — old entries just lack the new fields until a rescan.

## License

MIT © Atli Davidsson
