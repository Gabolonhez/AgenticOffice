import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openaiSecretBody } from './realtime';
import { effectiveEngine, looksLikePin, validateVoiceConfig, VoiceService, VoiceStore, type VoiceConfig } from './voice';

const okFetch = () =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ value: 'ek_123', expires_at: 1_000, session: { model: 'gpt-realtime' } }), { status: 200 }));

function setup(cfg: Partial<VoiceConfig> = {}, o: { fetch?: typeof fetch; perHour?: number; reply?: Promise<unknown> } = {}) {
  let data: VoiceConfig = { provider: 'openai', ...cfg };
  const store = { get: () => data, set: vi.fn((c: VoiceConfig) => ((data = c), undefined)) };
  const say = vi.fn((_text: string, _origin: string) => ({ result: (o.reply ?? Promise.resolve({ ok: true, reply: 'feito' })) as never, cancel: () => {} }));
  const svc = new VoiceService({ store, say, fetch: o.fetch, perHour: o.perHour, now: () => 0, askWaitMs: 50 });
  return { svc, say, store };
}

describe('voz do Jarvis', () => {
  it('PIN nunca passa: número de 6+ dígitos ou a palavra PIN/senha', () => {
    expect(looksLikePin('aprova com o pin 4 8 1 5 1 6')).toBe(true);
    expect(looksLikePin('minha senha é banana azul')).toBe(true);
    expect(looksLikePin('481516')).toBe(true);
    expect(looksLikePin('como está o dia?')).toBe(false);
    expect(looksLikePin('abre 3 agentes no projeto 12')).toBe(false);
  });

  it('pedido por voz entra com a origem "voice"; o que parece PIN é barrado antes do Jarvis', async () => {
    const t = setup();
    expect(await t.svc.ask('o que está rodando?')).toEqual({ reply: 'feito' });
    expect(t.say).toHaveBeenCalledWith('o que está rodando?', 'voice');
    const blocked = await t.svc.ask('o PIN é 123456');
    expect(blocked.blocked).toBe(true);
    expect(t.say).toHaveBeenCalledTimes(1);
  });

  it('resposta que demora volta como pendente (a tela recebe depois)', async () => {
    const t = setup({}, { reply: new Promise(() => {}) });
    expect(await t.svc.ask('relatório da semana')).toMatchObject({ pending: true });
  });

  it('token efêmero: a chave só vai ao provedor; o navegador recebe o ek_ e onde abrir a conversa', async () => {
    const f = okFetch();
    const t = setup({ openaiKey: 'sk-secreta', voice: 'cedar' }, { fetch: f as never });
    const r = await t.svc.session('pt');
    expect(r).toEqual({ provider: 'openai', token: 'ek_123', expiresAt: 1_000_000, model: 'gpt-realtime', callUrl: 'https://api.openai.com/v1/realtime/calls' });
    expect(JSON.stringify(r)).not.toContain('sk-secreta');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-secreta');
    const body = JSON.parse(String(init!.body));
    expect(body.session.tools.map((x: { name: string }) => x.name)).toEqual(['ask_jarvis']);
    expect(body.session.audio.output.voice).toBe('cedar');
    expect(body.session.audio.input.transcription.language).toBe('pt');
  });

  it('limite por hora e sem chave = sem token', async () => {
    const f = okFetch();
    const t = setup({ openaiKey: 'sk-x' }, { fetch: f as never, perHour: 2 });
    expect('token' in (await t.svc.session('en'))).toBe(true);
    expect('token' in (await t.svc.session('en'))).toBe(true);
    expect(await t.svc.session('en')).toMatchObject({ status: 429 });
    expect(f).toHaveBeenCalledTimes(2);
    expect(await setup().svc.session('en')).toMatchObject({ status: 409 });
  });

  it('provedor recusou: erro curto, sem a chave', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }));
    const r = await setup({ openaiKey: 'sk-x' }, { fetch: f as never }).svc.session('en');
    expect(r).toMatchObject({ status: 502 });
    expect(JSON.stringify(r)).not.toContain('sk-x');
  });

  it('Gemini: a escolha existe, a emissão ainda não', async () => {
    expect(await setup({ provider: 'gemini', geminiKey: 'g' }).svc.session('en')).toMatchObject({ status: 502 });
  });

  it('motor automático: realtime com chave, senão navegador; a view nunca tem a chave', () => {
    expect(effectiveEngine({ provider: 'openai' })).toBe('browser');
    expect(effectiveEngine({ provider: 'openai', openaiKey: 'k' })).toBe('realtime');
    expect(effectiveEngine({ provider: 'openai', openaiKey: 'k', engine: 'local' })).toBe('local');
    const t = setup({ openaiKey: 'sk-x' });
    expect(JSON.stringify(t.svc.view(true))).not.toContain('sk-x');
    expect(t.svc.view(true).keySet.openai).toBe(true);
  });

  it('validação: chave vazia mantém, null apaga; URL do TTS só http(s); motor inválido recusa', () => {
    const cur: VoiceConfig = { provider: 'openai', openaiKey: 'old' };
    expect(validateVoiceConfig({ openaiKey: '' }, cur)).toEqual({ config: cur });
    expect(validateVoiceConfig({ openaiKey: null }, cur)).toEqual({ config: { provider: 'openai' } });
    expect(validateVoiceConfig({ ttsUrl: 'file:///etc/passwd' }, cur)).toHaveProperty('error');
    expect(validateVoiceConfig({ engine: 'telepatia' }, cur)).toHaveProperty('error');
    expect(validateVoiceConfig({ engine: 'local', ttsUrl: 'http://127.0.0.1:8880/v1/audio/speech' }, cur)).toMatchObject({ config: { engine: 'local', ttsUrl: 'http://127.0.0.1:8880/v1/audio/speech' } });
  });

  it('voice.json é gravado com permissão 600 e relido', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'voice-')), 'voice.json');
    const s = new VoiceStore(file);
    expect(s.set({ provider: 'openai', openaiKey: 'sk-1' })).toBeUndefined();
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).openaiKey).toBe('sk-1');
    expect(new VoiceStore(file).get().openaiKey).toBe('sk-1');
  });

  it('formato do client_secrets: GA (session.type realtime) e validade curta', () => {
    const b = openaiSecretBody({ lang: 'fr' }) as { expires_after: { seconds: number }; session: { type: string; model: string } };
    expect(b.session.type).toBe('realtime');
    expect(b.session.model).toBe('gpt-realtime');
    expect(b.expires_after.seconds).toBeLessThanOrEqual(600);
  });
});
