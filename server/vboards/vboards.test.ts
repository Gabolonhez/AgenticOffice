import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentInfo } from '../../shared/types';
import { setQuiet } from '../log';
import { policyFile, readPolicy } from './policy';
import { baseFromUrl, decideCompletion, policyChangeNeedsPin, repoTag, matchFolders, parseFolderConfig, reportKey, taskFolders, parseRefineOutput, parseRefines, taskRisk, refinePrompt, REFINE_LIMITS, readFolderConfig, resolveConfig, validateFolderConfig, writeFolderConfig, REVIEW_SUMMARY_MAX, SUMMARY_MAX, TodoTracker, TODOS_QUIET_MS, VBoardsService, type FolderConfig } from './vboards';

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

describe('debounce das conversas', () => {
  it('espera ficar calmo, manda uma vez e de novo só quando muda', () => {
    const t = new TodoTracker();
    const x = [{ id: 'a', item: { text: 'x', done: false } }];
    expect(t.due(x, 0)).toEqual([]);
    expect(t.due(x, TODOS_QUIET_MS - 1)).toEqual([]);
    const due = t.due(x, TODOS_QUIET_MS);
    expect(due).toEqual([{ id: 'a', sig: expect.any(String), item: { text: 'x', done: false } }]);
    t.posted('a', due[0].sig);
    expect(t.due(x, TODOS_QUIET_MS * 3)).toEqual([]);
    const y = [{ id: 'a', item: { text: 'x', done: true, summary: 's' } }];
    expect(t.due(y, 100_000)).toEqual([]);
    expect(t.due(y, 100_000 + TODOS_QUIET_MS)[0].item).toEqual({ text: 'x', done: true, summary: 's' });
  });
});

