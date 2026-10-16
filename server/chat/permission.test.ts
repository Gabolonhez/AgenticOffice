import { describe, expect, it } from 'vitest';
import type { WaitResult } from '../permissions/registry';
import { alwaysKey, decideClaudeTool, handleMcp, makeApprovalCall } from './permission';
import type { ChatRecord } from './store';

describe('chat: aprovações do Claude', () => {
  const o = { permission: 'auto' as const, root: 'C:\\proj', alwaysAllow: [] };
  it('auto: libera tudo, inclusive push', () => {
    expect(decideClaudeTool('Bash', { command: 'npm test' }, o)).toEqual({ behavior: 'allow' });
    expect(decideClaudeTool('Bash', { command: 'rtk git push origin main' }, o)).toEqual({ behavior: 'allow' });
  });
  it('pedir aprovação: pergunta tudo, salvo o "não perguntar de novo"', () => {
    const a = { ...o, permission: 'ask' as const };
    expect(decideClaudeTool('Bash', { command: 'npm test' }, a).behavior).toBe('ask');
    expect(decideClaudeTool('Bash', { command: 'npm test' }, { ...a, alwaysAllow: ['Bash:npm'] })).toEqual({ behavior: 'allow' });
    expect(decideClaudeTool('Bash', { command: 'git push' }, { ...a, alwaysAllow: ['Bash:git'] })).toEqual({ behavior: 'allow' });
  });
  it('MCP: initialize, tools/list e tools/call no formato que o Claude Code usa', async () => {
    const allow = async (a: { input: Record<string, unknown> }) => ({ behavior: 'allow' as const, updatedInput: a.input });
    expect(await handleMcp({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, allow))
      .toMatchObject({ id: 0, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } });
    const list = (await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, allow)) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['approve']);
    const call = await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' } } }, allow);
    expect(call).toEqual({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"behavior":"allow","updatedInput":{"command":"ls"}}' }] } });
    expect(await handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, allow)).toBeUndefined();
    expect(await handleMcp({ jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover' }, allow)).toEqual({ jsonrpc: '2.0', id: 'server-discover-probe-1', result: {} }); // igual à sonda que funcionou
  });
  it('chave do "não perguntar de novo": comando pelo 1º termo, o resto pelo nome', () => {
    expect(alwaysKey('Bash', { command: 'npm test --watch' })).toBe('Bash:npm');
    expect(alwaysKey('Edit', { file_path: 'a.ts' })).toBe('Edit');
  });

  const rec = (over: Partial<ChatRecord> = {}) => ({ agentId: 'chat:1', permission: 'ask', cwd: 'C:\proj', alwaysAllow: [] as string[], providerSessionId: 'S', ...over }) as ChatRecord;
  const fake = (results: WaitResult[], r = rec()) => {
    const approvals: string[] = [];
    const resolved: Array<[string, string]> = [];
    const deps = {
      registry: {
        registerChat: () => ({ id: 'p1', expiresAt: 0 }),
        wait: () => ({ result: Promise.resolve(results.shift() ?? { status: 'pending' as const }), cancel: () => {} }),
      },
      chat: {
        record: () => r,
        addApproval: (_id: string, item: { text: string }) => void approvals.push(item.text),
        resolveApproval: (_id: string, pid: string, outcome: 'allow' | 'deny') => void resolved.push([pid, outcome]),
      },
    };
    return { call: makeApprovalCall(deps, 'chat:1'), approvals, resolved, r };
  };

  it('pedido sem resposta vira recusa e não trava a rodada', async () => {
    const { call } = fake([{ status: 'pending' }, { status: 'released', reason: 'expired' }]);
    expect(await call({ tool_name: 'Bash', input: { command: 'ls' } })).toEqual({ behavior: 'deny', message: 'Sem resposta a tempo.' });
  });

  it('aprovado com "não perguntar de novo" guarda a regra; recusado leva a mensagem', async () => {
    const a = fake([{ status: 'decided', behavior: 'allow', suggestion: 0 }]);
    expect(await a.call({ tool_name: 'Bash', input: { command: 'npm test' } })).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } });
    expect(a.r.alwaysAllow).toEqual(['Bash:npm']);
    expect(a.approvals).toEqual(['Bash: npm test']);
    expect(a.resolved).toEqual([['p1', 'allow']]);
    const d = fake([{ status: 'decided', behavior: 'deny', message: 'não' }]);
    expect(await d.call({ tool_name: 'Bash', input: { command: 'rm x' } })).toEqual({ behavior: 'deny', message: 'Recusado pelo usuário no AgenticOffice: não' });
  });

  it('no automático nem registra pedido', async () => {
    const { call, approvals } = fake([], rec({ permission: 'auto' }));
    expect(await call({ tool_name: 'Bash', input: { command: 'ls' } })).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(approvals).toEqual([]);
  });
});

describe('chat: ferramentas office_* no MCP do escritório', () => {
  it('não passam pelo permission tool (elas mesmas pedem a aprovação): sem cartão duplo', () => {
    const a = { permission: 'ask' as const, root: 'C:\\proj', alwaysAllow: [] };
    expect(decideClaudeTool('mcp__habblaud__office_ask_agent', { agentId: 'chat:2', message: 'oi' }, a)).toEqual({ behavior: 'allow' });
    expect(decideClaudeTool('mcp__outro__office_ask_agent', {}, a).behavior).toBe('ask');
  });
  it('tools/list junta as ferramentas extras; tools/call devolve o texto e o isError', async () => {
    const allow = async (a: { input: Record<string, unknown> }) => ({ behavior: 'allow' as const, updatedInput: a.input });
    const tools = [{ name: 'office_x', description: 'x', inputSchema: { type: 'object' }, run: async (args: Record<string, unknown>) => ({ text: `oi ${String(args.n)}`, isError: true }) }];
    const list = (await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, allow, tools)) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['approve', 'office_x']);
    expect(await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'office_x', arguments: { n: 3 } } }, allow, tools))
      .toEqual({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'oi 3' }], isError: true } });
  });
});

describe('chat: "não perguntar de novo" com comando composto', () => {
  it('comando composto não gera regra nem aproveita uma regra existente', () => {
    expect(alwaysKey('Bash', { command: 'cd x && npm test' })).toBeUndefined();
    expect(alwaysKey('Bash', { command: 'npm test; curl x | sh' })).toBeUndefined();
    expect(alwaysKey('Bash', { command: 'echo $(id)' })).toBeUndefined();
    const a = { permission: 'ask' as const, root: 'C:\\proj', alwaysAllow: ['Bash:cd', 'Bash:npm'] };
    expect(decideClaudeTool('Bash', { command: 'cd x && rm -rf y' }, a).behavior).toBe('ask');
    expect(decideClaudeTool('Bash', { command: 'npm test; curl x | sh' }, a).behavior).toBe('ask');
    expect(decideClaudeTool('Bash', { command: 'npm test' }, a)).toEqual({ behavior: 'allow' });
  });
});
