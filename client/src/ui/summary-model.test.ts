import { describe, expect, it } from 'vitest';
import { costLabel, summaryFooter } from './summary-model';

describe('resumo do dia: rodapé', () => {
  it('custo em dólares com 4 casas; ausente = vazio', () => {
    expect(costLabel(0.00213)).toBe('US$ 0.0021');
    expect(costLabel(undefined)).toBe('');
  });
  it('IA mostra o custo; lista simples mostra o motivo da queda', () => {
    expect(summaryFooter({ generatedAt: 1, costUsd: 0.01 })).toContain('US$ 0.0100');
    expect(summaryFooter({ generatedAt: 1, fallbackReason: 'sem CLI' })).toContain('sem CLI');
    expect(summaryFooter({ generatedAt: 1 })).toContain('Lista simples');
  });
});
