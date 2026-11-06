// Ditado: transforma o áudio gravado no navegador em texto com o Whisper LOCAL (whisper.cpp: `whisper-cli`), sem mandar
// a voz para nenhum serviço. O idioma é detectado sozinho (`-l auto`); como o ditado é em português ou inglês, um
// resultado em outra língua (o Whisper às vezes confunde português com espanhol ou galego) é refeito em português.
// Precisa do whisper-cli, do ffmpeg (o áudio do celular vem em mp4/webm) e de um modelo multilíngue ggml-*.bin (os
// ".en" só entendem inglês e ficam de fora). Roda onde está o Whisper: o servidor no modo Node, o auxiliar do host
// (scripts/codex-bridge.ts) no Docker. Sem shell (execFile), com prazo, numa pasta temporária apagada no fim.
// Node puro e sem dependências: também é importado pelo auxiliar do host (via tsx).
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { tr } from '../../shared/i18n';

export const TRANSCRIBE_TIMEOUT_MS = 120_000;
/** Idiomas do ditado: o primeiro é o de reserva quando o detectado não está na lista. */
export const DEFAULT_LANGS = ['pt', 'en'] as const;
/** Do melhor para o mais leve: usa o primeiro que existir. */
const MODELS = ['ggml-large-v3-turbo.bin', 'ggml-large-v3.bin', 'ggml-medium.bin', 'ggml-small.bin', 'ggml-base.bin', 'ggml-tiny.bin'];

export interface WhisperSetup {
  bin: string;
  ffmpeg: string;
  model: string;
  langs: string[];
}

export interface Transcript {
  text: string;
  /** Código ISO do idioma reconhecido (ex.: "pt", "en"). */
  lang: string;
}

export type Transcriber = (audio: Buffer, type: string) => Promise<Transcript>;

function onPath(names: string[], env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | undefined {
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const p = join(dir, name);
      if (exists(p)) return p;
    }
  }
  return undefined;
}

/** Como instalar o que falta: no Windows o brew não existe (winget/scoop, ou o release do whisper.cpp). */
export function whisperHelp(what: 'whisper' | 'ffmpeg', platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return what === 'whisper' ? 'whisper-cli (brew install whisper-cpp)' : 'ffmpeg (brew install ffmpeg)';
  return what === 'whisper'
    ? tr('whisper-cli.exe (baixe whisper-bin-x64.zip em github.com/ggml-org/whisper.cpp/releases, extraia e ponha a pasta no PATH ou aponte HABBLAUD_WHISPER_BIN para o whisper-cli.exe; ou scoop install whisper-cpp)')
    : tr('ffmpeg (winget install Gyan.FFmpeg)');
}

/** Acha o whisper-cli, o ffmpeg e o melhor modelo multilíngue; undefined (com o motivo) se faltar algum. */
export function findWhisper(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync, platform: NodeJS.Platform = process.platform): WhisperSetup | { missing: string } {
  const win = platform === 'win32';
  const home = env.HOME || env.USERPROFILE || homedir();
  const ext = win ? '.exe' : '';
  const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const fixed = (names: string[], dirs: string[]) => dirs.flatMap((d) => names.map((n) => join(d, n))).find(exists);
  const bin =
    env.HABBLAUD_WHISPER_BIN?.trim() ||
    (win
      ? fixed(['whisper-cli.exe', 'whisper.exe'], [join(home, 'scoop', 'shims'), join(home, '.local', 'share', 'whisper'), join(home, '.whisper'), join(local, 'whisper.cpp'), join(local, 'whisper')]) || onPath(['whisper-cli.exe', 'whisper.exe'], env, exists)
      : ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'].find(exists) || onPath(['whisper-cli'], env, exists));
  if (!bin || !exists(bin)) return { missing: whisperHelp('whisper', platform) };
  const ffmpeg = env.HABBLAUD_FFMPEG_BIN?.trim() || (win ? undefined : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(exists)) || onPath([`ffmpeg${ext}`], env, exists);
  if (!ffmpeg || !exists(ffmpeg)) return { missing: whisperHelp('ffmpeg', platform) };
  const dirs = [join(home, '.local', 'share', 'whisper'), join(home, '.whisper'), '/opt/homebrew/share/whisper-cpp', '/usr/local/share/whisper-cpp'];
  const model =
    env.HABBLAUD_WHISPER_MODEL?.trim() ||
    MODELS.flatMap((m) => dirs.map((d) => join(d, m))).find(exists);
  if (!model || !exists(model)) return { missing: tr('um modelo multilíngue do Whisper (ggml-small.bin ou ggml-base.bin em ~/.local/share/whisper, ou HABBLAUD_WHISPER_MODEL)') };
  const langs = (env.HABBLAUD_DICTATION_LANGS ?? '')
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => /^[a-z]{2,3}$/.test(l));
  return { bin, ffmpeg, model, langs: langs.length ? langs : [...DEFAULT_LANGS] };
}

