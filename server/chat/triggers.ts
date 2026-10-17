// Gatilhos "quando X, faça Y" (projeto 4). Regra do dono do produto: um gatilho NUNCA abre nem manda mensagem a um
// agente sozinho. Todo disparo vira um cartão de aprovação no escritório (o mesmo dos cartões de delegação); só roda
// se a pessoa aprovar dentro da janela da regra. No máximo um cartão por regra: disparos enquanto ele espera são
// juntados. Guardado em <dataDir>/chat/triggers.json. Desenho: docs/superpowers/specs/2026-10-16-gatilhos-design.md.
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch as fsWatch, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { maskSecrets } from '../../shared/activity';
import { CHAT_TEXT_MAX } from '../../shared/chat';
import { tr } from '../../shared/i18n';
import {
  renderTemplate,
  TRIGGER_DEBOUNCE_DEFAULT,
  TRIGGER_HISTORY_MAX,
  TRIGGER_INTERVAL_MIN,
  TRIGGER_NAME_MAX,
  TRIGGER_SAIDA_MAX,
  TRIGGER_WINDOW_DEFAULT,
  TRIGGER_WINDOW_MAX,
  TRIGGERS_MAX,
  type TriggerDo,
  type TriggerFiring,
  type TriggerRule,
  type TriggerVar,
  type TriggerWhen,
} from '../../shared/triggers';
import { errMsg, log } from '../log';
import type { Office } from '../model/office';
import type { PermissionRegistry } from '../permissions/registry';
import { askHuman, type HumanAnswer } from './permission';
import type { ChatService } from './service';

export const CLOCK_MS = 30_000;
const POLL_MS = 10_000;
const POLL_FILES_MAX = 20_000;
const FILES_LIST_MAX = 50;
const OPEN_KEYS = ['folder', 'provider', 'account', 'model', 'roleId', 'permission', 'isolated', 'limits', 'name'] as const;
const IGNORED = new Set(['.git', 'node_modules', 'dist']);

/** O cartão de um disparo: `text` é o resumo (fica no contador), `detail` o que roda, inteiro. */
export interface TriggerCard { ruleId: string; title: string; folder: string; text: string; detail: string; timeoutMs: number }
export type Approver = (card: TriggerCard) => { result: Promise<HumanAnswer>; cancel: () => void };
export type Watcher = (folder: string, onChange: (rel: string) => void) => () => void;

export interface TriggerDeps {
  chat: Pick<ChatService, 'check' | 'open' | 'deliver' | 'onTurnEnd' | 'turnOutcome' | 'lastReply' | 'record' | 'displayName'>;
  approve: Approver;
  /** Nome do papel para o cartão (o id não diz nada ao usuário). */
  roleName?: (id: string) => string | undefined;
  folders: () => Array<{ path: string }>;
  file: string;
  watch?: Watcher;
  now?: () => number;
  newId?: () => string;
}

type Fail = { status: number; error: string };
type Vars = Partial<Record<TriggerVar, string>>;
/** O que o cartão mostrou e roda se aprovado. */
type Plan = { kind: 'open'; req: Record<string, unknown> & { prompt: string } } | { kind: 'send'; agentId: string; message: string };

// ------------------------------------------------------------------ lógica pura

const pad = (n: number) => String(n).padStart(2, '0');
/** Corta sem juntar as linhas (o truncate de activity junta). */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const hhmm = (t: number) => `${pad(new Date(t).getHours())}:${pad(new Date(t).getMinutes())}`;

/** Próximo HH:MM local depois de `from`, num dos dias (0 = domingo; vazio = todos). Monta a data no calendário local. */
export function nextScheduleAt(time: string, days: readonly number[], from: number): number | undefined {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) return undefined;
  const base = new Date(from);
  for (let d = 0; d <= 7; d++) {
    const at = new Date(base.getFullYear(), base.getMonth(), base.getDate() + d, Number(m[1]), Number(m[2]));
    if (at.getTime() > from && (!days.length || days.includes(at.getDay()))) return at.getTime();
  }
  return undefined;
}

