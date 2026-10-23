// As ferramentas do Jarvis no MCP do escritório (só no agente do sistema: server/chat/http.ts extraTools). Duas classes:
// - SAFE: rodam na hora, dentro de limites que o servidor impõe sempre (cópia isolada, sem push, orçamento da pasta,
//   por hora), seja qual for o pedido;
// - GATED: o run() chama askHuman ANTES do efeito, com um cartão montado com dados reais (pasta, branch, diffstat,
//   origem do turno); o motivo do Jarvis entra só como "Motivo (do Jarvis, não verificado)". Cartão sem "sempre
//   permitir"; recusa, prazo ou rodada parada = nada roda. Só a página com login e "permissions" responde cartões.
// Não existe ferramenta de push, de shell nem de apagar no VBoards. Texto de fora (VBoards, saídas de agentes) volta
// embrulhado em <dados_nao_confiaveis>. Exceções aprovadas pelo dono às regras "nunca sozinho": agents_spawn e
// agents_send SAFE com limites, agendamento `trusted` criado via cartão uma vez, aviso com texto livre mascarado.
// Turno contaminado (pedido que não veio do dono pela página, ou ferramenta que devolveu dado embrulhado nesta rodada):
// agents_spawn, runs_create, agents_send, vboards_subtasks_add com queue e memory_write viram GATED. Todo cartão daqui é
// crítico (pede o PIN de aprovação) e mostra os fatos primeiro e o texto livre inteiro depois; texto que não cabe no
// cartão (CARD_TEXT_MAX) recusa a ação em vez de cortar. Escritas no VBoards ficam SAFE, mas sempre mascaradas.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { maskSecrets } from '../../shared/activity';
import { CHAT_TEXT_MAX } from '../../shared/chat';
import { tr } from '../../shared/i18n';
import type { ChatRun, RunMetric } from '../../shared/runs';
import type { TriggerRule } from '../../shared/triggers';
import type { Provider } from '../../shared/types';
import { askHuman, type HumanAnswer, type McpTool } from '../chat/permission';
import type { RunService } from '../chat/runs';
import type { ChatService } from '../chat/service';
import type { TriggerService } from '../chat/triggers';
import type { WorktreeOps } from '../chat/types';
import type { PermissionRegistry } from '../permissions/registry';
import { CARD_STATUSES, SCHEDULE_SCOPES, TASK_STATUSES, VBoardsApiError, type VBoardsApi } from '../vboards/api';
import type { NotifyChannel } from '../vboards/ntfy';
import { AUTO_TURN_MINUTES, folderConfigView, validateFolderConfig, type FolderConfig, type FolderKey } from '../vboards/vboards';
import { UNTRUSTED_TAG, wrapUntrusted } from './prompt';
import { originLabel, type JarvisTurn } from './service';

/** agents_spawn SAFE por hora; acima, vira cartão. */
export const SPAWN_PER_HOUR = 3;
/** runs_create SAFE (pasta com vboards.auto) por hora; acima, vira cartão. */
export const RUNS_PER_HOUR = 5;
/** O maior texto que um cartão mostra inteiro; acima disso a ação é recusada (nunca cortada). */
export const CARD_TEXT_MAX = 20_000;
/** notify_send por hora (depois, recusa). */
export const NOTIFY_PER_HOUR = 20;
export const NOTIFY_NTFY_MAX = 200;
export const NOTIFY_WA_MAX = 3000;
const HOUR = 60 * 60_000;
/** Ferramentas de leitura que devolvem texto de fora (embrulhado): contaminam o turno desde o início da chamada. */
const UNTRUSTED_READS: ReadonlySet<string> = new Set(['memory_read', 'agents_list', 'agents_read', 'runs_get', 'vboards_me', 'vboards_projects', 'vboards_tasks_list', 'vboards_schedule_list', 'vboards_summary']);
const READ_ITEMS = 30;
const READ_TEXT = 600;
const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'antigravity'];

type Result = { text: string; isError?: boolean };
const ok = (v: unknown): Result => ({ text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) });
const fail = (text: string): Result => ({ text, isError: true });
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
/** Corta sem juntar as linhas. */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const normPath = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();

/** Janela deslizante: no máximo `max` em `ms`. `saved` = grava depois de cada uso (sobrevive a reinícios). */
export class RateWindow {
  constructor(
    private readonly max: number,
    private readonly ms: number,
    public times: number[] = [],
    private readonly saved?: () => void,
  ) {}
  left(now: number): number {
    this.times = this.times.filter((t) => now - t < this.ms && t <= now);
    return this.max - this.times.length;
  }
  take(now: number): boolean {
    if (this.left(now) <= 0) return false;
    this.times.push(now);
    this.saved?.();
    return true;
  }
}

type Limits = Record<'spawn' | 'notify' | 'runs', number[]>;

function readLimits(file: string | undefined): Partial<Limits> {
  if (!file) return {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const nums = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).slice(-100) : []);
    return { spawn: nums(raw.spawn), notify: nums(raw.notify), runs: nums(raw.runs) };
  } catch {
    return {};
  }
}

export interface JarvisToolsDeps {
  jarvisId: () => string | undefined;
  /** O turno atual (origem e seq do pedido): vai no cartão e decide a contaminação. */
  turn: () => JarvisTurn;
  /** Onde os limites por hora (spawn, aviso, listas) ficam entre reinícios. */
  limitsFile?: string;
  chat: Pick<ChatService, 'record' | 'agentsList' | 'view' | 'open' | 'deliver' | 'stop' | 'close' | 'displayName' | 'addApproval' | 'resolveApproval' | 'check'>;
  registry: Pick<PermissionRegistry, 'registerChat' | 'wait'>;
  runs?: Pick<RunService, 'list' | 'get' | 'create' | 'stop' | 'continue' | 'merge' | 'discard'>;
  worktrees?: Pick<WorktreeOps, 'summary'>;
  folders: () => Array<{ path: string; name?: string }>;
  folderConfig: (folder: string) => Promise<FolderConfig>;
  writeFolderConfig: (folder: string, values: Partial<Record<FolderKey, string>>) => Promise<string | undefined>;
  accounts?: () => unknown[];
  metrics?: (since: number) => RunMetric[];
  notify?: (text: string, channel: NotifyChannel) => Promise<{ ntfy?: boolean; whatsapp?: boolean; error?: string }>;
  triggers?: Pick<TriggerService, 'list' | 'create' | 'update' | 'remove' | 'test'>;
  vboards?: VBoardsApi;
  memory: { read(): string; write(mode: 'append' | 'replace', text: string): string | undefined };
  now?: () => number;
  /** Prazo dos cartões (testes). */
  cardTimeoutMs?: number;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const S = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
const REASON = { reason: S('Why you want this (shown to the owner as unverified)') };

export class JarvisTools {
  private readonly spawns: RateWindow;
  private readonly notices: RateWindow;
  private readonly runsWindow: RateWindow;
  private readonly now: () => number;
  /** seq do pedido do turno em que uma ferramenta devolveu dado embrulhado. */
  private taintSeq = -1;

