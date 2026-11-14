/* ============================================================================
   Dengue Defense — Field Edition :: Modals & Screens
   Command Hub, doctrine select, monthly dispatch, triage report, perk pick,
   pause, badges, end-of-run debrief + leaderboard submission.

   Voice: Satgas DBD field command. Zero emojis. Zero disclaimers / no model
   math anywhere in this file (the optional '[ Audit in EpiKD Lab ]' pill on
   the report screen only dispatches 'dd:open-epikd-audit' for epikd-lab.js).
   All gameplay copy flows through t() from js/i18n.js; a tiny L(en,id) helper
   covers the few label atoms that have no key.

   Screens live in the shell (#hubScreen, #dispatchScreen, #reportScreen,
   #perkScreen, #pauseScreen, #badgeScreen, #leaderboardScreen, #endScreen).
   Missing screens are created on demand and given the canonical ID. Any
   legacy/foreign children we supersede are hidden, never removed.
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
import {
  MODES,
  DOCTRINES,
  MUTATORS,
  PERKS,
  ACHIEVEMENTS,
  randomSeedWord,
} from '../state.js';
import { iconSvg } from '../sprites.js';

/* ------------------------------------------------------------------ helpers */
const doc = () => (typeof document !== 'undefined' ? document : null);
const win = () => (typeof window !== 'undefined' ? window : null);
const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
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
const L = (en, id) => (getLang() === 'id' ? id : en);
const localName = (obj, lang) => {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  return obj[lang] || obj.en || obj.id || '';
};

function storageGet(key) {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch (e) { return null; }
}
function storageSet(key, value) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, value); } catch (e) { /* best effort */ }
}
function readBest(mode) {
  const raw = storageGet(`dd_best_${mode}`);
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}
function writeBest(mode, score) {
  const n = Number(score) || 0;
  if (n > readBest(mode)) storageSet(`dd_best_${mode}`, String(Math.round(n)));
}

