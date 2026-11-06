import { describe, expect, it } from 'vitest';
import { findWhisper, parseWhisperJson, transcribeTimeoutMs } from './whisper';

describe('Whisper local', () => {
  it('lê texto e idioma do JSON do whisper-cli, sem marcas de silêncio', () => {
    const raw = JSON.stringify({ result: { language: 'pt' }, transcription: [{ text: ' Crie um agente' }, { text: ' para o relatório. [BLANK_AUDIO]' }] });
    expect(parseWhisperJson(raw)).toEqual({ text: 'Crie um agente para o relatório.', lang: 'pt' });
    expect(parseWhisperJson('{}')).toEqual({ text: '', lang: '' });
  });

  it('acha binários e o melhor modelo multilíngue (nunca um .en)', () => {
    const have = new Set(['/opt/homebrew/bin/whisper-cli', '/opt/homebrew/bin/ffmpeg', '/h/.whisper/ggml-base.en.bin', '/h/.local/share/whisper/ggml-base.bin', '/h/.local/share/whisper/ggml-small.bin']);
    const bs = String.fromCharCode(92);
    const exists = (p: string) => have.has(p.split(bs).join('/'));
    const setup = findWhisper({ HOME: '/h', PATH: '' }, exists, 'darwin');
    if ('model' in setup) setup.model = setup.model.split(bs).join('/');
    expect(setup).toEqual({ bin: '/opt/homebrew/bin/whisper-cli', ffmpeg: '/opt/homebrew/bin/ffmpeg', model: '/h/.local/share/whisper/ggml-small.bin', langs: ['pt', 'en'] });
    have.delete('/h/.local/share/whisper/ggml-small.bin');
    have.delete('/h/.local/share/whisper/ggml-base.bin');
    expect(findWhisper({ HOME: '/h', PATH: '' }, exists, 'darwin')).toHaveProperty('missing');
    expect(findWhisper({ HOME: '/h', PATH: '' }, () => false, 'darwin')).toEqual({ missing: 'whisper-cli (brew install whisper-cpp)' });
    expect(findWhisper({ HOME: '/h', PATH: '', HABBLAUD_DICTATION_LANGS: 'en, pt, xx-bad' }, () => true, 'darwin')).toMatchObject({ langs: ['en', 'pt'] });
  });

  it('Windows: acha whisper-cli.exe no scoop, ffmpeg.exe no PATH e ensina a instalar o que falta', () => {
    const norm = (p: string) => p.split(String.fromCharCode(92)).join('/');
    const have = new Set(['C:/u/scoop/shims/whisper-cli.exe', 'C:/ff/ffmpeg.exe', 'C:/u/.local/share/whisper/ggml-large-v3-turbo.bin']);
    const f = (env: NodeJS.ProcessEnv, ok: (p: string) => boolean) => findWhisper(env, (p) => ok(norm(p)), 'win32');
    expect(f({ USERPROFILE: 'C:/u', PATH: 'C:/ff' }, (p) => have.has(p))).toMatchObject({ bin: expect.stringContaining('whisper-cli.exe'), ffmpeg: expect.stringContaining('ffmpeg.exe'), model: expect.stringContaining('turbo') });
    const none = f({ USERPROFILE: 'C:/u', PATH: '' }, () => false);
    expect(none).toHaveProperty('missing', expect.stringContaining('whisper.cpp/releases'));
    expect(JSON.stringify(none)).not.toContain('brew');
    expect(f({ USERPROFILE: 'C:/u', PATH: '', HABBLAUD_WHISPER_BIN: 'C:/w/whisper-cli.exe' }, (p) => p.includes('whisper-cli'))).toHaveProperty('missing', expect.stringContaining('winget install Gyan.FFmpeg'));
  });

  it('prazo cresce com o tamanho do áudio, com piso e teto', () => {
    expect(transcribeTimeoutMs(1000)).toBe(120_000);
    expect(transcribeTimeoutMs(600_000)).toBeGreaterThan(transcribeTimeoutMs(100_000));
    expect(transcribeTimeoutMs(1e12)).toBe(20 * 60_000);
  });
});
