import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChatRun } from '../../shared/runs';
import { readJournal } from './journal';
import { feedbackMessage, itemTitle, mergeMessage, METRICS_KEEP_MS, METRICS_TRIM_BYTES, parseComments, readMetrics, RunService, trimMetrics, type RunDeps } from './runs';

const PROJ = 'C:\\proj';
const options = { folder: PROJ, provider: 'claude', permission: 'auto', limits: {} };

function fakeChat() {
  const listeners: Array<(id: string) => void> = [];
  const outcomes = new Map<string, 'done' | 'failed'>();
  const replies = new Map<string, string>();
  const opened: Array<{ id: string; raw: Record<string, unknown>; run?: { cwd?: string } }> = [];
  let n = 0;
  const chat = {
    check: vi.fn((raw: { folder?: string }) => (raw.folder?.startsWith(PROJ) ? undefined : { error: 'invalid' as const, reason: 'Pasta desconhecida' })),
    open: vi.fn((raw: unknown, _from?: unknown, run?: { cwd?: string }) => {
      const id = `chat:${++n}`;
      opened.push({ id, raw: raw as Record<string, unknown>, run });
      return { agentId: id };
    }),
    turnOutcome: (id: string) => outcomes.get(id),
    lastReply: (id: string) => replies.get(id),
    stop: vi.fn(() => 'ok' as const),
    onTurnEnd: (cb: (id: string) => void) => void listeners.push(cb),
    restoreCwd: vi.fn(),
    send: vi.fn((_id: string, _raw: unknown) => 'ok' as const),
  };
  const end = (id: string, outcome: 'done' | 'failed', reply?: string) => {
    outcomes.set(id, outcome);
    if (reply) replies.set(id, reply);
    for (const cb of listeners) cb(id);
  };
  return { chat, end, opened };
}

function setup(over: Partial<RunDeps> = {}, file = join(mkdtempSync(join(tmpdir(), 'hb-runs-')), 'runs.json')) {
  const f = fakeChat();
  const svc = new RunService({ chat: f.chat, file, now: () => 100, newId: () => 'r1', ...over });
  svc.load();
  return { svc, file, ...f };
}

