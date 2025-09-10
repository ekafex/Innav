// app.js — GPS-like indoor provider integration (PDR + PF + map constraint)
// NOTE: Make sure index.html loads this with: <script type="module" src="app.js"></script>
import { IndoorLocationProvider } from './location/provider.js';
import { MapMatcher } from './location/map.js';

/* -------------------- Config -------------------- */
const Y_DOWN = false; // if your coords are math-like (+y up), keep false
// ---- Map scale ----
// If your SVG/graph uses pixels, set how many pixels ≈ 1 meter in the real world.
// Tweak until a normal walking pace looks right. Start with 30–60 px/m for indoor plans.
const MAP_UNITS_PER_METER = 60;  // <<< tune me

let walkable = { polygons: [] };

/* -------------------- Utilities -------------------- */
async function loadJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url} (${r.status})`);
  return r.json();
}
async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url} (${r.status})`);
  return r.text();
}
function parseSvgMeta(svgText) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const root = doc.documentElement;
  let vb = root.getAttribute('viewBox');
  let minX, minY, width, height;
  if (vb) {
    [minX, minY, width, height] = vb.trim().split(/[\s,]+/).map(Number);
  } else {
    const w = parseFloat(root.getAttribute('width') || '0');
    const h = parseFloat(root.getAttribute('height') || '0');
    minX = 0; minY = 0; width = w || 1000; height = h || 1000;
  }
  if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) {
    minX = 0; minY = 0; width = 1000; height = 1000;
  }
  return { viewBox: { minX, minY, width, height }, text: svgText };
}
function svgTextToDataUri(svgText) {
  return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svgText);
}
function euclid(a, b) {
  const ax = a.x_m ?? a.x ?? 0, ay = a.y_m ?? a.y ?? 0;
  const bx = b.x_m ?? b.x ?? 0, by = b.y_m ?? b.y ?? 0;
  return Math.hypot(ax - bx, ay - by);
}
function bearingDeg(a, b) {
  const ax = a.x_m ?? a.x ?? 0, ay = a.y_m ?? a.y ?? 0;
  const bx = b.x_m ?? b.x ?? 0, by = b.y_m ?? b.y ?? 0;
  const rad = Math.atan2(by - ay, bx - ax);
  let deg = rad * 180 / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}