describe('serviço', () => {
  const cfg = { base: 'https://vb.dev', token: 'segredo', email: 'eu@x' };
  const mainAgent = (p: Partial<AgentInfo>): AgentInfo =>
    ({ id: 'acc:1', kind: 'main', roomId: 'r1', name: 'Ana', look: 'f', role: '', sessionId: 's', account: 'acc', status: 'idle', recent: [], tasks: [], startedAt: 2_000, lastEventAt: 0, statusSince: 0, stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0, linesAdded: 1 }, seed: 1, ...p }) as AgentInfo;

  function setup(over: { spawnStatus?: 'opened' | 'failed'; chat?: boolean; outcome?: 'done' | 'failed' | 'review' } = {}) {
    let now = 100_000;
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const body = String(url).includes('/api/agent-tasks?') ? { tasks: [{ cardId: 'c1', subtaskId: 's1', text: 'Corrigir o login', cardTitle: 'Posts Builder', date: '2026-10-15' }] } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const submit = vi.fn(() => ({ spawn: { id: 'sp1', folder: '/p/payposts-web', status: 'queued' as const } }));
    const open = vi.fn(() => ({ agentId: 'chat:1' }));
    let agents: AgentInfo[] = [];
    let replyText = `Pronto. token sk-ant-api03-${'a'.repeat(40)} ${'x'.repeat(3000)}`;
    const svc = new VBoardsService({
      config: cfg,
      agents: () => agents,
      roomPath: (id) => (id === 'r1' ? '/p/payposts-web' : undefined),
      folders: async () => ['/p/payposts-web', '/p/outro'],
      cardOf: async (f) => (f.endsWith('payposts-web') ? 'PostsBuilder' : undefined),
      spawn: { submit, get: () => ({ id: 'sp1', folder: '/p/payposts-web', status: over.spawnStatus ?? 'opened' }) },
      reply: () => replyText,
      ...(over.chat ? { chat: { open, outcome: () => over.outcome } } : {}),
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });
    return { svc, calls, submit, open, setAgents: (a: AgentInfo[]) => (agents = a), tick: (ms: number) => (now += ms), setReply: (t: string) => (replyText = t) };
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

  it('com o chat: Iniciar abre pelo chat, o link já nasce com o agente e conclui com a resposta dele', async () => {
    const { svc, calls, submit, open, setAgents, setReply } = setup({ chat: true, outcome: 'done' });
    await svc.poll();
    svc.stop();
    expect(await svc.begin({ id: 'c1:s1', folder: '/p/payposts-web', chat: { provider: 'codex', model: 'x' } })).toEqual({ agentId: 'chat:1' });
    expect(submit).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith({ provider: 'codex', model: 'x', folder: '/p/payposts-web', prompt: 'Tarefa do VBoards (card Posts Builder): Corrigir o login', vboardsTaskId: 'c1:s1' });
    setReply('Feito: login corrigido.');
    setAgents([mainAgent({ id: 'chat:1', chat: true, status: 'idle', stats: { toolCalls: 1, tokensIn: 10, tokensOut: 5, subagents: 0 } })]);
    await svc.check();
    await flush();
    const updates = calls.filter((c) => c.url.endsWith('/update')).map((c) => JSON.parse(String(c.init.body)));
    expect(updates.map((u) => u.status)).toEqual(['running', 'done']);
    expect(updates[1].summary).toBe('Feito: login corrigido.');
  });

  it('lista automática: outcome review vai como review, com o relatório do portão (até 2000)', async () => {
    const { svc, calls, setAgents, setReply } = setup({ chat: true, outcome: 'review' });
    await svc.poll();
    svc.stop();
    await svc.begin({ id: 'c1:s1', folder: '/p/payposts-web' });
    setReply(`Branch: agentic/lista-1 ${'r'.repeat(3000)}`);
    setAgents([mainAgent({ id: 'chat:1', chat: true, status: 'idle' })]);
    await svc.check();
    await flush();
    const updates = calls.filter((c) => c.url.endsWith('/update')).map((c) => JSON.parse(String(c.init.body)));
    expect(updates.map((u) => u.status)).toEqual(['running', 'review']);
    expect(updates[1].summary).toHaveLength(REVIEW_SUMMARY_MAX);
  });

  it('comentários da revisão (reopen): a subtarefa volta a running e, no fim do portão, vai de novo como review', async () => {
    const over: { chat: boolean; outcome?: 'review' } = { chat: true, outcome: 'review' };
    const { svc, calls, setAgents, setReply } = setup(over);
    await svc.poll();
    svc.stop();
    await svc.begin({ id: 'c1:s1', folder: '/p/payposts-web' });
    setReply('Branch: agentic/lista-1, rodada 1');
    setAgents([mainAgent({ id: 'chat:1', chat: true, status: 'idle' })]);
    await svc.check();
    await flush();
    expect(svc.reopen('chat:9')).toBe(false);
    over.outcome = undefined; // rodando de novo / no portão
    expect(svc.reopen('chat:1')).toBe(true);
    await flush();
    await svc.check();
    await flush();
    over.outcome = 'review';
    setReply('Branch: agentic/lista-1, rodada 2');
    await svc.check();
    await flush();
    const updates = calls.filter((c) => c.url.endsWith('/update')).map((c) => JSON.parse(String(c.init.body)));
    expect(updates.map((u) => u.status)).toEqual(['running', 'review', 'running', 'review']);
    expect(updates[2].summary).toBeUndefined();
    expect(updates[3].summary).toContain('rodada 2');
  });

  it('reopen limpa a etapa e o PR da rodada anterior', async () => {
    const { svc, calls, setAgents, setReply } = setup({ chat: true, outcome: 'review' });
    await svc.poll();
    svc.stop();
    await svc.begin({ id: 'c1:s1', folder: '/p/payposts-web' });
    setReply('Branch: agentic/lista-1');
    setAgents([mainAgent({ id: 'chat:1', chat: true, status: 'idle' })]);
    await svc.check();
    await flush();
    expect(svc.settle('c1:s1', { state: 'review', stage: 'pr', prUrl: 'https://github.com/o/r/pull/1' })).toBe(true);
    await flush();
    expect(svc.reopen('chat:1')).toBe(true);
    await flush();
    const last = calls.filter((c) => c.url.endsWith('/update')).map((c) => JSON.parse(String(c.init.body))).at(-1);
    expect(last.status).toBe('running');
    expect(last).not.toHaveProperty('stage');
    expect(last).not.toHaveProperty('prUrl');
  });

  it('com o chat: o pedido editado na janela vale no lugar do texto da tarefa', async () => {
    const { svc, open } = setup({ chat: true });
    await svc.poll();
    svc.stop();
    await svc.begin({ id: 'c1:s1', folder: '/p/payposts-web', chat: { provider: 'claude', prompt: 'Corrija o login e rode os testes' } });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Corrija o login e rode os testes', vboardsTaskId: 'c1:s1' }));
  });

  it('lista do chat: begin abre pelo opener dela e a tarefa fica ligada ao agente', async () => {
    const { svc, open } = setup({ chat: true });
    await svc.poll();
    svc.stop();
    const viaRun = vi.fn(() => ({ agentId: 'chat:7' }));
    expect(await svc.begin({ id: 'c1:s1', folder: '/p/payposts-web', chat: { provider: 'claude', prompt: 'item' } }, viaRun)).toEqual({ agentId: 'chat:7' });
    expect(open).not.toHaveBeenCalled();
    expect(viaRun).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'item', vboardsTaskId: 'c1:s1' }));
    expect(await svc.begin({ id: 'c1:s1', folder: '/p/payposts-web' }, viaRun)).toMatchObject({ status: 409 });
  });

  it('agente do chat ligado a uma task não vira item de conversa; um solto vira um item só', async () => {
    const { svc, calls, setAgents, tick } = setup({ chat: true });
    await svc.poll();
    svc.stop();
    await svc.begin({ id: 'c1:s1', folder: '/p/payposts-web' });
    const worked = { toolCalls: 1, tokensIn: 10, tokensOut: 5, subagents: 0, linesAdded: 2 };
    setAgents([mainAgent({ id: 'chat:1', chat: true, title: 'Corrigir o login', status: 'working', stats: worked }), mainAgent({ id: 'chat:2', chat: true, title: 'Ajustar o paywall', status: 'working', stats: worked })]);
    for (let i = 0; i < 2; i++) {
      await svc.check();
      tick(TODOS_QUIET_MS);
      await svc.check();
    }
    await flush();
    const posts = calls.filter((c) => c.url.endsWith('/todos')).map((c) => JSON.parse(String(c.init.body)).todos[0].text);
    expect(posts).toEqual(['Ajustar o paywall']);
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

  it('uma conversa = um item no card da pasta (vboards.card): título, done e resumo', async () => {
    const { svc, calls, setAgents, tick, setReply } = setup();
    const posts = () => calls.filter((c) => c.url.endsWith('/todos')).map((c) => JSON.parse(String(c.init.body)));
    const settle = async () => {
      await svc.check();
      tick(TODOS_QUIET_MS);
      await svc.check();
      await svc.check();
    };
    const item = (done: boolean, summary?: string) => ({ email: 'eu@x', repo: 'PostsBuilder', todos: [{ text: 'Clone do jogo Real War', done, ...(summary ? { summary } : {}) }] });

    setAgents([mainAgent({ status: 'working' })]);
    await settle();
    expect(posts()).toEqual([]); // sem título: nada

    setAgents([mainAgent({ status: 'working', title: '  Clone do jogo Real War ' })]);
    await settle();
    expect(posts()).toEqual([item(false)]);

    setAgents([mainAgent({ status: 'idle', title: 'Clone do jogo Real War' })]);
    setReply('Primeiro resumo');
    await settle();
    expect(posts()).toEqual([item(false), item(true, 'Primeiro resumo')]);

    setAgents([mainAgent({ status: 'working', title: 'Clone do jogo Real War' })]);
    await settle();
    setAgents([mainAgent({ status: 'idle', title: 'Clone do jogo Real War' })]);
    setReply('Segundo resumo');
    await settle();
    expect(posts().at(-1)).toEqual(item(true, 'Segundo resumo'));
    expect(posts()).toHaveLength(4);
  });

  it('só conversa que mexeu em código vira item: pergunta e resposta não; edição ou commit sim', async () => {
    const { svc, calls, setAgents, tick } = setup();
    const noStats = { toolCalls: 3, tokensIn: 1, tokensOut: 1, subagents: 0 };
    const act = (tool: string, detail = '') => ({ id: tool, kind: 'other', icon: '', text: tool, tool, detail, at: 1 }) as AgentInfo['recent'][number];
    const titles = () => calls.filter((c) => c.url.endsWith('/todos')).map((c) => JSON.parse(String(c.init.body)).todos[0].text);
    const settle = async () => {
      await svc.check();
      tick(TODOS_QUIET_MS);
      await svc.check();
      await svc.check();
    };
    setAgents([mainAgent({ id: 'a:1', title: 'Só perguntas', status: 'idle', stats: noStats, recent: [act('Read'), act('Bash', 'git status')] })]);
    await settle();
    expect(titles()).toEqual([]);
    setAgents([
      mainAgent({ id: 'a:1', title: 'Só perguntas', status: 'idle', stats: noStats, recent: [act('Read')] }),
      mainAgent({ id: 'a:2', title: 'Com edição', status: 'idle', stats: noStats, recent: [act('Edit')] }),
      mainAgent({ id: 'a:3', title: 'Só commit', status: 'idle', stats: noStats, recent: [act('Bash', 'git commit -m "x"')] }),
      mainAgent({ id: 'a:4', provider: 'codex', title: 'Codex no chat', status: 'idle', stats: noStats, recent: [act('command', 'git commit -m y')] }),
    ]);
    await settle();
    expect(titles().sort()).toEqual(['Codex no chat', 'Com edição', 'Só commit']);
  });

  it('ligar a uma conversa aberta: lista a sessão da pasta (qualquer provedor), cria o link e manda running', async () => {
    const { svc, calls, setAgents } = setup();
    await svc.poll();
    svc.stop();
    setAgents([mainAgent({ id: 'codex:1', provider: 'codex', title: 'No VS Code', status: 'working' }), mainAgent({ id: 'x:2', roomId: 'r9' })]);
    const [view] = await svc.list();
    expect(view.agents).toEqual([{ id: 'codex:1', name: 'Ana', title: 'No VS Code', provider: 'codex', folder: '/p/payposts-web' }]);
    expect(await svc.attach({ id: 'c1:s1', agentId: 'x:2' })).toMatchObject({ status: 400 });
    expect(await svc.attach({ id: 'nada', agentId: 'codex:1' })).toMatchObject({ status: 404 });
    expect(await svc.attach({ id: 'c1:s1', agentId: 'codex:1' })).toEqual({ ok: true });
    expect(await svc.attach({ id: 'c1:s1', agentId: 'codex:1' })).toMatchObject({ status: 409 });
    expect(await svc.list()).toEqual([]);
    await svc.check();
    await flush();
    expect(calls.filter((c) => c.url.endsWith('/update')).map((c) => JSON.parse(String(c.init.body)).status)).toEqual(['running']);
  });

  it('conversa ligada à mão sai das conversas do card', async () => {
    const { svc, calls, setAgents, tick } = setup();
    await svc.poll();
    svc.stop();
    setAgents([mainAgent({ id: 'a:1', title: 'Trabalho no VS Code', status: 'working' })]);
    await svc.attach({ id: 'c1:s1', agentId: 'a:1' });
    await svc.check();
    tick(TODOS_QUIET_MS);
    await svc.check();
    await svc.check();
    expect(calls.filter((c) => c.url.endsWith('/todos'))).toEqual([]);
  });

  it('ligada à mão: só conclui quando a sessão acaba, não na primeira pausa', async () => {
    const { svc, calls, setAgents, setReply } = setup();
    const statuses = () => calls.filter((c) => c.url.endsWith('/update')).map((c) => JSON.parse(String(c.init.body)).status);
    await svc.poll();
    svc.stop();
    setAgents([mainAgent({ id: 'a:1', status: 'working', stats: { toolCalls: 1, tokensIn: 1, tokensOut: 9, subagents: 0 } })]);
    await svc.attach({ id: 'c1:s1', agentId: 'a:1' });
    await svc.check();
    setAgents([mainAgent({ id: 'a:1', status: 'idle', stats: { toolCalls: 1, tokensIn: 1, tokensOut: 9, subagents: 0 } })]);
    await svc.check();
    await svc.check();
    await flush();
    expect(statuses()).toEqual(['running']);
    setReply('Terminei no VS Code.');
    setAgents([mainAgent({ id: 'a:1', status: 'offline', stats: { toolCalls: 1, tokensIn: 1, tokensOut: 9, subagents: 0 } })]);
    await svc.check();
    await flush();
    expect(statuses()).toEqual(['running', 'done']);
    expect(JSON.parse(String(calls.filter((c) => c.url.endsWith('/update')).at(-1)!.init.body)).summary).toBe('Terminei no VS Code.');
  });

  it('agente ligado a uma subtarefa não vira item de conversa', async () => {
    const { svc, calls, setAgents, tick } = setup();
    await svc.poll();
    svc.stop();
    await svc.begin({ id: 'c1:s1' });
    setAgents([mainAgent({ status: 'working', title: 'Corrigir o login', startedAt: 101_000 })]);
    tick(5_000);
    await svc.check();
    tick(TODOS_QUIET_MS);
    await svc.check();
    await svc.check();
    expect(calls.filter((c) => c.url.endsWith('/todos'))).toEqual([]);
  });
});

