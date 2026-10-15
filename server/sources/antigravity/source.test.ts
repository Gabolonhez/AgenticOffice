// Fonte do Antigravity: leitura dos bytes do -wal/.db (sem abrir o SQLite) e o ciclo presença/status/atividade.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { activityFrom, AntigravitySource, newestStep, RECENT_MS, statusFrom, walPages, workspaceFrom, WORKING_MS } from './source';

const PAGE = 4096;
const CASCADE = '0123abcd-0000-4000-8000-00000000beef';

function varint(n: number): number[] {
  const out = [n & 0x7f];
  for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) out.unshift(0x80 | (n & 0x7f));
  return out;
}

/** Linha de `steps` (11 colunas): idx = rowid, metadata = o blob dado, o resto NULL/0. */
function stepCell(idx: number, metadata: string, columns = 11): Buffer {
  const blob = Buffer.from(metadata);
  const types = [0, 1, 1, 8, blob.length * 2 + 12, ...Array(6).fill(0)].slice(0, columns);
  const typeBytes = types.flatMap(varint);
  const record = Buffer.from([typeBytes.length + 1, ...typeBytes, 3, 2, ...blob]);
  return Buffer.from([...varint(record.length), ...varint(idx), ...record]);
}

/** Folha de tabela com as células na ordem dada (a última é a de maior rowid). */
function leafPage(cells: Buffer[]): Buffer {
  const page = Buffer.alloc(PAGE);
  page[0] = 0x0d;
  page.writeUInt16BE(cells.length, 3);
  let end = PAGE;
  cells.forEach((c, i) => {
    end -= c.length;
    c.copy(page, end);
    page.writeUInt16BE(end, 8 + 2 * i);
  });
  return page;
}

function wal(frames: Array<{ salt: number; page: Buffer }>, headSalt = Math.max(...frames.map((f) => f.salt))): Buffer {
  const head = Buffer.alloc(32);
  head.writeUInt32BE(0x377f0682, 0);
  head.writeUInt32BE(3007000, 4);
  head.writeUInt32BE(PAGE, 8);
  head.writeUInt32BE(headSalt, 16);
  return Buffer.concat([
    head,
    ...frames.map((f, i) => {
      const fh = Buffer.alloc(24);
      fh.writeUInt32BE(i + 2, 0);
      fh.writeUInt32BE(f.salt, 8);
      return Buffer.concat([fh, f.page]);
    }),
  ]);
}

function metaBlob(dir: string): Buffer {
  const uri = pathToFileURL(dir).href;
  return Buffer.concat([Buffer.from([0x12, 0x24]), Buffer.from(`${CASCADE}:`), Buffer.from([uri.length]), Buffer.from(uri), Buffer.from([0x7a, 0x01])]);
}

const action = (text: string) => `{"CommandLine":"npm test","toolAction":"${text}","toolSummary":"x"}`;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

