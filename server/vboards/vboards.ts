// Ponte com o VBoards (o quadro de Planning do time). Cinco partes:
// - fila: a cada ~10 s (com espera maior depois de erro) busca as subtarefas que você marcou "mandar para o agente"
//   (GET /api/agent-tasks) e guarda na memória; a página as lista (GET /api/vboards) e só começa uma com o seu clique
//   em "Iniciar" (POST /api/vboards/start), salvo a abertura automática opt-in de uma pasta (última parte);
// - conclusão: o agente aberto para a subtarefa fica ligado a ela (<dataDir>/vboards-links.json, sobrevive a um
//   reinício); quando ele termina o turno depois de ter trabalhado, ou a sessão acaba, a subtarefa vira 'done' com a
//   última resposta como resumo (ou 'failed', se nunca trabalhou). Uma vez por subtarefa. "Ligar a uma conversa aberta"
//   (POST /api/vboards/attach) liga a subtarefa a uma sessão já aberta (VS Code, terminal, de qualquer provedor): essa
//   só conclui quando a sessão acaba, não na primeira pausa;
// - conversas: cada agente principal (Claude Code, Codex; fora os ligados a uma subtarefa) que mexeu em código (editou arquivos ou fez commit) vira um item no card do projeto
//   (POST /api/agent-tasks/todos): o título da conversa, done quando terminou o turno depois de trabalhar, com o
//   resumo da última resposta. ~15 s de calma e só quando mudou;
// - abertura automática (opt-in, desligada por padrão): numa pasta com `git config --local vboards.auto true`, a
//   subtarefa da fila que só combina com ela vira uma lista do chat sozinha (server/chat/runs.ts, cópia isolada, sem
//   push, com o portão de qualidade de server/chat/gate.ts). Juntar continua sendo um clique.
// - refinar: o "Refinar" clicado no card chega na mesma busca (`refines`, ausente num VBoards antigo); com uma única
//   pasta que combina, UMA rodada só de leitura do vboards.provider na própria pasta (gate.ts refinerFor) devolve plano,
//   perguntas e subtarefas (POST /api/agent-tasks/refine: running, depois ready ou failed). Uma vez por pedido.
// O token só vai no cabeçalho Authorization: nunca em log, snapshot ou página. Git sem shell (execFile).
import { execFile } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { maskSecrets } from '../../shared/activity';
import { tr } from '../../shared/i18n';
import type { AgentInfo, Provider } from '../../shared/types';
import { errMsg, log } from '../log';
import { FileTail } from '../sources/tail';
import type { TerminalParser } from '../sources/terminal';
import { sessionName, type SpawnInfo, type SpawnSubmit } from '../spawn/spawn';
import { apiErrorText } from './api';
import type { NotifyEvent } from './ntfy';

export const POLL_MS = 10_000;
export const POLL_MAX_MS = 5 * 60_000;
export const TODOS_QUIET_MS = 15_000;
export const SUMMARY_MAX = 1_500;
/** O relatório do portão (status 'review', server/chat/gate.ts REPORT_MAX) é mais longo que um resumo. */
export const REVIEW_SUMMARY_MAX = 2_000;
/** Agente que não apareceu na pasta neste prazo depois do "Iniciar": a subtarefa falha. */
export const LINK_TIMEOUT_MS = 30 * 60_000;
/** Ligações concluídas ficam este tempo (para não concluir duas vezes nem mostrar a subtarefa de novo). */
export const KEEP_DONE_MS = 7 * 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_MS = 60_000;
const CARD_CACHE_MS = 5 * 60_000;
/** Depois de subir: só conclui "a sessão acabou" passado este tempo (o escritório ainda está remontando). */
const STARTUP_GRACE_MS = 60_000;

/** `token`: o segredo antigo da ponte ou um token `vb_...` da API v1 (com ele o e-mail vem do token e pode faltar). */
export interface VBoardsConfig {
  base: string;
  token: string;
  email: string;
}

/** Uma subtarefa na fila do VBoards (GET /api/agent-tasks). */
export interface AgentTask {
  cardId: string;
  subtaskId: string;
  text: string;
  cardTitle: string;
  date?: string;
}

/** O que a página vê: a subtarefa, a pasta escolhida (se só uma combina) e as pastas para escolher. */
export interface VBoardsTaskView {
  id: string;
  cardTitle: string;
  text: string;
  date?: string;
  folder?: string;
  candidates: Array<{ path: string; name: string }>;
  /** Conversas abertas (qualquer provedor) nas pastas da subtarefa, para "Ligar a uma conversa aberta". */
  agents: Array<{ id: string; name: string; title?: string; provider: string; folder: string }>;
}

/** 'review': lista automática que passou pelo portão e espera a pessoa (relatório no resumo). */
export type TaskStatus = 'running' | 'done' | 'failed' | 'review';

/** Subtarefa iniciada daqui, ligada ao agente aberto para ela. */
export interface TaskLink {
  id: string;
  cardId: string;
  subtaskId: string;
  /** Para o aviso no celular (ligações antigas não têm). */
  cardTitle?: string;
  folder: string;
  /** Nome da sessão em segundo plano (spawn/spawn.ts sessionName): desempata agentes na mesma pasta. */
  session: string;
  spawnId: string;
  startedAt: number;
  agentId?: string;
  /** Ligada à mão a uma conversa já aberta: só conclui quando a sessão acaba. */
  manual?: boolean;
  /** O agente já esteve trabalhando. */
  worked?: boolean;
  state: TaskStatus;
  summary?: string;
  /** Último status aceito pelo VBoards. */
  reported?: TaskStatus;
  retryAt?: number;
}

/** Pedido de "Refinar" um card (GET /api/agent-tasks → `refines`). */
export interface RefineRequest {
  cardId: string;
  cardTitle: string;
  date?: string;
  description: string;
  subtasks: string[];
  /** updatedAt/attempt do VBoards, se vier: um novo clique no mesmo card é outro pedido. */
  key: string;
}

/** O que o agente devolve (o bloco ```json da resposta), já validado e cortado nos limites do VBoards. */
export interface RefineResult {
  plan: string;
  questions: string[];
  subtasks: string[];
}

export type RefineStatus = 'running' | 'ready' | 'failed';
/** Atividade do "Refinar" para a página (só título, estado e o motivo da falha). */
export interface RefineView {
  cardId: string;
  cardTitle: string;
  state: RefineStatus;
  at: number;
  error?: string;
}

