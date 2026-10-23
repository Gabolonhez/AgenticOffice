// Mensagens pelo WhatsApp por um WA-AKG (o gateway do próprio dono, numa sessão dele):
//   POST {url}/api/messages/{sessionId}/{jid}/send   x-api-key: <chave>   {"message": {"text": "..."}}
//   → 200 {status: true, message, data}; erro {status: false, message, error} (400/401/403/404/500/503).
// Só para o dono (ownerJid): nunca há parâmetro de destino vindo de agente. Texto mascarado e cortado em WA_TEXT_MAX. A
// chave só vai no cabeçalho (nunca em log nem na página). Falhar ao mandar só vira log/erro devolvido.
import { maskSecrets } from '../../shared/activity';
import { tr } from '../../shared/i18n';
import { errMsg } from '../log';

/** localhost e IPs da rede local (10/8, 172.16/12, 192.168/16, 100.64/10 do Tailscale): os únicos com http. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

export const WA_TEXT_MAX = 3000;
const URL_MAX = 300;

export interface WaSettings {
  /** Base do WA-AKG (sem /api). */
  url: string;
  apiKey: string;
  sessionId: string;
  /** O número do dono (ex.: 5511999999999@s.whatsapp.net): o único destino e o único remetente aceito na caixa de entrada. */
  ownerJid: string;
}

/** "5511999@s.whatsapp.net", "5511999:12@s.whatsapp.net" (aparelho) e "5511999@c.us" são a mesma pessoa. */
export function normJid(jid: string): string {
  const [user, domain = ''] = jid.trim().toLowerCase().split('@');
  const d = domain === 'c.us' ? 's.whatsapp.net' : domain;
  return `${user.split(':')[0]}@${d}`;
}

/** Endereço do WA-AKG: https (http só localhost/rede local), sem login, query nem fragmento; "/api" no fim sai. */
export function validateWaUrl(raw: unknown): { url: string } | { error: string } {
  const bad = { error: tr('Endereço do WA-AKG inválido: use https://... (http só para localhost ou a rede local).') };
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
  if (u.username || u.password || u.search || u.hash) return bad;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalHost(u.hostname))) return bad;
  return { url: u.href.replace(/\/+$/, '').replace(/\/api$/i, '') };
}

/**
 * Valida o bloco `wa` da tela. `apiKey` vazio ou ausente mantém a chave guardada (a página nunca a recebe de volta), mas
 * só para o mesmo endereço: trocar o `url` sem digitar a chave de novo apaga a guardada (senão ela iria para outro
 * servidor). `url` vazio = WhatsApp desligado (undefined).
 */
export function validateWa(raw: unknown, prev?: WaSettings): { wa: WaSettings | undefined } | { error: string } {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const u = validateWaUrl(b.url ?? prev?.url ?? '');
  if ('error' in u) return u;
  if (!u.url) return { wa: undefined };
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const apiKey = str(b.apiKey) || (prev && prev.url === u.url ? prev.apiKey : '');
  const sessionId = b.sessionId === undefined ? (prev?.sessionId ?? '') : str(b.sessionId);
  const ownerJid = b.ownerJid === undefined ? (prev?.ownerJid ?? '') : str(b.ownerJid);
  if (!apiKey || apiKey.length > 200 || /[\s\0]/.test(apiKey)) return { error: tr('Chave do WA-AKG inválida.') };
  if (!/^[\w.-]{1,80}$/.test(sessionId)) return { error: tr('Sessão do WA-AKG inválida (letras, números, ponto, hífen).') };
  if (!/^\d{6,20}(:\d+)?@(s\.whatsapp\.net|c\.us|lid)$/.test(ownerJid)) return { error: tr('Número do dono inválido: use 5511999999999@s.whatsapp.net.') };
  return { wa: { url: u.url, apiKey, sessionId, ownerJid: normJid(ownerJid) } };
}

/** Manda um texto ao dono; devolve o erro (mascarado), ou undefined se o WA-AKG confirmou. */
export async function sendWhatsApp(wa: WaSettings, text: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  const body = maskSecrets(text).trim();
  const message = body.length > WA_TEXT_MAX ? `${body.slice(0, WA_TEXT_MAX - 1)}…` : body;
  if (!message) return undefined;
  try {
    const res = await fetchImpl(`${wa.url}/api/messages/${encodeURIComponent(wa.sessionId)}/${encodeURIComponent(wa.ownerJid)}/send`, {
      method: 'POST',
      headers: { 'x-api-key': wa.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { text: message } }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => ({}))) as { status?: unknown; message?: unknown; error?: unknown };
    if (!res.ok || j.status !== true) return maskSecrets(String(j.error ?? j.message ?? `HTTP ${res.status}`)).slice(0, 300);
    return undefined;
  } catch (err) {
    return maskSecrets(errMsg(err));
  }
}
