import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'motion/react';
import type { LucideIcon } from 'lucide-react';
import { CircleAlert, Loader2, RefreshCw, Unplug, Waypoints } from 'lucide-react';
import { commands, isTauriAvailable } from '@graphite/bindings';
import type { GraphData, NoteRef } from '@graphite/bindings';
import { Button, Switch, cx, easePoints } from '@graphite/ui';
import { Fade, Presence, SlideUp, springSnappy, usePrefersReducedMotion } from '../../motion';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { resolveIconColor } from '../tree/NoteIcon';

const TAU = Math.PI * 2;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;
const ALPHA_MIN = 0.012;
const ALPHA_DECAY = 0.986;
const REPULSION = 1050;
const REPULSION_CUTOFF = 250;
const CENTER_PULL = 0.02;
const FRICTION = 0.72;
const MAX_SPEED = 16;
const LABEL_MIN_R = 4.6;
const LABEL_FULL_R = 7.5;
const AMBIENT_LABEL_CAP = 140;
const SETTLE_TICKS_MAX = 600;
const PREWARM_TICKS = 60;
const CLICK_SLOP_PX = 4;
const GRID_WORLD_STEP = 64;

interface SimNode {
  ref: NoteRef;
  title: string;
  label: string;
  degree: number;
  r: number;
  fill: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
  fresh: boolean;
}

interface SimEdge {
  a: number;
  b: number;
  rest: number;
  strength: number;
  bias: number;
}

interface ThemeColors {
  bg: string;
  grid: string;
  edge: string;
  accent: string;
  text0: string;
  text1: string;
  font: string;
}

interface CameraFit {
  k: number;
  tx: number;
  ty: number;
}

interface Engine {
  nodes: SimNode[];
  edges: SimEdge[];
  adjacency: number[][];
  order: number[];
  labelOrder: number[];
  alpha: number;
  k: number;
  tx: number;
  ty: number;
  camTarget: CameraFit | null;
  hover: number;
  dim: number;
  autoFit: boolean;
  interacted: boolean;
  w: number;
  h: number;
  dpr: number;
  theme: ThemeColors;
}

type DragState =
  | { mode: 'pan'; startX: number; startY: number; tx0: number; ty0: number; moved: boolean }
  | { mode: 'node'; idx: number; offX: number; offY: number; startX: number; startY: number; moved: boolean };

type ViewStatus = 'loading' | 'ready' | 'error' | 'offline';

interface HoverMeta {
  title: string;
  degree: number;
  fill: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) {
    return one;
  }
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) {
    return few;
  }
  return many;
}

function readTheme(): ThemeColors {
  const root = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string): string => {
    const raw = root.getPropertyValue(name).trim();
    return raw.length > 0 ? raw : fallback;
  };
  const bodyFont = typeof document !== 'undefined' ? getComputedStyle(document.body).fontFamily : '';
  return {
    bg: pick('--bg-0', '#0D0E11'),
    grid: pick('--text-3', '#494E59'),
    edge: pick('--stroke-1', '#343945'),
    accent: pick('--accent', '#8B93FF'),
    text0: pick('--text-0', '#EDEEF2'),
    text1: pick('--text-1', '#A9ADB8'),
    font: bodyFont.length > 0 ? bodyFont : 'Inter, system-ui, sans-serif',
  };
}

/** Цвет заливки узла: цвет иконки заметки (токен темы или #hex), по умолчанию — акцент. */
function resolveNodeFill(color: string | undefined, root: CSSStyleDeclaration, accent: string): string {
  const resolved = resolveIconColor(color);
  if (resolved === undefined) {
    return accent;
  }
  if (resolved.startsWith('var(')) {
    const raw = root.getPropertyValue(resolved.slice(4, -1)).trim();
    return raw.length > 0 ? raw : accent;
  }
  return resolved;
}

function createEngine(): Engine {
  return {
    nodes: [],
    edges: [],
    adjacency: [],
    order: [],
    labelOrder: [],
    alpha: 0,
    k: 1,
    tx: 0,
    ty: 0,
    camTarget: null,
    hover: -1,
    dim: 0,
    autoFit: true,
    interacted: false,
    w: 1,
    h: 1,
    dpr: 1,
    theme: readTheme(),
  };
}

