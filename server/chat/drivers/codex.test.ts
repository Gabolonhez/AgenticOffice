import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODEX_JARVIS_OFF, codexArgs, codexDriver, prepareCodexHome } from './codex';
import type { ChatEvent, TurnSpec } from '../types';

const fx = (n: string) => readFileSync(join(__dirname, '..', 'fixtures', n), 'utf8').split(/\r?\n/).filter(Boolean);
const run = (n: string, exit = 0): ChatEvent[] => { const p = codexDriver.parser(); return [...fx(n).flatMap((l) => p.line(l)), ...p.end(exit, '')]; };

describe('chat: driver do Codex', () => {
  it('argv: exec na 1ª, exec resume depois; acesso total e papel por -c; pedido por stdin', () => {
    const s: TurnSpec = { folder: 'C:\\proj', prompt: '--x', first: true, permission: 'auto', role: 'Diga "oi"\n' };
    expect(codexArgs(s)).toEqual(['exec', '--json', '--skip-git-repo-check',
      '-c', 'sandbox_mode="danger-full-access"',
      '-c', 'developer_instructions="Diga \\"oi\\"\\n"', '-']);
    expect(codexArgs({ ...s, first: false, resumeId: '01a14670-48d2-7781-8dee-d5aaf4ebd0f3', model: 'gpt-5.6-luna', role: undefined }))
      .toEqual(['exec', 'resume', '01a14670-48d2-7781-8dee-d5aaf4ebd0f3', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="danger-full-access"', '-m', 'gpt-5.6-luna', '-']);
    expect(codexDriver.invocation(s).stdin).toBe('--x');
  });
  it('erro real: aviso vira notice, falha traz a mensagem de dentro do JSON', () => {
    const ev = run('codex-error.jsonl', 1);
    expect(ev[0]).toEqual({ type: 'session', id: '01a14670-09a5-7761-b763-5c4bda855648' });
    expect(ev).toContainEqual({ type: 'notice', text: 'Model metadata for `gpt-6.1-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' });
    expect(ev.at(-1)).toEqual({ type: 'done', ok: false, error: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." });
  });
  it('rodada: comando, arquivo, texto e uso em tokens (sem US$)', () => {
    const ev = run('codex-turn.jsonl');
    expect(ev).toContainEqual({ type: 'tool', id: 'item_1', name: 'command', input: 'git push origin main' });
    expect(ev).toContainEqual({ type: 'tool-result', id: 'item_1', output: 'Everything up-to-date', error: false });
    expect(ev).toContainEqual({ type: 'tool', id: 'item_2', name: 'file_change', input: 'add C:\\proj\\c.txt' });
    expect(ev).toContainEqual({ type: 'text', text: 'ok' });
    expect(ev).toContainEqual({ type: 'usage', tokensIn: 1200, tokensOut: 40 });
    expect(ev.at(-1)).toEqual({ type: 'done', ok: true });
  });
});

describe('chat: Codex sem push', () => {
  it('denyPush: sandbox workspace-write sem rede no lugar do acesso total', () => {
    const args = codexArgs({ folder: 'C:\proj', prompt: 'x', first: true, permission: 'auto', denyPush: true });
    expect(args).toContain('sandbox_mode="workspace-write"');
    expect(args).toContain('sandbox_workspace_write.network_access=false');
    expect(args).not.toContain('sandbox_mode="danger-full-access"');
  });
});

describe('chat: Codex sem ferramentas internas (Jarvis)', () => {
  it('só leitura, sem shell nem web, MCP do escritório por -c e token só no env', () => {
    const s: TurnSpec = { folder: 'C:\j', prompt: 'oi', first: true, permission: 'ask', tools: '', mcp: { url: 'http://127.0.0.1:4747/api/chat/mcp/chat%3Ajarvis', token: 'segredo' } };
    const args = codexArgs(s);
    expect(args).toContain('sandbox_mode="read-only"');
    expect(args).toContain('features.shell_tool=false');
    expect(args).toContain('features.unified_exec=false');
    expect(args).toContain('mcp_servers.habblaud.url="http://127.0.0.1:4747/api/chat/mcp/chat%3Ajarvis"');
    expect(args.join(' ')).not.toContain('segredo');
    expect(codexDriver.invocation(s).env.HABBLAUD_MCP_TOKEN).toBe('segredo');
    expect(codexDriver.invocation({ ...s, tools: undefined }).env.HABBLAUD_MCP_TOKEN).toBeUndefined();
  });

  it('desliga plugins, apps, MCPs de recurso, navegador, computador, hooks, skills e as regras do usuário', () => {
    const s: TurnSpec = { folder: 'C:\\j', prompt: 'oi', first: false, resumeId: 't1', permission: 'ask', tools: '', accountDir: 'C:\\data\\jarvis\\codex-home' };
    const args = codexArgs(s);
    for (const f of ['plugins', 'apps', 'computer_use', 'browser_use', 'code_mode_host', 'multi_agent', 'hooks', 'shell_tool', 'unified_exec']) expect(CODEX_JARVIS_OFF).toContain(f);
    for (const f of CODEX_JARVIS_OFF) expect(args).toContain(`features.${f}=false`);
    expect(args).toContain('--ignore-rules');
    expect(args).toContain('skills.include_instructions=false');
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 't1']);
    expect(codexDriver.invocation(s).env.CODEX_HOME).toBe('C:\\data\\jarvis\\codex-home');
    const normal = codexArgs({ folder: 'C:\\p', prompt: 'x', first: true, permission: 'auto' });
    expect(normal).not.toContain('--ignore-rules');
    expect(normal.join(' ')).not.toContain('features.plugins');
  });

  it('prepareCodexHome: copia o auth.json (só se o de lá for mais novo), config.toml só com o MCP do escritório; sem login, erro', () => {
    const src = mkdtempSync(join(tmpdir(), 'hb-codex-src-'));
    const dir = join(mkdtempSync(join(tmpdir(), 'hb-codex-home-')), 'codex-home');
    expect(prepareCodexHome(dir, src, 'http://127.0.0.1:1/x')).toEqual({ error: expect.stringContaining('codex login') });
    writeFileSync(join(src, 'auth.json'), 'v1');
    writeFileSync(join(src, 'config.toml'), '[mcp_servers.node_repl]\ncommand = "node"\n[features]\nplugins = true\n');
    expect(prepareCodexHome(dir, src, 'http://127.0.0.1:1/x')).toEqual({ dir });
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toBe('v1');
    const config = readFileSync(join(dir, 'config.toml'), 'utf8');
    expect(config).toContain('[mcp_servers.habblaud]\nurl = "http://127.0.0.1:1/x"\nbearer_token_env_var = "HABBLAUD_MCP_TOKEN"');
    expect(config).not.toMatch(/node_repl|features|plugins/);
    // O Codex renovou o token na cópia (mais nova que a de lá): fica.
    writeFileSync(join(dir, 'auth.json'), 'renovado');
    utimesSync(join(src, 'auth.json'), new Date(0), new Date(0));
    prepareCodexHome(dir, src, 'http://127.0.0.1:1/x');
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toBe('renovado');
    // Login novo na conta (mais novo): copia de novo.
    writeFileSync(join(src, 'auth.json'), 'v2');
    utimesSync(join(src, 'auth.json'), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    prepareCodexHome(dir, src, 'http://127.0.0.1:1/x');
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toBe('v2');
    if (process.platform !== 'win32') expect(statSync(join(dir, 'auth.json')).mode & 0o777).toBe(0o600);
  });
  it('mcp_tool_call vira ferramenta mcp__servidor__nome com o resultado', () => {
    const p = codexDriver.parser();
    const ev = [
      ...p.line(JSON.stringify({ type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'habblaud', tool: 'runs_list', arguments: {} } })),
      ...p.line(JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'habblaud', tool: 'runs_list', status: 'completed', result: { content: [{ type: 'text', text: '[]' }] } } })),
    ];
    expect(ev).toEqual([{ type: 'tool', id: 'i1', name: 'mcp__habblaud__runs_list', input: '{}' }, { type: 'tool-result', id: 'i1', output: '[]', error: false }]);
  });
});
