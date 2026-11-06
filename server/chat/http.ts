// Rotas do chat com agentes (/api/chat/*). Abrem processos na máquina: pelo próprio computador (a trava do terminal
// interativo) ou, pela porta do celular (login + HTTPS), só com "chat" em HABBLAUD_REMOTE_ALLOW. O MCP do permission
// tool (/api/chat/mcp/:agentId) é chamado pelo `claude.exe`, sem Origin: vale só do loopback, pela porta local e com o
// Bearer do próprio agente.
import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tr } from '../../shared/i18n';
import type { DaySummary, SummaryMode } from '../../shared/summary';
import type { Provider } from '../../shared/types';
import { HttpError, readJson, sendJson } from '../http/app';
import { ptyRequestProblem } from '../http/pty';
import { pinError, type ApprovalPin } from '../permissions/pin';
import type { ShipApproval } from '../../shared/runs';
import type { PermissionRegistry } from '../permissions/registry';
import type { Delegation } from './delegation';
import { handleMcp, makeApprovalCall, type McpTool } from './permission';
import type { RoleStore } from './roles';
import type { RunService } from './runs';
import type { ShipService } from './ship';
import type { ChatService } from './service';
import type { TriggerService } from './triggers';
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
  runs?: Pick<RunService, 'list' | 'get' | 'create' | 'stop' | 'continue' | 'merge' | 'discard' | 'diff' | 'feedback' | 'shotPath'>;
  /** "Subir" (ship.ts): o cartão (prepare) e a aprovação com PIN (approve); sem ele, 404. */
  ship?: Pick<ShipService, 'prepare' | 'approve'>;
  /** PIN de aprovação (permissions/pin.ts): o "Subir" sempre pede; sem PIN definido = 403. */
  pin?: Pick<ApprovalPin, 'check' | 'triesLeft'>;
  /** Token do GitHub do "Subir" (github.ts GitHubTokenStore): GET /api/chat/github; PUT só pelo próprio computador. */
  github?: { view(editable: boolean): unknown; save(raw: unknown): string | undefined };
  /** "Abrir no VS Code" a cópia de uma lista (`code <caminho>` sem shell): false = sem `code`, a página mostra o caminho. */
  openEditor?: (path: string) => Promise<boolean>;
  /** Gatilhos (triggers.ts); sem eles, 404. */
  /** Resumo do dia (server/summary); sem ele, 404. */
  summary?: { generate(mode: SummaryMode): Promise<DaySummary>; last(): DaySummary | undefined };
  triggers?: Pick<TriggerService, 'list' | 'history' | 'create' | 'update' | 'remove' | 'test'>;
  /** Ferramentas a mais no MCP de um agente (as do Jarvis, só no agente do sistema); somam com as office_*. */
  extraTools?: (agentId: string) => McpTool[];
  /** Rotas do Jarvis (/api/chat/jarvis*, server/jarvis/http.ts), com a mesma trava do resto do chat. */
  jarvis?: (req: IncomingMessage, res: ServerResponse, url: URL, isRemote: boolean) => Promise<boolean>;
}

/** Batida do SSE enquanto uma ferramenta espera (aprovação, resposta de outro agente). */
const SSE_BEAT_MS = 15_000;

const AGENT_ROUTE = /^\/api\/chat\/agents\/([^/]+)(?:\/(messages|stop|limits|merge|discard))?$/;
const MCP_ROUTE = /^\/api\/chat\/mcp\/([^/]+)$/;
const ROLE_ROUTE = /^\/api\/chat\/roles\/([^/]+)$/;
const RUN_ROUTE = /^\/api\/chat\/runs\/([^/]+)(?:\/(stop|continue|merge|discard|diff|ship|ship\/prepare|vscode))?$/;
const FEEDBACK_ROUTE = /^\/api\/chat\/runs\/([^/]+)\/items\/(\d{1,4})\/feedback$/;
const SHOT_ROUTE = /^\/api\/chat\/runs\/([^/]+)\/items\/(\d{1,4})\/shots\/([^/]+)$/;
const TRIGGER_ROUTE = /^\/api\/chat\/triggers\/([^/]+)(?:\/(test))?$/;

/** O conjunto que o cartão mostrou, como a página manda (o servidor compara com o que vale agora). */
function parseApproval(b: Record<string, unknown>): ShipApproval | undefined {
  const s = (k: string) => (typeof b[k] === 'string' && (b[k] as string).length <= 300 ? (b[k] as string) : undefined);
  const risky = Array.isArray(b.risky) && b.risky.length <= 1000 && b.risky.every((x) => typeof x === 'string') ? (b.risky as string[]) : undefined;
  const sha = s('sha');
  const [owner, repo, base, remote, deploy] = [s('owner'), s('repo'), s('base'), s('remote'), s('deploy')];
  if (!sha || !/^[0-9a-f]{40}$/.test(sha) || !owner || !repo || !base || !remote || !deploy || !risky || (b.mode !== 'pr' && b.mode !== 'merge')) return undefined;
  return { sha, owner, repo, base, remote, deploy, risky, mode: b.mode, ...(b.noCi === true ? { noCi: true } : {}) };
}

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