/** Один шаг силовой раскладки: пружины рёбер, отталкивание пар, притяжение к центру, интеграция. */
function simTick(e: Engine): void {
  const nodes = e.nodes;
  const alpha = e.alpha;

  for (const ed of e.edges) {
    const a = nodes[ed.a];
    const b = nodes[ed.b];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.01) {
      dx = 0.1 + ((ed.a * 7919) % 13) * 0.05;
      dy = 0.1;
      d = Math.sqrt(dx * dx + dy * dy);
    }
    const f = ((d - ed.rest) / d) * ed.strength * alpha;
    const fx = dx * f;
    const fy = dy * f;
    b.vx -= fx * ed.bias;
    b.vy -= fy * ed.bias;
    a.vx += fx * (1 - ed.bias);
    a.vy += fy * (1 - ed.bias);
  }

  const n = nodes.length;
  const cutoff2 = REPULSION_CUTOFF * REPULSION_CUTOFF;
  for (let i = 0; i < n; i += 1) {
    const a = nodes[i];
    for (let j = i + 1; j < n; j += 1) {
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 >= cutoff2) {
        continue;
      }
      if (d2 < 0.01) {
        dx = (((i + j) % 7) - 3) * 0.17 + 0.05;
        dy = (((i * 31 + j) % 5) - 2) * 0.17 + 0.05;
        d2 = dx * dx + dy * dy;
      }
      const d = Math.sqrt(d2);
      const minDist = a.r + b.r + 5;
      let f = (REPULSION * alpha) / d2;
      if (d < minDist) {
        f += ((minDist - d) / d) * 0.45;
      }
      const fx = dx * f;
      const fy = dy * f;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }

  for (const nd of nodes) {
    if (nd.fx !== null && nd.fy !== null) {
      nd.x = nd.fx;
      nd.y = nd.fy;
      nd.vx = 0;
      nd.vy = 0;
      continue;
    }
    nd.vx = (nd.vx - nd.x * CENTER_PULL * alpha) * FRICTION;
    nd.vy = (nd.vy - nd.y * CENTER_PULL * alpha) * FRICTION;
    const speed = Math.sqrt(nd.vx * nd.vx + nd.vy * nd.vy);
    if (speed > MAX_SPEED) {
      const s = MAX_SPEED / speed;
      nd.vx *= s;
      nd.vy *= s;
    }
    nd.x += nd.vx;
    nd.y += nd.vy;
  }

  e.alpha *= ALPHA_DECAY;
  if (e.alpha < ALPHA_MIN) {
    e.alpha = 0;
  }
}

/** Синхронно догоняем раскладку до устойчивого состояния (для reduced-motion). */
function settle(e: Engine): void {
  const maxTicks = e.nodes.length > 400 ? 240 : SETTLE_TICKS_MAX;
  for (let i = 0; e.alpha > ALPHA_MIN && i < maxTicks; i += 1) {
    simTick(e);
  }
  e.alpha = 0;
}

