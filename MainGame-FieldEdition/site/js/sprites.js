/* ============================================================
   Dengue Defense — Field Edition · Vector Sprites
   Zero-emoji inline SVG icon registry + Canvas 2D map/entity renderers.

   EXPORTS
   -------
   iconSvg(id, className)            -> string (inline <svg> markup; falls back to a reticle glyph)
   SVG_ICONS                         -> { [vecId: string]: innerSvgString } (34 registered icons)

   Canvas 2D renderers (map-space unless noted; caller applies the
   corridor transform, see map-renderer.js):
   drawMapBackground(ctx, view)      -> void   screen-space slate base + UTM grid + A1–D4 sector ticks
   drawMerapiContour(ctx, opts)      -> void   concentric topo rings + Gunungkidul karst hatches
   drawRiverCurves(ctx, rivers, t)   -> void   dual-stroke luminous cyan rivers + flow-dash ticks
   drawDistrictPolygon(ctx, district, opts) -> void  choropleth fill + optional lock border + brackets
   drawQuarantineEdge(ctx, edge, opts)      -> void  hazard chevron dashes along a shared border
   drawUnitMarker(ctx, x, y, kind, opts)    -> void  psn | traps | fog | clinic geometric tokens
   drawHotspotNode(ctx, x, y, opts)         -> void  pulsing surveillance ping blip
   drawStandingPool(ctx, x, y, opts)        -> void  dual-ring irregular pool + ripple + drain arc
   drawMosquitoSprite(ctx, x, y, opts)      -> void  4 archetypes (standard|flanker|queen|viremic)
   drawSlashTrail(ctx, points, opts)        -> void  tapering cyan-white plasma arc
   drawSprayBurst(ctx, x, y, progress, opts)-> void  expanding shockwave ring + mist
   drawEffectsLayer(ctx, particles, now)    -> void  renders floatText / spark / ring / splat particles
   createFloatText(x, y, text, opts)        -> particle object
   createSparkBurst(x, y, opts)             -> particle[] (sparks + one ring)
   createSplat(x, y, opts)                  -> particle object

   ARGUMENT TYPES
   --------------
   ctx        : CanvasRenderingContext2D
   view       : { w:number, h:number, dpr:number, scale:number, ox:number, oy:number, time?:number }
                (scale maps map units -> CSS px; map space is the 700x500 virtual corridor,
                 MX0=85, MY0=30, MW=500, MH=425 — see map-renderer.js CORRIDOR)
   rivers     : Array<Path2D | Array<[number, number]>>  (map coordinates)
   district   : { path?: Path2D, d?: string, bb?: [x0,y0,x1,y1], risk?: 0|1|2|3,
                  fill?: [r,g,b], alpha?: number, selected?: boolean }
   edge       : Path2D | { a:[x,y], b:[x,y] }              (map coordinates)
   points     : Array<{ x:number, y:number, t:number }>    (map or screen space, caller's transform)
   particles  : Array<particle>                            (from createFloatText / createSparkBurst / ...)
   opts       : per-function option bags, documented on each function
   ============================================================ */

const SVG_OPEN = (id, className) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"${className ? ` class="${className}"` : ''} aria-hidden="true" data-icon="${id}">`;

/* ---------------------------------------------------------------
   SVG_ICONS — inner markup for the 34 vec-* IDs (24x24, stroke).
   --------------------------------------------------------------- */
