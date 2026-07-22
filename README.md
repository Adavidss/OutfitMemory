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
- **Wardrobe (optional)** — tag clothing straight off your photos: drag roughly over a piece and *smart select* snaps to the garment using real person-parsing (skin, hair and background are excluded by pixel classification, not guesswork). You name it and pick the category — nothing is guessed. Tags and categories are one-tap chips.
- **Wishlist & planned outfits** — keep wanted items separate from what you own (add them by pasting a shop's product image), move them across when you buy them, and save builder combinations as ideas to wear later.
- **Wardrobe insights** — real **cost-per-wear** (wear counts come from the photo log, not self-reporting), "worth a rewear" nudges, what-pairs-with-what, and an **outfit builder** that shuffles your own clothes into something to wear. Never required — the journal works untouched if you ignore all of it.
- **Where to buy (optional, BYO key)** — with your own free Gemini key, an item's crop can be looked up online with Google Search grounding for real purchase links. Off by default; see [How tagging understands your photo](#how-tagging-understands-your-photo).
- **Themes** — Light, Dark, Mono, Retro Magazine, and Polaroid Scrapbook (plus Auto).
- **Quality of life** — undo-able delete, ⤨ flashback (random outfit), bulk back-fill (multi-select from library, dated by photo file dates), tag autocomplete, cozy/compact grid toggle, "share as memory card" (polaroid-framed PNG composed on-device).
- **PWA** — installable on your home screen, works fully offline.
- **Backup / restore** — export `metadata.json` or a full ZIP archive; import merges cleanly.
- **Automatic backups** (desktop Chrome/Edge) — pick a second folder and a preset (after every change / daily / weekly); OutfitMemory incrementally mirrors new photos + `metadata.json` into it. The backup folder is itself a complete archive — restoring is just "Choose Outfit Folder" and pointing at it.

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

- **Nothing is uploaded unless you opt in.** The `Content-Security-Policy` permits two *download-only* hosts, used solely to fetch the on-device clothing-detection model (`cdn.jsdelivr.net`, `storage.googleapis.com`), plus `generativelanguage.googleapis.com` — which stays unreachable until you configure your own Gemini key for "Find where to buy". There is no `form-action` target, so photos and metadata have nowhere else to be posted — enforced by the browser, not by promise. Skip the optional features and the app makes no network requests at all.
- **EXIF stripped.** Photos are re-encoded through a canvas on save, which removes all metadata (GPS location, device model, etc.) from stored files.
- **You own the archive.** It's a plain folder:

```
OutfitMemory/
├── Photos/2026/07/outfit_2026-07-21.webp
├── Thumbnails/2026/07/outfit_2026-07-21_thumb.webp
├── Items/itm_ab12cd.webp          (only if you tag clothing)
└── metadata.json
```

Readable in 20 years with no app at all. `metadata.json` is derived data in spirit — Settings → **Rescan folder** can rebuild entries (and regenerate thumbnails) from the photos alone.

### Metadata schema

```json
{
  "app": "OutfitMemory",
  "schema": 2,
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
    "weather": null,
    "items": ["itm_ab12cd"]
  }],
  "items": [{
    "id": "itm_ab12cd",
    "name": "Navy crew sweater",
    "category": "top",
    "color": "navy",
    "hex": "#26324f",
    "brand": "",
    "price": 89,
    "currency": "USD",
    "link": "",
    "notes": "",
    "tags": ["work"],
    "wish": false,
    "thumb": "Items/itm_ab12cd.webp"
  }],
  "plans": [{ "id": "plan_x", "items": ["itm_ab12cd"], "note": "", "createdAt": "…" }]
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
  segment.js          garment segmentation: parser-backed smart paths + heuristic fallback
  wardrobe.js         item analytics + the outfit recombination engine
  models/             personParser — MediaPipe pixel classes (clothes vs skin/hair/bg)
  search/             whereToBuy (optional Gemini lookup) · shoppingSearch (retailer URLs)
  storage/            folderStorage (FS Access) · browserStorage (IndexedDB)
  views/              gallery · calendar · stats · wrapped · detail · capture · settings · onboarding
                      wardrobeView · itemTagger · outfitBuilder · shareOutfit
scripts/              generate_icons.py
  ui/                 dom helpers · svg icons
  util/               dates/streaks · idb wrapper · zip writer+reader
sw.js                 offline cache (bump CACHE on deploy)
manifest.webmanifest  PWA manifest (+ "Add Outfit" shortcut)
scripts/generate_icons.py  regenerates PNG icons from the SVG design
```

## The wardrobe layer

Tagging is opt-in and additive. Open any outfit → **Tag clothing** → drag a box
around one piece. The crop is saved to `Items/`, the color comes from the pixels,
and the category is guessed from where the box sits on the body. Name it (or accept
the suggestion) and you're done; brand, price and a product link are optional.

Because OutfitMemory already knows *when you wore what*, the numbers it derives are
real rather than self-reported:

| Derived | From |
|---|---|
| Times worn, last worn | photos the item is tagged in |
| **Cost per wear** | `price ÷ wears` — the one number a shopping app can't compute for you |
| "Worth a rewear" | items unworn for 60+ days, or never worn |
| "You usually wear it with" | co-occurrence across your outfits |
| Outfit suggestions | least-recently-worn pieces, neutral-anchored color harmony, and never a combo you wore in the last 3 weeks |

Items live in `metadata.json` under `items[]`, and outfits reference them by id in
`entry.items[]` — so schema 1 archives keep loading unchanged, and an archive with
no tagged clothes has no `items` at all.

## How tagging understands your photo

Three engines cooperate, each strictly optional and each with a fallback:

**1. Person parsing (smart select).** MediaPipe's multiclass selfie segmenter
labels every pixel — background, hair, body skin, face skin, clothes,
accessories — so "which pixels are clothing" is a classification, not a color
guess. This is what keeps your skin and hair out of color palettes and crops.
~1.3 MB WASM + 16 MB model, downloaded on first tagging use, cached (offline
afterwards), runs locally in ~250 ms. If it can't load, or the photo has no
person the model recognizes, the old color-heuristic segmentation takes over.
Settings → Storage → **Recalculate colors** re-reads existing archives with the
current engine.

**2. You name it.** Nothing about the garment is guessed. An earlier version ran
FashionCLIP to prefill the name and category; it was removed because a confident
wrong label is worse than an empty field — harder to notice, harder to correct,
and it quietly poisoned the wardrobe with names nobody chose. The form now opens
with an empty name and **no category selected**, category and tags are one-tap
chips, and notes are inline. The only thing pre-filled is the detected colour,
which comes from the garment's own pixels rather than a model's opinion.

**3. Where to buy (optional, off by default, the ONE online feature).** Every
wardrobe item can have a manual product link (http/https only). Beyond that, if
you paste **your own free Gemini API key** (aistudio.google.com) into Settings →
Online item search, items get a "Find where to buy" button: the item's **crop**
(never the full outfit photo) goes to Google's Gemini with Search grounding, and
real web sources come back as possible purchase links, plus retailer-search
shortcuts for its suggested phrase. Results are cached on the item. Without a
key, the buttons don't exist and the endpoint is never contacted. The key lives
in `localStorage` only — never in `metadata.json`, so exports, backups and
mirrors never contain it.

### Network policy, precisely

The CSP allows download-only fetches from `cdn.jsdelivr.net` and
`storage.googleapis.com` (the person-parsing runtime and model), plus — solely
for the opt-in feature above — `generativelanguage.googleapis.com`. There is no
`form-action` target. Skip the optional features and the app makes no network
requests at all.

## Wishlist

The Wardrobe tab has two halves: **Owned** and **Wishlist**. Wanted items live in
the same `items[]` array with `wish: true`, which keeps one search index and one
set of screens — but they are excluded from the outfit builder, cost-per-wear and
every insight, because suggesting something you don't own would be nonsense. When
you buy one, "I bought this" flips it to owned and stamps `acquiredAt`.

**Adding an item from a shop:** copy the product image (right-click → Copy Image,
or long-press → Copy on mobile) and paste it into the add dialog; drag-drop and
file upload work too. Pasting rather than "fetch this URL" is deliberate — URL
fetching would need the app to reach any host on the web, the exact capability
this app is built not to have, and it would mostly fail anyway since shop CDNs
rarely send CORS headers, leaving the canvas tainted and the image un-encodable.

## Sharing

Outfit photos share as a polaroid **memory card**. Builder suggestions and saved
plans share as an **outfit card** — the pieces laid out on the brand gradient with
their names. Both are composed on a local canvas and only go anywhere if you pick
a destination in the system share sheet; browsers without file sharing download
the PNG instead.

## Future AI (designed-for, not required)

The metadata is deliberately extensible; analyzers run on-device and write fields beside the photo:

- **Color extraction** — ✅ already implemented (`colors.js`, ~1 ms/photo, no ML).
- **Similar outfit search** — add per-photo embeddings (e.g. MobileCLIP via WebGPU/ONNX-runtime-web) stored as an `embedding` field; cosine-match for "show outfits like this".
- **Auto-tagging** — the same embedding pass over item crops could pre-fill `category` and `name` (see "Purchase links & reverse image search" above for what's realistic and what isn't).
- **Style evolution / Wrapped+** — richer yearly summaries from colors + embeddings.
- **Clothing detection** — a small on-device segmentation model writing `items: ["shirt", "jeans", …]`.

All of these slot into the pipeline in `imagePipeline.js → processPhoto()` without schema migrations — old entries just lack the new fields until a rescan.

## License

MIT © Atli Davidsson
