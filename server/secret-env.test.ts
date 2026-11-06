import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runChecks } from './chat/gate';
import { createWorktreeOps } from './chat/worktree';
import { SECRET_ENV_VARS, takeSecrets, withoutSecrets } from './secret-env';

const TOKEN = `github_pat_${'S'.repeat(40)}`;
afterEach(() => vi.unstubAllEnvs());

describe('segredos do Habblaud fora dos processos filhos', () => {
  it('withoutSecrets tira todos; takeSecrets devolve os valores e limpa o env', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', HABBLAUD_GITHUB_TOKEN: TOKEN, HABBLAUD_VBOARDS_TOKEN: 'vb_x' };
    expect(withoutSecrets(env)).toEqual({ PATH: '/bin' });
    expect(env.HABBLAUD_GITHUB_TOKEN).toBe(TOKEN);
    expect(takeSecrets(env)).toEqual({ HABBLAUD_GITHUB_TOKEN: TOKEN, HABBLAUD_VBOARDS_TOKEN: 'vb_x' });
    expect(env).toEqual({ PATH: '/bin' });
    expect(SECRET_ENV_VARS).toContain('HABBLAUD_GITHUB_TOKEN');
  });

  it('o vboards.check (e o QA, que usa o mesmo caminho) não vê o token', async () => {
    vi.stubEnv('HABBLAUD_GITHUB_TOKEN', TOKEN);
    const r = await runChecks(`node -e "console.log('tok=' + (process.env.HABBLAUD_GITHUB_TOKEN || 'vazio'))"`, tmpdir());
    expect(r.tail).toContain('tok=vazio');
    expect(r.tail).not.toContain(TOKEN);
  });

  it('os hooks do git (commit da cópia) não veem o token', async () => {
    vi.stubEnv('HABBLAUD_GITHUB_TOKEN', TOKEN);
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: withoutSecrets(process.env) }).trim();
    const dir = mkdtempSync(join(tmpdir(), 'hb-sec-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), '1\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'i');
    const ops = createWorktreeOps(mkdtempSync(join(tmpdir(), 'hb-sec-data-')));
    const w = await ops.create(dir, 'chat:1', 'x');
    if ('error' in w) throw new Error(w.error);
    const hooks = join(dir, 'hooks');
    const out = join(dir, 'visto.txt').replace(/\\/g, '/');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\necho "tok=$HABBLAUD_GITHUB_TOKEN" > "${out}"\n`);
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    git(w.path, 'config', 'core.hooksPath', hooks);
    writeFileSync(join(w.path, 'b.txt'), '2\n');
    expect((await ops.commit(w, 'b')).ok).toBe(true);
    expect(readFileSync(out, 'utf8').trim()).toBe('tok=');
  });
});
