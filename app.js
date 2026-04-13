// ── RUNTIME DATA ──────────────────────────────────────────────────────────
let ESZ_GEOJSON   = null;  // FeatureCollection — community profile props + geometry
let STATION_GEO   = null;
let FACILITY_GEO  = null;
let STATION_SUMS  = null;
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
let activeMode    = 'community';
let activeStation = 'ALL';
let activeESZ     = null;
let activeProgram = null;
let activeRisk    = null;
let currentMetric = 'est_population';
let choroplethLayer      = null;
let stationBoundaryLayer = null;
let stationLabelLayer    = null;

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
    const [stRes, facRes] = await Promise.allSettled([
      fetch('data/npfr_station_boundary.geojson'),
      fetch('data/CountyFacility.geojson'),
    ]);
    STATION_GEO  = stRes.status  === 'fulfilled' && stRes.value.ok  ? await stRes.value.json()  : null;
    FACILITY_GEO = facRes.status === 'fulfilled' && facRes.value.ok ? await facRes.value.json() : null;

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

// ── STATION PILLS ─────────────────────────────────────────────────────────
function buildStationPills() {
  document.getElementById('station-pills').innerHTML =
    '<button class="pill all active" data-station="ALL" onclick="filterStation(this)">All</button>'
    + STATIONS.map(s =>
        `<button class="pill" data-station="${s}" onclick="filterStation(this)">${s}</button>`
      ).join('');
}

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

  if (mode === 'community') {
    app.classList.remove('incident-mode');
    activeProgram = null;
    activeRisk    = null;
    activeESZ     = null;
    renderChoropleth();
    showStationOverview(activeStation);
  } else {
    app.classList.add('incident-mode');
    const progs = Object.keys(PROG_RISK_MAP);
    if (progs.length && !activeProgram) {
      selectProgram(progs[0]);  // → selectRisk → renderChoropleth
    } else if (activeProgram) {
      renderChoropleth();
      showStationOverview(activeStation);
    }
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

// ── COMMUNITY CHOROPLETH helpers ──────────────────────────────────────────
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
  // For year metrics, breaks are already in age (years old) from renderCommunityChoropleth
  // fmt() will display them as "X yrs old" but legend needs raw age values formatted simply
  const fmtBreak = v => isYear ? Math.round(v) + ' yrs' : fmt(v, metric);
  const labels = [
    'Zero / no data',
    `< ${fmtBreak(breaks[0])}`,
    `${fmtBreak(breaks[0])} – ${fmtBreak(breaks[1])}`,
    `${fmtBreak(breaks[1])} – ${fmtBreak(breaks[2])}`,
    `${fmtBreak(breaks[2])} – ${fmtBreak(breaks[3])}`,
    `> ${fmtBreak(breaks[3])}`,
  ];
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
  if (choroplethLayer) map.removeLayer(choroplethLayer);
  activeMode === 'community' ? renderCommunityChoropleth() : renderIncidentChoropleth();
  // Bring station boundary lines above the choropleth fill
  // (markers in stationLabelLayer are always above vector layers in Leaflet — no action needed)
  if (stationBoundaryLayer) stationBoundaryLayer.bringToFront();
}

