// Listas que rodam um agente do chat por item, em sequência (server/chat/runs.ts): o protocolo entre cliente e servidor.
import type { ChatOpenRequest } from './chat';
import type { Provider } from './types';

export const RUN_ITEMS_MAX = 50;
export const RUN_CONTEXT_MAX = 4000;

/** 'review': lista automática do VBoards, passou pelo portão (checagens + revisão) e espera a pessoa. */
export type RunItemState = 'pending' | 'running' | 'done' | 'failed' | 'interrupted' | 'canceled' | 'review';
/** 'queued': espera a pasta ficar livre (uma lista por pasta) ou uma vaga (HABBLAUD_MAX_PARALLEL_RUNS). */
export type RunState = 'queued' | 'running' | 'paused' | 'stopped' | 'failed' | 'done';

export interface RunItem {
  text: string;
  vboardsTaskId?: string;
  state: RunItemState;
  agentId?: string;
  /** Última resposta (feito) ou o motivo (falhou). */
  summary?: string;
  startedAt?: number;
  endedAt?: number;
  /** Lista automática: o erro do portão já voltou uma vez ao agente. */
  retried?: boolean;
  /** Lista automática: o relatório do portão (branch, checagens, revisão e resumo). */
  report?: string;
  /** Interrompido pelo reinício (lista automática): ao voltar, segue no mesmo agente (agentId), avisado disso. */
  resume?: boolean;
  /** Lista automática: o resultado do portão na última passada (checagens + revisão). */
  gate?: 'pass' | 'fail';
  /** Lista automática: nomes dos PNGs do QA visual (GET /api/chat/runs/:id/items/:n/shots/:nome). */
  shots?: string[];
  /** Lista automática: o risco que a IA do Refinar deu à subtarefa (VBoards); ausente conta como 'medium'. */
  risk?: RiskLevel;
  riskWhy?: string;
  /** Lista automática: quando o plano do card foi aprovado no VBoards (sem isso, nada sobe sozinho). */
  approvedAt?: string;
}

/** Risco de uma tarefa (server/chat/risk.ts): o final é o maior entre o da IA e o calculado do diff. */
export type RiskLevel = 'low' | 'medium' | 'high';

/** Uma linha de <dataDir>/chat/run-metrics.jsonl: um item de lista que terminou (briefing e usage_metrics do Jarvis). */
export interface RunMetric {
  at: number;
  runId: string;
  folder: string;
  state: RunItemState;
  gate: 'pass' | 'fail' | 'none';
  retried: boolean;
  ms: number;
  usd: number;
  tokens: number;
  provider: Provider;
  model?: string;
}

/** Lista aberta sozinha pelo VBoards (vboards.auto da pasta): o portão de qualidade do fim de cada item. */
export interface RunAuto {
  /** vboards.check: comando de shell rodado na cópia isolada. */
  check?: string;
  /** vboards.qa: comando do QA visual, depois do check; os PNGs vão em $HABBLAUD_QA_DIR. */
  qa?: string;
  /** vboards.riskPaths (globs) e vboards.riskLines: o risco do diff no relatório do portão. */
  riskPaths?: string[];
  riskLines?: number;
  reviewer: Provider;
  reviewerModel?: string;
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
  /** `copied`/`missing`: vboards.copy (copiados para a cópia; os que não existem vão no relatório do portão). */
  isolated?: { branch: string; path: string; base: string; copied?: string[]; missing?: string[]; merged?: boolean; discarded?: boolean };
  /** Pediu cópia isolada (o worktree nasce ao começar). */
  wantIsolated: boolean;
  items: RunItem[];
  /** Por que parou (erro ao criar a cópia, etc.). */
  note?: string;
  /** Aberta sozinha pelo VBoards: cada item passa pelo portão (server/chat/gate.ts) e termina em 'review'. */
  auto?: RunAuto;
  /** Pausada pela cota da conta (server/chat/quota.ts): a janela, o uso e quando reinicia; a automática volta sozinha. */
  quota?: { window: '5h' | 'week'; pct: number; resetsAt?: number };
  /** A pessoa mandou rodar com a cota no limite ("Rodar lista"/"Continuar"): esta lista não pausa mais pela cota. */
  quotaOverride?: boolean;
  /** Rodada de comentários num item de uma lista que já tinha parado: o estado a que ela volta quando o item termina. */
  resumeTo?: RunState;
  /** "Subir" (server/chat/ship.ts): push do branch, PR, CI, merge e deploy, preso ao SHA aprovado. */
  ship?: RunShip;
  /** vboards.autoMerge=low: a lista automática já foi avaliada para subir sozinha (uma vez); `blocked` = por que não. */
  autoShip?: { at: number; blocked?: string };
}

/**
 * Etapas do "Subir". 'waiting': produto com vários repos, espera o repo anterior (server → web → app) chegar a
 * deployed. Com vboards.ship=pr a máquina para em 'pr' (o PR aberto é o fim).
 */
export type ShipStep = 'waiting' | 'pushing' | 'pr' | 'ci' | 'merging' | 'deploying' | 'deployed' | 'failed';
export type CiVerdict = 'pending' | 'pass' | 'fail' | 'no-ci';

