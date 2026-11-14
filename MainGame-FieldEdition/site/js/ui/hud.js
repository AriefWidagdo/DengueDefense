/* ============================================================================
   Dengue Defense — Field Edition :: HUD (top telemetry bar + tactical rail)
   Mode-aware chrome for the Satgas DBD command post.
   - renderHud(snapshot) consumes the ACTIVE MODE's getHudSnapshot()
   - operations / crisis_board  -> #panel right rail (districts, threat meters,
                                   protocol toggles via data attributes, COMMIT CTA)
   - wave phases                -> bottom-center Field Gadget Dock (spray ring,
                                   ward-surge quick button)
   - blitz (mode 3)             -> #panel hidden entirely; countdown + surge
                                   meter + score/combo pills + spray trigger
   All gameplay copy flows through t() from js/i18n.js. Zero emojis. Zero
   scientific/math copy in this file (that lives in js/ui/epikd-lab.js behind a
   'dd:open-epikd' CustomEvent).

   Defensive DOM contract: the Wave-3 shell (W3-A, site/index.html) owns
   #hud / #panel / #toast / #banner. Any sub-structure we need is created
   in place, idempotently, and flagged with data-dd="keep" so a re-render
   never duplicates nodes. Legacy pre-redesign children of #hud / #panel
   are superseded (display:none, not removed - never destructive).
   No document/window access at module scope; everything is lazy + guarded.
   ============================================================================ */

import { t, getLang, toggleLanguage, applyStaticI18n } from '../i18n.js';
import {
  SFX,
  setAudioEnabled,
  isAudioEnabled,
  setHapticsEnabled,
  isHapticsEnabled,
  vibrate,
} from '../audio.js';
import { iconSvg } from '../sprites.js';

/* ------------------------------------------------------------------ helpers */
const doc = () => (typeof document !== 'undefined' ? document : null);
const win = () => (typeof window !== 'undefined' ? window : null);
const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
const clamp01 = (v) => clamp(v, 0, 1);
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');
const fmtInt = (n) => {
  const v = Number(n) || 0;
  try { return Math.round(v).toLocaleString(); } catch (e) { return String(Math.round(v)); }
};
/* Bilingual literal fallback for the handful of atoms that have no i18n key.
   Kept label-only; never used for sentences. */
const L = (en, id) => (getLang() === 'id' ? id : en);

function dispatchDd(name, detail) {
  const w = win();
  if (!w) return false;
  try {
    const Ctor = typeof w.CustomEvent === 'function' ? w.CustomEvent : null;
    const ev = Ctor
      ? new Ctor(name, { detail: detail || {} })
      : (typeof w.document !== 'undefined' && w.document.createEvent
          ? (() => { const e = w.document.createEvent('CustomEvent'); e.initCustomEvent(name, false, false, detail || {}); return e; })()
          : null);
    if (ev) w.dispatchEvent(ev);
    return !!ev;
  } catch (e) {
    return false;
  }
}

function el(tag, className, attrs) {
  const d = doc();
  if (!d) return null;
  const node = d.createElement(tag);
  if (className) node.className = className;
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const v = attrs[key];
      if (v == null) continue;
      if (key === 'text') node.textContent = v;
      else if (key === 'html') node.innerHTML = v;
      else node.setAttribute(key, String(v));
    }
  }
  return node;
}

/* Scoped stylesheet — self-sufficient styling that composes with tokens.css
   when present (falls back to literal values otherwise). Unique prefix. */
