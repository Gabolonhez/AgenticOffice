// Projeto novo a partir do molde (A7): o briefing (brief.ts) e a criação em passos retomáveis. O estado de cada passo
// fica em <dataDir>/projects/<slug>/create.json: rodar de novo pula o que está feito e tenta o resto (manual e falha
// incluídos). Um passo que falha para a sequência; "manual" (ex.: token sem permissão no GitHub) não para. Nada aqui
// faz push, deploy nem cria projeto no EAS. Quem chama já passou pelo PIN (cartão crítico do Jarvis ou a rota com pin).
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { maskSecrets } from '../../shared/activity';
import { tr } from '../../shared/i18n';
import type { VBoardsApi } from '../vboards/api';
import type { Product, ProductRepo } from '../vboards/products';
import type { FolderKey } from '../vboards/vboards';
import { cardsFromSpec, listDrafts, loadBrief, loadSpec, parseBrief, projectDir, repoName, saveDraft, saveSpec, SLUG_RE, type Brief, type BriefQuestion, type PartRole } from './brief';
import { createRepo, OWNER_RE } from './github-repo';
import { copyTemplate, DEPLOY_TEMPLATES, personalize, writePipelineFiles } from './scaffold';

export const STEP_IDS = ['copy', 'personalize', 'ci', 'deploy', 'git', 'github', 'register', 'vboards', 'agent'] as const;
export type StepId = (typeof STEP_IDS)[number];
export type StepStatus = 'pending' | 'running' | 'done' | 'manual' | 'skipped' | 'failed';

export interface CreateStep {
  id: StepId;
  status: StepStatus;
  note?: string;
  /** Partes já feitas dentro do passo (cópia, git, GitHub): a retomada não refaz. */
  roles?: PartRole[];
  at?: number;
}

export interface CreateOptions {
  github: boolean;
  githubOwner?: string;
  vboards: boolean;
  /** Abrir um agente (Claude, pedindo aprovação) no repo principal: a sala nova aparece no escritório. */
  agent: boolean;
}

export interface CreateState {
  v: 1;
  slug: string;
  name: string;
  root: string;
  template: string;
  repos: Array<{ role: PartRole; path: string }>;
  options: CreateOptions;
  steps: CreateStep[];
  startedAt: number;
  updatedAt: number;
  running?: boolean;
}

type GitRun = (args: string[], cwd: string) => Promise<{ ok: true; out: string } | { ok: false; error: string }>;

export interface ProjectsDeps {
  dataDir: string;
  templateDir: () => string | undefined;
  projectsRoot: () => string | undefined;
  githubToken: () => string | undefined;
  githubOwner?: () => string | undefined;
  fetchImpl?: typeof fetch;
  git?: GitRun;
  products: { load(): { products: Product[]; error?: string }; save(raw: unknown): { products: Product[] } | { error: string } };
  writeFolderConfig: (folder: string, values: Partial<Record<FolderKey, string>>) => Promise<string | undefined>;
  vboards?: Pick<VBoardsApi, 'enabled' | 'createCard'>;
  openAgent?: (folder: string, prompt: string) => Promise<{ agentId: string } | { reason: string }>;
  now?: () => number;
}

const ORDER: PartRole[] = ['app', 'server', 'web'];

export const gitRun: GitRun = (args, cwd) =>
  new Promise((ok) =>
    execFile('git', args, { cwd, timeout: 120_000, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } }, (e, out, err) =>
      ok(e ? { ok: false, error: maskSecrets((err || e.message).trim()).slice(0, 500) } : { ok: true, out: out.trim() }),
    ),
  );

/** Pasta-mãe dos produtos registrados (a mais comum entre os avôs dos repos: D:\Projects\peptpro\helix-app → D:\Projects). */
export function defaultProjectsRoot(repoPaths: readonly string[]): string | undefined {
  const count = new Map<string, number>();
  for (const p of repoPaths) {
    // Os dois separadores: o registro pode ter caminhos do Windows mesmo com o teste rodando no Linux.
    const root = p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]+[\\/][^\\/]+$/, '');
    if (!root || root === p) continue;
    count.set(root, (count.get(root) ?? 0) + 1);
  }
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function parseOptions(raw: unknown, defaultOwner?: string): CreateOptions | { error: string } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const github = o.github === true;
  const owner = (typeof o.githubOwner === 'string' && o.githubOwner.trim()) || defaultOwner || '';
  if (github && !OWNER_RE.test(owner)) return { error: tr('Diga o dono (usuário ou organização) do GitHub.') };
  return { github, ...(github ? { githubOwner: owner } : {}), vboards: o.vboards === true, agent: o.agent === true };
}

export class ProjectsService {
  private readonly running = new Set<string>();
  private readonly now: () => number;
  private readonly git: GitRun;

