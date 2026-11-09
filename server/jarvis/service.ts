// Jarvis: o orquestrador do Habblaud. É um agente comum do ChatService marcado `system: 'jarvis'` (só o servidor marca),
// na pasta <dataDir>/jarvis, fora do limite de agentes, sem fechar. Roda sem ferramentas internas: age só pelas do MCP
// do escritório (tools.ts), onde as que têm efeito pedem um cartão. O que chega de fora (WhatsApp, VBoards, gatilho)
// entra embrulhado em <dados_nao_confiaveis>; o que a pessoa digita na página, não. Provedor e modelo configuráveis
// (jarvisProviders: só quem roda sem ferramentas internas e com o MCP); trocar de provedor começa conversa nova e mantém
// a memória (MEMORY.md). Caixa de entrada do WhatsApp (JarvisInbox): pelo VBoards, resposta pelo WA-AKG.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { maskSecrets } from '../../shared/activity';
import { CHAT_TEXT_MAX, type ChatFrom } from '../../shared/chat';
import { tr } from '../../shared/i18n';
import type { Provider } from '../../shared/types';
import type { ChatRecord } from '../chat/store';
import type { ChatService, DeliverResult } from '../chat/service';
import { AUDIO_MAX_BYTES } from '../dictation/dictation';
import { createWhisperTranscriber, transcribeTimeoutMs, type Transcript, type WhisperSetup } from '../dictation/whisper';
import { errMsg, log } from '../log';
import type { Attachment } from '../spawn/attachments';
import type { InboxMessage, VBoardsApi } from '../vboards/api';
import { normJid, sendWhatsApp, WA_TEXT_MAX, type WaSettings } from '../vboards/whatsapp';
import { jarvisPrompt, wrapUntrusted } from './prompt';

export const JARVIS_ID = 'chat:jarvis';
export const JARVIS_NAME = 'Jarvis';
/** Quanto da memória entra no prompt; quanto a memória guarda. */
export const MEMORY_PROMPT_MAX = 8 * 1024;
export const MEMORY_MAX = 16 * 1024;
/** Prazo de cada rodada do Jarvis: uma rodada presa não segura a fila (WhatsApp, agendamentos) para sempre. */
export const JARVIS_TURN_MINUTES = 30;

/**
 * De onde veio o pedido do turno: 'ui' = o dono pela página; o resto entra embrulhado e deixa o turno contaminado.
 * 'voice' = a tela cheia por voz: o microfone ouve o ambiente (pode ser outra pessoa falando), então nunca vale como o dono.
 */
export type JarvisOrigin = 'ui' | 'whatsapp' | 'vboards' | 'schedule' | 'agent' | 'voice';
/** O turno atual do Jarvis: a origem e o seq do item do pedido (a mancha de contaminação vale até o próximo pedido). */
export interface JarvisTurn { origin: JarvisOrigin; seq: number }
export interface JarvisSettings { provider: Provider; model?: string }
export const JARVIS_DEFAULT: JarvisSettings = { provider: 'claude', model: 'sonnet' };

const MODEL_RE = /^[\w.:/[\]-]{1,60}$/;

/**
 * Quem pode ser o Jarvis: precisa (a) aceitar as ferramentas do MCP do escritório e (b) rodar sem ferramentas internas
 * de escrita/shell, para que o portão não seja contornado. Claude: `--tools ''` + `--strict-mcp-config`. Codex: fora
 * (teste real, codex-cli 0.154: todos os modelos vêm `tool_mode: code_mode_only` do catálogo, então as ferramentas,
 * inclusive as do MCP, só existem dentro do `exec` em JavaScript do code-mode host; com ele desligado o `exec` falha
 * fechado e o MCP some, e o `apply_patch` aparece mesmo com include_apply_patch_tool=false). O CODEX_HOME isolado
 * (drivers/codex.ts) fica pronto para quando houver um modo sem código. Antigravity: fora.
 */
