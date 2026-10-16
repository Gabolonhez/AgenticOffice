// Cópia isolada do agente: um git worktree num branch próprio, fora do projeto (<dataDir>/chat/worktrees/). O agente
// trabalha lá; ao fim o usuário junta (merge no projeto) ou descarta. Juntar nunca mexe num projeto com mudanças sem
// commit, e um conflito volta tudo como estava.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tr } from '../../shared/i18n';
import type { WorktreeOps } from './types';

type Git = (args: string[], cwd: string) => Promise<{ code: number; out: string }>;

const realGit: Git = (args, cwd) =>
  new Promise((ok) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      ok({ code, out: `${stdout}${err ? stderr : ''}`.trim() });
    });
  });

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

export function createWorktreeOps(dataDir: string, git: Git = realGit): WorktreeOps {
  return {
    async create(repo, agentId, label) {
      if ((await git(['rev-parse', '--show-toplevel'], repo)).code !== 0) return { error: tr('A pasta não é um repositório git.') };
      const head = await git(['rev-parse', 'HEAD'], repo);
      if (head.code !== 0) return { error: tr('O repositório ainda não tem nenhum commit.') };
      const tag = randomBytes(3).toString('hex');
      const branch = `agentic/${slug(label)}-${tag}`;
      const root = join(dataDir, 'chat', 'worktrees');
      mkdirSync(root, { recursive: true });
      const path = join(root, `${agentId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${tag}`);
      const add = await git(['worktree', 'add', '-b', branch, path, 'HEAD'], repo);
      if (add.code !== 0) return { error: tr('Não deu para criar a cópia isolada: {0}', [add.out]) };
      return { path, branch, base: head.out };
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

    async merge(repo, w, message) {
      if ((await git(['status', '--porcelain'], repo)).out) {
        return { ok: false, reason: tr('A pasta do projeto tem mudanças sem commit; faça commit ou guarde antes de juntar.') };
      }
      await git(['add', '-A'], w.path);
      if ((await git(['status', '--porcelain'], w.path)).out) {
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
