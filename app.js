// ── RUNTIME DATA ──────────────────────────────────────────────────────────
let ESZ_GEOJSON      = null;  // FeatureCollection — community profile props + geometry
let STATION_GEO      = null;
let FACILITY_GEO     = null;
let CONSERVATION_GEO = null;
let STATION_SUMS     = null;
let CATEGORIES    = null;
let STATIONS      = null;
let SYNTHETIC     = false;

// ESZ_COUNTS: { "ESZ-ID": { ems_1low: N, fire_2moderate: N, fy_range: "...", ... } }
let ESZ_COUNTS    = null;
// PROG_RISK_MAP: { EMS: ["1-Low","2-Moderate","3-High"], Fire: [...], ... }
// Built dynamically by inspecting column names — mirrors available_programs_risks()
let PROG_RISK_MAP = {};

const STATION_COLORS = {
  ST81:'#D7263D', ST82:'#F46036', ST83:'#2E294E',
  ST84:'#1B998B', ST85:'#C5D86D', ST86:'#6A4C93',
};

// Risk colors — muted, saturated but not neon
const RISK_NEON = {
  '1-Low':      '#2e9e52',  // forest green
  '2-Moderate': '#c97a1a',  // warm amber-brown
  '3-High':     '#c0392b',  // brick red
  '4-Maximum':  '#7b3fa0',  // deep purple
};
const RISK_DARK = {
  '1-Low':      '#0d1f0d',
  '2-Moderate': '#1f1200',
  '3-High':     '#1f0000',
  '4-Maximum':  '#0f001f',
};
const ZERO_BAND_COLOR = '#0a1628';
const N_BANDS = 4;

const PROG_COLORS = {
  EMS:'#3a74b8', Fire:'#c0392b', Hazmat:'#c97a1a', Rescue:'#7b3fa0',
};

// ── APP STATE ─────────────────────────────────────────────────────────────
let activeMode     = 'community';
let activeStation = 'ALL';
let activeESZ      = null;
let activeProgram = null;
let activeRisk    = null;
let currentMetric = 'est_population';
let choroplethLayer      = null;
let stationBoundaryLayer = null;
let stationLabelLayer    = null;
let eszLabelLayer        = null;  // ESZ ID text labels (single-station view)

// Bring station overlay layers to front in correct z-order
function bringStationLayersToFront() {
  if (stationBoundaryLayer) stationBoundaryLayer.bringToFront();
  if (eszLabelLayer)        eszLabelLayer.eachLayer(l => l.bringToFront?.());
  if (stationLabelLayer)    stationLabelLayer.eachLayer(l => l.bringToFront?.());
}
let conservationLayer    = null;
let showConservation     = true;

// ── TARGET HAZARDS STATE ──────────────────────────────────────────────────
let TARGET_HAZARDS_GEO  = null;   // FeatureCollection from flowmsp_high_hazard.geojson
let HAZARD_CAMPUSES     = [];     // derived: one entry per parent_id campus/site
let hazardsLayer        = null;
let activeHazardCat     = 'all';
let activeHazardCampus  = null;   // currently selected campus object

// Map FlowMSP occupancy_type → internal category key
// Priority order for campus: school > alf > assembly > multifamily > commercial > industrial > special
const OCCUPANCY_TO_CAT = {
  'Educational':                  'school',
  'Day-Care':                     'school',
  'Board & Care':                 'alf',
  'Medical Care / Institutional': 'alf',
  'Assembly':                     'assembly',
  'Multi-Family':                 'multifamily',
  'Business/Mercantile':          'commercial',
  'Industrial':                   'industrial',
  'High Hazard':                  'industrial',
  'Storage':                      'industrial',
  'Special Structures':           'special',
};

const CAT_PRIORITY = ['school','alf','assembly','multifamily','commercial','industrial','special','other'];

function getBldgCat(props) {
  return OCCUPANCY_TO_CAT[props.occupancy_type] || 'other';
}

// For a campus, pick the highest-priority category among its buildings
function getCampusCat(buildings) {
  const cats = new Set(buildings.map(f => getBldgCat(f.properties)));
  for (const c of CAT_PRIORITY) if (cats.has(c)) return c;
  return 'other';
}

const HAZARD_CAT_CONFIG = {
  all:         { label:'All',           color:'#4a6fa5', icon:'◉' },
  school:      { label:'School / EDU',  color:'#c97a1a', icon:'🏫' },
  alf:         { label:'ALF / Medical', color:'#c0392b', icon:'🏥' },
  assembly:    { label:'Assembly',      color:'#3a74b8', icon:'🏟' },
  multifamily: { label:'Multi-Family',  color:'#d4a017', icon:'🏢' },
  commercial:  { label:'Commercial',    color:'#1B998B', icon:'🏪' },
  industrial:  { label:'Industrial',    color:'#6A4C93', icon:'🏭' },
  special:     { label:'Special',       color:'#7a7a7a', icon:'⚙'  },
};
// ── COVERAGE STATE ────────────────────────────────────────────────────────
let DRIVE_TIME_GEO     = null;  // FeatureCollection — polygon isochrones
let DRIVE_TIME_ROADS   = null;  // FeatureCollection — road LineString segments
let ESZ_DRIVE_COV      = null;  // FeatureCollection — esz_drive_coverage.geojson
let isochroneLayer     = null;  // Leaflet layer for coverage rendering
let activeCovView      = 'road';     // 'road' | 'polygons' | 'esz'
let activeCovSubType   = 'mph';      // 'mph' | 'drivetime'
let activeCovMPH       = null;       // e.g. '25', '35', '45'
let activeCovDriveTime = null;       // e.g. '4'

// Speed MPH color palette — muted, distinct, non-neon
const MPH_COLORS = {
  '25': { fill:'#4a6fa5', stroke:'#3a5a8a' },  // slate blue
  '35': { fill:'#3a7d6e', stroke:'#2d6459' },  // teal-green
  '45': { fill:'#b05a2a', stroke:'#8e4820' },  // burnt sienna
};

// Overlap count color ramp (1 station → 6+ stations) — muted, sequential
const OVERLAP_COLORS = [
  '#4a7c59',  // 1 station  — muted green
  '#4a6fa5',  // 2 stations — slate blue
  '#b07d2a',  // 3 stations — golden brown
  '#a63d2f',  // 4 stations — brick red
  '#6b3d8a',  // 5 stations — deep purple
  '#2c4a6e',  // 6+         — dark navy
];

// ── MAP INIT ──────────────────────────────────────────────────────────────
if (typeof L === 'undefined') throw new Error('Leaflet failed to load.');
const map = L.map('map', {
  center:[27.03,-82.38], zoom:11,
  zoomControl:false, attributionControl:false,
});
L.control.zoom({position:'bottomright'}).addTo(map);

// ── TILE LAYER ────────────────────────────────────────────────────────────
const TILE_DARK   = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_STREET = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
let tileLayer = L.tileLayer(TILE_DARK, { maxZoom:19, opacity:0.7 }).addTo(map);
let isLightMode = false;

function toggleTheme() {
  isLightMode = !isLightMode;
  document.body.classList.toggle('light-mode', isLightMode);

  // Swap tile layer: Voyager street map in light mode, dark carto in dark mode
  map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(isLightMode ? TILE_STREET : TILE_DARK, {
    maxZoom: 19,
    opacity: isLightMode ? 1.0 : 0.7,
  }).addTo(map);
  tileLayer.bringToBack();

  // Update switch label + icon
  const thumb = document.getElementById('theme-thumb');
  if (thumb) thumb.textContent = isLightMode ? '☀️' : '🌙';
  document.getElementById('theme-label').textContent = isLightMode ? 'Light Mode' : 'Dark Mode';

  // Re-render station labels with correct colors
  renderStationLayers();

  // Re-render so choropleth/coverage colors stay legible
  if (activeMode !== 'coverage') renderChoropleth();
  else renderCoverageLayer();
}

let windowFocused = true;
function closeAllTooltips() {
  map.eachLayer(l => { if (l.getTooltip && l.getTooltip()) l.closeTooltip(); });
}
window.addEventListener('blur',  () => { windowFocused = false; closeAllTooltips(); });
window.addEventListener('focus', () => { windowFocused = true;  closeAllTooltips(); });
document.addEventListener('visibilitychange', closeAllTooltips);
// Attach mouseleave after DOM is ready to ensure the element exists
document.addEventListener('DOMContentLoaded', () => {
  const mapEl = document.getElementById('map');
  if (mapEl) mapEl.addEventListener('mouseleave', closeAllTooltips);
});

// ── DATA FETCH ────────────────────────────────────────────────────────────
async function init() {
  const msg = document.getElementById('load-msg');
  try {
    msg.textContent = 'Fetching community profiles…';
    const [eszResp, sumsResp] = await Promise.all([
      fetch('data/esz_profiles.json'),
      fetch('data/esz_station_sums.json'),
    ]);
    if (!eszResp.ok)  throw new Error(`esz_profiles.json: HTTP ${eszResp.status}`);
    if (!sumsResp.ok) throw new Error(`esz_station_sums.json: HTTP ${sumsResp.status}`);

    msg.textContent = 'Parsing data…';
    const [eszData, sumsData] = await Promise.all([eszResp.json(), sumsResp.json()]);
    ESZ_GEOJSON  = eszData;
    STATION_SUMS = sumsData;
    CATEGORIES   = eszData.metadata?.categories || [];
    STATIONS     = eszData.metadata?.stations   || [];
    SYNTHETIC    = eszData.metadata?.synthetic  || false;

    msg.textContent = 'Fetching incident counts…';
    const countsResp = await fetch('data/esz_counts.json');
    if (countsResp.ok) {
      ESZ_COUNTS = await countsResp.json();
      buildProgRiskMap();
    } else {
      console.warn('[NPFR] esz_counts.json not found — Incident Risk mode unavailable.');
      const btn = document.getElementById('mode-incident');
      btn.disabled = true;
      btn.style.opacity = '0.35';
      btn.title = 'Incident count data not available — run build.py';
    }

    msg.textContent = 'Fetching boundary layers…';
    const [stRes, facRes, dtRes, dtRoadsRes, eszCovRes, consRes, thRes] = await Promise.allSettled([
      fetch('data/npfr_station_boundary.geojson'),
      fetch('data/CountyFacility.geojson'),
      fetch('data/drive_time_isochrones.geojson'),
      fetch('data/drive_time_roads.geojson'),
      fetch('data/esz_drive_coverage.geojson'),
      fetch('data/conservation_lands.geojson'),
      fetch('data/flowmsp_high_hazard.geojson'),
    ]);
    STATION_GEO        = stRes.status      === 'fulfilled' && stRes.value.ok      ? await stRes.value.json()      : null;
    FACILITY_GEO       = facRes.status     === 'fulfilled' && facRes.value.ok     ? await facRes.value.json()     : null;
    DRIVE_TIME_GEO     = dtRes.status      === 'fulfilled' && dtRes.value.ok      ? await dtRes.value.json()      : null;
    DRIVE_TIME_ROADS   = dtRoadsRes.status === 'fulfilled' && dtRoadsRes.value.ok ? await dtRoadsRes.value.json() : null;
    ESZ_DRIVE_COV      = eszCovRes.status  === 'fulfilled' && eszCovRes.value.ok  ? await eszCovRes.value.json()  : null;
    CONSERVATION_GEO   = consRes.status    === 'fulfilled' && consRes.value.ok    ? await consRes.value.json()    : null;
    TARGET_HAZARDS_GEO = thRes.status      === 'fulfilled' && thRes.value.ok      ? await thRes.value.json()      : null;

  } catch (err) {
    document.getElementById('load-overlay').innerHTML =
      `<div style="font-family:monospace;font-size:13px;color:#ff6b6b;padding:40px;max-width:600px;text-align:center">
        <strong>Data load failed</strong><br><br>${err.message}<br><br>
        <span style="color:#8888aa">Run build.py then serve via HTTP (not file://).</span>
      </div>`;
    return;
  }

  document.getElementById('load-overlay').remove();

  if (SYNTHETIC) {
    document.getElementById('synthetic-badge').style.display = '';
    console.warn('[NPFR] Running with SYNTHETIC data.');
  }

  buildStationPills();
  buildProgTabs();
  buildHazardCampuses();
  renderStationLayers();
  renderConservationLayer();
  renderChoropleth();
  showStationOverview('ALL');
  setTimeout(() => {
    const b = L.geoJSON(ESZ_GEOJSON).getBounds();
    if (b.isValid()) map.fitBounds(b, {padding:[30,30]});
  }, 80);
}

// ── BUILD PROG/RISK MAP from column names ─────────────────────────────────
// Mirrors available_programs_risks() from render_riskmaps.py
function buildProgRiskMap() {
  if (!ESZ_COUNTS) return;
  const RISK_SLUG  = { '1low':'1-Low','2moderate':'2-Moderate','3high':'3-High','4maximum':'4-Maximum' };
  const PROG_NAMES = { ems:'EMS', fire:'Fire', hazmat:'Hazmat', rescue:'Rescue' };
  const pat = /^([a-z]+)_(1low|2moderate|3high|4maximum)$/;
  const result = {};

  const sample = Object.values(ESZ_COUNTS)[0] || {};
  for (const col of Object.keys(sample)) {
    const m = pat.exec(col);
    if (!m) continue;
    const prog = PROG_NAMES[m[1]] || m[1];
    const risk = RISK_SLUG[m[2]];
    if (!result[prog]) result[prog] = [];
    if (!result[prog].includes(risk)) result[prog].push(risk);
  }
  for (const p of Object.keys(result)) result[p].sort();
  PROG_RISK_MAP = result;

  const fy = Object.values(ESZ_COUNTS)[0]?.fy_range || '';
  if (fy) document.getElementById('fy-badge').textContent = fy;
}

// ── STATION DROPDOWN ──────────────────────────────────────────────────────
// ── STATION DROPDOWN (single-select) ─────────────────────────────────────
function buildStationPills() {
  const wrap = document.getElementById('station-pills');
  wrap.innerHTML = `
    <div class="st-dropdown" id="st-dropdown">
      <button class="st-dropdown-btn" id="st-dropdown-btn" onclick="toggleStationDropdown(event)">
        <span class="st-dot" id="st-dropdown-dot" style="background:var(--accent)"></span>
        <span id="st-dropdown-label">All Stations</span>
        <span class="st-dropdown-arrow">▾</span>
      </button>
      <div class="st-dropdown-panel" id="st-dropdown-panel">
        <div class="st-dropdown-item st-dropdown-item-active" data-station="ALL" onclick="selectStation('ALL')">
          <span class="st-dot" style="background:var(--accent)"></span>
          <span>All Stations</span>
          <span class="st-check-mark" id="st-mark-ALL">✓</span>
        </div>
        <div class="st-dropdown-sep"></div>
        ${STATIONS.map(s => `
          <div class="st-dropdown-item" data-station="${s}" onclick="selectStation('${s}')">
            <span class="st-dot" style="background:${STATION_COLORS[s]||'var(--accent)'}"></span>
            <span>${s}</span>
            <span class="st-check-mark" id="st-mark-${s}"></span>
          </div>
        `).join('')}
      </div>
    </div>`;

  document.addEventListener('click', e => {
    if (!document.getElementById('st-dropdown')?.contains(e.target))
      document.getElementById('st-dropdown-panel')?.classList.remove('open');
  });
}

function toggleStationDropdown(e) {
  e.stopPropagation();
  document.getElementById('st-dropdown-panel').classList.toggle('open');
}