/** Limites do POST /api/agent-tasks/refine (o VBoards também corta). */
export const REFINE_LIMITS = { plan: 8_000, questions: 10, question: 500, subtasks: 20, subtask: 300, error: 2_000 } as const;
/** Rodadas do "Refinar" ao mesmo tempo (cada uma é uma CLI lendo o repositório). */
export const REFINE_PARALLEL = 2;
/** Tentativas de mandar o resultado final do "Refinar" (uma por busca da fila). */
const REFINE_POST_TRIES = 30;
/** Quanto do card entra no pedido (o agy recebe o pedido no argv). */
const REFINE_DESCRIPTION_MAX = 4_000;
const REFINE_VIEW_MS = 60 * 60_000;

export interface Folder {
  path: string;
  /** `git config vboards.card` da pasta, se houver. */
  card?: string;
}

// ------------------------------------------------------------------ funções puras

export const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const samePath = (a: string, b: string): boolean => a.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase() === b.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
export const taskId = (t: Pick<AgentTask, 'cardId' | 'subtaskId'>): string => `${t.cardId}:${t.subtaskId}`;

/** vboards.url (o endereço dos commits, ".../api/commits") vira a base do VBoards. */
export function baseFromUrl(raw: string | undefined): string | undefined {
  const s = (raw ?? '').trim().replace(/\/+$/, '').replace(/\/api\/commits$/i, '').replace(/\/+$/, '');
  try {
    return /^https?:$/.test(new URL(s).protocol) ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Configuração pelas variáveis (prioridade) e pelo git config global; ou por que fica desligado. */
export function resolveConfig(env: NodeJS.ProcessEnv, git: { url?: string; token?: string; email?: string }): VBoardsConfig | { off: string } {
  const flag = env.HABBLAUD_VBOARDS?.trim().toLowerCase();
  if (flag && ['0', 'false', 'off', 'no'].includes(flag)) return { off: tr('desligado (HABBLAUD_VBOARDS={0})', [env.HABBLAUD_VBOARDS!.trim()]) };
  const base = baseFromUrl(env.HABBLAUD_VBOARDS_URL?.trim() || git.url);
  const token = env.HABBLAUD_VBOARDS_TOKEN?.trim() || git.token?.trim();
  const email = env.HABBLAUD_VBOARDS_EMAIL?.trim() || git.email?.trim();
  if (!base) return { off: tr('sem endereço (git config --global vboards.url ou HABBLAUD_VBOARDS_URL)') };
  if (!token) return { off: tr('sem token (git config --global vboards.token ou HABBLAUD_VBOARDS_TOKEN)') };
  // Token vb_ (API v1): o VBoards tira o e-mail do token.
  if (!email && !token.startsWith('vb_')) return { off: tr('sem e-mail (git config --global user.email ou HABBLAUD_VBOARDS_EMAIL)') };
  return { base, token, email: email ?? '' };
}

/** Pastas cujo nome (ou vboards.card) é o título do card. */
export function matchFolders(cardTitle: string, folders: readonly Folder[]): string[] {
  const want = norm(cardTitle);
  if (!want) return [];
  return folders.filter((f) => norm(baseName(f.path)) === want || (!!f.card && norm(f.card) === want)).map((f) => f.path);
}

/** Configuração de uma pasta no `git config --local` dela (a única fonte; a tela do escritório lê e grava lá). */
export interface FolderConfig {
  card?: string;
  /** vboards.auto: abre sozinho as subtarefas desta pasta (padrão: não). */
  auto: boolean;
  provider: Provider;
  /** vboards.budget: dólares por item. */
  budget: number;
  /** vboards.check: comando de shell do portão (instala as dependências: a cópia isolada não tem node_modules nem .env). */
  check?: string;
  reviewer: Provider;
  reviewerModel?: string;
  /** vboards.copy: arquivos (caminhos relativos, separados por vírgula) copiados da pasta para cada cópia isolada (ex.: .env). */
  copy: string[];
}

export const FOLDER_KEYS = ['card', 'auto', 'provider', 'budget', 'check', 'reviewer', 'reviewerModel', 'copy'] as const;
export type FolderKey = (typeof FOLDER_KEYS)[number];
export const DEFAULT_BUDGET_USD = 2;
/** Prazo de cada rodada de um item da lista automática. */
export const AUTO_TURN_MINUTES = 30;
/** No git config o Antigravity é `agy` (o nome da CLI). */
export const PROVIDER_NAMES: Record<string, Provider> = { claude: 'claude', codex: 'codex', agy: 'antigravity', antigravity: 'antigravity' };
/** Modelo do revisor quando a pasta não diz: sonnet no Claude; Codex e agy ficam com o padrão da CLI. */
export const DEFAULT_REVIEWER_MODEL: Record<Provider, string | undefined> = { claude: 'sonnet', codex: undefined, antigravity: undefined };

/** `git config --get-regexp ^vboards\.` (chaves em minúsculas) vira a configuração, com os padrões. */
export function parseFolderConfig(out: string | undefined): FolderConfig {
  const raw = new Map<string, string>();
  for (const line of (out ?? '').split(/\r?\n/)) {
    const m = /^vboards\.(\S+)(?: (.*))?$/i.exec(line.trim());
    if (m) raw.set(m[1].toLowerCase(), (m[2] ?? '').trim());
  }
  const provider = PROVIDER_NAMES[raw.get('provider')?.toLowerCase() ?? ''] ?? 'claude';
  const reviewer = PROVIDER_NAMES[raw.get('reviewer')?.toLowerCase() ?? ''] ?? 'claude';
  const budget = Number(raw.get('budget'));
  return {
    ...(raw.get('card') ? { card: raw.get('card') } : {}),
    auto: raw.get('auto')?.toLowerCase() === 'true',
    provider,
    budget: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET_USD,
    ...(raw.get('check') ? { check: raw.get('check') } : {}),
    reviewer,
    ...((raw.get('reviewermodel') || DEFAULT_REVIEWER_MODEL[reviewer]) ? { reviewerModel: raw.get('reviewermodel') || DEFAULT_REVIEWER_MODEL[reviewer] } : {}),
    copy: parseCopyList(raw.get('copy')),
  };
}

/** Caminho do vboards.copy: relativo, sem `..`, sem unidade nem barra no começo, sem quebra de linha. */
export const validCopyPath = (p: string): boolean => !!p && p.length <= 200 && !/[\r\n\0]/.test(p) && !/^([\\/]|[A-Za-z]:)/.test(p) && !p.split(/[\\/]/).includes('..');

/** vboards.copy (vírgulas) vira a lista; o que não passa no validCopyPath fica de fora. */
export const parseCopyList = (raw: string | undefined): string[] => (raw ?? '').split(',').map((s) => s.trim()).filter(validCopyPath);

export function readFolderConfig(folder: string): Promise<FolderConfig> {
  return gitConfig(['--local', '--get-regexp', '^vboards\\.'], folder).then(parseFolderConfig);
}

/** A configuração como a tela mostra e grava: o Antigravity volta a ser `agy`, como no git config. */
export type FolderConfigView = Omit<FolderConfig, 'provider' | 'reviewer' | 'copy'> & { provider: string; reviewer: string; copy: string };
const providerName = (p: Provider): string => (p === 'antigravity' ? 'agy' : p);
export const folderConfigView = (c: FolderConfig): FolderConfigView => ({ ...c, provider: providerName(c.provider), reviewer: providerName(c.reviewer), copy: c.copy.join(', ') });

/**
 * Valida o que a tela manda gravar (só as chaves presentes). Texto vazio = tirar a chave (volta ao padrão). Nada de
 * quebra de linha: cada valor vira um argumento do `git config`, sem shell.
 */
export function validateFolderConfig(raw: unknown): { values: Partial<Record<FolderKey, string>> } | { error: string } {
  const b = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const values: Partial<Record<FolderKey, string>> = {};
  for (const key of FOLDER_KEYS) {
    const v = b[key];
    if (v === undefined) continue;
    const s = typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
    if (s === null || /[\r\n\0]/.test(s)) return { error: tr('Valor inválido em vboards.{0}.', [key]) };
    if (s === '') {
      values[key] = '';
      continue;
    }
    const ok =
      key === 'auto' ? s === 'true' || s === 'false'
      : key === 'provider' || key === 'reviewer' ? ['claude', 'codex', 'agy'].includes(s)
      : key === 'budget' ? /^\d+(\.\d+)?$/.test(s) && Number(s) > 0 && Number(s) <= 1000
      : key === 'reviewerModel' ? /^[\w.:/[\]-]{1,60}$/.test(s)
      : key === 'card' ? s.length <= 100
      : key === 'copy' ? s.length <= 500 && s.split(',').every((x) => validCopyPath(x.trim()))
      : s.length <= 500; // check
    if (!ok) return { error: tr('Valor inválido em vboards.{0}.', [key]) };
    values[key] = s;
  }
  return { values };
}

/** Grava no git config --local da pasta (sem shell); valor vazio tira a chave. */
export async function writeFolderConfig(folder: string, values: Partial<Record<FolderKey, string>>): Promise<string | undefined> {
  for (const [key, value] of Object.entries(values)) {
    const err = await new Promise<string | undefined>((ok) =>
      execFile('git', ['config', '--local', ...(value ? [`vboards.${key}`, value] : ['--unset', `vboards.${key}`])], { cwd: folder, timeout: 5_000, windowsHide: true, encoding: 'utf8' }, (e, _out, stderr) =>
        // --unset de uma chave que não existe sai com 5: já está como pedido.
        ok(e && !(value === '' && (e as { code?: unknown }).code === 5) ? stderr.trim() || e.message : undefined),
      ),
    );
    if (err) return err;
  }
  return undefined;
}

/** O pedido do agente para uma subtarefa. */
export const taskPrompt = (t: Pick<AgentTask, 'cardTitle' | 'text'>): string => `${tr('Tarefa do VBoards (card {0}):', [t.cardTitle])} ${t.text}`;

const cutText = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/** `refines` da fila; ausente ou estragado (VBoards antigo) = nenhum. */
export function parseRefines(raw: unknown): RefineRequest[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    if (!str(r.cardId)) return [];
    return [{
      cardId: str(r.cardId),
      cardTitle: str(r.cardTitle),
      ...(str(r.date) ? { date: str(r.date) } : {}),
      description: str(r.description),
      subtasks: Array.isArray(r.subtasks) ? r.subtasks.map(str).filter(Boolean) : [],
      key: str(r.updatedAt) || str(r.attempt),
    }];
  });
}

