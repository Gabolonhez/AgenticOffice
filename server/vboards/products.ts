// Registro de produtos (<dataDir>/products.json): um produto do VBoards (o card) pode ter vários repositórios (app,
// server, web). A subtarefa diz qual repo, por uma etiqueta no começo do texto ("[server] corrigir login") ou pelo
// campo `repo` da fila; produto com um repo só usa ele. Ambíguo = falha com a frase pedindo o repo: nunca escolhe às
// cegas. Sem produto para o card, vale o casamento antigo por nome da pasta / vboards.card (vboards.ts matchFolders).
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tr } from '../../shared/i18n';

export const REPO_ROLES = ['app', 'server', 'web', 'other'] as const;
export type RepoRole = (typeof REPO_ROLES)[number];
export const STORE_MODES = ['off', 'ota', 'ota+build'] as const;

export interface ProductRepo {
  path: string;
  role: RepoRole;
  /** Remoto do git (padrão: o vboards.remote da pasta). */
  remote?: string;
  /** `none` ou `workflow:<arquivo.yml>`. */
  deploy?: string;
  store?: (typeof STORE_MODES)[number];
}

export interface Product {
  id: string;
  name: string;
  /** Título do card no VBoards. */
  cardName: string;
  repos: ProductRepo[];
}

export const PRODUCTS_MAX = 50;
export const PRODUCT_REPOS_MAX = 20;

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const samePath = (a: string, b: string): boolean => a.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase() === b.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() && v.trim().length <= max && !/[\r\n\0]/.test(v) ? v.trim() : undefined);

/** Valida a lista inteira (o arquivo ou o que a tela manda gravar). */
export function parseProducts(raw: unknown): { products: Product[] } | { error: string } {
  const list = Array.isArray(raw) ? raw : (raw as { products?: unknown } | null)?.products;
  if (!Array.isArray(list) || list.length > PRODUCTS_MAX) return { error: tr('Produtos: mande uma lista de até {0}.', [PRODUCTS_MAX]) };
  const products: Product[] = [];
  const paths: string[] = [];
  for (const x of list) {
    const p = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const id = typeof p.id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(p.id) ? p.id : undefined;
    const name = text(p.name, 100);
    const cardName = text(p.cardName, 100) ?? name;
    if (!id || !name || !cardName) return { error: tr('Produto inválido: id (minúsculas, números e hífen), nome e card são obrigatórios.') };
    if (products.some((q) => q.id === id || norm(q.cardName) === norm(cardName))) return { error: tr('Produto repetido: {0}.', [id]) };
    const rs = Array.isArray(p.repos) ? p.repos : [];
    if (!rs.length || rs.length > PRODUCT_REPOS_MAX) return { error: tr('O produto {0} precisa ter de 1 a {1} repositórios.', [id, PRODUCT_REPOS_MAX]) };
    const repos: ProductRepo[] = [];
    for (const y of rs) {
      const r = (y && typeof y === 'object' ? y : {}) as Record<string, unknown>;
      const path = text(r.path, 500);
      const bad = () => ({ error: tr('Repositório inválido no produto {0}.', [id]) });
      if (!path || !/^(\/|[A-Za-z]:[\\/])/.test(path) || path.split(/[\\/]/).includes('..')) return bad();
      if (!REPO_ROLES.includes(r.role as RepoRole)) return bad();
      if (r.remote !== undefined && r.remote !== '' && !(typeof r.remote === 'string' && /^[\w][\w.-]{0,59}$/.test(r.remote))) return bad();
      if (r.deploy !== undefined && r.deploy !== '' && !(typeof r.deploy === 'string' && /^(none|workflow:[\w.-]{1,100}\.ya?ml)$/.test(r.deploy))) return bad();
      if (r.store !== undefined && r.store !== '' && !STORE_MODES.includes(r.store as (typeof STORE_MODES)[number])) return bad();
      if (paths.some((q) => samePath(q, path))) return { error: tr('A pasta {0} está em mais de um lugar do registro.', [path]) };
      paths.push(path);
      repos.push({ path, role: r.role as RepoRole, ...(r.remote ? { remote: r.remote as string } : {}), ...(r.deploy ? { deploy: r.deploy as string } : {}), ...(r.store ? { store: r.store as ProductRepo['store'] } : {}) });
    }
    products.push({ id, name, cardName, repos });
  }
  return { products };
}

/** O produto do card (pelo cardName ou o nome). */
export const productForCard = (cardTitle: string, products: readonly Product[]): Product | undefined => {
  const want = norm(cardTitle);
  return want ? products.find((p) => norm(p.cardName) === want || norm(p.name) === want) : undefined;
};

/** O produto de uma pasta (um dos repos dele). */
export const productOfFolder = (folder: string, products: readonly Product[]): Product | undefined => products.find((p) => p.repos.some((r) => samePath(r.path, folder)));

/** Etiqueta de repo no começo da subtarefa: "[server] corrigir login" → "server". */
export const repoHint = (taskText: string): string | undefined => /^\s*\[([^\]\n]{1,60})\]/.exec(taskText)?.[1].trim() || undefined;

/**
 * O repo de uma subtarefa num produto: a dica (papel ou nome da pasta), senão o único repo. Ambíguo ou dica que não
 * existe = a frase de erro (nunca escolhe às cegas).
 */
export function pickRepo(p: Product, hint: string | undefined): { path: string } | { error: string } {
  const names = p.repos.map((r) => `${baseName(r.path)} (${r.role})`).join(', ');
  if (hint) {
    const h = norm(hint);
    const byName = p.repos.filter((r) => norm(baseName(r.path)) === h);
    const hits = byName.length ? byName : p.repos.filter((r) => r.role === hint.trim().toLowerCase());
    if (hits.length === 1) return { path: hits[0].path };
    return { error: tr('A subtarefa pede o repo "{0}", que não identifica um só repositório do produto {1}: {2}.', [hint, p.name, names]) };
  }
  if (p.repos.length === 1) return { path: p.repos[0].path };
  return { error: tr('O produto {0} tem {1} repositórios ({2}): diga qual no começo da subtarefa, ex.: [server] ...', [p.name, p.repos.length, names]) };
}

/** Lê o registro; arquivo ausente ou estragado = nenhum produto (o erro vai em `error`). */
export function loadProducts(file: string): { products: Product[]; error?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return (err as { code?: unknown }).code === 'ENOENT' ? { products: [] } : { products: [], error: tr('products.json ilegível.') };
  }
  const r = parseProducts(raw);
  return 'error' in r ? { products: [], error: r.error } : r;
}

/** Valida e grava (atômico, 600). */
export function saveProducts(file: string, raw: unknown): { products: Product[] } | { error: string } {
  const r = parseProducts(raw);
  if ('error' in r) return r;
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ products: r.products }, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return r;
}