function ensureStyle() {
  const d = doc();
  if (!d) return;
  if (d.getElementById('dd-hud-style')) return;
  const style = d.createElement('style');
  style.id = 'dd-hud-style';
  style.textContent = `
  #hud.dd-hud{position:relative;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:10px;
    padding:8px 12px;min-height:56px;max-height:56px;box-sizing:border-box;
    background:var(--bg-glass,rgba(11,21,25,.86));backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
    border-bottom:1px solid var(--border-subtle,rgba(148,210,230,.14));color:var(--text-primary,#E6F0F2);
    font-family:var(--font-sans,'Plus Jakarta Sans','Inter','Segoe UI',system-ui,sans-serif);}
  .ddh-cluster{display:flex;align-items:center;gap:8px;min-width:0;}
  .ddh-left{flex:0 1 auto;justify-content:flex-start;}
  .ddh-center{flex:1 1 auto;justify-content:center;gap:10px;}
  .ddh-right{flex:0 1 auto;justify-content:flex-end;}
  .ddh-badge{display:flex;align-items:center;gap:7px;padding:4px 10px;border:1px solid var(--border-strong,#2E4D5B);
    border-radius:var(--radius-pill,999px);background:var(--bg-elevated,#1A2E38);font-size:10px;font-weight:800;
    letter-spacing:.12em;color:var(--accent-primary,#F59E0B);white-space:nowrap;max-width:190px;overflow:hidden;}
  .ddh-badge svg{width:16px;height:16px;flex:0 0 auto;}
  .ddh-badge small{display:block;font-size:7px;letter-spacing:.18em;color:var(--text-secondary,#8FA8B2);font-weight:700;}
  .ddh-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:var(--radius-pill,999px);
    border:1px solid var(--border-subtle,rgba(148,210,230,.14));background:var(--bg-surface,#132229);
    font:600 10.5px var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);font-variant-numeric:tabular-nums;
    color:var(--text-primary,#E6F0F2);white-space:nowrap;letter-spacing:.05em;}
  .ddh-pill .ddh-lbl{font-size:7px;letter-spacing:.14em;color:var(--text-secondary,#8FA8B2);font-weight:700;}
  .ddh-seed{cursor:pointer;border-style:dashed;color:var(--text-secondary,#8FA8B2);}
  .ddh-seed:hover{color:var(--text-primary,#E6F0F2);border-color:var(--border-strong,#2E4D5B);}
  .ddh-gauge{display:flex;flex-direction:column;gap:3px;min-width:150px;max-width:230px;}
  .ddh-gauge-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px;}
  .ddh-gauge-lbl{font-size:7px;letter-spacing:.16em;color:var(--text-secondary,#8FA8B2);font-weight:800;}
  .ddh-gauge-val{font:700 13px var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);font-variant-numeric:tabular-nums;color:var(--text-primary,#E6F0F2);}
  .ddh-gauge-val em{font-style:normal;color:var(--text-muted,#5B737E);font-size:9px;}
  .ddh-track{height:6px;border-radius:var(--radius-pill,999px);background:var(--bg-elevated,#1A2E38);overflow:hidden;border:1px solid var(--border-subtle,rgba(148,210,230,.14));}
  .ddh-fill{height:100%;width:0%;background:var(--status-safe,#10B981);transition:width .25s ease;}
  .ddh-fill.warn{background:var(--status-warn,#F59E0B);}
  .ddh-fill.danger{background:var(--status-danger,#EF4444);}
  .ddh-fill.critical{background:var(--status-critical,#D946EF);}
  .ddh-combo{position:relative;width:44px;height:44px;flex:0 0 auto;}
  .ddh-combo svg{width:44px;height:44px;transform:rotate(-90deg);}
  .ddh-combo .ddh-ring-bg{stroke:var(--bg-elevated,#1A2E38);}
  .ddh-combo .ddh-ring-fg{stroke:var(--accent-primary,#F59E0B);transition:stroke-dashoffset .12s linear;}
  .ddh-combo-num{position:absolute;inset:0;display:grid;place-items:center;font:800 11px var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);color:var(--accent-primary,#F59E0B);}
  .ddh-iconbtn{position:relative;display:inline-grid;place-items:center;min-width:34px;height:34px;padding:0 6px;
    border-radius:var(--radius-md,8px);border:1px solid var(--border-subtle,rgba(148,210,230,.14));
    background:var(--bg-surface,#132229);color:var(--text-primary,#E6F0F2);cursor:pointer;}
  .ddh-iconbtn:hover{border-color:var(--border-strong,#2E4D5B);}
  .ddh-iconbtn[aria-pressed="false"]{color:var(--text-muted,#5B737E);}
  .ddh-iconbtn svg{width:17px;height:17px;}
  .ddh-lang{display:inline-flex;border:1px solid var(--border-subtle,rgba(148,210,230,.14));border-radius:var(--radius-md,8px);overflow:hidden;}
  .ddh-lang button{min-width:36px;height:34px;padding:0 8px;font:800 10px var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);
    letter-spacing:.08em;background:transparent;color:var(--text-secondary,#8FA8B2);border:0;cursor:pointer;}
  .ddh-lang button[aria-pressed="true"]{background:var(--accent-primary,#F59E0B);color:var(--on-accent,#0A1317);}
  .ddh-epikd{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 12px;border-radius:var(--radius-pill,999px);
    border:1px solid var(--accent-hydro,#38BDF8);color:var(--accent-hydro,#38BDF8);background:transparent;
    font-size:9px;font-weight:800;letter-spacing:.12em;cursor:pointer;white-space:nowrap;}
  .ddh-epikd:hover{background:rgba(56,189,248,.12);}
  .ddh-epikd svg{width:15px;height:15px;}
  .ddh-blitz{display:flex;align-items:center;gap:10px;}
  .ddh-blitz-clock{font:800 24px var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);font-variant-numeric:tabular-nums;
    color:var(--text-primary,#E6F0F2);letter-spacing:.04em;min-width:86px;text-align:center;}
  .ddh-blitz-clock.late{color:var(--status-danger,#EF4444);animation:ddh-pulse 1s ease infinite;}
  @keyframes ddh-pulse{50%{opacity:.55;}}
  .ddh-spraytrig{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 14px;border-radius:var(--radius-md,8px);
    border:1px solid var(--accent-primary,#F59E0B);background:rgba(245,158,11,.14);color:var(--accent-primary,#F59E0B);
    font-weight:800;font-size:10px;letter-spacing:.1em;cursor:pointer;}
  .ddh-spraytrig svg{width:17px;height:17px;}
  /* Field Gadget Dock (wave phases) */
  #ddDock{position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);
    z-index:25;display:flex;align-items:center;gap:14px;padding:8px 14px;border-radius:var(--radius-lg,12px);
    background:var(--bg-glass,rgba(11,21,25,.88));backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
    border:1px solid var(--border-strong,#2E4D5B);box-shadow:var(--shadow-panel,0 12px 32px rgba(0,0,0,.45));}
  .ddh-ring{position:relative;width:58px;height:58px;}
  .ddh-ring svg{width:58px;height:58px;transform:rotate(-90deg);}
  .ddh-ring .ddh-ring-bg{stroke:var(--bg-elevated,#1A2E38);}
  .ddh-ring .ddh-ring-fg{stroke:var(--accent-hydro,#38BDF8);transition:stroke-dashoffset .15s linear;}
  .ddh-ring.ready .ddh-ring-fg{stroke:var(--accent-primary,#F59E0B);}
  .ddh-ring-num{position:absolute;inset:0;display:grid;place-items:center;font:800 10px var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);color:var(--text-primary,#E6F0F2);}
  .ddh-ring-cap{font-size:6.5px;letter-spacing:.14em;color:var(--text-secondary,#8FA8B2);text-align:center;margin-top:2px;font-weight:800;}
  .ddh-dockbtn{display:flex;flex-direction:column;align-items:center;gap:2px;min-width:74px;padding:8px 10px;
    border-radius:var(--radius-md,8px);border:1px solid var(--border-subtle,rgba(148,210,230,.14));
    background:var(--bg-surface,#132229);color:var(--text-primary,#E6F0F2);cursor:pointer;}
  .ddh-dockbtn b{font-size:9px;letter-spacing:.1em;}
  .ddh-dockbtn span{font-size:7px;color:var(--text-secondary,#8FA8B2);font-variant-numeric:tabular-nums;}
  .ddh-dockbtn svg{width:18px;height:18px;}
  .ddh-dockbtn:disabled{opacity:.38;cursor:not-allowed;}
  /* Tactical rail (#panel) */
  #panel.dd-panel{position:relative;z-index:20;}
  #ddRail{display:flex;flex-direction:column;gap:10px;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));
    background:var(--bg-surface,#132229);border:1px solid var(--border-subtle,rgba(148,210,230,.14));
    border-radius:var(--radius-lg,12px);margin:8px;max-height:min(62vh,560px);overflow:auto;
    color:var(--text-primary,#E6F0F2);font-family:var(--font-sans,'Plus Jakarta Sans','Inter','Segoe UI',system-ui,sans-serif);}
  #ddRail.collapsed .ddh-rail-body{display:none;}
  .ddh-rail-handle{display:flex;align-items:center;justify-content:space-between;gap:10px;background:transparent;
    border:0;border-bottom:1px solid var(--border-subtle,rgba(148,210,230,.14));padding:2px 2px 8px;cursor:pointer;color:var(--text-primary,#E6F0F2);text-align:left;width:100%;}
  .ddh-rail-handle .ddh-rail-title{font-size:9px;letter-spacing:.18em;font-weight:800;color:var(--text-secondary,#8FA8B2);}
  .ddh-rail-handle .ddh-chev{color:var(--accent-primary,#F59E0B);font-size:12px;}
  .ddh-districts{display:flex;flex-direction:column;gap:6px;}
  .ddh-district{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,2fr) auto;gap:8px;align-items:center;
    padding:6px 8px;border-radius:var(--radius-md,8px);border:1px solid var(--border-subtle,rgba(148,210,230,.14));
    background:var(--bg-body,#0B1519);cursor:pointer;color:inherit;text-align:left;width:100%;}
  .ddh-district[aria-pressed="true"]{border-color:var(--accent-primary,#F59E0B);box-shadow:0 0 0 1px var(--accent-primary,#F59E0B) inset;}
  .ddh-district-name{font-size:10px;font-weight:800;letter-spacing:.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .ddh-district-sub{font-size:7px;color:var(--text-secondary,#8FA8B2);font-variant-numeric:tabular-nums;}
  .ddh-meter{height:5px;border-radius:var(--radius-pill,999px);background:var(--bg-elevated,#1A2E38);overflow:hidden;}
  .ddh-meter i{display:block;height:100%;background:var(--status-safe,#10B981);}
  .ddh-meter i.l1{background:var(--status-warn,#F59E0B);}
  .ddh-meter i.l2{background:var(--status-danger,#EF4444);}
  .ddh-meter i.l3{background:var(--status-critical,#D946EF);}
  .ddh-risk{font:800 8px var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);letter-spacing:.1em;color:var(--text-secondary,#8FA8B2);}
  .ddh-protocols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;}
  .ddh-proto{display:flex;flex-direction:column;gap:2px;align-items:flex-start;padding:7px 9px;border-radius:var(--radius-md,8px);
    border:1px solid var(--border-subtle,rgba(148,210,230,.14));background:var(--bg-body,#0B1519);cursor:pointer;color:inherit;text-align:left;}
  .ddh-proto[aria-pressed="true"]{border-color:var(--accent-hydro,#38BDF8);background:rgba(56,189,248,.10);}
  .ddh-proto b{font-size:9.5px;letter-spacing:.04em;display:flex;align-items:center;gap:6px;}
  .ddh-proto b svg{width:14px;height:14px;}
  .ddh-proto span{font-size:7.5px;color:var(--text-secondary,#8FA8B2);font-variant-numeric:tabular-nums;}
  .ddh-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;}
  .ddh-action{display:flex;flex-direction:column;gap:2px;align-items:flex-start;padding:7px 9px;border-radius:var(--radius-md,8px);
    border:1px solid var(--border-subtle,rgba(148,210,230,.14));background:var(--bg-body,#0B1519);cursor:pointer;color:inherit;text-align:left;}
  .ddh-action[aria-pressed="true"]{border-color:var(--accent-primary,#F59E0B);background:rgba(245,158,11,.10);}
  .ddh-action:disabled{opacity:.4;cursor:not-allowed;}
  .ddh-action b{font-size:9.5px;}
  .ddh-action span{font-size:7.5px;color:var(--text-secondary,#8FA8B2);}
  .ddh-commit{margin-top:2px;display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:44px;
    border:0;border-radius:var(--radius-md,8px);background:var(--accent-primary,#F59E0B);color:var(--on-accent,#0A1317);
    font:800 12px var(--font-sans,'Plus Jakarta Sans','Inter','Segoe UI',system-ui,sans-serif);letter-spacing:.14em;
    text-transform:uppercase;cursor:pointer;box-shadow:var(--glow-amber,0 0 18px rgba(245,158,11,.25));}
  .ddh-commit:hover{filter:brightness(1.06);}
  .ddh-commit svg{width:18px;height:18px;}
  .ddh-commit:disabled{opacity:.45;cursor:not-allowed;box-shadow:none;}
  .ddh-kv{display:flex;justify-content:space-between;gap:8px;font-size:9px;color:var(--text-secondary,#8FA8B2);}
  .ddh-kv b{font-family:var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);color:var(--text-primary,#E6F0F2);font-variant-numeric:tabular-nums;}
  .ddh-event{border:1px solid var(--border-strong,#2E4D5B);border-left:3px solid var(--accent-hydro,#38BDF8);
    border-radius:var(--radius-md,8px);padding:7px 9px;background:var(--bg-elevated,#1A2E38);}
  .ddh-event b{font-size:9px;letter-spacing:.08em;color:var(--accent-hydro,#38BDF8);}
  .ddh-event p{margin:3px 0 0;font-size:10px;line-height:1.45;color:var(--text-primary,#E6F0F2);}
  /* Toast + banner */
  #toast.dd-toast{position:fixed;left:50%;bottom:calc(96px + env(safe-area-inset-bottom,0px));transform:translate(-50%,14px);
    z-index:70;max-width:min(480px,92vw);padding:9px 16px;border-radius:var(--radius-md,8px);
    background:var(--bg-elevated,#1A2E38);border:1px solid var(--border-strong,#2E4D5B);color:var(--text-primary,#E6F0F2);
    font-size:12px;font-weight:600;text-align:center;opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;
    box-shadow:var(--shadow-panel,0 12px 32px rgba(0,0,0,.45));}
  #toast.dd-toast.show{opacity:1;transform:translate(-50%,0);}
  #toast.dd-toast.warn{border-color:var(--status-warn,#F59E0B);color:var(--status-warn,#F59E0B);}
  #toast.dd-toast.danger{border-color:var(--status-danger,#EF4444);color:var(--status-danger,#EF4444);}
  #toast.dd-toast.ok{border-color:var(--status-safe,#10B981);color:var(--status-safe,#10B981);}
  #banner.dd-banner{position:fixed;top:calc(64px + env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);
    z-index:65;max-width:min(560px,94vw);padding:10px 22px;border-radius:var(--radius-md,8px);text-align:center;
    opacity:1;pointer-events:none;
    background:rgba(217,70,239,.16);border:1px solid var(--status-critical,#D946EF);color:#F5C2FE;
    font:800 13px var(--font-sans,'Plus Jakarta Sans','Inter','Segoe UI',system-ui,sans-serif);letter-spacing:.18em;
    text-transform:uppercase;box-shadow:var(--shadow-panel,0 12px 32px rgba(0,0,0,.45));}
  #banner.dd-banner.hidden{display:none !important;}
  #banner.dd-banner.warn{background:rgba(245,158,11,.14);border-color:var(--status-warn,#F59E0B);color:#FDE68A;}
  #banner.dd-banner.danger{background:rgba(239,68,68,.15);border-color:var(--status-danger,#EF4444);color:#FCA5A5;}
  @media (prefers-reduced-motion: reduce){.ddh-fill,.ddh-combo .ddh-ring-fg,.ddh-ring .ddh-ring-fg{transition:none;}}
  @media (max-width:900px){
    #hud.dd-hud{min-height:52px;max-height:none;flex-wrap:wrap;row-gap:6px;padding:6px 8px;}
    .ddh-gauge{min-width:120px;}
    .ddh-badge small{display:none;}
    .ddh-epikd .ddh-epikd-word{display:none;}
    #ddRail{max-height:44vh;}
  }`;
  d.head ? d.head.appendChild(style) : d.body && d.body.appendChild(style);
}

