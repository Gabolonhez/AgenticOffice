// Chat com agentes abertos pelo escritório: cada mensagem do usuário é uma rodada da CLI do provedor sem tela
// (drivers/), que retoma a mesma conversa pelo id. O agente aparece no Office como qualquer outro (AgentInfo.chat) e a
// conversa fica em <dataDir>/chat/agents/ (store.ts), para voltar depois de reiniciar o servidor.
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { CHAT_TEXT_MAX, CHAT_TOOL_OUTPUT_MAX, type ChatFrom, type ChatItem, type ChatLimits, type ChatOpenRequest, type ChatState, type ChatView } from '../../shared/chat';
import { describeTool, maskSecrets, truncate } from '../../shared/activity';
import { tr } from '../../shared/i18n';
import type { Provider } from '../../shared/types';
import type { AccountsService } from '../accounts/service';
import type { Office } from '../model/office';
import { INHERITED_SESSION_VARS } from '../pty/manager';
import { resolveCliBin, type CliBin } from './bins';
import { agyDriver } from './drivers/agy';
import { claudeDriver } from './drivers/claude';
import { codexDriver } from './drivers/codex';
import { RoleStore } from './roles';
import { ChatStore, type ChatRecord } from './store';
import type { ChatDriver, ChatEvent, TurnSpec, WorktreeOps } from './types';
import { addUsage, overLimit, remainingUsd } from './usage';

export type { ChatOpenRequest };
export type ChatOpenResult = { agentId: string } | { error: 'invalid' | 'unavailable' | 'too-many'; reason: string };
/** Fim da rodada de uma mensagem entregue por outro agente (deliver). */
export type DeliverResult = { ok: true; reply: string } | { ok: false; error: string };
export interface ChatAgentSummary { id: string; name: string; role: string; provider: Provider; folder: string; status: string; lastReply?: string }
export interface ChatProcess {
  pid?: number;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin: NodeJS.WritableStream;
  on(e: 'close', cb: (code: number | null) => void): void;
  on(e: 'error', cb: (err: Error) => void): void;
}
export interface ChatServiceDeps {
  office: Office;
  dataDir: string;
  port: number;
  knownFolders: () => string[];
  accounts: Pick<AccountsService, 'find'>;
  bins?: (p: Provider) => CliBin | undefined;
  spawnProcess?: (file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => ChatProcess;
  kill?: (pid: number) => void;
  now?: () => number;
  newId?: () => string;
  platform?: NodeJS.Platform;
  worktrees?: WorktreeOps;
  onFinish?: (agentId: string) => void;
}

/** Um item novo, antes de ganhar seq e hora (Omit distributivo sobre a união). */
type NewItem = ChatItem extends infer T ? (T extends ChatItem ? Omit<T, 'seq' | 'at'> : never) : never;

export const MAX_CHAT_AGENTS = 8;

/** Por que o chat está desligado (undefined = ligado). Abre processos com acesso total: a mesma trava do terminal. */
export function chatOffReason(o: { inDocker: boolean; ptyOptIn: boolean; terminal: boolean; terminalReason?: string }): string | undefined {
  if (o.inDocker) return tr('Chat com agentes indisponível no Docker: rode o servidor direto no computador.');
  if (!o.ptyOptIn) return tr('Chat com agentes desligado: inicie o servidor com HABBLAUD_PTY=1.');
  if (!o.terminal) return tr('Chat com agentes desligado pela trava do terminal ({0}).', [o.terminalReason ?? '']);
  return undefined;
}
const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'antigravity'];
const DRIVERS: Record<Provider, ChatDriver> = { claude: claudeDriver, codex: codexDriver, antigravity: agyDriver };
const CLI_NAMES: Record<Provider, string> = { claude: 'claude', codex: 'codex', antigravity: 'agy' };
const NAME_MAX = 40;
const STDERR_MAX = 4000;

/** Encerra a rodada inteira: no Windows o `taskkill /T` leva junto os netos (codex.exe, shells das ferramentas). */
export function defaultKill(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  exec: (file: string, args: string[]) => void = (file, args) => void execFile(file, args, { windowsHide: true }, () => {}),
): void {
  if (platform === 'win32') {
    exec('taskkill', ['/PID', String(pid), '/T', '/F']);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // já saiu
  }
}

