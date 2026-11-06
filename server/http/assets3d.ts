// Serve o pacote 3D importado (~/.habblaud/assets/3d) em GET /api/assets3d/file/<caminho>. Fica fora do static.ts, que
// serve só o cliente compilado.
import { createReadStream, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { PACK_EXTS } from '../assets3d/pack';
import { etagOf, isNotModified } from './static';

const MIME: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Arquivo real do pacote para o caminho pedido, ou null (fora da raiz, link simbólico para fora, extensão inesperada). */
export function resolveAssetPath(root: string, rel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes('\0') || !PACK_EXTS.has(extname(decoded).toLowerCase())) return null;
  try {
    const base = realpathSync(resolve(root));
    const file = realpathSync(resolve(base, `.${sep}${decoded}`));
    return file.startsWith(base + sep) && statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

export function serveAsset(root: string, rel: string, req: IncomingMessage, res: ServerResponse): void {
  const file = resolveAssetPath(root, rel);
  const st = file ? statSync(file) : null;
  if (!file || !st) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return void res.end('404');
  }
  const etag = etagOf(st);
  // O nome é fixo e o conteúdo só muda numa nova importação: revalida (304) em vez de guardar por tempo.
  const headers = { 'Cache-Control': 'no-cache', ETag: etag, 'Last-Modified': new Date(st.mtimeMs).toUTCString(), 'X-Content-Type-Options': 'nosniff' };
  if (isNotModified(req, etag, st.mtimeMs)) {
    res.writeHead(304, headers);
    return void res.end();
  }
  res.writeHead(200, { ...headers, 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': st.size });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}
