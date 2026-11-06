import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadProducts, saveProducts } from '../vboards/products';
import { cardsFromSpec, parseBrief, slugify, type Brief } from './brief';
import { defaultProjectsRoot, ProjectsService, type ProjectsDeps } from './create';
import { createRepo } from './github-repo';
import { copyTemplate, personalize, writePipelineFiles } from './scaffold';

const BRIEF: Brief = { idea: 'Diário de treino', name: 'Treino Pro', slug: 'treino-pro', audience: 'quem treina', monetization: 'assinatura', parts: ['app', 'server', 'web'], bundleId: 'com.virex.treinopro', colors: { primary: '#FF5500', secondary: '#112233' } };

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'habblaud-proj-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const put = (file: string, text: string) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};

/** Um molde mínimo com os mesmos valores do app-base que a personalização procura. */
function fakeTemplate(root: string): string {
  const t = join(root, 'app-base');
  const pkg = (name: string) => `{\n\t"name": "${name}",\n\t"version": "1.0.0"\n}\n`;
  const lock = (name: string) => `{\n\t"name": "${name}",\n\t"lockfileVersion": 3,\n\t"packages": {\n\t\t"": {\n\t\t\t"name": "${name}"\n\t\t}\n\t}\n}\n`;
  put(join(t, 'base-app', 'package.json'), pkg('app-base'));
  put(join(t, 'base-app', 'package-lock.json'), lock('app-base'));
  put(join(t, 'base-app', 'app.json'), JSON.stringify({ expo: { name: 'app-base', slug: 'app-base', scheme: 'app-base', ios: { bundleIdentifier: 'com.lucasqueiroga.baseapp' }, android: { package: 'com.lucasqueiroga.baseapp' }, plugins: ['expo-router', ['@sentry/react-native/expo', { organization: 'o1', project: 'baseapp' }]] } }, null, '\t'));
  put(join(t, 'base-app', 'eas.json'), JSON.stringify({ build: { preview: { env: { SENTRY_PROJECT: 'REPLACE_SENTRY_PROJECT' } }, production: { env: { SENTRY_PROJECT: 'REPLACE_SENTRY_PROJECT' } } } }, null, '\t'));
  put(join(t, 'base-app', 'src', 'theme', 'colors', 'index.ts'), 'export const lightColors = {\n\tprimary: "#000000",\n\tsecondary: "#666666",\n\ttextSecondary: "#666666",\n};\nexport const darkColors = {\n\tprimary: "#FFFFFF",\n};\n');
  put(join(t, 'base-app', '.env'), 'SECRET=1');
  put(join(t, 'base-app', '.env.local'), 'SECRET=2');
  put(join(t, 'base-app', '.env.example'), 'SECRET=');
  put(join(t, 'base-app', 'google-services.json'), '{}');
  put(join(t, 'base-app', 'node_modules', 'x', 'index.js'), '');
  put(join(t, 'base-app', '.git', 'HEAD'), 'ref: refs/heads/main');
  put(join(t, 'base-app', 'android', 'build.gradle'), 'applicationId "com.lucasqueiroga.baseapp"');
  put(join(t, 'base-app', 'src', 'dist', 'keep.ts'), '');
  put(join(t, 'base-server', 'package.json'), pkg('appbase-server'));
  put(join(t, 'base-server', 'package-lock.json'), lock('appbase-server'));
  put(join(t, 'base-server', 'prisma', 'schema.prisma'), '');
  put(join(t, 'base-server', '.github', 'workflows', 'production.yml'), 'on:\n  push:\n    branches: [main]\njobs:\n  d:\n    steps:\n      - uses: appleboy/ssh-action@v1\n');
  put(join(t, 'base-app', '.github', 'workflows', 'deploy.yml'), 'on:\n  push:\n    branches: [main]\njobs:\n  d:\n    steps:\n      - run: eas build --profile production\n');
  put(join(t, 'base-web', 'package.json'), pkg('appbase-web').replace(/\t/g, '  '));
  put(join(t, 'base-web', 'package-lock.json'), lock('appbase-web'));
  put(join(t, 'base-web', '.next', 'cache'), '');
  put(
    join(t, 'base-web', 'config', 'site.ts'),
    [
      'export const site = {',
      '\tname: "App Base",',
      '\tshortName: "AppBase",',
      '\tandroidPackage: "com.example.app",',
      '\tplayStoreUrl: "https://play.google.com/store/apps/details?id=com.example.app",',
      '\tiosBundleId: "com.example.app",',
      '\tappScheme: "com.example.app",',
      '};',
      'export const colors = {',
      '\tprimary: "#000000",',
      '\tsecondary: "#4F46E5",',
      '};',
      '',
    ].join('\n'),
  );
  put(join(t, 'base-web', 'public', '.well-known', 'apple-app-site-association'), JSON.stringify({ applinks: { apps: [], details: [{ appID: 'TEAMID0000.com.example.app', paths: ['/open'] }] }, webcredentials: { apps: ['TEAMID0000.com.example.app'] } }, null, '\t'));
  put(join(t, 'base-web', 'public', '.well-known', 'assetlinks.json'), JSON.stringify([{ relation: ['x'], target: { namespace: 'android_app', package_name: 'com.example.app', sha256_cert_fingerprints: [] } }], null, '\t'));
  return t;
}