function deltaAngle(a, b) { return ((b - a + 540) % 360) - 180; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

/* -------------------- State -------------------- */
let graph = null, mediaMap = null, aliasesRaw = {};
let floor = null, floorDataUri = null;

const nodesById = new Map(), nodesByIdLower = new Map();
const aliasMap = new Map(), allSuggestStrings = new Set();
const adj = new Map();

let currentRoute = [], currentStep = 0, maneuvers = [];

// voice/audio
let voiceEnabled = false;
let voiceLang = 'en';
let preferClips = true;
let allowBrowserTTS = true;

// Side nav buttons
let __leftBtn = null, __rightBtn = null;

// Live user pose (now from IndoorLocationProvider)
let userPose = { x: null, y: null, heading: 0, conf: 0 };
let _xr = null, _yr = null, _tr = 0; // eased (rendered) pose

// Keep a provider instance scoped so anchors can target it
let __provider = null;

/* -------------------- Boot -------------------- */
window.addEventListener('DOMContentLoaded', async () => {
  // Load assets
  // inside DOMContentLoaded, replace your existing Promise.all with this 5-item one:
    const [g, m, svgText, a, w] = await Promise.all([
        loadJSON('data/graph.json'),
         loadJSON('data/media_map.json'),
        fetchText('data/floor.svg'),
        loadJSON('data/aliases.json').catch(() => ({})),
        loadJSON('data/walkable.json').catch(() => ({ polygons: [] }))
    ]);

    graph = g;
    mediaMap = m;
    aliasesRaw = a || {};
    floor = parseSvgMeta(svgText);
    floorDataUri = svgTextToDataUri(floor.text);
    walkable = w;                   // <<< make it available globally

    // …then later in the same DOMContentLoaded you already call:
    setupLivePositioningUI();       // this now sees `walkable`



  // Build graph structures
  (graph.nodes || []).forEach(n => {
    nodesById.set(n.id, n);
    nodesByIdLower.set(n.id.toLowerCase(), n.id);
  });
  (graph.nodes || []).forEach(n => adj.set(n.id, new Set()));
  (graph.edges || []).forEach(e => { adj.get(e.from)?.add(e.to); adj.get(e.to)?.add(e.from); });

  // Aliases & suggestions
  buildAliasIndex(aliasesRaw);

  // ----- UI wiring -----
  const fromInput = document.getElementById('fromInput');
  const toInput   = document.getElementById('toInput');
  const datalist  = document.getElementById('nodeList');
  const routeBtn  = document.getElementById('routeBtn');

  const toggleViewBtn = document.getElementById('toggleViewBtn');
  const mapLayer = document.getElementById('mapLayer');
  const panoLayer = document.getElementById('panoLayer');

  // Big floating cue (draggable)
  const bigNav = document.getElementById('bigNav');
  const bigNavIcon = document.getElementById('bigNavIcon');
  const bigNavPrimary = document.getElementById('bigNavPrimary');
  const bigNavSecondary = document.getElementById('bigNavSecondary');

  // Voice controls
  const voiceBtn = document.getElementById('voiceBtn');
  const voiceLangSel = document.getElementById('voiceLang');

  // PiP
  const pip = document.getElementById('pip');
  const pipShow = document.getElementById('pipShow');
  const pipHide = document.getElementById('pipHide');

  pipShow?.addEventListener('click', () => { pip?.classList.remove('hidden'); pipShow.classList.add('hidden'); drawMinimap(); });
  pipHide?.addEventListener('click', () => { pip?.classList.add('hidden'); pipShow.classList.remove('hidden'); });

  // Panorama toggle
  toggleViewBtn?.addEventListener('click', () => {
    const mapShown = mapLayer && !mapLayer.classList.contains('hidden');
    if (mapLayer && panoLayer) {
      if (mapShown) {
        mapLayer.classList.add('hidden'); panoLayer.classList.remove('hidden'); toggleViewBtn.textContent = 'Map';
        if (currentRoute.length) setSkyTexture(mediaMap?.[currentRoute[currentStep]] || null);
        const sceneEl = document.querySelector('#panoLayer a-scene');
        if (sceneEl) {
          if (!sceneEl.hasLoaded) sceneEl.addEventListener('loaded', () => sceneEl.resize(), { once: true });
          if (sceneEl.resize) sceneEl.resize();
          setTimeout(() => sceneEl.resize && sceneEl.resize(), 0);
        }
      } else {
        panoLayer.classList.add('hidden'); mapLayer.classList.remove('hidden'); toggleViewBtn.textContent = 'Panorama';
        drawSvgOverlay();
      }
    }
  });

  // Route compute
  routeBtn?.addEventListener('click', () => {
    const start = normalizeAlias(fromInput?.value.trim());
    const end   = normalizeAlias(toInput?.value.trim());
    if (!start || !end || !nodesById.has(start) || !nodesById.has(end)) return;

    currentRoute = shortestPath(start, end);
    currentStep = 0;
    maneuvers = computeManeuvers(currentRoute);

    renderStep();
    drawMinimap();
    drawSvgOverlay();
    updateBigCue();
    refreshSideNavButtons(); // ensure ◀/▶ enabled immediately

    // Re-anchor provider at route start if running
    if (__provider && currentRoute.length) {
      const n0 = nodesById.get(currentRoute[0]);
      const heading = currentRoute.length >= 2 ? bearingDeg(nodesById.get(currentRoute[0]), nodesById.get(currentRoute[1])) : 0;
      __provider.anchor({ x: n0.x_m ?? n0.x, y: n0.y_m ?? n0.y, headingDeg: heading });
    }
  });

  // Suggestions: datalist + custom popup
  rebuildDatalist(datalist, '');
  setupSuggestPopup(fromInput, document.getElementById('fromSuggest'));
  setupSuggestPopup(toInput, document.getElementById('toSuggest'));

  fromInput.addEventListener('keydown', e => { if (e.key === 'Enter') routeBtn?.click(); });
  toInput.addEventListener('keydown',   e => { if (e.key === 'Enter') routeBtn?.click(); });

  // Side ◀ / ▶
  createSideNavButtons();

  // Voice (separate single toggle + language)
  voiceBtn?.addEventListener('click', () => {
    voiceEnabled = !voiceEnabled;
    voiceBtn.textContent = `Voice: ${voiceEnabled ? 'On' : 'Off'}`;
    if (voiceEnabled) speakCue(getCueForStep(currentStep));
  });
  voiceLangSel?.addEventListener('change', () => { voiceLang = voiceLangSel.value || 'en'; });

  // Draggable cue default (bottom-left via CSS)
  restorePanelPosition(bigNav, 'bigNavPos');
  makeDraggable(bigNav, document.getElementById('viewer'), 'bigNavPos');

  // Initial renders
  drawMinimap();
  drawSvgOverlay();
  renderStep();
  updateBigCue();

  // Patch stepRoute to also refresh cue & buttons
  const _stepRoute = stepRoute;
  stepRoute = function(delta) { _stepRoute(delta); updateBigCue(); refreshSideNavButtons(); };

  // Live positioning UI wiring (now uses provider)
  setupLivePositioningUI();

  // ---- local helper in init ----
  function updateBigCue() {
    if (!bigNav || !bigNavIcon || !bigNavPrimary) return;
    const cue = getCueForStep(currentStep);
    bigNav.classList.toggle('hidden', !cue);
    if (!cue) return;
    bigNavIcon.innerHTML = svgForTurn(cue.type);
    bigNavPrimary.textContent = cue.primary;
    if (bigNavSecondary) bigNavSecondary.textContent = cue.secondary || '';
    if (voiceEnabled) speakCue(cue);
  }
});

/* -------------------- Alias & Suggestions -------------------- */
function buildAliasIndex(aliasesRaw) {
  const pushAlias = (label, idCandidate) => {
    if (!label) return;
    const key = String(label).trim();
    const low = key.toLowerCase();
    let id = idCandidate;
    if (typeof id === 'string') {
      id = nodesById.has(id) ? id : (nodesByIdLower.get(id.toLowerCase()) || id);
    }
    if (typeof id === 'string') {
      aliasMap.set(low, id);
      allSuggestStrings.add(key);
    }
  };

  Object.entries(aliasesRaw).forEach(([k, v]) => {
    if (typeof v === 'string') {
      pushAlias(k, v);
    } else if (v && typeof v === 'object') {
      const id = v.id ?? v.ID ?? v.node;
      pushAlias(k, id);
      const syns = Array.isArray(v.synonyms) ? v.synonyms : (Array.isArray(v.aliases) ? v.aliases : []);
      syns.forEach(s => pushAlias(s, id));
    }
  });

  (graph.nodes || []).forEach(n => allSuggestStrings.add(n.id));
}
function normalizeAlias(input) {
  if (!input) return input;
  const s = String(input).trim();
  if (nodesById.has(s)) return s;
  const byLower = nodesByIdLower.get(s.toLowerCase());
  if (byLower) return byLower;
  const aliased = aliasMap.get(s.toLowerCase());
  if (aliased && nodesById.has(aliased)) return aliased;
  return s;
}
function rebuildDatalist(datalistEl, filterText = '') {
  const f = (filterText || '').trim().toLowerCase();
  datalistEl.innerHTML = '';
  const opts = Array.from(allSuggestStrings);
  const prefix = f ? opts.filter(x => x.toLowerCase().startsWith(f)) : opts.slice();
  const substr = f ? opts.filter(x => !x.toLowerCase().startsWith(f) && x.toLowerCase().includes(f)) : [];
  const merged = (f ? [...prefix, ...substr] : prefix).slice(0, 200);
  for (const val of merged) {
    const opt = document.createElement('option');
    opt.value = val; datalistEl.appendChild(opt);
  }
}
function setupSuggestPopup(inputEl, boxEl) {
  if (!inputEl || !boxEl) return;
  const update = () => {
    const f = (inputEl.value || '').trim().toLowerCase();
    const opts = Array.from(allSuggestStrings);
    const prefix = f ? opts.filter(x => x.toLowerCase().startsWith(f)) : opts.slice();
    const substr = f ? opts.filter(x => !x.toLowerCase().startsWith(f) && x.toLowerCase().includes(f)) : [];
    const merged = (f ? [...prefix, ...substr] : prefix).slice(0, 30);

    if (!merged.length) { boxEl.style.display = 'none'; return; }
    boxEl.innerHTML = merged.map(v => `<div class="suggest-item" data-v="${encodeURIComponent(v)}">${v}</div>`).join('');
    // position under the input
    const r = inputEl.getBoundingClientRect();
    const vr = document.getElementById('viewer').getBoundingClientRect();
    boxEl.style.left = (r.left - vr.left) + 'px';
    boxEl.style.top  = (r.bottom - vr.top + 6) + 'px';
    boxEl.style.minWidth = r.width + 'px';
    boxEl.style.display = 'block';
  };
  inputEl.addEventListener('input', update);
  inputEl.addEventListener('focus',  update);
  inputEl.addEventListener('blur',   () => setTimeout(() => boxEl.style.display='none', 150));
  boxEl.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.suggest-item');
    if (!item) return;
    const v = decodeURIComponent(item.getAttribute('data-v'));
    inputEl.value = v;
    boxEl.style.display = 'none';
  });
}

