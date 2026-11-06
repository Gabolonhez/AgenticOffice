import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunMetric } from '../../shared/runs';
import { setQuiet } from '../log';
import { Briefing, briefingMaterial, briefingPrompt, reportSince, type BriefingInput } from './briefing';

setQuiet(true);

const metric = (o: Partial<RunMetric> = {}): RunMetric => ({ at: 1, runId: 'r', folder: 'C:\\p\\app', state: 'review', gate: 'pass', retried: false, ms: 1000, usd: 0.5, tokens: 100, provider: 'claude', ...o });
const input = (o: Partial<BriefingInput> = {}): BriefingInput => ({
  since: new Date(2026, 9, 23, 8, 0).getTime(),
  summary: {
    subtasks: { queued: { count: 2, items: [] }, running: { count: 1, items: [] }, review: { count: 1, items: [{ id: 's', title: 'Botão novo', project: 'app' }] }, failed: { count: 1, items: [{ id: 'f', title: 'Migração', project: 'api' }] }, doneToday: { count: 3, items: [] } },
    refines: { queued: { count: 0, items: [] }, running: { count: 0, items: [] }, ready: { count: 1, items: [] }, failed: { count: 0, items: [] } },
    tasks: { ideas: { count: 4, items: [] }, backlog: { count: 5, items: [] }, in_progress: { count: 2, items: [] }, code_review: { count: 1, items: [] } },
  },
  metrics: [metric(), metric({ gate: 'fail', retried: true, usd: 1, state: 'failed' })],
  quota: ['Conta a (claude): 5 h 40%, semana 70%'],
  failures: ['gatilho "x": erro'],
  ...o,
});

describe('Jarvis: briefing', () => {
  it('material: listas (contagem, % do portão, voltas, custo, por pasta), VBoards, cota e falhas', () => {
    const m = briefingMaterial(input());
    expect(m).toContain('Desde 08:00');
    expect(m).toContain('2 itens terminaram, portão 50%, 1 voltas de correção, US$ 1.50');
    expect(m).toContain('- app: 2 itens, US$ 1.50, 1 falhas');
    expect(m).toContain('subtarefas na fila 2, rodando 1, em revisão 1, falharam 1, feitas hoje 3');
    expect(m).toContain('Botão novo (app)');
    expect(m).toContain('Migração (api)');
    expect(m).toContain('semana 70%');
    expect(m).toContain('gatilho "x": erro');
    expect(briefingMaterial(input({ summary: undefined, summaryError: 'O token do VBoards precisa do escopo read.', metrics: [] }))).toContain('sem o resumo (O token do VBoards precisa do escopo read.)');
    expect(briefingPrompt(m)).toContain('<dados_nao_confiaveis origem="briefing"');
  });

  it('IA respondeu: o texto dela vai na conversa, a manchete no ntfy e tudo no WhatsApp; guarda o último', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hb-brief-')), 'briefing.json');
    const post = vi.fn();
    const notify = vi.fn(async () => undefined);
    const b = new Briefing({ settings: () => ({ time: '', days: [] }), gather: async () => input(), runner: async () => ({ text: 'Manchete do dia\nlinha 2' }), post, notify, file, now: () => 5_000 });
    const r = await b.run();
    expect(r.fallback).toBeUndefined();
    expect(post.mock.calls[0][0]).toContain('Manchete do dia\nlinha 2');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('linha 2'), 'Manchete do dia');
    expect(post.mock.calls[0][0]).toMatch(/^Briefing \d\d:\d\d\n/);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ lastAt: 5_000 });
    expect(new Briefing({ settings: () => ({ time: '', days: [] }), gather: async () => input(), runner: async () => ({ text: '' }), post, notify, file }).lastAt()).toBe(5_000);
  });

  it('IA falhou: vai a lista simples (o material), com o motivo', async () => {
    const post = vi.fn();
    const b = new Briefing({ settings: () => ({ time: '', days: [] }), gather: async () => input(), runner: async () => Promise.reject(new Error('a IA demorou')), post, notify: async () => undefined, file: join(mkdtempSync(join(tmpdir(), 'hb-brief-')), 'b.json') });
    const r = await b.run();
    expect(r.fallback).toBe('a IA demorou');
    expect(post.mock.calls[0][0]).toContain('subtarefas na fila 2');
  });

  it('relógio: roda no horário; sem hora, nunca', async () => {
    let now = new Date(2026, 9, 23, 8, 59).getTime();
    let time = '09:00';
    const gather = vi.fn(async () => input());
    const b = new Briefing({ settings: () => ({ time, days: [] }), gather, runner: async () => ({ text: 'ok' }), post: () => {}, notify: async () => undefined, file: join(mkdtempSync(join(tmpdir(), 'hb-brief-')), 'b.json'), now: () => now });
    await b.tick();
    expect(gather).not.toHaveBeenCalled();
    now += 2 * 60_000;
    await b.tick();
    await b.tick();
    expect(gather).toHaveBeenCalledTimes(1);
    time = '';
    now += 24 * 60 * 60_000;
    await b.tick();
    expect(gather).toHaveBeenCalledTimes(1);
  });
});

describe('Jarvis: seção por projeto e as rotinas de fechamento e semanal', () => {
  it('material: uma linha por projeto com feito/fazendo/a fazer/travado e alguns títulos', () => {
    const item = (title: string) => ({ title, stage: 'merged' as const, at: 1 });
    const m = briefingMaterial(input({ ledger: [{ project: 'peptpro', folders: ['/p/a'], done: [item('Login'), item('Tela')], doing: [item('X')], todo: [], stuck: [item('CI quebrado')] }] }));
    expect(m).toContain('Projetos:');
    expect(m).toContain('- peptpro: feito 2, fazendo 1, a fazer 0, travado 1');
    expect(m).toContain('  feito: Login; Tela');
    expect(m).toContain('  travado: CI quebrado');
  });

  it('desde quando e o título de cada rotina; o prompt pede o que cada uma tem', async () => {
    const now = new Date(2026, 10, 6, 18, 30).getTime();
    expect(reportSince('closing', now, 0)).toBe(new Date(2026, 10, 6).getTime());
    expect(reportSince('weekly', now, 0)).toBe(now - 7 * 24 * 3_600_000);
    expect(reportSince('briefing', now, 123)).toBe(123);
    expect(briefingPrompt('m', 'closing')).toContain('fica para amanhã');
    expect(briefingPrompt('m', 'weekly')).toContain('custo dos agentes');
    const post = vi.fn();
    const gather = vi.fn(async (since: number) => input({ since }));
    const b = new Briefing({ kind: 'closing', settings: () => ({ time: '', days: [] }), gather, runner: async () => ({ text: 'Dia fechado' }), post, notify: async () => undefined, file: join(mkdtempSync(join(tmpdir(), 'hb-brief-')), 'closing.json'), now: () => now });
    await b.run();
    expect(gather).toHaveBeenCalledWith(new Date(2026, 10, 6).getTime());
    expect(post.mock.calls[0][0]).toMatch(/^Fechamento do dia 18:30\nDia fechado/);
  });
});

describe('Jarvis: semanal com sugestão de versão', () => {
  it('o material lista a versão proposta por app', () => {
    const m = briefingMaterial(input({ versions: [{ app: 'PeptPro', version: '1.5.0', count: 3 }] }));
    expect(m).toContain('Sugestão de versão para a loja:');
    expect(m).toContain('- PeptPro: 1.5.0 (3 tarefas novas)');
    expect(briefingMaterial(input())).not.toContain('Sugestão de versão');
  });
});
