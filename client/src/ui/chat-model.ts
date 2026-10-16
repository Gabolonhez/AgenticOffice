// Lógica pura do painel do chat com agentes (ui/chat.ts): textos de status e uso, envio, junção dos itens buscados.
import type { ChatItem, ChatState } from '../../../shared/chat';
import { intlLocale, tr } from '../../../shared/i18n';
import { formatDuration, formatTokens, formatUSD } from './format';

/** Custo de uma rodada: abaixo de 1 centavo, 4 casas ("US$ 0,01" esconderia a ordem de grandeza). */
function usd(n: number): string {
  if (n >= 0.01 || n === 0) return formatUSD(n);
  const v = new Intl.NumberFormat(intlLocale(), { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(n);
  return `US$ ${v}`;
}

export function chatStatusText(s: ChatState): string {
  if (s.blocked === 'cost') return tr('Limite de custo atingido ({0}). Aumente o limite para continuar.', [formatUSD(s.limits.maxCostUsd ?? s.spentUsd)]);
  if (s.blocked === 'tokens') return tr('Limite de tokens atingido ({0}). Aumente o limite para continuar.', [formatTokens(s.limits.maxTokens ?? s.spentTokens)]);
  switch (s.phase) {
    case 'thinking':
      return tr('Pensando…');
    case 'tool':
      return s.tool ? tr('Usando {0}…', [s.tool]) : tr('Trabalhando…');
    case 'approval':
      return tr('Esperando sua aprovação');
    case 'stopping':
      return tr('Parando…');
    default:
      return '';
  }
}

export function usageText(i: Extract<ChatItem, { kind: 'usage' }>): string {
  const parts = [tr('{0} tokens de entrada', [formatTokens(i.tokensIn)]), tr('{0} de saída', [formatTokens(i.tokensOut)])];
  if (i.costUsd !== undefined) parts.push(usd(i.costUsd));
  parts.push(formatDuration(i.ms));
  return parts.join(' · ');
}

export function toolLine(i: Extract<ChatItem, { kind: 'tool' }>): { title: string; detail: string; failed: boolean } {
  return { title: i.input ? `${i.name}: ${i.input}` : i.name, detail: i.output ?? '', failed: !!i.error };
}

export function canSendChat(raw: string, s: ChatState): { ok: true } | { ok: false; why: string } {
  if (!raw.trim()) return { ok: false, why: tr('Escreva uma mensagem.') };
  if (s.blocked) return { ok: false, why: chatStatusText(s) };
  if (s.phase !== 'idle') return { ok: false, why: tr('Espere a rodada terminar ou toque em Parar.') };
  return { ok: true };
}

/** Junta os itens buscados aos que a página já tem: por seq, e o que veio de novo troca o antigo (saída da ferramenta). */
export function mergeItems(have: ChatItem[], incoming: ChatItem[]): ChatItem[] {
  const bySeq = new Map(have.map((i) => [i.seq, i]));
  for (const i of incoming) bySeq.set(i.seq, i);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * De onde buscar: a saída de uma ferramenta chega depois, no mesmo item (mesmo seq). Com a rodada em andamento, busca
 * de novo a partir da primeira ferramenta ainda sem saída.
 */
export function afterSeq(items: ChatItem[], s: ChatState): number {
  const last = items.at(-1)?.seq ?? 0;
  if (s.phase === 'idle') return last;
  const open = items.find((i) => i.kind === 'tool' && i.output === undefined);
  return open ? open.seq - 1 : last;
}

export function pollDelayChat(s: ChatState): number {
  return s.phase === 'idle' ? 4000 : 700;
}