export const SVG_ICONS = {
  // vec-mosquito — body, swept wings, proboscis, legs
  'vec-mosquito': '<ellipse cx="12" cy="13.5" rx="2.4" ry="4.2"/><path d="M12 9.3V6.5"/><path d="M12 6.5 9.5 3.5M12 6.5l2.5-3"/><path d="M9.6 11 5 7.5M14.4 11 19 7.5"/><path d="M9.4 14.5 4.5 13M14.6 14.5 19.5 13"/><path d="M10.4 17.3 8 21M13.6 17.3 16 21"/>',
  // vec-broom-psn — angled brush with bristle slash + droplet
  'vec-broom-psn': '<path d="M4 20l6.5-6.5"/><path d="M12.5 8.5 15 6l3.5 3.5-2.5 2.5z"/><path d="M15 6l2-2 3 3-2 2"/><path d="M10 13l1.5-4L15 13l-4 1.5z"/><path d="M6.5 17.5l2 2"/>',
  // vec-ovitrap — hexagonal trap canister with attractant ring
  'vec-ovitrap': '<path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9L12 3z"/><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="0.4" fill="currentColor"/><path d="M12 8.8V6.5M12 17.5v-2.3"/>',
  // vec-fogger — pressurized nozzle + dispersal cone
  'vec-fogger': '<rect x="3" y="11" width="9" height="5" rx="1"/><path d="M12 13h3l2-2"/><path d="M17 11l4-3M17.5 13.5 22 13M17 16l4 3"/><path d="M6 11V8.5h3V11"/>',
  // vec-clinic-cross — triage ward emblem
  'vec-clinic-cross': '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M12 9v6M9 12h6"/>',
  // vec-volcano-peak — contour peak + ash plume arc
  'vec-volcano-peak': '<path d="M3 19 9.5 8h5L21 19"/><path d="M9.5 8c1-1.6 4-1.6 5 0"/><path d="M10.5 4.5h3M12 2.5h.01"/><path d="M7 19h10"/>',
  // vec-command-chevron — three-star / diamond command emblem
  'vec-command-chevron': '<path d="M5 15l7-6 7 6"/><path d="M5 10l7-6 7 6"/><path d="M12 19l2.2-1.6L12 15.8l-2.2 1.6L12 19z" fill="currentColor" stroke="none"/>',
  // vec-epi-helix — clinical sine-node network (double helix)
  'vec-epi-helix': '<path d="M8 3c0 6 8 6 8 12M16 3c0 6-8 6-8 12"/><path d="M9.5 6.5h5M9.5 11h5M9.5 15.5h5"/><circle cx="12" cy="3" r="0.6" fill="currentColor"/><circle cx="12" cy="21" r="0.6" fill="currentColor"/>',
  // vec-blood-drop — high-contrast clinical droplet
  'vec-blood-drop': '<path d="M12 3s6.5 7.4 6.5 12a6.5 6.5 0 0 1-13 0C5.5 10.4 12 3 12 3z"/><path d="M9.5 14.5a2.6 2.6 0 0 0 2 2.6"/>',
  // vec-trophy-shield — tactical laurel crest
  'vec-trophy-shield': '<path d="M12 3l7 2.5v6c0 5-3.5 8-7 9.5-3.5-1.5-7-4.5-7-9.5v-6L12 3z"/><path d="M9.5 10.5l2 2 3.5-4"/>',
  // vec-globe-grid — latitude/longitude globe
  'vec-globe-grid': '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M4.5 7.5h15M4.5 16.5h15"/>',
  // vec-audio-on — speaker + waves
  'vec-audio-on': '<path d="M4 10v4h3l5 4V6l-5 4H4z"/><path d="M16 9.5a4 4 0 0 1 0 5M18.5 7a7.5 7.5 0 0 1 0 10"/>',
  // vec-audio-off — speaker + slash
  'vec-audio-off': '<path d="M4 10v4h3l5 4V6l-5 4H4z"/><path d="M17 9.5l5 5M22 9.5l-5 5"/>',
  // vec-monsoon-cloud — storm cell + slanting rain
  'vec-monsoon-cloud': '<path d="M7 15a4.5 4.5 0 0 1 .4-9A6 6 0 0 1 18.6 9 4 4 0 0 1 18 17H8"/><path d="M9 19.5 8 22M13 19.5l-1 2.5M17 19.5l-1 2.5"/>',
  // vec-clipboard-dossier — tactical briefing pad
  'vec-clipboard-dossier': '<rect x="5" y="4.5" width="14" height="17" rx="1.5"/><path d="M9.5 4.5V2.8h5v1.7"/><path d="M9 10h6M9 13.5h6M9 17h4"/>',
  // vec-rail-transit — locomotive front + track
  'vec-rail-transit': '<rect x="6" y="3" width="12" height="13" rx="2"/><path d="M6 11h12"/><circle cx="9.5" cy="19" r="1.3"/><circle cx="14.5" cy="19" r="1.3"/><path d="M4 22h16M8 16l-2 3M16 16l2 3"/>',
  // vec-trend-down — segmented sparkline arrow
  'vec-trend-down': '<path d="M3 6l6 6 4-4 8 8"/><path d="M21 11v5h-5"/>',
  // vec-larvae-sprout — aquatic larva / stagnation ring
  'vec-larvae-sprout': '<circle cx="12" cy="12" r="9"/><path d="M8 13.5c2-1.5 6-1.5 8 0"/><circle cx="9.5" cy="10" r="0.5" fill="currentColor"/><circle cx="12" cy="9" r="0.5" fill="currentColor"/><circle cx="14.5" cy="10" r="0.5" fill="currentColor"/>',
  // vec-blitz-bolt — sharp angled voltage bolt
  'vec-blitz-bolt': '<path d="M13 2 5 13.5h5L9.5 22 18 10.5h-5L13 2z"/>',
  // vec-pool-droplet — rippling pond contour
  'vec-pool-droplet': '<path d="M12 4s5 5.7 5 9.3a5 5 0 0 1-10 0C7 9.7 12 4 12 4z"/><path d="M9.2 13.5a2.8 2.8 0 0 0 2.2 2.7"/>',
  // vec-defense-shield — chamfered tactical shield
  'vec-defense-shield': '<path d="M12 2.5 20 6v6.2c0 5.2-3.4 8.9-8 10.3-4.6-1.4-8-5.1-8-10.3V6l8-3.5z"/><path d="M12 7v10"/>',
  // vec-thermal-flame — geometric flare
  'vec-thermal-flame': '<path d="M12 2.8s5.5 5.2 5.5 10a5.5 5.5 0 0 1-11 0c0-2 1-3.8 1-3.8s.8 1.5 2 1.5c0-2.7 1.2-6 2.5-7.7z"/>',
  // vec-spark-star — 4-point precision reticle star
  'vec-spark-star': '<path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2z"/>',
  // vec-fund-coin — hexagonal ledger token
  'vec-fund-coin': '<path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9L12 3z"/><path d="M12 8v8M9.3 10.2c0-1 1.1-1.7 2.7-1.7s2.7.7 2.7 1.9-1 1.6-2.7 1.9-2.7.8-2.7 2 1.2 1.9 2.7 1.9 2.7-.8 2.7-1.9"/>',
  // vec-kader-unit — helmeted field responder silhouette
  'vec-kader-unit': '<circle cx="12" cy="7" r="3.4"/><path d="M8.6 6.2a3.4 3.4 0 0 1 6.8 0"/><path d="M5 21c.6-4.4 3.4-6.6 7-6.6s6.4 2.2 7 6.6"/>',
  // vec-swat-arc — motion-blur blade arc
  'vec-swat-arc': '<path d="M3 15a10 10 0 0 1 18-6"/><path d="M7 16.5a6.5 6.5 0 0 1 12-3.8"/><path d="M14.5 6.5 21 6l-1.5 6"/>',
  // vec-lab-flask — graduated surveillance vial
  'vec-lab-flask': '<path d="M10 3h4"/><path d="M11 3v6l-5.2 9A2.4 2.4 0 0 0 8 21h8a2.4 2.4 0 0 0 2.2-3L13 9V3"/><path d="M8.5 15h7"/>',
  // vec-civic-hall — pillared district HQ
  'vec-civic-hall': '<path d="M3 9.5 12 4l9 5.5"/><path d="M5 10v9M9.7 10v9M14.3 10v9M19 10v9"/><path d="M3 21h18M3 19h18"/>',
  // vec-ward-tent — medical annex silhouette
  'vec-ward-tent': '<path d="M3 19 12 5l9 14"/><path d="M12 12.5v4M10 14.5h4"/><path d="M2 19h20"/>',
  // vec-comms-radar — directional signal cone
  'vec-comms-radar': '<circle cx="5" cy="19" r="1.6"/><path d="M5 14a7 7 0 0 1 7 7"/><path d="M5 8.5A12.5 12.5 0 0 1 17.5 21"/><path d="M5 3A18 18 0 0 1 23 21"/>',
  // vec-spray-canister — pressurized canister + AoE ring
  'vec-spray-canister': '<rect x="8" y="8" width="8" height="12" rx="2"/><path d="M10.5 8V5.5h3V8"/><path d="M18.5 5.5h.01M21 8h.01M21 12h.01M18.5 15h.01"/>',
  // vec-radar-dish — concentric ping arcs
  'vec-radar-dish': '<path d="M4 14a9 9 0 0 1 6 8"/><path d="M4 9a14 14 0 0 1 11 13"/><path d="M4 4.5A19 19 0 0 1 16 21.5"/><circle cx="4.8" cy="19.5" r="1.3" fill="currentColor"/>',
  // vec-rank-star — 5-point tactical star
  'vec-rank-star': '<path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.9 6.2 20.4l1.1-6.5L2.6 9.3l6.5-.9L12 2.5z"/>',
  // vec-scroll-manual — classified dossier folder
  'vec-scroll-manual': '<path d="M4 18V6a2 2 0 0 1 2-2h4l2 2.5h6a2 2 0 0 1 2 2V18"/><path d="M4 18a2 2 0 0 0 2 2h13a1.5 1.5 0 0 0 1.5-1.5V16H6a2 2 0 0 0-2 2z"/>',
};

