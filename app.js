/* NYC Childcare Finder — vanilla JS, no build step, no framework.
 *
 * Data: NYC "ChildcareNYC" ArcGIS feature layer (20,076 point records).
 * Strategy: query only the providers inside the current map view, so each
 * request stays small and fast; re-run on pan/zoom (debounced).
 */
'use strict';

/* ------------------------------------------------------------------ config */

var API_URL = 'https://services6.arcgis.com/yG5s3afENB5iO9fj/arcgis/rest/services/PROD_childcarenyc/FeatureServer/0/query';

/* Basemaps. Both are keyless and cost nothing:
 *
 *   openfreemap - vector tiles rendered by MapLibre, attached to the Leaflet
 *     map through the official binding. Its public instance is explicitly free
 *     with "no limits on the number of map views or requests", no registration,
 *     no API keys and no cookies, and commercial use is allowed. That explicit
 *     permission is the point: it is the one thing OpenStreetMap's volunteer
 *     raster servers cannot offer a public site.
 *
 *   osm - OpenStreetMap's raster tiles. Needs no WebGL, so it covers every
 *     browser, but its policy forbids heavy use and permits blocking without
 *     notice. Kept as the fallback.
 *
 * Override with ?basemap=osm or ?basemap=openfreemap. The OSM raster URL is
 * itself overridable with ?tiles=<https-template>. */
var BASEMAP = 'openfreemap';

var OPENFREEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

/* Loaded in order: MapLibre, then the Leaflet binding that depends on it. */
var MAPLIBRE_ASSETS = [
  { kind: 'css', url: 'https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css' },
  { kind: 'js', url: 'https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js' },
  { kind: 'js', url: 'https://unpkg.com/@maplibre/maplibre-gl-leaflet/leaflet-maplibre-gl.js' }
];

var OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/* Attribution that is not supplied by the basemap itself. OpenStreetMap's tile
 * policy asks for the copyright credit and a "Report a map issue" link;
 * OpenFreeMap's style carries its own "OpenFreeMap © OpenMapTiles Data from
 * OpenStreetMap" credit, which the Leaflet binding forwards automatically. */
var SHARED_ATTRIBUTION =
  '<a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener">Report a map issue</a> · ' +
  'Provider data: <a href="https://www.nyc.gov/content/childcarehub/" target="_blank" rel="noopener">NYC Childcare Hub</a> / NYC DOE';

/* Contact for users and for OpenStreetMap operations — the tile policy asks
 * public sites to be contactable so they can be reached before any block.
 * Repoint this at your own repository's Issues page before deploying; the link
 * stays hidden while it is still the placeholder. See README, "Deploying". */
var CONTACT_URL = 'https://github.com/theindexer/nyc-daycare/issues';

var PAGE_SIZE = 2000;     // server maxRecordCount for this layer
var MAX_FEATURES = 2000;  // cap per map view, keeps the first paint snappy
var DEBOUNCE_MS = 400;    // wait after pan/zoom before querying

var OUT_FIELDS = [
  'FID', 'NAME', 'ADDRESS', 'ADDRESS2', 'CITY', 'STATE', 'ZIPCODE',
  'TELEPHONE1', 'EMAIL', 'CARETYPE_GROUP', 'CARETYPE_NAME', 'CARETYPE_URL',
  'SETTINGTYPE_STD', 'AGEMIN', 'AGEMAX', 'AGEMIN_YEAR', 'AGEMAX_YEAR',
  'YEARSCHEDULE', 'TYPEHOURS', 'ELIGIBILITY', 'COST', 'DOE_WEBSITE',
  'DOE_CONTACT_NAME', 'OCFS_INSPECTURL', 'MYSCHOOLS_URL', 'DOHMH_INSPECTION_URL',
  'COMMUNITYDISTRICT', 'COMMUNITYDISTRICTNUMBER', 'COMMUNITYDISTRICTBOROUGHCODE',
  'NTANAME', 'LATITUDE', 'LONGITUDE'
].join(',');

var UNSPECIFIED = '__unspecified__';

var CARE_TYPES = [
  'Pre-K', '3-K', 'Head Start', 'Early Head Start',
  'Infant Care (NYC Public Schools)', '2-K & Other Toddler', 'Private'
];

var CARE_COLORS = {
  'Pre-K': '#1d4ed8',
  '3-K': '#7c3aed',
  'Head Start': '#047857',
  'Early Head Start': '#0d9488',
  'Infant Care (NYC Public Schools)': '#db2777',
  '2-K & Other Toddler': '#ea580c',
  'Private': '#b45309'
};

var UNSPECIFIED_COLOR = '#64748b';

var SETTINGS = [
  { value: 'Center', label: 'Center' },
  { value: 'Home', label: 'Home-based' },
  { value: 'School', label: 'School' },
  { value: UNSPECIFIED, label: 'Not specified' }
];

var BOROUGHS = { 1: 'Manhattan', 2: 'Bronx', 3: 'Brooklyn', 4: 'Queens', 5: 'Staten Island' };

/* ------------------------------------------------------------------- state */

var state = {
  careTypes: new Set(CARE_TYPES),
  settings: new Set(SETTINGS.map(function (s) { return s.value; })),
  ageMonths: null,      // null = any age
  boroughCode: '',
  cdCode: '',
  text: '',
  providers: [],        // normalized records for the current view
  filtered: [],         // after the client-side text filter
  totalInView: 0,       // server-reported count (may exceed what we fetched)
  truncated: false,
  activeFid: null,
  popupKey: null,       // group popup to restore after markers are rebuilt
  pendingScroll: false, // bring the selected card back into view after a rebuild
  loading: false,
  error: null,
  token: 0              // guards against out-of-order responses
};

var map, markerLayer, renderer, activeMarker = null;
var groups = [];              // one entry per distinct coordinate in view
var markerByKey = new Map();  // group key -> marker
var groupByKey = new Map();   // group key -> group
var groupForFid = new Map();  // provider FID -> the group it belongs to
var moveTimer = null, textTimer = null, abortController = null;

var dom = {};

/* ----------------------------------------------------------------- helpers */

function $(id) { return document.getElementById(id); }

function setStatus(text, isError) {
  dom.status.textContent = text;
  dom.status.classList.toggle('is-error', !!isError);
}

function showError(message) {
  dom.mapErrorText.textContent = message;
  dom.mapError.hidden = false;
}

function hideError() { dom.mapError.hidden = true; }

