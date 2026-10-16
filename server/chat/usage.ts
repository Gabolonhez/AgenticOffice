// Uso somado de um agente do chat e os limites de custo/tokens (o de tempo vale por rodada, no ChatService).
import type { ChatLimits } from '../../shared/chat';
import type { ChatEvent } from './types';

export interface Spend { usd: number; tokens: number; lastCumulativeUsd?: number }

/**
 * Soma uma rodada. O Claude manda o custo acumulado da sessão (e 0 numa rodada que falhou): só a diferença conta, e a
 * base nunca desce.
 */
export function addUsage(s: Spend, e: Extract<ChatEvent, { type: 'usage' }>): { spend: Spend; turnUsd?: number } {
  const tokens = s.tokens + e.tokensIn + e.tokensOut;
  if (e.costUsd === undefined) return { spend: { ...s, tokens } };
  if (!e.costIsCumulative) return { spend: { ...s, tokens, usd: s.usd + e.costUsd }, turnUsd: e.costUsd };
  const last = s.lastCumulativeUsd ?? 0;
  const turnUsd = Math.max(0, e.costUsd - last);
  return { spend: { usd: s.usd + turnUsd, tokens, lastCumulativeUsd: Math.max(last, e.costUsd) }, turnUsd };
}

export function overLimit(s: Spend, l: ChatLimits): 'cost' | 'tokens' | undefined {
  if (l.maxCostUsd !== undefined && s.usd >= l.maxCostUsd) return 'cost';
  if (l.maxTokens !== undefined && s.tokens >= l.maxTokens) return 'tokens';
  return undefined;
}

export function remainingUsd(s: Spend, l: ChatLimits): number | undefined {
  return l.maxCostUsd === undefined ? undefined : Math.max(0, l.maxCostUsd - s.usd);
}
