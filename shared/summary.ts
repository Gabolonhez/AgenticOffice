// Resumo do dia (POST /api/summary/day, server/summary).
export type SummaryMode = 'ai' | 'list';
export interface DaySummary {
  text: string;
  /** Custo da rodada da IA em dólares (só no modo 'ai'). */
  costUsd?: number;
  generatedAt: number;
  /** Por que veio a lista simples quando a IA foi pedida. */
  fallbackReason?: string;
}
