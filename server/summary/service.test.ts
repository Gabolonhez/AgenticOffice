import { describe, expect, it, vi } from 'vitest';
import { aiPrompt, DaySummaryService } from './service';

const NOW = new Date(2026, 9, 16, 15, 0).getTime();
const gather = async () => ({ agents: [], chats: [], commits: [{ project: '/p/app', subjects: ['feat: x'] }] });

describe('DaySummaryService', () => {
  it('IA: devolve o texto e o custo, e guarda o último do dia', async () => {
    const runner = vi.fn(async (_p: string) => ({ text: 'Resumo da IA', costUsd: 0.002 }));
    const svc = new DaySummaryService({ gather, runner, now: () => NOW });
    expect(svc.last()).toBeUndefined();
    const r = await svc.generate('ai');
    expect(r).toMatchObject({ text: 'Resumo da IA', costUsd: 0.002, generatedAt: NOW });
    expect(runner.mock.calls[0][0]).toContain('commit: feat: x');
    expect(svc.last()).toEqual(r);
  });

  it('cache vale só no mesmo dia', async () => {
    let now = NOW;
    const svc = new DaySummaryService({ gather, runner: async () => ({ text: 'x' }), now: () => now });
    await svc.generate('ai');
    now += 24 * 3600_000;
    expect(svc.last()).toBeUndefined();
  });

  it('cai na lista quando a IA falha, com o motivo', async () => {
    const svc = new DaySummaryService({ gather, runner: async () => Promise.reject(new Error('sem CLI')), now: () => NOW });
    const r = await svc.generate('ai');
    expect(r.text).toContain('- commit: feat: x');
    expect(r.fallbackReason).toBe('sem CLI');
    expect(svc.last()).toBeUndefined();
  });

  it('modo lista não chama a IA; dia vazio também não', async () => {
    const runner = vi.fn(async () => ({ text: 'x' }));
    const svc = new DaySummaryService({ gather, runner, now: () => NOW });
    expect((await svc.generate('list')).text).toContain('## app');
    const empty = new DaySummaryService({ gather: async () => ({ agents: [], chats: [], commits: [] }), runner, now: () => NOW });
    expect((await empty.generate('ai')).text).toBe('Nada registrado hoje.');
    expect(runner).not.toHaveBeenCalled();
  });

  it('cliques repetidos esperam a mesma rodada', async () => {
    const runner = vi.fn(async () => ({ text: 'x' }));
    const svc = new DaySummaryService({ gather, runner, now: () => NOW });
    await Promise.all([svc.generate('ai'), svc.generate('ai')]);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('o prompt manda não inventar e o material', () => {
    expect(aiPrompt('MATERIAL')).toMatch(/não invente/i);
    expect(aiPrompt('MATERIAL')).toContain('MATERIAL');
  });
});