/** Prazo da transcrição proporcional ao áudio: duração estimada pelos bytes (voz do WhatsApp ~2 KB/s; mais bytes = estima mais, só alonga o prazo), 3x em tempo real mais 60 s, até 20 min. */
export function transcribeTimeoutMs(bytes: number): number {
  return Math.min(20 * 60_000, Math.max(TRANSCRIBE_TIMEOUT_MS, 60_000 + (bytes / 2000) * 3000));
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((ok) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => {
      if (!err) return ok({ ok: true });
      const line = (stderr || err.message || '').split('\n').filter((l) => l.trim()).pop() ?? tr('falhou');
      ok({ ok: false, error: line.trim().slice(0, 300) });
    });
  });
}

/** Texto e idioma do JSON do whisper-cli (-oj). */
export function parseWhisperJson(raw: string): Transcript {
  const d = JSON.parse(raw) as { result?: { language?: unknown }; transcription?: Array<{ text?: unknown }> };
  const text = (d.transcription ?? [])
    .map((t) => (typeof t.text === 'string' ? t.text : ''))
    .join(' ')
    .replace(/\[(BLANK_AUDIO|MUSIC|Música|SILENCE)\]|\((?:silence|música|music)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { text, lang: typeof d.result?.language === 'string' ? d.result.language : '' };
}

/** Transcritor com o whisper-cli; a pasta temporária some no fim, com ou sem erro. */
export function createWhisperTranscriber(setup: WhisperSetup, timeoutMs = TRANSCRIBE_TIMEOUT_MS): Transcriber {
  return async (audio) => {
    const dir = mkdtempSync(join(tmpdir(), 'habblaud-dictation-'));
    try {
      const input = join(dir, 'audio.in');
      const wav = join(dir, 'audio.wav');
      writeFileSync(input, audio, { mode: 0o600 });
      const conv = await run(setup.ffmpeg, ['-nostdin', '-loglevel', 'error', '-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], timeoutMs);
      if (!conv.ok) throw new Error(tr('não deu para ler o áudio ({0})', [conv.error]));
      const pass = async (lang: string): Promise<Transcript> => {
        const out = join(dir, `out-${lang}`);
        const r = await run(setup.bin, ['-m', setup.model, '-l', lang, '-f', wav, '-nt', '-np', '-oj', '-of', out], timeoutMs);
        if (!r.ok) throw new Error(tr('o Whisper falhou ({0})', [r.error]));
        return parseWhisperJson(readFileSync(`${out}.json`, 'utf8'));
      };
      const first = await pass('auto');
      if (!first.lang || setup.langs.includes(first.lang) || !first.text) return first;
      // Detectou uma língua fora da lista (ex.: "es" para português): refaz no idioma principal.
      const again = await pass(setup.langs[0]);
      return { text: again.text, lang: setup.langs[0] };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