/* Hide (never remove) any element we did not create inside a container, so a
   partially-built W3-A shell or the legacy DOM never double-renders. */
function supersedeForeignChildren(container) {
  if (!container) return;
  const children = Array.from(container.children || []);
  for (const child of children) {
    if (child && child.getAttribute && child.getAttribute('data-dd') === 'keep') continue;
    if (child && child.id === 'toast') continue;
    if (child && child.id === 'banner') continue;
    child.classList.add('dd-superseded');
    child.style.display = 'none';
    child.setAttribute('aria-hidden', 'true');
  }
}

function markKeep(node) {
  if (node && node.setAttribute) node.setAttribute('data-dd', 'keep');
  return node;
}

/* ------------------------------------------------------- scaffold builders */
function ensureHudScaffold() {
  const d = doc();
  if (!d) return null;
  const hud = d.getElementById('hud');
  if (!hud) return null;
  hud.classList.add('dd-hud');
  supersedeForeignChildren(hud);

  let left = hud.querySelector(':scope > #ddHudLeft');
  let center = hud.querySelector(':scope > #ddHudCenter');
  let right = hud.querySelector(':scope > #ddHudRight');

  if (!left) { left = markKeep(el('div', 'ddh-cluster ddh-left', { id: 'ddHudLeft' })); hud.appendChild(left); }
  if (!center) { center = markKeep(el('div', 'ddh-cluster ddh-center', { id: 'ddHudCenter' })); hud.appendChild(center); }
  if (!right) { right = markKeep(el('div', 'ddh-cluster ddh-right', { id: 'ddHudRight' })); hud.appendChild(right); }
  return { hud, left, center, right };
}

function ensurePanelScaffold() {
  const d = doc();
  if (!d) return null;
  const panel = d.getElementById('panel');
  if (!panel) return null;
  panel.classList.add('dd-panel');
  supersedeForeignChildren(panel);
  let rail = panel.querySelector(':scope > #ddRail');
  if (!rail) {
    rail = markKeep(el('section', '', { id: 'ddRail', role: 'complementary', 'aria-label': 'Field command rail' }));
    panel.appendChild(rail);
  }
  return { panel, rail };
}