function selectStation(sid) {
  activeStation = sid;
  activeESZ     = null;

  // Update button — show label text only for ALL; single station just shows colored dot + short ID
  const color = sid === 'ALL' ? 'var(--accent)' : (STATION_COLORS[sid] || 'var(--accent)');
  document.getElementById('st-dropdown-label').textContent = sid === 'ALL' ? 'All Stations' : sid;
  document.getElementById('st-dropdown-dot').style.background = color;

  // Update check marks
  document.querySelectorAll('.st-check-mark').forEach(el => el.textContent = '');
  const mark = document.getElementById(`st-mark-${sid}`);
  if (mark) mark.textContent = '✓';

  // Update active row highlight
  document.querySelectorAll('.st-dropdown-item').forEach(el =>
    el.classList.toggle('st-dropdown-item-active', el.dataset.station === sid)
  );

  document.getElementById('st-dropdown-panel').classList.remove('open');

  // Re-render station layers (dim overlay, ESZ labels, badge, dot markers)
  renderStationLayers();

  if (activeMode === 'coverage') {
    activeCovMPH = null;
    buildCoverageSubTabs();
    renderCoverageLayer();
    showCoverageOverview();
  } else {
    renderChoropleth();
    showStationOverview(sid);
  }

  // Fit bounds
  if (sid !== 'ALL') {
    const src = activeMode === 'coverage' ? DRIVE_TIME_GEO : ESZ_GEOJSON;
    const key = activeMode === 'coverage' ? 'station_id' : null;
    const feats = src?.features?.filter(f =>
      (key ? f.properties[key] : (f.properties.StationID || f.properties.station_id)) === sid
    ) || [];
    if (feats.length) {
      const b = L.geoJSON({type:'FeatureCollection', features:feats}).getBounds();
      if (b.isValid()) map.fitBounds(b, {padding:[30,30]});
    }
  } else {
    const b = L.geoJSON(ESZ_GEOJSON).getBounds();
    if (b.isValid()) map.fitBounds(b, {padding:[30,30]});
  }
}

// Called from sidebar station cards
function filterStation(sid) { selectStation(sid); }

// ── PROGRAM & RISK TABS ───────────────────────────────────────────────────
function buildProgTabs() {
  document.getElementById('prog-tabs').innerHTML =
    Object.keys(PROG_RISK_MAP).map(p =>
      `<button class="prog-tab" data-prog="${p}" onclick="selectProgram('${p}')">${p}</button>`
    ).join('');
}

function buildRiskTabs(program) {
  document.getElementById('risk-tabs').innerHTML =
    (PROG_RISK_MAP[program] || []).map(r =>
      `<button class="risk-tab" data-risk="${r}" onclick="selectRisk('${r}')">${r}</button>`
    ).join('');
}

// ── MODE SWITCHING ────────────────────────────────────────────────────────
function setMode(mode) {
  activeMode = mode;
  const app = document.getElementById('app');
  document.getElementById('mode-community').classList.toggle('active', mode === 'community');
  document.getElementById('mode-incident').classList.toggle('active',  mode === 'incident');
  document.getElementById('mode-coverage').classList.toggle('active',  mode === 'coverage');
  const hBtn = document.getElementById('mode-hazards');
  if (hBtn) hBtn.classList.toggle('active', mode === 'hazards');

  app.classList.toggle('incident-mode', mode === 'incident');
  app.classList.toggle('coverage-mode',  mode === 'coverage');
  app.classList.toggle('hazards-mode',   mode === 'hazards');

  if (mode === 'community') {
    activeProgram = null;
    activeRisk    = null;
    activeESZ     = null;
    clearIsochroneLayer();
    clearHazardsLayer();
    renderChoropleth();
    showStationOverview(activeStation);
  } else if (mode === 'incident') {
    activeESZ = null;
    clearIsochroneLayer();
    clearHazardsLayer();
    const progs = Object.keys(PROG_RISK_MAP);
    if (progs.length && !activeProgram) {
      selectProgram(progs[0]);
    } else if (activeProgram) {
      renderChoropleth();
      showStationOverview(activeStation);
    }
  } else if (mode === 'coverage') {
    activeProgram = null;
    activeRisk    = null;
    activeESZ     = null;
    clearHazardsLayer();
    if (choroplethLayer) { map.removeLayer(choroplethLayer); choroplethLayer = null; }
    buildCoverageSubheader();
    renderCoverageLayer();
    showCoverageOverview();
  } else if (mode === 'hazards') {
    activeProgram = null;
    activeRisk    = null;
    activeESZ     = null;
    clearIsochroneLayer();
    if (choroplethLayer) { map.removeLayer(choroplethLayer); choroplethLayer = null; }
    buildHazardsCatTabs();
    renderHazardsLayer();
    showHazardsOverview();
  }

  // If info panel is open, re-render it for the new mode
  const infoOverlay = document.getElementById('info-overlay');
  if (infoOverlay?.classList.contains('open') && INFO_DATA) {
    renderInfoPanel(INFO_DATA, mode);
  }
}

function selectProgram(program) {
  activeProgram = program;
  document.querySelectorAll('.prog-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.prog === program)
  );
  buildRiskTabs(program);
  const risks = PROG_RISK_MAP[program] || [];
  if (risks.length) selectRisk(risks[0]);
}

function selectRisk(risk) {
  activeRisk = risk;
  document.querySelectorAll('.risk-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.risk === risk)
  );
  activeESZ = null;
  renderChoropleth();
  showStationOverview(activeStation);
}

// ── STATION BOUNDARY LAYERS ───────────────────────────────────────────────
function renderStationLayers() {
  if (stationBoundaryLayer) { map.removeLayer(stationBoundaryLayer); stationBoundaryLayer = null; }
  if (stationLabelLayer)    { map.removeLayer(stationLabelLayer);    stationLabelLayer    = null; }
  if (eszLabelLayer)        { map.removeLayer(eszLabelLayer);        eszLabelLayer        = null; }

  const isSingle      = activeStation !== 'ALL';
  const boundaryColor = isLightMode ? '#2244aa' : '#c8c8e8';

  // ── Station boundaries — full opacity for selected, faded for others ──
  if (STATION_GEO?.features?.length) {
    stationBoundaryLayer = L.geoJSON(STATION_GEO, {
      style: feat => {
        const sid        = feat.properties.StationID || feat.properties.station_id || '';
        const isSelected = !isSingle || sid === activeStation;
        return {
          color:       boundaryColor,
          weight:      isSelected ? 2.5 : 1.2,
          opacity:     isSelected ? 0.9 : 0.3,
          fillOpacity: 0,
        };
      },
      interactive: false,
    }).addTo(map);
  }

  // ── Station number badge (upper-left of map) ──────────────────────────
  const badge = document.getElementById('station-badge');
  if (badge) {
    if (isSingle) {
      badge.style.display = 'block';
      badge.style.color   = STATION_COLORS[activeStation] || 'var(--accent)';
      badge.textContent   = activeStation.replace('ST', '');
    } else {
      badge.style.display = 'none';
    }
  }

  // ── Collect station centroid positions ────────────────────────────────
  const stationCentroids = [];
  if (FACILITY_GEO?.features) {
    FACILITY_GEO.features.forEach(f => {
      const lbl = f.properties.cadlabel || f.properties.CadLabel || '';
      const num = parseInt(lbl);
      if (num >= 81 && num <= 86)
        stationCentroids.push({ sid:'ST'+num, coords: f.geometry.coordinates });
    });
  } else if (STATION_GEO?.features) {
    STATION_GEO.features.forEach(f => {
      const sid = f.properties.StationID || f.properties.station_id || '';
      if (!sid) return;
      const flat  = f.geometry.coordinates.flat(10).filter((_,i) => i%2===0);
      const flatY = f.geometry.coordinates.flat(10).filter((_,i) => i%2===1);
      if (!flat.length) return;
      stationCentroids.push({
        sid,
        coords: [
          flat.reduce((a,b)=>a+b,0)/flat.length,
          flatY.reduce((a,b)=>a+b,0)/flatY.length,
        ],
      });
    });
  }

  // ── Station markers: dot for selected, number label for all others ────
  if (stationCentroids.length) {
    const grp       = L.layerGroup();
    const textColor = isLightMode ? '#003399' : '#4a90d9';
    const shadow    = isLightMode ? '#ffffff'  : '#0a0a1a';

    stationCentroids.forEach(({ sid, coords }) => {
      const isSelected = isSingle && sid === activeStation;
      const dotColor   = STATION_COLORS[sid] || '#4a90d9';
      const num        = sid.replace('ST','');

      if (isSelected) {
        // Selected station → colored dot marker
        L.marker([coords[1], coords[0]], {
          icon: L.divIcon({
            className: '',
            html: `<div style="width:14px;height:14px;border-radius:50%;`
                + `background:${dotColor};border:2.5px solid ${shadow};`
                + `box-shadow:0 1px 6px rgba(0,0,0,0.45);pointer-events:none;"></div>`,
            iconAnchor: [7, 7],
          }),
          interactive: false, zIndexOffset: 600,
        }).addTo(grp);
      } else {
        // All other stations → number text label (same as before)
        L.marker([coords[1], coords[0]], {
          icon: L.divIcon({
            className: '',
            html: `<div style="font-family:Barlow Condensed,sans-serif;font-size:20px;font-weight:700;`
                + `letter-spacing:.08em;color:${textColor};opacity:${isSingle ? '0.45' : '1'};`
                + `text-shadow:-2px -2px 0 ${shadow},2px -2px 0 ${shadow},`
                + `-2px 2px 0 ${shadow},2px 2px 0 ${shadow};`
                + `white-space:nowrap;pointer-events:none;">${num}</div>`,
            iconAnchor: [14, 10],
          }),
          interactive: false, zIndexOffset: 500,
        }).addTo(grp);
      }
    });
    stationLabelLayer = grp.addTo(map);
  }

  // ── ESZ ID labels — disabled (too cluttered at station scale)
  // eslLabelLayer remains null
}

// ── CONSERVATION LAYER ────────────────────────────────────────────────────
function renderConservationLayer() {
  if (conservationLayer) { map.removeLayer(conservationLayer); conservationLayer = null; }
  if (!CONSERVATION_GEO?.features?.length) return;

  conservationLayer = L.geoJSON(CONSERVATION_GEO, {
    style: () => ({
      fillColor:   '#2d6a4f',
      fillOpacity: 0.18,
      color:       '#52b788',
      weight:      0.8,
      opacity:     0.45,
    }),
    interactive: false,
  });

  if (showConservation) conservationLayer.addTo(map);
}

function toggleConservationLayer(checked) {
  showConservation = checked;
  if (!conservationLayer) return;
  if (showConservation) {
    conservationLayer.addTo(map);
    // Restore layer order: conservation sits above choropleth, below station boundaries
    bringStationLayersToFront();
  } else {
    map.removeLayer(conservationLayer);
  }
}


// Community choropleth ramps: index 0 = no data/zero, 1–5 = low→high value
// Solid colors — opacity is controlled per-band via fillOpacity in the style function.
// Low values are nearly transparent (0.08), high values are fully opaque (0.95).
const RAMP_COLORS = {
  fire:   '#c87800',  // amber-gold  — population / general counts
  blue:   '#1a5fc8',  // royal blue  — hydrant coverage / density
  orange: '#c84800',  // burnt orange — flood / hazard
  yellow: '#0a7272',  // deep teal   — age / year built
};
const RAMP_OPACITIES = [0, 0.12, 0.30, 0.52, 0.74, 0.95];

// Legacy RAMPS kept for legend swatches — built from RAMP_COLORS at display time
function getRampSwatches(ramp) {
  const base = RAMP_COLORS[ramp] || RAMP_COLORS.fire;
  return RAMP_OPACITIES.map(o => {
    if (o === 0) return 'rgba(128,128,128,0.10)';
    const r = parseInt(base.slice(1,3),16);
    const g = parseInt(base.slice(3,5),16);
    const b = parseInt(base.slice(5,7),16);
    return `rgba(${r},${g},${b},${o})`;
  });
}

const PCT_METRICS = new Set([
  'pct_hydrant_1000ft','pct_flood_ae',
  'sfr_pct','mobile_pct','multifamily_pct','alf_pct','retail_pct',
  'industrial_pct','institutional_pct','school_pct','government_pct','vacant_pct',
  'residential_pct',
  'sfr_hyd_pct','sfr_flood_pct','mobile_hyd_pct','mobile_flood_pct',
  'multifamily_hyd_pct','multifamily_flood_pct','alf_hyd_pct','alf_flood_pct',
  'retail_hyd_pct','retail_flood_pct','industrial_hyd_pct','industrial_flood_pct',
  'institutional_hyd_pct','institutional_flood_pct','school_hyd_pct','school_flood_pct',
  'government_hyd_pct','government_flood_pct','vacant_hyd_pct','vacant_flood_pct',
]);

const YEAR_METRICS = new Set([
  'residential_avg_yrbl','commercial_avg_yrbl',
  'sfr_avg_yrbl','mobile_avg_yrbl','multifamily_avg_yrbl','alf_avg_yrbl',
  'retail_avg_yrbl','industrial_avg_yrbl',
]);

const SQFT_METRICS = new Set([
  'residential_grnd_sqft','commercial_grnd_sqft',
  'sfr_grnd_sqft','mobile_grnd_sqft','multifamily_grnd_sqft','alf_grnd_sqft',
  'retail_grnd_sqft','industrial_grnd_sqft',
]);

function fmt(v, metric) {
  if (v === undefined || v === null || v === '' || isNaN(parseFloat(v))) return '—';
  const n = parseFloat(v);
  if (metric && PCT_METRICS.has(metric))  return n.toFixed(1) + '%';
  if (metric && YEAR_METRICS.has(metric)) {
    if (n <= 0) return '—';
    const age = new Date().getFullYear() - Math.round(n);
    return age + ' yrs old';
  }
  if (metric && SQFT_METRICS.has(metric)) return (n / 1000).toFixed(0) + 'k sqft';
  return Math.round(n).toLocaleString();
}
function fmtPct(v) {
  if (v === undefined || v === null || v === '' || isNaN(parseFloat(v))) return '—';
  return parseFloat(v).toFixed(1) + '%';
}
function getRamp(metric) {
  if (metric.includes('flood') || metric.includes('pct_flood')) return 'orange';
  if (metric.includes('hydrant') || metric.includes('pop'))     return 'blue';
  if (YEAR_METRICS.has(metric))                                 return 'yellow';
  if (SQFT_METRICS.has(metric))                                 return 'blue';
  return 'fire';
}
function communityColor(val, breaks, ramp) {
  if (val === undefined || val === null || val === '' || isNaN(parseFloat(val))) return { color: RAMP_COLORS[ramp] || RAMP_COLORS.fire, opacity: RAMP_OPACITIES[0] };
  const n = parseFloat(val);
  if (n <= 0) return { color: RAMP_COLORS[ramp] || RAMP_COLORS.fire, opacity: RAMP_OPACITIES[0] };
  let idx = RAMP_OPACITIES.length - 1;
  for (let i = 0; i < breaks.length; i++) { if (n <= breaks[i]) { idx = i + 1; break; } }
  return { color: RAMP_COLORS[ramp] || RAMP_COLORS.fire, opacity: RAMP_OPACITIES[idx] };
}
function quantileBreaks(vals, n) {
  const sorted = [...vals].filter(v=>v>0).sort((a,b)=>a-b);
  if (!sorted.length) return [0,0,0,0,0];
  const breaks = [];
  for (let i=1; i<n; i++) breaks.push(sorted[Math.floor(sorted.length * i/n)]);
  return breaks;
}