function sqlQuote(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }

function colorFor(provider) {
  return CARE_COLORS[provider.CARETYPE_GROUP] || UNSPECIFIED_COLOR;
}

function settingLabel(value) {
  if (!value) return 'Not specified';
  for (var i = 0; i < SETTINGS.length; i++) {
    if (SETTINGS[i].value === value) return SETTINGS[i].label;
  }
  return value;
}

function formatMonths(months) {
  var m = Math.round(months);
  if (m < 12) return m === 1 ? '1 month' : m + ' months';
  var years = Math.floor(m / 12), rest = m % 12;
  var y = years === 1 ? '1 year' : years + ' years';
  if (!rest) return y;
  return y + ' ' + (rest === 1 ? '1 month' : rest + ' months');
}

function formatCount(n) { return n.toLocaleString('en-US'); }

/* A record is usable only if it has finite coordinates. */
function normalize(feature) {
  var p = feature.properties || {};
  var coords = feature.geometry && feature.geometry.coordinates;
  var lng = coords ? Number(coords[0]) : Number(p.LONGITUDE);
  var lat = coords ? Number(coords[1]) : Number(p.LATITUDE);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  var out = { fid: p.FID, lat: lat, lng: lng };
  for (var key in p) {
    if (Object.prototype.hasOwnProperty.call(p, key)) out[key] = p[key];
  }
  return out;
}

/* -------------------------------------------------------- query construction */

/* Builds the server-side WHERE clause from the filter state. */
function buildWhere() {
  var clauses = [];

  if (state.careTypes.size === 0) return null; // nothing selected
  if (state.careTypes.size < CARE_TYPES.length) {
    var types = [];
    state.careTypes.forEach(function (t) { types.push('CARETYPE_GROUP = ' + sqlQuote(t)); });
    clauses.push('(' + types.join(' OR ') + ')');
  }

  if (state.settings.size === 0) return null;
  if (state.settings.size < SETTINGS.length) {
    var named = [], wantsUnspecified = false;
    state.settings.forEach(function (s) {
      if (s === UNSPECIFIED) wantsUnspecified = true;
      else named.push(sqlQuote(s));
    });
    var parts = [];
    if (named.length) parts.push('SETTINGTYPE_STD IN (' + named.join(',') + ')');
    if (wantsUnspecified) parts.push("(SETTINGTYPE_STD IS NULL OR SETTINGTYPE_STD = '')");
    if (!parts.length) return null;
    clauses.push('(' + parts.join(' OR ') + ')');
  }

  if (state.ageMonths !== null) {
    clauses.push('AGEMIN <= ' + Number(state.ageMonths));
    clauses.push('AGEMAX >= ' + Number(state.ageMonths));
  }

  if (state.boroughCode !== '') {
    clauses.push('COMMUNITYDISTRICTBOROUGHCODE = ' + Number(state.boroughCode));
    if (state.boroughCode !== '0' && state.cdCode !== '') {
      clauses.push('COMMUNITYDISTRICT = ' + Number(state.cdCode));
    }
  }

  return clauses.length ? clauses.join(' AND ') : '1=1';
}

/* The policy asks that the tile URL not be hard-coded. Only accept an https
 * template carrying all three placeholders, so a bad value cannot break the map. */
function tileUrl() {
  var override = '';
  try {
    override = new URLSearchParams(window.location.search).get('tiles') || '';
  } catch (error) {
    override = '';
  }
  var complete = /^https:\/\//.test(override) &&
    override.indexOf('{z}') !== -1 && override.indexOf('{x}') !== -1 && override.indexOf('{y}') !== -1;
  return complete ? override : OSM_TILE_URL;
}

function basemapChoice() {
  var choice = '';
  try {
    choice = new URLSearchParams(window.location.search).get('basemap') || '';
  } catch (error) {
    choice = '';
  }
  return (choice === 'osm' || choice === 'openfreemap') ? choice : BASEMAP;
}

function webglAvailable() {
  try {
    var probe = document.createElement('canvas');
    return !!(window.WebGLRenderingContext &&
      (probe.getContext('webgl') || probe.getContext('experimental-webgl')));
  } catch (error) {
    return false;
  }
}

function loadAsset(asset) {
  return new Promise(function (resolve, reject) {
    var element;
    if (asset.kind === 'css') {
      element = document.createElement('link');
      element.rel = 'stylesheet';
      element.href = asset.url;
    } else {
      element = document.createElement('script');
      element.src = asset.url;
    }
    element.onload = function () { resolve(); };
    element.onerror = function () { reject(new Error('could not load ' + asset.url)); };
    document.head.appendChild(element);
  });
}

function addRasterBasemap() {
  L.tileLayer(tileUrl(), {
    maxZoom: 19,
    referrerPolicy: 'strict-origin-when-cross-origin',
    attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> · ' +
      SHARED_ATTRIBUTION
  }).addTo(map);
}

/* MapLibre is a large bundle, so it is only fetched when it will be used, and
 * any failure (no WebGL, blocked CDN) quietly degrades to raster tiles. */
function addBasemap() {
  if (basemapChoice() !== 'openfreemap' || !webglAvailable()) {
    addRasterBasemap();
    return;
  }

  MAPLIBRE_ASSETS.reduce(function (chain, asset) {
    return chain.then(function () { return loadAsset(asset); });
  }, Promise.resolve()).then(function () {
    if (typeof L.maplibreGL !== 'function') throw new Error('maplibre Leaflet binding missing');
    map.attributionControl.addAttribution(SHARED_ATTRIBUTION);
    L.maplibreGL({ style: OPENFREEMAP_STYLE }).addTo(map);
  }).catch(function () {
    addRasterBasemap();
  });
}

function arcgis(params, signal) {
  var url = API_URL + '?' + new URLSearchParams(params).toString();
  return fetch(url, { signal: signal, credentials: 'omit' }).then(function (res) {
    if (!res.ok) throw new Error('The data service responded with HTTP ' + res.status + '.');
    return res.json();
  }).then(function (data) {
    if (data && data.error) {
      throw new Error(data.error.message || 'The data service rejected the query.');
    }
    return data;
  });
}

/* --------------------------------------------------------------- data load */

