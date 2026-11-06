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
  /** O --mcp-config do Claude já gravado num arquivo 600 (o token fora do argv). */
  mcpConfigFile?: string;
  accountDir?: string;
  /** Sem `git push` (listas automáticas do VBoards): cada driver usa o que a CLI dele tem; o env do git vale para todos. */
  denyPush?: boolean;
  /** Ferramentas internas da CLI ('' = nenhuma: o Jarvis só tem as do MCP do escritório, onde fica o portão). */
  tools?: string;
}

export interface CliInvocation { args: string[]; stdin?: string; env: Record<string, string | undefined> }

/** Cópia isolada do agente num git worktree (implementação em worktree.ts). */
export interface WorktreeOps {
  /** `copied`/`missing`: os arquivos do vboards.copy que foram copiados e os que não existem na pasta. */
  create(repo: string, agentId: string, label: string): Promise<{ path: string; branch: string; base: string; copied?: string[]; missing?: string[] } | { error: string }>;
  summary(w: { path: string; base: string }): Promise<{ files: number; added: number; removed: number; commits: number; stat: string }>;
  /** Diff da cópia contra a base, com os arquivos novos (git add -A -N antes): o que o revisor do portão lê. */
  diff(w: { path: string; base: string; copied?: string[] }): Promise<string>;
  /** Os `copied` ficam fora do commit; um trabalho que os commitou (desde `base`) não junta. */
  merge(repo: string, w: { path: string; branch: string; base?: string; copied?: string[] }, message: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  discard(repo: string, w: { path: string; branch: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** O que o "Subir" (ship.ts) usa a mais da cópia isolada (implementação em worktree.ts). */
export interface ShipWorktreeOps extends WorktreeOps {
  /** O commit do Juntar sem o merge (mesma checagem dos `copied`): devolve o HEAD da cópia. */
  commit(w: { path: string; base?: string; copied?: string[] }, message: string): Promise<{ ok: true; sha: string } | { ok: false; reason: string }>;
  /** Endereço do remoto (git remote get-url) e o branch padrão dele (refs/remotes/<remote>/HEAD), se houver. */
  remoteInfo(repo: string, remote: string): Promise<{ url?: string; head?: string }>;
  /** Arquivos mudados entre a base da cópia e `sha`. */
  changedFiles(w: { path: string; base: string }, sha: string): Promise<string[]>;
  /** Push só do branch agentic/* da cópia, do SHA aprovado, sem force, com varredura de segredos; token só no env. */
  push(w: { path: string; branch: string; base: string }, o: { url: string; sha: string; token: string; baseBranch: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Fast-forward do checkout local se estiver limpo e na base; devolve o aviso quando não deu. */
  fastForward(repo: string, remote: string, base: string): Promise<string | undefined>;
}

export interface ChatDriver {
  readonly provider: Provider;
  invocation(spec: TurnSpec): CliInvocation;
  parser(): StreamParser;
}
