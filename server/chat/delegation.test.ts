import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { PermissionRegistry } from '../permissions/registry';
import { Delegation } from './delegation';
import { ChatService, type ChatProcess } from './service';

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

const flush = () => new Promise((r) => setTimeout(r, 20));

async function setup(o: { callerPermission?: 'auto' | 'ask'; minuteMs?: number; maxWaits?: number } = {}) {
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  let registry: PermissionRegistry | undefined;
  const office = new Office({
    names: new NameStore(null),
    version: '9',
    startedAt: 0,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    permissions: () => registry?.snapshot() ?? new Map(),
  });
  registry = new PermissionRegistry({ office, viewers: () => 0, now: clock.now });
  const procs: FakeProc[] = [];
  let n = 0;
  const chat = new ChatService({
    office,
    dataDir: mkdtempSync(join(tmpdir(), 'hb-deleg-')),
    port: 4747,
    knownFolders: () => ['C:\\proj', 'C:\\outro'],
    accounts: { find: () => undefined } as never,
    bins: () => ({ file: 'claude.exe', prefix: [] }),
    spawnProcess: () => {
      const p = new FakeProc();
      procs.push(p);
      return p;
    },
    kill: () => procs.at(-1)?.finish([], 1),
    newId: () => String(++n),
    platform: 'win32',
  });
  chat.start();
  const delegation = new Delegation({ chat, registry, folders: () => [{ path: 'C:\\proj', name: 'proj' }, { path: 'C:\\outro' }], minuteMs: o.minuteMs, maxWaits: o.maxWaits });
  const open = async (body: Record<string, unknown>) => {
    const r = chat.open({ folder: 'C:\\proj', provider: 'claude', prompt: 'oi', ...body });
    const id = 'agentId' in r ? r.agentId : '';
    procs.at(-1)!.finish(fixture('claude-turn.jsonl'));
    await flush();
    return id;
  };
  const a = await open({ name: 'Ana', roleId: 'orquestrador', permission: o.callerPermission ?? 'auto' });
  const b = await open({ name: 'Bia', roleId: 'dev' });
  const tool = (caller: string, name: string) => delegation.tools(caller).find((t) => t.name === name)!;
  const card = (agentId: string) => registry!.snapshot().get(agentId);
  return { chat, office, registry, delegation, procs, a, b, tool, card, clock };
}

