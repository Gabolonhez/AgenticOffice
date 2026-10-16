// Aprovações do Claude no chat: o `claude -p` chama o permission tool `mcp__habblaud__approve`, que é este servidor
// (MCP por HTTP em /api/chat/mcp/:agentId). No automático tudo passa; em "pedir aprovação" o pedido vira um cartão no
// escritório e no chat (PermissionRegistry.registerChat) e a rodada espera a resposta.
import type { ChatItem, ChatPermission } from '../../shared/chat';
import { tr } from '../../shared/i18n';
import type { PermissionRegistry } from '../permissions/registry';
import { toolInputText } from './drivers/claude';
import type { ChatRecord } from './store';

export type ToolDecision = { behavior: 'allow' } | { behavior: 'ask'; reason?: string } | { behavior: 'deny'; message: string };
export type ApprovalAnswer = { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string };
export type ApprovalCall = (args: { tool_name: string; input: Record<string, unknown>; tool_use_id?: string }) => Promise<ApprovalAnswer>;

/** Prazo de um pedido sem resposta; depois, recusa e a rodada segue. */
export const APPROVAL_TIMEOUT_MS = 300_000;
const WAIT_SLICE_MS = 25_000;

/** "Não perguntar de novo": comandos pelo primeiro termo (Bash:npm), o resto pelo nome da ferramenta. */
export function alwaysKey(tool: string, input: Record<string, unknown>): string {
  const cmd = typeof input.command === 'string' ? input.command.trim().split(/\s+/)[0] : '';
  return cmd ? `${tool}:${cmd}` : tool;
}

export function decideClaudeTool(tool: string, input: Record<string, unknown>, o: { permission: ChatPermission; root: string; alwaysAllow: readonly string[] }): ToolDecision {
  if (o.permission === 'auto') return { behavior: 'allow' };
  return o.alwaysAllow.includes(alwaysKey(tool, input)) ? { behavior: 'allow' } : { behavior: 'ask' };
}

export interface ApprovalDeps {
  registry: Pick<PermissionRegistry, 'registerChat' | 'wait'>;
  chat: {
    record(agentId: string): ChatRecord | undefined;
    addApproval(agentId: string, item: Omit<Extract<ChatItem, { kind: 'approval' }>, 'seq' | 'at'>): void;
    resolveApproval(agentId: string, permissionId: string, outcome: 'allow' | 'deny'): void;
  };
}

/** O que o permission tool de um agente faz: decide, ou pergunta ao usuário e espera. */
export function makeApprovalCall(deps: ApprovalDeps, agentId: string): ApprovalCall {
  return async ({ tool_name: tool, input }) => {
    const rec = deps.chat.record(agentId);
    if (!rec) return { behavior: 'deny', message: tr('Agente não encontrado.') };
    const d = decideClaudeTool(tool, input, { permission: rec.permission, root: rec.cwd, alwaysAllow: rec.alwaysAllow });
    if (d.behavior === 'allow') return { behavior: 'allow', updatedInput: input };
    if (d.behavior === 'deny') return d;
    const r = deps.registry.registerChat({ agentId, sessionId: rec.providerSessionId ?? agentId, tool, input, timeoutMs: APPROVAL_TIMEOUT_MS });
    if ('skip' in r) return { behavior: 'deny', message: tr('Muitos pedidos de aprovação abertos.') };
    deps.chat.addApproval(agentId, { kind: 'approval', permissionId: r.id, tool, text: `${tool}: ${toolInputText(input)}` });
    const timeout: ApprovalAnswer = { behavior: 'deny', message: tr('Sem resposta a tempo.') };
    for (;;) {
      const w = deps.registry.wait(r.id, WAIT_SLICE_MS);
      if (!w) {
        deps.chat.resolveApproval(agentId, r.id, 'deny');
        return timeout;
      }
      const res = await w.result;
      if (res.status === 'pending') continue;
      if (res.status === 'decided' && res.behavior === 'allow') {
        if (res.suggestion === 0) {
          const key = alwaysKey(tool, input);
          if (!rec.alwaysAllow.includes(key)) rec.alwaysAllow.push(key);
        }
        deps.chat.resolveApproval(agentId, r.id, 'allow');
        return { behavior: 'allow', updatedInput: input };
      }
      deps.chat.resolveApproval(agentId, r.id, 'deny');
      if (res.status === 'decided' && res.behavior === 'deny') return { behavior: 'deny', message: tr('Recusado pelo usuário no AgenticOffice: {0}', [res.message ?? '']) };
      return timeout;
    }
  };
}

const TOOL = {
  name: 'approve',
  description: 'Asks the AgenticOffice user to approve a tool call.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name', 'input'],
  },
};

/** JSON-RPC do MCP (Streamable HTTP, uma resposta JSON por POST). undefined = notificação (responder 202). */
export async function handleMcp(body: unknown, call: ApprovalCall): Promise<unknown | undefined> {
  const m = (body && typeof body === 'object' ? body : {}) as { id?: string | number; method?: string; params?: Record<string, any> };
  if (m.id === undefined || m.id === null) return undefined;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return ok({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'habblaud', version: '1' } });
    case 'tools/list':
      return ok({ tools: [TOOL] });
    case 'tools/call': {
      const args = (m.params?.arguments ?? {}) as { tool_name?: unknown; input?: unknown; tool_use_id?: unknown };
      if (m.params?.name !== TOOL.name || typeof args.tool_name !== 'string') {
        return { jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'invalid params' } };
      }
      const input = args.input && typeof args.input === 'object' ? (args.input as Record<string, unknown>) : {};
      const answer = await call({ tool_name: args.tool_name, input, ...(typeof args.tool_use_id === 'string' ? { tool_use_id: args.tool_use_id } : {}) });
      return ok({ content: [{ type: 'text', text: JSON.stringify(answer) }] });
    }
    default:
      return ok({});
  }
}
