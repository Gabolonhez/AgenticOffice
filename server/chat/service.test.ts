import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Office } from '../model/office';
import { NameStore } from '../model/names';
import { ChatService, chatOffReason, defaultKill, type ChatProcess, type ChatServiceDeps } from './service';

const fixture = (n: string) => readFileSync(join(__dirname, 'fixtures', n), 'utf8').split(/\r?\n/).filter(Boolean);

class FakeProc extends EventEmitter implements ChatProcess {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  input = '';
  constructor() {
    super();
    this.stdin.on('data', (d) => (this.input += String(d)));
  }
  finish(lines: string[], code = 0): void {
    for (const l of lines) this.stdout.write(`${l}\n`);
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code));
  }
}

interface Spawned { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; proc: FakeProc }

function setup(over: Partial<ChatServiceDeps> = {}, dataDir = mkdtempSync(join(tmpdir(), 'hb-chatsvc-'))) {
  const office = new Office({ names: new NameStore(null), version: '9', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined });
  const spawned: Spawned[] = [];
  const kills: number[] = [];
  const finished: string[] = [];
  let n = 0;
  const deps: ChatServiceDeps = {
    office,
    dataDir,
    port: 4747,
    knownFolders: () => ['C:\\proj'],
    accounts: { find: (id: string) => (id === '.claude-b' ? { id, provider: 'claude', dir: 'C:\\Users\\u\\.claude-b' } : undefined) } as unknown as ChatServiceDeps['accounts'],
    bins: () => ({ file: 'claude.exe', prefix: [] }),
    spawnProcess: (file, args, o) => {
      const proc = new FakeProc();
      spawned.push({ file, args, cwd: o.cwd, env: o.env, proc });
      return proc;
    },
    kill: (pid) => kills.push(pid),
    newId: () => String(++n),
    platform: 'win32',
    onFinish: (id) => finished.push(id),
    ...over,
  };
  const chat = new ChatService(deps);
  chat.start();
  return { chat, office, spawned, kills, finished, dataDir };
}

const flush = () => new Promise((r) => setTimeout(r, 20));
const idOf = (r: ReturnType<ChatService['open']>) => ('agentId' in r ? r.agentId : '');

afterEach(() => vi.useRealTimers());

