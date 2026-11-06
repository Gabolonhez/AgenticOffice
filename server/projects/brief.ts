// Briefing de um projeto novo (A7): as respostas que faltam viram perguntas; com tudo respondido, a spec e o plano em
// Markdown (<dataDir>/projects/<slug>/spec.md) e o brief.json que o projects_create usa. A spec sai em pt-BR, como o
// PLAYBOOK e os SPEC.md do molde (é documento do produto, não interface); perguntas e erros passam por tr().
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tr } from '../../shared/i18n';

export const PART_ROLES = ['app', 'server', 'web'] as const;
export type PartRole = (typeof PART_ROLES)[number];

export interface Brief {
  idea: string;
  name: string;
  slug: string;
  audience: string;
  monetization: string;
  parts: PartRole[];
  /** Bundle id (iOS) e package (Android): o mesmo nos dois. */
  bundleId: string;
  colors: { primary: string; secondary?: string };
  notes?: string;
}

export interface BriefQuestion {
  key: 'idea' | 'name' | 'audience' | 'monetization' | 'parts' | 'bundleId' | 'primaryColor';
  question: string;
  suggestion?: string;
}

export const IDEA_MAX = 2000;
const TEXT_MAX = 300;

export const SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
// Segmentos começam com letra e não têm hífen: o package do Android não aceita.
export const BUNDLE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// Vai dentro de strings de JSON e de TS no molde: sem aspas, barras nem quebra de linha.
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,38}[\p{L}\p{N}]$/u;

/** "Meu App Legal" → "meu-app-legal" (sem acento). */
export const slugify = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[0-9-]+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');

const str = (v: unknown, max = TEXT_MAX): string => (typeof v === 'string' && !/[\0]/.test(v) ? v.trim().slice(0, max) : '');

/**
 * Lê as respostas (o que veio do Jarvis ou da tela). `brief` só quando tudo está respondido e válido; senão, as perguntas
 * do que falta (com sugestão) e os erros do que veio errado.
 */
export function parseBrief(raw: unknown): { brief?: Brief; questions: BriefQuestion[]; errors: string[] } {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const questions: BriefQuestion[] = [];
  const errors: string[] = [];
  const idea = str(b.idea, IDEA_MAX);
  const name = str(b.name, 60);
  const slug = str(b.slug, 40) || slugify(name);
  const audience = str(b.audience);
  const monetization = str(b.monetization);
  const partsRaw = Array.isArray(b.parts) ? b.parts : typeof b.parts === 'string' ? b.parts.split(/[\s,]+/) : [];
  const parts = PART_ROLES.filter((p) => partsRaw.includes(p));
  const bundleId = str(b.bundleId, 100).toLowerCase();
  const primary = str(b.primaryColor ?? (b.colors as Record<string, unknown> | undefined)?.primary, 7);
  const secondary = str(b.secondaryColor ?? (b.colors as Record<string, unknown> | undefined)?.secondary, 7);

  if (!idea) questions.push({ key: 'idea', question: tr('Qual é a ideia do app, em 1 a 3 frases?') });
  if (!name) questions.push({ key: 'name', question: tr('Qual é o nome do produto?') });
  else if (!NAME_RE.test(name)) errors.push(tr('Nome inválido: de 2 a 40 letras, números, espaço, ponto, hífen ou sublinhado.'));
  else if (!SLUG_RE.test(slug)) errors.push(tr('Não deu para tirar um identificador do nome: mande um slug (minúsculas, números e hífen, começando por letra).'));
  if (!audience) questions.push({ key: 'audience', question: tr('Para quem é o app (o público)?') });
  if (!monetization) questions.push({ key: 'monetization', question: tr('Como ele ganha dinheiro (assinatura, compra única, anúncios, grátis)?'), suggestion: tr('assinatura com paywall (Superwall)') });
  if (!parts.length) questions.push({ key: 'parts', question: tr('Quais partes do molde: app, server, web?'), suggestion: 'app, server' });
  if (!bundleId) questions.push({ key: 'bundleId', question: tr('Qual o bundle id (iOS) / package (Android)?'), suggestion: slug && SLUG_RE.test(slug) ? `com.example.${slug.replace(/-/g, '')}` : undefined });
  else if (!BUNDLE_RE.test(bundleId)) errors.push(tr('Bundle id inválido: minúsculas, pelo menos 3 partes separadas por ponto, cada uma começando por letra (ex.: com.empresa.app).'));
  if (!primary) questions.push({ key: 'primaryColor', question: tr('Qual a cor principal da marca (hex)? A secundária é opcional.'), suggestion: '#4F46E5' });
  else if (!COLOR_RE.test(primary)) errors.push(tr('Cor inválida: use #RRGGBB.'));
  if (secondary && !COLOR_RE.test(secondary)) errors.push(tr('Cor inválida: use #RRGGBB.'));

  if (questions.length || errors.length) return { questions, errors };
  const notes = str(b.notes, IDEA_MAX);
  return {
    brief: { idea, name, slug, audience, monetization, parts, bundleId, colors: { primary: primary.toUpperCase(), ...(secondary ? { secondary: secondary.toUpperCase() } : {}) }, ...(notes ? { notes } : {}) },
    questions,
    errors,
  };
}

