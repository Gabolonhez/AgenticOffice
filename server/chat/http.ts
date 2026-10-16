// Rotas do chat com agentes (/api/chat/*). Abrem processos na máquina: só pelo próprio computador (a trava do terminal
// interativo). O MCP do permission tool (/api/chat/mcp/:agentId) é chamado pelo `claude.exe`, sem Origin: vale só do
// loopback e com o Bearer do próprio agente.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tr } from '../../shared/i18n';
import type { Provider } from '../../shared/types';
import { HttpError, readJson, sendJson } from '../http/app';
import { ptyRequestProblem } from '../http/pty';
import type { PermissionRegistry } from '../permissions/registry';
import type { Delegation } from './delegation';
import { handleMcp, makeApprovalCall } from './permission';
import type { RoleStore } from './roles';
import type { RunService } from './runs';
import type { ChatService } from './service';
import type { WorktreeOps } from './types';

export interface ChatRouteDeps {
  chat: Pick<ChatService, 'providers' | 'open' | 'view' | 'send' | 'stop' | 'setLimits' | 'close' | 'tokenOwner' | 'record' | 'markIsolated' | 'addApproval' | 'resolveApproval'> & { roles?: RoleStore };
  registry?: Pick<PermissionRegistry, 'registerChat' | 'wait'>;
  folders: () => Array<{ path: string; name?: string }>;
  accounts: () => Array<{ id: string; provider: Provider; short?: string }>;
  worktrees?: WorktreeOps;
  /** Ferramentas office_* e ligações entre agentes (delegation.ts); sem ela, só o permission tool. */
  delegation?: Pick<Delegation, 'tools' | 'links'>;
  /** Listas que rodam um agente por item (runs.ts); sem ela, 404. */
  runs?: Pick<RunService, 'list' | 'get' | 'create' | 'stop' | 'continue' | 'merge' | 'discard'>;
}

/** Batida do SSE enquanto uma ferramenta espera (aprovação, resposta de outro agente). */
const SSE_BEAT_MS = 15_000;

const AGENT_ROUTE = /^\/api\/chat\/agents\/([^/]+)(?:\/(messages|stop|limits|merge|discard))?$/;
const MCP_ROUTE = /^\/api\/chat\/mcp\/([^/]+)$/;
const ROLE_ROUTE = /^\/api\/chat\/roles\/([^/]+)$/;
const RUN_ROUTE = /^\/api\/chat\/runs\/([^/]+)(?:\/(stop|continue|merge|discard))?$/;

function isLoopback(addr: string | undefined): boolean {
  const a = addr?.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || !!a?.startsWith('127.');
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, tr('id inválido'));
  }
};