/**
 * iconSvg(id, className) -> inline SVG markup string
 * @param {string} id        one of the 34 vec-* IDs (unknown IDs fall back to vec-spark-star reticle)
 * @param {string} [className]  optional class applied to the root <svg>
 * @returns {string} complete <svg> element markup
 */
export function iconSvg(id, className) {
  const inner = SVG_ICONS[id] || SVG_ICONS['vec-spark-star'];
  const safeClass = typeof className === 'string'
    ? className.replace(/[^a-zA-Z0-9 _-]/g, '').trim()
    : '';
  return `${SVG_OPEN(id, safeClass)}${inner}</svg>`;
}

/* ===============================================================
   Canvas 2D renderers
   Map-space functions assume ctx already carries the corridor
   transform (see map-renderer.js). Line widths divide by scale
   where a hairline is required.
   =============================================================== */

const TAU = Math.PI * 2;
const clamp01 = v => Math.max(0, Math.min(1, v));

/**
 * drawMapBackground(ctx, view) — slate-teal base + UTM-style 40px grid + A1–D4 sector ticks.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{w:number,h:number,dpr?:number,time?:number,grid?:number}} view  screen-space view (CSS px; ctx pre-scaled by dpr)
 * @returns {void}
 */
export function drawMapBackground(ctx, view) {
  const w = view?.w ?? 700, h = view?.h ?? 500;
  const grid = view?.grid ?? 40;

  const g = ctx.createRadialGradient(w / 2, h * 0.44, 24, w / 2, h * 0.44, Math.max(w, h) * 0.85);
  g.addColorStop(0, '#16282F');
  g.addColorStop(0.55, '#101F26');
  g.addColorStop(1, '#0B1519');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.04)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = (w % grid) / 2; x <= w; x += grid) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = (h % grid) / 2; y <= h; y += grid) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();

  // Faint alphanumeric sector ticks along margins: A–D columns, 1–4 rows
  ctx.fillStyle = 'rgba(143, 168, 178, 0.42)';
  ctx.font = '9px "Cascadia Mono", Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cols = ['A', 'B', 'C', 'D'];
  for (let i = 0; i < 4; i++) {
    const cx = ((i + 0.5) / 4) * w;
    ctx.fillText(cols[i], cx, 8);
    ctx.fillText(cols[i], cx, h - 8);
  }
  ctx.textAlign = 'left';
  for (let i = 0; i < 4; i++) {
    const ry = ((i + 0.5) / 4) * h;
    ctx.fillText(String(i + 1), 6, ry);
    ctx.textAlign = 'right';
    ctx.fillText(String(i + 1), w - 6, ry);
    ctx.textAlign = 'left';
  }
  // Margin frame ticks
  ctx.strokeStyle = 'rgba(148, 210, 230, 0.12)';
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  ctx.restore();
}

/**
 * drawMerapiContour(ctx, opts) — multi-ring topographic contours around Mount Merapi
 * (NW corridor) plus elevation hatch marks on the Gunungkidul karst ridge (south).
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ cx?:number, cy?:number, rings?:number, baseRadius?:number, time?:number,
 *           ridge?: { x0:number, y0:number, x1:number, y1:number, teeth?:number } | null }} [opts]
 * @returns {void}
 */