function equalWidthBreaks(vals, n) {
  const filtered = vals.filter(v=>v>0);
  if (!filtered.length) return [0,0,0,0,0];
  const min = Math.min(...filtered);
  const max = Math.max(...filtered);
  const step = (max - min) / n;
  const breaks = [];
  for (let i=1; i<n; i++) breaks.push(Math.round(min + step * i));
  return breaks;
}
function metricLabel(m) {
  const labels = {
    est_population:        'Est. Population',
    pct_hydrant_1000ft:    'Hydrant 1000ft %',
    pct_flood_ae:          'AE Flood Area %',
    sfr_units:             'SFR Bldg',
    multifamily_units:     'Multifamily Bldg',
    mobile_units:          'Mobile Homes',
    residential_units:     'Residential Bldg (All)',
    residential_pct:       'Residential %',
    residential_grnd_sqft: 'Residential Total Sqft',
    residential_avg_yrbl:  'Residential Bldg Age',
    sfr_flood_pct:         'SFR Flood %',
    commercial_units:      'Commercial Bldg',
    retail_units:          'Retail Bldg',
    commercial_grnd_sqft:  'Commercial Total Sqft',
    retail_grnd_sqft:      'Retail Total Sqft',
    vacant_units:          'Vacant Lots',
    vacant_pct:            'Vacant %',
  };
  return labels[m] || m;
}

// ── INCIDENT CHOROPLETH helpers ───────────────────────────────────────────
// Mirrors _compute_cuts() and _build_band_colors() from render_riskmaps.py

function incidentCol(program, risk) {
  return `${program.toLowerCase()}_${risk.toLowerCase().replace('-','').replace(' ','')}`;
}

function computeEqualWidthCuts(counts, nBands) {
  const maxVal = Math.max(...counts.filter(v=>v>0), 0);
  if (maxVal === 0) return [0, 1];
  const step = maxVal / nBands;
  const raw  = Array.from({length:nBands}, (_,i) => Math.round(step * i));
  raw.push(maxVal + 1);
  const deduped = [raw[0]];
  for (const c of raw.slice(1)) { if (c > deduped[deduped.length-1]) deduped.push(c); }
  return deduped;
}

function lerpHex(dark, neon, t) {
  const d = parseInt(dark.slice(1),16), n = parseInt(neon.slice(1),16);
  const dr=(d>>16)&255, dg=(d>>8)&255, db=d&255;
  const nr=(n>>16)&255, ng=(n>>8)&255, nb=n&255;
  const r=Math.round(dr+(nr-dr)*t), g=Math.round(dg+(ng-dg)*t), b=Math.round(db+(nb-db)*t);
  return '#'+[r,g,b].map(x=>x.toString(16).padStart(2,'0')).join('');
}

// Incident risk band opacities: 0 = no incidents (transparent), 1-4 = pale→saturated
const INCIDENT_OPACITIES = [0.06, 0.28, 0.52, 0.76, 0.96];

function buildBandColors(risk, nBands) {
  // Returns array: index 0 = zero/no-incidents color, indices 1..nBands = low→high
  const neon = RISK_NEON[risk] || '#00cfff';
  const colors = ['rgba(128,128,128,0.06)']; // zero band — near transparent
  for (let i = 0; i < nBands; i++) {
    const op = INCIDENT_OPACITIES[Math.min(i, INCIDENT_OPACITIES.length - 1)];
    // Parse neon hex to rgb
    const r = parseInt(neon.slice(1,3),16);
    const g = parseInt(neon.slice(3,5),16);
    const b = parseInt(neon.slice(5,7),16);
    colors.push(`rgba(${r},${g},${b},${op})`);
  }
  return colors;
}

function incidentFillStyle(count, cuts, bandColors) {
  // Returns {fillColor, fillOpacity} for Leaflet style
  if (!count || isNaN(count) || count <= 0) return { fillColor: '#888888', fillOpacity: 0.06 };
  let idx = bandColors.length - 1;
  for (let i = 0; i < cuts.length - 1; i++) {
    if (count >= cuts[i] && count < cuts[i+1]) { idx = i + 1; break; }
  }
  const col = bandColors[Math.min(idx, bandColors.length - 1)];
  // col is already an rgba string — use fillOpacity:1 so Leaflet respects the rgba
  return { fillColor: col, fillOpacity: 1 };
}

// ── LEGENDS ───────────────────────────────────────────────────────────────
function buildCommunityLegend(breaks, ramp, metric) {
  const swatches = getRampSwatches(ramp);
  const isYear = YEAR_METRICS.has(metric);
  const isPct  = PCT_METRICS.has(metric);
  let labels;
  if (isPct) {
    labels = ['Zero / no data','0 – 20%','20 – 40%','40 – 60%','60 – 80%','80 – 100%'];
  } else {
    const fmtBreak = v => isYear ? Math.round(v) + ' yrs' : fmt(v, metric);
    labels = [
      'Zero / no data',
      `< ${fmtBreak(breaks[0])}`,
      `${fmtBreak(breaks[0])} – ${fmtBreak(breaks[1])}`,
      `${fmtBreak(breaks[1])} – ${fmtBreak(breaks[2])}`,
      `${fmtBreak(breaks[2])} – ${fmtBreak(breaks[3])}`,
      `> ${fmtBreak(breaks[3])}`,
    ];
  }
  document.getElementById('legend-title').textContent = metricLabel(metric);
  document.getElementById('legend-rows').innerHTML = swatches.map((c,i) =>
    `<div class="legend-row"><div class="legend-swatch" style="background:${c};border:1px solid rgba(128,128,128,0.2)"></div><span>${labels[i]||''}</span></div>`
  ).join('');
}

function buildIncidentLegend(cuts, bandColors, program, risk) {
  const neon = RISK_NEON[risk] || '#00cfff';
  document.getElementById('legend-title').innerHTML =
    `<span style="color:${PROG_COLORS[program]||'var(--text)'}">${program}</span>`
    + `<span style="color:var(--muted)"> · </span>`
    + `<span style="color:${neon}">${risk}</span>`;
  const rows = [
    `<div class="legend-row"><div class="legend-swatch" style="background:rgba(128,128,128,0.10);border:1px solid rgba(128,128,128,0.2)"></div><span>No Incidents</span></div>`
  ];
  const nActive = cuts.length - 1;
  for (let i = 0; i < nActive; i++) {
    const lo  = cuts[i].toLocaleString();
    const hi  = i === nActive-1 ? '∞' : (cuts[i+1]-1).toLocaleString();
    const col = bandColors[i+1] || bandColors[bandColors.length-1];
    rows.push(
      `<div class="legend-row"><div class="legend-swatch" style="background:${col};border:1px solid rgba(128,128,128,0.2)"></div>`
      + `<span>${lo} – ${hi}</span></div>`
    );
  }
  document.getElementById('legend-rows').innerHTML = rows.join('');
}

// ── CHOROPLETH DISPATCHER ─────────────────────────────────────────────────
function renderChoropleth() {
  if (activeMode === 'coverage') return;
  if (choroplethLayer) map.removeLayer(choroplethLayer);
  activeMode === 'community' ? renderCommunityChoropleth() : renderIncidentChoropleth();
  // Layer order: choropleth → conservation → dim overlay → station boundaries → ESZ labels → station dots
  if (conservationLayer && showConservation) conservationLayer.bringToFront();
  bringStationLayersToFront();
}

function renderCommunityChoropleth() {
  const metric = currentMetric;
  const ramp   = getRamp(metric);
  const isYear = YEAR_METRICS.has(metric);
  const isPct  = PCT_METRICS.has(metric);

  const CURRENT_YEAR = new Date().getFullYear();
  const rawVals = ESZ_GEOJSON.features
    .map(f => parseFloat(f.properties[metric]))
    .filter(v => !isNaN(v) && v > 0);
  const vals = isYear ? rawVals.map(v => CURRENT_YEAR - v) : rawVals;

  // For percentage metrics use fixed 0–100 bands so 100% always = brightest color.
  // For year/count metrics use quantile (skew-resistant) or equal-width breaks.
  const breaks = isPct  ? [20, 40, 60, 80]
               : isYear ? equalWidthBreaks(vals, 5)
               :          quantileBreaks(vals, 5);

  // Always render all ESZs — dim those outside the selected station
  const fc = ESZ_GEOJSON;

  choroplethLayer = L.geoJSON(fc, {
    style: feat => {
      const sid        = feat.properties.StationID || feat.properties.station_id;
      const inStation  = activeStation === 'ALL' || sid === activeStation;
      const raw = parseFloat(feat.properties[metric]);
      const val = isYear ? (CURRENT_YEAR - raw) : raw;
      const c   = communityColor(val, breaks, ramp);
      const borderColor = isLightMode ? '#00000030' : '#ffffff50';
      if (!inStation) {
        // Dim ESZs outside the selected station
        return {
          fillColor:   isLightMode ? '#c8cce0' : '#1a1a2e',
          fillOpacity: isLightMode ? 0.6 : 0.7,
          color: borderColor, weight:0.4, opacity:0.5,
        };
      }
      return {
        fillColor:   c.color,
        fillOpacity: c.opacity,
        color: borderColor, weight:0.5, opacity:1,
      };
    },
    onEachFeature: (feat, layer) => {
      const sid       = feat.properties.StationID || feat.properties.station_id;
      const inStation = activeStation === 'ALL' || sid === activeStation;
      if (!inStation) return; // dimmed ESZs — no interaction
      layer.on({
        mouseover: e => {
          if (!windowFocused) return;
          const borderColor = isLightMode ? '#000000' : '#ffffff';
          e.target.setStyle({weight:2, color:borderColor, opacity:1});
          e.target.bringToFront();
        },
        mouseout: e => {
          const isActive = activeESZ && feat.properties.ESZ_ID === activeESZ;
          const borderColor = isLightMode ? '#00000030' : '#ffffff50';
          e.target.setStyle(isActive
            ? {weight:2, color: isLightMode ? '#000' : '#fff', opacity:1}
            : {weight:0.5, color:borderColor, opacity:1}
          );
        },
        click: () => selectESZ(feat.properties),
      });
      layer.bindTooltip(
        `<b>${feat.properties.ESZ_ID}</b><br>${metricLabel(metric)}: ${fmt(feat.properties[metric], metric)}`,
        {sticky:true, opacity:0.9, className:'esz-tip', permanent:false, closeOnClick:true}
      );
    }
  }).addTo(map);

  buildCommunityLegend(breaks, ramp, metric);
}

function renderIncidentChoropleth() {
  if (!ESZ_COUNTS || !activeProgram || !activeRisk) return;

  const col    = incidentCol(activeProgram, activeRisk);
  const counts = ESZ_GEOJSON.features.map(f => {
    const e = ESZ_COUNTS[f.properties.ESZ_ID];
    return e ? (parseInt(e[col]) || 0) : 0;
  });
  const cuts       = computeEqualWidthCuts(counts, N_BANDS);
  const bandColors = buildBandColors(activeRisk, N_BANDS);
  const fc = ESZ_GEOJSON; // always render all ESZs

  choroplethLayer = L.geoJSON(fc, {
    style: feat => {
      const sid       = feat.properties.StationID || feat.properties.station_id;
      const inStation = activeStation === 'ALL' || sid === activeStation;
      const borderColor = isLightMode ? '#00000030' : '#ffffff50';
      if (!inStation) {
        return {
          fillColor:   isLightMode ? '#c8cce0' : '#1a1a2e',
          fillOpacity: isLightMode ? 0.6 : 0.7,
          color: borderColor, weight: 0.4, opacity: 0.5,
        };
      }
      const e     = ESZ_COUNTS[feat.properties.ESZ_ID];
      const count = e ? (parseInt(e[col]) || 0) : 0;
      const fs    = incidentFillStyle(count, cuts, bandColors);
      return { ...fs, color: borderColor, weight: 0.5, opacity: 1 };
    },
    onEachFeature: (feat, layer) => {
      const sid       = feat.properties.StationID || feat.properties.station_id;
      const inStation = activeStation === 'ALL' || sid === activeStation;
      if (!inStation) return; // dimmed — no interaction
      const e     = ESZ_COUNTS[feat.properties.ESZ_ID];
      const count = e ? (parseInt(e[col]) || 0) : 0;
      layer.on({
        mouseover: ev => {
          if (!windowFocused) return;
          ev.target.setStyle({ weight:2, color: isLightMode ? '#000' : '#fff', opacity:1 });
          ev.target.bringToFront();
        },
        mouseout: ev => {
          const isActive = activeESZ && feat.properties.ESZ_ID === activeESZ;
          const borderColor = isLightMode ? '#00000030' : '#ffffff50';
          ev.target.setStyle(isActive
            ? { weight:2, color: isLightMode ? '#000' : '#fff', opacity:1 }
            : { weight:0.5, color: borderColor, opacity:1 }
          );
        },
        click: () => selectESZIncident(feat.properties, count),
      });
      layer.bindTooltip(
        `<b>${feat.properties.ESZ_ID}</b><br>${activeProgram} ${activeRisk}: ${count.toLocaleString()} incidents`,
        {sticky:true, opacity:0.9, className:'esz-tip', permanent:false, closeOnClick:true}
      );
    }
  }).addTo(map);

  buildIncidentLegend(cuts, bandColors, activeProgram, activeRisk);
}

// ── SIDEBAR: STATION OVERVIEW ─────────────────────────────────────────────
function showStationOverview(sid) {
  const s = STATION_SUMS[sid];
  document.getElementById('sidebar-title').textContent = sid === 'ALL' ? 'All Stations' : `Station ${sid}`;
  document.getElementById('sidebar-sub').textContent = sid === 'ALL'
    ? `${Object.values(STATION_SUMS).reduce((a,b)=>a+b.esz_count,0)} ESZs · Click a polygon for profile`
    : `${s?.esz_count ?? 0} ESZs · Click a polygon for profile`;

  if (activeMode === 'incident') { showIncidentStationOverview(sid); return; }
  if (activeMode === 'coverage') { showCoverageOverview(); return; }

  const stations  = sid === 'ALL' ? Object.values(STATION_SUMS) : [s];
  const totEszs   = stations.reduce((a,st)=>a+(st?.esz_count||0),0);
  const totPop    = stations.reduce((a,st)=>a+(st?.est_population||0),0);
  const totSqMi   = stations.reduce((a,st)=>a+(st?.sq_miles||0),0);
  const totRes    = stations.reduce((a,st)=>a+(st?.residential_units||0),0);
  const totComm   = stations.reduce((a,st)=>a+(st?.commercial_units||0),0);
  const totRetail = stations.reduce((a,st)=>a+(st?.retail_units||0),0);

  document.getElementById('sidebar-body').innerHTML = `
    <div class="sec-hdr">Jurisdiction Summary</div>
    <table class="kv-table">
      <tr><td>Total ESZs</td><td>${totEszs.toLocaleString()}</td></tr>
      <tr><td>Est. Population</td><td>${totPop.toLocaleString()}</td></tr>
      <tr><td>Sq Miles</td><td>${totSqMi.toFixed(2)}</td></tr>
      <tr><td>Residential Units</td><td>${totRes.toLocaleString()}</td></tr>
      <tr><td>Commercial Units</td><td>${totComm.toLocaleString()}</td></tr>
      <tr><td>Retail Units</td><td>${totRetail.toLocaleString()}</td></tr>
    </table>
    <div class="sec-hdr">By Station</div>
    ${stations.map(st => {
      const c = STATION_COLORS[st.StationID] || 'var(--accent)';
      return `
      <div class="station-card" style="border-left-color:${c}" onclick="filterStation('${st.StationID}')">
        <div class="sc-head">${st.StationID}</div>
        <div class="sc-kv">
          <div class="sc-kv-item"><div class="sc-kv-lbl">ESZs</div><div class="sc-kv-val">${st.esz_count}</div></div>
          <div class="sc-kv-item"><div class="sc-kv-lbl">Pop.</div><div class="sc-kv-val">${st.est_population.toLocaleString()}</div></div>
          <div class="sc-kv-item"><div class="sc-kv-lbl">Sq Mi</div><div class="sc-kv-val">${(st.sq_miles||0).toFixed(2)}</div></div>
          <div class="sc-kv-item"><div class="sc-kv-lbl">Res Units</div><div class="sc-kv-val">${(st.residential_units||0).toLocaleString()}</div></div>
          <div class="sc-kv-item"><div class="sc-kv-lbl">Comm Units</div><div class="sc-kv-val">${(st.commercial_units||0).toLocaleString()}</div></div>
          <div class="sc-kv-item"><div class="sc-kv-lbl">Retail Units</div><div class="sc-kv-val">${(st.retail_units||0).toLocaleString()}</div></div>
        </div>
      </div>`;
    }).join('')}
    <div style="margin-top:8px;padding:8px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;font-size:13px;color:var(--muted)">
      Click a station card or any ESZ polygon to explore.
    </div>
  `;
}

