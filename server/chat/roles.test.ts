import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES, LEGACY_ORCHESTRATOR_TEXT, RoleStore } from './roles';

const file = () => join(mkdtempSync(join(tmpdir(), 'hb-roles-')), 'chat', 'roles.json');

describe('chat: papéis', () => {
  it('sem arquivo: os 6 prontos, nesta ordem, sem gravar nada', () => {
    const f = file();
    const s = new RoleStore(f);
    expect(s.list().map((r) => r.name)).toEqual(['Dev', 'QA', 'Revisor', 'Designer', 'Pesquisador', 'Orquestrador']);
    expect(s.list().map((r) => r.id)).toEqual(['dev', 'qa', 'revisor', 'designer', 'pesquisador', 'orquestrador']);
    expect(BUILTIN_ROLES.every((r) => r.text.length > 20)).toBe(true);
    expect(existsSync(f)).toBe(false);
  });

  it('edita, cria e apaga; o que foi apagado continua apagado', () => {
    const f = file();
    const s = new RoleStore(f);
    expect(s.put({ id: 'qa', name: 'QA', text: 'x' })).toMatchObject({ id: 'qa', text: 'x' });
    const novo = s.put({ name: 'Meu', text: 'y' });
    expect(novo).toMatchObject({ name: 'Meu', text: 'y' });
    expect('id' in novo && novo.id).toBeTruthy();
    expect(s.remove('dev')).toBe(true);
    expect(s.remove('nao-existe')).toBe(false);
    const again = new RoleStore(f);
    expect(again.get('dev')).toBeUndefined();
    expect(again.get('qa')?.text).toBe('x');
    expect(again.list().map((r) => r.name)).toContain('Meu');
    expect(existsSync(f)).toBe(true);
  });

  it('Orquestrador: conhece as ferramentas office_* e a aprovação do usuário; o texto antigo guardado é atualizado', () => {
    const text = BUILTIN_ROLES.find((r) => r.id === 'orquestrador')!.text;
    for (const t of ['office_list_agents', 'office_open_agent', 'office_ask_agent', 'aprova']) expect(text).toContain(t);
    const f = file();
    const s = new RoleStore(f);
    s.put({ id: 'orquestrador', name: 'Orquestrador', text: LEGACY_ORCHESTRATOR_TEXT });
    s.put({ id: 'qa', name: 'QA', text: 'meu QA' });
    const again = new RoleStore(f);
    expect(again.get('orquestrador')?.text).toBe(text);
    expect(again.get('qa')?.text).toBe('meu QA');
  });

  it('valida nome e texto', () => {
    const s = new RoleStore(file());
    expect(s.put({ name: '', text: 'a' })).toHaveProperty('error');
    expect(s.put({ name: 'x'.repeat(41), text: 'a' })).toHaveProperty('error');
    expect(s.put({ name: 'ok', text: 'a'.repeat(8001) })).toHaveProperty('error');
    expect(s.put('lixo')).toHaveProperty('error');
  });
});
