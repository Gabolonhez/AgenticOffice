import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK_LINES, diffRisk, finalRisk, globToRegex, maxRisk, parseRisk } from './risk';

/** Um arquivo no formato do `git diff`, com as linhas mudadas. */
const file = (path: string, ...lines: string[]) => [`diff --git a/${path} b/${path}`, 'index 1..2 100644', `--- a/${path}`, `+++ b/${path}`, '@@ -1,1 +1,1 @@', ...lines].join('\n');
const level = (diff: string, o = {}) => diffRisk(diff, o).level;

describe('diffRisk: cada padrão de risco alto', () => {
  it.each([
    ['.github/workflows/ci.yml'],
    ['.husky/pre-push'],
    ['.githooks/pre-commit'],
    ['db/migrations/0001_init.ts'],
    ['prisma/migrations/2026/migration.sql'],
    ['drizzle/0002_users.ts'],
    ['scripts/seed.sql'],
    ['src/auth/session.ts'],
    ['server/billing.ts'],
    ['app/payment/checkout.tsx'],
    ['app/Paywall.tsx'],
    ['src/subscriptions.ts'],
    ['lib/stripe.ts'],
    ['src/superwall/config.ts'],
    ['src/RevenueCat.ts'],
    ['.env'],
    ['apps/web/.env.local'],
    ['package-lock.json'],
    ['yarn.lock'],
    ['pnpm-lock.yaml'],
    ['ios/Podfile.lock'],
    ['ios/Podfile'],
    ['android/app/build.gradle'],
    ['eas.json'],
  ])('%s', (path) => {
    const r = diffRisk(file(path, '+x'));
    expect(r.level).toBe('high');
    expect(r.why.join(' ')).toContain(path);
  });

  it('package.json: só dependências (não scripts nem version)', () => {
    expect(level(file('package.json', '-    "build": "tsc"', '+    "build": "tsc -b"'))).toBe('low');
    expect(level(file('package.json', '-  "version": "1.0.0",', '+  "version": "1.0.1",'))).toBe('low');
    expect(level(file('package.json', '+    "lodash": "^4.17.21",'))).toBe('high');
    expect(level(file('package.json', '+  "devDependencies": {'))).toBe('high');
  });

  it('app.json/app.config: só quando o trecho mexe em plugins', () => {
    expect(level(file('app.json', '-    "name": "A",', '+    "name": "B",'))).toBe('low');
    expect(level(file('app.json', ' "plugins": [', '+      "expo-camera",'))).toBe('high');
    expect(level(file('app.config.ts', ' plugins: [', "+    'expo-notifications',"))).toBe('high');
  });

  it('vboards.riskPaths: globs extras (sem / = nome do arquivo)', () => {
    const d = file('src/core/money.ts', '+x');
    expect(level(d)).toBe('low');
    expect(level(d, { extra: ['src/core/**'] })).toBe('high');
    expect(level(file('infra/main.tf', '+x'), { extra: ['*.tf'] })).toBe('high');
    expect(level(file('infra/main.tf', '+x'), { extra: ['other/*.tf'] })).toBe('low');
    expect(diffRisk(d, { extra: ['src/core/**'] }).why[0]).toContain('src/core/**');
  });

  it('diff pequeno e comum = low, sem motivo', () => {
    expect(diffRisk(file('src/ui/button.tsx', '-a', '+b'))).toEqual({ level: 'low', why: [] });
    expect(diffRisk('')).toEqual({ level: 'low', why: [] });
  });
});

describe('diffRisk: médio', () => {
  it('mais linhas que o limite (vboards.riskLines, padrão DEFAULT_RISK_LINES)', () => {
    const lines = (n: number) => file('src/a.ts', ...Array.from({ length: n }, (_, i) => `+l${i}`));
    expect(level(lines(DEFAULT_RISK_LINES))).toBe('low');
    expect(level(lines(DEFAULT_RISK_LINES + 1))).toBe('medium');
    expect(level(lines(11), { maxLines: 10 })).toBe('medium');
  });
  it('volta de correção no portão', () => {
    expect(diffRisk(file('src/a.ts', '+x'), { reworked: true }).level).toBe('medium');
  });
  it('alto continua alto com os motivos de médio juntos', () => {
    const r = diffRisk(file('.env', '+X=1'), { reworked: true });
    expect(r.level).toBe('high');
    expect(r.why).toHaveLength(2);
  });
  it('diff cortado: o arquivo que falta no texto passa pelas regras (e o que dependeria do conteúdo vira alto)', () => {
    expect(level(file('src/a.ts', '+x'), { files: ['src/a.ts'] })).toBe('low');
    expect(level(file('src/a.ts', '+x'), { files: ['src/a.ts', 'src/b.ts'] })).toBe('medium');
    expect(level('', { files: ['.github/workflows/deploy.yml'] })).toBe('high');
    expect(level('', { files: ['package.json'] })).toBe('high');
  });
});

describe('risco final', () => {
  const calc = (l: 'low' | 'medium' | 'high') => ({ level: l, why: l === 'low' ? [] : ['calc'] });
  it('max entre a IA e o calculado', () => {
    expect(finalRisk([{ risk: 'low' }], calc('low')).level).toBe('low');
    expect(finalRisk([{ risk: 'high', riskWhy: 'paywall' }], calc('low'))).toMatchObject({ level: 'high', why: [expect.stringContaining('paywall')] });
    expect(finalRisk([{ risk: 'low' }, { risk: 'medium' }], calc('low')).level).toBe('medium');
  });
  it('o calculado nunca é rebaixado pela IA', () => {
    expect(finalRisk([{ risk: 'low' }], calc('high')).level).toBe('high');
    expect(finalRisk([{ risk: 'low' }], calc('medium')).level).toBe('medium');
  });
  it('IA ausente conta como medium', () => {
    expect(finalRisk([{}], calc('low')).level).toBe('medium');
    expect(finalRisk([], calc('low')).level).toBe('low');
  });
  it('parseRisk e maxRisk', () => {
    expect([parseRisk('low'), parseRisk(' Baixo '), parseRisk('high'), parseRisk('ALTO'), parseRisk('medium'), parseRisk(''), parseRisk(null)]).toEqual(['low', 'low', 'high', 'high', 'medium', 'medium', 'medium']);
    expect(maxRisk('low', 'high', 'medium')).toBe('high');
    expect(maxRisk()).toBe('low');
  });
  it('globToRegex', () => {
    expect(globToRegex('src/**/x.ts').test('src/x.ts')).toBe(true);
    expect(globToRegex('src/**/x.ts').test('src/a/b/x.ts')).toBe(true);
    expect(globToRegex('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegex('a?.ts').test('ab.ts')).toBe(true);
  });
});
