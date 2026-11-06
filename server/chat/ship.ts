// "Subir" uma lista (cópia isolada) ao GitHub: pushing → pr → ci → merging → deploying → deployed | failed, gravado em
// ChatRun.ship (runs.json) e retomado depois de um reinício; o relógio olha o GitHub a cada SHIP_POLL_MS.
// - Começa só com o PIN (rota http.ts) ou o cartão crítico do Jarvis (runs_ship), e fica preso ao SHA aprovado: o push
//   é do HEAD da cópia igual a ele, o merge é pelo SHA (o GitHub recusa se o PR mudou).
// - vboards.ship=pr: só abre o PR (o fim). =merge: merge só com CI verde. CI vazio ('no-ci') NUNCA é verde: o merge
//   espera uma aprovação extra com PIN ("este repo não tem CI de PR; merge = deploy em produção").
// - Deploy: vboards.deploy=workflow:<arquivo.yml> espera esse workflow na base, no SHA do merge; none = o merge basta.
// - Produto com vários repos (vboards/products.ts): server → web → app; o próximo espera o anterior chegar a deployed.
// - Cada etapa vai ao registro (journal.ts) e ao VBoards (stage + prUrl em todas as tarefas da lista); avisos no
//   celular: pr, ci_failed, no_ci, deployed (e failed). Depois do deploy: descarta a cópia e faz fast-forward do
//   checkout local se ele estiver limpo e na base (senão só avisa).
// - vboards.autoMerge=low (A4): a lista automática do VBoards sobe SOZINHA, sem PIN, só se autoShipBlock deixar (plano
//   aprovado no VBoards, portão sem volta de correção, risco final baixo); o merge continua exigindo CI verde.
import { basename } from 'node:path';
import { tr } from '../../shared/i18n';
import { shipActive, type ChatRun, type RiskLevel, type RunShip, type ShipPreview, type ShipStep } from '../../shared/runs';
import { errMsg } from '../log';
import { productOfFolder, type Product, type RepoRole } from '../vboards/products';
import type { FolderConfig } from '../vboards/vboards';
import { ciVerdict, deployVerdict, GitHubError, parseRemote, type GitHub } from './github';
import type { JournalStage } from './journal';
import { diffRisk, finalRisk, maxRisk, riskLabel } from './risk';
import { mergeMessage, type RunService } from './runs';
import type { ShipWorktreeOps } from './types';
import { findSecrets, riskyFiles } from './worktree';

export const SHIP_POLL_MS = 60_000;
/** Logo depois do PR o GitHub ainda não registrou os checks: vazio só vira 'no-ci' passado este tempo. */
export const NO_CI_GRACE_MS = 3 * 60_000;
/** Ordem de subida de um produto com vários repos. */
const ROLE_ORDER: Record<RepoRole, number> = { server: 0, web: 1, app: 2, other: 3 };

export type ShipGitHub = Pick<GitHub, 'openPr' | 'pr' | 'checks' | 'mergePr' | 'workflowRuns'>;
/** 'auto': o PR de uma subida sem PIN (vboards.autoMerge=low), com o link. */
export type ShipEvent = 'pr' | 'ci_failed' | 'no_ci' | 'deployed' | 'failed' | 'auto';

export interface ShipDeps {
  runs: Pick<RunService, 'get' | 'list' | 'persist' | 'journalShipped'>;
  worktrees: ShipWorktreeOps;
  token: () => string | undefined;
  github: (token: string) => ShipGitHub;
  folderConfig: (folder: string) => Promise<FolderConfig>;
  products?: () => Product[];
  vboards?: { settle?(id: string, s: { state: 'done' | 'failed' | 'review'; stage?: string; summary?: string; prUrl?: string }): boolean };
  notify?: (title: string, event: ShipEvent, url?: string) => void;
  /** Agentes dos itens voltam à pasta do projeto quando a cópia some. */
  restoreCwd?: (agentId: string) => void;
  now?: () => number;
}