function dispatchDd(name, detail) {
  const w = win();
  if (!w) return false;
  try {
    const Ctor = typeof w.CustomEvent === 'function' ? w.CustomEvent : null;
    const ev = Ctor ? new Ctor(name, { detail: detail || {} }) : null;
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

function ensureStyle() {
  const d = doc();
  if (!d) return;
  if (d.getElementById('dd-modal-style')) return;
  const style = d.createElement('style');
  style.id = 'dd-modal-style';
  style.textContent = `
  .ddm-hidden{display:none !important;}
  .overlay.ddm{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;
    padding:calc(18px + env(safe-area-inset-top,0px)) 16px calc(18px + env(safe-area-inset-bottom,0px));
    background:var(--bg-scrim,rgba(6,12,15,.78));overflow-y:auto;
    font-family:var(--font-sans,'Plus Jakarta Sans','Inter','Segoe UI',system-ui,sans-serif);color:var(--text-primary,#E6F0F2);}
  .ddm-sheet{width:100%;max-width:560px;max-height:100%;overflow-y:auto;background:var(--bg-surface,#132229);
    border:1px solid var(--border-strong,#2E4D5B);border-radius:var(--radius-lg,12px);
    box-shadow:var(--shadow-panel,0 12px 32px rgba(0,0,0,.45));padding:18px 18px 16px;position:relative;}
  .ddm-kicker{font-size:8.5px;letter-spacing:.2em;font-weight:800;color:var(--accent-hydro,#38BDF8);text-transform:uppercase;}
  .ddm-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;}
  .ddm-epikd{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:var(--radius-pill,999px);
    border:1px solid var(--accent-hydro,#38BDF8);background:transparent;color:var(--accent-hydro,#38BDF8);
    font-size:8px;font-weight:800;letter-spacing:.14em;cursor:pointer;}
  .ddm-epikd:hover{background:rgba(56,189,248,.12);}
  .ddm-title{font-size:34px;line-height:.98;letter-spacing:-.04em;font-weight:800;margin:2px 0 6px;}
  .ddm-title span{color:var(--accent-primary,#F59E0B);}
  .ddm-tag{font-size:10.5px;color:var(--text-secondary,#8FA8B2);margin:0 0 12px;letter-spacing:.03em;}
  .ddm-modes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:12px;}
  .ddm-mode{display:flex;flex-direction:column;gap:4px;align-items:flex-start;text-align:left;padding:10px 10px 9px;
    border-radius:var(--radius-md,8px);border:1px solid var(--border-subtle,rgba(148,210,230,.14));
    background:var(--bg-body,#0B1519);cursor:pointer;color:inherit;min-height:118px;}
  .ddm-mode[aria-pressed="true"]{border-color:var(--accent-primary,#F59E0B);box-shadow:0 0 0 1px var(--accent-primary,#F59E0B) inset,var(--glow-amber,0 0 18px rgba(245,158,11,.25));}
  .ddm-mode b{font-size:11px;letter-spacing:.03em;line-height:1.25;}
  .ddm-mode svg{width:20px;height:20px;color:var(--accent-primary,#F59E0B);}
  .ddm-mode small{font-size:7px;letter-spacing:.12em;color:var(--text-secondary,#8FA8B2);font-weight:700;text-transform:uppercase;}
  .ddm-mode p{margin:0;font-size:8.5px;line-height:1.4;color:var(--text-secondary,#8FA8B2);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;}
  .ddm-mode .ddm-mech{font-size:7px;letter-spacing:.08em;color:var(--accent-hydro,#38BDF8);font-weight:800;text-transform:uppercase;}
  .ddm-best{font:800 8px var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);color:var(--accent-primary,#F59E0B);
    border:1px solid var(--accent-primary,#F59E0B);border-radius:var(--radius-pill,999px);padding:1px 7px;letter-spacing:.06em;margin-top:auto;}
  .ddm-best.none{color:var(--text-muted,#5B737E);border-color:var(--border-strong,#2E4D5B);}
  .ddm-h{font-size:8px;letter-spacing:.18em;font-weight:800;color:var(--text-secondary,#8FA8B2);text-transform:uppercase;margin:10px 0 6px;}
  .ddm-doctrines{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;}
  .ddm-doctrine{display:flex;flex-direction:column;gap:3px;text-align:left;padding:9px 10px;border-radius:var(--radius-md,8px);
    border:1px solid var(--border-subtle,rgba(148,210,230,.14));background:var(--bg-body,#0B1519);cursor:pointer;color:inherit;}
  .ddm-doctrine[aria-pressed="true"]{border-color:var(--accent-hydro,#38BDF8);box-shadow:0 0 0 1px var(--accent-hydro,#38BDF8) inset;}
  .ddm-doctrine b{font-size:9px;letter-spacing:.04em;line-height:1.35;}
  .ddm-doctrine span{font-size:7.5px;line-height:1.45;color:var(--text-secondary,#8FA8B2);}
  .ddm-seedrow{display:flex;gap:8px;align-items:stretch;}
  .ddm-seed{flex:1;min-width:0;height:40px;padding:0 12px;border-radius:var(--radius-md,8px);
    border:1px dashed var(--border-strong,#2E4D5B);background:var(--bg-body,#0B1519);color:var(--text-primary,#E6F0F2);
    font:600 12px var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);letter-spacing:.08em;text-transform:uppercase;}
  .ddm-seed::placeholder{color:var(--text-muted,#5B737E);text-transform:none;font-family:var(--font-sans,'Plus Jakarta Sans','Inter','Segoe UI',system-ui,sans-serif);letter-spacing:0;font-weight:400;}
  .ddm-dice{display:inline-grid;place-items:center;width:44px;border:0;border-radius:var(--radius-md,8px);
    background:var(--bg-elevated,#1A2E38);color:var(--accent-primary,#F59E0B);cursor:pointer;border:1px solid var(--border-strong,#2E4D5B);}
  .ddm-dice:hover{border-color:var(--accent-primary,#F59E0B);}
  .ddm-dice svg{width:20px;height:20px;}
  .ddm-mut-toggle{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;
    background:var(--bg-body,#0B1519);border:1px solid var(--border-subtle,rgba(148,210,230,.14));border-radius:var(--radius-md,8px);
    padding:8px 12px;color:var(--text-primary,#E6F0F2);cursor:pointer;font-size:9px;letter-spacing:.14em;font-weight:800;text-transform:uppercase;}
  .ddm-mut-toggle em{font-style:normal;color:var(--accent-primary,#F59E0B);font-family:var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);}
  .ddm-muts{display:none;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:8px;}
  .ddm-muts.open{display:grid;}
  .ddm-mut{display:flex;gap:8px;align-items:flex-start;padding:8px 9px;border-radius:var(--radius-md,8px);
    border:1px solid var(--border-subtle,rgba(148,210,230,.14));background:var(--bg-body,#0B1519);cursor:pointer;}
  .ddm-mut input{margin-top:2px;accent-color:#F59E0B;}
  .ddm-mut b{display:block;font-size:8.5px;letter-spacing:.05em;}
  .ddm-mut span{display:block;font-size:7.5px;color:var(--text-secondary,#8FA8B2);line-height:1.4;margin-top:1px;}
  .ddm-mut em{font-style:normal;font-family:var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);color:var(--accent-primary,#F59E0B);font-size:7.5px;}
  .ddm-start{margin-top:14px;width:100%;min-height:52px;border:0;border-radius:var(--radius-md,8px);
    background:var(--accent-primary,#F59E0B);color:var(--on-accent,#0A1317);
    font:800 14px var(--font-sans,'Plus Jakarta Sans','Inter','Segoe UI',system-ui,sans-serif);letter-spacing:.2em;text-transform:uppercase;
    cursor:pointer;box-shadow:var(--glow-amber,0 0 18px rgba(245,158,11,.25));}
  .ddm-start:hover{filter:brightness(1.06);}
  /* Dispatch */
  .ddm-dcard{border:1px solid var(--border-strong,#2E4D5B);border-left:3px solid var(--accent-hydro,#38BDF8);
    border-radius:var(--radius-md,8px);padding:12px 14px;background:var(--bg-body,#0B1519);margin-bottom:12px;}
  .ddm-dcard h3{margin:0 0 6px;font-size:19px;line-height:1.25;letter-spacing:-.01em;}
  .ddm-dcard p{margin:0;font-size:11px;line-height:1.6;color:var(--text-secondary,#8FA8B2);}
  .ddm-count{height:5px;border-radius:var(--radius-pill,999px);background:var(--bg-elevated,#1A2E38);overflow:hidden;margin:10px 0 12px;border:1px solid var(--border-subtle,rgba(148,210,230,.14));}
  .ddm-count i{display:block;height:100%;width:100%;background:var(--accent-hydro,#38BDF8);transition:width .1s linear;}
  .ddm-opts{display:flex;flex-direction:column;gap:8px;}
  .ddm-opt{display:flex;gap:12px;align-items:flex-start;text-align:left;width:100%;padding:12px 12px;border-radius:var(--radius-md,8px);
    border:1px solid var(--border-subtle,rgba(148,210,230,.14));background:var(--bg-body,#0B1519);cursor:pointer;color:inherit;}
  .ddm-opt:hover{border-color:var(--accent-primary,#F59E0B);}
  .ddm-opt-key{font:800 11px var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);width:26px;height:26px;flex:0 0 auto;
    display:grid;place-items:center;border:1px solid var(--accent-hydro,#38BDF8);color:var(--accent-hydro,#38BDF8);border-radius:var(--radius-inner,4px);}
  .ddm-opt.b .ddm-opt-key{border-color:var(--accent-primary,#F59E0B);color:var(--accent-primary,#F59E0B);}
  .ddm-opt b{display:block;font-size:12.5px;line-height:1.35;}
  .ddm-opt span.d{display:block;font-size:9.5px;color:var(--text-secondary,#8FA8B2);line-height:1.5;margin-top:3px;}
  .ddm-hint{margin-top:10px;font-size:8px;letter-spacing:.16em;color:var(--text-muted,#5B737E);text-align:center;text-transform:uppercase;font-weight:800;}
  /* Report */
  .ddm-grade-wrap{display:flex;align-items:center;gap:14px;margin:6px 0 12px;}
  .ddm-grade{display:grid;place-items:center;width:64px;height:64px;border-radius:var(--radius-md,8px);
    border:2px solid var(--accent-primary,#F59E0B);color:var(--accent-primary,#F59E0B);
    font:800 34px var(--font-display,'Space Grotesk','Bahnschrift','Segoe UI',system-ui,sans-serif);}
  .ddm-grade.good{border-color:var(--status-safe,#10B981);color:var(--status-safe,#10B981);}
  .ddm-grade.mid{border-color:var(--status-warn,#F59E0B);color:var(--status-warn,#F59E0B);}
  .ddm-grade.bad{border-color:var(--status-danger,#EF4444);color:var(--status-danger,#EF4444);}
  .ddm-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-bottom:12px;}
  .ddm-stat{background:var(--bg-body,#0B1519);border:1px solid var(--border-subtle,rgba(148,210,230,.14));border-radius:var(--radius-md,8px);
    padding:8px 6px;text-align:center;}
  .ddm-stat b{display:block;font:700 15px var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);font-variant-numeric:tabular-nums;}
  .ddm-stat span{font-size:6.5px;letter-spacing:.12em;color:var(--text-secondary,#8FA8B2);font-weight:800;text-transform:uppercase;}
  .ddm-outcome{display:flex;flex-direction:column;gap:7px;border-block:1px solid var(--border-subtle,rgba(148,210,230,.14));padding:10px 2px;margin-bottom:12px;}
  .ddm-outcome-head{font-size:8px;letter-spacing:.18em;font-weight:800;color:var(--text-secondary,#8FA8B2);text-transform:uppercase;}
  .ddm-bar-row{display:grid;grid-template-columns:78px 1fr 52px;gap:8px;align-items:center;font-size:9px;}
  .ddm-bar-row span{color:var(--text-secondary,#8FA8B2);letter-spacing:.05em;font-weight:700;text-transform:uppercase;font-size:7.5px;}
  .ddm-bar-track{height:10px;border-radius:var(--radius-pill,999px);background:var(--bg-elevated,#1A2E38);overflow:hidden;}
  .ddm-bar-fill{height:100%;width:0%;}
  .ddm-bar-fill.base{background:#64748B;}
  .ddm-bar-fill.saved{background:var(--accent-bio,#2DD4BF);}
  .ddm-bar-fill.actual{background:var(--status-warn,#F59E0B);}
  .ddm-bar-row b{font:700 10px var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);text-align:right;font-variant-numeric:tabular-nums;}
  .ddm-audit{display:inline-flex;align-items:center;gap:6px;background:transparent;border:1px dashed var(--accent-hydro,#38BDF8);
    color:var(--accent-hydro,#38BDF8);border-radius:var(--radius-pill,999px);padding:5px 12px;font-size:8px;font-weight:800;
    letter-spacing:.12em;cursor:pointer;margin-bottom:10px;text-transform:uppercase;}
  .ddm-audit:hover{background:rgba(56,189,248,.12);}
  .ddm-continue{width:100%;min-height:46px;border:0;border-radius:var(--radius-md,8px);background:var(--accent-primary,#F59E0B);
    color:var(--on-accent,#0A1317);font:800 12px var(--font-sans,'Plus Jakarta Sans','Inter','Segoe UI',system-ui,sans-serif);
    letter-spacing:.16em;text-transform:uppercase;cursor:pointer;}
  /* Perks */
  .ddm-perks{display:flex;flex-direction:column;gap:8px;}
  .ddm-perk{display:flex;gap:12px;align-items:flex-start;text-align:left;width:100%;padding:12px;border-radius:var(--radius-md,8px);
    border:1px solid var(--border-subtle,rgba(148,210,230,.14));background:var(--bg-body,#0B1519);cursor:pointer;color:inherit;}
  .ddm-perk:hover{border-color:var(--accent-primary,#F59E0B);}
  .ddm-perk-key{font:800 11px var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);width:26px;height:26px;flex:0 0 auto;
    display:grid;place-items:center;border:1px solid var(--border-strong,#2E4D5B);color:var(--text-secondary,#8FA8B2);border-radius:var(--radius-inner,4px);}
  .ddm-perk b{display:block;font-size:12px;}
  .ddm-perk span{display:block;font-size:9.5px;color:var(--text-secondary,#8FA8B2);line-height:1.5;margin-top:2px;}
  /* Pause */
  .ddm-pause{display:flex;flex-direction:column;gap:8px;}
  .ddm-prow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 12px;
    border:1px solid var(--border-subtle,rgba(148,210,230,.14));border-radius:var(--radius-md,8px);background:var(--bg-body,#0B1519);}
  .ddm-prow span{font-size:10px;letter-spacing:.1em;font-weight:800;text-transform:uppercase;color:var(--text-secondary,#8FA8B2);}
  .ddm-prow button{height:28px;padding:0 12px;border-radius:var(--radius-pill,999px);border:1px solid var(--border-strong,#2E4D5B);
    background:transparent;color:var(--text-primary,#E6F0F2);font:800 9px var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);
    letter-spacing:.1em;cursor:pointer;}
  .ddm-prow button[aria-pressed="true"]{border-color:var(--status-safe,#10B981);color:var(--status-safe,#10B981);}
  .ddm-btn{width:100%;min-height:44px;border-radius:var(--radius-md,8px);border:1px solid var(--border-strong,#2E4D5B);
    background:var(--bg-elevated,#1A2E38);color:var(--text-primary,#E6F0F2);font:800 11px var(--font-sans,'Plus Jakarta Sans','Inter','Segoe UI',system-ui,sans-serif);
    letter-spacing:.14em;text-transform:uppercase;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;}
  .ddm-btn.primary{background:var(--accent-primary,#F59E0B);border-color:transparent;color:var(--on-accent,#0A1317);}
  .ddm-btn.ghost{background:transparent;}
  .ddm-btn.danger-text{color:var(--status-danger,#EF4444);border-color:rgba(239,68,68,.4);}
  /* Badges */
  .ddm-badges{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin:10px 0 12px;}
  .ddm-badge{display:flex;flex-direction:column;align-items:center;gap:5px;text-align:center;padding:12px 8px;
    border-radius:var(--radius-md,8px);border:1px solid var(--border-subtle,rgba(148,210,230,.14));background:var(--bg-body,#0B1519);}
  .ddm-badge svg{width:28px;height:28px;color:var(--accent-primary,#F59E0B);}
  .ddm-badge b{font-size:8.5px;letter-spacing:.06em;text-transform:uppercase;}
  .ddm-badge span{font-size:7.5px;color:var(--text-secondary,#8FA8B2);line-height:1.4;}
  .ddm-badge.locked{opacity:.35;}
  .ddm-badge.locked svg{color:var(--text-muted,#5B737E);}
  .ddm-badge em{font-style:normal;font-size:6px;letter-spacing:.16em;color:var(--text-muted,#5B737E);font-weight:800;text-transform:uppercase;}
  /* End */
  .ddm-end-title{font-size:28px;line-height:1.05;letter-spacing:-.03em;margin:2px 0 4px;font-weight:800;}
  .ddm-end-body{font-size:11px;color:var(--text-secondary,#8FA8B2);line-height:1.55;margin-bottom:12px;}
  .ddm-newbest{display:inline-block;margin-left:8px;padding:2px 8px;border-radius:var(--radius-pill,999px);
    background:var(--accent-primary,#F59E0B);color:var(--on-accent,#0A1317);font-size:8px;letter-spacing:.18em;
    font-weight:800;vertical-align:middle;text-transform:uppercase;}
  .ddm-breakdown{display:flex;flex-direction:column;border-block:1px solid var(--border-subtle,rgba(148,210,230,.14));
    padding:6px 0;margin-bottom:12px;}
  .ddm-bline{display:flex;justify-content:space-between;gap:12px;padding:4px 2px;font-size:10px;color:var(--text-secondary,#8FA8B2);}
  .ddm-bline b{font-family:var(--font-mono,'JetBrains Mono','Cascadia Mono','Consolas',monospace);color:var(--text-primary,#E6F0F2);font-variant-numeric:tabular-nums;}
  .ddm-lb{border:1px solid var(--border-strong,#2E4D5B);border-radius:var(--radius-md,8px);padding:12px;background:var(--bg-body,#0B1519);margin-top:12px;}
  .ddm-lb h3{margin:0 0 8px;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--text-secondary,#8FA8B2);}
  .ddm-lb-row{display:flex;gap:8px;}
  .ddm-lb-input{flex:1;min-width:0;height:38px;padding:0 12px;border-radius:var(--radius-md,8px);
    border:1px solid var(--border-strong,#2E4D5B);background:var(--bg-surface,#132229);color:var(--text-primary,#E6F0F2);
    font-size:12px;letter-spacing:.05em;}
  .ddm-lb-btn{height:38px;padding:0 14px;border:0;border-radius:var(--radius-md,8px);background:var(--accent-primary,#F59E0B);
    color:var(--on-accent,#0A1317);font-size:9px;font-weight:800;letter-spacing:.12em;cursor:pointer;text-transform:uppercase;}
  .ddm-lb-btn:disabled{opacity:.5;cursor:wait;}
  .ddm-lb-status{min-height:1.3em;margin-top:6px;font-size:9px;color:var(--text-secondary,#8FA8B2);}
  .ddm-lb-status.ok{color:var(--status-safe,#10B981);}
  .ddm-lb-status.err{color:var(--status-danger,#EF4444);}
  .ddm-lb-view{width:100%;margin-top:8px;min-height:36px;border-radius:var(--radius-md,8px);border:1px dashed var(--border-strong,#2E4D5B);
    background:transparent;color:var(--accent-hydro,#38BDF8);font-size:8.5px;letter-spacing:.16em;font-weight:800;cursor:pointer;text-transform:uppercase;}
  .ddm-close{position:absolute;top:10px;right:10px;width:34px;height:34px;border-radius:var(--radius-md,8px);
    border:1px solid var(--border-subtle,rgba(148,210,230,.14));background:transparent;color:var(--text-secondary,#8FA8B2);
    font-size:15px;cursor:pointer;display:grid;place-items:center;}
  .ddm-close:hover{color:var(--text-primary,#E6F0F2);border-color:var(--border-strong,#2E4D5B);}
  @media (max-width:720px){
    .ddm-modes{grid-template-columns:1fr;}
    .ddm-doctrines{grid-template-columns:1fr;}
    .ddm-stats{grid-template-columns:repeat(2,minmax(0,1fr));}
    .ddm-muts{grid-template-columns:1fr;}
  }`;
  d.head ? d.head.appendChild(style) : d.body && d.body.appendChild(style);
  bindEscape();
}

const SCREENS = ['hubScreen', 'doctrineScreen', 'dispatchScreen', 'reportScreen', 'perkScreen', 'pauseScreen', 'badgeScreen', 'endScreen', 'leaderboardScreen'];

const isVisible = (node) => !!node && !node.classList.contains('hidden') && !node.classList.contains('ddm-hidden');

function supersedeForeignChildren(container) {
  if (!container) return;
  for (const child of Array.from(container.children || [])) {
    if (child && child.getAttribute && child.getAttribute('data-dd') === 'keep') continue;
    child.classList.add('dd-superseded');
    child.style.display = 'none';
    child.setAttribute('aria-hidden', 'true');
  }
}
const markKeep = (node) => (node && node.setAttribute ? (node.setAttribute('data-dd', 'keep'), node) : node);

/* Ensure (get or create) a canonical screen element hosting our own sheet. */
function ensureScreen(id, label) {
  const d = doc();
  if (!d) return null;
  let screen = d.getElementById(id);
  if (!screen) {
    screen = el('section', 'overlay ddm hidden', { id, role: 'dialog', 'aria-modal': 'true', 'aria-label': label || id });
    (d.getElementById('app') || d.body || d.documentElement).appendChild(screen);
  }
  screen.classList.add('overlay', 'ddm');
  if (label) screen.setAttribute('aria-label', label);
  screen.setAttribute('role', 'dialog');
  screen.setAttribute('aria-modal', 'true');
  supersedeForeignChildren(screen);
  let sheet = screen.querySelector(':scope > [data-dd="keep"]');
  if (!sheet) {
    sheet = markKeep(el('div', 'ddm-sheet'));
    screen.appendChild(sheet);
  }
  return { screen, sheet };
}

function show(screenInfo) {
  if (!screenInfo) return false;
  screenInfo.screen.classList.remove('hidden', 'ddm-hidden');
  screenInfo.screen.removeAttribute('aria-hidden');
  screenInfo.screen.removeAttribute('hidden');
  try { screenInfo.screen.hidden = false; } catch (e) { /* old engines */ }
  return true;
}
function hide(screenOrId) {
  const d = doc();
  const node = typeof screenOrId === 'string' ? (d && d.getElementById(screenOrId)) : screenOrId;
  if (node) {
    node.classList.add('hidden');
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('hidden', '');
    try { node.hidden = true; } catch (e) { /* old engines */ }
  }
  return !!node;
}

/* ============================================================= HUB (markas) */
const MODE_KEY = { operations: 'mode1', crisis_board: 'mode2', blitz: 'mode3' };
const MODE_ICON = { operations: 'vec-monsoon-cloud', crisis_board: 'vec-clipboard-dossier', blitz: 'vec-blitz-bolt' };
const hubState = { mode: 'operations', doctrine: 'surveillance_directorate', mutators: [], scenario: null, seedStr: '' };

export function showHub(state) {
  const d = doc();
  if (!d) return false;
  ensureStyle();
  const opts = state && typeof state === 'object' ? state : {};
  hubState.mode = opts.mode && MODE_KEY[opts.mode] ? opts.mode : (hubState.mode || 'operations');
  hubState.doctrine = opts.doctrine || hubState.doctrine || 'surveillance_directorate';
  hubState.mutators = Array.isArray(opts.mutators) ? opts.mutators.slice() : [];
  hubState.scenario = opts.scenario || null;
  hubState.seedStr = opts.seedStr != null ? String(opts.seedStr) : '';

  const s = ensureScreen('hubScreen', t('hub.title'));
  if (!s) return false;
  const { screen, sheet } = s;
  const lang = getLang();
  const seedVal = esc(hubState.seedStr);

  const modeCards = MODES.map((m) => {
    const key = MODE_KEY[m.id] || 'mode1';
    const best = opts.bestScores && opts.bestScores[m.id] != null ? Number(opts.bestScores[m.id]) : readBest(m.id);
    const hasBest = Number.isFinite(best) && best > 0;
    const selected = m.id === hubState.mode;
    return (
      `<button class="ddm-mode" type="button" role="radio" aria-pressed="${selected ? 'true' : 'false'}" data-mode="${esc(m.id)}">` +
        iconSvg(MODE_ICON[m.id] || 'vec-command-chevron') +
        `<small>${esc(t(`hub.${key}.duration`))}</small>` +
        `<b>${esc(t(`hub.${key}.name`))}</b>` +
        `<p>${esc(t(`hub.${key}.desc`))}</p>` +
        `<span class="ddm-mech">${esc(t(`hub.${key}.mechanics`))}</span>` +
        `<span class="ddm-best${hasBest ? '' : ' none'}">${hasBest ? esc(t('hub.bestScore', { count: fmtInt(best) })) : esc(L('NO RECORDS YET', 'BELUM ADA REKOR'))}</span>` +
      `</button>`
    );
  }).join('');

  const doctrineCards = DOCTRINES.map((docTr) => {
    const selected = docTr.id === hubState.doctrine;
    return (
      `<button class="ddm-doctrine" type="button" role="radio" aria-pressed="${selected ? 'true' : 'false'}" data-doctrine="${esc(docTr.id)}">` +
        `<b>${esc(localName(docTr.name, lang))}</b>` +
        `<span>${esc(localName(docTr.summary, lang) || localName(docTr.identity, lang))}</span>` +
      `</button>`
    );
  }).join('');

  const mutatorRows = MUTATORS.map((mut) => {
    const checked = hubState.mutators.includes(mut.id) ? ' checked' : '';
    return (
      `<label class="ddm-mut"><input type="checkbox" data-mutator="${esc(mut.id)}"${checked}>` +
        `<span><b>${esc(t(`hub.mutator.${mut.id}.name`))} <em>x${esc(mut.mult)}</em></b>` +
        `<span>${esc(t(`hub.mutator.${mut.id}.desc`))}</span></span></label>`
    );
  }).join('');

  sheet.innerHTML =
    `<div class="ddm-top"><span class="ddm-kicker">${esc(L('SATGAS DBD · FIELD COMMAND', 'SATGAS DBD · KOMANDO LAPANGAN'))}</span>` +
      `<button class="ddm-epikd" type="button" data-act="epikd">${esc(t('hub.epikd').toUpperCase())}</button></div>` +
    `<h1 class="ddm-title">${esc(t('hub.title'))}<br><span>${esc(t('hub.edition').toUpperCase())}</span></h1>` +
    `<p class="ddm-tag">${esc(t('hub.tagline'))}</p>` +
    `<div class="ddm-h">${esc(L('OPERATION MODE', 'MODE OPERASI'))}</div>` +
    `<div class="ddm-modes" role="radiogroup" aria-label="${esc(L('Operation mode', 'Mode operasi'))}">${modeCards}</div>` +
    `<div class="ddm-h">${esc(t('hub.doctrine.label'))}</div>` +
    `<div class="ddm-doctrines" role="radiogroup" aria-label="${esc(t('hub.doctrine.label'))}">${doctrineCards}</div>` +
    `<div class="ddm-h">${esc(t('hub.seed.label'))}</div>` +
    `<div class="ddm-seedrow">` +
      `<input id="ddHubSeedInput" class="ddm-seed" type="text" maxlength="40" autocomplete="off" spellcheck="false" value="${seedVal}" placeholder="${esc(t('hub.seed.placeholder'))}" aria-label="${esc(t('hub.seed.label'))}">` +
      `<button id="hubSeedDice" class="ddm-dice" type="button" aria-label="${esc(t('hub.seed.random'))}" title="${esc(t('hub.seed.random'))}">${iconSvg('vec-rank-star')}</button>` +
    `</div>` +
    `<button class="ddm-mut-toggle" id="ddMutToggle" type="button" aria-expanded="false" aria-controls="ddMutDrawer">` +
      `<span>${esc(t('hub.mutators.label'))} <em id="ddMutCount">0</em></span><span id="ddMutChevron">+</span></button>` +
    `<div class="ddm-muts" id="ddMutDrawer">${mutatorRows}</div>` +
    `<p class="ddm-tag" style="margin:8px 2px 0;font-size:8px">${esc(t('hub.mutators.hint'))}</p>` +
    `<button id="ddHubStart" class="ddm-start" type="button">${esc(t('hub.play'))}</button>`;

  /* Wire mode cards */
  sheet.querySelectorAll('.ddm-mode').forEach((btn) => {
    btn.addEventListener('click', () => {
      hubState.mode = btn.getAttribute('data-mode') || 'operations';
      sheet.querySelectorAll('.ddm-mode').forEach((b) => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
      if (SFX && typeof SFX.play === 'function') { try { SFX.play('tap'); } catch (e) { /* optional */ } }
    });
  });
  /* Wire doctrine cards */
  sheet.querySelectorAll('.ddm-doctrine').forEach((btn) => {
    btn.addEventListener('click', () => {
      hubState.doctrine = btn.getAttribute('data-doctrine') || 'surveillance_directorate';
      sheet.querySelectorAll('.ddm-doctrine').forEach((b) => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
      if (SFX && typeof SFX.play === 'function') { try { SFX.play('tap'); } catch (e) { /* optional */ } }
    });
  });
  /* Seed dice */
  const seedInput = sheet.querySelector('#ddHubSeedInput');
  const dice = sheet.querySelector('#hubSeedDice');
  if (dice && seedInput) {
    dice.addEventListener('click', () => {
      seedInput.value = randomSeedWord();
      seedInput.focus();
      if (SFX && typeof SFX.play === 'function') { try { SFX.play('coin'); } catch (e) { /* optional */ } }
    });
  }
  /* Mutator drawer */
  const mutToggle = sheet.querySelector('#ddMutToggle');
  const mutDrawer = sheet.querySelector('#ddMutDrawer');
  const mutCount = sheet.querySelector('#ddMutCount');
  const mutChevron = sheet.querySelector('#ddMutChevron');
  const refreshMutCount = () => {
    const n = sheet.querySelectorAll('input[data-mutator]:checked').length;
    if (mutCount) mutCount.textContent = String(n);
  };
  if (mutToggle && mutDrawer) {
    mutToggle.addEventListener('click', () => {
      const open = mutDrawer.classList.toggle('open');
      mutToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (mutChevron) mutChevron.textContent = open ? '-' : '+';
    });
    mutDrawer.addEventListener('change', refreshMutCount);
    refreshMutCount();
  }
  /* EpiKD pill */
  const epikdBtn = sheet.querySelector('[data-act="epikd"]');
  if (epikdBtn) {
    epikdBtn.addEventListener('click', () => {
      const handled = typeof opts.onEpikd === 'function' ? opts.onEpikd() : undefined;
      if (handled === undefined) dispatchDd('dd:open-epikd', {});
    });
  }
  /* START */
  const startBtn = sheet.querySelector('#ddHubStart');
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      const seedRaw = seedInput ? String(seedInput.value || '').trim().toUpperCase() : '';
      const seedStr = seedRaw || randomSeedWord();
      const mutators = Array.from(sheet.querySelectorAll('input[data-mutator]:checked')).map((n) => n.getAttribute('data-mutator')).filter(Boolean);
      const mode = hubState.mode;
      const modeDef = MODES.find((m) => m.id === mode) || MODES[0];
      const payload = {
        mode,
        doctrine: hubState.doctrine,
        scenario: hubState.scenario || (modeDef && modeDef.defaultScenario) || null,
        seedStr,
        mutators,
      };
      hubState.seedStr = seedStr;
      hubState.mutators = mutators;
      if (SFX && typeof SFX.play === 'function') { try { SFX.play('deploy'); } catch (e) { /* optional */ } }
      vibrate(30);
      if (typeof opts.onStart === 'function') {
        try { opts.onStart(payload); } catch (e) { /* host callback owns errors */ }
      }
      dispatchDd('dd:hub-start', payload);
      hideHub();
    });
  }

  show({ screen, sheet });
  return true;
}

export function hideHub() {
  return hide('hubScreen');
}

/* Standalone doctrine picker (optional surface; hub embeds one already). */
export function showDoctrineSelect(onPick) {
  const d = doc();
  if (!d) return false;
  ensureStyle();
  const s = ensureScreen('doctrineScreen', t('hub.doctrine.label'));
  if (!s) return false;
  const { sheet } = s;
  const lang = getLang();
  sheet.innerHTML =
    `<button class="ddm-close" type="button" data-act="close" aria-label="${esc(t('epikd.close'))}">x</button>` +
    `<div class="ddm-kicker">${esc(t('hub.doctrine.label'))}</div>` +
    `<h2 class="ddm-end-title" style="font-size:22px;margin:4px 0 10px">${esc(L('Choose your doctrine', 'Pilih doktrinmu'))}</h2>` +
    `<div class="ddm-doctrines" style="grid-template-columns:1fr">` +
    DOCTRINES.map((docTr) => (
      `<button class="ddm-doctrine" type="button" data-doctrine="${esc(docTr.id)}">` +
        `<b>${esc(localName(docTr.name, lang))}</b>` +
        `<span>${esc(localName(docTr.summary, lang) || localName(docTr.identity, lang))}</span>` +
      `</button>`
    )).join('') +
    `</div>`;
  const close = () => hide('doctrineScreen');
  sheet.querySelector('[data-act="close"]').addEventListener('click', close);
  sheet.querySelectorAll('.ddm-doctrine').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-doctrine');
      close();
      if (typeof onPick === 'function') {
        try { onPick(id); } catch (e) { /* host owns errors */ }
      }
      dispatchDd('dd:doctrine-pick', { doctrineId: id });
    });
  });
  show(s);
  return true;
}