interface Runtime {
  rec: ChatRecord;
  proc?: ChatProcess;
  timer?: ReturnType<typeof setTimeout>;
  stopReason?: string;
  phase: ChatState['phase'];
  tool?: string;
  turnStart: number;
  token: string;
  /** Mensagens de outros agentes esperando a rodada atual terminar (deliver). */
  queue: Array<{ text: string; from: ChatFrom; done: (r: DeliverResult) => void }>;
  /** Quem espera o fim da rodada atual (a mensagem entregue que ela está rodando). */
  waiter?: (r: DeliverResult) => void;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

export function parseLimits(raw: unknown): ChatLimits | undefined {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: ChatLimits = {};
  for (const k of ['maxCostUsd', 'maxTokens', 'maxTurnMinutes'] as const) {
    if (o[k] === undefined || o[k] === null) continue;
    const n = num(o[k]);
    if (n === undefined) return undefined;
    out[k] = n;
  }
  return out;
}

export class ChatService {
  private readonly agents = new Map<string, Runtime>();
  private readonly store: ChatStore;
  readonly roles: RoleStore;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly turnEndListeners: Array<(agentId: string) => void> = [];

  constructor(private readonly deps: ChatServiceDeps) {
    this.store = new ChatStore(join(deps.dataDir, 'chat', 'agents'));
    this.roles = new RoleStore(join(deps.dataDir, 'chat', 'roles.json'));
    this.now = deps.now ?? Date.now;
    this.platform = deps.platform ?? process.platform;
  }

  /** Carrega as conversas guardadas e recoloca os agentes no Office, parados. */
  start(): void {
    for (const rec of this.store.load()) {
      this.agents.set(rec.agentId, this.runtime(rec));
      this.enterOffice(rec, 'idle');
      this.store.save(rec);
    }
  }

  providers(): Array<{ id: Provider; available: boolean; reason?: string; ask: boolean }> {
    return PROVIDERS.map((id) => {
      const available = !!this.bin(id);
      return { id, available, ...(available ? {} : { reason: tr('{0} não encontrado no PATH', [CLI_NAMES[id]]) }), ask: id === 'claude' };
    });
  }

  /** O que impediria abrir este agente (pasta, provedor, pedido, papel, limites, CLI), sem abrir nada. */
  check(raw: unknown): Exclude<ChatOpenResult, { agentId: string }> | undefined {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ChatOpenRequest>;
    const invalid = (reason: string) => ({ error: 'invalid' as const, reason });
    if (typeof r.folder !== 'string' || !this.knownFolder(r.folder)) return invalid(tr('Pasta desconhecida: abra uma sessão nela antes.'));
    const provider = r.provider;
    if (!provider || !PROVIDERS.includes(provider)) return invalid(tr('Provedor inválido.'));
    const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : '';
    if (!prompt || prompt.length > CHAT_TEXT_MAX) return invalid(tr('Escreva o pedido (até {0} caracteres).', [CHAT_TEXT_MAX]));
    if (!parseLimits(r.limits)) return invalid(tr('Limites inválidos.'));
    if (r.roleId && !this.roles.get(r.roleId)) return invalid(tr('Papel não encontrado.'));
    if (typeof r.name === 'string' && r.name.trim().length > NAME_MAX) return invalid(tr('Nome muito longo.'));
    if (r.isolated && !this.deps.worktrees) return invalid(tr('Cópia isolada indisponível.'));
    if (!this.bin(provider)) return { error: 'unavailable', reason: tr('{0} não encontrado no PATH', [CLI_NAMES[provider]]) };
    return undefined;
  }

