import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { setQuiet } from '../log';
import { ntfyMessage, NotifySettings, NTFY_FREE_MAX, sendNtfy, validateNtfyUrl } from './ntfy';
import { sendWhatsApp } from './whatsapp';

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
    const s = new NotifySettings(file);
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    s.notify('card', 'review', fetchMock as unknown as typeof fetch);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.set('http://ntfy.sh/t')).toMatch(/inválido/);
    expect(s.set('https://ntfy.sh/t')).toBeUndefined();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ntfyUrl: 'https://ntfy.sh/t' });
    expect(new NotifySettings(file).get()).toBe('https://ntfy.sh/t');
    s.notify('card', 'ready', fetchMock as unknown as typeof fetch);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('avisos: WhatsApp (WA-AKG) e canal', () => {
  const wa = { url: 'https://wa.dev/api/', apiKey: 'wag_segredo', sessionId: 'pessoal', ownerJid: '5511999999999@s.whatsapp.net' };

  it('grava o WhatsApp sem devolver a chave; a porta remota vê só "ligado"; chave vazia mantém a guardada', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hb-notify-')), 'notify.json');
    const s = new NotifySettings(file);
    expect(s.update({ wa: { ...wa, ownerJid: 'abc' } })).toMatch(/dono/);
    expect(s.update({ wa, channel: 'both', briefing: { time: '08:30', days: [1, 2, 3, 4, 5] } })).toBeUndefined();
    expect(s.wa()).toEqual({ ...wa, url: 'https://wa.dev' });
    expect(JSON.stringify(s.view(true))).not.toContain('wag_segredo');
    expect(s.view(true)).toMatchObject({ waConfigured: true, channel: 'both', wa: { url: 'https://wa.dev', sessionId: 'pessoal', apiKeySet: true }, briefing: { time: '08:30' } });
    expect(s.view(false)).toEqual({ configured: false, waConfigured: true, channel: 'both', briefing: { time: '08:30', days: [1, 2, 3, 4, 5] }, closing: { time: '', days: [] }, weekly: { time: '', days: [] }, editable: false });
    expect(s.update({ wa: { url: 'https://wa.dev', apiKey: '', sessionId: 'outra', ownerJid: wa.ownerJid } })).toBeUndefined();
    expect(s.wa()?.apiKey).toBe('wag_segredo');
    expect(new NotifySettings(file).wa()?.sessionId).toBe('outra');
    // Outro endereço sem digitar a chave de novo: a guardada não vai para o servidor novo.
    expect(s.update({ wa: { url: 'https://outro.dev', apiKey: '' } })).toMatch(/Chave/);
    expect(s.wa()?.url).toBe('https://wa.dev');
    expect(s.update({ wa: { url: 'https://outro.dev', apiKey: 'wag_nova' } })).toBeUndefined();
    expect(s.wa()).toMatchObject({ url: 'https://outro.dev', apiKey: 'wag_nova', sessionId: 'outra' });
    expect(s.update({ channel: 'pombo' })).toMatch(/inválido/);
    expect(s.update({ briefing: { time: '25:00' } })).toMatch(/inválido/);
    expect(s.update({ closing: { time: '18:30', days: [] }, weekly: { time: '17:00', days: [5] } })).toBeUndefined();
    expect(new NotifySettings(file).briefing('weekly')).toEqual({ time: '17:00', days: [5] });
    expect(s.briefing('closing').time).toBe('18:30');
    expect(s.update({ weekly: { time: 'x' } })).toMatch(/inválido/);
    expect(s.update({ wa: { url: '' } })).toBeUndefined();
    expect(s.wa()).toBeUndefined();
  });

  it('manda pelo WA-AKG: POST /api/messages/{sessão}/{jid}/send com x-api-key e {message: {text}}, mascarado', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: true, message: 'Message sent successfully', data: {} }), { status: 200 }));
    const err = await sendWhatsApp({ ...wa, url: 'https://wa.dev' }, `oi sk-ant-api03-${'a'.repeat(40)}`, fetchMock as unknown as typeof fetch);
    expect(err).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://wa.dev/api/messages/pessoal/5511999999999%40s.whatsapp.net/send');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('wag_segredo');
    const body = JSON.parse(String(init.body)) as { message: { text: string } };
    expect(body.message.text.startsWith('oi ')).toBe(true);
    expect(body.message.text).not.toContain('a'.repeat(40));
    const bad = vi.fn(async () => new Response(JSON.stringify({ status: false, message: 'Forbidden', error: 'Forbidden - Cannot access this session' }), { status: 403 }));
    expect(await sendWhatsApp({ ...wa, url: 'https://wa.dev' }, 'oi', bad as unknown as typeof fetch)).toBe('Forbidden - Cannot access this session');
  });

  it('avisos de card pelo canal escolhido; texto livre: ntfy só a manchete (até 200), WhatsApp tudo', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: true }), { status: 200 }));
    const s = new NotifySettings(join(mkdtempSync(join(tmpdir(), 'hb-notify-')), 'notify.json'), fetchMock as unknown as typeof fetch);
    s.update({ url: 'https://ntfy.sh/t', wa, channel: 'whatsapp' });
    s.notify('Card A', 'review');
    await flush();
    expect((fetchMock.mock.calls as unknown as Array<[string]>).map((c) => String(c[0]))).toEqual(['https://wa.dev/api/messages/pessoal/5511999999999%40s.whatsapp.net/send']);
    fetchMock.mockClear();
    s.update({ channel: 'both' });
    const r = await s.sendText(`linha 1\n${'x'.repeat(400)}`, { headline: 'manchete' });
    expect(r).toEqual({ ntfy: true, whatsapp: true });
    const [ntfyCall, waCall] = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(ntfyCall[0]).toBe('https://ntfy.sh/t');
    expect(ntfyCall[1].body).toBe('manchete');
    expect(JSON.parse(String(waCall[1].body)).message.text).toContain('x'.repeat(400));
    expect(await s.sendText('a'.repeat(500), { channel: 'ntfy' })).toEqual({ ntfy: true });
    expect(String((fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit])[1].body).length).toBe(NTFY_FREE_MAX);
  });
});