function loadView() {
  var token = ++state.token;
  if (abortController) abortController.abort();
  var controller = new AbortController();
  abortController = controller;

  var where = buildWhere();
  if (where === null) {
    state.providers = [];
    state.filtered = [];
    state.totalInView = 0;
    state.truncated = false;
    state.activeFid = null;
    state.popupKey = null;
    state.pendingScroll = false;
    state.loading = false;
    state.error = null;
    setStatus('No providers selected — pick at least one care type and setting.', false);
    hideError();
    renderAll();
    return;
  }

  state.loading = true;
  state.error = null;
  setStatus('Loading…', false);
  hideError();

  var bounds = map.getBounds();
  var common = {
    where: where,
    geometry: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects'
  };

  arcgis(Object.assign({ f: 'json', returnCountOnly: 'true' }, common), controller.signal)
    .then(function (countResult) {
      var total = countResult.count || 0;
      var take = Math.min(total, MAX_FEATURES);
      var requests = [];
      for (var offset = 0; offset < take; offset += PAGE_SIZE) {
        requests.push(arcgis(Object.assign({
          f: 'geojson',
          outFields: OUT_FIELDS,
          returnGeometry: 'true',
          orderByFields: 'FID ASC',
          resultOffset: String(offset),
          resultRecordCount: String(Math.min(PAGE_SIZE, take - offset))
        }, common), controller.signal));
      }
      return Promise.all(requests).then(function (pages) {
        return { total: total, pages: pages };
      });
    })
    .then(function (result) {
      if (token !== state.token) return; // a newer request already superseded this one
      var providers = [];
      result.pages.forEach(function (page) {
        (page.features || []).forEach(function (feature) {
          var record = normalize(feature);
          if (record) providers.push(record);
        });
      });
      state.providers = providers;
      state.totalInView = result.total;
      state.truncated = result.total > providers.length;

      // Keep the current selection only while its provider is still in view.
      var stillVisible = providers.some(function (p) { return p.fid === state.activeFid; });
      if (!stillVisible) {
        state.activeFid = null;
        state.pendingScroll = false;
      }
      // state.popupKey is deliberately left alone here: it belongs to a
      // location, not a provider, and restorePopup() clears it if that
      // location is no longer in the new set.

      state.loading = false;
      state.error = null;
      applyTextFilter();
      setStatus(describeStatus(), false);
    })
    .catch(function (error) {
      if (token !== state.token || error.name === 'AbortError') return;
      state.loading = false;
      state.error = error.message || 'request failed';
      renderResultsMeta();
      setStatus('Could not load providers.', true);
      showError(error.message || 'Could not reach the childcare data service. Check your connection and try again.');
    });
}

function describeStatus() {
  var shown = state.providers.length;
  if (state.totalInView === 0) return 'No providers match in this view.';
  if (state.truncated) {
    return 'Showing ' + formatCount(shown) + ' of ' + formatCount(state.totalInView) +
      ' providers in this view — zoom in to see the rest.';
  }
  return 'Showing ' + formatCount(shown) + ' of ' + formatCount(state.totalInView) +
    ' provider' + (state.totalInView === 1 ? '' : 's') + ' in this view.';
}

/* ------------------------------------------------------- client-side filter */

function applyTextFilter() {
  var needle = state.text.trim().toLowerCase();
  if (!needle) {
    state.filtered = state.providers.slice();
  } else {
    state.filtered = state.providers.filter(function (p) {
      return [p.NAME, p.ADDRESS, p.ADDRESS2, p.ZIPCODE, p.CITY, p.NTANAME].some(function (field) {
        return field && String(field).toLowerCase().indexOf(needle) !== -1;
      });
    });
  }
  buildGroups();
  renderAll();
}

/* ---------------------------------------------------------------- grouping */

/* A provider's address is geocoded once, so a daycare's several programme
 * registrations land on the same spot — but not always on the same coordinate:
 * the source stores them at differing precision, so copies of one address can
 * sit a fraction of a metre apart. Cluster by proximity rather than by rounding
 * to a grid, because rounding splits neighbours that straddle a cell boundary
 * (at 6 decimals "941 WASHINGTON AVE" splits 4 + 1; at 4 decimals it splits
 * again). Measured against the data, same-address points are always within 1 m
 * of each other and different addresses are never closer than ~2 m, so a few
 * metres is both sufficient and safe. See README, "Duplicate coordinates". */
var GROUP_RADIUS_M = 4;
var METERS_PER_DEG_LAT = 111320;

function metersBetween(aLat, aLng, bLat, bLng) {
  var dLat = (aLat - bLat) * METERS_PER_DEG_LAT;
  var dLng = (aLng - bLng) * METERS_PER_DEG_LAT * Math.cos(aLat * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function buildGroups() {
  var previous = groupByKey;
  groupByKey = new Map();
  groupForFid = new Map();
  groups = [];

  var items = state.filtered;
  var count = items.length;
  if (!count) return;

  // Union-find over points, joined when they fall within GROUP_RADIUS_M.
  var parent = new Array(count);
  for (var i = 0; i < count; i++) parent[i] = i;

  function find(index) {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  }

  // Spatial hash so each point is only compared with its immediate neighbours.
  var cellDeg = GROUP_RADIUS_M / METERS_PER_DEG_LAT;
  var buckets = new Map();
  for (var b = 0; b < count; b++) {
    var cellKey = Math.floor(items[b].lat / cellDeg) + ':' + Math.floor(items[b].lng / cellDeg);
    var bucket = buckets.get(cellKey);
    if (bucket) bucket.push(b);
    else buckets.set(cellKey, [b]);
  }

  for (var a = 0; a < count; a++) {
    var pointA = items[a];
    var row = Math.floor(pointA.lat / cellDeg);
    var col = Math.floor(pointA.lng / cellDeg);
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        var neighbours = buckets.get((row + dy) + ':' + (col + dx));
        if (!neighbours) continue;
        for (var n = 0; n < neighbours.length; n++) {
          var other = neighbours[n];
          if (other <= a) continue;
          var pointB = items[other];
          if (metersBetween(pointA.lat, pointA.lng, pointB.lat, pointB.lng) <= GROUP_RADIUS_M) {
            var rootA = find(a);
            var rootB = find(other);
            if (rootA !== rootB) parent[rootB] = rootA;
          }
        }
      }
    }
  }

  // Items arrive in FID order, so the first member seen is the group's lowest
  // FID — a key that stays stable while that provider remains in view.
  var groupByRoot = new Map();
  for (var m = 0; m < count; m++) {
    var root = find(m);
    var group = groupByRoot.get(root);
    if (!group) {
      var anchor = items[m];
      var key = 'g' + anchor.fid;
      var old = previous.get(key);
      group = {
        key: key,
        lat: anchor.lat,
        lng: anchor.lng,
        providers: [],
        color: UNSPECIFIED_COLOR,
        // Carry a drilled-in selection across a rebuild: clicking a list entry
        // reloads the view, and the popup should reopen on that programme.
        detailFid: old ? old.detailFid : null
      };
      groupByRoot.set(root, group);
      groupByKey.set(key, group);
      groups.push(group);
    }
    group.providers.push(items[m]);
    groupForFid.set(items[m].fid, group);
  }

  groups.forEach(function (group) { group.color = dominantColor(group.providers); });
}

