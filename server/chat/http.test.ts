import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatView } from '../../shared/chat';
import { createChatRoutes, type ChatRouteDeps } from './http';
import type { ChatRecord } from './store';

const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

async function start() {
  const afters: number[] = [];
  const rec = { agentId: 'chat:1', permission: 'auto', cwd: 'C:\\proj', folder: 'C:\\proj', alwaysAllow: [], providerSessionId: 'S' } as unknown as ChatRecord;
  const chat = {
    tokenOwner: (t: string) => (t === 'tok-1' ? 'chat:1' : t === 'tok-2' ? 'chat:2' : undefined),
    record: (id: string) => (id === 'chat:1' ? rec : undefined),
    view: (id: string, after?: number) => {
      afters.push(after ?? 0);
      return id === 'chat:1' ? ({ agentId: id, provider: 'claude', items: [], state: { phase: 'idle', spentUsd: 0, spentTokens: 0, limits: {} }, lastSeq: 0 } as ChatView) : undefined;
    },
    open: () => ({ agentId: 'chat:9' }),
  } as unknown as ChatRouteDeps['chat'];
  const delegation = {
    links: () => [{ from: 'chat:1', to: 'chat:2', at: 5 }],
    tools: (caller: string) => [{ name: 'office_list_agents', description: 'x', inputSchema: { type: 'object' }, run: async () => ({ text: `lista de ${caller}` }) }],
  };
  const runs = {
    list: () => [{ id: 'r1' }],
    get: (id: string) => (id === 'r1' ? { id } : undefined),
    create: (body: { items?: unknown[] }) => (body.items?.length ? { run: { id: 'r1' } } : { status: 400, error: 'A lista precisa ter de 1 a 50 itens.' }),
    stop: (id: string) => (id === 'r1' ? 'ok' : 'not-found'),
    continue: (id: string) => (id === 'r1' ? 'busy' : 'not-found'),
    merge: async () => ({ ok: true }),
    discard: async () => ({ status: 409, error: 'sem cópia' }),
  } as unknown as ChatRouteDeps['runs'];
  const triggers = {
    list: () => [{ id: 't1' }],
    history: () => [{ id: 'f1', ruleId: 't1' }],
    create: (b: { name?: string }) => (b.name ? { rule: { id: 't1', name: b.name } } : { status: 400, error: 'Dê um nome ao gatilho (até 60 caracteres).' }),
    update: (id: string, b: { name?: string }) => (id !== 't1' ? { status: 404, error: 'gatilho não encontrado' } : { rule: { id, name: b.name } }),
    remove: (id: string) => id === 't1',
    test: (id: string) => (id === 't1' ? 'ok' : 'not-found'),
  } as unknown as ChatRouteDeps['triggers'];
  const modes: string[] = [];
  const summary = {
    generate: async (mode: string) => (modes.push(mode), mode === 'ai' ? { text: 'IA', costUsd: 0.001, generatedAt: 1 } : { text: 'lista', generatedAt: 1 }),
    last: () => undefined,
  } as unknown as ChatRouteDeps['summary'];
  const routes = createChatRoutes({ chat, folders: () => [], accounts: () => [], delegation, runs, triggers, summary });
  const server = http.createServer((req, res) => routes(req, res, new URL(req.url ?? '/', 'http://x')));
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { port: (server.address() as AddressInfo).port, afters, modes };
}

function raw(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host: `localhost:${port}`, ...opts.headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', fail);
    req.end(opts.body);
  });
}

const json = { 'content-type': 'application/json' };

