// Risco de uma tarefa (A4): `diffRisk` lê o diff unificado e decide, de forma determinística, low | medium | high com
// os motivos. O risco final é o maior entre o da IA (Refinar/triagem, vindo do VBoards) e o calculado aqui: o calculado
// nunca é rebaixado. Vai para o relatório do portão (runs.ts) e para o cartão do "Subir" (ship.ts), e só 'low' deixa a
// lista subir sozinha (vboards.autoMerge=low).
import { tr } from '../../shared/i18n';
import type { RiskLevel } from '../../shared/runs';

/** vboards.riskLines: acima disto (linhas + e -) o diff é no mínimo 'medium'. */
export const DEFAULT_RISK_LINES = 300;

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
export const maxRisk = (...r: RiskLevel[]): RiskLevel => r.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'low');
export const riskLabel = (r: RiskLevel): string => (r === 'low' ? tr('baixo') : r === 'medium' ? tr('médio') : tr('alto'));

/** O risco que a IA devolveu (texto livre do JSON): aceita pt/en; ausente ou estranho = 'medium'. */
export function parseRisk(v: unknown): RiskLevel {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (s === 'low' || s === 'baixo') return 'low';
  if (s === 'high' || s === 'alto') return 'high';
  return 'medium';
}

export interface DiffRiskOpts {
  /** vboards.riskLines (padrão DEFAULT_RISK_LINES). */
  maxLines?: number;
  /** O portão mandou corrigir (volta de correção). */
  reworked?: boolean;
  /** vboards.riskPaths: globs extras que contam como 'high' (sem `/` = só o nome do arquivo). */
  extra?: readonly string[];
  /**
   * Os arquivos mudados (`git diff --name-only`): o que falta no texto do diff (cortado, grande demais) passa pelas
   * mesmas regras, e o que dependeria do conteúdo (package.json, app.json) conta como alto.
   */
  files?: readonly string[];
}

export interface RiskVerdict {
  level: RiskLevel;
  why: string[];
}

const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'podfile.lock', 'gemfile.lock', 'cargo.lock', 'poetry.lock', 'composer.lock', 'go.sum', 'pubspec.lock', 'gradle.lockfile']);
/** Manifestos de dependência que contam inteiros (o package.json e o app.json olham o que mudou). */
const MANIFESTS = new Set(['podfile', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'requirements.txt', 'gemfile', 'go.mod', 'cargo.toml', 'pyproject.toml', 'composer.json', 'pubspec.yaml', 'eas.json']);
const SENSITIVE = /auth|billing|payment|paywall|subscription|stripe|superwall|revenuecat/i;
const APP_CONFIG = /^app\.(json|config\.(js|ts|cjs|mjs|json))$/;
const PKG_DEP_KEY = /"(dependencies|devDependencies|peerDependencies|optionalDependencies|bundledDependencies|overrides|resolutions|engines|packageManager)"/;
/** `"nome": "versão"` (dependência), fora de "version". */
const PKG_DEP_LINE = /^\s*"(?!version")[@\w./-]+"\s*:\s*"(\^|~|[<>=]|\d|\*|latest|workspace:|file:|link:|npm:|git|https?:|github:)/;

interface FileDiff {
  paths: string[];
  /** Linhas + e - (sem os cabeçalhos ---/+++). */
  changed: string[];
  /** O texto inteiro do trecho (contexto incluído). */
  text: string;
}

function splitDiff(diff: string): FileDiff[] {
  const out: FileDiff[] = [];
  let cur: FileDiff | undefined;
  for (const line of diff.split(/\r?\n/)) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      out.push((cur = { paths: [...new Set([m[1], m[2]])], changed: [], text: '' }));
      continue;
    }
    if (!cur) continue;
    cur.text += `${line}\n`;
    if ((line.startsWith('+') && !line.startsWith('+++ ')) || (line.startsWith('-') && !line.startsWith('--- '))) cur.changed.push(line.slice(1));
  }
  return out;
}

