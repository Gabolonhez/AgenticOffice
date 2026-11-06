import { describe, expect, it, vi } from 'vitest';
import type { ChatRun } from '../../shared/runs';
import type { Product } from '../vboards/products';
import type { FolderConfig } from '../vboards/vboards';
import { GitHubError } from './github';
import { NO_CI_GRACE_MS, ShipService, type ShipDeps, type ShipGitHub } from './ship';
import type { ShipWorktreeOps } from './types';

const SHA = 'a'.repeat(40);
const MERGE = 'm'.repeat(40);
const TOKEN = `github_pat_${'T'.repeat(40)}`;
const MIN = 60_000;

const cfg = (o: Partial<FolderConfig> = {}): FolderConfig => ({ auto: false, provider: 'claude', budget: 2, reviewer: 'claude', copy: [], ship: 'merge', ciMinutes: 30, ...o });

function makeRun(id: string, folder: string): ChatRun {
  return {
    id,
    createdAt: 1,
    state: 'done',
    options: { folder, provider: 'claude', permission: 'auto' } as ChatRun['options'],
    stopOnFail: true,
    wantIsolated: true,
    isolated: { branch: `agentic/lista-${id}`, path: `/data/wt/${id}`, base: 'b'.repeat(40) },
    items: [{ text: 'Tarefa do VBoards (card X): corrigir login', vboardsTaskId: 'c1:s1', state: 'review', agentId: 'chat:1', gate: 'pass' }],
  };
}

/** GitHub falso: o veredito do CI e do deploy muda pelo teste. */
function fakeGitHub() {
  const st = { checkRuns: [] as Array<{ status: string; conclusion: string | null }>, statuses: [] as Array<{ state: string }>, deploy: [] as Array<{ status: string; conclusion: string | null }>, merged: false, headSha: SHA };
  const gh = {
    openPr: vi.fn(async () => ({ number: 7, url: 'https://github.com/acme/api/pull/7', state: 'open', merged: false })),
    pr: vi.fn(async () => ({ number: 7, url: 'u', state: 'open', merged: st.merged, headSha: st.headSha, ...(st.merged ? { mergeSha: MERGE } : {}) })),
    checks: vi.fn(async () => ({ checkRuns: st.checkRuns, statuses: st.statuses })),
    mergePr: vi.fn(async (_r: unknown, _n: number, sha: string) => {
      if (sha !== st.headSha) throw new GitHubError('409', 409);
      st.merged = true;
      return MERGE;
    }),
    workflowRuns: vi.fn(async () => st.deploy),
  } satisfies ShipGitHub;
  return { gh, st };
}

