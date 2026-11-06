// Cópia isolada do agente: um git worktree num branch próprio, fora do projeto (<dataDir>/chat/worktrees/). O agente
// trabalha lá; ao fim o usuário junta (merge no projeto) ou descarta. Juntar nunca mexe num projeto com mudanças sem
// commit, e um conflito volta tudo como estava.
// vboards.copy (git config da pasta): os arquivos listados (ex.: .env) são copiados da pasta para a cópia nova, se
// existirem e não vierem do checkout. Nunca entram no diff do revisor nem no commit do Juntar (pathspec exclude), e o
// Juntar recusa um trabalho que os tenha commitado.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tr } from '../../shared/i18n';
import { parseFolderConfig } from '../vboards/vboards';
import type { WorktreeOps } from './types';

type Git = (args: string[], cwd: string, opts?: { env?: Record<string, string>; timeout?: number }) => Promise<{ code: number; out: string }>;

/** git fetch sem nunca pedir senha (nem o terminal, nem o Git Credential Manager), com prazo. */
export const FETCH_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
export const FETCH_TIMEOUT_MS = 60_000;

/**
 * Trava de push para qualquer provedor (best effort): pushInsteadOf com prefixo vazio reescreve todo endereço de push
 * para um esquema que não existe, então `git push` falha e o fetch segue normal. Vale para o processo do agente e os
 * shells dele (o env é herdado); soma às entradas GIT_CONFIG_* que já houver.
 */
export function noPushEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  return { GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'url.habblaud-no-push://.pushInsteadOf', [`GIT_CONFIG_VALUE_${n}`]: '' };
}

const realGit: Git = (args, cwd, opts) =>
  new Promise((ok) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      ok({ code, out: `${stdout}${err ? stderr : ''}`.trim() });
    });
  });

/** Pathspecs que deixam de fora os arquivos copiados (literal: o nome não é padrão). */
const literal = (p: string): string => `:(literal)${p.replace(/\\/g, '/')}`;
const keepOut = (copied: readonly string[] | undefined): string[] => (copied ?? []).map((p) => `:(exclude,literal)${p.replace(/\\/g, '/')}`);

/** Copia os arquivos do vboards.copy da pasta para a cópia: os que já vieram do checkout ficam; os que faltam, listados. */
function copyListed(repo: string, path: string, list: readonly string[]): { copied: string[]; missing: string[] } {
  const copied: string[] = [];
  const missing: string[] = [];
  for (const rel of list) {
    const dst = join(path, rel);
    try {
      if (!statSync(join(repo, rel)).isFile()) throw new Error('not a file');
      if (existsSync(dst)) continue;
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(join(repo, rel), dst);
      copied.push(rel);
    } catch {
      missing.push(rel);
    }
  }
  return { copied, missing };
}

function slug(label: string): string {
  const s = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return s || 'agente';
}

/** `git fetch <remote> <base>` sem prompt e com prazo; devolve `<remote>/<base>` (base vazia = o HEAD do remoto, senão main). */
async function remoteBase(git: Git, repo: string, remote: string, base: string | undefined): Promise<string | { error: string }> {
  let b = base;
  if (!b) {
    const sym = await git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], repo);
    b = sym.code === 0 && sym.out.startsWith(`${remote}/`) ? sym.out.slice(remote.length + 1) : 'main';
  }
  const f = await git(['fetch', '--no-tags', remote, b], repo, { env: FETCH_ENV, timeout: FETCH_TIMEOUT_MS });
  if (f.code !== 0) return { error: tr('vboards.ship ligado, mas o git fetch {0} {1} falhou: {2}', [remote, b, f.out || tr('sem resposta')]) };
  return `${remote}/${b}`;
}

