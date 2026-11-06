import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendJournal, JOURNAL_KEEP_MS, JOURNAL_TRIM_BYTES, projectLedger, readJournal, trimJournal, type JournalEntry } from './journal';

const e = (o: Partial<JournalEntry>): JournalEntry => ({ at: 1, folder: '/p/app', stage: 'queued', ...o });

describe('registro por projeto (journal)', () => {
  it('grava uma linha por etapa e lê desde uma data, sem as linhas estragadas', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hb-journal-')), 'chat', 'journal.jsonl');
    appendJournal(file, e({ at: 10, ref: 'r#0' }));
    appendJournal(file, e({ at: 20, ref: 'r#0', stage: 'running' }));
    writeFileSync(file, `${readFileSync(file, 'utf8')}{lixo\n${JSON.stringify(e({ at: 30, stage: 'voando' as never }))}\n`);
    expect(readJournal(file).map((x) => x.at)).toEqual([10, 20]);
    expect(readJournal(file, 15).map((x) => x.stage)).toEqual(['running']);
    expect(readJournal(join(file, 'nada'))).toEqual([]);
  });

  it('corta só acima do limite, mantendo o recente', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hb-journal-')), 'journal.jsonl');
    const now = JOURNAL_KEEP_MS * 3;
    const old = JSON.stringify(e({ at: 1, title: 'x'.repeat(1000) }));
    writeFileSync(file, `${`${old}\n`.repeat(Math.ceil(JOURNAL_TRIM_BYTES / old.length) + 1)}${JSON.stringify(e({ at: now - 1 }))}\n`);
    trimJournal(file, now);
    expect(statSync(file).size).toBeLessThan(1000);
    expect(readJournal(file).map((x) => x.at)).toEqual([now - 1]);
  });

  it('ledger: a última etapa de cada tarefa, por produto ou pasta; descartada some', () => {
    const ledger = projectLedger([
      e({ at: 1, ref: 'a', title: 'Login', product: 'pept', folder: '/p/helix-server' }),
      e({ at: 2, ref: 'a', stage: 'running', product: 'pept', folder: '/p/helix-server' }),
      e({ at: 3, ref: 'a', stage: 'merged', product: 'pept', folder: '/p/helix-server' }),
      e({ at: 4, ref: 'b', title: 'Tela', stage: 'review', product: 'pept', folder: '/p/helix-app' }),
      e({ at: 5, ref: 'c', title: 'Fila', stage: 'queued', product: 'pept', folder: '/p/helix-app' }),
      e({ at: 6, ref: 'd', title: 'CI', stage: 'ci_fail', folder: '/p/voer' }),
      e({ at: 7, ref: 'e', title: 'Lixo', stage: 'discarded', folder: '/p/voer' }),
    ]);
    expect(ledger.map((p) => p.project)).toEqual(['pept', 'voer']);
    expect(ledger[0]).toMatchObject({ folders: ['/p/helix-server', '/p/helix-app'], done: [{ title: 'Login', stage: 'merged' }], doing: [{ title: 'Tela' }], todo: [{ title: 'Fila' }], stuck: [] });
    expect(ledger[1]).toMatchObject({ done: [], doing: [], todo: [], stuck: [{ title: 'CI', stage: 'ci_fail' }] });
  });
});