/** Pasta de cada parte: <slug>-app, <slug>-server, <slug>-web (o padrão dos produtos do dono). */
export const repoName = (slug: string, role: PartRole): string => `${slug}-${role}`;

/** Os cards iniciais do VBoards (subtarefas do card do produto), com a etiqueta do repo. */
export function initialCards(b: Brief): string[] {
  const has = (r: PartRole) => b.parts.includes(r);
  const colors = [b.colors.primary, b.colors.secondary].filter(Boolean).join(' / ');
  return [
    ...(has('server') ? ['[server] Fase 4.1: .env (DATABASE_URL, JWT_SECRET novo, BASE_PORT sem conflito, CORS) e npm run db:setup'] : []),
    ...(has('app') ? ['[app] Rebrand pelo checklist do README (ícone, splash, i18n, URLs de LGPD) e npx expo prebuild --clean'] : []),
    ...(has('app') ? ['[app] Fase 4: Firebase, Superwall, Paywallo, Sentry e sign-in social (chaves no .env)'] : []),
    ...(has('app') ? [`[app] Fase 2: /design-import com a paleta ${colors} (DESIGN.md)`] : []),
    ...(has('web') ? ['[web] config/site.ts, .well-known (team id) e textos de privacidade e termos'] : []),
    ...(has('app') ? ['[app] Fase 5: features do SPEC.md, uma por vez (/new-feature)'] : []),
    ...(has('app') ? ['[app] Fase 5.1: ações rápidas, widget do domínio e live activity (ou registrar que pula)'] : []),
    ...b.parts.map((r) => `[${r}] Fases 6 e 7: /polish, npm run check && npm test sem erros e /code-review`),
    ...(has('server') ? ['[server] Fase 8: staging (docker:deploy) e GET /health'] : []),
    ...(has('app') ? ['[app] Fase 9: assets das lojas, App Store Connect, Play Console e eas build/submit'] : []),
  ];
}

