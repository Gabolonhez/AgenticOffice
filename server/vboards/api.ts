// Cliente da API v1 do VBoards (as ferramentas vboards_* do Jarvis e a caixa de entrada do WhatsApp). Usa a mesma
// configuração da ponte (loadVBoardsConfig, vboards.ts) com um token `vb_...` (Authorization: Bearer); o token antigo
// não serve aqui. Erros chegam como {error} com 400/401/403/404/409/500; o 403 diz o escopo que falta ("missing scope
// X") e o 401 é token expirado ou inválido: viram uma frase clara, nunca uma nova tentativa. O token só vai no cabeçalho.
import { maskSecrets } from '../../shared/activity';
import { tr } from '../../shared/i18n';
import type { VBoardsConfig } from './vboards';

const REQUEST_TIMEOUT_MS = 10_000;

export const TASK_STATUSES = ['ideas', 'backlog', 'in_progress', 'code_review', 'done', 'deployed'] as const;
export const CARD_STATUSES = ['todo', 'doing', 'done'] as const;
export const SCHEDULE_SCOPES = ['month', 'week', 'day'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** `audio`: a mensagem é um áudio (a transcrição é do Habblaud, local; o texto pode vir vazio). VBoards antigo: campo ausente = só texto. */
export interface InboxMessage { id: string; chatJid: string; senderJid: string; text: string; receivedAt: number; audio?: { mime: string; bytes: number } }

/** Erro da API com a frase para quem lê (o Jarvis, a página). */
export class VBoardsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A frase de um erro da API v1: escopo que falta (403), token expirado/inválido (401), ou o {error} mascarado. */
export function apiErrorText(status: number, error: unknown): string {
  const raw = maskSecrets(typeof error === 'string' ? error : '').slice(0, 300);
  const scope = /missing scope\s+([\w:-]+)/i.exec(raw)?.[1];
  if (status === 403 && scope) return tr('O token do VBoards precisa do escopo {0}.', [scope]);
  if (status === 401) return tr('Token do VBoards expirado ou inválido.');
  if (status === 404) return tr('Não encontrado no VBoards.');
  return raw ? tr('VBoards respondeu {0}: {1}', [status, raw]) : tr('VBoards respondeu {0}.', [status]);
}

/** `vb_...` é o token da API v1 (com escopos); o resto é o segredo antigo da ponte. */
export const isV1Token = (token: string): boolean => token.startsWith('vb_');

export class VBoardsApi {
  constructor(
    private readonly config: Pick<VBoardsConfig, 'base' | 'token'>,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  /** A API v1 só vale com um token vb_. */
  get enabled(): boolean {
    return isV1Token(this.config.token);
  }

  me() {
    return this.call<{ email: string; members: unknown[]; organizations: unknown[] }>('GET', '/me');
  }
  projects() {
    return this.call<{ projects: unknown[] }>('GET', '/projects');
  }
  tasks(q: { projectId?: string; status?: string } = {}) {
    return this.call<{ tasks: unknown[] }>('GET', `/tasks${query(q)}`);
  }
  createTask(body: Record<string, unknown>) {
    return this.call<{ task: unknown }>('POST', '/tasks', body);
  }
  updateTask(id: string, body: Record<string, unknown>) {
    return this.call<{ task: unknown }>('PATCH', `/tasks/${encodeURIComponent(id)}`, body);
  }
  schedule(q: { date?: string; scope?: string } = {}) {
    return this.call<{ cards: unknown[] }>('GET', `/schedule${query(q)}`);
  }
  createCard(body: Record<string, unknown>) {
    return this.call<{ card: unknown }>('POST', '/schedule', body);
  }
  updateCard(id: string, body: Record<string, unknown>) {
    return this.call<{ card: unknown }>('PATCH', `/schedule/${encodeURIComponent(id)}`, body);
  }
  addSubtasks(id: string, texts: string[], queue?: boolean) {
    return this.call<{ card: unknown; subtaskIds: string[] }>('POST', `/schedule/${encodeURIComponent(id)}/subtasks`, { texts, ...(queue === undefined ? {} : { queue }) });
  }
  refine(id: string) {
    return this.call<{ card: unknown }>('POST', `/schedule/${encodeURIComponent(id)}/refine`, {});
  }
  approve(id: string) {
    return this.call<{ card: unknown; queuedSubtaskIds: string[] }>('POST', `/schedule/${encodeURIComponent(id)}/approve`, {});
  }
  summary(date?: string) {
    return this.call<Record<string, unknown>>('GET', `/summary${query({ date })}`);
  }

  /** Mensagens do dono para o Jarvis, ainda sem ack (mais antiga primeiro, até 20). */
  async inbox(): Promise<InboxMessage[]> {
    const r = await this.call<{ messages?: unknown }>('GET', '/jarvis/inbox');
    const list = Array.isArray(r.messages) ? r.messages : [];
    return list.flatMap((x) => {
      const m = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
      const at = typeof m.receivedAt === 'number' ? m.receivedAt : Date.parse(String(m.receivedAt ?? ''));
      const a = (m.audio && typeof m.audio === 'object' ? m.audio : undefined) as Record<string, unknown> | undefined;
      const audio = a && typeof a.mime === 'string' && typeof a.bytes === 'number' && a.bytes >= 0 ? { mime: a.mime.slice(0, 100), bytes: a.bytes } : undefined;
      if (typeof m.id !== 'string' || !m.id || (typeof m.text !== 'string' && !audio)) return [];
      return [{ id: m.id, chatJid: String(m.chatJid ?? ''), senderJid: String(m.senderJid ?? ''), text: typeof m.text === 'string' ? m.text : '', receivedAt: Number.isFinite(at) ? at : 0, ...(audio ? { audio } : {}) }];
    });
  }

  /** Marca como lida; `reply` fica guardada no VBoards (quem manda ao WhatsApp é o Habblaud). */
  ack(id: string, reply?: string) {
    return this.call<{ ok: boolean }>('POST', `/jarvis/inbox/${encodeURIComponent(id)}/ack`, reply ? { reply: reply.slice(0, 3000) } : {});
  }

  /** O áudio de uma mensagem da caixa (GET /jarvis/inbox/:id/audio, bytes crus); `max` corta antes de estourar a memória. */
  async inboxAudio(id: string, max: number): Promise<Buffer> {
    if (!this.enabled) throw new VBoardsApiError(0, tr('A API do VBoards precisa de um token vb_ (git config --global vboards.token ou HABBLAUD_VBOARDS_TOKEN).'));
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.base}/api/v1/jarvis/inbox/${encodeURIComponent(id)}/audio`, { headers: { Authorization: `Bearer ${this.config.token}` }, signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      throw new VBoardsApiError(0, tr('VBoards fora do ar ({0}).', [maskSecrets(err instanceof Error ? err.message : String(err))]));
    }
    if (!res.ok) throw new VBoardsApiError(res.status, apiErrorText(res.status, ((await res.json().catch(() => ({}))) as Record<string, unknown>).error));
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > max) throw new VBoardsApiError(413, tr('áudio grande demais'));
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw new VBoardsApiError(413, tr('áudio grande demais'));
    return buf;
  }

  private async call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
    if (!this.enabled) throw new VBoardsApiError(0, tr('A API do VBoards precisa de um token vb_ (git config --global vboards.token ou HABBLAUD_VBOARDS_TOKEN).'));
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.base}/api/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.config.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new VBoardsApiError(0, tr('VBoards fora do ar ({0}).', [maskSecrets(err instanceof Error ? err.message : String(err))]));
    }
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new VBoardsApiError(res.status, apiErrorText(res.status, j.error));
    return j as T;
  }
}

function query(q: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}