function showIncidentStationOverview(sid) {
  if (!ESZ_COUNTS || !activeProgram || !activeRisk) return;
  const col   = incidentCol(activeProgram, activeRisk);
  const neon  = RISK_NEON[activeRisk] || '#00cfff';
  const pCol  = PROG_COLORS[activeProgram] || '#fff';

  const stTotals = {};
  for (const [eszId, entry] of Object.entries(ESZ_COUNTS)) {
    const feat = ESZ_GEOJSON.features.find(f=>f.properties.ESZ_ID === eszId);
    if (!feat) continue;
    const st = feat.properties.StationID || feat.properties.station_id;
    if (!st) continue;
    if (!stTotals[st]) stTotals[st] = {incidents:0, esz_count:0, esz_with_incidents:0};
    const count = parseInt(entry[col]) || 0;
    stTotals[st].incidents += count;
    stTotals[st].esz_count += 1;
    if (count > 0) stTotals[st].esz_with_incidents += 1;
  }

  const stList = (sid === 'ALL'
    ? Object.entries(stTotals).sort((a,b)=>b[1].incidents-a[1].incidents)
    : Object.entries(stTotals).filter(([s])=>s===sid)
  );
  const grandTotal = stList.reduce((a,[,v])=>a+v.incidents,0);

  document.getElementById('sidebar-body').innerHTML = `
    <div class="sec-hdr" style="color:${neon}">
      <span style="color:${pCol}">${activeProgram}</span>&nbsp;·&nbsp;${activeRisk} Risk
    </div>
    <table class="kv-table">
      <tr><td>Total Incidents</td>
          <td><span class="kv-val-lg" style="color:${neon}">${grandTotal.toLocaleString()}</span></td></tr>
    </table>
    <div class="sec-hdr">By Station</div>
    ${stList.map(([st, d])=>`
      <div class="incident-stat-card" style="border-left-color:${STATION_COLORS[st]||'var(--accent)'}">
        <div class="isc-head">
          <span class="isc-prog">${st}</span>
          <span class="isc-risk" style="color:${neon};border:1px solid ${neon};background:${neon}18">${d.incidents.toLocaleString()} incidents</span>
        </div>
        <div class="isc-kv">
          <div class="isc-kv-item"><div class="isc-kv-lbl">ESZs w/ incidents</div><div class="isc-kv-val">${d.esz_with_incidents} / ${d.esz_count}</div></div>
          <div class="isc-kv-item"><div class="isc-kv-lbl">Avg per ESZ</div><div class="isc-kv-val">${d.esz_count ? (d.incidents/d.esz_count).toFixed(1) : '—'}</div></div>
        </div>
      </div>
    `).join('')}
    <div style="margin-top:8px;padding:8px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;font-size:13px;color:var(--muted)">
      Click any ESZ polygon to see its incident detail.
    </div>
  `;
}

// ── SIDEBAR: ESZ DETAIL (community) ──────────────────────────────────────
function dqClass(flag) {
  if (!flag || flag==='OK') return 'dq-ok';
  if (flag==='REVIEW') return 'dq-review';
  return 'dq-low';
}

function selectESZ(props) {
  if (activeMode === 'incident') {
    const e     = ESZ_COUNTS?.[props.ESZ_ID];
    const count = e ? (parseInt(e[incidentCol(activeProgram, activeRisk)]) || 0) : 0;
    selectESZIncident(props, count);
    return;
  }

  activeESZ = props.ESZ_ID;
  document.getElementById('sidebar-title').textContent = props.ESZ_ID;
  document.getElementById('sidebar-sub').textContent =
    `${props.StationID} · ${metricLabel(currentMetric)}: ${fmt(props[currentMetric], currentMetric)}`;

  if (choroplethLayer) {
    const metric = currentMetric;
    const ramp   = getRamp(metric);
    const isYear = YEAR_METRICS.has(metric);
    const isPct  = PCT_METRICS.has(metric);
    const CURRENT_YEAR = new Date().getFullYear();
    const rawVals = ESZ_GEOJSON.features.map(f=>parseFloat(f.properties[metric])).filter(v=>!isNaN(v)&&v>0);
    const vals   = isYear ? rawVals.map(v=>CURRENT_YEAR-v) : rawVals;
    const breaks = isPct  ? [20, 40, 60, 80]
                 : isYear ? equalWidthBreaks(vals,5)
                 :          quantileBreaks(vals,5);
    choroplethLayer.eachLayer(l => {
      const p = l.feature.properties;
      const isActive = p.ESZ_ID === activeESZ;
      const raw = parseFloat(p[metric]);
      const val = isYear ? (CURRENT_YEAR - raw) : raw;
      const c   = communityColor(val, breaks, ramp);
      const borderColor = isLightMode ? '#00000030' : '#ffffff50';
      l.setStyle({
        fillColor:   c.color,
        fillOpacity: c.opacity,
        weight:      isActive ? 2 : 0.5,
        color:       isActive ? (isLightMode ? '#000' : '#fff') : borderColor,
        opacity:     1,
      });
      if (isActive) l.bringToFront();
    });
  }

  const totalUnits = CATEGORIES.reduce((s,c)=>s+(parseInt(props[c+'_units'])||0),0);
  const catCards = CATEGORIES.map(cat => {
    const units  = parseInt(props[cat+'_units'])||0;
    const pctVal = parseFloat(props[cat+'_pct'])||0;
    const sqft   = parseInt(props[cat+'_grnd_sqft'])||0;
    const yr     = props[cat+'_avg_yrbl']||'—';
    const hyd    = parseFloat(props[cat+'_hyd_pct'])||0;
    const flood  = parseFloat(props[cat+'_flood_pct'])||0;
    if (!units) return '';
    return `<div class="cat-card">
      <div class="cat-card-head">
        <span class="cat-card-name">${cat}</span>
        <span class="cat-card-units">${units.toLocaleString()} units</span>
      </div>
      <div class="cat-card-body">
        <div class="cat-kv"><span class="cat-kv-lbl">Sq Ft</span><span class="cat-kv-val">${sqft>0?(sqft/1000).toFixed(0)+'k sqft':'—'}</span></div>
        <div class="cat-kv"><span class="cat-kv-lbl">Avg Yr Built</span><span class="cat-kv-val">${yr}</span></div>
        <div class="cat-kv"><span class="cat-kv-lbl">Hydrant Cvg</span><span class="cat-kv-val">${hyd.toFixed(1)}%</span></div>
        <div class="cat-kv"><span class="cat-kv-lbl">Flood Zone</span><span class="cat-kv-val">${flood.toFixed(1)}%</span></div>
        <div class="pct-bar-row">
          <div class="pct-bar-track"><div class="pct-bar-fill" style="width:${Math.min(pctVal,100)}%"></div></div>
          <span style="font-size:12px;color:var(--muted);margin-top:2px;display:block">${pctVal.toFixed(1)}% of mix</span>
        </div>
      </div>
    </div>`;
  }).join('');

  document.getElementById('sidebar-body').innerHTML = `
    <div class="sec-hdr">Overview</div>
    <table class="kv-table">
      <tr><td>ESZ</td><td><span class="kv-val-lg">${props.ESZ_ID}</span></td></tr>
      <tr><td>Station</td><td><span class="kv-val-lg">${props.StationID}</span></td></tr>
      <tr><td>Est. Population</td><td><span class="kv-val-lg">${fmt(props.est_population)}</span></td></tr>
      <tr><td>Total Units</td><td>${totalUnits.toLocaleString()}</td></tr>
      <tr><td>Data Quality</td><td class="${dqClass(props.data_quality_flag)}">${props.data_quality_flag||'OK'}</td></tr>
    </table>
    <div class="sec-hdr">Coverage</div>
    <table class="kv-table">
      <tr><td>Hydrant (1000 ft)</td>
        <td><div class="mini-bar-wrap">
          <div class="mini-bar-track"><div class="mini-bar-fill" style="width:${Math.min(parseFloat(props.pct_hydrant_1000ft)||0,100)}%;background:var(--accent)"></div></div>
          <span>${fmtPct(props.pct_hydrant_1000ft)}</span>
        </div></td>
      </tr>
      <tr><td>Flood Zone AE</td>
        <td><div class="mini-bar-wrap">
          <div class="mini-bar-track"><div class="mini-bar-fill" style="width:${Math.min(parseFloat(props.pct_flood_ae)||0,100)}%;background:#E65100"></div></div>
          <span>${fmtPct(props.pct_flood_ae)}</span>
        </div></td>
      </tr>
    </table>
    <div class="sec-hdr">Category Breakdown</div>
    <div class="cat-cards">${catCards}</div>
    <div class="action-row">
      <button class="btn-sec" onclick="showStationOverview('${props.StationID}')">← ${props.StationID}</button>
      <button class="btn-pri" onclick="exportPDF()">⬇ PDF · This ESZ</button>
    </div>
  `;
}

// ── SIDEBAR: ESZ DETAIL (incident) ────────────────────────────────────────
function selectESZIncident(props, count) {
  activeESZ = props.ESZ_ID;
  const neon = RISK_NEON[activeRisk] || '#00cfff';
  const pCol = PROG_COLORS[activeProgram] || '#fff';

  document.getElementById('sidebar-title').textContent = props.ESZ_ID;
  document.getElementById('sidebar-sub').textContent =
    `${props.StationID} · ${activeProgram} ${activeRisk}: ${count.toLocaleString()} incidents`;

  if (choroplethLayer) {
    const col = incidentCol(activeProgram, activeRisk);
    const counts = ESZ_GEOJSON.features.map(f=>{
      const e = ESZ_COUNTS[f.properties.ESZ_ID];
      return e ? (parseInt(e[col])||0) : 0;
    });
    const cuts       = computeEqualWidthCuts(counts, N_BANDS);
    const bandColors = buildBandColors(activeRisk, N_BANDS);
    choroplethLayer.eachLayer(l => {
      const p        = l.feature.properties;
      const e        = ESZ_COUNTS?.[p.ESZ_ID];
      const cnt      = e ? (parseInt(e[col])||0) : 0;
      const isActive = p.ESZ_ID === activeESZ;
      const fs       = incidentFillStyle(cnt, cuts, bandColors);
      const borderColor = isLightMode ? '#00000030' : '#ffffff50';
      l.setStyle({
        ...fs,
        weight:  isActive ? 2 : 0.5,
        color:   isActive ? (isLightMode ? '#000' : '#fff') : borderColor,
        opacity: 1,
      });
      if (isActive) l.bringToFront();
    });
  }

  const entry = ESZ_COUNTS?.[props.ESZ_ID] || {};
  const breakdownRows = Object.entries(PROG_RISK_MAP).map(([prog, risks]) => {
    const progTotal = risks.reduce((s,r)=>s+(parseInt(entry[incidentCol(prog,r)])||0),0);
    return `
      <tr>
        <td colspan="2" style="padding-top:8px;padding-bottom:2px">
          <span style="font-family:var(--font-h);font-size:14px;font-weight:700;color:${PROG_COLORS[prog]||'#fff'};text-transform:uppercase;letter-spacing:.06em">${prog}</span>
          <span style="font-size:13px;color:var(--muted);margin-left:6px">${progTotal.toLocaleString()} total</span>
        </td>
      </tr>
      ${risks.map(r => {
        const cnt = parseInt(entry[incidentCol(prog,r)]) || 0;
        const rn  = RISK_NEON[r] || '#ccc';
        return `<tr>
          <td style="padding-left:10px;color:${rn}">${r}</td>
          <td style="color:var(--text);font-weight:600;text-align:right">${cnt.toLocaleString()}</td>
        </tr>`;
      }).join('')}`;
  }).join('');

  document.getElementById('sidebar-body').innerHTML = `
    <div class="sec-hdr" style="color:${neon}">
      <span style="color:${pCol}">${activeProgram}</span>&nbsp;·&nbsp;${activeRisk} Risk
    </div>
    <table class="kv-table">
      <tr><td>ESZ</td><td><span class="kv-val-lg">${props.ESZ_ID}</span></td></tr>
      <tr><td>Station</td><td>${props.StationID}</td></tr>
      <tr><td>${activeProgram} ${activeRisk}</td>
          <td><span class="kv-val-lg" style="color:${neon}">${count.toLocaleString()}</span></td></tr>
    </table>
    <div class="sec-hdr">All Programs · This ESZ</div>
    <table class="kv-table">${breakdownRows}</table>
    <div class="action-row">
      <button class="btn-sec" onclick="showStationOverview('${props.StationID}')">← ${props.StationID}</button>
      <button class="btn-pri" onclick="exportPDF()">⬇ PDF · This ESZ</button>
    </div>
  `;
}


// ── METRIC CHANGE ─────────────────────────────────────────────────────────
document.getElementById('metric-select').addEventListener('change', e => {
  currentMetric = e.target.value;
  if (activeMode === 'community') {
    renderChoropleth();
    if (activeESZ) {
      const feat = ESZ_GEOJSON.features.find(f=>f.properties.ESZ_ID===activeESZ);
      if (feat) selectESZ(feat.properties);
    }
  }
});

// ── EXPORT ────────────────────────────────────────────────────────────────
function exportPDF() {
  alert('PDF export will be handled by render_report.py (Playwright).\nMode: ' + activeMode
    + (activeMode==='incident' ? `\nProgram: ${activeProgram}  Risk: ${activeRisk}` : '')
    + '\nStation: ' + activeStation + '\nESZ: ' + (activeESZ||'All'));
}

// ── COVERAGE MODE ─────────────────────────────────────────────────────────

function clearIsochroneLayer() {
  if (isochroneLayer) { map.removeLayer(isochroneLayer); isochroneLayer = null; }
}

// Build the subheader for coverage: Road View | Polygons | ESZ View + sub-tabs
function buildCoverageSubheader() {
  document.getElementById('coverage-view-tabs').innerHTML =
    [['road','Road View'],['polygons','Polygons'],['esz','ESZ View']].map(([v,label]) =>
      `<button class="cov-view-tab${activeCovView===v?' active':''}" data-view="${v}"
         onclick="selectCovView('${v}')">${label}</button>`
    ).join('');
  buildCoverageSubTabs();
}