/** `**` atravessa pastas, `*` e `?` não, `{a,b}` alternativas; sem barra, vale o nome do arquivo em qualquer pasta. */
export function globMatch(glob: string, rel: string): boolean {
  const g = glob.trim().replace(/\\/g, '/');
  const path = rel.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  const target = g.includes('/') ? path : (path.split('/').pop() ?? path);
  try {
    return new RegExp(`^${re}$`).test(target);
  } catch {
    return false;
  }
}

export function ignoredPath(rel: string): boolean {
  return rel.split(/[\\/]/).some((part) => IGNORED.has(part));
}

// ------------------------------------------------------------------ validação

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const int = (v: unknown, min: number, max: number): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined);
const normPath = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();

// ------------------------------------------------------------------ serviço

interface Pending { firing: TriggerFiring; cancel: () => void }
interface FileWatch { close: () => void; timer?: ReturnType<typeof setTimeout>; changed: Set<string> }

export class TriggerService {
  private rules: TriggerRule[] = [];
  private firings: TriggerFiring[] = [];
  private readonly pending = new Map<string, Pending>();
  private readonly nextAt = new Map<string, number>();
  private readonly watches = new Map<string, FileWatch>();
  private clock?: ReturnType<typeof setInterval>;
  /** Servidor desligando: as rodadas interrompidas pelo stopAll não disparam nada. */
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly deps: TriggerDeps) {
    this.now = deps.now ?? Date.now;
    deps.chat.onTurnEnd((id) => this.agentEnded(id));
  }

  /** Lê triggers.json; regra estragada é deixada de fora, o resto continua. */
  load(): void {
    let raw: { rules?: unknown; history?: unknown };
    try {
      raw = JSON.parse(readFileSync(this.deps.file, 'utf8'));
    } catch {
      return;
    }
    const ok = (r: unknown): r is TriggerRule => {
      const o = r as TriggerRule;
      return !!o && typeof o.id === 'string' && typeof o.name === 'string' && !!o.when && typeof o.when.kind === 'string' && !!o.do && typeof o.do.kind === 'string';
    };
    this.rules = Array.isArray(raw?.rules) ? raw.rules.filter(ok) : [];
    this.firings = Array.isArray(raw?.history) ? raw.history.filter((f: unknown) => !!f && typeof (f as TriggerFiring).id === 'string') : [];
    // Cartão que esperava quando o servidor caiu não existe mais.
    for (const f of this.firings) if (f.outcome === 'fired') Object.assign(f, { outcome: 'expired', note: tr('O servidor reiniciou.') });
  }

  /** Liga o relógio e os observadores das regras ligadas. */
  start(): void {
    if (this.clock) return;
    this.stopped = false;
    this.clock = setInterval(() => this.tick(), CLOCK_MS);
    this.clock.unref?.();
    for (const r of this.rules) this.arm(r);
  }

  /** Desligando o servidor: para relógio e observadores (os cartões somem com o registro). */
  stop(): void {
    this.stopped = true;
    clearInterval(this.clock);
    this.clock = undefined;
    for (const id of [...this.watches.keys()]) this.disarm(id);
    this.nextAt.clear();
  }

  list(): TriggerRule[] {
    return this.rules;
  }

  history(): TriggerFiring[] {
    return this.firings;
  }

  create(raw: unknown): { rule: TriggerRule } | Fail {
    if (this.rules.length >= TRIGGERS_MAX) return { status: 409, error: tr('No máximo {0} gatilhos.', [TRIGGERS_MAX]) };
    const r = this.parse(raw);
    if ('error' in r) return { status: 400, error: r.error };
    const rule: TriggerRule = { id: (this.deps.newId ?? randomUUID)(), createdAt: this.now(), ...r };
    this.rules.push(rule);
    this.save();
    this.arm(rule);
    return { rule };
  }

  update(id: string, raw: unknown): { rule: TriggerRule } | Fail {
    const i = this.rules.findIndex((r) => r.id === id);
    if (i < 0) return { status: 404, error: tr('gatilho não encontrado') };
    const r = this.parse(raw);
    if ('error' in r) return { status: 400, error: r.error };
    const rule: TriggerRule = { ...this.rules[i], ...r };
    this.disarm(id);
    this.rules[i] = rule;
    if (!rule.enabled) this.pending.get(id)?.cancel();
    this.save();
    this.arm(rule);
    return { rule };
  }

  remove(id: string): boolean {
    const i = this.rules.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.disarm(id);
    this.rules.splice(i, 1);
    this.pending.get(id)?.cancel();
    this.save();
    return true;
  }

  /** "Testar agora": dispara já (o cartão aparece como em qualquer disparo). */
  test(id: string): 'ok' | 'not-found' {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) return 'not-found';
    this.fire(rule, tr('teste manual'));
    return 'ok';
  }

  /** Relógio: horário e intervalo. */
  tick(): void {
    const now = this.now();
    for (const r of this.rules) {
      const at = this.nextAt.get(r.id);
      if (!r.enabled || at === undefined || now < at) continue;
      this.nextAt.set(r.id, this.next(r, now)!);
      if (r.when.kind === 'schedule') this.fire(r, tr('horário {0}', [r.when.time]));
      else if (r.when.kind === 'interval') this.fire(r, tr('a cada {0} min', [r.when.minutes]));
    }
  }

  // --- interno ---

  private parse(raw: unknown): Omit<TriggerRule, 'id' | 'createdAt'> | { error: string } {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const name = str(b.name);
    if (!name || name.length > TRIGGER_NAME_MAX) return { error: tr('Dê um nome ao gatilho (até {0} caracteres).', [TRIGGER_NAME_MAX]) };
    const windowMinutes = b.windowMinutes === undefined ? TRIGGER_WINDOW_DEFAULT : int(b.windowMinutes, 1, TRIGGER_WINDOW_MAX);
    if (windowMinutes === undefined) return { error: tr('Prazo de aprovação inválido (1 a {0} min).', [TRIGGER_WINDOW_MAX]) };
    const when = this.parseWhen(b.when);
    if ('error' in when) return when;
    const act = this.parseDo(b.do);
    if ('error' in act) return act;
    return { name, enabled: b.enabled !== false, when, do: act, windowMinutes };
  }

  private parseWhen(raw: unknown): TriggerWhen | { error: string } {
    const w = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    switch (w.kind) {
      case 'schedule': {
        const time = str(w.time);
        const days = Array.isArray(w.days) ? w.days : [];
        if (nextScheduleAt(time, [], 0) === undefined) return { error: tr('Horário inválido (use HH:MM).') };
        if (!days.every((d) => int(d, 0, 6) !== undefined)) return { error: tr('Dias da semana inválidos.') };
        return { kind: 'schedule', time, days: [...new Set(days as number[])].sort() };
      }
      case 'interval': {
        const minutes = int(w.minutes, TRIGGER_INTERVAL_MIN, 7 * 24 * 60);
        return minutes === undefined ? { error: tr('Intervalo de pelo menos {0} minutos.', [TRIGGER_INTERVAL_MIN]) } : { kind: 'interval', minutes };
      }
      case 'agent': {
        const agentId = str(w.agentId);
        const roleId = str(w.roleId);
        if (!agentId && !roleId) return { error: tr('Escolha o agente ou o papel.') };
        return { kind: 'agent', ...(agentId ? { agentId } : { roleId }), ...(w.alsoFailed === true ? { alsoFailed: true } : {}) };
      }
      case 'files': {
        const folder = this.deps.folders().find((f) => normPath(f.path) === normPath(str(w.folder)));
        if (!folder) return { error: tr('Pasta desconhecida: abra uma sessão nela antes.') };
        const glob = str(w.glob);
        if (glob.length > 200) return { error: tr('Filtro de arquivos longo demais.') };
        const debounceSec = w.debounceSec === undefined ? TRIGGER_DEBOUNCE_DEFAULT : int(w.debounceSec, 5, 3600);
        if (debounceSec === undefined) return { error: tr('Espera inválida (5 a 3600 s).') };
        return { kind: 'files', folder: folder.path, ...(glob ? { glob } : {}), debounceSec };
      }
      default:
        return { error: tr('Escolha quando o gatilho dispara.') };
    }
  }

  private parseDo(raw: unknown): TriggerDo | { error: string } {
    const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (d.kind === 'send') {
      const agentId = str(d.agentId);
      const message = str(d.message);
      if (!this.deps.chat.record(agentId)) return { error: tr('Agente não encontrado.') };
      if (!message || message.length > CHAT_TEXT_MAX) return { error: tr('Escreva a mensagem (até {0} caracteres).', [CHAT_TEXT_MAX]) };
      return { kind: 'send', agentId, message };
    }
    if (d.kind !== 'open') return { error: tr('Escolha o que o gatilho faz.') };
    const given = (d.options && typeof d.options === 'object' ? d.options : {}) as Record<string, unknown>;
    const options = Object.fromEntries(OPEN_KEYS.filter((k) => given[k] !== undefined).map((k) => [k, given[k]])) as unknown as Extract<TriggerDo, { kind: 'open' }>['options'];
    const prompt = str(d.prompt);
    const bad = this.deps.chat.check({ ...options, prompt });
    // CLI fora do PATH agora não impede guardar (é conferido de novo no disparo).
    if (bad && bad.error === 'invalid') return { error: bad.reason };
    return { kind: 'open', options, prompt };
  }

  private next(r: TriggerRule, from: number): number | undefined {
    if (r.when.kind === 'schedule') return nextScheduleAt(r.when.time, r.when.days, from);
    if (r.when.kind === 'interval') return from + r.when.minutes * 60_000;
    return undefined;
  }

  private arm(r: TriggerRule): void {
    if (!r.enabled || !this.clock) return;
    const at = this.next(r, this.now());
    if (at !== undefined) this.nextAt.set(r.id, at);
    if (r.when.kind !== 'files') return;
    const { folder, glob } = r.when;
    const debounce = (r.when.debounceSec ?? TRIGGER_DEBOUNCE_DEFAULT) * 1000;
    const fw: FileWatch = { changed: new Set(), close: () => {} };
    const onChange = (rel: string) => {
      const path = rel.replace(/\\/g, '/');
      if (!path || ignoredPath(path) || (glob && !globMatch(glob, path))) return;
      fw.changed.add(path);
      clearTimeout(fw.timer);
      fw.timer = setTimeout(() => {
        const files = [...fw.changed];
        fw.changed.clear();
        const reason = files.length === 1 ? tr('arquivo mudou: {0}', [files[0]]) : tr('{0} arquivos mudaram: {1}', [files.length, files.slice(0, 3).join(', ') + (files.length > 3 ? ', …' : '')]);
        this.fire(r, reason, { arquivos: files.slice(0, FILES_LIST_MAX).join('\n') + (files.length > FILES_LIST_MAX ? '\n…' : '') });
      }, debounce);
    };
    try {
      fw.close = (this.deps.watch ?? defaultWatch)(folder, onChange);
    } catch (err) {
      log.warnOnce(`triggers:watch:${folder}`, tr('Gatilhos: não deu para observar {0} ({1}).', [folder, errMsg(err)]));
    }
    this.watches.set(r.id, fw);
  }

  private disarm(id: string): void {
    this.nextAt.delete(id);
    const fw = this.watches.get(id);
    if (!fw) return;
    clearTimeout(fw.timer);
    fw.close();
    this.watches.delete(id);
  }

  private agentEnded(agentId: string): void {
    const end = this.deps.chat.turnOutcome(agentId);
    if (!end) return;
    const roleId = this.deps.chat.record(agentId)?.roleId;
    for (const r of this.rules) {
      if (!r.enabled || r.when.kind !== 'agent') continue;
      const w = r.when;
      if (w.agentId ? w.agentId !== agentId : !roleId || w.roleId !== roleId) continue;
      if (end === 'failed' && !w.alsoFailed) continue;
      const name = this.deps.chat.displayName(agentId);
      const reply = end === 'done' ? (this.deps.chat.lastReply(agentId) ?? '') : '';
      this.fire(r, end === 'done' ? tr('agente {0} terminou', [name]) : tr('agente {0} falhou', [name]), { agente: name, saida: clip(maskSecrets(reply).trim(), TRIGGER_SAIDA_MAX) });
    }
  }

  /** Disparo: valida a ação, mostra o cartão e só roda se aprovado. Com cartão esperando, só conta. */
  private fire(rule: TriggerRule, reason: string, extra: Vars = {}): void {
    if (this.stopped) return;
    const waiting = this.pending.get(rule.id);
    if (waiting) {
      waiting.firing.coalesced = (waiting.firing.coalesced ?? 0) + 1;
      return this.save();
    }
    const now = this.now();
    const vars: Vars = { regra: rule.name, motivo: reason, hora: hhmm(now), ...extra };
    const firing: TriggerFiring = { id: (this.deps.newId ?? randomUUID)(), ruleId: rule.id, ruleName: rule.name, at: now, reason, outcome: 'fired' };
    this.firings = [firing, ...this.firings].slice(0, TRIGGER_HISTORY_MAX);
    const plan = this.plan(rule, vars);
    if ('error' in plan) return this.end(firing, 'failed', plan.error);
    firing.action = plan.detail;
    const card: TriggerCard = {
      ruleId: rule.id,
      title: rule.name,
      folder: plan.folder,
      text: tr('Gatilho "{0}" ({1}): {2}', [rule.name, reason, plan.summary]),
      detail: tr('Motivo: {0}', [reason]) + `\n${plan.detail}`,
      timeoutMs: rule.windowMinutes * 60_000,
    };
    const ask = this.deps.approve(card);
    this.pending.set(rule.id, { firing, cancel: ask.cancel });
    this.save();
    void ask.result.then(
      (a) => this.answered(rule.id, firing, plan.run, a),
      (err) => this.answered(rule.id, firing, plan.run, { answer: 'deny', message: errMsg(err) }),
    );
  }

  /** O que a regra faria agora: o texto montado com os valores do disparo, validado antes do cartão. */
  private plan(rule: TriggerRule, vars: Vars): { run: Plan; folder: string; summary: string; detail: string } | { error: string } {
    const { chat } = this.deps;
    const fill = (tpl: string) => clip(renderTemplate(tpl, vars).trim(), CHAT_TEXT_MAX);
    if (rule.do.kind === 'send') {
      const rec = chat.record(rule.do.agentId);
      if (!rec) return { error: tr('Agente não encontrado.') };
      const message = fill(rule.do.message);
      if (!message) return { error: tr('A mensagem ficou vazia.') };
      const to = chat.displayName(rule.do.agentId);
      return { run: { kind: 'send', agentId: rule.do.agentId, message }, folder: rec.folder, summary: tr('mandar mensagem para {0}', [to]), detail: tr('Mandar para {0}:', [to]) + `\n\n${message}` };
    }
    const prompt = fill(rule.do.prompt);
    const req = { ...rule.do.options, prompt };
    const bad = chat.check(req);
    if (bad) return { error: bad.reason };
    const o = rule.do.options;
    const facts = [
      tr('provedor {0}', [o.provider]),
      o.model ? tr('modelo {0}', [o.model]) : '',
      o.roleId ? tr('papel {0}', [this.deps.roleName?.(o.roleId) ?? o.roleId]) : '',
      // Igual ao ChatService.open: só o Claude pede aprovação; Codex e Antigravity rodam no automático.
      o.provider === 'claude' && o.permission === 'ask' ? tr('pede aprovação a cada ação') : tr('permissão automática'),
      o.isolated ? tr('cópia isolada') : '',
      o.name ? tr('nome {0}', [o.name]) : '',
    ].filter(Boolean);
    return {
      run: { kind: 'open', req },
      folder: o.folder,
      summary: tr('abrir um agente em {0}', [o.folder]),
      detail: tr('Abrir agente em {0} ({1}) com o pedido:', [o.folder, facts.join(', ')]) + `\n\n${prompt}`,
    };
  }

  private answered(ruleId: string, firing: TriggerFiring, plan: Plan, a: HumanAnswer): void {
    if (this.pending.get(ruleId)?.firing === firing) this.pending.delete(ruleId);
    const rule = this.rules.find((r) => r.id === ruleId);
    if (a.answer === 'deny') return this.end(firing, 'denied', a.message || undefined);
    if (a.answer === 'too-many') return this.end(firing, 'failed', tr('Muitos pedidos de aprovação abertos.'));
    if (a.answer !== 'allow') return this.end(firing, 'expired', rule?.enabled ? undefined : tr('Gatilho desligado.'));
    // Desligar já tira o cartão; "Testar agora" numa regra desligada roda se aprovado.
    if (!rule) return this.end(firing, 'expired', tr('gatilho não encontrado'));
    if (plan.kind === 'open') {
      const r = this.deps.chat.open(plan.req, { agentId: `trigger:${ruleId}`, name: tr('Gatilho "{0}"', [rule.name]) });
      if (!('agentId' in r)) return this.end(firing, 'failed', r.reason);
      firing.agentId = r.agentId;
    } else {
      const d = this.deps.chat.deliver(plan.agentId, plan.message, { agentId: `trigger:${ruleId}`, name: tr('Gatilho "{0}"', [rule.name]) });
      if (!d) return this.end(firing, 'failed', tr('Agente não encontrado.'));
      firing.agentId = plan.agentId;
    }
    this.end(firing, 'approved');
  }

  private end(firing: TriggerFiring, outcome: TriggerFiring['outcome'], note?: string): void {
    firing.outcome = outcome;
    firing.endedAt = this.now();
    if (note) firing.note = note;
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true });
      writeFileSync(`${this.deps.file}.tmp`, JSON.stringify({ rules: this.rules, history: this.firings }));
      renameSync(`${this.deps.file}.tmp`, this.deps.file);
    } catch (err) {
      log.warnOnce(`triggers:save:${errMsg(err)}`, tr('Gatilhos: não deu para gravar {0} ({1}).', [this.deps.file, errMsg(err)]));
    }
  }
}