function ensureDock() {
  const d = doc();
  if (!d) return null;
  let dock = d.getElementById('ddDock');
  if (!dock) {
    dock = el('div', '', { id: 'ddDock', role: 'group', 'aria-label': L('Field gadget dock', 'Dok gadget lapangan') });
    (d.body || d.documentElement).appendChild(dock);
  }
  return dock;
}

function ensureToast() {
  const d = doc();
  if (!d) return null;
  let toast = d.getElementById('toast');
  if (!toast) {
    toast = el('div', '', { id: 'toast', role: 'status', 'aria-live': 'polite' });
    (d.body || d.documentElement).appendChild(toast);
  }
  toast.classList.add('dd-toast');
  return toast;
}

/* Banner starts hidden until the first banner() call fills it. */

function ensureBanner() {
  const d = doc();
  if (!d) return null;
  let banner = d.getElementById('banner');
  const created = !banner;
  if (!banner) {
    banner = el('div', '', { id: 'banner', role: 'alert' });
    (d.body || d.documentElement).appendChild(banner);
  }
  banner.classList.add('dd-banner');
  if (created || !String(banner.textContent || '').trim()) banner.classList.add('hidden');
  return banner;
}

/* ------------------------------------------------------------- mode sniff */
function bodyMode() {
  const d = doc();
  const cl = d && d.body && d.body.classList;
  if (!cl) return null;
  if (cl.contains('mode-blitz')) return 'blitz';
  if (cl.contains('mode-crisis-board') || cl.contains('mode-crisis_board')) return 'crisis_board';
  if (cl.contains('mode-operations')) return 'operations';
  return null;
}

function detectMode(snapshot) {
  const fromBody = bodyMode();
  if (fromBody) return fromBody;
  if (snapshot) {
    if (snapshot.mode === 'blitz' || snapshot.id === 'blitz') return 'blitz';
    if (snapshot.mode === 'crisis_board' || snapshot.id === 'crisis_board') return 'crisis_board';
    if (snapshot.mode === 'operations' || snapshot.id === 'operations') return 'operations';
    if (snapshot.timeLeftStr !== undefined || snapshot.durationSec !== undefined) return 'blitz';
    if (snapshot.week !== undefined || snapshot.totalWeeks !== undefined) return 'crisis_board';
  }
  return 'operations';
}

function detectPhase(snapshot, mode) {
  if (!snapshot) return 'idle';
  if (mode === 'blitz') return snapshot.status || snapshot.phase || 'playing';
  return snapshot.phase || 'idle';
}

const isPlanningPhase = (mode, phase) => {
  if (mode === 'crisis_board') return phase !== 'over';
  if (mode === 'operations') return phase === 'briefing' || phase === 'plan' || phase === 'report' || phase === 'perk';
  return false;
};
const isWavePhase = (mode, phase) => mode === 'operations' && phase === 'wave';

/* ---------------------------------------------------- normalised vitals */
function vitals(snapshot) {
  const s = snapshot || {};
  const icuLoad = Number(s.icuLoad ?? s.hospitalLoad ?? 0);
  const icuCap = Number(s.icuCap ?? s.hospitalCap ?? s.hospitalEffectiveCap ?? 0);
  const pct = s.icuPct != null
    ? Number(s.icuPct)
    : (s.hospitalPct != null ? Number(s.hospitalPct) * 100 : (icuCap > 0 ? (icuLoad / icuCap) * 100 : 0));
  const score = Number(s.score ?? 0);
  const funds = s.funds != null ? Number(s.funds) : null;
  const ap = s.ap != null ? Number(s.ap) : null;
  const maxAp = s.maxAp != null ? Number(s.maxAp) : null;
  const comboMult = Number(s.comboMult ?? s.comboTier ?? 1) || 1;
  const comboTimer = Number(s.comboWindow ?? s.comboTimer ?? 0);
  const comboTimerMax = Number(s.comboTimerMax ?? 1) || 1;
  const comboFrac = comboTimerMax > 0 ? clamp01(comboTimer / comboTimerMax) : 0;
  return { icuLoad, icuCap, pct: clamp(pct, 0, 100), score, funds, ap, maxAp, comboMult, comboFrac, comboTimer };
}

function fillClass(pct) {
  if (pct >= 100) return 'critical';
  if (pct >= 75) return 'danger';
  if (pct >= 50) return 'warn';
  return '';
}

function threatLevel(tier, maxTier) {
  const t = Number(tier) || 0;
  if (maxTier && maxTier > 0) return clamp(Math.round((t / maxTier) * 3), 0, 3);
  if (t >= 3) return 3;
  if (t >= 2) return 2;
  if (t >= 1) return 1;
  return 0;
}

/* ================================================================ RENDER */
let lastSnapshot = null;
const boundRoots = new WeakSet();
const panelState = { collapsed: false };
let currentHandlers = {};

