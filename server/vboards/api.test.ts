import { describe, expect, it, vi } from 'vitest';
import { apiErrorText, VBoardsApi } from './api';
import { resolveConfig } from './vboards';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('VBoards API v1', () => {
  it('Bearer vb_, caminhos e corpos do contrato', async () => {
    const f = vi.fn(async () => res(200, { messages: [{ id: 'm1', chatJid: 'c', senderJid: 's', text: 'oi', receivedAt: '2026-10-23T10:00:00Z' }, { id: 7 }] }));
    const api = new VBoardsApi({ base: 'https://vb.dev', token: 'vb_abc' }, f as unknown as typeof fetch);
    expect(await api.inbox()).toEqual([{ id: 'm1', chatJid: 'c', senderJid: 's', text: 'oi', receivedAt: Date.parse('2026-10-23T10:00:00Z') }]);
    await api.ack('m 1', 'resposta');
    await api.addSubtasks('card/1', ['a'], true);
    await api.tasks({ status: 'backlog' });
    const calls = f.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([u, i]) => `${i.method} ${u}`)).toEqual([
      'GET https://vb.dev/api/v1/jarvis/inbox',
      'POST https://vb.dev/api/v1/jarvis/inbox/m%201/ack',
      'POST https://vb.dev/api/v1/schedule/card%2F1/subtasks',
      'GET https://vb.dev/api/v1/tasks?status=backlog',
    ]);
    expect((calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer vb_abc');
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ reply: 'resposta' });
    expect(JSON.parse(String(calls[2][1].body))).toEqual({ texts: ['a'], queue: true });
  });

  it('inbox: campo audio opcional (VBoards antigo = só texto) e GET do áudio cru', async () => {
    const f = vi.fn(async (u: string) =>
      String(u).endsWith('/audio')
        ? new Response(new Uint8Array([1, 2, 3]))
        : res(200, { messages: [{ id: 'a1', chatJid: 'c', senderJid: 's', audio: { mime: 'audio/ogg', bytes: 3 }, receivedAt: 1 }, { id: 'a2', text: 'oi', audio: { mime: 5 } }, { id: 'a3' }] }),
    );
    const api = new VBoardsApi({ base: 'https://vb.dev', token: 'vb_abc' }, f as unknown as typeof fetch);
    const list = await api.inbox();
    expect(list.map((m) => [m.id, m.text, m.audio])).toEqual([['a1', '', { mime: 'audio/ogg', bytes: 3 }], ['a2', 'oi', undefined]]);
    expect([...(await api.inboxAudio('a 1', 10))]).toEqual([1, 2, 3]);
    expect(f.mock.calls.at(-1)![0]).toBe('https://vb.dev/api/v1/jarvis/inbox/a%201/audio');
    await expect(api.inboxAudio('a1', 2)).rejects.toThrow('grande demais');
  });

  it('403 sem escopo e 401 viram frase clara; uma tentativa só', async () => {
    expect(apiErrorText(403, 'missing scope agent')).toBe('O token do VBoards precisa do escopo agent.');
    expect(apiErrorText(401, 'expired')).toBe('Token do VBoards expirado ou inválido.');
    expect(apiErrorText(500, 'internal error')).toBe('VBoards respondeu 500: internal error');
    const f = vi.fn(async () => res(403, { error: 'missing scope agent' }));
    await expect(new VBoardsApi({ base: 'https://vb.dev', token: 'vb_abc' }, f as unknown as typeof fetch).approve('c')).rejects.toThrow('escopo agent');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('token antigo: a API v1 fica desligada, sem chamar nada', async () => {
    const f = vi.fn();
    const api = new VBoardsApi({ base: 'https://vb.dev', token: 'segredo-antigo' }, f as unknown as typeof fetch);
    expect(api.enabled).toBe(false);
    await expect(api.me()).rejects.toThrow('vb_');
    expect(f).not.toHaveBeenCalled();
  });

  it('configuração: token vb_ dispensa o e-mail (vem do token); o segredo antigo continua precisando dele', () => {
    const git = { url: 'https://vb.dev/api/commits', email: '' };
    expect(resolveConfig({}, { ...git, token: 'vb_x' })).toEqual({ base: 'https://vb.dev', token: 'vb_x', email: '' });
    expect(resolveConfig({}, { ...git, token: 'antigo' })).toHaveProperty('off');
  });
});
