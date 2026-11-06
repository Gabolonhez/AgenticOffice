// Aviso no celular pelo ntfy (https://ntfy.sh/<tópico> ou um servidor próprio), opcional e global: <dataDir>/notify.json.
// Vai só o título do card e uma frase curta ("aguardando revisão", "plano pronto", "falhou"): nunca código, diff,
// resumo, relatório nem segredo. Falhar ao avisar só vira log; nunca atrapalha o fluxo. Gravar só pelo próprio
// computador (http/app.ts), como a configuração das pastas. Os mesmos avisos podem ir pelo WhatsApp (whatsapp.ts),
// conforme o canal escolhido (NotifySettings).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { maskSecrets } from '../../shared/activity';
import { tr } from '../../shared/i18n';
import type { Provider } from '../../shared/types';
import { JARVIS_DEFAULT, type JarvisSettings } from '../jarvis/service';
import { errMsg, log } from '../log';
import { isLocalHost, sendWhatsApp, validateWa, type WaSettings } from './whatsapp';

/**
 * 'quota': uma lista pausou pela cota da conta (chat/runs.ts); o título é o nome da pasta. 'pr', 'ci_failed', 'no_ci' e
 * 'deployed': o "Subir" (chat/ship.ts), com o nome da pasta.
 */
export type NotifyEvent = 'review' | 'ready' | 'failed' | 'quota' | 'pr' | 'ci_failed' | 'no_ci' | 'deployed' | 'store_pin' | 'store_ok' | 'store_failed';

const EVENT_TEXT: Record<NotifyEvent, () => string> = {
  review: () => tr('aguardando revisão'),
  ready: () => tr('plano pronto'),
  quota: () => tr('lista pausada: cota da conta no limite'),
  failed: () => tr('falhou'),
  pr: () => tr('PR aberto'),
  ci_failed: () => tr('CI do PR falhou'),
  no_ci: () => tr('repo sem CI de PR: o merge espera a sua aprovação com PIN'),
  deployed: () => tr('no ar (deployed)'),
  store_pin: () => tr('loja: espera a sua aprovação com PIN'),
  store_ok: () => tr('loja: etapa concluída'),
  store_failed: () => tr('loja: etapa falhou'),
};

const TITLE_MAX = 100;
const URL_MAX = 300;


/** Endereço do tópico: https (http só para localhost/rede local), com tópico, sem login, query nem fragmento. Vazio = desligado. */
export function validateNtfyUrl(raw: unknown): { url: string } | { error: string } {
  const bad = { error: tr('Endereço do ntfy inválido: use https://ntfy.sh/<tópico> (http só para localhost ou a rede local).') };
  if (typeof raw !== 'string') return bad;
  const s = raw.trim();
  if (!s) return { url: '' };
  if (s.length > URL_MAX || /[\s\0]/.test(s)) return bad;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return bad;
  }
  if (u.username || u.password || u.search || u.hash || !/^\/[^/]+/.test(u.pathname)) return bad;
  if (u.protocol === 'https:' || (u.protocol === 'http:' && isLocalHost(u.hostname))) return { url: u.href.replace(/\/+$/, '') };
  return bad;
}

/** Título (o card, mascarado e cortado) e a frase do evento. */
export function ntfyMessage(cardTitle: string, event: NotifyEvent): { title: string; text: string } {
  const t = maskSecrets(cardTitle).replace(/\s+/g, ' ').trim() || tr('(card sem título)');
  const title = t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
  return { title, text: EVENT_TEXT[event]() };
}

/** POST no tópico; o título vai como RFC 2047 (o fetch não aceita cabeçalho fora do latin1). Erro só vira log. */
export async function sendNtfy(url: string, title: string, text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: `=?UTF-8?B?${Buffer.from(title, 'utf8').toString('base64')}?=` },
      body: text,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    log.warnOnce(`ntfy:${errMsg(err)}`, tr('Aviso no celular (ntfy) falhou ({0}).', [errMsg(err)]));
  }
}

/** Por onde vão os avisos: ntfy, WhatsApp (WA-AKG) ou os dois. */
export type NotifyChannel = 'ntfy' | 'whatsapp' | 'both';
/** Briefing do Jarvis (server/jarvis/briefing.ts): HH:MM local nos dias (0 = domingo; vazio = todos). Sem hora = desligado. */
export interface BriefingSettings { time: string; days: number[] }
/** Texto livre (notify_send do Jarvis, manchete do briefing) no ntfy: mascarado e cortado. */
export const NTFY_FREE_MAX = 200;