/* ===================================================== DISPATCH (briefing) */
let dispatchTimer = null;
let dispatchKeyHandler = null;

export function showDispatch(directive, onChoose) {
  const d = doc();
  if (!d) return false;
  ensureStyle();
  const dir = directive && typeof directive === 'object' ? directive : {};
  const s = ensureScreen('dispatchScreen', L('Monthly dispatch', 'Laporan bulanan'));
  if (!s) return false;
  const { screen, sheet } = s;
  const options = Array.isArray(dir.options) ? dir.options.slice(0, 2) : [];
  while (options.length < 2) options.push({ id: options.length === 0 ? 'a' : 'b', label: '—', sub: '' });
  const seconds = clamp(Number(dir.timeLeft ?? dir.timeLimit ?? 10) || 10, 1, 60);

  sheet.innerHTML =
    `<div class="ddm-top"><span class="ddm-kicker">${esc(L('FIELD DISPATCH', 'LAPORAN LAPANGAN'))}</span>` +
      (dir.monthLabel ? `<span class="ddm-kicker" style="color:var(--text-secondary,#8FA8B2)">${esc(String(dir.monthLabel))}</span>` : '') + `</div>` +
    `<div class="ddm-dcard"><h3>${esc(String(dir.title || ''))}</h3><p>${esc(String(dir.body || ''))}</p></div>` +
    `<div class="ddm-count" aria-hidden="true"><i id="ddCountBar"></i></div>` +
    `<div class="ddm-opts">` +
    options.map((o, i) => {
      const letter = i === 0 ? 'A' : 'B';
      const sub = o.sub ?? o.desc ?? '';
      return `<button class="ddm-opt${i === 1 ? ' b' : ''}" type="button" data-option="${esc(String(o.id ?? letter.toLowerCase()))}" data-index="${i}">` +
        `<span class="ddm-opt-key">${i + 1}</span>` +
        `<span><b>${esc(String(o.label || ''))}</b>${sub ? `<span class="d">${esc(String(sub))}</span>` : ''}</span>` +
      `</button>`;
    }).join('') +
    `</div>` +
    `<div class="ddm-hint">${esc(L('PRESS 1 OR 2 TO DECIDE', 'TEKAN 1 ATAU 2 UNTUK MEMUTUSKAN'))}</div>`;

  const countBar = sheet.querySelector('#ddCountBar');
  const optButtons = Array.from(sheet.querySelectorAll('.ddm-opt'));

  const cleanup = () => {
    if (dispatchTimer) { clearInterval(dispatchTimer); dispatchTimer = null; }
    if (dispatchKeyHandler) {
      try { d.removeEventListener('keydown', dispatchKeyHandler, true); } catch (e) { /* ignore */ }
      dispatchKeyHandler = null;
    }
  };
  const choose = (index) => {
    cleanup();
    hide(screen);
    const picked = index == null || index < 0 ? null : options[index] || null;
    if (picked) dispatchDd('dd:directive-choice', { optionId: picked.id, index });
    if (typeof onChoose === 'function') {
      try { onChoose(picked); } catch (e) { /* host owns errors */ }
    }
    if (SFX && typeof SFX.play === 'function') { try { SFX.play(picked ? 'deploy' : 'deny'); } catch (e) { /* optional */ } }
  };

  optButtons.forEach((btn) => {
    btn.addEventListener('click', () => choose(Number(btn.getAttribute('data-index'))));
  });
  dispatchKeyHandler = (ev) => {
    const key = ev && ev.key;
    if (key === '1') { ev.preventDefault(); choose(0); }
    else if (key === '2') { ev.preventDefault(); choose(1); }
  };
  try { d.addEventListener('keydown', dispatchKeyHandler, true); } catch (e) { /* ignore */ }

  const start = Date.now();
  const total = seconds * 1000;
  if (countBar) countBar.style.width = '100%';
  dispatchTimer = setInterval(() => {
    const elapsed = Date.now() - start;
    const remain = Math.max(0, 1 - elapsed / total);
    if (countBar) countBar.style.width = `${(remain * 100).toFixed(1)}%`;
    if (remain <= 0) choose(null);
  }, 100);

  show(s);
  return true;
}

