import { describe, expect, it } from 'vitest';
import { historyTail, levelOf, pickVoice, speakable, speechEnvelope, stepVoice, VOICE_OFF, type VoiceEvent, type VoiceUi } from './jarvis-model';

const run = (events: VoiceEvent[], from: VoiceUi = VOICE_OFF) => events.reduce(stepVoice, from);

describe('Jarvis em tela cheia: estados da voz', () => {
  it('conecta, ouve, pensa, fala e volta a ouvir', () => {
    let s = run([{ type: 'start' }]);
    expect(s.phase).toBe('connecting');
    s = run([{ type: 'ready' }, { type: 'hearing', text: 'como está' }], s);
    expect(s).toMatchObject({ phase: 'listening', heard: 'como está' });
    s = stepVoice(s, { type: 'ask', text: 'como está o dia?' });
    expect(s).toMatchObject({ phase: 'thinking', heard: 'como está o dia?', said: '' });
    s = run([{ type: 'reply', text: 'Tudo em ordem.' }, { type: 'speakStart' }], s);
    expect(s).toMatchObject({ phase: 'speaking', said: 'Tudo em ordem.' });
    expect(stepVoice(s, { type: 'speakEnd' }).phase).toBe('listening');
  });

  it('interromper: falando ou pensando volta a ouvir; falar por cima também', () => {
    const speaking = run([{ type: 'start' }, { type: 'ready' }, { type: 'speakStart' }]);
    expect(stepVoice(speaking, { type: 'interrupt' }).phase).toBe('listening');
    expect(stepVoice(speaking, { type: 'hearing', text: 'espera' }).phase).toBe('listening');
    const thinking = run([{ type: 'start' }, { type: 'ready' }, { type: 'ask', text: 'x' }]);
    expect(stepVoice(thinking, { type: 'interrupt' }).phase).toBe('listening');
  });

  it('erro fica até começar de novo; desligado ignora eventos atrasados', () => {
    const err = run([{ type: 'start' }, { type: 'fail', error: 'sem microfone' }, { type: 'ready' }, { type: 'speakStart' }]);
    expect(err).toMatchObject({ phase: 'error', error: 'sem microfone' });
    expect(stepVoice(err, { type: 'start' })).toMatchObject({ phase: 'connecting', error: '' });
    expect(run([{ type: 'speakStart' }, { type: 'reply', text: 'x' }])).toBe(VOICE_OFF);
    expect(run([{ type: 'start' }, { type: 'stop' }])).toBe(VOICE_OFF);
  });

  it('conectando não pula para falando nem ouvindo antes de pronto', () => {
    const c = run([{ type: 'start' }, { type: 'speakStart' }, { type: 'hearing', text: 'a' }]);
    expect(c.phase).toBe('connecting');
  });
});

describe('Jarvis em tela cheia: orb, voz e histórico', () => {
  it('nível: silêncio = 0, sinal forte satura em 1', () => {
    expect(levelOf(new Uint8Array(64).fill(128))).toBe(0);
    expect(levelOf(Uint8Array.from({ length: 64 }, (_, i) => (i % 2 ? 255 : 0)))).toBe(1);
    expect(levelOf([])).toBe(0);
  });

  it('envelope da fala fica entre 0 e 1 e pulsa na fronteira de palavra', () => {
    for (let t = 0; t < 2000; t += 37) {
      const v = speechEnvelope(t);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(speechEnvelope(0, 0)).toBeGreaterThan(speechEnvelope(0));
  });

  it('voz pela língua da página: exata, depois a família, local antes de remota', () => {
    const voices = [
      { name: 'US', lang: 'en-US', localService: true },
      { name: 'PT remota', lang: 'pt-BR', localService: false },
      { name: 'PT local', lang: 'pt-BR', localService: true },
      { name: 'Portugal', lang: 'pt_PT', localService: true },
    ];
    expect(pickVoice(voices, 'pt-BR')?.name).toBe('PT local');
    expect(pickVoice(voices.slice(3), 'pt-BR')?.name).toBe('Portugal');
    expect(pickVoice(voices, 'fr-FR')).toBeUndefined();
    // As neurais grátis do Edge/Chrome ganham das locais (robóticas), mesmo sendo remotas.
    const natural = [...voices, { name: 'Microsoft Francisca Online (Natural) - Portuguese (Brazil)', lang: 'pt-BR', localService: false }];
    expect(pickVoice(natural, 'pt-BR')?.name).toMatch(/Francisca/);
  });

  it('texto falado sem markdown nem código', () => {
    expect(speakable('**Pronto**: veja [o PR](https://x) ```ts\nx\n``` # fim')).toBe('Pronto : veja o PR fim');
  });

  it('histórico: pedidos (sem o embrulho, com a origem), respostas e avisos; sem ferramentas', () => {
    const lines = historyTail([
      { seq: 1, at: 0, kind: 'user', text: 'oi' },
      { seq: 2, at: 0, kind: 'tool', toolId: 't', name: 'x', input: '' },
      { seq: 3, at: 0, kind: 'user', text: '<dados_nao_confiaveis origem="voice" id="">\nabre o agente\n</dados_nao_confiaveis>', from: { agentId: 'voice', name: 'voz' } },
      { seq: 4, at: 0, kind: 'assistant', text: 'Feito.' },
      { seq: 5, at: 0, kind: 'notice', level: 'error', text: 'falhou' },
    ]);
    expect(lines).toEqual([
      { seq: 1, who: 'you', text: 'oi' },
      { seq: 3, who: 'you', text: 'abre o agente', from: 'voz' },
      { seq: 4, who: 'jarvis', text: 'Feito.' },
      { seq: 5, who: 'note', text: 'falhou', error: true },
    ]);
    expect(historyTail(Array.from({ length: 20 }, (_, i) => ({ seq: i, at: 0, kind: 'assistant' as const, text: String(i) })), 3).map((l) => l.text)).toEqual(['17', '18', '19']);
  });
});
