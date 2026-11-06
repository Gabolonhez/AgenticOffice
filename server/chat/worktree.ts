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
import { maskSecrets } from '../../shared/activity';
import { tr } from '../../shared/i18n';
import { parseFolderConfig } from '../vboards/vboards';
import type { ShipWorktreeOps } from './types';

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

export function createWorktreeOps(dataDir: string, git: Git = realGit): ShipWorktreeOps {
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

    commit: (w, message) => commitCopy(git, w, message),

    async merge(repo, w, message) {
      if ((await git(['status', '--porcelain'], repo)).out) {
        return { ok: false, reason: tr('A pasta do projeto tem mudanças sem commit; faça commit ou guarde antes de juntar.') };
      }
      const c = await commitCopy(git, w, message);
      if (!c.ok) return c;
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

    async remoteInfo(repo, remote) {
      const r = await git(['remote', 'get-url', remote], repo);
      const sym = await git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], repo);
      return {
        ...(r.code === 0 && r.out ? { url: r.out.split(/\r?\n/)[0] } : {}),
        ...(sym.code === 0 && sym.out.startsWith(`${remote}/`) ? { head: sym.out.slice(remote.length + 1) } : {}),
      };
    },

    async changedFiles(w, sha) {
      const r = await git(['diff', '--name-only', w.base, sha], w.path);
      return r.code === 0 ? r.out.split(/\r?\n/).filter(Boolean) : [];
    },

    push: (w, o) => pushCopy(git, w, o),

    async fastForward(repo, remote, base) {
      if ((await git(['status', '--porcelain'], repo)).out) return tr('O checkout local tem mudanças sem commit: atualize à mão (git pull).');
      const cur = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).out;
      if (cur !== base) return tr('O checkout local está em {0}, não em {1}: atualize à mão.', [cur || '?', base]);
      const f = await git(['fetch', '--no-tags', remote, base], repo, { env: FETCH_ENV, timeout: FETCH_TIMEOUT_MS });
      if (f.code !== 0) return tr('Não deu para buscar {0}/{1} no checkout local: atualize à mão.', [remote, base]);
      const m = await git(['merge', '--ff-only', `${remote}/${base}`], repo);
      return m.code === 0 ? undefined : tr('O checkout local não avança sem merge (fast-forward): atualize à mão.');
    },
  };
}

/** A checagem do Juntar (arquivo copiado commitado) + o commit do que está na cópia; devolve o HEAD. */
async function commitCopy(git: Git, w: { path: string; base?: string; copied?: string[] }, message: string): Promise<{ ok: true; sha: string } | { ok: false; reason: string }> {
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
  const head = await git(['rev-parse', 'HEAD'], w.path);
  return head.code === 0 ? { ok: true, sha: head.out } : { ok: false, reason: tr('Não deu para ler o commit da cópia.') };
}

export const PUSH_TIMEOUT_MS = 120_000;

/** Arquivos que nunca sobem (nome): .env (fora os modelos), chaves privadas e contas de serviço do Firebase. */
const secretFiles = (): Array<[RegExp, string]> => [
  [/(^|\/)\.env(\.(?!example$|sample$|template$)[^/]*)?$/i, '.env'],
  [/(^|\/)[^/]*adminsdk[^/]*\.json$/i, 'adminsdk.json'],
  [/(^|\/)(id_rsa|id_ed25519|id_ecdsa)$|\.(pem|p12|pfx|key)$/i, tr('chave privada')],
];
/** Segredos no conteúdo (só nas linhas adicionadas). */
const secretText = (): Array<[RegExp, string]> => [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, tr('chave privada (PEM)')],
  [/\bghp_[A-Za-z0-9]{36}\b|\bgh[ousr]_[A-Za-z0-9]{36}\b/, tr('token do GitHub')],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}/, tr('token do GitHub')],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, tr('chave de API (sk-)')],
  [/\bAKIA[0-9A-Z]{16}\b/, tr('chave da AWS')],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, tr('token do Slack')],
];

