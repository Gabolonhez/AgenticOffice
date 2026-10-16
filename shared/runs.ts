// Listas que rodam um agente do chat por item, em sequência (server/chat/runs.ts): o protocolo entre cliente e servidor.
import type { ChatOpenRequest } from './chat';

export const RUN_ITEMS_MAX = 50;
export const RUN_CONTEXT_MAX = 4000;

export type RunItemState = 'pending' | 'running' | 'done' | 'failed' | 'interrupted' | 'canceled';
export type RunState = 'running' | 'paused' | 'stopped' | 'failed' | 'done';

export interface RunItem {
  text: string;
  vboardsTaskId?: string;
  state: RunItemState;
  agentId?: string;
  /** Última resposta (feito) ou o motivo (falhou). */
  summary?: string;
  startedAt?: number;
  endedAt?: number;
}

/** Opções de cada agente da lista: as da janela de abrir agente, sem pedido, nome e tarefa. */
export type RunAgentOptions = Omit<ChatOpenRequest, 'prompt' | 'name' | 'vboardsTaskId' | 'isolated'>;

export interface ChatRun {
  id: string;
  createdAt: number;
  state: RunState;
  options: RunAgentOptions;
  context?: string;
  stopOnFail: boolean;
  isolated?: { branch: string; path: string; base: string; merged?: boolean; discarded?: boolean };
  /** Pediu cópia isolada (o worktree nasce ao começar). */
  wantIsolated: boolean;
  items: RunItem[];
  /** Por que parou (erro ao criar a cópia, etc.). */
  note?: string;
}

/** POST /api/chat/runs: a lista aprovada na tela de confirmação. */
export interface RunCreateRequest {
  items: Array<{ text: string; vboardsTaskId?: string }>;
  context?: string;
  stopOnFail?: boolean;
  isolated?: boolean;
  options: RunAgentOptions;
}

/** Itens de um checklist em Markdown: as caixas abertas (`- [ ]`, `* [ ]`, de qualquer nível). */
export function parseChecklist(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+\[ \]\s*(.*)$/.exec(line);
    const text = m?.[1].trim();
    if (text) out.push(text);
  }
  return out;
}