describe('chat: rotas HTTP', () => {
  it('só pelo próprio computador: Host de rede ou Origin de fora dão 403', async () => {
    const { port } = await start();
    const lan = await raw(port, '/api/chat/agents', { method: 'POST', headers: { ...json, host: '192.168.0.10' }, body: '{}' });
    expect(lan.status).toBe(403);
    expect(JSON.parse(lan.body).error).toBe('abra o Habblaud por http://localhost para usar o terminal interativo');
    const evil = await raw(port, '/api/chat/agents', { method: 'POST', headers: { ...json, origin: 'http://evil' }, body: '{}' });
    expect(evil.status).toBe(403);
  });

  it('resumo do dia: POST devolve IA (padrão) ou lista; só pelo próprio computador', async () => {
    const { port, modes } = await start();
    const ai = await raw(port, '/api/summary/day', { method: 'POST', headers: json, body: '{}' });
    expect(JSON.parse(ai.body)).toEqual({ text: 'IA', costUsd: 0.001, generatedAt: 1 });
    const list = await raw(port, '/api/summary/day', { method: 'POST', headers: json, body: '{"mode":"list"}' });
    expect(JSON.parse(list.body).text).toBe('lista');
    expect(modes).toEqual(['ai', 'list']);
    expect(JSON.parse((await raw(port, '/api/summary/day')).body)).toEqual({});
    expect((await raw(port, '/api/summary/day', { method: 'POST', headers: { ...json, host: '192.168.0.10' }, body: '{}' })).status).toBe(403);
    expect((await raw(port, '/api/summary/day', { method: 'POST', headers: { ...json, origin: 'http://evil' }, body: '{}' })).status).toBe(403);
    expect(modes).toHaveLength(2);
  });

  it('MCP exige o Bearer do próprio agente', async () => {
    const { port } = await start();
    const call = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' } } } });
    const path = `/api/chat/mcp/${encodeURIComponent('chat:1')}`;
    expect((await raw(port, path, { method: 'POST', headers: json, body: call })).status).toBe(401);
    expect((await raw(port, path, { method: 'POST', headers: { ...json, authorization: 'Bearer tok-2' }, body: call })).status).toBe(401);
    const ok = await raw(port, path, { method: 'POST', headers: { ...json, authorization: 'Bearer tok-1' }, body: call });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"behavior":"allow","updatedInput":{"command":"ls"}}' }] } });
    const note = await raw(port, path, { method: 'POST', headers: { ...json, authorization: 'Bearer tok-1' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(note.status).toBe(202);
    expect((await raw(port, path, { headers: { authorization: 'Bearer tok-1' } })).status).toBe(405);
  });

  it('MCP: ferramentas office_* do agente; tools/call por SSE quando o cliente aceita (esperas longas)', async () => {
    const { port } = await start();
    const path = `/api/chat/mcp/${encodeURIComponent('chat:1')}`;
    const auth = { ...json, authorization: 'Bearer tok-1' };
    const list = await raw(port, path, { method: 'POST', headers: auth, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(JSON.parse(list.body).result.tools.map((t: { name: string }) => t.name)).toEqual(['approve', 'office_list_agents']);
    const call = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'office_list_agents', arguments: {} } });
    const sse = await raw(port, path, { method: 'POST', headers: { ...auth, accept: 'application/json, text/event-stream' }, body: call });
    expect(sse.status).toBe(200);
    expect(sse.body).toBe(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'lista de chat:1' }] } })}\n\n`);
  });

  it('ligações entre agentes para o quadro', async () => {
    const { port } = await start();
    const r = await raw(port, '/api/chat/links');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual([{ from: 'chat:1', to: 'chat:2', at: 5 }]);
  });

  it('a conversa vem a partir do seq pedido', async () => {
    const { port, afters } = await start();
    const r = await raw(port, `/api/chat/agents/${encodeURIComponent('chat:1')}?after=3`);
    expect(r.status).toBe(200);
    expect(afters).toEqual([3]);
    expect((await raw(port, '/api/chat/agents/chat%3Ax')).status).toBe(404);
  });

  it('corpo grande demais dá 413', async () => {
    const { port } = await start();
    const r = await raw(port, '/api/chat/agents', { method: 'POST', headers: json, body: JSON.stringify({ prompt: 'x'.repeat(300 * 1024) }) });
    expect(r.status).toBe(413);
  });

  it('abrir devolve 201 com o id', async () => {
    const { port } = await start();
    const r = await raw(port, '/api/chat/agents', { method: 'POST', headers: json, body: JSON.stringify({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' }) });
    expect(r.status).toBe(201);
    expect(JSON.parse(r.body)).toEqual({ agentId: 'chat:9' });
  });

  it('listas: criar (a aprovação), ver, parar, continuar, juntar/descartar; só pelo próprio computador', async () => {
    const { port } = await start();
    expect((await raw(port, '/api/chat/runs', { method: 'POST', headers: { ...json, origin: 'http://evil' }, body: '{}' })).status).toBe(403);
    const bad = await raw(port, '/api/chat/runs', { method: 'POST', headers: json, body: JSON.stringify({ items: [] }) });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toBe('A lista precisa ter de 1 a 50 itens.');
    const ok = await raw(port, '/api/chat/runs', { method: 'POST', headers: json, body: JSON.stringify({ items: [{ text: 'a' }] }) });
    expect(ok.status).toBe(201);
    expect(JSON.parse(ok.body)).toEqual({ id: 'r1' });
    expect(JSON.parse((await raw(port, '/api/chat/runs')).body)).toEqual([{ id: 'r1' }]);
    expect((await raw(port, '/api/chat/runs/r1')).status).toBe(200);
    expect((await raw(port, '/api/chat/runs/r2')).status).toBe(404);
    expect((await raw(port, '/api/chat/runs/r1/stop', { method: 'POST' })).status).toBe(200);
    expect((await raw(port, '/api/chat/runs/r2/stop', { method: 'POST' })).status).toBe(404);
    expect((await raw(port, '/api/chat/runs/r1/continue', { method: 'POST' })).status).toBe(409);
    expect((await raw(port, '/api/chat/runs/r1/merge', { method: 'POST' })).status).toBe(200);
    expect((await raw(port, '/api/chat/runs/r1/discard', { method: 'POST' })).status).toBe(409);
    expect((await raw(port, '/api/chat/runs/r1/stop')).status).toBe(405);
    expect((await raw(port, '/api/chat/runs', { method: 'DELETE' })).status).toBe(405);
  });

  it('gatilhos: listar, criar, editar, apagar, testar (só cria o cartão) e histórico; só pelo próprio computador', async () => {
    const { port } = await start();
    expect((await raw(port, '/api/chat/triggers', { method: 'POST', headers: { ...json, origin: 'http://evil' }, body: '{}' })).status).toBe(403);
    expect((await raw(port, '/api/chat/triggers', { headers: { host: '192.168.0.10' } })).status).toBe(403);
    expect(JSON.parse((await raw(port, '/api/chat/triggers')).body)).toEqual([{ id: 't1' }]);
    const bad = await raw(port, '/api/chat/triggers', { method: 'POST', headers: json, body: '{}' });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toBe('Dê um nome ao gatilho (até 60 caracteres).');
    const ok = await raw(port, '/api/chat/triggers', { method: 'POST', headers: json, body: JSON.stringify({ name: 'R' }) });
    expect(ok.status).toBe(201);
    expect(JSON.parse(ok.body)).toEqual({ id: 't1', name: 'R' });
    expect((await raw(port, '/api/chat/triggers/t1', { method: 'PUT', headers: json, body: JSON.stringify({ name: 'S' }) })).status).toBe(200);
    expect((await raw(port, '/api/chat/triggers/t2', { method: 'PUT', headers: json, body: '{}' })).status).toBe(404);
    expect((await raw(port, '/api/chat/triggers/t1/test', { method: 'POST' })).status).toBe(202);
    expect((await raw(port, '/api/chat/triggers/t2/test', { method: 'POST' })).status).toBe(404);
    expect(JSON.parse((await raw(port, '/api/chat/triggers/history')).body)).toEqual([{ id: 'f1', ruleId: 't1' }]);
    expect((await raw(port, '/api/chat/triggers/t1', { method: 'DELETE' })).status).toBe(200);
    expect((await raw(port, '/api/chat/triggers/t2', { method: 'DELETE' })).status).toBe(404);
    expect((await raw(port, '/api/chat/triggers/t1')).status).toBe(405);
    expect((await raw(port, '/api/chat/triggers/t1/test')).status).toBe(405);
    expect((await raw(port, '/api/chat/triggers/history', { method: 'POST' })).status).toBe(405);
  });
});