describe('briefing', () => {
  it('pergunta o que falta e valida o que veio', () => {
    const r = parseBrief({ idea: 'um app', name: 'X Y', bundleId: 'com.x', primaryColor: 'azul' });
    expect(r.brief).toBeUndefined();
    expect(r.questions.map((q) => q.key)).toEqual(['audience', 'monetization', 'parts']);
    expect(r.errors).toHaveLength(2);
    const ok = parseBrief({ ...BRIEF, slug: undefined, primaryColor: '#ff5500', secondaryColor: '#112233', parts: 'web app' });
    expect(ok.brief).toMatchObject({ slug: 'treino-pro', parts: ['app', 'web'], colors: { primary: '#FF5500' } });
    expect(slugify('Ação Fácil 2!')).toBe('acao-facil-2');
  });

  it('os cards iniciais saem da spec (editável) e só das partes escolhidas', () => {
    const svc = new ProjectsService(deps());
    const d = svc.draft({ ...BRIEF, parts: ['server'], primaryColor: '#FF5500' });
    expect('slug' in d).toBe(true);
    const spec = 'slug' in d ? d.spec : '';
    expect(cardsFromSpec(spec).every((c) => c.startsWith('[server]'))).toBe(true);
    expect(cardsFromSpec(`${spec}\n## Outra\n- fora`)).not.toContain('fora');
    expect(readFileSync(join(tmp, 'data', 'projects', 'treino-pro', 'spec.md'), 'utf8')).toBe(spec);
  });
});

describe('cópia do molde', () => {
  it('leva o código, sem node_modules, .git, .env, credenciais, build nem pastas nativas', () => {
    const t = fakeTemplate(tmp);
    const dest = join(tmp, 'out', 'treino-pro-app');
    expect(copyTemplate(join(t, 'base-app'), dest)).toBeUndefined();
    expect(existsSync(join(dest, 'app.json'))).toBe(true);
    expect(existsSync(join(dest, '.env.example'))).toBe(true);
    for (const gone of ['node_modules', '.git', '.env', '.env.local', 'google-services.json', 'android', join('src', 'dist')]) expect(existsSync(join(dest, gone)), gone).toBe(false);
    expect(existsSync(`${dest}.habblaud-tmp`)).toBe(false);
  });

  it('recusa sobrescrever uma pasta que já existe', () => {
    const t = fakeTemplate(tmp);
    const dest = join(tmp, 'out', 'x');
    put(join(dest, 'meu.txt'), 'meu');
    expect(copyTemplate(join(t, 'base-app'), dest)).toMatch(/já existe/);
    expect(readFileSync(join(dest, 'meu.txt'), 'utf8')).toBe('meu');
    expect(existsSync(join(dest, 'app.json'))).toBe(false);
  });
});