function setup(o: { config?: Partial<FolderConfig>; products?: Product[]; runs?: ChatRun[] } = {}) {
  let now = 1_000_000;
  const runs = o.runs ?? [makeRun('r1', '/p/api')];
  const journal: string[] = [];
  const settles: Array<{ id: string; state: string; stage?: string; prUrl?: string }> = [];
  const notes: string[] = [];
  const persisted = vi.fn();
  const worktrees = {
    commit: vi.fn(async () => ({ ok: true as const, sha: SHA })),
    remoteInfo: vi.fn(async (): Promise<{ url?: string; head?: string }> => ({ url: 'git@github.com:acme/api.git', head: 'main' })),
    changedFiles: vi.fn(async () => ['src/a.ts', '.github/workflows/ci.yml']),
    diff: vi.fn(async () => '+++ b/src/a.ts\n+x'),
    summary: vi.fn(async () => ({ files: 2, added: 3, removed: 1, commits: 1, stat: ' src/a.ts | 2 +-' })),
    push: vi.fn(async (): Promise<{ ok: true } | { ok: false; reason: string }> => ({ ok: true })),
    discard: vi.fn(async () => ({ ok: true as const })),
    fastForward: vi.fn(async () => undefined),
    create: vi.fn(),
    merge: vi.fn(),
  };
  const { gh, st } = fakeGitHub();
  const deps: ShipDeps = {
    runs: {
      get: (id) => runs.find((r) => r.id === id),
      list: () => runs,
      persist: persisted,
      journalShipped: (run, stage) => journal.push(`${run.id}:${stage}`),
    },
    worktrees: worktrees as unknown as ShipWorktreeOps,
    token: () => TOKEN,
    github: () => gh,
    folderConfig: async () => cfg(o.config),
    products: () => o.products ?? [],
    vboards: { settle: (id, s) => (settles.push({ id, ...s }), true) },
    notify: (title, ev) => notes.push(`${title}:${ev}`),
    restoreCwd: vi.fn(),
    now: () => now,
  };
  const ship = new ShipService(deps);
  return { ship, runs, worktrees, gh, st, journal, settles, notes, persisted, clock: (ms: number) => (now += ms) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
async function approved(t: ReturnType<typeof setup>, id = 'r1') {
  const p = await t.ship.prepare(id);
  if ('error' in p) throw new Error(p.error);
  const r = await t.ship.approve(id, { sha: p.sha });
  if ('error' in r) throw new Error(r.error);
  await flush();
  return t.runs.find((x) => x.id === id)!;
}

describe('ship: o cartão (prepare)', () => {
  it('mostra repo, base, branch, SHA exato, diffstat, portão e destaca hooks/CI', async () => {
    const t = setup();
    const p = await t.ship.prepare('r1');
    expect(p).toMatchObject({ owner: 'acme', repo: 'api', base: 'main', branch: 'agentic/lista-r1', sha: SHA, mode: 'merge', deploy: 'none', gate: 'pass', risky: ['.github/workflows/ci.yml'] });
    expect(t.gh.openPr).not.toHaveBeenCalled();
    expect(t.worktrees.push).not.toHaveBeenCalled();
  });
  it('recusa: ship=off, sem token, remoto fora do GitHub, segredo no diff', async () => {
    expect(await setup({ config: { ship: 'off' } }).ship.prepare('r1')).toMatchObject({ status: 409, error: expect.stringMatching(/desligado/) });
    const t = setup();
    t.worktrees.remoteInfo.mockResolvedValueOnce({ url: 'https://gitlab.com/a/b.git' });
    expect(await t.ship.prepare('r1')).toMatchObject({ error: expect.stringMatching(/github\.com/) });
    t.worktrees.diff.mockResolvedValueOnce(`+++ b/a.ts\n+k = "AKIA${'A'.repeat(16)}"`);
    expect(await t.ship.prepare('r1')).toMatchObject({ error: expect.stringMatching(/segredo/) });
  });
  it('SHA do cartão diferente do HEAD atual = recusa', async () => {
    const t = setup();
    expect(await t.ship.approve('r1', { sha: 'f'.repeat(40) })).toMatchObject({ status: 409 });
    expect(t.runs[0].ship).toBeUndefined();
  });
});

describe('ship: máquina de estados', () => {
  it('caminho feliz: push → PR → CI verde → merge pelo SHA → deployed, com registro, VBoards, avisos e descarte', async () => {
    const t = setup();
    const run = await approved(t);
    expect(t.worktrees.push).toHaveBeenCalledWith(run.isolated, { url: 'https://github.com/acme/api.git', sha: SHA, token: TOKEN, baseBranch: 'main' });
    expect(run.ship).toMatchObject({ step: 'ci', prNumber: 7, prUrl: 'https://github.com/acme/api/pull/7' });
    expect(t.settles).toContainEqual({ id: 'c1:s1', state: 'review', stage: 'pr', prUrl: 'https://github.com/acme/api/pull/7' });
    expect(t.notes).toEqual(['api:pr']);
    await t.ship.tick();
    expect(run.ship!.step).toBe('ci'); // pendente
    t.st.checkRuns = [{ status: 'completed', conclusion: 'success' }];
    await t.ship.tick();
    expect(t.gh.mergePr).toHaveBeenCalledWith({ owner: 'acme', repo: 'api' }, 7, SHA);
    expect(run.ship).toMatchObject({ step: 'deployed', mergeSha: MERGE });
    expect(t.journal).toEqual(['r1:pr', 'r1:merged', 'r1:deployed']);
    expect(t.settles.at(-1)).toEqual({ id: 'c1:s1', state: 'done', stage: 'deployed', prUrl: 'https://github.com/acme/api/pull/7' });
    expect(t.notes).toEqual(['api:pr', 'api:deployed']);
    expect(t.worktrees.discard).toHaveBeenCalled();
    expect(run.isolated!.discarded).toBe(true);
    expect(t.worktrees.fastForward).toHaveBeenCalledWith('/p/api', 'origin', 'main');
    await t.ship.tick();
    expect(t.gh.mergePr).toHaveBeenCalledTimes(1);
  });

  it('ship=pr: só abre o PR (o fim), sem merge', async () => {
    const t = setup({ config: { ship: 'pr' } });
    const run = await approved(t);
    expect(run.ship).toMatchObject({ step: 'pr', mode: 'pr', prNumber: 7 });
    expect(t.settles.at(-1)).toMatchObject({ state: 'done', stage: 'pr' });
    t.st.checkRuns = [{ status: 'completed', conclusion: 'success' }];
    await t.ship.tick();
    expect(t.gh.checks).not.toHaveBeenCalled();
    expect(t.gh.mergePr).not.toHaveBeenCalled();
  });

  it('CI falho: failed, ci_fail no registro e no VBoards, aviso ci_failed, sem merge', async () => {
    const t = setup();
    const run = await approved(t);
    t.st.checkRuns = [{ status: 'completed', conclusion: 'failure' }];
    await t.ship.tick();
    expect(run.ship).toMatchObject({ step: 'failed', failedAt: 'ci' });
    expect(t.journal).toContain('r1:ci_fail');
    expect(t.settles.at(-1)).toMatchObject({ state: 'failed', stage: 'ci_fail' });
    expect(t.notes).toContain('api:ci_failed');
    expect(t.gh.mergePr).not.toHaveBeenCalled();
  });

  it('no-ci bloqueia o merge até a aprovação extra no mesmo SHA', async () => {
    const t = setup();
    const run = await approved(t);
    await t.ship.tick();
    expect(run.ship!.step).toBe('ci'); // vazio logo depois do PR ainda é espera
    t.clock(NO_CI_GRACE_MS + 1);
    await t.ship.tick();
    expect(run.ship).toMatchObject({ step: 'ci', ci: 'no-ci', needs: 'no-ci' });
    expect(t.notes).toContain('api:no_ci');
    t.clock(120 * MIN); // sem prazo: espera a pessoa
    await t.ship.tick();
    await t.ship.tick();
    expect(t.gh.mergePr).not.toHaveBeenCalled();
    expect(t.notes.filter((n) => n === 'api:no_ci')).toHaveLength(1);
    expect(await t.ship.approve('r1', { sha: 'f'.repeat(40), noCi: true })).toMatchObject({ status: 409 });
    expect(await t.ship.approve('r1', { sha: SHA, noCi: true })).toHaveProperty('run');
    await flush();
    expect(t.gh.mergePr).toHaveBeenCalledWith(expect.anything(), 7, SHA);
    expect(run.ship!.step).toBe('deployed');
  });

  it('noCi sem a subida estar esperando isso = recusa', async () => {
    const t = setup();
    await approved(t);
    expect(await t.ship.approve('r1', { sha: SHA, noCi: true })).toMatchObject({ status: 409 });
  });

  it('CI que não termina no prazo (vboards.ciMinutes) falha', async () => {
    const t = setup({ config: { ciMinutes: 5 } });
    const run = await approved(t);
    t.st.checkRuns = [{ status: 'in_progress', conclusion: null }];
    t.clock(6 * MIN);
    await t.ship.tick();
    expect(run.ship).toMatchObject({ step: 'failed', note: expect.stringMatching(/5 min/) });
  });

  it('workflow de deploy: espera a execução no SHA do merge; falha vira failed', async () => {
    const t = setup({ config: { deploy: 'workflow:deploy.yml' } });
    const run = await approved(t);
    t.st.checkRuns = [{ status: 'completed', conclusion: 'success' }];
    await t.ship.tick();
    expect(run.ship!.step).toBe('deploying');
    expect(t.gh.workflowRuns).toHaveBeenLastCalledWith({ owner: 'acme', repo: 'api' }, 'deploy.yml', 'main', MERGE);
    t.st.deploy = [{ status: 'in_progress', conclusion: null }];
    await t.ship.tick();
    expect(run.ship!.step).toBe('deploying');
    t.st.deploy = [{ status: 'completed', conclusion: 'failure' }];
    await t.ship.tick();
    expect(run.ship).toMatchObject({ step: 'failed', failedAt: 'deploying' });
    expect(t.worktrees.discard).not.toHaveBeenCalled();
  });

  it('workflow verde = deployed', async () => {
    const t = setup({ config: { deploy: 'workflow:deploy.yml' } });
    const run = await approved(t);
    t.st.checkRuns = [{ status: 'completed', conclusion: 'success' }];
    t.st.deploy = [{ status: 'completed', conclusion: 'success' }];
    await t.ship.tick();
    expect(run.ship!.step).toBe('deployed');
  });

  it('retomada depois do reinício: um serviço novo continua do que está gravado', async () => {
    const t = setup();
    const run = await approved(t);
    // Reinício no meio do merge: o PR já tinha sido juntado no GitHub.
    run.ship!.step = 'merging';
    run.ship!.ci = 'pass';
    t.st.merged = true;
    const again = new ShipService({ runs: { get: () => run, list: () => [run], persist: vi.fn(), journalShipped: vi.fn() }, worktrees: t.worktrees as unknown as ShipWorktreeOps, token: () => TOKEN, github: () => t.gh, folderConfig: async () => cfg() });
    await again.tick();
    expect(t.gh.mergePr).not.toHaveBeenCalled();
    expect(run.ship).toMatchObject({ step: 'deployed', mergeSha: MERGE });
  });

  it('merge pelo SHA aprovado: PR com head diferente = recusa', async () => {
    const t = setup();
    const run = await approved(t);
    t.st.checkRuns = [{ status: 'completed', conclusion: 'success' }];
    t.st.headSha = 'e'.repeat(40);
    await t.ship.tick();
    expect(run.ship).toMatchObject({ step: 'failed', failedAt: 'merging', note: expect.stringMatching(/mudou depois da aprovação/) });
    expect(t.gh.mergePr).not.toHaveBeenCalled();
  });

  it('push recusado (segredo, branch) falha na etapa pushing, sem PR', async () => {
    const t = setup();
    t.worktrees.push.mockResolvedValueOnce({ ok: false, reason: 'Push recusado: segredo' });
    const run = await approved(t);
    expect(run.ship).toMatchObject({ step: 'failed', failedAt: 'pushing', note: 'Push recusado: segredo' });
    expect(t.gh.openPr).not.toHaveBeenCalled();
  });

  it('GitHub fora do ar no CI: espera e tenta de novo', async () => {
    const t = setup();
    const run = await approved(t);
    t.gh.checks.mockRejectedValueOnce(new GitHubError('GitHub não respondeu', 0));
    await t.ship.tick();
    expect(run.ship).toMatchObject({ step: 'ci', note: 'GitHub não respondeu' });
  });

  it('produto com vários repos: server → web → app, o próximo só depois do anterior deployed', async () => {
    const products: Product[] = [{ id: 'pept', name: 'PeptPro', cardName: 'PeptPro', repos: [{ path: '/p/app', role: 'app' }, { path: '/p/web', role: 'web' }, { path: '/p/server', role: 'server' }] }];
    const runs = [makeRun('app', '/p/app'), makeRun('server', '/p/server')];
    const t = setup({ products, runs });
    const server = await approved(t, 'server');
    expect(server.ship!.step).toBe('ci');
    const app = await approved(t, 'app');
    expect(app.ship).toMatchObject({ step: 'waiting', note: expect.stringMatching(/server/) });
    expect(t.worktrees.push).toHaveBeenCalledTimes(1);
    t.st.checkRuns = [{ status: 'completed', conclusion: 'success' }];
    await t.ship.tick();
    expect(server.ship!.step).toBe('deployed');
    await t.ship.tick();
    expect(app.ship!.step).not.toBe('waiting');
    expect(t.worktrees.push).toHaveBeenCalledTimes(2);
  });

  it('produto: o repo anterior falhou = o próximo falha também', async () => {
    const products: Product[] = [{ id: 'pept', name: 'PeptPro', cardName: 'PeptPro', repos: [{ path: '/p/web', role: 'web' }, { path: '/p/server', role: 'server' }] }];
    const t = setup({ products, runs: [makeRun('web', '/p/web'), makeRun('server', '/p/server')] });
    const server = await approved(t, 'server');
    const web = await approved(t, 'web');
    expect(web.ship!.step).toBe('waiting');
    t.st.checkRuns = [{ status: 'completed', conclusion: 'failure' }];
    await t.ship.tick();
    expect(server.ship!.step).toBe('failed');
    await t.ship.tick();
    expect(web.ship).toMatchObject({ step: 'failed', failedAt: 'waiting' });
  });
});
