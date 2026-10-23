import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { setQuiet } from '../log';
import { ntfyMessage, NtfySettings, sendNtfy, validateNtfyUrl } from './ntfy';

setQuiet(true);
const flush = () => new Promise((ok) => setTimeout(ok, 0));

describe('ntfy: endereço', () => {
  it('https com tópico; http só para localhost e a rede local; nada de login, query ou quebra de linha', () => {
    expect(validateNtfyUrl('https://ntfy.sh/meu-topico')).toEqual({ url: 'https://ntfy.sh/meu-topico' });
    expect(validateNtfyUrl('  ')).toEqual({ url: '' });
    for (const ok of ['http://localhost:8080/t', 'http://127.0.0.1/t', 'http://192.168.0.10/t', 'http://10.1.2.3/t', 'http://172.20.0.1/t', 'http://100.101.1.1/t', 'http://[::1]/t']) {
      expect(validateNtfyUrl(ok)).toHaveProperty('url');
    }
    for (const bad of ['http://ntfy.sh/t', 'http://172.32.0.1/t', 'http://8.8.8.8/t', 'https://ntfy.sh', 'https://ntfy.sh/', 'https://u:p@ntfy.sh/t', 'https://ntfy.sh/t?x=1', 'https://ntfy.sh/t\nX: y', 'ftp://ntfy.sh/t', 'javascript:alert(1)', 42]) {
      expect(validateNtfyUrl(bad)).toHaveProperty('error');
    }
  });

  it('mensagem: só o título do card (mascarado, cortado) e a frase do evento', () => {
    expect(ntfyMessage('Posts Builder', 'review')).toEqual({ title: 'Posts Builder', text: 'aguardando revisão' });
    expect(ntfyMessage('', 'ready').text).toBe('plano pronto');
    expect(ntfyMessage('x', 'failed').text).toBe('falhou');
    expect(ntfyMessage('y'.repeat(300), 'failed').title.length).toBeLessThanOrEqual(100);
    expect(ntfyMessage(`card ${['sk', 'ant', 'api03', 'a'.repeat(40)].join('-')}`, 'review').title).not.toContain('aaaaaaaaaaaaaaaaaaaa');
  });
});

describe('ntfy: envio', () => {
  it('POST no tópico com o título em RFC 2047; falha (rede ou HTTP) só vira log', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('', { status: 200 }));
    await sendNtfy('https://ntfy.sh/t', 'Cartão ✓', 'aguardando revisão', fetchMock as unknown as typeof fetch);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://ntfy.sh/t');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('aguardando revisão');
    const title = (init.headers as Record<string, string>).Title;
    expect(Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(title)![1], 'base64').toString('utf8')).toBe('Cartão ✓');
    await expect(sendNtfy('https://ntfy.sh/t', 'a', 'b', (async () => { throw new Error('sem rede'); }) as unknown as typeof fetch)).resolves.toBeUndefined();
    await expect(sendNtfy('https://ntfy.sh/t', 'a', 'b', (async () => new Response('', { status: 500 })) as unknown as typeof fetch)).resolves.toBeUndefined();
  });

  it('configuração: grava validado em notify.json, relê; desligado não manda nada', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hb-ntfy-')), 'sub', 'notify.json');
    const s = new NtfySettings(file);
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    s.notify('card', 'review', fetchMock as unknown as typeof fetch);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.set('http://ntfy.sh/t')).toMatch(/inválido/);
    expect(s.set('https://ntfy.sh/t')).toBeUndefined();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ntfyUrl: 'https://ntfy.sh/t' });
    expect(new NtfySettings(file).get()).toBe('https://ntfy.sh/t');
    s.notify('card', 'ready', fetchMock as unknown as typeof fetch);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