  constructor(private readonly deps: ProjectsDeps) {
    this.now = deps.now ?? Date.now;
    this.git = deps.git ?? gitRun;
  }

  // ------------------------------------------------------------------ briefing

  /** As perguntas do que falta, ou o briefing salvo com a spec (o slug não pode ser de produto já registrado). */
  draft(raw: unknown): { questions: BriefQuestion[]; errors: string[] } | { slug: string; brief: Brief; spec: string } {
    const r = parseBrief(raw);
    if (!r.brief) return { questions: r.questions, errors: r.errors };
    const b = r.brief;
    if (this.deps.products.load().products.some((p) => p.id === b.slug)) return { questions: [], errors: [tr('Já existe um produto {0} no registro.', [b.slug])] };
    const st = this.state(b.slug);
    // Começou a criar: o briefing fica como está (as pastas já seguem ele); só a retomada continua.
    if (st?.steps.some((s) => s.status !== 'pending' || s.roles?.length)) return { questions: [], errors: [tr('O projeto {0} já começou a ser criado: retome a criação em vez de refazer o briefing.', [b.slug])] };
    if (st) rmSync(join(projectDir(this.deps.dataDir, b.slug), 'create.json'), { force: true });
    return { slug: b.slug, brief: b, spec: saveDraft(this.deps.dataDir, b) };
  }

  saveSpec(slug: string, md: unknown): string | undefined {
    return saveSpec(this.deps.dataDir, slug, typeof md === 'string' ? md : '');
  }

  list(): Array<{ slug: string; name: string; state?: CreateState }> {
    return listDrafts(this.deps.dataDir).map((slug) => ({ slug, name: loadBrief(this.deps.dataDir, slug)!.name, ...(this.state(slug) ? { state: this.state(slug) } : {}) }));
  }

  get(slug: string): { brief: Brief; spec: string; state: CreateState } | undefined {
    const brief = loadBrief(this.deps.dataDir, slug);
    if (!brief) return undefined;
    const plan = this.plan(slug, { github: false, vboards: false, agent: false });
    return { brief, spec: loadSpec(this.deps.dataDir, slug), state: this.state(slug) ?? ('error' in plan ? this.emptyState(brief, '', '') : plan) };
  }

  // ------------------------------------------------------------------ criação

  state(slug: string): CreateState | undefined {
    if (!SLUG_RE.test(slug)) return undefined;
    try {
      const s = JSON.parse(readFileSync(join(projectDir(this.deps.dataDir, slug), 'create.json'), 'utf8')) as CreateState;
      return s?.v === 1 && s.slug === slug && Array.isArray(s.steps) ? { ...s, running: this.running.has(slug) } : undefined;
    } catch {
      return undefined;
    }
  }

  private emptyState(b: Brief, root: string, template: string, options: CreateOptions = { github: false, vboards: false, agent: false }): CreateState {
    const repos = ORDER.filter((r) => b.parts.includes(r)).map((role) => ({ role, path: root ? join(root, b.slug, repoName(b.slug, role)) : '' }));
    const now = this.now();
    return { v: 1, slug: b.slug, name: b.name, root, template, repos, options, steps: STEP_IDS.map((id) => ({ id, status: 'pending' })), startedAt: now, updatedAt: now };
  }

  /** O que vai ser feito (o estado salvo, se já começou; senão, um novo) com as opções pedidas: os fatos do cartão. */
  plan(slug: string, options: CreateOptions): CreateState | { error: string } {
    const b = loadBrief(this.deps.dataDir, slug);
    if (!b) return { error: tr('Projeto não encontrado: faça o briefing antes.') };
    const saved = this.state(slug);
    if (saved) return { ...saved, options };
    const root = this.deps.projectsRoot();
    const template = this.deps.templateDir();
    if (!root || !isAbsolute(root)) return { error: tr('Pasta dos projetos desconhecida: defina HABBLAUD_PROJECTS_ROOT.') };
    if (!template || !isAbsolute(template)) return { error: tr('Molde desconhecido: defina HABBLAUD_TEMPLATE_DIR (a pasta do app-base).') };
    return this.emptyState(b, root, template, options);
  }

  /** Fatos do cartão crítico (montados aqui, nunca pelo pedido). */
  facts(st: CreateState): string[] {
    const o = st.options;
    return [
      tr('Criar o projeto {0} a partir do molde {1}', [st.name, st.template]),
      ...st.repos.map((r) => tr('Repo {0}: {1}', [r.role, r.path])),
      o.github ? tr('GitHub: criar repositórios PRIVADOS em {0} e o remote origin (sem push)', [o.githubOwner ?? '']) : tr('GitHub: não'),
      tr('Registro: products.json e vboards.* de cada repo (ship=off, auto=false)'),
      o.vboards ? tr('VBoards: card do produto com os cards iniciais da spec') : tr('VBoards: não'),
      o.agent ? tr('Abrir um agente Claude (pede aprovação a cada ação) no repo principal') : tr('Agente: não'),
      tr('Já feito: {0}', [st.steps.filter((s) => s.status === 'done').map((s) => s.id).join(', ') || tr('nada')]),
    ];
  }

