// Motores de voz do Jarvis em tela cheia (ui/jarvis.ts), escolhidos em Configurações › Jarvis (server/jarvis/voice.ts):
// - realtime: OpenAI Realtime por WebRTC com o token efêmero do servidor (a chave nunca vem para cá). O modelo de voz só
//   tem ask_jarvis(texto): o pedido vai ao servidor (origem 'voice', contaminada) e a resposta volta para ele falar;
// - browser: SpeechRecognition contínuo (parciais na tela) + speechSynthesis na língua da página; sem SpeechRecognition,
//   o ditado do Habblaud (Whisper local), apertando para falar;
// - local: ditado (Whisper local) + TTS local pelo servidor (/voice/tts); sem TTS configurado, speechSynthesis com aviso.
// Todo motor fala com o overlay por `emit` (jarvis-model.ts) e devolve o nível 0..1 para o orb.
import { getLocale, tr } from '../../../shared/i18n';
import { pickMimeType, transcribeAudio } from './dictation';
import { levelOf, pickVoice, shortLang, speakable, speechEnvelope, speechLang, type VoiceEvent } from './jarvis-model';

export type EngineId = 'realtime' | 'browser' | 'local';

export interface VoiceViewLite {
  engine: EngineId;
  provider: 'openai' | 'gemini';
  ttsUrl?: string;
}

export interface EngineHost {
  emit(e: VoiceEvent): void;
  /** Aviso que não para a conversa (ex.: TTS local ausente). */
  warn(text: string): void;
}

export interface VoiceEngine {
  readonly id: EngineId;
  /** Ouvir aperta para falar (ditado)? Então o orb é o botão de gravar. */
  readonly pushToTalk: boolean;
  start(): Promise<void>;
  stop(): void;
  interrupt(): void;
  /** Só no aperta-para-falar: começa/termina a gravação. */
  toggleTalk?(): void;
  level(now: number): number;
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  } catch {
    throw new Error(tr('o Habblaud não respondeu'));
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? tr('erro {0}', [res.status]));
  return data;
}

/** Um pedido por voz ao Jarvis (origem 'voice'): espera a resposta (o servidor manda batidas enquanto ele pensa). */
export async function askJarvis(text: string): Promise<string> {
  return (await api<{ reply: string }>('/api/chat/jarvis/voice/ask', { text })).reply;
}

/** Medidor de nível de um stream (microfone ou a voz do realtime) ou de um <audio>. */
class Meter {
  private readonly buf: Uint8Array<ArrayBuffer>;
  private constructor(private readonly node: AnalyserNode) {
    this.buf = new Uint8Array(node.fftSize);
  }
  static of(ctx: AudioContext, src: MediaStream | HTMLMediaElement): Meter | null {
    try {
      const node = ctx.createAnalyser();
      node.fftSize = 512;
      const input = src instanceof MediaStream ? ctx.createMediaStreamSource(src) : ctx.createMediaElementSource(src);
      input.connect(node);
      // <audio> passa pelo grafo: precisa chegar à saída para continuar tocando.
      if (!(src instanceof MediaStream)) node.connect(ctx.destination);
      return new Meter(node);
    } catch {
      return null;
    }
  }
  level(): number {
    this.node.getByteTimeDomainData(this.buf);
    return levelOf(this.buf);
  }
}

let audioCtx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    audioCtx ??= new AudioContext();
    void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

async function openMic(): Promise<MediaStream> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error(tr('Este navegador não deixa gravar áudio aqui (precisa de HTTPS).'));
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    throw new Error((err as DOMException)?.name === 'NotAllowedError' ? tr('Sem permissão para o microfone: libere nas configurações do navegador e tente de novo.') : tr('Não deu para abrir o microfone.'));
  }
}

// ---------------------------------------------------------------- realtime (OpenAI, WebRTC)

interface RealtimeSessionView { provider: string; token: string; callUrl: string }

class RealtimeEngine implements VoiceEngine {
  readonly id = 'realtime' as const;
  readonly pushToTalk = false;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private out: HTMLAudioElement | null = null;
  private micMeter: Meter | null = null;
  private outMeter: Meter | null = null;
  private speaking = false;
  private heard = '';
  private said = '';
  private stopped = false;

  constructor(private readonly host: EngineHost) {}

  async start(): Promise<void> {
    const s = await api<RealtimeSessionView>('/api/chat/jarvis/voice/session', { lang: shortLang(getLocale()) });
    if (this.stopped) return;
    if (s.provider !== 'openai') throw new Error(tr('Gemini Live ainda não está pronto: use OpenAI Realtime ou outro motor de voz.'));
    this.mic = await openMic();
    if (this.stopped) return this.stop();
    const ctx = audio();
    if (ctx) this.micMeter = Meter.of(ctx, this.mic);
    const pc = (this.pc = new RTCPeerConnection());
    this.out = new Audio();
    this.out.autoplay = true;
    pc.ontrack = (e) => {
      this.out!.srcObject = e.streams[0];
      if (ctx) this.outMeter = Meter.of(ctx, e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && !this.stopped) this.host.emit({ type: 'fail', error: tr('A conexão de voz caiu.') });
    };
    pc.addTrack(this.mic.getAudioTracks()[0], this.mic);
    const dc = (this.dc = pc.createDataChannel('oai-events'));
    dc.onopen = () => this.host.emit({ type: 'ready' });
    dc.onmessage = (m) => void this.onEvent(m.data);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const res = await fetch(s.callUrl, { method: 'POST', body: offer.sdp, headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/sdp' } });
    if (!res.ok) throw new Error(tr('A OpenAI recusou a conversa de voz ({0}).', [res.status]));
    if (this.stopped) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
  }

  private send(ev: Record<string, unknown>): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(ev));
  }

