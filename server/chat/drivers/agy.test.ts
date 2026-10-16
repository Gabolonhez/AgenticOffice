import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agyArgs, agyDriver } from './agy';
import type { ChatEvent, TurnSpec } from '../types';

const fx = (n: string) => readFileSync(join(__dirname, '..', 'fixtures', n), 'utf8').split(/\r?\n/).filter(Boolean);
const run = (n: string, exit = 0): ChatEvent[] => { const p = agyDriver.parser(); return [...fx(n).flatMap((l) => p.line(l)), ...p.end(exit, '')]; };

describe('chat: driver do Antigravity', () => {
  it('argv: o pedido vai grudado em --print= (texto que começa com "-" não vira flag)', () => {
    const s: TurnSpec = { folder: 'C:\\proj', prompt: '--model x', first: true, permission: 'auto', role: 'Papel.' };
    expect(agyArgs(s)).toEqual(['--output-format', 'stream-json', '--dangerously-skip-permissions', '--print=Papel.\n\n---\n\n--model x']);
    expect(agyArgs({ ...s, first: false, resumeId: 'd38f4d9a-1217-40ed-87e9-1ebc9a747fae', model: 'gemini-x' }))
      .toEqual(['--output-format', 'stream-json', '--dangerously-skip-permissions', '--conversation', 'd38f4d9a-1217-40ed-87e9-1ebc9a747fae', '--model', 'gemini-x', '--print=--model x']);
  });
  it('sem login: SUCCESS vazio com 0 rodadas é erro com aviso de login', () => {
    const ev = run('agy-nologin.jsonl');
    expect(ev[0]).toEqual({ type: 'session', id: 'd38f4d9a-1217-40ed-87e9-1ebc9a747fae' });
    expect(ev.at(-1)).toEqual({ type: 'done', ok: false, error: 'O Antigravity não respondeu. Faça login rodando `agy` num terminal.' });
  });
  it('rodada: texto do response e tokens', () => {
    const ev = run('agy-turn.jsonl');
    expect(ev).toContainEqual({ type: 'text', text: 'ok' });
    expect(ev).toContainEqual({ type: 'usage', tokensIn: 900, tokensOut: 13 });
    expect(ev.at(-1)).toEqual({ type: 'done', ok: true });
  });
  it('timeout do print vira falha', () => {
    expect(agyDriver.parser().end(1, 'error: print timeout exceeded')).toEqual([{ type: 'done', ok: false, error: 'error: print timeout exceeded' }]);
  });
});
