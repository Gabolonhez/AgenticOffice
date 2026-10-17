// Ponte com o VBoards (o quadro de Planning do time). Três partes:
// - fila: a cada ~10 s (com espera maior depois de erro) busca as subtarefas que você marcou "mandar para o agente"
//   (GET /api/agent-tasks) e guarda na memória; a página as lista (GET /api/vboards) e só começa uma com o seu clique
//   em "Iniciar" (POST /api/vboards/start): nunca sozinha;
// - conclusão: o agente aberto para a subtarefa fica ligado a ela (<dataDir>/vboards-links.json, sobrevive a um
//   reinício); quando ele termina o turno depois de ter trabalhado, ou a sessão acaba, a subtarefa vira 'done' com a
//   última resposta como resumo (ou 'failed', se nunca trabalhou). Uma vez por subtarefa;
// - conversas: cada agente principal do Claude Code (fora os ligados a uma subtarefa) que mexeu em código (editou arquivos ou fez commit) vira um item no card do projeto
//   (POST /api/agent-tasks/todos): o título da conversa, done quando terminou o turno depois de trabalhar, com o
//   resumo da última resposta. ~15 s de calma e só quando mudou.
// O token só vai no cabeçalho Authorization: nunca em log, snapshot ou página. Git sem shell (execFile).
import { execFile } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { maskSecrets } from '../../shared/activity';
import { tr } from '../../shared/i18n';
import type { AgentInfo } from '../../shared/types';
import { errMsg, log } from '../log';
import { FileTail } from '../sources/tail';
import type { TerminalParser } from '../sources/terminal';
import { sessionName, type SpawnInfo, type SpawnSubmit } from '../spawn/spawn';

export const POLL_MS = 10_000;
export const POLL_MAX_MS = 5 * 60_000;
export const TODOS_QUIET_MS = 15_000;
export const SUMMARY_MAX = 1_500;
/** Agente que não apareceu na pasta neste prazo depois do "Iniciar": a subtarefa falha. */
export const LINK_TIMEOUT_MS = 30 * 60_000;
/** Ligações concluídas ficam este tempo (para não concluir duas vezes nem mostrar a subtarefa de novo). */
export const KEEP_DONE_MS = 7 * 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_MS = 60_000;
const CARD_CACHE_MS = 5 * 60_000;
/** Depois de subir: só conclui "a sessão acabou" passado este tempo (o escritório ainda está remontando). */
const STARTUP_GRACE_MS = 60_000;

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
}

export type TaskStatus = 'running' | 'done' | 'failed';

/** Subtarefa iniciada daqui, ligada ao agente aberto para ela. */
export interface TaskLink {
  id: string;
  cardId: string;
  subtaskId: string;
  folder: string;
  /** Nome da sessão em segundo plano (spawn/spawn.ts sessionName): desempata agentes na mesma pasta. */
  session: string;
  spawnId: string;
  startedAt: number;
  agentId?: string;
  /** O agente já esteve trabalhando. */
  worked?: boolean;
  state: TaskStatus;
  summary?: string;
  /** Último status aceito pelo VBoards. */
  reported?: TaskStatus;
  retryAt?: number;
}

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
  if (!email) return { off: tr('sem e-mail (git config --global user.email ou HABBLAUD_VBOARDS_EMAIL)') };
  return { base, token, email };
}

