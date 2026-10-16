import { describe, expect, it } from 'vitest';
import { addUsage, overLimit, remainingUsd, type Spend } from './usage';

describe('chat: uso e limites', () => {
  it('custo cumulativo do Claude: soma só a diferença e não zera no erro', () => {
    let s: Spend = { usd: 0, tokens: 0 };
    let r = addUsage(s, { type: 'usage', tokensIn: 100, tokensOut: 4, costUsd: 0.1015494, costIsCumulative: true });
    expect(r.turnUsd).toBeCloseTo(0.1015494); s = r.spend;
    r = addUsage(s, { type: 'usage', tokensIn: 200, tokensOut: 590, costUsd: 0.11005549, costIsCumulative: true });
    expect(r.turnUsd).toBeCloseTo(0.00850609); s = r.spend;
    expect(s.usd).toBeCloseTo(0.11005549);
    r = addUsage(s, { type: 'usage', tokensIn: 0, tokensOut: 0, costUsd: 0, costIsCumulative: true }); // rodada que falhou
    expect(r.spend.usd).toBeCloseTo(0.11005549);
    expect(r.spend.lastCumulativeUsd).toBeCloseTo(0.11005549);
    expect(s.tokens).toBe(100 + 4 + 200 + 590);
  });
  it('limite: US$ quando há custo, tokens quando não; bloqueia a partir do limite', () => {
    expect(overLimit({ usd: 0.5, tokens: 10 }, { maxCostUsd: 0.5 })).toBe('cost');
    expect(overLimit({ usd: 0.49, tokens: 10 }, { maxCostUsd: 0.5 })).toBeUndefined();
    expect(overLimit({ usd: 0, tokens: 50_000 }, { maxTokens: 50_000 })).toBe('tokens');
    expect(remainingUsd({ usd: 0.2, tokens: 0 }, { maxCostUsd: 0.5 })).toBeCloseTo(0.3);
    expect(remainingUsd({ usd: 0.2, tokens: 0 }, {})).toBeUndefined();
  });
});
