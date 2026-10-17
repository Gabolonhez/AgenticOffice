import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderTemplate, type TriggerRule } from '../../shared/triggers';
import type { HumanAnswer } from './permission';
import { globMatch, ignoredPath, nextScheduleAt, officeApprover, TriggerService, type TriggerCard, type TriggerDeps } from './triggers';

const PROJ = 'C:\\proj';
const openDo = { kind: 'open', options: { folder: PROJ, provider: 'claude', permission: 'ask', roleId: 'qa' }, prompt: 'Revise ({{motivo}}): {{arquivos}}' };

function setup(over: Partial<TriggerDeps> = {}, file = join(mkdtempSync(join(tmpdir(), 'hb-trig-')), 'triggers.json')) {
  const listeners: Array<(id: string) => void> = [];
  const outcomes = new Map<string, 'done' | 'failed'>();
  const replies = new Map<string, string>();
  const agents: Record<string, { folder: string; roleId?: string }> = { 'chat:ana': { folder: PROJ, roleId: 'dev' }, 'chat:bia': { folder: PROJ } };
  const chat = {
    check: vi.fn((raw: { folder?: string; prompt?: string }) => (raw.folder === PROJ && raw.prompt ? undefined : { error: 'invalid' as const, reason: 'Pasta desconhecida' })),
    open: vi.fn((_raw: unknown, _from?: unknown) => ({ agentId: 'chat:new' })),
    deliver: vi.fn((id: string) => (agents[id] ? { result: new Promise<never>(() => {}), cancel: () => {} } : undefined)),
    onTurnEnd: (cb: (id: string) => void) => void listeners.push(cb),
    turnOutcome: (id: string) => outcomes.get(id),
    lastReply: (id: string) => replies.get(id),
    record: (id: string) => agents[id] as never,
    displayName: (id: string) => (id === 'chat:ana' ? 'Ana (Dev)' : id),
  };
  const cards: Array<TriggerCard & { answer: (a: HumanAnswer) => void; canceled: boolean }> = [];
  const approve = vi.fn((card: TriggerCard) => {
    let answer!: (a: HumanAnswer) => void;
    const result = new Promise<HumanAnswer>((ok) => (answer = ok));
    const c = { ...card, answer, canceled: false };
    cards.push(c);
    return { result, cancel: () => ((c.canceled = true), answer({ answer: 'timeout' })) };
  });
  const watchers: Array<{ folder: string; emit: (rel: string) => void; closed: boolean }> = [];
  const watch = (folder: string, onChange: (rel: string) => void) => {
    const w = { folder, emit: onChange, closed: false };
    watchers.push(w);
    return () => void (w.closed = true);
  };
  let n = 0;
  const svc = new TriggerService({ chat, approve, file, watch, folders: () => [{ path: PROJ }], newId: () => `id${++n}`, ...over });
  svc.load();
  const end = (id: string, outcome: 'done' | 'failed', reply?: string) => {
    outcomes.set(id, outcome);
    if (reply) replies.set(id, reply);
    for (const cb of listeners) cb(id);
  };
  return { svc, chat, cards, approve, watchers, end, file };
}

const rule = (r: ReturnType<TriggerService['create']>) => ('rule' in r ? r.rule : (undefined as unknown as TriggerRule));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('gatilhos: lógica pura', () => {
  it('próximo horário: hoje se ainda não passou, senão o próximo dia permitido', () => {
    const from = new Date(2026, 9, 16, 8, 0).getTime(); // sexta
    expect(nextScheduleAt('09:00', [], from)).toBe(new Date(2026, 9, 16, 9, 0).getTime());
    expect(nextScheduleAt('08:00', [], from)).toBe(new Date(2026, 9, 17, 8, 0).getTime());
    expect(nextScheduleAt('07:30', [1, 2, 3, 4, 5], from)).toBe(new Date(2026, 9, 19, 7, 30).getTime()); // segunda
    expect(nextScheduleAt('23:59', [5], from)).toBe(new Date(2026, 9, 16, 23, 59).getTime());
    expect(nextScheduleAt('00:00', [0], new Date(2026, 9, 18, 0, 0).getTime())).toBe(new Date(2026, 9, 25, 0, 0).getTime());
    expect(nextScheduleAt('25:00', [], from)).toBeUndefined();
  });

  it('glob: ** atravessa pastas, * não; sem barra vale o nome do arquivo', () => {
    expect(globMatch('src/**/*.ts', 'src/a.ts')).toBe(true);
    expect(globMatch('src/**/*.ts', 'src/x/y/a.ts')).toBe(true);
    expect(globMatch('src/**/*.ts', 'lib/a.ts')).toBe(false);
    expect(globMatch('src/*.ts', 'src/x/a.ts')).toBe(false);
    expect(globMatch('*.md', 'docs/a.md')).toBe(true);
    expect(globMatch('*.{ts,tsx}', 'a/b.tsx')).toBe(true);
    expect(globMatch('a?.ts', 'ab.ts')).toBe(true);
    expect(globMatch('a.ts', 'xa.ts')).toBe(false);
    expect(ignoredPath('node_modules/x/a.ts')).toBe(true);
    expect(ignoredPath('a/.git/HEAD')).toBe(true);
    expect(ignoredPath('dist/app.js')).toBe(true);
    expect(ignoredPath('src/distant.ts')).toBe(false);
  });

  it('modelo: troca os conhecidos, deixa os desconhecidos', () => {
    expect(renderTemplate('{{regra}} / {{ motivo }} / {{x}} / {{saida}}', { regra: 'R', motivo: 'M' })).toBe('R / M / {{x}} / ');
  });
});