  /**
   * Abre um agente e roda o pedido. `run` (só do servidor, lista de server/chat/runs.ts): roda na cópia da lista e não
   * conta no limite de agentes (a lista roda um por vez).
   */
  open(raw: unknown, from?: ChatFrom, run?: { cwd?: string }): ChatOpenResult {
    const bad = this.check(raw);
    if (bad) return bad;
    const r = raw as ChatOpenRequest;
    const folder = this.knownFolder(r.folder)!;
    const provider = r.provider;
    const prompt = r.prompt.trim();
    const limits = parseLimits(r.limits)!;
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!run && this.agents.size >= MAX_CHAT_AGENTS) return { error: 'too-many', reason: tr('Já há {0} agentes do chat abertos; feche um antes.', [MAX_CHAT_AGENTS]) };

    const agentId = `chat:${(this.deps.newId ?? randomUUID)()}`;
    const rec: ChatRecord = {
      v: 1,
      agentId,
      provider,
      ...(typeof r.account === 'string' && r.account ? { account: r.account } : {}),
      folder,
      cwd: run?.cwd ?? folder,
      ...(typeof r.model === 'string' && r.model.trim() ? { model: r.model.trim() } : {}),
      ...(r.roleId ? { roleId: r.roleId } : {}),
      permission: provider === 'claude' && r.permission === 'ask' ? 'ask' : 'auto',
      // O Claude aceita o id da conversa já na 1ª rodada; Codex e agy dão o deles no evento `session`.
      ...(provider === 'claude' ? { providerSessionId: randomUUID() } : {}),
      limits,
      spend: { usd: 0, tokens: 0 },
      items: [],
      ...(typeof r.vboardsTaskId === 'string' && r.vboardsTaskId ? { vboardsTaskId: r.vboardsTaskId } : {}),
      ...(name ? { name } : {}),
      seed: randomBytes(4).readUInt32LE(0),
      createdAt: this.now(),
      alwaysAllow: [],
    };
    const rt = this.runtime(rec);
    this.agents.set(agentId, rt);
    this.enterOffice(rec, 'working');
    if (name) this.deps.office.setCharacter(agentId, { name, seed: rec.seed, parts: {} });
    if (r.isolated && this.deps.worktrees && !run) {
      rt.phase = 'thinking';
      rec.running = true;
      this.store.save(rec);
      void this.deps.worktrees.create(folder, agentId, name || CLI_NAMES[provider]).then((w) => {
        rec.running = false;
        if ('error' in w) {
          this.pushItem(rt, { kind: 'notice', level: 'error', text: w.error });
          this.finishOffice(rt);
          return;
        }
        rec.cwd = w.path;
        rec.isolated = { branch: w.branch, path: w.path, base: w.base };
        this.runTurn(rt, prompt, from);
      });
    } else {
      this.runTurn(rt, prompt, from);
    }
    return { agentId };
  }

  send(agentId: string, raw: unknown): 'ok' | 'not-found' | 'busy' | 'blocked' | 'invalid' {
    const rt = this.agents.get(agentId);
    if (!rt) return 'not-found';
    const text = typeof (raw as { text?: unknown })?.text === 'string' ? (raw as { text: string }).text.trim() : '';
    if (!text || text.length > CHAT_TEXT_MAX) return 'invalid';
    if (rt.proc || rt.rec.running) return 'busy';
    if (overLimit(rt.rec.spend, rt.rec.limits)) return 'blocked';
    this.runTurn(rt, text);
    return 'ok';
  }

  /**
   * Mensagem de outro agente (já aprovada pelo usuário): roda agora se o agente estiver livre, senão espera na fila.
   * `result` resolve no fim da rodada dela; `cancel` tira da fila (se já roda, só deixa de esperar).
   */
  deliver(agentId: string, text: string, from: ChatFrom): { result: Promise<DeliverResult>; cancel: () => void } | undefined {
    const rt = this.agents.get(agentId);
    if (!rt) return undefined;
    let entry!: Runtime['queue'][number];
    const result = new Promise<DeliverResult>((done) => (entry = { text, from, done }));
    rt.queue.push(entry);
    this.runQueued(rt);
    return {
      result,
      cancel: () => {
        rt.queue = rt.queue.filter((q) => q !== entry);
        if (rt.waiter === entry.done) delete rt.waiter;
        entry.done({ ok: false, error: tr('Cancelado.') });
      },
    };
  }