const items = (...texts: string[]) => texts.map((text) => ({ text }));
const run = (r: ReturnType<RunService['create']> | Awaited<ReturnType<RunService['create']>>) => ('run' in r ? r.run : undefined) as ChatRun;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('chat: lista que roda um agente por item', () => {
  it('hasTask: a tarefa do VBoards numa lista guardada (mesmo parada) não abre outra lista sozinha', async () => {
    const vboards = { begin: vi.fn(async () => ({ agentId: 'chat:1' })) };
    const { svc } = setup({ vboards });
    expect(svc.hasTask('c:s')).toBe(false);
    const r = run(await svc.create({ items: [{ text: 'a', vboardsTaskId: 'c:s' }, { text: 'b', vboardsTaskId: 'c:t' }], options }));
    expect(svc.hasTask('c:t')).toBe(true);
    svc.stop(r.id);
    expect(svc.hasTask('c:t')).toBe(true);
    expect(svc.hasTask('c:u')).toBe(false);
  });

  it('valida antes de abrir qualquer agente', async () => {
    const { svc, opened } = setup();
    expect(await svc.create({ items: [], options })).toMatchObject({ status: 400 });
    expect(await svc.create({ items: items(...Array.from({ length: 51 }, (_, i) => `t${i}`)), options })).toMatchObject({ status: 400 });
    expect(await svc.create({ items: [{ text: '  ' }], options })).toMatchObject({ status: 400 });
    expect(await svc.create({ items: items('a'), options: { ...options, folder: 'C:\\outro' } })).toMatchObject({ status: 400, error: 'Pasta desconhecida' });
    expect(await svc.create({ items: [{ text: 'a', vboardsTaskId: 'c:s' }], options })).toMatchObject({ status: 400 });
    expect(await svc.create({ items: items('a'), options, context: 'x'.repeat(5000) })).toMatchObject({ status: 400 });
    expect(await svc.create({ items: items('a'), options, isolated: true })).toMatchObject({ status: 400 });
    expect(await svc.create('lixo')).toMatchObject({ status: 400 });
    expect(opened).toHaveLength(0);
    expect(svc.list()).toEqual([]);
  });

  it('roda em sequência: o próximo item começa quando a rodada do anterior termina', async () => {
    const { svc, opened, end } = setup();
    const r = run(await svc.create({ items: items('criar a tela', 'testar'), options: { ...options, name: 'x', isolated: true }, context: 'Projeto X.' }));
    expect(r.state).toBe('running');
    expect(opened).toHaveLength(1);
    expect(opened[0].raw).toEqual({ folder: PROJ, provider: 'claude', permission: 'auto', limits: {}, prompt: 'Projeto X.\n\ncriar a tela' });
    expect(opened[0].run).toEqual({});
    expect(svc.get('r1')?.items.map((i) => i.state)).toEqual(['running', 'pending']);
    end('chat:9', 'done'); // agente de fora da lista: nada muda
    expect(opened).toHaveLength(1);
    end('chat:1', 'done', 'Tela criada.');
    expect(svc.get('r1')?.items[0]).toMatchObject({ state: 'done', agentId: 'chat:1', summary: 'Tela criada.' });
    expect(opened.map((o) => o.raw.prompt)).toEqual(['Projeto X.\n\ncriar a tela', 'Projeto X.\n\ntestar']);
    end('chat:2', 'done');
    expect(svc.get('r1')?.state).toBe('done');
  });

  it('falhou com "parar se falhar": a lista para; Continuar segue com o resto', async () => {
    const { svc, opened, end } = setup();
    await svc.create({ items: items('a', 'b'), options, stopOnFail: true });
    end('chat:1', 'failed');
    expect(svc.get('r1')).toMatchObject({ state: 'failed' });
    expect(svc.get('r1')?.items.map((i) => i.state)).toEqual(['failed', 'pending']);
    expect(opened).toHaveLength(1);
    expect(svc.continue('r1')).toBe('ok');
    expect(opened).toHaveLength(2);
    expect(svc.get('r1')?.items.map((i) => i.state)).toEqual(['failed', 'running']);
  });

  it('sem "parar se falhar": segue para o próximo', async () => {
    const { svc, opened, end } = setup();
    await svc.create({ items: items('a', 'b'), options, stopOnFail: false });
    end('chat:1', 'failed');
    expect(opened).toHaveLength(2);
    end('chat:2', 'done');
    expect(svc.get('r1')?.state).toBe('done');
  });

  it('Parar interrompe o agente atual e cancela o resto (definitivo)', async () => {
    const { svc, chat, end, opened } = setup();
    await svc.create({ items: items('a', 'b', 'c'), options });
    expect(svc.stop('r1')).toBe('ok');
    expect(chat.stop).toHaveBeenCalledWith('chat:1');
    expect(svc.get('r1')?.state).toBe('stopped');
    expect(svc.get('r1')?.items.map((i) => i.state)).toEqual(['interrupted', 'canceled', 'canceled']);
    end('chat:1', 'failed');
    expect(opened).toHaveLength(1);
    expect(svc.continue('r1')).toBe('invalid');
    expect(svc.stop('r1')).toBe('idle');
    expect(svc.stop('nada')).toBe('not-found');
  });

  const ids = () => (() => { let n = 0; return () => `r${++n}`; })();

  it('pastas diferentes rodam ao mesmo tempo; a mesma pasta espera na fila e começa sozinha', async () => {
    const { svc, opened, end } = setup({ newId: ids() });
    await svc.create({ items: items('a'), options });
    const b = run(await svc.create({ items: items('b'), options: { ...options, folder: `${PROJ}2` } }));
    expect(b.state).toBe('running');
    expect(opened.map((o) => o.raw.prompt)).toEqual(['a', 'b']);
    const c = run(await svc.create({ items: items('c'), options: { ...options, folder: `${PROJ}/` } }));
    expect(c.state).toBe('queued');
    expect(svc.canStart(PROJ)).toBe(false);
    expect(opened).toHaveLength(2);
    end('chat:1', 'done');
    expect(svc.get('r3')?.state).toBe('running');
    expect(opened.map((o) => o.raw.prompt)).toEqual(['a', 'b', 'c']);
  });

  it('teto de listas ao mesmo tempo (maxParallel); a automática não entra na fila (409)', async () => {
    const { svc, opened, end } = setup({ newId: ids(), maxParallel: 1 });
    await svc.create({ items: items('a'), options });
    expect(svc.canStart(`${PROJ}2`)).toBe(false);
    expect(await svc.create({ items: items('auto'), options: { ...options, folder: `${PROJ}3` } }, { reviewer: 'claude' })).toMatchObject({ status: 409 });
    expect(run(await svc.create({ items: items('b'), options: { ...options, folder: `${PROJ}2` } })).state).toBe('queued');
    expect(svc.continue('r1')).toBe('invalid');
    expect(opened).toHaveLength(1);
    svc.stop('r1');
    expect(svc.get('r2')?.state).toBe('running');
    expect(opened.map((o) => o.raw.prompt)).toEqual(['a', 'b']);
    end('chat:2', 'done');
    expect(svc.get('r2')?.state).toBe('done');
  });

  it('Parar uma lista na fila: cancela tudo sem abrir agente', async () => {
    const { svc, opened } = setup({ newId: ids() });
    await svc.create({ items: items('a'), options });
    await svc.create({ items: items('b'), options });
    expect(svc.stop('r2')).toBe('ok');
    expect(svc.get('r2')).toMatchObject({ state: 'stopped', items: [{ state: 'canceled' }] });
    expect(opened).toHaveLength(1);
  });

  it('reinício: o item que rodava vira interrompido, a lista pausa e só volta com Continuar', async () => {
    const first = setup();
    await first.svc.create({ items: items('a', 'b'), options });
    const again = setup({}, first.file);
    expect(again.svc.get('r1')).toMatchObject({ state: 'paused' });
    expect(again.svc.get('r1')?.items.map((i) => i.state)).toEqual(['interrupted', 'pending']);
    expect(again.opened).toHaveLength(0);
    expect(again.svc.continue('r1')).toBe('ok');
    expect(again.opened.map((o) => o.raw.prompt)).toEqual(['a']);
    expect(again.svc.get('r1')?.items[0]).toMatchObject({ state: 'running', agentId: 'chat:1' });
  });

  it('servidor desligando (freeze): o fim das rodadas mortas não abre o próximo item', async () => {
    const { svc, opened, end, file } = setup();
    await svc.create({ items: items('a', 'b'), options });
    svc.freeze();
    end('chat:1', 'failed');
    expect(opened).toHaveLength(1);
    expect(setup({}, file).svc.get('r1')?.items.map((i) => i.state)).toEqual(['interrupted', 'pending']);
  });

  it('arquivo com lixo: lê o que dá', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-runs-'));
    const file = join(dir, 'runs.json');
    writeFileSync(file, '{oops');
    expect(setup({}, file).svc.list()).toEqual([]);
    const ok = { id: 'r9', createdAt: 1, state: 'done', options, stopOnFail: true, wantIsolated: false, items: [{ text: 'a', state: 'done' }] };
    writeFileSync(file, JSON.stringify([null, 3, { id: 'x' }, { ...ok, items: 'no' }, ok]));
    expect(setup({}, file).svc.list().map((r) => r.id)).toEqual(['r9']);
  });

  it('grava em runs.json', async () => {
    const { svc, file } = setup();
    await svc.create({ items: items('a'), options });
    expect(JSON.parse(readFileSync(file, 'utf8'))[0]).toMatchObject({ id: 'r1', state: 'running' });
  });

  it('cópia isolada: um worktree para a lista toda; Juntar/Descartar só parada; descartar devolve os agentes à pasta', async () => {
    const create = vi.fn(async () => ({ path: 'C:\\wt', branch: 'agentic/lista-1', base: 'abc' }));
    const merge = vi.fn(async () => ({ ok: true as const }));
    const discard = vi.fn(async () => ({ ok: true as const }));
    const worktrees = { create, merge, discard, summary: vi.fn(), diff: vi.fn() };
    const { svc, opened, end, chat } = setup({ worktrees });
    await svc.create({ items: items('a', 'b'), options, isolated: true });
    await flush();
    expect(create).toHaveBeenCalledWith(PROJ, 'r1', 'lista');
    expect(opened[0].run).toEqual({ cwd: 'C:\\wt' });
    expect(await svc.merge('r1')).toMatchObject({ status: 409 });
    end('chat:1', 'done');
    expect(opened[1].run).toEqual({ cwd: 'C:\\wt' });
    end('chat:2', 'done');
    expect(await svc.discard('r1')).toEqual({ ok: true });
    expect(chat.restoreCwd.mock.calls.map((c) => c[0])).toEqual(['chat:1', 'chat:2']);
    expect(svc.get('r1')?.isolated).toMatchObject({ discarded: true });
    expect(await svc.merge('r1')).toMatchObject({ status: 409 });
  });

  it('cópia que não nasce: a lista falha sem abrir agente', async () => {
    const worktrees = { create: vi.fn(async () => ({ error: 'não é git' })), merge: vi.fn(), discard: vi.fn(), summary: vi.fn(), diff: vi.fn() };
    const { svc, opened } = setup({ worktrees });
    await svc.create({ items: items('a'), options, isolated: true });
    await flush();
    expect(svc.get('r1')).toMatchObject({ state: 'failed', note: 'não é git' });
    expect(opened).toHaveLength(0);
  });

  it('itens do VBoards abrem pelo begin (com o opener da lista) e falha dele vira item falho', async () => {
    const begin = vi.fn(async (raw: unknown, open: (r: unknown) => unknown) => {
      const b = raw as { id: string; chat: unknown };
      if (b.id === 'c:2') return { status: 409, error: 'esta tarefa já foi iniciada' };
      return open(b.chat) as { agentId: string };
    });
    const { svc, opened, end } = setup({ vboards: { begin } });
    await svc.create({ items: [{ text: 'T1', vboardsTaskId: 'c:1' }, { text: 'T2', vboardsTaskId: 'c:2' }, { text: 'livre' }], options, stopOnFail: false });
    await flush();
    expect(begin.mock.calls[0][0]).toEqual({ id: 'c:1', folder: PROJ, chat: { ...options, prompt: 'T1' } });
    expect(opened[0].run).toEqual({});
    end('chat:1', 'done', 'ok');
    await flush();
    expect(svc.get('r1')?.items[1]).toMatchObject({ state: 'failed', summary: 'esta tarefa já foi iniciada' });
    expect(opened.map((o) => o.raw.prompt)).toEqual(['T1', 'livre']);
  });

  it('lista automática: portão reprova → volta uma vez ao agente → item em review com o relatório; nunca junta', async () => {
    const worktrees = { create: vi.fn(async () => ({ path: 'C:\wt', branch: 'agentic/lista-1', base: 'abc' })), merge: vi.fn(), discard: vi.fn(), summary: vi.fn(), diff: vi.fn(async () => 'diff --git a/x b/x') };
    const failed = { ok: false, tail: 'teste quebrou' };
    // O item 1 reprova duas vezes (antes e depois da correção); o item 2 passa.
    const gate = { checks: vi.fn(async (_cmd: string, _cwd: string) => ({ ok: true, tail: '' })).mockResolvedValueOnce(failed).mockResolvedValueOnce(failed), review: vi.fn(async () => ({ ok: true, findings: 'OK', by: 'claude/sonnet' })) };
    const { svc, opened, end, chat } = setup({ worktrees, gate });
    svc.create({ items: items('a', 'b'), options, isolated: true }, { check: 'npm test', reviewer: 'claude', reviewerModel: 'sonnet' });
    await flush();
    end('chat:1', 'done', 'Feito.');
    await flush();
    expect(gate.checks).toHaveBeenCalledWith('npm test', 'C:\wt');
    expect(chat.send).toHaveBeenCalledTimes(1);
    expect(chat.send.mock.calls[0][0]).toBe('chat:1');
    expect(svc.gateState('chat:1')).toBe('pending');
    expect(opened).toHaveLength(1);
    end('chat:1', 'done', 'Corrigi.');
    await flush();
    expect(chat.send).toHaveBeenCalledTimes(1);
    const item = svc.get('r1')!.items[0];
    expect(item).toMatchObject({ state: 'review', retried: true });
    expect(item.report).toContain('agentic/lista-1');
    expect(item.report).toContain('teste quebrou');
    expect(svc.gateState('chat:1')).toBe('review');
    expect(svc.reportOf('chat:1')).toBe(item.report);
    expect(opened).toHaveLength(2);
    end('chat:2', 'done');
    await flush();
    expect(svc.get('r1')?.state).toBe('done');
    expect(worktrees.merge).not.toHaveBeenCalled();
    expect(worktrees.discard).not.toHaveBeenCalled();
  });

  it('lista automática que passa no portão: review direto, sem mandar nada ao agente', async () => {
    const worktrees = { create: vi.fn(async () => ({ path: 'C:\wt', branch: 'agentic/lista-1', base: 'abc' })), merge: vi.fn(), discard: vi.fn(), summary: vi.fn(), diff: vi.fn(async () => '') };
    const gate = { checks: vi.fn(async () => ({ ok: true, tail: '' })), review: vi.fn() };
    const { svc, end, chat } = setup({ worktrees, gate });
    svc.create({ items: items('a'), options, isolated: true }, { reviewer: 'codex' });
    await flush();
    end('chat:1', 'done', 'Feito.');
    await flush();
    expect(gate.checks).not.toHaveBeenCalled(); // sem vboards.check
    expect(gate.review).not.toHaveBeenCalled(); // diff vazio
    expect(chat.send).not.toHaveBeenCalled();
    expect(svc.get('r1')?.items[0].state).toBe('review');
    expect(worktrees.merge).not.toHaveBeenCalled();
  });
});