/** O pedido do "Refinar": o card e as subtarefas que já existem; a resposta é UM bloco ```json. */
export function refinePrompt(r: Pick<RefineRequest, 'cardTitle' | 'description' | 'subtasks'>): string {
  const subtasks = r.subtasks.slice(0, 50).map((t) => `- ${cutText(t, REFINE_LIMITS.subtask)}`);
  return [
    'Você planeja um card do quadro do time, em português do Brasil. Só leia: não edite arquivos, não rode comandos que mudem nada, não faça commit.',
    'Leia o repositório desta pasta o quanto precisar para entender o pedido e responda com UM único bloco ```json, sem mais nada depois dele:',
    '{"plan": "escopo, arquivos afetados e critérios de aceite", "questions": ["o que falta decidir"], "subtasks": ["itens pequenos, de um propósito só, implementáveis"]}',
    `Limites: plan até ${REFINE_LIMITS.plan} caracteres; até ${REFINE_LIMITS.questions} perguntas; até ${REFINE_LIMITS.subtasks} subtarefas, sem repetir as que já existem.`,
    '',
    `Card: ${cutText(r.cardTitle, 200)}`,
    `Descrição:\n${cutText(r.description.trim(), REFINE_DESCRIPTION_MAX) || '(sem descrição)'}`,
    `Subtarefas que já existem:\n${subtasks.join('\n') || '(nenhuma)'}`,
  ].join('\n');
}

/** O último bloco ```json da resposta, validado (plan texto; questions/subtasks listas de texto) e cortado; senão undefined. */
export function parseRefineOutput(text: string): RefineResult | undefined {
  const fences = [...text.matchAll(/```json[^\n]*\n([\s\S]*?)```/gi)];
  if (!fences.length) return undefined;
  let j: unknown;
  try {
    j = JSON.parse(fences[fences.length - 1][1]);
  } catch {
    return undefined;
  }
  const o = (j && typeof j === 'object' && !Array.isArray(j) ? j : {}) as Record<string, unknown>;
  const list = (v: unknown, max: number, each: number): string[] | undefined =>
    v === undefined ? [] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, max).map((x) => cutText(maskSecrets(x.trim()), each)) : undefined;
  const plan = typeof o.plan === 'string' ? maskSecrets(o.plan.trim()) : '';
  const questions = list(o.questions, REFINE_LIMITS.questions, REFINE_LIMITS.question);
  const subtasks = list(o.subtasks, REFINE_LIMITS.subtasks, REFINE_LIMITS.subtask);
  if (!plan || !questions || !subtasks) return undefined;
  return { plan: cutText(plan, REFINE_LIMITS.plan), questions, subtasks };
}

/** Nome do card para uma pasta: o vboards.card dela ou o nome da pasta. */
export const cardName = (f: Folder): string => f.card?.trim() || baseName(f.path);