  /** Atividade no Office do agente (ex.: conversa entre agentes). */
  note(agentId: string, icon: string, text: string, detail?: string): void {
    if (!this.agents.has(agentId)) return;
    const at = this.now();
    this.deps.office.addActivity(agentId, { id: `${agentId}#note:${randomUUID()}`, at, kind: 'other', icon, text: truncate(text, 46), ...(detail ? { detail: truncate(maskSecrets(detail), 300) } : {}) }, false);
  }

  /** Avisado quando a rodada de qualquer agente termina (inclusive por Parar ou tempo). */
  onTurnEnd(cb: (agentId: string) => void): void {
    this.turnEndListeners.push(cb);
  }

  /** "Bia (Dev)": o nome do personagem no escritório e o papel. */
  displayName(agentId: string): string {
    const rec = this.agents.get(agentId)?.rec;
    if (!rec) return agentId;
    const name = this.deps.office.get(agentId)?.name || rec.name || agentId;
    const role = rec.roleId ? this.roles.get(rec.roleId)?.name : undefined;
    return role ? `${name} (${role})` : name;
  }

  agentsList(): ChatAgentSummary[] {
    return [...this.agents.values()].map(({ rec }) => {
      const reply = this.lastReply(rec.agentId);
      return {
        id: rec.agentId,
        name: this.deps.office.get(rec.agentId)?.name || rec.name || rec.agentId,
        role: rec.roleId ? (this.roles.get(rec.roleId)?.name ?? '') : '',
        provider: rec.provider,
        folder: rec.folder,
        status: this.deps.office.get(rec.agentId)?.status ?? 'idle',
        ...(reply ? { lastReply: truncate(reply.replace(/\s+/g, ' '), 300) } : {}),
      };
    });
  }

  stop(agentId: string): 'ok' | 'not-found' | 'idle' {
    const rt = this.agents.get(agentId);
    if (!rt) return 'not-found';
    if (!rt.proc) return 'idle';
    this.interrupt(rt, tr('Rodada interrompida.'));
    return 'ok';
  }

  setLimits(agentId: string, raw: unknown): 'ok' | 'not-found' | 'invalid' {
    const rt = this.agents.get(agentId);
    if (!rt) return 'not-found';
    const limits = parseLimits(raw);
    if (!limits) return 'invalid';
    rt.rec.limits = limits;
    this.store.save(rt.rec);
    this.deps.office.markDirty();
    return 'ok';
  }

  view(agentId: string, after = 0): ChatView | undefined {
    const rt = this.agents.get(agentId);
    if (!rt) return undefined;
    const { rec } = rt;
    const blocked = overLimit(rec.spend, rec.limits);
    const state: ChatState = {
      phase: rt.phase,
      ...(rt.tool ? { tool: rt.tool } : {}),
      ...(blocked ? { blocked } : {}),
      spentUsd: rec.spend.usd,
      spentTokens: rec.spend.tokens,
      limits: rec.limits,
      ...(rec.isolated ? { isolated: { branch: rec.isolated.branch, ...(rec.isolated.merged ? { merged: true } : {}), ...(rec.isolated.discarded ? { discarded: true } : {}) } } : {}),
    };
    return { agentId, provider: rec.provider, items: rec.items.filter((i) => i.seq > after), state, lastSeq: rec.items.at(-1)?.seq ?? 0 };
  }

  close(agentId: string): 'ok' | 'not-found' | 'busy' {
    const rt = this.agents.get(agentId);
    if (!rt) return 'not-found';
    if (rt.proc || rt.rec.running) return 'busy';
    this.agents.delete(agentId);
    this.store.remove(agentId);
    this.deps.office.closeMain(agentId);
    return 'ok';
  }

  /** Desligando o servidor: encerra as rodadas em andamento (os filhos sobreviveriam ao processo). */
  stopAll(): void {
    for (const rt of this.agents.values()) this.interrupt(rt, tr('Rodada interrompida.'));
  }

