/**
 * MagicShow / MagicThinking performance layer for OpenFilm.
 *
 * The numbers, timing and scheduling are ported from Editroom's Swift-derived
 * MagicShow.swift / MagicThinking.swift implementation (see EditroomWin/src/magic/
 * animation.js). OpenFilm's own tools do the real edit; this layer only paints
 * the swarm of cursors, scans, ghosts and marks while an agent turn runs, so an
 * MCP edit is visible on screen instead of appearing all at once.
 */
import './animation.cjs';

type MagicEvent =
  | { type: 'agent-thinking'; done?: boolean }
  | { type: 'agent-act'; callId: string; act: string; query?: string }
  | { type: 'agent-act-done'; callId?: string }
  | { type: 'source-changed' }
  | { type: 'completed' | 'replied' | 'failed' | 'cancelled' };

type Rect = { x: number; y: number; w: number; h: number; cx: number; cy: number };
type Act = { id: string; act: string; query?: string; born: number; done: boolean; kind: string };

const A: any = (window as any).OpenFilmMagicAnimation;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function rectOf(el: Element | null | undefined): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
}

/**
 * Screen regions used by the cursors.
 *
 * OpenFilm's window is split: the chat column (`#of-chat`) on the left, Studio's
 * editor on its right. `#root`, by contrast, is a zero-height React mount, so
 * measuring from it (as an earlier port did) made "library" land at x≈130 —
 * inside the chat — and every import/command cursor danced in the chat instead
 * of over the timeline. Anchor everything to the chat column's right edge.
 */
function regions(): Record<string, Rect> {
  const chat = rectOf(document.getElementById('of-chat'));
  // Studio occupies everything to the right of the chat column. Fall back to
  // the whole window only when the chat has not been laid out yet.
  const studio: Rect = chat
    ? { x: chat.x + chat.w, y: 0, w: Math.max(320, innerWidth - chat.x - chat.w), h: innerHeight,
        cx: chat.x + chat.w + Math.max(320, innerWidth - chat.x - chat.w) / 2, cy: innerHeight / 2 }
    : { x: 0, y: 0, w: innerWidth, h: innerHeight, cx: innerWidth / 2, cy: innerHeight / 2 };
  const viewer: Rect = {
    x: studio.x + studio.w * 0.06, y: studio.y + 52, w: studio.w * 0.62, h: studio.h * 0.60,
    cx: studio.x + studio.w * 0.37, cy: studio.y + 52 + studio.h * 0.30,
  };
  const timeline: Rect = {
    x: studio.x + studio.w * 0.08, y: studio.y + studio.h * 0.66, w: studio.w * 0.84, h: studio.h * 0.30,
    cx: studio.x + studio.w * 0.50, cy: studio.y + studio.h * 0.81,
  };
  // The media library is Studio's left strip, right of the chat — never the chat itself.
  const library: Rect = {
    x: studio.x, y: studio.y + 52, w: Math.min(220, studio.w * 0.20), h: studio.h * 0.60,
    cx: studio.x + Math.min(110, studio.w * 0.10), cy: studio.y + 52 + studio.h * 0.30,
  };
  return { full: studio, studio, viewer, timeline, library, chat: chat || viewer };
}

/**
 * Closed-set agent act → the part of the app it touches.
 *
 * Only acts that actually CHANGE the picture send an editing cursor to the
 * timeline. Reading / researching / shell work is the agent *thinking*, not
 * editing: a cursor performing a drag there would be a lie (the screenshots
 * showed cursors "making" over the timeline while the agent only read files).
 * Those thinking acts stay in the chat, where the work is really happening.
 */
function actRegion(act: string): Rect {
  const r = regions();
  if (/^(film\.arrange|scene\.|audio\.)/.test(act)) return r.timeline;
  /* Looking at the film (review/frames/check/hear) happens over the viewer. */
  if (/^film\./.test(act)) return r.viewer;
  if (/^asset\./.test(act)) return r.library;
  /* research / chat / local file + shell work / unknown = thinking, stay in chat. */
  if (/^(research\.|chat\.|files\.|command\.|working$)/.test(act)) return r.chat;
  return r.viewer;
}

/**
 * Does this act actually perform an edit on the film? Only those get a cursor
 * swarm. Reading, researching, shell work and "looking" acts are the agent
 * thinking — showing a cursor dragging across the timeline for them is wrong.
 */
function isEditingAct(act: string): boolean {
  return /^(film\.arrange|scene\.|audio\.|asset\.)/.test(act);
}

