// Aviso no celular pelo ntfy (https://ntfy.sh/<tópico> ou um servidor próprio), opcional e global: <dataDir>/notify.json.
// Vai só o título do card e uma frase curta ("aguardando revisão", "plano pronto", "falhou"): nunca código, diff,
// resumo, relatório nem segredo. Falhar ao avisar só vira log; nunca atrapalha o fluxo. Gravar só pelo próprio
// computador (http/app.ts), como a configuração das pastas.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { maskSecrets } from '../../shared/activity';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';

export type NotifyEvent = 'review' | 'ready' | 'failed';

const TITLE_MAX = 100;
const URL_MAX = 300;

/** localhost e IPs da rede local (10/8, 172.16/12, 192.168/16, 100.64/10 do Tailscale): os únicos com http. */
function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

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
  return { title, text: event === 'review' ? tr('aguardando revisão') : event === 'ready' ? tr('plano pronto') : tr('falhou') };
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

/** O endereço guardado em <dataDir>/notify.json (modo 600: quem tem o tópico lê os avisos). */
export class NtfySettings {
  private url = '';

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { ntfyUrl?: unknown };
      const v = validateNtfyUrl(raw?.ntfyUrl);
      if ('url' in v) this.url = v.url;
    } catch {
      // sem arquivo: desligado
    }
  }

  get(): string {
    return this.url;
  }

  /** Valida e grava; devolve o erro, se houver. */
  set(raw: unknown): string | undefined {
    const v = validateNtfyUrl(raw);
    if ('error' in v) return v.error;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify({ ntfyUrl: v.url }), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      return errMsg(err);
    }
    this.url = v.url;
    return undefined;
  }

  /** Avisa, se ligado (sem esperar). */
  notify(cardTitle: string, event: NotifyEvent, fetchImpl?: typeof fetch): void {
    if (!this.url) return;
    const m = ntfyMessage(cardTitle, event);
    void sendNtfy(this.url, m.title, m.text, fetchImpl);
  }
}
