# Dark PDF · dark mode for the native PDF viewer

[简体中文](README.md) · **English**

A **40 KB** extension for Edge and Chrome that inverts a PDF into dark mode while **keeping the browser's own PDF toolbar fully intact** — page navigation, zoom, rotate, search, print, draw, Copilot, all of it.

No replacement viewer. No bundled pdf.js. No network.

---

## Before / after

Same document ([`docs/demo.pdf`](docs/demo.pdf)), same window — the only thing that changes is the extension switch.

**At 100%**

| Extension off | Extension on |
|:---:|:---:|
| ![Off, 100%](docs/compare-off.png) | ![On, 100%](docs/screenshot-dark.png) |
| White paper, native toolbar — hard on the eyes over time | Paper inverted to `#141414`, toolbar untouched |

**Zoomed out to 62% — where the area outside the page becomes visible**

| Extension off | Extension on |
|:---:|:---:|
| ![Off, 62%](docs/compare-off-zoom.png) | ![On, 62%](docs/screenshot-zoomout.png) |
| The browser's own dark-grey desk, plus white paper | Paper goes dark, desk stays the original dark grey instead of flipping to light grey |

Inversion also flips the browser's dark-grey desk to light grey, so the overlay **covers only the page itself** — the desk on either side belongs to the browser and is left untouched. Only in a light theme (where the desk really is light grey) are the margins painted `#33373d`.

---

## How it differs from other dark-mode PDF extensions

Most solutions hand the PDF to their own renderer, and the native toolbar goes away with it. This one does the opposite: it **inverts inside the browser's native PDF plugin page**, without touching a single pixel of the toolbar.

The hard part is that the toolbar and the document canvas live on the **same layer** (the same `<embed>`), so you cannot simply put a `filter` on the embed — that would invert the toolbar into a light bar too. The solution is a `pointer-events: none` overlay sitting just below the toolbar, using `backdrop-filter` to invert only what is behind it.

---

## Features

- **Native toolbar untouched**: colours follow the browser theme, so it is already dark in a dark theme
- **Zero contrast loss in body text**: only `invert + hue-rotate`, no curves — formulas, footnotes and thin strokes stay crisp
- **Browser chrome left alone**: the overlay covers the page only, so the scrollbar — and the part of a toolbar flyout that falls on the gutter — stay where they are
- **No flicker on zoom or resize**: new bounds are computed from a geometry model instead of re-capturing the screen
- **Colours stay meaningful**: `hue-rotate(180deg)` restores the hues lost to inversion, so illustrations do not turn into negatives
- **Zero network**: no remote resources, the capture is decoded inside the extension process, used once, never written to disk or sent anywhere

| Zoomed out to 62% | Settings |
| --- | --- |
| ![Zoomed out](docs/screenshot-zoomout.png) | ![Settings](docs/screenshot-popup.png) |

---

## Install

### Edge

1. Go to `edge://extensions/`
2. Turn on **Developer mode** (bottom-left)
3. Click **Load unpacked** and pick the root of this repository
4. To read PDFs stored on disk (opened by double-clicking), open the extension's **Details → Allow access to file URLs**

### Chrome

1. Go to `chrome://extensions/`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** and pick the root of this repository
4. Same as above: enable **Allow access to file URLs** in the details

> `manifest_version: 3`, minimum Chromium 102.

---

## Settings

Click the extension icon:

| Setting | Meaning |
| --- | --- |
| Dark inversion | Master switch; turning it off restores the original white instantly |
| Inversion strength | 50%–100%, 100% being a full inversion; lowering it keeps photos less negative |
| Auto-dim gutters | On by default. Measures the page bounds, then decides whether the margins need painting at all (in a dark theme they do not) |
| Re-apply to this page | Manual refresh and re-calibration (rarely needed) |
| Show original page temporarily | Restores the current tab to white paper; shortcut `Alt+Shift+D`, press again to go back |

