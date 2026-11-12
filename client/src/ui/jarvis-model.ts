// Lógica pura do Jarvis em tela cheia (ui/jarvis.ts): a máquina de estados da voz, o nível do orb, a voz do navegador
// pela língua da página e o histórico curto.
import type { ChatItem } from '../../../shared/chat';
import { tr, type Locale } from '../../../shared/i18n';

export type VoicePhase = 'off' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

export type VoiceEvent =
  | { type: 'start' }
  | { type: 'ready' }
  /** Transcrição parcial (o que está sendo ouvido agora). */
  | { type: 'hearing'; text: string }
  /** Pedido fechado, indo ao Jarvis. */
  | { type: 'ask'; text: string }
  | { type: 'reply'; text: string }
  | { type: 'speakStart' }
  /** Legenda do que está sendo falado (realtime: a transcrição da saída). */
  | { type: 'caption'; text: string }
  | { type: 'speakEnd' }
  | { type: 'interrupt' }
  | { type: 'fail'; error: string }
  | { type: 'stop' };

export interface VoiceUi {
  phase: VoicePhase;
  /** O que está sendo ouvido (parcial) ou o último pedido. */
  heard: string;
  /** O que o Jarvis está falando (ou a última resposta). */
  said: string;
  error: string;
}

export const VOICE_OFF: VoiceUi = { phase: 'off', heard: '', said: '', error: '' };

/** Próximo estado. Eventos fora de hora (ex.: fala depois de fechar) não mudam nada. */
export function stepVoice(s: VoiceUi, e: VoiceEvent): VoiceUi {
  if (e.type === 'stop') return VOICE_OFF;
  if (e.type === 'start') return s.phase === 'off' || s.phase === 'error' ? { ...VOICE_OFF, phase: 'connecting' } : s;
  if (s.phase === 'off') return s;
  if (e.type === 'fail') return { ...s, phase: 'error', error: e.error };
  if (s.phase === 'error') return s;
  switch (e.type) {
    case 'ready':
      return s.phase === 'connecting' ? { ...s, phase: 'listening' } : s;
    case 'hearing':
      // Falar por cima do Jarvis (realtime) também volta a ouvir.
      return s.phase === 'connecting' ? s : { ...s, phase: 'listening', heard: e.text };
    case 'ask':
      return { ...s, phase: 'thinking', heard: e.text, said: '' };
    case 'reply':
      return { ...s, phase: s.phase === 'thinking' ? 'listening' : s.phase, said: e.text };
    case 'speakStart':
      return s.phase === 'connecting' ? s : { ...s, phase: 'speaking' };
    case 'caption':
      return { ...s, said: e.text };
    case 'speakEnd':
      return s.phase === 'speaking' ? { ...s, phase: 'listening' } : s;
    case 'interrupt':
      return s.phase === 'speaking' || s.phase === 'thinking' ? { ...s, phase: 'listening' } : s;
  }
}

export function phaseLabel(p: VoicePhase): string {
  switch (p) {
    case 'connecting':
      return tr('Conectando…');
    case 'listening':
      return tr('Ouvindo');
    case 'thinking':
      return tr('Pensando…');
    case 'speaking':
      return tr('Falando');
    case 'error':
      return tr('Erro');
    default:
      return tr('Desligado');
  }
}

/** Nível 0..1 de um quadro do AnalyserNode (getByteTimeDomainData: 128 = silêncio). */
export function levelOf(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 3.2);
}

/** Envelope sintético da fala do navegador (o speechSynthesis não passa pelo AudioContext): sílabas a ~5 Hz. */
export function speechEnvelope(ms: number, sinceBoundaryMs = Infinity): number {
  const syl = Math.abs(Math.sin(ms / 1000 * Math.PI * 5)) * 0.45 + Math.abs(Math.sin(ms / 1000 * Math.PI * 1.3)) * 0.25;
  const kick = sinceBoundaryMs < 160 ? (1 - sinceBoundaryMs / 160) * 0.3 : 0;
  return Math.min(1, 0.15 + syl + kick);
}

const SPEECH_LANG: Record<Locale, string> = { 'pt-BR': 'pt-BR', en: 'en-US', es: 'es-ES', fr: 'fr-FR' };
export const speechLang = (l: Locale): string => SPEECH_LANG[l];
/** A língua curta do realtime/transcrição. */
export const shortLang = (l: Locale): string => l.slice(0, 2);

