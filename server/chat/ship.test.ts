import { describe, expect, it, vi } from 'vitest';
import { shipApprovalOf, type ChatRun, type ShipPreview } from '../../shared/runs';
import type { Product } from '../vboards/products';
import type { FolderConfig } from '../vboards/vboards';
import { GitHubError } from './github';
import { autoShipBlock, NO_CI_GRACE_MS, ShipService, type ShipDeps, type ShipGitHub } from './ship';
import type { ShipWorktreeOps } from './types';

const SHA = 'a'.repeat(40);
const PUSHED = 'p'.repeat(40);
const MERGE = 'm'.repeat(40);
const TOKEN = `github_pat_${'T'.repeat(40)}`;
const MIN = 60_000;

const cfg = (o: Partial<FolderConfig> = {}): FolderConfig => ({ auto: false, provider: 'claude', budget: 2, reviewer: 'claude', copy: [], ship: 'merge', ciMinutes: 30, autoMerge: 'off', riskPaths: [], ...o });

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
  const st = { checkRuns: [] as Array<{ status: string; conclusion: string | null }>, statuses: [] as Array<{ state: string }>, deploy: [] as Array<{ status: string; conclusion: string | null }>, merged: false, headSha: PUSHED };
  const gh = {
    openPr: vi.fn(async () => ({ number: 7, url: 'https://github.com/acme/api/pull/7', state: 'open', merged: false })),
    pr: vi.fn(async () => ({ number: 7, url: 'u', state: 'open', merged: st.merged, headSha: st.headSha, ...(st.merged ? { mergeSha: MERGE } : {}) })),
    checks: vi.fn(async (_r: unknown, _sha: string) => ({ checkRuns: st.checkRuns, statuses: st.statuses })),
    mergePr: vi.fn(async (_r: unknown, _n: number, sha: string) => {
      if (sha !== st.headSha) throw new GitHubError('409', 409);
      st.merged = true;
      return MERGE;
    }),
    workflowRuns: vi.fn(async () => st.deploy),
  } satisfies ShipGitHub;
  return { gh, st };
}