export function createChatRoutes(d: ChatRouteDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => void {
  const notAllowed = (res: ServerResponse, allow: string) => {
    res.setHeader('Allow', allow);
    sendJson(res, 405, { error: tr('método não permitido') });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const path = url.pathname;
    const method = req.method ?? 'GET';

    const mcp = MCP_ROUTE.exec(path);
    if (mcp) {
      if (method !== 'POST') return notAllowed(res, 'POST');
      const agentId = decode(mcp[1]);
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!isLoopback(req.socket.remoteAddress) || !token || d.chat.tokenOwner(token) !== agentId) {
        req.resume();
        return sendJson(res, 401, { error: tr('não autorizado') });
      }
      const body = await readJson(req);
      const registry = d.registry ?? { registerChat: () => ({ skip: 'too-many' as const }), wait: () => undefined };
      const run = () => handleMcp(body, makeApprovalCall({ registry, chat: d.chat }, agentId), d.delegation?.tools(agentId));
      // tools/call pode esperar muito (cartão, resposta de outro agente): por SSE, com batidas, nenhum prazo de
      // cabeçalho/corpo do cliente HTTP estoura. O Streamable HTTP do MCP aceita os dois formatos.
      if ((body as { method?: unknown })?.method === 'tools/call' && String(req.headers.accept ?? '').includes('text/event-stream')) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const beat = setInterval(() => res.write(': ping\n\n'), SSE_BEAT_MS);
        try {
          res.end(`event: message\ndata: ${JSON.stringify(await run())}\n\n`);
        } finally {
          clearInterval(beat);
        }
        return;
      }
      const out = await run();
      if (out === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      return sendJson(res, 200, out);
    }

    const problem = ptyRequestProblem(req);
    if (problem) {
      req.resume();
      return sendJson(res, 403, { error: problem });
    }

    if (path === '/api/chat/links') {
      if (method !== 'GET') return notAllowed(res, 'GET');
      return sendJson(res, 200, d.delegation?.links() ?? []);
    }

    if (path === '/api/chat/options') {
      if (method !== 'GET') return notAllowed(res, 'GET');
      return sendJson(res, 200, { providers: d.chat.providers(), roles: d.chat.roles?.list() ?? [], folders: d.folders(), accounts: d.accounts() });
    }

    if (path === '/api/chat/agents') {
      if (method !== 'POST') return notAllowed(res, 'POST');
      const r = d.chat.open(await readJson(req));
      if ('agentId' in r) return sendJson(res, 201, r);
      return sendJson(res, r.error === 'invalid' ? 400 : r.error === 'too-many' ? 429 : 409, { error: r.reason });
    }

    const agent = AGENT_ROUTE.exec(path);
    if (agent) {
      const id = decode(agent[1]);
      const action = agent[2];
      if (!action) {
        if (method === 'GET') {
          const after = Number(url.searchParams.get('after') ?? 0) || 0;
          const v = d.chat.view(id, after);
          return v ? sendJson(res, 200, v) : sendJson(res, 404, { error: tr('agente não encontrado') });
        }
        if (method === 'DELETE') {
          const r = d.chat.close(id);
          return sendJson(res, r === 'ok' ? 200 : r === 'busy' ? 409 : 404, r === 'ok' ? {} : { error: r });
        }
        return notAllowed(res, 'GET, DELETE');
      }
      if (action === 'limits') {
        if (method !== 'PUT') return notAllowed(res, 'PUT');
        const r = d.chat.setLimits(id, await readJson(req));
        return sendJson(res, r === 'ok' ? 200 : r === 'invalid' ? 400 : 404, r === 'ok' ? {} : { error: r });
      }
      if (method !== 'POST') return notAllowed(res, 'POST');
      if (action === 'messages') {
        const r = d.chat.send(id, await readJson(req));
        const status = { ok: 202, busy: 409, blocked: 409, invalid: 400, 'not-found': 404 }[r];
        return sendJson(res, status, r === 'ok' ? {} : { error: r });
      }
      if (action === 'stop') {
        req.resume();
        const r = d.chat.stop(id);
        return sendJson(res, r === 'not-found' ? 404 : 200, r === 'not-found' ? { error: r } : {});
      }
      // merge | discard
      req.resume();
      const rec = d.chat.record(id);
      if (!rec) return sendJson(res, 404, { error: tr('agente não encontrado') });
      if (!rec.isolated || !d.worktrees || rec.isolated.merged || rec.isolated.discarded) return sendJson(res, 409, { error: tr('Este agente não tem cópia isolada aberta.') });
      const w = rec.isolated;
      if (action === 'merge') {
        const r = await d.worktrees.merge(rec.folder, w, tr('Trabalho do agente {0}', [rec.name ?? id]));
        if (!r.ok) return sendJson(res, 409, { error: r.reason });
        d.chat.markIsolated(id, { merged: true }, tr('Cópia juntada ao projeto.'));
        return sendJson(res, 200, {});
      }
      const r = await d.worktrees.discard(rec.folder, w);
      if (!r.ok) return sendJson(res, 409, { error: r.reason });
      d.chat.markIsolated(id, { discarded: true }, tr('Cópia descartada.'));
      return sendJson(res, 200, {});
    }

    // Listas: o POST que cria é o "Rodar lista" da tela de confirmação (a aprovação da lista inteira).
    if (path === '/api/chat/runs') {
      if (!d.runs) return sendJson(res, 404, { error: tr('rota desconhecida') });
      if (method === 'GET') return sendJson(res, 200, d.runs.list());
      if (method !== 'POST') return notAllowed(res, 'GET, POST');
      const r = d.runs.create(await readJson(req));
      return 'run' in r ? sendJson(res, 201, r.run) : sendJson(res, r.status, { error: r.error });
    }
    const runRoute = RUN_ROUTE.exec(path);
    if (runRoute && d.runs) {
      const id = decode(runRoute[1]);
      const action = runRoute[2];
      if (!action) {
        if (method !== 'GET') return notAllowed(res, 'GET');
        const run = d.runs.get(id);
        return run ? sendJson(res, 200, run) : sendJson(res, 404, { error: tr('lista não encontrada') });
      }
      if (method !== 'POST') return notAllowed(res, 'POST');
      req.resume();
      if (action === 'stop' || action === 'continue') {
        const r = action === 'stop' ? d.runs.stop(id) : d.runs.continue(id);
        const status = { ok: 200, idle: 200, 'not-found': 404, invalid: 409, busy: 409 }[r];
        const error = r === 'busy' ? tr('Já há uma lista rodando.') : r === 'invalid' ? tr('Esta lista não pode continuar.') : r;
        return sendJson(res, status, status === 200 ? {} : { error });
      }
      const r = await (action === 'merge' ? d.runs.merge(id) : d.runs.discard(id));
      return 'ok' in r ? sendJson(res, 200, {}) : sendJson(res, r.status, { error: r.error });
    }

    if (path === '/api/chat/roles') {
      const roles = d.chat.roles;
      if (!roles) return sendJson(res, 404, { error: tr('rota desconhecida') });
      if (method === 'GET') return sendJson(res, 200, roles.list());
      if (method !== 'PUT') return notAllowed(res, 'GET, PUT');
      const r = roles.put(await readJson(req));
      return 'error' in r ? sendJson(res, 400, r) : sendJson(res, 200, roles.list());
    }
    const role = ROLE_ROUTE.exec(path);
    if (role) {
      if (method !== 'DELETE') return notAllowed(res, 'DELETE');
      req.resume();
      const ok = d.chat.roles?.remove(decode(role[1]));
      return ok ? sendJson(res, 200, d.chat.roles!.list()) : sendJson(res, 404, { error: tr('Papel não encontrado.') });
    }

    req.resume();
    sendJson(res, 404, { error: tr('rota desconhecida') });
  };

  return (req, res, url) => {
    handle(req, res, url).catch((err) => {
      if (res.headersSent) return void res.destroy();
      if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
      else sendJson(res, 500, { error: tr('erro interno') });
    });
  };
}
