# NYC Childcare Finder

An interactive map of NYC childcare providers — 3-K, Pre-K, Head Start, Early Head
Start, public-school infant care, toddler programs and private care — across all five
boroughs.

Intended to be a replacement to https://finder.nyc.gov/childcarenyc/locations?mView=map
which has major performance issues preventing it from being usable.
My guess is too much react rendering and not enough virtualization. Anyway, this thing uses
the same API but is just a replacement front-end. FWIW, this is entirely vibe-coded.
This paragraph is the only part I've edited manually.


**No build step, no framework, no dependencies to install.** Plain HTML/CSS/JS with
Leaflet from a CDN, served by a one-line static server.

> Contributing or working on the code? Read **[AGENTS.md](AGENTS.md)** — it covers the
> commands, the code's invariants, and the traps that fail silently. This file is for
> people using and deploying the site.

## Running it

```sh
./serve.sh            # then open http://localhost:8000
./serve.sh 9000       # or pick a port
```

`serve.sh` starts Python's built-in static server on loopback, opens your browser, and
stops with `Ctrl+C`. It needs nothing but Python 3 — no npm, no build.

Then open **<http://localhost:8000>**.

### Why a server rather than just opening the file?

OpenStreetMap's tile server enforces its [Tile Usage
Policy](https://operations.osmfoundation.org/policies/tiles/) and refuses requests that
arrive **without an HTTP `Referer`**, answering with a *"403r Access blocked — App is not
following the tile usage policy"* image instead of map tiles. A page opened as
`file://` cannot send a `Referer`, so the map can come up blank or covered in block
tiles. Served over `http://localhost` the browser sends `Referer: http://localhost:8000/`
and the tiles load.

Opening `index.html` directly still works most of the time — see
[Tile usage policy](#tile-usage-policy) if it doesn't.

Other servers work equally well if you prefer: `php -S localhost:8000`, `npx serve`, or
anything else that serves this folder over HTTP.

## Deploying to GitHub Pages

The site is plain static files, so GitHub Pages serves it directly.

1. **Create the repository and push.**

   ```sh
   git init -b main
   git add .
   git commit -m "NYC childcare map"
   git remote add origin git@github.com:<you>/<repo>.git
   git push -u origin main
   ```

2. **Turn on Pages.** Repository → *Settings* → *Pages* → *Source*: "Deploy from a branch"
   → Branch `main`, folder `/ (root)` → Save. The site appears at
   `https://<you>.github.io/<repo>/` within a minute or two.

3. **Contact link — already set.** `CONTACT_URL` in `app.js` points at
   `https://github.com/theindexer/nyc-daycare/issues`, which the sidebar footer links to.
   The tile policy asks public sites to be contactable so OpenStreetMap can reach you
   before taking any action. If you ever fork or rename the repo, update this constant —
   while it contains `YOUR-USERNAME` the link hides itself rather than shipping a dead
   `href="#"`.

No build step, no Actions workflow and no `gh-pages` branch are needed — `.nojekyll` is
already present so GitHub serves the files as they are.

### Notes for a public deployment

- **Relative paths** are used throughout (`app.js`, `styles.css`), so the site works
  unchanged at `https://<you>.github.io/<repo>/`.
- **The data service is queried per map view.** Each pan runs a count query plus a small
  page fetch against NYC's public ArcGIS feature layer. That is fine at community scale,
  but it is the part to watch if the site ever gets popular — unlike map tiles, there is no
  cache in front of it.
- **Tiles.** The default OpenFreeMap basemap explicitly permits unlimited use. If you
  switch to `?basemap=osm`, re-read [Basemaps](#basemaps): OSM's policy forbids heavy use,
  and a public site is exactly the sort of client it may block without notice.

## Features

- **Map view of providers** on OpenStreetMap tiles, coloured by care type, with a legend.
- **One pin per location.** Providers that share a coordinate — a daycare registered
  under several programmes, which is 70% of the records — collapse into a single pin
  carrying the count. Clicking it lists every programme at that address; clicking one
  opens its full details. Single-provider locations stay as plain dots.
- **Viewport loading** — only the providers inside the current map view are fetched, so
  each request stays small (a typical neighbourhood view is ~40 KB–500 KB and returns in
  well under a second). Pan or zoom and the view reloads automatically.
- **Filters** (applied server-side, so they work across the whole city rather than only
  what is loaded):
  - Care type (Pre-K, 3-K, Head Start, Early Head Start, Infant Care, 2-K & Other Toddler, Private)
  - Setting (Center, Home-based, School, Not specified)
  - Child's age — an "Any age / Specific age" toggle; choosing *Specific age* reveals a
    month slider ("show me providers who accept an 18-month-old"). The slider exists only
    while it applies, so no control is ever greyed out.
  - Borough and community district
- **Results list** beside the map, with a text box that filters the providers already
  loaded in the view by name, address or ZIP.
- **Detail popup** per provider: care type, setting, ages accepted, phone, email, hours,
  year schedule, eligibility, cost, district, and links to the provider website,
  MySchools, OCFS inspections, DOHMH inspections and Google Maps directions.
- **Two-way selection** — clicking a list entry flies the map to that provider; clicking a
  marker highlights and reveals its entry in the list.
- Responsive: side-by-side on desktop, an overlay panel behind a toggle button on mobile.

## Basemaps

The map can run on either of two free, keyless tile sources. `BASEMAP` at the top of
`app.js` selects between them, and `?basemap=` overrides it per visit.

| | `openfreemap` (default) | `osm` (fallback) |
| --- | --- | --- |
| Tiles | Vector, rendered by MapLibre | Raster PNG |
| Terms | Public instance is "completely free: no limits on the number of map views or requests", no registration, no API keys, no cookies; **commercial use allowed** | [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/) — must not be heavy use; served best-effort, blockable without notice |
| Cost of entry | +~250 KB gzipped (MapLibre GL) | None |
| Requires WebGL | Yes | No |
| Style | OpenMapTiles "Liberty" | OpenStreetMap Carto |

**Why OpenFreeMap is the default:** it is the only one of the two that explicitly permits
unlimited public use. OSM's volunteer raster servers are funded by donations and their
policy forbids heavy use, so a site that grows can be blocked without notice — taking the
map down for every visitor at once. OpenFreeMap removes that particular risk.

**The fallback is automatic.** If WebGL is missing, or MapLibre or its CDN cannot be
reached, the app quietly switches to OpenStreetMap raster tiles without even downloading
MapLibre. Verified: with WebGL unavailable the page falls back, loads 24 raster tiles from
`tile.openstreetmap.org`, renders all providers, and makes zero MapLibre requests.

```sh
./serve.sh                            # OpenFreeMap (default)
./serve.sh && open 'http://localhost:8000/?basemap=osm'   # force raster
```

## Tile usage policy

This section matters for the `osm` raster basemap, and for the fallback path.

If the map shows black-and-yellow *"Access blocked"* tiles, OpenStreetMap is refusing your
tile requests. This is enforced by OSM, not by this app, and the officially documented
causes are:

1. **No `Referer`** — the usual cause, and the one this project hits when opened as
   `file://`. Fix: run `./serve.sh` and use `http://localhost:8000`.
2. **A restrictive `Referrer-Policy`** — some tools and privacy extensions (Brave Shields,
   uBlock, anti-tracker/cookie plugins) strip the `Referer` header. `index.html` sets
   `<meta name="referrer" content="strict-origin-when-cross-origin">` and the Leaflet tile
   layer sets `referrerPolicy: 'strict-origin-when-cross-origin'` to prevent the page
   itself from stripping it; if you still see block tiles, try allowlisting the site or
   disabling the extension.
3. **Too much traffic** — OSM's servers are volunteer-run and they block clients that
   generate heavy traffic. Panning far and fast generates many tile requests.

Blocks are usually served as HTTP `200` with an error *image*, so the failure looks like a
blank or half-drawn map rather than a network error. OSM describes enforcement as a
"brownout" — only some tiles fail, which is why the map can look partly fine.

## Data source

NYC Childcare Hub data published as an ArcGIS feature layer:

```
https://services6.arcgis.com/yG5s3afENB5iO9fj/arcgis/rest/services/PROD_childcarenyc/FeatureServer/0
```

20,076 point records, one layer. The service sends `Access-Control-Allow-Origin: *`, which
is why the data loads even from `file://`.

### Query notes

These were verified against the live service and are worth knowing if you change
`app.js`:

- **`distance` is in the layer's units, i.e. metres.** The layer is in Web Mercator
  (`wkid 102100/3857`), so a query like

  ```
  .../query?where=1=1&geometry={"x":-73.9704832,"y":40.665088}
            &distance=16&geometryType=esriGeometryPoint&inSR=4326
  ```

  searches a **16-metre** radius and returns nothing. For 16 miles add
  `&units=esriSRUnit_StatuteMile`, which returns 19,604 of the 20,076 records.

- The map itself uses an **envelope** query rather than a distance query, which is the
  natural fit for a pan/zoom interface:

  ```
  geometry=west,south,east,north&geometryType=esriGeometryEnvelope
  &inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects
  ```

- **`outSR=4326`** matters: it returns WGS84 lon/lat coordinates that Leaflet can use
  directly, instead of the layer's native Web Mercator.

- **`maxRecordCount` is 2000**, so `MAX_FEATURES` in `app.js` caps a view at 2,000
  providers (one page) and the UI says so when a view is truncated. Paginate with
  `resultOffset` plus `orderByFields=FID ASC` — without the explicit ordering,
  paged responses can overlap.

- **`CARETYPE_GROUP` is never null**, but `SETTINGTYPE_STD` is null in 87 records and an
  empty string in 6, so "Not specified" maps to
  `(SETTINGTYPE_STD IS NULL OR SETTINGTYPE_STD = '')`.

- **Community districts are read from the data** rather than hardcoded, because Queens
  contains a district code (`481`) that does not follow the usual
  `borough * 100 + district` pattern used by the other four boroughs.

- Ages are stored in **months** (`AGEMIN` 0–48, `AGEMAX` 23–71), with the human-readable
  `AGEMIN_YEAR` / `AGEMAX_YEAR` used for display.

### Inspection links: OCFS or DOHMH, not both

Which regulator a provider links to is determined by its setting type, not chosen by the
app. The two fields are effectively mutually exclusive — only **7 of 20,071** records
carry both, and those are one provider whose OCFS link is just the agency's front page.

| Setting | OCFS | DOHMH | neither |
| --- | --- | --- | --- |
| Home (family day care) | 12,826 | 0 | 0 |
| Center | 42 | 5,550 | 0 |
| School | 0 | 472 | 1,081 |
| (blank) | 0 | 0 | 93 |

That mirrors how childcare is actually regulated in New York: home-based family and group
family day care is licensed by the **state** Office of Children and Family Services, while
**city** DOHMH permits and inspects centres. School-age programmes have no link at all in
about two thirds of cases. The 42 centre records pointing at OCFS are genuine outliers
(all `Private`).

**Not all of these links are inspection records.** Some point at the provider's own record;
others are only the agency's search page:

| Agency | Record-specific link | Search page only |
| --- | --- | --- |
| OCFS | 7,028 | 5,847 |
| DOHMH | 4,942 | 1,087 |

The popup labels these two cases differently; see [AGENTS.md](AGENTS.md) for the rule.

### Duplicate coordinates

An address is geocoded once, so all of a daycare's programme registrations land on the
same point — and often on exactly the same coordinate:

| | |
| --- | --- |
| Records | 20,071 |
| Distinct coordinates | 10,442 |
| Coordinates holding more than one record | 4,360 |
| Records sitting on a shared coordinate | 13,989 (**70%**) |
| Largest single coordinate | 51 records |

Most shared coordinates hold one daycare's several programmes (2,700 of them share a
single name). The rest hold unrelated businesses, and the big ones are **bad geocodes**:
the 51-record point spans 13 different names across 3 different addresses, so grouping
also acts as a sanity check on the data — a pin reading "51 programs at this address" is
a data problem, not a real cluster.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Markup: header, filter/results sidebar, map container |
| `styles.css` | Layout and styling |
| `app.js` | All logic: query building, fetching, map/marker and list rendering |
| `serve.sh` | Serves this folder on `http://localhost` (needs only Python 3) |
| `AGENTS.md` | Engineering notes for whoever changes the code — commands, invariants, traps |
