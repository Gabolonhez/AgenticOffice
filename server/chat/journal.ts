// Registro por projeto (<dataDir>/chat/journal.jsonl): uma linha por etapa de cada tarefa das listas (runs.ts grava
// nas transições: entrou na fila, rodando, revisão, juntada, descartada, falhou; o pipeline de PR/CI/deploy usa as
// etapas pr, ci_fail, merged e deployed). O briefing, os relatórios e as ferramentas projects_status e release_notes do
// Jarvis leem daqui por projectLedger(). Cortado como as métricas (runs.ts trimMetrics).
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';

export const JOURNAL_STAGES = ['queued', 'running', 'review', 'pr', 'ci_fail', 'merged', 'deployed', 'failed', 'discarded', 'triaged', 'ota_preview', 'ota_production', 'build', 'submitted'] as const;
export type JournalStage = (typeof JOURNAL_STAGES)[number];

export interface JournalEntry {
  at: number;
  /** id do produto (vboards/products.ts), se a pasta for de um. */
  product?: string;
  folder: string;
  cardId?: string;
  subtaskId?: string;
  stage: JournalStage;
  /** Identifica a tarefa entre as linhas (a lista e o item) ou o PR. */
  ref?: string;
  title?: string;
  /** Detalhe curto da etapa (a triagem: válida/duplicada/prioridade). */
  note?: string;
}

export const JOURNAL_TRIM_BYTES = 2 * 1024 * 1024;
export const JOURNAL_KEEP_MS = 90 * 24 * 60 * 60_000;

export function appendJournal(file: string, e: JournalEntry): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(e)}\n`);
  } catch (err) {
    log.warnOnce(`journal:${errMsg(err)}`, tr('Registro por projeto: não deu para gravar ({0}).', [errMsg(err)]));
  }
}

/** As linhas desde `since` (linha estragada fica de fora). */
export function readJournal(file: string, since = 0): JournalEntry[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((l) => {
    try {
      const e = JSON.parse(l) as JournalEntry;
      return e && typeof e.at === 'number' && e.at >= since && typeof e.folder === 'string' && (JOURNAL_STAGES as readonly string[]).includes(e.stage) ? [e] : [];
    } catch {
      return [];
    }
  });
}

/** Só acima de JOURNAL_TRIM_BYTES, mantendo os últimos JOURNAL_KEEP_MS. */
export function trimJournal(file: string, now: number): void {
  try {
    if (statSync(file).size <= JOURNAL_TRIM_BYTES) return;
    writeFileSync(`${file}.tmp`, readJournal(file, now - JOURNAL_KEEP_MS).map((e) => `${JSON.stringify(e)}\n`).join(''));
    renameSync(`${file}.tmp`, file);
  } catch {
    // sem arquivo: nada a cortar
  }
}

export interface LedgerItem {
  title: string;
  stage: JournalStage;
  at: number;
  ref?: string;
}

/** Por projeto (o produto, ou o nome da pasta): feito, fazendo, a fazer e travado (falhou ou CI vermelho). */
export interface ProjectLedger {
  project: string;
  folders: string[];
  done: LedgerItem[];
  doing: LedgerItem[];
  todo: LedgerItem[];
  stuck: LedgerItem[];
}

const BUCKET: Record<JournalStage, keyof Pick<ProjectLedger, 'done' | 'doing' | 'todo' | 'stuck'> | undefined> = {
  queued: 'todo',
  running: 'doing',
  review: 'doing',
  pr: 'doing',
  ci_fail: 'stuck',
  merged: 'done',
  deployed: 'done',
  failed: 'stuck',
  discarded: undefined,
  triaged: undefined,
  ota_preview: undefined,
  ota_production: undefined,
  build: undefined,
  submitted: undefined,
};

/** Quanto do registro conta para o que está em aberto (fazendo, a fazer). */
export const LEDGER_OPEN_MS = 30 * 24 * 60 * 60_000;

/**
 * A última etapa de cada tarefa (pela ref, senão card:subtarefa, senão o título), agrupada por projeto. `since`: feito e
 * travado só a partir dali (o que está em aberto vale do registro inteiro que veio).
 */
export function projectLedger(entries: readonly JournalEntry[], since = 0): ProjectLedger[] {
  const last = new Map<string, JournalEntry>();
  for (const e of entries) {
    const key = `${e.folder}|${e.ref ?? (e.subtaskId ? `${e.cardId}:${e.subtaskId}` : e.title ?? '')}`;
    const cur = last.get(key);
    if (!cur || cur.at <= e.at) last.set(key, { ...e, title: e.title ?? cur?.title });
  }
  const out = new Map<string, ProjectLedger>();
  for (const e of last.values()) {
    const bucket = BUCKET[e.stage];
    if (!bucket || ((bucket === 'done' || bucket === 'stuck') && e.at < since)) continue;
    const project = e.product ?? (basename(e.folder) || e.folder);
    const p = out.get(project) ?? { project, folders: [], done: [], doing: [], todo: [], stuck: [] };
    if (!p.folders.includes(e.folder)) p.folders.push(e.folder);
    p[bucket].push({ title: e.title ?? e.ref ?? '', stage: e.stage, at: e.at, ...(e.ref ? { ref: e.ref } : {}) });
    out.set(project, p);
  }
  for (const p of out.values()) for (const k of ['done', 'doing', 'todo', 'stuck'] as const) p[k].sort((a, b) => b.at - a.at);
  return [...out.values()].sort((a, b) => a.project.localeCompare(b.project));
}