/** As rotinas do Jarvis com horário (jarvis/briefing.ts ReportKind): briefing, fechamento do dia e semanal; desligadas por padrão. */
export const ROUTINES = ['briefing', 'closing', 'weekly'] as const;
export type Routine = (typeof ROUTINES)[number];
const OFF: BriefingSettings = { time: '', days: [] };

interface Stored extends Record<Routine, BriefingSettings> {
  ntfyUrl: string;
  channel: NotifyChannel;
  wa?: WaSettings;
  jarvis: JarvisSettings;
  /** Triagem automática das ideias novas (vboards/triage.ts) a cada 2 min: desligada por padrão. */
  triage?: boolean;
}

const CHANNELS: readonly NotifyChannel[] = ['ntfy', 'whatsapp', 'both'];
const JARVIS_PROVIDERS: readonly Provider[] = ['claude', 'codex'];

function parseBriefing(raw: unknown): BriefingSettings | undefined {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const time = typeof b.time === 'string' ? b.time.trim() : '';
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return undefined;
  const days = Array.isArray(b.days) ? b.days : [];
  if (!days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return undefined;
  return { time, days: [...new Set(days as number[])].sort() };
}

function parseJarvis(raw: unknown): JarvisSettings {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!JARVIS_PROVIDERS.includes(b.provider as Provider)) return { ...JARVIS_DEFAULT };
  const model = typeof b.model === 'string' && /^[\w.:/[\]-]{1,60}$/.test(b.model) ? b.model : undefined;
  return { provider: b.provider as Provider, ...(model ? { model } : {}) };
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Avisos ao dono e a configuração deles, em <dataDir>/notify.json (modo 600: tem o tópico e a chave do WA-AKG): o
 * tópico do ntfy, o WhatsApp (WA-AKG), o canal, o horário do briefing e o provedor do Jarvis. Gravar só pelo próprio
 * computador (http/app.ts e server/jarvis/http.ts); a página remota vê só "ligado"; a chave nunca sai.
 */
export class NotifySettings {
  private s: Stored = { ntfyUrl: '', channel: 'ntfy', briefing: OFF, closing: OFF, weekly: OFF, jarvis: { ...JARVIS_DEFAULT } };

  constructor(
    private readonly file: string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      const u = validateNtfyUrl(raw?.ntfyUrl);
      const wa = validateWa(raw?.wa);
      this.s = {
        ntfyUrl: 'url' in u ? u.url : '',
        channel: CHANNELS.includes(raw?.channel as NotifyChannel) ? (raw.channel as NotifyChannel) : 'ntfy',
        ...('wa' in wa && wa.wa ? { wa: wa.wa } : {}),
        briefing: parseBriefing(raw?.briefing) ?? OFF,
        closing: parseBriefing(raw?.closing) ?? OFF,
        weekly: parseBriefing(raw?.weekly) ?? OFF,
        jarvis: parseJarvis(raw?.jarvis),
        ...(raw?.triage === true ? { triage: true } : {}),
      };
    } catch {
      // sem arquivo: tudo desligado, Jarvis no padrão
    }
  }

  /** O tópico do ntfy ('' = desligado). */
  get(): string {
    return this.s.ntfyUrl;
  }

  wa(): WaSettings | undefined {
    return this.s.wa;
  }

  channel(): NotifyChannel {
    return this.s.channel;
  }

  /** Horário de uma rotina (padrão: o briefing da manhã). */
  briefing(kind: Routine = 'briefing'): BriefingSettings {
    return this.s[kind];
  }

  jarvis(): JarvisSettings {
    return this.s.jarvis;
  }

  /** A triagem automática das ideias novas está ligada (Configurações)? */
  triage(): boolean {
    return this.s.triage === true;
  }

  /** Só o tópico do ntfy (compatível com a tela antiga). */
  set(raw: unknown): string | undefined {
    return this.update({ url: raw });
  }

  setJarvis(j: JarvisSettings): string | undefined {
    return this.write({ ...this.s, jarvis: parseJarvis(j) });
  }

  /** O que a tela manda (só as chaves presentes): url, channel, wa {url, apiKey, sessionId, ownerJid}, briefing {time, days}. */
  update(raw: unknown): string | undefined {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const next: Stored = { ...this.s };
    if (b.url !== undefined) {
      const u = validateNtfyUrl(b.url);
      if ('error' in u) return u.error;
      next.ntfyUrl = u.url;
    }
    if (b.channel !== undefined) {
      if (!CHANNELS.includes(b.channel as NotifyChannel)) return tr('Canal de aviso inválido.');
      next.channel = b.channel as NotifyChannel;
    }
    if (b.wa !== undefined) {
      const w = validateWa(b.wa, this.s.wa);
      if ('error' in w) return w.error;
      if (w.wa) next.wa = w.wa;
      else delete next.wa;
    }
    if (b.triage !== undefined) {
      if (typeof b.triage !== 'boolean') return tr('Triagem automática: use verdadeiro ou falso.');
      if (b.triage) next.triage = true;
      else delete next.triage;
    }
    for (const k of ROUTINES) {
      if (b[k] === undefined) continue;
      const br = parseBriefing(b[k]);
      if (!br) return tr('Horário do briefing inválido (use HH:MM e dias de 0 a 6).');
      next[k] = br;
    }
    return this.write(next);
  }

  /** Para a página: a remota (editable=false) vê só se está ligado; a chave do WA-AKG nunca sai. */
  view(editable: boolean): Record<string, unknown> {
    const { ntfyUrl, wa } = this.s;
    return {
      configured: !!ntfyUrl,
      waConfigured: !!wa,
      channel: this.s.channel,
      briefing: this.s.briefing,
      closing: this.s.closing,
      weekly: this.s.weekly,
      triage: this.triage(),
      ...(editable ? { url: ntfyUrl, wa: wa ? { url: wa.url, sessionId: wa.sessionId, ownerJid: wa.ownerJid, apiKeySet: true } : null } : {}),
      editable,
    };
  }

  private wantsNtfy(): boolean {
    return !!this.s.ntfyUrl && this.s.channel !== 'whatsapp';
  }

  private wantsWa(): boolean {
    return !!this.s.wa && this.s.channel !== 'ntfy';
  }

  /** Aviso de um card (review, plano pronto, falha, cota) pelo canal escolhido, sem esperar. */
  notify(cardTitle: string, event: NotifyEvent, fetchImpl: typeof fetch = this.fetchImpl): void {
    const m = ntfyMessage(cardTitle, event);
    if (this.wantsNtfy()) void sendNtfy(this.s.ntfyUrl, m.title, m.text, fetchImpl);
    const wa = this.s.wa;
    if (wa && this.wantsWa()) void sendWhatsApp(wa, `${m.title}: ${m.text}`, fetchImpl).then((err) => err && log.warnOnce(`wa:${err}`, tr('Aviso pelo WhatsApp falhou ({0}).', [err])));
  }

  /**
   * Texto livre para o dono (notify_send do Jarvis, briefing): no ntfy só `headline` (ou o texto) mascarado até
   * NTFY_FREE_MAX; no WhatsApp o texto inteiro (até WA_TEXT_MAX). `channel` restringe; o destino é sempre o do dono.
   */
  async sendText(text: string, o: { title?: string; headline?: string; channel?: NotifyChannel } = {}, fetchImpl: typeof fetch = this.fetchImpl): Promise<{ ntfy?: boolean; whatsapp?: boolean; error?: string }> {
    const want = o.channel ?? 'both';
    const out: { ntfy?: boolean; whatsapp?: boolean; error?: string } = {};
    if (want !== 'whatsapp' && this.wantsNtfy()) {
      const body = cut(maskSecrets(o.headline ?? text).replace(/\s+/g, ' ').trim(), NTFY_FREE_MAX);
      await sendNtfy(this.s.ntfyUrl, o.title ?? 'Jarvis', body, fetchImpl);
      out.ntfy = true;
    }
    const wa = this.s.wa;
    if (want !== 'ntfy' && wa && this.wantsWa()) {
      const err = await sendWhatsApp(wa, text, fetchImpl);
      out.whatsapp = !err;
      if (err) out.error = err;
    }
    return out;
  }

  private write(next: Stored): string | undefined {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const { ntfyUrl, channel, wa, jarvis, triage } = next;
      // Só o que difere do padrão: um notify.json antigo (só o tópico) continua igual.
      const out = {
        ntfyUrl,
        ...(channel !== 'ntfy' ? { channel } : {}),
        ...(wa ? { wa } : {}),
        ...Object.fromEntries(ROUTINES.filter((k) => next[k].time || next[k].days.length).map((k) => [k, next[k]])),
        ...(jarvis.provider !== JARVIS_DEFAULT.provider || jarvis.model !== JARVIS_DEFAULT.model ? { jarvis } : {}),
        ...(triage ? { triage: true } : {}),
      };
      writeFileSync(`${this.file}.tmp`, JSON.stringify(out), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      return errMsg(err);
    }
    this.s = next;
    return undefined;
  }
}
