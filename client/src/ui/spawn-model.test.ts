import { describe, expect, it } from 'vitest';
import { askDisabledReason, defaultForm, toRequest } from './spawn-model';

const providers = [
  { id: 'claude' as const, available: false },
  { id: 'codex' as const, available: true },
];

describe('chat: janela de abrir agente', () => {
  it('padrão: primeiro provedor disponível, automático, sem papel, sem cópia, sem limites', () => {
    expect(defaultForm('C:\\proj', providers)).toMatchObject({ folder: 'C:\\proj', provider: 'codex', permission: 'auto', isolated: false, roleId: '', limitUsd: '', limitTokens: '', limitMinutes: '', name: '', prompt: '' });
    expect(defaultForm('C:\\proj', [{ id: 'claude', available: true }, ...providers.slice(1)]).provider).toBe('claude');
  });

  it('só o Claude pede aprovação ação por ação', () => {
    expect(askDisabledReason('codex')).toBe('O Codex não pede aprovação ação por ação: roda sempre no automático, com acesso total.');
    expect(askDisabledReason('antigravity')).toBe('O Antigravity não pede aprovação ação por ação: roda sempre no automático, com acesso total.');
    expect(askDisabledReason('claude')).toBeUndefined();
  });

  it('pedido: limites com vírgula, nome aparado, aprovação só no Claude', () => {
    const base = { ...defaultForm('C:\\proj', providers), prompt: ' faça X ', name: '  Ana ' };
    expect(toRequest({ ...base, provider: 'claude', limitUsd: '0,5', permission: 'ask' })).toMatchObject({ folder: 'C:\\proj', provider: 'claude', prompt: 'faça X', name: 'Ana', permission: 'ask', limits: { maxCostUsd: 0.5 } });
    expect(toRequest({ ...base, provider: 'claude', limitUsd: 'abc' })).toHaveProperty('error');
    expect(toRequest({ ...base, provider: 'codex', permission: 'ask' })).toMatchObject({ permission: 'auto', limits: {} });
    expect(toRequest({ ...base, prompt: '  ' })).toHaveProperty('error');
  });

  it('US$ só no Claude; tokens só no Codex/Antigravity; minutos em todos', () => {
    const base = { ...defaultForm('C:\\proj', providers), prompt: 'oi', limitUsd: '2', limitTokens: '1000', limitMinutes: '5' };
    expect(toRequest({ ...base, provider: 'claude' })).toMatchObject({ limits: { maxCostUsd: 2, maxTurnMinutes: 5 } });
    expect((toRequest({ ...base, provider: 'claude' }) as { limits: object }).limits).not.toHaveProperty('maxTokens');
    expect(toRequest({ ...base, provider: 'codex' })).toMatchObject({ limits: { maxTokens: 1000, maxTurnMinutes: 5 } });
    expect((toRequest({ ...base, provider: 'codex' }) as { limits: object }).limits).not.toHaveProperty('maxCostUsd');
  });

  it('campos opcionais vazios não vão no pedido', () => {
    const r = toRequest({ ...defaultForm('C:\\proj', providers), prompt: 'oi' }) as Record<string, unknown>;
    expect(r).not.toHaveProperty('roleId');
    expect(r).not.toHaveProperty('model');
    expect(r).not.toHaveProperty('name');
    expect(r.isolated).toBe(false);
  });
});
