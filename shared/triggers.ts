// Gatilhos "quando X, faça Y" (server/chat/triggers.ts): o protocolo entre cliente e servidor. Todo disparo vira um
// cartão de aprovação; nada roda sem a pessoa. Desenho: docs/superpowers/specs/2026-10-16-gatilhos-design.md.
import type { ChatOpenRequest } from './chat';

export const TRIGGERS_MAX = 50;
export const TRIGGER_NAME_MAX = 60;
export const TRIGGER_INTERVAL_MIN = 15;
export const TRIGGER_WINDOW_DEFAULT = 30;
export const TRIGGER_WINDOW_MAX = 24 * 60;
export const TRIGGER_DEBOUNCE_DEFAULT = 60;
export const TRIGGER_HISTORY_MAX = 100;
/** {{saida}}: a última resposta do agente que terminou, cortada. */
export const TRIGGER_SAIDA_MAX = 4000;

export type TriggerWhen =
  /** Todo dia às HH:MM (hora local) nos dias da semana (0 = domingo). */
  | { kind: 'schedule'; time: string; days: number[] }
  | { kind: 'interval'; minutes: number }
  /** Agente do chat fechou a rodada com resposta (um id, ou qualquer um com o papel). */
  | { kind: 'agent'; agentId?: string; roleId?: string; alsoFailed?: boolean }
  | { kind: 'files'; folder: string; glob?: string; debounceSec?: number };

export type TriggerOpenOptions = Omit<ChatOpenRequest, 'prompt' | 'vboardsTaskId'>;
export type TriggerDo = { kind: 'open'; options: TriggerOpenOptions; prompt: string } | { kind: 'send'; agentId: string; message: string };

export interface TriggerRule {
  id: string;
  name: string;
  enabled: boolean;
  when: TriggerWhen;
  do: TriggerDo;
  /** Quanto o cartão espera a resposta antes de o disparo ser pulado. */
  windowMinutes: number;
  createdAt: number;
}

/** fired = cartão esperando; o resto é o fim do disparo. */
export type TriggerOutcome = 'fired' | 'approved' | 'denied' | 'expired' | 'failed';

export interface TriggerFiring {
  id: string;
  ruleId: string;
  ruleName: string;
  at: number;
  /** Por que disparou ("arquivo mudou: src/a.ts"). */
  reason: string;
  outcome: TriggerOutcome;
  /** O que roda se aprovado, inteiro (o cartão mostra uma prévia). */
  action?: string;
  /** Disparos juntados enquanto o cartão esperava. */
  coalesced?: number;
  /** Motivo da recusa ou da falha. */
  note?: string;
  /** Agente aberto ou que recebeu a mensagem. */
  agentId?: string;
  endedAt?: number;
}

export type TriggerVar = 'regra' | 'motivo' | 'arquivos' | 'saida' | 'agente' | 'hora';
export const TRIGGER_VARS: readonly TriggerVar[] = ['regra', 'motivo', 'arquivos', 'saida', 'agente', 'hora'];

/** Troca {{regra}}, {{motivo}}... pelos valores; o que faltar vira vazio e placeholders desconhecidos ficam. */
export function renderTemplate(tpl: string, vars: Partial<Record<TriggerVar, string>>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, k: string) => ((TRIGGER_VARS as readonly string[]).includes(k) ? (vars[k as TriggerVar] ?? '') : all));
}
