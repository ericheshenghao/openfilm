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

/** Closed-set agent act → the part of the app it touches. */
function actRegion(act: string): Rect {
  const r = regions();
  if (/^(film\.|scene\.|audio\.)/.test(act)) return r.timeline;
  /* Importing / splitting / local file and command edits change the film on the
     timeline; send them there rather than to the media strip (or the chat). */
  if (/^(files\.|command\.|working$)/.test(act)) return r.timeline;
  if (/^asset\./.test(act)) return r.library;
  if (/^research\.|^chat\./.test(act)) return r.chat;
  return r.viewer;
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
    this.lastScan = now;
  }
  private lastScan = -1;

  private paintThinking(now: number) {
    const c = this.ctx;
    const t = now - this.thinkingT0;
    const alpha = A.THINKING.appear(t);
    if (alpha <= 0) return;
    c.save();
    c.globalAlpha = alpha * A.THINKING.dimming;
    c.fillStyle = '#000';
    c.fillRect(0, 0, innerWidth, innerHeight);
    c.restore();

    const r = regions();
    if (now - this.lastScan > A.THINKING.scanGap && t > A.THINKING.scanStart) {
      this.addScan([r.viewer, r.timeline, r.library, r.chat][this.scans.length % 4], now);
    }
    // dashed scanning brackets around the region being read
    for (let i = this.scans.length - 1; i >= 0; i--) {
      const s = this.scans[i];
      if (now > s.end) { this.scans.splice(i, 1); continue; }
      const p = clamp((now - s.start) / Math.max(0.01, s.sweep), 0, 1);
      const x = s.rect.x + s.rect.w * p;
      const y = s.rect.y + s.rect.h * (1 - p);
      c.save();
      c.globalAlpha = alpha * A.THINKING.strokeAlpha * A.THINKING.fadeFactor(now, s.end - 0.2);
      c.strokeStyle = '#ff7842'; c.lineWidth = A.THINKING.lineWidth;
      c.setLineDash(A.THINKING.dash); c.lineDashOffset = -now * A.THINKING.dashSpeed;
      c.strokeRect(x - 14, y - 14, 28, 28);
      c.setLineDash([]);
      c.beginPath(); c.moveTo(x, s.rect.y); c.lineTo(x, s.rect.y + s.rect.h); c.stroke();
      c.restore();
    }
    // dot field over the viewer, a shimmering preview of what is being planned
    this.fieldAlpha = Math.min(1, this.fieldAlpha + 0.04);
    c.save();
    c.globalAlpha = alpha * 0.28 * this.fieldAlpha;
    c.fillStyle = '#ffb08a';
    for (let i = 0; i < 90; i++) {
      const gx = r.viewer.x + ((i * 73) % 100) / 100 * r.viewer.w;
      const gy = r.viewer.y + ((i * 41) % 100) / 100 * r.viewer.h;
      const pulse = 0.5 + 0.5 * Math.sin(now * 5 + i);
      c.globalAlpha = alpha * 0.08 * pulse;
      c.fillRect(gx, gy, 2, 2);
    }
    c.restore();

    const word = A.THINKING.word(['looking', 'analyzing', 'thinking'][this.thinkingStage]);
    this.paintStage(word, alpha);
    if (t > 2.5 && this.thinkingStage < 2) this.thinkingStage++;
  }

  private paintStage(word: string, alpha = 1) {
    if (!word) return;
    const c = this.ctx;
    c.save();
    c.font = '600 12px Inter, system-ui, sans-serif';
    const w = c.measureText(word).width + 24;
    c.globalAlpha = alpha * 0.92;
    c.fillStyle = '#ff4a1c';
    c.beginPath(); c.roundRect(16, 16, w, 28, 8); c.fill();
    c.fillStyle = '#fff'; c.textBaseline = 'middle';
    c.fillText(word, 28, 31);
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
