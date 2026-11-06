// Leitor de ZIP mínimo (sem dependências): central directory + inflateRaw. Feito para o pacote 3D que o dono importa,
// então recusa o que não precisa aceitar: ZIP64, criptografia, links simbólicos, caminhos absolutos ou com "..".
import { crc32, inflateRawSync } from 'node:zlib';
import { tr } from '../../shared/i18n';

export class ZipError extends Error {}

export interface ZipEntry {
  /** Caminho já normalizado (separador "/", sem "./"), nunca absoluto nem com "..". */
  name: string;
  size: number;
  compressed: number;
  method: number;
  crc: number;
  offset: number;
  dir: boolean;
}

export interface ZipLimits {
  /** Soma dos tamanhos descompactados. */
  totalBytes: number;
  /** Maior arquivo descompactado. */
  entryBytes: number;
  entries: number;
}

export const DEFAULT_LIMITS: ZipLimits = { totalBytes: 600 * 1024 * 1024, entryBytes: 128 * 1024 * 1024, entries: 5000 };

/** Caminho de entrada seguro? Devolve o nome normalizado ou lança ZipError (zip-slip). */
export function safeEntryName(raw: string): string {
  const name = raw.replace(/\\/g, '/');
  if (name.includes('\0') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new ZipError(tr('caminho inválido no zip: {0}', [raw.slice(0, 80)]));
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) throw new ZipError(tr('caminho inválido no zip: {0}', [raw.slice(0, 80)]));
  return parts.join('/') + (name.endsWith('/') && parts.length ? '/' : '');
}

export function parseZip(buf: Buffer, limits: ZipLimits = DEFAULT_LIMITS): ZipEntry[] {
  const bad = () => new ZipError(tr('o arquivo não é um zip válido'));
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad();
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || p === 0xffffffff) throw new ZipError(tr('zip64 não é suportado'));
  if (count > limits.entries) throw new ZipError(tr('zip com arquivos demais'));
  const out: ZipEntry[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad();
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    const offset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw bad();
    const raw = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const name = safeEntryName(raw);
    // criado em Unix (madeBy >> 8 === 3): o modo está nos 16 bits de cima; 0o120000 = link simbólico
    if (madeBy >> 8 === 3 && ((attrs >>> 16) & 0o170000) === 0o120000) throw new ZipError(tr('link simbólico no zip: {0}', [raw.slice(0, 80)]));
    if (flags & 1) throw new ZipError(tr('zip criptografado não é suportado'));
    if (compressed === 0xffffffff || size === 0xffffffff) throw new ZipError(tr('zip64 não é suportado'));
    const dir = name.endsWith('/');
    if (!dir && method !== 0 && method !== 8) throw new ZipError(tr('método de compressão não suportado'));
    if (size > limits.entryBytes) throw new ZipError(tr('arquivo grande demais no zip: {0}', [raw.slice(0, 80)]));
    total += size;
    if (total > limits.totalBytes) throw new ZipError(tr('zip grande demais depois de descompactado'));
    if (name) out.push({ name, size, compressed, method, crc, offset, dir });
  }
  return out;
}

/** Descompacta uma entrada, conferindo o tamanho declarado (bomba de zip) e o CRC. */
export function readEntry(buf: Buffer, e: ZipEntry): Buffer {
  const bad = () => new ZipError(tr('o arquivo não é um zip válido'));
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw bad();
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  if (start + e.compressed > buf.length) throw bad();
  const raw = buf.subarray(start, start + e.compressed);
  let data: Buffer;
  try {
    data = e.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) });
  } catch {
    throw bad();
  }
  if (data.length !== e.size || crc32(data) !== e.crc) throw bad();
  return data;
}
