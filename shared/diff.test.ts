import { describe, expect, it } from 'vitest';
import { parseDiff } from './diff';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@ export',
  ' um',
  '-dois',
  '+DOIS',
  '+--- não é cabeçalho',
  ' três',
  '\\ No newline at end of file',
  'diff --git a/velho.md b/novo.md',
  'similarity index 90%',
  'rename from velho.md',
  'rename to novo.md',
  '@@ -10 +10,2 @@',
  ' x',
  '+y',
  '',
].join('\n');

describe('parseDiff', () => {
  it('arquivos, renomeados e linhas numeradas dos dois lados', () => {
    const [a, b] = parseDiff(DIFF);
    expect(a.path).toBe('src/a.ts');
    expect(a.oldPath).toBeUndefined();
    expect(a.lines.filter((l) => l.kind === 'meta').map((l) => l.text)).toEqual(['index 111..222 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '\\ No newline at end of file']);
    expect(a.lines.filter((l) => l.kind !== 'meta' && l.kind !== 'hunk')).toEqual([
      { kind: 'ctx', text: 'um', old: 1, new: 1 },
      { kind: 'del', text: 'dois', old: 2 },
      { kind: 'add', text: 'DOIS', new: 2 },
      { kind: 'add', text: '--- não é cabeçalho', new: 3 },
      { kind: 'ctx', text: 'três', old: 3, new: 4 },
    ]);
    expect(b).toMatchObject({ path: 'novo.md', oldPath: 'velho.md' });
    expect(b.lines.at(-1)).toEqual({ kind: 'add', text: 'y', new: 11 });
  });

  it('vazio ou lixo: nenhum arquivo', () => {
    expect(parseDiff('')).toEqual([]);
    expect(parseDiff('<script>x</script>\n+a')).toEqual([]);
  });
});
