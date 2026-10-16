import { describe, expect, it } from 'vitest';
import {
  autoLayout,
  boundsOf,
  buildLinks,
  CARD_H,
  CARD_W,
  fitView,
  groupCards,
  MAX_ZOOM,
  MIN_ZOOM,
  overlaps,
  parseLinks,
  parseState,
  RECENT_MS,
  serializeState,
  toWorld,
  zoomAt,
  type Rect,
} from './canvas-model';

const rect = (p: { x: number; y: number }): Rect => ({ ...p, w: CARD_W, h: CARD_H });

describe('quadro: cartões', () => {
  it('subagentes entram no cartão do principal; sem o principal, viram cartão próprio', () => {
    const agents = [
      { id: 'a', kind: 'main' as const },
      { id: 's1', kind: 'sub' as const, parentId: 'a' },
      { id: 's2', kind: 'sub' as const, parentId: 'sumiu' },
      { id: 'b', kind: 'main' as const },
    ];
    const g = groupCards(agents);
    expect(g.map((c) => [c.card.id, c.subs.map((s) => s.id)])).toEqual([
      ['a', ['s1']],
      ['s2', []],
      ['b', []],
    ]);
  });
});

describe('quadro: arrumação automática', () => {
  it('agrupa por sala em colunas, sem sobrepor', () => {
    const cards = [
      { id: 'a', roomId: 'r1' },
      { id: 'b', roomId: 'r2' },
      { id: 'c', roomId: 'r1' },
    ];
    const pos = autoLayout(cards, ['r1', 'r2'], {});
    expect(pos.a.x).toBe(pos.c.x);
    expect(pos.b.x).toBeGreaterThan(pos.a.x);
    expect(pos.c.y).toBeGreaterThan(pos.a.y);
    const rects = Object.values(pos).map(rect);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i], rects[j])).toBe(false);
  });

  it('mantém posições salvas e encaixa os novos sem cobrir ninguém (nem notas)', () => {
    const saved = { a: { x: 0, y: 10 } };
    const note: Rect = { x: 0, y: 200, w: 100, h: 100 };
    const pos = autoLayout(
      [
        { id: 'a', roomId: 'r1' },
        { id: 'n', roomId: 'r1' },
        { id: 'm', roomId: 'r1' },
      ],
      ['r1'],
      saved,
      [note],
    );
    expect(pos.a).toEqual({ x: 0, y: 10 });
    const all = [rect(pos.a), rect(pos.n), rect(pos.m), note];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i], all[j])).toBe(false);
  });

  it('sala fora da ordem vai para depois das conhecidas', () => {
    const pos = autoLayout([{ id: 'x', roomId: 'nova' }, { id: 'a', roomId: 'r1' }], ['r1'], {});
    expect(pos.x.x).toBeGreaterThan(pos.a.x);
  });
});

describe('quadro: ligações', () => {
  const cardOf = (id: string) => ({ a: 'a', b: 'b', c: 'c', s1: 'a' })[id];

  it('lê a resposta da API tolerando lixo', () => {
    expect(parseLinks(null)).toEqual([]);
    expect(parseLinks({ links: [] })).toEqual([]);
    expect(parseLinks([{ from: 'a', to: 'b', at: 5 }, { from: 1 }, 'x', { from: 'a', to: 'b', at: 'x' }])).toEqual([{ from: 'a', to: 'b', at: 5 }]);
  });

  it('junta pares nos dois sentidos, guarda o mais recente e marca o recente', () => {
    const now = 1_000_000;
    const links = buildLinks(
      [
        { from: 'a', to: 'b', at: now - RECENT_MS - 5 },
        { from: 'b', to: 'a', at: now - 10 },
        { from: 'c', to: 'b', at: now - RECENT_MS - 1 },
      ],
      cardOf,
      now,
    );
    expect(links).toEqual([
      { from: 'c', to: 'b', at: now - RECENT_MS - 1, recent: false },
      { from: 'b', to: 'a', at: now - 10, recent: true },
    ]);
  });

  it('subagente liga pelo cartão do principal; descarta desconhecidos e o próprio cartão', () => {
    const links = buildLinks(
      [
        { from: 's1', to: 'b', at: 1 },
        { from: 's1', to: 'a', at: 2 },
        { from: 'zz', to: 'a', at: 3 },
      ],
      cardOf,
      10,
    );
    expect(links.map((l) => [l.from, l.to])).toEqual([['a', 'b']]);
  });
});

describe('quadro: câmera', () => {
  it('zoom em volta do cursor mantém o ponto sob ele', () => {
    const v = { x: 30, y: -20, k: 1 };
    const before = toWorld(v, 200, 150);
    const z = zoomAt(v, 1.5, 200, 150);
    expect(z.k).toBe(1.5);
    const after = toWorld(z, 200, 150);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('zoom tem limites', () => {
    expect(zoomAt({ x: 0, y: 0, k: 1 }, 100, 0, 0).k).toBe(MAX_ZOOM);
    expect(zoomAt({ x: 0, y: 0, k: 1 }, 0.001, 0, 0).k).toBe(MIN_ZOOM);
  });

  it('enquadrar tudo cabe na tela e centraliza; sem nada, volta ao início', () => {
    const rects: Rect[] = [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 900, y: 400, w: 100, h: 100 },
    ];
    expect(boundsOf(rects)).toEqual({ x: 0, y: 0, w: 1000, h: 500 });
    const v = fitView(rects, 540, 540, 20);
    expect(v.k).toBeCloseTo(0.5);
    // Centro do conjunto (500, 250) no centro da tela (270, 270).
    expect(500 * v.k + v.x).toBeCloseTo(270);
    expect(250 * v.k + v.y).toBeCloseTo(270);
    // Poucos cartões: não amplia além de 1.
    expect(fitView([{ x: 0, y: 0, w: 10, h: 10 }], 1000, 1000).k).toBe(1);
    expect(fitView([], 800, 600)).toEqual({ x: 40, y: 40, k: 1 });
  });
});

describe('quadro: o que fica salvo', () => {
  it('ida e volta', () => {
    const s = { pos: { a: { x: 1, y: 2 } }, notes: [{ id: 'n1', x: 3, y: 4, text: 'oi', color: 'pink' as const }] };
    expect(parseState(serializeState(s))).toEqual(s);
  });

  it('tolera lixo', () => {
    const empty = { pos: {}, notes: [] };
    expect(parseState(null)).toEqual(empty);
    expect(parseState('{nope')).toEqual(empty);
    expect(parseState('42')).toEqual(empty);
    expect(parseState('{"pos":[1],"notes":{}}')).toEqual(empty);
    const s = parseState(
      JSON.stringify({
        pos: { a: { x: 1, y: 2 }, b: { x: 'x', y: 1 }, c: null, d: { x: 1e400, y: 0 } },
        notes: [{ id: 'n', x: 0, y: 0, text: 5, color: 'roxo' }, { id: 'ok', x: 0, y: 0, text: 'a'.repeat(5000), color: 'blue' }, null],
      }),
    );
    expect(s.pos).toEqual({ a: { x: 1, y: 2 } });
    expect(s.notes).toHaveLength(2);
    expect(s.notes[0]).toEqual({ id: 'n', x: 0, y: 0, text: '', color: 'yellow' });
    expect(s.notes[1].text).toHaveLength(2000);
  });
});
