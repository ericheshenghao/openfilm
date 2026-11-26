(function () {
'use strict';
/* Magic animation performance layer — ported from MagicThinking.swift (640) and
 * MagicShow.swift (1645). The AppKit/QuartzCore *drawing* is replaced by Web
 * (DOM/CSS/SVG/Canvas), but every number, state machine, timing and scheduling
 * decision below is taken verbatim from the Swift source (see :line citations).
 *
 * This module is PURE LOGIC (no DOM, no Electron): it can be unit-tested in node
 * and driven by a Web renderer. The renderer calls schedule()/step-level helpers
 * and paints cursors, scans, ghosts and marks. */


// SRC MagicPlan.swift:202-205
const Ease = {
  inOut(t) { t = Math.min(1, Math.max(0, t)); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
  out(t) { t = Math.min(1, Math.max(0, t)); return 1 - Math.pow(1 - t, 3); },
};

// SRC MagicPlan.swift:417-424 — exact LCG.
class SeededRandom {
  constructor(seed) { this.state = (BigInt(seed >>> 0) + 0x9E3779B97F4A7C15n) & 0xFFFFFFFFFFFFFFFFn; }
  next() {
    this.state = (this.state * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn;
    return Number(this.state >> 11n) / Number(1n << 53n);
  }
}

// ---------------------------------------------------------------- MagicThinking
// SRC MagicThinking.swift:93, 208-217, 20-29
const THINKING = {
  dimming: 0.45,
  ghostDraw: 0.7,
  ghostLeave: 0.3,
  fadeTime: 0.6,
  appearTime: 0.35,
  scanGap: 0.18,          // :450 t - lastScan > 0.18
  scanStart: 0.25,        // :450 t > 0.25
  scanTail: 0.55,         // :41  end = start + sweep + 0.55
  idleToThink: 2.5,       // :382 wall - lastEvent > 2.5
  ghostStagger: 0.12,     // :338
  dash: [7, 6],           // :343
  dashSpeed: 24,          // :538 lineDashPhase = -t*24
  strokeAlpha: 0.65,      // :341
  fillAlpha: 0.06,        // :346
  lineWidth: 1.5,         // :342
  stages: ['looking', 'analyzing', 'thinking'],
  words: ['Looking', 'Analyzing', 'Thinking'],
  // :396
  appear(t) { return Math.min(1, Math.max(0, t) / 0.35); },
  // :406 hint = max(min(1,max(0,t-0.6)/0.4), bump); bump ignored when no nudge
  hintOpacity(t) { return Math.min(1, Math.max(0, t - 0.6) / 0.4); },
  // :383
  fadeFactor(t, from) { return from == null ? 1 : Math.max(0, 1 - (t - from) / 0.6); },
  // :490 sweep random(1..1.5) * min(1.6, max(0.8, w/220)); factor part only
  sweepFactor(width) { return Math.min(1.6, Math.max(0.8, width / 220)); },
  // :449
  scanRoom(targets) { return Math.min(6, Math.max(1, targets / 2 + 1)); },
  // :41
  scanEnd(start, sweep) { return start + sweep + 0.55; },
  // :536
  ghostProgress(t, born) { return Math.min(1, Math.max(0, (t - born) / 0.7)); },
  // :23 word from stage
  word(stage) { const i = THINKING.stages.indexOf(stage); return i < 0 ? '' : THINKING.words[i]; },
};

// MagicThinking.swift:20-29, 243-247, 382 — forward-only stage machine.
function ThinkingState() {
  return {
    stage: 'looking',
    lastEvent: 0,
    fadeFrom: null,
    handedOver: false,
    advance(to) {
      const from = THINKING.stages.indexOf(this.stage);
      const dest = THINKING.stages.indexOf(to);
      if (this.fadeFrom != null || dest <= from) return false;
      this.stage = to; this.lastEvent = this.now(); return true;
    },
    shouldAutoThink(wall) { return this.stage === 'analyzing' && wall - this.lastEvent > 2.5; },
    setEventTime(t) { this.lastEvent = t; },
    now() { return this.lastEvent; },
  };
}

// ---------------------------------------------------------------- MagicShow
// SRC MagicShow.swift:520-542, 656, 979-1002, 800
const SHOW = {
  outro: 0.34,
  homeTrip: 0.42,
  cardHeight: 96,
  cardGap: 6,
  targetLength: 7.0,
  menuItem: { x: 62, y: 20 },
  menuItems: ['Dissolve', 'Dip to Black', 'Wipe'],
  agentSpeed: 4.0,
  cursor: {
    w: 18, h: 24,
    points: [
      { x: 2, y: 2 }, { x: 2, y: 18.5 }, { x: 6.2, y: 14.6 }, { x: 9.1, y: 21 },
      { x: 11.6, y: 19.9 }, { x: 8.8, y: 13.6 }, { x: 14.4, y: 13.6 },
    ],
  },
  flashInterval: 0.3, // :1502
  // :656
  tempo(t) { return 0.72 + 1.1 * Math.exp(-t / 0.8); },
  // :800
  pace(at, agentMode, few) { return agentMode || few ? 0.85 : SHOW.tempo(at); },
  // :1510
  flashTime(sourceStart, duration) { return sourceStart + duration * 0.6; },
};

// cursorImage -> SVG path (7-vertex arrow, closed). SRC :989-992
function cursorPath() {
  const p = SHOW.cursor.points;
  return 'M ' + p.map((v) => `${v.x} ${v.y}`).join(' L ') + ' Z';
}

// Cubic bezier (SRC :bezier used throughout drawAgents).
function bezier(a, c, b, u) {
  const m = 1 - u;
  return m * m * a + 2 * m * u * c + u * u * b;
}
function bezierPoint(a, c, b, u) { return { x: bezier(a.x, c.x, b.x, u), y: bezier(a.y, c.y, b.y, u) }; }

// Nathan: hsv(hue,0.68,0.97) from :683 — produce a CSS colour.
function agentColor(hue) {
  return `hsl(${(hue * 360).toFixed(1)}, 68%, ${(0.97 * 100 - 0.97 * 100 * 0.5 + 50).toFixed(1)}%)`;
}

/* schedule() — SRC MagicShow.swift:660-793.
 * Assigns each edit to the agent that can reach it soonest, staggering births,
 * thinking time, travel and perform duration. Pure: pointsFor(edit,ti) returns
 * {grab,release} screen points (the Web renderer maps clip/asset rects). */
function schedule(tasks, opts = {}) {
  const agentMode = !!opts.agentMode;
  const spawn = opts.spawn || { x: 0, y: 0 };
  const pointsFor = opts.pointsFor || (() => ({ grab: { x: 0, y: 0 }, release: { x: 0, y: 0 } }));
  const isGradeCard = opts.isGradeCard || ((e) => e && (e.kind === 'grade' || e.kind === 'look'));
  const few = tasks.length <= 6; // :678
  // :679
  const count = agentMode ? 1 : Math.min(64, Math.max(14, Math.floor(tasks.length / 2.4)));
  let rng = new SeededRandom(opts.seed == null ? tasks.length : opts.seed); // :680

  const agents = []; // :681-691
  for (let i = 0; i < count; i++) {
    const hue = (i * 0.61803398875) % 1; // :682 golden ratio
    const a = {
      i, hue,
      color: opts.performer && opts.performer.color ? opts.performer.color : agentColor(hue),
      angle: 0, speed: 0, birth: 0, home: 0, gone: 0, slots: [], // SRC :462-468 defaults 0, not infinity
    };
    a.birth = Math.max(0, 2.4 * Math.pow(i / count, 0.7) + (rng.next() - 0.5) * 0.12); // :686
    a.angle = rng.next() * 2 * Math.PI; // :687
    a.speed = 0.65 + rng.next() * 0.7; // :688
    if (agentMode) { a.birth = 0; a.speed = 1; } // :689
    agents.push(a);
  }

  // :697-698 first 1-2 independent steps play at once, full speed.
  const quick = agentMode ? new Set() : new Set(
    tasks.map((t, i) => ({ t, i }))
      .filter(({ t }) => (!t.after || t.after.length === 0) && !isGradeCard(t.edit))
      .sort((a, b) => (a.t.delay || 0) - (b.t.delay || 0))
      .slice(0, 2).map(({ i }) => i)
  );
  for (const a of agents.slice(0, 2)) a.speed = Math.max(1, a.speed); // :699

  // :694-709 thought before each edit; grade panels think together.
  const panelThought = {};
  const think = tasks.map((t, i) => {
    const e = t.edit;
    if (isGradeCard(e) && e.clipID) {
      const id = e.clipID;
      if (id in panelThought) return panelThought[id];
      const v = rng.next() * 0.35; panelThought[id] = v; return v;
    }
    return agentMode || quick.has(i) ? 0 : Math.pow(rng.next(), 1.5) * 0.45;
  });

  // :710-716
  let free = agents.map((a) => a.birth);
  let pos = agents.map(() => ({ ...spawn }));
  let used = agents.map(() => false);
  const end = new Array(tasks.length).fill(-1);
  let remaining = new Set(tasks.map((_, i) => i));
  let firstDone = 0;
  const slots = [];

  // :718-721
  const travel = (a, from, to, t, isQuick) => {
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    return Math.min(0.65, Math.max(0.14, d / (2200 * agents[a].speed / (isQuick ? 1 : SHOW.pace(t, agentMode, few)))));
  };

  // :723-772 greedy earliest-ready assignment.
  while (remaining.size) {
    let best = null; // {task, ready}
    for (const i of remaining) {
      const t = tasks[i];
      if (!(t.after || []).every((j) => end[j] >= 0)) continue;
      const depMax = (t.after || []).length ? Math.max(...t.after.map((j) => end[j])) : 0;
      const ready = depMax + (quick.has(i) ? 0 : (t.delay || 0)) + think[i];
      if (best == null || ready < best.ready) best = { task: i, ready };
    }
    if (!best) break;
    const ti = best.task, ready = best.ready;
    const edit = tasks[ti].edit;
    const { grab, release } = pointsFor(edit, ti);
    // :745-751 cursor that can arrive soonest (a used one wins ties).
    let pick = 0, pickStart = Infinity, pickTravel = 0;
    for (let a = 0; a < count; a++) {
      const tr = travel(a, pos[a], grab, free[a], quick.has(ti));
      const start = Math.max(ready, free[a] + tr);
      const better = start < pickStart - 1e-6 || (Math.abs(start - pickStart) <= 1e-6 && used[a] && !used[pick]);
      if (better) { pick = a; pickStart = start; pickTravel = tr; }
    }
    // :752 perform duration
    const perform = edit.performTime * (quick.has(ti) ? 1 : SHOW.pace(pickStart, agentMode, few))
      * (agentMode ? 1 : isGradeCard(edit) ? 0.85 + rng.next() * 0.3 : 0.7 + rng.next() * 0.8);
    const finish = pickStart + perform;
    if (quick.has(ti)) firstDone = Math.max(firstDone, finish);
    slots.push({ edit, ti, agent: pick, grab, release, travel: pickTravel, travelStart: pickStart - pickTravel, start: pickStart, end: finish });
    agents[pick].slots.push(slots.length - 1);
    free[pick] = finish + 0.03; // :757
    pos[pick] = { ...release }; // :758
    used[pick] = true;
    end[ti] = finish;
    remaining.delete(ti);
  }

  const order = slots.map((_, i) => i).sort((a, b) => slots[a].start - slots[b].start); // :773
  const workEnd = (Math.max(0, ...slots.map((s) => s.end))) + 0.06; // :774
  // :776-782 each agent goes home once it has nothing left.
  for (const a of agents) {
    if (!a.slots.length) continue;
    const first = a.slots[0], last = a.slots[a.slots.length - 1];
    a.birth = slots[first].travelStart;
    a.home = agentMode ? Infinity : slots[last].end + 0.08 + rng.next() * 0.12;
    a.gone = agentMode ? Infinity : a.home + SHOW.homeTrip;
  }
  // :783
  const showEnd = agentMode ? workEnd + 0.05 : Math.max(workEnd, Math.max(0, ...agents.map((a) => a.gone))) + 0.05;
  const quickEnd = Math.min(showEnd, firstDone); // :789
  // :792
  const pace = agentMode || few || showEnd <= quickEnd ? 1 : Math.max(1, (SHOW.targetLength - quickEnd) / (showEnd - quickEnd));
  return { agents, slots, order, count, few, workEnd, showEnd, quickEnd, pace };
}

/* agentPose() — SRC MagicShow.swift:1256-1350. Returns where one cursor is at
 * time t, with its opacity/scale/label and whether it is pressing a control. */
function agentPose(a, slots, t, spawn, opts = {}) {
  const agentMode = !!opts.agentMode;
  if (!a.slots.length || t < a.birth || t >= a.gone) return { hidden: true }; // :1258
  const work = Math.min(t, a.home); // :1265
  const pop = agentMode ? 1 : Ease.out((t - a.birth) / 0.12); // :1266
  const out = t > a.home ? Ease.inOut(Math.min(1, (t - a.home) / SHOW.homeTrip)) : 0; // :1267
  const dir = { x: Math.cos(a.angle), y: Math.sin(a.angle) }; // :1268
  let pos = { ...spawn };
  let label = '', pressed = false;
  // :1277 current slot = first not yet finished, else last.
  const k = a.slots.findIndex((si) => slots[si].end > work);
  const ki = k < 0 ? a.slots.length - 1 : k;
  if (ki >= 0) {
    const s = slots[a.slots[ki]];
    const prevEnd = ki > 0 ? slots[a.slots[ki - 1]].end : s.travelStart - 0.03; // :1281
    const prev = ki > 0 ? slots[a.slots[ki - 1]].release : spawn; // :1282
    const leave = Math.max(prevEnd + 0.03, ki > 0 ? prevEnd + 0.03 : s.travelStart); // :1283
    if (work >= s.end) {
      pos = { ...s.release }; // :1286
      if (work - s.end < 0.12) label = s.edit.label; // :1287
    } else if (work < leave) {
      pos = { ...prev }; // :1289
    } else if (work < s.start) {
      // :1308-1311 approach along a bezier toward the grab point.
      const t0 = Math.max(leave, s.travelStart);
      const u = Ease.inOut((work - t0) / Math.max(0.01, s.start - t0));
      const ctrl = { x: (prev.x + s.grab.x) / 2 + dir.x * 40, y: (prev.y + s.grab.y) / 2 + dir.y * 40 };
      pos = bezierPoint(prev, ctrl, s.grab, u);
      label = s.edit.label;
    } else {
      // :1314-1325 drag grab -> release.
      const u = Ease.inOut((work - s.start) / Math.max(0.01, s.end - s.start));
      pos = { x: s.grab.x + (s.release.x - s.grab.x) * u, y: s.grab.y + (s.release.y - s.grab.y) * u };
      label = s.edit.label; pressed = true;
    }
  }
  if (out > 0) { // :1339-1342 back into the button
    const ctrl = { x: (pos.x + spawn.x) / 2 + dir.x * 120, y: (pos.y + spawn.y) / 2 + dir.y * 120 };
    pos = bezierPoint(pos, ctrl, spawn, out);
    label = '';
  }
  const fade = out > 0.6 ? (1 - out) / 0.4 : 1; // :1347
  const opacity = Math.min(1, pop * 2) * fade; // :1348
  const scale = (0.45 + 0.55 * pop) * (1 - 0.5 * out) * (pressed ? 0.88 : 1); // :1349
  return { hidden: false, pos, label, pressed, out, pop, opacity, scale, color: a.color };
}

/* marks() — SRC MagicShow.swift:1454-1496. What the timeline highlights while
 * cursors are working: selected clips, drag handles, snap guides, blade cuts. */
function marks(t, slots, order) {
  const m = { selected: new Set(), left: new Set(), right: new Set(), snaps: [], cuts: [], gain: new Set(), fadeIn: new Set(), fadeOut: new Set() };
  for (const i of order) {
    const s = slots[i];
    if (!(t >= s.start && t < s.end + 0.12)) continue; // :1456
    const u = Math.min(1, (t - s.start) / Math.max(0.01, s.end - s.start)); // :1458
    const live = t < s.end; // :1459
    const e = s.edit;
    const ids = (e.ids || e.clipIDs || (e.id ? [e.id] : [])) || [];
    switch (e.kind) {
      case 'place': if (!live) ids.forEach((id) => m.selected.add(id)); break; // :1462
      case 'trimHead':
        ids.forEach((id) => m.selected.add(id)); if (live) ids.forEach((id) => m.left.add(id));
        if (live && u > 0.7 && ids[0]) m.snaps.push({ time: e.to, clip: ids[0] }); // :1466
        break;
      case 'trimTail':
        ids.forEach((id) => m.selected.add(id)); if (live) ids.forEach((id) => m.right.add(id));
        if (live && u > 0.7 && ids[0]) m.snaps.push({ time: e.to, clip: ids[0] }); // :1470
        break;
      case 'move':
        ids.forEach((id) => m.selected.add(id));
        if (live && u > 0.6 && ids[0]) m.snaps.push({ time: e.to, clip: ids[0] }); // :1473
        break;
      case 'blade': if (live) ids.forEach((id) => m.cuts.push({ time: e.at, clip: id })); break; // :1475
      case 'remove': ids.forEach((id) => m.selected.add(id)); break; // :1477
      case 'type': case 'transition': if (e.id) m.selected.add(e.id); break; // :1478
      case 'gain': if (e.id) { m.selected.add(e.id); if (live) m.gain.add(e.id); } break; // :1480-1482
      case 'fadeIn': if (e.id) { m.selected.add(e.id); if (live) m.fadeIn.add(e.id); } break; // :1483-1485
      case 'fadeOut': if (e.id) { m.selected.add(e.id); if (live) m.fadeOut.add(e.id); } break; // :1486-1488
      case 'change': if (e.id) m.selected.add(e.id); break; // :1489-1490
      default: break; // look/grade :1491
    }
  }
  return m;
}

/* corner brackets path (SRC MagicThinking.swift:431-441). */
function bracketsPath(x, y, w, h, length, offset = 1.5) {
  const x0 = x - offset, y0 = y - offset, x1 = x + w + offset, y1 = y + h + offset;
  const l = Math.min(length, w / 3, h / 3);
  return `M ${x0} ${y0 + l} L ${x0} ${y0} L ${x0 + l} ${y0} ` +
    `M ${x1 - l} ${y0} L ${x1} ${y0} L ${x1} ${y0 + l} ` +
    `M ${x1} ${y1 - l} L ${x1} ${y1} L ${x1 - l} ${y1} ` +
    `M ${x0 + l} ${y1} L ${x0} ${y1} L ${x0} ${y1 - l}`;
}

// ---------------------------------------------------------------- AgentPresence
// SRC AgentPresence.swift:24, 99, 35, 104-107, 53-69
const PRESENCE = {
  linger: 12.0,                            // :24
  removeAge: 12.0 + 0.5,                   // :99 linger + 0.5
  tickInterval: 1 / 30,                    // :35
  cursorSize: { w: 18, h: 24 },            // :53
  cursorAnchor: { x: 2 / 18, y: 2 / 24 },  // :54
  tagHeight: 16,                           // :64
  tagRadius: 4,                            // :56
  tagBlendFraction: 0.18,                  // :55 color blended 0.18 toward black
  textSize: 10,                            // :58-59
  textWeight: 'semibold',                  // :58
  textColor: '#ffffff',                    // :60
  bob(now, hash) { return Math.sin(now * 2.2 + (hash % 7)) * 2; }, // :104
  fade(age) { return Math.max(0, Math.min(1, (12.5 - age) / 0.5)); }, // :105
  tagPosition(at, tagW, bob) { return { x: at.x + 10 + tagW / 2, y: at.y + 26 + bob }; }, // :107
  textWidth(s) { return String(s || '').length * 6.2; }, // :63 approximation of 10px semibold
  tagWidth(s) { return Math.ceil(PRESENCE.textWidth(s)) + 12; },
  // :55 blend #rrggbb toward black by fraction f
  blendBlack(hex, f) {
    const h = String(hex || '#ffffff').replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) || 0, g = parseInt(h.slice(2, 4), 16) || 0, b = parseInt(h.slice(4, 6), 16) || 0;
    return { r: Math.round(r * (1 - f)), g: Math.round(g * (1 - f)), b: Math.round(b * (1 - f)) };
  },
};

/* AgentPresence.swift:21-22,27-47,91-116 — parked cursors keyed by agent name. */
function PresenceState() {
  const parked = new Map(); // name -> { at, since, hash }
  function hashOf(name) { // stable stand-in for Swift String.hashValue % 7 (:104)
    let h = 0; const s = String(name);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 7;
  }
  return {
    hash: hashOf,
    // :29-32 re-parking reuses the layer but resets position + time
    park(name, at, now) {
      const prev = parked.get(name);
      parked.set(name, { at: { ...at }, since: now, hash: prev ? prev.hash : hashOf(name) });
    },
    take(name) { const p = parked.get(name); if (!p) return null; parked.delete(name); return { ...p.at }; }, // :42-47
    peek(name) { const p = parked.get(name); return p ? { at: { ...p.at }, since: p.since } : null; },
    count() { return parked.size; },
    isEmpty() { return parked.size === 0; },
    tick(now) { // :98-101
      const removed = [];
      for (const [name, p] of parked) if (now - p.since > PRESENCE.removeAge) { parked.delete(name); removed.push(name); }
      return removed;
    },
    sample(name, now) { // :98-109
      const p = parked.get(name); if (!p) return null;
      const age = now - p.since;
      return { age, expired: age > PRESENCE.removeAge, fade: PRESENCE.fade(age),
               bob: PRESENCE.bob(now, p.hash), at: p.at, hash: p.hash };
    },
    entries() { return [...parked.keys()]; },
  };
}

const ANIMATION_API = {
  Ease, SeededRandom, THINKING, SHOW, PRESENCE,
  ThinkingState, PresenceState, schedule, agentPose, marks,
  cursorPath, bezier, bezierPoint, bracketsPath, agentColor,
};
if (typeof module !== 'undefined' && module.exports) module.exports = ANIMATION_API;
if (typeof window !== 'undefined') window.OpenFilmMagicAnimation = ANIMATION_API;
})();