describe('chat: listas depois de reiniciar o servidor', () => {
  const wt = () => ({ create: vi.fn(async () => ({ path: 'C:\wt', branch: 'agentic/lista-1', base: 'abc' })), merge: vi.fn(), discard: vi.fn(), summary: vi.fn(), diff: vi.fn(async () => 'diff --git a/x b/x') });
  const auto = { check: 'npm test', reviewer: 'claude' as const };

  it('automática: volta sozinha; o item interrompido segue no mesmo agente (rodada nova avisada), depois o resto', async () => {
    const first = setup({ worktrees: wt(), exists: () => true });
    first.svc.create({ items: items('a', 'b'), options, isolated: true }, auto);
    await flush();
    expect(first.opened).toHaveLength(1);
    const gate = { checks: vi.fn(async () => ({ ok: true, tail: '' })), review: vi.fn(async () => ({ ok: true, findings: 'OK', by: 'claude' })) };
    const again = setup({ worktrees: wt(), gate, exists: () => true }, first.file);
    expect(again.svc.get('r1')).toMatchObject({ state: 'queued', items: [{ state: 'pending', resume: true, agentId: 'chat:1' }, { state: 'pending' }] });
    expect(again.chat.send).not.toHaveBeenCalled();
    again.svc.tick();
    expect(again.chat.send).toHaveBeenCalledTimes(1);
    const [id, msg] = again.chat.send.mock.calls[0] as [string, { text: string }];
    expect(id).toBe('chat:1');
    expect(msg.text).toContain('git status');
    expect(msg.text.endsWith('\n\na')).toBe(true);
    expect(again.opened).toHaveLength(0);
    expect(again.svc.get('r1')?.items[0]).toMatchObject({ state: 'running', agentId: 'chat:1' });
    expect(again.svc.get('r1')?.items[0].resume).toBeUndefined();
    again.end('chat:1', 'done', 'Terminei.');
    await flush();
    expect(again.svc.get('r1')?.items[0].state).toBe('review');
    expect(again.opened.map((o) => o.raw.prompt)).toEqual(['b']);
    expect(again.opened[0].run).toEqual({ cwd: 'C:\wt' });
  });

  it('automática: o portão já tinha devolvido o erro uma vez; depois do reinício não devolve de novo', async () => {
    const failed = { ok: false, tail: 'teste quebrou' };
    const gate = { checks: vi.fn(async () => failed), review: vi.fn(async () => ({ ok: true, findings: 'OK', by: 'claude' })) };
    const first = setup({ worktrees: wt(), gate, exists: () => true });
    first.svc.create({ items: items('a'), options, isolated: true }, auto);
    await flush();
    first.end('chat:1', 'done', 'Feito.');
    await flush();
    expect(first.chat.send).toHaveBeenCalledTimes(1); // a única volta do portão
    const again = setup({ worktrees: wt(), gate, exists: () => true }, first.file);
    again.svc.tick();
    expect(again.chat.send).toHaveBeenCalledTimes(1); // só o aviso do reinício
    again.end('chat:1', 'done', 'Corrigi.');
    await flush();
    expect(again.chat.send).toHaveBeenCalledTimes(1);
    expect(again.svc.get('r1')?.items[0]).toMatchObject({ state: 'review', retried: true });
    expect(again.svc.get('r1')?.state).toBe('done');
  });

  it('cópia isolada que sumiu: a lista falha com o motivo, sem abrir nem retomar agente', async () => {
    const first = setup({ worktrees: wt(), exists: () => true });
    first.svc.create({ items: items('a'), options, isolated: true }, auto);
    await flush();
    const again = setup({ worktrees: wt(), exists: () => false }, first.file);
    expect(again.svc.get('r1')).toMatchObject({ state: 'failed', items: [{ state: 'interrupted' }] });
    expect(again.svc.get('r1')?.note).toContain('C:\wt');
    again.svc.tick();
    expect(again.svc.continue('r1')).toBe('ok');
    expect(again.svc.get('r1')?.state).toBe('failed');
    expect(again.chat.send).not.toHaveBeenCalled();
    expect(again.opened).toHaveLength(0);
  });

  it('agente que não retoma (ex.: orçamento esgotado): o item falha com o motivo', async () => {
    const first = setup({ worktrees: wt(), exists: () => true });
    first.svc.create({ items: items('a'), options, isolated: true, stopOnFail: false }, auto);
    await flush();
    const again = setup({ worktrees: wt(), exists: () => true }, first.file);
    again.chat.send.mockReturnValueOnce('blocked' as 'ok');
    again.svc.tick();
    await flush();
    expect(again.svc.get('r1')?.items[0]).toMatchObject({ state: 'failed' });
    expect(again.svc.get('r1')?.items[0].summary).toContain('blocked');
    expect(again.chat.send).toHaveBeenCalledTimes(1);
  });
});

