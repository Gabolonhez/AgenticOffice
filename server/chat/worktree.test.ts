import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorktreeOps, noPushEnv } from './worktree';

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