/** Pastas cujo nome (ou vboards.card) é o título do card. */
export function matchFolders(cardTitle: string, folders: readonly Folder[]): string[] {
  const want = norm(cardTitle);
  if (!want) return [];
  return folders.filter((f) => norm(baseName(f.path)) === want || (!!f.card && norm(f.card) === want)).map((f) => f.path);
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
const GIT_COMMIT = /\bgit\s+(?:-\S+\s+)*commit\b/;

/**
 * A conversa mexeu em código: linhas somadas/removidas (total do transcript) ou, nas atividades recentes, uma edição
 * de arquivo ou um `git commit`. Conversa só de perguntas e respostas não conta.
 */
export function changedCode(a: Pick<AgentInfo, 'stats' | 'recent' | 'activity'>): boolean {
  if ((a.stats?.linesAdded ?? 0) > 0 || (a.stats?.linesRemoved ?? 0) > 0) return true;
  return [...(a.recent ?? []), ...(a.activity ? [a.activity] : [])].some((x) => (!!x.tool && EDIT_TOOLS.test(x.tool)) || (!x.error && /^(Bash|shell|command_execution)$/i.test(x.tool ?? '') && GIT_COMMIT.test(x.detail ?? x.text)));
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
export function summaryText(text: string | undefined): string | undefined {
  const s = maskSecrets(text ?? '').trim();
  if (!s) return undefined;
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s;
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
  chat?: { open: ChatOpener; outcome?(agentId: string): 'done' | 'failed' | undefined };
  /** Última resposta do agente (transcript). */
  reply?: (agentId: string) => string | undefined;
  booting?: () => boolean;
  /** vboards.card de uma pasta. */
  cardOf?: (folder: string) => Promise<string | undefined>;
  file?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class VBoardsService {
  private tasks: AgentTask[] = [];
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
      const r = (await this.call(`/api/agent-tasks?email=${encodeURIComponent(this.opts.config.email)}`)) as { tasks?: unknown };
      const list = Array.isArray(r?.tasks) ? r.tasks : [];
      this.tasks = list.flatMap((x) => {
        const t = x as Record<string, unknown>;
        const s = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
        return s(t.cardId) && s(t.subtaskId) && s(t.text) ? [{ cardId: s(t.cardId), subtaskId: s(t.subtaskId), text: s(t.text), cardTitle: s(t.cardTitle), date: s(t.date) || undefined }] : [];
      });
      this.delay = POLL_MS;
      this.lastError = undefined;
    } catch (err) {
      const msg = errMsg(err);
      if (msg !== this.lastError) log.warn(tr('VBoards: falha ao buscar as tarefas ({0}); tentando de novo mais tarde.', [msg]));
      this.lastError = msg;
      this.delay = Math.min(this.delay * 2, POLL_MAX_MS);
    }
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), this.delay);
    this.pollTimer.unref?.();
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
      };
    });
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
    const prompt = `${tr('Tarefa do VBoards (card {0}):', [task.cardTitle])} ${task.text}`;
    if (chat) {
      // Pelo chat: o agente já tem id, então o link nasce ligado a ele (sem casar por pasta e horário).
      const extra = body.chat && typeof body.chat === 'object' ? (body.chat as Record<string, unknown>) : {};
      const asked = typeof extra.prompt === 'string' && extra.prompt.trim() ? extra.prompt : prompt;
      const r = chat.open({ ...extra, folder: picked, prompt: asked, vboardsTaskId: taskId(task) });
      if (!('agentId' in r)) return { status: r.error === 'invalid' ? 400 : r.error === 'too-many' ? 429 : 409, error: r.reason };
      this.links.push({ id: taskId(task), cardId: task.cardId, subtaskId: task.subtaskId, folder: picked, session: '', spawnId: '', agentId: r.agentId, startedAt: this.now(), state: 'running' });
      this.save();
      void this.report();
      return { agentId: r.agentId };
    }
    const r = spawn!.submit({ folder: picked, prompt });
    if (!('spawn' in r)) return { status: r.error === 'invalid' ? 400 : r.error === 'too-many' ? 429 : 409, error: r.reason };
    this.links.push({ id: taskId(task), cardId: task.cardId, subtaskId: task.subtaskId, folder: picked, session: sessionName(prompt), spawnId: r.spawn.id, startedAt: this.now(), state: 'running' });
    this.save();
    void this.report();
    return { spawn: r.spawn };
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
      // Agente do chat: vale o resultado da rodada (respondeu ou falhou), não só ter parado depois de começar.
      const chatEnd = agent?.chat && this.opts.chat?.outcome ? this.opts.chat.outcome(l.agentId!) : null;
      if (chatEnd === undefined) continue;
      const end = chatEnd ?? decideCompletion(l, agent);
      if (!end) continue;
      l.state = end;
      l.summary = end === 'done' ? summaryText(this.opts.reply?.(l.agentId!)) : undefined;
      changed = true;
    }
    if (changed) this.save();
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
        await this.call('/api/agent-tasks/update', { email: this.opts.config.email, cardId: l.cardId, subtaskId: l.subtaskId, status: state, ...(l.summary ? { summary: l.summary } : {}) });
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
    const agents = this.opts.agents().filter((a) => a.kind === 'main' && (a.provider ?? 'claude') === 'claude' && a.status !== 'offline' && !linked.has(a.id));
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
        await this.call('/api/agent-tasks/todos', { email: this.opts.config.email, repo, todos: [d.item] });
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
