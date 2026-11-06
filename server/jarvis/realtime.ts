// Voz em tempo real do Jarvis: o formato de cada provedor isolado aqui (o resto do servidor só vê RealtimeSession).
// O servidor guarda a chave e emite um token efêmero; o navegador abre a conversa direto com o provedor (WebRTC) com
// esse token e nunca vê a chave. O modelo de voz tem UMA ferramenta, ask_jarvis(texto): ele não chama as do Jarvis.
// OpenAI: POST /v1/realtime/client_secrets → { value: "ek_…", expires_at (s) }; o navegador faz o POST do SDP em
// /v1/realtime/calls com o token. Gemini Live: o tipo e a escolha existem, a emissão ainda não (devolve o motivo).
import { tr } from '../../shared/i18n';

export type RealtimeProvider = 'openai' | 'gemini';
export const REALTIME_PROVIDERS: readonly RealtimeProvider[] = ['openai', 'gemini'];
export const OPENAI_REALTIME_MODEL = 'gpt-realtime';
export const OPENAI_REALTIME_VOICE = 'marin';
const OPENAI_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const OPENAI_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
/** Validade do token efêmero: só precisa durar até o navegador abrir a conversa. */
export const TOKEN_TTL_S = 120;

/** O que o navegador recebe: o token efêmero e onde abrir a conversa (nunca a chave). */
export interface RealtimeSession {
  provider: RealtimeProvider;
  token: string;
  /** ms desde 1970. */
  expiresAt: number;
  model: string;
  callUrl: string;
}

export interface MintOptions {
  key: string;
  model?: string;
  voice?: string;
  /** 'pt' | 'en' | 'es' | 'fr': a língua da conversa (a da página). */
  lang: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const LANG_NAME: Record<string, string> = { pt: 'Brazilian Portuguese', en: 'English', es: 'Spanish', fr: 'French' };

export const ASK_JARVIS_TOOL = {
  type: 'function',
  name: 'ask_jarvis',
  description: "Send the user's request to Jarvis, the office orchestrator, and get his answer. Use it for anything about the office, agents, projects, tasks or actions.",
  parameters: { type: 'object', properties: { texto: { type: 'string', description: "The user's request, in their words" } }, required: ['texto'] },
} as const;

/** Instruções do modelo de voz: ele é só a voz; quem decide é o Jarvis (e os cartões). */
export function voiceInstructions(lang: string): string {
  return [
    `You are the voice of Jarvis, the orchestrator of the Habblaud office. Speak ${LANG_NAME[lang] ?? 'English'}, short and natural.`,
    'You cannot act by yourself. For anything about the office, agents, projects, tasks or actions, call ask_jarvis with what the user asked and then say the answer faithfully, shortened for speech.',
    'Never invent results. If Jarvis says an approval card is waiting, tell the user to approve it on screen.',
    'Never ask for, repeat or pass on a PIN, password or code. If the user says one, do not call ask_jarvis with it: tell them the PIN is always typed on the approval card.',
  ].join('\n');
}

/** Corpo do POST /v1/realtime/client_secrets (formato GA, `session.type: realtime`). */
export function openaiSecretBody(o: Pick<MintOptions, 'model' | 'voice' | 'lang'>): Record<string, unknown> {
  return {
    expires_after: { anchor: 'created_at', seconds: TOKEN_TTL_S },
    session: {
      type: 'realtime',
      model: o.model || OPENAI_REALTIME_MODEL,
      instructions: voiceInstructions(o.lang),
      tools: [ASK_JARVIS_TOOL],
      tool_choice: 'auto',
      audio: {
        input: { transcription: { model: 'gpt-4o-mini-transcribe', language: o.lang }, turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true } },
        output: { voice: o.voice || OPENAI_REALTIME_VOICE },
      },
    },
  };
}

/** Emite o token efêmero no provedor. Erros voltam como texto curto (nunca com a chave). */
export async function mintRealtime(provider: RealtimeProvider, o: MintOptions): Promise<RealtimeSession | { error: string }> {
  if (provider === 'gemini') return { error: tr('Gemini Live ainda não está pronto: use OpenAI Realtime ou outro motor de voz.') };
  const f = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(OPENAI_SECRETS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(openaiSecretBody(o)),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { error: tr('A OpenAI não respondeu.') };
  }
  const body = (await res.json().catch(() => ({}))) as { value?: unknown; expires_at?: unknown; session?: { model?: unknown }; error?: { message?: unknown } };
  if (!res.ok) return { error: tr('A OpenAI recusou o token ({0}): {1}', [res.status, String(body.error?.message ?? '').slice(0, 200)]) };
  if (typeof body.value !== 'string' || !body.value) return { error: tr('Resposta da OpenAI sem token.') };
  const now = (o.now ?? Date.now)();
  return {
    provider,
    token: body.value,
    expiresAt: typeof body.expires_at === 'number' ? body.expires_at * 1000 : now + TOKEN_TTL_S * 1000,
    model: typeof body.session?.model === 'string' ? body.session.model : o.model || OPENAI_REALTIME_MODEL,
    callUrl: OPENAI_CALLS_URL,
  };
}
