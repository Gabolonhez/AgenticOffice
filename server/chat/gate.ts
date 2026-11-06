// Portão de qualidade das listas automáticas do VBoards (runs.ts, ChatRun.auto): no fim de cada item roda o
// vboards.check da pasta na cópia isolada e pede a UM revisor (claude, codex ou agy, vboards.reviewer) que leia só o
// diff, sem ferramentas. O resultado vira o relatório que vai para o VBoards com o status 'review'. Nunca junta nem dá
// push: o "Juntar" continua sendo um clique da pessoa.
// A cópia isolada é um git worktree recém-criado, sem node_modules nem .env: o vboards.check instala o que precisar
// (ex.: `npm ci && npm test`).
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { maskSecrets } from '../../shared/activity';
import { CHAT_TEXT_MAX } from '../../shared/chat';
import { tr } from '../../shared/i18n';
import type { RunAuto } from '../../shared/runs';
import type { Provider } from '../../shared/types';
import { INHERITED_SESSION_VARS } from '../pty/manager';
import { AI_TIMEOUT_MS, claudeRunner, type AiRunner } from '../summary/service';
import { resolveCliBin, type CliBin } from './bins';
import { agyDriver } from './drivers/agy';
import { claudeDriver } from './drivers/claude';
import { codexDriver } from './drivers/codex';
import { defaultKill } from './service';
import type { StreamParser } from './types';
import { noPushEnv } from './worktree';

export const CHECK_TIMEOUT_MS = 10 * 60_000;
export const CHECK_TAIL_MAX = 1_500;
export const DIFF_MAX = 20_000;
export const REPORT_MAX = 2_000;
const OUTPUT_KEEP = 64 * 1024;

/** Corta mantendo as quebras de linha (o truncate do activity junta tudo numa linha). */
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export interface CheckResult { ok: boolean; tail: string }
export type ReviewResult = { ok: boolean; findings: string; by: string } | { error: string; by: string };

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of INHERITED_SESSION_VARS) delete env[k];
  return { ...env, ...noPushEnv(env), ...extra };
}

/** O vboards.check num shell, na cópia isolada: passa com código 0 dentro do prazo. Guarda o fim da saída, mascarado. */
export function runChecks(cmd: string, cwd: string, timeoutMs = CHECK_TIMEOUT_MS, extraEnv: NodeJS.ProcessEnv = {}): Promise<CheckResult> {
  return new Promise((ok) => {
    let out = '';
    let timedOut = false;
    const keep = (d: Buffer | string) => void (out = (out + String(d)).slice(-OUTPUT_KEEP));
    const finish = (pass: boolean, extra = '') => ok({ ok: pass, tail: maskSecrets(`${out}${extra}`).trim().slice(-CHECK_TAIL_MAX) });
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, { cwd, shell: true, env: cleanEnv(extraEnv), windowsHide: true, detached: process.platform !== 'win32' });
    } catch (err) {
      return finish(false, String((err as Error)?.message ?? err));
    }
    const timer = setTimeout(() => {
      timedOut = true;
      if (proc.pid !== undefined) defaultKill(proc.pid);
    }, timeoutMs);
    proc.stdout?.on('data', keep);
    proc.stderr?.on('data', keep);
    proc.on('error', (err) => {
      clearTimeout(timer);
      finish(false, `\n${err.message}`);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0 && !timedOut, timedOut ? `\n${tr('Checagens passaram de {0} min.', [Math.round(timeoutMs / 60_000)])}` : '');
    });
  });
}

export const QA_TIMEOUT_MS = 10 * 60_000;
/** Quantas capturas entram no relatório e o tamanho máximo de cada uma. */
export const QA_MAX_SHOTS = 6;
export const QA_SHOT_MAX_BYTES = 5 * 1024 * 1024;
export interface QaResult extends CheckResult { shots: string[] }