describe('VBoards e o resultado do chat', () => {
  it('agente do chat que falhou: a subtarefa vai como failed, mesmo parado depois de "trabalhar"', async () => {
    let now = 100_000;
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/update')) calls.push(JSON.parse(String(init?.body)).status);
      const body = String(url).includes('/api/agent-tasks?') ? { tasks: [{ cardId: 'c1', subtaskId: 's1', text: 'X', cardTitle: 'Posts Builder', date: '2026-10-15' }] } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const agent = { id: 'chat:1', kind: 'main', chat: true, roomId: 'r1', name: 'Ana', look: 'f', role: '', sessionId: 's', account: '', status: 'idle', recent: [], tasks: [], startedAt: 0, lastEventAt: 0, statusSince: 0, stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, seed: 1 } as unknown as AgentInfo;
    const svc = new VBoardsService({
      config: { base: 'https://vb.dev', token: 't', email: 'eu@x' },
      agents: () => [agent],
      roomPath: () => '/p/payposts-web',
      folders: async () => ['/p/payposts-web'],
      chat: { open: () => ({ agentId: 'chat:1' }), outcome: () => 'failed' },
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
    });
    await svc.poll();
    svc.stop();
    await svc.begin({ id: 'c1:s1', folder: '/p/payposts-web' });
    now += 1000;
    await svc.check();
    await flush();
    expect(calls).toEqual(['running', 'failed']);
  });
});