/* Colour a shared pin by whichever care type it holds the most of. */
function dominantColor(providers) {
  var tally = new Map();
  providers.forEach(function (p) {
    if (!p.CARETYPE_GROUP) return;
    tally.set(p.CARETYPE_GROUP, (tally.get(p.CARETYPE_GROUP) || 0) + 1);
  });
  var best = null, bestCount = 0;
  CARE_TYPES.forEach(function (type) {
    var count = tally.get(type) || 0;
    if (count > bestCount) { best = type; bestCount = count; }
  });
  return best ? CARE_COLORS[best] : UNSPECIFIED_COLOR;
}

/* --------------------------------------------------------------- rendering */

function renderAll() {
  renderMarkers();
  renderList();
  renderResultsMeta();
}

function currentRadius() {
  return Math.max(2.5, Math.min(9, map.getZoom() - 6));
}

/* Count badges grow with the number of programmes they stand for. */
function badgeDiameter(count) {
  return Math.round(20 + Math.min(16, Math.log(count) / Math.LN2 * 3));
}

function badgeIcon(group) {
  var size = badgeDiameter(group.providers.length);
  var label = group.providers.length > 99 ? '99+' : String(group.providers.length);
  return L.divIcon({
    className: 'pin-badge',
    html: '<span style="background:' + group.color + '">' + label + '</span>',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2]
  });
}

function renderMarkers() {
  // Drop stale references before tearing down, so the popupclose events that
  // teardown fires are recognised as "marker replaced", not "user dismissed".
  markerByKey = new Map();
  activeMarker = null;
  markerLayer.clearLayers();
  var radius = currentRadius();

  groups.forEach(function (group) {
    var marker;
    if (group.providers.length === 1) {
      // Single provider: stay on the canvas renderer, which is much cheaper
      // than a DOM element for the thousands of pins a view can hold.
      marker = L.circleMarker([group.lat, group.lng], {
        renderer: renderer,
        radius: radius,
        weight: 1,
        color: '#ffffff',
        fillColor: group.color,
        fillOpacity: 0.9
      });
    } else {
      marker = L.marker([group.lat, group.lng], { icon: badgeIcon(group) });
    }

    marker.bindPopup(function () { return groupPopupNode(group); }, { autoPanPadding: [24, 24] });
    marker.on('click', function () {
      group.detailFid = null;  // clicking the pin shows the whole group
      state.popupKey = group.key;
      if (group.providers.length === 1) setActive(group.providers[0].fid);
    });
    marker.on('popupclose', function () {
      // Ignore closes caused by this marker being replaced on a reload.
      if (markerByKey.get(group.key) !== marker) return;
      if (state.popupKey === group.key) state.popupKey = null;
    });
    marker.addTo(markerLayer);
    markerByKey.set(group.key, marker);
  });

  if (state.activeFid !== null) paintActive();
  restorePopup();
}

/* The markers are rebuilt whenever the view reloads, so re-open a popup the
 * user already had open instead of letting it disappear under them. */
function restorePopup() {
  if (state.popupKey === null) return;
  var marker = markerByKey.get(state.popupKey);
  if (marker) marker.openPopup();
  else state.popupKey = null;
}

function isBadgeMarker(marker) { return marker instanceof L.Marker; }

function setMarkerActive(marker, on) {
  if (isBadgeMarker(marker)) {
    var element = marker.getElement();
    if (element) element.classList.toggle('is-active', on);
  } else {
    marker.setStyle(on
      ? { weight: 3, color: '#111827', radius: currentRadius() + 3 }
      : { weight: 1, color: '#ffffff', radius: currentRadius() });
  }
}

function paintActive() {
  if (activeMarker) setMarkerActive(activeMarker, false);
  activeMarker = null;

  if (state.activeFid === null) return;
  var group = groupForFid.get(state.activeFid);
  if (!group) return;
  activeMarker = markerByKey.get(group.key) || null;
  if (activeMarker) setMarkerActive(activeMarker, true);
}

/* Zoom changes only need the circle sizes refreshed, not a re-query. Count
 * badges keep a fixed size so they stay readable at any zoom. */
function updateRadii() {
  var radius = currentRadius();
  markerByKey.forEach(function (marker) {
    if (!isBadgeMarker(marker) && marker !== activeMarker) marker.setRadius(radius);
  });
  if (activeMarker && !isBadgeMarker(activeMarker)) activeMarker.setRadius(radius + 3);
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (character) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
  });
}

/* Provider text is escaped: names and addresses come from the data service and
   go into an HTML string, so they must not be able to inject markup. */
function cardHtml(p) {
  var tags = [];
  function pushTag(text) { tags.push('<span class="tag">' + escapeHtml(text) + '</span>'); }

  if (p.CARETYPE_GROUP) pushTag(p.CARETYPE_GROUP);
  pushTag(settingLabel(p.SETTINGTYPE_STD));
  var ages = ageRange(p);
  if (ages) pushTag(ages);
  var group = groupForFid.get(p.fid);
  if (group && group.providers.length > 1) pushTag(group.providers.length + ' at address');

  return '<button type="button" class="card' + (p.fid === state.activeFid ? ' is-active' : '') +
    '" data-fid="' + p.fid + '">' +
    '<span class="card-name"><span class="swatch" style="background:' + colorFor(p) + '"></span>' +
    escapeHtml(p.NAME || 'Unnamed provider') + '</span>' +
    '<span class="card-line">' + escapeHtml(fullAddress(p) || 'Address not listed') + '</span>' +
    '<span class="card-tags">' + tags.join('') + '</span>' +
    '</button>';
}