/* -------------------- Pathfinding -------------------- */
function shortestPath(start, goal) {
  const dist = new Map(), prev = new Map();
  const unvisited = new Set([...nodesById.keys()]);
  nodesById.forEach((_, id) => dist.set(id, Infinity));
  dist.set(start, 0);

  function popMin() {
    let best = null, bestVal = Infinity;
    for (const id of unvisited) {
      const d = dist.get(id);
      if (d < bestVal) { bestVal = d; best = id; }
    }
    if (best !== null) unvisited.delete(best);
    return best;
  }

  while (unvisited.size) {
    const u = popMin();
    if (u === null) break;
    if (u === goal) break;
    for (const v of adj.get(u) || []) {
      if (!unvisited.has(v)) continue;
      const alt = dist.get(u) + euclid(nodesById.get(u), nodesById.get(v));
      if (alt < dist.get(v)) { dist.set(v, alt); prev.set(v, u); }
    }
  }

  const path = [];
  let cur = goal;
  if (!prev.has(cur) && cur !== start) return [];
  while (cur !== undefined) {
    path.unshift(cur);
    cur = prev.get(cur);
    if (cur === start) { path.unshift(start); break; }
  }
  return path;
}

/* -------------------- Maneuvers (left/right correct) -------------------- */
function computeManeuvers(route) {
  const out = [];
  if (!route || route.length === 0) return out;

  const nameFor = id => id;

  for (let i = 0; i < route.length; i++) {
    if (i === 0 && route.length > 1) {
      out.push({ type: 'depart', primary: `Proceed to ${nameFor(route[i+1])}`, secondary: `Step 1 of ${route.length - 1}` });
      continue;
    }
    if (i === route.length - 1) {
      out.push({ type: 'arrive', primary: `Arrive at ${nameFor(route[i])}`, secondary: 'Destination' });
      continue;
    }

    const a = nodesById.get(route[i-1]);
    const b = nodesById.get(route[i]);
    const c = nodesById.get(route[i+1]);
    if (!a || !b || !c) { out.push(null); continue; }

    const ang1 = bearingDeg(a, b);
    const ang2 = bearingDeg(b, c);
    const d = (Y_DOWN ? -1 : 1) * deltaAngle(ang1, ang2);

    let type = 'straight', text = 'Continue straight';
    if (Math.abs(d) > 150) { type = 'uturn'; text = 'Make a U-turn'; }
    else if (d > 45 && d <= 135) { type = 'right'; text = 'Turn right'; }
    else if (d >= 15 && d <= 45) { type = 'slight-right'; text = 'Slight right'; }
    else if (d < -45 && d >= -135) { type = 'left'; text = 'Turn left'; }
    else if (d <= -15 && d >= -45) { type = 'slight-left'; text = 'Slight left'; }

    out.push({ type, primary: `${text} to ${nameFor(route[i+1])}`, secondary: `Step ${i+1} of ${route.length - 1}` });
  }
  return out;
}
function getCueForStep(stepIdx) {
  if (!currentRoute.length) return null;
  const idx = Math.max(0, Math.min(currentRoute.length - 1, stepIdx));
  if (!maneuvers || maneuvers.length !== currentRoute.length) maneuvers = computeManeuvers(currentRoute);
  return maneuvers[idx] || null;
}

