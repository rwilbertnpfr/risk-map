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

// Risk colors — atomic ramps from render_riskmaps.py
const RISK_NEON = {
  '1-Low':      '#39ff6e',
  '2-Moderate': '#ff8c00',
  '3-High':     '#ff2d55',
  '4-Maximum':  '#bf5fff',
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
  EMS:'#1565C0', Fire:'#B71C1C', Hazmat:'#E65100', Rescue:'#6A1B9A',
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
let conservationLayer    = null;
let showConservation     = true;

// ── COVERAGE STATE ────────────────────────────────────────────────────────
let DRIVE_TIME_GEO     = null;  // FeatureCollection — polygon isochrones
let DRIVE_TIME_ROADS   = null;  // FeatureCollection — road LineString segments
let ESZ_DRIVE_COV      = null;  // FeatureCollection — esz_drive_coverage.geojson
let isochroneLayer     = null;  // Leaflet layer for coverage rendering
let activeCovView      = 'road';     // 'road' | 'polygons' | 'esz'
let activeCovSubType   = 'mph';      // 'mph' | 'drivetime'
let activeCovMPH       = null;       // e.g. '25', '35', '45'
let activeCovDriveTime = null;       // e.g. '4'

// Speed MPH color palette
const MPH_COLORS = {
  '25': { fill:'#7b61ff', stroke:'#a084ff' },
  '35': { fill:'#00cfff', stroke:'#33dfff' },
  '45': { fill:'#ff8c00', stroke:'#ffad44' },
};

// Overlap count color ramp (1 station → 6+ stations)
const OVERLAP_COLORS = [
  '#39ff6e',  // 1 station  — green
  '#00cfff',  // 2 stations — cyan
  '#ff8c00',  // 3 stations — orange
  '#ff2d55',  // 4 stations — red
  '#bf5fff',  // 5 stations — purple
  '#ffffff',  // 6+         — white
];

// ── MAP INIT ──────────────────────────────────────────────────────────────
if (typeof L === 'undefined') throw new Error('Leaflet failed to load.');
const map = L.map('map', {
  center:[27.03,-82.38], zoom:11,
  zoomControl:false, attributionControl:false,
});
L.control.zoom({position:'bottomright'}).addTo(map);

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

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  maxZoom:19, opacity:0.7,
}).addTo(map);

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
    const [stRes, facRes, dtRes, dtRoadsRes, eszCovRes, consRes] = await Promise.allSettled([
      fetch('data/npfr_station_boundary.geojson'),
      fetch('data/CountyFacility.geojson'),
      fetch('data/drive_time_isochrones.geojson'),
      fetch('data/drive_time_roads.geojson'),
      fetch('data/esz_drive_coverage.geojson'),
      fetch('data/conservation_lands.geojson'),
    ]);
    STATION_GEO      = stRes.status      === 'fulfilled' && stRes.value.ok      ? await stRes.value.json()      : null;
    FACILITY_GEO     = facRes.status     === 'fulfilled' && facRes.value.ok     ? await facRes.value.json()     : null;
    DRIVE_TIME_GEO   = dtRes.status      === 'fulfilled' && dtRes.value.ok      ? await dtRes.value.json()      : null;
    DRIVE_TIME_ROADS = dtRoadsRes.status === 'fulfilled' && dtRoadsRes.value.ok ? await dtRoadsRes.value.json() : null;
    ESZ_DRIVE_COV    = eszCovRes.status  === 'fulfilled' && eszCovRes.value.ok  ? await eszCovRes.value.json()  : null;
    CONSERVATION_GEO = consRes.status    === 'fulfilled' && consRes.value.ok    ? await consRes.value.json()    : null;

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

  // Update button label + dot
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

  app.classList.toggle('incident-mode', mode === 'incident');
  app.classList.toggle('coverage-mode',  mode === 'coverage');

  if (mode === 'community') {
    activeProgram = null;
    activeRisk    = null;
    activeESZ     = null;
    clearIsochroneLayer();
    renderChoropleth();
    showStationOverview(activeStation);
  } else if (mode === 'incident') {
    activeESZ = null;
    clearIsochroneLayer();
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
    if (choroplethLayer) { map.removeLayer(choroplethLayer); choroplethLayer = null; }
    buildCoverageSubheader();
    renderCoverageLayer();
    showCoverageOverview();
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
  if (stationBoundaryLayer) map.removeLayer(stationBoundaryLayer);
  if (stationLabelLayer)    map.removeLayer(stationLabelLayer);

  if (STATION_GEO?.features?.length) {
    stationBoundaryLayer = L.geoJSON(STATION_GEO, {
      style: () => ({color:'#c8c8e8', weight:2.5, opacity:0.9, fillOpacity:0}),
      interactive: false,
    }).addTo(map);
  }

  const labelFeatures = [];
  if (FACILITY_GEO?.features) {
    FACILITY_GEO.features.forEach(f => {
      const lbl = f.properties.cadlabel || f.properties.CadLabel || '';
      const num = parseInt(lbl);
      if (num >= 81 && num <= 86)
        labelFeatures.push({sid:'ST'+num, coords:f.geometry.coordinates});
    });
  } else if (STATION_GEO?.features) {
    STATION_GEO.features.forEach(f => {
      const sid = f.properties.StationID || f.properties.station_id || '';
      if (!sid) return;
      const flat  = f.geometry.coordinates.flat(10).filter((_,i)=>i%2===0);
      const flatY = f.geometry.coordinates.flat(10).filter((_,i)=>i%2===1);
      if (!flat.length) return;
      labelFeatures.push({
        sid,
        coords:[
          flat.reduce((a,b)=>a+b,0)/flat.length,
          flatY.reduce((a,b)=>a+b,0)/flatY.length,
        ]
      });
    });
  }

  if (labelFeatures.length) {
    const grp = L.layerGroup();
    labelFeatures.forEach(({sid, coords}) => {
      L.marker([coords[1], coords[0]], {
        icon: L.divIcon({
          className:'',
          html:`<div style="font-family:Barlow Condensed,sans-serif;font-size:20px;font-weight:700;`
             + `letter-spacing:.08em;color:#00cfff;`
             + `text-shadow:-2px -2px 0 #0a0a1a,2px -2px 0 #0a0a1a,-2px 2px 0 #0a0a1a,2px 2px 0 #0a0a1a;`
             + `white-space:nowrap;pointer-events:none;">${sid}</div>`,
          iconAnchor:[28,10],
        }),
        interactive:false, zIndexOffset:500,
      }).addTo(grp);
    });
    stationLabelLayer = grp.addTo(map);
  }
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
    if (stationBoundaryLayer) stationBoundaryLayer.bringToFront();
  } else {
    map.removeLayer(conservationLayer);
  }
}


