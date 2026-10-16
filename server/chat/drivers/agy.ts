// Antigravity sem tela: `agy --print=<pedido> --output-format stream-json`, retomado com `--conversation <id>`.
// O pedido vai grudado no `--print=` (o `-p` consome o argv seguinte e `-- texto` falha), então um texto que começa com
// "-" nunca vira opção. Sem aprovação por ação no modo print: no chat ele roda com acesso total (decisão do usuário).
import { tr } from '../../../shared/i18n';
import type { ChatDriver, StreamParser, TurnSpec } from '../types';

export function agyArgs(spec: TurnSpec): string[] {
  const args = ['--output-format', 'stream-json', '--dangerously-skip-permissions'];
  if (!spec.first && spec.resumeId) args.push('--conversation', spec.resumeId);
  if (spec.model) args.push('--model', spec.model);
  // Sem prompt de sistema por flag (e nada é escrito no projeto): o papel vai no começo da 1ª mensagem.
  const prompt = spec.first && spec.role ? `${spec.role}\n\n---\n\n${spec.prompt}` : spec.prompt;
  args.push(`--print=${prompt}`);
  return args;
}

function agyParser(): StreamParser {
  let finished = false;
  return {
    line(raw) {
      let m: Record<string, any>;
      try {
        m = JSON.parse(raw);
      } catch {
        return [];
      }
      if (m?.event === 'init') return typeof m.conversation_id === 'string' ? [{ type: 'session', id: m.conversation_id }] : [];
      if (m?.event !== 'result') return [];
      finished = true;
      const r = m.result ?? {};
      // Sem login o agy devolve SUCCESS vazio, sem nenhuma rodada.
      if (r.status === 'SUCCESS' && !r.response && !r.num_turns) {
        return [{ type: 'done', ok: false, error: tr('O Antigravity não respondeu. Faça login rodando `agy` num terminal.') }];
      }
      if (r.status !== 'SUCCESS') return [{ type: 'done', ok: false, error: String(r.error ?? r.response ?? r.status ?? tr('erro')) }];
      const u = r.usage ?? {};
      return [
        ...(r.response ? [{ type: 'text' as const, text: String(r.response) }] : []),
        { type: 'usage', tokensIn: u.input_tokens ?? 0, tokensOut: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0) },
        { type: 'done', ok: true },
      ];
    },
    end(code, stderr) {
      if (finished) return [];
      return [{ type: 'done', ok: false, error: stderr.trim() || tr('A CLI terminou sem resposta (código {0})', [String(code)]) }];
    },
  };
}

export const agyDriver: ChatDriver = {
  provider: 'antigravity',
  invocation(spec) {
    return { args: agyArgs(spec), env: {} };
  },
  parser: agyParser,
};