describe('chat: ChatService', () => {
  it('abre na pasta conhecida, entra no Office trabalhando e fixa o id da conversa', () => {
    const { chat, office, spawned } = setup();
    const r = chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' });
    expect(r).toEqual({ agentId: 'chat:1' });
    expect(office.get('chat:1')).toMatchObject({ kind: 'main', chat: true, status: 'working' });
    expect(office.get('chat:1')?.provider).toBeUndefined(); // claude é o padrão
    const args = spawned[0].args;
    const sid = args[args.indexOf('--session-id') + 1];
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(chat.isChatSession(sid)).toBe(true);
    expect(spawned[0].cwd).toBe('C:\\proj');
    expect(spawned[0].proc.input).toBe('oi');
  });

  it('pasta desconhecida é recusada sem abrir processo', () => {
    const { chat, spawned } = setup();
    expect(chat.open({ folder: 'C:\\outro', provider: 'claude', prompt: 'oi' })).toMatchObject({ error: 'invalid' });
    expect(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: '' })).toMatchObject({ error: 'invalid' });
    expect(spawned).toHaveLength(0);
  });

  it('check valida sem abrir; agente de lista roda na cópia dela e não conta no limite', () => {
    const { chat, spawned } = setup();
    expect(chat.check({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' })).toBeUndefined();
    expect(chat.check({ folder: 'C:\\outro', provider: 'claude', prompt: 'oi' })).toMatchObject({ error: 'invalid' });
    expect(spawned).toHaveLength(0);
    for (let i = 0; i < 8; i++) chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' });
    expect(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' })).toMatchObject({ error: 'too-many' });
    const r = chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'item' }, undefined, { cwd: 'C:\\wt' });
    expect(r).toEqual({ agentId: 'chat:9' });
    expect(spawned.at(-1)?.cwd).toBe('C:\\wt');
    expect(chat.record('chat:9')?.folder).toBe('C:\\proj');
  });

  it('rodada: itens, Office parado com os números e onFinish', async () => {
    const { chat, office, spawned, finished } = setup();
    const id = idOf(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' }));
    spawned[0].proc.finish(fixture('claude-turn.jsonl'));
    await flush();
    const v = chat.view(id)!;
    expect(v.items.map((i) => i.kind)).toEqual(['user', 'tool', 'tool', 'assistant', 'usage']);
    expect(v.items.find((i) => i.kind === 'tool' && i.name === 'Bash')).toMatchObject({ error: true });
    expect(v.state.phase).toBe('idle');
    expect(office.get(id)).toMatchObject({ status: 'idle' });
    expect(office.get(id)?.stats.tokensOut).toBe(590);
    expect(finished).toEqual([id]);
  });

  it('retoma a mesma conversa e recusa mensagem durante a rodada', async () => {
    const { chat, spawned } = setup();
    const id = idOf(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' }));
    expect(chat.send(id, { text: 'de novo' })).toBe('busy');
    const sid = spawned[0].args[spawned[0].args.indexOf('--session-id') + 1];
    spawned[0].proc.finish(fixture('claude-turn.jsonl'));
    await flush();
    expect(chat.send(id, { text: 'de novo' })).toBe('ok');
    expect(spawned[1].args.slice(4, 6)).toEqual(['--resume', sid]);
    expect(chat.send('chat:x', { text: 'a' })).toBe('not-found');
  });

  it('parar mata a árvore do processo e avisa no chat', async () => {
    const { chat, spawned, kills } = setup();
    const id = idOf(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' }));
    expect(chat.stop(id)).toBe('ok');
    expect(kills).toEqual([4242]);
    spawned[0].proc.finish([], 1);
    await flush();
    expect(chat.view(id)!.items.at(-1)).toMatchObject({ kind: 'notice', text: 'Rodada interrompida.' });
    expect(chat.stop(id)).toBe('idle');
  });

  it('kill padrão: taskkill /T /F no Windows, grupo do processo fora dele', () => {
    const exec = vi.fn();
    defaultKill(77, 'win32', exec);
    expect(exec).toHaveBeenCalledWith('taskkill', ['/PID', '77', '/T', '/F']);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    defaultKill(77, 'linux', exec);
    expect(kill).toHaveBeenCalledWith(-77, 'SIGTERM');
    kill.mockRestore();
  });

  it('tempo da rodada: para depois do limite', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { chat, spawned, kills } = setup();
    const id = idOf(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi', limits: { maxTurnMinutes: 1 } }));
    vi.advanceTimersByTime(60_000);
    expect(kills).toEqual([4242]);
    vi.useRealTimers();
    spawned[0].proc.finish([], 1);
    await flush();
    expect(chat.view(id)!.items.at(-1)).toMatchObject({ kind: 'notice', text: 'Tempo da rodada esgotado (1 min).' });
  });

  it('limite de custo bloqueia até aumentar; o restante vai para --max-budget-usd', async () => {
    const { chat, spawned } = setup();
    const id = idOf(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi', limits: { maxCostUsd: 0.1 } }));
    spawned[0].proc.finish(fixture('claude-turn.jsonl'));
    await flush();
    expect(chat.view(id)!.state.blocked).toBe('cost');
    expect(chat.send(id, { text: 'mais' })).toBe('blocked');
    expect(chat.setLimits(id, { maxCostUsd: 1 })).toBe('ok');
    expect(chat.send(id, { text: 'mais' })).toBe('ok');
    const a = spawned[1].args;
    expect(Number(a[a.indexOf('--max-budget-usd') + 1])).toBeCloseTo(0.88994451);
  });

  it('env sem as variáveis da sessão de fora; conta escolhida vira CLAUDE_CONFIG_DIR', () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    process.env.CLAUDE_CODE_SESSION_ID = 'x';
    const { chat, spawned } = setup();
    chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi', account: '.claude-b' });
    expect(spawned[0].env.CLAUDECODE).toBeUndefined();
    expect(spawned[0].env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(spawned[0].env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(spawned[0].env.CLAUDE_CONFIG_DIR).toBe('C:\\Users\\u\\.claude-b');
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    delete process.env.CLAUDE_CODE_SESSION_ID;
  });

  it('depois de reiniciar, o agente volta parado com a mesma conversa', async () => {
    const first = setup();
    const id = idOf(first.chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' }));
    const sid = first.spawned[0].args[first.spawned[0].args.indexOf('--session-id') + 1];
    first.spawned[0].proc.finish(fixture('claude-turn.jsonl'));
    await flush();
    const again = setup({}, first.dataDir);
    expect(again.office.get(id)).toMatchObject({ status: 'idle', chat: true });
    expect(again.chat.view(id)!.items.map((i) => i.kind)).toEqual(['user', 'tool', 'tool', 'assistant', 'usage']);
    expect(again.chat.isChatSession(sid)).toBe(true);
  });

  it('segredo na saída de ferramenta chega mascarado', async () => {
    const { chat, spawned } = setup();
    const id = idOf(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' }));
    const secret = 'sk-ant-api03-' + 'a'.repeat(40);
    spawned[0].proc.finish([
      JSON.stringify({ type: 'assistant', session_id: 's', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat .env' } }] } }),
      JSON.stringify({ type: 'user', session_id: 's', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: `KEY=${secret}` }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's', total_cost_usd: 0, usage: {} }),
    ]);
    await flush();
    const tool = chat.view(id)!.items.find((i) => i.kind === 'tool');
    expect(tool && 'output' in tool ? tool.output : '').not.toContain(secret);
  });
});

describe('chat: correções da revisão', () => {
  it('erro ao abrir o processo (pasta sumiu) vira aviso, sem derrubar o servidor', async () => {
    const { chat, spawned } = setup();
    const id = idOf(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' }));
    const p = spawned[0].proc;
    p.emit('error', Object.assign(new Error('spawn claude.exe ENOENT'), { code: 'ENOENT' }));
    p.stdin.emit('error', new Error('EPIPE'));
    p.finish([], -4058);
    await flush();
    expect(chat.view(id)!.items.at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: 'spawn claude.exe ENOENT' });
    expect(chat.view(id)!.state.phase).toBe('idle');
  });

  it('descartar a cópia volta o agente para a pasta do projeto', async () => {
    const { chat, spawned } = setup({ worktrees: { create: async () => ({ path: 'C:\\wt\\a', branch: 'agentic/a', base: 'b' }), summary: async () => ({ files: 0, added: 0, removed: 0, commits: 0, stat: '' }), merge: async () => ({ ok: true as const }), discard: async () => ({ ok: true as const }) } });
    const id = idOf(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi', isolated: true }));
    await flush();
    expect(spawned[0].cwd).toBe('C:\\wt\\a');
    spawned[0].proc.finish(fixture('claude-turn.jsonl'));
    await flush();
    chat.markIsolated(id, { discarded: true });
    expect(chat.send(id, { text: 'de novo' })).toBe('ok');
    expect(spawned[1].cwd).toBe('C:\\proj');
  });

  it('1ª rodada do Claude interrompida depois de criar a sessão: a próxima retoma (não repete --session-id)', async () => {
    const { chat, spawned } = setup();
    const id = idOf(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' }));
    const sid = spawned[0].args[spawned[0].args.indexOf('--session-id') + 1];
    chat.stop(id);
    spawned[0].proc.finish(fixture('claude-turn.jsonl').slice(0, 2), 1);
    await flush();
    expect(chat.send(id, { text: 'de novo' })).toBe('ok');
    expect(spawned[1].args.slice(4, 6)).toEqual(['--resume', sid]);
  });

  it('stopAll encerra as rodadas em andamento (desligar o servidor)', () => {
    const { chat, kills } = setup();
    chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' });
    chat.stopAll();
    expect(kills).toEqual([4242]);
  });

  it('resultado da última rodada: feita com resposta, falha sem resposta, nada enquanto roda', async () => {
    const { chat, spawned } = setup();
    const ok = idOf(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' }));
    expect(chat.turnOutcome(ok)).toBeUndefined();
    spawned[0].proc.finish(fixture('claude-turn.jsonl'));
    await flush();
    expect(chat.turnOutcome(ok)).toBe('done');
    const bad = idOf(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' }));
    spawned[1].proc.finish(fixture('claude-error.jsonl'), 1);
    await flush();
    expect(chat.turnOutcome(bad)).toBe('failed');
  });

  it('chat desligado: Docker, sem HABBLAUD_PTY ou com a trava do terminal', () => {
    expect(chatOffReason({ inDocker: true, ptyOptIn: true, terminal: true })).toBe('Chat com agentes indisponível no Docker: rode o servidor direto no computador.');
    expect(chatOffReason({ inDocker: false, ptyOptIn: false, terminal: true })).toBe('Chat com agentes desligado: inicie o servidor com HABBLAUD_PTY=1.');
    expect(chatOffReason({ inDocker: false, ptyOptIn: true, terminal: false, terminalReason: 'HABBLAUD_TERMINAL=0' })).toBe('Chat com agentes desligado pela trava do terminal (HABBLAUD_TERMINAL=0).');
    expect(chatOffReason({ inDocker: false, ptyOptIn: true, terminal: true })).toBeUndefined();
  });
});

describe('chat: mensagens entre agentes (deliver)', () => {
  const from = { agentId: 'chat:9', name: 'Ana (Orquestrador)' };

  it('Claude no automático também recebe o MCP do escritório (ferramentas office_*)', () => {
    const { chat, spawned } = setup();
    chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' });
    expect(spawned[0].args).toContain('--mcp-config');
    expect(spawned[0].args).not.toContain('--strict-mcp-config');
  });

  it('agente livre: roda na hora com o remetente, e o resultado traz a resposta final', async () => {
    const { chat, spawned } = setup();
    const id = idOf(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' }, from));
    expect(chat.view(id)!.items[0]).toMatchObject({ kind: 'user', text: 'oi', from });
    spawned[0].proc.finish(fixture('claude-turn.jsonl'));
    await flush();
    const ends: string[] = [];
    chat.onTurnEnd((a) => ends.push(a));
    const d = chat.deliver(id, 'revise o diff', from)!;
    expect(chat.view(id)!.items.at(-1)).toMatchObject({ kind: 'user', text: 'revise o diff', from });
    expect(spawned[1].proc.input).toContain('Ana (Orquestrador)');
    expect(spawned[1].proc.input).toContain('revise o diff');
    spawned[1].proc.finish(fixture('claude-turn.jsonl'));
    expect(await d.result).toEqual({ ok: true, reply: chat.lastReply(id) });
    expect(ends).toEqual([id]);
  });

  it('agente ocupado: entra na fila e roda quando a rodada atual termina; cancelar tira da fila', async () => {
    const { chat, spawned } = setup();
    const id = idOf(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' }));
    const a = chat.deliver(id, 'primeira', from)!;
    const b = chat.deliver(id, 'segunda', from)!;
    expect(spawned).toHaveLength(1);
    b.cancel();
    spawned[0].proc.finish(fixture('claude-turn.jsonl'));
    await flush();
    expect(spawned).toHaveLength(2);
    expect(spawned[1].proc.input).toContain('primeira');
    spawned[1].proc.finish([], 1);
    await flush();
    expect(spawned).toHaveLength(2); // a cancelada não rodou
    expect(await a.result).toMatchObject({ ok: false });
    expect(chat.deliver('chat:x', 'a', from)).toBeUndefined();
  });

  it('parar o agente cancela a fila: a mensagem de outro agente não começa sozinha', async () => {
    const { chat, spawned } = setup();
    const id = idOf(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi' }));
    const a = chat.deliver(id, 'na fila', from)!;
    chat.stop(id);
    spawned[0].proc.finish([], 1);
    await flush();
    expect(spawned).toHaveLength(1);
    expect(await a.result).toMatchObject({ ok: false });
  });

  it('quem espera sempre recebe um fim: CLI sumiu ou limite estourado com várias na fila', async () => {
    let bin = true;
    const { chat, spawned } = setup({ bins: () => (bin ? { file: 'claude.exe', prefix: [] } : undefined) });
    const id = idOf(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi', limits: { maxTokens: 1 } }));
    const a = chat.deliver(id, 'a', from)!;
    const b = chat.deliver(id, 'b', from)!;
    spawned[0].proc.finish(fixture('claude-turn.jsonl')); // gasta mais que 1 token: bloqueado
    expect(await a.result).toMatchObject({ ok: false });
    expect(await b.result).toMatchObject({ ok: false });
    chat.setLimits(id, {});
    bin = false;
    expect(await chat.deliver(id, 'c', from)!.result).toMatchObject({ ok: false });
  });

  it('lista os agentes do chat com nome, papel, pasta e status', async () => {
    const { chat, office } = setup();
    const id = idOf(chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi', roleId: 'dev', name: 'Bia' }));
    expect(chat.agentsList()).toEqual([{ id, name: 'Bia', role: 'Dev', provider: 'claude', folder: 'C:\\proj', status: 'working' }]);
    expect(chat.displayName(id)).toBe('Bia (Dev)');
    expect(office.get(id)?.name).toBe('Bia');
  });
});
