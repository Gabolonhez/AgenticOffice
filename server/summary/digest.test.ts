import { describe, expect, it } from 'vitest';
import type { Activity } from '../../shared/types';
import { buildDigest, digestToList, DIGEST_MAX, localMidnight, type DigestInput } from './digest';

const since = 1_000_000;
const act = (tool: string, text: string, at = since + 10): Activity => ({ id: text, kind: 'other', icon: '', text, tool, at }) as Activity;
const base = (o: Partial<DigestInput> = {}): DigestInput => ({ since, agents: [], chats: [], commits: [], ...o });

describe('buildDigest', () => {
  it('agrupa por projeto: parado hoje = feito, trabalhando = em andamento', () => {
    const d = buildDigest(
      base({
        agents: [
          { project: 'C:\\p\\app', title: 'Corrigir login', working: false, recent: [], lastEventAt: since + 5 },
          { project: 'C:/p/app/', title: 'Novo paywall', working: true, current: 'Editando Paywall.tsx', recent: [], lastEventAt: since + 6 },
          { project: 'C:\\p\\site', title: 'Home', working: false, recent: [], lastEventAt: since + 7 },
        ],
      }),
    );
    expect(d).toEqual([
      { name: 'app', done: ['Corrigir login'], doing: ['Novo paywall — Editando Paywall.tsx'] },
      { name: 'site', done: ['Home'], doing: [] },
    ]);
  });

  it('só o dia de hoje: agente parado desde ontem fica de fora; edições antigas não contam', () => {
    const d = buildDigest(
      base({
        agents: [
          { project: '/p/a', title: 'Antiga', working: false, recent: [], lastEventAt: since - 1 },
          { project: '/p/a', title: 'Nova', working: false, recent: [act('Edit', 'Editando x.ts'), act('Edit', 'Editando velho.ts', since - 5), act('Read', 'Lendo y')], lastEventAt: since + 1 },
        ],
      }),
    );
    expect(d).toEqual([{ name: 'a', done: ['Nova', 'Nova: Editando x.ts'], doing: [] }]);
  });

  it('chat: pedidos, resposta e commits; chat parado desde ontem some', () => {
    const d = buildDigest(
      base({
        chats: [
          { project: '/p/a', name: 'Marina', prompts: ['faça A', 'faça B'], lastReply: 'Pronto', working: false, lastAt: since + 1 },
          { project: '/p/a', name: 'Rui', prompts: ['faça C'], working: true, lastAt: since + 2 },
          { project: '/p/b', name: 'Velho', prompts: ['x'], working: false, lastAt: since - 1 },
        ],
        commits: [{ project: '/p/a', subjects: ['feat: x', 'feat: x'] }],
      }),
    );
    expect(d).toEqual([{ name: 'a', done: ['Marina: faça A', 'Marina: faça B', 'Marina respondeu: Pronto', 'commit: feat: x'], doing: ['Rui: faça C'] }]);
  });

  it('mascara segredos em tudo', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const d = buildDigest(base({ commits: [{ project: '/p/a', subjects: [`fix: usa ${secret}`] }], chats: [{ project: '/p/a', name: 'M', prompts: [`use ${secret}`], working: false, lastAt: since + 1 }] }));
    expect(JSON.stringify(d)).not.toContain(secret);
  });
});

describe('digestToList', () => {
  it('formata as duas seções e avisa quando vazio', () => {
    expect(digestToList([{ name: 'app', done: ['a'], doing: ['b'] }])).toBe('## app\nFeito hoje:\n- a\nEm andamento agora:\n- b');
    expect(digestToList([])).toBe('Nada registrado hoje.');
  });
  it('corta em ~12k', () => {
    const big = [{ name: 'p', done: Array.from({ length: 500 }, (_, i) => `item ${i} ${'x'.repeat(100)}`), doing: [] }];
    expect(digestToList(big).length).toBeLessThanOrEqual(DIGEST_MAX);
  });
});

it('localMidnight devolve 00:00 local', () => {
  const m = new Date(localMidnight(new Date(2026, 9, 16, 15, 30).getTime()));
  expect([m.getDate(), m.getHours(), m.getMinutes()]).toEqual([16, 0, 0]);
});