describe('chat: listas e a cota da conta', () => {
  const wt = () => ({ create: vi.fn(async () => ({ path: 'C:\wt', branch: 'agentic/lista-1', base: 'abc' })), merge: vi.fn(), discard: vi.fn(), summary: vi.fn(), diff: vi.fn(async () => '') });
  const auto = { reviewer: 'claude' as const };
  function withQuota(over: Partial<RunDeps> = {}) {
    let block: ReturnType<NonNullable<RunDeps['quota']>> = undefined;
    let now = 100;
    const notify = vi.fn();
    const quota = vi.fn(() => block);
    const s = setup({ quota, notify, now: () => now, exists: () => true, ...over });
    return { ...s, quota, notify, set: (b: typeof block) => void (block = b), at: (t: number) => void (now = t) };
  }

  it('automática com a cota no limite: nem começa, pausa com a janela e avisa UMA vez; volta sozinha depois do reinício', async () => {
    const t = withQuota({ worktrees: wt(), newId: (() => { let n = 0; return () => `r${++n}`; })() });
    t.set({ window: '5h', pct: 93, resetsAt: 1000 });
    const r = run(t.svc.create({ items: items('a'), options: { ...options, account: '.claude-b' } }, auto));
    expect(t.quota).toHaveBeenCalledWith('claude', '.claude-b');
    expect(r).toMatchObject({ state: 'paused', quota: { window: '5h', pct: 93, resetsAt: 1000 } });
    expect(t.opened).toHaveLength(0);
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify).toHaveBeenCalledWith('proj', 'quota');
    // Tarefas novas da mesma pasta esperam a pausada (sem outro aviso).
    expect(t.svc.create({ items: items('b'), options }, auto)).toMatchObject({ status: 409 });
    t.svc.tick();
    expect(t.opened).toHaveLength(0); // antes do reinício
    t.at(1001);
    t.svc.tick();
    expect(t.opened).toHaveLength(0); // reiniciou, mas a leitura ainda diz cheia
    t.set(undefined);
    t.svc.tick();
    await flush();
    expect(t.svc.get('r1')).toMatchObject({ state: 'running' });
    expect(t.svc.get('r1')?.quota).toBeUndefined();
    expect(t.opened).toHaveLength(1);
    expect(t.notify).toHaveBeenCalledTimes(1);
  });

  it('pausa antes do próximo item; a manual só volta com Continuar, que passa por cima da cota com aviso', async () => {
    const t = withQuota();
    t.svc.create({ items: items('a', 'b', 'c'), options });
    expect(t.opened).toHaveLength(1);
    t.set({ window: 'week', pct: 97 });
    t.end('chat:1', 'done');
    expect(t.svc.get('r1')).toMatchObject({ state: 'paused', quota: { window: 'week', pct: 97 } });
    expect(t.svc.get('r1')?.items.map((i) => i.state)).toEqual(['done', 'pending', 'pending']);
    expect(t.notify).toHaveBeenCalledTimes(1);
    t.set(undefined);
    t.svc.tick();
    expect(t.opened).toHaveLength(1); // manual: nada volta sozinho
    t.set({ window: 'week', pct: 97 });
    expect(t.svc.continue('r1')).toBe('ok');
    expect(t.svc.get('r1')).toMatchObject({ state: 'running', quotaOverride: true });
    expect(t.svc.get('r1')?.note).toContain('97%');
    expect(t.opened).toHaveLength(2);
    t.end('chat:2', 'done');
    expect(t.opened).toHaveLength(3); // a pessoa já decidiu: não pausa de novo
  });

  it('"Rodar lista" com a cota no limite roda (a pessoa decidiu) e deixa o aviso; cota desconhecida não trava', () => {
    const t = withQuota();
    t.set({ window: '5h', pct: 91 });
    const r = run(t.svc.create({ items: items('a'), options }));
    expect(r).toMatchObject({ state: 'running', quotaOverride: true });
    expect(r.note).toContain('91%');
    expect(t.opened).toHaveLength(1);
    expect(t.notify).not.toHaveBeenCalled();
    const free = setup({ newId: () => 'r2' });
    expect(run(free.svc.create({ items: items('a'), options }, auto)).state).toBe('running');
  });
});