describe('configuração da pasta (git config --local vboards.*)', () => {
  it('padrões: desligado, claude, US$ 2, revisor claude com sonnet; agy é o Antigravity', () => {
    expect(parseFolderConfig('vboards.qa npx playwright test')).toMatchObject({ qa: 'npx playwright test' });
    expect(validateFolderConfig({ qa: 'npx playwright test' })).toEqual({ values: { qa: 'npx playwright test' } });
    expect(parseFolderConfig(undefined)).toEqual({ auto: false, provider: 'claude', budget: 2, reviewer: 'claude', reviewerModel: 'sonnet', copy: [], ship: 'off', ciMinutes: 30, autoMerge: 'off', riskPaths: [] });
    const out = 'vboards.card PostsBuilder\nvboards.auto TRUE\nvboards.provider agy\nvboards.budget 0.75\nvboards.check npm ci && npm test\nvboards.reviewer codex\nvboards.copy .env, config/local.json, ../fora, /etc/passwd';
    expect(parseFolderConfig(out)).toEqual({ card: 'PostsBuilder', auto: true, provider: 'antigravity', budget: 0.75, check: 'npm ci && npm test', reviewer: 'codex', copy: ['.env', 'config/local.json'], ship: 'off', ciMinutes: 30, autoMerge: 'off', riskPaths: [] });
    expect(parseFolderConfig('vboards.auto yes\nvboards.budget -1\nvboards.provider gpt\nvboards.reviewermodel opus')).toEqual({ auto: false, provider: 'claude', budget: 2, reviewer: 'claude', reviewerModel: 'opus', copy: [], ship: 'off', ciMinutes: 30, autoMerge: 'off', riskPaths: [] });
  });
});

describe('abertura automática (opt-in)', () => {
  const tasks = [
    { cardId: 'c1', subtaskId: 's1', text: 'Login', cardTitle: 'Posts Builder' },
    { cardId: 'c1', subtaskId: 's2', text: 'Logout', cardTitle: 'Posts Builder' },
    { cardId: 'c2', subtaskId: 's1', text: 'X', cardTitle: 'outro' },
    { cardId: 'c3', subtaskId: 's1', text: 'Y', cardTitle: 'Agentic Office' },
  ];
  const cfg = (auto: boolean): FolderConfig => ({ auto, provider: 'codex', budget: 1, reviewer: 'claude', reviewerModel: 'sonnet', copy: [], ship: 'off', ciMinutes: 30, autoMerge: 'off', riskPaths: [] });
  function setup(withAuto = true) {
    const fetchMock = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes('/api/agent-tasks?') ? { tasks } : { ok: true }), { status: 200 }));
    const auto = vi.fn();
    const folderConfig = vi.fn(async (f: string) => cfg(f.endsWith('payposts-web') || f.includes('office')));
    const svc = new VBoardsService({
      config: { base: 'https://vb.dev', token: 't', email: 'eu@x' },
      agents: () => [],
      roomPath: () => undefined,
      folders: async () => ['/p/payposts-web', '/p/outro', '/a/agentic-office', '/b/agentic_office'],
      cardOf: async (f) => (f.endsWith('payposts-web') ? 'PostsBuilder' : undefined),
      chat: { open: () => ({ agentId: 'chat:1' }) },
      folderConfig,
      ...(withAuto ? { auto } : {}),
      fetch: fetchMock as unknown as typeof fetch,
    });
    return { svc, auto, folderConfig };
  }

  it('só com vboards.auto=true e exatamente uma pasta; as soltas da pasta vão juntas', async () => {
    const { svc, auto } = setup();
    await svc.poll();
    svc.stop();
    expect(auto).toHaveBeenCalledTimes(1);
    expect(auto).toHaveBeenCalledWith('/p/payposts-web', [{ id: 'c1:s1', prompt: 'Tarefa do VBoards (card Posts Builder): Login' }, { id: 'c1:s2', prompt: 'Tarefa do VBoards (card Posts Builder): Logout' }], cfg(true));
  });

  it('a subtarefa já ligada a um agente não vai de novo', async () => {
    const { svc, auto } = setup();
    await svc.poll();
    svc.stop();
    await svc.begin({ id: 'c1:s1', folder: '/p/payposts-web' });
    await svc.poll();
    svc.stop();
    expect(auto.mock.calls[1][1]).toEqual([{ id: 'c1:s2', prompt: 'Tarefa do VBoards (card Posts Builder): Logout' }]);
  });

  it('sem o chat (sem auto): nada abre e a configuração das pastas nem é lida', async () => {
    const { svc, folderConfig } = setup(false);
    await svc.poll();
    svc.stop();
    expect(folderConfig).not.toHaveBeenCalled();
    expect(await svc.list()).toHaveLength(4);
  });
});

describe('tela de configuração das pastas', () => {
  it('valida: enums, orçamento numérico, sem quebra de linha; vazio tira a chave', () => {
    expect(validateFolderConfig({ auto: true, provider: 'agy', budget: '1.5', check: 'npm ci && npm test', reviewer: 'codex', reviewerModel: 'gpt-5.1', card: 'Posts' })).toEqual({
      values: { card: 'Posts', auto: 'true', provider: 'agy', budget: '1.5', check: 'npm ci && npm test', reviewer: 'codex', reviewerModel: 'gpt-5.1' },
    });
    expect(validateFolderConfig({ check: '', reviewerModel: '' })).toEqual({ values: { check: '', reviewerModel: '' } });
    expect(validateFolderConfig({ copy: '.env, apps/web/.env.local' })).toEqual({ values: { copy: '.env, apps/web/.env.local' } });
    for (const bad of [{ auto: 'sim' }, { provider: 'gemini' }, { reviewer: 'antigravity' }, { budget: 'dois' }, { budget: 0 }, { budget: '-1' }, { check: 'npm test\nrm -rf /' }, { reviewerModel: 'a b' }, { card: {} }, { copy: '../.env' }, { copy: '.env, /etc/passwd' }, { copy: 'C:\\x\\.env' }, { copy: 'a/../../b' }]) {
      expect(validateFolderConfig(bad)).toHaveProperty('error');
    }
  });

  it('só grava em pasta conhecida, com os valores validados', async () => {
    const writeConfig = vi.fn(async () => undefined);
    const svc = new VBoardsService({
      config: { base: 'https://vb.dev', token: 't', email: 'eu@x' },
      agents: () => [],
      roomPath: () => undefined,
      folders: async () => ['/p/app'],
      cardOf: async () => undefined,
      folderConfig: async () => parseFolderConfig('vboards.auto true'),
      writeConfig,
      fetch: vi.fn() as unknown as typeof fetch,
    });
    expect(await svc.saveFolderSettings({ folder: '/etc', config: { auto: true } })).toMatchObject({ status: 400 });
    expect(await svc.saveFolderSettings({ folder: '/p/app', config: { budget: 'x' } })).toMatchObject({ status: 400 });
    expect(writeConfig).not.toHaveBeenCalled();
    expect(await svc.saveFolderSettings({ folder: '/p/app/', config: { auto: true, provider: 'agy' } })).toMatchObject({ folder: '/p/app', config: { auto: true } });
    expect(writeConfig).toHaveBeenCalledWith('/p/app', { auto: 'true', provider: 'agy' });
    expect(await svc.folderSettings('/p/app')).toMatchObject({ config: { provider: 'claude', reviewer: 'claude' } });
  });
});

