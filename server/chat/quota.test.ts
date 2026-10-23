import { describe, expect, it } from 'vitest';
import { envInt } from '../config';
import { quotaBlock } from './quota';

const limits = { fiveHour: 90, week: 95 };
const ok = (fiveHour?: number, sevenDay?: number) => ({
  status: 'ok' as const,
  usage: { source: 'statusline' as const, fetchedAt: 1, ...(fiveHour === undefined ? {} : { fiveHour: { utilization: fiveHour, resetsAt: 500 } }), ...(sevenDay === undefined ? {} : { sevenDay: { utilization: sevenDay, resetsAt: 900 } }) },
});

describe('chat: pausa pela cota da conta', () => {
  it('trava no limite ou acima; a semanal primeiro', () => {
    expect(quotaBlock(ok(90.4, 10), limits)).toEqual({ window: '5h', pct: 90, resetsAt: 500 });
    expect(quotaBlock(ok(89, 94), limits)).toBeUndefined();
    expect(quotaBlock(ok(90), limits)).toEqual({ window: '5h', pct: 90, resetsAt: 500 });
    expect(quotaBlock(ok(99, 95), limits)).toEqual({ window: 'week', pct: 95, resetsAt: 900 });
  });

  it('número velho ou desconhecido não trava', () => {
    expect(quotaBlock({ ...ok(100, 100), status: 'stale' }, limits)).toBeUndefined();
    expect(quotaBlock({ status: 'disabled' }, limits)).toBeUndefined();
    expect(quotaBlock(undefined, limits)).toBeUndefined();
    expect(quotaBlock(ok(), limits)).toBeUndefined();
  });

  it('envInt: inteiro dentro da faixa; senão o padrão', () => {
    expect(envInt(undefined, 2, 1)).toBe(2);
    expect(envInt(' 3 ', 2, 1)).toBe(3);
    expect(envInt('0', 2, 1)).toBe(2);
    expect(envInt('1.5', 2, 1)).toBe(2);
    expect(envInt('abc', 90, 1, 100)).toBe(90);
    expect(envInt('101', 90, 1, 100)).toBe(90);
    expect(envInt('100', 90, 1, 100)).toBe(100);
  });
});
