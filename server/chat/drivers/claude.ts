// Claude Code sem tela: `claude -p --output-format stream-json --verbose`, uma rodada por mensagem, retomada pelo id.
// O pedido vai por stdin (nunca no argv: um texto que começa com "-" viraria opção).
import { tr } from '../../../shared/i18n';
import type { ChatDriver, ChatEvent, StreamParser, TurnSpec } from '../types';

export const PERMISSION_TOOL = 'mcp__habblaud__approve';

export function claudeArgs(spec: TurnSpec): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (spec.first) args.push('--session-id', spec.sessionId ?? '');
  else args.push('--resume', spec.resumeId ?? '');
  args.push('--permission-mode', spec.permission === 'ask' ? 'default' : 'bypassPermissions');
  if (spec.model) args.push('--model', spec.model);
  if (spec.role) args.push('--append-system-prompt', spec.role);
  if (spec.budgetUsd !== undefined) args.push('--max-budget-usd', String(spec.budgetUsd));
  if (spec.mcp && spec.permission === 'ask') {
    const config = { mcpServers: { habblaud: { type: 'http', url: spec.mcp.url, headers: { Authorization: `Bearer ${spec.mcp.token}` } } } };
    args.push('--strict-mcp-config', '--mcp-config', JSON.stringify(config), '--permission-prompt-tool', PERMISSION_TOOL);
  }
  return args;
}

/** O campo que diz o que a ferramenta fez (comando, arquivo, padrão, URL), ou o input inteiro. */
export function toolInputText(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'pattern', 'url']) if (typeof o[k] === 'string') return o[k] as string;
  }
  return JSON.stringify(input ?? {});
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: string; text: string } => !!c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

function claudeParser(): StreamParser {
  let session = false;
  let finished = false;
  return {
    line(raw) {
      let m: Record<string, any>;
      try {
        m = JSON.parse(raw);
      } catch {
        return [];
      }
      if (!m || typeof m !== 'object') return [];
      const out: ChatEvent[] = [];
      if (!session && typeof m.session_id === 'string') {
        session = true;
        out.push({ type: 'session', id: m.session_id });
      }
      // Subagentes rodam dentro da rodada; só o agente principal vira item do chat.
      if (m.parent_tool_use_id) return out;
      if (m.type === 'system' && m.subtype === 'thinking_tokens') out.push({ type: 'thinking' });
      else if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
        for (const c of m.message.content) {
          if (c?.type === 'thinking') out.push({ type: 'thinking' });
          else if (c?.type === 'text' && typeof c.text === 'string' && c.text) out.push({ type: 'text', text: c.text });
          else if (c?.type === 'tool_use') out.push({ type: 'tool', id: String(c.id), name: String(c.name), input: toolInputText(c.input) });
        }
      } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
        for (const c of m.message.content) {
          if (c?.type === 'tool_result') out.push({ type: 'tool-result', id: String(c.tool_use_id), output: resultText(c.content), error: c.is_error === true });
        }
      } else if (m.type === 'result') {
        finished = true;
        // Rodada que falhou (inclusive por estourar o orçamento) também gastou: o uso conta no limite.
        const u = m.usage ?? {};
        out.push({
          type: 'usage',
          tokensIn: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          tokensOut: u.output_tokens ?? 0,
          ...(typeof m.total_cost_usd === 'number' ? { costUsd: m.total_cost_usd, costIsCumulative: true } : {}),
        });
        if (m.is_error) {
          const error = (Array.isArray(m.errors) && m.errors.join('\n')) || m.result || m.subtype || tr('erro');
          out.push({ type: 'done', ok: false, error: String(error) });
        } else out.push({ type: 'done', ok: true });
      }
      return out;
    },
    end(code, stderr) {
      if (finished) return [];
      return [{ type: 'done', ok: false, error: stderr.trim() || tr('A CLI terminou sem resposta (código {0})', [String(code)]) }];
    },
  };
}

export const claudeDriver: ChatDriver = {
  provider: 'claude',
  invocation(spec) {
    return { args: claudeArgs(spec), stdin: spec.prompt, env: { CLAUDE_CONFIG_DIR: spec.accountDir } };
  },
  parser: claudeParser,
};
