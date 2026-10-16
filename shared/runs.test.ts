import { describe, expect, it } from 'vitest';
import { parseChecklist } from './runs';

describe('parseChecklist', () => {
  it('pega só as caixas abertas (- [ ] e * [ ]), sem espaços sobrando', () => {
    const md = ['# Plano', '', '- [ ] criar a tela  ', '* [ ]   testar o fluxo', '- [x] já feito', '- [X] também feito', 'texto solto', '- item sem caixa', '  - [ ] subtarefa'].join('\n');
    expect(parseChecklist(md)).toEqual(['criar a tela', 'testar o fluxo', 'subtarefa']);
  });

  it('ignora caixa vazia e aceita CRLF', () => {
    expect(parseChecklist('- [ ]   \r\n- [ ] a\r\n')).toEqual(['a']);
  });

  it('texto sem itens dá lista vazia', () => {
    expect(parseChecklist('')).toEqual([]);
  });
});
