// Criar um repositório privado no GitHub pela REST (A7), com fetch (sem gh, sem Octokit). Precisa de um token com
// Administration: write na conta ou na organização; sem essa permissão (403) ou sem token, o passo vira "manual" com a
// instrução para criar à mão. O token vem do GitHubTokenStore (chat/github.ts: HABBLAUD_GITHUB_TOKEN lido antes do
// takeSecrets, ou <dataDir>/github.json) e só vai no cabeçalho Authorization.
import { maskSecrets } from '../../shared/activity';
import { tr } from '../../shared/i18n';

const API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;
export const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export type CreateRepoResult = { ok: true; url: string; cloneUrl: string; existed: boolean } | { manual: string } | { error: string };

/** Instrução do passo manual (sem token, ou token sem Administration: write). */
export const manualRepoText = (owner: string, name: string, why: string): string =>
  tr('{0} Crie à mão em https://github.com/new (dono {1}, nome {2}, privado, sem README) e rode na pasta: git remote add origin https://github.com/{1}/{2}.git', [why, owner, name]);

/**
 * Cria `owner/name` privado (na conta do token se `owner` for ela; senão, na organização). Repo que já existe com esse
 * nome conta como feito (uma tentativa anterior pode ter criado antes de gravar o estado). Nunca faz push.
 */
export async function createRepo(o: { token: string | undefined; owner: string; name: string; description?: string; fetchImpl?: typeof fetch }): Promise<CreateRepoResult> {
  const { owner, name } = o;
  if (!OWNER_RE.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) return { error: tr('Dono ou nome de repositório inválido.') };
  if (!o.token) return { manual: manualRepoText(owner, name, tr('Sem token do GitHub (HABBLAUD_GITHUB_TOKEN ou github.json).')) };
  const f = o.fetchImpl ?? fetch;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await f(`${API}${path}`, {
      method,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${o.token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'habblaud', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  };
  const done = (j: Record<string, unknown>, existed: boolean): CreateRepoResult =>
    typeof j.html_url === 'string' && typeof j.clone_url === 'string' ? { ok: true, url: j.html_url, cloneUrl: j.clone_url, existed } : { error: tr('Resposta inesperada do GitHub.') };
  try {
    const me = await call('GET', '/user');
    if (me.status === 401) return { manual: manualRepoText(owner, name, tr('O GitHub recusou o token (401: inválido ou expirado).')) };
    if (me.status !== 200) return { error: tr('GitHub respondeu {0}.', [me.status]) };
    const mine = typeof me.json.login === 'string' && me.json.login.toLowerCase() === owner.toLowerCase();
    const r = await call('POST', mine ? '/user/repos' : `/orgs/${encodeURIComponent(owner)}/repos`, { name, private: true, ...(o.description ? { description: o.description.slice(0, 300) } : {}) });
    if (r.status === 201) return done(r.json, false);
    if (r.status === 403 || r.status === 401 || (r.status === 404 && !mine))
      return { manual: manualRepoText(owner, name, tr('O token não pode criar repositórios em {0} ({1}): ele precisa de Administration: write.', [owner, r.status])) };
    if (r.status === 422) {
      // Nome já usado: se é um repo privado nosso, segue (idempotente); público ou de outro jeito, o dono decide.
      const ex = await call('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
      if (ex.status === 200 && ex.json.private === true) return done(ex.json, true);
      return { manual: manualRepoText(owner, name, tr('Já existe um repositório {0}/{1} que não é privado ou não é acessível.', [owner, name])) };
    }
    const msg = typeof r.json.message === 'string' ? maskSecrets(r.json.message).slice(0, 200) : '';
    return { error: tr('GitHub respondeu {0}{1}.', [r.status, msg ? `: ${msg}` : '']) };
  } catch (err) {
    return { error: tr('Sem resposta do GitHub: {0}', [maskSecrets(err instanceof Error ? err.message : String(err))]) };
  }
}
