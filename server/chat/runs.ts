// Lista que roda sozinha: um agente novo do chat por item, em sequência (contexto limpo a cada item). Só começa com o
// "Rodar lista" da tela de confirmação (POST /api/chat/runs = a aprovação da lista inteira); Parar interrompe o agente
// atual e cancela o resto. Reiniciar o servidor nunca retoma: o item que rodava vira interrompido e a lista pausa até o
// "Continuar". Itens do VBoards abrem pelo VBoardsService.begin, que liga a tarefa ao agente e a conclui com o resumo.
// Guardado em <dataDir>/chat/runs.json. Desenho: docs/superpowers/specs/2026-10-16-checklist-design.md.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { truncate } from '../../shared/activity';
import { CHAT_TEXT_MAX } from '../../shared/chat';
import { tr } from '../../shared/i18n';
import { RUN_CONTEXT_MAX, RUN_ITEMS_MAX, type ChatRun, type RunAgentOptions, type RunItem } from '../../shared/runs';
import { errMsg, log } from '../log';
import type { ChatOpener } from '../vboards/vboards';
import type { ChatService } from './service';
import type { WorktreeOps } from './types';

export const RUNS_KEEP = 20;
const SUMMARY_MAX = 600;
const OPTION_KEYS = ['folder', 'provider', 'account', 'model', 'roleId', 'permission', 'limits'] as const;

export interface RunDeps {
  chat: Pick<ChatService, 'check' | 'open' | 'turnOutcome' | 'lastReply' | 'stop' | 'onTurnEnd' | 'restoreCwd'>;
  vboards?: { begin(raw: unknown, open: ChatOpener): Promise<{ agentId: string } | { spawn: unknown } | { status: number; error: string }> };
  worktrees?: WorktreeOps;
  file: string;
  now?: () => number;
  newId?: () => string;
}

type Fail = { status: number; error: string };

const itemPrompt = (run: Pick<ChatRun, 'context'>, text: string) => (run.context ? `${run.context}\n\n${text}` : text);

export class RunService {
  private runs: ChatRun[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: RunDeps) {
    this.now = deps.now ?? Date.now;
    deps.chat.onTurnEnd((agentId) => this.turnEnded(agentId));
  }