  private async onEvent(raw: unknown): Promise<void> {
    let ev: { type?: string; delta?: string; transcript?: string; name?: string; call_id?: string; arguments?: string; error?: { message?: string } };
    try {
      ev = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.heard = '';
        this.host.emit({ type: 'hearing', text: '' });
        return;
      case 'conversation.item.input_audio_transcription.delta':
        this.heard += ev.delta ?? '';
        this.host.emit({ type: 'hearing', text: this.heard });
        return;
      case 'conversation.item.input_audio_transcription.completed':
        this.heard = ev.transcript ?? this.heard;
        this.host.emit({ type: 'hearing', text: this.heard });
        return;
      case 'response.output_audio_transcript.delta':
        this.said += ev.delta ?? '';
        this.host.emit({ type: 'caption', text: this.said });
        return;
      case 'response.created':
        this.said = '';
        return;
      case 'output_audio_buffer.started':
        this.speaking = true;
        this.host.emit({ type: 'speakStart' });
        return;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.speaking = false;
        this.host.emit({ type: 'speakEnd' });
        return;
      case 'response.function_call_arguments.done':
        if (ev.name === 'ask_jarvis' && ev.call_id) await this.askTool(ev.call_id, ev.arguments ?? '{}');
        return;
      case 'error':
        this.host.warn(ev.error?.message ?? tr('Erro na conversa de voz.'));
        return;
    }
  }

  private async askTool(callId: string, args: string): Promise<void> {
    let text = '';
    try {
      text = String((JSON.parse(args) as { texto?: unknown }).texto ?? '').trim();
    } catch {
      // argumentos inválidos: resposta vazia abaixo
    }
    this.host.emit({ type: 'ask', text: text || this.heard });
    let reply: string;
    try {
      reply = text ? await askJarvis(text) : tr('Não entendi o pedido.');
    } catch (err) {
      reply = tr('Não consegui falar com o Jarvis: {0}', [(err as Error).message]);
    }
    if (this.stopped) return;
    this.host.emit({ type: 'reply', text: reply });
    this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: reply } });
    this.send({ type: 'response.create' });
  }

  interrupt(): void {
    this.send({ type: 'response.cancel' });
    this.send({ type: 'output_audio_buffer.clear' });
    this.speaking = false;
    this.host.emit({ type: 'interrupt' });
  }

  stop(): void {
    this.stopped = true;
    this.dc?.close();
    this.pc?.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    if (this.out) this.out.srcObject = null;
    this.pc = this.dc = this.mic = this.out = null;
  }

  level(): number {
    return (this.speaking ? this.outMeter : this.micMeter)?.level() ?? 0;
  }
}