export function renderHud(snapshot) {
  const d = doc();
  if (!d) return false;
  if (!snapshot || typeof snapshot !== 'object') return false;
  lastSnapshot = snapshot;
  ensureStyle();
  const scaffold = ensureHudScaffold();
  if (!scaffold) return false;
  const { left, center, right } = scaffold;

  const mode = detectMode(snapshot);
  const phase = detectPhase(snapshot, mode);
  const isBlitz = mode === 'blitz';
  const planning = isPlanningPhase(mode, phase);
  const wave = isWavePhase(mode, phase);

  /* ---- Panel visibility choreography ---- */
  const panelEl = d.getElementById('panel');
  const dock = ensureDock();
  if (isBlitz || wave) {
    if (panelEl) { panelEl.classList.add('hidden'); panelEl.setAttribute('aria-hidden', 'true'); }
  } else {
    if (panelEl) { panelEl.classList.remove('hidden'); panelEl.removeAttribute('aria-hidden'); }
  }
  if (dock) dock.style.display = wave ? 'flex' : 'none';

  /* ---- LEFT CLUSTER ---- */
  left.textContent = '';
  const modeMeta = {
    operations: { icon: 'vec-monsoon-cloud', name: t('hub.mode1.name') },
    crisis_board: { icon: 'vec-clipboard-dossier', name: t('hub.mode2.name') },
    blitz: { icon: 'vec-blitz-bolt', name: t('hub.mode3.name') },
  }[mode] || { icon: 'vec-command-chevron', name: String(mode || 'OPS').toUpperCase() };
  const badge = el('div', 'ddh-badge', { role: 'status', 'aria-label': modeMeta.name });
  badge.innerHTML = `${iconSvg(modeMeta.icon)}<span>${esc(modeMeta.name.toUpperCase())}<small>${esc((L('FIELD COMMAND', 'KOMANDO LAPANGAN')).toUpperCase())}</small></span>`;
  left.appendChild(badge);

  let pillText = '';
  if (mode === 'operations') {
    const month = snapshot.monthLabel || 'NOV';
    const counter = snapshot.monthCounter ? ` · ${snapshot.monthCounter}` : '';
    pillText = `${month}${counter}`;
  } else if (mode === 'crisis_board') {
    pillText = t('hud.phase.week', { count: snapshot.week ?? 1 });
  } else {
    pillText = t('hud.phase.blitz');
  }
  const phaseLbl = mode === 'operations'
    ? ({ briefing: t('hud.phase.briefing'), plan: t('hud.phase.deployment'), wave: t('hud.phase.active'), report: t('hud.phase.triage'), perk: t('hud.phase.deployment') }[phase] || String(phase).toUpperCase())
    : (mode === 'crisis_board' ? String(phase).toUpperCase() : t('hud.phase.blitz'));
  left.appendChild(el('span', 'ddh-pill', { text: `${pillText}`, title: phaseLbl }));
  left.appendChild(el('span', 'ddh-pill', { text: phaseLbl }));

  const seedStr = snapshot.seedStr || (snapshot.replay && snapshot.replay.seedStr) || null;
  if (seedStr) {
    const seedBtn = el('button', 'ddh-pill ddh-seed', {
      type: 'button', text: `SEED ${String(seedStr).toUpperCase()}`, 'data-dd-action': 'copy-seed',
      'data-seed': String(seedStr), title: L('Copy seed', 'Salin kode'),
    });
    left.appendChild(seedBtn);
  }
  if (isBlitz) {
    const scorePill = el('span', 'ddh-pill', { title: t('hud.score') });
    scorePill.innerHTML = `<span class="ddh-lbl">${esc(t('hud.score').toUpperCase())}</span>${esc(fmtInt(snapshot.score))}`;
    left.appendChild(scorePill);
  }

  /* ---- CENTER CLUSTER ---- */
  center.textContent = '';
  const v = vitals(snapshot);

  const gauge = el('div', 'ddh-gauge', { role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(Math.max(1, Math.round(v.icuCap))), 'aria-valuenow': String(Math.round(v.icuLoad)), 'aria-label': t('hud.icuLoad') });
  const fillCls = fillClass(v.pct);
  gauge.innerHTML =
    `<div class="ddh-gauge-top"><span class="ddh-gauge-lbl">${esc(t('hud.icuLoad').toUpperCase())}</span>` +
    `<span class="ddh-gauge-val">${esc(fmtInt(v.icuLoad))}<em> / ${esc(fmtInt(v.icuCap))} · ${esc(Math.round(v.pct))}%</em></span></div>` +
    `<div class="ddh-track"><div class="ddh-fill ${fillCls}" style="width:${clamp(v.pct, 0, 100)}%"></div></div>`;
  center.appendChild(gauge);

  if (v.funds != null) {
    const fundsPill = el('span', 'ddh-pill', { title: t('hud.funds') });
    fundsPill.innerHTML = `<span class="ddh-lbl">${esc(t('hud.funds').toUpperCase())}</span>${esc(fmtInt(v.funds))}`;
    center.appendChild(fundsPill);
  }
  if (v.ap != null) {
    const apPill = el('span', 'ddh-pill', { title: t('hud.ap') });
    apPill.innerHTML = `<span class="ddh-lbl">${esc(t('hud.ap').toUpperCase())}</span>${esc(fmtInt(v.ap))}${v.maxAp != null ? `<em style="font-style:normal;color:var(--text-muted,#5B737E)"> / ${esc(fmtInt(v.maxAp))}</em>` : ''}`;
    center.appendChild(apPill);
  }
  if (!isBlitz && v.funds == null) {
    const scorePill = el('span', 'ddh-pill', { title: t('hud.score') });
    scorePill.innerHTML = `<span class="ddh-lbl">${esc(t('hud.score').toUpperCase())}</span>${esc(fmtInt(v.score))}`;
    center.appendChild(scorePill);
  }

  if (isBlitz) {
    const blitzBox = el('div', 'ddh-blitz', { role: 'timer', 'aria-label': t('hud.phase.blitz') });
    const timeStr = snapshot.timeLeftStr || '00:00';
    const late = Number(snapshot.timeLeft) <= 30;
    const stage = snapshot.stageLabel ? `<span class="ddh-lbl" style="font-size:7px;color:var(--text-secondary,#8FA8B2);letter-spacing:.14em;font-weight:800">${esc(String(snapshot.stageLabel).toUpperCase())}</span>` : '';
    blitzBox.innerHTML =
      `<div style="display:flex;flex-direction:column;align-items:center;gap:2px">${stage}` +
      `<div class="ddh-blitz-clock${late ? ' late' : ''}">${esc(timeStr)}</div></div>`;
    blitzBox.appendChild(el('button', 'ddh-spraytrig', {
      type: 'button', 'data-dd-action': 'spray',
      'aria-label': t('hud.spray'),
      html: `${iconSvg('vec-spray-canister')}<span>[SPACE] ${esc(t('hud.spray').toUpperCase())}</span>`,
    }));
    center.appendChild(blitzBox);
  }

  /* Combo ring when hot */
  if (v.comboMult > 1) {
    const R = 18, C = 2 * Math.PI * R;
    const off = C * (1 - clamp01(v.comboFrac));
    const combo = el('div', 'ddh-combo', { role: 'status', 'aria-label': t('hud.combo', { count: String(v.comboMult) }), title: t('hud.combo', { count: String(v.comboMult) }) });
    combo.innerHTML =
      `<svg viewBox="0 0 44 44" aria-hidden="true"><circle class="ddh-ring-bg" cx="22" cy="22" r="${R}" stroke-width="4" fill="none"/>` +
      `<circle class="ddh-ring-fg" cx="22" cy="22" r="${R}" stroke-width="4" fill="none" stroke-linecap="round" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/></svg>` +
      `<span class="ddh-combo-num">x${esc(String(v.comboMult))}</span>`;
    center.appendChild(combo);
  }

  /* ---- RIGHT CLUSTER ---- */
  right.textContent = '';
  const lang = getLang();
  const langWrap = el('div', 'ddh-lang', { role: 'group', 'aria-label': L('Language', 'Bahasa') });
  for (const code of ['en', 'id']) {
    const btn = el('button', '', {
      type: 'button', text: code.toUpperCase(), 'data-dd-action': 'set-lang', 'data-lang': code,
      'aria-pressed': code === lang ? 'true' : 'false', 'aria-label': code === 'en' ? 'English' : 'Bahasa Indonesia',
    });
    langWrap.appendChild(btn);
  }
  right.appendChild(langWrap);

  const audioOn = isAudioEnabled();
  right.appendChild(el('button', 'ddh-iconbtn', {
    type: 'button', 'data-dd-action': 'toggle-audio', 'aria-pressed': audioOn ? 'true' : 'false',
    'aria-label': L('Toggle sound', 'Suara hidup/mati'), title: L('Sound', 'Suara'),
    html: iconSvg(audioOn ? 'vec-audio-on' : 'vec-audio-off'),
  }));

  const hapticsOn = isHapticsEnabled();
  right.appendChild(el('button', 'ddh-iconbtn', {
    type: 'button', 'data-dd-action': 'toggle-haptics', 'aria-pressed': hapticsOn ? 'true' : 'false',
    'aria-label': L('Toggle haptics', 'Haptik hidup/mati'), title: L('Haptics', 'Haptik'),
    html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="18" rx="1.5"/><path d="M4.5 9.5a4 4 0 0 0 0 5M19.5 9.5a4 4 0 0 1 0 5M2 7a8.5 8.5 0 0 0 0 10M22 7a8.5 8.5 0 0 1 0 10"/></svg>',
  }));

  right.appendChild(el('button', 'ddh-epikd', {
    type: 'button', 'data-dd-action': 'open-epikd', 'aria-label': t('hud.epikd'),
    html: `${iconSvg('vec-lab-flask')}<span class="ddh-epikd-word">${esc(t('hud.epikd').toUpperCase())}</span>`,
  }));

  right.appendChild(el('button', 'ddh-iconbtn', {
    type: 'button', 'data-dd-action': 'pause', 'aria-label': t('hud.pause'), title: t('hud.pause'),
    html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9.5 6v12M14.5 6v12"/></svg>',
  }));

  /* ---- MODE-SPECIFIC SURFACES ---- */
  const panelScaffold = ensurePanelScaffold();
  if (planning && panelScaffold) {
    renderRail(panelScaffold.rail, snapshot, mode, phase);
  }
  if (wave && dock) {
    renderDock(dock, snapshot);
  } else if (dock && !isBlitz) {
    dock.style.display = 'none';
  }
  if (isBlitz && panelScaffold) {
    panelScaffold.rail.textContent = '';
  }

  /* wire delegated controls once per root */
  bindDelegated(scaffold.hud);
  if (panelScaffold) bindDelegated(panelScaffold.panel);
  if (dock) bindDelegated(dock);

  return true;
}

