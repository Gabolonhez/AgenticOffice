// Cópia e personalização do molde (A7). A cópia leva só o que é código do molde: nada de node_modules, .git, .env,
// saídas de build, pastas nativas (o `expo prebuild` gera de novo a partir do app.json) nem credenciais do app base
// (google-services, chaves). A personalização é uma lista fechada de trocas por arquivo — campos de JSON e linhas
// inteiras de TS —, nunca uma regex solta no repo: o que não bate vira "não achei" para conferir, não um chute.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tr } from '../../shared/i18n';
import type { Brief, PartRole } from './brief';

/** Pastas que nunca vêm do molde (em qualquer nível). */
export const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', '.next', '.swc', '.expo', '.turbo', 'dist', 'build', 'coverage', '.gradle', 'Pods', 'android', 'ios', '.claude', '.playwright-mcp']);
/** Arquivos com credenciais do app base ou segredos locais. */
const SKIP_FILES = /^(\.env(\..*)?|google-services\.json|GoogleService-Info\.plist|google-service-account\.json|.*\.(tsbuildinfo|jks|p8|p12|key|pem|mobileprovision|keystore))$/i;

export const skipEntry = (name: string, dir: boolean): boolean => (dir ? SKIP_DIRS.has(name) : name !== '.env.example' && SKIP_FILES.test(name));

/**
 * Copia `src` para `dest` (que não pode existir). Copia numa pasta temporária ao lado e renomeia no fim: uma cópia que
 * caiu no meio não deixa `dest` pela metade, e a sobra é apagada na próxima tentativa. Links simbólicos ficam de fora.
 */
export function copyTemplate(src: string, dest: string): string | undefined {
  if (!existsSync(join(src, 'package.json'))) return tr('Molde não encontrado em {0}.', [src]);
  if (existsSync(dest)) return tr('A pasta {0} já existe: nada foi sobrescrito.', [dest]);
  const tmp = `${dest}.habblaud-tmp`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, tmp, {
    recursive: true,
    filter: (from) => {
      if (from === src) return true;
      const st = lstatSync(from);
      return !st.isSymbolicLink() && !skipEntry(basename(from), st.isDirectory());
    },
  });
  renameSync(tmp, dest);
  return undefined;
}

// ------------------------------------------------------------------ personalização

type Json = Record<string, unknown>;
interface JsonEdit { file: string; json: (o: Json, miss: (what: string) => void) => void }
interface LineEdit { file: string; lines: Array<[from: string, to: string]> }
type Edit = JsonEdit | LineEdit;

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** o[path...] = value, só se o caminho já existe no molde (campo sumido = "não achei"). */
function set(o: Json, path: string[], value: unknown, miss: (what: string) => void): void {
  let cur: unknown = o;
  for (const k of path.slice(0, -1)) cur = isObj(cur) ? cur[k] : undefined;
  const last = path[path.length - 1];
  if (isObj(cur) && last in cur) cur[last] = value;
  else miss(path.join('.'));
}

const q = (s: string) => JSON.stringify(s);

function packageEdits(name: string): Edit[] {
  return [
    { file: 'package.json', json: (o, miss) => set(o, ['name'], name, miss) },
    {
      file: 'package-lock.json',
      json: (o, miss) => {
        set(o, ['name'], name, miss);
        const root = isObj(o.packages) ? o.packages[''] : undefined;
        if (isObj(root)) set(root, ['name'], name, miss);
        else miss('packages[""].name');
      },
    },
  ];
}

