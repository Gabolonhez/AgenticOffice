// Tipos internos do chat com agentes: o que cada provedor (drivers/) entrega ao ChatService.
import type { ChatPermission } from '../../shared/chat';
import type { Provider } from '../../shared/types';

export type ChatEvent =
  | { type: 'session'; id: string }
  | { type: 'thinking' }
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: string }
  | { type: 'tool-result'; id: string; output: string; error: boolean }
  | { type: 'notice'; text: string }
  | { type: 'usage'; tokensIn: number; tokensOut: number; costUsd?: number; costIsCumulative?: boolean }
  | { type: 'done'; ok: boolean; error?: string };

/** Lê o stdout de uma rodada, uma linha JSON por vez. */
export interface StreamParser {
  line(raw: string): ChatEvent[];
  end(exitCode: number | null, stderr: string): ChatEvent[];
}

export interface TurnSpec {
  folder: string;
  prompt: string;
  first: boolean;
  sessionId?: string;
  resumeId?: string;
  model?: string;
  role?: string;
  permission: ChatPermission;
  budgetUsd?: number;
  mcp?: { url: string; token: string };
  accountDir?: string;
}

export interface CliInvocation { args: string[]; stdin?: string; env: Record<string, string | undefined> }

export interface ChatDriver {
  readonly provider: Provider;
  invocation(spec: TurnSpec): CliInvocation;
  parser(): StreamParser;
}