  constructor(private readonly deps: JarvisToolsDeps) {
    this.now = deps.now ?? Date.now;
    const st = readLimits(deps.limitsFile);
    const save = () => this.saveLimits();
    this.spawns = new RateWindow(SPAWN_PER_HOUR, HOUR, st.spawn, save);
    this.notices = new RateWindow(NOTIFY_PER_HOUR, HOUR, st.notify, save);
    this.runsWindow = new RateWindow(RUNS_PER_HOUR, HOUR, st.runs, save);
  }

  private saveLimits(): void {
    const file = this.deps.limitsFile;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify({ spawn: this.spawns.times, notify: this.notices.times, runs: this.runsWindow.times } satisfies Limits));
      renameSync(`${file}.tmp`, file);
    } catch {
      // só os limites por hora: seguem na memória
    }
  }

  /** O turno atual está contaminado? (pedido de fora, ou ferramenta que devolveu dado embrulhado nesta rodada) */
  tainted(): boolean {
    const t = this.deps.turn();
    return t.origin !== 'ui' || this.taintSeq === t.seq;
  }

  tools(): McpTool[] {
    const t = (name: string, description: string, inputSchema: Record<string, unknown>, run: (a: Record<string, unknown>) => Promise<Result>): McpTool => ({
      name,
      description,
      inputSchema,
      run: async (a) => {
        // Leitura que devolve dado de fora: o turno fica contaminado já no começo da chamada, para que outra chamada em
        // paralelo (um spawn, uma lista) que só olha a mancha veja o mesmo turno contaminado.
        if (UNTRUSTED_READS.has(name)) this.taintSeq = this.deps.turn().seq;
        const r = await run(a).catch((err) => fail(err instanceof VBoardsApiError ? err.message : maskSecrets(err instanceof Error ? err.message : String(err))));
        // Dado de fora entrou no contexto do Jarvis: o resto desta rodada fica contaminado.
        if (r.text.includes(`<${UNTRUSTED_TAG}`)) this.taintSeq = this.deps.turn().seq;
        return r;
      },
    });
    const list: McpTool[] = [
      // --- memória
      t('memory_read', 'SAFE. Reads your notes (MEMORY.md), wrapped as untrusted data.', obj({}), async () => ok(wrapUntrusted('memoria', 'MEMORY.md', this.deps.memory.read() || '(vazia)'))),
      t('memory_write', 'Writes your notes: mode append or replace. Max 16 KB, secrets masked. SAFE in a clean turn; GATED when the turn carries outside data.', obj({ mode: { type: 'string', enum: ['append', 'replace'] }, text: S(), ...REASON }, ['mode', 'text']), async (a) => {
        const mode = a.mode === 'replace' ? 'replace' : a.mode === 'append' ? 'append' : undefined;
        if (!mode || typeof a.text !== 'string') return fail(tr('Use mode append ou replace e um texto.'));
        if (this.tainted()) {
          const refused = await this.gate('memory_write', { mode }, [mode === 'replace' ? tr('TROCAR toda a memória do Jarvis (MEMORY.md) por:') : tr('Acrescentar à memória do Jarvis (MEMORY.md):')], a.reason, maskSecrets(a.text));
          if (refused) return fail(refused);
        }
        const err = this.deps.memory.write(mode, a.text);
        return err ? fail(err) : ok(tr('Memória gravada.'));
      }),
      // --- agentes
      t('agents_list', 'SAFE. Lists the chat agents (id, name, role, provider, folder, status, last reply).', obj({}), async () => ok(this.agentsList())),
      t('agents_read', 'SAFE. Reads the latest items of an agent conversation (after = last seq you saw).', obj({ agentId: S(), after: { type: 'number' } }, ['agentId']), async (a) => this.agentsRead(a)),
      t('agents_stop', 'SAFE. Stops the current turn of an agent.', obj({ agentId: S() }, ['agentId']), async (a) => {
        const id = str(a.agentId);
        if (id === this.deps.jarvisId()) return fail(tr('Você não pode parar a si mesmo.'));
        const r = this.deps.chat.stop(id);
        return r === 'not-found' ? fail(tr('Agente não encontrado.')) : ok(r === 'idle' ? tr('O agente já estava parado.') : tr('Rodada interrompida.'));
      }),
      t(
        'agents_spawn',
        `Opens a chat agent with a first request. SAFE only with isolated:true in a clean turn (own git worktree, no push, budget = the folder vboards.budget, max ${SPAWN_PER_HOUR}/hour); otherwise GATED (owner card). Outside the isolated copy only provider claude (it asks approval per action).`,
        obj({ folder: S('Known folder (path or name)'), prompt: S(), roleId: S(), provider: { type: 'string', enum: [...PROVIDERS] }, isolated: { type: 'boolean' }, ...REASON }, ['folder', 'prompt']),
        async (a) => this.agentsSpawn(a),
      ),
      t('agents_send', 'Sends a message to an agent (it runs when free; read the answer with agents_read). SAFE only for isolated agents you opened, in a clean turn; otherwise GATED.', obj({ agentId: S(), text: S(), ...REASON }, ['agentId', 'text']), async (a) => this.agentsSend(a)),
      t('agents_close', 'GATED. Closes an agent (removes it from the office).', obj({ agentId: S(), ...REASON }, ['agentId']), async (a) => this.agentsClose(a)),
      // --- listas
      t('runs_list', 'SAFE. Lists the runs (lists of items, one agent per item).', obj({}), async () => ok((this.deps.runs?.list() ?? []).map((r) => this.runSummary(r)))),
      t('runs_get', 'SAFE. A run with its items.', obj({ id: S() }, ['id']), async (a) => this.runsGet(a)),
      t('runs_diff', 'SAFE. Diff stat of the run isolated copy.', obj({ id: S() }, ['id']), async (a) => this.runsDiff(a)),
      t('runs_stop', 'SAFE. Stops a run.', obj({ id: S() }, ['id']), async (a) => {
        const r = this.need('runs')?.stop(str(a.id));
        return r === 'not-found' || !r ? fail(tr('lista não encontrada')) : ok(tr('Lista parada.'));
      }),
      t('runs_continue', 'SAFE. Continues a paused or failed run.', obj({ id: S() }, ['id']), async (a) => {
        const r = this.need('runs')?.continue(str(a.id));
        return r === 'ok' ? ok(tr('Lista retomada.')) : fail(tr('Esta lista não pode continuar ({0}).', [r ?? 'off']));
      }),
      t(
        'runs_create',
        `Creates a run (isolated worktree, no push, folder budget). SAFE when the folder has vboards.auto=true (auto run with the quality gate), in a clean turn, max ${RUNS_PER_HOUR}/hour; otherwise GATED.`,
        obj({ folder: S(), items: { type: 'array', items: { type: 'string' } }, context: S(), ...REASON }, ['folder', 'items']),
        async (a) => this.runsCreate(a),
      ),
      t('runs_merge', 'GATED. Merges the run isolated copy into the project.', obj({ id: S(), ...REASON }, ['id']), async (a) => this.runsClose(a, 'merge')),
      t('runs_discard', 'GATED. Discards the run isolated copy and branch.', obj({ id: S(), ...REASON }, ['id']), async (a) => this.runsClose(a, 'discard')),
      // --- projetos
      t('projects_list', 'SAFE. Known project folders and their VBoards settings.', obj({}), async () => ok(await this.projectsList())),
      t('projects_config_get', 'SAFE. Settings of a folder (git config vboards.*; the check command masked).', obj({ folder: S() }, ['folder']), async (a) => this.projectsConfigGet(a)),
      t('projects_config_set', 'GATED. Changes settings of a folder (keys: card, auto, provider, budget, check, reviewer, reviewerModel, copy).', obj({ folder: S(), values: { type: 'object' }, ...REASON }, ['folder', 'values']), async (a) => this.projectsConfigSet(a)),
      // --- uso
      t('usage_accounts', 'SAFE. Accounts and their 5h/week quota.', obj({}), async () => ok(this.deps.accounts?.() ?? [])),
      t('usage_spend', 'SAFE. Spend (US$, tokens) of each chat agent.', obj({}), async () => ok(this.spend())),
      t('usage_metrics', 'SAFE. Finished run items since `since` (ms epoch; default 24h): count, gate pass %, retries, cost, per folder.', obj({ since: { type: 'number' }, folder: S() }), async (a) => ok(this.metrics(a))),
      // --- aviso
      t(
        'notify_send',
        `SAFE. Sends a short notice to the OWNER (fixed destination): ntfy (masked, max ${NOTIFY_NTFY_MAX} chars), whatsapp (max ${NOTIFY_WA_MAX}) or both. Max ${NOTIFY_PER_HOUR}/hour.`,
        obj({ text: S(), channel: { type: 'string', enum: ['ntfy', 'whatsapp', 'both'] } }, ['text']),
        async (a) => this.notifySend(a),
      ),
      // --- agendamentos
      t('schedule_list', 'SAFE. Your schedules (messages sent to you on a clock).', obj({}), async () => ok(this.schedules())),
      t(
        'schedule_create',
        'GATED (once). Creates a schedule that sends `message` to you: mode scheduled (time HH:MM + days 0-6), continuous (every `minutes` >= 15) or on-demand (only schedule_run). Its firings then skip the card.',
        obj({ name: S(), mode: { type: 'string', enum: ['scheduled', 'continuous', 'on-demand'] }, time: S(), days: { type: 'array', items: { type: 'number' } }, minutes: { type: 'number' }, message: S(), ...REASON }, ['name', 'mode', 'message']),
        async (a) => this.scheduleCreate(a),
      ),
      t('schedule_run', 'SAFE. Runs one of your schedules now.', obj({ id: S() }, ['id']), async (a) => this.scheduleRun(a)),
      t(
        'schedule_update',
        'Changes one of your schedules. SAFE only to turn it off (enabled:false); any other change is GATED.',
        obj({ id: S(), enabled: { type: 'boolean' }, name: S(), mode: { type: 'string', enum: ['scheduled', 'continuous', 'on-demand'] }, time: S(), days: { type: 'array', items: { type: 'number' } }, minutes: { type: 'number' }, message: S(), ...REASON }, ['id']),
        async (a) => this.scheduleUpdate(a),
      ),
      t('schedule_remove', 'GATED. Removes one of your schedules.', obj({ id: S(), ...REASON }, ['id']), async (a) => this.scheduleRemove(a)),
    ];
    return [...list, ...this.vboardsTools(t)];
  }

  // ------------------------------------------------------------------ portão

  /**
   * O cartão GATED (crítico: aprovar pede o PIN): primeiro os fatos reais (montados aqui, nunca pelo Jarvis), a origem e
   * a contaminação do turno e o motivo dele marcado como não verificado; depois, o texto livre INTEIRO (`free`: o pedido,
   * a mensagem, os itens). Texto que não cabe em CARD_TEXT_MAX recusa a ação. undefined = aprovado; senão, a frase da
   * recusa (nada rodou).
   */
  private async gate(tool: string, input: Record<string, unknown>, facts: string[], reason: unknown, free?: string): Promise<string | undefined> {
    const id = this.deps.jarvisId();
    if (!id) return tr('Agente não encontrado.');
    const why = str(reason);
    const head = [
      tr('Jarvis quer: {0}', [tool]),
      ...facts,
      tr('Origem do pedido: {0}', [originLabel(this.deps.turn().origin)]),
      this.tainted() ? tr('Turno contaminado: sim (dados de fora nesta rodada; leia o texto com cuidado)') : tr('Turno contaminado: não'),
      why ? tr('Motivo (do Jarvis, não verificado): {0}', [why]) : tr('Motivo (do Jarvis, não verificado): (nenhum)'),
    ];
    const body = maskSecrets([...head, ...(free ? ['', tr('--- texto completo ---'), free] : [])].join('\n'));
    if (body.length > CARD_TEXT_MAX) return tr('O texto passa de {0} caracteres e não cabe inteiro no cartão: nada foi feito. Mande algo menor.', [CARD_TEXT_MAX]);
    const a: HumanAnswer = await askHuman({ registry: this.deps.registry, chat: this.deps.chat }, id, {
      tool: `Jarvis · ${tool}`,
      input,
      text: maskSecrets(facts[0] ? `${tr('Jarvis quer: {0}', [tool])} · ${facts[0]}` : tr('Jarvis quer: {0}', [tool])),
      body,
      critical: true,
      ...(this.deps.cardTimeoutMs ? { timeoutMs: this.deps.cardTimeoutMs } : {}),
    });
    if (a.answer === 'allow') return undefined;
    if (a.answer === 'deny') return tr('O dono recusou{0}. Nada foi feito; não insista.', [a.message ? `: ${a.message}` : '']);
    if (a.answer === 'too-many') return tr('Muitos pedidos de aprovação abertos: nada foi feito.');
    return tr('Sem resposta do dono a tempo: nada foi feito; não insista.');
  }

  private need<K extends 'runs' | 'triggers' | 'vboards'>(k: K): JarvisToolsDeps[K] | undefined {
    return this.deps[k];
  }

  private folder(want: string): { path: string; name?: string } | undefined {
    if (!want) return undefined;
    return this.deps.folders().find((f) => normPath(f.path) === normPath(want) || (f.name ?? '').toLowerCase() === want.toLowerCase() || basename(f.path).toLowerCase() === want.toLowerCase());
  }

  // ------------------------------------------------------------------ agentes

  private agentsList(): unknown[] {
    const me = this.deps.jarvisId();
    return this.deps.chat.agentsList().filter((a) => a.id !== me).map((a) => ({ ...a, ...(a.lastReply ? { lastReply: wrapUntrusted('agente', a.id, a.lastReply) } : {}), openedByYou: this.deps.chat.record(a.id)?.openedBy === me }));
  }

  private agentsRead(a: Record<string, unknown>): Result {
    const id = str(a.agentId);
    const v = this.deps.chat.view(id, typeof a.after === 'number' ? a.after : 0);
    if (!v) return fail(tr('Agente não encontrado.'));
    const items = v.items.slice(-READ_ITEMS).map((i) => {
      if (i.kind === 'tool') return { seq: i.seq, kind: 'tool', name: i.name, input: clip(i.input, 200), ...(i.error ? { error: true } : {}) };
      if (i.kind === 'usage') return { seq: i.seq, kind: 'usage', costUsd: i.costUsd, tokens: i.tokensIn + i.tokensOut };
      if (i.kind === 'approval') return { seq: i.seq, kind: 'approval', text: clip(i.text, READ_TEXT), outcome: i.outcome ?? 'pending' };
      return { seq: i.seq, kind: i.kind, text: clip(i.text, READ_TEXT) };
    });
    return ok({ agentId: id, phase: v.state.phase, lastSeq: v.lastSeq, spentUsd: v.state.spentUsd, items: wrapUntrusted('agente', id, JSON.stringify(items, null, 1)) });
  }

  private async agentsSpawn(a: Record<string, unknown>): Promise<Result> {
    const f = this.folder(str(a.folder));
    if (!f) return fail(tr('Pasta desconhecida: abra uma sessão nela antes.'));
    const prompt = str(a.prompt);
    if (!prompt || prompt.length > CHAT_TEXT_MAX) return fail(tr('Escreva o pedido (até {0} caracteres).', [CHAT_TEXT_MAX]));
    const provider = (str(a.provider) || 'claude') as Provider;
    if (!PROVIDERS.includes(provider)) return fail(tr('Provedor inválido.'));
    const roleId = str(a.roleId);
    const me = this.deps.jarvisId() ?? '';
    const from = { agentId: me, name: 'Jarvis' };
    const isolated = a.isolated === true;
    // Fora da cópia isolada, só o Claude em "pedir aprovação": Codex e agy rodariam no automático, na pasta real, com push.
    if (!isolated && provider !== 'claude') return fail(tr('Fora da cópia isolada só dá para abrir um agente Claude (que pede aprovação a cada ação). Use isolated:true.'));
    const cfg = await this.deps.folderConfig(f.path);
    // SAFE: cópia isolada + sem push + orçamento da pasta + limite por hora + turno limpo, impostos aqui (não pelo pedido).
    const safe = { folder: f.path, provider, prompt, permission: 'auto' as const, isolated: true, denyPush: true, limits: { maxCostUsd: cfg.budget, maxTurnMinutes: AUTO_TURN_MINUTES }, ...(roleId ? { roleId } : {}) };
    const tainted = this.tainted();
    if (isolated && !tainted) {
      const bad = this.deps.chat.check(safe);
      if (bad) return fail(bad.reason);
      if (this.spawns.take(this.now())) {
        const r = this.deps.chat.open(safe, from);
        return 'agentId' in r ? ok(tr('Agente aberto: {0} (cópia isolada, sem push, até US$ {1}).', [r.agentId, cfg.budget])) : fail(r.reason);
      }
    }
    // GATED: fora da cópia isolada, acima do limite por hora ou turno contaminado; fora da cópia nasce em "pedir aprovação".
    const req = isolated ? safe : { folder: f.path, provider, prompt, permission: 'ask' as const, ...(roleId ? { roleId } : {}) };
    const bad = this.deps.chat.check(req);
    if (bad) return fail(bad.reason);
    const refused = await this.gate(
      'agents_spawn',
      { folder: f.path, provider, isolated },
      [
        tr('Abrir um agente {0} em {1}', [provider, f.path]),
        isolated
          ? tr('Cópia isolada, sem push, até US$ {0}: roda comandos sem perguntar{1}', [cfg.budget, tainted ? '' : tr(' (acima de {0} por hora)', [SPAWN_PER_HOUR])])
          : tr('Na pasta do projeto, sem cópia isolada (pede aprovação a cada ação no Claude)'),
      ],
      a.reason,
      prompt,
    );
    if (refused) return fail(refused);
    const r = this.deps.chat.open(req, from);
    return 'agentId' in r ? ok(tr('Agente aberto: {0}.', [r.agentId])) : fail(r.reason);
  }

  private async agentsSend(a: Record<string, unknown>): Promise<Result> {
    const id = str(a.agentId);
    const text = str(a.text);
    const me = this.deps.jarvisId();
    if (!text || text.length > CHAT_TEXT_MAX) return fail(tr('Escreva a mensagem (até {0} caracteres).', [CHAT_TEXT_MAX]));
    if (id === me) return fail(tr('Você não pode mandar mensagem para si mesmo.'));
    const rec = this.deps.chat.record(id);
    if (!rec) return fail(tr('Agente não encontrado.'));
    // SAFE só para quem o Jarvis abriu, numa cópia isolada ainda aberta, e num turno limpo.
    const isolated = !!rec.isolated && !rec.isolated.merged && !rec.isolated.discarded;
    if (rec.openedBy !== me || !isolated || this.tainted()) {
      const facts = [
        tr('Mandar uma mensagem para {0} ({1})', [this.deps.chat.displayName(id), rec.folder]),
        isolated ? tr('O agente roda numa cópia isolada ({0})', [rec.isolated!.branch]) : tr('O agente roda NA PASTA DO PROJETO, sem cópia isolada'),
      ];
      const refused = await this.gate('agents_send', { agentId: id }, facts, a.reason, text);
      if (refused) return fail(refused);
    }
    const d = this.deps.chat.deliver(id, text, { agentId: me ?? '', name: 'Jarvis' });
    if (!d) return fail(tr('Agente não encontrado.'));
    void d.result.catch(() => {});
    return ok(tr('Mensagem na fila de {0}; leia a resposta com agents_read.', [this.deps.chat.displayName(id)]));
  }

  private async agentsClose(a: Record<string, unknown>): Promise<Result> {
    const id = str(a.agentId);
    const rec = this.deps.chat.record(id);
    if (!rec) return fail(tr('Agente não encontrado.'));
    if (rec.system) return fail(tr('O Jarvis não fecha.'));
    const facts = [tr('Fechar o agente {0} ({1}): a conversa é apagada', [this.deps.chat.displayName(id), rec.folder])];
    if (rec.isolated && !rec.isolated.merged && !rec.isolated.discarded) facts.push(tr('Tem cópia isolada aberta no branch {0}', [rec.isolated.branch]));
    const refused = await this.gate('agents_close', { agentId: id }, facts, a.reason);
    if (refused) return fail(refused);
    const r = this.deps.chat.close(id);
    return r === 'ok' ? ok(tr('Agente fechado.')) : fail(tr('Não fechou ({0}).', [r]));
  }

  // ------------------------------------------------------------------ listas

  private runSummary(r: ChatRun): Record<string, unknown> {
    const count: Record<string, number> = {};
    for (const i of r.items) count[i.state] = (count[i.state] ?? 0) + 1;
    return { id: r.id, state: r.state, folder: r.options.folder, provider: r.options.provider, auto: !!r.auto, items: count, ...(r.isolated ? { branch: r.isolated.branch, merged: !!r.isolated.merged, discarded: !!r.isolated.discarded } : {}), ...(r.note ? { note: r.note } : {}) };
  }

  private runsGet(a: Record<string, unknown>): Result {
    const run = this.need('runs')?.get(str(a.id));
    if (!run) return fail(tr('lista não encontrada'));
    const items = run.items.map((i, n) => ({ n, state: i.state, text: clip(i.text, 300), ...(i.gate ? { gate: i.gate } : {}), ...(i.retried ? { retried: true } : {}), ...(i.agentId ? { agentId: i.agentId } : {}), ...(i.summary ? { summary: clip(i.summary, READ_TEXT) } : {}) }));
    return ok({ ...this.runSummary(run), items: wrapUntrusted('lista', run.id, JSON.stringify(items, null, 1)) });
  }

  private async runsDiff(a: Record<string, unknown>): Promise<Result> {
    const run = this.need('runs')?.get(str(a.id));
    if (!run) return fail(tr('lista não encontrada'));
    const w = run.isolated;
    if (!w || w.merged || w.discarded || !this.deps.worktrees) return fail(tr('Esta lista não tem cópia isolada aberta.'));
    return ok(await this.deps.worktrees.summary(w));
  }

  private async runsCreate(a: Record<string, unknown>): Promise<Result> {
    const runs = this.need('runs');
    if (!runs) return fail(tr('Listas desligadas.'));
    const f = this.folder(str(a.folder));
    if (!f) return fail(tr('Pasta desconhecida: abra uma sessão nela antes.'));
    const items = Array.isArray(a.items) ? a.items.map(str).filter(Boolean) : [];
    if (!items.length) return fail(tr('A lista precisa ter de 1 a {0} itens.', [50]));
    const context = str(a.context);
    const cfg = await this.deps.folderConfig(f.path);
    // Sempre cópia isolada, sem push e com o orçamento da pasta, aprovada ou não.
    const body = { items: items.map((text) => ({ text })), isolated: true, ...(context ? { context } : {}), options: { folder: f.path, provider: cfg.provider, permission: 'auto', denyPush: true, limits: { maxCostUsd: cfg.budget, maxTurnMinutes: AUTO_TURN_MINUTES } } };
    const auto = { ...(cfg.check ? { check: cfg.check } : {}), reviewer: cfg.reviewer, ...(cfg.reviewerModel ? { reviewerModel: cfg.reviewerModel } : {}) };
    const tainted = this.tainted();
    if (cfg.auto && !tainted && this.runsWindow.take(this.now())) {
      const r = runs.create(body, auto);
      return 'run' in r ? ok(tr('Lista automática criada: {0} ({1} itens, com o portão; termina esperando revisão).', [r.run.id, items.length])) : fail(r.error);
    }
    const free = [...items.map((x, i) => `${i + 1}. ${x}`), ...(context ? ['', tr('Contexto:'), context] : [])].join('\n');
    const facts = [tr('Criar uma lista de {0} itens em {1} (cópia isolada, sem push, {2}, até US$ {3} por item; cada item roda no automático)', [items.length, f.path, cfg.provider, cfg.budget])];
    if (cfg.auto && !tainted) facts.push(tr('Acima de {0} listas automáticas por hora', [RUNS_PER_HOUR]));
    const refused = await this.gate('runs_create', { folder: f.path, items: items.length }, facts, a.reason, free);
    if (refused) return fail(refused);
    const r = cfg.auto ? runs.create(body, auto) : runs.create(body);
    return 'run' in r ? ok(tr('Lista criada: {0}.', [r.run.id])) : fail(r.error);
  }

  private async runsClose(a: Record<string, unknown>, how: 'merge' | 'discard'): Promise<Result> {
    const runs = this.need('runs');
    const run = runs?.get(str(a.id));
    if (!runs || !run) return fail(tr('lista não encontrada'));
    const w = run.isolated;
    if (!w || w.merged || w.discarded) return fail(tr('Esta lista não tem cópia isolada aberta.'));
    let stat = '';
    try {
      stat = (await this.deps.worktrees?.summary(w))?.stat ?? '';
    } catch {
      // o diffstat é só para o cartão
    }
    const facts = [
      how === 'merge' ? tr('JUNTAR ao projeto a lista {0}', [run.id]) : tr('DESCARTAR a cópia e o branch da lista {0} (o trabalho se perde)', [run.id]),
      tr('Pasta: {0}', [run.options.folder]),
      tr('Branch: {0}', [w.branch]),
      tr('Itens: {0}', [run.items.map((i) => `${i.state}${i.gate ? `/${i.gate}` : ''}`).join(', ')]),
      stat ? tr('Diff: {0}', [clip(stat, 600)]) : tr('Diff: (vazio ou indisponível)'),
    ];
    const refused = await this.gate(how === 'merge' ? 'runs_merge' : 'runs_discard', { id: run.id, branch: w.branch }, facts, a.reason);
    if (refused) return fail(refused);
    const r = how === 'merge' ? await runs.merge(run.id) : await runs.discard(run.id);
    return 'ok' in r ? ok(how === 'merge' ? tr('Cópia juntada ao projeto.') : tr('Cópia descartada.')) : fail(r.error);
  }

  // ------------------------------------------------------------------ projetos

  private async projectsList(): Promise<unknown[]> {
    return Promise.all(
      this.deps.folders().slice(0, 25).map(async (f) => {
        const c = await this.deps.folderConfig(f.path).catch(() => undefined);
        return { path: f.path, name: f.name ?? basename(f.path), ...(c ? { auto: c.auto, provider: c.provider, budget: c.budget, card: c.card } : {}) };
      }),
    );
  }

  private async projectsConfigGet(a: Record<string, unknown>): Promise<Result> {
    const f = this.folder(str(a.folder));
    if (!f) return fail(tr('Pasta desconhecida: abra uma sessão nela antes.'));
    const v = folderConfigView(await this.deps.folderConfig(f.path));
    return ok({ folder: f.path, config: { ...v, ...(v.check ? { check: maskSecrets(v.check) } : {}) } });
  }

  private async projectsConfigSet(a: Record<string, unknown>): Promise<Result> {
    const f = this.folder(str(a.folder));
    if (!f) return fail(tr('Pasta desconhecida: abra uma sessão nela antes.'));
    const v = validateFolderConfig(a.values);
    if ('error' in v) return fail(v.error);
    const keys = Object.entries(v.values);
    if (!keys.length) return fail(tr('Nada para mudar.'));
    const before = folderConfigView(await this.deps.folderConfig(f.path)) as unknown as Record<string, unknown>;
    const facts = [tr('Mudar o git config --local de {0}:', [f.path]), ...keys.map(([k, val]) => `vboards.${k}: ${maskSecrets(String(before[k] ?? ''))} → ${val ? maskSecrets(val) : tr('(padrão)')}`)];
    const refused = await this.gate('projects_config_set', { folder: f.path, keys: keys.map(([k]) => k) }, facts, a.reason);
    if (refused) return fail(refused);
    const err = await this.deps.writeFolderConfig(f.path, v.values);
    return err ? fail(tr('Não deu para gravar no git config da pasta: {0}', [maskSecrets(err)])) : ok(tr('Gravado no git config da pasta.'));
  }

  // ------------------------------------------------------------------ uso

  private spend(): unknown {
    const rows = this.deps.chat.agentsList().map((a) => {
      const s = this.deps.chat.record(a.id)?.spend;
      return { agentId: a.id, name: a.name, folder: a.folder, usd: Math.round((s?.usd ?? 0) * 100) / 100, tokens: s?.tokens ?? 0 };
    });
    return { totalUsd: Math.round(rows.reduce((n, r) => n + r.usd, 0) * 100) / 100, agents: rows };
  }

  private metrics(a: Record<string, unknown>): unknown {
    const since = typeof a.since === 'number' && a.since > 0 ? a.since : this.now() - 24 * HOUR;
    const folder = str(a.folder);
    const list = (this.deps.metrics?.(since) ?? []).filter((m) => !folder || normPath(m.folder) === normPath(folder) || basename(m.folder).toLowerCase() === folder.toLowerCase());
    return summarizeMetrics(list);
  }

  // ------------------------------------------------------------------ aviso

  private async notifySend(a: Record<string, unknown>): Promise<Result> {
    if (!this.deps.notify) return fail(tr('Avisos desligados.'));
    const text = str(a.text);
    if (!text) return fail(tr('Escreva o aviso.'));
    const channel: NotifyChannel = a.channel === 'ntfy' || a.channel === 'whatsapp' ? a.channel : 'both';
    if (!this.notices.take(this.now())) return fail(tr('Limite de {0} avisos por hora atingido.', [NOTIFY_PER_HOUR]));
    const r = await this.deps.notify(clip(text, NOTIFY_WA_MAX), channel);
    if (!r.ntfy && !r.whatsapp) return fail(r.error ?? tr('Nenhum canal de aviso configurado para {0}.', [channel]));
    return ok(tr('Aviso enviado ({0}).', [[r.ntfy ? 'ntfy' : '', r.whatsapp ? 'WhatsApp' : ''].filter(Boolean).join(', ')]));
  }

  // ------------------------------------------------------------------ agendamentos

  private mine(): TriggerRule[] {
    const me = this.deps.jarvisId();
    return (this.need('triggers')?.list() ?? []).filter((r) => r.do.kind === 'send' && r.do.agentId === me);
  }

  private schedules(): unknown[] {
    return this.mine().map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, when: r.when, trusted: r.trusted === 'jarvis', message: r.do.kind === 'send' ? r.do.message : '' }));
  }

  /** mode → when/enabled do gatilho. on-demand: desligado (só schedule_run), com um relógio que nunca chega a valer. */
  private when(a: Record<string, unknown>): { when: unknown; enabled: boolean } | { error: string } {
    if (a.mode === 'scheduled') return { when: { kind: 'schedule', time: str(a.time), days: Array.isArray(a.days) ? a.days : [] }, enabled: true };
    if (a.mode === 'continuous') return { when: { kind: 'interval', minutes: a.minutes }, enabled: true };
    if (a.mode === 'on-demand') return { when: { kind: 'interval', minutes: 7 * 24 * 60 }, enabled: false };
    return { error: tr('Use mode scheduled, continuous ou on-demand.') };
  }

  private describe(name: string, a: Record<string, unknown>, message: string): string[] {
    const when = a.mode === 'scheduled' ? tr('todo dia às {0} (dias {1})', [str(a.time), Array.isArray(a.days) && a.days.length ? a.days.join(',') : tr('todos')]) : a.mode === 'continuous' ? tr('a cada {0} min', [String(a.minutes)]) : tr('só sob pedido');
    return [tr('Agendamento "{0}": {1}', [name, when]), tr('Disparos dele vão direto ao Jarvis, sem cartão. Mensagem:'), message];
  }

  private async scheduleCreate(a: Record<string, unknown>): Promise<Result> {
    const triggers = this.need('triggers');
    const me = this.deps.jarvisId();
    if (!triggers || !me) return fail(tr('Gatilhos desligados.'));
    const w = this.when(a);
    if ('error' in w) return fail(w.error);
    const name = str(a.name);
    const message = str(a.message);
    const body = { name, enabled: w.enabled, when: w.when, do: { kind: 'send', agentId: me, message } };
    const refused = await this.gate('schedule_create', { name, mode: a.mode }, this.describe(name, a, message), a.reason);
    if (refused) return fail(refused);
    const r = triggers.create(body, { trusted: 'jarvis' });
    return 'rule' in r ? ok(tr('Agendamento criado: {0}.', [r.rule.id])) : fail(r.error);
  }

  private async scheduleRun(a: Record<string, unknown>): Promise<Result> {
    const rule = this.mine().find((r) => r.id === str(a.id));
    if (!rule) return fail(tr('gatilho não encontrado'));
    if (rule.trusted !== 'jarvis') return fail(tr('Este agendamento não é seu de confiança: rode pela página.'));
    this.need('triggers')!.test(rule.id);
    return ok(tr('Disparado: a mensagem chega na sua fila.'));
  }

  private async scheduleUpdate(a: Record<string, unknown>): Promise<Result> {
    const triggers = this.need('triggers');
    const rule = this.mine().find((r) => r.id === str(a.id));
    if (!triggers || !rule || rule.do.kind !== 'send') return fail(tr('gatilho não encontrado'));
    const changes = ['name', 'mode', 'time', 'days', 'minutes', 'message'].filter((k) => a[k] !== undefined);
    // SAFE: só desligar.
    if (!changes.length && a.enabled === false) {
      const r = triggers.update(rule.id, { ...rule, enabled: false });
      return 'rule' in r ? ok(tr('Agendamento desligado.')) : fail(r.error);
    }
    if (!changes.length && a.enabled === undefined) return fail(tr('Nada para mudar.'));
    let next: Record<string, unknown> = { ...rule, ...(a.enabled !== undefined ? { enabled: a.enabled === true } : {}) };
    if (a.mode !== undefined) {
      const w = this.when(a);
      if ('error' in w) return fail(w.error);
      next = { ...next, when: w.when, ...(a.enabled === undefined ? { enabled: w.enabled } : {}) };
    }
    const name = str(a.name) || rule.name;
    const message = str(a.message) || rule.do.message;
    next = { ...next, name, do: { ...rule.do, message } };
    const facts = [tr('Mudar o agendamento "{0}"', [rule.name]), ...this.describe(name, a.mode !== undefined ? a : { mode: rule.when.kind === 'schedule' ? 'scheduled' : rule.enabled ? 'continuous' : 'on-demand', ...rule.when }, message), tr('Ligado: {0}', [String(next.enabled)])];
    const refused = await this.gate('schedule_update', { id: rule.id }, facts, a.reason);
    if (refused) return fail(refused);
    const r = triggers.update(rule.id, next);
    return 'rule' in r ? ok(tr('Agendamento mudado.')) : fail(r.error);
  }

  private async scheduleRemove(a: Record<string, unknown>): Promise<Result> {
    const triggers = this.need('triggers');
    const rule = this.mine().find((r) => r.id === str(a.id));
    if (!triggers || !rule) return fail(tr('gatilho não encontrado'));
    const refused = await this.gate('schedule_remove', { id: rule.id }, [tr('Remover o agendamento "{0}"', [rule.name])], a.reason);
    if (refused) return fail(refused);
    return triggers.remove(rule.id) ? ok(tr('Agendamento removido.')) : fail(tr('gatilho não encontrado'));
  }

  // ------------------------------------------------------------------ VBoards

  private vboardsTools(t: (name: string, description: string, inputSchema: Record<string, unknown>, run: (a: Record<string, unknown>) => Promise<Result>) => McpTool): McpTool[] {
    const api = this.deps.vboards;
    if (!api?.enabled) return [];
    /** Tudo que volta do VBoards é texto de pessoas: embrulhado como dado. */
    const data = (tool: string, v: unknown): Result => ok(wrapUntrusted('vboards', tool, JSON.stringify(v, null, 1)));
    const date = (v: unknown) => {
      const s = str(v);
      if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(tr('Data inválida (use AAAA-MM-DD).'));
      return s || undefined;
    };
    // Tudo que vai para o VBoards (a organização inteira lê) sai mascarado e dentro dos limites, contaminado ou não.
    const title = (v: unknown, need: boolean) => {
      const s = maskSecrets(str(v));
      if (need && !s) throw new Error(tr('Título de 1 a 200 caracteres.'));
      if (s.length > 200) throw new Error(tr('Título de 1 a 200 caracteres.'));
      return s || undefined;
    };
    const desc = (v: unknown) => {
      if (v === undefined) return undefined;
      const s = maskSecrets(typeof v === 'string' ? v : '');
      if (s.length > 10_000) throw new Error(tr('Descrição até 10000 caracteres.'));
      return s;
    };
    const oneOf = (v: unknown, list: readonly string[], what: string) => {
      if (v === undefined || v === '') return undefined;
      if (typeof v !== 'string' || !list.includes(v)) throw new Error(tr('{0} inválido: use {1}.', [what, list.join(', ')]));
      return v;
    };
    const texts = (v: unknown) => {
      const list = Array.isArray(v) ? v.map((x) => maskSecrets(str(x))).filter(Boolean) : [];
      if (!list.length || list.length > 20 || list.some((x) => x.length > 300)) throw new Error(tr('De 1 a 20 subtarefas, até 300 caracteres cada.'));
      return list;
    };
    const priority = (v: unknown) => {
      const s = str(v);
      if (s && !/^[a-z_]{1,20}$/.test(s)) throw new Error(tr('Prioridade inválida.'));
      return s || undefined;
    };
    const pick = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
    // `..` ou barra no id mudaria o caminho da API (/schedule/../tasks).
    const id = (v: unknown) => {
      const s = str(v);
      if (!s || s.length > 100 || s.includes('..') || /[/\\]/.test(s)) throw new Error(tr('id inválido'));
      return s;
    };
    return [
      t('vboards_me', 'SAFE. VBoards: who the token belongs to (email, members, organizations).', obj({}), async () => data('me', await api.me())),
      t('vboards_projects', 'SAFE. VBoards projects.', obj({}), async () => data('projects', await api.projects())),
      t('vboards_tasks_list', 'SAFE. VBoards tasks (max 500); filter by status or projectId.', obj({ status: { type: 'string', enum: [...TASK_STATUSES] }, projectId: S() }), async (a) =>
        data('tasks', await api.tasks({ status: oneOf(a.status, TASK_STATUSES, 'status'), projectId: str(a.projectId) || undefined })),
      ),
      t(
        'vboards_task_create',
        'SAFE. Creates a VBoards task (status default ideas).',
        obj({ title: S(), description: S(), projectId: S(), status: { type: 'string', enum: TASK_STATUSES.filter((s) => s !== 'deployed') }, priority: S() }, ['title']),
        async (a) => {
          const status = oneOf(a.status, TASK_STATUSES, 'status');
          if (status === 'deployed') throw new Error(tr('Para deployed use vboards_task_update (pede cartão).'));
          return data('task', await api.createTask(pick({ title: title(a.title, true), description: desc(a.description), projectId: str(a.projectId) || undefined, status, priority: priority(a.priority) })));
        },
      ),
      t(
        'vboards_task_update',
        'Updates a VBoards task. SAFE, except status "deployed", which is GATED (owner card).',
        obj({ id: S(), title: S(), description: S(), status: { type: 'string', enum: [...TASK_STATUSES] }, priority: S(), projectId: { type: ['string', 'null'] }, ...REASON }, ['id']),
        async (a) => {
          const taskId = id(a.id);
          const status = oneOf(a.status, TASK_STATUSES, 'status');
          const body = pick({ title: title(a.title, false), description: desc(a.description), status, priority: priority(a.priority), projectId: a.projectId === null ? null : str(a.projectId) || undefined });
          if (!Object.keys(body).length) throw new Error(tr('Nada para mudar.'));
          if (status === 'deployed') {
            const refused = await this.gate('vboards_task_update', { id: taskId, status }, [tr('Marcar a tarefa {0} do VBoards como deployed', [taskId])], a.reason);
            if (refused) return fail(refused);
          }
          return data('task', await api.updateTask(taskId, body));
        },
      ),
      t('vboards_schedule_list', 'SAFE. VBoards schedule cards around a date (scope month/week/day).', obj({ date: S('YYYY-MM-DD'), scope: { type: 'string', enum: [...SCHEDULE_SCOPES] } }), async (a) =>
        data('schedule', await api.schedule({ date: date(a.date), scope: oneOf(a.scope, SCHEDULE_SCOPES, 'scope') })),
      ),
      t(
        'vboards_schedule_create',
        'SAFE. Creates a VBoards schedule card (date default today, scope default day) with optional subtasks (max 20).',
        obj({ title: S(), date: S('YYYY-MM-DD'), scope: { type: 'string', enum: [...SCHEDULE_SCOPES] }, description: S(), subtasks: { type: 'array', items: { type: 'string' } } }, ['title']),
        async (a) => data('card', await api.createCard(pick({ title: title(a.title, true), date: date(a.date), scope: oneOf(a.scope, SCHEDULE_SCOPES, 'scope'), description: desc(a.description), subtasks: a.subtasks === undefined ? undefined : texts(a.subtasks) }))),
      ),
      t(
        'vboards_schedule_update',
        'SAFE. Updates a VBoards schedule card (title, description, status todo/doing/done, date or null).',
        obj({ id: S(), title: S(), description: S(), status: { type: 'string', enum: [...CARD_STATUSES] }, date: { type: ['string', 'null'] } }, ['id']),
        async (a) => {
          const body = pick({ title: title(a.title, false), description: desc(a.description), status: oneOf(a.status, CARD_STATUSES, 'status'), date: a.date === null ? null : date(a.date) });
          if (!Object.keys(body).length) throw new Error(tr('Nada para mudar.'));
          return data('card', await api.updateCard(id(a.id), body));
        },
      ),
      t(
        'vboards_subtasks_add',
        'Adds subtasks (1-20, max 300 chars) to a schedule card; queue:true also sends them to the agents queue. SAFE, except queue:true when the turn carries outside data (GATED).',
        obj({ id: S(), texts: { type: 'array', items: { type: 'string' } }, queue: { type: 'boolean' }, ...REASON }, ['id', 'texts']),
        async (a) => {
          const cardId = id(a.id);
          const list = texts(a.texts);
          if (a.queue === true && this.tainted()) {
            const refused = await this.gate('vboards_subtasks_add', { id: cardId, queue: true }, [tr('Mandar {0} subtarefas do card {1} do VBoards para a fila dos agentes (eles rodam no automático)', [list.length, cardId])], a.reason, list.map((x, i) => `${i + 1}. ${x}`).join('\n'));
            if (refused) return fail(refused);
          }
          return data('subtasks', await api.addSubtasks(cardId, list, a.queue === true ? true : undefined));
        },
      ),
      t('vboards_refine', 'SAFE. Asks VBoards to refine a schedule card (an agent plans it read-only).', obj({ id: S() }, ['id']), async (a) => data('refine', await api.refine(id(a.id)))),
      t('vboards_summary', 'SAFE. VBoards summary for a date: subtasks, refines and tasks per state.', obj({ date: S('YYYY-MM-DD') }), async (a) => data('summary', await api.summary(date(a.date)))),
      t('vboards_approve', 'GATED. Approves the refine plan of a schedule card (its subtasks go to the agents queue).', obj({ id: S(), ...REASON }, ['id']), async (a) => {
        const cardId = id(a.id);
        const refused = await this.gate('vboards_approve', { id: cardId }, [tr('Aprovar o plano do card {0} no VBoards: as subtarefas vão para a fila dos agentes', [cardId])], a.reason);
        if (refused) return fail(refused);
        return data('approve', await api.approve(cardId));
      }),
    ];
  }
}