/* ---------------------------------------------------------------- rail */
function renderRail(rail, snapshot, mode, phase) {
  rail.textContent = '';
  rail.classList.toggle('collapsed', !!panelState.collapsed);

  const selectedId = snapshot.selectedDistrict || snapshot.selectedId || null;
  const districts = Array.isArray(snapshot.districts) ? snapshot.districts : [];

  const handle = el('button', 'ddh-rail-handle', {
    type: 'button', 'data-dd-action': 'toggle-panel', 'aria-expanded': panelState.collapsed ? 'false' : 'true',
    'aria-controls': 'ddRailBody',
  });
  const railTitle = mode === 'crisis_board'
    ? L('CRISIS ALLOCATION', 'ALOKASI KRISIS')
    : L('DEPLOYMENT PLAN', 'RENCANA PENGERAHAN');
  handle.innerHTML = `<span class="ddh-rail-title">${esc(railTitle)}</span><span class="ddh-chev">${panelState.collapsed ? '+' : '-'}</span>`;
  rail.appendChild(handle);

  const body = el('div', 'ddh-rail-body', { id: 'ddRailBody' });
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '10px';

  /* Incident / event card (crisis board) */
  if (mode === 'crisis_board' && snapshot.eventCard) {
    const ev = snapshot.eventCard;
    const card = el('div', 'ddh-event', { role: 'status' });
    card.innerHTML = `<b>${esc(String(ev.name || ev.id || '').toUpperCase())}</b><p>${esc(String(ev.desc || ''))}</p>`;
    body.appendChild(card);
  }

  /* District roster with threat meters */
  const list = el('div', 'ddh-districts', { role: 'listbox', 'aria-label': L('Districts', 'Wilayah') });
  const maxRisk = 3;
  for (const dstr of districts) {
    const id = dstr.id || '';
    const name = dstr.name || String(id).toUpperCase();
    const cases = dstr.cases ?? dstr.activeTx ?? 0;
    const riskTier = mode === 'crisis_board'
      ? clamp(Number(dstr.riskIndex ?? riskFromThreat(dstr)) || 0, 0, 3)
      : clamp(Number(dstr.risk) || 0, 0, maxRisk);
    const lvl = threatLevel(riskTier, maxRisk);
    const mit = dstr.mitigationPct != null ? Math.round(Number(dstr.mitigationPct)) : null;
    const selected = id === selectedId;
    const row = el('button', 'ddh-district', {
      type: 'button', role: 'option', 'aria-selected': selected ? 'true' : 'false',
      'aria-pressed': selected ? 'true' : 'false',
      'data-dd-action': 'select-district', 'data-district': String(id),
    });
    const meterPct = mode === 'crisis_board'
      ? clamp(Math.round(((Number(dstr.median) || 0) / Math.max(1, Number(dstr.endemicThreshold) || 1)) * 45), 4, 100)
      : clamp(((riskTier + 1) / 4) * 100, 8, 100);
    const riskName = dstr.riskName || dstr.threat || '';
    row.innerHTML =
      `<span><span class="ddh-district-name">${esc(String(name).toUpperCase())}</span><br>` +
      `<span class="ddh-district-sub">${esc(fmtInt(cases))} ${esc(L('cases', 'kasus'))}${mit != null ? ` · ${esc(t('hud.mitigation').toUpperCase())} ${esc(mit)}%` : ''}</span></span>` +
      `<span class="ddh-meter"><i class="l${lvl}" style="width:${meterPct}%"></i></span>` +
      `<span class="ddh-risk">${esc(String(riskName).toUpperCase())}</span>`;
    list.appendChild(row);
  }
  if (districts.length === 0) {
    list.appendChild(el('div', 'ddh-kv', { text: L('No district telemetry yet.', 'Belum ada telemetri wilayah.') }));
  }
  body.appendChild(list);

  if (mode === 'crisis_board') {
    /* AP economy + cordon readout */
    const kv = el('div', 'ddh-kv');
    kv.innerHTML =
      `<span>${esc(t('hud.ap').toUpperCase())}: <b>${esc(fmtInt(snapshot.ap))} / ${esc(fmtInt(snapshot.maxAp))}</b></span>` +
      `<span>${esc(L('CORDONS', 'SEKAT'))}: <b>${esc(String(snapshot.cordonActive ?? 0))} / ${esc(String(snapshot.cordonMax ?? 0))}</b></span>` +
      `<span>${esc(L('DEEP INTEL', 'INTEL'))}: <b>${esc(String(snapshot.deepIntelCharges ?? 0))}</b></span>`;
    body.appendChild(kv);

    /* Allocation actions (data-driven) */
    const actions = Array.isArray(snapshot.actions) ? snapshot.actions : [];
    const grid = el('div', 'ddh-actions', { role: 'group', 'aria-label': L('Allocate actions', 'Alokasi aksi') });
    for (const a of actions) {
      const disabled = a.cooldownReady === false || (a.disabledReason != null && a.disabledReason !== '') || (a.chargesLeft != null && a.chargesLeft <= 0);
      const btn = el('button', 'ddh-action', {
        type: 'button', 'data-dd-action': 'select-action', 'data-action': String(a.id || ''),
        'aria-pressed': a.selected ? 'true' : 'false',
        title: a.disabledReason ? String(a.disabledReason) : String(a.shortName || a.name || ''),
      });
      if (disabled) btn.setAttribute('disabled', 'disabled');
      const apCost = a.apCost != null ? `${a.apCost} AP` : '';
      const charges = a.chargesLeft != null ? ` · x${a.chargesLeft}` : '';
      btn.innerHTML = `<b>${esc(String(a.shortName || a.name || a.id || ''))}</b><span>${esc(apCost)}${esc(charges)}</span>`;
      grid.appendChild(btn);
    }
    body.appendChild(grid);

    if (phase === 'allocate' || phase === 'intel') {
      const commit = el('button', 'ddh-commit', {
        type: 'button', 'data-dd-action': 'commit', 'data-commit-mode': 'crisis_board',
      });
      commit.innerHTML = `${iconSvg('vec-defense-shield')}<span>${esc(t('hud.commitTurn'))}</span>`;
      body.appendChild(commit);
    }
  } else {
    /* Operations: selected district readout + protocol toggles */
    const sel = districts.find((x) => x && x.id === selectedId) || districts[0] || null;
    if (sel) {
      const kv = el('div', 'ddh-kv');
      const pred = sel.predMedian != null ? `${fmtInt(sel.predMedian)} (${fmtInt(sel.predLow)}-${fmtInt(sel.predHigh)})` : 'n/a';
      kv.innerHTML =
        `<span>${esc(L('FORECAST', 'PROYEKSI'))}: <b>${esc(pred)}</b></span>` +
        `<span>${esc(L('POOLS', 'GENANGAN'))}: <b>${esc(fmtInt(sel.pools))}</b></span>` +
        `<span>${esc(t('hud.mitigation').toUpperCase())}: <b>${sel.mitigationPct != null ? esc(Math.round(sel.mitigationPct)) + '%' : 'n/a'}</b></span>`;
      body.appendChild(kv);
    }

    const costs = snapshot.protocolCosts || {};
    const protoState = (sel && sel.protos) || {};
    const protocols = [
      { id: 'psn', icon: 'vec-broom-psn', label: L('PSN', 'PSN') },
      { id: 'traps', icon: 'vec-ovitrap', label: L('TRAPS', 'OVITRAP') },
      { id: 'fog', icon: 'vec-fogger', label: L('FOG', 'FOGGING') },
      { id: 'clinic', icon: 'vec-clinic-cross', label: L('CLINIC', 'POSKO') },
    ];
    const grid = el('div', 'ddh-protocols', { role: 'group', 'aria-label': L('Field protocols', 'Protokol lapangan') });
    for (const p of protocols) {
      const active = !!protoState[p.id];
      const cost = costs[p.id];
      const btn = el('button', 'ddh-proto', {
        type: 'button', 'data-dd-action': 'toggle-protocol', 'data-protocol': p.id,
        'data-district': selectedId ? String(selectedId) : '',
        'aria-pressed': active ? 'true' : 'false',
      });
      btn.innerHTML =
        `<b>${iconSvg(p.icon)}${esc(p.label)}</b>` +
        `<span>${cost != null ? esc(fmtInt(cost)) + ' ' + esc(t('hud.funds').toUpperCase()) : ''}</span>`;
      grid.appendChild(btn);
    }
    body.appendChild(grid);

    /* Surveillance ping (intel economy) */
    if (costs.ping != null || snapshot.pingCost != null) {
      const pingCost = costs.ping != null ? costs.ping : snapshot.pingCost;
      const ping = el('button', 'ddh-proto', {
        type: 'button', 'data-dd-action': 'ping', 'data-district': selectedId ? String(selectedId) : '',
        'aria-label': L('Surveillance sweep', 'Patroli surveilans'),
      });
      ping.innerHTML = `<b>${iconSvg('vec-radar-dish')}${esc(L('PING', 'PATROLI'))}</b><span>${esc(fmtInt(pingCost))} ${esc(t('hud.funds').toUpperCase())}</span>`;
      body.appendChild(ping);
    }

    if (phase === 'plan') {
      const commit = el('button', 'ddh-commit', {
        type: 'button', 'data-dd-action': 'commit', 'data-commit-mode': 'operations',
        title: t('hud.launchWave'),
      });
      commit.innerHTML = `${iconSvg('vec-command-chevron')}<span>${esc(t('hud.launchWave'))}</span>`;
      body.appendChild(commit);
    }
  }

  rail.appendChild(body);
}

