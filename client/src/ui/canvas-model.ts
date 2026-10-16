// Modelo puro do quadro (ui/canvas.ts): cartões por agente, arrumação automática por sala, ligações entre agentes,
// contas da câmera (zoom em volta do cursor, enquadrar tudo) e o que fica salvo no navegador (posições e notas).

export interface Pos {
  x: number;
  y: number;
}
export interface Rect extends Pos {
  w: number;
  h: number;
}
/** Câmera do quadro: tela = mundo * k + (x, y). */
export interface View extends Pos {
  k: number;
}

/** Tamanho fixo dos cartões e das notas: a geometria (linhas, enquadrar, sobreposição) não depende do DOM. */
export const CARD_W = 264;
export const CARD_H = 156;
export const NOTE_W = 180;
export const NOTE_H = 140;
export const GAP = 28;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2.5;
/** Conversa entre agentes há menos que isto: linha em destaque. */
export const RECENT_MS = 10 * 60_000;

// ---------------------------------------------------------------- cartões

interface CardAgent {
  id: string;
  kind: 'main' | 'sub';
  parentId?: string;
}

/** Um cartão por principal (com os subagentes dentro); subagente sem o principal presente ganha cartão próprio. */
export function groupCards<A extends CardAgent>(agents: readonly A[]): { card: A; subs: A[] }[] {
  const mains = new Set(agents.filter((a) => a.kind === 'main').map((a) => a.id));
  const inCard = (a: A) => a.kind === 'sub' && !!a.parentId && mains.has(a.parentId);
  return agents.filter((a) => !inCard(a)).map((card) => ({ card, subs: agents.filter((s) => inCard(s) && s.parentId === card.id) }));
}

// ---------------------------------------------------------------- arrumação

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Posição de cada cartão: a salva, se houver; os novos vão para a coluna da sua sala (na ordem `roomOrder`; salas
 * desconhecidas depois), na primeira vaga de cima para baixo que não cubra nenhum cartão nem `obstacles` (notas).
 */
export function autoLayout(cards: readonly { id: string; roomId: string }[], roomOrder: readonly string[], saved: Readonly<Record<string, Pos>>, obstacles: readonly Rect[] = []): Record<string, Pos> {
  const out: Record<string, Pos> = {};
  const taken: Rect[] = [...obstacles];
  for (const c of cards) {
    const p = saved[c.id];
    if (!p) continue;
    out[c.id] = p;
    taken.push({ ...p, w: CARD_W, h: CARD_H });
  }
  const extra: string[] = [];
  const col = (roomId: string) => {
    let i = roomOrder.indexOf(roomId);
    if (i < 0) {
      if (!extra.includes(roomId)) extra.push(roomId);
      i = roomOrder.length + extra.indexOf(roomId);
    }
    return i;
  };
  for (const c of cards) {
    if (out[c.id]) continue;
    const r: Rect = { x: col(c.roomId) * (CARD_W + GAP), y: 0, w: CARD_W, h: CARD_H };
    // Termina: há finitos retângulos e cada passo desce uma vaga inteira.
    while (taken.some((t) => overlaps(r, t))) r.y += CARD_H + GAP;
    out[c.id] = { x: r.x, y: r.y };
    taken.push(r);
  }
  return out;
}

// ---------------------------------------------------------------- ligações

export interface ChatLink {
  from: string;
  to: string;
  at: number;
}
export interface Link extends ChatLink {
  recent: boolean;
}

/** Resposta de GET /api/chat/links ([{from, to, at}]); o que não tiver essa forma é ignorado. */
export function parseLinks(raw: unknown): ChatLink[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((l): l is ChatLink => !!l && typeof l.from === 'string' && typeof l.to === 'string' && Number.isFinite(l.at)).map(({ from, to, at }) => ({ from, to, at }));
}

/**
 * Uma linha por par de cartões (os dois sentidos contam como o mesmo par), com o sentido e o instante da conversa mais
 * recente; subagentes ligam pelo cartão em que estão (`cardOf`), e o que não tem cartão ou cai no mesmo cartão sai.
 * Ordem: das mais antigas para as mais recentes (as recentes ficam por cima).
 */
export function buildLinks(links: readonly ChatLink[], cardOf: (agentId: string) => string | undefined, now: number, recentMs = RECENT_MS): Link[] {
  const best = new Map<string, ChatLink>();
  for (const l of links) {
    const from = cardOf(l.from);
    const to = cardOf(l.to);
    if (!from || !to || from === to) continue;
    const key = from < to ? `${from}\n${to}` : `${to}\n${from}`;
    const prev = best.get(key);
    if (!prev || l.at > prev.at) best.set(key, { from, to, at: l.at });
  }
  return [...best.values()].sort((a, b) => a.at - b.at).map((l) => ({ ...l, recent: now - l.at < recentMs }));
}

// ---------------------------------------------------------------- câmera

const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

export function toWorld(v: View, sx: number, sy: number): Pos {
  return { x: (sx - v.x) / v.k, y: (sy - v.y) / v.k };
}

/** Zoom por `factor` mantendo parado o ponto do mundo sob (sx, sy). */
export function zoomAt(v: View, factor: number, sx: number, sy: number): View {
  const k = clampZoom(v.k * factor);
  const f = k / v.k;
  return { k, x: sx - (sx - v.x) * f, y: sy - (sy - v.y) * f };
}

export function boundsOf(rects: readonly Rect[]): Rect | null {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

/** Câmera que mostra todos os retângulos numa tela w × h (margem `pad`), sem ampliar além de 1:1. */
export function fitView(rects: readonly Rect[], w: number, h: number, pad = 40): View {
  const b = boundsOf(rects);
  if (!b) return { x: pad, y: pad, k: 1 };
  const k = clampZoom(Math.min(1, (w - 2 * pad) / b.w, (h - 2 * pad) / b.h));
  return { k, x: w / 2 - (b.x + b.w / 2) * k, y: h / 2 - (b.y + b.h / 2) * k };
}

// ---------------------------------------------------------------- o que fica salvo

export const NOTE_COLORS = ['yellow', 'pink', 'blue', 'green'] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];
export const NOTE_MAX = 2000;

export interface Note extends Pos {
  id: string;
  text: string;
  color: NoteColor;
}
export interface CanvasState {
  /** Posição de cada cartão, pelo id do agente. */
  pos: Record<string, Pos>;
  notes: Note[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isPos = (v: unknown): v is Pos & Record<string, unknown> => isObj(v) && Number.isFinite(v.x) && Number.isFinite(v.y);

/** Lê o estado salvo; JSON quebrado, de outra versão ou com itens inválidos vira o que der para aproveitar. */
export function parseState(raw: string | null): CanvasState {
  const out: CanvasState = { pos: {}, notes: [] };
  let data: unknown;
  try {
    data = JSON.parse(raw ?? '');
  } catch {
    return out;
  }
  if (!isObj(data)) return out;
  if (isObj(data.pos)) for (const [id, p] of Object.entries(data.pos)) if (isPos(p)) out.pos[id] = { x: p.x, y: p.y };
  if (Array.isArray(data.notes))
    for (const n of data.notes) {
      if (!isPos(n) || typeof n.id !== 'string') continue;
      const color = NOTE_COLORS.includes(n.color as NoteColor) ? (n.color as NoteColor) : 'yellow';
      out.notes.push({ id: n.id, x: n.x, y: n.y, text: typeof n.text === 'string' ? n.text.slice(0, NOTE_MAX) : '', color });
    }
  return out;
}

export function serializeState(s: CanvasState): string {
  return JSON.stringify(s);
}