function buildCoverageSubTabs() {
  if (activeCovView === 'esz') {
    // Discover available time+mph combos from ESZ coverage column names
    // Columns: cov_{mph}mph_{min}min
    const sample = ESZ_DRIVE_COV?.features?.[0]?.properties || {};
    const covKeys = Object.keys(sample).filter(k => k.startsWith('cov_'));
    const times  = [...new Set(covKeys.map(k => { const m=k.match(/_(\d+)min$/); return m?m[1]:null; }).filter(Boolean))].sort((a,b)=>+a-+b);
    const speeds = [...new Set(covKeys.map(k => { const m=k.match(/cov_(\d+)mph/);  return m?m[1]:null; }).filter(Boolean))].sort((a,b)=>+a-+b);

    if (!activeCovDriveTime || !times.includes(activeCovDriveTime)) activeCovDriveTime = times[0] || null;
    if (!activeCovMPH       || activeCovMPH === 'ALL' || !speeds.includes(activeCovMPH)) activeCovMPH = speeds[0] || null;

    const timeHtml  = times.map(t =>
      `<button class="cov-sub-tab${activeCovDriveTime===t?' active':''}" onclick="selectCovDriveTime('${t}')">${t} min</button>`
    ).join('');
    const speedHtml = speeds.map(s =>
      `<button class="cov-sub-tab${activeCovMPH===s?' active':''}" onclick="selectCovMPH('${s}')">${s} mph</button>`
    ).join('');

    document.getElementById('coverage-sub-tabs').innerHTML =
      `<span class="cov-sub-label">Time</span><div class="cov-pill-group">${timeHtml}</div>`
      + `<div class="cov-sub-sep"></div>`
      + `<span class="cov-sub-label">MPH</span><div class="cov-pill-group">${speedHtml}</div>`;
    return;
  }

  const allFeats = activeCovView === 'road'
    ? (DRIVE_TIME_ROADS?.features || [])
    : (DRIVE_TIME_GEO?.features   || []);

  const times = [...new Set(allFeats.map(f => String(parseFloat(f.properties.minutes))))]
    .filter(t => !isNaN(parseFloat(t))).sort((a,b) => parseFloat(a)-parseFloat(b));
  if (!activeCovDriveTime && times.length) activeCovDriveTime = times[0];

  const speeds = [...new Set(allFeats.map(f => String(parseFloat(f.properties.speed_mph))))]
    .filter(s => !isNaN(parseFloat(s))).sort((a,b) => parseFloat(a)-parseFloat(b));
  const offerAllMPH = activeCovView === 'polygons' && activeStation !== 'ALL';
  if (!activeCovMPH || (activeCovMPH === 'ALL' && !offerAllMPH)) {
    activeCovMPH = offerAllMPH ? 'ALL' : (speeds[0] || null);
  }

  const timeHtml = times.map(t =>
    `<button class="cov-sub-tab${activeCovDriveTime===t?' active':''}"
       onclick="selectCovDriveTime('${t}')">${t} min</button>`
  ).join('');

  const allMPHBtn = offerAllMPH
    ? `<button class="cov-sub-tab cov-sub-tab-all${activeCovMPH==='ALL'?' active':''}"
         onclick="selectCovMPH('ALL')">All</button>`
    : '';
  const speedHtml = allMPHBtn + speeds.map(s =>
    `<button class="cov-sub-tab${activeCovMPH===s?' active':''}"
       onclick="selectCovMPH('${s}')">${s} mph</button>`
  ).join('');

  document.getElementById('coverage-sub-tabs').innerHTML =
    `<span class="cov-sub-label">Time</span>`
    + `<div class="cov-pill-group">${timeHtml}</div>`
    + `<div class="cov-sub-sep"></div>`
    + `<span class="cov-sub-label">MPH</span>`
    + `<div class="cov-pill-group">${speedHtml}</div>`;
}

function selectCovView(view) {
  activeCovView = view;
  // Reset MPH default when switching views so the All/specific logic re-evaluates
  activeCovMPH = null;
  document.querySelectorAll('.cov-view-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === view)
  );
  buildCoverageSubTabs();
  renderCoverageLayer();
  showCoverageOverview();
}

function selectCovMPH(mph) {
  activeCovMPH = mph;
  buildCoverageSubTabs();
  renderCoverageLayer();
  showCoverageOverview();
}

function selectCovDriveTime(dt) {
  activeCovDriveTime = dt;
  buildCoverageSubTabs();
  renderCoverageLayer();
  showCoverageOverview();
}

// ── COVERAGE RENDER DISPATCHER ────────────────────────────────────────────
function renderCoverageLayer() {
  clearIsochroneLayer();
  if (choroplethLayer) { map.removeLayer(choroplethLayer); choroplethLayer = null; }

  if      (activeCovView === 'esz')      renderCoverageESZ();
  else if (activeCovView === 'polygons') renderCoveragePolygons();
  else                                   renderCoverageRoads();
}

// ── ESZ VIEW ──────────────────────────────────────────────────────────────
// Choropleth of ESZ polygons colored by cov_{mph}mph_{min}min (0→1 fraction).
// Yellow ramp: dark at 0%, bright at 100%. One time + one MPH selected at a time.
// ESZ coverage ramp: 0% coverage = near transparent, 100% = fully saturated teal-blue
// Using rgba so the underlying map shows through at low coverage
const ESZ_COV_COLOR = '#2e6da4';  // muted steel blue
const ESZ_COV_OPACITIES = [0.04, 0.18, 0.36, 0.56, 0.76, 0.95];

function eszCovColor(fraction) {
  if (fraction === null || fraction === undefined || isNaN(fraction) || fraction <= 0)
    return 'rgba(128,128,128,0.06)';
  const clamped = Math.max(0, Math.min(1, fraction));
  // Interpolate opacity across the ramp
  const scaled = clamped * (ESZ_COV_OPACITIES.length - 1);
  const lo = Math.floor(scaled);
  const hi = Math.min(lo + 1, ESZ_COV_OPACITIES.length - 1);
  const t  = scaled - lo;
  const op = ESZ_COV_OPACITIES[lo] + (ESZ_COV_OPACITIES[hi] - ESZ_COV_OPACITIES[lo]) * t;
  const r = parseInt(ESZ_COV_COLOR.slice(1,3),16);
  const g = parseInt(ESZ_COV_COLOR.slice(3,5),16);
  const b = parseInt(ESZ_COV_COLOR.slice(5,7),16);
  return `rgba(${r},${g},${b},${op.toFixed(3)})`;
}

function eszCovKey() {
  return `cov_${activeCovMPH}mph_${activeCovDriveTime}min`;
}

function renderCoverageESZ() {
  if (!ESZ_DRIVE_COV) { buildCoverageLegendEmpty('ESZ coverage data unavailable (esz_drive_coverage.geojson)'); return; }
  if (!activeCovMPH || !activeCovDriveTime) { buildCoverageLegendEmpty('Select a speed and time'); return; }

  const key = eszCovKey();

  // Check the key actually exists
  const sampleProps = ESZ_DRIVE_COV.features[0]?.properties || {};
  if (!(key in sampleProps)) { buildCoverageLegendEmpty(`No data for ${activeCovMPH} mph / ${activeCovDriveTime} min`); return; }

  // Filter by station if not ALL — each ESZ row is per station_id
  let features = ESZ_DRIVE_COV.features;
  if (activeStation !== 'ALL') {
    features = features.filter(f => f.properties.station_id === activeStation);
  }

  // For ALL stations: if an ESZ appears for multiple stations, take the max coverage
  // Build a lookup: ESZ_ID → best coverage value + properties
  const eszBest = {};
  for (const f of features) {
    const id  = f.properties.ESZ_ID;
    const val = parseFloat(f.properties[key]) || 0;
    if (!eszBest[id] || val > eszBest[id].val) {
      eszBest[id] = { val, props: f.properties, geometry: f.geometry };
    }
  }

  const renderFeatures = Object.values(eszBest).map(e => ({
    type: 'Feature',
    properties: { ...e.props, _covVal: e.val },
    geometry: e.geometry,
  }));

  if (!renderFeatures.length) { buildCoverageLegendEmpty('No ESZ data for selection'); return; }

  isochroneLayer = L.geoJSON({ type:'FeatureCollection', features: renderFeatures }, {
    style: feat => {
      const val = feat.properties._covVal;
      const borderColor = isLightMode ? '#00000030' : '#ffffff50';
      return {
        fillColor:   eszCovColor(val),
        fillOpacity: 1,
        color:       borderColor,
        weight:      0.5,
        opacity:     1,
      };
    },
    onEachFeature: (feat, layer) => {
      const props = feat.properties;
      const val   = props._covVal;
      const pct   = (val * 100).toFixed(1);
      layer.on({
        mouseover: e => {
          if (!windowFocused) return;
          e.target.setStyle({ weight:2, color:'#ffffff', opacity:1 });
          e.target.bringToFront();
        },
        mouseout: e => {
          e.target.setStyle({ weight:0.5, color:'#ffffff', opacity:0.3 });
        },
        click: () => showCoverageESZDetail(props, val),
      });
      layer.bindTooltip(
        `<b>${props.ESZ_ID}</b><br>${activeCovMPH} mph · ${activeCovDriveTime} min<br>Coverage: ${pct}%`,
        {sticky:true, opacity:0.9, permanent:false, closeOnClick:true}
      );
    }
  }).addTo(map);

  bringStationLayersToFront();

  buildCoverageLegendESZCov();
}

// ── POLYGONS VIEW ─────────────────────────────────────────────────────────
// ALL station: show all stations colored by station, filtered by time + MPH
// Single station + ALL mph: all speeds layered, colored by MPH, biggest first
// Single station + one MPH: just that tier, colored by MPH, biggest first
function renderCoveragePolygons() {
  if (!DRIVE_TIME_GEO) { buildCoverageLegendEmpty('Polygon data unavailable'); return; }

  const targetMin = parseFloat(activeCovDriveTime);
  let features = DRIVE_TIME_GEO.features.filter(f =>
    parseFloat(f.properties.minutes) === targetMin
  );

  if (activeStation !== 'ALL') {
    features = features.filter(f => f.properties.station_id === activeStation);
  }

  if (activeCovMPH && activeCovMPH !== 'ALL') {
    const targetMPH = parseFloat(activeCovMPH);
    features = features.filter(f => parseFloat(f.properties.speed_mph) === targetMPH);
  }

  if (!features.length) { buildCoverageLegendEmpty('No polygons for selection'); return; }

  // Sort biggest first so smaller polygons sit on top
  function polyArea(feat) {
    const coords = feat.geometry.coordinates[0];
    if (!coords?.length) return 0;
    const lons = coords.map(c=>c[0]), lats = coords.map(c=>c[1]);
    return (Math.max(...lons)-Math.min(...lons)) * (Math.max(...lats)-Math.min(...lats));
  }
  features = [...features].sort((a,b) => polyArea(b) - polyArea(a));

  isochroneLayer = L.geoJSON({ type:'FeatureCollection', features }, {
    style: feat => {
      const sid = feat.properties.station_id;
      const mph = String(parseFloat(feat.properties.speed_mph));
      let fillColor, strokeColor;
      if (activeStation === 'ALL') {
        // All stations → color by station
        const c = STATION_COLORS[sid] || '#00cfff';
        fillColor = c; strokeColor = c;
      } else {
        // Single station → color by MPH tier
        const c = MPH_COLORS[mph] || { fill:'#00cfff', stroke:'#33dfff' };
        fillColor = c.fill; strokeColor = c.stroke;
      }
      return { fillColor, fillOpacity:0.25, color:strokeColor, weight:2, opacity:0.9 };
    },
    onEachFeature: (feat, layer) => {
      const sid = feat.properties.station_id;
      const mph = feat.properties.speed_mph;
      const min = feat.properties.minutes;
      layer.on({
        mouseover: e => {
          if (!windowFocused) return;
          e.target.setStyle({ fillOpacity:0.5, weight:3 });
          e.target.bringToFront();
        },
        mouseout: e => { isochroneLayer?.resetStyle(e.target); },
        click: () => showCoveragePolyDetail(feat.properties),
      });
      layer.bindTooltip(
        `<b>${sid}</b><br>${min} min · ${mph} mph`,
        {sticky:true, opacity:0.9, permanent:false, closeOnClick:true}
      );
    }
  }).addTo(map);

  bringStationLayersToFront();

  buildCoverageLegendPolygons(features);
}

// ── ROAD VIEW ─────────────────────────────────────────────────────────────
// Renders LineString road segments colored by overlap count —
// how many station polygon isochrones cover each segment.
// Overlap is computed at render time using point-in-polygon checks.
function renderCoverageRoads() {
  if (!DRIVE_TIME_ROADS) { buildCoverageLegendEmpty('Road data unavailable (drive_time_roads.geojson)'); return; }
  if (!DRIVE_TIME_GEO)   { buildCoverageLegendEmpty('Polygon data required for overlap computation'); return; }

  // Filter road segments by selected MPH and drive time
  // Both filters always active — roads show segments matching both dimensions
  const targetMin = parseFloat(activeCovDriveTime);
  let roadFeatures = DRIVE_TIME_ROADS.features.filter(f =>
    parseFloat(f.properties.minutes) === targetMin
  );
  if (activeCovMPH && activeCovMPH !== 'ALL') {
    const targetMPH = parseFloat(activeCovMPH);
    roadFeatures = roadFeatures.filter(f => parseFloat(f.properties.speed_mph) === targetMPH);
  }

  // If single station, restrict to roads for that station only
  if (activeStation !== 'ALL') {
    roadFeatures = roadFeatures.filter(f => f.properties.station_id === activeStation);
  }

  if (!roadFeatures.length) { buildCoverageLegendEmpty('No road segments for selection'); return; }

  // Build polygon set for overlap checking — all stations, same filter
  let polyFeatures = DRIVE_TIME_GEO.features.filter(f =>
    parseFloat(f.properties.minutes) === targetMin
  );
  if (activeCovMPH && activeCovMPH !== 'ALL') {
    const targetMPH = parseFloat(activeCovMPH);
    polyFeatures = polyFeatures.filter(f => parseFloat(f.properties.speed_mph) === targetMPH);
  }

  // Point-in-polygon: ray casting on the first ring
  function pointInPoly(px, py, coords) {
    let inside = false;
    for (let i=0, j=coords.length-1; i<coords.length; j=i++) {
      const xi=coords[i][0], yi=coords[i][1], xj=coords[j][0], yj=coords[j][1];
      if (((yi>py)!==(yj>py)) && (px < (xj-xi)*(py-yi)/(yj-yi)+xi)) inside=!inside;
    }
    return inside;
  }

  // For a LineString, test its midpoint against each polygon
  function overlapCount(lineCoords) {
    const mid = lineCoords[Math.floor(lineCoords.length/2)];
    const [px, py] = mid;
    let count = 0;
    for (const poly of polyFeatures) {
      const rings = poly.geometry.type === 'Polygon'
        ? [poly.geometry.coordinates[0]]
        : poly.geometry.coordinates.map(r=>r[0]);
      for (const ring of rings) {
        if (pointInPoly(px, py, ring)) { count++; break; }
      }
    }
    return count;
  }

  // Pre-compute overlap for each segment
  const segments = roadFeatures.map(f => ({
    feat: f,
    overlap: overlapCount(f.geometry.coordinates),
  }));

  const overlapColor = n => OVERLAP_COLORS[Math.min(n,OVERLAP_COLORS.length)-1] || OVERLAP_COLORS[OVERLAP_COLORS.length-1];

  const fc = { type:'FeatureCollection', features: roadFeatures };

  isochroneLayer = L.geoJSON(fc, {
    style: feat => {
      const seg = segments.find(s => s.feat === feat);
      const ov  = seg ? seg.overlap : 1;
      return {
        color:   overlapColor(ov),
        weight:  ov > 1 ? 3.5 : 2,
        opacity: 0.85,
      };
    },
    onEachFeature: (feat, layer) => {
      const sid = feat.properties.station_id;
      const mph = feat.properties.speed_mph;
      const min = feat.properties.minutes;
      const seg = segments.find(s => s.feat === feat);
      const ov  = seg ? seg.overlap : 1;
      layer.on({
        mouseover: e => {
          if (!windowFocused) return;
          e.target.setStyle({ weight: ov > 1 ? 5 : 3.5, opacity: 1 });
          e.target.bringToFront();
        },
        mouseout: e => { isochroneLayer?.resetStyle(e.target); },
        click: () => showCoverageRoadDetail(feat.properties, ov),
      });
      layer.bindTooltip(
        `<b>${sid}</b><br>${min} min · ${mph} mph<br>Overlap: ${ov} station${ov!==1?'s':''}`,
        {sticky:true, opacity:0.9, permanent:false, closeOnClick:true}
      );
    }
  }).addTo(map);

  bringStationLayersToFront();

  buildCoverageLegendRoads(segments);
}

