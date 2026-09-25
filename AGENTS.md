# AGENTS.md

Engineering notes for this repo: the contracts, the defaults, and the traps. It is written
for whoever changes the code next — human or agent.

[README.md](README.md) is the human-facing document (what the site is, how to run it, how
to deploy it, what the datasets contain). Nothing here is needed to *use* the app.

## What this is

A buildless static site: `index.html` + `styles.css` + `app.js`, with Leaflet and MapLibre
loaded from CDNs. No framework, no bundler, no package manager, and **no Node in the
runtime path** — the page is the program.

It queries the NYC Childcare Hub ArcGIS feature layer for the providers inside the current
map view, then renders them as pins (grouped per location) and a results list.

## Commands

```sh
./serve.sh                 # serve on http://localhost:8000 and open a browser
./serve.sh 9000            # pick a port
node --check app.js        # the only syntax check that exists
sh -n serve.sh             # shell syntax
```

There is no build, test runner, linter, or dependency install. `?basemap=osm` and
`?tiles=<https-template>` override the basemap for one visit without editing anything.

**Test over HTTP, never `file://`.** A `file://` page sends no `Referer`, and the OSM raster
basemap answers referer-less requests with a 403 "Access blocked" tile image (served as HTTP
200, so it looks like a rendering bug). See [README](README.md#tile-usage-policy).

### Definition of done

`node --check app.js` passes, the page loads over HTTP with **no console errors**, and the
interaction you touched works. That means actually exercising it: pan/zoom, change each
filter, drag the age slider, type in the text box, click a pin, click a row, and narrow the
window to mobile width.

## Layout and ownership

The file list itself is in [README](README.md#files). The boundaries worth knowing:

- **Filter controls are built in `app.js`, not `index.html`** — the markup holds empty
  containers that `buildFilterControls()` fills.
- **The filter panel folds via `#filters-body`**, hidden by the `#filters-toggle` button in
  its `<h2>`. The state lives in that button's `aria-expanded` (no body class, no storage);
  the active icon is picked from that attribute in CSS, so the swap is script-free. The
  button is icon-only — the "Filters" text is a `.sr-only` span inside it, which is what
  names both the button and the section.
- **The two toggle icons are `<img>`, not inline SVG**, so they cannot inherit
  `currentColor`; they render the black baked into the files in `icons/` (Font Awesome
  Free, CC BY 4.0 — see the README Credits section). Colour feedback has to come from the
  button's background. Inlining the paths would be the way to get a colour-following icon.

- **`styles.css` owns presentation, except `--row-height`**, which `app.js` writes at init
  (see the list invariants). It is not a free-standing style value.
- **`app.js` is one flat classic script** — no modules, no bundler. Top-level `function`
  declarations become globals, which is handy for driving the app from a console but means
  name collisions fail silently.

`app.js` runs in dependency order: constants → helpers → query building → fetch → grouping →
rendering → popups → interaction → init.

## Invariants

Everything below fails **silently** when broken. Each has already cost time once.

### The results list is virtualized

Only rows near the scroll position exist in the DOM (~11–19 rows, ~90 nodes; ~1,000 nodes
for the whole page, against ~16,900 and ~18,000 when every row was rendered).

- **`ROW_HEIGHT` is the single source of truth.** It is written into the `--row-height` CSS
  variable at init, and `#list-sizer`'s height plus every row offset derive from it.
  Changing the card's CSS height without changing `ROW_HEIGHT` silently misplaces rows.
- Index arithmetic only holds because every row is exactly `ROW_HEIGHT` tall — which is why
  `.card` fixes its height and clips overflow with an ellipsis rather than wrapping. Do not
  let card content wrap.
- `#list-sizer` alone defines the scroll range. `#list-rows` is absolutely positioned and
  slid with `transform: translateY(start * ROW_HEIGHT)`, so it contributes no height.
- **A row outside the window does not exist.** Never reach for a row with `findCard(fid)`
  unless you know it is rendered — resolve the index with `rowIndex(fid)` and call
  `revealRow(fid)` first. `setActive()` does exactly this.
- **Anything that resizes `#result-list` must re-run `renderWindow()`.** The window is
  derived from `clientHeight`, so growing the list (collapsing the filter panel) leaves the
  newly exposed space blank until something else triggers a render. `onListScroll()` covers
  scrolling; the filters toggle calls `renderWindow()` itself.
- `renderList()` must move the scroll position to the selected row **before** rendering, and
  highlight it after. Reversing that order loses the highlight for off-screen rows.
- Scrolling is rAF-throttled through `onListScroll()`. Do not render the window synchronously
  from the `scroll` handler.

### Rows are assembled as HTML strings

- `cardHtml()` concatenates markup, so **`escapeHtml()` is load-bearing**: `NAME` and
  `ADDRESS` come from the data service, not from us.
- Clicks are **delegated** to one listener on `#result-list`. Rows are replaced wholesale and
  only a handful exist at a time, so per-row listeners would both leak and miss.
- Clicking a pin that covers several programmes deliberately does **not** change the
  selection — the popup lists them and the user picks one. That is intentional, not a bug.

### Pins are grouped by proximity, never by rounding

`buildGroups()` runs union-find over a spatial hash with `GROUP_RADIUS_M`.

**Do not replace this with coordinate rounding.** The five records at `941 WASHINGTON AVE,
BROOKLYN 11225` are stored at differing precision, ~0.3 m apart: rounding to 6 decimals
splits them `4 + 1`, and rounding to 4 decimals splits them again because they straddle the
boundary. Measured separation in the data:

| Pair distance | Share the same address |
| --- | --- |
| 0–1 m | 84.9% (31,003 of 36,521) |
| 1–2 m | no pairs exist at all |
| 2–5 m | 0% (4 pairs) |
| 5–10 m | 0% (375 pairs) |

Every same-address pair is under a metre apart; no two different addresses are closer than
~2 m. Hence `GROUP_RADIUS_M = 4` — above the jitter, below the merge point. Grouping 2,000
records takes ~10 ms.

### Basemap

`addBasemap()` prefers OpenFreeMap (vector, via MapLibre) and **falls back to OSM raster
when WebGL is absent or the MapLibre CDN fails — without downloading MapLibre at all**. Keep
that path working; it is the compatibility guarantee.

The OSM tile-policy rules are a contract, not decoration. Regressing any of these risks the
fallback being blocked:

- exact host, no subdomain: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
- `© OpenStreetMap contributors` visible, and never hidden behind UI (the mobile sidebar
  stops above it via `--attribution-height`)
- no `Cache-Control: no-cache` / `Pragma: no-cache` on tile requests
- no prefetch / pre-seed / offline feature (measured: 24 tiles for the initial view, ~4 per pan)
- `referrerPolicy: 'strict-origin-when-cross-origin'` left in place, in both the meta tag and
  the tile layer

### Inspection links are omitted unless they point at the provider

`OCFS_INSPECTURL` and `DOHMH_INSPECTION_URL` do not always address the provider's own
record — for many they are only the agency's search page (`https://hs.ocfs.ny.gov/DCFS/`,
`https://a816-healthpsi.nyc.gov/ChildCare/`). A search form is not something the user can
act on, so **those are dropped entirely** rather than shown under a vague label.

- `isRecordSpecificLink()` decides from the URL shape: a query parameter, or an id as the
  last path segment (e.g. `…/GetProgramInfo/880314`, `?facilityBIN=…`).
- `detailNode()` only emits the link when that returns true. Both agencies are treated the
  same way.
- Do not hard-code agency-specific URL paths. The heuristic was checked against all 18,904
  URLs in the dataset and agrees with the literal `GetProgramInfo`/`facilityBIN` patterns on
  every one.
- Measured effect: 6,927 of 20,068 records lose their link, leaving **40%** with no
  inspection link at all (Home 46%, Center 19%, School 70%). That is the intended
  trade-off — the alternative was linking every one of them to a search box.

### The mobile map dim is a fixed scrim, not a shadow

While the sidebar is open on narrow screens, `body::before` dims the map (z-index 1100 —
below the sidebar at 1150 and below the attribution at 1200, so the OSM credit stays
legible). It is deliberately **not** a `box-shadow` on `#sidebar`: a shadow is anchored to
its element, so translating the sidebar off-screen (`translateX(-102%)`) dragged the dim
across the whole viewport and darkened the map permanently, open or closed.

### The mobile drawer shares the map's grid row

On narrow screens `#app` is a single-column grid (`top` / `body`) and `#sidebar` is a grid
item in the `body` row alongside `#map-wrap`, stretched down to `margin-bottom:
var(--attribution-height)` so the OSM credit stays clear of it.

**Do not go back to `position: absolute; top: 0` against the viewport.** That anchored the
drawer at the top of the page, i.e. *above* the search field, while the top bar paints over
it (1200 vs 1150) — the first ~115px of the sidebar (the search box and the top of Care
type) was covered and unreachable at any scroll position. Sharing the row starts the drawer
at the top bar's bottom edge and tracks its height, including when the status line rewraps,
with no measured value to go stale.

## Tuning

All at the top of `app.js` unless noted.

| Constant | Default | Meaning |
| --- | --- | --- |
| `MAX_FEATURES` | `2000` | Providers fetched per map view (the service's page size) |
| `PAGE_SIZE` | `2000` | Records per request; must not exceed the layer's `maxRecordCount` |
| `DEBOUNCE_MS` | `400` | Quiet period after pan/zoom before querying |
| `GROUP_RADIUS_M` | `4` | Proximity clustering radius, in metres |
| `ROW_HEIGHT` | `82` | Results-list row height in px; mirrors `--row-height` |
| `ROW_OVERSCAN` | `8` | Extra rows rendered above and below the viewport |
| `BASEMAP` | `'openfreemap'` | `'openfreemap'` or `'osm'` |
| `OSM_TILE_URL` | `tile.openstreetmap.org` | Raster tile template; `?tiles=` overrides |
| `OPENFREEMAP_STYLE` | Liberty | MapLibre style URL |
| `CONTACT_URL` | this repo's Issues | Hides itself while it contains `YOUR-USERNAME` |
| `CARE_COLORS` / `CARE_TYPES` / `SETTINGS` | — | Marker colours and the filter vocabularies |

`MAX_FEATURES` is the main trade-off: raising it shows more providers when zoomed out, at the
cost of more requests and a heavier first paint. The list no longer cares (it is virtualized),
but `buildGroups()` and `renderMarkers()` still scale with it.

## Measured baselines

Useful for telling a real regression from noise. Measured in headless Chromium, cache
disabled — **caching bites**: a stale `styles.css` once made a fix look ineffective.

| | value |
| --- | --- |
| Results list, 2,000 providers | ~11–19 rows / ~90 nodes (was 16,898) |
| Whole page, 2,000 providers | ~1,000 nodes (was ~18,000) |
| Longest main-thread task on a filter change | 0 ms (was 242 ms) |
| `buildGroups()`, 2,000 records | ~10 ms |
| Initial view tile requests | 24 (OSM raster fallback) |

A Firefox profile of zooming showed the tab's own JS at **under 1%** of samples, with
password-manager extensions walking the DOM (`NodeFilter.acceptNode`) for ~1.2 s — which is
why node count matters more than our own render cost.

## Data

The dataset's quirks (units, `maxRecordCount`, null handling, community districts, ages in
months) and the ArcGIS query notes are documented once, in
[README](README.md#data-source) — read them before changing `buildWhere()` or `OUT_FIELDS`.
