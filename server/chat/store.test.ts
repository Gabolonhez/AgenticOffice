import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatStore, ITEMS_KEEP, type ChatRecord } from './store';

const rec = (over: Partial<ChatRecord> = {}): ChatRecord => ({
  v: 1,
  agentId: 'chat:1',
  provider: 'claude',
  folder: 'C:\\proj',
  cwd: 'C:\\proj',
  permission: 'auto',
  limits: {},
  spend: { usd: 0, tokens: 0 },
  items: [{ seq: 1, at: 1, kind: 'user', text: 'oi' }],
  seed: 7,
  createdAt: 1,
  alwaysAllow: [],
  ...over,
});

describe('chat: ChatStore', () => {
  it('grava um arquivo por agente (atômico) e carrega igual', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-chat-'));
    const s = new ChatStore(dir);
    s.save(rec());
    expect(readdirSync(dir)).toEqual([`${encodeURIComponent('chat:1')}.json`]);
    expect(new ChatStore(dir).load()).toEqual([rec()]);
  });

  it(`guarda só os ${ITEMS_KEEP} itens mais recentes`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-chat-'));
    const items = Array.from({ length: 600 }, (_, i) => ({ seq: i + 1, at: i, kind: 'user' as const, text: String(i) }));
    new ChatStore(dir).save(rec({ items }));
    const [loaded] = new ChatStore(dir).load();
    expect(loaded.items).toHaveLength(500);
    expect(loaded.items[0].seq).toBe(101);
  });

  it('arquivo corrompido é ignorado e o resto carrega', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-chat-'));
    new ChatStore(dir).save(rec());
    writeFileSync(join(dir, 'ruim.json'), '{nao é json');
    expect(new ChatStore(dir).load().map((r) => r.agentId)).toEqual(['chat:1']);
  });

  it('rodada que estava no meio quando o servidor caiu vira aviso', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-chat-'));
    new ChatStore(dir).save(rec({ running: true }));
    const [loaded] = new ChatStore(dir).load();
    expect(loaded.running).toBe(false);
    expect(loaded.items.at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: 'A rodada foi interrompida porque o servidor reiniciou.', seq: 2 });
  });

  it('remove apaga o arquivo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-chat-'));
    const s = new ChatStore(dir);
    s.save(rec());
    s.remove('chat:1');
    expect(new ChatStore(dir).load()).toEqual([]);
  });
});
