/* ============================================================
   Dengue Defense — Field Edition · Map Renderer
   Canvas projection (map <-> screen) over the virtual corridor
   coordinate space, letterboxed to the viewport, plus an FX
   particle system and the layer-orchestrating MapRenderer.

   No DOM access at import time. Canvas is resolved lazily via
   resizeCanvas() / new MapRenderer().

   EXPORTS
   -------
   CORRIDOR                -> const { MX0, MY0, MW, MH, WIDTH, HEIGHT }
   view                    -> internal mutable view descriptor (read via getView())
   getView()               -> { w, h, dpr, scale, ox, oy }
   toScreen(x, y)          -> [sx, sy]   map -> screen (CSS px)
   toMap(sx, sy)           -> [mx, my]   screen -> map
   resizeCanvas(canvas?)   -> view descriptor; sizes canvas to viewport * dpr (max 2), letterboxes corridor
   FX                      -> class ParticleSystem (floatText / burst / splat / draw / clear)
   MapRenderer             -> class orchestrating layers: background -> rivers -> districts -> markers -> FX

   ARGUMENT TYPES
   --------------
   canvas   : HTMLCanvasElement | null/undefined (falls back to #canvas when available)
   state    : render-state bag consumed by MapRenderer.render(); see MapRenderer docs
   now      : number (ms, performance.now()) — caller (main.js) drives the loop
   ============================================================ */

import {
  drawMapBackground,
  drawMerapiContour,
  drawRiverCurves,
  drawDistrictPolygon,
  drawQuarantineEdge,
  drawUnitMarker,
  drawHotspotNode,
  drawStandingPool,
  drawMosquitoSprite,
  drawSlashTrail,
  drawSprayBurst,
  drawEffectsLayer,
  createFloatText,
  createSparkBurst,
  createSplat,
} from './sprites.js';

/* Virtual corridor coordinate space (matches legacy Solo–Yogya corridor) */
export const CORRIDOR = Object.freeze({
  MX0: 85, MY0: 30, MW: 500, MH: 425,
  WIDTH: 700, HEIGHT: 500,
});

/* Internal mutable view descriptor — updated by resizeCanvas(). */
const view = {
  w: 700, h: 500, dpr: 1,
  scale: 1, ox: 0, oy: 0,
};

/** getView() -> snapshot of the current projection ({ w, h, dpr, scale, ox, oy }). */
export function getView() {
  return { ...view };
}

/**
 * toScreen(x, y) -> [sx, sy]
 * Map (corridor) coordinates -> screen CSS px, letterboxed into the viewport.
 * @param {number} x @param {number} y
 * @returns {[number, number]}
 */
export function toScreen(x, y) {
  return [view.ox + (x - CORRIDOR.MX0) * view.scale, view.oy + (y - CORRIDOR.MY0) * view.scale];
}

/**
 * toMap(sx, sy) -> [mx, my]
 * Screen CSS px -> map (corridor) coordinates.
 * @param {number} sx @param {number} sy
 * @returns {[number, number]}
 */
export function toMap(sx, sy) {
  return [(sx - view.ox) / view.scale + CORRIDOR.MX0, (sy - view.oy) / view.scale + CORRIDOR.MY0];
}

function resolveCanvas(canvas) {
  if (canvas) return canvas;
  if (typeof document !== 'undefined') {
    return document.getElementById('canvas') || null;
  }
  return null;
}

/**
 * resizeCanvas(canvas?) -> view descriptor
 * Sizes the canvas to its CSS box (or the viewport) * devicePixelRatio (clamped to 2),
 * and recomputes the letterboxed corridor projection.
 * @param {HTMLCanvasElement} [canvas] defaults to #canvas when available
 * @returns {{ w:number, h:number, dpr:number, scale:number, ox:number, oy:number }}
 */
