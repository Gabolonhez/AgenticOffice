// Rotas do assistente "Novo projeto" (A7). Só pelo próprio computador (a trava do terminal, conferida em http/app.ts);
// o guard já exigiu JSON e Origin local nos POST. Criar pede SEMPRE o PIN de aprovação no corpo (sem PIN definido,
// nada é criado), como os cartões críticos.
//
//   GET  /api/projects                 os briefings salvos (com o estado da criação) e os padrões
//   POST /api/projects/draft           {idea, name?, ...} → {questions, errors} ou {slug, brief, spec}
//   GET  /api/projects/:slug           {brief, spec, state}
//   POST /api/projects/:slug/spec      {spec}: a spec revisada
//   POST /api/projects/:slug/create    {pin, options} → 202 {state} (a criação segue; acompanhe pelo GET)
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tr } from '../../shared/i18n';
import { HttpError, readJson, sendJson } from '../http/app';
import { log, errMsg } from '../log';
import { pinError, type ApprovalPin } from '../permissions/pin';
import { parseOptions, type ProjectsService } from './create';

const ITEM = /^\/api\/projects\/([a-z0-9-]{1,60})(?:\/(spec|create))?$/;

export function createProjectRoutes(svc: ProjectsService, pin: Pick<ApprovalPin, 'check' | 'triesLeft'> | undefined, defaults: () => { githubOwner?: string; root?: string; template?: string }): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  const fail = (res: ServerResponse, err: unknown) => {
    if (res.headersSent) return void res.destroy();
    if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
    else sendJson(res, 500, { error: tr('erro interno') });
  };
  const notAllowed = (res: ServerResponse, allow: string) => {
    res.setHeader('Allow', allow);
    sendJson(res, 405, { error: tr('método não permitido') });
  };
  const route = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    const method = req.method ?? 'GET';
    if (path === '/api/projects') {
      if (method !== 'GET') return notAllowed(res, 'GET');
      return sendJson(res, 200, { projects: svc.list(), defaults: defaults() });
    }
    if (path === '/api/projects/draft') {
      if (method !== 'POST') return notAllowed(res, 'POST');
      const r = svc.draft(await readJson(req));
      return sendJson(res, 'slug' in r || !r.errors.length ? 200 : 400, r);
    }
    const m = ITEM.exec(path);
    if (!m) return sendJson(res, 404, { error: tr('rota desconhecida') });
    const [, slug, action] = m;
    if (!action) {
      if (method !== 'GET') return notAllowed(res, 'GET');
      const p = svc.get(slug);
      return p ? sendJson(res, 200, p) : sendJson(res, 404, { error: tr('Projeto não encontrado: faça o briefing antes.') });
    }
    if (method !== 'POST') return notAllowed(res, 'POST');
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    if (action === 'spec') {
      const err = svc.saveSpec(slug, body.spec);
      return sendJson(res, err ? 400 : 200, err ? { error: err } : { ok: true });
    }
    const options = parseOptions(body.options, defaults().githubOwner);
    if ('error' in options) return sendJson(res, 400, options);
    const c = pin ? await pin.check(body.pin) : 'unset';
    if (c !== 'ok') {
      const e = pinError(c, pin?.triesLeft() ?? 0);
      return sendJson(res, e.status, { error: e.error, pin: c });
    }
    const r = svc.start(slug, options);
    if ('error' in r) return sendJson(res, 409, r);
    r.done.catch((err) => log.warn(tr('Projeto {0}: a criação parou ({1}).', [slug, errMsg(err)])));
    sendJson(res, 202, { state: r.state });
  };
  return (req, res, path) => void route(req, res, path).catch((err) => fail(res, err));
}
