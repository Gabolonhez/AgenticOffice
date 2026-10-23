// Diff unificado do git (`git diff <base>`) em arquivos e linhas numeradas: a vista do diff com comentários por linha
// (client/src/ui/runs.ts) e a validação dos comentários no servidor (server/chat/runs.ts feedback).

export interface DiffLine {
  /** 'hunk' = cabeçalho @@; 'meta' = cabeçalho do arquivo (index, ---, +++) ou "\ No newline at end of file". */
  kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
  text: string;
  /** Número da linha no lado antigo (del, ctx) e no novo (add, ctx). */
  old?: number;
  new?: number;
}

export interface DiffFile {
  path: string;
  /** Renomeado: o caminho antigo. */
  oldPath?: string;
  lines: DiffLine[];
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let f: DiffFile | undefined;
  let inHunk = false;
  let o = 0;
  let n = 0;
  for (const line of diff.split(/\r?\n/)) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      f = { path: head[2], ...(head[1] !== head[2] ? { oldPath: head[1] } : {}), lines: [] };
      files.push(f);
      inHunk = false;
      continue;
    }
    if (!f) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      inHunk = true;
      f.lines.push({ kind: 'hunk', text: line });
    } else if (!inHunk) {
      if (line) f.lines.push({ kind: 'meta', text: line });
    } else if (line.startsWith('+')) f.lines.push({ kind: 'add', text: line.slice(1), new: n++ });
    else if (line.startsWith('-')) f.lines.push({ kind: 'del', text: line.slice(1), old: o++ });
    else if (line.startsWith(' ')) f.lines.push({ kind: 'ctx', text: line.slice(1), old: o++, new: n++ });
    else if (line) f.lines.push({ kind: 'meta', text: line });
  }
  return files;
}