describe('política sensível fora do git config (folder-policy.json)', () => {
  it('chave sensível no git config é ignorada e vira aviso; a do arquivo vale', () => {
    const out = 'vboards.automerge low\nvboards.ship merge\nvboards.risklines 99999\nvboards.store ota\nvboards.check npm test';
    const c = parseFolderConfig(out);
    expect(c).toMatchObject({ autoMerge: 'off', ship: 'off', check: 'npm test' });
    expect(c.riskLines).toBeUndefined();
    expect(c.store).toBeUndefined();
    expect(c.legacy).toEqual(['autoMerge', 'ship', 'riskLines', 'store']);
    // No arquivo: vale e não avisa; o do git config continua ignorado (nunca importado).
    const d = parseFolderConfig(out, { ship: 'pr' });
    expect(d).toMatchObject({ ship: 'pr', autoMerge: 'off' });
    expect(d.legacy).toEqual(['autoMerge', 'riskLines', 'store']);
  });

  it('grava as sensíveis no arquivo (não no git config), tira a cópia antiga e lê de volta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-vb-pol-'));
    const data = mkdtempSync(join(tmpdir(), 'hb-vb-data-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'vboards.automerge', 'low'], { cwd: dir });
    expect((await readFolderConfig(dir, data)).legacy).toEqual(['autoMerge']);
    expect(await writeFolderConfig(dir, { ship: 'pr', autoMerge: 'off', check: 'npm test' }, data)).toBeUndefined();
    const git = execFileSync('git', ['config', '--local', '--get-regexp', '^vboards\\.'], { cwd: dir, encoding: 'utf8' });
    expect(git).toContain('vboards.check npm test');
    expect(git).not.toMatch(/ship|automerge/i);
    expect(readPolicy(policyFile(data), dir)).toEqual({ ship: 'pr', autoMerge: 'off' });
    const c = await readFolderConfig(dir, data);
    expect(c).toMatchObject({ ship: 'pr', autoMerge: 'off', check: 'npm test' });
    expect(c.legacy).toBeUndefined();
    // Sem a pasta de dados, nada sensível é gravado.
    expect(await writeFolderConfig(dir, { ship: 'merge' })).toEqual(expect.any(String));
  });

  it('PIN: ligar autoMerge=low, ship=merge ou store≠off (ou mexer ligado); desligar e o resto não pedem', () => {
    const base = parseFolderConfig(undefined);
    expect(policyChangeNeedsPin(base, { autoMerge: 'low' })).toBe(true);
    expect(policyChangeNeedsPin(base, { ship: 'merge' })).toBe(true);
    expect(policyChangeNeedsPin(base, { store: 'ota' })).toBe(true);
    expect(policyChangeNeedsPin(base, { ship: 'pr', base: 'main', ciMinutes: '30', check: 'x', auto: 'true' })).toBe(false);
    const armed = parseFolderConfig(undefined, { autoMerge: 'low', ship: 'merge' });
    expect(policyChangeNeedsPin(armed, { riskLines: '99999' })).toBe(true);
    expect(policyChangeNeedsPin(armed, { autoMerge: 'low', ship: 'merge' })).toBe(false);
    expect(policyChangeNeedsPin(armed, { autoMerge: 'off' })).toBe(false);
    expect(policyChangeNeedsPin(armed, { check: 'npm test' })).toBe(false);
  });

  it('POST da configuração: ligar autoMerge sem PIN é recusado; com PIN grava', async () => {
    const writeConfig = vi.fn(async () => undefined);
    const svc = new VBoardsService({ config: { base: 'https://vb.example', token: 't', email: 'e' }, agents: () => [], roomPath: () => undefined, folders: async () => ['/p/api'], folderConfig: async () => parseFolderConfig(undefined), writeConfig });
    const check = vi.fn(async (p: unknown) => (p === '1234' ? ('ok' as const) : p ? ('wrong' as const) : ('missing' as const)));
    const pin = { check, triesLeft: () => 4 };
    expect(await svc.saveFolderSettings({ folder: '/p/api', config: { autoMerge: 'low' } }, pin)).toMatchObject({ status: 403, pin: 'missing' });
    expect(await svc.saveFolderSettings({ folder: '/p/api', config: { autoMerge: 'low' } })).toMatchObject({ status: 403, pin: 'unset' });
    expect(writeConfig).not.toHaveBeenCalled();
    expect(await svc.saveFolderSettings({ folder: '/p/api', config: { autoMerge: 'low' }, pin: '1234' }, pin)).toMatchObject({ folder: '/p/api' });
    expect(writeConfig).toHaveBeenCalledWith('/p/api', { autoMerge: 'low' });
    expect(await svc.saveFolderSettings({ folder: '/p/api', config: { check: 'npm test' } })).toMatchObject({ folder: '/p/api' });
  });
});

describe('git config --local de verdade', () => {
  it('grava, lê de volta e tira (tirar o que não existe não é erro)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-vb-cfg-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    expect(await writeFolderConfig(dir, { auto: 'true', provider: 'agy', check: 'npm ci && npm test', reviewerModel: '' })).toBeUndefined();
    expect(await readFolderConfig(dir)).toMatchObject({ auto: true, provider: 'antigravity', check: 'npm ci && npm test' });
    expect(await writeFolderConfig(dir, { check: '' })).toBeUndefined();
    expect(await readFolderConfig(dir)).not.toHaveProperty('check');
    expect(await writeFolderConfig(mkdtempSync(join(tmpdir(), 'hb-vb-nogit-')), { auto: 'true' })).toEqual(expect.any(String));
  });
});