/** Segredos num diff (`git diff`): `arquivo (tipo)`, sem nunca o valor. */
export function findSecrets(names: readonly string[], diff: string): string[] {
  const out = new Set<string>();
  for (const n of names) for (const [re, kind] of secretFiles()) if (re.test(n.replace(/\\/g, '/'))) out.add(`${n} (${kind})`);
  const text = secretText();
  let file = '';
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) file = line.replace(/^\+\+\+ (b\/)?/, '');
    else if (line.startsWith('+')) for (const [re, kind] of text) if (re.test(line)) out.add(`${file} (${kind})`);
  }
  return [...out];
}

/** Hooks e CI mudados (rodam com a credencial do dono): o cartão destaca. */
export const riskyFiles = (names: readonly string[]): string[] => names.filter((n) => /^(\.husky|\.githooks|\.github\/workflows)\//.test(n.replace(/\\/g, '/')));

/**
 * Credencial do push só pelo env (nunca no argv): http.<github>.extraheader com o token, os helpers de credencial
 * zerados (nada de Git Credential Manager) e hooks desligados (um .husky do agente não roda com o token no env).
 */
export function pushEnv(token: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  const pairs: Array<[string, string]> = [
    ['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`],
    ['credential.helper', ''],
    ['core.hooksPath', '/dev/null/habblaud-no-hooks'],
  ];
  const out: Record<string, string> = { ...FETCH_ENV, GIT_CONFIG_COUNT: String(n + pairs.length) };
  pairs.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${n + i}`] = k;
    out[`GIT_CONFIG_VALUE_${n + i}`] = v;
  });
  return out;
}

/**
 * Push do branch da cópia, só dele: `agentic/*`, nunca a base, sem force, só o SHA aprovado (o HEAD da cópia) e só
 * depois da varredura de segredos no que sobe. O token nunca vai no argv nem volta na mensagem.
 */
async function pushCopy(git: Git, w: { path: string; branch: string; base: string }, o: { url: string; sha: string; token: string; baseBranch: string }): Promise<{ ok: true } | { ok: false; reason: string }> {
  const branch = w.branch;
  if (!/^agentic\/[\w.-]{1,100}$/.test(branch) || branch.includes('..') || branch === o.baseBranch) return { ok: false, reason: tr('Push recusado: só branches agentic/* sobem, nunca a base ({0}).', [branch]) };
  if (!/^[0-9a-f]{40}$/.test(o.sha)) return { ok: false, reason: tr('Push recusado: SHA inválido.') };
  const head = (await git(['rev-parse', 'HEAD'], w.path)).out;
  if (head !== o.sha) return { ok: false, reason: tr('A cópia mudou depois da aprovação (HEAD {0}, aprovado {1}): aprove de novo.', [head.slice(0, 12), o.sha.slice(0, 12)]) };
  const names = await git(['diff', '--name-only', w.base, o.sha], w.path);
  const diff = await git(['diff', w.base, o.sha], w.path);
  if (names.code !== 0 || diff.code !== 0) return { ok: false, reason: tr('Push recusado: não deu para varrer o diff atrás de segredos.') };
  const secrets = findSecrets(names.out.split(/\r?\n/).filter(Boolean), diff.out);
  if (secrets.length) return { ok: false, reason: tr('Push recusado: o diff tem o que parece segredo: {0}. Tire do commit (e troque a chave, se for real) antes de subir.', [secrets.slice(0, 10).join(', ')]) };
  const p = await git(['push', '--no-verify', '--porcelain', o.url, `${o.sha}:refs/heads/${branch}`], w.path, { env: pushEnv(o.token), timeout: PUSH_TIMEOUT_MS });
  if (p.code !== 0) return { ok: false, reason: tr('O push falhou: {0}', [maskSecrets(p.out).replaceAll(o.token, '***').slice(0, 1000) || tr('sem resposta')]) };
  return { ok: true };
}