---

## How it works

### 1. Why the native PDF page can be modified at all

In the browser a PDF is a **plugin document** (`document.contentType === 'application/pdf'`, with a DOM of just `<html><body><embed type="application/pdf">`). Content scripts declared in the manifest **cannot** run there, but `chrome.scripting.executeScript` can inject programmatically.

### 2. Why the toolbar survives

The toolbar and the document canvas live in the same `<embed>`. Putting a `filter` on the embed inverts the toolbar too (measured: `#3b3b3b` → `#b9b9b9`). So instead, a `pointer-events: none` overlay is placed **below the toolbar** (measured height 41px) and `backdrop-filter` inverts whatever is behind it — the toolbar sits above the overlay and is never affected.

### 3. Why the gutters sometimes need painting and sometimes do not

The area outside the page is painted by the viewer itself, on the same layer as the document, so it gets inverted too. Inversion is a monotonic map: white paper `#fff` and the dark-theme backdrop `#333` both come out light (`#141414` and `#c0c0c0`).

Crushing it with `brightness/contrast` was tried, and so was `mix-blend-mode: color-burn`. Both darken the gutters, and both **eat thin strokes** ("MATHEMATICS" broke apart). This is mathematically unsolvable: after inversion the text sits at 232 and the gutter at 192 — 40 apart. Any monotonic map that separates those two values has to crush the midtones, and every CSS filter and blend mode is monotonic.

So the only option is **measure, then decide**. `chrome.tabs.captureVisibleTab` grabs one frame → scan the middle row → find the widest run whose luminance differs most from the gutter (= the page). The same frame also records the gutter's brightness, which decides what happens next:

| Browser theme | Native gutter | Measured after inversion | Handling |
| --- | --- | --- | --- |
| Dark | `#333` | light (≈192) | The gutter is already dark grey: **the overlay covers the page only**, nothing on either side is touched |
| Light | `#f1f1f1` | dark (≈32) | It would flip to light: paint the margins `#33373d` |

The point is that in a dark theme there is nothing to paint — and painting is exactly what puts an opaque block over the browser's own chrome, hiding the scrollbar and the Draw panel along with it. Once the overlay is clipped to the page, the scrollbar and the gutter side of any flyout stay put.

### 3.1 Scrollbar and toolbar flyouts

- **Scrollbar**: the overlay always stops short of the scrollbar column (measured 14px). Inversion turns the scrollbar light against a dark track, which makes it practically invisible — i.e. it hides it.
- **Toolbar flyouts** (Draw panel, zoom menu, overflow menu): Edge draws these inside the PDF plugin. The extension can reach neither their DOM (`executeScript` only ever sees an `<embed>`) nor their mouse events (the plugin swallows them all). So the part of a flyout that **crosses the page's left edge** cannot be cut out of the inversion — whatever overlaps the page gets inverted with it. For accurate colour picking (choosing a highlighter, say), press `Alt+Shift+D` to restore the page to white paper, then press it again to come back.

### 4. Why zooming does not flicker