// ── COVERAGE LEGENDS ──────────────────────────────────────────────────────
function buildCoverageLegendPolygons(features) {
  const dt = activeCovDriveTime;
  const mphLabel = activeCovMPH === 'ALL' ? 'All speeds' : `${activeCovMPH} mph`;

  if (activeStation === 'ALL') {
    // Color by station
    const stations = [...new Set(features.map(f => f.properties.station_id))].sort();
    document.getElementById('legend-title').innerHTML =
      `Polygons&nbsp;·&nbsp;<span style="color:var(--accent)">${dt} min · ${mphLabel}</span>`;
    document.getElementById('legend-rows').innerHTML = stations.map(sid => {
      const c = STATION_COLORS[sid] || '#00cfff';
      return `<div class="legend-row"><div class="legend-swatch" style="background:${c};opacity:0.8;border-radius:2px"></div><span>${sid}</span></div>`;
    }).join('');
  } else {
    // Single/multi station — color by MPH
    const speeds = [...new Set(features.map(f => String(parseFloat(f.properties.speed_mph))))].sort((a,b)=>parseFloat(a)-parseFloat(b));
    const stLabel = activeStation === 'ALL' ? 'All Stations' : activeStation;
    const c = STATION_COLORS[activeStation] || 'var(--accent)';
    document.getElementById('legend-title').innerHTML =
      `<span style="color:${c}">${stLabel}</span>&nbsp;·&nbsp;<span style="color:var(--accent)">${dt} min</span>`;
    document.getElementById('legend-rows').innerHTML = speeds.map(s => {
      const mc = MPH_COLORS[s] || { fill:'#00cfff' };
      return `<div class="legend-row"><div class="legend-swatch" style="background:${mc.fill};opacity:0.8;border-radius:2px"></div><span>${s} mph</span></div>`;
    }).join('');
  }
}

function buildCoverageLegendRoads(segments) {
  const maxOv = Math.max(...segments.map(s=>s.overlap), 1);
  const label = activeCovSubType === 'mph' ? `${activeCovMPH} mph` : `${activeCovDriveTime} min`;
  document.getElementById('legend-title').innerHTML =
    `Road View&nbsp;·&nbsp;<span style="color:var(--accent)">${label}</span>`;
  const rows = [];
  for (let i=1; i<=Math.min(maxOv, OVERLAP_COLORS.length); i++) {
    const label2 = i === OVERLAP_COLORS.length ? `${i}+ stations` : `${i} station${i>1?'s':''}`;
    rows.push(`<div class="legend-row">
      <div style="width:22px;height:4px;border-radius:2px;background:${OVERLAP_COLORS[i-1]};flex-shrink:0"></div>
      <span>${label2}</span>
    </div>`);
  }
  document.getElementById('legend-rows').innerHTML = rows.join('');
}

function buildCoverageLegendESZCov() {
  const mph = activeCovMPH, dt = activeCovDriveTime;
  document.getElementById('legend-title').innerHTML =
    `ESZ Coverage&nbsp;·&nbsp;<span style="color:var(--accent)">${mph} mph · ${dt} min</span>`;
  const r = parseInt(ESZ_COV_COLOR.slice(1,3),16);
  const g = parseInt(ESZ_COV_COLOR.slice(3,5),16);
  const b = parseInt(ESZ_COV_COLOR.slice(5,7),16);
  const stops = ESZ_COV_OPACITIES.map((op, i) => {
    const pct   = Math.round((i / (ESZ_COV_OPACITIES.length - 1)) * 100);
    const color = op < 0.08 ? 'rgba(128,128,128,0.10)' : `rgba(${r},${g},${b},${op})`;
    return `<div class="legend-row">
      <div class="legend-swatch" style="background:${color};border:1px solid rgba(128,128,128,0.2)"></div>
      <span>${pct}%</span>
    </div>`;
  }).reverse();
  document.getElementById('legend-rows').innerHTML = stops.join('');
}

function buildCoverageLegendESZ() {
  // Kept for safety — redirects to real legend or empty
  if (ESZ_DRIVE_COV) buildCoverageLegendESZCov();
  else buildCoverageLegendEmpty('ESZ data not loaded');
}

function buildCoverageLegendEmpty(msg = 'No data') {
  document.getElementById('legend-title').textContent = 'Coverage';
  document.getElementById('legend-rows').innerHTML =
    `<div style="font-size:12px;color:var(--muted)">${msg}</div>`;
}

// ── COVERAGE SIDEBAR ──────────────────────────────────────────────────────
function showCoverageOverview() {
  document.getElementById('sidebar-title').textContent = 'Coverage';

  if (activeCovView === 'esz') {
    showCoverageESZOverview();
    return;
  }

  if (activeCovView === 'polygons') {
    showCoveragePolygonOverview();
    return;
  }

  // Road view
  showCoverageRoadOverview();
}

function showCoveragePolygonOverview() {
  const isAll = activeStation === 'ALL';
  const stLabel = isAll ? 'All Stations' : activeStation;

  if (!DRIVE_TIME_GEO) {
    document.getElementById('sidebar-sub').textContent = 'Polygons · No data';
    document.getElementById('sidebar-body').innerHTML = `<div class="cov-placeholder"><div class="cov-placeholder-icon">⚠</div><div class="cov-placeholder-title">No Polygon Data</div></div>`;
    return;
  }

  const stFeats = DRIVE_TIME_GEO.features.filter(f => f.properties.station_id === activeStation);
  const speeds  = [...new Set(stFeats.map(f => parseFloat(f.properties.speed_mph)))].sort((a,b)=>a-b);
  const times   = [...new Set(stFeats.map(f => parseFloat(f.properties.minutes)))].sort((a,b)=>a-b);
  const c       = STATION_COLORS[activeStation] || 'var(--accent)';

  document.getElementById('sidebar-sub').textContent = `Polygons · ${stLabel} · ${activeCovDriveTime} min`;

  document.getElementById('sidebar-body').innerHTML = `
    <div class="sec-hdr" style="color:${c}">Polygons · ${stLabel}</div>
    <table class="kv-table">
      <tr><td>Station</td><td><span class="kv-val-lg" style="color:${c}">${stLabel}</span></td></tr>
      <tr><td>Total Polygons</td><td>${stFeats.length}</td></tr>
      <tr><td>Speeds</td><td>${speeds.map(s=>s+' mph').join(', ')}</td></tr>
      <tr><td>Times</td><td>${times.map(t=>t+' min').join(', ')}</td></tr>
    </table>
    <div class="sec-hdr">Speed Layers</div>
    ${speeds.map(s => {
      const mc = MPH_COLORS[String(s)] || { fill:'#00cfff' };
      const cnt = stFeats.filter(f=>parseFloat(f.properties.speed_mph)===s).length;
      return `<div class="incident-stat-card" style="border-left-color:${mc.fill}">
        <div class="isc-head">
          <span class="isc-prog" style="color:${mc.fill}">${s} mph</span>
          <span class="isc-risk" style="color:${mc.fill};border:1px solid ${mc.fill};background:${mc.fill}18">${cnt} polygon${cnt!==1?'s':''}</span>
        </div>
      </div>`;
    }).join('')}
    <div style="margin-top:8px;padding:8px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;font-size:13px;color:var(--muted)">
      Polygons are rendered largest-first so smaller high-speed zones appear on top. Click a polygon to inspect it.
    </div>`;
}

function showCoverageRoadOverview() {
  if (!DRIVE_TIME_ROADS) {
    document.getElementById('sidebar-sub').textContent = 'Road View · No data loaded';
    document.getElementById('sidebar-body').innerHTML = `<div class="cov-placeholder"><div class="cov-placeholder-icon">⚠</div><div class="cov-placeholder-title">No Road Data</div><div>drive_time_roads.geojson could not be loaded.</div></div>`;
    return;
  }

  const label = activeCovSubType === 'mph' ? `${activeCovMPH} mph` : `${activeCovDriveTime} min`;
  const stLabel = activeStation === 'ALL' ? 'All Stations' : activeStation;
  document.getElementById('sidebar-sub').textContent = `Road View · ${stLabel} · ${label}`;

  const allSpeeds = [...new Set(DRIVE_TIME_ROADS.features.map(f=>parseFloat(f.properties.speed_mph)))].sort((a,b)=>a-b);
  const allTimes  = [...new Set(DRIVE_TIME_ROADS.features.map(f=>parseFloat(f.properties.minutes)))].sort((a,b)=>a-b);

  // Per-station segment counts
  const stRows = Object.keys(STATION_COLORS).map(sid => {
    let feats = DRIVE_TIME_ROADS.features.filter(f => f.properties.station_id === sid);
    if (activeCovSubType === 'mph') feats = feats.filter(f=>String(parseFloat(f.properties.speed_mph))===activeCovMPH);
    else feats = feats.filter(f=>String(parseFloat(f.properties.minutes))===activeCovDriveTime);
    if (!feats.length) return '';
    const c = STATION_COLORS[sid];
    return `<div class="incident-stat-card" style="border-left-color:${c}">
      <div class="isc-head">
        <span class="isc-prog">${sid}</span>
        <span class="isc-risk" style="color:${c};border:1px solid ${c};background:${c}18">${feats.length} segments</span>
      </div>
    </div>`;
  }).join('');

  document.getElementById('sidebar-body').innerHTML = `
    <div class="sec-hdr" style="color:var(--accent)">Road View · Overlap</div>
    <table class="kv-table">
      <tr><td>Filter</td><td style="color:var(--accent);font-weight:700">${label}</td></tr>
      <tr><td>Station</td><td>${stLabel}</td></tr>
      <tr><td>Speeds</td><td>${allSpeeds.map(s=>s+' mph').join(', ')}</td></tr>
      <tr><td>Times</td><td>${allTimes.map(t=>t+' min').join(', ')}</td></tr>
    </table>
    <div class="sec-hdr">Overlap Legend</div>
    ${OVERLAP_COLORS.map((c,i)=>`
      <div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:13px">
        <div style="width:22px;height:4px;border-radius:2px;background:${c};flex-shrink:0"></div>
        <span style="color:var(--muted)">${i===OVERLAP_COLORS.length-1?`${i+1}+ stations`:`${i+1} station${i>0?'s':''}`}</span>
      </div>`).join('')}
    <div class="sec-hdr">By Station</div>
    ${stRows || '<div style="font-size:13px;color:var(--muted);padding:8px 0">No segments for this filter</div>'}
    <div style="margin-top:8px;padding:8px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;font-size:13px;color:var(--muted)">
      Road segments are colored by how many station isochrone polygons they fall within. Brighter = more overlap.
    </div>`;
}

function showCoveragePolyDetail(props) {
  const sid = props.station_id;
  const mph = parseFloat(props.speed_mph);
  const min = parseFloat(props.minutes);
  const c   = STATION_COLORS[sid] || 'var(--accent)';
  const mc  = MPH_COLORS[String(mph)] || { fill:'#00cfff' };

  document.getElementById('sidebar-title').textContent = sid;
  document.getElementById('sidebar-sub').textContent = `Polygons · ${min} min · ${mph} mph`;

  document.getElementById('sidebar-body').innerHTML = `
    <div class="sec-hdr" style="color:${c}">Polygon Detail</div>
    <table class="kv-table">
      <tr><td>Station</td><td><span class="kv-val-lg" style="color:${c}">${sid}</span></td></tr>
      <tr><td>Drive Time</td><td><span class="kv-val-lg">${min} min</span></td></tr>
      <tr><td>Speed</td><td><span class="kv-val-lg" style="color:${mc.fill}">${mph} mph</span></td></tr>
    </table>
    <div style="margin-top:8px;padding:8px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;font-size:13px;color:var(--muted)">
      This polygon shows the estimated area reachable from ${sid} within ${min} minutes at ${mph} mph average road speed.
    </div>
    <div class="action-row">
      <button class="btn-sec" onclick="showCoverageOverview()">← Overview</button>
      <button class="btn-pri" onclick="exportPDF()">⬇ PDF · Coverage</button>
    </div>`;
}

function showCoverageRoadDetail(props, overlapCount) {
  const sid = props.station_id;
  const mph = parseFloat(props.speed_mph);
  const min = parseFloat(props.minutes);
  const c   = STATION_COLORS[sid] || 'var(--accent)';
  const oc  = OVERLAP_COLORS[Math.min(overlapCount, OVERLAP_COLORS.length) - 1];

  document.getElementById('sidebar-title').textContent = sid;
  document.getElementById('sidebar-sub').textContent = `Road View · ${min} min · ${mph} mph`;

  document.getElementById('sidebar-body').innerHTML = `
    <div class="sec-hdr" style="color:${c}">Road Segment Detail</div>
    <table class="kv-table">
      <tr><td>Station</td><td><span class="kv-val-lg" style="color:${c}">${sid}</span></td></tr>
      <tr><td>Drive Time</td><td><span class="kv-val-lg">${min} min</span></td></tr>
      <tr><td>Speed</td><td><span class="kv-val-lg">${mph} mph</span></td></tr>
      <tr><td>Station Overlap</td><td><span class="kv-val-lg" style="color:${oc}">${overlapCount} station${overlapCount!==1?'s':''}</span></td></tr>
    </table>
    <div style="margin-top:8px;padding:8px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;font-size:13px;color:var(--muted)">
      This road segment is reachable from <strong style="color:${oc}">${overlapCount} station${overlapCount!==1?'s':''}</strong> within the selected drive time and speed parameters.
    </div>
    <div class="action-row">
      <button class="btn-sec" onclick="showCoverageOverview()">← Overview</button>
      <button class="btn-pri" onclick="exportPDF()">⬇ PDF · Coverage</button>
    </div>`;
}