/* ================================================================= REPORT */
export function showReport(report, onContinue) {
  const d = doc();
  if (!d) return false;
  ensureStyle();
  const r = report && typeof report === 'object' ? report : {};
  const s = ensureScreen('reportScreen', t('end.stats.title'));
  if (!s) return false;
  const { screen, sheet } = s;

  const grade = String(r.grade || 'C').toUpperCase().slice(0, 1);
  const gradeCls = grade === 'S' || grade === 'A' ? 'good' : grade === 'B' ? 'mid' : 'bad';
  const bedsFreed = Number(r.bedsFreed) || 0;
  const bedsAdded = Number(r.bedsAdded) || 0;
  const prevented = Number(r.casesPreventedThisWave ?? r.casesPrevented) || 0;
  const refill = Number(r.budgetRefill) || 0;
  const icuLoad = Number(r.icuLoad) || 0;
  const icuCap = Number(r.icuCap) || 0;
  const baseline = Math.max(0, Number(r.baseline) || 0);
  const actual = Math.max(0, Number(r.totalCases) || 0);
  const maxBar = Math.max(baseline, actual, 1);
  const baseW = (baseline / maxBar) * 100;
  const savedW = clamp((prevented / maxBar) * 100, 0, 100);
  const actualW = (actual / maxBar) * 100;
  const monthLine = r.monthLabel
    ? `${String(r.monthLabel)}${r.monthIndex != null ? ` · ${Number(r.monthIndex) + 1}/${Number(r.monthTotal) || 6}` : ''}`
    : '';

  sheet.innerHTML =
    `<div class="ddm-top"><span class="ddm-kicker">${esc(L('TRIAGE REPORT', 'LAPORAN TRIASE'))}</span>` +
      (monthLine ? `<span class="ddm-kicker" style="color:var(--text-secondary,#8FA8B2)">${esc(monthLine)}</span>` : '') + `</div>` +
    `<div class="ddm-grade-wrap"><div class="ddm-grade ${gradeCls}">${esc(grade)}</div>` +
      `<div><div class="ddm-kicker" style="color:var(--text-secondary,#8FA8B2)">${esc(L('FIELD GRADE', 'GRADE LAPANGAN'))}</div>` +
      `<div class="ddm-end-title" style="font-size:20px;margin:2px 0 0">${esc(r.cleanMonth ? L('CLEAN SWEEP', 'SAPU BERSIH') : L('WAVE RESOLVED', 'GELOMBANG SELESAI'))}</div></div></div>` +
    `<div class="ddm-stats">` +
      `<div class="ddm-stat"><b>+${esc(fmtInt(bedsFreed))}</b><span>${esc(t('end.bedsFreed'))}</span></div>` +
      `<div class="ddm-stat"><b>+${esc(fmtInt(bedsAdded))}</b><span>${esc(L('BEDS ADDED', 'KASUR DITAMBAH'))}</span></div>` +
      `<div class="ddm-stat"><b>${esc(fmtInt(prevented))}</b><span>${esc(t('end.casesPrevented'))}</span></div>` +
      `<div class="ddm-stat"><b>+${esc(fmtInt(refill))}</b><span>${esc(t('hud.funds'))}</span></div>` +
    `</div>` +
    `<div class="ddm-outcome"><div class="ddm-outcome-head">${esc(L('Outbreak Outcome', 'Hasil Wabah'))}</div>` +
      `<div class="ddm-bar-row"><span>${esc(L('Baseline', 'Baseline'))}</span><div class="ddm-bar-track"><div class="ddm-bar-fill base" style="width:${baseW.toFixed(1)}%"></div></div><b>${esc(fmtInt(baseline))}</b></div>` +
      `<div class="ddm-bar-row"><span>${esc(L('Contained', 'Terkendali'))}</span><div class="ddm-bar-track"><div class="ddm-bar-fill saved" style="width:${savedW.toFixed(1)}%"></div></div><b>${esc(fmtInt(prevented))}</b></div>` +
      `<div class="ddm-bar-row"><span>${esc(L('Actual', 'Aktual'))}</span><div class="ddm-bar-track"><div class="ddm-bar-fill actual" style="width:${actualW.toFixed(1)}%"></div></div><b>${esc(fmtInt(actual))}</b></div>` +
    `</div>` +
    `<div class="ddm-kv" style="margin-bottom:8px"><span>${esc(t('hud.icuLoad').toUpperCase())}: <b>${esc(fmtInt(icuLoad))} / ${esc(fmtInt(icuCap))}</b></span></div>` +
    ((r.auditAvailable !== false)
      ? `<button class="ddm-audit" type="button" data-act="audit">${esc(r.auditPillLabel || '[ Audit in EpiKD Lab ]')}</button>`
      : '') +
    `<button id="ddReportContinue" class="ddm-continue" type="button">${esc(L('Continue', 'Lanjut'))}</button>`;

  const auditBtn = sheet.querySelector('[data-act="audit"]');
  if (auditBtn) {
    auditBtn.addEventListener('click', () => {
      const handled = typeof r.onAudit === 'function' ? r.onAudit() : undefined;
      if (handled === undefined) dispatchDd('dd:open-epikd-audit', { auditEvent: 'dd:open-epikd-audit' });
    });
  }
  const continueBtn = sheet.querySelector('#ddReportContinue');
  const proceed = () => {
    hide(screen);
    dispatchDd('dd:report-continue', { monthLabel: r.monthLabel || null });
    if (typeof onContinue === 'function') {
      try { onContinue(); } catch (e) { /* host owns errors */ }
    }
    if (SFX && typeof SFX.play === 'function') { try { SFX.play('report'); } catch (e) { /* optional */ } }
  };
  if (continueBtn) continueBtn.addEventListener('click', proceed);
  registerEnterSpace(screen, proceed);

  show(s);
  return true;
}