/** A melhor voz do navegador para a língua: a exata (pt-BR), senão a da família (pt-PT), local antes de remota. */
export function pickVoice<V extends { lang: string; localService?: boolean; name?: string }>(voices: readonly V[], lang: string): V | undefined {
  const norm = (s: string) => s.replace('_', '-').toLowerCase();
  const want = norm(lang);
  const fam = want.split('-')[0];
  // Vozes neurais grátis do navegador (Edge: "... Online (Natural)"; Chrome: "Google ...") soam bem melhor que as locais.
  const quality = (v: V) => (/natural|neural/i.test(v.name ?? '') ? 0 : /google/i.test(v.name ?? '') ? 0.3 : v.localService ? 0.6 : 0.9);
  const rank = (v: V) => (norm(v.lang) === want ? 0 : norm(v.lang).split('-')[0] === fam ? 2 : 9) + quality(v);
  const best = [...voices].sort((a, b) => rank(a) - rank(b))[0];
  return best && rank(best) < 9 ? best : undefined;
}

/** Texto para falar: sem marcação de markdown, curto. */
export function speakable(text: string, max = 1500): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_#`>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export interface HistoryLine {
  seq: number;
  who: 'you' | 'jarvis' | 'note';
  text: string;
  /** Pedido que veio por voz (contaminado) ou de fora: a origem aparece. */
  from?: string;
  error?: boolean;
}

/** As últimas `n` falas da conversa (pedidos, respostas, avisos e cartões), sem ferramentas nem uso. */
export function historyTail(items: readonly ChatItem[], n = 8): HistoryLine[] {
  const out: HistoryLine[] = [];
  for (const i of items) {
    if (i.kind === 'user') out.push({ seq: i.seq, who: 'you', text: stripUntrusted(i.text), ...(i.from && i.from.agentId !== 'ui' ? { from: i.from.name } : {}) });
    else if (i.kind === 'assistant') out.push({ seq: i.seq, who: 'jarvis', text: i.text });
    else if (i.kind === 'notice') out.push({ seq: i.seq, who: 'note', text: i.text, ...(i.level === 'error' ? { error: true } : {}) });
    else if (i.kind === 'approval') out.push({ seq: i.seq, who: 'note', text: tr('Pedido de aprovação: {0}', [i.text]) });
  }
  return out.slice(-n);
}

// ---------------------------------------------------------------- o que o Jarvis está fazendo (painel de atividade)

export type ActivityIcon = 'web' | 'open' | 'agent' | 'list' | 'project' | 'board' | 'memory' | 'notify' | 'clock' | 'gauge' | 'lock' | 'spark';
export type ActivityState = 'running' | 'done' | 'error' | 'waiting';
export interface ActivityRow { seq: number; icon: ActivityIcon; label: string; detail: string; state: ActivityState; agentId?: string }

/** Ferramenta do MCP do escritório → rótulo e ícone (prefixo `mcp__<servidor>__` fora). */
function toolLook(raw: string): { icon: ActivityIcon; label: string } {
  const n = raw.replace(/^mcp__.+?__/, '');
  if (n === 'web_research') return { icon: 'web', label: tr('Pesquisando na web') };
  if (n === 'pc_open') return { icon: 'open', label: tr('Abrindo no computador') };
  if (n === 'agents_send') return { icon: 'agent', label: tr('Mandando mensagem a um agente') };
  if (n === 'agents_spawn') return { icon: 'agent', label: tr('Abrindo um agente') };
  if (n === 'agents_stop' || n === 'agents_close') return { icon: 'agent', label: tr('Parando um agente') };
  if (n.startsWith('agents_')) return { icon: 'agent', label: tr('Olhando os agentes') };
  if (n.startsWith('runs_')) return { icon: 'list', label: tr('Cuidando das listas') };
  if (n.startsWith('projects_') || n.startsWith('release_')) return { icon: 'project', label: tr('Consultando os projetos') };
  if (n.startsWith('vboards_')) return { icon: 'board', label: tr('Consultando o VBoards') };
  if (n === 'memory_write') return { icon: 'memory', label: tr('Guardando na memória') };
  if (n.startsWith('memory_')) return { icon: 'memory', label: tr('Lendo a memória') };
  if (n.startsWith('notify_')) return { icon: 'notify', label: tr('Mandando um aviso') };
  if (n.startsWith('schedule_')) return { icon: 'clock', label: tr('Mexendo nos agendamentos') };
  if (n.startsWith('usage_')) return { icon: 'gauge', label: tr('Vendo o consumo') };
  return { icon: 'spark', label: n };
}

/** O campo mais útil da entrada da ferramenta (pergunta, link, alvo, texto…), ou o texto cru cortado. */
function toolDetail(input: string): { detail: string; agentId?: string } {
  try {
    const o = JSON.parse(input) as Record<string, unknown>;
    const agentId = typeof o.agentId === 'string' ? o.agentId : undefined;
    for (const k of ['question', 'url', 'target', 'text', 'prompt', 'folder', 'product', 'name', 'id']) {
      if (typeof o[k] === 'string' && o[k]) return { detail: (o[k] as string).replace(/\s+/g, ' ').slice(0, 140), ...(agentId ? { agentId } : {}) };
    }
    return { detail: '', ...(agentId ? { agentId } : {}) };
  } catch {
    return { detail: input.replace(/\s+/g, ' ').slice(0, 140) };
  }
}