/* -------------------- Routing / Step Rendering -------------------- */
function stepRoute(delta) {
  if (!currentRoute.length) return;
  currentStep = Math.max(0, Math.min(currentRoute.length - 1, currentStep + delta));
  renderStep();
  drawMinimap();
  drawSvgOverlay();
}
function renderStep() {
  const stepInfo = document.getElementById('stepInfo');
  if (!currentRoute.length) {
    if (stepInfo) stepInfo.textContent = '';
    setSkyTexture(null);
    return;
  }
  const nodeId = currentRoute[currentStep];
  if (stepInfo) stepInfo.textContent = `Step ${currentStep + 1} / ${currentRoute.length}: ${nodeId}`;
  setSkyTexture(mediaMap?.[nodeId] || null);
}
function setSkyTexture(imgUrl) {
  const sky = document.getElementById('sky');
  if (!sky) return;
  if (!imgUrl) { sky.removeAttribute('src'); return; }

  const candidates = [imgUrl];
  if (!/^https?:\/\//i.test(imgUrl) && !imgUrl.startsWith('./') && !imgUrl.startsWith('/')) {
    if (!imgUrl.startsWith('media/')) candidates.push('media/' + imgUrl);
    candidates.push('./' + imgUrl);
  }
  (function tryNext(i = 0) {
    if (i >= candidates.length) { sky.removeAttribute('src'); return; }
    const u = candidates[i];
    const test = new Image();
    test.onload = () => sky.setAttribute('src', u);
    test.onerror = () => tryNext(i + 1);
    test.src = u;
  })();
}

/* -------------------- Side nav (◀ / ▶) -------------------- */
function createSideNavButtons() {
  const viewer = document.querySelector('.viewer') || document.getElementById('viewer') || document.body;
  const left = document.createElement('button');
  const right = document.createElement('button');

  left.textContent = '◀';
  right.textContent = '▶';
  Object.assign(left.style, {
    position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)',
    width: '42px', height: '42px', borderRadius: '50%', border: '1px solid #ccc',
    background: '#fff', boxShadow: '0 4px 12px rgba(0,0,0,0.18)', cursor: 'pointer',
    zIndex: 30, display: 'flex', alignItems: 'center', justifyContent: 'center'
  });
  Object.assign(right.style, {
    position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
    width: '42px', height: '42px', borderRadius: '50%', border: '1px solid #ccc',
    background: '#fff', boxShadow: '0 4px 12px rgba(0,0,0,0.18)', cursor: 'pointer',
    zIndex: 30, display: 'flex', alignItems: 'center', justifyContent: 'center'
  });

  viewer.querySelectorAll('.__sideNavBtn').forEach(el => el.remove());
  left.className = '__sideNavBtn'; right.className = '__sideNavBtn';
  viewer.appendChild(left); viewer.appendChild(right);

  left.addEventListener('click', () => { stepRoute(-1); refreshSideNavButtons(); });
  right.addEventListener('click', () => { stepRoute(1);  refreshSideNavButtons(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { stepRoute(-1); refreshSideNavButtons(); }
    if (e.key === 'ArrowRight'){ stepRoute(1);  refreshSideNavButtons(); }
  });

  __leftBtn = left; __rightBtn = right;
  refreshSideNavButtons();
}
function refreshSideNavButtons() {
  if (!__leftBtn || !__rightBtn) return;
  const has = currentRoute.length > 0;
  __leftBtn.disabled = !has; __rightBtn.disabled = !has;
  __leftBtn.style.opacity = has ? '1' : '0.6';
  __rightBtn.style.opacity = has ? '1' : '0.6';
  __leftBtn.style.cursor = has ? 'pointer' : 'not-allowed';
  __rightBtn.style.cursor = has ? 'pointer' : 'not-allowed';
}