function labelOf(act: string): string {
  const map: Record<string, string> = {
    'film.arrange': 'Arrange', 'scene.write': 'Write shot', 'scene.edit': 'Edit shot',
    'film.frames': 'Inspect frames', 'film.check': 'Check film', 'film.review': 'Review',
    'film.hear': 'Listen', 'audio.transcribe': 'Transcribe', 'audio.voice': 'Pick voice',
    'audio.narrate': 'Voice-over', 'audio.sfx': 'Sound effect', 'audio.music': 'Music',
    'audio.translate': 'Translate', 'asset.searchImage': 'Find picture', 'asset.genImage': 'Make picture',
    'asset.genVideo': 'Make shot', 'research.search': 'Search', 'research.read': 'Read',
    'files.edit': 'Edit file', 'command.run': 'Run command', 'chat.ask': 'Ask',
  };
  return map[act] || 'Working';
}

class Director {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private acts: Act[] = [];
  private schedule: any = null;
  private spawn: { x: number; y: number } = { x: 80, y: 60 };
  private swarmT0 = 0;
  private thinking = false;
  private thinkingT0 = 0;
  private thinkingStage = 0;
  private scans: Array<{ rect: Rect; start: number; sweep: number; end: number }> = [];
  private fieldAlpha = 0;
  private rng = new A.SeededRandom(7);
  private lastAct = 0;
  private flashUntil = 0;
  private fadeFrom: number | null = null;
  private running = false;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  private resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(innerWidth * this.dpr);
    this.canvas.height = Math.floor(innerHeight * this.dpr);
    this.canvas.style.width = innerWidth + 'px';
    this.canvas.style.height = innerHeight + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  get now() { return performance.now() / 1000; }

  onEvent(e: MagicEvent) {
    const now = this.now;
    if (e.type === 'agent-thinking') {
      if (!e.done && !this.thinking) {
        this.thinking = true; this.thinkingT0 = now; this.thinkingStage = 0;
        this.fadeFrom = null; this.scans = [];
      } else if (e.done) {
        this.finishThinking();
      }
    } else if (e.type === 'agent-act') {
      if (this.acts.some((a) => a.id === e.callId)) return; // SSE replay is idempotent
      // Thinking / research / file reads are not film edits: keep the thinking
      // performance alive but do not dispatch editing cursors over the Studio.
      if (!isEditingAct(e.act)) {
        if (!this.thinking) {
          this.thinking = true; this.thinkingT0 = now; this.thinkingStage = 0;
          this.fadeFrom = null; this.scans = [];
        } else if (this.thinkingStage < 2) this.thinkingStage = 1;
        if (!this.running) { this.running = true; requestAnimationFrame(this.frame); }
        return;
      }
      this.thinking = this.thinking && now - this.lastAct < 4;
      this.acts.push({ id: e.callId, act: e.act, query: e.query, born: now, done: false, kind: e.act });
      if (this.acts.length > 40) this.acts.shift();
      this.lastAct = now;
      this.rebuild(now);
      if (this.thinking && this.thinkingStage < 2) this.thinkingStage = 2;
    } else if (e.type === 'agent-act-done') {
      if (e.callId) {
        const a = this.acts.find((x) => x.id === e.callId);
        if (a) a.done = true;
      } else {
        for (let i = this.acts.length - 1; i >= 0; i--) {
          if (!this.acts[i].done) { this.acts[i].done = true; break; }
        }
      }
      this.flashUntil = now + 0.12;
    } else if (e.type === 'source-changed') {
      this.flashUntil = now + 0.22;
    } else {
      this.finishThinking();
      this.fadeFrom = now;
    }
    if (!this.running) { this.running = true; requestAnimationFrame(this.frame); }
  }

  private finishThinking() {
    if (!this.thinking) return;
    this.thinking = false;
    this.fieldAlpha = 0;
  }