/* ================================================================= PERKS */
export function showPerkPick(perks, onPick) {
  const d = doc();
  if (!d) return false;
  ensureStyle();
  const s = ensureScreen('perkScreen', t('mode1.perk.title'));
  if (!s) return false;
  const { screen, sheet } = s;

  const list = (Array.isArray(perks) ? perks : []).slice(0, 3).map((p) => {
    if (typeof p === 'string') {
      const found = PERKS.find((x) => x.id === p);
      return found
        ? { id: found.id, name: t(`mode1.perk.${found.id}.name`), desc: t(`mode1.perk.${found.id}.desc`) }
        : { id: p, name: p, desc: '' };
    }
    const id = p && p.id;
    const hasPerk = id && PERKS.some((x) => x.id === id);
    return {
      id,
      name: hasPerk ? t(`mode1.perk.${id}.name`) : ((p && (p.name || p.id)) || ''),
      desc: hasPerk ? t(`mode1.perk.${id}.desc`) : ((p && p.desc) || ''),
    };
  });
  while (list.length < 3) list.push({ id: `empty_${list.length}`, name: '—', desc: '' });

  sheet.innerHTML =
    `<div class="ddm-top"><span class="ddm-kicker">${esc(L('FIELD PERKS', 'KEUNTUNGAN LAPANGAN'))}</span></div>` +
    `<h2 class="ddm-end-title" style="font-size:20px;margin:0 0 10px">${esc(t('mode1.perk.title'))}</h2>` +
    `<div class="ddm-perks">` +
    list.map((p, i) => (
      `<button class="ddm-perk" type="button" data-perk="${esc(String(p.id))}" data-index="${i}">` +
        `<span class="ddm-perk-key">${i + 1}</span>` +
        `<span><b>${esc(String(p.name))}</b><span>${esc(String(p.desc))}</span></span>` +
      `</button>`
    )).join('') +
    `</div>` +
    `<div class="ddm-hint">${esc(L('PRESS 1, 2 OR 3 TO SELECT', 'TEKAN 1, 2 ATAU 3 UNTUK MEMILIH'))}</div>`;

  const cleanup = () => {
    if (perkKeyHandler) {
      try { d.removeEventListener('keydown', perkKeyHandler, true); } catch (e) { /* ignore */ }
      perkKeyHandler = null;
    }
  };
  const pick = (index) => {
    const p = list[index];
    if (!p || String(p.id).startsWith('empty_')) return;
    cleanup();
    hide(screen);
    dispatchDd('dd:perk-pick', { perkId: p.id });
    if (typeof onPick === 'function') {
      try { onPick(p); } catch (e) { /* host owns errors */ }
    }
    if (SFX && typeof SFX.play === 'function') { try { SFX.play('combo'); } catch (e) { /* optional */ } }
  };
  sheet.querySelectorAll('.ddm-perk').forEach((btn) => {
    btn.addEventListener('click', () => pick(Number(btn.getAttribute('data-index'))));
  });
  perkKeyHandler = (ev) => {
    const i = ['1', '2', '3'].indexOf(ev && ev.key);
    if (i >= 0) { ev.preventDefault(); pick(i); }
  };
  try { d.addEventListener('keydown', perkKeyHandler, true); } catch (e) { /* ignore */ }

  show(s);
  return true;
}
let perkKeyHandler = null;

