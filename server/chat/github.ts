// GitHub do "Subir" (ship.ts): REST com fetch, sem Octokit e sem `gh`. O token (fine-grained) vem de
// HABBLAUD_GITHUB_TOKEN ou de <dataDir>/github.json (600, gravado só pelo próprio computador); só vai no cabeçalho
// Authorization, nunca em log, URL ou página. ciVerdict é pura: lista vazia de checks = 'no-ci', NUNCA 'pass'.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { maskSecrets } from '../../shared/activity';
import { tr } from '../../shared/i18n';
import type { CiVerdict, GitHubTokenView } from '../../shared/runs';
import { errMsg } from '../log';

export interface GhRepo {
  owner: string;
  repo: string;
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** owner/repo de um remoto do github.com (https ou ssh); qualquer outro host = undefined. */
export function parseRemote(url: string): GhRepo | undefined {
  const s = url.trim();
  const m =
    /^https:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(s) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(s);
  if (!m || !NAME.test(m[1]) || !NAME.test(m[2]) || m[2] === '.' || m[2] === '..') return undefined;
  return { owner: m[1], repo: m[2] };
}

export interface CheckRun {
  status: string;
  conclusion: string | null;
}
export interface CommitStatus {
  state: string;
}

const RUN_FAIL = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
const RUN_PASS = new Set(['success']);

/**
 * O veredito do CI de um SHA pelos check-runs e pelos statuses. Nada que tenha passado de verdade (vazio, ou só
 * skipped/neutral) = 'no-ci': nunca conta como verde.
 */
export function ciVerdict(c: { checkRuns: readonly CheckRun[]; statuses: readonly CommitStatus[] }): CiVerdict {
  if (c.checkRuns.some((r) => r.status === 'completed' && RUN_FAIL.has(r.conclusion ?? '')) || c.statuses.some((s) => s.state === 'failure' || s.state === 'error')) return 'fail';
  if (c.checkRuns.some((r) => r.status !== 'completed') || c.statuses.some((s) => s.state === 'pending')) return 'pending';
  const passed = c.checkRuns.some((r) => RUN_PASS.has(r.conclusion ?? '')) || c.statuses.some((s) => s.state === 'success');
  return passed ? 'pass' : 'no-ci';
}

export interface WorkflowRun {
  status: string;
  conclusion: string | null;
  url?: string;
}

/** Deploy por workflow: sem execução ainda = pending (o prazo é de quem chama). */
export function deployVerdict(runs: readonly WorkflowRun[]): 'pending' | 'pass' | 'fail' {
  if (runs.some((r) => r.status === 'completed' && RUN_FAIL.has(r.conclusion ?? ''))) return 'fail';
  if (!runs.length || runs.some((r) => r.status !== 'completed')) return 'pending';
  return runs.some((r) => RUN_PASS.has(r.conclusion ?? '')) ? 'pass' : 'fail';
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A frase de cada erro do GitHub (o `message` dele vem mascarado e cortado). */
export function githubErrorText(status: number, message?: string): string {
  const m = message ? maskSecrets(message).slice(0, 300) : '';
  if (status === 401) return tr('GitHub: token inválido ou expirado. Troque em Configurações > Token do GitHub.');
  if (status === 403) return tr('GitHub: o token não tem permissão para isso (confira os escopos em Configurações) ou o limite de pedidos acabou.{0}', [m ? ` (${m})` : '']);
  if (status === 404) return tr('GitHub: não encontrado (o repositório existe e o token enxerga ele?).');
  if (status === 409) return tr('GitHub: conflito, o PR mudou depois da aprovação (SHA diferente) ou não pode ser juntado.{0}', [m ? ` (${m})` : '']);
  if (status === 405) return tr('GitHub: o PR não pode ser juntado agora.{0}', [m ? ` (${m})` : '']);
  if (status === 422) return tr('GitHub recusou o pedido: {0}', [m || tr('dados inválidos')]);
  return tr('GitHub respondeu HTTP {0}.', [status]);
}

const API = 'https://api.github.com';
const TIMEOUT_MS = 20_000;
const enc = encodeURIComponent;

export interface PullRequest {
  number: number;
  url: string;
  state: string;
  merged: boolean;
  mergeSha?: string;
  headSha?: string;
}

const toPr = (j: Record<string, unknown>): PullRequest => ({
  number: Number(j.number),
  url: String(j.html_url ?? ''),
  state: String(j.state ?? ''),
  merged: j.merged === true || !!j.merged_at,
  ...(typeof j.merge_commit_sha === 'string' ? { mergeSha: j.merge_commit_sha } : {}),
  ...(typeof (j.head as { sha?: unknown } | undefined)?.sha === 'string' ? { headSha: (j.head as { sha: string }).sha } : {}),
});

export class GitHub {
  private readonly fetchImpl: typeof fetch;
  constructor(
    private readonly token: string,
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'habblaud',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new GitHubError(tr('GitHub não respondeu ({0}).', [maskSecrets(errMsg(err)).replaceAll(this.token, '***')]), 0);
    }
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const errors = Array.isArray(j.errors) ? j.errors.map((e) => (e as { message?: unknown })?.message).filter((x) => typeof x === 'string') : [];
      throw new GitHubError(githubErrorText(res.status, [j.message, ...errors].filter((x) => typeof x === 'string' && x).join(': ')), res.status);
    }
    return j as T;
  }

