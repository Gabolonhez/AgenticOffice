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
export function pickVoice<V extends { lang: string; localService?: boolean }>(voices: readonly V[], lang: string): V | undefined {
  const norm = (s: string) => s.replace('_', '-').toLowerCase();
  const want = norm(lang);
  const fam = want.split('-')[0];
  const rank = (v: V) => (norm(v.lang) === want ? 0 : norm(v.lang).split('-')[0] === fam ? 2 : 9) + (v.localService ? 0 : 1);
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

/** O pedido de fora chega embrulhado em <dados_nao_confiaveis …>: na tela, só o texto. */
function stripUntrusted(text: string): string {
  const m = /^<dados_nao_confiaveis[^>]*>\n?([\s\S]*?)\n?<\/dados_nao_confiaveis>$/.exec(text.trim());
  return m ? m[1] : text;
}