/** spec.md: a spec do produto e o plano (os passos do projects_create e as fases do PLAYBOOK). */
export function specMarkdown(b: Brief): string {
  const repos = b.parts.map((r) => `- \`${repoName(b.slug, r)}\` (${r})`).join('\n');
  return [
    `# ${b.name}`,
    '',
    '## Ideia',
    '',
    b.idea,
    '',
    '## Público',
    '',
    b.audience,
    '',
    '## Monetização',
    '',
    b.monetization,
    '',
    '## Identidade',
    '',
    `- Slug: \`${b.slug}\``,
    `- Bundle id / package: \`${b.bundleId}\``,
    `- Cor principal: \`${b.colors.primary}\`${b.colors.secondary ? `; secundária: \`${b.colors.secondary}\`` : ''}`,
    '- Regras visuais: DESIGN.md do molde (escalas fechadas, estados obrigatórios, AA nos dois temas).',
    '',
    '## Partes',
    '',
    repos,
    '',
    ...(b.notes ? ['## Notas', '', b.notes, ''] : []),
    '## Delta sobre a base',
    '',
    'Auth, onboarding, paywall, LGPD, tracking, i18n, tema, push e force-update já vêm do molde: descreva aqui só o que é deste produto (telas, dados, regras).',
    '',
    '## Plano',
    '',
    '1. Copiar o molde (só as partes escolhidas, sem node_modules, .git, .env nem pastas nativas).',
    '2. Personalizar nome, slug, bundle id, package e cores.',
    '3. Workflow de CI de PR (install, typecheck, test, build) e eas.json no app.',
    '4. git init e commit inicial em cada repo.',
    '5. Repositórios privados no GitHub e o remote origin (opcional; o primeiro push é do dono).',
    '6. Registrar o produto no Habblaud (products.json) e as chaves vboards.* de cada repo (check, qa e ship desligados).',
    '7. Card do produto no VBoards com os cards iniciais abaixo (opcional).',
    '8. Seguir o PLAYBOOK.md do molde a partir da Fase 4.',
    '',
    '## Cards iniciais',
    '',
    ...initialCards(b).map((c) => `- ${c}`),
    '',
  ].join('\n');
}

/** As linhas "- ..." da seção "## Cards iniciais" (a spec pode ter sido editada na revisão). Até 20, 300 caracteres. */
export function cardsFromSpec(md: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^##\s/.test(line)) inside = /^##\s+cards iniciais\s*$/i.test(line.trim());
    else if (inside) {
      const m = /^\s*[-*]\s+(.+)$/.exec(line);
      if (m) out.push(m[1].trim().slice(0, 300));
    }
  }
  return out.slice(0, 20);
}

// ------------------------------------------------------------------ arquivos

export const SPEC_MAX = 50_000;
export const projectDir = (dataDir: string, slug: string): string => join(dataDir, 'projects', slug);

function writeAtomic(file: string, text: string): void {
  writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** Grava brief.json e spec.md (a spec é refeita do brief; a edição da revisão vem por saveSpec). */
export function saveDraft(dataDir: string, b: Brief): string {
  const dir = projectDir(dataDir, b.slug);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, 'brief.json'), `${JSON.stringify(b, null, 2)}\n`);
  const spec = specMarkdown(b);
  writeAtomic(join(dir, 'spec.md'), spec);
  return spec;
}

export function saveSpec(dataDir: string, slug: string, md: string): string | undefined {
  if (!SLUG_RE.test(slug)) return tr('Projeto inválido.');
  if (typeof md !== 'string' || !md.trim() || md.length > SPEC_MAX) return tr('A spec precisa ter de 1 a {0} caracteres.', [SPEC_MAX]);
  if (!loadBrief(dataDir, slug)) return tr('Projeto não encontrado: faça o briefing antes.');
  writeAtomic(join(projectDir(dataDir, slug), 'spec.md'), md);
  return undefined;
}

export function loadBrief(dataDir: string, slug: string): Brief | undefined {
  if (!SLUG_RE.test(slug)) return undefined;
  try {
    const r = parseBrief(JSON.parse(readFileSync(join(projectDir(dataDir, slug), 'brief.json'), 'utf8')));
    return r.brief?.slug === slug ? r.brief : undefined;
  } catch {
    return undefined;
  }
}

export function loadSpec(dataDir: string, slug: string): string {
  try {
    return readFileSync(join(projectDir(dataDir, slug), 'spec.md'), 'utf8');
  } catch {
    return '';
  }
}

/** Slugs com briefing salvo. */
export function listDrafts(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, 'projects')).filter((s) => SLUG_RE.test(s) && !!loadBrief(dataDir, s));
  } catch {
    return [];
  }
}