export function drawMerapiContour(ctx, opts = {}) {
  const cx = opts.cx ?? 258, cy = opts.cy ?? 60;
  const rings = opts.rings ?? 5;
  const baseR = opts.baseRadius ?? 14;
  const time = opts.time ?? 0;

  ctx.save();
  for (let i = rings; i >= 1; i--) {
    const r = baseR + i * 11;
    const wobble = 1 + 0.12 * Math.sin(i * 1.7 + time * 0.15);
    ctx.beginPath();
    for (let a = 0; a <= TAU + 0.01; a += TAU / 48) {
      const rr = r * wobble * (1 + 0.18 * Math.sin(3 * a + i * 0.9) + 0.09 * Math.sin(7 * a + i));
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr * 0.78;
      if (a === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.strokeStyle = `rgba(190, 227, 235, ${0.05 + i * 0.028})`;
    ctx.lineWidth = i === 1 ? 1.4 : 1;
    ctx.stroke();
  }
  // Summit tick
  ctx.fillStyle = 'rgba(230, 240, 242, 0.55)';
  ctx.beginPath();
  ctx.moveTo(cx, cy - 5); ctx.lineTo(cx + 4.4, cy + 3.4); ctx.lineTo(cx - 4.4, cy + 3.4);
  ctx.closePath(); ctx.fill();

  // Gunungkidul karst ridge hatches (south)
  const ridge = opts.ridge === undefined ? { x0: 210, y0: 428, x1: 500, y1: 442, teeth: 26 } : opts.ridge;
  if (ridge) {
    const teeth = ridge.teeth ?? 22;
    ctx.strokeStyle = 'rgba(190, 227, 235, 0.16)';
    ctx.lineWidth = 1.1;
    for (let i = 0; i <= teeth; i++) {
      const t = i / teeth;
      const x = ridge.x0 + (ridge.x1 - ridge.x0) * t;
      const y = ridge.y0 + (ridge.y1 - ridge.y0) * t + Math.sin(t * Math.PI * 3) * 3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 5, y - 9);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(ridge.x0 - 6, ridge.y0 + 2);
    ctx.lineTo(ridge.x1 + 6, ridge.y1 + 2);
    ctx.strokeStyle = 'rgba(190, 227, 235, 0.22)';
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * drawRiverCurves(ctx, rivers, time) — dual-stroke luminous cyan rivers + animated flow-dash ticks.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<Path2D | Array<[number, number]>>} rivers  map-coordinate river paths
 * @param {number} [time]  seconds (drives lineDashOffset flow animation)
 * @returns {void}
 */
export function drawRiverCurves(ctx, rivers, time = 0) {
  if (!Array.isArray(rivers)) return;
  const trace = (r) => {
    ctx.beginPath();
    if (typeof Path2D !== 'undefined' && r instanceof Path2D) { ctx.stroke(r); return; }
    const pts = r;
    if (!pts?.length) return;
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0], last[1]);
    ctx.stroke();
  };

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Outer hydro glow
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.28)';
  ctx.lineWidth = 6;
  ctx.shadowColor = 'rgba(56, 189, 248, 0.5)';
  ctx.shadowBlur = 10;
  for (const r of rivers) trace(r);

  // Crisp inner spline
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(148, 226, 255, 0.9)';
  ctx.lineWidth = 1.5;
  for (const r of rivers) trace(r);

  // Animated flow-dash ticks
  ctx.strokeStyle = 'rgba(224, 246, 255, 0.85)';
  ctx.lineWidth = 1.1;
  ctx.setLineDash([2.5, 16]);
  ctx.lineDashOffset = -(time * 26) % 18.5;
  for (const r of rivers) trace(r);
  ctx.setLineDash([]);
  ctx.restore();
}

const RISK_FILLS = [
  [16, 185, 129],   // SAFE emerald
  [245, 158, 11],   // ELEVATED amber
  [239, 68, 68],    // HIGH red
  [217, 70, 239],   // CRITICAL magenta
];
const RISK_ALPHAS = [0.16, 0.22, 0.3, 0.38];

function resolveDistrictPath(district) {
  if (typeof Path2D !== 'undefined' && district?.path instanceof Path2D) return district.path;
  if (typeof district?.d === 'string') return new Path2D(district.d);
  return null;
}

/**
 * drawDistrictPolygon(ctx, district, opts) — choropleth fill by risk tier;
 * selected districts gain an animated dashed amber lock border + corner brackets.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ path?: Path2D, d?: string, bb?: [number,number,number,number],
 *           risk?: 0|1|2|3, fill?: [number,number,number], alpha?: number }} district
 * @param {{ time?: number, selected?: boolean, stroke?: string, lineWidth?: number }} [opts]
 * @returns {void}
 */