describe('gatilhos: regras e rotas', () => {
  it('valida a regra', () => {
    const { svc } = setup();
    const base = { name: 'R', when: { kind: 'interval', minutes: 15 }, do: openDo };
    expect(svc.create({ ...base, when: { kind: 'interval', minutes: 5 } })).toMatchObject({ status: 400 });
    expect(svc.create({ ...base, name: '' })).toMatchObject({ status: 400 });
    expect(svc.create({ ...base, when: { kind: 'schedule', time: '9h', days: [1] } })).toMatchObject({ status: 400 });
    expect(svc.create({ ...base, when: { kind: 'schedule', time: '09:00', days: [9] } })).toMatchObject({ status: 400 });
    expect(svc.create({ ...base, when: { kind: 'agent' } })).toMatchObject({ status: 400 });
    expect(svc.create({ ...base, when: { kind: 'files', folder: 'C:\\outra' } })).toMatchObject({ status: 400 });
    expect(svc.create({ ...base, do: { ...openDo, options: { ...openDo.options, folder: 'C:\\x' } } })).toMatchObject({ status: 400 });
    expect(svc.create({ ...base, do: { kind: 'send', agentId: 'chat:zz', message: 'oi' } })).toMatchObject({ status: 400 });
    expect(svc.create({ ...base, windowMinutes: 0 })).toMatchObject({ status: 400 });
    expect(svc.create('lixo')).toMatchObject({ status: 400 });
    const r = rule(svc.create(base));
    expect(r).toMatchObject({ name: 'R', enabled: true, windowMinutes: 30 });
    expect(svc.update(r.id, { ...base, name: 'S', enabled: false })).toMatchObject({ rule: { id: r.id, name: 'S', enabled: false } });
    expect(svc.update('nada', base)).toMatchObject({ status: 404 });
    expect(svc.remove(r.id)).toBe(true);
    expect(svc.list()).toEqual([]);
  });

  it('guarda e lê de novo; arquivo estragado não derruba', () => {
    const a = setup();
    const r = rule(a.svc.create({ name: 'R', when: { kind: 'interval', minutes: 20 }, do: openDo }));
    expect(JSON.parse(readFileSync(a.file, 'utf8')).rules[0].id).toBe(r.id);
    const b = setup({}, a.file);
    expect(b.svc.list()).toEqual([r]);
    writeFileSync(a.file, '{ruim');
    expect(setup({}, a.file).svc.list()).toEqual([]);
    writeFileSync(a.file, JSON.stringify({ rules: [{ id: 'x' }, r], history: 'ruim' }));
    const c = setup({}, a.file);
    expect(c.svc.list()).toEqual([r]);
    expect(c.svc.history()).toEqual([]);
  });
});

describe('gatilhos: o cartão diz o que vai rodar de verdade', () => {
  it('Codex sempre roda no automático, mesmo com "ask" salvo; papel pelo nome', () => {
    const { svc, cards } = setup({ roleName: (id: string) => (id === 'qa' ? 'QA' : undefined) });
    const codex = rule(svc.create({ name: 'C', when: { kind: 'interval', minutes: 15 }, do: { ...openDo, options: { ...openDo.options, provider: 'codex', permission: 'ask' } } }));
    svc.test(codex.id);
    const shown = `${cards[0].text}\n${cards[0].detail}`;
    expect(shown).toContain('permissão automática');
    expect(shown).not.toContain('pede aprovação a cada ação');
    expect(shown).toContain('papel QA');
    expect(shown).not.toContain('papel qa');
  });
});

