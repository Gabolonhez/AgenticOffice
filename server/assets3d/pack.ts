// Pacote 3D (escritórios, móveis e funcionários em GLB) importado pelo dono em ~/.habblaud/assets/3d. Os GLB nunca
// entram no repositório: a licença do pacote não permite redistribuí-lo.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tr } from '../../shared/i18n';
import { DEFAULT_LIMITS, parseZip, readEntry, safeEntryName, ZipError, type ZipLimits } from './zip';

/** Extensões que o Habblaud guarda; o resto do zip (visualizador .js/.html/.css...) é ignorado. */
export const PACK_EXTS = new Set(['.glb', '.json', '.webp', '.md', '.txt']);
const INDEX = 'escritorios/indice.json';

export interface PackStatus {
  installed: boolean;
  offices: number;
}

export function packRoot(dataDir: string): string {
  return join(dataDir, 'assets', '3d');
}

export function packStatus(root: string): PackStatus {
  try {
    const idx = JSON.parse(readFileSync(join(root, INDEX), 'utf8')) as { escritorios?: unknown };
    const n = Array.isArray(idx.escritorios) ? idx.escritorios.length : 0;
    return { installed: n > 0, offices: n };
  } catch {
    return { installed: false, offices: 0 };
  }
}

function ext(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

/**
 * Extrai o zip para `root`. Recusa o zip inteiro se houver caminho perigoso; ignora extensões inesperadas. A pasta do
 * pacote é achada por `escritorios/indice.json` (com ou sem uma pasta-mãe, como "escritorio-3d/"). Extrai numa pasta
 * temporária e troca no fim: um zip ruim não estraga o pacote que já estava instalado.
 */
export function importPack(zip: Buffer, root: string, limits: ZipLimits = DEFAULT_LIMITS): { files: number; bytes: number } {
  const entries = parseZip(zip, limits);
  const idx = entries.find((e) => !e.dir && (e.name === INDEX || e.name.endsWith(`/${INDEX}`)));
  if (!idx) throw new ZipError(tr('este zip não parece o pacote 3D (falta escritorios/indice.json)'));
  const prefix = idx.name.slice(0, idx.name.length - INDEX.length);
  const base = resolve(root);
  const tmp = `${base}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  let files = 0;
  let bytes = 0;
  try {
    for (const e of entries) {
      if (e.dir || !e.name.startsWith(prefix) || !PACK_EXTS.has(ext(e.name))) continue;
      const rel = safeEntryName(e.name.slice(prefix.length));
      const dest = resolve(tmp, rel);
      if (!dest.startsWith(tmp + sep)) throw new ZipError(tr('caminho inválido no zip: {0}', [e.name.slice(0, 80)]));
      const data = readEntry(zip, e);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
      files++;
      bytes += data.length;
    }
    if (!existsSync(join(tmp, INDEX))) throw new ZipError(tr('este zip não parece o pacote 3D (falta escritorios/indice.json)'));
    mkdirSync(dirname(base), { recursive: true });
    rmSync(base, { recursive: true, force: true });
    renameSync(tmp, base);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return { files, bytes };
}