/* ================================================================= PAUSE */
let pauseCallbacks = { onResume: null, onQuit: null };

export function showPause(onResume, onQuit) {
  const d = doc();
  if (!d) return false;
  ensureStyle();
  pauseCallbacks = {
    onResume: typeof onResume === 'function' ? onResume : null,
    onQuit: typeof onQuit === 'function' ? onQuit : null,
  };
  const s = ensureScreen('pauseScreen', t('hud.pause'));
  if (!s) return false;
  const { screen, sheet } = s;
  const lang = getLang();
  const audioOn = isAudioEnabled();
  const hapticsOn = isHapticsEnabled();

  sheet.innerHTML =
    `<div class="ddm-top"><span class="ddm-kicker">${esc(L('STANDING BY', 'MENUNGGU'))}</span></div>` +
    `<h2 class="ddm-end-title">${esc(L('Command paused.', 'Komando dijeda.'))}</h2>` +
    `<p class="ddm-end-body">${esc(L('The field waits for your order.', 'Lapangan menunggu perintahmu.'))}</p>` +
    `<div class="ddm-pause">` +
      `<button class="ddm-btn primary" type="button" data-act="resume">${esc(L('Resume', 'Lanjutkan'))}</button>` +
      `<button class="ddm-btn" type="button" data-act="restart">${esc(L('Restart Operation', 'Ulangi Operasi'))}</button>` +
      `<div class="ddm-prow"><span>${esc(L('Audio', 'Audio'))}</span>` +
        `<button type="button" data-act="audio" aria-pressed="${audioOn ? 'true' : 'false'}">${audioOn ? 'ON' : 'OFF'}</button></div>` +
      `<div class="ddm-prow"><span>${esc(L('Haptics', 'Haptik'))}</span>` +
        `<button type="button" data-act="haptics" aria-pressed="${hapticsOn ? 'true' : 'false'}">${hapticsOn ? 'ON' : 'OFF'}</button></div>` +
      `<div class="ddm-prow"><span>${esc(L('Language', 'Bahasa'))}</span>` +
        `<button type="button" data-act="lang">${esc(lang === 'en' ? 'EN / ID' : 'ID / EN')}</button></div>` +
      `<button class="ddm-btn ghost" type="button" data-act="badges">${esc(L('Field Honors', 'Penghargaan Lapangan'))}</button>` +
      `<button class="ddm-btn danger-text" type="button" data-act="quit">${esc(L('End Campaign', 'Akhiri Kampanye'))}</button>` +
    `</div>`;

  const refreshLang = () => {
    const l = getLang();
    const langBtn = sheet.querySelector('[data-act="lang"]');
    if (langBtn) langBtn.textContent = l === 'en' ? 'EN / ID' : 'ID / EN';
  };
  sheet.querySelectorAll('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.getAttribute('data-act');
      if (act === 'resume') { hide(screen); if (pauseCallbacks.onResume) pauseCallbacks.onResume(); }
      else if (act === 'restart') { hide(screen); if (pauseCallbacks.onQuit) pauseCallbacks.onQuit('restart'); dispatchDd('dd:restart', {}); }
      else if (act === 'quit') { hide(screen); if (pauseCallbacks.onQuit) pauseCallbacks.onQuit('quit'); dispatchDd('dd:abandon', {}); }
      else if (act === 'audio') {
        const next = !isAudioEnabled();
        setAudioEnabled(next);
        btn.setAttribute('aria-pressed', next ? 'true' : 'false');
        btn.textContent = next ? 'ON' : 'OFF';
      } else if (act === 'haptics') {
        const next = !isHapticsEnabled();
        setHapticsEnabled(next);
        if (next) vibrate(30);
        btn.setAttribute('aria-pressed', next ? 'true' : 'false');
        btn.textContent = next ? 'ON' : 'OFF';
      } else if (act === 'lang') {
        toggleLanguage();
        try { applyStaticI18n(); } catch (e) { /* keep chrome stable */ }
        refreshLang();
        if (lastPauseRerender) lastPauseRerender();
      } else if (act === 'badges') {
        showBadges(resolveBadgesPayload());
      }
    });
  });
  lastPauseRerender = () => { try { showPause(onResume, onQuit); } catch (e) { /* keep stable */ } };

  show(s);
  return true;
}
let lastPauseRerender = null;

export function openPause(onResume, onQuit) {
  return showPause(onResume, onQuit);
}

