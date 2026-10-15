import { describe, expect, it, vi } from 'vitest';
import type { AgentInfo } from '../../shared/types';
import { setQuiet } from '../log';
import { baseFromUrl, decideCompletion, matchFolders, resolveConfig, SUMMARY_MAX, TodoTracker, TODOS_QUIET_MS, VBoardsService } from './vboards';

setQuiet(true);
const flush = () => new Promise((ok) => setTimeout(ok, 0));

describe('configuração do VBoards', () => {
  it('vboards.url dos commits vira a base', () => {
    expect(baseFromUrl('https://vboards.vercel.app/api/commits')).toBe('https://vboards.vercel.app');
    expect(baseFromUrl('https://vboards.vercel.app/api/commits/')).toBe('https://vboards.vercel.app');
    expect(baseFromUrl('https://x.dev/')).toBe('https://x.dev');
    expect(baseFromUrl('ftp://x.dev')).toBeUndefined();
    expect(baseFromUrl('não é url')).toBeUndefined();
    expect(baseFromUrl(undefined)).toBeUndefined();
  });

  it('variáveis valem antes do git config; faltando algo, desligado', () => {
    const git = { url: 'https://a.dev/api/commits', token: 't1', email: 'a@x' };
    expect(resolveConfig({}, git)).toEqual({ base: 'https://a.dev', token: 't1', email: 'a@x' });
    expect(resolveConfig({ HABBLAUD_VBOARDS_URL: 'https://b.dev', HABBLAUD_VBOARDS_TOKEN: 't2', HABBLAUD_VBOARDS_EMAIL: 'b@x' }, git)).toEqual({ base: 'https://b.dev', token: 't2', email: 'b@x' });
    expect(resolveConfig({ HABBLAUD_VBOARDS: '0' }, git)).toHaveProperty('off');
    expect(resolveConfig({}, { ...git, token: undefined })).toHaveProperty('off');
    expect(resolveConfig({}, { ...git, email: '' })).toHaveProperty('off');
    expect(resolveConfig({}, { ...git, url: undefined })).toHaveProperty('off');
  });
});

describe('pasta da tarefa', () => {
  const folders = [
    { path: 'C:\\Projects\\paypost\\payposts-web', card: 'PostsBuilder' },
    { path: 'C:\\Projects\\habblaud' },
    { path: '/Users/a/Agentic-Office' },
    { path: '/Users/b/agentic_office' },
  ];
  it('pelo nome da pasta ou pelo vboards.card, sem caixa nem pontuação', () => {
    expect(matchFolders('Posts Builder', folders)).toEqual(['C:\\Projects\\paypost\\payposts-web']);
    expect(matchFolders('payposts-web', folders)).toEqual(['C:\\Projects\\paypost\\payposts-web']);
    expect(matchFolders('HABBLAUD', folders)).toEqual(['C:\\Projects\\habblaud']);
    expect(matchFolders('AgenticOffice', folders)).toHaveLength(2);
    expect(matchFolders('outro', folders)).toEqual([]);
    expect(matchFolders('', folders)).toEqual([]);
  });
});

describe('conclusão da subtarefa', () => {
  const stats = (tokensOut = 0) => ({ toolCalls: 0, tokensIn: 0, tokensOut, subagents: 0 });
  it('termina o turno depois de trabalhar = done; sessão acaba sem trabalhar = failed', () => {
    expect(decideCompletion({}, { status: 'working', stats: stats() })).toBeUndefined();
    expect(decideCompletion({ worked: true }, { status: 'idle', stats: stats() })).toBe('done');
    expect(decideCompletion({}, { status: 'idle', stats: stats(50) })).toBe('done');
    expect(decideCompletion({}, { status: 'idle', stats: stats() })).toBeUndefined();
    expect(decideCompletion({ worked: true }, { status: 'waiting', stats: stats(5) })).toBeUndefined();
    expect(decideCompletion({ worked: true }, { status: 'shell', stats: stats(5) })).toBeUndefined();
    expect(decideCompletion({ worked: true }, undefined)).toBe('done');
    expect(decideCompletion({}, { status: 'offline', stats: stats() })).toBe('failed');
    expect(decideCompletion({}, undefined)).toBe('failed');
  });
});

describe('todos', () => {
  const agent = (id: string, titles: Array<[string, boolean]>) => ({
    id,
    tasks: titles.map(([title, done], i) => ({ id: String(i), title, status: done ? ('completed' as const) : ('pending' as const) })),
  });
  it('espera a lista ficar calma, manda uma vez e de novo só quando muda', () => {
    const t = new TodoTracker();
    const a = agent('a', [['x', false]]);
    expect(t.due([a], 0)).toEqual([]);
    expect(t.due([a], TODOS_QUIET_MS - 1)).toEqual([]);
    const due = t.due([a], TODOS_QUIET_MS);
    expect(due).toEqual([{ id: 'a', sig: expect.any(String), todos: [{ text: 'x', done: false }] }]);
    t.posted('a', due[0].sig);
    expect(t.due([a], TODOS_QUIET_MS * 3)).toEqual([]);
    const b = agent('a', [['x', true]]);
    expect(t.due([b], 100_000)).toEqual([]);
    expect(t.due([b], 100_000 + TODOS_QUIET_MS)[0].todos).toEqual([{ text: 'x', done: true }]);
    // Volta ao que já foi mandado: nada a mandar (falha no envio continua pendente).
    expect(t.due([agent('e', [])], 0)).toEqual([]);
  });
});