/* -------------------- Mini-map (canvas) -------------------- */
function drawMinimap() {
  const c = document.getElementById('pipCanvas') || document.getElementById('mapCanvas');
  if (!c || !graph) return;

  // Retina crispness
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const cssW = c.clientWidth || 260, cssH = c.clientHeight || 150;
  if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW, H = cssH;

  ctx.clearRect(0, 0, W, H);

  const xs = (graph.nodes || []).map(n => (n?.x_m ?? n?.x ?? 0));
  const ys = (graph.nodes || []).map(n => (n?.y_m ?? n?.y ?? 0));
  if (!xs.length || !ys.length) return; // nothing to draw yet

  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 12;
  const sx = (W - pad*2) / Math.max(1e-6, (maxX - minX));
  const sy = (H - pad*2) / Math.max(1e-6, (maxY - minY));
  const s = Math.min(sx, sy);

  const toCanvas = (n) => {
    if (!n) return null;
    const x = n.x_m ?? n.x ?? 0, y = n.y_m ?? n.y ?? 0;
    return [ pad + (x - minX) * s, pad + (y - minY) * s ];
  };

  // BG
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#e5e5e5'; ctx.strokeRect(0.5, 0.5, W-1, H-1);

  // Edges (skip any edge with missing nodes)
  ctx.strokeStyle = '#9aa0a6'; ctx.lineWidth = 1;
  (graph.edges || []).forEach(e => {
    const na = nodesById.get(e.from);
    const nb = nodesById.get(e.to);
    if (!na || !nb) {
      console.warn('Edge with missing node id(s):', e);
      return;
    }
    const a = toCanvas(na), b = toCanvas(nb);
    if (!a || !b) return;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
  });

  // Route (halo + core) — skip any missing node ids
  if (currentRoute.length >= 2) {
    const pts = currentRoute
      .map(id => toCanvas(nodesById.get(id)))
      .filter(Boolean);
    if (pts.length >= 2) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(26,115,232,0.25)'; ctx.lineWidth = 10;
      ctx.beginPath();
      pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
      ctx.stroke();

      ctx.strokeStyle = '#1a73e8'; ctx.lineWidth = 4;
      ctx.beginPath();
      pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
      ctx.stroke();
    }
  }

  // Route nodes (skip missing)
  ctx.fillStyle = '#3a7';
  currentRoute.forEach(id => {
    const p = toCanvas(nodesById.get(id));
    if (!p) return;
    ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, Math.PI*2); ctx.fill();
  });

  // Route-based arrow at current step (skip missing)
  const { cur, tgt } = currentAndTarget();
  if (cur) {
    const pc = toCanvas(cur);
    if (pc) {
      ctx.beginPath(); ctx.arc(pc[0], pc[1], 5.5, 0, Math.PI*2);
      ctx.fillStyle = '#1a73e8'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();

      if (tgt) {
        const pt = toCanvas(tgt);
        if (pt) {
          const ang = Math.atan2(pt[1]-pc[1], pt[0]-pc[0]);
          ctx.save();
          ctx.translate(pc[0], pc[1]);
          ctx.rotate(ang);
          ctx.beginPath();
          ctx.moveTo(8, 0); ctx.lineTo(0, 3.5); ctx.lineTo(0, -3.5); ctx.closePath();
          ctx.fillStyle = '#1a73e8'; ctx.fill();
          ctx.restore();
        }
      }
    }
  }

  // --- Live user dot ---
  if (_xr !== null && _yr !== null) {
    const pc = [ pad + (_xr - minX) * s, pad + (_yr - minY) * s ];
    ctx.beginPath(); ctx.arc(pc[0], pc[1], 7.5, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(26,115,232,0.15)'; ctx.fill();
    ctx.beginPath(); ctx.arc(pc[0], pc[1], 4.5, 0, Math.PI*2);
    ctx.fillStyle = '#1a73e8'; ctx.fill();
    const ang = (_tr || 0) * Math.PI/180;
    ctx.save(); ctx.translate(pc[0], pc[1]); ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(10, 0); ctx.lineTo(0, 4); ctx.lineTo(0, -4); ctx.closePath();
    ctx.fillStyle = '#1a73e8'; ctx.fill();
    ctx.restore();
  }
}


/* -------------------- Floor SVG Overlay -------------------- */
function drawSvgOverlay() {
  const svg = document.getElementById('floorSvg');
  if (!svg || !floor) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const { minX: fMinX, minY: fMinY, width: fW, height: fH } = floor.viewBox;
  svg.setAttribute('viewBox', `${fMinX} ${fMinY} ${fW} ${fH}`);

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'image');
  bg.setAttribute('x', String(fMinX));
  bg.setAttribute('y', String(fMinY));
  bg.setAttribute('width', String(fW));
  bg.setAttribute('height', String(fH));
  bg.setAttribute('preserveAspectRatio', 'none');
  bg.setAttributeNS('http://www.w3.org/1999/xlink', 'href', floorDataUri);
  bg.setAttribute('style', 'pointer-events:none;image-rendering:crisp-edges;');
  svg.appendChild(bg);

  const toFloor = (n) => {
    if (!n) return null;           // <- guard
    const gx = n.x_m ?? n.x ?? 0;
    const gy = n.y_m ?? n.y ?? 0;
    return { fx: fMinX + gx, fy: fMinY + gy };
  };


  const base = Math.max(fW, fH);

  // Edges
  const gEdges = document.createElementNS(svg.namespaceURI, 'g');
  gEdges.setAttribute('stroke', '#9aa0a6');
  gEdges.setAttribute('stroke-width', String(0.006 * base));
  gEdges.setAttribute('fill', 'none');
  gEdges.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(gEdges);

  (graph.edges || []).forEach(e => {
    const a = nodesById.get(e.from), b = nodesById.get(e.to);
    if (!a || !b) return;
    const A = toFloor(a), B = toFloor(b);
    const line = document.createElementNS(svg.namespaceURI, 'line');
    line.setAttribute('x1', A.fx); line.setAttribute('y1', A.fy);
    line.setAttribute('x2', B.fx); line.setAttribute('y2', B.fy);
    gEdges.appendChild(line);
  });

  // Route (halo + core)
  // Route (halo + core) — robust against missing node IDs