function resolveBadgesPayload() {
  const w = win();
  try {
    const g = w && w.G;
    if (g && Array.isArray(g.badges)) return g.badges;
    if (g && g.achievements && Array.isArray(g.achievements)) return g.achievements;
  } catch (e) { /* fall through */ }
  return [];
}

/* ================================================================ BADGES */
export function showBadges(badges) {
  const d = doc();
  if (!d) return false;
  ensureStyle();
  const s = ensureScreen('badgeScreen', L('Field honors', 'Penghargaan lapangan'));
  if (!s) return false;
  const { screen, sheet } = s;

  let payload = badges;
  if (typeof payload === 'function') {
    try { payload = payload(); } catch (e) { payload = []; }
  }
  const unlocked = new Set();
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (typeof entry === 'string') unlocked.add(entry);
      else if (entry && entry.id) unlocked.add(entry.id);
      else if (entry && entry.badgeId) unlocked.add(entry.badgeId);
    }
  } else if (payload && typeof payload === 'object') {
    for (const key of Object.keys(payload)) if (payload[key]) unlocked.add(key);
  }

  const cells = ACHIEVEMENTS.map((a) => {
    const isOn = unlocked.has(a.id);
    const title = t(`badge.${a.id}.title`);
    const desc = t(`badge.${a.id}.desc`);
    return (
      `<div class="ddm-badge${isOn ? '' : ' locked'}" role="listitem" aria-label="${esc(title)}">` +
        iconSvg('vec-trophy-shield') +
        `<b>${esc(title)}</b>` +
        `<span>${esc(desc)}</span>` +
        (isOn ? '' : `<em>${esc(L('Locked', 'Terkunci'))}</em>`) +
      `</div>`
    );
  }).join('');

  sheet.innerHTML =
    `<button class="ddm-close" type="button" data-act="close" aria-label="${esc(t('epikd.close'))}">x</button>` +
    `<div class="ddm-top"><span class="ddm-kicker">${esc(L('FIELD HONORS', 'PENGHARGAAN LAPANGAN'))}</span>` +
      `<span class="ddm-kicker" style="color:var(--text-secondary,#8FA8B2)">${esc(String(unlocked.size))} / ${esc(String(ACHIEVEMENTS.length))}</span></div>` +
    `<h2 class="ddm-end-title" style="font-size:22px;margin:0 0 2px">${esc(L('Field honors.', 'Penghargaan lapangan.'))}</h2>` +
    `<div class="ddm-badges" role="list">${cells}</div>` +
    `<button class="ddm-btn ghost" type="button" data-act="close">${esc(t('epikd.close'))}</button>`;

  sheet.querySelectorAll('[data-act="close"]').forEach((btn) => btn.addEventListener('click', () => hide(screen)));
  show(s);
  return true;
}