export function createWorktreeOps(dataDir: string, git: Git = realGit): WorktreeOps {
  return {
    async create(repo, agentId, label) {
      if ((await git(['rev-parse', '--show-toplevel'], repo)).code !== 0) return { error: tr('A pasta não é um repositório git.') };
      const cfg = parseFolderConfig((await git(['config', '--get-regexp', '^vboards\\.'], repo)).out);
      // vboards.ship ligado: a cópia nasce do remoto atualizado (a base do PR), não do HEAD local.
      const start = cfg.ship === 'off' ? 'HEAD' : await remoteBase(git, repo, cfg.remote ?? 'origin', cfg.base);
      if (typeof start !== 'string') return start;
      const head = await git(['rev-parse', '--verify', `${start}^{commit}`], repo);
      if (head.code !== 0) return { error: tr('O repositório ainda não tem nenhum commit.') };
      const tag = randomBytes(3).toString('hex');
      const branch = `agentic/${slug(label)}-${tag}`;
      const root = join(dataDir, 'chat', 'worktrees');
      mkdirSync(root, { recursive: true });
      const path = join(root, `${agentId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${tag}`);
      // --no-track: o branch do agente nunca segue a base do remoto (um push não cai nela).
      const add = await git(['worktree', 'add', '--no-track', '-b', branch, path, head.out], repo);
      if (add.code !== 0) return { error: tr('Não deu para criar a cópia isolada: {0}', [add.out]) };
      const { copied, missing } = copyListed(repo, path, cfg.copy);
      return { path, branch, base: head.out, ...(copied.length ? { copied } : {}), ...(missing.length ? { missing } : {}) };
    },

    async summary(w) {
      const numstat = await git(['diff', '--numstat', w.base], w.path);
      let files = 0;
      let added = 0;
      let removed = 0;
      for (const line of numstat.out.split(/\r?\n/).filter(Boolean)) {
        const [a, r] = line.split('\t');
        files++;
        added += Number(a) || 0;
        removed += Number(r) || 0;
      }
      const commits = Number((await git(['rev-list', '--count', `${w.base}..HEAD`], w.path)).out) || 0;
      const stat = (await git(['diff', '--stat', w.base], w.path)).out;
      return { files, added, removed, commits, stat };
    },

    async diff(w) {
      // intent-to-add: os arquivos novos entram no diff sem ir para o índice de verdade.
      await git(['add', '-A', '-N', '--', '.', ...keepOut(w.copied)], w.path);
      return (await git(['diff', w.base], w.path)).out;
    },

    async merge(repo, w, message) {
      if ((await git(['status', '--porcelain'], repo)).out) {
        return { ok: false, reason: tr('A pasta do projeto tem mudanças sem commit; faça commit ou guarde antes de juntar.') };
      }
      // O agente commitou um arquivo copiado (ex.: o .env): não leva para o projeto.
      if (w.copied?.length && w.base) {
        const leaked = (await git(['diff', '--name-only', w.base, 'HEAD', '--', ...w.copied.map(literal)], w.path)).out;
        if (leaked) return { ok: false, reason: tr('O trabalho commitou arquivos copiados para a cópia ({0}); tire-os do commit antes de juntar.', [leaked.split(/\r?\n/).join(', ')]) };
      }
      await git(['add', '-A', '--', '.', ...keepOut(w.copied)], w.path);
      // Só o que foi para o índice: os copiados continuam soltos na cópia.
      if ((await git(['diff', '--cached', '--quiet'], w.path)).code !== 0) {
        const c = await git(['commit', '-q', '-m', message], w.path);
        if (c.code !== 0) return { ok: false, reason: tr('Não deu para commitar o trabalho da cópia: {0}', [c.out]) };
      }
      const m = await git(['merge', '--no-ff', '--no-edit', w.branch], repo);
      if (m.code !== 0) {
        await git(['merge', '--abort'], repo);
        return { ok: false, reason: tr('Conflito ao juntar; nada foi alterado no projeto.') };
      }
      return { ok: true };
    },

    async discard(repo, w) {
      const rm = await git(['worktree', 'remove', '--force', w.path], repo);
      if (rm.code !== 0) return { ok: false, reason: rm.out };
      await git(['branch', '-D', w.branch], repo);
      return { ok: true };
    },
  };
}