const RAMPS = {
  yellow: ['#1a1400','#3d3000','#736000','#a88c00','#ddb800','#ffdd00'],
  fire:   ['#1a1400','#3d3000','#736000','#a88c00','#ddb800','#ffdd00'],
  blue:   ['#1a1400','#3d3000','#736000','#a88c00','#ddb800','#ffdd00'],
  orange: ['#1a1400','#3d3000','#736000','#a88c00','#ddb800','#ffdd00'],
};

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
  const colors = RAMPS[ramp] || RAMPS.yellow;
  if (val === undefined || val === null || val === '' || isNaN(parseFloat(val))) return colors[0];
  const n = parseFloat(val);
  if (n <= 0) return colors[0];
  for (let i=0; i<breaks.length; i++) { if (n <= breaks[i]) return colors[i+1]; }
  return colors[colors.length-1];
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

function buildBandColors(risk, nBands) {
  // Index 0 = zero band (deep navy); indices 1..nBands = dim→neon
  const dark = RISK_DARK[risk] || '#001020';
  const neon = RISK_NEON[risk] || '#00cfff';
  const colors = [ZERO_BAND_COLOR];
  for (let i=0; i<nBands; i++) {
    const t = 0.15 + 0.85 * (i / Math.max(nBands-1, 1));
    colors.push(lerpHex(dark, neon, t));
  }
  return colors;
}

function incidentColor(count, cuts, bandColors) {
  if (!count || isNaN(count) || count <= 0) return ZERO_BAND_COLOR;
  for (let i=0; i<cuts.length-1; i++) {
    if (count >= cuts[i] && count < cuts[i+1])
      return bandColors[i+1] || bandColors[bandColors.length-1];
  }
  return bandColors[bandColors.length-1];
}

