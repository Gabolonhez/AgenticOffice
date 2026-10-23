// Rotas do Jarvis (/api/chat/jarvis*), chamadas por server/chat/http.ts depois da trava do chat (pelo próprio computador,
// ou pela porta do celular com "chat" em HABBLAUD_REMOTE_ALLOW). Trocar provedor/modelo grava no notify.json: só pelo
// próprio computador.
//   GET  /api/chat/jarvis           → {agentId, provider, model, providers}
//   POST /api/chat/jarvis {text}    → a mensagem entra na fila do Jarvis (origem: página)
//   POST /api/chat/jarvis/reset     → conversa nova na CLI (a memória fica)
//   POST /api/chat/jarvis/briefing  → o briefing agora
//   GET  /api/chat/jarvis/settings  → {provider, model, providers, editable} (sem criar o agente)
//   POST /api/chat/jarvis/settings {provider, model} → troca (conversa nova se mudou)
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CHAT_TEXT_MAX } from '../../shared/chat';
import { tr } from '../../shared/i18n';
import { readJson, sendJson } from '../http/app';
import { validateJarvisSettings, type JarvisService, type JarvisSettings } from './service';

export interface JarvisRouteDeps {
  jarvis: Pick<JarvisService, 'ensure' | 'say' | 'reset' | 'providers' | 'settingsChanged'>;
  settings: () => JarvisSettings;
  saveSettings: (s: JarvisSettings) => string | undefined;
  briefing?: { run(): Promise<unknown> };
}

export function createJarvisRoutes(d: JarvisRouteDeps): (req: IncomingMessage, res: ServerResponse, url: URL, isRemote: boolean) => Promise<boolean> {
  const notAllowed = (res: ServerResponse, allow: string) => {
    res.setHeader('Allow', allow);
    sendJson(res, 405, { error: tr('método não permitido') });
    return true;
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    sendJson(res, status, body);
    return true;
  };
  const view = () => ({ agentId: d.jarvis.ensure(), ...d.settings(), providers: d.jarvis.providers() });

  return async (req, res, url, isRemote) => {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (path === '/api/chat/jarvis') {
      if (method === 'GET') return json(res, 200, view());
      if (method !== 'POST') return notAllowed(res, 'GET, POST');
      const body = (await readJson(req)) as { text?: unknown } | null;
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > CHAT_TEXT_MAX) return json(res, 400, { error: tr('Escreva a mensagem (até {0} caracteres).', [CHAT_TEXT_MAX]) });
      d.jarvis.say(text, 'ui');
      return json(res, 202, { agentId: d.jarvis.ensure() });
    }
    // A tela de configurações: a escolha atual e quem pode ser o Jarvis, sem criar o agente.
    if (path === '/api/chat/jarvis/settings' && method === 'GET') return json(res, 200, { ...d.settings(), providers: d.jarvis.providers(), editable: !isRemote });
    if (method !== 'POST') return notAllowed(res, 'POST');
    if (path === '/api/chat/jarvis/reset') {
      req.resume();
      d.jarvis.ensure();
      const r = d.jarvis.reset();
      return json(res, r === 'ok' ? 200 : 409, r === 'ok' ? {} : { error: tr('Espere o Jarvis terminar a rodada (e a fila) antes.') });
    }
    if (path === '/api/chat/jarvis/briefing') {
      req.resume();
      if (!d.briefing) return json(res, 404, { error: tr('rota desconhecida') });
      void d.briefing.run();
      return json(res, 202, {});
    }
    if (path === '/api/chat/jarvis/settings') {
      if (isRemote) {
        req.resume();
        return json(res, 403, { error: tr('O provedor do Jarvis só muda pelo próprio computador.') });
      }
      const v = validateJarvisSettings(await readJson(req), d.jarvis.providers());
      if ('error' in v) return json(res, 400, { error: v.error });
      const err = d.saveSettings(v.settings);
      if (err) return json(res, 500, { error: err });
      d.jarvis.ensure();
      const r = d.jarvis.settingsChanged();
      return json(res, 200, { ...view(), ...(r === 'busy' ? { note: tr('Gravado: a conversa nova começa quando o Jarvis terminar a rodada atual (Conversa nova).') } : {}) });
    }
    return false;
  };
}