export function jarvisProviders(available: (p: Provider) => boolean): Array<{ id: Provider; available: boolean; reason?: string }> {
  return [
    { id: 'claude', available: available('claude'), ...(available('claude') ? {} : { reason: tr('{0} não encontrado no PATH', ['claude']) }) },
    {
      id: 'codex',
      available: false,
      reason: tr('O Codex não serve para o Jarvis por enquanto: os modelos dele só usam ferramentas pelo modo de código (JavaScript escrito pelo modelo, com apply_patch junto). Desligado o modo de código, as ferramentas do escritório somem.'),
    },
    {
      id: 'antigravity',
      available: false,
      reason: tr('O Antigravity não serve para o Jarvis: o MCP só entra pela configuração global (agy mcp add), não por rodada, e não há modo sem as ferramentas de shell e de escrita.'),
    },
  ];
}

/** Valida a troca de provedor/modelo do Jarvis; provedor sem suporte (ou fora do PATH) é recusado com o motivo. */
export function validateJarvisSettings(raw: unknown, providers: ReturnType<typeof jarvisProviders>): { settings: JarvisSettings } | { error: string } {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const p = providers.find((x) => x.id === b.provider);
  if (!p) return { error: tr('Provedor inválido.') };
  if (!p.available) return { error: p.reason ?? tr('Provedor inválido.') };
  const model = typeof b.model === 'string' ? b.model.trim() : '';
  if (model && !MODEL_RE.test(model)) return { error: tr('Modelo inválido.') };
  return { settings: { provider: p.id, ...(model ? { model } : {}) } };
}

export const originLabel = (o: JarvisOrigin): string => (o === 'voice' ? tr('voz') : o === 'whatsapp' ? 'WhatsApp' : o === 'vboards' ? 'VBoards' : o === 'schedule' ? tr('agendamento') : o === 'agent' ? tr('outro agente') : tr('página'));

/**
 * O turno atual: a última mensagem da conversa (o `from` do item). 'ui' só para o que a página manda (POST
 * /api/chat/jarvis, `from` 'ui', ou o chat da página, sem `from`); outro agente do chat (office_ask_agent) = 'agent'.
 */
export function turnOf(rec: Pick<ChatRecord, 'items'> | undefined): JarvisTurn {
  const items = rec?.items ?? [];
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind !== 'user') continue;
    const who = it.from?.agentId;
    const origin: JarvisOrigin = who === undefined || who === 'ui' ? 'ui' : who === 'whatsapp' || who === 'vboards' || who === 'schedule' || who === 'voice' ? who : who.startsWith('trigger:') ? 'schedule' : 'agent';
    return { origin, seq: it.seq };
  }
  return { origin: 'ui', seq: 0 };
}

/** De onde veio a última mensagem da conversa: mostrado nos cartões. */
export const originOf = (rec: Pick<ChatRecord, 'items'> | undefined): JarvisOrigin => turnOf(rec).origin;

export interface JarvisDeps {
  chat: Pick<ChatService, 'openSystem' | 'systemAgent' | 'deliver' | 'record' | 'resetSession' | 'post' | 'providers'>;
  dataDir: string;
  settings: () => JarvisSettings;
  /** Retrato curto do escritório para o prompt (hora, agentes, revisões, cartões, cota, último briefing). */
  snapshot?: () => string[];
}

export class JarvisService {
  readonly folder: string;
  private readonly memoryFile: string;

  constructor(private readonly deps: JarvisDeps) {
    this.folder = join(deps.dataDir, 'jarvis');
    this.memoryFile = join(this.folder, 'MEMORY.md');
  }

  id(): string | undefined {
    return this.deps.chat.systemAgent('jarvis');
  }

  /** A configuração gravada, ou o padrão se o provedor dela não pode mais ser o Jarvis (ex.: Codex de antes). */
  private settings(): JarvisSettings {
    const s = this.deps.settings();
    return this.providers().find((p) => p.id === s.provider)?.available ? s : JARVIS_DEFAULT;
  }

