// Chat com agentes abertos pelo escritório (server/chat): o protocolo entre cliente e servidor.
import type { Provider } from './types';

export type ChatPermission = 'auto' | 'ask';
export interface ChatLimits { maxCostUsd?: number; maxTokens?: number; maxTurnMinutes?: number }
export type ChatItem =
  | { seq: number; at: number; kind: 'user'; text: string }
  | { seq: number; at: number; kind: 'assistant'; text: string }
  | { seq: number; at: number; kind: 'tool'; toolId: string; name: string; input: string; output?: string; error?: boolean; blocked?: string }
  | { seq: number; at: number; kind: 'approval'; permissionId: string; tool: string; text: string; outcome?: 'allow' | 'deny' }
  | { seq: number; at: number; kind: 'notice'; level: 'info' | 'error'; text: string }
  | { seq: number; at: number; kind: 'usage'; tokensIn: number; tokensOut: number; costUsd?: number; ms: number };
export type ChatPhase = 'idle' | 'thinking' | 'tool' | 'approval' | 'stopping';
export interface ChatState {
  phase: ChatPhase;
  tool?: string;
  blocked?: 'cost' | 'tokens';
  spentUsd: number;
  spentTokens: number;
  limits: ChatLimits;
  isolated?: { branch: string; merged?: boolean; discarded?: boolean };
}
export interface ChatView { agentId: string; provider: Provider; items: ChatItem[]; state: ChatState; lastSeq: number }
export const CHAT_TEXT_MAX = 8000; // igual ao SPAWN_PROMPT_MAX
export const CHAT_TOOL_OUTPUT_MAX = 4000; // por item, depois de maskSecrets