  /** Como terminou a última rodada: 'done' se o agente respondeu; undefined enquanto roda. */
  turnOutcome(agentId: string): 'done' | 'failed' | undefined {
    const rt = this.agents.get(agentId);
    if (!rt || rt.proc || rt.rec.running) return undefined;
    const items = rt.rec.items;
    let i = items.length - 1;
    while (i >= 0 && items[i].kind !== 'user') i--;
    if (i < 0) return undefined;
    return items.slice(i + 1).some((x) => x.kind === 'assistant') ? 'done' : 'failed';
  }

  isChatSession(sessionId: string): boolean {
    for (const rt of this.agents.values()) if (rt.rec.providerSessionId === sessionId) return true;
    return false;
  }

  lastReply(agentId: string): string | undefined {
    const items = this.agents.get(agentId)?.rec.items ?? [];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === 'assistant') return it.text;
    }
    return undefined;
  }

  /** Conversas com atividade desde `since`: os pedidos do usuário de hoje e a última resposta (resumo do dia). */
  conversationsSince(since: number): Array<{ name: string; folder: string; prompts: string[]; lastReply?: string; working: boolean; lastAt: number }> {
    return [...this.agents.values()].flatMap(({ rec }) => {
      const lastAt = rec.items.at(-1)?.at ?? 0;
      const working = !!this.deps.office.get(rec.agentId) && ['working', 'waiting'].includes(this.deps.office.get(rec.agentId)!.status);
      if (lastAt < since && !working) return [];
      const prompts = rec.items.flatMap((i) => (i.kind === 'user' && i.at >= since && !i.from ? [i.text] : []));
      return [{ name: this.deps.office.get(rec.agentId)?.name || rec.name || rec.agentId, folder: rec.folder, prompts, lastReply: this.lastReply(rec.agentId), working, lastAt }];
    });
  }

  tokenOwner(token: string): string | undefined {
    for (const [id, rt] of this.agents) if (rt.token === token) return id;
    return undefined;
  }

  record(agentId: string): ChatRecord | undefined {
    return this.agents.get(agentId)?.rec;
  }

  addApproval(agentId: string, item: Omit<Extract<ChatItem, { kind: 'approval' }>, 'seq' | 'at'>): void {
    const rt = this.agents.get(agentId);
    if (!rt) return;
    rt.phase = 'approval';
    this.pushItem(rt, item);
    this.deps.office.setStatus(agentId, 'waiting', tr('aprovação'));
  }

  /** O usuário respondeu um pedido de aprovação (o item fica com o resultado). */
  resolveApproval(agentId: string, permissionId: string, outcome: 'allow' | 'deny'): void {
    const rt = this.agents.get(agentId);
    if (!rt) return;
    const it = rt.rec.items.find((i) => i.kind === 'approval' && i.permissionId === permissionId);
    if (it && it.kind === 'approval') it.outcome = outcome;
    if (rt.proc) {
      rt.phase = 'tool';
      this.deps.office.setStatus(agentId, 'working');
    }
    this.store.save(rt.rec);
    this.deps.office.markDirty();
  }

  /** Marca a cópia isolada como juntada/descartada (Task 11/12). */
  markIsolated(agentId: string, change: { merged?: true; discarded?: true }, notice?: string): void {
    const rt = this.agents.get(agentId);
    if (!rt?.rec.isolated) return;
    Object.assign(rt.rec.isolated, change);
    // A cópia descartada não existe mais: o agente volta a trabalhar na pasta do projeto.
    if (change.discarded) rt.rec.cwd = rt.rec.folder;
    if (notice) this.pushItem(rt, { kind: 'notice', level: 'info', text: notice });
    else this.store.save(rt.rec);
  }

  /** A cópia da lista foi descartada: o agente volta a trabalhar na pasta do projeto. */
  restoreCwd(agentId: string): void {
    const rt = this.agents.get(agentId);
    if (!rt || rt.rec.cwd === rt.rec.folder || rt.rec.isolated) return;
    rt.rec.cwd = rt.rec.folder;
    this.store.save(rt.rec);
  }

  // --- interno ---

  private runtime(rec: ChatRecord): Runtime {
    return { rec, phase: 'idle', turnStart: 0, token: randomBytes(24).toString('hex'), queue: [] };
  }

  private bin(p: Provider): CliBin | undefined {
    return (this.deps.bins ?? ((x: Provider) => resolveCliBin(x)))(p);
  }

  private knownFolder(folder: string): string | undefined {
    const norm = (p: string) => (this.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
    const want = norm(folder);
    return this.deps.knownFolders().find((f) => norm(f) === want);
  }

  private enterOffice(rec: ChatRecord, status: 'working' | 'idle'): void {
    const role = rec.roleId ? (this.roles.get(rec.roleId)?.name ?? '') : '';
    this.deps.office.addMain({
      id: rec.agentId,
      provider: rec.provider,
      account: rec.account ?? '',
      sessionId: rec.providerSessionId ?? rec.agentId,
      cwd: rec.folder,
      role,
      startedAt: rec.createdAt,
      status,
      chat: true,
    });
    this.applyStats(rec);
  }

  private applyStats(rec: ChatRecord): void {
    const first = rec.items.find((i) => i.kind === 'user');
    let toolCalls = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    for (const i of rec.items) {
      if (i.kind === 'tool') toolCalls++;
      if (i.kind === 'usage') {
        tokensIn += i.tokensIn;
        tokensOut += i.tokensOut;
      }
    }
    this.deps.office.applyTranscript(rec.agentId, {
      ...(first && first.kind === 'user' ? { title: truncate(first.text.replace(/\s+/g, ' '), 60) } : {}),
      tasks: [],
      stats: { toolCalls, tokensIn, tokensOut, subagents: 0, ...(rec.spend.usd ? { costUSD: rec.spend.usd } : {}) },
      ...(rec.model ? { model: rec.model } : {}),
      lastAt: this.now(),
    });
  }

  private pushItem(rt: Runtime, item: NewItem): ChatItem {
    const full = { ...item, seq: (rt.rec.items.at(-1)?.seq ?? 0) + 1, at: this.now() } as ChatItem;
    rt.rec.items.push(full);
    this.store.save(rt.rec);
    this.deps.office.markDirty();
    return full;
  }

  /** Agente livre: roda a próxima mensagem da fila. Quem espera sempre recebe um fim (limite, CLI que não abriu). */
  private runQueued(rt: Runtime): void {
    while (!rt.proc && !rt.rec.running && rt.queue.length) {
      const q = rt.queue.shift()!;
      if (overLimit(rt.rec.spend, rt.rec.limits)) {
        q.done({ ok: false, error: tr('O agente atingiu o limite de custo ou de tokens.') });
        continue;
      }
      rt.waiter = q.done;
      this.runTurn(rt, q.text, q.from);
      if (rt.proc || rt.rec.running) return;
      delete rt.waiter;
      q.done(this.turnResult(rt));
    }
  }

  /** Como terminou a rodada que acabou de fechar, para quem mandou a mensagem. */
  private turnResult(rt: Runtime): DeliverResult {
    if (this.turnOutcome(rt.rec.agentId) === 'done') return { ok: true, reply: this.lastReply(rt.rec.agentId) ?? '' };
    const items = rt.rec.items;
    let i = items.length - 1;
    while (i >= 0 && items[i].kind !== 'user') i--;
    const notice = items.slice(i + 1).findLast((x) => x.kind === 'notice');
    return { ok: false, error: notice && notice.kind === 'notice' ? notice.text : tr('O agente terminou sem responder.') };
  }

  private runTurn(rt: Runtime, prompt: string, from?: ChatFrom): void {
    const { rec } = rt;
    const bin = this.bin(rec.provider);
    this.pushItem(rt, { kind: 'user', text: prompt, ...(from ? { from } : {}) });
    if (!bin) {
      this.pushItem(rt, { kind: 'notice', level: 'error', text: tr('{0} não encontrado no PATH', [CLI_NAMES[rec.provider]]) });
      this.finishOffice(rt);
      return;
    }
    const first = !rec.sessionStarted;
    const spec: TurnSpec = {
      folder: rec.cwd,
      // A CLI de quem recebe precisa saber que o pedido veio de outro agente (no chat, o remetente vai no item).
      prompt: from ? `[Mensagem de ${from.name}, outro agente do AgenticOffice (id ${from.agentId}). A sua resposta final volta para ele.]\n\n${prompt}` : prompt,
      first,
      ...(rec.provider === 'claude' && first ? { sessionId: rec.providerSessionId } : {}),
      ...(!first && rec.providerSessionId ? { resumeId: rec.providerSessionId } : {}),
      ...(rec.model ? { model: rec.model } : {}),
      ...(rec.roleId && this.roles.get(rec.roleId) ? { role: this.roles.get(rec.roleId)!.text } : {}),
      permission: rec.permission,
      ...(remainingUsd(rec.spend, rec.limits) !== undefined ? { budgetUsd: remainingUsd(rec.spend, rec.limits) } : {}),
      ...(rec.provider === 'claude'
        ? { mcp: { url: `http://127.0.0.1:${this.deps.port}/api/chat/mcp/${encodeURIComponent(rec.agentId)}`, token: rt.token } }
        : {}),
      ...(rec.account && this.deps.accounts.find(rec.account) ? { accountDir: this.deps.accounts.find(rec.account)!.dir } : {}),
    };
    const driver = DRIVERS[rec.provider];
    const inv = driver.invocation(spec);
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of INHERITED_SESSION_VARS) delete env[k];
    for (const [k, v] of Object.entries(inv.env)) if (v !== undefined) env[k] = v;
    rec.running = true;
    rt.phase = 'thinking';
    rt.turnStart = this.now();
    delete rt.stopReason;
    this.store.save(rec);
    this.deps.office.setStatus(rec.agentId, 'working');

    const spawnProcess = this.deps.spawnProcess ?? ((file, args, o) => spawn(file, args, { cwd: o.cwd, env: o.env, shell: false, windowsHide: true, detached: this.platform !== 'win32' }));
    let proc: ChatProcess;
    try {
      proc = spawnProcess(bin.file, [...bin.prefix, ...inv.args], { cwd: rec.cwd, env });
    } catch (err) {
      rec.running = false;
      this.pushItem(rt, { kind: 'notice', level: 'error', text: maskSecrets(String((err as Error)?.message ?? err)) });
      this.finishOffice(rt);
      return;
    }
    rt.proc = proc;
    // Falha ao abrir (pasta sumiu, executável apagado) chega como 'error' depois; sem ouvinte, derrubaria o servidor.
    let spawnError = '';
    proc.on('error', (err) => {
      spawnError ||= err.message;
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(inv.stdin ?? '');

    const parser = driver.parser();
    let stderr = '';
    proc.stderr.on('data', (d: Buffer | string) => {
      if (stderr.length < STDERR_MAX) stderr += String(d);
    });
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    const rlDone = new Promise<void>((ok) => rl.on('close', ok));
    rl.on('line', (line) => {
      for (const e of parser.line(line)) this.apply(rt, e);
    });
    if (rec.limits.maxTurnMinutes) {
      const min = rec.limits.maxTurnMinutes;
      rt.timer = setTimeout(() => this.interrupt(rt, tr('Tempo da rodada esgotado ({0} min).', [min])), min * 60_000);
    }
    proc.on('close', (code) => {
      void rlDone.then(() => {
        for (const e of parser.end(code, spawnError || stderr)) this.apply(rt, e);
        this.endTurn(rt);
      });
    });
  }

  private interrupt(rt: Runtime, reason: string): void {
    if (!rt.proc || rt.stopReason) return;
    rt.stopReason = reason;
    rt.phase = 'stopping';
    if (rt.proc.pid !== undefined) (this.deps.kill ?? ((pid: number) => defaultKill(pid, this.platform)))(rt.proc.pid);
    this.deps.office.markDirty();
  }

  private apply(rt: Runtime, e: ChatEvent): void {
    const { rec } = rt;
    const id = rec.agentId;
    switch (e.type) {
      case 'session':
        if (!rec.providerSessionId) rec.providerSessionId = e.id;
        if (!rec.sessionStarted) {
          rec.sessionStarted = true;
          this.store.save(rec);
        }
        return;
      case 'thinking':
        if (rt.phase !== 'stopping') rt.phase = 'thinking';
        return;
      case 'text':
        this.pushItem(rt, { kind: 'assistant', text: maskSecrets(e.text) });
        return;
      case 'notice':
        this.pushItem(rt, { kind: 'notice', level: 'info', text: maskSecrets(e.text) });
        return;
      case 'tool': {
        const input = maskSecrets(e.input);
        this.pushItem(rt, { kind: 'tool', toolId: e.id, name: e.name, input });
        if (rt.phase !== 'stopping') rt.phase = 'tool';
        rt.tool = e.name;
        const raw = /^(Bash|PowerShell|command)$/.test(e.name) ? { command: e.input } : { file_path: e.input };
        this.deps.office.addActivity(id, { id: `${id}#${e.id}`, at: this.now(), tool: e.name, ...describeTool(e.name, raw) }, true);
        this.deps.office.setStatus(id, 'working');
        return;
      }
      case 'tool-result': {
        const it = rec.items.find((i) => i.kind === 'tool' && i.toolId === e.id);
        if (it && it.kind === 'tool') {
          it.output = truncate(maskSecrets(e.output), CHAT_TOOL_OUTPUT_MAX);
          if (e.error) it.error = true;
          this.store.save(rec);
          this.deps.office.markDirty();
        }
        return;
      }
      case 'usage': {
        const { spend, turnUsd } = addUsage(rec.spend, e);
        rec.spend = spend;
        this.pushItem(rt, { kind: 'usage', tokensIn: e.tokensIn, tokensOut: e.tokensOut, ...(turnUsd !== undefined ? { costUsd: turnUsd } : {}), ms: this.now() - rt.turnStart });
        return;
      }
      case 'done':
        if (!e.ok && !rt.stopReason && e.error) this.pushItem(rt, { kind: 'notice', level: 'error', text: maskSecrets(e.error) });
        return;
    }
  }

  private endTurn(rt: Runtime): void {
    const { rec } = rt;
    if (rt.timer) clearTimeout(rt.timer);
    delete rt.timer;
    delete rt.proc;
    rec.running = false;
    const stopped = !!rt.stopReason;
    if (rt.stopReason) this.pushItem(rt, { kind: 'notice', level: 'info', text: rt.stopReason });
    const blocked = overLimit(rec.spend, rec.limits);
    if (blocked) {
      this.pushItem(rt, {
        kind: 'notice',
        level: 'error',
        text: blocked === 'cost' ? tr('Limite de custo atingido: aumente o limite para continuar.') : tr('Limite de tokens atingido: aumente o limite para continuar.'),
      });
    }
    void this.afterIsolatedTurn(rt).finally(() => {
      this.finishOffice(rt);
      this.deps.onFinish?.(rec.agentId);
      const waiter = rt.waiter;
      delete rt.waiter;
      waiter?.(this.turnResult(rt));
      for (const cb of this.turnEndListeners) cb(rec.agentId);
      // Parado pelo usuário (ou pelo tempo): a fila não começa sozinha uma rodada nova com acesso total.
      if (stopped) for (const q of rt.queue.splice(0)) q.done({ ok: false, error: tr('O agente foi parado.') });
      else this.runQueued(rt);
    });
  }

  private async afterIsolatedTurn(rt: Runtime): Promise<void> {
    const w = rt.rec.isolated;
    if (!w || !this.deps.worktrees || w.merged || w.discarded) return;
    try {
      const s = await this.deps.worktrees.summary(w);
      if (s.stat) this.pushItem(rt, { kind: 'notice', level: 'info', text: s.stat });
    } catch {
      // o resumo é só informativo
    }
  }

  private finishOffice(rt: Runtime): void {
    rt.phase = 'idle';
    delete rt.tool;
    delete rt.stopReason;
    this.store.save(rt.rec);
    this.applyStats(rt.rec);
    this.deps.office.setStatus(rt.rec.agentId, 'idle');
  }
}