if (currentRoute.length >= 2) {
  // keep only nodes that exist
  const pts = currentRoute
    .map(id => toFloor(nodesById.get(id)))
    .filter(Boolean);

  if (pts.length >= 2) {
    const d = pts.map((P, i) => (i ? `L ${P.fx} ${P.fy}` : `M ${P.fx} ${P.fy}`)).join(' ');

    const halo = document.createElementNS(svg.namespaceURI, 'path');
    halo.setAttribute('d', d);
    halo.setAttribute('fill', 'none');
    halo.setAttribute('stroke', 'rgba(26,115,232,0.25)');
    halo.setAttribute('stroke-width', String(0.035 * base));
    halo.setAttribute('stroke-linecap', 'round');
    halo.setAttribute('stroke-linejoin', 'round');
    halo.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(halo);

    const core = document.createElementNS(svg.namespaceURI, 'path');
    core.setAttribute('d', d);
    core.setAttribute('fill', 'none');
    core.setAttribute('stroke', '#1a73e8');
    core.setAttribute('stroke-width', String(0.018 * base));
    core.setAttribute('stroke-linecap', 'round');
    core.setAttribute('stroke-linejoin', 'round');
    core.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(core);
  } else {
    console.warn('Route has < 2 valid points; skipping SVG path.');
  }
}


  // Route nodes
  const gRoute = document.createElementNS(svg.namespaceURI, 'g');
  gRoute.setAttribute('fill', '#3a7');
  svg.appendChild(gRoute);
  currentRoute.forEach(id => {
    const n = nodesById.get(id); if (!n) return;
    const P = toFloor(n);
    const c = document.createElementNS(svg.namespaceURI, 'circle');
    c.setAttribute('cx', P.fx); c.setAttribute('cy', P.fy);
    c.setAttribute('r', String(0.012 * base));
    gRoute.appendChild(c);
  });

  // Route-based arrow at current step
  if (currentRoute.length) {
    const { cur, tgt } = currentAndTarget();
    if (cur) {
      const P = toFloor(cur);
      const g = document.createElementNS(svg.namespaceURI, 'g');
      g.setAttribute('transform', `translate(${P.fx} ${P.fy})`);
      svg.appendChild(g);

      const r = 0.018 * base;
      const ring = document.createElementNS(svg.namespaceURI, 'circle');
      ring.setAttribute('r', String(r));
      ring.setAttribute('fill', '#1a73e8');
      ring.setAttribute('stroke', '#fff');
      ring.setAttribute('stroke-width', String(0.008 * base));
      ring.setAttribute('vector-effect', 'non-scaling-stroke');
      g.appendChild(ring);

      if (tgt) {
        const T = toFloor(tgt);
        const angRad = Math.atan2(T.fy - P.fy, T.fx - P.fx);
        const angDeg = angRad * 180 / Math.PI;
        const tri = document.createElementNS(svg.namespaceURI, 'path');
        const L = 0.05 * base, W = 0.024 * base;
        tri.setAttribute('d', `M ${L} 0 L 0 ${W/2} L 0 ${-W/2} Z`);
        tri.setAttribute('fill', '#1a73e8');
        tri.setAttribute('opacity', '0.95');
        tri.setAttribute('transform', `rotate(${angDeg})`);
        tri.setAttribute('vector-effect', 'non-scaling-stroke');
        g.appendChild(tri);
      }
    }
  }

  // --- Live user dot on floor ---
  if (_xr !== null && _yr !== null) {
    const gLive = document.createElementNS(svg.namespaceURI, 'g');
    gLive.setAttribute('transform', `translate(${floor.viewBox.minX + _xr} ${floor.viewBox.minY + _yr})`);
    svg.appendChild(gLive);

    const base2 = Math.max(floor.viewBox.width, floor.viewBox.height);
    const ring = document.createElementNS(svg.namespaceURI,'circle');
    ring.setAttribute('r', String(0.018*base2));
    ring.setAttribute('fill','#1a73e8');
    ring.setAttribute('stroke','#fff');
    ring.setAttribute('stroke-width', String(0.008*base2));
    ring.setAttribute('vector-effect','non-scaling-stroke');
    gLive.appendChild(ring);

    const tri = document.createElementNS(svg.namespaceURI,'path');
    tri.setAttribute('d', `M ${0.05*base2} 0 L 0 ${0.012*base2} L 0 ${-0.012*base2} Z`);
    tri.setAttribute('fill','#1a73e8'); tri.setAttribute('opacity','0.95');
    tri.setAttribute('transform', `rotate(${_tr||0})`);
    tri.setAttribute('vector-effect','non-scaling-stroke');
    gLive.appendChild(tri);
  }
}

/* -------------------- Long-press to anchor (custom event) -------------------- */
(function enableLongPressAnchor(){
  const svg = document.getElementById('floorSvg');
  if (!svg) return;
  let t = null;
  svg.addEventListener('touchstart', (e) => {
    if (t) clearTimeout(t);
    const touch = e.touches?.[0]; if (!touch) return;
    const rect = svg.getBoundingClientRect();
    const x = floor.viewBox.minX + (touch.clientX - rect.left) * (floor.viewBox.width / rect.width);
    const y = floor.viewBox.minY + (touch.clientY - rect.top)  * (floor.viewBox.height / rect.height);
    t = setTimeout(() => {
      // Find nearest node (within ~2 m)
      let best = null, bestD = 1e9;
      (graph.nodes || []).forEach(n => {
        const dx = (n.x_m ?? n.x ?? 0) - x;
        const dy = (n.y_m ?? n.y ?? 0) - y;
        const d = Math.hypot(dx, dy);
        if (d < bestD) { bestD = d; best = n; }
      });

      const ANCHOR_RADIUS_UNITS = 2.0 * MAP_UNITS_PER_METER; // 2 m in map units
      if (best && bestD <= ANCHOR_RADIUS_UNITS) {
        const ev = new CustomEvent('longpress-anchor', { detail: { x_m: best.x_m ?? best.x, y_m: best.y_m ?? best.y, nodeId: best.id } });
        svg.dispatchEvent(ev);
      }
    }, 600); // 600ms long-press
  }, { passive: true });
  svg.addEventListener('touchend', () => { if (t) clearTimeout(t); }, { passive: true });
})();