describe('serviço', () => {
  const cfg = { base: 'https://vb.dev', token: 'segredo', email: 'eu@x' };
  const mainAgent = (p: Partial<AgentInfo>): AgentInfo =>
    ({ id: 'acc:1', kind: 'main', roomId: 'r1', name: 'Ana', look: 'f', role: '', sessionId: 's', account: 'acc', status: 'idle', recent: [], tasks: [], startedAt: 2_000, lastEventAt: 0, statusSince: 0, stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, seed: 1, ...p }) as AgentInfo;

  function setup(over: { spawnStatus?: 'opened' | 'failed' } = {}) {
    let now = 100_000;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const body = String(url).includes('/api/agent-tasks?') ? { tasks: [{ cardId: 'c1', subtaskId: 's1', text: 'Corrigir o login', cardTitle: 'Posts Builder', date: '2026-10-15' }] } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const submit = vi.fn(() => ({ spawn: { id: 'sp1', folder: '/p/payposts-web', status: 'queued' as const } }));
    let agents: AgentInfo[] = [];
    const svc = new VBoardsService({
      config: cfg,
      agents: () => agents,
      roomPath: (id) => (id === 'r1' ? '/p/payposts-web' : undefined),
      folders: async () => ['/p/payposts-web', '/p/outro'],
      cardOf: async (f) => (f.endsWith('payposts-web') ? 'PostsBuilder' : undefined),
      spawn: { submit, get: () => ({ id: 'sp1', folder: '/p/payposts-web', status: over.spawnStatus ?? 'opened' }) },
      reply: () => `Pronto. token sk-ant-api03-${'a'.repeat(40)} ${'x'.repeat(3000)}`,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });
    return { svc, calls, submit, setAgents: (a: AgentInfo[]) => (agents = a), tick: (ms: number) => (now += ms) };
  }

  it('lista, inicia só com a pasta do servidor, manda running, liga o agente e conclui uma vez', async () => {
    const { svc, calls, submit, setAgents, tick } = setup();
    await svc.poll();
    svc.stop();
    expect(calls[0].url).toBe('https://vb.dev/api/agent-tasks?email=eu%40x');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer segredo');
    const [view] = await svc.list();
    expect(view).toMatchObject({ id: 'c1:s1', cardTitle: 'Posts Builder', folder: '/p/payposts-web' });

    expect(await svc.begin({ id: 'c1:s1', folder: '/etc' })).toEqual({ status: 400, error: expect.any(String) });
    expect(await svc.begin({ id: 'nada' })).toMatchObject({ status: 404 });
    expect(await svc.begin({ id: 'c1:s1' })).toHaveProperty('spawn');
    expect(submit).toHaveBeenCalledWith({ folder: '/p/payposts-web', prompt: 'Tarefa do VBoards (card Posts Builder): Corrigir o login' });
    expect(await svc.begin({ id: 'c1:s1' })).toMatchObject({ status: 409 });
    expect(await svc.list()).toEqual([]);
    await svc.check();
    const updates = () => calls.filter((c) => c.url.endsWith('/update')).map((c) => JSON.parse(String(c.init.body)));
    expect(updates()).toEqual([{ email: 'eu@x', cardId: 'c1', subtaskId: 's1', status: 'running' }]);

    // Agente antigo na pasta não conta; o novo trabalha e termina o turno.
    setAgents([mainAgent({ id: 'old', startedAt: 0, status: 'working' }), mainAgent({ status: 'working', startedAt: 101_000 })]);
    tick(5_000);
    await svc.check();
    expect(updates()).toHaveLength(1);
    setAgents([mainAgent({ status: 'idle', startedAt: 101_000 })]);
    await svc.check();
    await svc.check();
    await flush();
    const done = updates().slice(1);
    expect(done).toHaveLength(1);
    expect(done[0].status).toBe('done');
    expect(done[0].summary).toHaveLength(SUMMARY_MAX);
    expect(done[0].summary).not.toContain('sk-ant-api03-aaaa');
  });

  it('spawn que falhou: failed, sem agente', async () => {
    const { svc, calls } = setup({ spawnStatus: 'failed' });
    await svc.poll();
    svc.stop();
    await svc.begin({ id: 'c1:s1', folder: '/p/outro' });
    await svc.check();
    await flush();
    const statuses = calls.filter((c) => c.url.endsWith('/update')).map((c) => JSON.parse(String(c.init.body)).status);
    expect(statuses).toEqual(['running', 'failed']);
  });

  it('todos do agente principal vão para o card da pasta (vboards.card)', async () => {
    const { svc, calls, setAgents, tick } = setup();
    setAgents([mainAgent({ tasks: [{ id: '1', title: 'Escrever testes', status: 'completed' }] })]);
    await svc.check();
    tick(TODOS_QUIET_MS);
    await svc.check();
    await svc.check();
    const posts = calls.filter((c) => c.url.endsWith('/todos')).map((c) => JSON.parse(String(c.init.body)));
    expect(posts).toEqual([{ email: 'eu@x', repo: 'PostsBuilder', todos: [{ text: 'Escrever testes', done: true }] }]);
  });
});
