import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJarvisRoutes } from './http';
import { jarvisProviders, type JarvisSettings } from './service';

let server: http.Server | undefined;
afterEach(() => server?.close());

async function start(isRemote = false, voice?: unknown) {
  let settings: JarvisSettings = { provider: 'claude', model: 'sonnet' };
  const jarvis = {
    ensure: vi.fn(() => 'chat:jarvis'),
    say: vi.fn(),
    reset: vi.fn(() => 'ok' as const),
    providers: () => jarvisProviders(() => true),
    settingsChanged: vi.fn(() => 'ok' as const),
  };
  const saveSettings = vi.fn((s: JarvisSettings) => ((settings = s), undefined));
  const routes = createJarvisRoutes({ jarvis: jarvis as never, settings: () => settings, saveSettings, voice: voice as never });
  server = http.createServer((req, res) => void routes(req, res, new URL(req.url ?? '/', 'http://x'), isRemote).then((handled) => handled || (res.writeHead(404), res.end())));
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  return { call, jarvis, saveSettings };
}

describe('Jarvis: rotas', () => {
  it('GET cria/mostra; POST {text} entra pela página (origem ui)', async () => {
    const t = await start();
    expect((await t.call('/api/chat/jarvis')).body).toMatchObject({ agentId: 'chat:jarvis', provider: 'claude', model: 'sonnet' });
    expect((await t.call('/api/chat/jarvis', 'POST', { text: '  bom dia ' })).status).toBe(202);
    expect(t.jarvis.say).toHaveBeenCalledWith('bom dia', 'ui', '', []);
    expect((await t.call('/api/chat/jarvis', 'POST', { text: '' })).status).toBe(400);
  });

  it('trocar o provedor: valida, recusa o Antigravity e o Codex, só pelo próprio computador', async () => {
    const t = await start();
    expect((await t.call('/api/chat/jarvis/settings', 'POST', { provider: 'antigravity' })).status).toBe(400);
    expect((await t.call('/api/chat/jarvis/settings', 'POST', { provider: 'codex' })).status).toBe(400);
    expect(t.saveSettings).not.toHaveBeenCalled();
    const ok = await t.call('/api/chat/jarvis/settings', 'POST', { provider: 'claude', model: 'haiku' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ provider: 'claude', model: 'haiku' });
    expect(t.jarvis.settingsChanged).toHaveBeenCalled();
    server?.close();
    const remote = await start(true);
    expect((await remote.call('/api/chat/jarvis/settings', 'POST', { provider: 'claude' })).status).toBe(403);
    expect(remote.saveSettings).not.toHaveBeenCalled();
  });

  it('voz: o pedido vai ao serviço de voz (origem voice) e volta como JSON; gravar só pelo próprio computador', async () => {
    const voice = { view: vi.fn((_e: boolean) => ({ engine: 'browser' })), save: vi.fn(() => ({ view: {} })), session: vi.fn(), ask: vi.fn(async (_t: string) => ({ reply: 'oi' })), tts: vi.fn() };
    const t = await start(false, voice);
    expect((await t.call('/api/chat/jarvis/voice/ask', 'POST', { text: ' status ' })).body).toEqual({ reply: 'oi' });
    expect(voice.ask).toHaveBeenCalledWith('status');
    expect(t.jarvis.say).not.toHaveBeenCalled();
    server?.close();
    const remote = await start(true, voice);
    expect((await remote.call('/api/chat/jarvis/voice', 'POST', { engine: 'local' })).status).toBe(403);
    expect(voice.save).not.toHaveBeenCalled();
    expect((await remote.call('/api/chat/jarvis/voice')).body).toEqual({ engine: 'browser' });
    expect(voice.view).toHaveBeenLastCalledWith(false);
  });
});