  /** Abre o PR (head → base); já existindo um aberto do mesmo branch, devolve ele. */
  async openPr(r: GhRepo, p: { head: string; base: string; title: string; body: string }): Promise<PullRequest> {
    try {
      return toPr(await this.call('POST', `/repos/${enc(r.owner)}/${enc(r.repo)}/pulls`, p));
    } catch (err) {
      if (!(err instanceof GitHubError) || err.status !== 422) throw err;
      const open = await this.call<Array<Record<string, unknown>>>('GET', `/repos/${enc(r.owner)}/${enc(r.repo)}/pulls?state=open&head=${enc(`${r.owner}:${p.head}`)}&base=${enc(p.base)}`);
      if (Array.isArray(open) && open[0]) return toPr(open[0]);
      throw err;
    }
  }

  async pr(r: GhRepo, n: number): Promise<PullRequest> {
    return toPr(await this.call('GET', `/repos/${enc(r.owner)}/${enc(r.repo)}/pulls/${n}`));
  }

  /** Check-runs e o status combinado do SHA. */
  async checks(r: GhRepo, sha: string): Promise<{ checkRuns: CheckRun[]; statuses: CommitStatus[] }> {
    const runs = await this.call<{ check_runs?: Array<Record<string, unknown>> }>('GET', `/repos/${enc(r.owner)}/${enc(r.repo)}/commits/${enc(sha)}/check-runs?per_page=100`);
    const status = await this.call<{ statuses?: Array<Record<string, unknown>> }>('GET', `/repos/${enc(r.owner)}/${enc(r.repo)}/commits/${enc(sha)}/status?per_page=100`);
    return {
      checkRuns: (runs.check_runs ?? []).map((c) => ({ status: String(c.status ?? ''), conclusion: typeof c.conclusion === 'string' ? c.conclusion : null })),
      statuses: (status.statuses ?? []).map((s) => ({ state: String(s.state ?? '') })),
    };
  }

  /** Merge preso ao SHA aprovado (o GitHub recusa com 409 se o head do PR mudou). Devolve o SHA do merge. */
  async mergePr(r: GhRepo, n: number, sha: string): Promise<string> {
    const j = await this.call<{ sha?: unknown; merged?: unknown }>('PUT', `/repos/${enc(r.owner)}/${enc(r.repo)}/pulls/${n}/merge`, { sha, merge_method: 'merge' });
    if (j.merged === false || typeof j.sha !== 'string') throw new GitHubError(githubErrorText(405), 405);
    return j.sha;
  }

  /** Execuções do workflow (arquivo .yml) no branch, para o SHA. */
  async workflowRuns(r: GhRepo, file: string, branch: string, sha: string): Promise<WorkflowRun[]> {
    const j = await this.call<{ workflow_runs?: Array<Record<string, unknown>> }>('GET', `/repos/${enc(r.owner)}/${enc(r.repo)}/actions/workflows/${enc(file)}/runs?branch=${enc(branch)}&head_sha=${enc(sha)}&per_page=20`);
    return (j.workflow_runs ?? [])
      .filter((w) => w.head_sha === undefined || w.head_sha === sha)
      .map((w) => ({ status: String(w.status ?? ''), conclusion: typeof w.conclusion === 'string' ? w.conclusion : null, ...(typeof w.html_url === 'string' ? { url: w.html_url } : {}) }));
  }
}

/** Token fine-grained (github_pat_) ou clássico (ghp_ e afins). */
export const validGitHubToken = (s: string): boolean => /^(github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,255}$/.test(s);

/** HABBLAUD_GITHUB_TOKEN (prioridade) ou <dataDir>/github.json {token} (600). */
export class GitHubTokenStore {
  constructor(
    private readonly file: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private fromFile(): string | undefined {
    try {
      const t = (JSON.parse(readFileSync(this.file, 'utf8')) as { token?: unknown }).token;
      return typeof t === 'string' && validGitHubToken(t) ? t : undefined;
    } catch {
      return undefined;
    }
  }

  get(): string | undefined {
    return this.env.HABBLAUD_GITHUB_TOKEN?.trim() || this.fromFile();
  }

  view(editable: boolean): GitHubTokenView {
    const source = this.env.HABBLAUD_GITHUB_TOKEN?.trim() ? 'env' : this.fromFile() ? 'file' : null;
    return { set: !!source, source, editable };
  }

  /** Grava (600) ou apaga ('' ). Devolve o erro, se houver. */
  save(raw: unknown): string | undefined {
    const token = typeof raw === 'string' ? raw.trim() : undefined;
    if (token === undefined || (token && !validGitHubToken(token))) return tr('Token do GitHub inválido: use um token fine-grained (github_pat_...).');
    try {
      if (!token) {
        rmSync(this.file, { force: true });
        return undefined;
      }
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ token }), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
      return undefined;
    } catch (err) {
      return tr('Não deu para gravar o token do GitHub ({0}).', [errMsg(err)]);
    }
  }
}
