// Fonte de agentes do Google Antigravity IDE (AgentSource 'antigravity', ver sources/source.ts). SOMENTE LEITURA: sem
// permissões, mensagens, terminal nem hooks; o escritório só mostra a conversa aberta, a pasta, o status e uma linha
// do que o agente faz.
//
// Cada conversa é um SQLite em `~/.gemini/antigravity-ide/conversations/<cascadeId>.db` (WAL, com -wal/-shm, passos
// em protobuf sem esquema público). O SQLite NUNCA é aberto: até uma conexão readOnly reescreve o -shm, e o modo
// immutable ignora o -wal (onde está o que é novo). Os arquivos são lidos como bytes:
// - presença: .db ou .db-wal modificado nos últimos RECENT_MS (sem registro de sessões abertas nem processo a olhar);
// - status: escreveu nos últimos WORKING_MS = 'working', senão 'idle';
// - pasta: a URI file:/// do workspace no blob de metadados (cascadeId, ':', tamanho, URI), achada nos frames válidos
//   do -wal ou, já consolidada, no começo do .db;
// - atividade: o "toolAction" (ou um trecho de texto legível) da célula mais nova da folha de tabela mais nova do
//   -wal, mascarado. Sem -wal (consolidado ao fechar o app) fica sem atividade nova.
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskSecrets, truncate } from '../../../shared/activity';
import { tr } from '../../../shared/i18n';
import type { Activity, AgentStatus, SourceInfo } from '../../../shared/types';
import type { AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';

/** Conversa modificada há menos que isto = aberta. */
export const RECENT_MS = 30 * 60_000;
/** Escreveu há menos que isto = trabalhando. */
export const WORKING_MS = 20_000;
/** Máximo lido de um -wal (o SQLite consolida a cada ~4 MB; maior que isto só com checkpoint travado). */
const WAL_MAX_BYTES = 32 * 1024 * 1024;
/** Começo do .db lido atrás da pasta (a tabela de metadados é criada logo no início). */
const DB_HEAD_BYTES = 1024 * 1024;
const ACCOUNT_ID = '.antigravity';
const DB_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.db$/i;
const MAIN_ROLE = tr('Agente principal (Antigravity)');

/** Pasta das conversas do Antigravity IDE. */
export function antigravityDir(home: string): string {
  return join(home, '.gemini', 'antigravity-ide', 'conversations');
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Os primeiros `len` bytes de um arquivo (vazio se não dá para ler). */
function readHead(path: string, len: number): Buffer {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const buf = Buffer.alloc(Math.min(len, fstatSync(fd).size));
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
  } catch {
    return Buffer.alloc(0);
  } finally {
    closeSync(fd);
  }
}

/**
 * Páginas de um -wal, da mais recente para a mais antiga. Cada checkpoint recomeça a escrita do início do arquivo
 * com o salt1 seguinte: a recência é (salt1, posição), e os frames de gerações anteriores (já consolidados no .db)
 * entram depois, ainda úteis (o último passo pode estar só neles quando o app só mexeu em passos antigos depois).
 */
export function walPages(wal: Buffer): Buffer[] {
  if (wal.length < 32 || (wal.readUInt32BE(0) & ~1) !== 0x377f0682) return [];
  const pageSize = wal.readUInt32BE(8);
  if (pageSize < 512 || pageSize > 65536 || pageSize & (pageSize - 1)) return [];
  const frames: Array<{ salt: number; pos: number }> = [];
  for (let pos = 32; pos + 24 + pageSize <= wal.length; pos += 24 + pageSize) frames.push({ salt: wal.readUInt32BE(pos + 8), pos });
  // salt1 cresce de 1 a cada recomeço; a diferença com sinal (|0) aguenta a volta do contador.
  frames.sort((a, b) => (b.salt - a.salt) | 0 || b.pos - a.pos);
  return frames.map((f) => wal.subarray(f.pos + 24, f.pos + 24 + pageSize));
}

function varint(buf: Buffer, pos: number): [value: number, next: number] {
  let v = 0;
  for (let i = 0; i < 9 && pos < buf.length; i++) {
    const b = buf[pos++];
    if (i === 8) return [v * 256 + b, pos];
    v = v * 128 + (b & 0x7f);
    if (b < 0x80) break;
  }
  return [v, pos];
}

/** Colunas da tabela `steps` (idx, step_type, status, ..., step_payload, step_format): é por elas que a linha é reconhecida. */
const STEP_COLUMNS = 11;

/**
 * Passo de maior idx numa folha da tabela `steps`: o idx (rowid) e a parte local da linha (o começo dos blobs).
 * undefined se a página não é folha de tabela, ou é de outra tabela (gen_metadata, overflow de payloads grandes...).
 */
export function newestStep(page: Buffer): { idx: number; body: Buffer } | undefined {
  const u = page.length;
  const cells = page[0] === 0x0d ? page.readUInt16BE(3) : 0;
  if (!cells) return undefined;
  const at = page.readUInt16BE(8 + 2 * (cells - 1));
  if (at < 8 || at >= u) return undefined;
  const [size, afterSize] = varint(page, at);
  const [idx, start] = varint(page, afterSize);
  // Tamanho local da célula (regra do formato do SQLite para folhas de tabela).
  const max = u - 35;
  const min = Math.floor(((u - 12) * 32) / 255) - 23;
  const k = min + ((size - min) % (u - 4));
  const body = page.subarray(start, Math.min(u, start + (size <= max ? size : k <= max ? k : min)));
  // Cabeçalho do registro: um tipo serial por coluna.
  let [headerSize, p] = varint(body, 0);
  let columns = 0;
  while (p < headerSize && p < body.length) {
    p = varint(body, p)[1];
    columns++;
  }
  return columns === STEP_COLUMNS ? { idx, body } : undefined;
}

/** Pasta do workspace no blob de metadados: `<cascadeId>` ':' <tamanho> 'file:///...' (string protobuf). */
export function workspaceFrom(buf: Buffer, cascadeId: string): string | undefined {
  const anchor = Buffer.from(`${cascadeId}:`, 'latin1');
  for (let i = buf.indexOf(anchor); i >= 0; i = buf.indexOf(anchor, i + 1)) {
    const start = i + anchor.length + 1;
    const len = buf[start - 1];
    if (len === undefined || len >= 0x80 || buf.toString('latin1', start, start + 8) !== 'file:///') continue;
    try {
      return fileURLToPath(buf.toString('utf8', start, start + len));
    } catch {
      // URI quebrada (página cortada): tenta a próxima
    }
  }
  return undefined;
}

/**
 * Linha do que o agente faz num passo: o "toolAction" de uma chamada de ferramenta, senão o maior trecho de texto
 * legível com cara de frase. Mascarado e cortado.
 */
export function activityFrom(buf: Buffer): Pick<Activity, 'kind' | 'icon' | 'text' | 'detail'> | undefined {
  const s = buf.toString('utf8');
  const action = /"toolAction":"((?:[^"\\]|\\.){3,200})"/.exec(s)?.[1];
  let best = '';
  if (!action) for (const run of s.split(/[\x00-\x1f\x7f\ufffd]+/)) if (run.length > best.length && run.length >= 16 && (run.match(/ /g)?.length ?? 0) >= 3) best = run;
  const raw = action ? action.replace(/\\(.)/g, '$1') : best;
  if (!raw) return undefined;
  // Mascara antes de cortar (um segredo cortado ao meio vazaria o começo).
  const detail = truncate(maskSecrets(raw.slice(0, 1200)), 300);
  const text = truncate(detail, 46);
  return { kind: action ? 'run' : 'respond', icon: action ? '⚙️' : '💬', text, ...(detail !== text ? { detail } : {}) };
}