describe('personalização', () => {
  it('troca nome, slug, bundle id, package e cores, e repetir não muda nada', () => {
    const t = fakeTemplate(tmp);
    for (const role of ['app', 'server', 'web'] as const) {
      const dir = join(tmp, role);
      copyTemplate(join(t, `base-${role}`), dir);
      expect(personalize(dir, role, BRIEF)).toEqual([]);
      expect(personalize(dir, role, BRIEF)).toEqual([]);
    }
    const app = JSON.parse(readFileSync(join(tmp, 'app', 'app.json'), 'utf8'));
    expect(app.expo).toMatchObject({ name: 'Treino Pro', slug: 'treino-pro', scheme: 'treino-pro', ios: { bundleIdentifier: 'com.virex.treinopro' }, android: { package: 'com.virex.treinopro' } });
    expect(app.expo.plugins[1][1].project).toBe('treino-pro');
    expect(readFileSync(join(tmp, 'app', 'app.json'), 'utf8')).toContain('\n\t"expo"');
    expect(JSON.parse(readFileSync(join(tmp, 'app', 'package-lock.json'), 'utf8')).packages[''].name).toBe('treino-pro-app');
    const colors = readFileSync(join(tmp, 'app', 'src', 'theme', 'colors', 'index.ts'), 'utf8');
    expect(colors.match(/primary: "#FF5500"/g)).toHaveLength(2);
    expect(colors).toContain('textSecondary: "#666666"');
    expect(JSON.parse(readFileSync(join(tmp, 'server', 'package.json'), 'utf8')).name).toBe('treino-pro-server');
    expect(readFileSync(join(tmp, 'web', 'package.json'), 'utf8')).toContain('\n  "name": "treino-pro-web"');
    const site = readFileSync(join(tmp, 'web', 'config', 'site.ts'), 'utf8');
    for (const s of ['name: "Treino Pro"', 'shortName: "TreinoPro"', 'iosBundleId: "com.virex.treinopro"', 'appScheme: "treino-pro"', 'id=com.virex.treinopro"', 'secondary: "#112233"']) expect(site).toContain(s);
    expect(readFileSync(join(tmp, 'web', 'public', '.well-known', 'apple-app-site-association'), 'utf8')).toContain('TEAMID0000.com.virex.treinopro');
    expect(JSON.parse(readFileSync(join(tmp, 'web', 'public', '.well-known', 'assetlinks.json'), 'utf8'))[0].target.package_name).toBe('com.virex.treinopro');
  });

  it('o que o molde não tem vira "não achei", sem chute', () => {
    const t = fakeTemplate(tmp);
    writeFileSync(join(t, 'base-web', 'config', 'site.ts'), 'export const site = { name: "Outro" };\n');
    const dir = join(tmp, 'web');
    copyTemplate(join(t, 'base-web'), dir);
    expect(personalize(dir, 'web', BRIEF)).toContain('config/site.ts: name: "App Base",');
    expect(readFileSync(join(dir, 'config', 'site.ts'), 'utf8')).toBe('export const site = { name: "Outro" };\n');
  });

  const real = process.env.HABBLAUD_TEMPLATE_DIR || 'D:\\Projects\\app-base';
  it.skipIf(!existsSync(join(real, 'base-app', 'app.json')))('o molde de verdade tem tudo o que a personalização troca', () => {
    for (const role of ['app', 'server', 'web'] as const) expect(personalize(join(real, `base-${role}`), role, BRIEF, { dryRun: true }), role).toEqual([]);
  });

  it('CI de PR e eas.json sem sobrescrever', () => {
    const dir = join(tmp, 'srv');
    mkdirSync(join(dir, 'prisma'), { recursive: true });
    expect(writePipelineFiles(dir, 'server')).toEqual(['.github/workflows/ci.yml']);
    const ci = readFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(/on:\n {2}pull_request:/);
    expect(ci).toContain('npx prisma generate');
    expect(ci).toContain('npm run build --if-present');
    expect(writePipelineFiles(dir, 'server')).toEqual([]);
    expect(writePipelineFiles(join(tmp, 'app'), 'app')).toEqual(['.github/workflows/ci.yml', 'eas.json']);
  });
});

// ------------------------------------------------------------------ GitHub

type Call = { method: string; url: string; body?: Record<string, unknown> };
function fakeGithub(routes: Record<string, [number, unknown]>) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const u = String(url);
    calls.push({ method, url: u, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const [status, body] = routes[`${method} ${u.replace('https://api.github.com', '')}`] ?? [404, { message: 'Not Found' }];
    return new Response(JSON.stringify(body), { status });
  });
  return { fetchImpl: f as unknown as typeof fetch, calls };
}
const repoJson = (name: string, owner = 'Virex-Tech') => ({ html_url: `https://github.com/${owner}/${name}`, clone_url: `https://github.com/${owner}/${name}.git`, private: true });