describe('Refinar (plano só de leitura)', () => {
  const fence = (o: unknown) => `Li o repositório.\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;
  it('lê o último bloco json, valida as formas e corta nos limites', () => {
    const good = { plan: 'Mexer em a.ts', questions: ['Qual tela?'], subtasks: ['Criar rota', 'Testar'] };
    expect(parseRefineOutput(`${fence({ plan: 'velho', subtasks: [] })}\n${fence(good)}`)).toEqual({ ...good, risks: [{ risk: 'medium' }, { risk: 'medium' }] });
    expect(parseRefineOutput(fence({ plan: 'só plano' }))).toEqual({ plan: 'só plano', questions: [], subtasks: [], risks: [] });
    expect(parseRefineOutput(JSON.stringify(good))).toBeUndefined();
    expect(parseRefineOutput('```json\n{quebrado\n```')).toBeUndefined();
    expect(parseRefineOutput(fence({ plan: 1, subtasks: [] }))).toBeUndefined();
    expect(parseRefineOutput(fence({ plan: 'x', subtasks: 'não é lista' }))).toBeUndefined();
    expect(parseRefineOutput(fence({ plan: 'x', questions: {} }))).toBeUndefined();
    expect(parseRefineOutput(fence({ plan: 'x', subtasks: ['a', 3, '', 'b'] }))?.subtasks).toEqual(['a', 'b']);
    const big = parseRefineOutput(fence({ plan: 'p'.repeat(9000), questions: Array(15).fill('q'.repeat(600)), subtasks: Array(30).fill('s'.repeat(400)) }))!;
    expect(big.plan.length).toBeLessThanOrEqual(REFINE_LIMITS.plan);
    expect(big.questions).toHaveLength(REFINE_LIMITS.questions);
    expect(big.questions[0].length).toBeLessThanOrEqual(REFINE_LIMITS.question);
    expect(big.subtasks).toHaveLength(REFINE_LIMITS.subtasks);
    expect(big.subtasks[0].length).toBeLessThanOrEqual(REFINE_LIMITS.subtask);
    expect(big.risks).toHaveLength(REFINE_LIMITS.subtasks);
  });
  it('subtarefa com risco: {text, risk, riskWhy} (tolerante), texto puro = medium, alinhado com subtasks', () => {
    const r = parseRefineOutput(fence({ plan: 'p', subtasks: [{ text: 'Trocar cor do botão', risk: 'low', riskWhy: 'só estilo' }, 'Ajustar texto', { text: 'Mexer no paywall', risk: 'ALTO' }, { risk: 'low' }, { text: 'x', risk: 'talvez' }] }))!;
    expect(r.subtasks).toEqual(['Trocar cor do botão', 'Ajustar texto', 'Mexer no paywall', 'x']);
    expect(r.risks).toEqual([{ risk: 'low', riskWhy: 'só estilo' }, { risk: 'medium' }, { risk: 'high' }, { risk: 'medium' }]);
    expect(refinePrompt({ cardTitle: 'C', description: 'd', subtasks: [] })).toContain('"risk": "low|medium|high"');
  });
  it('tarefa da fila: risk/riskWhy/approvedAt tolerantes (sem approvedAt válido = ausente)', () => {
    expect(taskRisk({ risk: 'low', riskWhy: 'estilo', approvedAt: '2026-11-06T10:00:00Z' })).toEqual({ risk: 'low', riskWhy: 'estilo', approvedAt: '2026-11-06T10:00:00.000Z' });
    expect(taskRisk({ risk: 'xyz', approvedAt: 'ontem' })).toEqual({ risk: 'medium' });
    expect(taskRisk({ approvedAt: 0 })).toEqual({});
    expect(taskRisk({ approvedAt: 1_700_000_000_000 }).approvedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });
  it('vboards.autoMerge (off padrão | low), riskPaths e riskLines', () => {
    expect(parseFolderConfig(undefined, { autoMerge: 'low', riskPaths: 'src/core/**, *.tf', riskLines: '120' })).toMatchObject({ autoMerge: 'low', riskPaths: ['src/core/**', '*.tf'], riskLines: 120 });
    expect(parseFolderConfig(undefined, { autoMerge: 'sim' })).toMatchObject({ autoMerge: 'off', riskPaths: [] });
    expect(validateFolderConfig({ autoMerge: 'low', riskPaths: 'a/**, *.sql', riskLines: '50' })).toEqual({ values: { autoMerge: 'low', riskPaths: 'a/**, *.sql', riskLines: '50' } });
    for (const bad of [{ autoMerge: 'medium' }, { autoMerge: 'high' }, { riskLines: '0' }, { riskLines: 'x' }]) expect(validateFolderConfig(bad)).toHaveProperty('error');
  });

  it('pedidos da fila: ausentes (VBoards antigo) ou estragados = nenhum; o prompt leva card, descrição e subtarefas', () => {
    expect(parseRefines(undefined)).toEqual([]);
    expect(parseRefines([{ cardTitle: 'sem id' }, null])).toEqual([]);
    const [r] = parseRefines([{ cardId: 7, cardTitle: 'Posts Builder', description: 'Fazer X', subtasks: ['a', 1, null], updatedAt: '2026-10-23T10:00' }]);
    expect(r).toEqual({ cardId: '7', cardTitle: 'Posts Builder', description: 'Fazer X', subtasks: ['a', '1'], key: '2026-10-23T10:00' });
    const p = refinePrompt(r);
    expect(p).toContain('Posts Builder');
    expect(p).toContain('Fazer X');
    expect(p).toContain('- a');
    expect(p).toContain('```json');
  });

  const settle = async () => {
    for (let i = 0; i < 20; i++) await flush();
  };
  function setup(o: { refines?: unknown[]; noRefines?: boolean; status?: (body: Record<string, unknown>) => number; output?: string; folders?: string[] } = {}) {
    const posts: Array<Record<string, unknown>> = [];
    let refines = o.refines ?? [{ cardId: 'c9', cardTitle: 'Posts Builder', description: 'Fazer X', subtasks: ['a'] }];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/api/agent-tasks?')) return new Response(JSON.stringify(o.noRefines ? { tasks: [] } : { tasks: [], refines }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push(body);
      return new Response(JSON.stringify({ ok: true, subtaskIds: [] }), { status: o.status?.(body) ?? 200 });
    });
    let release: (t: string) => void = () => {};
    const refine = vi.fn((_folder: string, _prompt: string, _cfg: FolderConfig) => new Promise<string>((ok) => (release = ok)));
    const notify = vi.fn();
    const svc = new VBoardsService({
      config: { base: 'https://vb.dev', token: 't', email: 'eu@x' },
      agents: () => [],
      roomPath: () => undefined,
      folders: async () => o.folders ?? ['/p/payposts-web', '/p/outro'],
      cardOf: async (f) => (f.endsWith('payposts-web') ? 'PostsBuilder' : undefined),
      chat: { open: () => ({ agentId: 'chat:1' }) },
      folderConfig: async () => ({ auto: false, provider: 'codex', budget: 1, reviewer: 'claude', copy: [], ship: 'off', ciMinutes: 30, autoMerge: 'off', riskPaths: [] }),
      refine,
      notify,
      fetch: fetchMock as unknown as typeof fetch,
    });
    return { svc, posts, refine, notify, finish: (t = o.output ?? fence({ plan: 'P', questions: [], subtasks: ['s1'] })) => release(t), setRefines: (r: unknown[]) => (refines = r) };
  }

  it('uma pasta: running, a rodada na própria pasta e ready com o resultado; aviso "plano pronto"', async () => {
    const s = setup();
    await s.svc.poll();
    s.svc.stop();
    await settle();
    expect(s.refine).toHaveBeenCalledWith('/p/payposts-web', expect.stringContaining('Fazer X'), expect.objectContaining({ provider: 'codex' }), undefined);
    expect(s.posts).toEqual([{ email: 'eu@x', cardId: 'c9', status: 'running' }]);
    expect(s.svc.refineList()).toMatchObject([{ cardId: 'c9', state: 'running' }]);
    s.finish();
    await settle();
    expect(s.posts[1]).toEqual({ email: 'eu@x', cardId: 'c9', status: 'ready', plan: 'P', questions: [], subtasks: ['s1'], risks: [{ risk: 'medium' }] });
    expect(s.notify).toHaveBeenCalledWith('Posts Builder', 'ready');
    expect(s.svc.refineList()).toMatchObject([{ cardId: 'c9', state: 'ready' }]);
  });

  it('nenhuma ou várias pastas: failed com o motivo, sem rodar', async () => {
    const none = setup({ refines: [{ cardId: 'c1', cardTitle: 'Inexistente', description: '', subtasks: [] }] });
    await none.svc.poll();
    none.svc.stop();
    await settle();
    expect(none.refine).not.toHaveBeenCalled();
    expect(none.posts).toEqual([{ email: 'eu@x', cardId: 'c1', status: 'failed', error: expect.stringContaining('nenhuma pasta com vboards.card = Inexistente') }]);
    expect(none.notify).toHaveBeenCalledWith('Inexistente', 'failed');
    const many = setup({ refines: [{ cardId: 'c2', cardTitle: 'Agentic Office', description: '', subtasks: [] }], folders: ['/a/agentic-office', '/b/agentic_office'] });
    await many.svc.poll();
    many.svc.stop();
    await settle();
    expect(many.refine).not.toHaveBeenCalled();
    expect(many.posts[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('várias pastas') });
  });

  it('resposta sem o bloco json: failed com o fim da saída', async () => {
    const s = setup({ output: 'não sei responder em json' });
    await s.svc.poll();
    s.svc.stop();
    await settle();
    s.finish();
    await settle();
    expect(s.posts[1]).toMatchObject({ status: 'failed', error: expect.stringContaining('não sei responder em json') });
  });

  it('nunca duas vezes o mesmo card ao mesmo tempo nem o mesmo pedido de novo; um clique novo (updatedAt) roda', async () => {
    const s = setup({ refines: [{ cardId: 'c9', cardTitle: 'Posts Builder', description: '', subtasks: [], updatedAt: '1' }] });
    await s.svc.poll();
    await s.svc.poll();
    s.svc.stop();
    await settle();
    expect(s.refine).toHaveBeenCalledTimes(1);
    s.finish();
    await settle();
    await s.svc.poll();
    s.svc.stop();
    await settle();
    expect(s.refine).toHaveBeenCalledTimes(1);
    s.setRefines([{ cardId: 'c9', cardTitle: 'Posts Builder', description: '', subtasks: [], updatedAt: '2' }]);
    await s.svc.poll();
    s.svc.stop();
    await settle();
    expect(s.refine).toHaveBeenCalledTimes(2);
  });

  it('VBoards antigo: sem refines nada roda; 404 no running = não gasta a rodada nem tenta de novo', async () => {
    const old = setup({ noRefines: true });
    await old.svc.poll();
    old.svc.stop();
    await settle();
    expect(old.refine).not.toHaveBeenCalled();
    expect(old.posts).toEqual([]);
    const s = setup({ status: () => 404 });
    await s.svc.poll();
    await s.svc.poll();
    s.svc.stop();
    await settle();
    expect(s.refine).not.toHaveBeenCalled();
    expect(s.posts).toEqual([{ email: 'eu@x', cardId: 'c9', status: 'running' }]);
  });

  it('resultado final que não chegou (5xx) vai de novo na próxima busca', async () => {
    let fail = true;
    const s = setup({ status: (b) => (b.status === 'ready' && fail ? 503 : 200) });
    await s.svc.poll();
    s.svc.stop();
    await settle();
    s.finish();
    await settle();
    fail = false;
    await s.svc.poll();
    s.svc.stop();
    await settle();
    expect(s.posts.map((p) => p.status)).toEqual(['running', 'ready', 'ready']);
    expect(s.refine).toHaveBeenCalledTimes(1);
  });
});