function showCoverageESZOverview() {
  const mph = activeCovMPH, dt = activeCovDriveTime;
  const stLabel = activeStation === 'ALL' ? 'All Stations' : activeStation;
  document.getElementById('sidebar-sub').textContent = `ESZ View · ${stLabel} · ${mph} mph · ${dt} min`;

  if (!ESZ_DRIVE_COV) {
    document.getElementById('sidebar-body').innerHTML = `
      <div class="cov-placeholder"><div class="cov-placeholder-icon">⚠</div>
      <div class="cov-placeholder-title">No ESZ Data</div>
      <div>esz_drive_coverage.geojson could not be loaded.</div></div>`;
    return;
  }

  const key = eszCovKey();
  let features = ESZ_DRIVE_COV.features;
  if (activeStation !== 'ALL') features = features.filter(f => f.properties.station_id === activeStation);

  // Aggregate: best coverage per ESZ
  const eszBest = {};
  for (const f of features) {
    const id  = f.properties.ESZ_ID;
    const val = parseFloat(f.properties[key]) || 0;
    if (!eszBest[id] || val > eszBest[id]) eszBest[id] = val;
  }
  const vals = Object.values(eszBest);
  if (!vals.length) {
    document.getElementById('sidebar-body').innerHTML = `<div class="cov-placeholder"><div class="cov-placeholder-icon">⬡</div><div class="cov-placeholder-title">No Data</div><div>No ESZ coverage data for this selection.</div></div>`;
    return;
  }

  const avg  = vals.reduce((a,b)=>a+b,0) / vals.length;
  const full = vals.filter(v=>v>=1.0).length;
  const none = vals.filter(v=>v<=0).length;
  const part = vals.length - full - none;

  // Bracket distribution
  const brackets = [[0,0.25],[0.25,0.5],[0.5,0.75],[0.75,1.0],[1.0,1.01]];
  const bracketLabels = ['0–25%','25–50%','50–75%','75–99%','100%'];
  const bracketCounts = brackets.map(([lo,hi]) => vals.filter(v=>v>=lo&&v<hi).length);

  document.getElementById('sidebar-body').innerHTML = `
    <div class="sec-hdr" style="color:var(--accent)">ESZ Coverage · ${mph} mph · ${dt} min</div>
    <table class="kv-table">
      <tr><td>Station</td><td>${stLabel}</td></tr>
      <tr><td>ESZs Evaluated</td><td><span class="kv-val-lg">${vals.length}</span></td></tr>
      <tr><td>Avg Coverage</td><td><span class="kv-val-lg" style="color:${eszCovColor(avg)}">${(avg*100).toFixed(1)}%</span></td></tr>
      <tr><td>Full Coverage (100%)</td><td style="color:${ESZ_COV_COLOR};font-weight:700">${full}</td></tr>
      <tr><td>Partial Coverage</td><td>${part}</td></tr>
      <tr><td>No Coverage</td><td style="color:var(--muted)">${none}</td></tr>
    </table>
    <div class="sec-hdr">Distribution</div>
    ${bracketLabels.map((lbl,i) => {
      const cnt = bracketCounts[i];
      const pct = vals.length ? (cnt/vals.length*100).toFixed(0) : 0;
      const midVal = (brackets[i][0]+brackets[i][1])/2;
      const barColor = eszCovColor(midVal);
      return `<div style="margin-bottom:6px">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px">
          <span style="color:var(--muted)">${lbl}</span>
          <span style="color:var(--text);font-weight:600">${cnt} ESZs</span>
        </div>
        <div style="height:5px;background:rgba(58,58,92,.4);border-radius:2px">
          <div style="height:100%;width:${pct}%;background:${barColor};border-radius:2px;transition:width .3s"></div>
        </div>
      </div>`;
    }).join('')}
    <div style="margin-top:8px;padding:8px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;font-size:13px;color:var(--muted)">
      Click any ESZ polygon to see its coverage detail.
    </div>`;
}

function showCoverageESZDetail(props, covVal) {
  const mph = activeCovMPH, dt = activeCovDriveTime;
  const pct = (covVal * 100).toFixed(1);
  const color = eszCovColor(covVal);
  const stColor = STATION_COLORS[props.station_id] || 'var(--accent)';

  document.getElementById('sidebar-title').textContent = props.ESZ_ID;
  document.getElementById('sidebar-sub').textContent = `ESZ Coverage · ${mph} mph · ${dt} min`;

  // Show all speed tiers for this ESZ
  const allKeys = Object.keys(props).filter(k => k.startsWith('cov_'));
  const tierRows = allKeys.sort().map(k => {
    const m = k.match(/cov_(\d+)mph_(\d+)min/);
    if (!m) return '';
    const v = parseFloat(props[k]);
    const c = eszCovColor(v);
    return `<tr>
      <td>${m[1]} mph · ${m[2]} min</td>
      <td style="color:${c};font-weight:700;text-align:right">${(v*100).toFixed(1)}%</td>
    </tr>`;
  }).join('');

  document.getElementById('sidebar-body').innerHTML = `
    <div class="sec-hdr" style="color:${color}">ESZ Coverage</div>
    <table class="kv-table">
      <tr><td>ESZ</td><td><span class="kv-val-lg">${props.ESZ_ID}</span></td></tr>
      <tr><td>Station</td><td><span style="color:${stColor};font-weight:700">${props.station_id}</span></td></tr>
      <tr><td>${mph} mph · ${dt} min</td>
          <td><span class="kv-val-lg" style="color:${color}">${pct}%</span></td></tr>
    </table>
    <div style="margin:10px 0 4px;height:8px;background:rgba(58,58,92,.4);border-radius:4px">
      <div style="height:100%;width:${Math.min(covVal*100,100)}%;background:${color};border-radius:4px;transition:width .4s"></div>
    </div>
    <div class="sec-hdr">All Speed Tiers</div>
    <table class="kv-table">${tierRows}</table>
    <div class="action-row">
      <button class="btn-sec" onclick="showCoverageOverview()">← Overview</button>
      <button class="btn-pri" onclick="exportPDF()">⬇ PDF · Coverage</button>
    </div>`;
}

// ── TARGET HAZARDS ────────────────────────────────────────────────────────

function clearHazardsLayer() {
  if (hazardsLayer) { map.removeLayer(hazardsLayer); hazardsLayer = null; }
}

function hazardColor(cat) {
  return (HAZARD_CAT_CONFIG[cat] || HAZARD_CAT_CONFIG.all).color;
}

function buildHazardsCatTabs() {
  const wrap = document.getElementById('hazards-controls');
  if (!wrap) return;

  const visible = HAZARD_CAMPUSES.filter(c =>
    activeStation === 'ALL' || c.StationID === activeStation
  );
  const presentCats = new Set(visible.map(c => c.cat));
  const orderedCats = ['all', ...Object.keys(HAZARD_CAT_CONFIG).filter(c => c !== 'all' && presentCats.has(c))];

  wrap.innerHTML = orderedCats.map(cat => {
    const cfg = HAZARD_CAT_CONFIG[cat];
    return `<button class="hz-cat-tab${activeHazardCat === cat ? ' active' : ''}"
      data-cat="${cat}" onclick="selectHazardCat('${cat}')">${cfg.icon} ${cfg.label}</button>`;
  }).join('');
}

function selectHazardCat(cat) {
  activeHazardCat    = cat;
  activeHazardCampus = null;
  document.querySelectorAll('.hz-cat-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.cat === cat)
  );
  renderHazardsLayer();
  showHazardsOverview();
}

function renderHazardsLayer() {
  clearHazardsLayer();
  if (!HAZARD_CAMPUSES.length) return;

  const filtered = HAZARD_CAMPUSES.filter(c => {
    const matchesCat = activeHazardCat === 'all' || c.cat === activeHazardCat;
    const matchesStn = activeStation === 'ALL' || c.StationID === activeStation;
    return matchesCat && matchesStn;
  });

  hazardsLayer = L.layerGroup();

  filtered.forEach(campus => {
    const col  = hazardColor(campus.cat);
    const cfg  = HAZARD_CAT_CONFIG[campus.cat] || HAZARD_CAT_CONFIG.all;
    const flow = campus.totalFlow;
    // Radius based on total campus fire flow
    const radius = flow > 20000 ? 11 : flow > 10000 ? 9 : flow > 4000 ? 7 : 5;
    const multi  = campus.buildings.length > 1;

    const sprinkIcon = campus.sprinkStatus === 'Full'    ? '💧 Full'
                     : campus.sprinkStatus === 'Partial' ? '💧 Partial'
                     : '🚫 None';

    const marker = L.circleMarker([campus.lat, campus.lng], {
      radius,
      fillColor:   col,
      color:       multi ? '#fff' : '#fff',
      weight:      multi ? 2.5 : 1.5,
      dashArray:   multi ? null : null,
      opacity:     1,
      fillOpacity: 0.88,
    });

    marker.bindTooltip(
      `<div style="font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:700;color:${col}">${campus.name}</div>
       <div style="font-size:12px;color:#aaa;margin-top:1px">${campus.address}, ${campus.city}</div>
       <div style="font-size:12px;color:#ccc;margin-top:3px">${cfg.icon} ${cfg.label}${multi ? ' · ' + campus.buildings.length + ' bldgs' : ''} · ${flow.toLocaleString()} GPM</div>
       <div style="font-size:11px;color:#999;margin-top:1px">${sprinkIcon}</div>`,
      { sticky: true, className: 'hz-popup', offset: [8, 0] }
    );

    marker.on('click', () => showCampusDetail(campus));
    hazardsLayer.addLayer(marker);
  });

  hazardsLayer.addTo(map);
  bringStationLayersToFront();
  renderHazardsLegend();

  if (filtered.length) {
    const pts = filtered.map(c => [c.lat, c.lng]);
    const bounds = L.latLngBounds(pts);
    if (bounds.isValid()) map.fitBounds(bounds, { padding:[40,40] });
  }
}

function renderHazardsLegend() {
  const legendTitle = document.getElementById('legend-title');
  const legendRows  = document.getElementById('legend-rows');
  if (!legendTitle || !legendRows) return;

  legendTitle.textContent = 'Required Fire Flow';
  legendRows.innerHTML = `
    <div class="legend-row"><svg width="22" height="22"><circle cx="11" cy="11" r="11" fill="#888" opacity=".88"/></svg><span>&gt; 20,000 GPM</span></div>
    <div class="legend-row"><svg width="18" height="18"><circle cx="9" cy="9" r="9" fill="#888" opacity=".88"/></svg><span>10,001 – 20,000 GPM</span></div>
    <div class="legend-row"><svg width="14" height="14"><circle cx="7" cy="7" r="7" fill="#888" opacity=".88"/></svg><span>4,001 – 10,000 GPM</span></div>
    <div class="legend-row"><svg width="10" height="10"><circle cx="5" cy="5" r="5" fill="#888" opacity=".88"/></svg><span>≤ 4,000 GPM</span></div>
  `;
}

function showHazardsOverview() {
  if (!HAZARD_CAMPUSES.length) {
    document.getElementById('sidebar-title').textContent = 'Target Hazards';
    document.getElementById('sidebar-sub').textContent   = 'Data unavailable';
    document.getElementById('sidebar-body').innerHTML    =
      '<div class="empty-state"><div class="empty-icon">⚠</div><div class="empty-title">No Data</div>' +
      '<div>flowmsp_high_hazard.geojson not found in /data/</div></div>';
    return;
  }

  const allCampuses = HAZARD_CAMPUSES.filter(c =>
    activeStation === 'ALL' || c.StationID === activeStation
  );
  const visCampuses = allCampuses.filter(c =>
    activeHazardCat === 'all' || c.cat === activeHazardCat
  );

  document.getElementById('sidebar-title').textContent = 'Target Hazards';
  document.getElementById('sidebar-sub').textContent =
    `${visCampuses.length} sites · ${activeStation === 'ALL' ? 'All Stations' : activeStation}`;

  // Category count cards
  const cats = Object.keys(HAZARD_CAT_CONFIG).filter(c => c !== 'all');
  const countCards = cats.map(cat => {
    const cfg   = HAZARD_CAT_CONFIG[cat];
    const count = allCampuses.filter(c => c.cat === cat).length;
    if (!count) return '';
    return `<div class="hz-count-card${activeHazardCat === cat ? ' hz-count-active' : ''}"
        style="border-left-color:${cfg.color}" onclick="selectHazardCat('${cat}')">
      <div class="hz-count-val" style="color:${cfg.color}">${count}</div>
      <div class="hz-count-lbl">${cfg.icon} ${cfg.label}</div>
    </div>`;
  }).join('');

  // Aggregate stats
  const totalFlow   = visCampuses.reduce((s, c) => s + c.totalFlow, 0);
  const fullSprink  = visCampuses.filter(c => c.sprinkStatus === 'Full').length;
  const partSprink  = visCampuses.filter(c => c.sprinkStatus === 'Partial').length;
  const totalAnnot  = visCampuses.reduce((s, c) => s + c.totalAnnot, 0);
  const totalBldgs  = visCampuses.reduce((s, c) => s + c.buildings.length, 0);

  // Top sites by totalFlow
  const topSites = [...visCampuses]
    .sort((a, b) => b.totalFlow - a.totalFlow)
    .slice(0, 8);

  const siteCardsHtml = topSites.map(campus => {
    const col  = hazardColor(campus.cat);
    const cfg  = HAZARD_CAT_CONFIG[campus.cat] || {};
    const flow = campus.totalFlow ? campus.totalFlow.toLocaleString() + ' GPM' : '—';
    const sprk = campus.sprinkStatus === 'Full' ? '💧 Full' : campus.sprinkStatus === 'Partial' ? '💧 Partial' : '🚫 None';
    const bldgLabel = campus.buildings.length > 1 ? `${campus.buildings.length} bldgs` : '1 bldg';
    return `<div class="hz-card" style="border-left-color:${col}" onclick="showCampusDetail(HZ_CAMPUS_BY_ID['${campus.parent_id}'])">
      <div class="hz-card-name">${campus.name}</div>
      <div class="hz-card-addr">${campus.address}, ${campus.city}</div>
      <div class="hz-card-pills">
        <span class="hz-pill" style="color:${col}">${cfg.icon || ''} ${cfg.label || campus.cat}</span>
        <span class="hz-pill" style="color:var(--muted)">${flow}</span>
        <span class="hz-pill" style="color:var(--muted)">${sprk}</span>
        <span class="hz-pill" style="color:var(--muted)">${bldgLabel}</span>
      </div>
    </div>`;
  }).join('');

  document.getElementById('sidebar-body').innerHTML = `
    <div class="sec-hdr">By Occupancy</div>
    <div class="hz-overview-counts">${countCards}</div>
    <div class="sec-hdr">Summary</div>
    <div class="hz-stat-grid">
      <div class="hz-stat">
        <div class="hz-stat-val" style="color:var(--accent)">${(totalFlow/1000).toFixed(0)}K</div>
        <div class="hz-stat-lbl">Total GPM</div>
      </div>
      <div class="hz-stat">
        <div class="hz-stat-val" style="color:#2e9e52">${fullSprink}<span style="font-size:14px;color:var(--muted)"> + ${partSprink}p</span></div>
        <div class="hz-stat-lbl">Sprinklered</div>
      </div>
      <div class="hz-stat">
        <div class="hz-stat-val" style="color:#c97a1a">${totalAnnot}</div>
        <div class="hz-stat-lbl">Annotations</div>
      </div>
      <div class="hz-stat">
        <div class="hz-stat-val" style="color:var(--muted)">${totalBldgs}</div>
        <div class="hz-stat-lbl">Buildings</div>
      </div>
    </div>
    <div class="sec-hdr">Highest Flow${activeHazardCat !== 'all' ? ' · ' + (HAZARD_CAT_CONFIG[activeHazardCat]?.label || activeHazardCat) : ''}</div>
    ${siteCardsHtml}
    <div style="margin-top:8px;padding:8px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;font-size:13px;color:var(--muted)">
      Click a marker or site card to view pre-plan details.
    </div>`;
}

