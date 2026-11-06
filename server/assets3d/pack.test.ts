import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAssetPath } from '../http/assets3d';
import { importPack, packStatus } from './pack';
import { parseZip, readEntry, ZipError } from './zip';

interface Spec {
  name: string;
  data?: Buffer | string;
  deflate?: boolean;
  /** modo Unix (ex.: 0o120777 = link simbólico) */
  mode?: number;
}

/** Monta um zip na mão (o leitor não conhece quem o escreveu). */
function makeZip(specs: Spec[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const s of specs) {
    const name = Buffer.from(s.name);
    const raw = Buffer.from(s.data ?? '');
    const body = s.deflate ? deflateRawSync(raw) : raw;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(s.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc32(raw), 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(s.mode ? 0x031e : 20, 4);
    ch.writeUInt16LE(s.deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc32(raw), 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    if (s.mode) ch.writeUInt32LE((s.mode << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    parts.push(lh, name, body);
    central.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(specs.length, 8);
  end.writeUInt16LE(specs.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const INDEX = JSON.stringify({ versao: 1, escritorios: [{ id: 'a' }, { id: 'b' }] });
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'hb3d-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('leitor de zip', () => {
  it('lê entradas guardadas e comprimidas', () => {
    const z = makeZip([{ name: 'a.txt', data: 'olá' }, { name: 'dir/b.json', data: '{"x":1}'.repeat(50), deflate: true }]);
    const es = parseZip(z);
    expect(es.map((e) => e.name)).toEqual(['a.txt', 'dir/b.json']);
    expect(readEntry(z, es[0]).toString()).toBe('olá');
    expect(readEntry(z, es[1]).toString()).toBe('{"x":1}'.repeat(50));
  });

  it.each(['../fora.txt', 'a/../../fora.txt', '/etc/passwd', 'C:/x.txt', 'C:\\x.txt', '..\\fora.txt'])('recusa o caminho %s (zip-slip)', (name) => {
    expect(() => parseZip(makeZip([{ name, data: 'x' }]))).toThrow(ZipError);
  });

  it('recusa link simbólico, lixo e tamanho declarado mentiroso', () => {
    expect(() => parseZip(makeZip([{ name: 'l', data: '/etc', mode: 0o120777 }]))).toThrow(/simbólico/);
    expect(() => parseZip(Buffer.from('isto não é um zip'))).toThrow(ZipError);
    const z = makeZip([{ name: 'a.txt', data: 'x'.repeat(100), deflate: true }]);
    const [e] = parseZip(z);
    expect(() => readEntry(z, { ...e, size: 10 })).toThrow(ZipError);
  });

  it('respeita os limites de tamanho', () => {
    const z = makeZip([{ name: 'a.txt', data: 'x'.repeat(100) }]);
    expect(() => parseZip(z, { totalBytes: 50, entryBytes: 1000, entries: 10 })).toThrow(/grande/);
    expect(() => parseZip(z, { totalBytes: 1000, entryBytes: 1000, entries: 0 })).toThrow(/demais/);
  });
});

describe('importPack', () => {
  it('extrai só as extensões esperadas, sem a pasta-mãe', () => {
    const root = join(tmp(), 'assets', '3d');
    const z = makeZip([
      { name: 'escritorio-3d/escritorios/indice.json', data: INDEX },
      { name: 'escritorio-3d/escritorios/a.glb', data: Buffer.from([1, 2, 3]), deflate: true },
      { name: 'escritorio-3d/visualizador/app.js', data: 'alert(1)' },
      { name: 'fora/escritorios/x.glb', data: 'x' },
    ]);
    expect(importPack(z, root).files).toBe(2);
    expect(packStatus(root)).toEqual({ installed: true, offices: 2 });
    expect([...readFileSync(join(root, 'escritorios/a.glb'))]).toEqual([1, 2, 3]);
    expect(existsSync(join(root, 'visualizador'))).toBe(false);
  });

  it('um zip malicioso não escreve nada e mantém o pacote anterior', () => {
    const root = join(tmp(), '3d');
    importPack(makeZip([{ name: 'escritorios/indice.json', data: INDEX }]), root);
    const evil = makeZip([
      { name: 'escritorios/indice.json', data: '{"escritorios":[]}' },
      { name: 'escritorios/../../../pwned.json', data: '{}' },
    ]);
    expect(() => importPack(evil, root)).toThrow(ZipError);
    expect(packStatus(root).offices).toBe(2);
    expect(existsSync(join(root, '..', '..', 'pwned.json'))).toBe(false);
  });

  it('recusa zip sem o índice do pacote', () => {
    expect(() => importPack(makeZip([{ name: 'a.glb', data: 'x' }]), join(tmp(), '3d'))).toThrow(/pacote 3D/);
  });
});

describe('resolveAssetPath', () => {
  it('serve arquivos de dentro e recusa o resto', () => {
    const base = tmp();
    const root = join(base, '3d');
    mkdirSync(join(root, 'escritorios'), { recursive: true });
    writeFileSync(join(root, 'escritorios', 'a.glb'), 'x');
    writeFileSync(join(base, 'segredo.json'), '{}');
    writeFileSync(join(root, 'run.sh'), 'x');
    expect(resolveAssetPath(root, 'escritorios/a.glb')).toMatch(/a\.glb$/);
    expect(resolveAssetPath(root, '../segredo.json')).toBeNull();
    expect(resolveAssetPath(root, '..%2Fsegredo.json')).toBeNull();
    expect(resolveAssetPath(root, '%2e%2e/segredo.json')).toBeNull();
    expect(resolveAssetPath(root, 'escritorios/%00.glb')).toBeNull();
    expect(resolveAssetPath(root, 'run.sh')).toBeNull();
    expect(resolveAssetPath(root, 'escritorios/nao-existe.glb')).toBeNull();
    expect(resolveAssetPath(root, '%E0%A4%A')).toBeNull();
  });

  it('um link simbólico para fora da raiz não vale', () => {
    const base = tmp();
    const root = join(base, '3d');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(base, 'segredo.json'), '{}');
    try {
      symlinkSync(join(base, 'segredo.json'), join(root, 'link.json'));
    } catch {
      return; // sem permissão para criar links neste sistema
    }
    expect(resolveAssetPath(root, 'link.json')).toBeNull();
  });
});
