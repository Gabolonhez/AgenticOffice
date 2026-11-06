// Política sensível de cada pasta (subir, merge sozinho, loja): fora do git config. A cópia isolada (git worktree)
// compartilha o .git/config do repo e um agente em modo auto conseguiria gravar `vboards.autoMerge low` lá; por isso
// estas chaves vivem em <dataDir>/chat/folder-policy.json (chave = caminho real da pasta), gravado só pelo servidor
// (tela local ou cartão do Jarvis). Valores antigos no git config são IGNORADOS (nunca importados: o agente pode tê-los
// gravado); a tela avisa para configurar de novo.
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { errMsg } from '../log';

export const SENSITIVE_KEYS = ['autoMerge', 'ship', 'base', 'remote', 'deploy', 'ciMinutes', 'riskPaths', 'riskLines', 'store', 'storeWorkflow', 'otaChannel', 'versionBump'] as const;
export type SensitiveKey = (typeof SENSITIVE_KEYS)[number];
export type FolderPolicy = Partial<Record<SensitiveKey, string>>;

export const isSensitive = (key: string): key is SensitiveKey => (SENSITIVE_KEYS as readonly string[]).includes(key);
export const policyFile = (dataDir: string): string => join(dataDir, 'chat', 'folder-policy.json');

/** Caminho real da pasta (links resolvidos), com `/` e, no Windows, em minúsculas. */
export function policyKey(folder: string): string {
  let p: string;
  try {
    p = realpathSync.native(folder);
  } catch {
    p = resolve(folder);
  }
  p = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function loadAll(file: string): Record<string, FolderPolicy> {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as { folders?: unknown };
    return j.folders && typeof j.folders === 'object' ? (j.folders as Record<string, FolderPolicy>) : {};
  } catch {
    return {};
  }
}

/** A política gravada da pasta (só chaves sensíveis com texto). */
export function readPolicy(file: string, folder: string): FolderPolicy {
  const raw = loadAll(file)[policyKey(folder)];
  const out: FolderPolicy = {};
  if (raw && typeof raw === 'object') for (const k of SENSITIVE_KEYS) if (typeof raw[k] === 'string' && raw[k]) out[k] = raw[k];
  return out;
}

/** Grava (valor vazio tira a chave). Devolve o erro, se houver. Quem valida os valores é o validateFolderConfig. */
export function writePolicy(file: string, folder: string, values: FolderPolicy): string | undefined {
  try {
    const all = loadAll(file);
    const key = policyKey(folder);
    const cur: FolderPolicy = { ...(all[key] ?? {}) };
    for (const [k, v] of Object.entries(values)) {
      if (!isSensitive(k)) continue;
      if (v) cur[k] = v;
      else delete cur[k];
    }
    if (Object.keys(cur).length) all[key] = cur;
    else delete all[key];
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify({ folders: all }, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    return undefined;
  } catch (err) {
    return errMsg(err);
  }
}

/**
 * PIN para gravar: o resultado deixa algo subir ou publicar sem PIN a cada vez (autoMerge=low, ship=merge ou store≠off)
 * e muda alguma chave sensível (ligar, ou mexer em riskLines/deploy/workflow com isso ligado). Desligar não pede.
 */
export function policyNeedsPin(next: FolderPolicy, current: FolderPolicy): boolean {
  const m: FolderPolicy = { ...current, ...next };
  const armed = m.autoMerge === 'low' || m.ship === 'merge' || (!!m.store && m.store !== 'off');
  const disarms = (k: SensitiveKey, v = ''): boolean => (k === 'autoMerge' && v !== 'low') || (k === 'ship' && v !== 'merge') || (k === 'store' && (!v || v === 'off'));
  return armed && SENSITIVE_KEYS.some((k) => (m[k] ?? '') !== (current[k] ?? '') && !disarms(k, m[k]));
}

/** Mesma política (a congelada na lista × a de agora): comparação pelas chaves sensíveis, em ordem fixa. */
export const samePolicy = (a: FolderPolicy | undefined, b: FolderPolicy | undefined): boolean => !!a && !!b && SENSITIVE_KEYS.every((k) => (a[k] ?? '') === (b[k] ?? ''));