function setup(o: { config?: Partial<FolderConfig>; products?: Product[]; runs?: ChatRun[]; files?: string[] } = {}) {
  let now = 1_000_000;
  const runs = o.runs ?? [makeRun('r1', '/p/api')];
  const journal: string[] = [];
  const settles: Array<{ id: string; state: string; stage?: string; prUrl?: string }> = [];
  const notes: string[] = [];
  const persisted = vi.fn();
  const worktrees = {
    commit: vi.fn(async () => ({ ok: true as const, sha: SHA })),
    remoteInfo: vi.fn(async (): Promise<{ url?: string; head?: string }> => ({ url: 'git@github.com:acme/api.git', head: 'main' })),
    scan: vi.fn(async (): Promise<{ names: string[]; secrets: string[] } | { error: string }> => ({ names: o.files ?? ['src/a.ts'], secrets: [] })),
    summary: vi.fn(async () => ({ files: 2, added: 3, removed: 1, commits: 1, stat: ' src/a.ts | 2 +-' })),
    push: vi.fn(async (): Promise<{ ok: true; pushed: string } | { ok: false; reason: string }> => ({ ok: true, pushed: PUSHED })),
    discard: vi.fn(async () => ({ ok: true as const })),
    fastForward: vi.fn(async () => undefined),
    diff: vi.fn(async () => ''),
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
  return { ship, deps, runs, worktrees, gh, st, journal, settles, notes, persisted, clock: (ms: number) => (now += ms) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
async function approved(t: ReturnType<typeof setup>, id = 'r1') {
  const p = (await t.ship.prepare(id)) as ShipPreview;
  if ('error' in p) throw new Error(String(p.error));
  const r = await t.ship.approve(id, shipApprovalOf(p));
  if ('error' in r) throw new Error(r.error);
  await flush();
  return t.runs.find((x) => x.id === id)!;
}

describe('ship: o cartão (prepare)', () => {
  it('mostra repo, base, branch, SHA exato, diffstat, portão e destaca hooks/CI', async () => {
    const t = setup({ files: ['src/a.ts', '.github/workflows/ci.yml'] });
    const p = await t.ship.prepare('r1');
    expect(p).toMatchObject({ owner: 'acme', repo: 'api', base: 'main', remote: 'origin', branch: 'agentic/lista-r1', sha: SHA, mode: 'merge', deploy: 'none', gate: 'pass', risky: ['.github/workflows/ci.yml'] });
    expect(t.gh.openPr).not.toHaveBeenCalled();
    expect(t.worktrees.push).not.toHaveBeenCalled();
  });
  it('recusa: ship=off, remoto fora do GitHub, segredo no diff', async () => {
    expect(await setup({ config: { ship: 'off' } }).ship.prepare('r1')).toMatchObject({ status: 409, error: expect.stringMatching(/desligado/) });
    const t = setup();
    t.worktrees.remoteInfo.mockResolvedValueOnce({ url: 'https://gitlab.com/a/b.git' });
    expect(await t.ship.prepare('r1')).toMatchObject({ error: expect.stringMatching(/github\.com/) });
    t.worktrees.scan.mockResolvedValueOnce({ names: ['a.ts'], secrets: ['a.ts (chave da AWS)'] });
    expect(await t.ship.prepare('r1')).toMatchObject({ error: expect.stringMatching(/segredo/) });
  });
  it('a aprovação prende o conjunto inteiro: SHA, repo, base, remoto, modo, deploy e hooks/CI', async () => {
    const t = setup();
    const p = (await t.ship.prepare('r1')) as ShipPreview;
    const ok = shipApprovalOf(p);
    for (const bad of [{ sha: 'f'.repeat(40) }, { owner: 'outro' }, { repo: 'x' }, { base: 'dev' }, { remote: 'up' }, { mode: 'pr' as const }, { deploy: 'workflow:x.yml' }, { risky: ['.husky/pre-push'] }, { noCi: true }]) {
      expect(await t.ship.approve('r1', { ...ok, ...bad })).toMatchObject({ status: 409 });
    }
    expect(t.runs[0].ship).toBeUndefined();
    expect(await t.ship.approve('r1', ok)).toHaveProperty('run');
  });
});

describe('ship: máquina de estados', () => {
  it('caminho feliz: push (squash) → PR → CI verde → merge pelo SHA que subiu → deployed, com registro, VBoards, avisos e descarte', async () => {
    const t = setup();
    const run = await approved(t);
    expect(t.worktrees.push).toHaveBeenCalledWith(run.isolated, { url: 'https://github.com/acme/api.git', sha: SHA, token: TOKEN, baseBranch: 'main', message: 'corrigir login' });
    expect(run.ship).toMatchObject({ step: 'ci', prNumber: 7, prUrl: 'https://github.com/acme/api/pull/7', pushedSha: PUSHED });
    expect(t.settles).toContainEqual({ id: 'c1:s1', state: 'review', stage: 'pr', prUrl: 'https://github.com/acme/api/pull/7' });
    expect(t.notes).toEqual(['api:pr']);
    await t.ship.tick();
    expect(run.ship!.step).toBe('ci'); // pendente
    t.st.checkRuns = [{ status: 'completed', conclusion: 'success' }];
    await t.ship.tick();
    expect(t.gh.checks).toHaveBeenLastCalledWith({ owner: 'acme', repo: 'api' }, PUSHED);
    expect(t.gh.mergePr).toHaveBeenCalledWith({ owner: 'acme', repo: 'api' }, 7, PUSHED);
    expect(run.ship).toMatchObject({ step: 'deployed', mergeSha: MERGE });
    expect(t.journal).toEqual(['r1:pr', 'r1:merged', 'r1:deployed']);
    expect(t.settles.at(-1)).toEqual({ id: 'c1:s1', state: 'done', stage: 'deployed', prUrl: 'https://github.com/acme/api/pull/7' });
    expect(t.notes).toEqual(['api:pr', 'api:deployed']);
    expect(run.isolated!.discarded).toBe(true);
    expect(t.worktrees.fastForward).toHaveBeenCalledWith('/p/api', 'origin', 'main');
    await t.ship.tick();
    expect(t.gh.mergePr).toHaveBeenCalledTimes(1);
  });

  it('subir de novo depois de falhar: o squash novo tem como pai o que já subiu (sem force)', async () => {
    const t = setup();
    const run = await approved(t);
    t.st.checkRuns = [{ status: 'completed', conclusion: 'failure' }];
    await t.ship.tick();
    expect(run.ship!.step).toBe('failed');
    await approved(t);
    expect(t.worktrees.push).toHaveBeenLastCalledWith(run.isolated, expect.objectContaining({ parent: PUSHED }));
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

  it('no-ci bloqueia o merge até a aprovação extra com o mesmo conjunto', async () => {
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
    expect(await t.ship.approve('r1', { ...shipApprovalOf(run.ship!, true), sha: 'f'.repeat(40) })).toMatchObject({ status: 409 });
    expect(await t.ship.approve('r1', shipApprovalOf(run.ship!))).toMatchObject({ status: 409 }); // sem noCi
    expect(await t.ship.approve('r1', shipApprovalOf(run.ship!, true))).toHaveProperty('run');
    await flush();
    expect(t.gh.mergePr).toHaveBeenCalledWith(expect.anything(), 7, PUSHED);
    expect(run.ship!.step).toBe('deployed');
  });

  it('o diff muda workflows/hooks: CI verde vira no-ci (exige a confirmação extra)', async () => {
    const t = setup({ files: ['src/a.ts', '.github/workflows/ci.yml'] });
    const run = await approved(t);
    t.st.checkRuns = [{ status: 'completed', conclusion: 'success' }];
    await t.ship.tick();
    expect(run.ship).toMatchObject({ step: 'ci', ci: 'pass', needs: 'no-ci', note: expect.stringMatching(/workflows ou hooks/) });
    expect(t.gh.mergePr).not.toHaveBeenCalled();
    expect(await t.ship.approve('r1', shipApprovalOf(run.ship!, true))).toHaveProperty('run');
    await flush();
    expect(run.ship!.step).toBe('deployed');
  });

  it('noCi sem a subida estar esperando isso = recusa', async () => {
    const t = setup();
    const run = await approved(t);
    expect(await t.ship.approve('r1', shipApprovalOf(run.ship!, true))).toMatchObject({ status: 409 });
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

  it('reinício: deploy já juntado segue sozinho (só leitura)', async () => {
    const t = setup({ config: { deploy: 'workflow:deploy.yml' } });
    const run = await approved(t);
    t.st.checkRuns = [{ status: 'completed', conclusion: 'success' }];
    await t.ship.tick();
    expect(run.ship!.step).toBe('deploying');
    const again = new ShipService(t.deps);
    again.afterRestart();
    expect(run.ship!.needs).toBeUndefined();
    t.st.deploy = [{ status: 'completed', conclusion: 'success' }];
    await again.tick();
    expect(run.ship!.step).toBe('deployed');
  });

  it('reinício antes do merge: runs.json não basta; push/merge esperam o PIN de novo (e conferem contra a cópia)', async () => {
    const t = setup();
    const run = await approved(t);
    // Um agente forja o runs.json: CI "verde" e o merge liberado.
    run.ship = { ...run.ship!, step: 'merging', ci: 'pass', noCiApproved: true };
    const again = new ShipService(t.deps);
    again.afterRestart();
    expect(run.ship).toMatchObject({ step: 'merging', needs: 'reapprove' });
    expect(run.ship!.noCiApproved).toBeUndefined();
    await again.tick();
    expect(t.gh.pr).not.toHaveBeenCalled();
    expect(t.gh.mergePr).not.toHaveBeenCalled();
    // Forjou o repo: a aprovação nova (feita sobre a cópia e a pasta de agora) não bate.
    run.ship = { ...run.ship!, owner: 'atacante' };
    const p = (await again.prepare('r1')) as ShipPreview;
    expect(await again.approve('r1', shipApprovalOf(p))).toMatchObject({ status: 409 });
    run.ship = { ...run.ship!, owner: 'acme' };
    expect(await again.approve('r1', shipApprovalOf(p))).toHaveProperty('run');
    await flush();
    expect(t.gh.mergePr).toHaveBeenCalledWith(expect.anything(), 7, PUSHED);
    expect(run.ship!.step).toBe('deployed');
  });

  it('reinício no meio do push: não sobe sozinho', async () => {
    const t = setup();
    const run = makeRun('r1', '/p/api');
    run.ship = { step: 'pushing', mode: 'merge', sha: SHA, owner: 'acme', repo: 'api', remote: 'origin', base: 'main', branch: run.isolated!.branch, deploy: 'none', risky: [], ciMinutes: 30, startedAt: 0, stepAt: 0 };
    t.runs.splice(0, 1, run);
    const again = new ShipService(t.deps);
    again.afterRestart();
    await again.tick();
    expect(t.worktrees.push).not.toHaveBeenCalled();
    expect(run.ship!.needs).toBe('reapprove');
  });

  it('merge pelo SHA que subiu: PR com head diferente = recusa', async () => {
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

describe('ship: merge automático (vboards.autoMerge=low, sem PIN)', () => {
  const LOW = { autoMerge: 'low', ship: 'merge' } as const;
  /** Lista automática do VBoards pronta para subir sozinha: plano aprovado, portão ok sem volta, risco baixo. */
  function autoRun(item: Partial<ChatRun['items'][number]> = {}): ChatRun {
    const r = makeRun('r1', '/p/api');
    r.auto = { reviewer: 'claude' };
    r.items = [{ ...r.items[0], risk: 'low', riskWhy: 'só estilo', approvedAt: '2026-11-06T10:00:00.000Z', ...item }];
    return r;
  }
  function autoSetup(o: { config?: Partial<FolderConfig>; item?: Partial<ChatRun['items'][number]>; files?: string[] } = {}) {
    const t = setup({ config: { ...LOW, ...o.config }, runs: [autoRun(o.item)] });
    const files = o.files ?? ['src/ui/button.tsx'];
    t.worktrees.scan.mockResolvedValue({ names: files, secrets: [] });
    t.worktrees.diff.mockResolvedValue(files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-a\n+b`).join('\n'));
    return t;
  }

  it('todas as condições: sobe sem PIN, journal "auto", aviso com o PR e merge só com CI verde', async () => {
    const t = autoSetup();
    await t.ship.tick();
    await flush();
    const run = t.runs[0];
    expect(run.ship).toMatchObject({ auto: true, step: 'ci', sha: SHA });
    expect(run.autoShip?.blocked).toBeUndefined();
    expect(t.worktrees.push).toHaveBeenCalled();
    expect(t.journal).toContain('r1:auto');
    expect(t.notes).toEqual(['api:auto']);
    expect(t.gh.mergePr).not.toHaveBeenCalled();
    t.st.checkRuns = [{ status: 'completed', conclusion: 'success' }];
    await t.ship.tick();
    expect(t.gh.mergePr).toHaveBeenCalledTimes(1);
    expect(run.ship!.step).toBe('deployed');
  });

  it('o caminho sem PIN passa pela mesma comparação do conjunto aprovado (qualquer campo diferente recusa)', async () => {
    const t = autoSetup();
    const p = (await t.ship.prepare('r1')) as ShipPreview;
    for (const bad of [{ sha: 'f'.repeat(40) }, { deploy: 'workflow:deploy.yml' }, { base: 'dev' }, { mode: 'pr' as const }, { repo: 'outro' }]) {
      expect(await t.ship.approve('r1', { ...shipApprovalOf(p), ...bad }, { auto: true })).toMatchObject({ status: 409 });
    }
    expect(t.runs[0].ship).toBeUndefined();
    expect(await t.ship.approve('r1', { ...shipApprovalOf(p), noCi: true }, { auto: true })).toMatchObject({ status: 409 });
    expect(t.worktrees.push).not.toHaveBeenCalled();
  });

  it('reinício: lista lida do runs.json nunca sobe sozinha, e subida retomada (reapprove) não aceita o caminho sem PIN', async () => {
    const t = autoSetup();
    t.ship.start(60 * MIN);
    t.ship.stop();
    await t.ship.tick();
    await flush();
    expect(t.runs[0].ship).toBeUndefined();
    expect(t.runs[0].autoShip).toBeUndefined();
    expect(t.worktrees.push).not.toHaveBeenCalled();
    // Subida que estava em andamento antes do reinício: volta a pedir o PIN; o auto não continua por cima.
    const t2 = autoSetup();
    const p = (await t2.ship.prepare('r1')) as ShipPreview;
    t2.runs[0].ship = { step: 'pushing', mode: 'merge', sha: SHA, owner: 'acme', repo: 'api', remote: 'origin', base: 'main', branch: 'agentic/lista-r1', deploy: 'none', risky: [], ciMinutes: 30, startedAt: 1, stepAt: 1, auto: true };
    t2.ship.start(60 * MIN);
    t2.ship.stop();
    expect(t2.runs[0].ship!.needs).toBe('reapprove');
    expect(await t2.ship.approve('r1', shipApprovalOf(p), { auto: true })).toMatchObject({ status: 409 });
    expect(t2.runs[0].ship!.needs).toBe('reapprove');
    expect(t2.worktrees.push).not.toHaveBeenCalled();
  });

  it('hooks/CI no diff (riskyFiles = no-ci): o auto bloqueia mesmo com risco calculado baixo por engano', async () => {
    const t = autoSetup({ files: ['src/ui/button.tsx', '.husky/pre-push'] });
    await t.ship.tick();
    await flush();
    expect(t.runs[0].ship).toBeUndefined();
    expect(t.runs[0].autoShip?.blocked).toMatch(/Risco alto|hooks\/CI/);
    // Direto no approve: risky no conjunto aprovado = recusa do caminho sem PIN.
    const p = (await t.ship.prepare('r1')) as ShipPreview;
    expect(p.risky).toEqual(['.husky/pre-push']);
    expect(await t.ship.approve('r1', shipApprovalOf(p), { auto: true })).toMatchObject({ status: 409 });
    expect(t.worktrees.push).not.toHaveBeenCalled();
  });

  it('avalia uma vez só por lista', async () => {
    const t = autoSetup({ item: { approvedAt: undefined } });
    await t.ship.tick();
    await t.ship.tick();
    expect(t.worktrees.commit).not.toHaveBeenCalled();
    expect(t.runs[0].autoShip?.blocked).toMatch(/approvedAt/);
  });

  it.each([
    ['sem approvedAt do VBoards', { item: { approvedAt: undefined } }, /approvedAt/],
    ['risco da IA medium', { item: { risk: 'medium' as const } }, /Risco médio/],
    ['risco da IA ausente (conta medium)', { item: { risk: undefined } }, /Risco médio/],
    ['volta de correção no portão', { item: { retried: true } }, /volta de correção/],
    ['portão reprovado', { item: { gate: 'fail' as const } }, /portão/],
    ['ship=pr', { config: { ship: 'pr' as const } }, /ship não é merge/],
    ['diff de risco alto (o calculado não é rebaixado)', { files: ['src/ui/button.tsx', '.github/workflows/deploy.yml'] }, /Risco alto/],
    ['diff de risco alto por vboards.riskPaths', { config: { riskPaths: ['src/ui/**'] } }, /Risco alto/],
  ])('bloqueia: %s', async (_name, o, why) => {
    const t = autoSetup(o);
    await t.ship.tick();
    await flush();
    expect(t.runs[0].ship).toBeUndefined();
    expect(t.worktrees.push).not.toHaveBeenCalled();
    expect(t.runs[0].autoShip?.blocked).toMatch(why);
  });

  it('autoMerge off (padrão): nada sobe e nada é cobrado; ligar depois não sobe a lista antiga', async () => {
    const t = autoSetup({ config: { autoMerge: 'off' } });
    await t.ship.tick();
    expect(t.runs[0]).toMatchObject({ autoShip: { at: expect.any(Number) } });
    expect(t.runs[0].autoShip!.blocked).toBeUndefined();
    expect(t.worktrees.commit).not.toHaveBeenCalled();
  });

  it('lista que não é a automática do VBoards (sem portão) não sobe sozinha', async () => {
    const t = autoSetup();
    delete t.runs[0].auto;
    await t.ship.tick();
    expect(t.runs[0].ship).toBeUndefined();
    expect(autoShipBlock({ ...t.runs[0] }, { ...LOW }, 'low')).toMatch(/automática/);
  });

  it('no-ci NUNCA faz merge sozinho: espera a aprovação com PIN', async () => {
    const t = autoSetup();
    await t.ship.tick();
    await flush();
    const run = t.runs[0];
    t.clock(NO_CI_GRACE_MS + 1);
    await t.ship.tick();
    expect(run.ship).toMatchObject({ step: 'ci', ci: 'no-ci', needs: 'no-ci', auto: true });
    await t.ship.tick();
    expect(t.gh.mergePr).not.toHaveBeenCalled();
  });

  it('autoShipBlock (pura): ok só com todas', () => {
    const r = autoRun();
    expect(autoShipBlock(r, LOW, 'low')).toBeUndefined();
    expect(autoShipBlock(r, LOW, 'medium')).toMatch(/médio/);
    expect(autoShipBlock(r, { ...LOW, autoMerge: 'off' }, 'low')).toMatch(/autoMerge/);
    expect(autoShipBlock({ ...r, items: [...r.items, { text: 'manual', state: 'review', gate: 'pass' }] }, LOW, 'low')).toMatch(/approvedAt/);
  });
});
