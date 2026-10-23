// Codex sem tela: `codex exec --json` na 1ª rodada e `codex exec resume <thread>` nas outras; pedido por stdin (`-`).
// O `exec` não pede aprovação ação por ação: no chat ele roda com acesso total (decisão do usuário). O resume não aceita
// `--sandbox`/`-C`, então tudo vai por `-c` (TOML) e a pasta é o cwd do processo. Sem push (denyPush): o sandbox
// workspace-write sem rede (o push não sai; também não instala dependências nem faz commit, que o "Juntar" faz).
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tr } from '../../../shared/i18n';
import type { ChatDriver, ChatEvent, StreamParser, TurnSpec } from '../types';

/** Valor TOML de string (os escapes do JSON valem em TOML). */
const toml = (s: string) => JSON.stringify(s);

/** O token do MCP do escritório vai pelo env (nunca no argv). */
export const CODEX_MCP_TOKEN_ENV = 'HABBLAUD_MCP_TOKEN';

/**
 * Recursos do Codex desligados no Jarvis (`codex features list`, 0.154): tudo que roda código, abre navegador ou
 * computador, carrega plugins/apps/skills/hooks ou abre outros agentes. Os que não existirem numa versão são ignorados.
 */
export const CODEX_JARVIS_OFF = [
  'apps',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'code_mode',
  'code_mode_host',
  'computer_use',
  'enable_mcp_apps',
  'goals',
  'guardian_approval',
  'hooks',
  'image_generation',
  'in_app_browser',
  'in_app_chat',
  'in_app_dictation',
  'in_app_local_automation',
  'in_app_updates',
  'memories',
  'mentions_v2',
  'multi_agent',
  'multi_agent_v2',
  'plugin_sharing',
  'plugins',
  'recommended_plugins',
  'remote_plugin',
  'request_permissions_tool',
  'shell_snapshot',
  'shell_tool',
  'skill_mcp_dependency_install',
  'skill_search',
  'sleep_tool',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'unified_exec',
  'unified_exec_tty',
  'view_image',
  'workspace_dependencies',
] as const;

/**
 * Sem ferramentas internas (spec.tools === '', o Jarvis): sandbox só leitura, os recursos de CODEX_JARVIS_OFF
 * desligados, sem skills no prompt, sem as regras de execpolicy do usuário, sem busca na web, sem pedir aprovação, e o
 * MCP do escritório por `-c mcp_servers.habblaud.*` (HTTP com Bearer pelo env). O CODEX_HOME é o isolado do Jarvis
 * (prepareCodexHome): os MCPs, plugins e recursos do ~/.codex/config.toml do usuário não entram.
 */
function noToolsArgs(spec: TurnSpec): string[] {
  const out = ['--ignore-rules', ...CODEX_JARVIS_OFF.flatMap((f) => ['-c', `features.${f}=false`])];
  out.push('-c', 'skills.include_instructions=false', '-c', 'web_search="disabled"', '-c', 'approval_policy="never"', '-c', 'include_apply_patch_tool=false', '-c', 'cli_auth_credentials_store="file"');
  if (spec.mcp) {
    out.push('-c', `mcp_servers.habblaud.url=${toml(spec.mcp.url)}`, '-c', `mcp_servers.habblaud.bearer_token_env_var=${toml(CODEX_MCP_TOKEN_ENV)}`);
    out.push('-c', 'mcp_servers.habblaud.tool_timeout_sec=9000', '-c', 'mcp_servers.habblaud.default_tools_approval_mode="approve"');
  }
  return out;
}

export function codexArgs(spec: TurnSpec): string[] {
  const args = spec.first ? ['exec'] : ['exec', 'resume', spec.resumeId ?? ''];
  const sandbox = spec.tools !== undefined ? 'read-only' : spec.denyPush ? 'workspace-write' : 'danger-full-access';
  args.push('--json', '--skip-git-repo-check', '-c', `sandbox_mode=${toml(sandbox)}`);
  if (spec.tools !== undefined) args.push(...noToolsArgs(spec));
  if (spec.denyPush) args.push('-c', 'sandbox_workspace_write.network_access=false');
  if (spec.role) args.push('-c', `developer_instructions=${toml(spec.role)}`);
  if (spec.model) args.push('-m', spec.model);
  args.push('-');
  return args;
}

/** A pasta do Codex que a CLI usaria sem conta escolhida ($CODEX_HOME ou ~/.codex). */
export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

/**
 * CODEX_HOME isolado do Jarvis: só uma cópia do auth.json (renovada da conta antes de cada rodada quando a de lá é mais
 * nova; modo 600) e um config.toml gerado só com mcp_servers.habblaud. Nada do ~/.codex do usuário (MCPs como o
 * node_repl, plugins, skills, hooks, AGENTS.md, recursos) entra. Devolve a pasta, ou o erro (sem login no Codex).
 */
export function prepareCodexHome(dir: string, source: string, mcpUrl: string | undefined): { dir: string } | { error: string } {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const from = join(source, 'auth.json');
    const to = join(dir, 'auth.json');
    if (existsSync(from) && (!existsSync(to) || statSync(from).mtimeMs > statSync(to).mtimeMs)) copyFileSync(from, to);
    if (!existsSync(to)) return { error: tr('O Codex não tem login para o Jarvis: rode "codex login" (o Jarvis usa uma cópia do auth.json de {0}).', [source]) };
    chmodSync(to, 0o600);
    const config = [
      '# Gerado pelo Habblaud para o Jarvis a cada rodada: só o MCP do escritório. Não edite.',
      ...(mcpUrl ? ['[mcp_servers.habblaud]', `url = ${toml(mcpUrl)}`, `bearer_token_env_var = ${toml(CODEX_MCP_TOKEN_ENV)}`] : []),
      '',
    ].join('\n');
    writeFileSync(join(dir, 'config.toml'), config, { mode: 0o600 });
    chmodSync(join(dir, 'config.toml'), 0o600);
    return { dir };
  } catch (err) {
    return { error: tr('Não deu para preparar a pasta do Codex do Jarvis ({0}).', [err instanceof Error ? err.message : String(err)]) };
  }
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
          if (it?.type === 'mcp_tool_call') return [{ type: 'tool', id: String(it.id), name: `mcp__${String(it.server ?? '')}__${String(it.tool ?? '')}`, input: JSON.stringify(it.arguments ?? {}) }];
          return [];
        case 'item.completed': {
          if (it?.type === 'error') return [{ type: 'notice', text: String(it.message ?? '') }];
          if (it?.type === 'reasoning') return [{ type: 'thinking' }];
          if (it?.type === 'agent_message') return it.text ? [{ type: 'text', text: String(it.text) }] : [];
          if (it?.type === 'command_execution') {
            return [{ type: 'tool-result', id: String(it.id), output: String(it.aggregated_output ?? ''), error: it.status === 'failed' || (typeof it.exit_code === 'number' && it.exit_code !== 0) }];
          }
          if (it?.type === 'mcp_tool_call') {
            const r = it.result?.content;
            const output = Array.isArray(r) ? r.map((c: { text?: unknown }) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : String(it.error?.message ?? '');
            return [{ type: 'tool-result', id: String(it.id), output, error: it.status === 'failed' || !!it.error }];
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
    return { args: codexArgs(spec), stdin: spec.prompt, env: { CODEX_HOME: spec.accountDir, ...(spec.tools !== undefined && spec.mcp ? { [CODEX_MCP_TOKEN_ENV]: spec.mcp.token } : {}) } };
  },
  parser: codexParser,
};