// ── LEGENDS ───────────────────────────────────────────────────────────────
function buildCommunityLegend(breaks, ramp, metric) {
  const colors = RAMPS[ramp] || RAMPS.yellow;
  const isYear = YEAR_METRICS.has(metric);
  const isPct  = PCT_METRICS.has(metric);
  let labels;
  if (isPct) {
    labels = [
      'Zero / no data',
      '0 – 20%',
      '20 – 40%',
      '40 – 60%',
      '60 – 80%',
      '80 – 100%',
    ];
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
  document.getElementById('legend-rows').innerHTML = colors.map((c,i) =>
    `<div class="legend-row"><div class="legend-swatch" style="background:${c}"></div><span>${labels[i]||''}</span></div>`
  ).join('');
}

function buildIncidentLegend(cuts, bandColors, program, risk) {
  const neon = RISK_NEON[risk] || '#00cfff';
  document.getElementById('legend-title').innerHTML =
    `<span style="color:${PROG_COLORS[program]||'#fff'}">${program}</span>`
    + `<span style="color:var(--muted)"> · </span>`
    + `<span style="color:${neon}">${risk}</span>`;
  const rows = [
    `<div class="legend-row"><div class="legend-swatch" style="background:${ZERO_BAND_COLOR}"></div><span>No Incidents</span></div>`
  ];
  const nActive = cuts.length - 1;
  for (let i=0; i<nActive; i++) {
    const lo = cuts[i].toLocaleString();
    const hi = i === nActive-1 ? '∞' : (cuts[i+1]-1).toLocaleString();
    rows.push(
      `<div class="legend-row"><div class="legend-swatch" style="background:${bandColors[i+1]||bandColors[bandColors.length-1]}"></div>`
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
  // Layer order: choropleth → conservation → station boundaries → labels
  if (conservationLayer && showConservation) conservationLayer.bringToFront();
  if (stationBoundaryLayer) stationBoundaryLayer.bringToFront();
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

  const fc = activeStation === 'ALL' ? ESZ_GEOJSON
    : {...ESZ_GEOJSON, features: ESZ_GEOJSON.features.filter(f => (f.properties.StationID || f.properties.station_id) === activeStation)};

  choroplethLayer = L.geoJSON(fc, {
    style: feat => {
      const raw = parseFloat(feat.properties[metric]);
      const val = isYear ? (CURRENT_YEAR - raw) : raw;
      return {
        fillColor:   communityColor(val, breaks, ramp),
        fillOpacity: 1.0, color:'#ffffff', weight:0.5, opacity:0.3,
      };
    },
    onEachFeature: (feat, layer) => {
      layer.on({
        mouseover: e => {
          if (!windowFocused) return;
          e.target.setStyle({weight:2, color:'#ffffff', opacity:1});
          e.target.bringToFront();
        },
        mouseout: e => {
          const isActive = activeESZ && feat.properties.ESZ_ID === activeESZ;
          e.target.setStyle(isActive
            ? {weight:2, color:'#fff', opacity:1}
            : {weight:0.5, color:'#ffffff', opacity:0.3}
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
  const fc = activeStation === 'ALL' ? ESZ_GEOJSON
    : {...ESZ_GEOJSON, features: ESZ_GEOJSON.features.filter(f => (f.properties.StationID || f.properties.station_id) === activeStation)};

  choroplethLayer = L.geoJSON(fc, {
    style: feat => {
      const e     = ESZ_COUNTS[feat.properties.ESZ_ID];
      const count = e ? (parseInt(e[col]) || 0) : 0;
      return {
        fillColor:   incidentColor(count, cuts, bandColors),
        fillOpacity: 1.0, color:'#ffffff', weight:0.5, opacity:0.3,
      };
    },
    onEachFeature: (feat, layer) => {
      const e     = ESZ_COUNTS[feat.properties.ESZ_ID];
      const count = e ? (parseInt(e[col]) || 0) : 0;
      layer.on({
        mouseover: ev => {
          if (!windowFocused) return;
          ev.target.setStyle({weight:2, color:'#ffffff', opacity:1});
          ev.target.bringToFront();
        },
        mouseout: ev => {
          const isActive = activeESZ && feat.properties.ESZ_ID === activeESZ;
          ev.target.setStyle(isActive
            ? {weight:2, color:'#fff', opacity:1}
            : {weight:0.5, color:'#ffffff', opacity:0.3}
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

  const stations = sid === 'ALL' ? Object.values(STATION_SUMS) : [s];
  const totPop   = stations.reduce((a,st)=>a+(st?.est_population||0),0);
  const totUnits = stations.reduce((a,st)=>a+(st?.total_units||0),0);
  const totEszs  = stations.reduce((a,st)=>a+(st?.esz_count||0),0);

  document.getElementById('sidebar-body').innerHTML = `
    <div class="sec-hdr">Jurisdiction Summary</div>
    <table class="kv-table">
      <tr><td>Total ESZs</td><td>${totEszs.toLocaleString()}</td></tr>
      <tr><td>Est. Population</td><td>${totPop.toLocaleString()}</td></tr>
      <tr><td>Total Units</td><td>${totUnits.toLocaleString()}</td></tr>
    </table>
    <div class="sec-hdr">By Station</div>
    ${stations.map(st=>`
      <div class="station-card" onclick="filterStation('${st.StationID}')">
        <div class="sc-head">${st.StationID}</div>
        <div class="sc-kv">
          <div class="sc-kv-item"><div class="sc-kv-lbl">ESZs</div><div class="sc-kv-val">${st.esz_count}</div></div>
          <div class="sc-kv-item"><div class="sc-kv-lbl">Population</div><div class="sc-kv-val">${st.est_population.toLocaleString()}</div></div>
          <div class="sc-kv-item"><div class="sc-kv-lbl">Units</div><div class="sc-kv-val">${st.total_units.toLocaleString()}</div></div>
        </div>
      </div>
    `).join('')}
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
      l.setStyle(isActive
        ? {weight:2, color:'#fff', opacity:1, fillOpacity:1.0, fillColor: communityColor(val, breaks, ramp)}
        : {weight:0.5, color:'#ffffff', opacity:0.3, fillOpacity:1.0, fillColor: communityColor(val, breaks, ramp)}
      );
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
      const p     = l.feature.properties;
      const e     = ESZ_COUNTS?.[p.ESZ_ID];
      const cnt   = e ? (parseInt(e[col])||0) : 0;
      const isActive = p.ESZ_ID === activeESZ;
      l.setStyle({
        weight:      isActive ? 2 : 0.5,
        color:       '#ffffff',
        opacity:     isActive ? 1 : 0.3,
        fillOpacity: 1.0,
        fillColor:   incidentColor(cnt, cuts, bandColors),
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
const ESZ_COV_RAMP = [
  '#1a1400','#3d3000','#736000','#a88c00','#ddb800','#ffdd00',
];

function eszCovKey() {
  return `cov_${activeCovMPH}mph_${activeCovDriveTime}min`;
}

function eszCovColor(fraction) {
  if (fraction === null || fraction === undefined || isNaN(fraction)) return ESZ_COV_RAMP[0];
  // Map 0–1 onto 6 ramp stops
  const idx = fraction <= 0 ? 0 : Math.min(Math.floor(fraction * (ESZ_COV_RAMP.length - 1) + 0.5), ESZ_COV_RAMP.length - 1);
  // Smooth: lerp between two adjacent stops
  const scaled = fraction * (ESZ_COV_RAMP.length - 1);
  const lo = Math.floor(scaled), hi = Math.min(lo + 1, ESZ_COV_RAMP.length - 1);
  const t  = scaled - lo;
  return lerpHex(ESZ_COV_RAMP[lo], ESZ_COV_RAMP[hi], t);
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
      return {
        fillColor:   eszCovColor(val),
        fillOpacity: 1.0,
        color:       '#ffffff',
        weight:      0.5,
        opacity:     0.3,
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

  if (stationBoundaryLayer) stationBoundaryLayer.bringToFront();
  if (stationLabelLayer)    stationLabelLayer.eachLayer(l => l.bringToFront?.());

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

  if (stationBoundaryLayer) stationBoundaryLayer.bringToFront();
  if (stationLabelLayer)    stationLabelLayer.eachLayer(l => l.bringToFront?.());

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

  if (stationBoundaryLayer) stationBoundaryLayer.bringToFront();
  if (stationLabelLayer)    stationLabelLayer.eachLayer(l => l.bringToFront?.());

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
  // Use the exact ramp stops so swatches match what's on the map
  const stops = ESZ_COV_RAMP.map((color, i) => {
    const frac = i / (ESZ_COV_RAMP.length - 1);
    const pct  = Math.round(frac * 100);
    return `<div class="legend-row">
      <div class="legend-swatch" style="background:${color}"></div>
      <span>${pct}%</span>
    </div>`;
  }).reverse(); // 100% at top
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
      <tr><td>Full Coverage (100%)</td><td style="color:${ESZ_COV_RAMP[5]};font-weight:700">${full}</td></tr>
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

// ── BOOT ──────────────────────────────────────────────────────────────────
init();