describe('VBoards: token vb_ recusado na fila', () => {
  it('403 sem escopo: a frase vai para o painel (problem) e a próxima busca espera o intervalo maior; sem e-mail na URL', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'missing scope agent' }), { status: 403 }));
    const svc = new VBoardsService({ config: { base: 'https://vb.dev', token: 'vb_x', email: '' }, agents: () => [], roomPath: () => undefined, folders: async () => [], chat: { open: () => ({ agentId: 'chat:1' }) }, fetch: fetchMock as unknown as typeof fetch });
    await svc.poll();
    svc.stop();
    expect(svc.problem()).toBe('O token do VBoards precisa do escopo agent.');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('https://vb.dev/api/agent-tasks');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Refinar num produto com vários repos', () => {
  const product = { id: 'helix', name: 'PeptPro', cardName: 'PeptPro', repos: [{ path: '/p/helix-app', role: 'app' as const }, { path: '/p/helix-server', role: 'server' as const }, { path: '/p/peptpro-web', role: 'web' as const }] };
  it('roda no repo server com os outros como leitura extra e pede a etiqueta em cada subtarefa', async () => {
    const posts: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/api/agent-tasks?')) return new Response(JSON.stringify({ tasks: [], refines: [{ cardId: 'c1', cardTitle: 'PeptPro', description: 'Login com Google', subtasks: [] }] }), { status: 200 });
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const refine = vi.fn(async (_f: string, _p: string, _c: FolderConfig, _x?: string[]) => '```json\n{"plan":"P","questions":[],"subtasks":["[server] rota do Google","[app] botão"]}\n```');
    const svc = new VBoardsService({ config: { base: 'https://vb.dev', token: 't', email: 'eu@x' }, agents: () => [], roomPath: () => undefined, folders: async () => [], chat: { open: () => ({ agentId: 'chat:1' }) }, folderConfig: async () => parseFolderConfig(undefined), refine, products: () => [product], fetch: fetchMock as unknown as typeof fetch });
    await svc.poll();
    svc.stop();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((ok) => setTimeout(ok, 0));
    expect(refine).toHaveBeenCalledWith('/p/helix-server', expect.stringContaining('[app] /p/helix-app'), expect.anything(), ['/p/helix-app', '/p/peptpro-web']);
    expect(refine.mock.calls[0][1]).toContain('Comece o texto de CADA subtarefa com a etiqueta');
    expect(posts.at(-1)).toMatchObject({ status: 'ready', subtasks: ['[server] rota do Google', '[app] botão'] });
    // A abertura automática acha a pasta pela etiqueta que o Refinar pôs.
    expect(taskFolders({ cardTitle: 'PeptPro', text: '[server] rota do Google' }, [], [product])).toEqual({ paths: ['/p/helix-server'] });
    expect(taskFolders({ cardTitle: 'PeptPro', text: '[app] botão' }, [], [product])).toEqual({ paths: ['/p/helix-app'] });
    expect(taskFolders({ cardTitle: 'PeptPro', text: '[peptpro-web] rodapé' }, [], [product])).toEqual({ paths: ['/p/peptpro-web'] });
  });

  it('repoTag: o papel quando é único, senão o nome da pasta', () => {
    const repos = [{ path: '/p/a-app', role: 'app' as const }, { path: '/p/b-app', role: 'app' as const }, { path: '/p/api', role: 'server' as const }];
    expect(repos.map((r) => repoTag(repos, r))).toEqual(['a-app', 'b-app', 'server']);
  });
});

