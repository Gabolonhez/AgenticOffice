import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChatRun } from '../../shared/runs';
import { RunService, type RunDeps } from './runs';

const PROJ = 'C:\\proj';
const options = { folder: PROJ, provider: 'claude', permission: 'auto', limits: {} };

function fakeChat() {
  const listeners: Array<(id: string) => void> = [];
  const outcomes = new Map<string, 'done' | 'failed'>();
  const replies = new Map<string, string>();
  const opened: Array<{ id: string; raw: Record<string, unknown>; run?: { cwd?: string } }> = [];
  let n = 0;
  const chat = {
    check: vi.fn((raw: { folder?: string }) => (raw.folder === PROJ ? undefined : { error: 'invalid' as const, reason: 'Pasta desconhecida' })),
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

  it('uma lista rodando por vez', async () => {
    const { svc } = setup({ newId: (() => { let n = 0; return () => `r${++n}`; })() });
    await svc.create({ items: items('a'), options });
    expect(await svc.create({ items: items('b'), options })).toMatchObject({ status: 409 });
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
    const worktrees = { create, merge, discard, summary: vi.fn() };
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
    const worktrees = { create: vi.fn(async () => ({ error: 'não é git' })), merge: vi.fn(), discard: vi.fn(), summary: vi.fn() };
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
});
