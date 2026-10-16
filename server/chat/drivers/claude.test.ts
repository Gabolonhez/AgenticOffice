import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeArgs, claudeDriver, PERMISSION_TOOL } from './claude';
import type { ChatEvent, TurnSpec } from '../types';

const fx = (n: string) => readFileSync(join(__dirname, '..', 'fixtures', n), 'utf8').split(/\r?\n/).filter(Boolean);
const run = (n: string, exit = 0): ChatEvent[] => { const p = claudeDriver.parser(); return [...fx(n).flatMap((l) => p.line(l)), ...p.end(exit, '')]; };
const base: TurnSpec = { folder: 'C:\\proj', prompt: '-oi', first: true, sessionId: 'a202b58e-04e5-40b3-bbe5-0cbe9be49d86', permission: 'auto' };

describe('chat: driver do Claude', () => {
  it('argv da 1ª rodada fixa o id; as outras retomam; pedido nunca vai no argv', () => {
    expect(claudeArgs(base)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--session-id', 'a202b58e-04e5-40b3-bbe5-0cbe9be49d86', '--permission-mode', 'bypassPermissions']);
    expect(claudeArgs(base)).not.toContain('--permission-prompt-tool'); // automático: acesso total, sem permission tool
    const next = claudeArgs({ ...base, first: false, resumeId: 'a202b58e-04e5-40b3-bbe5-0cbe9be49d86', permission: 'ask', model: 'sonnet', role: 'Seja breve.', budgetUsd: 0.5, mcp: { url: 'http://127.0.0.1:4747/api/chat/mcp/chat:1', token: 't0k' } });
    expect(next.slice(0, 6)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--resume', 'a202b58e-04e5-40b3-bbe5-0cbe9be49d86']);
    expect(next).toContain('--permission-prompt-tool');
    expect(next[next.indexOf('--permission-prompt-tool') + 1]).toBe(PERMISSION_TOOL);
    expect(next[next.indexOf('--permission-mode') + 1]).toBe('default');
    expect(next[next.indexOf('--append-system-prompt') + 1]).toBe('Seja breve.');
    expect(next[next.indexOf('--max-budget-usd') + 1]).toBe('0.5');
    expect(JSON.parse(next[next.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: { habblaud: { type: 'http', url: 'http://127.0.0.1:4747/api/chat/mcp/chat:1', headers: { Authorization: 'Bearer t0k' } } } });
    expect(next).toContain('--strict-mcp-config');
    expect(next.join(' ')).not.toContain('-oi');
    expect(claudeDriver.invocation(base).stdin).toBe('-oi');
  });

  it('automático com o MCP do escritório: --mcp-config sem strict nem permission tool; prazo longo das ferramentas MCP', () => {
    const auto = claudeArgs({ ...base, mcp: { url: 'http://127.0.0.1:4747/api/chat/mcp/chat:1', token: 't0k' } });
    expect(JSON.parse(auto[auto.indexOf('--mcp-config') + 1]).mcpServers.habblaud.url).toBe('http://127.0.0.1:4747/api/chat/mcp/chat:1');
    expect(auto).not.toContain('--strict-mcp-config');
    expect(auto).not.toContain('--permission-prompt-tool');
    expect(Number(claudeDriver.invocation(base).env.MCP_TOOL_TIMEOUT)).toBeGreaterThanOrEqual(2 * 60 * 60_000);
  });

  it('rodada real: sessão, ferramentas, texto, uso cumulativo e fim', () => {
    const ev = run('claude-turn.jsonl');
    expect(ev[0]).toEqual({ type: 'session', id: 'a202b58e-04e5-40b3-bbe5-0cbe9be49d86' });
    expect(ev).toContainEqual({ type: 'tool', id: 'toolu_01DrZF1NgtQPYtyUAaaAaShC', name: 'Read', input: 'C:\\proj\\a.txt' });
    expect(ev).toContainEqual({ type: 'tool-result', id: 'toolu_01DrZF1NgtQPYtyUAaaAaShC', output: '1\thello-file\n2\t', error: false });
    expect(ev).toContainEqual({ type: 'tool', id: 'toolu_01VhL9v69zU1xjVKcNRubTQX', name: 'Bash', input: 'rtk git push origin main' });
    expect(ev).toContainEqual({ type: 'tool-result', id: 'toolu_01VhL9v69zU1xjVKcNRubTQX', output: 'Trava: git push recusado', error: true });
    expect(ev.some((e) => e.type === 'tool' && e.id === 'toolu_sub')).toBe(false); // subagente (parent_tool_use_id) não vira item
    expect(ev).toContainEqual({ type: 'text', text: 'Li a.txt; o push foi recusado.' });
    expect(ev).toContainEqual({ type: 'usage', tokensIn: 6 + 33451 + 152029, tokensOut: 590, costUsd: 0.11005549, costIsCumulative: true });
    expect(ev.at(-1)).toEqual({ type: 'done', ok: true });
    expect(ev.filter((e) => e.type === 'thinking').length).toBeGreaterThan(0);
  });

  it('erro: done com a mensagem de errors[]; o custo da rodada que falhou também conta', () => {
    const ev = run('claude-error.jsonl', 1);
    expect(ev.at(-1)).toEqual({ type: 'done', ok: false, error: 'No conversation found with session ID: 00000000-0000-4000-8000-000000000000' });
    const p = claudeDriver.parser();
    const budget = p.line(JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, session_id: 's', total_cost_usd: 0.52, usage: { input_tokens: 10, output_tokens: 3 }, errors: ['budget'] }));
    expect(budget).toContainEqual({ type: 'usage', tokensIn: 10, tokensOut: 3, costUsd: 0.52, costIsCumulative: true });
    expect(budget.at(-1)).toEqual({ type: 'done', ok: false, error: 'budget' });
  });

  it('linha quebrada ou desconhecida é ignorada; sem result = falha com stderr', () => {
    const p = claudeDriver.parser();
    expect(p.line('{"type":"assi')).toEqual([]);
    expect(p.line('{"type":"rate_limit_event"}')).toEqual([]);
    expect(p.end(1, 'boom')).toEqual([{ type: 'done', ok: false, error: 'boom' }]);
  });
});