/* -------------------- Shared helpers -------------------- */
function currentAndTarget() {
  if (!currentRoute.length) return { cur: null, tgt: null };
  const cur = nodesById.get(currentRoute[currentStep]);
  let tgt = null;
  if (currentStep < currentRoute.length - 1) {
    tgt = nodesById.get(currentRoute[currentStep + 1]);
  } else if (currentStep > 0) {
    tgt = nodesById.get(currentRoute[currentStep - 1]);
  }
  return { cur, tgt };
}

/* -------------------- Turn icon SVGs -------------------- */
function svgForTurn(type) {
  const base = `
  <svg viewBox="0 0 64 64" role="img" aria-label="${type}">
    <rect x="2" y="2" width="60" height="60" rx="14" ry="14" fill="#eef4ff" stroke="#d7e3ff"/>
    <g fill="#1a73e8">
      __PATH__
    </g>
  </svg>`;
  const P = {
    'depart':       '<path d="M30 52V18h-8l10-10 10 10h-8v34z"/>',
    'arrive':       '<circle cx="32" cy="32" r="9"/>',
    'straight':     '<path d="M30 52V20h-8l10-10 10 10h-8v32z"/>',
    'slight-left':  '<path d="M34 52V32l-8 3 4-16 12 12-6 2v19z"/>',
    'left':         '<path d="M44 50V36H24l6 6-6 6-14-14 14-14 6 6-6 6h20V14l14 14-14 14z"/>',
    'slight-right': '<path d="M30 52V32l8 3-4-16-12 12 6 2v19z"/>',
    'right':        '<path d="M20 50V36h20l-6 6 6 6 14-14-14-14-6 6 6 6H20V14L6 28l14 14z"/>',
    'uturn':        '<path d="M24 52V28c0-4.5 3.7-8.2 8.2-8.2S40.5 23.5 40.5 28v9.5h-8l9.5 9.5 9.5-9.5h-8V28c0-9-7.3-16.2-16.2-16.2S16.8 19 16.8 28v24h7.2z"/>'
  };
  return base.replace('__PATH__', P[type] || P['straight']);
}

/* -------------------- Voice (clips preferred) -------------------- */
function speakCue(cue) {
  if (!cue || !voiceEnabled) return;
  const fileMap = {
    'depart': 'start', 'arrive': 'arrive', 'straight': 'straight',
    'slight-left': 'slight-left', 'left': 'left',
    'slight-right': 'slight-right', 'right': 'right', 'uturn': 'uturn'
  };
  const fname = fileMap[cue.type] || 'straight';
  if (preferClips) {
    const url = `audio/${voiceLang}/${fname}.mp3`;
    tryPlay(url, () => { if (allowBrowserTTS) ttsSpeak(cue.primary); });
  } else if (allowBrowserTTS) {
    ttsSpeak(cue.primary);
  }
}
function tryPlay(url, onError) {
  try {
    const a = new Audio(url);
    a.oncanplay = () => a.play().catch(()=>onError && onError());
    a.onerror = () => onError && onError();
    a.load();
  } catch { onError && onError(); }
}
function ttsSpeak(text) {
  try {
    if (!text) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(u);
  } catch {}
}

/* -------------------- Draggable panel helpers -------------------- */
function makeDraggable(panelEl, containerEl, storageKey = 'panelPos') {
  if (!panelEl || !containerEl) return;
  panelEl.style.touchAction = 'none';

  let dragging = false;
  let startX = 0, startY = 0;
  let startLeft = 0, startTop = 0;

  const onPointerDown = (e) => {
    dragging = true;
    panelEl.style.bottom = '';
    panelEl.style.right = '';

    const rect = panelEl.getBoundingClientRect();
    startLeft = rect.left - containerEl.getBoundingClientRect().left;
    startTop  = rect.top  - containerEl.getBoundingClientRect().top;

    const pt = pointerXY(e);
    startX = pt.x; startY = pt.y;

    panelEl.setPointerCapture?.(e.pointerId ?? 1);
    e.preventDefault();
  };

  const onPointerMove = (e) => {
    if (!dragging) return;
    const pt = pointerXY(e);
    let dx = pt.x - startX;
    let dy = pt.y - startY;

    const cont = containerEl.getBoundingClientRect();
    const el   = panelEl.getBoundingClientRect();

    let L = clamp(startLeft + dx, 0, cont.width  - el.width);
    let T = clamp(startTop  + dy,  0, cont.height - el.height);

    panelEl.style.left = `${L}px`;
    panelEl.style.top  = `${T}px`;
  };

  const onPointerUp = (e) => {
    if (!dragging) return;
    dragging = false;
    const cont = containerEl.getBoundingClientRect();
    const el   = panelEl.getBoundingClientRect();
    const pos = { left: el.left - cont.left, top: el.top - cont.top };
    try { localStorage.setItem(storageKey, JSON.stringify(pos)); } catch {}
    panelEl.releasePointerCapture?.(e.pointerId ?? 1);
  };

  panelEl.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  panelEl.addEventListener('dblclick', () => {
    resetPanelPosition(panelEl);
    try { localStorage.removeItem(storageKey); } catch {}
  });
}
function restorePanelPosition(panelEl, storageKey = 'panelPos') {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return;
    const pos = JSON.parse(raw);
    panelEl.style.left = `${pos.left}px`;
    panelEl.style.top  = `${pos.top}px`;
    panelEl.style.bottom = '';
    panelEl.style.right  = '';
  } catch {}
}
function resetPanelPosition(panelEl) {
  panelEl.style.left = '';
  panelEl.style.top = '';
  panelEl.style.bottom = '12px';
  panelEl.style.right = '';
}
function pointerXY(e) {
  if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  return { x: e.clientX, y: e.clientY };
}

