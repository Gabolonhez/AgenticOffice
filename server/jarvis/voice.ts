// Voz do Jarvis (tela cheia): o motor escolhido, a chave do realtime e o TTS local, em <dataDir>/voice.json (600,
// gravado só pelo próprio computador; as chaves nunca voltam à página). Três motores:
//   realtime: OpenAI Realtime (Gemini Live depois) com token efêmero emitido aqui (limite por hora);
//   browser: SpeechRecognition + speechSynthesis do navegador (grátis);
//   local: Whisper local (server/dictation) + um TTS por HTTP (/v1/audio/speech, OpenAI-compatível), por este servidor.
// Todo pedido por voz entra no Jarvis com a origem 'voice' (contaminada: o microfone ouve o ambiente). PIN nunca passa
// por voz: o que parece PIN é barrado aqui, antes de chegar ao Jarvis.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CHAT_TEXT_MAX } from '../../shared/chat';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';
import { mintRealtime, REALTIME_PROVIDERS, type RealtimeProvider, type RealtimeSession } from './realtime';
import type { JarvisService } from './service';
import { RateWindow } from './tools';

export type VoiceEngine = 'realtime' | 'browser' | 'local';
export const VOICE_ENGINES: readonly VoiceEngine[] = ['realtime', 'browser', 'local'];
/** Tokens efêmeros por hora (cada um abre uma conversa de voz). */
export const VOICE_SESSIONS_PER_HOUR = 20;
/** Quanto o pedido por voz espera a resposta do Jarvis; depois, avisa que a resposta chega na tela. */
export const VOICE_ASK_WAIT_MS = 4 * 60_000;
const TTS_TEXT_MAX = 4000;
const KEY_MAX = 300;
const HOUR = 60 * 60_000;

export interface VoiceConfig {
  /** Sem motor gravado: realtime se houver chave do provedor, senão browser. */
  engine?: VoiceEngine;
  provider: RealtimeProvider;
  model?: string;
  voice?: string;
  openaiKey?: string;
  geminiKey?: string;
  /** TTS local: URL completa do endpoint (ex.: http://127.0.0.1:8880/v1/audio/speech). */
  ttsUrl?: string;
  ttsVoice?: string;
  ttsModel?: string;
}

/** O que a página vê: sem as chaves (só se existem). */
export interface VoiceView {
  engine: VoiceEngine;
  configured?: VoiceEngine;
  provider: RealtimeProvider;
  model?: string;
  voice?: string;
  keySet: Record<RealtimeProvider, boolean>;
  ttsUrl?: string;
  ttsVoice?: string;
  ttsModel?: string;
  editable: boolean;
}

const NAME_RE = /^[\w.:-]{1,60}$/;

/**
 * Parece um PIN? (o PIN tem no mínimo 6 caracteres; falado, vira número ou "pin/senha …"). Melhor barrar um pedido
 * inocente ("o PR 123456") do que mandar o PIN ao Jarvis e ao histórico.
 */
export function looksLikePin(text: string): boolean {
  const t = text.normalize('NFKC').toLowerCase();
  if (/\b(pin|senha|password|passcode|passphrase|contraseña|clave|mot de passe|code secret)\b/.test(t)) return true;
  return /(?:\d[\s.,-]?){6,}/.test(t);
}

export function effectiveEngine(c: VoiceConfig): VoiceEngine {
  if (c.engine) return c.engine;
  return keyOf(c, c.provider) ? 'realtime' : 'browser';
}

const keyOf = (c: VoiceConfig, p: RealtimeProvider) => (p === 'openai' ? c.openaiKey : c.geminiKey);

export function voiceView(c: VoiceConfig, editable: boolean): VoiceView {
  return {
    engine: effectiveEngine(c),
    ...(c.engine ? { configured: c.engine } : {}),
    provider: c.provider,
    ...(c.model ? { model: c.model } : {}),
    ...(c.voice ? { voice: c.voice } : {}),
    keySet: { openai: !!c.openaiKey, gemini: !!c.geminiKey },
    ...(c.ttsUrl ? { ttsUrl: c.ttsUrl } : {}),
    ...(c.ttsVoice ? { ttsVoice: c.ttsVoice } : {}),
    ...(c.ttsModel ? { ttsModel: c.ttsModel } : {}),
    editable,
  };
}

/**
 * Valida a gravação. Chave: string nova troca, vazia/ausente mantém, `null` apaga. Motor vazio = automático.
 */
export function validateVoiceConfig(raw: unknown, cur: VoiceConfig): { config: VoiceConfig } | { error: string } {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const next: VoiceConfig = { ...cur };
  if (b.engine !== undefined) {
    const e = s(b.engine);
    if (e && !VOICE_ENGINES.includes(e as VoiceEngine)) return { error: tr('Motor de voz inválido.') };
    if (e) next.engine = e as VoiceEngine;
    else delete next.engine;
  }
  if (b.provider !== undefined) {
    if (!REALTIME_PROVIDERS.includes(b.provider as RealtimeProvider)) return { error: tr('Provedor de voz inválido.') };
    next.provider = b.provider as RealtimeProvider;
  }
  for (const k of ['model', 'voice', 'ttsVoice', 'ttsModel'] as const) {
    if (b[k] === undefined) continue;
    const v = s(b[k]);
    if (v && !NAME_RE.test(v)) return { error: tr('Nome inválido em {0}.', [k]) };
    if (v) next[k] = v;
    else delete next[k];
  }
  if (b.ttsUrl !== undefined) {
    const v = s(b.ttsUrl);
    if (v) {
      let u: URL;
      try {
        u = new URL(v);
      } catch {
        return { error: tr('URL do TTS inválida.') };
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: tr('URL do TTS inválida.') };
      next.ttsUrl = u.href;
    } else delete next.ttsUrl;
  }
  for (const k of ['openaiKey', 'geminiKey'] as const) {
    if (b[k] === null) delete next[k];
    else if (typeof b[k] === 'string' && b[k].trim()) {
      const v = b[k].trim();
      if (v.length > KEY_MAX || /\s/.test(v)) return { error: tr('Chave inválida.') };
      next[k] = v;
    }
  }
  return { config: next };
}