export function statusFrom(lastWrite: number, now: number): AgentStatus {
  return now - lastWrite < WORKING_MS ? 'working' : 'idle';
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

interface Conv {
  key: string;
  cascadeId: string;
  db: string;
  lastWrite: number;
  startedAt: number;
  cwd?: string;
  status: AgentStatus;
  activity?: string;
  inOffice: boolean;
}

export interface AntigravitySourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pasta `conversations/` do Antigravity IDE. */
  dir: string;
  now?: () => number;
  pollMs?: number;
}

export class AntigravitySource implements AgentSource {
  readonly provider = 'antigravity' as const;
  private readonly accountId: string;
  private convs = new Map<string, Conv>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private error?: string;
  private seq = 0;
  private readonly now: () => number;

  constructor(private readonly opts: AntigravitySourceOptions) {
    this.now = opts.now ?? Date.now;
    const taken = new Set(opts.accounts.entries().map((e) => e.detected.short.toUpperCase()));
    const [entry] = opts.accounts.setProviderAccounts('antigravity', [
      {
        dir: opts.dir,
        detected: { id: ACCOUNT_ID, configDir: opts.dir, short: ['G', 'A', 'Y'].find((l) => !taken.has(l)) ?? 'G', name: 'Antigravity', color: '#3ec6c1' },
      },
    ]);
    this.accountId = entry.id;
  }