function renderCommunityChoropleth() {
  const metric = currentMetric;
  const ramp   = getRamp(metric);
  const isYear = YEAR_METRICS.has(metric);

  // For year built metrics, invert so older (lower year) = higher score = brighter/redder
  // Score = currentYear - builtYear, so a 1960 building scores higher than a 2020 building
  const CURRENT_YEAR = new Date().getFullYear();
  const rawVals = ESZ_GEOJSON.features
    .map(f => parseFloat(f.properties[metric]))
    .filter(v => !isNaN(v) && v > 0);
  const vals   = isYear ? rawVals.map(v => CURRENT_YEAR - v) : rawVals;
  const breaks = isYear ? equalWidthBreaks(vals, 5) : quantileBreaks(vals, 5);

  const fc = activeStation === 'ALL' ? ESZ_GEOJSON
    : {...ESZ_GEOJSON, features: ESZ_GEOJSON.features.filter(f=>f.properties.StationID===activeStation)};

  choroplethLayer = L.geoJSON(fc, {
    style: feat => {
      const raw = parseFloat(feat.properties[metric]);
      const val = isYear ? (CURRENT_YEAR - raw) : raw;
      return {
        fillColor:   communityColor(val, breaks, ramp),
        fillOpacity: 0.75, color:'#ffffff', weight:0.5, opacity:0.3,
      };
    },
    onEachFeature: (feat, layer) => {
      layer.on({
        mouseover: e => {
          if (!windowFocused) return;
          e.target.setStyle({weight:1.5, opacity:0.8, fillOpacity:0.9});
          e.target.bringToFront();
        },
        mouseout: e => {
          const isActive = activeESZ && feat.properties.ESZ_ID === activeESZ;
          e.target.setStyle(isActive
            ? {weight:2, color:'#fff', opacity:1, fillOpacity:0.75}
            : {
                weight:0.5, color:'#ffffff', opacity:0.3,
                fillOpacity:0.75,
                fillColor: communityColor(
                  isYear ? (CURRENT_YEAR - parseFloat(feat.properties[metric])) : parseFloat(feat.properties[metric]),
                  breaks, ramp
                ),
              }
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
    : {...ESZ_GEOJSON, features: ESZ_GEOJSON.features.filter(f=>f.properties.StationID===activeStation)};

  choroplethLayer = L.geoJSON(fc, {
    style: feat => {
      const e     = ESZ_COUNTS[feat.properties.ESZ_ID];
      const count = e ? (parseInt(e[col]) || 0) : 0;
      return {
        fillColor:   incidentColor(count, cuts, bandColors),
        fillOpacity: 0.80, color:'#ffffff', weight:0.5, opacity:0.3,
      };
    },
    onEachFeature: (feat, layer) => {
      const e     = ESZ_COUNTS[feat.properties.ESZ_ID];
      const count = e ? (parseInt(e[col]) || 0) : 0;
      layer.on({
        mouseover: ev => {
          if (!windowFocused) return;
          ev.target.setStyle({weight:1.5, opacity:0.8, fillOpacity:0.95});
          ev.target.bringToFront();
        },
        mouseout: ev => {
          const isActive = activeESZ && feat.properties.ESZ_ID === activeESZ;
          ev.target.setStyle(isActive
            ? {weight:2, color:'#fff', opacity:1, fillOpacity:0.80}
            : {
                weight:0.5, color:'#ffffff', opacity:0.3,
                fillOpacity:0.80,
                fillColor: incidentColor(count, cuts, bandColors),
              }
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
      <div class="station-card" onclick="filterStation(document.querySelector('[data-station=${st.StationID}]'))">
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
    const CURRENT_YEAR = new Date().getFullYear();
    const rawVals = ESZ_GEOJSON.features.map(f=>parseFloat(f.properties[metric])).filter(v=>!isNaN(v)&&v>0);
    const vals   = isYear ? rawVals.map(v=>CURRENT_YEAR-v) : rawVals;
    const breaks = isYear ? equalWidthBreaks(vals,5) : quantileBreaks(vals,5);
    choroplethLayer.eachLayer(l => {
      const p = l.feature.properties;
      const isActive = p.ESZ_ID === activeESZ;
      const raw = parseFloat(p[metric]);
      const val = isYear ? (CURRENT_YEAR - raw) : raw;
      l.setStyle(isActive
        ? {weight:2, color:'#fff', opacity:1, fillOpacity:0.75, fillColor: communityColor(val, breaks, ramp)}
        : {weight:0.5, color:'#ffffff', opacity:0.3, fillOpacity:0.75, fillColor: communityColor(val, breaks, ramp)}
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
        fillOpacity: 0.80,
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

// ── STATION FILTER ────────────────────────────────────────────────────────
function filterStation(el) {
  if (!el || !el.dataset) return;
  const sid = el.dataset.station;
  activeStation = sid;
  activeESZ     = null;
  document.querySelectorAll('.pill').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  renderChoropleth();
  showStationOverview(sid);
  if (sid !== 'ALL') {
    const feats = ESZ_GEOJSON.features.filter(f=>
      (f.properties.StationID||f.properties.station_id) === sid
    );
    if (feats.length) {
      const b = L.geoJSON({type:'FeatureCollection', features:feats}).getBounds();
      if (b.isValid()) map.fitBounds(b, {padding:[30,30]});
    }
  } else {
    const b = L.geoJSON(ESZ_GEOJSON).getBounds();
    if (b.isValid()) map.fitBounds(b, {padding:[30,30]});
  }
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

// ── BOOT ──────────────────────────────────────────────────────────────────
init();