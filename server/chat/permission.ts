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

/** Comando que encadeia outros (&&, ||, ;, |, `...`, $(...), quebra de linha): o primeiro termo não diz o que roda. */
export function isCompoundCommand(cmd: string): boolean {
  return /&&|\|\||[;|`\n]|\$\(/.test(cmd);
}

/**
 * "Não perguntar de novo": comandos pelo primeiro termo (Bash:npm), o resto pelo nome da ferramenta. Comando composto
 * não tem regra (undefined): liberar `cd x && npm test` não pode liberar `cd x && qualquer coisa`.
 */
export function alwaysKey(tool: string, input: Record<string, unknown>): string | undefined {
  if (typeof input.command !== 'string') return tool;
  const cmd = input.command.trim();
  if (!cmd || isCompoundCommand(cmd)) return undefined;
  return `${tool}:${cmd.split(/\s+/)[0]}`;
}

/** Ferramentas de delegação do escritório (delegation.ts): pedem a aprovação elas mesmas, nos dois modos. */
export const OFFICE_TOOL_PREFIX = 'mcp__habblaud__office_';

export function decideClaudeTool(tool: string, input: Record<string, unknown>, o: { permission: ChatPermission; root: string; alwaysAllow: readonly string[] }): ToolDecision {
  if (o.permission === 'auto' || tool.startsWith(OFFICE_TOOL_PREFIX)) return { behavior: 'allow' };
  const key = alwaysKey(tool, input);
  return key && o.alwaysAllow.includes(key) ? { behavior: 'allow' } : { behavior: 'ask' };
}

export interface ApprovalDeps {
  registry: Pick<PermissionRegistry, 'registerChat' | 'wait'>;
  chat: {
    record(agentId: string): ChatRecord | undefined;
    addApproval(agentId: string, item: Omit<Extract<ChatItem, { kind: 'approval' }>, 'seq' | 'at'>): void;
    resolveApproval(agentId: string, permissionId: string, outcome: 'allow' | 'deny'): void;
  };
}

/** Resposta do usuário a um cartão: aprovado, recusado (com o motivo) ou sem resposta (prazo, rodada parou). */
export type HumanAnswer = { answer: 'allow'; suggestion?: number } | { answer: 'deny'; message: string } | { answer: 'timeout' } | { answer: 'too-many' };

/**
 * Mostra o cartão (escritório e chat do agente) e espera a resposta. `text` = cartão de delegação (resumo pronto, sem
 * "sempre permitir").
 */
export async function askHuman(deps: ApprovalDeps, agentId: string, req: { tool: string; input: Record<string, unknown>; text?: string; timeoutMs?: number }): Promise<HumanAnswer> {
  const rec = deps.chat.record(agentId);
  const r = deps.registry.registerChat({
    agentId,
    sessionId: rec?.providerSessionId ?? agentId,
    tool: req.tool,
    input: req.input,
    timeoutMs: req.timeoutMs ?? APPROVAL_TIMEOUT_MS,
    ...(req.text ? { text: req.text } : {}),
  });
  if ('skip' in r) return { answer: 'too-many' };
  deps.chat.addApproval(agentId, { kind: 'approval', permissionId: r.id, tool: req.tool, text: req.text ?? `${req.tool}: ${toolInputText(req.input)}` });
  for (;;) {
    const w = deps.registry.wait(r.id, WAIT_SLICE_MS);
    const res = w ? await w.result : undefined;
    if (res?.status === 'pending') continue;
    const allowed = res?.status === 'decided' && res.behavior === 'allow';
    deps.chat.resolveApproval(agentId, r.id, allowed ? 'allow' : 'deny');
    if (res?.status === 'decided' && res.behavior === 'allow') return { answer: 'allow', ...(res.suggestion !== undefined ? { suggestion: res.suggestion } : {}) };
    if (res?.status === 'decided' && res.behavior === 'deny') return { answer: 'deny', message: res.message ?? '' };
    return { answer: 'timeout' };
  }
}

/** O que o permission tool de um agente faz: decide, ou pergunta ao usuário e espera. */
export function makeApprovalCall(deps: ApprovalDeps, agentId: string): ApprovalCall {
  return async ({ tool_name: tool, input }) => {
    const rec = deps.chat.record(agentId);
    if (!rec) return { behavior: 'deny', message: tr('Agente não encontrado.') };
    const d = decideClaudeTool(tool, input, { permission: rec.permission, root: rec.cwd, alwaysAllow: rec.alwaysAllow });
    if (d.behavior === 'allow') return { behavior: 'allow', updatedInput: input };
    if (d.behavior === 'deny') return d;
    const a = await askHuman(deps, agentId, { tool, input });
    if (a.answer === 'too-many') return { behavior: 'deny', message: tr('Muitos pedidos de aprovação abertos.') };
    if (a.answer === 'allow') {
      const key = alwaysKey(tool, input);
      if (a.suggestion === 0 && key && !rec.alwaysAllow.includes(key)) rec.alwaysAllow.push(key);
      return { behavior: 'allow', updatedInput: input };
    }
    if (a.answer === 'deny') return { behavior: 'deny', message: tr('Recusado pelo usuário no AgenticOffice: {0}', [a.message]) };
    return { behavior: 'deny', message: tr('Sem resposta a tempo.') };
  };
}

/** Ferramenta MCP extra (as office_* de delegation.ts). */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>;
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
export async function handleMcp(body: unknown, call: ApprovalCall, extra: readonly McpTool[] = []): Promise<unknown | undefined> {
  const m = (body && typeof body === 'object' ? body : {}) as { id?: string | number; method?: string; params?: Record<string, any> };
  if (m.id === undefined || m.id === null) return undefined;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return ok({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'habblaud', version: '1' } });
    case 'tools/list':
      return ok({ tools: [TOOL, ...extra.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))] });
    case 'tools/call': {
      const tool = extra.find((t) => t.name === m.params?.name);
      if (tool) {
        const raw = m.params?.arguments;
        const r = await tool.run(raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});
        return ok({ content: [{ type: 'text', text: r.text }], ...(r.isError ? { isError: true } : {}) });
      }
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
