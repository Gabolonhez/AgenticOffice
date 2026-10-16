import { describe, expect, it } from 'vitest';
import type { ChatState } from '../../../shared/chat';
import { afterSeq, canSendChat, chatStatusText, mergeItems, pollDelayChat, toolLine, usageText } from './chat-model';

const st = (o: Partial<ChatState> = {}): ChatState => ({ phase: 'idle', spentUsd: 0, spentTokens: 0, limits: {}, ...o });

describe('chat: modelo do painel', () => {
  it('status ao vivo', () => {
    expect(chatStatusText(st({ phase: 'thinking' }))).toBe('Pensando…');
    expect(chatStatusText(st({ phase: 'tool', tool: 'Bash' }))).toBe('Usando Bash…');
    expect(chatStatusText(st({ phase: 'approval' }))).toBe('Esperando sua aprovação');
    expect(chatStatusText(st({ phase: 'stopping' }))).toBe('Parando…');
    expect(chatStatusText(st())).toBe('');
    expect(chatStatusText(st({ blocked: 'cost', limits: { maxCostUsd: 1 } }))).toBe('Limite de custo atingido (US$ 1,00). Aumente o limite para continuar.');
    expect(chatStatusText(st({ blocked: 'tokens', limits: { maxTokens: 50000 } }))).toBe('Limite de tokens atingido (50 k). Aumente o limite para continuar.');
  });

  it('uso da rodada (tokens no formato da casa; centavos com 4 casas)', () => {
    expect(usageText({ seq: 1, at: 0, kind: 'usage', tokensIn: 185486, tokensOut: 590, costUsd: 0.0085, ms: 11191 })).toBe('185,5 k tokens de entrada · 590 de saída · US$ 0,0085 · 11 s');
    expect(usageText({ seq: 1, at: 0, kind: 'usage', tokensIn: 1200, tokensOut: 40, ms: 3000 })).toBe('1,2 k tokens de entrada · 40 de saída · 3 s');
    expect(usageText({ seq: 1, at: 0, kind: 'usage', tokensIn: 10, tokensOut: 1, costUsd: 0.25, ms: 1000 })).toBe('10 tokens de entrada · 1 de saída · US$ 0,25 · 1 s');
  });

  it('linha da ferramenta', () => {
    expect(toolLine({ seq: 1, at: 0, kind: 'tool', toolId: 't', name: 'Bash', input: 'npm test', output: 'ok' })).toEqual({ title: 'Bash: npm test', detail: 'ok', failed: false });
    expect(toolLine({ seq: 1, at: 0, kind: 'tool', toolId: 't', name: 'Bash', input: 'x', error: true })).toMatchObject({ failed: true, detail: '' });
  });

  it('envio: vazio, rodando ou bloqueado não manda', () => {
    expect(canSendChat('  ', st())).toMatchObject({ ok: false });
    expect(canSendChat('oi', st({ phase: 'thinking' }))).toEqual({ ok: false, why: 'Espere a rodada terminar ou toque em Parar.' });
    expect(canSendChat('oi', st({ blocked: 'tokens' }))).toMatchObject({ ok: false });
    expect(canSendChat('oi', st())).toEqual({ ok: true });
  });

  it('itens chegam por seq sem duplicar', () => {
    const a = { seq: 1, at: 0, kind: 'user', text: 'a' } as const;
    const b = { seq: 2, at: 0, kind: 'assistant', text: 'b' } as const;
    const b2 = { ...b, text: 'b atualizado' };
    expect(mergeItems([a], [a, b])).toEqual([a, b]);
    expect(mergeItems([a, b], [b2])).toEqual([a, b2]); // item atualizado (saída da ferramenta) troca o antigo
  });

  it('busca de novo a partir da 1ª ferramenta ainda sem saída (a saída chega depois, no mesmo item)', () => {
    const u = { seq: 1, at: 0, kind: 'user', text: 'a' } as const;
    const t = { seq: 2, at: 0, kind: 'tool', toolId: 't', name: 'Bash', input: 'ls' } as const;
    const x = { seq: 3, at: 0, kind: 'assistant', text: 'b' } as const;
    expect(afterSeq([u, t, x], st({ phase: 'tool' }))).toBe(1);
    expect(afterSeq([u, { ...t, output: '' }, x], st({ phase: 'tool' }))).toBe(3);
    expect(afterSeq([u, t, x], st())).toBe(3); // rodada acabou: a saída não vem mais
    expect(afterSeq([], st())).toBe(0);
  });

  it('busca mais rápido com a rodada em andamento', () => {
    expect(pollDelayChat(st({ phase: 'tool' }))).toBe(700);
    expect(pollDelayChat(st())).toBe(4000);
  });
});