/* ================================================================== END */
export function showEnd(result, onReplay) {
  const d = doc();
  if (!d) return false;
  ensureStyle();
  const r = result && typeof result === 'object' ? result : {};
  const s = ensureScreen('endScreen', t('end.stats.title'));
  if (!s) return false;
  const { screen, sheet } = s;

  const w = win();
  const g = (() => { try { return w && w.G; } catch (e) { return null; } })();
  const victory = r.victory != null ? !!r.victory
    : (typeof r.result === 'string' ? r.result === 'victory' : (g && g.result === 'victory') || false);
  const mode = r.mode || r.leaderboardMode || (g && g.mode) || 'operations';
  const score = Math.max(0, Math.round(Number(r.score ?? (g && g.score) ?? 0) || 0));
  const grade = r.grade ? String(r.grade).toUpperCase().slice(0, 2) : null;
  const seedStr = r.seedStr ?? (r.replay && r.replay.seedStr) ?? (g && (g.seedStr || g.seed)) ?? '';
  const doctrine = r.doctrine ?? (g && g.doctrine) ?? null;
  const scenario = r.scenario ?? (g && g.scenario) ?? null;
  const mutators = r.mutators ?? (g && g.mutators) ?? [];

  const prevBest = readBest(mode);
  const newBest = score > prevBest;
  if (newBest) writeBest(mode, score);
  const best = Math.max(prevBest, score);

  const title = r.title || (mode === 'crisis_board'
    ? (victory ? t('mode2.victory.title') : t('mode2.collapse.title'))
    : mode === 'blitz'
      ? (victory ? L('Storm Broken', 'Badai Patah') : L('The Swarm Prevails', 'Kawanan Menang'))
      : (victory ? t('end.victory.title') : t('end.defeat.title')));
  const body = r.body || (mode === 'crisis_board'
    ? (victory ? t('mode2.victory.body') : t('mode2.collapse.body'))
    : mode === 'blitz'
      ? (victory ? L('150 seconds survived. The corridor holds against the swarm.', '150 detik bertahan. Koridor bertahan menghadapi wabah.')
                 : L('Hospital capacity breached. The swarm overwhelms regional wards.', 'Kapasitas rumah sakit terlampaui. Kawanan vektor menembus pertahanan.'))
      : (victory ? t('end.victory.body') : t('end.defeat.body')));

  const stats = [
    { key: 'end.casesPrevented', value: r.casesPrevented ?? (g && g.casesPrevented) },
    { key: 'end.vectorsSwatted', value: r.vectorsSwatted ?? r.swatted ?? (g && g.swatted) },
    { key: 'end.poolsDrained', value: r.poolsDrained ?? (g && g.poolsDrained) },
    { key: 'end.bedsFreed', value: r.bedsFreed ?? r.peakHeadroom ?? (g && g.peakHeadroom) },
    { key: 'end.cleanMonths', value: r.cleanMonths ?? (g && g.cleanMonths) },
  ].filter((row) => row.value != null);

  /* Score breakdown lines: explicit list wins; otherwise auto-build for blitz */
  let breakdown = Array.isArray(r.breakdown) ? r.breakdown.slice() : [];
  if (breakdown.length === 0) {
    if (r.clearBonus) breakdown.push({ label: L('Clear bonus', 'Bonus tuntas'), value: `+${fmtInt(r.clearBonus)}` });
    if (r.unusedBedCapacity) breakdown.push({ label: L('Unused beds', 'Kasur tersisa'), value: `+${fmtInt(r.unusedBedCapacity)}` });
    if (r.peakCombo) breakdown.push({ label: L('Peak combo', 'Kombo puncak'), value: `x${Number(r.peakCombo).toFixed(1)}` });
    if (r.kills != null) breakdown.push({ label: L('Vectors down', 'Vektor tumbang'), value: fmtInt(r.kills) });
    if (r.survivalTime != null && !victory) breakdown.push({ label: L('Survived', 'Bertahan'), value: `${Math.round(Number(r.survivalTime) || 0)}s` });
  }
  breakdown = breakdown.filter((b) => b && (b.label != null));

  const gradeBlock = grade
    ? `<div class="ddm-grade-wrap"><div class="ddm-grade ${grade === 'S' || grade === 'A' ? 'good' : grade === 'B' ? 'mid' : 'bad'}">${esc(grade)}</div>` +
      `<div class="ddm-kicker" style="color:var(--text-secondary,#8FA8B2)">${esc(L('FIELD GRADE', 'GRADE LAPANGAN'))}</div></div>`
    : '';

  const statsGrid = stats.length
    ? `<div class="ddm-stats" style="grid-template-columns:repeat(auto-fit,minmax(96px,1fr))">` +
      stats.map((row) => `<div class="ddm-stat"><b>${esc(fmtInt(row.value))}</b><span>${esc(t(row.key))}</span></div>`).join('') +
      `</div>`
    : '';

  const breakdownBlock = breakdown.length
    ? `<div class="ddm-breakdown">` +
      breakdown.map((b) => `<div class="ddm-bline"><span>${esc(String(b.label))}</span><b>${esc(String(b.value))}</b></div>`).join('') +
      `<div class="ddm-bline" style="border-top:1px solid var(--border-subtle,rgba(148,210,230,.14));padding-top:6px"><span>${esc(t('end.score'))}</span><b>${esc(fmtInt(score))}</b></div>` +
      `</div>`
    : `<div class="ddm-breakdown"><div class="ddm-bline"><span>${esc(t('end.score'))}</span><b>${esc(fmtInt(score))}</b></div></div>`;

  sheet.innerHTML =
    `<div class="ddm-top"><span class="ddm-kicker">${esc(t('end.stats.title'))}</span>` +
      (seedStr ? `<span class="ddm-kicker" style="color:var(--text-secondary,#8FA8B2)">SEED ${esc(String(seedStr).toUpperCase())}</span>` : '') + `</div>` +
    `<h2 class="ddm-end-title">${esc(title)}${newBest ? `<span class="ddm-newbest">${esc(t('end.newBest'))}</span>` : ''}</h2>` +
    `<p class="ddm-end-body">${esc(body)}</p>` +
    gradeBlock +
    `<div class="ddm-stats" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:10px">` +
      `<div class="ddm-stat"><b>${esc(fmtInt(score))}</b><span>${esc(t('end.score'))}</span></div>` +
      `<div class="ddm-stat"><b>${esc(fmtInt(best))}</b><span>${esc(t('end.best'))}</span></div>` +
    `</div>` +
    statsGrid +
    breakdownBlock +
    `<div class="ddm-pause">` +
      `<button class="ddm-btn primary" type="button" data-replay="same-seed">${esc(t('end.playAgain'))}</button>` +
      `<button class="ddm-btn" type="button" data-replay="new-seed">${esc(t('end.newSeed'))}</button>` +
      `<button class="ddm-btn ghost" type="button" data-replay="hub">${esc(t('end.hub'))}</button>` +
    `</div>` +
    `<div class="ddm-lb" data-mode="${esc(String(mode))}">` +
      `<h3>${esc(t('lb.submit.prompt'))}</h3>` +
      `<div class="ddm-lb-row">` +
        `<input id="ddLbNameInput" class="ddm-lb-input" type="text" maxlength="24" autocomplete="off" spellcheck="false" placeholder="${esc(t('lb.submit.placeholder'))}" aria-label="${esc(t('lb.col.name'))}" value="${esc(storageGet('dd_lb_name') || '')}">` +
        `<button id="ddLbSubmitBtn" class="ddm-lb-btn" type="button">${esc(t('lb.submit.button'))}</button>` +
      `</div>` +
      `<div id="ddLbStatusMsg" class="ddm-lb-status" role="status" aria-live="polite"></div>` +
      `<button id="ddViewLeaderboard" class="ddm-lb-view" type="button">${esc(t('lb.title'))}</button>` +
    `</div>`;

  /* Replay buttons */
  sheet.querySelectorAll('[data-replay]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.getAttribute('data-replay');
      if (kind === 'same-seed') dispatchDd('dd:replay-same-seed', { seedStr, mode });
      else if (kind === 'new-seed') dispatchDd('dd:replay-new-seed', { mode });
      else dispatchDd('dd:return-hub', {});
      if (typeof onReplay === 'function') {
        try { onReplay(kind, { seedStr, mode }); } catch (e) { /* host owns errors */ }
      }
    });
  });

  /* Leaderboard submission block */
  const nameInput = sheet.querySelector('#ddLbNameInput');
  const submitBtn = sheet.querySelector('#ddLbSubmitBtn');
  const statusEl = sheet.querySelector('#ddLbStatusMsg');
  const viewBtn = sheet.querySelector('#ddViewLeaderboard');
  const setStatus = (msg, cls) => {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.remove('ok', 'err');
    if (cls) statusEl.classList.add(cls);
  };
  const doSubmit = () => {
    if (!nameInput || !submitBtn) return;
    const name = String(nameInput.value || '').trim().slice(0, 24);
    if (!name) { setStatus(L('Enter a callsign.', 'Isi nama panggilan.'), 'err'); nameInput.focus(); return; }
    storageSet('dd_lb_name', name);
    submitBtn.disabled = true;
    setStatus(t('lb.submit.sending'));
    const lbPending = (() => { try { return w && w.LB_PENDING_SCORE; } catch (e) { return undefined; } })();
    const payload = {
      name,
      score: Number.isFinite(Number(lbPending)) && Number(lbPending) > 0 ? Math.round(Number(lbPending)) : score,
      mode,
      doctrine: doctrine || '',
      scenario: scenario || '',
      seed: seedStr,
      mutators,
      months: Number(r.months) || 0,
    };
    const finishOk = (rank) => {
      setStatus(rank ? t('lb.submit.success', { count: rank }) : t('lb.rank.field'), 'ok');
      submitBtn.disabled = false;
    };
    const finishErr = () => {
      setStatus(t('lb.submit.error'), 'err');
      submitBtn.disabled = false;
    };
    const viaGlobal = () => {
      /* Fallback: raw LB_API fetch if the module import fails entirely */
      const api = (() => { try { return w && w.LB_API; } catch (e) { return undefined; } })();
      if (api == null) { finishErr(); return; }
      try {
        fetch(`${api}/api/submit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload),
        }).then((res) => res.json().catch(() => null).then((data) => {
          if (res.ok && data && data.ok === true) finishOk(data.rank);
          else finishErr();
        })).catch(finishErr);
      } catch (e) { finishErr(); }
    };
    import('../leaderboard.js').then((mod) => {
      const submit = mod && typeof mod.submitScore === 'function' ? mod.submitScore : null;
      if (!submit) { viaGlobal(); return; }
      submit(payload).then((data) => {
        if (data && data.ok === true) finishOk(data.rank);
        else finishErr();
      }).catch(finishErr);
    }).catch(viaGlobal);
  };
  if (submitBtn) submitBtn.addEventListener('click', doSubmit);
  if (nameInput) {
    nameInput.addEventListener('keydown', (ev) => {
      if (ev && ev.key === 'Enter') { ev.preventDefault(); doSubmit(); }
    });
  }
  if (viewBtn) {
    viewBtn.addEventListener('click', () => openLeaderboardFor(mode));
  }

  show(s);
  if (SFX && typeof SFX.play === 'function') { try { SFX.play(victory ? 'win' : 'lose'); } catch (e) { /* optional */ } }
  return true;
}

function openLeaderboardFor(mode) {
  const w = win();
  const d = doc();
  import('../leaderboard.js').then((mod) => {
    const open = mod && typeof mod.openLeaderboard === 'function' ? mod.openLeaderboard : null;
    if (open) {
      const ok = open(mode || 'operations');
      if (ok) return;
      fallbackShowLeaderboard(d);
    } else {
      fallbackShowLeaderboard(d);
    }
  }).catch(() => fallbackShowLeaderboard(d));
  function fallbackShowLeaderboard(dd) {
    if (!dd) return;
    const screen = dd.getElementById('leaderboardScreen');
    if (screen) {
      screen.classList.remove('hidden');
      screen.removeAttribute('aria-hidden');
      screen.removeAttribute('hidden');
      try { screen.hidden = false; } catch (e) { /* old engines */ }
    }
  }
}

/* =========================================================== close all */
export function closeAllModals() {
  const d = doc();
  if (!d) return 0;
  if (dispatchTimer) { clearInterval(dispatchTimer); dispatchTimer = null; }
  if (dispatchKeyHandler) {
    try { d.removeEventListener('keydown', dispatchKeyHandler, true); } catch (e) { /* ignore */ }
    dispatchKeyHandler = null;
  }
  if (perkKeyHandler) {
    try { d.removeEventListener('keydown', perkKeyHandler, true); } catch (e) { /* ignore */ }
    perkKeyHandler = null;
  }
  let closed = 0;
  for (const id of SCREENS) {
    const node = d.getElementById(id);
    if (node && !node.classList.contains('hidden')) {
      node.classList.add('hidden');
      node.setAttribute('aria-hidden', 'true');
      node.setAttribute('hidden', '');
      try { node.hidden = true; } catch (e) { /* old engines */ }
      closed += 1;
    }
  }
  return closed;
}

/* --------------------------------------------- Enter/Space affordance */
let enterSpaceHandler = null;
function registerEnterSpace(screen, fn) {
  const d = doc();
  if (!d) return;
  if (enterSpaceHandler) {
    try { d.removeEventListener('keydown', enterSpaceHandler, true); } catch (e) { /* ignore */ }
    enterSpaceHandler = null;
  }
  enterSpaceHandler = (ev) => {
    const key = ev && ev.key;
    const tag = ev && ev.target && ev.target.tagName ? String(ev.target.tagName).toLowerCase() : '';
    if (key !== 'Enter' && key !== ' ') return;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (!isVisible(screen)) {
      if (enterSpaceHandler) { try { d.removeEventListener('keydown', enterSpaceHandler, true); } catch (e) { /* ignore */ } enterSpaceHandler = null; }
      return;
    }
    ev.preventDefault();
    try { fn(); } catch (e) { /* host owns errors */ }
    if (enterSpaceHandler) { try { d.removeEventListener('keydown', enterSpaceHandler, true); } catch (e) { /* ignore */ } enterSpaceHandler = null; }
  };
  try { d.addEventListener('keydown', enterSpaceHandler, true); } catch (e) { /* ignore */ }
}

/* --------------------------------------- Escape closes dim overlays ------ */
let escapeBound = false;
function bindEscape() {
  const d = doc();
  if (!d || escapeBound) return;
  escapeBound = true;
  d.addEventListener('keydown', (ev) => {
    if (!ev || ev.key !== 'Escape') return;
    const badge = d.getElementById('badgeScreen');
    const lb = d.getElementById('leaderboardScreen');
    const doctrine = d.getElementById('doctrineScreen');
    if (isVisible(badge)) { hide(badge); ev.preventDefault(); return; }
    if (isVisible(lb)) { hide(lb); ev.preventDefault(); return; }
    if (isVisible(doctrine)) { hide(doctrine); ev.preventDefault(); return; }
    /* Pause is intentionally NOT handled here: main.js owns Escape -> togglePause,
       and handling it in both places would re-open the pause screen instantly. */
  }, true);
}