describe('chat: comentários por linha no diff (revisão)', () => {
  const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n um\n-dois\n+DOIS\n';
  const wt = () => ({ create: vi.fn(async () => ({ path: 'C:\wt', branch: 'agentic/lista-1', base: 'abc' })), merge: vi.fn(), discard: vi.fn(), summary: vi.fn(), diff: vi.fn(async () => DIFF) });
  const c = (over: Record<string, unknown> = {}) => ({ file: 'src/a.ts', line: 2, side: 'new', text: 'use uma constante', ...over });

  it('valida: até 50, texto até 2000, linha e lado válidos', () => {
    expect(parseComments({ comments: [] })).toHaveProperty('error');
    expect(parseComments({ comments: Array.from({ length: 51 }, () => c()) })).toHaveProperty('error');
    expect(parseComments({ comments: [c({ text: 'x'.repeat(2001) })] })).toHaveProperty('error');
    expect(parseComments({ comments: [c({ text: '   ' })] })).toHaveProperty('error');
    expect(parseComments({ comments: [c({ line: 0 })] })).toHaveProperty('error');
    expect(parseComments({ comments: [c({ line: 1.5 })] })).toHaveProperty('error');
    expect(parseComments({ comments: [c({ side: 'meio' })] })).toHaveProperty('error');
    expect(parseComments({ comments: [c({ file: 'a\nb' })] })).toHaveProperty('error');
    expect(parseComments(null)).toHaveProperty('error');
    expect(parseComments({ comments: Array.from({ length: 50 }, () => c({ text: 'x'.repeat(2000) })) })).toHaveLength(50);
  });

  it('mensagem: uma linha por comentário, arquivo:linha — comentário', () => {
    const msg = feedbackMessage([c({ text: 'primeira\nsegunda' }) as never, c({ line: 2, side: 'old', text: 'por que tirou?' }) as never]);
    const lines = msg.split('\n');
    expect(lines[0]).toContain('sem git push');
    expect(lines.slice(2)).toEqual(['- src/a.ts:2 — primeira segunda', '- src/a.ts:2 (linha antiga, removida) — por que tirou?']);
  });

  async function reviewed() {
    const gate = { checks: vi.fn(async () => ({ ok: true, tail: '' })), review: vi.fn(async () => ({ ok: true, findings: 'OK', by: 'claude' })) };
    const vboards = { begin: vi.fn(async (raw: unknown, open: (r: unknown) => unknown) => open((raw as { chat: unknown }).chat) as { agentId: string }), reopen: vi.fn(() => true) };
    const worktrees = wt();
    const s = setup({ worktrees, gate, vboards, exists: () => true });
    s.svc.create({ items: [{ text: 'a', vboardsTaskId: 'c:1' }], options, isolated: true }, { check: 'npm test', reviewer: 'claude' });
    await flush();
    s.end('chat:1', 'done', 'Feito.');
    await flush();
    expect(s.svc.get('r1')).toMatchObject({ state: 'done', items: [{ state: 'review' }] });
    return { ...s, gate, vboards, worktrees };
  }

  it('manda UMA mensagem ao mesmo agente; o item volta a rodar, o portão roda de novo (com a volta de correção outra vez) e termina em review', async () => {
    const s = await reviewed();
    expect(await s.svc.feedback('r1', 0, { comments: [c()] })).toEqual({ ok: true });
    expect(s.chat.send).toHaveBeenCalledTimes(1);
    expect(s.chat.send.mock.calls[0][0]).toBe('chat:1');
    expect((s.chat.send.mock.calls[0][1] as { text: string }).text).toContain('- src/a.ts:2 — use uma constante');
    expect(s.svc.get('r1')).toMatchObject({ state: 'running', resumeTo: 'done', items: [{ state: 'running', agentId: 'chat:1' }] });
    expect(s.svc.gateState('chat:1')).toBe('pending');
    expect(s.vboards.reopen).toHaveBeenCalledWith('chat:1');
    // Comentário enquanto roda: recusado.
    expect(await s.svc.feedback('r1', 0, { comments: [c()] })).toMatchObject({ status: 409 });
    s.gate.checks.mockResolvedValueOnce({ ok: false, tail: 'quebrou' });
    s.end('chat:1', 'done', 'Mudei.');
    await flush();
    expect(s.chat.send).toHaveBeenCalledTimes(2); // a volta de correção do portão, disponível de novo
    s.end('chat:1', 'done', 'Corrigi.');
    await flush();
    expect(s.svc.get('r1')).toMatchObject({ state: 'done', items: [{ state: 'review', retried: true }] });
    expect(s.svc.get('r1')?.resumeTo).toBeUndefined();
    expect(s.svc.gateState('chat:1')).toBe('review');
    expect(s.opened).toHaveLength(1);
    expect(s.worktrees.merge).not.toHaveBeenCalled();
  });

  it('recusa: arquivo fora do diff, item que não terminou, sem cópia aberta, lista/item desconhecido', async () => {
    const s = await reviewed();
    expect(await s.svc.feedback('r1', 0, { comments: [c({ file: 'src/b.ts' })] })).toMatchObject({ status: 400 });
    expect(await s.svc.feedback('r1', 5, { comments: [c()] })).toMatchObject({ status: 404 });
    expect(await s.svc.feedback('nada', 0, { comments: [c()] })).toMatchObject({ status: 404 });
    expect(await s.svc.feedback('r1', 0, { comments: [] })).toMatchObject({ status: 400 });
    s.worktrees.discard.mockResolvedValue({ ok: true });
    await s.svc.discard('r1');
    expect(await s.svc.feedback('r1', 0, { comments: [c()] })).toMatchObject({ status: 409 });
    expect(await s.svc.diff('r1')).toMatchObject({ status: 409 });
    expect(s.chat.send).not.toHaveBeenCalled();
  });

  it('diff da cópia aberta', async () => {
    const s = await reviewed();
    expect(await s.svc.diff('r1')).toEqual({ diff: DIFF });
    expect(await s.svc.diff('nada')).toMatchObject({ status: 404 });
  });
});

