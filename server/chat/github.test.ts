import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ciVerdict, deployVerdict, GitHub, GitHubError, GitHubTokenStore, parseRemote } from './github';

const TOKEN = `github_pat_${'A'.repeat(40)}`;

/** fetch falso: guarda os pedidos e responde pela rota. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: unknown }> = [];
  const f = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, headers: init.headers as Record<string, string>, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
    const r = key ? routes[key] : { status: 404, body: { message: 'Not Found' } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const R = { owner: 'acme', repo: 'helix-server' };
const API = 'https://api.github.com/repos/acme/helix-server';

describe('github: parseRemote', () => {
  it('https e ssh do github.com viram owner/repo', () => {
    expect(parseRemote('https://github.com/acme/helix-server.git')).toEqual(R);
    expect(parseRemote('https://github.com/acme/helix-server')).toEqual(R);
    expect(parseRemote('git@github.com:acme/helix-server.git')).toEqual(R);
    expect(parseRemote('ssh://git@github.com/acme/helix-server.git')).toEqual(R);
    expect(parseRemote('https://x-access-token:abc@github.com/acme/helix-server.git')).toEqual(R);
  });
  it('outros hosts e caminhos estranhos ficam de fora', () => {
    expect(parseRemote('https://gitlab.com/acme/x.git')).toBeUndefined();
    expect(parseRemote('https://github.com.evil.com/acme/x.git')).toBeUndefined();
    expect(parseRemote('http://github.com/acme/x.git')).toBeUndefined();
    expect(parseRemote('git@github.com:acme/x/y.git')).toBeUndefined();
    expect(parseRemote('D:/repos/x.git')).toBeUndefined();
    expect(parseRemote('https://github.com/acme/..')).toBeUndefined();
  });
});

describe('github: ciVerdict', () => {
  const run = (status: string, conclusion: string | null = null) => ({ status, conclusion });
  it('lista vazia = no-ci, nunca pass', () => {
    expect(ciVerdict({ checkRuns: [], statuses: [] })).toBe('no-ci');
  });
  it('só skipped/neutral também não é verde', () => {
    expect(ciVerdict({ checkRuns: [run('completed', 'skipped'), run('completed', 'neutral')], statuses: [] })).toBe('no-ci');
  });
  it('verde, pendente e vermelho', () => {
    expect(ciVerdict({ checkRuns: [run('completed', 'success'), run('completed', 'skipped')], statuses: [] })).toBe('pass');
    expect(ciVerdict({ checkRuns: [], statuses: [{ state: 'success' }] })).toBe('pass');
    expect(ciVerdict({ checkRuns: [run('completed', 'success'), run('in_progress')], statuses: [] })).toBe('pending');
    expect(ciVerdict({ checkRuns: [run('completed', 'success')], statuses: [{ state: 'pending' }] })).toBe('pending');
    expect(ciVerdict({ checkRuns: [run('completed', 'failure'), run('in_progress')], statuses: [] })).toBe('fail');
    expect(ciVerdict({ checkRuns: [run('completed', 'success')], statuses: [{ state: 'error' }] })).toBe('fail');
    expect(ciVerdict({ checkRuns: [run('completed', 'timed_out')], statuses: [] })).toBe('fail');
  });
  it('deployVerdict: sem execução ainda = pending', () => {
    expect(deployVerdict([])).toBe('pending');
    expect(deployVerdict([run('queued')])).toBe('pending');
    expect(deployVerdict([run('completed', 'success')])).toBe('pass');
    expect(deployVerdict([run('completed', 'failure')])).toBe('fail');
    expect(deployVerdict([run('completed', 'skipped')])).toBe('fail');
  });
});

describe('github: chamadas REST (fetch falso)', () => {
  it('openPr manda o token só no Authorization e devolve número e link', async () => {
    const { f, calls } = fakeFetch({ [`POST ${API}/pulls`]: { status: 201, body: { number: 7, html_url: 'https://github.com/acme/helix-server/pull/7', state: 'open' } } });
    const pr = await new GitHub(TOKEN, f).openPr(R, { head: 'agentic/x-1', base: 'main', title: 'T', body: 'B' });
    expect(pr).toMatchObject({ number: 7, url: 'https://github.com/acme/helix-server/pull/7' });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].url).not.toContain(TOKEN);
    expect(calls[0].body).toEqual({ head: 'agentic/x-1', base: 'main', title: 'T', body: 'B' });
  });
  it('openPr: PR já aberto (422) devolve o existente', async () => {
    const { f, calls } = fakeFetch({
      [`POST ${API}/pulls`]: { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] } },
      [`GET ${API}/pulls?state=open`]: { body: [{ number: 3, html_url: 'u3', state: 'open' }] },
    });
    expect((await new GitHub(TOKEN, f).openPr(R, { head: 'agentic/x', base: 'main', title: 't', body: '' })).number).toBe(3);
    expect(calls[1].url).toContain(`head=${encodeURIComponent('acme:agentic/x')}`);
  });
  it('checks junta check-runs e o status combinado; mergePr vai preso ao SHA; workflowRuns filtra pelo SHA', async () => {
    const sha = 'a'.repeat(40);
    const { f, calls } = fakeFetch({
      [`GET ${API}/commits/${sha}/check-runs`]: { body: { check_runs: [{ status: 'completed', conclusion: 'success' }] } },
      [`GET ${API}/commits/${sha}/status`]: { body: { statuses: [{ state: 'success' }] } },
      [`PUT ${API}/pulls/7/merge`]: { body: { merged: true, sha: 'm'.repeat(40) } },
      [`GET ${API}/actions/workflows/deploy.yml/runs`]: { body: { workflow_runs: [{ status: 'completed', conclusion: 'success', head_sha: 'm'.repeat(40) }, { status: 'completed', conclusion: 'failure', head_sha: 'z'.repeat(40) }] } },
    });
    const gh = new GitHub(TOKEN, f);
    expect(ciVerdict(await gh.checks(R, sha))).toBe('pass');
    expect(await gh.mergePr(R, 7, sha)).toBe('m'.repeat(40));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ sha, merge_method: 'merge' });
    const runs = await gh.workflowRuns(R, 'deploy.yml', 'main', 'm'.repeat(40));
    expect(runs).toHaveLength(1);
    expect(calls.at(-1)?.url).toContain(`branch=main&head_sha=${'m'.repeat(40)}`);
  });
  it('401, 403 e 422 viram frases', async () => {
    const err = async (status: number, message = 'x') => {
      const { f } = fakeFetch({ GET: { status, body: { message } } });
      return new GitHub(TOKEN, f).pr(R, 1).catch((e: unknown) => e as GitHubError);
    };
    const e401 = (await err(401)) as GitHubError;
    expect(e401).toBeInstanceOf(GitHubError);
    expect(e401.status).toBe(401);
    expect(e401.message).toMatch(/token inválido ou expirado/);
    expect(((await err(403, 'Resource not accessible by personal access token')) as Error).message).toMatch(/não tem permissão.*Resource not accessible/);
    expect(((await err(422, 'Validation Failed')) as Error).message).toMatch(/GitHub recusou o pedido: Validation Failed/);
    expect(((await err(404)) as Error).message).toMatch(/não encontrado/);
  });
  it('erro de rede não vaza o token', async () => {
    const f = (async () => {
      throw new Error(`falhou com ${TOKEN}`);
    }) as unknown as typeof fetch;
    const e = (await new GitHub(TOKEN, f).pr(R, 1).catch((x: unknown) => x)) as GitHubError;
    expect(e.status).toBe(0);
    expect(e.message).not.toContain(TOKEN);
  });
});

describe('github: token', () => {
  it('env vence o arquivo; o arquivo nasce 600 e o token não volta na vista', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hb-gh-')), 'github.json');
    const store = new GitHubTokenStore(file, {});
    expect(store.view(true)).toEqual({ set: false, source: null, editable: true });
    expect(store.save('nada-a-ver')).toMatch(/inválido/);
    expect(store.save(TOKEN)).toBeUndefined();
    expect(store.get()).toBe(TOKEN);
    expect(JSON.stringify(store.view(true))).not.toContain(TOKEN);
    expect(store.view(false)).toEqual({ set: true, source: 'file', editable: false });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ token: TOKEN });
    expect(new GitHubTokenStore(file, { HABBLAUD_GITHUB_TOKEN: 'ghp_env' }).view(true).source).toBe('env');
    expect(store.save('')).toBeUndefined();
    expect(store.get()).toBeUndefined();
  });
});