// Lookup map so overview cards can reference campuses by parent_id
const HZ_CAMPUS_BY_ID = {};
const _origBuildCampuses = buildHazardCampuses;
// Patch to also populate lookup after build
function buildHazardCampuses() {
  if (!TARGET_HAZARDS_GEO) return;
  const groups = {};
  TARGET_HAZARDS_GEO.features.forEach(feat => {
    const pid = feat.properties.parent_id;
    if (!groups[pid]) groups[pid] = [];
    groups[pid].push(feat);
  });

  HAZARD_CAMPUSES = Object.entries(groups).map(([pid, buildings]) => {
    const primary    = buildings[0].properties;
    const cat        = getCampusCat(buildings);
    const totalFlow  = buildings.reduce((s, f) => s + (f.properties.required_flow || 0), 0);
    const anySprink  = buildings.some(f => f.properties.sprinklered && f.properties.sprinklered !== 'None');
    const allSprink  = buildings.every(f => f.properties.sprinklered && f.properties.sprinklered !== 'None');
    const sprinkStatus = allSprink ? 'Full' : anySprink ? 'Partial' : 'None';
    const totalAnnot = buildings.reduce((s, f) => s + (f.properties.image_annotations || 0), 0);
    const maxHydrants = Math.max(...buildings.map(f => f.properties.hydrant_count || 0));
    const [lng, lat] = buildings[0].geometry.coordinates;
    const campus = { parent_id: pid, name: primary.name, address: primary.address,
      city: primary.city, zip: primary.zip, StationID: primary.StationID,
      ESZ_ID: primary.ESZ_ID, cat, buildings, totalFlow, sprinkStatus,
      totalAnnot, maxHydrants, lat, lng };
    HZ_CAMPUS_BY_ID[pid] = campus;
    return campus;
  });
}

function showCampusDetail(campus) {
  if (!campus) return;
  const col     = hazardColor(campus.cat);
  const cfg     = HAZARD_CAT_CONFIG[campus.cat] || {};
  const stColor = STATION_COLORS[campus.StationID] || 'var(--accent)';

  document.getElementById('sidebar-title').textContent = campus.name;
  document.getElementById('sidebar-sub').textContent   = (cfg.icon || '') + ' ' + (cfg.label || campus.cat);

  const sprinkColor = campus.sprinkStatus === 'Full'    ? '#2e9e52'
                    : campus.sprinkStatus === 'Partial'  ? '#c97a1a'
                    : '#c0392b';

  // Per-building table rows
  const bldgRows = campus.buildings
    .sort((a, b) => (b.properties.required_flow || 0) - (a.properties.required_flow || 0))
    .map(f => {
      const p   = f.properties;
      const sc  = p.sprinklered && p.sprinklered !== 'None' ? '#2e9e52' : '#c0392b';
      const sprk = p.sprinklered && p.sprinklered !== 'None' ? '💧' : '🚫';
      const lot  = p.lot_number || '—';
      const flow = p.required_flow ? p.required_flow.toLocaleString() : '—';
      return `<tr>
        <td style="font-size:12px;font-weight:600">${lot}</td>
        <td style="font-size:12px;color:var(--muted)">${p.occupancy_type || '—'}</td>
        <td style="text-align:right;font-size:12px;font-weight:700;color:${col}">${flow}</td>
        <td style="text-align:center"><span style="color:${sc}">${sprk}</span></td>
      </tr>`;
    }).join('');

  document.getElementById('sidebar-body').innerHTML = `
    <div class="hz-stat-grid">
      <div class="hz-stat">
        <div class="hz-stat-val" style="color:${col}">${campus.totalFlow.toLocaleString()}</div>
        <div class="hz-stat-lbl">Total GPM</div>
      </div>
      <div class="hz-stat">
        <div class="hz-stat-val" style="color:${sprinkColor}">${campus.sprinkStatus}</div>
        <div class="hz-stat-lbl">Sprinkler</div>
      </div>
    </div>
    <div class="sec-hdr">Location</div>
    <table class="kv-table">
      <tr><td>Address</td><td>${campus.address}, ${campus.city} ${campus.zip || ''}</td></tr>
      <tr><td>ESZ</td><td><span class="kv-val-lg">${campus.ESZ_ID || '—'}</span></td></tr>
      <tr><td>Station</td><td><span style="color:${stColor};font-weight:700;font-family:var(--font-h);font-size:16px">${campus.StationID || '—'}</span></td></tr>
      <tr><td>Hydrants</td><td><span style="font-weight:700">${campus.maxHydrants}</span></td></tr>
    </table>
    <div class="sec-hdr">Pre-Plan · ${campus.totalAnnot} Annotations</div>
    <div class="sec-hdr" style="margin-top:6px">Buildings (${campus.buildings.length})</div>
    <table class="kv-table" style="font-size:13px">
      <thead><tr style="border-bottom:1px solid var(--border)">
        <th style="text-align:left;padding:4px 0;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em">Building</th>
        <th style="text-align:left;padding:4px 0;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em">Use</th>
        <th style="text-align:right;padding:4px 0;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em">GPM</th>
        <th style="text-align:center;padding:4px 0;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em">💧</th>
      </tr></thead>
      <tbody>${bldgRows}</tbody>
    </table>
    <div class="action-row">
      <button class="btn-sec" onclick="showHazardsOverview()">← Overview</button>
      <button class="btn-pri" onclick="map.setView([${campus.lat},${campus.lng}],16,{animate:true})">🔍 Zoom To</button>
    </div>`;

  map.setView([campus.lat, campus.lng], Math.max(map.getZoom(), 15), { animate: true });
}

// ── INFO PANEL ────────────────────────────────────────────────────────────
let INFO_DATA = null;

async function loadInfoData() {
  if (INFO_DATA) return INFO_DATA;
  try {
    const resp = await fetch('data/map_info.json');
    if (!resp.ok) throw new Error('map_info.json not found');
    INFO_DATA = await resp.json();
  } catch (e) {
    console.warn('[NPFR] map_info.json load failed:', e);
    INFO_DATA = {};
  }
  return INFO_DATA;
}

async function openInfoPanel() {
  const overlay = document.getElementById('info-overlay');
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  const body = document.getElementById('info-panel-body');
  body.innerHTML = '<div id="info-loading">Loading…</div>';
  const data = await loadInfoData();
  renderInfoPanel(data, activeMode);
}

function closeInfoPanel(e) {
  if (e && e.target !== document.getElementById('info-overlay') && e.target !== document.getElementById('info-close-btn')) return;
  document.getElementById('info-overlay').classList.remove('open');
  document.body.style.overflow = '';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.getElementById('info-overlay').classList.remove('open');
    document.body.style.overflow = '';
  }
});

function renderInfoPanel(data, mode) {
  const body  = document.getElementById('info-panel-body');
  const title = document.getElementById('info-panel-title');
  const modeData = data?.modes?.[mode] || {};
  const global   = data?.global  || {};

  title.textContent = modeData.title || 'About This Map';

  let html = '';

  html += `
    <div class="info-mode-badge">◉ ${mode.toUpperCase()} MODE</div>
    <div class="info-mode-title">${modeData.title || ''}</div>
    <div class="info-mode-subtitle">${modeData.subtitle || ''}</div>
  `;

  if (modeData.overview) {
    html += `<div class="info-section">
      <div class="info-section-title">Overview</div>
      <p class="info-body-text">${modeData.overview}</p>
    </div>`;
  }

  if (modeData.how_it_works) {
    html += `<div class="info-section">
      <div class="info-section-title">How It's Built</div>
      <p class="info-body-text">${modeData.how_it_works}</p>
    </div>`;
  }

  // COMMUNITY
  if (mode === 'community') {
    if (modeData.choropleth) {
      html += `<div class="info-section"><div class="info-section-title">Key Term</div>
        <div class="info-term-grid"><div class="info-term-card">
          <div class="info-term-name">${modeData.choropleth.term}</div>
          <div class="info-term-def">${modeData.choropleth.definition}</div>
        </div></div></div>`;
    }
    if (modeData.metrics?.length) {
      html += `<div class="info-section"><div class="info-section-title">Available Metrics</div>
        <div class="info-item-list">`;
      for (const m of modeData.metrics) {
        html += `<div class="info-item">
          <div class="info-item-label">${m.label}</div>
          <div class="info-item-desc">${m.description}</div>
        </div>`;
      }
      html += `</div></div>`;
    }
  }

  // INCIDENT
  if (mode === 'incident') {
    const sm = modeData.scoring_model;
    if (sm) {
      html += `<div class="info-section">
        <div class="info-section-title">${sm.title}</div>
        <p class="info-body-text">${sm.description}</p>
        <div class="info-scoring-axes">`;
      for (const ax of (sm.axes || [])) {
        html += `<div class="info-axis-card">
          <div class="info-axis-name">${ax.name}</div>
          <div class="info-axis-scores">${ax.scores}</div>
          <div class="info-axis-desc">${ax.description}</div>
        </div>`;
      }
      html += `</div>`;
      if (sm.formula) {
        html += `<div class="info-formula-box">
          <div class="info-formula-label">Formula</div>
          <div class="info-formula">${sm.formula}</div>
          <div class="info-formula-note">${sm.formula_note}</div>
          <div class="info-formula-example"><strong>Example:</strong> ${sm.example}</div>
        </div>`;
      }
      html += `</div>`;
    }
    if (modeData.risk_levels?.length) {
      html += `<div class="info-section"><div class="info-section-title">Risk Level Bins</div>
        <div class="info-item-list">`;
      for (const r of modeData.risk_levels) {
        html += `<div class="info-item">
          <div class="info-item-label"><span class="info-item-dot" style="background:${r.color}"></span>${r.level}${r.score_range ? `<br><span style="font-size:11px;font-weight:400;color:var(--muted)">score ${r.score_range}</span>` : ''}</div>
          <div class="info-item-desc">${r.description}</div>
        </div>`;
      }
      html += `</div></div>`;
    }
    if (modeData.programs?.length) {
      html += `<div class="info-section"><div class="info-section-title">Response Programs</div>
        <div class="info-item-list">`;
      for (const p of modeData.programs) {
        html += `<div class="info-item">
          <div class="info-item-label"><span class="info-item-dot" style="background:${p.color}"></span>${p.key}</div>
          <div class="info-item-desc">${p.description}</div>
        </div>`;
      }
      html += `</div></div>`;
    }
    if (modeData.opacity_ramp) {
      html += `<div class="info-section"><div class="info-section-title">Map Rendering</div>
        <div class="info-term-grid"><div class="info-term-card">
          <div class="info-term-name">${modeData.opacity_ramp.term}</div>
          <div class="info-term-def">${modeData.opacity_ramp.definition}</div>
        </div></div></div>`;
    }
  }

  // COVERAGE
  if (mode === 'coverage') {
    if (modeData.views?.length) {
      html += `<div class="info-section"><div class="info-section-title">Map Views</div>
        <div class="info-item-list">`;
      for (const v of modeData.views) {
        html += `<div class="info-item">
          <div class="info-item-label">${v.label}</div>
          <div class="info-item-desc">${v.description}</div>
        </div>`;
      }
      html += `</div></div>`;
    }
    if (modeData.terms?.length) {
      html += `<div class="info-section"><div class="info-section-title">Key Terms</div>
        <div class="info-term-grid">`;
      for (const t of modeData.terms) {
        html += `<div class="info-term-card">
          <div class="info-term-name">${t.term}</div>
          <div class="info-term-def">${t.definition}</div>
        </div>`;
      }
      html += `</div></div>`;
    }
    if (modeData.nfpa_context) {
      html += `<div class="info-section"><div class="info-section-title">NFPA 1710 Context</div>
        <p class="info-body-text">${modeData.nfpa_context}</p>
      </div>`;
    }
  }

  // HAZARDS
  if (mode === 'hazards') {
    const terms = [modeData.flowmsp, modeData.campus_grouping, modeData.gpm, modeData.construction_types, modeData.sprinkler_status].filter(Boolean);
    if (terms.length) {
      html += `<div class="info-section"><div class="info-section-title">Key Terms</div>
        <div class="info-term-grid">`;
      for (const t of terms) {
        html += `<div class="info-term-card">
          <div class="info-term-name">${t.term}</div>
          <div class="info-term-def">${t.definition}</div>
        </div>`;
      }
      html += `</div></div>`;
    }
    if (modeData.flow_tiers?.length) {
      const tierColors = ['#4a6fa5','#c97a1a','#c0392b','#7b3fa0'];
      html += `<div class="info-section"><div class="info-section-title">Fire Flow Tiers (Marker Size)</div>
        <table class="info-gpm-table"><thead><tr><th>Flow Range</th><th>Significance</th></tr></thead><tbody>`;
      modeData.flow_tiers.forEach((t,i) => {
        html += `<tr><td><span class="info-gpm-dot" style="background:${tierColors[i]}"></span>${t.label}</td><td>${t.description}</td></tr>`;
      });
      html += `</tbody></table></div>`;
    }
    if (modeData.categories?.length) {
      const catColors = { school:'#c97a1a', alf:'#c0392b', assembly:'#3a74b8', multifamily:'#d4a017', commercial:'#1B998B', industrial:'#6A4C93', special:'#7a7a7a' };
      html += `<div class="info-section"><div class="info-section-title">Occupancy Categories</div>
        <div class="info-item-list">`;
      for (const c of modeData.categories) {
        html += `<div class="info-item">
          <div class="info-item-label"><span class="info-item-dot" style="background:${catColors[c.key]||'#888'}"></span>${c.label}</div>
          <div class="info-item-desc">${c.description}</div>
        </div>`;
      }
      html += `</div></div>`;
    }
  }

  // ACCREDITATION (all modes)
  if (modeData.accreditation_relevance) {
    html += `<div class="info-section">
      <div class="info-section-title">🏅 CFAI Accreditation Relevance</div>
      <div class="info-accred-box"><p>${modeData.accreditation_relevance}</p></div>
    </div>`;
  }

  html += `<hr class="info-divider">`;

  // GLOBAL: ESZ definition
  if (global.geography?.esz) {
    const esz = global.geography.esz;
    html += `<div class="info-section"><div class="info-section-title">About Emergency Service Zones</div>
      <div class="info-term-grid"><div class="info-term-card">
        <div class="info-term-name">${esz.term}</div>
        <div class="info-term-def">${esz.definition}</div>
      </div></div>
      <p class="info-body-text" style="margin-top:10px;font-size:13px;color:var(--muted)">${esz.source}</p>
    </div>`;
  }

  // GLOBAL: Accreditation
  if (global.accreditation) {
    const a = global.accreditation;
    html += `<div class="info-section"><div class="info-section-title">CFAI Accreditation Program</div>
      <div class="info-term-grid"><div class="info-term-card">
        <div class="info-term-name">${a.body} — ${a.program}</div>
        <div class="info-term-def">${a.purpose}</div>
      </div></div>
    </div>`;
  }

  // GLOBAL: Data sources
  if (global.data_sources?.length) {
    html += `<div class="info-section"><div class="info-section-title">Data Sources</div>
      <ul class="info-sources">`;
    for (const s of global.data_sources) {
      html += `<li>${s}</li>`;
    }
    html += `</ul>`;
    if (global.pipeline) {
      html += `<p class="info-body-text" style="margin-top:10px;font-size:13px">${global.pipeline}</p>`;
    }
    html += `</div>`;
  }

  body.innerHTML = html;
}

// ── BOOT ──────────────────────────────────────────────────────────────────
init();