function riskFromThreat(d) {
  /* Crisis-board snapshots carry threat as 0..100-ish or a tier; fold to 0-3. */
  const tval = Number(d && d.threat) || 0;
  if (tval >= 75) return 3;
  if (tval >= 50) return 2;
  if (tval >= 25) return 1;
  return 0;
}

/* ---------------------------------------------------------------- dock */
function renderDock(dock, snapshot) {
  dock.textContent = '';
  const charge = clamp(Number(snapshot.sprayCharge) || 0, 0, 100);
  const ready = !!snapshot.sprayReady || charge >= 100;
  const R = 24, C = 2 * Math.PI * R;
  const off = C * (1 - charge / 100);

  const ringWrap = el('div', `ddh-ring${ready ? ' ready' : ''}`, {
    role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(charge)),
    'aria-label': t('hud.spray'), title: `${t('hud.spray')} ${Math.round(charge)}%`,
  });
  ringWrap.innerHTML =
    `<svg viewBox="0 0 58 58" aria-hidden="true"><circle class="ddh-ring-bg" cx="29" cy="29" r="${R}" stroke-width="5" fill="none"/>` +
    `<circle class="ddh-ring-fg" cx="29" cy="29" r="${R}" stroke-width="5" fill="none" stroke-linecap="round" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/></svg>` +
    `<div><div class="ddh-ring-num">${ready ? esc(t('hud.sprayReady')) : esc(Math.round(charge) + '%')}</div></div>`;
  const ringCol = el('div', '', {});
  ringCol.style.display = 'flex';
  ringCol.style.flexDirection = 'column';
  ringCol.style.alignItems = 'center';
  ringCol.appendChild(ringWrap);
  ringCol.appendChild(el('div', 'ddh-ring-cap', { text: t('hud.spray').toUpperCase() }));
  dock.appendChild(ringCol);

  /* Spray trigger */
  const sprayBtn = el('button', 'ddh-dockbtn', {
    type: 'button', 'data-dd-action': 'spray', 'aria-label': t('hud.spray'),
    html: `${iconSvg('vec-spray-canister')}<b>${esc(t('hud.spray').toUpperCase())}</b><span>[SPACE]</span>`,
  });
  if (!ready) sprayBtn.setAttribute('data-not-ready', 'true');
  dock.appendChild(sprayBtn);

  /* Ward surge quick button */
  const surgeAvailable = !!snapshot.surgeWardAvailable;
  const surgeCost = snapshot.surgeWardCost != null ? snapshot.surgeWardCost : 3;
  const surgeRelief = snapshot.surgeWardRelief != null ? snapshot.surgeWardRelief : 25;
  const surgeBtn = el('button', 'ddh-dockbtn', {
    type: 'button', 'data-dd-action': 'surge-ward',
    'aria-label': `${L('Ward surge', 'Lonjakan posko')} (-${surgeRelief})`,
    html: `${iconSvg('vec-ward-tent')}<b>+${esc(fmtInt(surgeRelief))} ${esc(t('hud.beds').toUpperCase())}</b><span>${esc(fmtInt(surgeCost))} ${esc(t('hud.funds').toUpperCase())}</span>`,
  });
  if (!surgeAvailable) surgeBtn.setAttribute('disabled', 'disabled');
  dock.appendChild(surgeBtn);
}

/* --------------------------------------------------- panel collapse API */
export function setPanelCollapsed(collapsed) {
  panelState.collapsed = !!collapsed;
  const d = doc();
  if (!d) return panelState.collapsed;
  const rail = d.getElementById('ddRail');
  if (rail) {
    rail.classList.toggle('collapsed', panelState.collapsed);
    const handle = rail.querySelector('.ddh-rail-handle');
    if (handle) {
      handle.setAttribute('aria-expanded', panelState.collapsed ? 'false' : 'true');
      const chev = handle.querySelector('.ddh-chev');
      if (chev) chev.textContent = panelState.collapsed ? '+' : '-';
    }
  }
  return panelState.collapsed;
}

export function togglePanel() {
  return setPanelCollapsed(!panelState.collapsed);
}