/* The list is virtualized: only the rows near the scroll position exist in the
 * DOM. A view can hold 2,000 providers, and rendering them all meant ~16,900
 * elements, which cost ~240 ms of main-thread work per filter change (measured)
 * — and, more expensively, got walked by every password-manager extension on the
 * page. With a window of visible rows plus a small overscan the DOM is ~150
 * elements instead.
 *
 * Rows are a fixed height so the offset of row N is simply N * ROW_HEIGHT; that
 * avoids a measurement pass and any scroll-position drift. Text that does not
 * fit is clipped — the popup carries the full detail. */
var ROW_HEIGHT = 82;

/* Rows rendered above and below the viewport, so a fast scroll does not flash
 * empty space. */
var ROW_OVERSCAN = 8;

var listStart = 0;
var listEnd = 0;
var listScrollQueued = false;

/* Rows are replaced wholesale, so the previous scroll offset can point past the
 * end of a shorter list. */
function clampListScroll() {
  var max = Math.max(0, dom.listSizer.offsetHeight - dom.resultList.clientHeight);
  if (dom.resultList.scrollTop > max) dom.resultList.scrollTop = max;
}

function rowIndex(fid) {
  if (fid === null) return -1;
  for (var i = 0; i < state.filtered.length; i++) {
    if (state.filtered[i].fid === fid) return i;
  }
  return -1;
}

/* Paint the slice of rows around the current scroll position. */
function renderWindow() {
  var items = state.filtered;
  var viewport = dom.resultList.clientHeight || ROW_HEIGHT * 12;
  var scrollTop = dom.resultList.scrollTop;

  var start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - ROW_OVERSCAN);
  var end = Math.min(items.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + ROW_OVERSCAN);
  listStart = start;
  listEnd = end;

  var html = '';
  for (var i = start; i < end; i++) html += cardHtml(items[i]);
  dom.listRows.innerHTML = html;
  dom.listRows.style.transform = 'translateY(' + (start * ROW_HEIGHT) + 'px)';
}

function onListScroll() {
  if (listScrollQueued) return;
  listScrollQueued = true;
  requestAnimationFrame(function () {
    listScrollQueued = false;
    renderWindow();
  });
}

