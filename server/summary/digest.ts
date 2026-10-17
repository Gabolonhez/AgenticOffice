// Resumo do dia: digest estruturado e determinístico do que aconteceu hoje (dia local) por projeto, em duas seções:
// feito e em andamento. É a base da lista simples e o material que a IA recebe. Função pura; tudo passa por maskSecrets.
import { maskSecrets } from '../../shared/activity';
import type { Activity } from '../../shared/types';

export const DIGEST_MAX = 12_000;
const ITEM_MAX = 200;
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|file_change)$/;

export interface DigestAgent {
  project: string;
  title?: string;
  working: boolean;
  /** Atividade atual, só para quem está trabalhando. */
  current?: string;
  recent: Activity[];
  lastEventAt: number;
}
export interface DigestChat {
  project: string;
  name: string;
  /** Pedidos do usuário feitos hoje. */
  prompts: string[];
  lastReply?: string;
  working: boolean;
  lastAt: number;
}
export interface DigestInput {
  /** Meia-noite local de hoje (epoch ms). */
  since: number;
  agents: DigestAgent[];
  chats: DigestChat[];
  commits: Array<{ project: string; subjects: string[] }>;
}
export interface DigestProject {
  name: string;
  done: string[];
  doing: string[];
}

const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const key = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
const clean = (s: string | undefined, max = ITEM_MAX): string => {
  const t = maskSecrets(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export const localMidnight = (now: number): number => new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();

export function buildDigest(input: DigestInput): DigestProject[] {
  const projects = new Map<string, DigestProject & { seen: Set<string> }>();
  const add = (project: string, list: 'done' | 'doing', text: string) => {
    const t = clean(text);
    if (!t) return;
    const k = key(project);
    let p = projects.get(k);
    if (!p) projects.set(k, (p = { name: baseName(project), done: [], doing: [], seen: new Set() }));
    if (p.seen.has(`${list}:${t}`)) return;
    p.seen.add(`${list}:${t}`);
    p[list].push(t);
  };
  for (const a of input.agents) {
    if (!a.working && a.lastEventAt < input.since) continue;
    const title = a.title ? clean(a.title) : '';
    if (a.working) add(a.project, 'doing', [title, a.current ? clean(a.current, 80) : ''].filter(Boolean).join(' — '));
    else if (title) add(a.project, 'done', title);
    const edits = [...new Set(a.recent.filter((r) => r.at >= input.since && !!r.tool && EDIT_TOOLS.test(r.tool)).map((r) => clean(r.text, 80)))].slice(-5);
    if (edits.length) add(a.project, a.working ? 'doing' : 'done', `${title || '…'}: ${edits.join('; ')}`);
  }
  for (const c of input.chats) {
    if (!c.working && c.lastAt < input.since) continue;
    const asked = c.prompts.map((p) => clean(p, 160)).filter(Boolean);
    if (c.working && asked.length) add(c.project, 'doing', `${c.name}: ${asked.at(-1)}`);
    for (const p of c.working ? asked.slice(0, -1) : asked) add(c.project, 'done', `${c.name}: ${p}`);
    if (!c.working && c.lastReply) add(c.project, 'done', `${c.name} respondeu: ${clean(c.lastReply, 240)}`);
  }
  for (const c of input.commits) for (const s of c.subjects) add(c.project, 'done', `commit: ${s}`);
  return [...projects.values()].filter((p) => p.done.length || p.doing.length).map(({ name, done, doing }) => ({ name, done, doing }));
}

/** Lista simples (também o material que a IA recebe). Cortada em DIGEST_MAX. */
export function digestToList(projects: readonly DigestProject[], labels = { done: 'Feito hoje', doing: 'Em andamento agora', empty: 'Nada registrado hoje.' }): string {
  if (!projects.length) return labels.empty;
  const out = projects
    .map((p) => [`## ${p.name}`, ...(p.done.length ? [`${labels.done}:`, ...p.done.map((x) => `- ${x}`)] : []), ...(p.doing.length ? [`${labels.doing}:`, ...p.doing.map((x) => `- ${x}`)] : [])].join('\n'))
    .join('\n\n');
  return out.length > DIGEST_MAX ? `${out.slice(0, DIGEST_MAX - 1)}…` : out;
}