export interface RunShip {
  step: ShipStep;
  mode: 'pr' | 'merge';
  /** O SHA aprovado (com PIN): push e merge só dele. */
  sha: string;
  owner: string;
  repo: string;
  remote: string;
  base: string;
  branch: string;
  /** `none` ou `workflow:<arquivo.yml>`. */
  deploy: string;
  /** Hooks/CI mudados pelo próprio diff: CI verde não basta (o merge pede a confirmação extra). */
  risky: string[];
  ciMinutes: number;
  startedAt: number;
  /** O commit que subiu (squash da árvore do `sha`): o PR, o CI e o merge são dele. */
  pushedSha?: string;
  /** Pai do squash: o commit que já subiu antes neste branch (subir de novo sem force). */
  parentSha?: string;
  /** Quando entrou na etapa atual (prazos do CI e do deploy). */
  stepAt: number;
  prNumber?: number;
  prUrl?: string;
  ci?: CiVerdict;
  /** O commit do merge na base (o deploy espera o workflow dele). */
  mergeSha?: string;
  /**
   * 'no-ci': repo sem CI de PR (ou que muda o próprio CI): o merge espera uma aprovação extra com PIN ("merge = deploy
   * em produção"). 'reapprove': o servidor reiniciou antes do merge; push e merge esperam o PIN de novo (runs.json não
   * é prova de aprovação).
   */
  needs?: 'no-ci' | 'reapprove';
  noCiApproved?: boolean;
  /** Etapa em que falhou. */
  failedAt?: ShipStep;
  /** Avisos (ntfy/WhatsApp) já mandados, para não repetir depois de um reinício. */
  notified?: string[];
  /** Por que falhou ou o que espera; o resultado do fast-forward do checkout local depois do deploy. */
  note?: string;
  /** Subiu sozinha, sem PIN (vboards.autoMerge=low e risco baixo). */
  auto?: boolean;
}

/** O "Subir" está andando (Juntar e Descartar esperam). Com ship=pr, o PR aberto ('pr' com prUrl) já é o fim. */
export const shipActive = (s: RunShip | undefined): boolean => !!s && s.step !== 'deployed' && s.step !== 'failed' && !(s.mode === 'pr' && s.step === 'pr' && !!s.prUrl);

/** O que o cartão do "Subir" mostra antes do PIN (POST /api/chat/runs/:id/ship/prepare). */
export interface ShipPreview {
  folder: string;
  owner: string;
  repo: string;
  remote: string;
  base: string;
  branch: string;
  sha: string;
  mode: 'pr' | 'merge';
  deploy: string;
  ciMinutes: number;
  stat: string;
  files: number;
  added: number;
  removed: number;
  /** Resultado do portão (lista automática): pass/fail no último item, none sem portão. */
  gate: 'pass' | 'fail' | 'none';
  /** Arquivos mudados em .husky/, .githooks/ e .github/workflows/ (hooks e CI rodam com a credencial do dono). */
  risky: string[];
  /** Risco final (server/chat/risk.ts): o maior entre o da IA e o do diff, com os motivos. */
  risk: RiskLevel;
  riskWhy: string[];
}

/**
 * O que a aprovação prende (a rota e o Jarvis mandam; o servidor compara campo a campo com o que vale agora): mudou
 * qualquer um, recusa.
 */
export interface ShipApproval {
  sha: string;
  owner: string;
  repo: string;
  base: string;
  remote: string;
  mode: 'pr' | 'merge';
  deploy: string;
  risky: string[];
  /** A aprovação extra do merge sem CI. */
  noCi?: boolean;
}

export const shipApprovalOf = (x: Omit<ShipApproval, 'noCi'>, noCi?: boolean): ShipApproval => ({ sha: x.sha, owner: x.owner, repo: x.repo, base: x.base, remote: x.remote, mode: x.mode, deploy: x.deploy, risky: [...x.risky], ...(noCi ? { noCi: true } : {}) });

/** Mesmo conjunto aprovado (noCi incluído). */
export const sameApproval = (a: ShipApproval, b: ShipApproval): boolean =>
  a.sha === b.sha && a.owner === b.owner && a.repo === b.repo && a.base === b.base && a.remote === b.remote && a.mode === b.mode && a.deploy === b.deploy && !!a.noCi === !!b.noCi && a.risky.length === b.risky.length && a.risky.every((r, i) => r === b.risky[i]);

/** GET/PUT /api/chat/github: o token do GitHub do "Subir" (nunca volta para a página). */
export interface GitHubTokenView {
  set: boolean;
  source: 'env' | 'file' | null;
  /** Só pelo próprio computador. */
  editable: boolean;
}

/** POST /api/chat/runs: a lista aprovada na tela de confirmação. */
export interface RunCreateRequest {
  items: Array<{ text: string; vboardsTaskId?: string }>;
  context?: string;
  stopOnFail?: boolean;
  isolated?: boolean;
  options: RunAgentOptions;
}

/** Comentários numa linha do diff da cópia isolada (POST /api/chat/runs/:id/items/:n/feedback). */
export const RUN_FEEDBACK_MAX = 50;
export const RUN_FEEDBACK_TEXT_MAX = 2000;

/** `side`: 'new' = linha do lado novo (adicionada ou de contexto); 'old' = do lado antigo (removida). */
export interface RunFeedbackComment {
  file: string;
  line: number;
  side: 'old' | 'new';
  text: string;
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
