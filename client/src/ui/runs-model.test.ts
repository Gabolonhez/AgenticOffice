import { describe, expect, it } from 'vitest';
import { toRunRequest } from './runs-model';
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