/** As trocas de cada parte, com os valores do molde (app-base) que elas esperam encontrar. */
export function personalizeEdits(role: PartRole, b: Brief): Edit[] {
  const repo = `${b.slug}-${role}`;
  const { primary, secondary } = b.colors;
  if (role === 'app')
    return [
      ...packageEdits(repo),
      {
        file: 'app.json',
        json: (o, miss) => {
          set(o, ['expo', 'name'], b.name, miss);
          set(o, ['expo', 'slug'], b.slug, miss);
          set(o, ['expo', 'scheme'], b.slug, miss);
          set(o, ['expo', 'ios', 'bundleIdentifier'], b.bundleId, miss);
          set(o, ['expo', 'android', 'package'], b.bundleId, miss);
          const plugins = isObj(o.expo) && Array.isArray(o.expo.plugins) ? o.expo.plugins : [];
          const sentry = plugins.find((p): p is [string, Json] => Array.isArray(p) && p[0] === '@sentry/react-native/expo' && isObj(p[1]));
          if (sentry) set(sentry[1], ['project'], b.slug, miss);
          else miss('expo.plugins[@sentry/react-native/expo].project');
        },
      },
      {
        file: 'eas.json',
        json: (o, miss) => {
          for (const profile of ['preview', 'production']) set(o, ['build', profile, 'env', 'SENTRY_PROJECT'], b.slug, miss);
        },
      },
      {
        file: 'src/theme/colors/index.ts',
        lines: [
          ['primary: "#000000",', `primary: ${q(primary)},`],
          ['primary: "#FFFFFF",', `primary: ${q(primary)},`],
        ],
      },
    ];
  if (role === 'server') return packageEdits(repo);
  return [
    ...packageEdits(repo),
    {
      file: 'config/site.ts',
      lines: [
        ['name: "App Base",', `name: ${q(b.name)},`],
        ['shortName: "AppBase",', `shortName: ${q(b.name.replace(/\s+/g, ''))},`],
        ['androidPackage: "com.example.app",', `androidPackage: ${q(b.bundleId)},`],
        ['playStoreUrl: "https://play.google.com/store/apps/details?id=com.example.app",', `playStoreUrl: ${q(`https://play.google.com/store/apps/details?id=${b.bundleId}`)},`],
        ['iosBundleId: "com.example.app",', `iosBundleId: ${q(b.bundleId)},`],
        ['appScheme: "com.example.app",', `appScheme: ${q(b.slug)},`],
        ['primary: "#000000",', `primary: ${q(primary)},`],
        ...(secondary ? [['secondary: "#4F46E5",', `secondary: ${q(secondary)},`] as [string, string]] : []),
      ],
    },
    {
      file: 'public/.well-known/apple-app-site-association',
      json: (o, miss) => {
        const swap = (id: unknown) => (typeof id === 'string' && id.endsWith('.com.example.app') ? `${id.slice(0, -'com.example.app'.length)}${b.bundleId}` : id);
        const details = isObj(o.applinks) && Array.isArray(o.applinks.details) ? o.applinks.details : undefined;
        if (details?.length) {
          for (const d of details) if (isObj(d)) d.appID = swap(d.appID);
        } else miss('applinks.details');
        if (isObj(o.webcredentials) && Array.isArray(o.webcredentials.apps)) o.webcredentials.apps = o.webcredentials.apps.map(swap);
        else miss('webcredentials.apps');
      },
    },
    {
      file: 'public/.well-known/assetlinks.json',
      json: (o, miss) => {
        const first = Array.isArray(o.list) ? o.list[0] : undefined;
        if (isObj(first)) set(first, ['target', 'package_name'], b.bundleId, miss);
        else miss('[0].target.package_name');
      },
    },
  ];
}

const indentOf = (text: string): string | number => (/\n\t/.test(text) ? '\t' : (/\n( +)\S/.exec(text)?.[1].length ?? 2));

/**
 * Aplica as trocas da parte em `dir`. Devolve o que não bateu ("arquivo: campo") para conferir à mão; repetir é seguro
 * (o que já tem o valor novo não conta como falta). `dryRun` só confere (o teste contra o molde de verdade usa).
 */
export function personalize(dir: string, role: PartRole, b: Brief, o: { dryRun?: boolean } = {}): string[] {
  const misses: string[] = [];
  for (const e of personalizeEdits(role, b)) {
    const file = join(dir, e.file);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      misses.push(e.file);
      continue;
    }
    let out: string;
    if ('json' in e) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        misses.push(e.file);
        continue;
      }
      // assetlinks.json é uma lista: embrulhada para a edição.
      const wrapped = Array.isArray(parsed) ? { list: parsed } : (parsed as Json);
      e.json(wrapped, (what) => misses.push(`${e.file}: ${what}`));
      out = `${JSON.stringify(Array.isArray(parsed) ? wrapped.list : wrapped, null, indentOf(text))}${text.endsWith('\n') ? '\n' : ''}`;
    } else {
      const lines = text.split('\n');
      for (const [from, to] of e.lines) {
        let hit = false;
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].replace(/\r$/, '').trim();
          if (trimmed === from) {
            lines[i] = lines[i].replace(from, to);
            hit = true;
          } else if (trimmed === to) hit = true;
        }
        if (!hit) misses.push(`${e.file}: ${from}`);
      }
      out = lines.join('\n');
    }
    if (!o.dryRun && out !== text) writeFileSync(file, out);
  }
  return misses;
}

// ------------------------------------------------------------------ CI e EAS

/** Workflow de PR (o portão do pipeline: "CI vazio não é CI verde"). Os scripts que o pacote não tem são pulados. */
export function ciWorkflow(withPrisma: boolean): string {
  return [
    'name: CI',
    '',
    'on:',
    '  pull_request:',
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  check:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 22',
    '          cache: npm',
    '      - run: npm ci',
    ...(withPrisma ? ['      - run: npx prisma generate'] : []),
    '      - run: npm run typecheck --if-present',
    '      - run: npm run test --if-present',
    '      - run: npm run build --if-present',
    '',
  ].join('\n');
}

/** eas.json base (o do molde vem na cópia; este só entra se ele faltar). */
export const EAS_JSON = `${JSON.stringify(
  {
    cli: { version: '>= 14.1.2' },
    build: {
      development: { developmentClient: true, distribution: 'internal' },
      preview: { distribution: 'internal', channel: 'preview' },
      production: { autoIncrement: true, channel: 'production' },
    },
    submit: { production: {} },
  },
  null,
  2,
)}\n`;

/** Grava o CI de PR (e o eas.json do app, se faltar) sem sobrescrever o que já existe. Devolve os arquivos criados. */
export function writePipelineFiles(dir: string, role: PartRole): string[] {
  const made: string[] = [];
  const ci = join(dir, '.github', 'workflows', 'ci.yml');
  if (!existsSync(ci)) {
    mkdirSync(dirname(ci), { recursive: true });
    writeFileSync(ci, ciWorkflow(existsSync(join(dir, 'prisma'))));
    made.push('.github/workflows/ci.yml');
  }
  if (role === 'app' && !existsSync(join(dir, 'eas.json'))) {
    writeFileSync(join(dir, 'eas.json'), EAS_JSON);
    made.push('eas.json');
  }
  return made;
}