/** Glob simples (`**`, `*`, `?`) para regex; sem `/` casa só o nome do arquivo (como no .gitignore). */
export function globToRegex(glob: string): RegExp {
  const g = glob.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  const src = g
    .split(/(\*\*\/?|\*|\?)/)
    .map((p) => (p === '**/' ? '(?:.*/)?' : p === '**' ? '.*' : p === '*' ? '[^/]*' : p === '?' ? '[^/]' : p.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${src}$`, 'i');
}

/** Por que um arquivo é 'high' (a chave do motivo), ou undefined. */
function highReason(path: string, f: FileDiff | undefined, extra: Array<{ glob: string; re: RegExp; base: boolean }>): string | undefined {
  const p = path.replace(/\\/g, '/');
  const segs = p.toLowerCase().split('/');
  const name = segs[segs.length - 1];
  if (segs.some((s) => s === '.github' || s === '.husky' || s === '.githooks')) return tr('CI/hooks (rodam com a sua credencial)');
  if (segs.includes('migrations') || segs.includes('drizzle') || name.endsWith('.sql')) return tr('migration/banco');
  if (name.startsWith('.env')) return tr('arquivo .env');
  if (LOCKFILES.has(name)) return tr('lockfile de dependências');
  if (MANIFESTS.has(name)) return name === 'eas.json' ? tr('eas.json (build/loja)') : tr('manifesto de dependências');
  if (name === 'package.json' && (!f || f.changed.some((l) => PKG_DEP_KEY.test(l) || PKG_DEP_LINE.test(l)))) return tr('dependências do package.json');
  if (APP_CONFIG.test(name) && (!f || /plugins/.test(f.text))) return tr('plugins do app.json/app.config');
  if (SENSITIVE.test(p)) return tr('login/pagamento/assinatura');
  const hit = extra.find((x) => x.re.test(x.base ? name : p));
  if (hit) return tr('vboards.riskPaths ({0})', [hit.glob]);
  return undefined;
}

/** Pura: o risco do diff (unificado, `git diff`), com os motivos. */
export function diffRisk(diff: string, opts: DiffRiskOpts = {}): RiskVerdict {
  const extra = (opts.extra ?? []).map((g) => g.trim()).filter(Boolean).map((glob) => ({ glob, re: globToRegex(glob), base: !glob.includes('/') }));
  const files = splitDiff(diff);
  const high = new Map<string, string[]>();
  let lines = 0;
  for (const f of files) {
    lines += f.changed.length;
    for (const path of f.paths) {
      const why = highReason(path, f, extra);
      if (why) high.set(why, [...new Set([...(high.get(why) ?? []), path])]);
    }
  }
  const seen = new Set(files.flatMap((f) => f.paths));
  const unseen = [...new Set(opts.files ?? [])].filter((p) => p && !seen.has(p));
  for (const path of unseen) {
    const why = highReason(path, undefined, extra);
    if (why) high.set(why, [...new Set([...(high.get(why) ?? []), path])]);
  }
  const why = [...high].map(([k, ps]) => `${k}: ${ps.slice(0, 5).join(', ')}${ps.length > 5 ? ' …' : ''}`);
  let level: RiskLevel = high.size ? 'high' : 'low';
  const max = opts.maxLines && opts.maxLines > 0 ? opts.maxLines : DEFAULT_RISK_LINES;
  if (lines > max) {
    level = maxRisk(level, 'medium');
    why.push(tr('diff grande: {0} linhas (limite {1})', [lines, max]));
  }
  if (unseen.length) {
    level = maxRisk(level, 'medium');
    why.push(tr('diff incompleto: {0} arquivo(s) sem o conteúdo', [unseen.length]));
  }
  if (opts.reworked) {
    level = maxRisk(level, 'medium');
    why.push(tr('o portão mandou corrigir uma vez'));
  }
  return { level, why };
}

/** O risco final: o maior entre o da IA (cada item; ausente = medium) e o calculado, que nunca é rebaixado. */
export function finalRisk(ai: ReadonlyArray<{ risk?: RiskLevel; riskWhy?: string }>, calc: RiskVerdict): RiskVerdict {
  let level = calc.level;
  const why = [...calc.why];
  for (const a of ai) {
    const r = a.risk ?? 'medium';
    level = maxRisk(level, r);
    if (r !== 'low') why.push(a.risk ? tr('IA: {0} ({1})', [riskLabel(r), a.riskWhy?.trim() || tr('sem motivo')]) : tr('IA: sem risco informado (conta como médio)'));
  }
  return { level, why: [...new Set(why)] };
}
