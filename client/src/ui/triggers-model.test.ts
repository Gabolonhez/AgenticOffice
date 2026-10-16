import { describe, expect, it } from 'vitest';
import { defaultForm } from './spawn-model';
import { previewText, toTriggerBody, whenText, type TriggerForm } from './triggers-model';

const base = (): TriggerForm => ({
  name: ' Revisão ',
  enabled: true,
  windowMinutes: '30',
  when: 'schedule',
  time: '09:00',
  days: [1, 2, 3, 4, 5],
  minutes: '',
  watch: '',
  alsoFailed: false,
  filesFolder: '',
  glob: '',
  debounceSec: '60',
  action: 'open',
  open: { ...defaultForm('/proj', [{ id: 'claude', available: true }]), roleId: 'qa', permission: 'ask', prompt: 'Revise {{arquivos}}' },
  sendTo: '',
  message: '',
});

describe('gatilhos: formulário', () => {
  it('vira o corpo da rota', () => {
    expect(toTriggerBody(base())).toEqual({
      name: 'Revisão',
      enabled: true,
      windowMinutes: 30,
      when: { kind: 'schedule', time: '09:00', days: [1, 2, 3, 4, 5] },
      do: { kind: 'open', options: { folder: '/proj', provider: 'claude', roleId: 'qa', permission: 'ask', isolated: false, limits: {} }, prompt: 'Revise {{arquivos}}' },
    });
    expect(toTriggerBody({ ...base(), days: [0, 1, 2, 3, 4, 5, 6] })).toMatchObject({ when: { days: [] } });
    expect(toTriggerBody({ ...base(), when: 'agent', watch: 'role:dev', alsoFailed: true, action: 'send', sendTo: 'chat:1', message: 'oi' })).toMatchObject({
      when: { kind: 'agent', roleId: 'dev', alsoFailed: true },
      do: { kind: 'send', agentId: 'chat:1', message: 'oi' },
    });
    expect(toTriggerBody({ ...base(), when: 'files', filesFolder: '/proj', glob: ' src/**/*.ts ' })).toMatchObject({ when: { kind: 'files', folder: '/proj', glob: 'src/**/*.ts', debounceSec: 60 } });
  });

  it('erros antes de mandar', () => {
    expect(toTriggerBody({ ...base(), name: ' ' })).toHaveProperty('error');
    expect(toTriggerBody({ ...base(), days: [] })).toHaveProperty('error');
    expect(toTriggerBody({ ...base(), when: 'agent', watch: '' })).toHaveProperty('error');
    expect(toTriggerBody({ ...base(), open: { ...base().open, prompt: '' } })).toHaveProperty('error');
    expect(toTriggerBody({ ...base(), action: 'send', sendTo: 'chat:1', message: '' })).toHaveProperty('error');
  });

  it('textos e prévia', () => {
    const names = { agent: (id: string) => id, role: (id: string) => id.toUpperCase() };
    expect(whenText({ kind: 'schedule', time: '09:00', days: [] }, names)).toBe('todo dia às 09:00');
    expect(whenText({ kind: 'agent', roleId: 'dev' }, names)).toBe('quando qualquer DEV terminar');
    expect(previewText('{{regra}}: {{arquivos}}', 'R')).toBe('R: src/a.ts\nsrc/b.ts');
  });
});
