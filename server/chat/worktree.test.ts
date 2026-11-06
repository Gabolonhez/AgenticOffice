import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorktreeOps, findSecrets, noPushEnv, riskyFiles } from './worktree';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hb-wt-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.hooksPath', join(dir, '.no-hooks'));
  git(dir, 'config', 'core.autocrlf', 'false'); // o global do Windows trocaria \n por \r\n no checkout
  writeFileSync(join(dir, 'a.txt'), 'um\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'inicio');
  return dir;
}

const setup = () => {
  const r = repo();
  const data = mkdtempSync(join(tmpdir(), 'hb-wt-data-'));
  return { r, data, ops: createWorktreeOps(data) };
};

async function made(ops: ReturnType<typeof createWorktreeOps>, r: string) {
  const w = await ops.create(r, 'chat:1', 'Dev Ana');
  if ('error' in w) throw new Error(w.error);
  git(w.path, 'config', 'user.email', 't@t');
  git(w.path, 'config', 'user.name', 't');
  return w;
}

describe('chat: cópia isolada (git worktree)', () => {
  it('cria fora do repo, num branch próprio, a partir do HEAD', async () => {
    const { r, data, ops } = setup();
    const w = await made(ops, r);
    expect(w.branch).toMatch(/^agentic\/dev-ana-[0-9a-f]{6}$/);
    expect(w.path.startsWith(join(data, 'chat', 'worktrees'))).toBe(true);
    expect(w.base).toBe(git(r, 'rev-parse', 'HEAD'));
    expect(existsSync(join(w.path, 'a.txt'))).toBe(true);
  });

  it('pasta sem git devolve erro', async () => {
    const { data, ops } = setup();
    const plain = mkdtempSync(join(tmpdir(), 'hb-wt-plain-'));
    expect(await ops.create(plain, 'chat:2', 'x')).toEqual({ error: 'A pasta não é um repositório git.' });
    void data;
  });

  it('resumo conta arquivos e commits desde a base', async () => {
    const { r, ops } = setup();
    const w = await made(ops, r);
    writeFileSync(join(w.path, 'b.txt'), 'novo\n');
    git(w.path, 'add', '-A');
    git(w.path, 'commit', '-q', '-m', 'b');
    const s = await ops.summary(w);
    expect(s).toMatchObject({ files: 1, commits: 1, added: 1 });
    expect(s.stat).toContain('b.txt');
  });

  it('juntar commita o pendente da cópia e faz merge no projeto, mantendo a cópia', async () => {
    const { r, ops } = setup();
    const w = await made(ops, r);
    writeFileSync(join(w.path, 'c.txt'), 'c\n');
    expect(await ops.merge(r, w, 'trabalho do agente')).toEqual({ ok: true });
    expect(readFileSync(join(r, 'c.txt'), 'utf8')).toBe('c\n');
    expect(existsSync(w.path)).toBe(true);
    expect(git(r, 'branch', '--list', w.branch)).toContain(w.branch);
  });

  it('projeto com mudanças sem commit: não junta e não mexe em nada', async () => {
    const { r, ops } = setup();
    const w = await made(ops, r);
    writeFileSync(join(w.path, 'c.txt'), 'c\n');
    writeFileSync(join(r, 'a.txt'), 'sujo\n');
    const head = git(r, 'rev-parse', 'HEAD');
    expect(await ops.merge(r, w, 'm')).toEqual({ ok: false, reason: 'A pasta do projeto tem mudanças sem commit; faça commit ou guarde antes de juntar.' });
    expect(git(r, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('conflito: aborta e o projeto fica como estava', async () => {
    const { r, ops } = setup();
    const w = await made(ops, r);
    writeFileSync(join(w.path, 'a.txt'), 'da copia\n');
    writeFileSync(join(r, 'a.txt'), 'do projeto\n');
    git(r, 'commit', '-q', '-am', 'projeto mudou');
    const head = git(r, 'rev-parse', 'HEAD');
    expect(await ops.merge(r, w, 'm')).toEqual({ ok: false, reason: 'Conflito ao juntar; nada foi alterado no projeto.' });
    expect(git(r, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(r, 'status', '--porcelain')).toBe('');
  });

  it('descartar remove a cópia e o branch', async () => {
    const { r, ops } = setup();
    const w = await made(ops, r);
    expect(await ops.discard(r, w)).toEqual({ ok: true });
    expect(existsSync(w.path)).toBe(false);
    expect(git(r, 'branch', '--list', w.branch)).toBe('');
  });
});

describe('trava de push no env (qualquer provedor)', () => {
  it('git push falha, o fetch segue; soma às entradas GIT_CONFIG_* que já houver', () => {
    expect(noPushEnv({ GIT_CONFIG_COUNT: '2' })).toEqual({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'url.habblaud-no-push://.pushInsteadOf', GIT_CONFIG_VALUE_2: '' });
    const dir = repo();
    const bare = mkdtempSync(join(tmpdir(), 'hb-wt-bare-'));
    git(bare, 'init', '-q', '--bare');
    git(dir, 'remote', 'add', 'origin', bare);
    const env = { ...process.env, ...noPushEnv({}) };
    expect(() => execFileSync('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: dir, env, stdio: 'pipe' })).toThrow();
    expect(() => execFileSync('git', ['push', '-q', bare, 'HEAD:main'], { cwd: dir, env, stdio: 'pipe' })).toThrow();
    expect(() => execFileSync('git', ['fetch', '-q', 'origin'], { cwd: dir, env, stdio: 'pipe' })).not.toThrow();
  });
});

describe('diff da cópia para o revisor', () => {
  it('inclui os arquivos novos (intent-to-add) e as mudanças, contra a base', async () => {
    const r = repo();
    const ops = createWorktreeOps(mkdtempSync(join(tmpdir(), 'hb-wt-data-')));
    const w = await ops.create(r, 'chat:1', 'lista');
    if ('error' in w) throw new Error(w.error);
    writeFileSync(join(w.path, 'novo.txt'), 'oi\n');
    writeFileSync(join(w.path, 'a.txt'), 'dois\n');
    const diff = await ops.diff(w);
    expect(diff).toContain('novo.txt');
    expect(diff).toContain('+dois');
  });
});

describe('vboards.copy: arquivos copiados para a cópia', () => {
  async function withCopy() {
    const { r, ops } = setup();
    mkdirSync(join(r, 'apps', 'web'), { recursive: true });
    writeFileSync(join(r, '.env'), 'SEGREDO=1\n');
    writeFileSync(join(r, 'apps', 'web', '.env.local'), 'X=2\n');
    writeFileSync(join(r, 'a.txt'), 'local sem commit\n');
    git(r, 'config', 'vboards.copy', '.env, apps/web/.env.local, falta.env, a.txt, ../fora');
    const w = await made(ops, r);
    git(r, 'checkout', '-q', '--', 'a.txt');
    // O Juntar exige o projeto sem mudanças: num projeto de verdade o .env é ignorado; aqui, sai da pasta.
    const clean = () => {
      rmSync(join(r, '.env'));
      rmSync(join(r, 'apps'), { recursive: true });
    };
    return { r, ops, w, clean };
  }

  it('copia os que existem, lista os que faltam e não troca o que veio do checkout', async () => {
    const { w } = await withCopy();
    expect(w.copied).toEqual(['.env', 'apps/web/.env.local']);
    expect(w.missing).toEqual(['falta.env']);
    expect(readFileSync(join(w.path, '.env'), 'utf8')).toBe('SEGREDO=1\n');
    expect(readFileSync(join(w.path, 'a.txt'), 'utf8')).toBe('um\n');
  });

  it('fora do diff do revisor e do commit do Juntar; o resto junta normal', async () => {
    const { r, ops, w, clean } = await withCopy();
    writeFileSync(join(w.path, 'c.txt'), 'c\n');
    const diff = await ops.diff(w);
    expect(diff).toContain('c.txt');
    expect(diff).not.toContain('SEGREDO');
    clean();
    expect(await ops.merge(r, w, 'trabalho')).toEqual({ ok: true });
    expect(git(r, 'show', '--name-only', '--format=', 'HEAD^2')).toBe('c.txt');
    expect(git(r, 'ls-files')).not.toContain('.env');
  });

  it('só os copiados, sem outra mudança: junta sem commit vazio', async () => {
    const { r, ops, w, clean } = await withCopy();
    clean();
    expect(await ops.merge(r, w, 'nada')).toEqual({ ok: true });
  });

  it('o agente commitou o .env copiado: não junta', async () => {
    const { r, ops, w, clean } = await withCopy();
    clean();
    git(w.path, 'add', '-f', '.env');
    git(w.path, 'commit', '-q', '-m', 'ops');
    const head = git(r, 'rev-parse', 'HEAD');
    expect(await ops.merge(r, w, 'm')).toEqual({ ok: false, reason: expect.stringContaining('.env') });
    expect(git(r, 'rev-parse', 'HEAD')).toBe(head);
  });
});


describe('chat: cópia isolada a partir do remoto (vboards.ship)', () => {
  /** Um "origin" (clone bare) com um commit a mais que o checkout local não tem, e um commit local que o origin não tem. */
  function withOrigin(ship: string) {
    const up = repo();
    const bare = mkdtempSync(join(tmpdir(), 'hb-wt-bare-'));
    git(bare, 'clone', '-q', '--bare', up, '.');
    const local = mkdtempSync(join(tmpdir(), 'hb-wt-local-'));
    git(local, 'clone', '-q', bare, '.');
    for (const [k, v] of [['user.email', 't@t'], ['user.name', 't'], ['core.hooksPath', join(local, '.no-hooks')], ['core.autocrlf', 'false'], ['vboards.ship', ship]]) git(local, 'config', k, v);
    writeFileSync(join(up, 'novo.txt'), 'remoto\n');
    git(up, 'add', '-A');
    git(up, 'commit', '-q', '-m', 'no remoto');
    git(up, 'push', '-q', bare, 'main');
    writeFileSync(join(local, 'local.txt'), 'local\n');
    git(local, 'add', '-A');
    git(local, 'commit', '-q', '-m', 'só local');
    return { local, bare, ops: createWorktreeOps(mkdtempSync(join(tmpdir(), 'hb-wt-data-'))) };
  }

  it('ship off: nasce do HEAD local, como antes', async () => {
    const { local, ops } = withOrigin('off');
    const w = await made(ops, local);
    expect(w.base).toBe(git(local, 'rev-parse', 'HEAD'));
  });

  it('ship pr: busca o origin e nasce de origin/main, sem seguir a base', async () => {
    const { local, bare, ops } = withOrigin('pr');
    const w = await made(ops, local);
    expect(w.base).toBe(git(bare, 'rev-parse', 'main'));
    expect(existsSync(join(w.path, 'novo.txt'))).toBe(true);
    expect(existsSync(join(w.path, 'local.txt'))).toBe(false);
    expect(() => git(w.path, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();
  });

  it('fetch que falha: erro claro, nada criado', async () => {
    const { local, ops } = withOrigin('pr');
    git(local, 'config', 'vboards.remote', 'nao-existe');
    expect(await ops.create(local, 'chat:9', 'x')).toEqual({ error: expect.stringContaining('git fetch nao-existe main') });
  });
});

describe('chat: Subir (commit, push e varredura)', () => {
  const TOKEN = `github_pat_${'B'.repeat(40)}`;

  async function shipped() {
    const { r, ops } = setup();
    const w = await made(ops, r);
    writeFileSync(join(w.path, 'novo.txt'), 'ok\n');
    const c = await ops.commit(w, 'feat: novo');
    if (!c.ok) throw new Error(c.reason);
    const bare = mkdtempSync(join(tmpdir(), 'hb-wt-bare-'));
    git(bare, 'init', '-q', '--bare');
    return { r, ops, w, sha: c.sha, bare };
  }

  it('commit devolve o HEAD da cópia e recusa arquivo copiado commitado', async () => {
    const { w, sha } = await shipped();
    expect(sha).toBe(git(w.path, 'rev-parse', 'HEAD'));
    expect(git(w.path, 'log', '-1', '--format=%s')).toBe('feat: novo');
    const { r, ops } = setup();
    writeFileSync(join(r, '.env'), 'X=1\n');
    git(r, 'config', 'vboards.copy', '.env');
    const w2 = await made(ops, r);
    git(w2.path, 'add', '-f', '.env');
    git(w2.path, 'commit', '-q', '-m', 'vazou');
    expect((await ops.commit(w2, 'x')).ok).toBe(false);
  });

  it('push para um --bare local: só o branch agentic/*, no SHA aprovado', async () => {
    const { ops, w, sha, bare } = await shipped();
    expect(await ops.push(w, { url: bare, sha, token: TOKEN, baseBranch: 'main' })).toEqual({ ok: true });
    expect(git(bare, 'rev-parse', `refs/heads/${w.branch}`)).toBe(sha);
    expect(() => git(bare, 'rev-parse', '--verify', '-q', 'refs/heads/main')).toThrow();
    // De novo, o mesmo SHA: nada muda (sem force).
    expect(await ops.push(w, { url: bare, sha, token: TOKEN, baseBranch: 'main' })).toEqual({ ok: true });
  });

  it('recusa branch fora de agentic/, a base e SHA que não é o HEAD', async () => {
    const { ops, w, sha, bare } = await shipped();
    const r1 = await ops.push({ ...w, branch: 'main' }, { url: bare, sha, token: TOKEN, baseBranch: 'main' });
    expect(r1.ok).toBe(false);
    expect((r1 as { reason: string }).reason).toMatch(/agentic\//);
    expect((await ops.push(w, { url: bare, sha, token: TOKEN, baseBranch: w.branch })).ok).toBe(false);
    const r3 = await ops.push(w, { url: bare, sha: 'c'.repeat(40), token: TOKEN, baseBranch: 'main' });
    expect((r3 as { reason: string }).reason).toMatch(/mudou depois da aprovação/);
    expect(git(bare, 'for-each-ref')).toBe('');
  });

  it('recusa segredo no diff (.env, token) sem mostrar o valor', async () => {
    const { r, ops } = setup();
    const w = await made(ops, r);
    const secret = `ghp_${'x'.repeat(36)}`;
    writeFileSync(join(w.path, 'config.ts'), `export const t = '${secret}';\n`);
    writeFileSync(join(w.path, '.env.production'), 'A=1\n');
    const c = await ops.commit(w, 'x');
    if (!c.ok) throw new Error(c.reason);
    const bare = mkdtempSync(join(tmpdir(), 'hb-wt-bare-'));
    git(bare, 'init', '-q', '--bare');
    const p = await ops.push(w, { url: bare, sha: c.sha, token: TOKEN, baseBranch: 'main' });
    expect(p.ok).toBe(false);
    const reason = (p as { reason: string }).reason;
    expect(reason).toMatch(/segredo/);
    expect(reason).toContain('config.ts');
    expect(reason).toContain('.env.production');
    expect(reason).not.toContain(secret);
    expect(git(bare, 'for-each-ref')).toBe('');
  });

  it('findSecrets e riskyFiles', () => {
    expect(findSecrets(['.env.example', 'src/a.ts'], '+++ b/src/a.ts\n+const k = 1')).toEqual([]);
    expect(findSecrets(['app/firebase-adminsdk-abc.json', 'id_rsa'], '')).toHaveLength(2);
    const diff = ['+++ b/k.pem', '+-----BEGIN RSA PRIVATE KEY-----', '+++ b/a.ts', `+x = "AKIA${'A'.repeat(16)}"`, `+y = "sk-ant-${'a'.repeat(30)}"`, `+z = "xoxb-${'1'.repeat(12)}"`, `-old = "github_pat_${'q'.repeat(30)}"`].join('\n');
    const found = findSecrets(['k.pem', 'a.ts'], diff);
    expect(found.some((x) => x.startsWith('k.pem'))).toBe(true);
    expect(found.filter((x) => x.startsWith('a.ts'))).toHaveLength(3); // linha removida não conta
    expect(riskyFiles(['.husky/pre-push', '.github/workflows/deploy.yml', '.githooks/x', 'src/.github/workflows/y', 'a.ts'])).toEqual(['.husky/pre-push', '.github/workflows/deploy.yml', '.githooks/x']);
  });

  it('o token vai só no env (extraheader), nunca no argv; hooks e credential helper desligados', async () => {
    const seen: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const sha = 'd'.repeat(40);
    const fake = async (args: string[], _cwd: string, opts?: { env?: Record<string, string> }) => {
      seen.push({ args, ...(opts?.env ? { env: opts.env } : {}) });
      return args[0] === 'rev-parse' ? { code: 0, out: sha } : { code: 0, out: '' };
    };
    const ops = createWorktreeOps(mkdtempSync(join(tmpdir(), 'hb-wt-data-')), fake);
    expect(await ops.push({ path: '/w', branch: 'agentic/x-1', base: 'b'.repeat(40) }, { url: 'https://github.com/acme/r.git', sha, token: TOKEN, baseBranch: 'main' })).toEqual({ ok: true });
    const push = seen.find((s) => s.args[0] === 'push')!;
    expect(push.args).toEqual(['push', '--no-verify', '--porcelain', 'https://github.com/acme/r.git', `${sha}:refs/heads/agentic/x-1`]);
    expect(seen.every((s) => !s.args.join(' ').includes('B'.repeat(20)))).toBe(true);
    const env = push.env!;
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GCM_INTERACTIVE).toBe('never');
    const pairs = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
    expect(Buffer.from(pairs['http.https://github.com/.extraheader'].split(' ').pop()!, 'base64').toString()).toBe(`x-access-token:${TOKEN}`);
    expect(pairs['credential.helper']).toBe('');
    expect(pairs['core.hooksPath']).toBeTruthy();
  });

  it('push que falha não devolve o token na mensagem', async () => {
    const sha = 'd'.repeat(40);
    const fake = async (args: string[]) => (args[0] === 'rev-parse' ? { code: 0, out: sha } : args[0] === 'push' ? { code: 128, out: `fatal: auth ${TOKEN} recusado` } : { code: 0, out: '' });
    const ops = createWorktreeOps(mkdtempSync(join(tmpdir(), 'hb-wt-data-')), fake);
    const r = await ops.push({ path: '/w', branch: 'agentic/x-1', base: 'b'.repeat(40) }, { url: 'u', sha, token: TOKEN, baseBranch: 'main' });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).not.toContain(TOKEN);
  });

  it('fast-forward do checkout local: só limpo e na base', async () => {
    const { r, ops, w, sha, bare } = await shipped();
    git(r, 'remote', 'add', 'origin', bare);
    git(r, 'push', '-q', 'origin', 'main');
    // O "merge no GitHub": a base do remoto avança para o commit da cópia.
    git(w.path, 'push', '-q', bare, `${sha}:refs/heads/main`);
    expect(await ops.fastForward(r, 'origin', 'main')).toBeUndefined();
    expect(git(r, 'rev-parse', 'HEAD')).toBe(sha);
    writeFileSync(join(r, 'sujo.txt'), 'x');
    expect(await ops.fastForward(r, 'origin', 'main')).toMatch(/sem commit/);
  });
});