describe('createRepo', () => {
  it('cria privado na organização (ou na conta do token)', async () => {
    const g = fakeGithub({ 'GET /user': [200, { login: 'gb' }], 'POST /orgs/Virex-Tech/repos': [201, repoJson('x-app')], 'POST /user/repos': [201, repoJson('x-app', 'gb')] });
    expect(await createRepo({ token: 't', owner: 'Virex-Tech', name: 'x-app', fetchImpl: g.fetchImpl })).toMatchObject({ ok: true, cloneUrl: 'https://github.com/Virex-Tech/x-app.git', existed: false });
    expect(g.calls[1].body).toMatchObject({ name: 'x-app', private: true });
    expect(await createRepo({ token: 't', owner: 'GB', name: 'x-app', fetchImpl: g.fetchImpl })).toMatchObject({ ok: true });
    expect(g.calls[3].url).toBe('https://api.github.com/user/repos');
  });

  it('403 (sem Administration: write) e sem token viram passo manual com a instrução', async () => {
    const g = fakeGithub({ 'GET /user': [200, { login: 'gb' }], 'POST /orgs/Virex-Tech/repos': [403, { message: 'Resource not accessible by personal access token' }] });
    const r = await createRepo({ token: 't', owner: 'Virex-Tech', name: 'x-app', fetchImpl: g.fetchImpl });
    expect('manual' in r && r.manual).toMatch(/Administration: write.*github\.com\/new.*git remote add origin https:\/\/github\.com\/Virex-Tech\/x-app\.git/s);
    expect(await createRepo({ token: undefined, owner: 'Virex-Tech', name: 'x-app', fetchImpl: g.fetchImpl })).toHaveProperty('manual');
  });

  it('nome já usado por um repo privado conta como feito', async () => {
    const g = fakeGithub({ 'GET /user': [200, { login: 'gb' }], 'POST /orgs/Virex-Tech/repos': [422, { message: 'name already exists' }], 'GET /repos/Virex-Tech/x-app': [200, repoJson('x-app')] });
    expect(await createRepo({ token: 't', owner: 'Virex-Tech', name: 'x-app', fetchImpl: g.fetchImpl })).toMatchObject({ ok: true, existed: true });
  });
});

// ------------------------------------------------------------------ criação

function deps(over: Partial<ProjectsDeps> = {}): ProjectsDeps {
  const productsFile = join(tmp, 'products.json');
  return {
    dataDir: join(tmp, 'data'),
    projectsRoot: () => join(tmp, 'Projects'),
    templateDir: () => join(tmp, 'app-base'),
    githubToken: () => 'tok',
    products: { load: () => loadProducts(productsFile), save: (raw) => saveProducts(productsFile, raw) },
    writeFolderConfig: vi.fn(async () => undefined),
    ...over,
  };
}