/** O agente (aberto só para a subtarefa) trabalhou: está trabalhando ou já respondeu algo (um turno curto cabe entre duas checagens). */
const hasWorked = (a: Pick<AgentInfo, 'status' | 'stats'> | undefined): boolean => !!a && (a.status === 'working' || (a.stats?.tokensOut ?? 0) > 0);

/**
 * O que fazer com uma subtarefa em andamento, dado o agente ligado a ela (undefined = sumiu do escritório):
 * terminou o turno depois de trabalhar = done; sessão acabou = done se trabalhou, senão failed.
 */
export function decideCompletion(link: Pick<TaskLink, 'worked'>, agent: Pick<AgentInfo, 'status' | 'stats'> | undefined): 'done' | 'failed' | undefined {
  const worked = !!link.worked || hasWorked(agent);
  if (!agent || agent.status === 'offline' || agent.status === 'done') return worked ? 'done' : 'failed';
  return worked && agent.status === 'idle' ? 'done' : undefined;
}

const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|file_change)$/;
// `command` é o nome da ferramenta de shell do Codex no chat (drivers/codex.ts).
const SHELL_TOOLS = /^(Bash|shell|command|command_execution)$/i;
const GIT_COMMIT = /\bgit\s+(?:-\S+\s+)*commit\b/;

/**
 * A conversa mexeu em código: linhas somadas/removidas (total do transcript) ou, nas atividades recentes, uma edição
 * de arquivo ou um `git commit`. Conversa só de perguntas e respostas não conta.
 */
export function changedCode(a: Pick<AgentInfo, 'stats' | 'recent' | 'activity'>): boolean {
  if ((a.stats?.linesAdded ?? 0) > 0 || (a.stats?.linesRemoved ?? 0) > 0) return true;
  return [...(a.recent ?? []), ...(a.activity ? [a.activity] : [])].some((x) => (!!x.tool && EDIT_TOOLS.test(x.tool)) || (!x.error && SHELL_TOOLS.test(x.tool ?? '') && GIT_COMMIT.test(x.detail ?? x.text)));
}

/** Item da conversa no card: o título, feito ou não e, feito, o resumo. */
export interface ConversationItem {
  text: string;
  done: boolean;
  summary?: string;
}

/** Título da conversa para o VBoards: mascarado e cortado em 200 caracteres. */
export function conversationText(title: string | undefined): string | undefined {
  return maskSecrets(title ?? '').trim().slice(0, 200).trim() || undefined;
}

