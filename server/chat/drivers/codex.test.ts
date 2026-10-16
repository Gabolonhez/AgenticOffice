import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexArgs, codexDriver } from './codex';
import type { ChatEvent, TurnSpec } from '../types';

const fx = (n: string) => readFileSync(join(__dirname, '..', 'fixtures', n), 'utf8').split(/\r?\n/).filter(Boolean);
const run = (n: string, exit = 0): ChatEvent[] => { const p = codexDriver.parser(); return [...fx(n).flatMap((l) => p.line(l)), ...p.end(exit, '')]; };

describe('chat: driver do Codex', () => {
  it('argv: exec na 1ª, exec resume depois; acesso total e papel por -c; pedido por stdin', () => {
    const s: TurnSpec = { folder: 'C:\\proj', prompt: '--x', first: true, permission: 'auto', role: 'Diga "oi"\n' };
    expect(codexArgs(s)).toEqual(['exec', '--json', '--skip-git-repo-check',
      '-c', 'sandbox_mode="danger-full-access"',
      '-c', 'developer_instructions="Diga \\"oi\\"\\n"', '-']);
    expect(codexArgs({ ...s, first: false, resumeId: '01a14670-48d2-7781-8dee-d5aaf4ebd0f3', model: 'gpt-5.6-luna', role: undefined }))
      .toEqual(['exec', 'resume', '01a14670-48d2-7781-8dee-d5aaf4ebd0f3', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="danger-full-access"', '-m', 'gpt-5.6-luna', '-']);
    expect(codexDriver.invocation(s).stdin).toBe('--x');
  });
  it('erro real: aviso vira notice, falha traz a mensagem de dentro do JSON', () => {
    const ev = run('codex-error.jsonl', 1);
    expect(ev[0]).toEqual({ type: 'session', id: '01a14670-09a5-7761-b763-5c4bda855648' });
    expect(ev).toContainEqual({ type: 'notice', text: 'Model metadata for `gpt-6.1-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' });
    expect(ev.at(-1)).toEqual({ type: 'done', ok: false, error: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." });
  });
  it('rodada: comando, arquivo, texto e uso em tokens (sem US$)', () => {
    const ev = run('codex-turn.jsonl');
    expect(ev).toContainEqual({ type: 'tool', id: 'item_1', name: 'command', input: 'git push origin main' });
    expect(ev).toContainEqual({ type: 'tool-result', id: 'item_1', output: 'Everything up-to-date', error: false });
    expect(ev).toContainEqual({ type: 'tool', id: 'item_2', name: 'file_change', input: 'add C:\\proj\\c.txt' });
    expect(ev).toContainEqual({ type: 'text', text: 'ok' });
    expect(ev).toContainEqual({ type: 'usage', tokensIn: 1200, tokensOut: 40 });
    expect(ev.at(-1)).toEqual({ type: 'done', ok: true });
  });
});
