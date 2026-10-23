// Lista que roda sozinha: um agente novo do chat por item, em sequência (contexto limpo a cada item). Só começa com o
// "Rodar lista" da tela de confirmação (POST /api/chat/runs = a aprovação da lista inteira); Parar interrompe o agente
// atual e cancela o resto. Reiniciar o servidor: a lista manual pausa com o item interrompido até o "Continuar"; a
// automática volta sozinha, e o item interrompido segue no mesmo agente e na mesma cópia (load). Itens do VBoards
// abrem pelo VBoardsService.begin, que liga a tarefa ao agente e a conclui com o resumo.
// Lista automática (VBoards com vboards.auto, ChatRun.auto): no fim de cada item o portão (gate.ts) roda as checagens e a
// revisão do diff; na 1ª falha o erro volta uma vez ao mesmo agente, depois o item fica 'review' com o relatório.
// Nunca junta nem dá push: o "Juntar" continua sendo um clique.
// Paralelo: listas de pastas diferentes rodam ao mesmo tempo (até maxParallel, HABBLAUD_MAX_PARALLEL_RUNS); na mesma
// pasta, uma de cada vez. A que não cabe fica 'queued' e começa sozinha quando abre a vaga (a automática nem nasce:
// espera a próxima busca do VBoards).
// Cota (quota.ts): com a conta no limite, a automática nem começa e qualquer lista pausa antes do próximo item, com um
// aviso no celular; a automática volta sozinha depois do reinício da janela, a manual só com "Continuar" (que, como o
// "Rodar lista", passa por cima da cota e deixa um aviso).
// Guardado em <dataDir>/chat/runs.json. Desenho: docs/superpowers/specs/2026-10-16-checklist-design.md.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { truncate } from '../../shared/activity';
import { CHAT_TEXT_MAX } from '../../shared/chat';
import { tr } from '../../shared/i18n';
import { parseDiff } from '../../shared/diff';
import { RUN_CONTEXT_MAX, RUN_FEEDBACK_MAX, RUN_FEEDBACK_TEXT_MAX, RUN_ITEMS_MAX, type ChatRun, type RunAgentOptions, type RunAuto, type RunFeedbackComment, type RunItem, type RunMetric } from '../../shared/runs';
import { errMsg, log } from '../log';
import type { Provider } from '../../shared/types';
import type { ChatOpener } from '../vboards/vboards';
import type { QuotaBlock } from './quota';
import { fixRequest, gatePassed, gateReport, type CheckResult, type ReviewResult } from './gate';
import type { ChatService } from './service';
import type { WorktreeOps } from './types';

export const RUNS_KEEP = 20;
const TICK_MS = 30_000;
const SUMMARY_MAX = 600;
const OPTION_KEYS = ['folder', 'provider', 'account', 'model', 'roleId', 'permission', 'limits', 'denyPush'] as const;

export interface RunDeps {
  /** `record`: o gasto do agente do item, para a linha de métricas. */
  chat: Pick<ChatService, 'check' | 'open' | 'turnOutcome' | 'lastReply' | 'stop' | 'onTurnEnd' | 'restoreCwd' | 'send'> & Partial<Pick<ChatService, 'record'>>;
  /** `reopen`: comentários da revisão voltaram ao agente; a subtarefa dele volta a 'running' no VBoards. */
  vboards?: { begin(raw: unknown, open: ChatOpener): Promise<{ agentId: string } | { spawn: unknown } | { status: number; error: string }>; reopen?(agentId: string): boolean };
  worktrees?: WorktreeOps;
  /** Portão das listas automáticas (gate.ts runChecks/reviewDiff); ausente = o item vai para 'review' sem checar. */
  gate?: { checks(cmd: string, cwd: string): Promise<CheckResult>; review(auto: RunAuto, diff: string): Promise<ReviewResult> };
  file: string;
  /** <dataDir>/chat/run-metrics.jsonl: uma linha por item que terminou (ausente = sem métricas). */
  metricsFile?: string;
  /** Listas rodando ao mesmo tempo, somando todas as pastas (padrão 2, mínimo 1). */
  maxParallel?: number;
  /** Cota da conta acima do limite (quota.ts), pela conta da lista ou a padrão do provedor; undefined = livre ou desconhecida. */
  quota?: (provider: Provider, account?: string) => QuotaBlock | undefined;
  /** Aviso no celular (vboards/ntfy.ts) quando uma lista pausa pela cota: só o nome da pasta. */
  notify?: (title: string, event: 'quota') => void;
  /** A pasta existe (testes); padrão existsSync. */
  exists?: (path: string) => boolean;
  now?: () => number;
  newId?: () => string;
}