describe('leitura dos bytes', () => {
  it('ordena os frames do -wal pela geração (salt1) e pela posição', () => {
    const [a, b, c] = [1, 2, 3].map((n) => Buffer.alloc(PAGE, n));
    const pages = walPages(wal([{ salt: 7, page: a }, { salt: 6, page: b }, { salt: 7, page: c }]));
    expect(pages.map((p) => p[0])).toEqual([3, 1, 2]);
    expect(walPages(Buffer.from('not a wal'))).toEqual([]);
  });

  it('acha o passo de maior idx numa folha de steps e ignora outras tabelas', () => {
    const step = newestStep(leafPage([stepCell(41, action('Old')), stepCell(42, action('Running tests'))]));
    expect(step?.idx).toBe(42);
    expect(activityFrom(step!.body)).toMatchObject({ kind: 'run', text: 'Running tests' });
    expect(newestStep(leafPage([stepCell(5, 'x', 3)]))).toBeUndefined();
    expect(newestStep(Buffer.alloc(PAGE))).toBeUndefined();
  });

  it('acha a pasta do workspace pelo blob de metadados', () => {
    const dir = join(tempDir().dir, 'proj');
    expect(workspaceFrom(Buffer.concat([Buffer.alloc(50, 1), metaBlob(dir)]), CASCADE)).toBe(dir);
    expect(workspaceFrom(metaBlob(dir), 'ffffffff-0000-4000-8000-000000000000')).toBeUndefined();
  });

  it('sem toolAction usa o maior trecho com cara de frase, mascarado e cortado', () => {
    const a = activityFrom(Buffer.from(`\x00\x01abc_def_123\x02Pronto! Ajustei o mapa com token sk-ant-api03-${'a'.repeat(40)} e mais coisas depois\x00`));
    expect(a?.kind).toBe('respond');
    expect(a?.text.length).toBeLessThanOrEqual(46);
    expect(a?.detail ?? a?.text).not.toContain('aaaaaaaaaa');
    expect(activityFrom(Buffer.from('\x00onlyonewordhere\x01'))).toBeUndefined();
  });

  it('status pelo tempo da última escrita', () => {
    expect(statusFrom(1_000, 1_000 + WORKING_MS - 1)).toBe('working');
    expect(statusFrom(1_000, 1_000 + WORKING_MS)).toBe('idle');
  });
});

describe('AntigravitySource', () => {
  it('entra trabalhando, mostra a atividade, fica ocioso e sai depois da janela', () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const project = join(tmp.dir, 'proj');
    const db = join(tmp.dir, `${CASCADE}.db`);
    writeFileSync(db, Buffer.concat([Buffer.alloc(100), metaBlob(project)]));
    writeFileSync(`${db}-wal`, wal([{ salt: 1, page: leafPage([stepCell(9, action('Editing index.css'))]) }]));
    writeFileSync(join(tmp.dir, 'other.txt'), 'x');

    const calls: string[] = [];
    const present = new Set<string>();
    const office = {
      beginBoot: () => calls.push('beginBoot'),
      endBoot: () => calls.push('endBoot'),
      has: (id: string) => present.has(id),
      addMain: (p: { id: string; cwd: string; status: string; provider: string }) => {
        present.add(p.id);
        calls.push(`addMain ${p.id} ${p.provider} ${p.cwd === project} ${p.status}`);
      },
      setStatus: (id: string, s: string) => calls.push(`setStatus ${id} ${s}`),
      addActivity: (id: string, a: { text: string }) => calls.push(`activity ${id} ${a.text}`),
      closeMain: (id: string) => calls.push(`closeMain ${id}`),
    };
    const accounts = {
      entries: () => [],
      setProviderAccounts: (_p: string, list: Array<{ dir: string; detected: { id: string } }>) => list.map((l) => ({ id: l.detected.id, dir: l.dir, detected: l.detected })),
    };
    let offset = 0;
    const src = new AntigravitySource({ accounts: accounts as never, office: office as never, dir: tmp.dir, now: () => Date.now() + offset, pollMs: 60_000 });
    src.start();
    src.stop();
    const key = `.antigravity:${CASCADE}`;
    expect(calls).toEqual(['beginBoot', `addMain ${key} antigravity true working`, `activity ${key} Editing index.css`, 'endBoot']);
    expect(src.sources()[0]).toMatchObject({ label: '.antigravity', provider: 'antigravity', sessions: 1, ok: true });
    expect(src.transcriptPathOf()).toBeUndefined();

    calls.length = 0;
    offset = WORKING_MS + 1_000;
    src.poll(false);
    expect(calls).toEqual([`setStatus ${key} idle`]);

    calls.length = 0;
    offset = RECENT_MS + 1_000;
    src.poll(false);
    expect(calls).toEqual([`closeMain ${key}`]);
    expect(src.sources()[0].sessions).toBe(0);
  });
});