/** Porta do celular (vem do app.ts): `is` = chegou pela porta remota (já logado); `trusted` = "chat" liberado lá. */
export interface ChatRemote {
  is(req: IncomingMessage): boolean;
  trusted(req: IncomingMessage): boolean;
}

export type ChatRoutes = (req: IncomingMessage, res: ServerResponse, url: URL, remote?: ChatRemote) => void;

export function createChatRoutes(d: ChatRouteDeps): ChatRoutes {
  const notAllowed = (res: ServerResponse, allow: string) => {
    res.setHeader('Allow', allow);
    sendJson(res, 405, { error: tr('método não permitido') });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL, remote?: ChatRemote): Promise<void> => {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const isRemote = !!remote?.is(req);

    const mcp = MCP_ROUTE.exec(path);
    if (mcp) {
      if (method !== 'POST') return notAllowed(res, 'POST');
      const agentId = decode(mcp[1]);
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (isRemote || !isLoopback(req.socket.remoteAddress) || !token || d.chat.tokenOwner(token) !== agentId) {
        req.resume();
        return sendJson(res, 401, { error: tr('não autorizado') });
      }
      const body = await readJson(req);
      const registry = d.registry ?? { registerChat: () => ({ skip: 'too-many' as const }), wait: () => undefined };
      const run = () => handleMcp(body, makeApprovalCall({ registry, chat: d.chat }, agentId), [...(d.delegation?.tools(agentId) ?? []), ...(d.extraTools?.(agentId) ?? [])]);
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

    const problem = isRemote
      ? remote!.trusted(req)
        ? null
        : tr('não liberado no acesso remoto (veja HABBLAUD_REMOTE_ALLOW)')
      : ptyRequestProblem(req);
    if (problem) {
      req.resume();
      return sendJson(res, 403, { error: problem });
    }

    if (path === '/api/summary/day') {
      if (!d.summary) return sendJson(res, 404, { error: tr('rota desconhecida') });
      if (method === 'GET') return sendJson(res, 200, d.summary.last() ?? {});
      if (method !== 'POST') return notAllowed(res, 'GET, POST');
      const body = (await readJson(req)) as { mode?: unknown } | null;
      return sendJson(res, 200, await d.summary.generate(body?.mode === 'list' ? 'list' : 'ai'));
    }

    if (d.jarvis && (path === '/api/chat/jarvis' || path.startsWith('/api/chat/jarvis/')) && (await d.jarvis(req, res, url, isRemote))) return;

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
          if (r === 'system') return sendJson(res, 403, { error: tr('O Jarvis não fecha: use "Conversa nova" para recomeçar.') });
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
    // Comentários por linha do diff (revisão): uma mensagem ao mesmo agente do item.
    const feedback = FEEDBACK_ROUTE.exec(path);
    if (feedback && d.runs) {
      if (method !== 'POST') return notAllowed(res, 'POST');
      const r = await d.runs.feedback(decode(feedback[1]), Number(feedback[2]), await readJson(req));
      return 'ok' in r ? sendJson(res, 202, {}) : sendJson(res, r.status, { error: r.error });
    }
    // Capturas do QA visual (vboards.qa): só o que o portão registrou no item, com o caminho real dentro da pasta dele.
    const shot = SHOT_ROUTE.exec(path);
    if (shot && d.runs) {
      if (method !== 'GET') return notAllowed(res, 'GET');
      const file = d.runs.shotPath(decode(shot[1]), Number(shot[2]), decode(shot[3]));
      if (!file) return sendJson(res, 404, { error: tr('captura não encontrada') });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return void createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }
    const runRoute = RUN_ROUTE.exec(path);
    if (runRoute && d.runs) {
      const id = decode(runRoute[1]);
      const action = runRoute[2];
      if (action === 'diff') {
        if (method !== 'GET') return notAllowed(res, 'GET');
        const r = await d.runs.diff(id);
        return 'diff' in r ? sendJson(res, 200, r) : sendJson(res, r.status, { error: r.error });
      }
      if (!action) {
        if (method !== 'GET') return notAllowed(res, 'GET');
        const run = d.runs.get(id);
        return run ? sendJson(res, 200, run) : sendJson(res, 404, { error: tr('lista não encontrada') });
      }
      if (method !== 'POST') return notAllowed(res, 'POST');
      if (action === 'ship' || action === 'ship/prepare') {
        if (!d.ship) {
          req.resume();
          return sendJson(res, 404, { error: tr('rota desconhecida') });
        }
        if (action === 'ship/prepare') {
          req.resume();
          const p = await d.ship.prepare(id);
          return 'error' in p ? sendJson(res, p.status, { error: p.error }) : sendJson(res, 200, p);
        }
        // Push, PR e merge: sempre com o PIN de aprovação (sem PIN definido, nada sobe).
        const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
        const c = d.pin ? await d.pin.check(body.pin) : 'unset';
        if (c !== 'ok') {
          const e = pinError(c, d.pin?.triesLeft() ?? 0);
          return sendJson(res, e.status, { error: e.error, pin: c });
        }
        const approval = parseApproval(body);
        if (!approval) return sendJson(res, 400, { error: tr('Mande o cartão inteiro que foi aprovado (SHA, repositório, base, remoto, modo, deploy e hooks/CI).') });
        const r = await d.ship.approve(id, approval);
        return 'run' in r ? sendJson(res, 200, r.run) : sendJson(res, r.status, { error: r.error });
      }
      req.resume();
      if (action === 'vscode') {
        const run = d.runs.get(id);
        const w = run?.isolated;
        if (!run) return sendJson(res, 404, { error: tr('lista não encontrada') });
        if (!w || w.merged || w.discarded) return sendJson(res, 409, { error: tr('Esta lista não tem cópia isolada aberta.') });
        return sendJson(res, 200, { opened: d.openEditor ? await d.openEditor(w.path) : false, path: w.path });
      }
      if (action === 'stop' || action === 'continue') {
        const r = action === 'stop' ? d.runs.stop(id) : d.runs.continue(id);
        const status = { ok: 200, idle: 200, 'not-found': 404, invalid: 409, busy: 409 }[r];
        const error = r === 'busy' ? tr('Já há uma lista rodando nesta pasta ou o limite de listas ao mesmo tempo foi atingido.') : r === 'invalid' ? tr('Esta lista não pode continuar.') : r;
        return sendJson(res, status, status === 200 ? {} : { error });
      }
      const r = await (action === 'merge' ? d.runs.merge(id) : d.runs.discard(id));
      return 'ok' in r ? sendJson(res, 200, {}) : sendJson(res, r.status, { error: r.error });
    }

    if (path === '/api/chat/github') {
      if (!d.github) return sendJson(res, 404, { error: tr('rota desconhecida') });
      if (method === 'GET') return sendJson(res, 200, d.github.view(!isRemote));
      if (method !== 'PUT') return notAllowed(res, 'GET, PUT');
      // O token só é gravado pelo próprio computador (nem pela porta do celular com login).
      if (isRemote) {
        req.resume();
        return sendJson(res, 403, { error: tr('O token do GitHub só muda pelo próprio computador.') });
      }
      const body = ((await readJson(req)) ?? {}) as { token?: unknown };
      const err = d.github.save(body.token);
      return err ? sendJson(res, 400, { error: err }) : sendJson(res, 200, d.github.view(true));
    }

    // Gatilhos: "Testar agora" só cria o cartão de aprovação, como qualquer disparo.
    const triggers = d.triggers;
    if (path === '/api/chat/triggers' || path.startsWith('/api/chat/triggers/')) {
      if (!triggers) return sendJson(res, 404, { error: tr('rota desconhecida') });
      if (path === '/api/chat/triggers') {
        if (method === 'GET') return sendJson(res, 200, triggers.list());
        if (method !== 'POST') return notAllowed(res, 'GET, POST');
        const r = triggers.create(await readJson(req));
        return 'rule' in r ? sendJson(res, 201, r.rule) : sendJson(res, r.status, { error: r.error });
      }
      if (path === '/api/chat/triggers/history') {
        if (method !== 'GET') return notAllowed(res, 'GET');
        return sendJson(res, 200, triggers.history());
      }
      const t = TRIGGER_ROUTE.exec(path);
      if (t) {
        const id = decode(t[1]);
        if (t[2] === 'test') {
          if (method !== 'POST') return notAllowed(res, 'POST');
          req.resume();
          return triggers.test(id) === 'ok' ? sendJson(res, 202, {}) : sendJson(res, 404, { error: tr('gatilho não encontrado') });
        }
        if (method === 'PUT') {
          const r = triggers.update(id, await readJson(req));
          return 'rule' in r ? sendJson(res, 200, r.rule) : sendJson(res, r.status, { error: r.error });
        }
        if (method !== 'DELETE') return notAllowed(res, 'PUT, DELETE');
        req.resume();
        return triggers.remove(id) ? sendJson(res, 200, {}) : sendJson(res, 404, { error: tr('gatilho não encontrado') });
      }
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

  return (req, res, url, remote) => {
    handle(req, res, url, remote).catch((err) => {
      if (res.headersSent) return void res.destroy();
      if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
      else sendJson(res, 500, { error: tr('erro interno') });
    });
  };
}
