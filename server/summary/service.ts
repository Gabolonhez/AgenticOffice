// Resumo do dia: monta o digest (digest.ts) e, por padrão, pede a UM turno do Claude (modelo mais barato, sem
// ferramentas, numa pasta neutra) um texto curto para o time. Sem a CLI, com erro ou estourando o prazo, cai na lista.
import { execFile, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { maskSecrets } from '../../shared/activity';
import { tr } from '../../shared/i18n';
import type { DaySummary, SummaryMode } from '../../shared/summary';
import { resolveCliBin } from '../chat/bins';
import { INHERITED_SESSION_VARS } from '../pty/manager';
import { buildDigest, digestToList, localMidnight, type DigestInput } from './digest';

export const AI_TIMEOUT_MS = 90_000;
export type AiRunner = (prompt: string) => Promise<{ text: string; costUsd?: number }>;

export function aiPrompt(material: string): string {
  return [
    'Você escreve o resumo do dia de trabalho de uma equipe de desenvolvimento, em português do Brasil.',
    'Abaixo está o material do dia, por projeto, com "Feito hoje" e "Em andamento agora". Escreva um resumo curto para o time: um bloco por projeto, com marcadores para o que foi feito e o que está em andamento.',
    'Use só o que está no material. Não invente fatos, nomes nem resultados; se algo estiver vago, diga de forma vaga. Não use ferramentas.',
    '',
    '--- material ---',
    material,
  ].join('\n');
}

/** Um turno `claude -p` (prompt pelo stdin, sem ferramentas). `cwd` neutro: não é um projeto. */
export function claudeRunner(cwd: string, bin = resolveCliBin('claude'), timeoutMs = AI_TIMEOUT_MS): AiRunner {
  return (prompt) =>
    new Promise((ok, fail) => {
      if (!bin) return fail(new Error(tr('Claude Code não encontrado')));
      mkdirSync(cwd, { recursive: true });
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const k of INHERITED_SESSION_VARS) delete env[k];
      const args = [...bin.prefix, '-p', '--model', 'haiku', '--output-format', 'json', '--tools', '', '--no-session-persistence'];
      const proc = spawn(bin.file, args, { cwd, env, shell: false, windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        proc.kill();
        fail(new Error(tr('a IA demorou mais de {0} s', [Math.round(timeoutMs / 1000)])));
      }, timeoutMs);
      proc.stdout.on('data', (d) => (out += d));
      proc.stderr.on('data', (d) => (err.length < 2000 ? (err += d) : undefined));
      proc.on('error', (e) => {
        clearTimeout(timer);
        fail(e);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        try {
          const j = JSON.parse(out) as { result?: unknown; is_error?: unknown; total_cost_usd?: unknown };
          if (code === 0 && !j.is_error && typeof j.result === 'string' && j.result.trim()) return ok({ text: j.result.trim(), ...(typeof j.total_cost_usd === 'number' ? { costUsd: j.total_cost_usd } : {}) });
        } catch {
          // saída que não é JSON: falha abaixo
        }
        fail(new Error(maskSecrets(err.trim().split('\n')[0] || tr('a IA não respondeu (código {0})', [String(code)]))));
      });
      proc.stdin.on('error', () => {});
      proc.stdin.end(prompt);
    });
}

/** Mensagens de commit de hoje de uma pasta (sem shell); vazio se não for repositório ou o git falhar. */
export function gitSubjectsToday(folder: string, since: number, max = 30): Promise<string[]> {
  return new Promise((ok) => {
    execFile('git', ['log', `--since=${new Date(since).toISOString()}`, '--no-merges', '--pretty=%s', '-n', String(max)], { cwd: folder, timeout: 5_000, windowsHide: true, encoding: 'utf8' }, (err, out) =>
      ok(err ? [] : out.split('\n').map((s) => s.trim()).filter(Boolean)),
    );
  });
}

export interface DaySummaryDeps {
  /** Material do dia; `since` já vem calculado. */
  gather: (since: number) => Promise<Omit<DigestInput, 'since'>>;
  runner: AiRunner;
  now?: () => number;
}

export class DaySummaryService {
  private cache?: { day: number; summary: DaySummary };
  private pending?: Promise<DaySummary>;

  constructor(private readonly deps: DaySummaryDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Último resumo da IA gerado hoje, se houver. */
  last(): DaySummary | undefined {
    return this.cache && this.cache.day === localMidnight(this.now()) ? this.cache.summary : undefined;
  }

  async generate(mode: SummaryMode): Promise<DaySummary> {
    const since = localMidnight(this.now());
    const projects = buildDigest({ since, ...(await this.deps.gather(since)) });
    const list = digestToList(projects, { done: tr('Feito hoje'), doing: tr('Em andamento agora'), empty: tr('Nada registrado hoje.') });
    const plain = (fallbackReason?: string): DaySummary => ({ text: list, generatedAt: this.now(), ...(fallbackReason ? { fallbackReason } : {}) });
    if (mode === 'list') return plain();
    if (!projects.length) return plain();
    // Um turno da IA por vez: cliques repetidos esperam o mesmo.
    this.pending ??= this.deps
      .runner(aiPrompt(list))
      .then((r): DaySummary => ({ text: maskSecrets(r.text), ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}), generatedAt: this.now() }))
      .then((s) => {
        this.cache = { day: since, summary: s };
        return s;
      })
      .finally(() => (this.pending = undefined));
    try {
      return await this.pending;
    } catch (err) {
      return plain(maskSecrets(err instanceof Error ? err.message : String(err)));
    }
  }
}

export const summaryCwd = (dataDir: string): string => join(dataDir, 'summary');
