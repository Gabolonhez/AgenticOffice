import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProducts, parseProducts, pickRepo, productForCard, productOfFolder, repoHint, saveProducts, type Product } from './products';

const pept: Product = {
  id: 'peptpro',
  name: 'PeptPro',
  cardName: 'Pept Pro',
  repos: [
    { path: 'D:\\Projects\\peptpro\\helix-app', role: 'app' },
    { path: 'D:\\Projects\\peptpro\\helix-server', role: 'server' },
    { path: 'D:\\Projects\\peptpro\\peptpro-web', role: 'web' },
  ],
};
const solo: Product = { id: 'voer', name: 'Voer', cardName: 'Voer', repos: [{ path: '/p/voer/app', role: 'app' }] };

describe('registro de produtos', () => {
  it('valida a lista: id, nome, card, repos com caminho absoluto e papel', () => {
    expect(parseProducts({ products: [pept, solo] })).toEqual({ products: [pept, solo] });
    expect(parseProducts([{ id: 'x', name: 'X', repos: [{ path: '/p/x', role: 'web', remote: 'origin', deploy: 'workflow:deploy.yml', store: 'ota' }] }])).toEqual({
      products: [{ id: 'x', name: 'X', cardName: 'X', repos: [{ path: '/p/x', role: 'web', remote: 'origin', deploy: 'workflow:deploy.yml', store: 'ota' }] }],
    });
    for (const bad of [
      'lixo',
      [{ id: 'X maiúsculo', name: 'a', repos: [{ path: '/p', role: 'app' }] }],
      [{ id: 'a', name: 'a', repos: [] }],
      [{ id: 'a', name: 'a', repos: [{ path: 'relativo', role: 'app' }] }],
      [{ id: 'a', name: 'a', repos: [{ path: '/p/../etc', role: 'app' }] }],
      [{ id: 'a', name: 'a', repos: [{ path: '/p', role: 'mobile' }] }],
      [{ id: 'a', name: 'a', repos: [{ path: '/p', role: 'app', remote: '-x' }] }],
      [{ id: 'a', name: 'a', repos: [{ path: '/p', role: 'app', deploy: 'ssh root@x' }] }],
      [{ id: 'a', name: 'a', repos: [{ path: '/p', role: 'app' }] }, { id: 'b', name: 'b', repos: [{ path: '/P/', role: 'web' }] }],
      [solo, { ...solo, id: 'outro' }],
    ]) expect(parseProducts(bad)).toHaveProperty('error');
  });

  it('acha o produto pelo card (sem caixa nem pontuação) e pela pasta', () => {
    expect(productForCard('PEPT-PRO', [pept, solo])?.id).toBe('peptpro');
    expect(productForCard('peptpro', [pept])?.id).toBe('peptpro');
    expect(productForCard('outro', [pept])).toBeUndefined();
    expect(productOfFolder('d:/projects/peptpro/helix-server/', [solo, pept])?.id).toBe('peptpro');
  });

  it('a subtarefa diz o repo; um repo só = ele; ambíguo = erro pedindo o repo', () => {
    expect(repoHint('[server] corrigir o login')).toBe('server');
    expect(repoHint('corrigir [server]')).toBeUndefined();
    expect(pickRepo(pept, 'server')).toEqual({ path: pept.repos[1].path });
    expect(pickRepo(pept, 'Helix-Server')).toEqual({ path: pept.repos[1].path });
    expect(pickRepo(solo, undefined)).toEqual({ path: '/p/voer/app' });
    const amb = pickRepo(pept, undefined);
    expect('error' in amb && amb.error).toMatch(/3 repositórios.*\[server\]/);
    expect(pickRepo(pept, 'worker')).toHaveProperty('error');
  });

  it('grava e lê o arquivo; estragado = nenhum produto, com o erro', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hb-prod-')), 'products.json');
    expect(loadProducts(file)).toEqual({ products: [] });
    expect(saveProducts(file, { products: [solo] })).toEqual({ products: [solo] });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ products: [solo] });
    expect(loadProducts(file)).toEqual({ products: [solo] });
    expect(saveProducts(file, [{ id: 'a' }])).toHaveProperty('error');
    expect(loadProducts(file)).toEqual({ products: [solo] });
    writeFileSync(file, '{');
    expect(loadProducts(file)).toMatchObject({ products: [], error: expect.any(String) });
  });
});
