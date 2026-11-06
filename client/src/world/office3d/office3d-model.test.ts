import { describe, expect, it } from 'vitest';
import { assignSeats, COFFEE_AFTER_MS, employeeModelFor, moodFor, pickOffice, placementFor, type OfficeEntry, type Seat } from './office3d-model';

const seat = (id: string, sala: string, over: Partial<Seat> = {}): Seat => ({ id, andar: 0, x: 1, y: 0.1, z: 2, yaw: 0, altura: 0.5, pose: 'type', trabalho: true, sala, ...over });
const office = (id: string, postos: number, andares = 1): OfficeEntry => ({ id, nome: id, arquivo: '', dados: '', andares, postos_de_trabalho: postos, assentos: postos, mb: 1 });

describe('moodFor', () => {
  it('mapeia o estado do agente para a animação', () => {
    expect(moodFor('working', 'type')).toEqual({ clip: 'digitando', standing: false });
    expect(moodFor('working', 'laptop').clip).toBe('notebook');
    expect(moodFor('shell', 'type').clip).toBe('digitando');
    expect(moodFor('working', 'stand').clip).toBe('digitando_em_pe');
    expect(moodFor('waiting', 'type')).toEqual({ clip: 'acenando', standing: true });
    expect(moodFor('done', 'type')).toEqual({ clip: 'apresentando', standing: true });
    expect(moodFor('idle', 'type', 1000)).toEqual({ clip: 'sentado', standing: false });
    expect(moodFor('idle', 'type', COFFEE_AFTER_MS)).toEqual({ clip: 'cafe', standing: true });
    expect(moodFor('offline', 'rest').clip).toBe('sentado');
  });
});

describe('placementFor', () => {
  it('senta descontando 0,47 e, em pé, recua pelas costas da cadeira', () => {
    expect(placementFor(seat('a', 's'), false).y).toBeCloseTo(0.1 + 0.5 - 0.47);
    const back = placementFor(seat('a', 's', { yaw: Math.PI }), true);
    expect(back.y).toBe(0.1);
    expect(back.z).toBeCloseTo(2 + 0.65); // virada para -z: as costas ficam em +z
    expect(placementFor(seat('a', 's', { pose: 'stand' }), false).y).toBe(0.1);
  });
});

describe('employeeModelFor', () => {
  it('é estável e fica entre 1 e 8', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `.claude:${i}`);
    const ns = ids.map(employeeModelFor);
    expect(ns).toEqual(ids.map(employeeModelFor));
    expect(Math.min(...ns)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...ns)).toBeLessThanOrEqual(8);
    expect(new Set(ns).size).toBe(8);
  });
});

describe('pickOffice', () => {
  const list = [office('grande', 244, 5), office('pequeno', 7), office('medio', 34)];
  it('escolhe o menor que comporta agentes e projetos', () => {
    expect(pickOffice(list, 3, 1)?.id).toBe('pequeno');
    expect(pickOffice(list, 3, 3)?.id).toBe('medio'); // 3 projetos pedem 12 postos
    expect(pickOffice(list, 100, 2)?.id).toBe('grande');
    expect(pickOffice(list, 900, 2)?.id).toBe('grande');
    expect(pickOffice([], 1, 1)).toBeNull();
  });
});

describe('assignSeats', () => {
  const seats = [seat('a1', 'A'), seat('a2', 'A'), seat('b1', 'B'), seat('b2', 'B'), seat('l1', 'L', { trabalho: false, pose: 'lounge' })];
  const rooms = [{ id: '/p/x', name: 'x', slot: 0 }, { id: '/p/y', name: 'y', slot: 1 }];
  const ag = (id: string, roomId: string, startedAt = 0) => ({ id, roomId, startedAt });

  it('cada projeto ocupa uma sala e o resultado é estável', () => {
    const agents = [ag('1', '/p/x', 1), ag('2', '/p/y', 2), ag('3', '/p/x', 3)];
    const r = assignSeats(agents, rooms, seats);
    expect(r.seats.get('1')?.sala).toBe('A');
    expect(r.seats.get('3')?.sala).toBe('A');
    expect(r.seats.get('2')?.sala).toBe('B');
    expect(assignSeats([...agents].reverse(), rooms, seats).seats.get('2')).toEqual(r.seats.get('2'));
  });

  it('a sala de mesmo nome vence a ordem', () => {
    const r = assignSeats([ag('1', '/p/y')], [{ id: '/p/y', name: 'b', slot: 0 }], seats);
    expect(r.seats.get('1')?.sala).toBe('B');
  });

  it('transborda para outras salas, depois para lugares sem mesa, e informa quem ficou sem lugar', () => {
    const agents = ['1', '2', '3', '4', '5', '6'].map((id, i) => ag(id, '/p/x', i));
    const r = assignSeats(agents, rooms, seats);
    expect(r.seats.size).toBe(5);
    expect(r.seats.get('5')?.id).toBe('l1');
    expect(r.missing).toEqual(['6']);
    expect(new Set([...r.seats.values()].map((s) => s.id)).size).toBe(5);
  });

  it('quem já estava sentado continua no lugar', () => {
    const keep = new Map([['3', 'a1']]);
    const r = assignSeats([ag('1', '/p/x', 1), ag('3', '/p/x', 3)], rooms, seats, keep);
    expect(r.seats.get('3')?.id).toBe('a1');
    expect(r.seats.get('1')?.id).toBe('a2');
  });
});