describe('chat: métricas das listas (run-metrics.jsonl)', () => {
  const wt = () => ({ create: vi.fn(async () => ({ path: 'C:\wt', branch: 'agentic/lista-1', base: 'abc' })), merge: vi.fn(), discard: vi.fn(), summary: vi.fn(), diff: vi.fn(async () => 'diff --git a/x b/x') });

  it('uma linha por item que termina: estado, portão, volta, tempo, gasto do agente, provedor e modelo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-metrics-'));
    const metricsFile = join(dir, 'run-metrics.jsonl');
    let now = 100;
    const gate = { checks: vi.fn(async () => ({ ok: true, tail: '' })), review: vi.fn(async () => ({ ok: true, findings: 'OK', by: 'claude' })) };
    const t = setup({ metricsFile, worktrees: wt(), gate, exists: () => true, now: () => now });
    (t.chat as unknown as { record: (id: string) => unknown }).record = (id: string) => ({ spend: { usd: id === 'chat:1' ? 0.75 : 0, tokens: 1234 } });
    t.svc.create({ items: items('a', 'b'), options: { ...options, model: 'sonnet' }, isolated: true }, { check: 'npm test', reviewer: 'claude' });
    await flush();
    now = 5_100;
    t.end('chat:1', 'done', 'Feito.');
    await flush();
    now = 6_000;
    t.svc.stop('r1');
    const lines = readMetrics(metricsFile);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ at: 5_100, runId: 'r1', folder: PROJ, state: 'review', gate: 'pass', retried: false, ms: 5_000, usd: 0.75, tokens: 1234, provider: 'claude', model: 'sonnet' });
    expect(lines[1]).toMatchObject({ state: 'interrupted', gate: 'none' });
    expect(readMetrics(metricsFile, 5_101)).toHaveLength(1);
  });

  it('corte no load: acima de 2 MB ficam só os últimos 90 dias; abaixo, nada muda', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hb-metrics-')), 'm.jsonl');
    const now = 200 * 24 * 60 * 60_000;
    const old = { at: now - METRICS_KEEP_MS - 1, runId: 'velho', folder: PROJ, state: 'done', gate: 'none', retried: false, ms: 1, usd: 0, tokens: 0, provider: 'claude', pad: 'x'.repeat(2000) };
    writeFileSync(file, `${JSON.stringify(old)}\n`.repeat(Math.ceil(METRICS_TRIM_BYTES / 2000) + 10) + `${JSON.stringify({ ...old, at: now - 1000, runId: 'novo' })}\nlixo\n`);
    trimMetrics(file, now);
    expect(readMetrics(file).map((m) => m.runId)).toEqual(['novo']);
    const small = join(mkdtempSync(join(tmpdir(), 'hb-metrics-')), 'm.jsonl');
    writeFileSync(small, `${JSON.stringify(old)}\n`);
    trimMetrics(small, now);
    expect(readMetrics(small)).toHaveLength(1);
  });
});