  /** O agente existe (cria na primeira vez, sem rodar nada); um Jarvis de provedor que saiu da lista volta ao padrão. */
  ensure(): string {
    const have = this.id();
    if (have) {
      const rec = this.deps.chat.record(have);
      if (rec && !this.providers().find((p) => p.id === rec.provider)?.available) this.reset();
      return have;
    }
    mkdirSync(this.folder, { recursive: true });
    const s = this.settings();
    return this.deps.chat.openSystem({ system: 'jarvis', agentId: JARVIS_ID, folder: this.folder, provider: s.provider, ...(s.model ? { model: s.model } : {}), name: JARVIS_NAME, limits: { maxTurnMinutes: JARVIS_TURN_MINUTES } });
  }

  providers(): ReturnType<typeof jarvisProviders> {
    const list = this.deps.chat.providers();
    return jarvisProviders((p) => !!list.find((x) => x.id === p)?.available);
  }

  /**
   * Uma mensagem para o Jarvis (fila do ChatService). Da página vai como está; de fora, embrulhada como dado não
   * confiável. `ref` = o id na origem (mensagem do WhatsApp, regra do gatilho).
   */
  say(text: string, origin: JarvisOrigin, ref = '', images: Attachment[] = []): { result: Promise<DeliverResult>; cancel: () => void } {
    const id = this.ensure();
    const body = origin === 'ui' ? text : wrapUntrusted(origin, ref, text);
    const from: ChatFrom = { agentId: origin, name: originLabel(origin) };
    // Imagens só da página (o dono): de fora, não entram.
    const d = this.deps.chat.deliver(id, body.slice(0, CHAT_TEXT_MAX), from, { raw: true, ...(origin === 'ui' && images.length ? { images } : {}) });
    return d ?? { result: Promise.resolve({ ok: false, error: tr('Agente não encontrado.') }), cancel: () => {} };
  }

  /** Conversa nova na CLI (a memória fica); com a configuração atual de provedor e modelo. */
  reset(): 'ok' | 'not-found' | 'busy' {
    const id = this.id();
    if (!id) return 'not-found';
    const s = this.settings();
    return this.deps.chat.resetSession(id, { provider: s.provider, model: s.model ?? '' });
  }

  /** Configuração mudou: provedor ou modelo diferente = conversa nova (com a memória). */
  settingsChanged(): 'ok' | 'not-found' | 'busy' | 'same' {
    const rec = this.id() ? this.deps.chat.record(this.id()!) : undefined;
    if (!rec) return 'not-found';
    const s = this.settings();
    if (rec.provider === s.provider && (rec.model ?? '') === (s.model ?? '')) return 'same';
    return this.reset();
  }

  origin(): JarvisOrigin {
    return this.turn().origin;
  }

  turn(): JarvisTurn {
    const id = this.id();
    return turnOf(id ? this.deps.chat.record(id) : undefined);
  }

  originLabel(): string {
    return originLabel(this.origin());
  }

  /** O hook ChatServiceDeps.systemPrompt. */
  systemPrompt(rec: ChatRecord): string | undefined {
    if (rec.system !== 'jarvis') return undefined;
    let snapshot: string[] = [];
    try {
      snapshot = this.deps.snapshot?.() ?? [];
    } catch (err) {
      snapshot = [tr('(retrato indisponível: {0})', [errMsg(err)])];
    }
    return jarvisPrompt({ memory: this.memoryRead().slice(0, MEMORY_PROMPT_MAX), snapshot });
  }

  memoryRead(): string {
    try {
      return readFileSync(this.memoryFile, 'utf8');
    } catch {
      return '';
    }
  }