Early versions re-captured the screen on every zoom, and the old overlay had to be removed first (otherwise the leftmost pixels are the overlay's own colour and the baseline is wrong) — which exposed a light-grey frame for about 200ms.

The current version uses a geometry model and **never captures again**. In Edge, PDF zoom is tab zoom, and the page width is strictly linear in zoom and independent of the window width:

```
pageW = k × zoom
left   = (W - scrollbar - pageW) / 2
```

`k` is the page width at 100% for that document (A4 works out to 793.98 = 210mm × 96dpi), calibrated once at load time. Four measured points all match, within 0.1%:

| zoom | window width | predicted | measured |
| --- | --- | --- | --- |
| 1 | 1280 | 18.36% | 18.36% |
| 0.422 | 1280 | 36.29% | 36.25% |
| 1.030 | 1280 | 17.43% | 17.42% |
| 1.030 | 1000 | 8.30% | 8.30% |

Zooming takes a fast path: it uses the `newZoomFactor` carried by the `onZoomChange` event and injects once. Verified with 16 consecutive frames — **not one light-grey frame**.

### 5. Other implementation details

- Injection happens in `tabs.onUpdated` at the `loading` stage, before the PDF renders, so there is no white flash
- Fixed-id `<style>` and `<div>` elements, so cleanup is reliable even if the service worker is recycled and in-memory state is lost
- A background tab cannot be captured, so calibration is deferred until it comes to the front; once calibrated, a tab never needs a capture again

---

## Known limitations

- The toolbar height is assumed to be 41px. If a future version makes it taller, a thin light strip may show along the top edge of the overlay
- **When the Draw panel or a zoom menu crosses the page's left edge, the part over the page is inverted.** Those flyouts are drawn inside the PDF plugin, so the extension can neither see nor avoid them (see 3.1) — use `Alt+Shift+D` when you need accurate colours
- When scrolling a multi-page document, **the horizontal gap between two pages** is still inverted light grey (~10px). It moves with the scroll, and a static overlay cannot follow it — it reads as a separator between pages
- The geometry model assumes all pages in a document have the same width; PDFs with mixed page sizes drift slightly when turning pages
- The theme is decided from the gutter brightness measured at load time; after switching the browser theme, reload the page to re-detect it
- Encrypted (password-protected) PDFs still prompt for the password, and inversion works as usual

---

## Repository layout

```
.
├─ manifest.json     extension manifest (MV3)
├─ background.js     injection: detect PDF page → inversion overlay → calibrate bounds → clip to page
├─ popup.html/css/js settings panel
├─ icons/            16 / 32 / 48 / 128 icons
└─ docs/             screenshots, plus the demo.pdf used to take them
```

---

## Version history

Full notes live in [Releases](https://github.com/hibit-SAA/dark-pdf/releases) and [CHANGELOG](CHANGELOG.md).

| Version | Highlights | Package |
| --- | --- | --- |
| **v2.4** | Fix: scrollbar was covered by the overlay; the Draw panel's gutter half was painted over. Added `Alt+Shift+D` to restore the original page | Current source |
| **v2.3.1** | Fix: after switching the extension off, zooming out and switching it back on, the gutters stayed inverted light grey | [Download](https://github.com/hibit-SAA/dark-pdf/releases/tag/v2.3.1) |
| **v2.3** | Desk changed to dark grey `#33373d`; zoom switched to the geometry model, no more flicker | [Download](https://github.com/hibit-SAA/dark-pdf/releases/tag/v2.3) |
| **v2.2** | Re-measure bounds after zoom / window resize; drop the overlay when the page fills the width | Not archived |
| **v2.1** | Gutters changed to "measure, then paint", replacing the curve-crushing approach | Not archived |
| **v2.0** | Rewrite: keep the native toolbar, invert with a `backdrop-filter` overlay | [Download](https://github.com/hibit-SAA/dark-pdf/releases/tag/v2.0) |
| **v1.0** | First version: bundled pdf.js viewer, fully dark, but no native toolbar | [Download](https://github.com/hibit-SAA/dark-pdf/releases/tag/v1.0) |

> v2.1 and v2.2 were two intermediate iterations on the same evening. Their code was overwritten in place and never archived, so only the change notes survive.

---

## Credit

This project was built with the assistance of **DeepSeek-V4.1-Flash**: the reasoning about why CSS filters alone cannot darken the page gutters, the `pageW = k × zoom` calibration, the injection logic, the settings panel and this document were produced collaboratively by a human and the model. All code, screenshots and demo documents are original to this project — nothing from any third-party document appears here. The screenshots use [`docs/demo.pdf`](docs/demo.pdf), which you can open and compare against yourself.

---

## License

[MIT](LICENSE)