describe('chat: lista, registro por projeto e o fim no VBoards', () => {
  it('mensagem do Juntar: as tarefas que terminaram, sem o prefixo do VBoards', () => {
    expect(mergeMessage([{ text: 'Corrigir o login\ncom detalhes', state: 'done' }])).toBe('Corrigir o login');
    const m = mergeMessage([
      { text: 'Tarefa do VBoards (card Posts Builder): Tela de perfil', vboardsTaskId: 'c:1', state: 'review' },
      { text: 'Testes', state: 'done' },
      { text: 'Falhou', state: 'failed' },
    ]);
    expect(m).toBe('Tela de perfil (e mais 1)\n\n- Tela de perfil\n- Testes');
    expect(itemTitle({ text: 'Tarefa do VBoards (card X): [server] Y', vboardsTaskId: 'c:1' })).toBe('[server] Y');
  });

  it('grava as etapas no journal e, no Juntar/Descartar, avisa o VBoards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-runs-j-'));
    const journalFile = join(dir, 'journal.jsonl');
    const merge = vi.fn(async (_r: string, _w: unknown, _m: string) => ({ ok: true as const }));
    const worktrees = { create: vi.fn(async () => ({ path: 'C:\wt', branch: 'agentic/lista-1', base: 'abc' })), merge, discard: vi.fn(async () => ({ ok: true as const })), summary: vi.fn(), diff: vi.fn() };
    const settle = vi.fn(() => true);
    const vboards = { begin: vi.fn(async () => ({ agentId: 'chat:1' })), settle };
    const { svc, end } = setup({ worktrees, vboards, journalFile, productOf: () => 'posts' });
    await svc.create({ items: [{ text: 'Tarefa do VBoards (card P): Login', vboardsTaskId: 'c1:s1' }], options, isolated: true });
    await flush();
    await flush();
    end('chat:1', 'done');
    expect(await svc.merge('r1')).toEqual({ ok: true });
    expect(merge.mock.calls[0][2]).toBe('Login');
    expect(settle).toHaveBeenCalledWith('c1:s1', { state: 'done', stage: 'merged' });
    expect(readJournal(journalFile).map((e) => [e.stage, e.product, e.cardId, e.subtaskId, e.title, e.ref])).toEqual([
      ['queued', 'posts', 'c1', 's1', 'Login', 'r1#0'],
      ['running', 'posts', 'c1', 's1', 'Login', 'r1#0'],
      ['review', 'posts', 'c1', 's1', 'Login', 'r1#0'],
      ['merged', 'posts', 'c1', 's1', 'Login', 'r1#0'],
    ]);
  });

  it('Descartar: failed com o motivo no VBoards e discarded no journal', async () => {
    const journalFile = join(mkdtempSync(join(tmpdir(), 'hb-runs-j-')), 'journal.jsonl');
    const worktrees = { create: vi.fn(async () => ({ path: 'C:\wt', branch: 'agentic/lista-1', base: 'abc' })), merge: vi.fn(), discard: vi.fn(async () => ({ ok: true as const })), summary: vi.fn(), diff: vi.fn() };
    const settle = vi.fn(() => true);
    const { svc, end } = setup({ worktrees, vboards: { begin: vi.fn(async () => ({ agentId: 'chat:1' })), settle }, journalFile });
    await svc.create({ items: [{ text: 'X', vboardsTaskId: 'c1:s1' }], options, isolated: true });
    await flush();
    await flush();
    end('chat:1', 'done');
    await svc.discard('r1');
    expect(settle).toHaveBeenCalledWith('c1:s1', { state: 'failed', stage: 'discarded', summary: expect.stringContaining('Descartado') });
    expect(readJournal(journalFile).at(-1)).toMatchObject({ stage: 'discarded', folder: PROJ });
  });

  it('Juntar × Subir: subida em andamento trava Juntar e Descartar; depois do PR, Juntar não cabe', async () => {
    const worktrees = { create: vi.fn(async () => ({ path: 'C:\\wt', branch: 'agentic/lista-1', base: 'abc' })), merge: vi.fn(async () => ({ ok: true as const })), discard: vi.fn(async () => ({ ok: true as const })), summary: vi.fn(), diff: vi.fn() };
    const { svc, end } = setup({ worktrees, vboards: { begin: vi.fn(async () => ({ agentId: 'chat:1' })) } });
    await svc.create({ items: [{ text: 'X', vboardsTaskId: 'c1:s1' }], options, isolated: true });
    await flush();
    await flush();
    end('chat:1', 'done');
    const run = svc.get('r1')!;
    run.ship = { step: 'ci', mode: 'merge', sha: 'a'.repeat(40), owner: 'o', repo: 'r', remote: 'origin', base: 'main', branch: 'agentic/lista-1', deploy: 'none', ciMinutes: 30, startedAt: 0, stepAt: 0, prUrl: 'u' };
    expect(await svc.merge('r1')).toMatchObject({ status: 409, error: expect.stringMatching(/Subir/) });
    expect(await svc.discard('r1')).toMatchObject({ status: 409 });
    run.ship = { ...run.ship, mode: 'pr', step: 'pr' };
    expect(await svc.merge('r1')).toMatchObject({ status: 409, error: expect.stringMatching(/já subiu/) });
    expect(worktrees.merge).not.toHaveBeenCalled();
    expect(await svc.discard('r1')).toEqual({ ok: true });
  });
});