export function drawDistrictPolygon(ctx, district, opts = {}) {
  const path = resolveDistrictPath(district);
  if (!path) return;
  const time = opts.time ?? 0;
  const risk = clamp01((district?.risk ?? 0) / 3) * 3 | 0;
  const fill = district?.fill ?? RISK_FILLS[risk] ?? RISK_FILLS[0];
  const alpha = district?.alpha ?? RISK_ALPHAS[risk] ?? 0.16;
  const selected = opts.selected ?? district?.selected ?? false;

  ctx.save();
  ctx.fillStyle = `rgba(${fill[0]}, ${fill[1]}, ${fill[2]}, ${alpha})`;
  ctx.fill(path);
  ctx.strokeStyle = opts.stroke ?? `rgba(${fill[0]}, ${fill[1]}, ${fill[2]}, 0.75)`;
  ctx.lineWidth = opts.lineWidth ?? 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke(path);

  if (selected) {
    // Animated dashed tactical lock border
    ctx.save();
    ctx.shadowColor = '#F59E0B';
    ctx.shadowBlur = 14;
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 2.6;
    ctx.setLineDash([10, 6]);
    ctx.lineDashOffset = -time * 30;
    ctx.stroke(path);
    ctx.restore();
    ctx.setLineDash([]);

    // Corner brackets around bounding box
    const bb = district?.bb;
    if (bb && bb.length === 4) {
      const [x0, y0, x1, y1] = bb;
      const L = Math.min(18, (x1 - x0) / 4, (y1 - y0) / 4);
      ctx.strokeStyle = '#FBBF24';
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      const corners = [
        [x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1],
      ];
      for (const [cx, cy, sx, sy] of corners) {
        ctx.beginPath();
        ctx.moveTo(cx + sx * L, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + sy * L);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

/**
 * drawQuarantineEdge(ctx, edge, opts) — high-contrast hazard chevron dashes along a shared border.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Path2D | { a:[number,number], b:[number,number] }} edge  border geometry (map coords)
 * @param {{ time?: number, color?: string, width?: number }} [opts]
 * @returns {void}
 */
export function drawQuarantineEdge(ctx, edge, opts = {}) {
  const time = opts.time ?? 0;
  const color = opts.color ?? '#F59E0B';
  const width = opts.width ?? 4;

  const path = (typeof Path2D !== 'undefined' && edge instanceof Path2D)
    ? edge
    : (() => { const p = new Path2D(); p.moveTo(edge.a[0], edge.a[1]); p.lineTo(edge.b[0], edge.b[1]); return p; })();

  ctx.save();
  ctx.lineCap = 'butt';
  // Dark underlay for contrast
  ctx.strokeStyle = 'rgba(6, 12, 15, 0.85)';
  ctx.lineWidth = width + 3;
  ctx.stroke(path);
  // Hazard chevron dashes, marching with time
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash([9, 7]);
  ctx.lineDashOffset = -time * 36;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.stroke(path);
  ctx.restore();
  ctx.setLineDash([]);
}

/**
 * drawUnitMarker(ctx, x, y, kind, opts) — geometric protocol tokens anchored at district centroids.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x  map x
 * @param {number} y  map y
 * @param {'psn'|'traps'|'fog'|'clinic'} kind
 * @param {{ time?: number, scale?: number, active?: boolean }} [opts]
 * @returns {void}
 */
export function drawUnitMarker(ctx, x, y, kind, opts = {}) {
  const time = opts.time ?? 0;
  const s = (opts.scale ?? 1);
  const active = opts.active ?? true;
  const dim = active ? 1 : 0.45;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.globalAlpha = dim;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (kind === 'psn') {
    // Teal octagonal ring + sweep badge
    ctx.strokeStyle = '#2DD4BF';
    ctx.fillStyle = 'rgba(45, 212, 191, 0.16)';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + Math.PI / 8;
      const px = Math.cos(a) * 8, py = Math.sin(a) * 8;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // Sweep arc badge
    ctx.beginPath();
    ctx.arc(0, 0, 4.6, -Math.PI / 2, -Math.PI / 2 + TAU * 0.72);
    ctx.strokeStyle = '#5EEAD4';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 1.2, 0, TAU);
    ctx.fillStyle = '#2DD4BF';
    ctx.fill();
  } else if (kind === 'traps') {
    // Amber hexagonal canister + pulsing capture dot
    ctx.strokeStyle = '#F59E0B';
    ctx.fillStyle = 'rgba(245, 158, 11, 0.18)';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU - Math.PI / 2;
      const px = Math.cos(a) * 7.4, py = Math.sin(a) * 7.4;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    const pulse = (Math.sin(time * 4) + 1) / 2;
    ctx.beginPath();
    ctx.arc(0, 0, 1.6 + pulse * 1.5, 0, TAU);
    ctx.fillStyle = `rgba(251, 191, 36, ${0.55 + pulse * 0.45})`;
    ctx.fill();
  } else if (kind === 'fog') {
    // Expanding translucent smoke plume rings
    for (let i = 0; i < 3; i++) {
      const phase = (time * 0.7 + i / 3) % 1;
      const r = 3 + phase * 9;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.strokeStyle = `rgba(148, 210, 230, ${0.55 * (1 - phase)})`;
      ctx.lineWidth = 1.6 * (1 - phase) + 0.4;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, 2.2, 0, TAU);
    ctx.fillStyle = '#CBD5E1';
    ctx.fill();
  } else if (kind === 'clinic') {
    // Emerald square + white medical cross
    ctx.fillStyle = '#059669';
    ctx.strokeStyle = '#34D399';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.rect(-7, -7, 14, 14);
    ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, -4); ctx.lineTo(0, 4);
    ctx.moveTo(-4, 0); ctx.lineTo(4, 0);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * drawHotspotNode(ctx, x, y, opts) — pulsing surveillance ping (radar sweep blip).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x  map x
 * @param {number} y  map y
 * @param {{ time?: number, color?: string, intensity?: number }} [opts]  intensity 0..1 scales radius/alpha
 * @returns {void}
 */
export function drawHotspotNode(ctx, x, y, opts = {}) {
  const time = opts.time ?? 0;
  const color = opts.color ?? '#38BDF8';
  const intensity = clamp01(opts.intensity ?? 0.7);

  ctx.save();
  ctx.translate(x, y);
  for (let i = 0; i < 3; i++) {
    const phase = (time * 0.9 + i / 3) % 1;
    ctx.beginPath();
    ctx.arc(0, 0, 2 + phase * (10 + intensity * 8), 0, TAU);
    ctx.strokeStyle = color;
    ctx.globalAlpha = (1 - phase) * (0.35 + intensity * 0.5);
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.arc(0, 0, 2.6 + Math.sin(time * 5) * 0.5, 0, TAU);
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.fill();
  ctx.restore();
}

/** Deterministic pseudo-random from a seed integer (for irregular pool outlines). */
function seededNoise(seed, i) {
  const v = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

/**
 * drawStandingPool(ctx, x, y, opts) — organic dual-ring irregular ellipse, concentric
 * sin(t) ripple rings, and a crisp drain-progress arc (0 -> 100%).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x  map x
 * @param {number} y  map y
 * @param {{ rx?:number, ry?:number, seed?:number, drain?:number, time?:number, rotation?:number }} [opts]
 *        drain 0..1 (1 = fully drained; arc sweeps clockwise from 12 o'clock)
 * @returns {void}
 */
export function drawStandingPool(ctx, x, y, opts = {}) {
  const rx = opts.rx ?? 9;
  const ry = opts.ry ?? rx * 0.68;
  const seed = opts.seed ?? 1;
  const drain = clamp01(opts.drain ?? 0);
  const time = opts.time ?? 0;
  const rot = opts.rotation ?? seededNoise(seed, 99) * Math.PI;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);

  const ring = (scale, alpha, lw) => {
    ctx.beginPath();
    const N = 26;
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * TAU;
      const wob = 1 + 0.22 * (seededNoise(seed, i % 13) - 0.5) * 2 * scale;
      const px = Math.cos(a) * rx * scale * wob;
      const py = Math.sin(a) * ry * scale * wob;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = `rgba(56, 189, 248, ${alpha})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(125, 211, 252, ${alpha + 0.25})`;
    ctx.lineWidth = lw;
    ctx.stroke();
  };
  ring(1.0, 0.3, 1.4);   // outer ring
  ring(0.62, 0.42, 1.1); // inner ring

  // Concentric ripple rings driven by sin(t)
  for (let k = 0; k < 2; k++) {
    const phase = (time * 0.8 + k * 0.5 + seededNoise(seed, 50 + k)) % 1;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx * (0.3 + phase * 0.75), ry * (0.3 + phase * 0.75), 0, 0, TAU);
    ctx.strokeStyle = `rgba(186, 230, 253, ${0.6 * (1 - phase)})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();

  // Drain-progress arc (screen-upright, drawn unrotated)
  if (drain > 0.001) {
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(rx, ry) + 4.5, -Math.PI / 2, -Math.PI / 2 + TAU * drain);
    ctx.strokeStyle = drain >= 1 ? '#10B981' : '#38BDF8';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.shadowColor = ctx.strokeStyle;
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * drawMosquitoSprite(ctx, x, y, opts) — articulated vector mosquito, 4 archetypes.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x  map x
 * @param {number} y  map y
 * @param {{ archetype?: 'standard'|'flanker'|'queen'|'viremic', angle?: number, time?: number,
 *           scale?: number, hp?: number, maxHp?: number, halo?: number, locked?: boolean,
 *           alpha?: number }} [opts]
 *   standard : striped dark/white abdomen, swept translucent fluttering wings, proboscis, threat halo (halo 0..1)
 *   flanker  : elongated cyan-tinted wings, sharper chevron silhouette, speed trail
 *   queen    : larger glowing amber/magenta abdomen sac (2–3 HP)
 *   viremic  : crimson core pulse + urgent target reticle lock (locked=true)
 * @returns {void}
 */
export function drawMosquitoSprite(ctx, x, y, opts = {}) {
  const archetype = opts.archetype ?? 'standard';
  const angle = opts.angle ?? 0;
  const time = opts.time ?? 0;
  const scale = opts.scale ?? 1;
  const hp = opts.hp ?? 1;
  const maxHp = opts.maxHp ?? hp;
  const halo = clamp01(opts.halo ?? 0);
  const locked = opts.locked ?? false;
  const alpha = opts.alpha ?? 1;

  const size = archetype === 'queen' ? 1.55 : archetype === 'flanker' ? 0.9 : archetype === 'viremic' ? 1.1 : 1;
  const flutter = Math.sin(time * 28);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(scale * size, scale * size);
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Speed trail (flanker)
  if (archetype === 'flanker') {
    ctx.strokeStyle = 'rgba(103, 232, 249, 0.5)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-2, 6); ctx.lineTo(-5.5, 13);
    ctx.moveTo(2, 6); ctx.lineTo(5.5, 13);
    ctx.moveTo(0, 6.5); ctx.lineTo(0, 15);
    ctx.stroke();
  }

  // Threat halo (standard, approaching target)
  if (halo > 0.02) {
    ctx.beginPath();
    ctx.arc(0, 0, 12 + halo * 3, 0, TAU);
    ctx.strokeStyle = `rgba(239, 68, 68, ${0.25 + halo * 0.45})`;
    ctx.lineWidth = 1.4 + halo;
    ctx.stroke();
  }

  // Wings — swept, translucent, fluttering
  const wingA = 0.55 + flutter * 0.35;
  const wingFill = archetype === 'flanker'
    ? `rgba(165, 243, 252, ${0.5 + flutter * 0.2})`
    : `rgba(203, 225, 235, ${0.42 + flutter * 0.18})`;
  ctx.fillStyle = wingFill;
  ctx.strokeStyle = 'rgba(230, 240, 242, 0.5)';
  ctx.lineWidth = 0.6;
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.rotate(side * wingA * 0.9);
    ctx.beginPath();
    if (archetype === 'flanker') {
      ctx.ellipse(side * 7.5, -2.5, 7.2, 1.9, side * 0.5, 0, TAU);   // elongated cyan wings
    } else {
      ctx.ellipse(side * 5.8, -3, 5.4, 2.6, side * 0.55, 0, TAU);
    }
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // Hind legs
  ctx.strokeStyle = '#0A1317';
  ctx.lineWidth = 1.1;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * 2.2, 3); ctx.lineTo(side * 4.6, 7.5); ctx.lineTo(side * 3.4, 11);
    ctx.stroke();
  }

  // Abdomen — striped dark/white (standard/flanker), glowing sac (queen), crimson core (viremic)
  if (archetype === 'queen') {
    const pulse = (Math.sin(time * 5) + 1) / 2;
    const sac = ctx.createRadialGradient(0, 4.5, 0.4, 0, 4.5, 5.4);
    sac.addColorStop(0, `rgba(252, 211, 77, ${0.9 + pulse * 0.1})`);
    sac.addColorStop(0.55, 'rgba(217, 70, 239, 0.85)');
    sac.addColorStop(1, 'rgba(112, 26, 117, 0.9)');
    ctx.fillStyle = sac;
    ctx.shadowColor = '#D946EF';
    ctx.shadowBlur = 10 + pulse * 6;
    ctx.beginPath();
    ctx.ellipse(0, 4.5, 3.6, 5, 0, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
  } else if (archetype === 'viremic') {
    const pulse = (Math.sin(time * 7) + 1) / 2;
    ctx.fillStyle = `rgba(239, 68, 68, ${0.75 + pulse * 0.25})`;
    ctx.shadowColor = '#EF4444';
    ctx.shadowBlur = 8 + pulse * 6;
    ctx.beginPath();
    ctx.ellipse(0, 3.5, 2.6, 4.6, 0, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Segment bands
    ctx.strokeStyle = 'rgba(254, 202, 202, 0.8)';
    ctx.lineWidth = 0.7;
    for (const yy of [1.6, 3.6, 5.6]) {
      ctx.beginPath(); ctx.moveTo(-2.1, yy); ctx.lineTo(2.1, yy); ctx.stroke();
    }
  } else {
    ctx.fillStyle = '#11181D';
    ctx.beginPath();
    ctx.ellipse(0, 3.5, 2.3, 4.4, 0, 0, TAU);
    ctx.fill();
    // White abdominal stripes
    ctx.strokeStyle = '#E6F0F2';
    ctx.lineWidth = archetype === 'flanker' ? 0.9 : 1.15;
    for (const yy of [1.4, 3.3, 5.2]) {
      ctx.beginPath(); ctx.moveTo(-2, yy); ctx.lineTo(2, yy); ctx.stroke();
    }
    if (archetype === 'flanker') {
      // Sharper chevron marking
      ctx.strokeStyle = '#67E8F9';
      ctx.beginPath(); ctx.moveTo(-1.6, 6.8); ctx.lineTo(0, 5.2); ctx.lineTo(1.6, 6.8); ctx.stroke();
    }
  }

  // Thorax
  ctx.fillStyle = '#1A2E38';
  ctx.beginPath();
  ctx.ellipse(0, -1.6, 2.5, 2.1, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(148, 210, 230, 0.4)';
  ctx.lineWidth = 0.6;
  ctx.stroke();

  // Head + proboscis
  ctx.beginPath();
  ctx.arc(0, -4.4, 1.5, 0, TAU);
  ctx.fillStyle = '#0A1317';
  ctx.fill();
  ctx.strokeStyle = '#0A1317';
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(0, -5.6); ctx.lineTo(0, -9.5);
  ctx.stroke();
  // Eyes
  ctx.fillStyle = archetype === 'viremic' ? '#FCA5A5' : '#93C5FD';
  ctx.beginPath(); ctx.arc(-0.8, -4.6, 0.32, 0, TAU); ctx.arc(0.8, -4.6, 0.32, 0, TAU); ctx.fill();

  // HP pips for multi-HP queens
  if (maxHp > 1) {
    const pipW = 3, gap = 1.4, total = maxHp * pipW + (maxHp - 1) * gap;
    ctx.rotate(-angle); // keep pips screen-upright
    for (let i = 0; i < maxHp; i++) {
      ctx.fillStyle = i < hp ? '#FBBF24' : 'rgba(91, 115, 126, 0.5)';
      ctx.fillRect(-total / 2 + i * (pipW + gap), -13.5, pipW, 1.6);
    }
    ctx.rotate(angle);
  }

  // Viremic target reticle lock
  if (locked) {
    const r = 11 + Math.sin(time * 9) * 1.5;
    ctx.strokeStyle = '#EF4444';
    ctx.lineWidth = 1.3;
    ctx.setLineDash([4, 3]);
    ctx.lineDashOffset = -time * 24;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(sx * (r + 3.5), sy * r);
      ctx.lineTo(sx * r, sy * r);
      ctx.lineTo(sx * r, sy * (r + 3.5));
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * drawSlashTrail(ctx, points, opts) — tapering cyan-to-white plasma/radar arc.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number, y:number, t:number}>} points  trail points (t in ms, newest last)
 * @param {{ now?: number, lifetime?: number, width?: number }} [opts]  lifetime default 180ms
 * @returns {void}
 */
export function drawSlashTrail(ctx, points, opts = {}) {
  if (!Array.isArray(points) || points.length < 2) return;
  const now = opts.now ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const lifetime = opts.lifetime ?? 180;
  const baseWidth = opts.width ?? 7;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1], p1 = points[i];
    const age = now - p1.t;
    if (age >= lifetime) continue;
    const life = 1 - age / lifetime;          // 1 fresh -> 0 gone
    const taper = (i / points.length) * life; // thin at tail, alpha fades with age
    if (taper <= 0.02) continue;
    ctx.strokeStyle = `rgba(125, 249, 255, ${0.25 + taper * 0.55})`;
    ctx.lineWidth = baseWidth * taper;
    ctx.shadowColor = '#67E8F9';
    ctx.shadowBlur = 8 * life;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
    // Hot white core
    ctx.strokeStyle = `rgba(255, 255, 255, ${taper * 0.9})`;
    ctx.lineWidth = Math.max(0.6, baseWidth * taper * 0.38);
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * drawSprayBurst(ctx, x, y, progress, opts) — containment shockwave ring + particulate mist.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x  map x
 * @param {number} y  map y
 * @param {number} progress  0..1 expansion progress
 * @param {{ maxRadius?: number, color?: string, mist?: number }} [opts]
 * @returns {void}
 */
export function drawSprayBurst(ctx, x, y, progress, opts = {}) {
  const p = clamp01(progress);
  const maxR = opts.maxRadius ?? 90;
  const color = opts.color ?? '#38BDF8';
  const mist = opts.mist ?? 14;

  ctx.save();
  const r = p * maxR;
  const fade = 1 - p;
  // Shockwave rings (double)
  ctx.strokeStyle = color;
  ctx.globalAlpha = fade * 0.9;
  ctx.lineWidth = 3.4 * fade + 0.6;
  ctx.shadowColor = color;
  ctx.shadowBlur = 12 * fade;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
  ctx.globalAlpha = fade * 0.5;
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(x, y, r * 0.72, 0, TAU); ctx.stroke();
  // Particulate mist
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#E0F2FE';
  for (let i = 0; i < mist; i++) {
    const a = (i / mist) * TAU + i * 2.39996;
    const rr = r * (0.45 + 0.55 * seededNoise(7, i));
    ctx.globalAlpha = fade * (0.35 + 0.4 * seededNoise(11, i));
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * rr, y + Math.sin(a) * rr, 1.4 + seededNoise(13, i) * 1.6, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

/* ---------- Effects-layer particle helpers ---------- */

/**
 * createFloatText(x, y, text, opts) -> floatText particle
 * @param {number} x @param {number} y @param {string} text
 * @param {{ color?: string, size?: number, life?: number }} [opts]  life in ms (default 900)
 * @returns {{ type:'floatText', x:number, y:number, text:string, color:string, size:number, born:number, life:number }}
 */
export function createFloatText(x, y, text, opts = {}) {
  const now = opts.now ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return {
    type: 'floatText',
    x, y,
    text: String(text),
    color: opts.color ?? '#E6F0F2',
    size: opts.size ?? 12,
    born: now,
    life: opts.life ?? 900,
  };
}

/**
 * createSparkBurst(x, y, opts) -> particle[] (radial sparks + one shockwave ring)
 * @param {number} x @param {number} y
 * @param {{ color?: string, count?: number, speed?: number, color2?: string }} [opts]
 * @returns {Array<object>}
 */
export function createSparkBurst(x, y, opts = {}) {
  const now = opts.now ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const count = opts.count ?? 14;
  const speed = opts.speed ?? 90;
  const color = opts.color ?? '#7DD3FC';
  const parts = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU + Math.random() * 0.5;
    const v = speed * (0.5 + Math.random() * 0.8);
    parts.push({
      type: 'spark',
      x, y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      color: Math.random() < 0.35 ? (opts.color2 ?? '#FFFFFF') : color,
      size: 1.4 + Math.random() * 1.8,
      born: now,
      life: 380 + Math.random() * 320,
    });
  }
  parts.push({ type: 'ring', x, y, r0: 4, r1: 46, color, lineWidth: 2, born: now, life: 420 });
  return parts;
}

/**
 * createSplat(x, y, opts) -> splat particle (hit marker droplet burst)
 * @param {number} x @param {number} y
 * @param {{ color?: string, size?: number, life?: number }} [opts]
 * @returns {{ type:'splat', x:number, y:number, color:string, size:number, born:number, life:number, seed:number }}
 */
export function createSplat(x, y, opts = {}) {
  const now = opts.now ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return {
    type: 'splat',
    x, y,
    color: opts.color ?? '#EF4444',
    size: opts.size ?? 9,
    born: now,
    life: opts.life ?? 520,
    seed: Math.random() * 1000,
  };
}

/**
 * drawEffectsLayer(ctx, particles, now) — renders and culls floatText / spark / ring / splat particles.
 * Does not mutate the array; modes prune via FX (map-renderer.js) or filter on particle.life.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<object>} particles
 * @param {number} now  ms timestamp (performance.now())
 * @returns {void}
 */
export function drawEffectsLayer(ctx, particles, now) {
  if (!Array.isArray(particles)) return;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const p of particles) {
    const age = now - (p.born ?? now);
    if (age < 0 || age >= (p.life ?? 900)) continue;
    const k = age / (p.life ?? 900);
    const fade = 1 - k;

    if (p.type === 'floatText') {
      ctx.globalAlpha = fade;
      ctx.font = `700 ${p.size ?? 12}px "Cascadia Mono", Consolas, monospace`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(6, 12, 15, 0.85)';
      const yy = p.y - k * 34;
      ctx.strokeText(p.text, p.x, yy);
      ctx.fillStyle = p.color ?? '#E6F0F2';
      ctx.fillText(p.text, p.x, yy);
    } else if (p.type === 'spark') {
      const dt = age / 1000;
      const px = p.x + (p.vx ?? 0) * dt;
      const py = p.y + (p.vy ?? 0) * dt + 140 * dt * dt; // gravity
      ctx.globalAlpha = fade;
      ctx.fillStyle = p.color ?? '#7DD3FC';
      ctx.beginPath();
      ctx.arc(px, py, (p.size ?? 2) * fade + 0.4, 0, TAU);
      ctx.fill();
    } else if (p.type === 'ring') {
      const r = (p.r0 ?? 4) + ((p.r1 ?? 46) - (p.r0 ?? 4)) * k;
      ctx.globalAlpha = fade * 0.9;
      ctx.strokeStyle = p.color ?? '#7DD3FC';
      ctx.lineWidth = (p.lineWidth ?? 2) * fade + 0.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.stroke();
    } else if (p.type === 'splat') {
      const seed = p.seed ?? 1;
      ctx.globalAlpha = fade;
      ctx.fillStyle = p.color ?? '#EF4444';
      const n = 7;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + seededNoise(seed, i) * 0.9;
        const d = (p.size ?? 9) * (0.35 + seededNoise(seed + 1, i) * 0.75) * (0.5 + k);
        ctx.beginPath();
        ctx.arc(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 1.1 + seededNoise(seed + 2, i) * 1.7, 0, TAU);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, (p.size ?? 9) * 0.32 * fade + 0.5, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}