// ------------------------------------------------------------------ ligações reais

/** fs.watch recursivo; onde ele não existe (ou falha), varre as datas de modificação a cada 10 s. */
export function defaultWatch(folder: string, onChange: (rel: string) => void): () => void {
  try {
    const w = fsWatch(folder, { recursive: true }, (_e, name) => name && onChange(String(name)));
    w.on('error', () => {});
    return () => w.close();
  } catch {
    // shortcut: varredura completa a cada 10 s, até 20 mil arquivos; troque por chokidar se pastas grandes pesarem.
    const scan = () => {
      const out = new Map<string, number>();
      const walk = (dir: string) => {
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          return;
        }
        for (const n of names) {
          if (IGNORED.has(n) || out.size >= POLL_FILES_MAX) continue;
          const p = join(dir, n);
          try {
            const s = statSync(p);
            if (s.isDirectory()) walk(p);
            else out.set(relative(folder, p).split(sep).join('/'), s.mtimeMs);
          } catch {
            // sumiu no meio da varredura
          }
        }
      };
      walk(folder);
      return out;
    };
    let last = scan();
    const timer = setInterval(() => {
      const now = scan();
      for (const [p, t] of now) if (last.get(p) !== t) onChange(p);
      for (const p of last.keys()) if (!now.has(p)) onChange(p);
      last = now;
    }, POLL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

/**
 * Cartões no escritório: o registro guarda pedidos por agente, então cada regra com cartão esperando aparece como um
 * agente "Gatilho" (`trigger:<id>`) na sala da pasta, só enquanto espera. Entra no "precisa de você" como os outros.
 */
export function officeApprover(d: { office: Pick<Office, 'addMain' | 'closeMain'>; registry: Pick<PermissionRegistry, 'registerChat' | 'wait' | 'releaseAgent'>; now?: () => number }): Approver {
  const noChat = { record: () => undefined, addApproval: () => {}, resolveApproval: () => {} };
  return (card) => {
    const agentId = `trigger:${card.ruleId}`;
    d.office.addMain({ id: agentId, account: '', sessionId: agentId, cwd: card.folder, role: tr('Gatilho'), startedAt: (d.now ?? Date.now)(), status: 'waiting', waitingFor: tr('aprovar um gatilho') });
    const result = askHuman({ registry: d.registry, chat: noChat }, agentId, { tool: 'Gatilho', input: { regra: card.title, detalhe: card.detail }, text: card.text, timeoutMs: card.timeoutMs });
    void result.finally(() => d.office.closeMain(agentId));
    return { result, cancel: () => d.registry.releaseAgent(agentId) };
  };
}