/** PNGs de verdade (extensão e tamanho) na pasta, em ordem de nome, até `max`; devolve só os nomes. */
export function listShots(dir: string, max = QA_MAX_SHOTS): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => /^[\w][\w .()-]{0,99}\.png$/i.test(n))
      .filter((n) => {
        const st = statSync(join(dir, n));
        return st.isFile() && st.size > 0 && st.size <= QA_SHOT_MAX_BYTES;
      })
      .sort()
      .slice(0, max);
  } catch {
    return [];
  }
}

/**
 * vboards.qa: roda DEPOIS do vboards.check, com o mesmo env limpo (sem push) e prazo. O comando escreve PNGs na pasta
 * `HABBLAUD_QA_DIR` (recriada vazia a cada passada). Falha só avisa: o chamador não usa `ok` para reprovar.
 */
export async function runQa(cmd: string, cwd: string, dir: string, timeoutMs = QA_TIMEOUT_MS): Promise<QaResult> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const r = await runChecks(cmd, cwd, timeoutMs, { HABBLAUD_QA_DIR: dir });
  return { ...r, shots: listShots(dir) };
}

export function reviewPrompt(diff: string): string {
  const cut = diff.length > DIFF_MAX ? `${diff.slice(0, DIFF_MAX)}\n[...diff cortado em ${DIFF_MAX} caracteres]` : diff;
  return [
    'Você revisa um diff de código feito por um agente, em português do Brasil. Não use ferramentas: leia só o diff abaixo.',
    'A primeira linha da resposta é exatamente OK (nada que impeça juntar) ou PROBLEMAS (bug, regressão, segredo, teste quebrado ou mudança fora do pedido).',
    'Depois, no máximo 10 marcadores curtos com os achados (arquivo e motivo). Não invente o que não está no diff.',
    '',
    '--- diff ---',
    cut,
  ].join('\n');
}

