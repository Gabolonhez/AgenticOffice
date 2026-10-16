// Onde está o executável de cada CLI do chat. No Windows o `claude` e o `codex` do npm são shims `.cmd`, que o spawn
// sem shell não roda: usa o binário real ao lado (claude.exe, ou o codex.js rodado pelo próprio Node).
import { posix, win32 } from 'node:path';
import type { Provider } from '../../shared/types';
import { isExecutableFile } from '../claude-bin';

export interface CliBin { file: string; prefix: string[] }

const NAMES: Record<Provider, { name: string; env: string }> = {
  claude: { name: 'claude', env: 'HABBLAUD_CLAUDE_BIN' },
  codex: { name: 'codex', env: 'HABBLAUD_CODEX_BIN' },
  antigravity: { name: 'agy', env: 'HABBLAUD_AGY_BIN' },
};

// Próprio em vez de findExecutable (claude-bin.ts): o teste precisa injetar o sistema de arquivos.
function findInPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (p: string) => boolean): string | undefined {
  const path = platform === 'win32' ? win32 : posix;
  const exts = platform === 'win32' ? ['.exe', ...(env.PATHEXT ?? '.COM;.CMD;.BAT').split(';').filter(Boolean).map((e) => e.toLowerCase())] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      if (exists(file)) return file;
    }
  }
  return undefined;
}

export function resolveCliBin(
  provider: Provider,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = (p) => isExecutableFile(p, platform),
): CliBin | undefined {
  const { name, env: key } = NAMES[provider];
  const set = env[key]?.trim();
  const found = set && /[\\/]/.test(set) ? set : findInPath(set || name, env, platform, exists);
  if (!found) return undefined;
  if (platform !== 'win32' || !found.toLowerCase().endsWith('.cmd')) return { file: found, prefix: [] };
  const dir = win32.dirname(found);
  if (provider === 'claude') {
    const exe = win32.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    return exists(exe) ? { file: exe, prefix: [] } : undefined;
  }
  if (provider === 'codex') {
    const js = win32.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    return exists(js) ? { file: process.execPath, prefix: [js] } : undefined;
  }
  return undefined;
}