export function resizeCanvas(canvas) {
  const cv = resolveCanvas(canvas);
  let w = typeof window !== 'undefined' ? window.innerWidth : 700;
  let h = typeof window !== 'undefined' ? window.innerHeight : 500;

  if (cv) {
    const rect = cv.getBoundingClientRect?.();
    const cssW = rect?.width || cv.clientWidth || w;
    const cssH = rect?.height || cv.clientHeight || h;
    if (cssW > 0) w = cssW;
    if (cssH > 0) h = cssH;
  }

  const dpr = Math.min(2, (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1);
  if (cv) {
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
  }

  view.w = w;
  view.h = h;
  view.dpr = dpr;
  view.scale = Math.max(0.01, Math.min((w - 12) / CORRIDOR.MW, Math.max(1, h - 24) / CORRIDOR.MH));
  view.ox = (w - CORRIDOR.MW * view.scale) / 2;
  view.oy = 12 + (h - 24 - CORRIDOR.MH * view.scale) / 2;
  return getView();
}

/* ===============================================================
   FX — particle system (floatText, burst, splat)
   Coordinates are in whatever space the caller draws in
   (map units for in-world FX, screen px for UI FX).
   =============================================================== */

/**
 * class FX — lightweight particle pool.
 *   fx.floatText(x, y, text, opts)  rising combat/score text (+10, PURGED, CLEARED)
 *   fx.burst(x, y, opts)            radial spark burst + shockwave ring
 *   fx.splat(x, y, opts)            impact splat marker
 *   fx.draw(ctx, now)               render + prune expired particles
 *   fx.clear()                      drop all particles
 */
export class FX {
  constructor() {
    /** @type {Array<object>} */
    this.particles = [];
  }

  /** floatText(x, y, text, opts) — rising fading text. Returns the particle. */
  floatText(x, y, text, opts = {}) {
    const p = createFloatText(x, y, text, opts);
    this.particles.push(p);
    return p;
  }

  /** burst(x, y, opts) — radial sparks + a shockwave ring. Returns the particles added. */
  burst(x, y, opts = {}) {
    const parts = createSparkBurst(x, y, opts);
    this.particles.push(...parts);
    return parts;
  }

  /** splat(x, y, opts) — impact splat. Returns the particle. */
  splat(x, y, opts = {}) {
    const p = createSplat(x, y, opts);
    this.particles.push(p);
    return p;
  }

  /** ring(x, y, opts) — standalone expanding ring. */
  ring(x, y, opts = {}) {
    const now = opts.now ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const p = {
      type: 'ring', x, y,
      r0: opts.r0 ?? 4,
      r1: opts.r1 ?? 60,
      color: opts.color ?? '#38BDF8',
      lineWidth: opts.lineWidth ?? 2.2,
      born: now,
      life: opts.life ?? 480,
    };
    this.particles.push(p);
    return p;
  }

  /** draw(ctx, now) — render particles and prune expired ones in place. */
  draw(ctx, now) {
    const t = now ?? (typeof performance !== 'undefined' ? performance.now() : Date.now());
    drawEffectsLayer(ctx, this.particles, t);
    this.particles = this.particles.filter(p => t - (p.born ?? t) < (p.life ?? 900));
  }

  /** clear() — remove all particles. */
  clear() {
    this.particles.length = 0;
  }

  /** get size() — live particle count. */
  get size() {
    return this.particles.length;
  }
}

/* ===============================================================
   MapRenderer — layer orchestrator
   Owns canvas sizing + projection. render(ctx, state, now) is
   rAF-agnostic: main.js drives the loop and passes `now` in ms.

   state shape (all fields optional):
   {
     time?: number,                 // seconds; defaults to now/1000
     showContours?: boolean,        // Merapi rings + karst hatches (default true)
     rivers?: Array<Path2D|Array<[number,number]>>,
     districts?: Array<{            // choropleth polygons
       id?: string, path?: Path2D, d?: string, bb?: [n,n,n,n],
       risk?: 0|1|2|3, fill?: [n,n,n], alpha?: number, selected?: boolean
     }>,
     selectedId?: string,           // forces selected=true on matching district.id
     quarantineEdges?: Array<Path2D | { a:[n,n], b:[n,n] }>,
     units?: Array<{ x:number, y:number, kind:'psn'|'traps'|'fog'|'clinic', active?:boolean }>,
     hotspots?: Array<{ x:number, y:number, color?:string, intensity?:number }>,
     standingPools?: Array<{ x:number, y:number, rx?:number, ry?:number, seed?:number, drain?:number, rotation?:number }>,
     mosquitoes?: Array<{ x:number, y:number, archetype?:'standard'|'flanker'|'queen'|'viremic',
                          angle?:number, scale?:number, hp?:number, maxHp?:number,
                          halo?:number, locked?:boolean, alpha?:number }>,
     slashTrail?: Array<{ x:number, y:number, t:number }>,
     sprayBursts?: Array<{ x:number, y:number, progress:number, maxRadius?:number, color?:string }>,
     fx?: FX,                       // defaults to this.fx
     drawFx?: boolean,              // default true
   }
   =============================================================== */

export class MapRenderer {
  /**
   * @param {HTMLCanvasElement} [canvas] defaults to #canvas when available
   */
  constructor(canvas) {
    /** @type {HTMLCanvasElement|null} */
    this.canvas = resolveCanvas(canvas);
    /** @type {CanvasRenderingContext2D|null} */
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.fx = new FX();
    /** @type {Map<string, Path2D>} */
    this._pathCache = new Map();
    this._autoResize = false;
    this._onResize = () => this.resize();
    if (this.canvas) this.resize();
  }

  /** resize() -> view descriptor. Re-projects the corridor to the current viewport. */
  resize() {
    const v = resizeCanvas(this.canvas ?? undefined);
    // Keep the ctx transform base fresh (render() re-applies it per frame anyway)
    return v;
  }

  /** enableAutoResize() — attach a window resize listener (browser only). Returns this. */
  enableAutoResize() {
    if (!this._autoResize && typeof window !== 'undefined') {
      window.addEventListener('resize', this._onResize, { passive: true });
      this._autoResize = true;
    }
    return this;
  }

  /** dispose() — detach listeners and drop cached paths. */
  dispose() {
    if (this._autoResize && typeof window !== 'undefined') {
      window.removeEventListener('resize', this._onResize);
      this._autoResize = false;
    }
    this._pathCache.clear();
    this.fx.clear();
  }

  /** _districtPath(d) — cached Path2D for a district definition. */
  _districtPath(d) {
    if (typeof Path2D !== 'undefined' && d?.path instanceof Path2D) return d.path;
    if (typeof d?.d !== 'string') return null;
    const key = d.id ?? d.d;
    let p = this._pathCache.get(key);
    if (!p) {
      p = new Path2D(d.d);
      this._pathCache.set(key, p);
    }
    return p;
  }

  /**
   * render(ctx, state, now) — rAF-agnostic frame render.
   * Layers: background -> contours -> rivers -> districts -> quarantine edges ->
   *         standing pools -> unit markers -> hotspots -> mosquitoes -> slash -> spray -> FX.
   * @param {CanvasRenderingContext2D} [ctx] defaults to this.ctx
   * @param {object} [state] render-state bag (see class docs above)
   * @param {number} [now] ms timestamp (performance.now())
   * @returns {void}
   */
  render(ctx, state = {}, now = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
    const c = ctx ?? this.ctx;
    if (!c) return;
    const time = state.time ?? now / 1000;

    // Screen-space pass: clear + background
    c.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    c.clearRect(0, 0, view.w, view.h);
    drawMapBackground(c, { ...view, time });

    // Map-space pass: corridor transform.
    // toScreen(): screen = ox + (map - MX0) * scale  ->  here, pre-multiplied by dpr.
    c.setTransform(
      view.dpr * view.scale, 0, 0,
      view.dpr * view.scale,
      view.dpr * (view.ox - CORRIDOR.MX0 * view.scale),
      view.dpr * (view.oy - CORRIDOR.MY0 * view.scale),
    );

    const hairline = 1 / Math.max(view.scale, 0.01);
    c.lineWidth = hairline;

    // Relief: Merapi contours + karst hatches
    if (state.showContours !== false) {
      drawMerapiContour(c, { time });
    }

    // Rivers
    if (Array.isArray(state.rivers) && state.rivers.length) {
      drawRiverCurves(c, state.rivers, time);
    }

    // Districts (choropleth)
    if (Array.isArray(state.districts)) {
      for (const d of state.districts) {
        const path = this._districtPath(d);
        const selected = d.selected ?? (state.selectedId != null && d.id === state.selectedId);
        drawDistrictPolygon(c, { ...d, path: path ?? d.path }, { time, selected });
      }
    }

    // Quarantine cordon edges
    if (Array.isArray(state.quarantineEdges)) {
      for (const e of state.quarantineEdges) {
        drawQuarantineEdge(c, e, { time });
      }
    }

    // Standing water breeding pools
    if (Array.isArray(state.standingPools)) {
      for (const p of state.standingPools) {
        drawStandingPool(c, p.x, p.y, { ...p, time });
      }
    }

    // Protocol / unit markers
    if (Array.isArray(state.units)) {
      for (const u of state.units) {
        drawUnitMarker(c, u.x, u.y, u.kind, { time, active: u.active });
      }
    }

    // Hotspot surveillance pings
    if (Array.isArray(state.hotspots)) {
      for (const hPt of state.hotspots) {
        drawHotspotNode(c, hPt.x, hPt.y, { time, color: hPt.color, intensity: hPt.intensity });
      }
    }

    // Mosquitoes
    if (Array.isArray(state.mosquitoes)) {
      for (const m of state.mosquitoes) {
        drawMosquitoSprite(c, m.x, m.y, { ...m, time });
      }
    }

    // Slash trail (pointer swat)
    if (Array.isArray(state.slashTrail) && state.slashTrail.length > 1) {
      drawSlashTrail(c, state.slashTrail, { now, lifetime: 180 });
    }

    // Containment spray shockwaves
    if (Array.isArray(state.sprayBursts)) {
      for (const s of state.sprayBursts) {
        drawSprayBurst(c, s.x, s.y, s.progress, { maxRadius: s.maxRadius, color: s.color });
      }
    }

    // FX particles (map space)
    const fx = state.fx ?? this.fx;
    if (state.drawFx !== false && fx) {
      fx.draw(c, now);
    }
  }
}