function buildEngine(e: Engine, data: GraphData): void {
  const root = getComputedStyle(document.documentElement);
  e.theme = readTheme();

  const prev = new Map<NoteRef, { x: number; y: number }>();
  for (const nd of e.nodes) {
    prev.set(nd.ref, { x: nd.x, y: nd.y });
  }

  const indexByRef = new Map<NoteRef, number>();
  const nodes: SimNode[] = [];
  data.nodes.forEach((raw, i) => {
    indexByRef.set(raw.ref, i);
    const seat = prev.get(raw.ref);
    const angle = i * 2.39996323;
    const radius = 22 * Math.sqrt(i + 0.5);
    nodes.push({
      ref: raw.ref,
      title: raw.title,
      label: truncate(raw.title, 28),
      degree: raw.degree,
      r: Math.min(19, 4.5 + Math.sqrt(Math.max(0, raw.degree)) * 2.4),
      fill: resolveNodeFill(raw.color, root, e.theme.accent),
      x: seat?.x ?? Math.cos(angle) * radius,
      y: seat?.y ?? Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
      fresh: seat === undefined,
    });
  });

  const adjacency: number[][] = nodes.map(() => []);
  const seen = new Set<string>();
  const edges: SimEdge[] = [];
  for (const raw of data.edges) {
    const a = indexByRef.get(raw.source);
    const b = indexByRef.get(raw.target);
    if (a === undefined || b === undefined || a === b) {
      continue;
    }
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    edges.push({ a, b, rest: 0, strength: 0, bias: 0.5 });
    adjacency[a].push(b);
    adjacency[b].push(a);
  }
  for (const ed of edges) {
    const ca = Math.max(1, adjacency[ed.a].length);
    const cb = Math.max(1, adjacency[ed.b].length);
    ed.rest = 40 + (nodes[ed.a].r + nodes[ed.b].r) * 1.2;
    ed.strength = clamp(1 / Math.min(ca, cb), 0.1, 0.72);
    ed.bias = ca / (ca + cb);
  }

  // Новые узлы при пересборке рождаются рядом со своими соседями, а не в центре спирали.
  nodes.forEach((nd, i) => {
    if (!nd.fresh) {
      return;
    }
    const anchors = adjacency[i].filter((j) => !nodes[j].fresh);
    if (anchors.length === 0) {
      return;
    }
    let ax = 0;
    let ay = 0;
    for (const j of anchors) {
      ax += nodes[j].x;
      ay += nodes[j].y;
    }
    nd.x = ax / anchors.length + (((i * 37) % 21) - 10) * 4;
    nd.y = ay / anchors.length + (((i * 53) % 17) - 8) * 4;
  });

  e.nodes = nodes;
  e.edges = edges;
  e.adjacency = adjacency;
  e.order = nodes.map((_, i) => i).sort((p, q) => nodes[p].r - nodes[q].r);
  e.labelOrder = nodes.map((_, i) => i).sort((p, q) => nodes[q].degree - nodes[p].degree);
  e.hover = -1;
  e.dim = 0;
  e.camTarget = null;
  if (!e.interacted) {
    e.autoFit = true;
  }
  e.alpha = prev.size > 0 ? 0.6 : 1;

  // Пре-прогрев: первая отрисовка уже с осмысленной формой, без «взрыва» из спирали.
  const warm = nodes.length > 1 ? (prev.size > 0 ? 24 : PREWARM_TICKS) : 0;
  for (let i = 0; i < warm && e.alpha > ALPHA_MIN; i += 1) {
    simTick(e);
  }
}

function computeFit(e: Engine): CameraFit | null {
  if (e.nodes.length === 0 || e.w < 10 || e.h < 10) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const nd of e.nodes) {
    const pad = nd.r + 24;
    minX = Math.min(minX, nd.x - pad);
    minY = Math.min(minY, nd.y - pad);
    maxX = Math.max(maxX, nd.x + pad);
    maxY = Math.max(maxY, nd.y + pad);
  }
  const k = clamp(Math.min(e.w / (maxX - minX + 120), e.h / (maxY - minY + 100), 1.8), MIN_ZOOM, MAX_ZOOM);
  const cx0 = (minX + maxX) / 2;
  const cy0 = (minY + maxY) / 2;
  return { k, tx: e.w / 2 - cx0 * k, ty: e.h / 2 - cy0 * k };
}