function renderList() {
  var items = state.filtered;
  dom.listSizer.style.height = (items.length * ROW_HEIGHT) + 'px';

  if (state.pendingScroll && state.activeFid !== null) {
    // The selected row may sit outside the current window, so move the scroll
    // position to it *before* rendering, otherwise there is no element to
    // highlight or scroll to.
    var index = rowIndex(state.activeFid);
    if (index >= 0) {
      var viewport = dom.resultList.clientHeight || ROW_HEIGHT * 12;
      var top = index * ROW_HEIGHT;
      if (top < dom.resultList.scrollTop || top + ROW_HEIGHT > dom.resultList.scrollTop + viewport) {
        dom.resultList.scrollTop = Math.max(0, top - Math.floor((viewport - ROW_HEIGHT) / 2));
      }
    }
  }

  clampListScroll();
  renderWindow();

  if (state.pendingScroll && state.activeFid !== null) {
    var active = findCard(state.activeFid);
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
  state.pendingScroll = false;
}

function fullAddress(p) {
  var parts = [];
  if (p.ADDRESS) parts.push(p.ADDRESS);
  if (p.ADDRESS2) parts.push(p.ADDRESS2);
  var cityLine = [p.CITY, p.STATE].filter(Boolean).join(', ');
  if (p.ZIPCODE) cityLine = cityLine ? cityLine + ' ' + p.ZIPCODE : p.ZIPCODE;
  if (cityLine) parts.push(cityLine);
  return parts.join(', ');
}

function ageRange(p) {
  var min = p.AGEMIN_YEAR || (p.AGEMIN !== null && p.AGEMIN !== undefined ? formatMonths(p.AGEMIN) : '');
  var max = p.AGEMAX_YEAR || (p.AGEMAX !== null && p.AGEMAX !== undefined ? formatMonths(p.AGEMAX) : '');
  if (!min && !max) return '';
  if (!max) return 'From ' + min;
  if (!min) return 'Up to ' + max;
  return min + ' – ' + max;
}

function renderResultsMeta() {
  dom.resultCount.textContent = formatCount(state.filtered.length);

  var notes = [];
  if (state.truncated) {
    notes.push('Only the first ' + formatCount(state.providers.length) + ' of ' +
      formatCount(state.totalInView) + ' providers in this view are loaded. Zoom in or add a filter to narrow the area.');
  }
  if (state.text.trim() && state.filtered.length !== state.providers.length) {
    notes.push('Text filter is matching ' + formatCount(state.filtered.length) + ' of ' +
      formatCount(state.providers.length) + ' loaded providers.');
  }
  dom.resultsNote.textContent = notes.join(' ');
  dom.resultsNote.hidden = notes.length === 0;

  // Show the empty state once a query has settled, so the panel is never
  // silently blank — including when the view genuinely has no providers.
  var settled = !state.loading && !state.error;
  dom.resultsEmpty.hidden = !(state.filtered.length === 0 && settled);
  dom.resultsEmpty.textContent = state.text.trim()
    ? 'No loaded providers match "' + state.text.trim() + '". Pan the map to load more of the city.'
    : 'No providers match in this map view.';
}

/* ------------------------------------------------------------- detail popup */

/* A pin stands for one coordinate, so its popup either shows that single
 * provider or lists every programme registered there. */
function groupPopupNode(group) {
  if (group.providers.length === 1) return detailNode(group.providers[0]);

  if (group.detailFid !== null) {
    var chosen = null;
    for (var i = 0; i < group.providers.length; i++) {
      if (group.providers[i].fid === group.detailFid) { chosen = group.providers[i]; break; }
    }
    if (chosen) {
      var node = detailNode(chosen);
      var back = document.createElement('button');
      back.type = 'button';
      back.className = 'popup-back';
      back.textContent = '‹ All ' + group.providers.length + ' at this address';
      back.addEventListener('click', function (event) {
        event.stopPropagation();   // same reason as the programme buttons above
        group.detailFid = null;
        refreshPopup(group);
      });
      node.insertBefore(back, node.firstChild);
      return node;
    }
  }

  return groupListNode(group);
}

function groupListNode(group) {
  var wrap = document.createElement('div');
  wrap.className = 'detail group-detail';

  var heading = document.createElement('h3');
  heading.textContent = group.providers.length + ' programs at this address';
  wrap.appendChild(heading);

  var address = document.createElement('p');
  address.className = 'detail-addr';
  address.textContent = fullAddress(group.providers[0]) || 'Address not listed';
  wrap.appendChild(address);

  // Scrollable: one coordinate in this dataset holds 51 records.
  var list = document.createElement('div');
  list.className = 'group-list';

  group.providers.forEach(function (p) {
    var item = document.createElement('button');
    item.type = 'button';
    item.className = 'group-item';

    var swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = colorFor(p);
    item.appendChild(swatch);

    var body = document.createElement('span');
    body.className = 'group-item-body';

    var name = document.createElement('span');
    name.className = 'group-item-name';
    name.textContent = p.NAME || 'Unnamed provider';
    body.appendChild(name);

    var meta = document.createElement('span');
    meta.className = 'group-item-meta';
    var bits = [];
    if (p.CARETYPE_GROUP) bits.push(p.CARETYPE_GROUP);
    if (p.SETTINGTYPE_STD) bits.push(settingLabel(p.SETTINGTYPE_STD));
    if (ageRange(p)) bits.push(ageRange(p));
    meta.textContent = bits.join(' · ');
    body.appendChild(meta);

    item.appendChild(body);
    item.addEventListener('click', function (event) {
      // Replacing the popup content detaches this node mid-dispatch, which
      // would let the click escape to the map and close the popup.
      event.stopPropagation();
      group.detailFid = p.fid;
      setActive(p.fid);
      refreshPopup(group);
    });
    list.appendChild(item);
  });

  wrap.appendChild(list);
  return wrap;
}

/* Re-render an open popup in place when the user drills in or back out. */
function refreshPopup(group) {
  var marker = markerByKey.get(group.key);
  if (!marker || typeof marker.isPopupOpen !== 'function' || !marker.isPopupOpen()) return;
  marker.setPopupContent(groupPopupNode(group));
  marker.getPopup().update();
}

function detailNode(p) {
  var wrap = document.createElement('div');
  wrap.className = 'detail';

  var heading = document.createElement('h3');
  heading.textContent = p.NAME || 'Unnamed provider';
  wrap.appendChild(heading);

  var address = document.createElement('p');
  address.className = 'detail-addr';
  address.textContent = fullAddress(p) || 'Address not listed';
  wrap.appendChild(address);

  var rows = document.createElement('dl');
  addRow(rows, 'Care type', p.CARETYPE_NAME || p.CARETYPE_GROUP);
  addRow(rows, 'Setting', settingLabel(p.SETTINGTYPE_STD));
  addRow(rows, 'Ages', ageRange(p));
  addRow(rows, 'Contact', p.DOE_CONTACT_NAME);
  addPhoneRow(rows, p.TELEPHONE1);
  addLinkRow(rows, 'Email', p.EMAIL, p.EMAIL ? 'mailto:' + p.EMAIL : '');
  addRow(rows, 'Hours', p.TYPEHOURS);
  addRow(rows, 'Year schedule', p.YEARSCHEDULE);
  addRow(rows, 'Eligibility', p.ELIGIBILITY);
  addRow(rows, 'Cost', p.COST);
  addRow(rows, 'District', districtLabel(p));
  if (rows.children.length) wrap.appendChild(rows);

  var links = document.createElement('p');
  links.className = 'detail-links';
  addLink(links, 'Website', p.DOE_WEBSITE);
  addLink(links, 'MySchools', p.MYSCHOOLS_URL);
  addLink(links, inspectionLabel('OCFS', p.OCFS_INSPECTURL), p.OCFS_INSPECTURL);
  addLink(links, inspectionLabel('DOHMH', p.DOHMH_INSPECTION_URL), p.DOHMH_INSPECTION_URL);
  addLink(links, 'About this care type', p.CARETYPE_URL);
  addLink(links, 'Google Maps directions',
    'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(p.lat + ',' + p.lng));
  if (links.children.length) wrap.appendChild(links);

  return wrap;
}

function addRow(list, label, value) {
  if (value === null || value === undefined || value === '') return;
  var dt = document.createElement('dt');
  dt.textContent = label;
  var dd = document.createElement('dd');
  dd.textContent = String(value);
  list.appendChild(dt);
  list.appendChild(dd);
}

function addPhoneRow(list, phone) {
  if (!phone) return;
  var dt = document.createElement('dt');
  dt.textContent = 'Phone';
  var dd = document.createElement('dd');
  var a = document.createElement('a');
  a.href = 'tel:' + String(phone).replace(/[^\d+]/g, '');
  a.textContent = phone;
  dd.appendChild(a);
  list.appendChild(dt);
  list.appendChild(dd);
}

function addLinkRow(list, label, text, href) {
  if (!text || !href) { addRow(list, label, text); return; }
  var dt = document.createElement('dt');
  dt.textContent = label;
  var dd = document.createElement('dd');
  var a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  dd.appendChild(a);
  list.appendChild(dt);
  list.appendChild(dd);
}

/* Only accept http(s) links from the data service. */
function safeUrl(url) {
  if (!url) return '';
  try {
    var parsed = new URL(url, window.location.href);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : '';
  } catch (error) {
    return '';
  }
}

/* The inspection fields point at the provider's own record for some providers
 * and at the agency's bare search page for others — roughly 45% of the OCFS
 * links are the latter. Detect the difference so a search form is not labelled
 * as an inspection record. A record link carries either a query parameter
 * (?facilityBIN=…) or an id as its last path segment (…/GetProgramInfo/880314). */
function isRecordSpecificLink(url) {
  if (!url) return false;
  try {
    var parsed = new URL(url, window.location.href);
    if (parsed.search && parsed.search.length > 1) return true;
    var segments = parsed.pathname.split('/').filter(Boolean);
    return /\d{3,}/.test(segments[segments.length - 1] || '');
  } catch (error) {
    return false;
  }
}

function inspectionLabel(agency, url) {
  return isRecordSpecificLink(url) ? agency + ' inspections' : 'Search ' + agency + ' records';
}

function addLink(container, label, url) {
  var href = safeUrl(url);
  if (!href) return;
  var a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label;
  container.appendChild(a);
}

function districtLabel(p) {
  var borough = BOROUGHS[p.COMMUNITYDISTRICTBOROUGHCODE];
  var cd = p.COMMUNITYDISTRICT;
  if (!borough && !cd) return '';
  var suffix = cd - (p.COMMUNITYDISTRICTBOROUGHCODE || 0) * 100;
  var cdText = (suffix > 0 && suffix <= 30) ? 'Community district ' + suffix : 'District code ' + cd;
  return borough ? borough + ' — ' + cdText : cdText;
}

/* -------------------------------------------------------------- interaction */

function setActive(fid) {
  state.activeFid = fid;
  // The list is rebuilt whenever the view reloads, so remember that the
  // selected card needs bringing back into view after that rebuild.
  state.pendingScroll = true;
  paintActive();

  var previous = dom.resultList.querySelector('.card.is-active');
  if (previous) previous.classList.remove('is-active');

  // The row may be outside the virtualized window, in which case it does not
  // exist yet and there is nothing to highlight.
  revealRow(fid);

  var card = findCard(fid);
  if (card) {
    card.classList.add('is-active');
    card.scrollIntoView({ block: 'nearest' });
  }
}

/* Scroll a row into the rendered window if it currently falls outside it. */
function revealRow(fid) {
  var index = rowIndex(fid);
  if (index < 0) return;
  if (index >= listStart && index < listEnd) return;

  var viewport = dom.resultList.clientHeight || ROW_HEIGHT * 12;
  dom.resultList.scrollTop = Math.max(0, index * ROW_HEIGHT - Math.floor((viewport - ROW_HEIGHT) / 2));
  renderWindow();
}

function findCard(fid) {
  return dom.resultList.querySelector('.card[data-fid="' + fid + '"]');
}

function focusProvider(fid) {
  var group = groupForFid.get(fid);
  if (!group) return;

  // Remember the popup: setView fires moveend, which reloads the view and
  // rebuilds the markers, otherwise destroying the popup we just opened.
  state.popupKey = group.key;
  group.detailFid = fid;   // from the list, jump straight to this programme

  setActive(fid);
  map.setView([group.lat, group.lng], Math.max(map.getZoom(), 16));

  var marker = markerByKey.get(group.key);
  if (marker) marker.openPopup();
}

/* ------------------------------------------------------------- filter wiring */

function buildFilterControls() {
  var careWrap = dom.caretypeControls;
  CARE_TYPES.forEach(function (type) {
    var label = document.createElement('label');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.value = type;
    box.addEventListener('change', function () {
      if (box.checked) state.careTypes.add(type);
      else state.careTypes.delete(type);
      syncLegend();
      scheduleLoad(true);
    });
    var swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = CARE_COLORS[type];
    label.appendChild(box);
    label.appendChild(swatch);
    label.appendChild(document.createTextNode(type));
    careWrap.appendChild(label);
  });

  var settingWrap = dom.settingControls;
  SETTINGS.forEach(function (setting) {
    var label = document.createElement('label');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.value = setting.value;
    box.addEventListener('change', function () {
      if (box.checked) state.settings.add(setting.value);
      else state.settings.delete(setting.value);
      scheduleLoad(true);
    });
    label.appendChild(box);
    label.appendChild(document.createTextNode(setting.label));
    settingWrap.appendChild(label);
  });
}

function syncLegend() {
  var items = dom.legend.querySelectorAll('.legend-item');
  Array.prototype.forEach.call(items, function (item) {
    item.classList.toggle('is-off', !state.careTypes.has(item.dataset.type));
  });
}

function buildLegend() {
  CARE_TYPES.forEach(function (type) {
    var item = document.createElement('button');
    item.type = 'button';
    item.className = 'legend-item';
    item.dataset.type = type;
    item.style.color = CARE_COLORS[type];
    var swatch = document.createElement('span');
    swatch.className = 'swatch';
    var text = document.createElement('span');
    text.className = 'label';
    text.textContent = type;
    text.style.color = '';

    item.appendChild(swatch);
    item.appendChild(text);
    item.addEventListener('click', function () {
      var box = dom.caretypeControls.querySelector('input[value="' + cssEscape(type) + '"]');
      if (box) { box.checked = !box.checked; box.dispatchEvent(new Event('change')); }
    });
    dom.legend.appendChild(item);
  });
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

function scheduleLoad(immediate) {
  if (moveTimer) clearTimeout(moveTimer);
  moveTimer = setTimeout(loadView, immediate ? 0 : DEBOUNCE_MS);
}

function syncCdSelect() {
  var code = state.boroughCode;
  if (code === '' || code === '0' || !BOROUGHS[code]) {
    dom.cdField.hidden = true;
    dom.cdSelect.textContent = '';
    state.cdCode = '';
    return;
  }
  dom.cdField.hidden = false;
  dom.cdSelect.textContent = '';

  var placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'All districts';
  dom.cdSelect.appendChild(placeholder);

  dom.cdSelect.disabled = true;
  arcgis({
    f: 'json',
    where: 'COMMUNITYDISTRICTBOROUGHCODE = ' + Number(code),
    outFields: 'COMMUNITYDISTRICT',
    returnDistinctValues: 'true',
    returnGeometry: 'false'
  }).then(function (result) {
    var codes = (result.features || [])
      .map(function (f) { return Number(f.attributes.COMMUNITYDISTRICT); })
      .filter(function (n) { return isFinite(n); })
      .sort(function (a, b) { return a - b; });

    codes.forEach(function (raw) {
      var suffix = raw - Number(code) * 100;
      var option = document.createElement('option');
      option.value = String(raw);
      option.textContent = (suffix > 0 && suffix <= 30)
        ? 'Community district ' + suffix
        : 'District ' + raw;
      dom.cdSelect.appendChild(option);
    });
    dom.cdSelect.disabled = false;
  }).catch(function () {
    dom.cdSelect.disabled = false;
  });
}

/* The age filter is a two-way choice, so the slider is present only when it
 * applies: no disabled control, and "Any age" is an explicit default rather
 * than the unchecked side of a checkbox. */
function ageMode() {
  var chosen = document.querySelector('input[name="age-mode"]:checked');
  return chosen ? chosen.value : 'any';
}

function setAgeMode(mode) {
  Array.prototype.forEach.call(dom.ageRadioInputs, function (radio) {
    radio.checked = radio.value === mode;
  });
  var specific = mode === 'specific';
  dom.ageSpecific.hidden = !specific;
  dom.ageValue.textContent = formatMonths(Number(dom.ageSlider.value));
  state.ageMonths = specific ? Number(dom.ageSlider.value) : null;
}

function resetFilters() {
  state.careTypes = new Set(CARE_TYPES);
  state.settings = new Set(SETTINGS.map(function (s) { return s.value; }));
  state.ageMonths = null;
  state.boroughCode = '';
  state.cdCode = '';
  state.text = '';

  Array.prototype.forEach.call(dom.caretypeControls.querySelectorAll('input'), function (b) { b.checked = true; });
  Array.prototype.forEach.call(dom.settingControls.querySelectorAll('input'), function (b) { b.checked = true; });
  dom.textFilter.value = '';
  setAgeMode('any');
  dom.boroughSelect.value = '';
  syncCdSelect();
  syncLegend();
  scheduleLoad(true);
}

/* -------------------------------------------------------------------- setup */

/* The mobile sidebar is a full-height overlay, which would sit on top of the
 * map's attribution bar. The policy says attribution must not be hidden beneath
 * UI, so publish the bar's height for the stylesheet to leave room for it. */
function keepAttributionVisible() {
  var attribution = document.querySelector('.leaflet-control-attribution');
  if (!attribution) return;

  function apply() {
    document.documentElement.style.setProperty('--attribution-height', attribution.offsetHeight + 'px');
  }

  apply();
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(apply).observe(attribution);
  } else {
    window.addEventListener('resize', apply);
  }
}

function init() {
  dom.status = $('status');
  dom.sidebar = $('sidebar');
  dom.sidebarToggle = $('sidebar-toggle');
  dom.caretypeControls = $('caretype-controls');
  dom.settingControls = $('setting-controls');
  dom.ageRadioInputs = document.querySelectorAll('input[name="age-mode"]');
  dom.ageSpecific = $('age-specific');
  dom.ageSlider = $('age-slider');
  dom.ageValue = $('age-value');
  dom.boroughSelect = $('borough-select');
  dom.cdField = $('cd-field');
  dom.cdSelect = $('cd-select');
  dom.textFilter = $('text-filter');
  dom.legend = $('legend');
  dom.resetFilters = $('reset-filters');
  dom.resultCount = $('result-count');
  dom.resultsNote = $('results-note');
  dom.resultList = $('result-list');
  dom.listSizer = $('list-sizer');
  dom.listRows = $('list-rows');
  dom.resultsEmpty = $('results-empty');
  dom.mapError = $('map-error');
  dom.mapErrorText = $('map-error-text');
  dom.contactLink = $('contact-link');

  // Only surface the contact link once it points at a real repository; the
  // placeholder must not ship as a dead link.
  if (dom.contactLink) {
    if (CONTACT_URL.indexOf('YOUR-USERNAME') === -1 && /^https:\/\//.test(CONTACT_URL)) {
      dom.contactLink.href = CONTACT_URL;
      dom.contactLink.target = '_blank';
      dom.contactLink.rel = 'noopener';
      dom.contactLink.hidden = false;
    } else {
      dom.contactLink.hidden = true;
    }
  }

  buildFilterControls();
  buildLegend();
  setAgeMode('any');

  // Single source of truth for the row height: the stylesheet reads this back.
  document.documentElement.style.setProperty('--row-height', ROW_HEIGHT + 'px');

  map = L.map('map', {
    minZoom: 10,
    maxZoom: 18,
    maxBounds: L.latLngBounds([40.35, -74.45], [41.05, -73.55]),
    preferCanvas: true,
    zoomControl: true
  }).setView([40.7128, -74.0060], 12);

  // Basemap is added asynchronously (MapLibre is only fetched when used) and
  // never blocks the provider data from loading.
  addBasemap();
  keepAttributionVisible();

  renderer = L.canvas({ padding: 0.5 });
  markerLayer = L.layerGroup().addTo(map);

  // Reload on dragend/zoomend rather than moveend: moveend also fires for the
  // small auto-pan Leaflet performs to fit an opening popup, which would
  // refetch the whole view and tear the popup down as it opened.
  map.on('dragend zoomend', function () { scheduleLoad(false); });
  map.on('zoomend', updateRadii);

  Array.prototype.forEach.call(dom.ageRadioInputs, function (radio) {
    radio.addEventListener('change', function () {
      if (!radio.checked) return;
      setAgeMode(radio.value);
      scheduleLoad(true);
    });
  });

  dom.ageSlider.addEventListener('input', function () {
    dom.ageValue.textContent = formatMonths(Number(dom.ageSlider.value));
    if (ageMode() === 'specific') {
      state.ageMonths = Number(dom.ageSlider.value);
      scheduleLoad(false);
    }
  });

  dom.boroughSelect.addEventListener('change', function () {
    state.boroughCode = dom.boroughSelect.value;
    state.cdCode = '';
    syncCdSelect();
    scheduleLoad(true);
  });

  dom.cdSelect.addEventListener('change', function () {
    state.cdCode = dom.cdSelect.value;
    scheduleLoad(true);
  });

  dom.textFilter.addEventListener('input', function () {
    if (textTimer) clearTimeout(textTimer);
    textTimer = setTimeout(function () {
      state.text = dom.textFilter.value;
      applyTextFilter();
    }, 150);
  });

  dom.resetFilters.addEventListener('click', resetFilters);

  // One delegated listener rather than one per card: the list is rendered as
  // raw HTML and only the visible window of rows exists at any moment.
  dom.resultList.addEventListener('click', function (event) {
    var card = event.target && event.target.closest ? event.target.closest('.card') : null;
    if (card && dom.resultList.contains(card)) focusProvider(Number(card.getAttribute('data-fid')));
  });

  dom.resultList.addEventListener('scroll', onListScroll);

  // A wider or taller window means more rows are needed.
  window.addEventListener('resize', function () {
    if (state.filtered.length) renderWindow();
  });

  Array.prototype.forEach.call(document.querySelectorAll('[data-toggle-all]'), function (button) {
    button.addEventListener('click', function () {
      var target = button.dataset.toggleAll;
      var on = button.dataset.mode !== 'none';
      var wrap = target === 'caretype' ? dom.caretypeControls : dom.settingControls;
      Array.prototype.forEach.call(wrap.querySelectorAll('input'), function (box) {
        if (box.checked !== on) { box.checked = on; box.dispatchEvent(new Event('change')); }
      });
    });
  });

  dom.sidebarToggle.addEventListener('click', function () {
    var open = document.body.classList.toggle('sidebar-open');
    dom.sidebarToggle.setAttribute('aria-expanded', String(open));
  });

  $('retry').addEventListener('click', function () { loadView(); });

  if (window.matchMedia('(max-width: 719px)').matches) {
    dom.sidebarToggle.setAttribute('aria-expanded', 'false');
  }

  loadView();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
