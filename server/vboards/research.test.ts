import { describe, expect, it } from 'vitest';
import { freshIdeas, parseResearchOutput, researchMessage, researchPrompt, researchTrigger } from './research';

const fence = (o: unknown) => `\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

describe('pesquisa agendada', () => {
  it('valida o resumo e as ideias, e mascara segredos', () => {
    const r = parseResearchOutput(fence({ summary: 'Concorrente X cobra caro', ideas: [{ title: 'Modo offline', description: 'token Bearer abcdef123456789' }, { title: '' }, { nope: 1 }] }));
    expect(r?.ideas).toHaveLength(1);
    expect(r?.ideas[0].description).not.toContain('abcdef123456789');
    for (const bad of ['', fence({ ideas: [] }), fence({ summary: 'x' }), '```json\n{x\n```']) expect(parseResearchOutput(bad)).toBeUndefined();
  });
  it('descarta ideias que já existem', () => {
    const ideas = [{ title: 'Modo offline no app', description: '' }, { title: 'Widget na tela inicial', description: '' }];
    expect(freshIdeas(ideas, [{ title: 'Adicionar modo offline no app', done: false }]).map((i) => i.title)).toEqual(['Widget na tela inicial']);
  });
  it('o modelo de gatilho manda o pedido ao Jarvis e cita o produto', () => {
    const t = researchTrigger('PeptPro', 'chat:jarvis');
    expect(t).toMatchObject({ name: 'Pesquisar ideias para PeptPro', enabled: true, when: { kind: 'schedule' }, do: { kind: 'send', agentId: 'chat:jarvis', message: researchMessage('PeptPro') } });
    expect(researchPrompt('PeptPro', ['a'])).toContain('PeptPro');
  });
});