/** voice.json: 600, gravado inteiro (tmp + rename). */
export class VoiceStore {
  private data: VoiceConfig = { provider: 'openai' };

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      const v = validateVoiceConfig(raw, { provider: 'openai' });
      if ('config' in v) this.data = v.config;
    } catch {
      // sem arquivo: padrão
    }
  }

  get(): VoiceConfig {
    return this.data;
  }

  set(c: VoiceConfig): string | undefined {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
      this.data = c;
      return undefined;
    } catch (err) {
      log.warnOnce(`voice:save:${errMsg(err)}`, tr('Voz do Jarvis: não deu para gravar ({0}).', [errMsg(err)]));
      return errMsg(err);
    }
  }
}

export interface VoiceDeps {
  store: Pick<VoiceStore, 'get' | 'set'>;
  say: JarvisService['say'];
  fetch?: typeof fetch;
  now?: () => number;
  perHour?: number;
  askWaitMs?: number;
}

export class VoiceService {
  private readonly sessions: RateWindow;
  private readonly now: () => number;

  constructor(private readonly deps: VoiceDeps) {
    this.now = deps.now ?? Date.now;
    this.sessions = new RateWindow(deps.perHour ?? VOICE_SESSIONS_PER_HOUR, HOUR);
  }

  view(editable: boolean): VoiceView {
    return voiceView(this.deps.store.get(), editable);
  }

  save(raw: unknown): { view: VoiceView } | { error: string; status: number } {
    const v = validateVoiceConfig(raw, this.deps.store.get());
    if ('error' in v) return { error: v.error, status: 400 };
    const err = this.deps.store.set(v.config);
    return err ? { error: err, status: 500 } : { view: this.view(true) };
  }

  /** Token efêmero do realtime (a chave fica aqui). Conta no limite por hora mesmo se o provedor recusar. */
  async session(lang: string): Promise<RealtimeSession | { error: string; status: number }> {
    const c = this.deps.store.get();
    const key = keyOf(c, c.provider);
    if (!key) return { error: tr('Sem chave do provedor de voz: configure em Configurações › Jarvis.'), status: 409 };
    if (!this.sessions.take(this.now())) return { error: tr('Limite de {0} conversas de voz por hora: espere um pouco.', [VOICE_SESSIONS_PER_HOUR]), status: 429 };
    const r = await mintRealtime(c.provider, { key, model: c.model, voice: c.voice, lang: /^(pt|en|es|fr)$/.test(lang) ? lang : 'en', fetch: this.deps.fetch, now: this.now });
    return 'error' in r ? { error: r.error, status: 502 } : r;
  }

  /**
   * Um pedido por voz ao Jarvis (origem 'voice', contaminada). PIN não passa. Espera a resposta até askWaitMs; depois
   * devolve um aviso (a resposta continua chegando na tela).
   */
  async ask(text: string): Promise<{ reply: string; blocked?: true; pending?: true }> {
    if (looksLikePin(text)) return { reply: tr('Não repasso PIN nem senha por voz: digite o PIN no cartão de aprovação.'), blocked: true };
    const d = this.deps.say(text.slice(0, CHAT_TEXT_MAX), 'voice');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((ok) => (timer = setTimeout(() => ok('late'), this.deps.askWaitMs ?? VOICE_ASK_WAIT_MS)));
    const r = await Promise.race([d.result, late]).finally(() => clearTimeout(timer));
    if (r === 'late') return { reply: tr('Ainda estou nisso: a resposta aparece na tela quando sair.'), pending: true };
    return { reply: r.ok ? r.reply || tr('(sem resposta)') : tr('Não consegui responder: {0}', [r.error]) };
  }

  /** TTS local (OpenAI-compatível): devolve o áudio, ou o erro. */
  async tts(text: string): Promise<{ audio: ArrayBuffer; type: string } | { error: string; status: number }> {
    const c = this.deps.store.get();
    if (!c.ttsUrl) return { error: tr('TTS local não configurado.'), status: 409 };
    const f = this.deps.fetch ?? fetch;
    try {
      const res = await f(c.ttsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: c.ttsModel || 'tts-1', voice: c.ttsVoice || 'alloy', input: text.slice(0, TTS_TEXT_MAX), response_format: 'mp3' }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return { error: tr('O TTS local respondeu {0}.', [res.status]), status: 502 };
      return { audio: await res.arrayBuffer(), type: res.headers.get('content-type') || 'audio/mpeg' };
    } catch (err) {
      return { error: tr('O TTS local não respondeu ({0}).', [errMsg(err)]), status: 502 };
    }
  }
}
