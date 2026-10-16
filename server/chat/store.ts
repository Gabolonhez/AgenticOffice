// Uma conversa do chat por arquivo em <dataDir>/chat/agents/, para o agente voltar depois de reiniciar o servidor.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatItem, ChatLimits, ChatPermission } from '../../shared/chat';
import { tr } from '../../shared/i18n';
import type { Provider } from '../../shared/types';
import type { Spend } from './usage';

export interface ChatRecord {
  v: 1;
  agentId: string;
  provider: Provider;
  account?: string;
  folder: string;
  cwd: string;
  model?: string;
  roleId?: string;
  permission: ChatPermission;
  providerSessionId?: string;
  /** A CLI já criou a conversa (a partir daí, sempre retomar). */
  sessionStarted?: true;
  limits: ChatLimits;
  spend: Spend;
  items: ChatItem[];
  isolated?: { branch: string; path: string; base: string; merged?: boolean; discarded?: boolean };
  vboardsTaskId?: string;
  name?: string;
  seed: number;
  createdAt: number;
  running?: boolean;
  alwaysAllow: string[];
}

export const ITEMS_KEEP = 500;

export class ChatStore {
  constructor(private readonly dir: string) {}

  private file(agentId: string): string {
    return join(this.dir, `${encodeURIComponent(agentId)}.json`);
  }

  load(): ChatRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: ChatRecord[] = [];
    for (const name of names) {
      let r: ChatRecord;
      try {
        r = JSON.parse(readFileSync(join(this.dir, name), 'utf8'));
      } catch {
        continue;
      }
      if (r?.v !== 1 || typeof r.agentId !== 'string' || !Array.isArray(r.items)) continue;
      if (r.running) {
        const seq = (r.items.at(-1)?.seq ?? 0) + 1;
        r.items.push({ seq, at: Date.now(), kind: 'notice', level: 'error', text: tr('A rodada foi interrompida porque o servidor reiniciou.') });
        r.running = false;
      }
      out.push(r);
    }
    return out;
  }

  save(r: ChatRecord): void {
    mkdirSync(this.dir, { recursive: true });
    const keep = r.items.length > ITEMS_KEEP ? { ...r, items: r.items.slice(-ITEMS_KEEP) } : r;
    const file = this.file(r.agentId);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(keep));
    renameSync(tmp, file);
  }

  remove(agentId: string): void {
    rmSync(this.file(agentId), { force: true });
  }
}
