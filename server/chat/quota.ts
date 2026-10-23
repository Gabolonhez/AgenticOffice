// Pausa das listas pela cota da conta (runs.ts): antes de abrir uma lista automática ou de passar ao próximo item, o uso
// de 5 h e da semana da conta do provedor (accounts/, o mesmo que o escritório mostra). Só números recentes ('ok')
// travam: velho (stale) ou desconhecido (ex.: agy, conta sem leitura) deixa rodar.
import type { UsageView } from '../accounts/usage';

/** Percentuais de HABBLAUD_QUOTA_PAUSE_5H (padrão 90) e HABBLAUD_QUOTA_PAUSE_WEEK (padrão 95). */
export interface QuotaLimits {
  fiveHour: number;
  week: number;
}

export interface QuotaBlock {
  window: '5h' | 'week';
  pct: number;
  resetsAt?: number;
}

/** A janela que trava (a semanal primeiro: reinicia mais tarde); undefined = pode rodar. */
export function quotaBlock(view: UsageView | undefined, limits: QuotaLimits): QuotaBlock | undefined {
  if (view?.status !== 'ok' || !view.usage) return undefined;
  const { sevenDay: week, fiveHour: five } = view.usage;
  const hit = (window: QuotaBlock['window'], w: typeof week): QuotaBlock => ({ window, pct: Math.round(w!.utilization), ...(w!.resetsAt ? { resetsAt: w!.resetsAt } : {}) });
  if (week && week.utilization >= limits.week) return hit('week', week);
  if (five && five.utilization >= limits.fiveHour) return hit('5h', five);
  return undefined;
}
