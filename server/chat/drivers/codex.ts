// Codex sem tela: `codex exec --json` na 1ª rodada e `codex exec resume <thread>` nas outras; pedido por stdin (`-`).
// O `exec` não pede aprovação ação por ação: no chat ele roda com acesso total (decisão do usuário). O resume não aceita
// `--sandbox`/`-C`, então tudo vai por `-c` (TOML) e a pasta é o cwd do processo.
import { tr } from '../../../shared/i18n';
import type { ChatDriver, ChatEvent, StreamParser, TurnSpec } from '../types';

/** Valor TOML de string (os escapes do JSON valem em TOML). */
const toml = (s: string) => JSON.stringify(s);

export function codexArgs(spec: TurnSpec): string[] {
  const args = spec.first ? ['exec'] : ['exec', 'resume', spec.resumeId ?? ''];
  args.push('--json', '--skip-git-repo-check', '-c', `sandbox_mode=${toml('danger-full-access')}`);
  if (spec.role) args.push('-c', `developer_instructions=${toml(spec.role)}`);
  if (spec.model) args.push('-m', spec.model);
  args.push('-');
  return args;
}

/** O Codex manda erros da API como JSON dentro da mensagem: mostra só a frase de dentro. */
function errorText(message: unknown): string {
  const raw = typeof message === 'string' ? message : '';
  try {
    const inner = JSON.parse(raw);
    const text = inner?.error?.message ?? inner?.message;
    if (typeof text === 'string') return text;
  } catch {
    // não é JSON
  }
  return raw;
}

function codexParser(): StreamParser {
  let finished = false;
  let lastError: string | undefined;
  return {
    line(raw) {
      let m: Record<string, any>;
      try {
        m = JSON.parse(raw);
      } catch {
        return [];
      }
      const it = m?.item;
      switch (m?.type) {
        case 'thread.started':
          return typeof m.thread_id === 'string' ? [{ type: 'session', id: m.thread_id }] : [];
        case 'error':
          lastError = errorText(m.message);
          return [];
        case 'turn.failed':
          finished = true;
          return [{ type: 'done', ok: false, error: errorText(m.error?.message) || lastError || tr('erro') }];
        case 'turn.completed': {
          finished = true;
          const u = m.usage ?? {};
          return [{ type: 'usage', tokensIn: u.input_tokens ?? 0, tokensOut: u.output_tokens ?? 0 }, { type: 'done', ok: true }];
        }
        case 'item.started':
          if (it?.type === 'command_execution') return [{ type: 'tool', id: String(it.id), name: 'command', input: String(it.command ?? '') }];
          return [];
        case 'item.completed': {
          if (it?.type === 'error') return [{ type: 'notice', text: String(it.message ?? '') }];
          if (it?.type === 'reasoning') return [{ type: 'thinking' }];
          if (it?.type === 'agent_message') return it.text ? [{ type: 'text', text: String(it.text) }] : [];
          if (it?.type === 'command_execution') {
            return [{ type: 'tool-result', id: String(it.id), output: String(it.aggregated_output ?? ''), error: it.status === 'failed' || (typeof it.exit_code === 'number' && it.exit_code !== 0) }];
          }
          if (it?.type === 'file_change') {
            const input = (Array.isArray(it.changes) ? it.changes : []).map((c: { kind?: string; path?: string }) => `${c.kind ?? ''} ${c.path ?? ''}`.trim()).join('\n');
            const out: ChatEvent[] = [{ type: 'tool', id: String(it.id), name: 'file_change', input }];
            out.push({ type: 'tool-result', id: String(it.id), output: '', error: it.status === 'failed' });
            return out;
          }
          return [];
        }
        default:
          return [];
      }
    },
    end(code, stderr) {
      if (finished) return [];
      return [{ type: 'done', ok: false, error: lastError || stderr.trim() || tr('A CLI terminou sem resposta (código {0})', [String(code)]) }];
    },
  };
}

export const codexDriver: ChatDriver = {
  provider: 'codex',
  invocation(spec) {
    return { args: codexArgs(spec), stdin: spec.prompt, env: { CODEX_HOME: spec.accountDir } };
  },
  parser: codexParser,
};