describe('gatilhos: aprovação', () => {
  it('nada roda sem aprovar; aprovado roda uma vez o que o cartão mostrou', async () => {
    const { svc, chat, cards } = setup();
    const r = rule(svc.create({ name: 'Revisar', when: { kind: 'interval', minutes: 15 }, do: openDo, windowMinutes: 10 }));
    expect(svc.test(r.id)).toBe('ok');
    expect(chat.open).not.toHaveBeenCalled();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ ruleId: r.id, folder: PROJ, timeoutMs: 600_000 });
    expect(cards[0].detail).toContain('Revise (teste manual)');
    expect(svc.history()[0]).toMatchObject({ outcome: 'fired', reason: 'teste manual' });
    cards[0].answer({ answer: 'allow' });
    await flush();
    expect(chat.open).toHaveBeenCalledTimes(1);
    expect(chat.open.mock.calls[0][0]).toMatchObject({ folder: PROJ, permission: 'ask', roleId: 'qa', prompt: 'Revise (teste manual):' });
    expect(svc.history()[0]).toMatchObject({ outcome: 'approved', agentId: 'chat:new' });
  });

  it('"Testar agora" numa regra desligada também só roda se aprovado', async () => {
    const { svc, chat, cards } = setup();
    const r = rule(svc.create({ name: 'R', enabled: false, when: { kind: 'interval', minutes: 15 }, do: { kind: 'send', agentId: 'chat:bia', message: 'oi' } }));
    svc.test(r.id);
    expect(chat.deliver).not.toHaveBeenCalled();
    cards[0].answer({ answer: 'allow' });
    await flush();
    expect(chat.deliver).toHaveBeenCalledTimes(1);
  });

  it('recusa e prazo: nada roda, histórico registra', async () => {
    const { svc, chat, cards } = setup();
    const r = rule(svc.create({ name: 'R', when: { kind: 'interval', minutes: 15 }, do: { kind: 'send', agentId: 'chat:bia', message: 'oi {{hora}}' } }));
    svc.test(r.id);
    cards[0].answer({ answer: 'deny', message: 'agora não' });
    await flush();
    svc.test(r.id);
    cards[1].answer({ answer: 'timeout' });
    await flush();
    expect(chat.deliver).not.toHaveBeenCalled();
    expect(chat.open).not.toHaveBeenCalled();
    expect(svc.history().map((f) => f.outcome)).toEqual(['expired', 'denied']);
    expect(svc.history()[1].note).toBe('agora não');
  });

  it('um cartão por regra: disparos enquanto espera são juntados', async () => {
    const { svc, chat, cards } = setup();
    const r = rule(svc.create({ name: 'R', when: { kind: 'interval', minutes: 15 }, do: { kind: 'send', agentId: 'chat:bia', message: 'oi' } }));
    svc.test(r.id);
    svc.test(r.id);
    svc.test(r.id);
    expect(cards).toHaveLength(1);
    expect(svc.history()).toHaveLength(1);
    expect(svc.history()[0].coalesced).toBe(2);
    cards[0].answer({ answer: 'allow' });
    await flush();
    expect(chat.deliver).toHaveBeenCalledTimes(1);
    expect(chat.deliver.mock.calls[0][0]).toBe('chat:bia');
    svc.test(r.id);
    expect(cards).toHaveLength(2);
  });

  it('ação inválida no disparo vira falha, sem cartão; desligar a regra tira o cartão', async () => {
    const { svc, cards } = setup();
    const r = rule(svc.create({ name: 'R', when: { kind: 'interval', minutes: 15 }, do: { kind: 'send', agentId: 'chat:bia', message: 'oi' } }));
    svc.test(r.id);
    svc.update(r.id, { name: 'R', enabled: false, when: { kind: 'interval', minutes: 15 }, do: { kind: 'send', agentId: 'chat:bia', message: 'oi' } });
    await flush();
    expect(cards[0].canceled).toBe(true);
    expect(svc.history()[0].outcome).toBe('expired');
    const s = rule(svc.create({ name: 'S', when: { kind: 'interval', minutes: 15 }, do: { kind: 'send', agentId: 'chat:ana', message: 'oi' } }));
    const { record } = (svc as unknown as { deps: TriggerDeps }).deps.chat;
    (svc as unknown as { deps: TriggerDeps }).deps.chat.record = (id: string) => (id === 'chat:ana' ? undefined : record(id));
    svc.test(s.id);
    expect(cards).toHaveLength(1);
    expect(svc.history()[0]).toMatchObject({ ruleId: s.id, outcome: 'failed' });
  });
});