type Fail = { status: number; error: string };

/** Métricas: no load, com o arquivo acima de METRICS_TRIM_BYTES, fica só o que tem até METRICS_KEEP_MS. */
export const METRICS_TRIM_BYTES = 2 * 1024 * 1024;
export const METRICS_KEEP_MS = 90 * 24 * 60 * 60_000;

/** Uma linha JSON no fim do arquivo; erro só vira log. */
export function appendMetric(file: string, m: RunMetric): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(m)}\n`);
  } catch (err) {
    log.warnOnce(`runs:metrics:${errMsg(err)}`, tr('Listas: não deu para gravar as métricas ({0}).', [errMsg(err)]));
  }
}

/** As linhas desde `since` (linha estragada fica de fora). */
export function readMetrics(file: string, since = 0): RunMetric[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((l) => {
    try {
      const m = JSON.parse(l) as RunMetric;
      return m && typeof m.at === 'number' && m.at >= since && typeof m.runId === 'string' ? [m] : [];
    } catch {
      return [];
    }
  });
}

/** Corte do arquivo de métricas: só acima de METRICS_TRIM_BYTES, mantendo os últimos METRICS_KEEP_MS. */
export function trimMetrics(file: string, now: number): void {
  try {
    if (statSync(file).size <= METRICS_TRIM_BYTES) return;
    const keep = readMetrics(file, now - METRICS_KEEP_MS);
    writeFileSync(`${file}.tmp`, keep.map((m) => `${JSON.stringify(m)}\n`).join(''));
    renameSync(`${file}.tmp`, file);
  } catch {
    // sem arquivo: nada a cortar
  }
}

const itemPrompt = (run: Pick<ChatRun, 'context'>, text: string) => (run.context ? `${run.context}\n\n${text}` : text);
const DIFF_VIEW_MAX = 500_000;

/** Valida o corpo do POST de comentários: 1 a RUN_FEEDBACK_MAX, texto até RUN_FEEDBACK_TEXT_MAX, linha inteira ≥ 1. */
export function parseComments(raw: unknown): RunFeedbackComment[] | { error: string } {
  const list = (raw as { comments?: unknown } | null)?.comments;
  if (!Array.isArray(list) || !list.length || list.length > RUN_FEEDBACK_MAX) return { error: tr('Mande de 1 a {0} comentários.', [RUN_FEEDBACK_MAX]) };
  const out: RunFeedbackComment[] = [];
  for (const x of list) {
    const c = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const text = typeof c.text === 'string' ? c.text.trim() : '';
    const file = typeof c.file === 'string' ? c.file : '';
    if (!file || file.length > 1000 || /[\r\n\0]/.test(file)) return { error: tr('Comentário sem arquivo válido.') };
    if (!Number.isInteger(c.line) || (c.line as number) < 1 || (c.line as number) > 10_000_000) return { error: tr('Comentário sem linha válida.') };
    if (c.side !== 'old' && c.side !== 'new') return { error: tr('Comentário sem lado válido (old ou new).') };
    if (!text || text.length > RUN_FEEDBACK_TEXT_MAX) return { error: tr('Cada comentário precisa ter de 1 a {0} caracteres.', [RUN_FEEDBACK_TEXT_MAX]) };
    out.push({ file, line: c.line as number, side: c.side, text });
  }
  return out;
}

/** A mensagem única ao agente: `arquivo:linha — comentário`, um por linha. */
export function feedbackMessage(comments: readonly RunFeedbackComment[]): string {
  const lines = comments.map((c) => `- ${c.file}:${c.line}${c.side === 'old' ? ` ${tr('(linha antiga, removida)')}` : ''} — ${c.text.replace(/\s*\r?\n\s*/g, ' ')}`);
  return [tr('Revisão do seu diff feita por uma pessoa. Resolva cada comentário abaixo (sem git push) e termine com um resumo do que mudou.'), '', ...lines].join('\n');
}

const normPath = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
const samePath = (a: string, b: string): boolean => normPath(a) === normPath(b);

export class RunService {
  private runs: ChatRun[] = [];
  /** Servidor desligando: nada avança (o fim das rodadas mortas não pode abrir o próximo item). */
  private frozen = false;
  private readonly now: () => number;
  private readonly max: number;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: RunDeps) {
    this.now = deps.now ?? Date.now;
    this.max = Math.max(1, Math.floor(deps.maxParallel ?? 2) || 1);
    deps.chat.onTurnEnd((agentId) => this.turnEnded(agentId));
  }

  /**
   * Lê runs.json. O que rodava quando o servidor caiu: a lista automática volta sozinha (fila; o start a retoma e o
   * item interrompido continua no mesmo agente e na mesma cópia); a manual pausa com o item interrompido até o
   * "Continuar" (coisa manual precisa de clique). Cópia isolada que sumiu = a lista falha.
   */
  load(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.deps.file, 'utf8'));
    } catch {
      return;
    }
    if (!Array.isArray(raw)) return;
    if (this.deps.metricsFile) trimMetrics(this.deps.metricsFile, this.now());
    this.runs = raw.filter(
      (r): r is ChatRun => !!r && typeof r === 'object' && typeof r.id === 'string' && Array.isArray(r.items) && !!r.options && typeof r.options.folder === 'string' && r.items.every((i: unknown) => !!i && typeof (i as RunItem).text === 'string'),
    );
    let changed = false;
    for (const run of this.runs) {
      if (run.state !== 'running') continue;
      changed = true;
      if (this.copyGone(run)) {
        for (const i of run.items) if (i.state === 'running') i.state = 'interrupted';
        run.state = 'failed';
        run.note = this.goneNote(run);
        continue;
      }
      if (run.auto) {
        for (const i of run.items) {
          if (i.state !== 'running') continue;
          i.state = 'pending';
          if (i.agentId) i.resume = true;
        }
        run.state = 'queued';
        run.note = tr('O servidor reiniciou: a lista volta sozinha.');
        continue;
      }
      run.state = 'paused';
      for (const i of run.items) if (i.state === 'running') i.state = 'interrupted';
    }
    if (changed) this.save();
  }

  /**
   * Depois do load: a cada TICK_MS as listas da fila que cabem começam (as automáticas retomadas pelo reinício também;
   * o primeiro tick vem depois da primeira busca do VBoards, que os itens dele precisam).
   */
  start(): void {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  /** A fila anda; a automática pausada pela cota volta sozinha depois do reinício da janela (e com a cota livre). */
  tick(): void {
    if (this.frozen) return;
    for (const run of this.runs) {
      if (run.state !== 'paused' || !run.quota || !run.auto) continue;
      if (run.quota.resetsAt && this.now() < run.quota.resetsAt) continue;
      if (this.quotaOf(run.options) || !this.slotFor(run.options.folder)) continue;
      this.continue(run.id);
    }
    this.pump();
  }

  /** Antes do ChatService.stopAll: o que rodava fica como estava e vira interrompido no próximo load. */
  freeze(): void {
    this.frozen = true;
    clearInterval(this.timer);
  }

  list(): ChatRun[] {
    return this.runs;
  }

  get(id: string): ChatRun | undefined {
    return this.runs.find((r) => r.id === id);
  }

  /**
   * Alguma lista guardada já tem esta tarefa do VBoards (rodando, pausada, parada ou falha): a abertura automática não
   * cria outra, nem depois de a pessoa parar a lista.
   */
  hasTask(id: string): boolean {
    return this.runs.some((r) => r.items.some((i) => i.vboardsTaskId === id));
  }

  /**
   * "Rodar lista": valida tudo antes de abrir qualquer agente; o pedido já é a aprovação da lista inteira. `auto` só
   * vem do servidor (VBoards com vboards.auto), nunca do corpo do pedido: ele traz um comando de shell.
   */
  create(raw: unknown, auto?: RunAuto): { run: ChatRun } | Fail {
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
    const ready = this.canStart(options.folder);
    // A automática não entra na fila: a próxima busca do VBoards tenta de novo.
    if (!ready && auto) return bad(tr('Já há uma lista rodando nesta pasta ou o limite de listas ao mesmo tempo foi atingido.'), 409);
    // Uma pausada pela cota nesta pasta já basta (e já avisou): as tarefas novas esperam ela voltar.
    if (auto && this.runs.some((r) => r.auto && r.quota && r.state === 'paused' && samePath(r.options.folder, options.folder))) {
      return bad(tr('Há uma lista desta pasta pausada pela cota da conta.'), 409);
    }
    const block = this.quotaOf(options);
    const run: ChatRun = {
      id: (this.deps.newId ?? randomUUID)(),
      createdAt: this.now(),
      state: ready ? 'running' : 'queued',
      options,
      ...(context ? { context } : {}),
      stopOnFail: b.stopOnFail !== false,
      wantIsolated: b.isolated === true,
      items,
      ...(auto ? { auto } : {}),
    };
    this.runs = [run, ...this.runs].filter((r, i) => i < RUNS_KEEP || r.state === 'running' || r.state === 'queued');
    // Cota no limite: a automática nem começa; o "Rodar lista" (a pessoa) passa por cima, com aviso.
    if (block && auto) this.pauseForQuota(run, block);
    else {
      if (block) this.override(run, block);
      if (ready) this.kick(run);
      else this.save();
    }
    return { run };
  }

  /** Cabe começar agora nesta pasta: vaga livre, nenhuma lista dela rodando nem esperando na fila. */
  canStart(folder: string): boolean {
    return this.slotFor(folder) && !this.runs.some((r) => r.state === 'queued' && samePath(r.options.folder, folder));
  }

  /** Parar: interrompe o agente atual e cancela o resto (definitivo). */
  stop(id: string): 'ok' | 'not-found' | 'idle' {
    const run = this.get(id);
    if (!run) return 'not-found';
    if (run.state === 'done' || run.state === 'stopped') return 'idle';
    const wasRunning = run.state === 'running';
    run.state = 'stopped';
    delete run.resumeTo;
    for (const i of run.items) {
      if (i.state === 'running') {
        i.state = 'interrupted';
        i.endedAt = this.now();
        this.metric(run, i);
        if (i.agentId) this.deps.chat.stop(i.agentId);
      } else if (i.state === 'pending') i.state = 'canceled';
    }
    this.save();
    if (wasRunning) this.pump();
    return 'ok';
  }

  /**
   * Continuar a lista pausada (reinício, cota) ou parada por falha: o item interrompido roda de novo num agente novo.
   * Com a cota no limite, roda mesmo assim (clique da pessoa) e deixa o aviso na lista.
   */
  continue(id: string): 'ok' | 'not-found' | 'invalid' | 'busy' {
    const run = this.get(id);
    if (!run) return 'not-found';
    if ((run.state !== 'paused' && run.state !== 'failed') || run.isolated?.merged || run.isolated?.discarded) return 'invalid';
    if (!this.slotFor(run.options.folder)) return 'busy';
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
    delete run.quota;
    delete run.resumeTo;
    const block = this.quotaOf(run.options);
    if (block) this.override(run, block);
    this.kick(run);
    return 'ok';
  }

  /** Diff da cópia isolada aberta (a vista de comentários por linha); cortado em DIFF_VIEW_MAX. */
  async diff(id: string): Promise<{ diff: string; cut?: true } | Fail> {
    const run = this.get(id);
    if (!run) return { status: 404, error: tr('lista não encontrada') };
    const w = run.isolated;
    if (!w || !this.deps.worktrees || w.merged || w.discarded) return { status: 409, error: tr('Esta lista não tem cópia isolada aberta.') };
    const diff = await this.deps.worktrees.diff(w);
    return diff.length > DIFF_VIEW_MAX ? { diff: diff.slice(0, DIFF_VIEW_MAX), cut: true } : { diff };
  }

  /**
   * "Enviar comentários ao agente": UMA mensagem ao mesmo agente do item (que já terminou), com `arquivo:linha —
   * comentário`; o item volta a rodar e, na lista automática, passa de novo pelo portão com a volta de correção
   * disponível outra vez (é uma rodada nova pedida pela pessoa). A subtarefa do VBoards volta a 'running' até o portão.
   */
  async feedback(id: string, index: number, raw: unknown): Promise<{ ok: true } | Fail> {
    const run = this.get(id);
    if (!run) return { status: 404, error: tr('lista não encontrada') };
    const item = run.items[index];
    if (!item) return { status: 404, error: tr('item não encontrado') };
    const parsed = parseComments(raw);
    if ('error' in parsed) return { status: 400, error: parsed.error };
    const busy = (): Fail | undefined => {
      const w = run.isolated;
      if (!w || !this.deps.worktrees || w.merged || w.discarded) return { status: 409, error: tr('Esta lista não tem cópia isolada aberta.') };
      if (!item.agentId || (item.state !== 'review' && item.state !== 'done')) return { status: 409, error: tr('Só dá para comentar um item que terminou (feito ou esperando revisão).') };
      if (run.items.some((i) => i.state === 'running')) return { status: 409, error: tr('Espere o item que está rodando nesta lista terminar.') };
      return undefined;
    };
    const before = busy();
    if (before) return before;
    const diff = await this.deps.worktrees!.diff(run.isolated!);
    const files = new Set(parseDiff(diff).flatMap((f) => [f.path, f.oldPath ?? f.path]));
    const outside = parsed.find((c) => !files.has(c.file));
    if (outside) return { status: 400, error: tr('O arquivo {0} não está no diff.', [outside.file]) };
    const text = feedbackMessage(parsed);
    if (text.length > CHAT_TEXT_MAX) return { status: 400, error: tr('Os comentários juntos passam de {0} caracteres; mande menos de cada vez.', [CHAT_TEXT_MAX]) };
    // Mudou durante o diff (outro clique, Parar, Juntar).
    const after = busy();
    if (after) return after;
    const agentId = item.agentId!;
    const sent = this.deps.chat.send(agentId, { text });
    if (sent !== 'ok') return { status: sent === 'not-found' ? 404 : 409, error: tr('O agente não recebeu os comentários ({0}).', [sent]) };
    item.state = 'running';
    item.startedAt = this.now();
    delete item.endedAt;
    delete item.retried;
    if (run.state !== 'running') {
      run.resumeTo = run.state;
      run.state = 'running';
    }
    this.deps.vboards?.reopen?.(agentId);
    this.save();
    return { ok: true };
  }

  merge(id: string): Promise<{ ok: true } | Fail> {
    return this.closeCopy(id, 'merge');
  }

  discard(id: string): Promise<{ ok: true } | Fail> {
    return this.closeCopy(id, 'discard');
  }

  // --- interno ---

  private quotaOf(o: RunAgentOptions): QuotaBlock | undefined {
    return this.deps.quota?.(o.provider, o.account);
  }

  private quotaText(q: QuotaBlock): [string, number] {
    return [q.window === '5h' ? tr('5 h') : tr('semana'), q.pct];
  }

  /** Para antes do próximo item: a lista fica 'paused' com a cota; UM aviso no celular (só o nome da pasta). */
  private pauseForQuota(run: ChatRun, q: QuotaBlock): void {
    run.state = 'paused';
    run.quota = { window: q.window, pct: q.pct, ...(q.resetsAt ? { resetsAt: q.resetsAt } : {}) };
    run.note = tr('Pausada: a cota de {0} da conta está em {1}%.', this.quotaText(q));
    this.save();
    this.deps.notify?.(basename(run.options.folder) || run.options.folder, 'quota');
    this.pump();
  }

  /** A pessoa mandou rodar com a cota no limite: não pausa mais por ela, e o aviso fica na lista. */
  private override(run: ChatRun, q: QuotaBlock): void {
    run.quotaOverride = true;
    run.note = tr('Aviso: a cota de {0} da conta está em {1}%; rodando mesmo assim porque você pediu.', this.quotaText(q));
  }

  /** Vaga livre e nenhuma lista desta pasta rodando. */
  private slotFor(folder: string): boolean {
    const running = this.runs.filter((r) => r.state === 'running');
    return running.length < this.max && !running.some((r) => samePath(r.options.folder, folder));
  }

  /** Abriu vaga: as da fila que cabem começam, a mais antiga primeiro. */
  private pump(): void {
    if (this.frozen) return;
    const queued = [...this.runs].reverse().filter((r) => r.state === 'queued').sort((a, b) => a.createdAt - b.createdAt);
    for (const run of queued) {
      if (!this.slotFor(run.options.folder)) continue;
      run.state = 'running';
      delete run.note;
      this.kick(run);
    }
  }

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
    if (this.copyGone(run)) return this.halt(run, this.goneNote(run));
    if (!run.wantIsolated || run.isolated) return this.advance(run);
    void this.deps.worktrees!.create(run.options.folder, run.id, 'lista').then(
      (w) => {
        if (run.state !== 'running') return;
        if ('error' in w) return this.halt(run, w.error);
        run.isolated = { branch: w.branch, path: w.path, base: w.base, ...(w.copied ? { copied: w.copied } : {}), ...(w.missing ? { missing: w.missing } : {}) };
        this.advance(run);
      },
      (err) => run.state === 'running' && this.halt(run, errMsg(err)),
    );
  }

  private halt(run: ChatRun, note: string): void {
    run.state = 'failed';
    run.note = note;
    this.save();
    this.pump();
  }

  private advance(run: ChatRun): void {
    if (run.state !== 'running' || this.frozen) return;
    // Fim de uma rodada de comentários numa lista que já tinha parado: ela volta a como estava.
    if (run.resumeTo && !run.items.some((i) => i.resume)) {
      run.state = run.resumeTo;
      delete run.resumeTo;
      this.save();
      return this.pump();
    }
    const item = run.items.find((i) => i.state === 'pending');
    if (!item) {
      run.state = 'done';
      this.save();
      return this.pump();
    }
    const block = run.quotaOverride ? undefined : this.quotaOf(run.options);
    if (block) return this.pauseForQuota(run, block);
    item.state = 'running';
    item.startedAt = this.now();
    this.save();
    void this.startItem(run, item);
  }

  /** A cópia isolada aberta da lista sumiu do disco (apagada à mão, outra máquina...). */
  private copyGone(run: ChatRun): boolean {
    const w = run.isolated;
    return !!w && !w.merged && !w.discarded && !(this.deps.exists ?? existsSync)(w.path);
  }

  private goneNote(run: ChatRun): string {
    return tr('A cópia isolada desta lista sumiu ({0}): ela não pode continuar. Descarte e rode de novo.', [run.isolated?.path ?? '']);
  }

  /** Item interrompido pelo reinício (lista automática): uma rodada nova no mesmo agente, que confere a cópia antes. */
  private resumeItem(run: ChatRun, item: RunItem, agentId: string): void {
    delete item.resume;
    const text = `${tr('O Habblaud reiniciou no meio da sua rodada e ela foi interrompida. Antes de continuar, confira o estado atual da cópia (git status e git diff): parte do trabalho pode já estar feita. Depois termine o pedido abaixo (sem git push) e finalize com um resumo do que mudou.')}\n\n${itemPrompt(run, item.text)}`;
    const r = this.deps.chat.send(agentId, { text: text.slice(0, CHAT_TEXT_MAX) });
    if (r !== 'ok') return this.finish(run, item, 'failed', tr('Não deu para retomar o agente depois do reinício ({0}).', [r]));
    this.save();
  }

  private async startItem(run: ChatRun, item: RunItem): Promise<void> {
    if (item.resume && item.agentId) return this.resumeItem(run, item, item.agentId);
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

  /**
   * Para o VBoards: item de lista automática ainda rodando ou no portão = 'pending' (não conclui); passou pelo portão =
   * 'review'; fora disso, undefined (vale o resultado da rodada).
   */
  gateState(agentId: string): 'pending' | 'review' | undefined {
    for (const run of this.runs) {
      if (!run.auto) continue;
      const item = run.items.find((i) => i.agentId === agentId);
      if (item?.state === 'running') return 'pending';
      if (item?.state === 'review') return 'review';
    }
    return undefined;
  }

  /** Relatório do portão do item deste agente (o resumo que vai para o VBoards). */
  reportOf(agentId: string): string | undefined {
    for (const run of this.runs) for (const i of run.items) if (i.agentId === agentId && i.report) return i.report;
    return undefined;
  }

  private turnEnded(agentId: string): void {
    if (this.frozen) return;
    for (const run of this.runs) {
      if (run.state !== 'running') continue;
      const item = run.items.find((i) => i.state === 'running' && i.agentId === agentId);
      const end = item && this.deps.chat.turnOutcome(agentId);
      if (item && end) return this.finish(run, item, end);
    }
  }

  private finish(run: ChatRun, item: RunItem, end: 'done' | 'failed', reason?: string): void {
    // Lista automática: respondeu (ou já é a volta da correção) = passa pelo portão antes de seguir.
    if (run.auto && run.isolated && item.agentId && (end === 'done' || item.retried)) return void this.gate(run, item, run.auto, run.isolated, item.agentId);
    item.state = end;
    item.endedAt = this.now();
    this.metric(run, item);
    const text = end === 'done' ? (item.agentId && this.deps.chat.lastReply(item.agentId)) || '' : reason || tr('O agente terminou sem responder.');
    if (text) item.summary = truncate(text.replace(/\s+/g, ' ').trim(), SUMMARY_MAX);
    if (end === 'failed' && run.stopOnFail) return this.halt(run, tr('Parou: um item falhou.'));
    this.advance(run);
  }

  private async gate(run: ChatRun, item: RunItem, auto: RunAuto, w: NonNullable<ChatRun['isolated']>, agentId: string): Promise<void> {
    let checks: CheckResult | undefined;
    let review: ReviewResult | undefined;
    try {
      if (auto.check && this.deps.gate) checks = await this.deps.gate.checks(auto.check, w.path);
      const diff = (await this.deps.worktrees?.diff(w)) ?? '';
      if (diff.trim() && this.deps.gate) review = await this.deps.gate.review(auto, diff);
    } catch (err) {
      checks = { ok: false, tail: errMsg(err) };
    }
    // Parada ou servidor desligando durante o portão: o item já mudou de estado.
    if (item.state !== 'running' || run.state !== 'running' || this.frozen) return;
    const passed = gatePassed(checks, review);
    item.gate = passed ? 'pass' : 'fail';
    if (!passed && !item.retried) {
      item.retried = true;
      this.save();
      // Uma volta só: o próximo fim de rodada (turnEnded → finish) passa de novo pelo portão e termina em 'review'.
      if (this.deps.chat.send(agentId, { text: fixRequest(checks, review) }) === 'ok') return;
    }
    item.report = gateReport({ branch: w.branch, checks, review, summary: this.deps.chat.lastReply(agentId), retried: item.retried, missing: w.missing });
    item.state = 'review';
    item.endedAt = this.now();
    this.metric(run, item);
    item.summary = truncate(item.report.replace(/\s+/g, ' ').trim(), SUMMARY_MAX);
    this.advance(run);
  }

  /** A linha de métricas de um item que terminou: gasto e tokens do agente dele (o Jarvis e o briefing leem). */
  private metric(run: ChatRun, item: RunItem): void {
    if (!this.deps.metricsFile) return;
    const spend = item.agentId ? this.deps.chat.record?.(item.agentId)?.spend : undefined;
    appendMetric(this.deps.metricsFile, {
      at: item.endedAt ?? this.now(),
      runId: run.id,
      folder: run.options.folder,
      state: item.state,
      gate: run.auto ? (item.gate ?? 'none') : 'none',
      retried: !!item.retried,
      ms: item.startedAt ? Math.max(0, (item.endedAt ?? this.now()) - item.startedAt) : 0,
      usd: spend?.usd ?? 0,
      tokens: spend?.tokens ?? 0,
      provider: run.options.provider,
      ...(run.options.model ? { model: run.options.model } : {}),
    });
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