  /** MagicShow.swift:660-793 — same scheduler, with acts standing in for edits. */
  private rebuild(now: number) {
    const tasks = this.acts.map((a, i) => ({
      // MagicPlan.inSteps supplies performTime in Editroom; give each act a
      // source-consistent short performance so schedule() can place it.
      edit: { kind: a.kind, id: a.id, act: a.act, label: labelOf(a.act), performTime: 0.55 + (i % 3) * 0.12 },
      after: i ? [i - 1] : [],
      delay: 0,
    }));
    const spawn = (() => {
      // Cursors fly out of the chat composer, where the person typed the request.
      const composer = document.querySelector('#of-chat [contenteditable]');
      const r = rectOf(composer) || rectOf(document.getElementById('of-chat'));
      return r ? { x: r.x + r.w / 2, y: r.y + r.h / 2 } : { x: 80, y: 60 };
    })();
    // The Editroom Swarm keeps spawn on the director (show-web.js:191,243);
    // schedule() itself does not return it. agentPose() needs it on every frame.
    this.spawn = spawn;
    this.schedule = A.schedule(tasks, {
      spawn,
      seed: this.acts.length + 1,
      pointsFor: (edit: any) => {
        const r = actRegion(edit.act || edit.kind || 'working');
        const jx = (this.rng.next() - 0.5) * r.w * 0.35;
        const jy = (this.rng.next() - 0.5) * r.h * 0.35;
        return { grab: { x: r.cx + jx, y: r.cy + jy }, release: { x: r.cx - jx * 0.4, y: r.cy - jy * 0.4 } };
      },
      isGradeCard: () => false,
    });
    this.swarmT0 = now;
  }

  private addScan(r: Rect, now: number) {
    if (!r) return;
    const sweep = (1 + this.rng.next() * 0.5) * A.THINKING.sweepFactor(r.w);
    this.scans.push({ rect: r, start: now, sweep, end: A.THINKING.scanEnd(now, sweep) });
    // MagicThinking.swift:57 scanRoom() caps concurrent scans. The earlier port
    // ignored it, so at 0.18s scanGap up to 12 full-height lines stacked into a
    // "fence" — the main reason the effect looked cheap. Keep at most 3.
    const room = A.THINKING.scanRoom(4);
    while (this.scans.length > room) this.scans.shift();
    this.lastScan = now;
  }
  private lastScan = -1;

  private paintThinking(now: number) {
    const c = this.ctx;
    const t = now - this.thinkingT0;
    const alpha = A.THINKING.appear(t);
    if (alpha <= 0) return;
    const r = regions();

    /* 1 — soft vignette instead of a flat black sheet. The centre stays
       readable, edges dim, and a faint warm bloom sits over the editor. */
    c.save();
    const glow = c.createRadialGradient(
      innerWidth * 0.55, innerHeight * 0.44, innerHeight * 0.06,
      innerWidth * 0.55, innerHeight * 0.44, Math.max(innerWidth, innerHeight) * 0.78,
    );
    glow.addColorStop(0, `rgba(20,13,10,${alpha * A.THINKING.dimming * 0.55})`);
    glow.addColorStop(0.55, `rgba(5,4,4,${alpha * A.THINKING.dimming * 0.9})`);
    glow.addColorStop(1, `rgba(0,0,0,${alpha * Math.min(0.82, A.THINKING.dimming * 1.65)})`);
    c.fillStyle = glow;
    c.fillRect(0, 0, innerWidth, innerHeight);
    c.restore();

    /* 2 — scan sweeps: a tapered light beam with a bright head and a fading
       tail, plus a camera-viewfinder reticle built from four corner brackets
       instead of a dashed 28px square. */
    if (now - this.lastScan > A.THINKING.scanGap && t > A.THINKING.scanStart) {
      this.addScan([r.viewer, r.timeline, r.library, r.chat][this.scans.length % 4], now);
    }
    for (let i = this.scans.length - 1; i >= 0; i--) {
      const s = this.scans[i];
      if (now > s.end) { this.scans.splice(i, 1); continue; }
      const p = clamp((now - s.start) / Math.max(0.01, s.sweep), 0, 1);
      const x = s.rect.x + s.rect.w * p;
      const y = s.rect.y + s.rect.h * (1 - p);
      const fade = alpha * A.THINKING.strokeAlpha * A.THINKING.fadeFactor(now, s.end - 0.2);
      const y0 = s.rect.y, y1 = s.rect.y + s.rect.h;

      c.save();
      c.globalAlpha = fade;
      // wide, low-opacity glow column under the hairline gives the sweep body
      const halfCol = 17;
      const column = c.createLinearGradient(x - halfCol, 0, x + halfCol, 0);
      column.addColorStop(0, 'rgba(255,120,66,0)');
      column.addColorStop(0.5, 'rgba(255,150,96,0.19)');
      column.addColorStop(1, 'rgba(255,120,66,0)');
      c.fillStyle = column;
      c.fillRect(x - halfCol, y0, halfCol * 2, y1 - y0);
      const beam = c.createLinearGradient(0, y0, 0, y1);
      beam.addColorStop(0, 'rgba(255,120,66,0)');
      beam.addColorStop(0.18, 'rgba(255,138,82,0.5)');
      beam.addColorStop(0.5, 'rgba(255,170,120,0.95)');
      beam.addColorStop(0.82, 'rgba(255,138,82,0.5)');
      beam.addColorStop(1, 'rgba(255,120,66,0)');
      c.strokeStyle = beam;
      c.lineWidth = A.THINKING.lineWidth;
      c.shadowColor = 'rgba(255,120,66,0.8)';
      c.shadowBlur = 9;
      c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y1); c.stroke();

      const half = 14, arm = 6;
      c.shadowBlur = 7;
      c.lineWidth = 1.4;
      c.strokeStyle = 'rgba(255,198,162,0.95)';
      c.beginPath();
      c.moveTo(x - half, y - half + arm); c.lineTo(x - half, y - half); c.lineTo(x - half + arm, y - half);
      c.moveTo(x + half - arm, y - half); c.lineTo(x + half, y - half); c.lineTo(x + half, y - half + arm);
      c.moveTo(x + half, y + half - arm); c.lineTo(x + half, y + half); c.lineTo(x + half - arm, y + half);
      c.moveTo(x - half + arm, y + half); c.lineTo(x - half, y + half); c.lineTo(x - half, y + half - arm);
      c.stroke();
      c.fillStyle = 'rgba(255,214,184,0.95)';
      c.beginPath(); c.arc(x, y, 1.8, 0, Math.PI * 2); c.fill();
      c.restore();
    }