/** As ações da rodada atual (desde o último pedido): ferramentas e cartões de aprovação, na ordem. */
export function activityOf(items: readonly ChatItem[]): ActivityRow[] {
  let start = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind === 'user') {
      start = i;
      break;
    }
  }
  const out: ActivityRow[] = [];
  for (const i of items.slice(start + 1)) {
    if (i.kind === 'tool') {
      const look = toolLook(i.name);
      out.push({ seq: i.seq, ...look, ...toolDetail(i.input), state: i.error || i.blocked ? 'error' : i.output === undefined ? 'running' : 'done' });
    } else if (i.kind === 'approval') {
      out.push({
        seq: i.seq,
        icon: 'lock',
        label: i.outcome === 'allow' ? tr('Aprovado por você') : i.outcome === 'deny' ? tr('Recusado por você') : tr('Esperando sua aprovação (PIN)'),
        detail: i.text.replace(/\s+/g, ' ').slice(0, 140),
        state: i.outcome === 'allow' ? 'done' : i.outcome === 'deny' ? 'error' : 'waiting',
      });
    }
  }
  return out;
}

/** O pedido de fora chega embrulhado em <dados_nao_confiaveis …>: na tela, só o texto. */
function stripUntrusted(text: string): string {
  const m = /^<dados_nao_confiaveis[^>]*>\n?([\s\S]*?)\n?<\/dados_nao_confiaveis>$/.exec(text.trim());
  return m ? m[1] : text;
}

// ---------------------------------------------------------------- Gemini Live (WebSocket): áudio PCM16 e mensagens

/** O microfone (na taxa do AudioContext) reduzido para `to` Hz pela média de cada janela (o Gemini ouve 16 kHz). */
export function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  // shortcut: cada bloco arredonda a própria janela (sem levar a fração ao próximo); inaudível na fala.
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += input[j];
    out[i] = b > a ? sum / (b - a) : input[Math.min(a, input.length - 1)];
  }
  return out;
}

/** Float32 (-1..1) → PCM16 little-endian em base64 (o realtimeInput.audio). */
export function pcm16Base64(samples: Float32Array): string {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(view.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** PCM16 little-endian em base64 (a voz do Gemini, 24 kHz) → Float32 (-1..1). */
export function pcm16FromBase64(b64: string): Float32Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Float32Array(bin.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    out[i] = (v >= 0x8000 ? v - 0x10000 : v) / 0x8000;
  }
  return out;
}

export const geminiAudioMessage = (b64: string) => ({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } });
export const geminiToolResponse = (id: string, reply: string) => ({ toolResponse: { functionResponses: [{ id, name: 'ask_jarvis', response: { result: reply } }] } });

/** O que importa de uma BidiGenerateContentServerMessage (várias partes podem vir juntas). */
export interface GeminiEvent {
  setupComplete: boolean;
  /** PCM16 24 kHz em base64. */
  audio: string[];
  /** Pedaços novos da transcrição (entrada e saída), para somar. */
  heard: string;
  said: string;
  interrupted: boolean;
  turnComplete: boolean;
  /** Só ask_jarvis (a única ferramenta que o token deixa). */
  calls: { id: string; texto: string }[];
  cancelled: string[];
}

export function parseGemini(raw: string): GeminiEvent | null {
  type Msg = {
    setupComplete?: unknown;
    serverContent?: { modelTurn?: { parts?: { inlineData?: { data?: unknown; mimeType?: unknown } }[] }; inputTranscription?: { text?: unknown }; outputTranscription?: { text?: unknown }; interrupted?: unknown; turnComplete?: unknown };
    toolCall?: { functionCalls?: { id?: unknown; name?: unknown; args?: { texto?: unknown } }[] };
    toolCallCancellation?: { ids?: unknown[] };
  };
  let m: Msg;
  try {
    m = JSON.parse(raw) as Msg;
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const sc = m.serverContent;
  return {
    setupComplete: m.setupComplete !== undefined,
    audio: (sc?.modelTurn?.parts ?? []).map((p) => (str(p.inlineData?.mimeType).startsWith('audio/') ? str(p.inlineData?.data) : '')).filter(Boolean),
    heard: str(sc?.inputTranscription?.text),
    said: str(sc?.outputTranscription?.text),
    interrupted: sc?.interrupted === true,
    turnComplete: sc?.turnComplete === true,
    calls: (m.toolCall?.functionCalls ?? []).filter((c) => c.name === 'ask_jarvis').map((c) => ({ id: str(c.id), texto: str(c.args?.texto).trim() })),
    cancelled: (m.toolCallCancellation?.ids ?? []).filter((x): x is string => typeof x === 'string'),
  };
}