  private save(st: CreateState): void {
    st.updatedAt = this.now();
    const file = join(projectDir(this.deps.dataDir, st.slug), 'create.json');
    const { running: _r, ...rest } = st;
    writeFileSync(`${file}.tmp`, `${JSON.stringify(rest, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  /**
   * Cria (ou retoma). Devolve o estado inicial já gravado e a promessa do fim. Um projeto por vez por slug.
   * SÓ chame depois do PIN.
   */
  start(slug: string, options: CreateOptions): { state: CreateState; done: Promise<CreateState> } | { error: string } {
    if (this.running.has(slug)) return { error: tr('A criação de {0} já está rodando.', [slug]) };
    const p = this.plan(slug, options);
    if ('error' in p) return p;
    const b = loadBrief(this.deps.dataDir, slug)!;
    const fresh = !this.state(slug);
    if (fresh && existsSync(join(p.root, slug)) && readdirSync(join(p.root, slug)).length) return { error: tr('A pasta {0} já existe e não está vazia: nada foi feito.', [join(p.root, slug)]) };
    if (fresh && this.deps.products.load().products.some((x) => x.id === slug)) return { error: tr('Já existe um produto {0} no registro.', [slug]) };
    this.running.add(slug);
    this.save(p);
    const done = this.run(p, b).finally(() => this.running.delete(slug));
    return { state: { ...p, running: true }, done };
  }

  private async run(st: CreateState, b: Brief): Promise<CreateState> {
    for (const step of st.steps) {
      if (step.status === 'done' || (step.status === 'skipped' && !this.wanted(step.id, st.options))) continue;
      step.status = 'running';
      delete step.note;
      this.save(st);
      try {
        const r = await this.step(step, st, b);
        step.status = r.status;
        if (r.note) step.note = maskSecrets(r.note).slice(0, 2000);
      } catch (err) {
        step.status = 'failed';
        step.note = maskSecrets(err instanceof Error ? err.message : String(err)).slice(0, 2000);
      }
      step.at = this.now();
      this.save(st);
      if (step.status === 'failed') break;
    }
    return { ...st, running: false };
  }

  private wanted(id: StepId, o: CreateOptions): boolean {
    return id === 'github' ? o.github : id === 'vboards' ? o.vboards : id === 'agent' ? o.agent : true;
  }

  private async step(step: CreateStep, st: CreateState, b: Brief): Promise<{ status: StepStatus; note?: string }> {
    const done = (step.roles ??= []);
    const each = async (fn: (r: { role: PartRole; path: string }) => Promise<string | undefined> | string | undefined): Promise<string | undefined> => {
      for (const r of st.repos) {
        if (done.includes(r.role)) continue;
        const err = await fn(r);
        if (err) return err;
        done.push(r.role);
        this.save(st);
      }
      return undefined;
    };
    switch (step.id) {
      case 'copy': {
        const err = await each((r) => copyTemplate(join(st.template, `base-${r.role}`), r.path));
        return err ? { status: 'failed', note: err } : { status: 'done' };
      }
      case 'personalize': {
        const misses = st.repos.flatMap((r) => personalize(r.path, r.role, b).map((m) => `${r.role}/${m}`));
        return misses.length ? { status: 'manual', note: tr('Personalizado, mas não achei no molde (confira à mão): {0}', [misses.slice(0, 12).join('; ')]) } : { status: 'done' };
      }
      case 'ci': {
        const made = st.repos.flatMap((r) => writePipelineFiles(r.path, r.role).map((f) => `${r.role}/${f}`));
        return { status: 'done', ...(made.length ? { note: made.join(', ') } : {}) };
      }
      case 'deploy': {
        // O deploy é do dono: secrets e host próprios. Os workflows do molde apontam para o servidor do app base.
        const parked = st.repos.filter((r) => existsSync(join(r.path, DEPLOY_TEMPLATES))).map((r) => `${r.role}/docs/deploy-templates`);
        return { status: 'manual', note: tr('Configurar o deploy: secrets e host próprios. Os workflows de deploy do molde não foram ativados{0}.', [parked.length ? tr(' (modelos em {0})', [parked.join(', ')]) : '']) };
      }
      case 'git': {
        const err = await each(async (r) => {
          if (!existsSync(join(r.path, '.git'))) {
            const i = await this.git(['init', '-b', 'main'], r.path);
            if (!i.ok) return i.error;
          }
          if ((await this.git(['rev-parse', '--verify', '-q', 'HEAD'], r.path)).ok) return undefined;
          for (const args of [['add', '-A'], ['commit', '-q', '-m', `chore: projeto ${b.name} criado a partir do molde app-base`]]) {
            const g = await this.git(args, r.path);
            if (!g.ok) return tr('git {0} em {1}: {2}', [args[0], r.path, g.error]);
          }
          return undefined;
        });
        return err ? { status: 'failed', note: err } : { status: 'done' };
      }
      case 'github': {
        if (!st.options.github) return { status: 'skipped' };
        const owner = st.options.githubOwner ?? '';
        const notes: string[] = [];
        const err = await each(async (r) => {
          const name = repoName(b.slug, r.role);
          const c = await createRepo({ token: this.deps.githubToken(), owner, name, description: b.idea, fetchImpl: this.deps.fetchImpl });
          if ('error' in c) return c.error;
          if ('manual' in c) {
            notes.push(c.manual);
            return 'manual';
          }
          const cur = await this.git(['remote', 'get-url', 'origin'], r.path);
          if (!cur.ok) {
            const a = await this.git(['remote', 'add', 'origin', c.cloneUrl], r.path);
            if (!a.ok) return a.error;
          } else if (cur.out !== c.cloneUrl) notes.push(tr('{0} já tem um origin ({1}); o repositório criado é {2}.', [r.path, cur.out, c.cloneUrl]));
          notes.push(tr('{0}: {1} (o primeiro push, git push -u origin main, é seu)', [r.role, c.url]));
          return undefined;
        });
        if (err === 'manual') return { status: 'manual', note: notes.join('\n') };
        return err ? { status: 'failed', note: err } : { status: 'done', note: notes.join('\n') };
      }
      case 'register': {
        const reg = this.deps.products.load();
        if (reg.error) return { status: 'failed', note: reg.error };
        const repos: ProductRepo[] = st.repos.map((r) => ({ path: r.path, role: r.role, ...(r.role === 'app' ? { store: 'off' as const } : {}) }));
        const same = (p: Product) => p.repos.length === repos.length && p.repos.every((x, i) => x.path === repos[i].path);
        const existing = reg.products.find((p) => p.id === b.slug);
        if (existing && !same(existing)) return { status: 'failed', note: tr('Já existe um produto {0} no registro, com outros repositórios.', [b.slug]) };
        if (!existing) {
          const saved = this.deps.products.save({ products: [...reg.products, { id: b.slug, name: b.name, cardName: b.name, repos }] });
          if ('error' in saved) return { status: 'failed', note: saved.error };
        }
        for (const r of st.repos) {
          const err = await this.deps.writeFolderConfig(r.path, { card: b.name, auto: 'false', ship: 'off', base: 'main', remote: 'origin' });
          if (err) return { status: 'failed', note: tr('vboards.* em {0}: {1}', [r.path, err]) };
        }
        return { status: 'done' };
      }
      case 'vboards': {
        if (!st.options.vboards) return { status: 'skipped' };
        if (!this.deps.vboards?.enabled) return { status: 'manual', note: tr('VBoards sem token vb_: crie o card {0} à mão com as subtarefas da seção "Cards iniciais" da spec.', [b.name]) };
        const spec = loadSpec(this.deps.dataDir, b.slug);
        const subtasks = cardsFromSpec(spec).map((s) => maskSecrets(s));
        const r = await this.deps.vboards.createCard({ title: maskSecrets(b.name), description: maskSecrets(`${b.idea}\n\n${tr('Spec: {0}', [join(projectDir(this.deps.dataDir, b.slug), 'spec.md')])}`).slice(0, 10_000), ...(subtasks.length ? { subtasks } : {}) });
        const id = (r.card as { id?: unknown } | undefined)?.id;
        return { status: 'done', note: tr('Card {0} com {1} subtarefas. A API do VBoards não cria projetos: se quiser agrupar as tarefas, crie o projeto à mão.', [typeof id === 'string' ? id : b.name, subtasks.length]) };
      }
      case 'agent': {
        if (!st.options.agent) return { status: 'skipped' };
        const main = st.repos[0];
        if (!this.deps.openAgent || !main) return { status: 'manual', note: tr('Chat com agentes desligado: abra um agente em {0} pelo Novo agente.', [main?.path ?? st.root]) };
        const spec = join(projectDir(this.deps.dataDir, b.slug), 'spec.md');
        const r = await this.deps.openAgent(main.path, tr('Projeto novo {0}, criado agora a partir do molde app-base. Leia a spec em {1} e o PLAYBOOK.md do molde em {2}. Liste o que falta para a Fase 4 (chaves, contas e o que é manual) e espere o dono antes de mudar qualquer arquivo.', [b.name, spec, st.template]));
        return 'agentId' in r ? { status: 'done', note: r.agentId } : { status: 'manual', note: r.reason };
      }
    }
  }
}