/* ------------------------------------------------------ toast + banner */
let toastTimer = null;
export function toast(msg, kind) {
  const d = doc();
  if (!d) return false;
  const elToast = ensureToast();
  if (!elToast) return false;
  clearTimeout(toastTimer);
  elToast.textContent = String(msg ?? '');
  elToast.classList.remove('warn', 'danger', 'ok', 'err');
  const k = String(kind || '').toLowerCase();
  if (k) elToast.classList.add(k === 'error' ? 'danger' : k);
  elToast.classList.add('show');
  toastTimer = setTimeout(() => {
    elToast.classList.remove('show');
  }, 2500);
  return true;
}

export function banner(msg, kind) {
  const d = doc();
  if (!d) return false;
  const elBanner = ensureBanner();
  if (!elBanner) return false;
  const k = String(kind || '').toLowerCase();
  if (!msg || k === 'clear' || k === 'hide') {
    elBanner.classList.add('hidden');
    elBanner.setAttribute('aria-hidden', 'true');
    elBanner.textContent = '';
    return true;
  }
  elBanner.textContent = String(msg);
  elBanner.classList.remove('hidden', 'warn', 'danger');
  if (k === 'warn' || k === 'alert') elBanner.classList.add('warn');
  else if (k === 'danger' || k === 'critical') elBanner.classList.add('danger');
  elBanner.removeAttribute('aria-hidden');
  return true;
}

/* -------------------------------------------------------- bind + events */
export function bindHudControls(handlers) {
  currentHandlers = handlers && typeof handlers === 'object' ? { ...handlers } : {};
  const d = doc();
  if (d) {
    const hud = d.getElementById('hud');
    const panel = d.getElementById('panel');
    const dock = d.getElementById('ddDock');
    if (hud) bindDelegated(hud);
    if (panel) bindDelegated(panel);
    if (dock) bindDelegated(dock);
    /* Language hot-swap re-renders from the last snapshot */
    if (!win().__ddHudLangBound && typeof win().addEventListener === 'function') {
      win().addEventListener('dd:langchange', () => {
        if (lastSnapshot) { try { renderHud(lastSnapshot); } catch (e) { /* keep chrome stable */ } }
      });
      win().__ddHudLangBound = true;
    }
  }
  return true;
}

function bindDelegated(root) {
  if (!root || boundRoots.has(root)) return;
  boundRoots.add(root);
  root.addEventListener('click', (ev) => {
    const target = ev.target && ev.target.closest ? ev.target.closest('[data-dd-action]') : null;
    if (!target || !root.contains(target)) return;
    const action = target.getAttribute('data-dd-action');
    handleAction(action, target, ev);
  });
}

function callHandler(name, ...args) {
  const fn = currentHandlers && currentHandlers[name];
  if (typeof fn === 'function') {
    try { return fn(...args); } catch (e) { return undefined; }
  }
  return undefined;
}

function handleAction(action, target, ev) {
  switch (action) {
    case 'set-lang': {
      const code = target.getAttribute('data-lang');
      const lang = getLang();
      if (code && code !== lang) { toggleLanguage(); try { applyStaticI18n(); } catch (e) { /* keep chrome stable */ } }
      if (lastSnapshot) renderHud(lastSnapshot);
      callHandler('onLanguage', getLang());
      return;
    }
    case 'toggle-audio': {
      const next = !isAudioEnabled();
      setAudioEnabled(next);
      if (SFX && typeof SFX.play === 'function') { try { SFX.play('tap'); } catch (e) { /* optional */ } }
      if (lastSnapshot) renderHud(lastSnapshot);
      callHandler('onAudioToggle', next);
      return;
    }
    case 'toggle-haptics': {
      const next = !isHapticsEnabled();
      setHapticsEnabled(next);
      if (next) vibrate(30);
      if (lastSnapshot) renderHud(lastSnapshot);
      callHandler('onHapticsToggle', next);
      return;
    }
    case 'open-epikd': {
      const handled = callHandler('onEpikd');
      if (handled === undefined) dispatchDd('dd:open-epikd', {});
      return;
    }
    case 'pause': {
      const handled = callHandler('onPause');
      if (handled === undefined) dispatchDd('dd:pause', {});
      return;
    }
    case 'commit': {
      const mode = target.getAttribute('data-commit-mode') || detectMode(lastSnapshot);
      const handled = callHandler('onCommit', mode);
      if (handled === undefined) dispatchDd(mode === 'crisis_board' ? 'dd:commit-turn' : 'dd:commit-deployment', { mode });
      return;
    }
    case 'spray': {
      const handled = callHandler('onSpray');
      if (handled === undefined) dispatchDd('dd:spray-burst', {});
      if (SFX && typeof SFX.play === 'function') { try { SFX.play('spray'); } catch (e) { /* optional */ } }
      return;
    }
    case 'surge-ward': {
      const handled = callHandler('onSurgeWard');
      if (handled === undefined) dispatchDd('dd:surge-ward', {});
      return;
    }
    case 'select-district': {
      const districtId = target.getAttribute('data-district');
      const handled = callHandler('onDistrictSelect', districtId);
      if (handled === undefined) dispatchDd('dd:select-district', { districtId });
      if (lastSnapshot && Array.isArray(lastSnapshot.districts)) {
        lastSnapshot = { ...lastSnapshot, selectedDistrict: districtId };
        renderHud(lastSnapshot);
      }
      return;
    }
    case 'toggle-protocol': {
      const protocol = target.getAttribute('data-protocol');
      const districtId = target.getAttribute('data-district');
      const active = target.getAttribute('aria-pressed') === 'true';
      const handled = callHandler('onProtocolToggle', protocol, districtId, !active);
      if (handled === undefined) dispatchDd('dd:toggle-protocol', { protocol, districtId, active: !active });
      if (lastSnapshot && Array.isArray(lastSnapshot.districts)) {
        lastSnapshot = {
          ...lastSnapshot,
          districts: lastSnapshot.districts.map((x) => (x && x.id === districtId
            ? { ...x, protos: { ...(x.protos || {}), [protocol]: !active } }
            : x)),
        };
        renderHud(lastSnapshot);
      }
      return;
    }
    case 'select-action': {
      const actionId = target.getAttribute('data-action');
      const handled = callHandler('onActionSelect', actionId);
      if (handled === undefined) dispatchDd('dd:select-action', { actionId });
      if (lastSnapshot && Array.isArray(lastSnapshot.actions)) {
        lastSnapshot = {
          ...lastSnapshot,
          selectedAction: actionId,
          actions: lastSnapshot.actions.map((a) => (a ? { ...a, selected: a.id === actionId } : a)),
        };
        renderHud(lastSnapshot);
      }
      return;
    }
    case 'ping': {
      const districtId = target.getAttribute('data-district');
      const handled = callHandler('onPing', districtId);
      if (handled === undefined) dispatchDd('dd:ping', { districtId });
      return;
    }
    case 'toggle-panel': {
      togglePanel();
      callHandler('onTogglePanel', panelState.collapsed);
      return;
    }
    case 'copy-seed': {
      const seed = target.getAttribute('data-seed') || '';
      const w = win();
      let done = false;
      try {
        if (w && w.navigator && w.navigator.clipboard && typeof w.navigator.clipboard.writeText === 'function') {
          w.navigator.clipboard.writeText(seed);
          done = true;
        }
      } catch (e) { done = false; }
      toast(done ? `${L('Seed copied', 'Kode tersalin')}: ${seed}` : seed, 'ok');
      callHandler('onCopySeed', seed);
      return;
    }
    default:
      return;
  }
}