  /** Lê runs.json; o que rodava quando o servidor caiu fica interrompido e a lista, pausada. */
  load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.deps.file, 'utf8'));
    } catch {
      return;
    }
    if (!Array.isArray(raw)) return;
    this.runs = raw.filter(
      (r): r is ChatRun => !!r && typeof r === 'object' && typeof r.id === 'string' && Array.isArray(r.items) && !!r.options && typeof r.options.folder === 'string' && r.items.every((i: unknown) => !!i && typeof (i as RunItem).text === 'string'),
    );
    let changed = false;
    for (const run of this.runs) {
      if (run.state !== 'running') continue;
      run.state = 'paused';
      for (const i of run.items) if (i.state === 'running') i.state = 'interrupted';
      changed = true;
    }
    if (changed) this.save();
  }

  list(): ChatRun[] {
    return this.runs;
  }

  get(id: string): ChatRun | undefined {
    return this.runs.find((r) => r.id === id);
  }

  /** "Rodar lista": valida tudo antes de abrir qualquer agente; o pedido já é a aprovação da lista inteira. */
  create(raw: unknown): { run: ChatRun } | Fail {
    const bad = (error: string, status = 400): Fail => ({ status, error });
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const list = Array.isArray(b.items) ? b.items : [];
    if (!list.length || list.length > RUN_ITEMS_MAX) return bad(tr('A lista precisa ter de 1 a {0} itens.', [RUN_ITEMS_MAX]));
    const context = typeof b.context === 'string' ? b.context.trim() : '';
    if (context.length > RUN_CONTEXT_MAX) return bad(tr('O contexto comum passa de {0} caracteres.', [RUN_CONTEXT_MAX]));
    const items: RunItem[] = [];
    for (const x of list) {
      const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
      const text = typeof o.text === 'string' ? o.text.trim() : '';
      if (!text) return bad(tr('Item da lista sem texto.'));
      if (itemPrompt({ context }, text).length > CHAT_TEXT_MAX) return bad(tr('Item longo demais: contexto e item passam de {0} caracteres.', [CHAT_TEXT_MAX]));
      const task = typeof o.vboardsTaskId === 'string' && o.vboardsTaskId ? o.vboardsTaskId : undefined;
      if (task && !this.deps.vboards) return bad(tr('VBoards desligado: a lista não pode ter tarefas dele.'));
      items.push({ text, ...(task ? { vboardsTaskId: task } : {}), state: 'pending' });
    }
    const given = (b.options && typeof b.options === 'object' ? b.options : {}) as Record<string, unknown>;
    const options = Object.fromEntries(OPTION_KEYS.filter((k) => given[k] !== undefined).map((k) => [k, given[k]])) as unknown as RunAgentOptions;
    const invalid = this.deps.chat.check({ ...options, prompt: items[0].text });
    if (invalid) return bad(invalid.reason, invalid.error === 'invalid' ? 400 : 409);
    if (b.isolated === true && !this.deps.worktrees) return bad(tr('Cópia isolada indisponível.'));
    if (this.runs.some((r) => r.state === 'running')) return bad(tr('Já há uma lista rodando; pare ou espere ela terminar.'), 409);
    const run: ChatRun = {
      id: (this.deps.newId ?? randomUUID)(),
      createdAt: this.now(),
      state: 'running',
      options,
      ...(context ? { context } : {}),
      stopOnFail: b.stopOnFail !== false,
      wantIsolated: b.isolated === true,
      items,
    };
    this.runs = [run, ...this.runs].slice(0, RUNS_KEEP);
    this.kick(run);
    return { run };
  }

  /** Parar: interrompe o agente atual e cancela o resto (definitivo). */
  stop(id: string): 'ok' | 'not-found' | 'idle' {
    const run = this.get(id);
    if (!run) return 'not-found';
    if (run.state === 'done' || run.state === 'stopped') return 'idle';
    run.state = 'stopped';
    for (const i of run.items) {
      if (i.state === 'running') {
        i.state = 'interrupted';
        i.endedAt = this.now();
        if (i.agentId) this.deps.chat.stop(i.agentId);
      } else if (i.state === 'pending') i.state = 'canceled';
    }
    this.save();
    return 'ok';
  }

  /** Continuar a lista pausada (reinício) ou parada por falha: o item interrompido roda de novo num agente novo. */
  continue(id: string): 'ok' | 'not-found' | 'invalid' | 'busy' {
    const run = this.get(id);
    if (!run) return 'not-found';
    if ((run.state !== 'paused' && run.state !== 'failed') || run.isolated?.merged || run.isolated?.discarded) return 'invalid';
    if (this.runs.some((r) => r.state === 'running')) return 'busy';
    for (const i of run.items) {
      if (i.state !== 'interrupted') continue;
      i.state = 'pending';
      delete i.agentId;
      delete i.summary;
      delete i.startedAt;
      delete i.endedAt;
    }
    run.state = 'running';
    delete run.note;
    this.kick(run);
    return 'ok';
  }

  merge(id: string): Promise<{ ok: true } | Fail> {
    return this.closeCopy(id, 'merge');
  }

  discard(id: string): Promise<{ ok: true } | Fail> {
    return this.closeCopy(id, 'discard');
  }

  // --- interno ---

  private async closeCopy(id: string, how: 'merge' | 'discard'): Promise<{ ok: true } | Fail> {
    const run = this.get(id);
    if (!run) return { status: 404, error: tr('lista não encontrada') };
    const w = run.isolated;
    if (!w || !this.deps.worktrees || w.merged || w.discarded) return { status: 409, error: tr('Esta lista não tem cópia isolada aberta.') };
    if (run.state === 'running') return { status: 409, error: tr('Pare a lista ou espere ela terminar antes.') };
    const r = how === 'merge' ? await this.deps.worktrees.merge(run.options.folder, w, tr('Lista de {0} itens', [run.items.length])) : await this.deps.worktrees.discard(run.options.folder, w);
    if (!r.ok) return { status: 409, error: r.reason };
    if (how === 'merge') w.merged = true;
    else {
      w.discarded = true;
      for (const i of run.items) if (i.agentId) this.deps.chat.restoreCwd(i.agentId);
    }
    this.save();
    return { ok: true };
  }

  /** Começa (ou volta a rodar): cria a cópia isolada se ainda não há, depois o próximo item. */
  private kick(run: ChatRun): void {
    this.save();
    if (!run.wantIsolated || run.isolated) return this.advance(run);
    void this.deps.worktrees!.create(run.options.folder, run.id, 'lista').then(
      (w) => {
        if (run.state !== 'running') return;
        if ('error' in w) return this.halt(run, w.error);
        run.isolated = { branch: w.branch, path: w.path, base: w.base };
        this.advance(run);
      },
      (err) => run.state === 'running' && this.halt(run, errMsg(err)),
    );
  }

  private halt(run: ChatRun, note: string): void {
    run.state = 'failed';
    run.note = note;
    this.save();
  }

  private advance(run: ChatRun): void {
    if (run.state !== 'running') return;
    const item = run.items.find((i) => i.state === 'pending');
    if (!item) {
      run.state = 'done';
      return this.save();
    }
    item.state = 'running';
    item.startedAt = this.now();
    this.save();
    void this.startItem(run, item);
  }

  private async startItem(run: ChatRun, item: RunItem): Promise<void> {
    const req = { ...run.options, prompt: itemPrompt(run, item.text) };
    const open: ChatOpener = (raw) => this.deps.chat.open(raw, undefined, { cwd: run.isolated?.path });
    let agentId: string | undefined;
    let error = '';
    try {
      const r = item.vboardsTaskId && this.deps.vboards ? await this.deps.vboards.begin({ id: item.vboardsTaskId, folder: run.options.folder, chat: req }, open) : open(req);
      if ('agentId' in r) agentId = r.agentId;
      else error = 'reason' in r ? r.reason : 'error' in r ? r.error : tr('Não abriu.');
    } catch (err) {
      error = errMsg(err);
    }
    if (agentId) item.agentId = agentId;
    // Parada durante a espera do begin: o agente que acabou de abrir para também.
    if (item.state !== 'running') {
      if (agentId) this.deps.chat.stop(agentId);
      return this.save();
    }
    if (!agentId) return this.finish(run, item, 'failed', error);
    this.save();
    const end = this.deps.chat.turnOutcome(agentId);
    if (end) this.finish(run, item, end);
  }

  private turnEnded(agentId: string): void {
    for (const run of this.runs) {
      if (run.state !== 'running') continue;
      const item = run.items.find((i) => i.state === 'running' && i.agentId === agentId);
      const end = item && this.deps.chat.turnOutcome(agentId);
      if (item && end) return this.finish(run, item, end);
    }
  }

  private finish(run: ChatRun, item: RunItem, end: 'done' | 'failed', reason?: string): void {
    item.state = end;
    item.endedAt = this.now();
    const text = end === 'done' ? (item.agentId && this.deps.chat.lastReply(item.agentId)) || '' : reason || tr('O agente terminou sem responder.');
    if (text) item.summary = truncate(text.replace(/\s+/g, ' ').trim(), SUMMARY_MAX);
    if (end === 'failed' && run.stopOnFail) return this.halt(run, tr('Parou: um item falhou.'));
    this.advance(run);
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true });
      writeFileSync(`${this.deps.file}.tmp`, JSON.stringify(this.runs));
      renameSync(`${this.deps.file}.tmp`, this.deps.file);
    } catch (err) {
      log.warnOnce(`runs:save:${errMsg(err)}`, tr('Listas: não deu para gravar {0} ({1}).', [this.deps.file, errMsg(err)]));
    }
  }
}