  /** append/replace na MEMORY.md, mascarada e até MEMORY_MAX; devolve o erro, se houver. */
  memoryWrite(mode: 'append' | 'replace', text: string): string | undefined {
    const clean = maskSecrets(text).trim();
    const next = mode === 'append' ? [this.memoryRead().trimEnd(), clean].filter(Boolean).join('\n') : clean;
    if (Buffer.byteLength(next, 'utf8') > MEMORY_MAX) return tr('A memória passaria de {0} KB: resuma com mode "replace".', [MEMORY_MAX / 1024]);
    try {
      mkdirSync(this.folder, { recursive: true });
      writeFileSync(`${this.memoryFile}.tmp`, `${next}\n`);
      renameSync(`${this.memoryFile}.tmp`, this.memoryFile);
    } catch (err) {
      log.warnOnce(`jarvis:memory:${errMsg(err)}`, tr('Jarvis: não deu para gravar a memória ({0}).', [errMsg(err)]));
      return errMsg(err);
    }
    return undefined;
  }
}

/** Caixa de entrada do WhatsApp: busca a cada INBOX_POLL_MS; depois de erro, o dobro até INBOX_MAX_MS. */
export const INBOX_POLL_MS = 15_000;
export const INBOX_MAX_MS = 5 * 60_000;
/** Mensagem que já esperava há mais que isto quando o servidor subiu: descartada (com ack), sem rodada. */
export const INBOX_STALE_MS = 10 * 60_000;
/** Respostas recentes do Jarvis guardadas para a trava de eco (a própria resposta voltando pela caixa). */
const RECENT_REPLIES = 20;

export interface JarvisInboxDeps {
  api: Pick<VBoardsApi, 'enabled' | 'inbox' | 'ack'> & Partial<Pick<VBoardsApi, 'inboxAudio'>>;
  /** Whisper local (findWhisper): sem ele (ou com `missing`), áudio recebe a explicação do que falta. */
  whisper?: () => WhisperSetup | { missing: string };
  /** Transcreve com o prazo proporcional ao tamanho (padrão: createWhisperTranscriber); o áudio nunca sai desta máquina. */
  transcribe?: (setup: WhisperSetup, audio: Buffer, mime: string) => Promise<Transcript>;
  /** WhatsApp do dono (ntfy.ts NotifySettings.wa): sem ele, a caixa não é lida. */
  wa: () => WaSettings | undefined;
  say: JarvisService['say'];
  send?: (wa: WaSettings, text: string) => Promise<string | undefined>;
  now?: () => number;
  startedAt?: number;
}

/**
 * Mensagens "Jarvis ..." do dono no WhatsApp, pelo VBoards (GET /api/v1/jarvis/inbox). Cada uma: confere o remetente
 * (só o ownerJid), entra na fila do Jarvis como dado não confiável, a resposta vai ao dono pelo WA-AKG e só então o
 * ack (com a resposta guardada no VBoards). Ids já vistos ficam na memória (sem rodar duas vezes a mesma).
 */