describe('gatilhos: quando', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('horário e intervalo pelo relógio', () => {
    vi.setSystemTime(new Date(2026, 9, 16, 8, 59, 0));
    const { svc, cards } = setup();
    rule(svc.create({ name: 'Diária', when: { kind: 'schedule', time: '09:00', days: [] }, do: openDo }));
    rule(svc.create({ name: 'Int', when: { kind: 'interval', minutes: 15 }, do: { kind: 'send', agentId: 'chat:bia', message: 'oi' } }));
    rule(svc.create({ name: 'Off', enabled: false, when: { kind: 'interval', minutes: 15 }, do: openDo }));
    svc.start();
    vi.advanceTimersByTime(30_000);
    expect(cards).toHaveLength(0);
    vi.advanceTimersByTime(60_000);
    expect(cards.map((c) => c.title)).toEqual(['Diária']);
    expect(cards[0].text).toContain('horário 09:00');
    vi.advanceTimersByTime(14 * 60_000);
    expect(cards.map((c) => c.title)).toEqual(['Diária', 'Int']);
    svc.stop();
    vi.advanceTimersByTime(60 * 60_000);
    expect(cards).toHaveLength(2);
  });

  it('agente terminou: por id ou papel, feito (e falhou se marcado), com a saída mascarada', () => {
    const { svc, cards, end } = setup();
    rule(svc.create({ name: 'Ana', when: { kind: 'agent', agentId: 'chat:ana' }, do: { kind: 'send', agentId: 'chat:bia', message: '{{agente}}: {{saida}}' } }));
    rule(svc.create({ name: 'Dev', when: { kind: 'agent', roleId: 'dev', alsoFailed: true }, do: openDo }));
    svc.start();
    end('chat:bia', 'done', 'x');
    expect(cards).toHaveLength(0);
    end('chat:ana', 'done', `pronto token=sk-ant-${'a'.repeat(40)} ${'y'.repeat(5000)}`);
    expect(cards.map((c) => c.title)).toEqual(['Ana', 'Dev']);
    expect(cards[0].text).toContain('Ana (Dev) terminou');
    expect(cards[0].detail).not.toContain('sk-ant-aaaa');
    expect(svc.history().find((f) => f.ruleName === 'Ana')!.action!.length).toBeLessThan(4300);
    svc.stop();
  });

  it('agente que falhou só dispara a regra que pede', () => {
    const { svc, cards, end } = setup();
    rule(svc.create({ name: 'Ana', when: { kind: 'agent', agentId: 'chat:ana' }, do: openDo }));
    rule(svc.create({ name: 'Dev', when: { kind: 'agent', roleId: 'dev', alsoFailed: true }, do: openDo }));
    svc.start();
    end('chat:ana', 'failed');
    expect(cards.map((c) => c.title)).toEqual(['Dev']);
    expect(cards[0].text).toContain('falhou');
  });

  it('arquivos: junta as mudanças pelo debounce, filtra glob e pastas ignoradas', () => {
    const { svc, cards, watchers } = setup();
    const r = rule(svc.create({ name: 'Src', when: { kind: 'files', folder: PROJ, glob: 'src/**/*.ts', debounceSec: 60 }, do: openDo }));
    svc.start();
    expect(watchers).toHaveLength(1);
    const w = watchers[0];
    w.emit('src/a.ts');
    vi.advanceTimersByTime(40_000);
    w.emit('src/b/c.ts');
    w.emit('node_modules/x.ts');
    w.emit('README.md');
    vi.advanceTimersByTime(40_000);
    expect(cards).toHaveLength(0);
    vi.advanceTimersByTime(20_000);
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toContain('src/a.ts');
    expect(cards[0].detail).toContain('src/a.ts\nsrc/b/c.ts');
    expect(cards[0].detail).not.toContain('README');
    svc.update(r.id, { name: 'Src', enabled: false, when: { kind: 'files', folder: PROJ }, do: openDo });
    expect(w.closed).toBe(true);
    svc.stop();
  });
});

describe('gatilhos: cartão no escritório', () => {
  it('o agente "Gatilho" aparece esperando enquanto o cartão espera e sai na resposta', async () => {
    const office = { addMain: vi.fn(), closeMain: vi.fn() };
    const registry = {
      registerChat: vi.fn(() => ({ id: 'p1', expiresAt: 0 })),
      wait: vi.fn(() => ({ result: Promise.resolve({ status: 'decided' as const, behavior: 'allow' as const }), cancel: () => {} })),
      releaseAgent: vi.fn(),
    };
    const ask = officeApprover({ office, registry })({ ruleId: 'r1', title: 'R', folder: PROJ, text: 'resumo', detail: 'tudo', timeoutMs: 1000 });
    expect(office.addMain).toHaveBeenCalledWith(expect.objectContaining({ id: 'trigger:r1', cwd: PROJ, status: 'waiting' }));
    expect(registry.registerChat).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'trigger:r1', tool: 'Gatilho', text: 'resumo', timeoutMs: 1000, input: { regra: 'R', detalhe: 'tudo' } }));
    expect(await ask.result).toEqual({ answer: 'allow' });
    await flush();
    expect(office.closeMain).toHaveBeenCalledWith('trigger:r1');
    ask.cancel();
    expect(registry.releaseAgent).toHaveBeenCalledWith('trigger:r1');
  });
});