function drawScene(e: Engine, ctx: CanvasRenderingContext2D, labelsOn: boolean): void {
  const { w, h, dpr, k, tx, ty, theme, nodes, edges } = e;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Фон: едва заметная точечная сетка, проявляется при приближении.
  const step = GRID_WORLD_STEP * k;
  if (step >= 26) {
    const cols = Math.ceil(w / step) + 2;
    const rows = Math.ceil(h / step) + 2;
    if (cols * rows <= 9000) {
      ctx.globalAlpha = Math.min(1, (step - 26) / 80) * 0.4;
      ctx.fillStyle = theme.grid;
      const x0 = ((tx % step) + step) % step;
      const y0 = ((ty % step) + step) % step;
      for (let gx = x0 - step; gx < w + step; gx += step) {
        for (let gy = y0 - step; gy < h + step; gy += step) {
          ctx.fillRect(gx - 0.75, gy - 0.75, 1.5, 1.5);
        }
      }
    }
  }

  const hover = e.hover;
  const dim = e.dim;
  let litSet: Set<number> | null = null;
  if (hover >= 0 && hover < nodes.length) {
    litSet = new Set(e.adjacency[hover]);
    litSet.add(hover);
  }

  // Рёбра: обычные одним батчем, рёбра ховер-кластера — акцентом поверх.
  ctx.lineCap = 'round';
  const margin = 60;
  const baseEdgeAlpha = 0.38 * (1 - dim * 0.85);
  if (baseEdgeAlpha > 0.01) {
    ctx.beginPath();
    for (const ed of edges) {
      if (litSet !== null && (ed.a === hover || ed.b === hover)) {
        continue;
      }
      const a = nodes[ed.a];
      const b = nodes[ed.b];
      const ax = a.x * k + tx;
      const ay = a.y * k + ty;
      const bx = b.x * k + tx;
      const by = b.y * k + ty;
      if (
        (ax < -margin && bx < -margin) ||
        (ax > w + margin && bx > w + margin) ||
        (ay < -margin && by < -margin) ||
        (ay > h + margin && by > h + margin)
      ) {
        continue;
      }
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.globalAlpha = baseEdgeAlpha;
    ctx.strokeStyle = theme.edge;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  if (litSet !== null && dim > 0.01) {
    ctx.beginPath();
    for (const ed of edges) {
      if (ed.a !== hover && ed.b !== hover) {
        continue;
      }
      const a = nodes[ed.a];
      const b = nodes[ed.b];
      ctx.moveTo(a.x * k + tx, a.y * k + ty);
      ctx.lineTo(b.x * k + tx, b.y * k + ty);
    }
    ctx.globalAlpha = 0.3 + 0.6 * dim;
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Узлы: мелкие снизу, крупные хабы сверху; ховер-кластер светится, прочие гаснут.
  for (const i of e.order) {
    const nd = nodes[i];
    const sx = nd.x * k + tx;
    const sy = nd.y * k + ty;
    if (sx < -40 || sx > w + 40 || sy < -40 || sy > h + 40) {
      continue;
    }
    const hovered = i === hover;
    const bright = litSet === null || litSet.has(i);
    const alpha = bright ? 1 : 1 - dim * 0.85;
    let sr = Math.max(2.4, nd.r * k);
    if (hovered) {
      sr *= 1 + 0.12 * dim;
    }
    ctx.globalAlpha = alpha;
    if (litSet !== null && bright && dim > 0.03) {
      ctx.shadowColor = nd.fill;
      ctx.shadowBlur = (hovered ? 20 : 11) * dim;
    }
    ctx.fillStyle = nd.fill;
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = alpha * 0.85;
    ctx.strokeStyle = theme.bg;
    ctx.lineWidth = 1;
    ctx.stroke();
    if (hovered && dim > 0.03) {
      ctx.globalAlpha = 0.5 * dim;
      ctx.strokeStyle = nd.fill;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, sr + 3 + 2 * dim, 0, TAU);
      ctx.stroke();
    }
  }

  // Подписи: приоритет хабам, мелкие скрываются при отдалении, ховер-кластер подписан всегда.
  ctx.font = `500 11px ${theme.font}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  let ambientDrawn = 0;
  for (const i of e.labelOrder) {
    const nd = nodes[i];
    const srRaw = nd.r * k;
    const bright = litSet !== null && litSet.has(i);
    const ambient = labelsOn ? smoothstep(LABEL_MIN_R, LABEL_FULL_R, srRaw) : 0;
    const alpha = bright ? Math.max(ambient, dim) : ambient * (1 - dim * 0.9);
    if (alpha < 0.04) {
      continue;
    }
    if (!bright) {
      if (ambientDrawn >= AMBIENT_LABEL_CAP) {
        continue;
      }
      ambientDrawn += 1;
    }
    const sx = nd.x * k + tx;
    const sy = nd.y * k + ty;
    if (sx < -240 || sx > w + 40 || sy < -30 || sy > h + 30) {
      continue;
    }
    const lx = sx + Math.max(2.4, srRaw) + 7;
    ctx.globalAlpha = alpha * 0.92;
    ctx.lineWidth = 3;
    ctx.strokeStyle = theme.bg;
    ctx.strokeText(nd.label, lx, sy);
    ctx.fillStyle = i === hover ? theme.text0 : theme.text1;
    ctx.fillText(nd.label, lx, sy);
  }
  ctx.globalAlpha = 1;
}

interface StateCardProps {
  icon: LucideIcon;
  title: string;
  text: ReactNode;
  children?: ReactNode;
}

function StateCard({ icon: Icon, title, text, children }: StateCardProps) {
  const reduced = usePrefersReducedMotion();
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
      <motion.div
        className="pointer-events-auto flex w-full max-w-[360px] flex-col items-center gap-4 rounded-l border border-stroke-0 bg-bg-1/85 px-8 py-9 text-center shadow-2 backdrop-blur-md"
        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
        animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0, transition: springSnappy }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98, transition: { duration: 0.12, ease: easePoints.in } }}
      >
        <span className="flex size-12 items-center justify-center rounded-full bg-accent-dim text-accent">
          <Icon size={22} strokeWidth={1.75} />
        </span>
        <div className="flex flex-col gap-1.5">
          <p className="text-ui font-semibold text-text-0">{title}</p>
          <p className="text-caption leading-relaxed text-text-2">{text}</p>
        </div>
        {children}
      </motion.div>
    </div>
  );
}

export function GraphView() {
  const reduced = usePrefersReducedMotion();
  const [status, setStatus] = useState<ViewStatus>('loading');
  const [stats, setStats] = useState({ nodes: 0, edges: 0 });
  const [labelsOn, setLabelsOn] = useState(true);
  const [hoverMeta, setHoverMeta] = useState<HoverMeta | null>(null);
  const [slowLoad, setSlowLoad] = useState(false);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const tooltipTransformRef = useRef('translate3d(-9999px, -9999px, 0)');
  const reducedRef = useRef(reduced);
  const labelsOnRef = useRef(labelsOn);
  const apiRef = useRef<{ requestFrame(): void; reload(): void } | null>(null);

  reducedRef.current = reduced;
  labelsOnRef.current = labelsOn;

  useEffect(() => {
    apiRef.current?.requestFrame();
  }, [reduced, labelsOn]);

  // Лоадер показываем только если ответ ядра дольше 150 мс — без мигания на быстрых данных.
  useEffect(() => {
    if (status !== 'loading') {
      setSlowLoad(false);
      return;
    }
    const timer = window.setTimeout(() => setSlowLoad(true), 150);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (canvas === null || wrap === null) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      return;
    }
    // Сужение типов не доживает до hoisted-функций ниже — фиксируем не-null ссылки.
    const surface = canvas;
    const host = wrap;
    const ctx2d = ctx;

    const engine = createEngine();
    let disposed = false;
    let raf = 0;
    let drag: DragState | null = null;
    let lastHover = -1;

    function requestFrame(): void {
      if (raf === 0 && !disposed) {
        raf = requestAnimationFrame(frame);
      }
    }

    function jumpFit(): void {
      const fit = computeFit(engine);
      if (fit !== null) {
        engine.k = fit.k;
        engine.tx = fit.tx;
        engine.ty = fit.ty;
      }
    }

    function placeTooltip(nd: SimNode): void {
      const sx = clamp(nd.x * engine.k + engine.tx, 16, engine.w - 16);
      const sr = Math.max(2.4, nd.r * engine.k) * (1 + 0.12 * engine.dim);
      const sy = Math.max(14, nd.y * engine.k + engine.ty - sr - 10);
      const transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
      tooltipTransformRef.current = transform;
      const tip = tooltipRef.current;
      if (tip !== null) {
        tip.style.transform = transform;
      }
    }

    function setHover(idx: number): void {
      if (idx === lastHover) {
        return;
      }
      lastHover = idx;
      engine.hover = idx;
      if (idx >= 0) {
        const nd = engine.nodes[idx];
        placeTooltip(nd);
        setHoverMeta({ title: nd.title, degree: nd.degree, fill: nd.fill });
      } else {
        setHoverMeta(null);
      }
      requestFrame();
    }

    function frame(): void {
      raf = 0;
      if (disposed) {
        return;
      }
      let active = false;

      if (engine.alpha > 0) {
        if (reducedRef.current) {
          settle(engine);
        } else {
          simTick(engine);
          active = engine.alpha > 0;
        }
      }

      // Пока идёт стабилизация и пользователь не вмешался — камера мягко держит граф в кадре.
      if (engine.autoFit && !engine.interacted) {
        const fit = computeFit(engine);
        if (fit !== null) {
          if (reducedRef.current) {
            engine.k = fit.k;
            engine.tx = fit.tx;
            engine.ty = fit.ty;
          } else {
            engine.k += (fit.k - engine.k) * 0.14;
            engine.tx += (fit.tx - engine.tx) * 0.14;
            engine.ty += (fit.ty - engine.ty) * 0.14;
          }
          const settled =
            Math.abs(fit.k - engine.k) < 0.002 && Math.abs(fit.tx - engine.tx) < 0.5 && Math.abs(fit.ty - engine.ty) < 0.5;
          if (engine.alpha > 0 || !settled) {
            active = true;
          } else {
            engine.autoFit = false;
          }
        }
      }

      // Полёт камеры к цели (двойной клик — «вписать»).
      if (engine.camTarget !== null) {
        const target = engine.camTarget;
        if (reducedRef.current) {
          engine.k = target.k;
          engine.tx = target.tx;
          engine.ty = target.ty;
          engine.camTarget = null;
        } else {
          engine.k += (target.k - engine.k) * 0.18;
          engine.tx += (target.tx - engine.tx) * 0.18;
          engine.ty += (target.ty - engine.ty) * 0.18;
          if (
            Math.abs(target.k - engine.k) < 0.001 &&
            Math.abs(target.tx - engine.tx) < 0.4 &&
            Math.abs(target.ty - engine.ty) < 0.4
          ) {
            engine.k = target.k;
            engine.tx = target.tx;
            engine.ty = target.ty;
            engine.camTarget = null;
          } else {
            active = true;
          }
        }
      }

      // Плавное затемнение/подсветка при ховере.
      const dimTarget = engine.hover >= 0 ? 1 : 0;
      if (Math.abs(engine.dim - dimTarget) > 0.004) {
        engine.dim += (dimTarget - engine.dim) * (reducedRef.current ? 1 : 0.22);
        active = true;
      } else {
        engine.dim = dimTarget;
      }

      drawScene(engine, ctx2d, labelsOnRef.current);
      if (engine.hover >= 0 && engine.hover < engine.nodes.length) {
        placeTooltip(engine.nodes[engine.hover]);
      }

      if (active) {
        raf = requestAnimationFrame(frame);
      }
    }

    function syncSize(): void {
      const rect = host.getBoundingClientRect();
      engine.w = Math.max(1, rect.width);
      engine.h = Math.max(1, rect.height);
      engine.dpr = Math.max(1, window.devicePixelRatio || 1);
      surface.width = Math.round(engine.w * engine.dpr);
      surface.height = Math.round(engine.h * engine.dpr);
      if (!engine.interacted && engine.nodes.length > 0) {
        jumpFit();
      }
      requestFrame();
    }

    async function load(): Promise<void> {
      if (!isTauriAvailable()) {
        if (!disposed) {
          setStatus('offline');
        }
        return;
      }
      setStatus('loading');
      try {
        const data = await commands.graphData();
        if (disposed) {
          return;
        }
        setHover(-1);
        buildEngine(engine, data);
        if (reducedRef.current) {
          settle(engine);
        }
        if (!engine.interacted) {
          jumpFit();
        }
        setStats({ nodes: engine.nodes.length, edges: engine.edges.length });
        setStatus('ready');
        requestFrame();
      } catch {
        if (!disposed) {
          setStatus('error');
        }
      }
    }

    function localPoint(ev: PointerEvent): { x: number; y: number } {
      const rect = surface.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }

    function pickNode(mx: number, my: number): number {
      const { nodes, order, k, tx, ty } = engine;
      for (let oi = order.length - 1; oi >= 0; oi -= 1) {
        const i = order[oi];
        const nd = nodes[i];
        const sx = nd.x * k + tx;
        const sy = nd.y * k + ty;
        const hit = Math.max(7, Math.max(2.4, nd.r * k) + 3);
        const dx = mx - sx;
        const dy = my - sy;
        if (dx * dx + dy * dy <= hit * hit) {
          return i;
        }
      }
      return -1;
    }

    const onPointerDown = (ev: PointerEvent): void => {
      if (ev.button !== 0 || engine.nodes.length === 0) {
        return;
      }
      const p = localPoint(ev);
      const idx = pickNode(p.x, p.y);
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch {
        // без capture перетаскивание тоже работает
      }
      if (idx >= 0) {
        const nd = engine.nodes[idx];
        const wx = (p.x - engine.tx) / engine.k;
        const wy = (p.y - engine.ty) / engine.k;
        drag = { mode: 'node', idx, offX: wx - nd.x, offY: wy - nd.y, startX: ev.clientX, startY: ev.clientY, moved: false };
        setHover(idx);
      } else {
        drag = { mode: 'pan', startX: ev.clientX, startY: ev.clientY, tx0: engine.tx, ty0: engine.ty, moved: false };
      }
      canvas.style.cursor = 'grabbing';
    };

    const onPointerMove = (ev: PointerEvent): void => {
      const p = localPoint(ev);
      if (drag === null) {
        const idx = pickNode(p.x, p.y);
        setHover(idx);
        canvas.style.cursor = idx >= 0 ? 'pointer' : 'grab';
        return;
      }
      const dxs = ev.clientX - drag.startX;
      const dys = ev.clientY - drag.startY;
      if (!drag.moved && dxs * dxs + dys * dys > CLICK_SLOP_PX * CLICK_SLOP_PX) {
        drag.moved = true;
      }
      if (drag.mode === 'pan') {
        if (!drag.moved) {
          return;
        }
        engine.tx = drag.tx0 + dxs;
        engine.ty = drag.ty0 + dys;
        engine.interacted = true;
        engine.autoFit = false;
        engine.camTarget = null;
        requestFrame();
        return;
      }
      const nd = engine.nodes[drag.idx];
      const wx = (p.x - engine.tx) / engine.k;
      const wy = (p.y - engine.ty) / engine.k;
      nd.fx = wx - drag.offX;
      nd.fy = wy - drag.offY;
      engine.interacted = true;
      engine.autoFit = false;
      if (reducedRef.current) {
        nd.x = nd.fx;
        nd.y = nd.fy;
      } else {
        engine.alpha = Math.max(engine.alpha, 0.3);
      }
      requestFrame();
    };

    const onPointerUp = (ev: PointerEvent): void => {
      if (drag === null) {
        return;
      }
      const done = drag;
      drag = null;
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch {
        // capture мог не устанавливаться
      }
      if (done.mode === 'node') {
        const nd = engine.nodes[done.idx];
        nd.fx = null;
        nd.fy = null;
        if (!done.moved) {
          useVaultStore.getState().openNote(nd.ref);
          useUiStore.getState().setRailView('tree');
          return;
        }
        if (!reducedRef.current) {
          engine.alpha = Math.max(engine.alpha, 0.1);
        }
      }
      const p = localPoint(ev);
      const idx = pickNode(p.x, p.y);
      setHover(idx);
      canvas.style.cursor = idx >= 0 ? 'pointer' : 'grab';
      requestFrame();
    };

    const onPointerCancel = (ev: PointerEvent): void => {
      if (drag?.mode === 'node') {
        const nd = engine.nodes[drag.idx];
        nd.fx = null;
        nd.fy = null;
      }
      drag = null;
      try {
        canvas.releasePointerCapture(ev.pointerId);
      } catch {
        // capture мог не устанавливаться
      }
      setHover(-1);
      canvas.style.cursor = 'grab';
    };

    const onPointerLeave = (): void => {
      if (drag === null) {
        setHover(-1);
        canvas.style.cursor = 'grab';
      }
    };

    const onWheel = (ev: WheelEvent): void => {
      ev.preventDefault();
      if (engine.nodes.length === 0) {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const delta = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
      const next = clamp(engine.k * Math.exp(-delta * 0.0012), MIN_ZOOM, MAX_ZOOM);
      if (next === engine.k) {
        return;
      }
      const wx = (mx - engine.tx) / engine.k;
      const wy = (my - engine.ty) / engine.k;
      engine.k = next;
      engine.tx = mx - wx * next;
      engine.ty = my - wy * next;
      engine.interacted = true;
      engine.autoFit = false;
      engine.camTarget = null;
      requestFrame();
    };

    const onDblClick = (): void => {
      const fit = computeFit(engine);
      if (fit === null) {
        return;
      }
      engine.interacted = true;
      engine.autoFit = false;
      engine.camTarget = fit;
      requestFrame();
    };

    canvas.style.cursor = 'grab';
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);

    const observer = new ResizeObserver(syncSize);
    observer.observe(wrap);
    syncSize();

    apiRef.current = {
      requestFrame,
      reload: () => {
        void load();
      },
    };
    void load();

    return () => {
      disposed = true;
      apiRef.current = null;
      if (raf !== 0) {
        cancelAnimationFrame(raf);
      }
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDblClick);
    };
  }, []);

  const rebuild = useCallback(() => {
    apiRef.current?.reload();
  }, []);

  let overlay: ReactNode = null;
  if (status === 'loading' && slowLoad) {
    overlay = (
      <Fade key="loading" className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        <span className="flex items-center gap-2 rounded-full border border-stroke-0 bg-bg-1/80 px-3.5 py-1.5 text-caption text-text-2 shadow-1 backdrop-blur-sm">
          <Loader2 size={13} className={cx('text-accent', !reduced && 'animate-spin')} />
          Собираем граф…
        </span>
      </Fade>
    );
  } else if (status === 'ready' && stats.nodes === 0) {
    overlay = (
      <StateCard
        key="empty"
        icon={Waypoints}
        title="Пока нет связей"
        text={
          <>
            Свяжите заметки ссылками{' '}
            <code className="rounded-xs bg-bg-3 px-1 py-0.5 font-mono text-micro text-accent">[[двойными скобками]]</code> —
            и граф оживёт.
          </>
        }
      />
    );
  } else if (status === 'offline') {
    overlay = (
      <StateCard
        key="offline"
        icon={Unplug}
        title="Ядро не подключено"
        text="Граф связей доступен в приложении Graphite — веб-предпросмотр работает без данных хранилища."
      />
    );
  } else if (status === 'error') {
    overlay = (
      <StateCard key="error" icon={CircleAlert} title="Не удалось построить граф" text="Ядро не ответило. Попробуйте пересобрать граф ещё раз.">
        <Button size="sm" onClick={rebuild}>
          Повторить
        </Button>
      </StateCard>
    );
  }

  const hasGraph = status === 'ready' && stats.nodes > 0;

  return (
    <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-bg-0">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 pb-4 pt-6">
        <div className="flex items-baseline gap-3">
          <h1 className="text-h2 text-text-0">Граф</h1>
          {hasGraph ? (
            <span className="animate-fade-in text-caption tabular-nums text-text-3">
              {stats.nodes} {plural(stats.nodes, 'заметка', 'заметки', 'заметок')} · {stats.edges}{' '}
              {plural(stats.edges, 'связь', 'связи', 'связей')}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-4">
          <label className="flex cursor-pointer select-none items-center gap-2 text-caption text-text-2">
            <Switch checked={labelsOn} onCheckedChange={setLabelsOn} aria-label="Показывать подписи узлов" />
            Подписи
          </label>
          <Button variant="ghost" size="sm" onClick={rebuild} disabled={status === 'loading' || status === 'offline'}>
            <RefreshCw size={14} className={cx(status === 'loading' && !reduced && 'animate-spin')} aria-hidden />
            Пересобрать
          </Button>
        </div>
      </header>

      <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 block h-full w-full touch-none"
          role="img"
          aria-label="Интерактивный граф связей между заметками"
        />

        <Presence>
          {hoverMeta !== null ? (
            <div
              key="tooltip"
              ref={tooltipRef}
              className="pointer-events-none absolute left-0 top-0 z-10 will-change-transform"
              style={{ transform: tooltipTransformRef.current }}
            >
              <motion.div
                className="flex max-w-[280px] flex-col gap-0.5 rounded-s border border-stroke-1 bg-bg-2/95 px-2.5 py-1.5 shadow-2 backdrop-blur-sm"
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 4 }}
                animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0, transition: springSnappy }}
                exit={{ opacity: 0, transition: { duration: 0.1, ease: easePoints.in } }}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: hoverMeta.fill }} aria-hidden />
                  <span className="truncate text-ui font-medium text-text-0">{hoverMeta.title}</span>
                </span>
                <span className="text-micro text-text-2">
                  {hoverMeta.degree} {plural(hoverMeta.degree, 'связь', 'связи', 'связей')} · клик — открыть
                </span>
              </motion.div>
            </div>
          ) : null}
        </Presence>

        <Presence>
          {hasGraph && stats.edges === 0 ? (
            <SlideUp key="link-hint" className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-6">
              <span className="rounded-full border border-stroke-0 bg-bg-1/80 px-3.5 py-1.5 text-caption text-text-2 shadow-1 backdrop-blur-sm">
                Заметки пока не связаны — сошлитесь из текста{' '}
                <code className="font-mono text-micro text-accent">[[двойными скобками]]</code>
              </span>
            </SlideUp>
          ) : null}
        </Presence>

        {hasGraph && stats.edges > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-6">
            <span className="animate-fade-in rounded-full border border-stroke-0 bg-bg-1/75 px-3 py-1 text-micro text-text-3 backdrop-blur-sm">
              Колесо — масштаб · Перетаскивание — панорама · Двойной клик — вписать
            </span>
          </div>
        ) : null}

        <Presence>{overlay}</Presence>
      </div>
    </main>
  );
}