    /* 3 — breathing dot grid over the viewer, softly faded at the edges. */
    this.fieldAlpha = Math.min(1, this.fieldAlpha + 0.04);
    c.save();
    c.beginPath(); c.rect(r.viewer.x, r.viewer.y, r.viewer.w, r.viewer.h); c.clip();
    const step = 26;
    for (let gx = r.viewer.x + step; gx < r.viewer.x + r.viewer.w; gx += step) {
      for (let gy = r.viewer.y + step; gy < r.viewer.y + r.viewer.h; gy += step) {
        const edge = 1 - clamp(Math.hypot(gx - r.viewer.cx, gy - r.viewer.cy) / (r.viewer.w * 0.62), 0, 1);
        const pulse = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now * 3.1 - (gx + gy) * 0.012));
        c.globalAlpha = alpha * 0.2 * edge * pulse * this.fieldAlpha;
        c.fillStyle = '#ffb48a';
        c.beginPath(); c.arc(gx, gy, 1.1, 0, Math.PI * 2); c.fill();
      }
    }
    c.restore();

    const word = A.THINKING.word(['looking', 'analyzing', 'thinking'][this.thinkingStage]);
    this.paintStage(word, alpha, now);
    if (t > 2.5 && this.thinkingStage < 2) this.thinkingStage++;
  }

  /** Glass capsule: pulsing dot, stage name and a three-segment progress. */
  private paintStage(word: string, alpha = 1, now = this.now) {
    if (!word) return;
    const c = this.ctx;
    const stages = ['Looking', 'Analyzing', 'Thinking'];
    const active = stages.indexOf(word);
    c.save();
    c.font = '600 11.5px Inter, system-ui, sans-serif';
    c.textBaseline = 'middle';
    const w = Math.max(122, c.measureText(word).width + 74);
    const h = 30, x = 16, y = 16;
    c.globalAlpha = alpha;
    c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = 12; c.shadowOffsetY = 2;
    c.fillStyle = 'rgba(22,19,18,0.88)';
    c.beginPath(); c.roundRect(x, y, w, h, 9); c.fill();
    c.shadowBlur = 0; c.shadowOffsetY = 0;
    c.strokeStyle = 'rgba(255,140,84,0.4)'; c.lineWidth = 1;
    c.beginPath(); c.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 9); c.stroke();
    // pulsing core with an expanding halo
    const pulse = 0.5 + 0.5 * Math.sin(now * 5);
    c.fillStyle = `rgba(255,120,66,${0.6 + 0.4 * pulse})`;
    c.beginPath(); c.arc(x + 15, y + h / 2, 3.6, 0, Math.PI * 2); c.fill();
    c.strokeStyle = `rgba(255,150,96,${0.3 * (1 - pulse)})`;
    c.beginPath(); c.arc(x + 15, y + h / 2, 6 + 4 * pulse, 0, Math.PI * 2); c.stroke();
    c.fillStyle = '#ffe6d8';
    c.fillText(word, x + 27, y + h / 2 + 0.5);
    if (active >= 0) {
      for (let i = 0; i < 3; i++) {
        const tx = x + w - 36 + i * 9;
        c.globalAlpha = alpha * (i <= active ? 0.95 : 0.28);
        c.fillStyle = i <= active ? '#ff9a63' : 'rgba(255,255,255,0.65)';
        c.beginPath(); c.roundRect(tx, y + h / 2 - 2, 5, 4, 2); c.fill();
      }
    }
    c.restore();
  }

  private paintSwarm(now: number) {
    const S = this.schedule;
    if (!S) return;
    const c = this.ctx;
    const t = now - this.swarmT0;
    // marks: thin guides over the regions being edited
    const m = A.marks(t, S.slots, S.order);
    c.save();
    c.strokeStyle = 'rgba(255,255,255,0.45)'; c.lineWidth = 1;
    const tl = regions().timeline;
    (m.snaps || []).forEach((_: any, i: number) => {
      const x = tl.x + tl.w * (0.25 + ((i * 0.17) % 0.5));
      c.beginPath(); c.moveTo(x, tl.y); c.lineTo(x, tl.y + tl.h); c.stroke();
    });
    c.restore();

    for (const agent of S.agents) {
      const pose = A.agentPose(agent, S.slots, t, this.spawn, { agentMode: false });
      if (pose.hidden) continue;
      const p = pose.pos, k = pose.scale;
      c.save();
      c.translate(p.x, p.y); c.scale(k, k);
      c.shadowColor = 'rgba(0,0,0,0.55)'; c.shadowBlur = 3; c.shadowOffsetY = 1;
      c.fillStyle = pose.color || agent.color || '#ff7842';
      c.beginPath();
      A.SHOW.cursor.points.forEach((v: any, i: number) => (i ? c.lineTo(v.x, v.y) : c.moveTo(v.x, v.y)));
      c.closePath(); c.fill();
      c.restore();
    }

    // a small "edit card" follows the first few agents, naming the closed-set act
    const shown = this.acts.slice(-6);
    shown.forEach((a, i) => {
      const slot = S.slots[S.order[i]];
      if (!slot || t < slot.start) return;
      const pose = A.agentPose(S.agents[i % S.agents.length], S.slots, t, this.spawn, { agentMode: false });
      if (pose.hidden) return;
      const text = labelOf(a.act) + (a.query ? ' · ' + String(a.query).slice(0, 22) : '');
      c.save();
      c.font = '500 10px Inter, system-ui, sans-serif';
      const w = Math.max(52, c.measureText(text).width + 16);
      c.globalAlpha = clamp((t - slot.start) / 0.2, 0, 1) * (a.done ? 0.4 : 0.95);
      c.fillStyle = 'rgba(12,12,12,0.92)';
      c.beginPath(); c.roundRect(pose.pos.x + 14, pose.pos.y + 12, w, A.SHOW.cardHeight / 5.5, 5); c.fill();
      c.fillStyle = '#fff'; c.textBaseline = 'middle';
      c.fillText(text, pose.pos.x + 22, pose.pos.y + 21);
      c.restore();
    });
    this.paintStage('Editing', 0.9);
  }

  private paintFlash(now: number) {
    if (now > this.flashUntil) return;
    const r = regions().viewer;
    const a = clamp((this.flashUntil - now) / 0.22, 0, 1) * 0.22;
    this.ctx.save();
    this.ctx.globalAlpha = a; this.ctx.fillStyle = '#fff';
    this.ctx.fillRect(r.x, r.y, r.w, r.h);
    this.ctx.restore();
  }

  private frame = () => {
    const now = this.now;
    const c = this.ctx;
    c.clearRect(0, 0, innerWidth, innerHeight);
    if (this.thinking) this.paintThinking(now);
    if (this.schedule && now - this.lastAct < 12) this.paintSwarm(now);
    this.paintFlash(now);
    const idle = !this.thinking && now - this.lastAct > 4 && this.fadeFrom != null;
    if (idle && now - this.fadeFrom > 1) {
      this.schedule = null; this.acts = []; this.scans = []; this.fadeFrom = null;
      this.running = false;
      c.clearRect(0, 0, innerWidth, innerHeight);
      return;
    }
    requestAnimationFrame(this.frame);
  };
}

/** Mount the window-wide canvas once the shell is present. */
export function mountMagicOverlay() {
  if (!A || document.getElementById('of-magic-canvas')) return;
  const canvas = document.createElement('canvas');
  canvas.id = 'of-magic-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  const director = new Director(canvas);
  addEventListener('openfilm:magic', (e: Event) => {
    director.onEvent((e as CustomEvent).detail as MagicEvent);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountMagicOverlay, { once: true });
} else mountMagicOverlay();