/* -------------------- Live positioning: Provider + UI -------------------- */
function setupLivePositioningUI() {
  const enableBtn = document.getElementById('enableSensors');
  const disableBtn = document.getElementById('disableSensors');
  const dismissBtn = document.getElementById('dismissSensors');
  const statusEl = document.getElementById('sensorStatus');

  // Build a fallback walkable BBOX from your graph nodes (replace with corridor polygons when ready)
  const xs = (graph.nodes || []).map(n => n.x_m ?? n.x ?? 0);
  const ys = (graph.nodes || []).map(n => n.y_m ?? n.y ?? 0);
  const bbox = {
    minX: Math.min(...xs) - 1.0,
    minY: Math.min(...ys) - 1.0,
    maxX: Math.max(...xs) + 1.0,
    maxY: Math.max(...ys) + 1.0
  };
  //const mapMatcher = new MapMatcher({ polygons: [], fallbackBBox: bbox });
  // const mapMatcher = new MapMatcher({ polygons: walkable.polygons || [] });
  const mapMatcher = new MapMatcher({
    polygons: (walkable && Array.isArray(walkable.polygons)) ? walkable.polygons : [],
    fallbackBBox: bbox
  });


  // Initial pose: start at first route node if present
  let initXY = { x: xs[0] ?? 0, y: ys[0] ?? 0 }, initHeadingDeg = 0;
  if (currentRoute.length >= 2) {
    const a = nodesById.get(currentRoute[0]);
    const b = nodesById.get(currentRoute[1]);
    initXY = { x: a.x_m ?? a.x ?? 0, y: a.y_m ?? a.y ?? 0 };
    initHeadingDeg = bearingDeg(a, b);
  }

  __provider = new IndoorLocationProvider({
    particleCount: 900,
    initXY, initHeadingDeg,
    //mapMatcher
    mapMatcher,
    unitsPerMeter: MAP_UNITS_PER_METER
  });

  __provider.onStatus((s) => {
    if (s.type === 'permission') {
      statusEl.textContent = `Status: permission ${s.detail}`;
    } else if (s.type === 'started') {
      statusEl.textContent = 'Status: enabled';
    } else if (s.type === 'stopped') {
      statusEl.textContent = 'Status: disabled';
    }
  });

  // Provider → render pose (your easing loop consumes userPose)
  __provider.onPosition(({ x, y, heading, confidence }) => {
    userPose = { x, y, heading, conf: confidence };
  });

  // Smooth motion + continuous repaint (same as before)
  (function easeLoop(){
    const k = 0.3;
    if (userPose.x !== null && userPose.y !== null) {
      if (_xr === null) { _xr = userPose.x; _yr = userPose.y; _tr = userPose.heading || 0; }
      _xr += k * (userPose.x - _xr);
      _yr += k * (userPose.y - _yr);
      const d = ((userPose.heading - _tr + 540) % 360) - 180;
      _tr += k * d;
    }
    drawSvgOverlay();
    drawMinimap();
    requestAnimationFrame(easeLoop);
  })();

  // Enable/Disable buttons
  enableBtn?.addEventListener('click', async () => {
    // Anchor to "From" node if valid, else route start
    try {
      const fromInput = document.getElementById('fromInput');
      const startId = normalizeAlias(fromInput?.value?.trim());

      if ((!startId || !nodesById.has(startId)) && currentRoute.length) {
        const n0 = nodesById.get(currentRoute[0]);
        __provider.anchor({ x: n0.x_m ?? n0.x, y: n0.y_m ?? n0.y, headingDeg: initHeadingDeg });
        statusEl.textContent = `Status: anchored at ${currentRoute[0]}`;
      }

      if (startId && nodesById.has(startId)) {
        const n = nodesById.get(startId); if (!n) return;
        let headingDeg = 0;
        if (currentRoute.length >= 2) {
          const a = nodesById.get(currentRoute[0]);
          const b = nodesById.get(currentRoute[1]);
          if (!a || !b) return;   // skip bad edge
          headingDeg = bearingDeg(a, b);
        }
        __provider.anchor({ x: n.x_m ?? n.x, y: n.y_m ?? n.y, headingDeg });
        statusEl.textContent = `Status: anchored at ${startId}`;
      }
    } catch {}
    __provider.start();
  });

  disableBtn?.addEventListener('click', () => {
    __provider.stop();
  });

  dismissBtn?.addEventListener('click', () => {
    document.getElementById('permSheet')?.classList.add('hidden');
  });

  // Bridge long-press anchor
  const svg = document.getElementById('floorSvg');
  svg?.addEventListener('longpress-anchor', (ev) => {
    const { x_m, y_m, nodeId } = ev.detail || {};
    if (x_m != null && y_m != null) {
      __provider.anchor({ x: x_m, y: y_m });
      const statusEl = document.getElementById('sensorStatus');
      if (statusEl && nodeId) statusEl.textContent = `Status: anchored at ${nodeId}`;
      drawSvgOverlay(); drawMinimap();
    }
  });
}