export class JarvisInbox {
  private readonly seen = new Set<string>();
  private readonly replies: string[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private delay = INBOX_POLL_MS;
  private readonly now: () => number;
  private readonly startedAt: number;
  private stopped = false;

  constructor(private readonly deps: JarvisInboxDeps) {
    this.now = deps.now ?? Date.now;
    this.startedAt = deps.startedAt ?? this.now();
  }

  start(): void {
    this.stopped = false;
    this.schedule(INBOX_POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** Uma busca; as mensagens novas rodam em segundo plano (a próxima busca não espera a rodada). */
  async poll(): Promise<Array<Promise<void>>> {
    const wa = this.deps.wa();
    if (!wa || !this.deps.api.enabled) return [];
    const jobs: Array<Promise<void>> = [];
    try {
      for (const m of await this.deps.api.inbox()) {
        if (this.seen.has(m.id)) continue;
        this.seen.add(m.id);
        if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
        jobs.push(this.handle(m, wa));
      }
      this.delay = INBOX_POLL_MS;
    } catch (err) {
      log.warnOnce(`jarvis:inbox:${errMsg(err)}`, tr('Jarvis: falha ao ler a caixa do WhatsApp ({0}).', [errMsg(err)]));
      this.delay = Math.min(this.delay * 2, INBOX_MAX_MS);
    }
    return jobs;
  }

  private async handle(m: InboxMessage, wa: WaSettings): Promise<void> {
    const send = this.deps.send ?? ((w: WaSettings, t: string) => sendWhatsApp(w, t));
    const ack = (reply?: string) => this.deps.api.ack(m.id, reply).then(() => undefined, (err) => log.warnOnce(`jarvis:ack:${errMsg(err)}`, tr('Jarvis: o ack da mensagem falhou ({0}).', [errMsg(err)])));
    // Só o dono, e só na conversa dele consigo mesmo (não num grupo nem na conversa com outra pessoa).
    if (normJid(m.senderJid) !== normJid(wa.ownerJid) || normJid(m.chatJid) !== normJid(wa.ownerJid)) return ack();
    // Trava de eco: a resposta do próprio Jarvis voltando pela caixa não vira outra rodada.
    if (this.replies.includes(m.text.trim())) return ack();
    if (m.receivedAt && m.receivedAt < this.startedAt && this.now() - m.receivedAt > INBOX_STALE_MS) {
      const note = tr('Mensagem descartada após reinício do Habblaud: mande de novo se ainda vale.');
      await send(wa, note);
      return ack(note);
    }
    let text = m.text;
    let heard = '';
    if (m.audio) {
      const t = await this.transcribe(m);
      if ('error' in t) return this.answer(wa, t.error, send, ack);
      text = t.text;
      heard = `${tr('Entendi: «{0}»', [t.text])}\n\n`;
    }
    const r = await this.deps.say(text, 'whatsapp', m.id).result;
    await this.answer(wa, heard + (r.ok ? r.reply || tr('(sem resposta)') : tr('Não consegui responder: {0}', [r.error])), send, ack);
  }

  /** Áudio do dono → texto, só no Whisper local; `error` é a resposta pronta para o dono. */
  private async transcribe(m: InboxMessage): Promise<{ text: string } | { error: string }> {
    if (m.audio!.bytes > AUDIO_MAX_BYTES) return { error: tr('Áudio grande demais ({0} MB; o limite é {1} MB). Mande um mais curto.', [Math.round(m.audio!.bytes / 1048576), AUDIO_MAX_BYTES / 1048576]) };
    const setup = this.deps.whisper?.();
    if (!setup || 'missing' in setup) return { error: tr('Recebi o seu áudio, mas não consigo transcrever: falta {0}. Instale e mande de novo; enquanto isso, escreva a mensagem.', [setup && 'missing' in setup ? setup.missing : 'whisper.cpp']) };
    try {
      const audio = await this.deps.api.inboxAudio!(m.id, AUDIO_MAX_BYTES);
      const transcribe = this.deps.transcribe ?? ((s, a, mime) => createWhisperTranscriber(s, transcribeTimeoutMs(a.length))(a, mime));
      const text = (await transcribe(setup, audio, m.audio!.mime)).text.trim();
      return text ? { text } : { error: tr('Não entendi nada no áudio. Mande de novo ou escreva.') };
    } catch (err) {
      return { error: tr('Não consegui transcrever o áudio: {0}', [errMsg(err)]) };
    }
  }

  private async answer(wa: WaSettings, raw: string, send: (w: WaSettings, t: string) => Promise<string | undefined>, ack: (reply?: string) => Promise<void>): Promise<void> {
    const reply = maskSecrets(raw).slice(0, WA_TEXT_MAX);
    this.replies.push(reply.trim());
    if (this.replies.length > RECENT_REPLIES) this.replies.shift();
    const err = await send(wa, reply);
    if (err) log.warnOnce(`jarvis:wa:${err}`, tr('Jarvis: a resposta pelo WhatsApp falhou ({0}).', [err]));
    await ack(reply);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.poll().finally(() => this.schedule(this.delay));
    }, ms);
    this.timer.unref?.();
  }
}