describe('ProjectsService', () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' })) vi.stubEnv(k, v);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('cria tudo: cópia, personalização, CI, git, GitHub, registro, VBoards e agente', async () => {
    fakeTemplate(tmp);
    const g = fakeGithub({ 'GET /user': [200, { login: 'gb' }], 'POST /orgs/Virex-Tech/repos': [201, repoJson('treino-pro-app')] });
    const createCard = vi.fn(async (_body: Record<string, unknown>) => ({ card: { id: 'c1' } }));
    const openAgent = vi.fn(async () => ({ agentId: 'chat:1' }));
    const d = deps({ fetchImpl: g.fetchImpl, vboards: { enabled: true, createCard } as never, openAgent });
    const svc = new ProjectsService(d);
    svc.draft({ ...BRIEF, parts: ['app'], primaryColor: '#FF5500' });
    const r = svc.start('treino-pro', { github: true, githubOwner: 'Virex-Tech', vboards: true, agent: true });
    if ('error' in r) throw new Error(r.error);
    const end = await r.done;
    expect(end.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['copy:done', 'personalize:done', 'ci:done', 'deploy:manual', 'git:done', 'github:done', 'register:done', 'vboards:done', 'agent:done']);
    const repo = join(tmp, 'Projects', 'treino-pro', 'treino-pro-app');
    expect(execFileSync('git', ['log', '--format=%s'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('chore: projeto Treino Pro criado a partir do molde app-base');
    expect(execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' })).toContain('.github/workflows/ci.yml');
    expect(execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, encoding: 'utf8' }).trim()).toBe('https://github.com/Virex-Tech/treino-pro-app.git');
    expect(loadProducts(join(tmp, 'products.json')).products).toEqual([{ id: 'treino-pro', name: 'Treino Pro', cardName: 'Treino Pro', repos: [{ path: repo, role: 'app', store: 'off' }] }]);
    expect(d.writeFolderConfig).toHaveBeenCalledWith(repo, expect.objectContaining({ ship: 'off', auto: 'false' }));
    expect(createCard.mock.calls[0][0]).toMatchObject({ title: 'Treino Pro', subtasks: expect.arrayContaining([expect.stringMatching(/^\[app\]/)]) });
    expect(openAgent).toHaveBeenCalledWith(repo, expect.stringContaining('spec.md'));
    expect(svc.state('treino-pro')?.steps.find((s) => s.id === 'deploy')?.note).toMatch(/secrets e host próprios.*docs\/deploy-templates/);
  });

  it('retoma do passo que falhou sem refazer o que está feito; GitHub 403 fica manual', async () => {
    fakeTemplate(tmp);
    const g = fakeGithub({ 'GET /user': [200, { login: 'gb' }], 'POST /orgs/Virex-Tech/repos': [403, { message: 'nope' }] });
    let broken = true;
    const writeFolderConfig = vi.fn(async () => (broken ? 'git config travou' : undefined));
    const svc = new ProjectsService(deps({ fetchImpl: g.fetchImpl, writeFolderConfig }));
    svc.draft({ ...BRIEF, parts: ['app', 'server'], primaryColor: '#FF5500' });
    const opts = { github: true, githubOwner: 'Virex-Tech', vboards: false, agent: false };
    const first = svc.start('treino-pro', opts);
    if ('error' in first) throw new Error(first.error);
    const a = await first.done;
    expect(a.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'manual', 'done', 'manual', 'failed', 'pending', 'pending']);
    expect(a.steps[5].note).toMatch(/Administration: write/);
    // Uma nova instância (reinício) lê o create.json: a cópia não é refeita (refazer recusaria, as pastas existem).
    broken = false;
    const again = new ProjectsService(deps({ fetchImpl: g.fetchImpl, writeFolderConfig })).start('treino-pro', opts);
    if ('error' in again) throw new Error(again.error);
    const b = await again.done;
    expect(b.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'manual', 'done', 'manual', 'done', 'skipped', 'skipped']);
    expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: join(tmp, 'Projects', 'treino-pro', 'treino-pro-server'), encoding: 'utf8' }).trim()).toBe('1');
    // Nenhum workflow ativo publica: só o CI de pull request; os de deploy do molde ficam como modelo desativado.
    for (const role of ['app', 'server']) {
      const repo = join(tmp, 'Projects', 'treino-pro', `treino-pro-${role}`);
      expect(readdirSync(join(repo, '.github', 'workflows'))).toEqual(['ci.yml']);
      const ci = readFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'utf8');
      expect(ci).not.toMatch(/push:|ssh|deploy|eas (build|submit)|secrets\./);
      expect(readdirSync(join(repo, 'docs', 'deploy-templates')).length).toBe(1);
    }
  });

  it('recusa começar numa pasta de produto que já existe', () => {
    fakeTemplate(tmp);
    put(join(tmp, 'Projects', 'treino-pro', 'algo.txt'), 'x');
    const svc = new ProjectsService(deps());
    svc.draft({ ...BRIEF, primaryColor: '#FF5500' });
    expect(svc.start('treino-pro', { github: false, vboards: false, agent: false })).toMatchObject({ error: expect.stringMatching(/já existe/) });
  });

  it('pasta-mãe padrão: a mais comum entre os produtos registrados', () => {
    expect(defaultProjectsRoot(['D:\\Projects\\peptpro\\helix-app', 'D:\\Projects\\peptpro\\helix-server', 'E:\\x\\y\\z'])).toBe('D:\\Projects');
    expect(defaultProjectsRoot([])).toBeUndefined();
  });
});