describe('produto com vários repos (products.json)', () => {
  const product = { id: 'posts', name: 'Posts Builder', cardName: 'Posts Builder', repos: [{ path: '/p/posts-server', role: 'server' as const }, { path: '/p/posts-web', role: 'web' as const }] };
  function setup(text: string, repo?: string) {
    const calls: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/update')) calls.push(JSON.parse(String(init?.body)));
      const body = String(url).includes('/api/agent-tasks?') ? { tasks: [{ cardId: 'c1', subtaskId: 's1', text, cardTitle: 'Posts Builder', ...(repo ? { repo } : {}) }] } : { ok: true };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const open = vi.fn(() => ({ agentId: 'chat:1' }));
    const svc = new VBoardsService({
      config: { base: 'https://vb.dev', token: 't', email: 'eu@x' },
      agents: () => [],
      roomPath: () => undefined,
      folders: async () => ['/p/outro'],
      cardOf: async () => undefined,
      chat: { open },
      products: () => [product],
      fetch: fetchMock as unknown as typeof fetch,
    });
    return { svc, calls, open };
  }

  it('sem dizer o repo: não escolhe; a página vê os repos e a frase, e o Iniciar sem pasta falha com ela', async () => {
    const { svc, open } = setup('Corrigir o login');
    await svc.poll();
    svc.stop();
    const [view] = await svc.list();
    expect(view.folder).toBeUndefined();
    expect(view.candidates.map((c) => c.path)).toEqual(['/p/posts-server', '/p/posts-web']);
    expect(view.problem).toMatch(/2 repositórios/);
    expect(await svc.begin({ id: 'c1:s1' })).toEqual({ status: 400, error: view.problem });
    expect(open).not.toHaveBeenCalled();
    // A pessoa escolhe: vale.
    expect(await svc.begin({ id: 'c1:s1', folder: '/p/posts-web' })).toEqual({ agentId: 'chat:1' });
  });

  it('a etiqueta [server] do texto ou o campo repo da fila escolhem o repo', async () => {
    const a = setup('[server] Corrigir o login');
    await a.svc.poll();
    a.svc.stop();
    expect((await a.svc.list())[0]).toMatchObject({ folder: '/p/posts-server' });
    const b = setup('Corrigir o login', 'posts-web');
    await b.svc.poll();
    b.svc.stop();
    expect((await b.svc.list())[0]).toMatchObject({ folder: '/p/posts-web' });
    expect(await b.svc.begin({ id: 'c1:s1' })).toEqual({ agentId: 'chat:1' });
    expect(b.open).toHaveBeenCalledWith(expect.objectContaining({ folder: '/p/posts-web' }));
  });

  it('settle: Juntar manda done com a etapa; Descartar manda failed com o motivo; ligação que não existe = false', async () => {
    const { svc, calls } = setup('[web] X');
    await svc.poll();
    svc.stop();
    await svc.begin({ id: 'c1:s1' });
    await flush();
    expect(svc.settle('c9:s9', { state: 'done' })).toBe(false);
    expect(svc.settle('c1:s1', { state: 'done', stage: 'merged' })).toBe(true);
    await flush();
    expect(svc.settle('c1:s1', { state: 'failed', stage: 'discarded', summary: 'Descartado' })).toBe(true);
    await flush();
    expect(calls.map((c) => [c.status, c.stage, c.summary])).toEqual([['running', undefined, undefined], ['done', 'merged', undefined], ['failed', 'discarded', 'Descartado']]);
  });
});

describe('taskFolders e as chaves novas da pasta', () => {
  it('sem produto do card: o casamento antigo por nome / vboards.card', () => {
    expect(taskFolders({ cardTitle: 'Posts Builder' }, [{ path: '/p/x', card: 'PostsBuilder' }], [])).toEqual({ paths: ['/p/x'] });
  });

  it('vboards.ship/base/remote: valida e lê, padrão off', () => {
    expect(validateFolderConfig({ ship: 'pr', base: 'develop', remote: 'upstream' })).toEqual({ values: { ship: 'pr', base: 'develop', remote: 'upstream' } });
    for (const bad of [{ ship: 'push' }, { base: '-x' }, { base: 'a..b' }, { remote: 'a b' }]) expect(validateFolderConfig(bad)).toHaveProperty('error');
    expect(parseFolderConfig(undefined, { ship: 'MERGE', base: 'release/1', remote: 'origin' })).toMatchObject({ ship: 'merge', base: 'release/1', remote: 'origin' });
    expect(parseFolderConfig(undefined, { ship: 'sim', base: '--upload-pack=x' })).toMatchObject({ ship: 'off' });
    expect(parseFolderConfig(undefined, { base: '--upload-pack=x' }).base).toBeUndefined();
  });

  it('reportKey: ligação antiga (só o status) não reenvia; etapa nova reenvia', () => {
    expect(reportKey({ state: 'done' })).toBe('done');
    expect(reportKey({ state: 'done', stage: 'merged', prUrl: 'https://x/pr/1' })).toBe('done+merged+https://x/pr/1');
  });
});