/** Contagem, % do portão, voltas de correção, custo e tokens, no total e por pasta (usage_metrics e briefing). */
export function summarizeMetrics(list: readonly RunMetric[]): { count: number; gatePassPct?: number; retries: number; usd: number; tokens: number; failed: number; byFolder: Record<string, { count: number; usd: number; failed: number }> } {
  const gated = list.filter((m) => m.gate !== 'none');
  const byFolder: Record<string, { count: number; usd: number; failed: number }> = {};
  for (const m of list) {
    const k = basename(m.folder) || m.folder;
    const f = (byFolder[k] ??= { count: 0, usd: 0, failed: 0 });
    f.count++;
    f.usd = Math.round((f.usd + m.usd) * 100) / 100;
    if (m.state === 'failed' || m.state === 'interrupted') f.failed++;
  }
  return {
    count: list.length,
    ...(gated.length ? { gatePassPct: Math.round((gated.filter((m) => m.gate === 'pass').length / gated.length) * 100) } : {}),
    retries: list.filter((m) => m.retried).length,
    usd: Math.round(list.reduce((n, m) => n + m.usd, 0) * 100) / 100,
    tokens: list.reduce((n, m) => n + m.tokens, 0),
    failed: list.filter((m) => m.state === 'failed' || m.state === 'interrupted').length,
    byFolder,
  };
}