describe('chat: delegação entre agentes (sempre com aprovação do usuário)', () => {
  it('office_list_agents só lê: sem cartão', async () => {
    const { a, b, tool, card } = await setup();
    const r = await tool(a, 'office_list_agents').run({});
    const list = JSON.parse(r.text) as Array<{ id: string; name: string; role: string; you?: boolean }>;
    expect(list.map((x) => [x.id, x.name, x.role, !!x.you])).toEqual([[a, 'Ana', 'Orquestrador', true], [b, 'Bia', 'Dev', false]]);
    expect(card(a)).toBeUndefined();
  });

  for (const mode of ['auto', 'ask'] as const) {
    it(`office_ask_agent no modo ${mode}: cartão primeiro; aprovado entrega com remetente e devolve a resposta final`, async () => {
      const { chat, registry, delegation, procs, a, b, tool, card } = await setup({ callerPermission: mode });
      const spawnedBefore = procs.length;
      const pending = tool(a, 'office_ask_agent').run({ agentId: b, message: 'revise o diff' });
      await flush();
      expect(card(a)?.text).toBe('Ana (Orquestrador) quer mandar para Bia (Dev): revise o diff');
      expect(card(a)?.suggestions).toBeUndefined();
      expect(chat.view(a)!.items.at(-1)).toMatchObject({ kind: 'approval' });
      expect(procs.length).toBe(spawnedBefore); // nada antes da aprovação
      expect(registry.decide(card(a)!.id, { behavior: 'allow' })).toBe('ok');
      await flush();
      expect(procs.length).toBe(spawnedBefore + 1);
      expect(chat.view(b)!.items.at(-1)).toMatchObject({ kind: 'user', text: 'revise o diff', from: { agentId: a, name: 'Ana (Orquestrador)' } });
      procs.at(-1)!.finish(fixture('claude-turn.jsonl'));
      const r = await pending;
      expect(r.isError).toBeUndefined();
      expect(r.text).toContain(chat.lastReply(b)!);
      expect(delegation.links()).toEqual([{ from: a, to: b, at: expect.any(Number) }]);
    });
  }

  it('recusado: devolve a recusa e nada é entregue', async () => {
    const { chat, registry, delegation, procs, a, b, tool, card } = await setup();
    const before = procs.length;
    const pending = tool(a, 'office_ask_agent').run({ agentId: b, message: 'apague tudo' });
    await flush();
    registry.decide(card(a)!.id, { behavior: 'deny', message: 'não' });
    const r = await pending;
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain('recusou');
    expect(procs.length).toBe(before);
    expect(chat.view(b)!.items.some((i) => i.kind === 'user' && i.text === 'apague tudo')).toBe(false);
    expect(delegation.links()).toEqual([]);
  });

  it('sem resposta (prazo do cartão): recusa e nada é entregue', async () => {
    const { registry, procs, a, b, tool, clock } = await setup();
    const before = procs.length;
    const pending = tool(a, 'office_ask_agent').run({ agentId: b, message: 'oi' });
    await flush();
    clock.advance(10 * 60_000);
    registry.tick();
    const r = await pending;
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain('Sem resposta');
    expect(procs.length).toBe(before);
  });

  it('guardas: a si mesmo, agente desconhecido, ciclo e limite de esperas', async () => {
    const { registry, procs, a, b, tool, card } = await setup({ maxWaits: 1 });
    expect((await tool(a, 'office_ask_agent').run({ agentId: a, message: 'x' })).isError).toBe(true);
    expect((await tool(a, 'office_ask_agent').run({ agentId: 'chat:x', message: 'x' })).text).toContain('chat:x');
    const pending = tool(a, 'office_ask_agent').run({ agentId: b, message: 'x' });
    await flush();
    const cycle = await tool(b, 'office_ask_agent').run({ agentId: a, message: 'y' });
    expect(cycle).toMatchObject({ isError: true });
    expect(cycle.text).toContain('ciclo');
    expect(card(b)).toBeUndefined(); // nem chegou a pedir aprovação
    expect((await tool(a, 'office_ask_agent').run({ agentId: b, message: 'z' })).text).toContain('Muitas conversas');
    registry.decide(card(a)!.id, { behavior: 'allow' });
    await flush();
    expect((await tool(b, 'office_ask_agent').run({ agentId: a, message: 'y' })).text).toContain('ciclo');
    procs.at(-1)!.finish(fixture('claude-turn.jsonl'));
    expect((await pending).isError).toBeUndefined();
  });

  it('prazo da resposta: devolve "não respondeu" e tira da fila se ainda não rodou', async () => {
    const { chat, registry, procs, a, b, tool, card } = await setup({ minuteMs: 30 });
    chat.send(b, { text: 'trabalho longo' }); // b ocupado: a mensagem vai para a fila
    const before = procs.length;
    const pending = tool(a, 'office_ask_agent').run({ agentId: b, message: 'oi', timeoutMinutes: 1 });
    await flush();
    registry.decide(card(a)!.id, { behavior: 'allow' });
    const r = await pending;
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain('não respondeu em 1 min');
    procs.at(-1)!.finish(fixture('claude-turn.jsonl'));
    await flush();
    expect(procs.length).toBe(before); // a mensagem saiu da fila
  });

  it('rodada de quem pediu parou: o cartão é solto e a ferramenta recusa', async () => {
    const { chat, a, b, tool, card } = await setup();
    chat.send(a, { text: 'delegue' });
    const pending = tool(a, 'office_ask_agent').run({ agentId: b, message: 'oi' });
    await flush();
    expect(card(a)).toBeDefined();
    chat.stop(a);
    const r = await pending;
    expect(r).toMatchObject({ isError: true });
    expect(card(a)).toBeUndefined();
  });

  it('office_open_agent: cartão diz quem pede e o quê; aprovado abre em "pedir aprovação"; recusado não abre', async () => {
    const { chat, registry, delegation, a, tool, card } = await setup();
    const denied = tool(a, 'office_open_agent').run({ role: 'qa', prompt: 'teste o login' });
    await flush();
    expect(card(a)?.text).toBe('Ana (Orquestrador) quer abrir um agente QA (Claude Code) em proj para: teste o login');
    registry.decide(card(a)!.id, { behavior: 'deny' });
    expect((await denied).isError).toBe(true);
    expect(chat.agentsList()).toHaveLength(2);

    const ok = tool(a, 'office_open_agent').run({ role: 'Dev', folder: 'outro', name: 'Caio', prompt: 'implemente' });
    await flush();
    expect(card(a)?.text).toBe('Ana (Orquestrador) quer abrir um agente Dev (Claude Code) em outro para: implemente');
    registry.decide(card(a)!.id, { behavior: 'allow' });
    const r = await ok;
    const id = chat.agentsList()[2].id;
    expect(r.text).toContain(id);
    expect(chat.record(id)).toMatchObject({ permission: 'ask', folder: 'C:\\outro', roleId: 'dev' });
    expect(chat.view(id)!.items[0]).toMatchObject({ kind: 'user', text: 'implemente', from: { agentId: a } });
    expect(delegation.links().at(-1)).toMatchObject({ from: a, to: id });
    expect((await tool(a, 'office_open_agent').run({ folder: 'C:\\nada', prompt: 'x' })).text).toContain('Pasta desconhecida');
  });
});
