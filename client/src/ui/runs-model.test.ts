import { describe, expect, it } from 'vitest';
import { runLabel, toRunRequest } from './runs-model';
import { defaultForm } from './spawn-model';

const form = { ...defaultForm('C:\\proj', [{ id: 'claude', available: true }]), roleId: 'dev', isolated: true, limitUsd: '2', name: 'Bia' };

describe('toRunRequest', () => {
  it('opções do agente sem pedido/nome/cópia; contexto aparado; cópia vale para a lista', () => {
    expect(toRunRequest(form, [{ text: 'a' }, { text: 'b', vboardsTaskId: 'c:s' }], '  ctx  ', true)).toEqual({
      items: [{ text: 'a' }, { text: 'b', vboardsTaskId: 'c:s' }],
      context: 'ctx',
      stopOnFail: true,
      isolated: true,
      options: { folder: 'C:\\proj', provider: 'claude', roleId: 'dev', permission: 'auto', limits: { maxCostUsd: 2 } },
    });
  });

  it('sem itens, itens demais ou limite inválido dão erro', () => {
    expect(toRunRequest(form, [], '', true)).toHaveProperty('error');
    expect(toRunRequest(form, Array.from({ length: 51 }, () => ({ text: 'x' })), '', true)).toHaveProperty('error');
    expect(toRunRequest({ ...form, limitUsd: 'abc' }, [{ text: 'a' }], '', false)).toHaveProperty('error');
  });
});

describe('runLabel', () => {
  it('pausada pela cota: janela, uso e quando volta (a automática volta sozinha)', () => {
    const now = new Date(2026, 9, 23, 10, 0).getTime();
    const resetsAt = new Date(2026, 9, 23, 14, 30).getTime();
    expect(runLabel({ state: 'paused', quota: { window: '5h', pct: 93, resetsAt }, auto: { reviewer: 'claude' } }, now)).toMatch(/^pausada: cota de 5 h em 93% · volta sozinha às 14:30$/);
    expect(runLabel({ state: 'paused', quota: { window: 'week', pct: 96 } }, now)).toBe('pausada: cota de semana em 96%');
    expect(runLabel({ state: 'paused' }, now)).toBe('pausada (o servidor reiniciou)');
    expect(runLabel({ state: 'queued' }, now)).toContain('na fila');
  });
});