type Fail = { status: number; error: string };
type Outcome = 'next' | 'wait' | 'end';

export class ShipService {
  private readonly now: () => number;
  private readonly busy = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: ShipDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Depois do runs.load(): retoma o que estava subindo e olha o GitHub a cada SHIP_POLL_MS. */
  start(pollMs = SHIP_POLL_MS): void {
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick(), pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Uma volta em cada subida em andamento (os testes chamam direto). */
  async tick(): Promise<void> {
    await Promise.all(this.deps.runs.list().filter((r) => shipActive(r.ship)).map((r) => this.advance(r)));
    await Promise.all(this.deps.runs.list().filter((r) => r.auto && !r.ship && !r.autoShip && r.state === 'done').map((r) => this.autoShip(r)));
  }

  status(id: string): RunShip | undefined {
    return this.deps.runs.get(id)?.ship;
  }

  /**
   * O que o cartão mostra: commita o que está na cópia (a mesma checagem do Juntar) e devolve repo, base, branch, SHA,
   * diffstat, portão e os arquivos de hooks/CI. Nada sai da máquina aqui.
   */
  async prepare(id: string): Promise<ShipPreview | Fail> {
    const run = this.deps.runs.get(id);
    if (!run) return { status: 404, error: tr('lista não encontrada') };
    const w = run.isolated;
    if (!w || w.merged || w.discarded) return { status: 409, error: tr('Esta lista não tem cópia isolada aberta.') };
    if (run.state === 'running') return { status: 409, error: tr('Pare a lista ou espere ela terminar antes.') };
    if (shipActive(run.ship)) return { status: 409, error: tr('O "Subir" desta lista já está em andamento.') };
    const cfg = await this.deps.folderConfig(run.options.folder);
    if (cfg.ship === 'off') return { status: 409, error: tr('O "Subir" está desligado nesta pasta (vboards.ship=off): ligue em Configurações > VBoards.') };
    if (!this.deps.token()) return { status: 409, error: tr('Sem token do GitHub: defina em Configurações > Token do GitHub.') };
    const repoCfg = productOfFolder(run.options.folder, this.deps.products?.() ?? [])?.repos.find((r) => samePath(r.path, run.options.folder));
    const remote = cfg.remote ?? repoCfg?.remote ?? 'origin';
    const info = await this.deps.worktrees.remoteInfo(run.options.folder, remote);
    const gh = info.url ? parseRemote(info.url) : undefined;
    if (!gh) return { status: 409, error: tr('O remoto {0} não é um repositório do github.com: o "Subir" só fala com o GitHub.', [remote]) };
    const base = cfg.base ?? info.head ?? 'main';
    const c = await this.deps.worktrees.commit(w, mergeMessage(run.items));
    if (!c.ok) return { status: 409, error: c.reason };
    const files = await this.deps.worktrees.changedFiles(w, c.sha);
    if (!files.length) return { status: 409, error: tr('Nada para subir: a cópia não mudou nada desde a base.') };
    const diff = await this.deps.worktrees.diff(w);
    const secrets = findSecrets(files, diff);
    if (secrets.length) return { status: 409, error: tr('Não sobe: o diff tem o que parece segredo: {0}. Tire do commit (e troque a chave, se for real).', [secrets.slice(0, 10).join(', ')]) };
    const sum = await this.deps.worktrees.summary(w);
    const gate = run.items.some((i) => i.gate === 'fail') ? 'fail' : run.items.some((i) => i.gate === 'pass') ? 'pass' : 'none';
    const risk = finalRisk(run.items, diffRisk(diff, { reworked: run.items.some((i) => i.retried), extra: cfg.riskPaths, maxLines: cfg.riskLines, files }));
    return { folder: run.options.folder, owner: gh.owner, repo: gh.repo, remote, base, branch: w.branch, sha: c.sha, mode: cfg.ship, deploy: cfg.deploy ?? repoCfg?.deploy ?? 'none', ciMinutes: cfg.ciMinutes, stat: sum.stat, files: sum.files, added: sum.added, removed: sum.removed, gate, risky: riskyFiles(files), risk: risk.level, riskWhy: risk.why };
  }

  /**
   * Aprovado (PIN já conferido por quem chama): começa a subida do `sha` do cartão. Com `noCi`, é a aprovação extra do
   * merge num repo sem CI de PR (a subida já parada em needs='no-ci', no mesmo SHA).
   */
  async approve(id: string, b: { sha: string; noCi?: boolean; auto?: boolean }): Promise<{ run: ChatRun } | Fail> {
    const run = this.deps.runs.get(id);
    if (!run) return { status: 404, error: tr('lista não encontrada') };
    if (b.noCi) {
      const s = run.ship;
      if (!s || s.needs !== 'no-ci' || s.step !== 'ci') return { status: 409, error: tr('Esta subida não espera a aprovação de merge sem CI.') };
      if (s.sha !== b.sha) return { status: 409, error: tr('O SHA aprovado não é o desta subida.') };
      s.noCiApproved = true;
      delete s.needs;
      s.note = tr('Merge sem CI aprovado com PIN.');
      this.deps.runs.persist();
      void this.advance(run);
      return { run };
    }
    const p = await this.prepare(id);
    if ('error' in p) return p;
    if (p.sha !== b.sha) return { status: 409, error: tr('A cópia mudou depois do cartão (SHA {0}, aprovado {1}): prepare e aprove de novo.', [p.sha.slice(0, 12), String(b.sha).slice(0, 12)]) };
    const now = this.now();
    run.ship = { step: 'waiting', mode: p.mode === 'merge' ? 'merge' : 'pr', sha: p.sha, owner: p.owner, repo: p.repo, remote: p.remote, base: p.base, branch: p.branch, deploy: p.deploy, ciMinutes: p.ciMinutes, startedAt: now, stepAt: now, ...(b.auto ? { auto: true } : {}) };
    this.deps.runs.persist();
    void this.advance(run);
    return { run };
  }

  /** Anda o máximo que der agora (uma de cada vez por lista). */
  async advance(run: ChatRun): Promise<void> {
    if (this.busy.has(run.id)) return;
    this.busy.add(run.id);
    try {
      for (let guard = 0; guard < 10 && shipActive(run.ship); guard++) {
        const s = run.ship!;
        let out: Outcome;
        try {
          out = await this.step(run, s);
        } catch (err) {
          // Falha de rede ou do GitHub (5xx): quem espera tenta de novo no próximo relógio; o resto falha.
          const transient = err instanceof GitHubError && (err.status === 0 || err.status >= 500);
          if (transient && (s.step === 'ci' || s.step === 'deploying' || s.step === 'pr' || s.step === 'merging')) {
            s.note = err.message;
            out = 'wait';
          } else {
            this.fail(run, s, err instanceof GitHubError ? err.message : errMsg(err));
            out = 'end';
          }
        }
        this.deps.runs.persist();
        if (out !== 'next') break;
      }
    } finally {
      this.busy.delete(run.id);
    }
  }

  private go(s: RunShip, step: ShipStep): Outcome {
    s.step = step;
    s.stepAt = this.now();
    delete s.note;
    return 'next';
  }

  private async step(run: ChatRun, s: RunShip): Promise<Outcome> {
    const repo = { owner: s.owner, repo: s.repo };
    switch (s.step) {
      case 'waiting': {
        const b = this.blocker(run, s);
        if (b === 'failed') return this.fail(run, s, tr('O repo anterior do produto falhou ao subir: este não sobe (ordem server → web → app).'));
        if (b) {
          s.note = tr('Esperando {0} chegar a deployed (ordem server → web → app).', [b]);
          return 'wait';
        }
        return this.go(s, 'pushing');
      }
      case 'pushing': {
        const token = this.deps.token();
        const w = run.isolated;
        if (!token) return this.fail(run, s, tr('Sem token do GitHub: defina em Configurações > Token do GitHub.'));
        if (!w || w.discarded || w.merged) return this.fail(run, s, tr('A cópia isolada não existe mais.'));
        const r = await this.deps.worktrees.push(w, { url: `https://github.com/${s.owner}/${s.repo}.git`, sha: s.sha, token, baseBranch: s.base });
        if (!r.ok) return this.fail(run, s, r.reason);
        return this.go(s, 'pr');
      }
      case 'pr': {
        const gh = this.gh();
        if (!gh) return this.fail(run, s, tr('Sem token do GitHub: defina em Configurações > Token do GitHub.'));
        const [title, ...rest] = mergeMessage(run.items).split('\n');
        const body = [rest.join('\n').trim(), tr('Aberto pelo Habblaud ("Subir"), commit {0}.', [s.sha])].filter(Boolean).join('\n\n');
        const pr = await gh.openPr(repo, { head: s.branch, base: s.base, title, body });
        s.prNumber = pr.number;
        s.prUrl = pr.url;
        this.deps.runs.journalShipped(run, 'pr');
        this.settle(run, s.mode === 'pr' ? 'done' : 'review', 'pr');
        this.notify(run, s, s.auto ? 'auto' : 'pr');
        if (s.mode === 'pr') {
          s.stepAt = this.now();
          return 'end';
        }
        return this.go(s, 'ci');
      }
      case 'ci': {
        const gh = this.gh();
        if (!gh) return this.fail(run, s, tr('Sem token do GitHub: defina em Configurações > Token do GitHub.'));
        const v = ciVerdict(await gh.checks(repo, s.sha));
        s.ci = v;
        const waited = this.now() - s.stepAt;
        if (v === 'pass') return this.go(s, 'merging');
        if (v === 'fail') return this.fail(run, s, tr('O CI do PR falhou: corrija na cópia (comentários ao agente) e suba de novo.'), 'ci_fail');
        if (v === 'no-ci' && waited >= NO_CI_GRACE_MS) {
          if (s.noCiApproved) return this.go(s, 'merging');
          s.needs = 'no-ci';
          s.note = tr('Este repo não tem CI de PR; merge = deploy em produção. O merge espera a sua aprovação com PIN.');
          this.notify(run, s, 'no_ci');
          return 'wait';
        }
        if (waited > s.ciMinutes * 60_000) return this.fail(run, s, tr('O CI não terminou em {0} min (vboards.ciMinutes).', [s.ciMinutes]), 'ci_fail');
        return 'wait';
      }
      case 'merging': {
        const gh = this.gh();
        if (!gh || !s.prNumber) return this.fail(run, s, tr('Sem token do GitHub: defina em Configurações > Token do GitHub.'));
        // A trava: merge só com CI verde ou o no-ci aprovado com PIN, e só do SHA aprovado.
        if (s.mode !== 'merge' || (s.ci !== 'pass' && !s.noCiApproved)) return this.fail(run, s, tr('Merge recusado: sem CI verde nem aprovação de merge sem CI.'));
        const pr = await gh.pr(repo, s.prNumber);
        if (pr.merged) s.mergeSha = pr.mergeSha;
        else {
          if (pr.headSha && pr.headSha !== s.sha) return this.fail(run, s, tr('O PR mudou depois da aprovação (head {0}, aprovado {1}): merge recusado.', [pr.headSha.slice(0, 12), s.sha.slice(0, 12)]));
          s.mergeSha = await gh.mergePr(repo, s.prNumber, s.sha);
        }
        this.deps.runs.journalShipped(run, 'merged');
        this.settle(run, 'review', 'merged');
        return s.deploy.startsWith('workflow:') ? this.go(s, 'deploying') : this.deployed(run, s);
      }
      case 'deploying': {
        const gh = this.gh();
        if (!gh || !s.mergeSha) return this.fail(run, s, tr('Sem token do GitHub: defina em Configurações > Token do GitHub.'));
        const file = s.deploy.slice('workflow:'.length);
        const v = deployVerdict(await gh.workflowRuns(repo, file, s.base, s.mergeSha));
        if (v === 'pass') return this.deployed(run, s);
        if (v === 'fail') return this.fail(run, s, tr('O workflow de deploy {0} falhou na {1}.', [file, s.base]));
        if (this.now() - s.stepAt > s.ciMinutes * 60_000) return this.fail(run, s, tr('O workflow de deploy {0} não terminou em {1} min.', [file, s.ciMinutes]));
        return 'wait';
      }
      default:
        return 'end';
    }
  }

  /** Chegou a deployed: registro, VBoards, aviso, descarte da cópia e fast-forward do checkout local. */
  private async deployed(run: ChatRun, s: RunShip): Promise<Outcome> {
    s.step = 'deployed';
    s.stepAt = this.now();
    this.deps.runs.journalShipped(run, 'deployed');
    this.settle(run, 'done', 'deployed');
    this.notify(run, s, 'deployed');
    const notes: string[] = [];
    const w = run.isolated;
    if (w && !w.discarded && !w.merged) {
      const d = await this.deps.worktrees.discard(run.options.folder, w);
      if (d.ok) {
        w.discarded = true;
        for (const i of run.items) if (i.agentId) this.deps.restoreCwd?.(i.agentId);
      } else notes.push(tr('A cópia isolada não foi apagada: {0}', [d.reason]));
    }
    const ff = await this.deps.worktrees.fastForward(run.options.folder, s.remote, s.base).catch((err) => errMsg(err));
    if (ff) notes.push(ff);
    s.note = notes.join(' ') || tr('No ar. O checkout local foi atualizado.');
    return 'end';
  }

  private fail(run: ChatRun, s: RunShip, reason: string, stage: JournalStage = 'failed'): Outcome {
    s.failedAt = s.step;
    s.step = 'failed';
    s.stepAt = this.now();
    s.note = reason;
    delete s.needs;
    this.deps.runs.journalShipped(run, stage);
    this.settle(run, 'failed', stage, reason);
    this.notify(run, s, stage === 'ci_fail' ? 'ci_failed' : 'failed');
    return 'end';
  }

  /** Repo anterior do mesmo produto (server → web → app) que ainda não chegou a deployed: o nome dele, ou 'failed'. */
  private blocker(run: ChatRun, s: RunShip): string | 'failed' | undefined {
    const product = productOfFolder(run.options.folder, this.deps.products?.() ?? []);
    if (!product || product.repos.length < 2) return undefined;
    const rank = (folder: string) => ROLE_ORDER[product.repos.find((r) => samePath(r.path, folder))?.role ?? 'other'];
    const mine = rank(run.options.folder);
    for (const other of this.deps.runs.list()) {
      const o = other.ship;
      if (!o || other === run || o.mode !== 'merge' || samePath(other.options.folder, run.options.folder)) continue;
      if (!product.repos.some((r) => samePath(r.path, other.options.folder)) || rank(other.options.folder) >= mine) continue;
      if (o.startedAt > s.startedAt) continue;
      if (shipActive(o)) return basename(other.options.folder) || other.options.folder;
      if (o.step === 'failed' && o.stepAt >= s.startedAt) return 'failed';
    }
    return undefined;
  }

  private gh(): ShipGitHub | undefined {
    const token = this.deps.token();
    return token ? this.deps.github(token) : undefined;
  }

  /** stage + prUrl em todas as tarefas do VBoards da lista (as que terminaram). */
  private settle(run: ChatRun, state: 'done' | 'failed' | 'review', stage: string, summary?: string): void {
    const prUrl = run.ship?.prUrl;
    for (const i of run.items) {
      if (!i.vboardsTaskId || (i.state !== 'done' && i.state !== 'review')) continue;
      this.deps.vboards?.settle?.(i.vboardsTaskId, { state, stage, ...(prUrl ? { prUrl } : {}), ...(summary ? { summary } : {}) });
    }
  }

  /** Um aviso de cada tipo por subida (sobrevive a reinícios). */
  private notify(run: ChatRun, s: RunShip, event: ShipEvent): void {
    if (s.notified?.includes(event)) return;
    s.notified = [...(s.notified ?? []), event];
    this.deps.notify?.(basename(run.options.folder) || run.options.folder, event, s.prUrl);
  }

  /**
   * vboards.autoMerge=low: a lista automática que terminou é avaliada UMA vez (run.autoShip). Se autoShipBlock deixar
   * (antes pelo risco da IA, depois pelo do diff no cartão), sobe sem PIN; senão guarda o motivo e espera o PIN.
   */
  async autoShip(run: ChatRun): Promise<void> {
    // Marcada já no começo: um relógio seguinte não repete, e um reinício no meio deixa como estava (com PIN).
    run.autoShip = { at: this.now() };
    const blocked = (why: string) => {
      run.autoShip = { at: this.now(), blocked: why };
      this.deps.runs.persist();
    };
    const cfg = await this.deps.folderConfig(run.options.folder).catch(() => undefined);
    // Desligado: só fica marcada (ligar depois não sobe as listas antigas).
    if (cfg?.autoMerge !== 'low') return void this.deps.runs.persist();
    const pre = autoShipBlock(run, cfg, maxRisk(...run.items.map((i) => i.risk ?? 'medium')));
    if (pre) return blocked(pre);
    const p = await this.prepare(run.id);
    if ('error' in p) return blocked(p.error);
    const why = autoShipBlock(run, cfg, p.risk);
    if (why) return blocked(`${why} ${p.riskWhy.join('; ')}`.trim());
    const r = await this.approve(run.id, { sha: p.sha, auto: true });
    if ('error' in r) return blocked(r.error);
    this.deps.runs.journalShipped(run, 'auto');
  }
}

/**
 * Pura: por que esta lista NÃO sobe sozinha (sem PIN), ou undefined. Exige TODAS: vboards.autoMerge=low e ship=merge;
 * lista automática do VBoards; cada item com o plano aprovado no VBoards (approvedAt), em 'review', aprovado no portão
 * e sem volta de correção; risco final baixo. O CI verde é cobrado depois, na etapa 'ci' (no-ci nunca passa sem PIN).
 */
export function autoShipBlock(run: Pick<ChatRun, 'auto' | 'items'>, cfg: Pick<FolderConfig, 'ship' | 'autoMerge'>, risk: RiskLevel): string | undefined {
  if (cfg.autoMerge !== 'low') return tr('vboards.autoMerge desligado: sobe só com PIN.');
  if (cfg.ship !== 'merge') return tr('vboards.ship não é merge: sobe só com PIN.');
  if (!run.auto) return tr('Só a lista automática do VBoards (com portão) sobe sozinha.');
  if (run.items.some((i) => !i.vboardsTaskId || !i.approvedAt)) return tr('Plano sem aprovação registrada no VBoards (approvedAt): sobe só com PIN.');
  if (run.items.some((i) => i.state !== 'review' || i.gate !== 'pass')) return tr('Nem todo item passou no portão: sobe só com PIN.');
  if (run.items.some((i) => i.retried)) return tr('Um item precisou de volta de correção no portão: sobe só com PIN.');
  if (risk !== 'low') return tr('Risco {0}: sobe só com PIN.', [riskLabel(risk)]);
  return undefined;
}

const samePath = (a: string, b: string): boolean => a.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase() === b.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
