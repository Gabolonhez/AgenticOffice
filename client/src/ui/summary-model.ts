// Resumo do dia (ui/summary.ts): textos puros do rodapé do painel.
import { tr } from '../../../shared/i18n';
import type { DaySummary } from '../../../shared/summary';

/** "US$ 0,0021"; custo ausente = nada. */
export function costLabel(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return '';
  return `US$ ${usd.toFixed(4)}`;
}

/** Linha de rodapé: hora, custo da IA ou o motivo da lista simples. */
export function summaryFooter(s: Pick<DaySummary, 'generatedAt' | 'costUsd' | 'fallbackReason'>): string {
  const at = new Date(s.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const extra = s.fallbackReason ? tr('Lista simples (a IA falhou: {0})', [s.fallbackReason]) : s.costUsd !== undefined ? tr('Escrito pela IA · custo {0}', [costLabel(s.costUsd)]) : tr('Lista simples');
  return `${at} · ${extra}`;
}