/** Resumo para o VBoards: mascarado e cortado. */
export function summaryText(text: string | undefined, max = SUMMARY_MAX): string | undefined {
  const s = maskSecrets(text ?? '').trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Debounce por agente: devolve quem mudou e está calmo há TODOS_QUIET_MS (e difere do último envio).
 * `posted` marca o que o VBoards aceitou.
 */
export class TodoTracker {
  private readonly state = new Map<string, { sig: string; since: number; posted?: string }>();

  due(entries: ReadonlyArray<{ id: string; item: ConversationItem }>, now: number): Array<{ id: string; sig: string; item: ConversationItem }> {
    const out: Array<{ id: string; sig: string; item: ConversationItem }> = [];
    const seen = new Set<string>();
    for (const { id, item } of entries) {
      seen.add(id);
      const sig = JSON.stringify(item);
      const cur = this.state.get(id);
      if (!cur || cur.sig !== sig) {
        this.state.set(id, { sig, since: now, posted: cur?.posted });
        continue;
      }
      if (cur.posted !== sig && now - cur.since >= TODOS_QUIET_MS) out.push({ id, sig, item });
    }
    for (const id of [...this.state.keys()]) if (!seen.has(id)) this.state.delete(id);
    return out;
  }

  posted(id: string, sig: string): void {
    const cur = this.state.get(id);
    if (cur) cur.posted = sig;
  }
}

// ------------------------------------------------------------------ Node

/** `git config ...` sem shell; undefined se não houver (ou o git falhar). */
export function gitConfig(args: string[], cwd?: string): Promise<string | undefined> {
  return new Promise((ok) => {
    execFile('git', ['config', ...args], { cwd, timeout: 5_000, windowsHide: true, encoding: 'utf8' }, (err, out) => ok(err ? undefined : out.trim() || undefined));
  });
}

export async function loadVBoardsConfig(env: NodeJS.ProcessEnv = process.env): Promise<VBoardsConfig | { off: string }> {
  const [url, token, email] = await Promise.all(['vboards.url', 'vboards.token', 'user.email'].map((k) => gitConfig(['--global', '--get', k])));
  return resolveConfig(env, { url, token, email });
}

/** Texto da última resposta do agente no fim do transcript. */
export function lastReply(path: string, parser: TerminalParser): string | undefined {
  const tail = new FileTail(path);
  let text: string | undefined;
  try {
    tail.seekTail(1024 * 1024);
    for (let i = 0; i < 8; i++) {
      const r = tail.read();
      for (const line of r.lines) for (const e of parser.push(line)) if (e.kind === 'assistant') text = e.text;
      if (!r.more) break;
    }
  } catch {
    return text;
  }
  return text;
}

export type ChatOpener = (raw: unknown) => { agentId: string } | { error: string; reason: string };

export interface VBoardsServiceOptions {
  config: VBoardsConfig;
  /** Agentes reais do escritório (Office.list) e a pasta de cada sala. */
  agents: () => AgentInfo[];
  roomPath: (roomId: string) => string | undefined;
  /** Pastas conhecidas (as do Novo agente); as dos agentes entram junto. */
  folders: () => Promise<string[]>;
  /** Novo agente; ausente = a fila não é buscada (dá para iniciar só com ele). */
  spawn?: { submit(raw: unknown): SpawnSubmit; get(id: string): SpawnInfo | undefined };
  /** Chat do escritório (server/chat): com ele, o "Iniciar" abre o agente pelo chat em vez do Novo agente. */
  /** `outcome`: 'review' = a lista automática passou pelo portão; undefined = ainda não acabou (rodando ou no portão). */
  chat?: { open: ChatOpener; outcome?(agentId: string): 'done' | 'failed' | 'review' | undefined };
  /** Última resposta do agente (transcript). */
  reply?: (agentId: string) => string | undefined;
  booting?: () => boolean;
  /** vboards.card de uma pasta. */
  cardOf?: (folder: string) => Promise<string | undefined>;
  /** Configuração da pasta (git config --local vboards.*) e a gravação dela (testes). */
  folderConfig?: (folder: string) => Promise<FolderConfig>;
  writeConfig?: (folder: string, values: Partial<Record<FolderKey, string>>) => Promise<string | undefined>;
  /**
   * Abertura automática: chamada a cada busca da fila com as subtarefas soltas de uma pasta com vboards.auto=true (a
   * única pasta que combina com o card). Ausente (chat desligado) = nada abre sozinho.
   */
  auto?: (folder: string, tasks: Array<{ id: string; prompt: string }>, config: FolderConfig) => void;
  /**
   * "Refinar": uma rodada só de leitura na pasta (gate.ts refinerFor) que devolve o texto da resposta. Ausente (chat
   * desligado) = os pedidos de refinar ficam para outro Habblaud.
   */
  refine?: (folder: string, prompt: string, config: FolderConfig) => Promise<string>;
  /** Aviso no celular (vboards/ntfy.ts): só o título do card e o que aconteceu. */
  notify?: (cardTitle: string, event: NotifyEvent) => void;
  file?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class VBoardsService {
  private tasks: AgentTask[] = [];
  private refines: RefineRequest[] = [];
  /** Cards sendo refinados agora (nunca dois ao mesmo tempo no mesmo card). */
  private readonly refining = new Set<string>();
  /** Pedido já tratado por card (a `key` dele): não roda de novo enquanto o VBoards o mostrar. */
  private readonly refined = new Map<string, string>();
  /** Resultado final que o VBoards não recebeu (rede/5xx): vai de novo a cada busca. */
  private readonly refinePosts = new Map<string, { payload: Record<string, unknown>; tries: number }>();
  private readonly refineViews = new Map<string, RefineView>();
  private links: TaskLink[] = [];
  private readonly todos = new TodoTracker();
  /** Agentes de conversa (sem subtarefa) que já trabalharam. */
  private readonly worked = new Set<string>();
  /** Agentes que já mexeram em código (fica marcado: `recent` rola e perde as edições antigas). */
  private readonly coded = new Set<string>();
  private readonly cards = new Map<string, { card?: string; at: number }>();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private checkTimer?: ReturnType<typeof setInterval>;
  private delay = POLL_MS;
  private lastError?: string;
  /** Última busca recusada pelo token (401 expirado/inválido, 403 sem escopo): a frase para a página. */
  private authProblem?: string;
  private checking = false;
  private reporting = false;
  private reportAgain = false;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: VBoardsServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetch ?? fetch;
    this.startedAt = this.now();
  }

  load(): void {
    if (!this.opts.file) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(this.opts.file, 'utf8'));
      if (Array.isArray(raw)) this.links = raw.filter((l): l is TaskLink => !!l && typeof l.id === 'string' && typeof l.folder === 'string');
    } catch {
      // sem arquivo: nenhuma ligação
    }
  }

  start(): void {
    if (this.opts.spawn || this.opts.chat) void this.poll();
    this.checkTimer = setInterval(() => void this.check(), 5_000);
    this.checkTimer.unref?.();
  }

  stop(): void {
    clearTimeout(this.pollTimer);
    clearInterval(this.checkTimer);
  }

  /** Busca a fila; a próxima busca vem em POLL_MS, ou mais tarde depois de erro (dobra até POLL_MAX_MS). */
  async poll(): Promise<void> {
    try {
      const email = this.opts.config.email;
      const r = (await this.call(`/api/agent-tasks${email ? `?email=${encodeURIComponent(email)}` : ''}`)) as { tasks?: unknown; refines?: unknown };
      this.refines = parseRefines(r?.refines);
      void this.startRefines();
      const list = Array.isArray(r?.tasks) ? r.tasks : [];
      this.tasks = list.flatMap((x) => {
        const t = x as Record<string, unknown>;
        const s = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
        return s(t.cardId) && s(t.subtaskId) && s(t.text) ? [{ cardId: s(t.cardId), subtaskId: s(t.subtaskId), text: s(t.text), cardTitle: s(t.cardTitle), date: s(t.date) || undefined }] : [];
      });
      this.delay = POLL_MS;
      this.lastError = undefined;
      this.authProblem = undefined;
      await this.autoStart().catch((err) => log.warnOnce(`vboards:auto:${errMsg(err)}`, tr('VBoards: abertura automática falhou ({0}).', [errMsg(err)])));
    } catch (err) {
      const msg = errMsg(err);
      if (msg !== this.lastError) log.warn(tr('VBoards: falha ao buscar as tarefas ({0}); tentando de novo mais tarde.', [msg]));
      this.lastError = msg;
      // Token sem o escopo ou expirado: repetir não resolve; confere de novo só no intervalo maior, e a página mostra.
      const status = (err as { status?: unknown })?.status;
      this.authProblem = status === 401 || status === 403 ? msg : undefined;
      this.delay = this.authProblem ? POLL_MAX_MS : Math.min(this.delay * 2, POLL_MAX_MS);
    }
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), this.delay);
    this.pollTimer.unref?.();
  }

  /** Subtarefas soltas cuja única pasta tem vboards.auto=true vão para o `auto`, agrupadas por pasta. */
  private async autoStart(): Promise<void> {
    if (!this.opts.auto) return;
    const started = new Set(this.links.map((l) => l.id));
    const queued = this.tasks.filter((t) => !started.has(taskId(t)));
    if (!queued.length) return;
    const folders = await this.knownFolders();
    const byFolder = new Map<string, AgentTask[]>();
    for (const t of queued) {
      const m = matchFolders(t.cardTitle, folders);
      if (m.length === 1) byFolder.set(m[0], [...(byFolder.get(m[0]) ?? []), t]);
    }
    for (const [folder, tasks] of byFolder) {
      const config = await (this.opts.folderConfig ?? readFolderConfig)(folder);
      if (config.auto) this.opts.auto(folder, tasks.map((t) => ({ id: taskId(t), prompt: taskPrompt(t) })), config);
    }
  }

  /** Refinar: cada pedido novo (card + key) roda uma vez; no máximo REFINE_PARALLEL ao mesmo tempo. */
  private async startRefines(): Promise<void> {
    await this.retryRefinePosts();
    const run = this.opts.refine;
    if (!run) return;
    const live = new Set(this.refines.map((r) => r.cardId));
    // Saiu da fila: um clique novo no mesmo card volta a rodar (mesmo sem updatedAt/attempt).
    for (const id of [...this.refined.keys()]) if (!live.has(id) && !this.refining.has(id)) this.refined.delete(id);
    for (const r of this.refines) {
      if (this.refining.size >= REFINE_PARALLEL) break;
      if (this.refining.has(r.cardId) || this.refined.get(r.cardId) === r.key) continue;
      this.refined.set(r.cardId, r.key);
      this.refining.add(r.cardId);
      void this.refine(r, run)
        .catch((err) => this.postRefine(r, { status: 'failed', error: errMsg(err) }))
        .finally(() => this.refining.delete(r.cardId));
    }
  }

  private async refine(r: RefineRequest, run: NonNullable<VBoardsServiceOptions['refine']>): Promise<void> {
    const matches = matchFolders(r.cardTitle, await this.knownFolders());
    if (matches.length !== 1) {
      const error = matches.length
        ? tr('várias pastas combinam com o card {0} ({1}): deixe vboards.card em só uma', [r.cardTitle, matches.map(baseName).join(', ')])
        : tr('nenhuma pasta com vboards.card = {0} (nem com esse nome) neste computador', [r.cardTitle]);
      return void (await this.postRefine(r, { status: 'failed', error }));
    }
    // VBoards que recusa o "running" (antigo, 404/400): nem gasta a rodada.
    if ((await this.postRefine(r, { status: 'running' })) === 'rejected') return;
    const folder = matches[0];
    const text = await run(folder, refinePrompt(r), await (this.opts.folderConfig ?? readFolderConfig)(folder));
    const out = parseRefineOutput(text);
    await this.postRefine(r, out ? { status: 'ready', ...out } : { status: 'failed', error: `${tr('A resposta não trouxe um bloco ```json válido (plan, questions, subtasks). Fim da saída:')}\n${maskSecrets(text).trim().slice(-1_500)}` });
  }

  /** Manda o estado do "Refinar"; o final também vira aviso no celular. */
  private postRefine(r: RefineRequest, body: { status: RefineStatus; error?: string } & Partial<RefineResult>): Promise<'ok' | 'rejected' | 'later'> {
    const error = body.error === undefined ? undefined : cutText(maskSecrets(body.error), REFINE_LIMITS.error);
    this.refineViews.set(r.cardId, { cardId: r.cardId, cardTitle: r.cardTitle, state: body.status, at: this.now(), ...(error ? { error } : {}) });
    if (body.status !== 'running') this.opts.notify?.(r.cardTitle, body.status);
    return this.sendRefine({ email: this.opts.config.email || undefined, cardId: r.cardId, ...body, ...(error === undefined ? {} : { error }) }, 0);
  }

  private async sendRefine(payload: Record<string, unknown>, tries: number): Promise<'ok' | 'rejected' | 'later'> {
    const cardId = String(payload.cardId);
    try {
      await this.call('/api/agent-tasks/refine', payload);
      this.refinePosts.delete(cardId);
      return 'ok';
    } catch (err) {
      const msg = errMsg(err);
      log.warnOnce(`vboards:refine:${msg}`, tr('VBoards: falha ao mandar o resultado do Refinar ({0}).', [msg]));
      // 4xx (VBoards antigo ou pedido recusado): não insiste. Rede/5xx: o resultado final vai de novo nas próximas buscas.
      const rejected = /^HTTP 4\d\d$/.test(msg);
      if (rejected || payload.status === 'running' || tries >= REFINE_POST_TRIES) this.refinePosts.delete(cardId);
      else this.refinePosts.set(cardId, { payload, tries: tries + 1 });
      return rejected ? 'rejected' : 'later';
    }
  }

  private async retryRefinePosts(): Promise<void> {
    for (const p of [...this.refinePosts.values()]) await this.sendRefine(p.payload, p.tries);
  }

  /** Atividade do "Refinar" para o painel: as rodando e as que acabaram há pouco. */
  /** O token foi recusado na última busca (escopo que falta, expirado): a frase para o painel; undefined = ok. */
  problem(): string | undefined {
    return this.authProblem;
  }

  refineList(): RefineView[] {
    const now = this.now();
    for (const [id, v] of this.refineViews) if (v.state !== 'running' && now - v.at > REFINE_VIEW_MS) this.refineViews.delete(id);
    return [...this.refineViews.values()];
  }

  /** Fila para a página (sem as já iniciadas daqui). */
  async list(): Promise<VBoardsTaskView[]> {
    const started = new Set(this.links.map((l) => l.id));
    const pending = this.tasks.filter((t) => !started.has(taskId(t)));
    if (!pending.length) return [];
    const folders = await this.knownFolders();
    return pending.map((t) => {
      const matches = matchFolders(t.cardTitle, folders);
      const pool = matches.length > 1 ? folders.filter((f) => matches.includes(f.path)) : folders;
      return {
        id: taskId(t),
        cardTitle: t.cardTitle,
        text: t.text,
        ...(t.date ? { date: t.date } : {}),
        ...(matches.length === 1 ? { folder: matches[0] } : {}),
        candidates: pool.map((f) => ({ path: f.path, name: baseName(f.path) })),
        agents: this.attachable(matches.length ? matches : folders.map((f) => f.path)).map(({ agent: a, folder }) => ({ id: a.id, name: a.name, ...(a.title ? { title: a.title } : {}), provider: a.provider ?? 'claude', folder })),
      };
    });
  }

  /** Conversas abertas que podem ser ligadas a uma subtarefa: principais, de qualquer provedor, numa destas pastas e soltas. */
  private attachable(folders: readonly string[]): Array<{ agent: AgentInfo; folder: string }> {
    const linked = new Set(this.links.filter((l) => l.state === 'running').map((l) => l.agentId));
    return this.opts.agents().flatMap((agent) => {
      if (agent.kind !== 'main' || agent.status === 'offline' || agent.status === 'done' || linked.has(agent.id)) return [];
      const p = this.opts.roomPath(agent.roomId);
      const folder = p && folders.find((f) => samePath(f, p));
      return folder ? [{ agent, folder }] : [];
    });
  }

  /**
   * Comentários da revisão voltaram ao agente (chat/runs.ts feedback): a subtarefa dele volta a 'running' e, quando o
   * portão terminar, vai de novo como 'review' com o relatório novo. Sem ligação (já saiu, KEEP_DONE_MS) = false.
   */
  reopen(agentId: string): boolean {
    const l = this.links.find((x) => x.agentId === agentId && !x.manual);
    if (!l) return false;
    l.state = 'running';
    l.summary = undefined;
    l.retryAt = undefined;
    this.save();
    void this.report();
    return true;
  }

  /** "Ligar a uma conversa aberta": a subtarefa fica ligada a uma sessão que já existe (nada é aberto). */
  async attach(raw: unknown): Promise<{ ok: true } | { status: number; error: string }> {
    const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const task = this.tasks.find((t) => taskId(t) === body.id);
    if (!task) return { status: 404, error: tr('tarefa do VBoards desconhecida: atualize a lista') };
    if (this.links.some((l) => l.id === body.id)) return { status: 409, error: tr('esta tarefa já foi iniciada') };
    const folders = await this.knownFolders();
    const matches = matchFolders(task.cardTitle, folders);
    const hit = this.attachable(matches.length ? matches : folders.map((f) => f.path)).find((x) => x.agent.id === body.agentId);
    if (!hit) return { status: 400, error: tr('conversa não encontrada na pasta do projeto: atualize a lista') };
    // Duas requisições durante a espera acima: só a primeira liga.
    if (this.links.some((l) => l.id === body.id)) return { status: 409, error: tr('esta tarefa já foi iniciada') };
    this.links.push({ id: taskId(task), cardId: task.cardId, subtaskId: task.subtaskId, cardTitle: task.cardTitle, folder: hit.folder, session: '', spawnId: '', agentId: hit.agent.id, manual: true, startedAt: this.now(), state: 'running' });
    this.save();
    void this.report();
    return { ok: true };
  }

  /** "Iniciar": a pasta vem do próprio servidor (a única que combina, ou uma das conhecidas escolhida na página). */
  /** `open` (lista do chat, server/chat/runs.ts): abre o agente do chat por ela em vez do chat.open das opções. */
  async begin(raw: unknown, open?: ChatOpener): Promise<{ spawn: SpawnInfo } | { agentId: string } | { status: number; error: string }> {
    const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const spawn = this.opts.spawn;
    const chat = open ? { open } : this.opts.chat;
    if (!spawn && !chat) return { status: 403, error: tr('novo agente pelo escritório desligado') };
    const task = this.tasks.find((t) => taskId(t) === body.id);
    if (!task) return { status: 404, error: tr('tarefa do VBoards desconhecida: atualize a lista') };
    if (this.links.some((l) => l.id === body.id)) return { status: 409, error: tr('esta tarefa já foi iniciada') };
    const folders = await this.knownFolders();
    const matches = matchFolders(task.cardTitle, folders);
    const picked = typeof body.folder === 'string' && body.folder ? folders.find((f) => f.path === body.folder)?.path : matches.length === 1 ? matches[0] : undefined;
    if (!picked) return { status: 400, error: tr('escolha a pasta do projeto (uma das sugeridas)') };
    // Dois cliques durante a espera acima: só o primeiro abre.
    if (this.links.some((l) => l.id === body.id)) return { status: 409, error: tr('esta tarefa já foi iniciada') };
    const prompt = taskPrompt(task);
    if (chat) {
      // Pelo chat: o agente já tem id, então o link nasce ligado a ele (sem casar por pasta e horário).
      const extra = body.chat && typeof body.chat === 'object' ? (body.chat as Record<string, unknown>) : {};
      const asked = typeof extra.prompt === 'string' && extra.prompt.trim() ? extra.prompt : prompt;
      const r = chat.open({ ...extra, folder: picked, prompt: asked, vboardsTaskId: taskId(task) });
      if (!('agentId' in r)) return { status: r.error === 'invalid' ? 400 : r.error === 'too-many' ? 429 : 409, error: r.reason };
      this.links.push({ id: taskId(task), cardId: task.cardId, subtaskId: task.subtaskId, cardTitle: task.cardTitle, folder: picked, session: '', spawnId: '', agentId: r.agentId, startedAt: this.now(), state: 'running' });
      this.save();
      void this.report();
      return { agentId: r.agentId };
    }
    const r = spawn!.submit({ folder: picked, prompt });
    if (!('spawn' in r)) return { status: r.error === 'invalid' ? 400 : r.error === 'too-many' ? 429 : 409, error: r.reason };
    this.links.push({ id: taskId(task), cardId: task.cardId, subtaskId: task.subtaskId, cardTitle: task.cardTitle, folder: picked, session: sessionName(prompt), spawnId: r.spawn.id, startedAt: this.now(), state: 'running' });
    this.save();
    void this.report();
    return { spawn: r.spawn };
  }

  /** Pastas que a tela de configuração mostra: só as conhecidas (nada de caminho arbitrário). */
  async configFolders(): Promise<Array<{ path: string; name: string }>> {
    return (await this.knownFolders()).map((f) => ({ path: f.path, name: baseName(f.path) }));
  }

  /** Configuração de uma pasta conhecida (git config --local vboards.*). */
  async folderSettings(folder: unknown): Promise<{ folder: string; config: FolderConfigView } | { status: number; error: string }> {
    const known = typeof folder === 'string' ? (await this.knownFolders()).find((f) => samePath(f.path, folder)) : undefined;
    if (!known) return { status: 400, error: tr('Pasta desconhecida: abra uma sessão nela antes.') };
    return { folder: known.path, config: folderConfigView(await (this.opts.folderConfig ?? readFolderConfig)(known.path)) };
  }

  /** Grava a configuração de uma pasta conhecida. A trava de quem pode (só local) fica na rota (http/app.ts). */
  async saveFolderSettings(raw: unknown): Promise<{ folder: string; config: FolderConfigView } | { status: number; error: string }> {
    const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const known = typeof body.folder === 'string' ? (await this.knownFolders()).find((f) => samePath(f.path, body.folder as string)) : undefined;
    if (!known) return { status: 400, error: tr('Pasta desconhecida: abra uma sessão nela antes.') };
    const v = validateFolderConfig(body.config);
    if ('error' in v) return { status: 400, error: v.error };
    const err = await (this.opts.writeConfig ?? writeFolderConfig)(known.path, v.values);
    if (err) return { status: 409, error: tr('Não deu para gravar no git config da pasta: {0}', [maskSecrets(err)]) };
    this.cards.delete(known.path);
    return this.folderSettings(known.path);
  }

  /** Liga agentes, conclui subtarefas e manda as conversas. */
  async check(): Promise<void> {
    if (this.checking || this.opts.booting?.()) return;
    this.checking = true;
    try {
      this.advanceLinks();
      await this.report();
      await this.syncTodos();
    } catch (err) {
      log.warnOnce(`vboards:${errMsg(err)}`, tr('VBoards: {0}', [errMsg(err)]));
    } finally {
      this.checking = false;
    }
  }

  private advanceLinks(): void {
    const now = this.now();
    const agents = this.opts.agents();
    let changed = false;
    this.links = this.links.filter((l) => l.state === 'running' || now - l.startedAt < KEEP_DONE_MS);
    for (const l of this.links) {
      if (l.state !== 'running') continue;
      if (!l.agentId) {
        const taken = new Set(this.links.map((x) => x.agentId));
        const here = agents
          .filter((a) => a.kind === 'main' && (a.provider ?? 'claude') === 'claude' && !taken.has(a.id) && a.startedAt >= l.startedAt - 5_000)
          .filter((a) => {
            const p = this.opts.roomPath(a.roomId);
            return !!p && samePath(p, l.folder);
          })
          .sort((a, b) => Number(b.title === l.session) - Number(a.title === l.session) || a.startedAt - b.startedAt);
        if (here[0]) {
          l.agentId = here[0].id;
          changed = true;
        } else {
          const failed = this.opts.spawn?.get(l.spawnId)?.status === 'failed';
          if (failed || now - l.startedAt > LINK_TIMEOUT_MS) {
            l.state = 'failed';
            this.notifyLink(l);
            changed = true;
          }
          continue;
        }
      }
      const agent = agents.find((a) => a.id === l.agentId);
      if (hasWorked(agent) && !l.worked) {
        l.worked = true;
        changed = true;
      }
      // Logo depois de subir, o escritório ainda pode não ter remontado a sessão.
      if (!agent && now - this.startedAt < STARTUP_GRACE_MS) continue;
      // Ligada à mão: a pessoa segue conversando nela, então só o fim da sessão conclui (não a primeira pausa).
      if (l.manual && agent && agent.status !== 'offline' && agent.status !== 'done') continue;
      // Agente do chat: vale o resultado da rodada (respondeu ou falhou), não só ter parado depois de começar.
      const chatEnd = !l.manual && agent?.chat && this.opts.chat?.outcome ? this.opts.chat.outcome(l.agentId!) : null;
      if (chatEnd === undefined) continue;
      const end = chatEnd ?? decideCompletion(l, agent);
      if (!end) continue;
      l.state = end;
      l.summary = end === 'failed' ? undefined : summaryText(this.opts.reply?.(l.agentId!), end === 'review' ? REVIEW_SUMMARY_MAX : SUMMARY_MAX);
      this.notifyLink(l);
      changed = true;
    }
    if (changed) this.save();
  }

  /** Item que espera revisão ou falhou: aviso no celular (nunca o resumo nem o relatório). */
  private notifyLink(l: TaskLink): void {
    if (l.state === 'review' || l.state === 'failed') this.opts.notify?.(l.cardTitle || tr('(card sem título)'), l.state);
  }

  /** Manda ao VBoards o status que ainda não foi aceito (com nova tentativa a cada minuto). */
  private async report(): Promise<void> {
    // Um envio por vez; pedido no meio de um envio roda logo depois dele.
    if (this.reporting) return void (this.reportAgain = true);
    this.reporting = true;
    try {
      do {
        this.reportAgain = false;
        await this.reportAll();
      } while (this.reportAgain);
    } finally {
      this.reporting = false;
    }
  }

  private async reportAll(): Promise<void> {
    const now = this.now();
    for (const l of this.links) {
      if (l.reported === l.state || (l.retryAt && now < l.retryAt)) continue;
      const state = l.state;
      try {
        await this.call('/api/agent-tasks/update', { email: this.opts.config.email || undefined, cardId: l.cardId, subtaskId: l.subtaskId, status: state, ...(l.summary ? { summary: l.summary } : {}) });
        l.reported = state;
        l.retryAt = undefined;
      } catch (err) {
        l.retryAt = now + RETRY_MS;
        log.warnOnce(`vboards:update:${errMsg(err)}`, tr('VBoards: falha ao atualizar a tarefa ({0}); tento de novo.', [errMsg(err)]));
      }
      this.save();
    }
  }

  private async syncTodos(): Promise<void> {
    const linked = new Set(this.links.map((l) => l.agentId));
    // Qualquer provedor: o changedCode decide (o Antigravity IDE não informa ferramentas nem linhas, então nunca entra).
    const agents = this.opts.agents().filter((a) => a.kind === 'main' && a.status !== 'offline' && !linked.has(a.id));
    const entries: Array<{ id: string; item: ConversationItem }> = [];
    for (const a of agents) {
      const text = conversationText(a.title);
      if (!text) continue;
      if (changedCode(a)) this.coded.add(a.id);
      if (!this.coded.has(a.id)) continue;
      if (hasWorked(a)) this.worked.add(a.id);
      const done = decideCompletion({ worked: this.worked.has(a.id) }, a) === 'done';
      const summary = done ? summaryText(this.opts.reply?.(a.id)) : undefined;
      entries.push({ id: a.id, item: { text, done, ...(summary ? { summary } : {}) } });
    }
    for (const d of this.todos.due(entries, this.now())) {
      const agent = agents.find((a) => a.id === d.id);
      const path = agent && this.opts.roomPath(agent.roomId);
      if (!path) continue;
      const repo = cardName({ path, card: await this.cardOf(path) });
      try {
        await this.call('/api/agent-tasks/todos', { email: this.opts.config.email || undefined, repo, todos: [d.item] });
        this.todos.posted(d.id, d.sig);
      } catch (err) {
        log.warnOnce(`vboards:todos:${errMsg(err)}`, tr('VBoards: falha ao mandar as conversas ({0}).', [errMsg(err)]));
      }
    }
  }

  private async knownFolders(): Promise<Folder[]> {
    const paths = [...(await this.opts.folders().catch(() => []))];
    for (const a of this.opts.agents()) {
      const p = this.opts.roomPath(a.roomId);
      if (p && /^(\/|[A-Za-z]:[\\/])/.test(p)) paths.push(p);
    }
    const unique = paths.filter((p, i) => paths.findIndex((q) => samePath(p, q)) === i);
    return Promise.all(unique.map(async (path) => ({ path, card: await this.cardOf(path) })));
  }

  private async cardOf(folder: string): Promise<string | undefined> {
    const hit = this.cards.get(folder);
    if (hit && this.now() - hit.at < CARD_CACHE_MS) return hit.card;
    const card = await (this.opts.cardOf ?? ((f: string) => gitConfig(['--get', 'vboards.card'], f)))(folder);
    this.cards.set(folder, { card, at: this.now() });
    return card;
  }

  private async call(path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.opts.config.base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.opts.config.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      const j = (await res.json().catch(() => ({}))) as { error?: unknown };
      throw Object.assign(new Error(apiErrorText(res.status, j.error)), { status: res.status });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  }

  private save(): void {
    if (!this.opts.file) return;
    try {
      writeFileSync(`${this.opts.file}.tmp`, JSON.stringify(this.links), { mode: 0o600 });
      renameSync(`${this.opts.file}.tmp`, this.opts.file);
    } catch (err) {
      log.warnOnce(`vboards:save:${errMsg(err)}`, tr('VBoards: não deu para gravar {0} ({1}).', [this.opts.file, errMsg(err)]));
    }
  }
}