// ---------------------------------------------------------------- ouvir: SpeechRecognition ou ditado

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function recognitionCtor(): (new () => RecognitionLike) | undefined {
  const w = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** Motor de ouvir + falar em etapas (browser e local). */
class PipelineEngine implements VoiceEngine {
  readonly pushToTalk: boolean;
  private rec: RecognitionLike | null = null;
  private recorder: MediaRecorder | null = null;
  private mic: MediaStream | null = null;
  private micMeter: Meter | null = null;
  private outMeter: Meter | null = null;
  private player: HTMLAudioElement | null = null;
  private speakingSince = 0;
  private boundaryAt = 0;
  private synth = false;
  /** Pausado enquanto pensa e fala (o microfone não ouve o próprio Jarvis). */
  private paused = false;
  private stopped = false;
  private seq = 0;

  constructor(
    readonly id: 'browser' | 'local',
    private readonly host: EngineHost,
    private readonly ttsUrl: string | undefined,
  ) {
    this.pushToTalk = id === 'local' || !recognitionCtor();
  }

  async start(): Promise<void> {
    this.mic = await openMic();
    if (this.stopped) return this.stop();
    const ctx = audio();
    if (ctx) this.micMeter = Meter.of(ctx, this.mic);
    if (this.id === 'local' && !this.ttsUrl) this.host.warn(tr('TTS local não configurado: usando a voz do navegador.'));
    if (this.id === 'browser' && this.pushToTalk) this.host.warn(tr('Este navegador não reconhece fala: toque no orb para falar (ditado do Habblaud).'));
    if (!this.pushToTalk) this.listen();
    this.host.emit({ type: 'ready' });
  }

  private listen(): void {
    const Ctor = recognitionCtor();
    if (!Ctor || this.stopped) return;
    const rec = (this.rec = new Ctor());
    rec.lang = speechLang(getLocale());
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      if (this.paused) return;
      let interim = '';
      let final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (final.trim()) void this.ask(final.trim());
      else if (interim.trim()) this.host.emit({ type: 'hearing', text: interim.trim() });
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') this.host.emit({ type: 'fail', error: tr('Sem permissão para o microfone: libere nas configurações do navegador e tente de novo.') });
    };
    // O reconhecimento para sozinho de tempos em tempos: religa enquanto a tela está aberta.
    rec.onend = () => {
      if (!this.stopped && this.rec === rec) setTimeout(() => rec === this.rec && !this.stopped && safe(() => rec.start()), 250);
    };
    safe(() => rec.start());
  }

  toggleTalk(): void {
    if (!this.pushToTalk || !this.mic) return;
    if (this.recorder?.state === 'recording') return this.recorder.stop();
    this.halt();
    const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
    const chunks: Blob[] = [];
    let rec: MediaRecorder;
    try {
      rec = this.recorder = new MediaRecorder(this.mic, mimeType ? { mimeType } : undefined);
    } catch {
      return this.host.emit({ type: 'fail', error: tr('Este navegador não grava áudio.') });
    }
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      this.recorder = null;
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/mp4' });
      if (this.stopped) return;
      if (blob.size < 512) return this.host.warn(tr('Não ouvi nada: tente de novo, mais perto do microfone.'));
      this.host.emit({ type: 'hearing', text: tr('Transcrevendo no computador…') });
      transcribeAudio(blob).then(
        ({ text }) => (text.trim() ? void this.ask(text.trim()) : this.host.warn(tr('Não entendi nada na gravação: tente de novo.'))),
        (err: Error) => this.host.warn(tr('Ditado falhou: {0}', [err.message])),
      );
    };
    rec.start();
    this.host.emit({ type: 'hearing', text: '' });
  }

  private async ask(text: string): Promise<void> {
    const my = ++this.seq;
    this.paused = true;
    this.host.emit({ type: 'ask', text });
    let reply: string;
    try {
      reply = await askJarvis(text);
    } catch (err) {
      reply = tr('Não consegui falar com o Jarvis: {0}', [(err as Error).message]);
    }
    if (this.stopped || my !== this.seq) return;
    this.host.emit({ type: 'reply', text: reply });
    await this.speak(reply);
    if (my === this.seq) this.paused = false;
  }

  private async speak(text: string): Promise<void> {
    const clean = speakable(text);
    if (!clean) return;
    if (this.id === 'local' && this.ttsUrl) {
      try {
        const res = await fetch('/api/chat/jarvis/voice/tts', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: clean }) });
        if (!res.ok) throw new Error(String(((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status));
        const url = URL.createObjectURL(await res.blob());
        const el = (this.player = new Audio(url));
        const ctx = audio();
        this.outMeter = ctx ? Meter.of(ctx, el) : null;
        await new Promise<void>((done) => {
          el.onplaying = () => this.host.emit({ type: 'speakStart' });
          el.onended = el.onerror = el.onpause = () => done();
          el.play().catch(() => done());
        });
        URL.revokeObjectURL(url);
        this.player = null;
        this.host.emit({ type: 'speakEnd' });
        return;
      } catch (err) {
        this.host.warn(tr('TTS local falhou ({0}): usando a voz do navegador.', [(err as Error).message]));
      }
    }
    await new Promise<void>((done) => {
      try {
        const u = new SpeechSynthesisUtterance(clean);
        u.lang = speechLang(getLocale());
        const v = pickVoice(speechSynthesis.getVoices(), u.lang);
        if (v) u.voice = v;
        u.onstart = () => {
          this.synth = true;
          this.speakingSince = performance.now();
          this.host.emit({ type: 'speakStart' });
        };
        u.onboundary = () => (this.boundaryAt = performance.now());
        u.onend = u.onerror = () => {
          this.synth = false;
          this.host.emit({ type: 'speakEnd' });
          done();
        };
        speechSynthesis.speak(u);
      } catch {
        done();
      }
    });
  }

  /** Para a fala em andamento. */
  private halt(): void {
    this.seq++;
    this.paused = false;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.player?.pause();
    this.synth = false;
  }

  interrupt(): void {
    this.halt();
    this.host.emit({ type: 'interrupt' });
  }

  stop(): void {
    this.stopped = true;
    this.halt();
    const rec = this.rec;
    this.rec = null;
    if (rec) safe(() => rec.abort());
    if (this.recorder?.state === 'recording') safe(() => this.recorder!.stop());
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
  }

  level(now: number): number {
    if (this.synth) return speechEnvelope(now - this.speakingSince, now - this.boundaryAt);
    if (this.player) return this.outMeter?.level() ?? speechEnvelope(now);
    return this.paused ? 0 : (this.micMeter?.level() ?? 0);
  }
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export function createEngine(v: VoiceViewLite, host: EngineHost): VoiceEngine {
  if (v.engine === 'realtime') return new RealtimeEngine(host);
  return new PipelineEngine(v.engine, host, v.ttsUrl);
}