  start(): void {
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
    this.timer = setInterval(() => {
      try {
        this.poll(false);
      } catch (err) {
        log.warnOnce(`antigravity-poll:${errMsg(err)}`, tr('Antigravity: falha ao ler as conversas ({0}).', [errMsg(err)]));
      }
    }, this.opts.pollMs ?? 2_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    let sessions = 0;
    for (const c of this.convs.values()) if (c.inOffice) sessions++;
    const info: SourceInfo = { label: this.accountId, provider: 'antigravity', path: this.opts.dir, sessions, ok: !this.error };
    if (this.error) info.error = this.error;
    return [info];
  }

  /** Sem transcript legível: o terminal não vale para o Antigravity. */
  transcriptPathOf(): string | undefined {
    return undefined;
  }

  poll(boot: boolean): void {
    const now = this.now();
    let names: string[];
    try {
      names = readdirSync(this.opts.dir);
      this.error = undefined;
    } catch (err) {
      this.error = errMsg(err);
      names = [];
    }
    const seen = new Set<string>();
    for (const name of names) {
      const cascadeId = DB_FILE.exec(name)?.[1];
      if (!cascadeId) continue;
      const db = join(this.opts.dir, name);
      const lastWrite = Math.max(mtime(db), mtime(`${db}-wal`));
      if (now - lastWrite >= RECENT_MS) continue;
      const key = `${this.accountId}:${cascadeId}`;
      seen.add(key);
      let c = this.convs.get(key);
      if (!c) {
        const born = statSync(db, { throwIfNoEntry: false })?.birthtimeMs || lastWrite;
        c = { key, cascadeId, db, lastWrite: 0, startedAt: Math.min(born, lastWrite), status: 'idle', inOffice: false };
        this.convs.set(key, c);
      }
      this.update(c, lastWrite, now, boot);
    }
    for (const [key, c] of this.convs) {
      if (seen.has(key)) continue;
      if (c.inOffice) this.opts.office.closeMain(key);
      this.convs.delete(key);
    }
  }

  private update(c: Conv, lastWrite: number, now: number, boot: boolean): void {
    const office = this.opts.office;
    let activity: ReturnType<typeof activityFrom> = undefined;
    if (lastWrite !== c.lastWrite) {
      c.lastWrite = lastWrite;
      const pages = walPages(readHead(`${c.db}-wal`, WAL_MAX_BYTES));
      if (!c.cwd) {
        for (const p of pages) c.cwd ??= workspaceFrom(p, c.cascadeId);
        c.cwd ??= workspaceFrom(readHead(c.db, DB_HEAD_BYTES), c.cascadeId);
      }
      let newest: ReturnType<typeof newestStep>;
      for (const p of pages) {
        const step = newestStep(p);
        if (step && (!newest || step.idx > newest.idx)) newest = step;
      }
      if (newest) activity = activityFrom(newest.body);
    }
    const status = statusFrom(lastWrite, now);
    // Sem a pasta não há sala: espera o metadado aparecer (como o Codex sem o session_meta).
    if (!c.cwd) return;
    if (!c.inOffice) {
      c.status = status;
      office.addMain({ id: c.key, provider: 'antigravity', account: this.accountId, sessionId: c.cascadeId, cwd: c.cwd, role: MAIN_ROLE, startedAt: c.startedAt, status });
      c.inOffice = office.has(c.key);
      if (!c.inOffice) return;
    } else if (status !== c.status) {
      c.status = status;
      office.setStatus(c.key, status);
    }
    if (activity && activity.text !== c.activity) {
      c.activity = activity.text;
      office.addActivity(c.key, { id: `${c.key}:${++this.seq}`, ...activity, at: lastWrite }, true, { feed: !boot });
    }
  }
}
