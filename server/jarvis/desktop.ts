// Abrir no computador do dono (ferramenta pc_open do Jarvis, sempre com cartão e PIN): um link http(s) no navegador
// padrão ou um app pelo atalho do Menu Iniciar. Nunca comando livre nem argumentos: o alvo é um URL validado ou um .lnk
// que já existe no Menu Iniciar, aberto sem shell.
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tr } from '../../shared/i18n';

export type OpenTarget = { kind: 'url'; url: string; label: string } | { kind: 'app'; path: string; label: string };
export interface StartMenuApp { name: string; path: string }

/** Atalhos (.lnk) do Menu Iniciar do usuário e de todos (Windows), pelo nome sem a extensão. */
export function startMenuApps(env: NodeJS.ProcessEnv = process.env): StartMenuApp[] {
  const roots = [env.APPDATA, env.ProgramData].filter((r): r is string => !!r).map((r) => join(r, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  const out: StartMenuApp[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && /\.lnk$/i.test(e.name)) out.push({ name: e.name.slice(0, -4), path: p });
    }
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/** O que o Jarvis pediu, já resolvido: URL http(s) (domínio sem esquema ganha https://) ou um app do Menu Iniciar. */
export function resolveTarget(raw: string, apps: readonly StartMenuApp[]): OpenTarget | { error: string } {
  let s = raw.trim();
  if (!s) return { error: tr('Diga o link ou o nome do app.') };
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/.test(s) && !/\s/.test(s)) s = `https://${s}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return { error: tr('Link inválido.') };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: tr('Só abro links http(s) ou apps do Menu Iniciar.') };
    return { kind: 'url', url: u.href, label: u.href };
  }
  const want = s.toLowerCase();
  const exact = apps.filter((a) => a.name.toLowerCase() === want);
  const hits = exact.length ? exact : apps.filter((a) => a.name.toLowerCase().includes(want));
  if (exact.length || hits.length === 1) return { kind: 'app', path: hits[0].path, label: hits[0].name };
  if (!hits.length) return { error: tr('Nenhum app do Menu Iniciar chamado "{0}".', [s]) };
  return { error: tr('Mais de um app parecido: {0}. Diga qual.', [hits.slice(0, 10).map((a) => a.name).join(', ')]) };
}

/** Abre sem shell. No Windows: o URL pelo FileProtocolHandler (o navegador padrão) e o atalho pelo Explorer. */
export function openTarget(t: OpenTarget, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (t.kind === 'app' && platform !== 'win32') return Promise.reject(new Error(tr('Abrir apps pelo nome só funciona no Windows.')));
  const [file, args] =
    platform === 'win32' ? (t.kind === 'url' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', t.url]] : ['explorer.exe', [t.path]]) : [platform === 'darwin' ? 'open' : 'xdg-open', [t.kind === 'url' ? t.url : t.path]];
  // O Explorer devolve código 1 mesmo quando abre: só a falha ao iniciar o processo conta.
  return new Promise((ok, fail) => execFile(file as string, args as string[], { windowsHide: true }, (err) => (err && (err as NodeJS.ErrnoException).code === 'ENOENT' ? fail(err) : ok())));
}