/** Primeira linha OK = passou; qualquer outra coisa (PROBLEMAS, vazio) = não passou. */
export function parseReview(text: string): { ok: boolean; findings: string } {
  const t = text.trim();
  const first = t.split(/\r?\n/, 1)[0].replace(/[*_`#\s.:]/g, '').toUpperCase();
  return { ok: first === 'OK', findings: t };
}

/** Uma rodada de uma CLI que fala JSONL (o parser do driver do chat junta o texto). */
function streamRunner(bin: CliBin, args: (prompt: string) => string[], stdin: boolean, parser: () => StreamParser, cwd: string, timeoutMs: number): AiRunner {
  return (prompt) =>
    new Promise((ok, fail) => {
      mkdirSync(cwd, { recursive: true });
      const proc = spawn(bin.file, [...bin.prefix, ...args(prompt)], { cwd, env: cleanEnv(), shell: false, windowsHide: true, detached: process.platform !== 'win32' });
      const p = parser();
      const texts: string[] = [];
      let error: string | undefined;
      let err = '';
      let buf = '';
      const take = (line: string) => {
        for (const e of p.line(line)) {
          if (e.type === 'text') texts.push(e.text);
          if (e.type === 'done' && !e.ok) error = e.error ?? tr('erro');
        }
      };
      const timer = setTimeout(() => {
        if (proc.pid !== undefined) defaultKill(proc.pid);
        fail(new Error(tr('a IA demorou mais de {0} s', [Math.round(timeoutMs / 1000)])));
      }, timeoutMs);
      proc.stdout.on('data', (d) => {
        buf += String(d);
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        lines.forEach(take);
      });
      proc.stderr.on('data', (d) => (err.length < 2000 ? (err += d) : undefined));
      proc.on('error', (e) => {
        clearTimeout(timer);
        fail(e);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (buf) take(buf);
        for (const e of p.end(code, err)) if (e.type === 'done' && !e.ok) error ??= e.error;
        const text = texts.join('\n').trim();
        if (!error && text) return ok({ text });
        fail(new Error(maskSecrets((error || err.trim().split('\n')[0] || tr('a IA não respondeu (código {0})', [String(code)])).slice(0, 300))));
      });
      proc.stdin.on('error', () => {});
      proc.stdin.end(stdin ? prompt : '');
    });
}

/**
 * Revisor pelo vboards.reviewer: claude sem ferramentas (`--tools ''`); codex no sandbox read-only, efêmero; agy no
 * modo plan. Todos numa pasta neutra (não o projeto). Sem a CLI do codex/agy, cai no claude (sonnet) e diz no `by`.
 */
export function reviewerFor(auto: Pick<RunAuto, 'reviewer' | 'reviewerModel'>, cwd: string, bins: (p: Provider) => CliBin | undefined = (p) => resolveCliBin(p), timeoutMs = 5 * AI_TIMEOUT_MS): { run: AiRunner; by: string } {
  const model = auto.reviewerModel;
  const label = (p: string, m?: string) => (m ? `${p}/${m}` : p);
  if (auto.reviewer === 'codex' && bins('codex')) {
    const args = () => ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', ...(model ? ['-m', model] : []), '-'];
    return { run: streamRunner(bins('codex')!, args, true, codexDriver.parser, cwd, timeoutMs), by: label('codex', model) };
  }
  if (auto.reviewer === 'antigravity' && bins('antigravity')) {
    // O pedido vai grudado no --print= (drivers/agy.ts); o diff já vem cortado em DIFF_MAX (cabe no argv do Windows).
    const args = (prompt: string) => ['--output-format', 'stream-json', '--mode', 'plan', ...(model ? ['--model', model] : []), `--print=${prompt}`];
    return { run: streamRunner(bins('antigravity')!, args, false, agyDriver.parser, cwd, timeoutMs), by: label('agy', model) };
  }
  const fallback = auto.reviewer !== 'claude';
  const m = fallback ? 'sonnet' : model || 'sonnet';
  return { run: claudeRunner(cwd, bins('claude'), timeoutMs, m), by: fallback ? `${label('claude', m)} ${tr('(no lugar de {0}, não encontrado)', [auto.reviewer === 'antigravity' ? 'agy' : auto.reviewer])}` : label('claude', m) };
}

/** Prazo do "Refinar" (lê o repositório inteiro, então bem mais que a revisão de um diff). */
export const REFINE_TIMEOUT_MS = 15 * 60_000;

/**
 * Argumentos da rodada só de leitura do "Refinar" (VBoards), por provedor: claude só com Read/Grep/Glob (sem shell nem
 * edição, sem os MCPs do usuário) e com o orçamento; codex no sandbox read-only, efêmero; agy no modo plan. O codex e o
 * agy não têm limite de gasto por flag.
 */
export function refineArgs(provider: Provider, budgetUsd: number, prompt: string, web = false): string[] {
  if (provider === 'codex') return ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-'];
  if (provider === 'antigravity') return ['--output-format', 'stream-json', '--mode', 'plan', `--print=${prompt}`];
  return ['-p', '--output-format', 'stream-json', '--verbose', '--tools', web ? 'WebSearch,WebFetch' : 'Read,Grep,Glob', '--strict-mcp-config', '--no-session-persistence', '--max-budget-usd', String(budgetUsd)];
}

/**
 * "Refinar" um card: UMA rodada só de leitura NA PASTA do projeto (sem cópia isolada: nada é escrito), pelo
 * vboards.provider. Sem a CLI do codex/agy, cai no claude, como o reviewerFor.
 */
export function refinerFor(provider: Provider, cwd: string, budgetUsd: number, bins: (p: Provider) => CliBin | undefined = (p) => resolveCliBin(p), timeoutMs = REFINE_TIMEOUT_MS, web = false): { run: AiRunner; by: string } {
  const p: Provider = provider !== 'claude' && bins(provider) ? provider : 'claude';
  const bin = bins(p);
  const by = p === provider ? (p === 'antigravity' ? 'agy' : p) : `claude ${tr('(no lugar de {0}, não encontrado)', [provider === 'antigravity' ? 'agy' : provider])}`;
  if (!bin) return { run: () => Promise.reject(new Error(tr('Claude Code não encontrado'))), by };
  const parser = p === 'codex' ? codexDriver.parser : p === 'antigravity' ? agyDriver.parser : claudeDriver.parser;
  return { run: streamRunner(bin, (prompt) => refineArgs(p, budgetUsd, prompt, web), p !== 'antigravity', parser, cwd, timeoutMs), by };
}

/** Revisa o diff; erro da IA não derruba o portão (vira "revisão indisponível" no relatório). */
export async function reviewDiff(auto: Pick<RunAuto, 'reviewer' | 'reviewerModel'>, diff: string, cwd: string): Promise<ReviewResult> {
  const r = reviewerFor(auto, cwd);
  try {
    return { ...parseReview(maskSecrets((await r.run(reviewPrompt(diff))).text)), by: r.by };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), by: r.by };
  }
}

/** Passou no portão: checagens (se há) ok e revisão (se respondeu) ok. */
export const gatePassed = (checks: CheckResult | undefined, review: ReviewResult | undefined): boolean => (!checks || checks.ok) && (!review || 'error' in review || review.ok);

/** O que volta para o agente (uma vez) quando o portão falha. */
export function fixRequest(checks: CheckResult | undefined, review: ReviewResult | undefined): string {
  const parts = [tr('O portão de qualidade encontrou problemas no seu trabalho. Corrija o que for preciso (sem git push) e termine com um resumo do que mudou.')];
  if (checks && !checks.ok) parts.push(`${tr('Checagens falharam. Fim da saída:')}\n${checks.tail}`);
  if (review && !('error' in review) && !review.ok) parts.push(`${tr('Revisão do diff:')}\n${review.findings}`);
  return cut(parts.join('\n\n'), CHAT_TEXT_MAX);
}

/** Relatório para o VBoards (até REPORT_MAX): branch, checagens, revisão e resumo do agente. */
export function gateReport(r: { branch: string; checks?: CheckResult; qa?: QaResult; review?: ReviewResult; summary?: string; retried?: boolean; missing?: string[] }): string {
  const checks = !r.checks ? tr('Checagens: sem vboards.check.') : r.checks.ok ? tr('Checagens: OK.') : `${tr('Checagens: FALHARAM.')}\n${cut(r.checks.tail, 500)}`;
  const review = !r.review
    ? tr('Revisão: sem mudanças no diff.')
    : 'error' in r.review
      ? tr('Revisão ({0}): indisponível ({1}).', [r.review.by, r.review.error])
      : `${tr('Revisão ({0}): {1}', [r.review.by, r.review.ok ? 'OK' : tr('PROBLEMAS')])}${r.review.ok ? '' : `\n${cut(r.review.findings, 600)}`}`;
  const qa = r.qa ? [r.qa.ok ? tr('QA visual: {0} captura(s).', [r.qa.shots.length]) : `${tr('QA visual: FALHOU (só aviso, não reprova).')}\n${cut(r.qa.tail, 300)}`] : [];
  const missing = r.missing?.length ? [tr('vboards.copy: não existem na pasta (não copiados): {0}.', [r.missing.join(', ')])] : [];
  const head = [tr('Branch: {0} (falta revisar e Juntar no Habblaud).', [r.branch]), checks, ...qa, review, ...missing, ...(r.retried ? [tr('O erro voltou uma vez ao agente para correção.')] : [])].join('\n');
  const summary = r.summary?.trim() ? `\n${tr('Resumo do agente:')}\n${r.summary.trim()}` : '';
  return cut(maskSecrets(`${head}${summary}`), REPORT_MAX);
}
