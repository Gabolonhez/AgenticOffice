import { describe, expect, it } from 'vitest';
import { gatePassed, gateReport, parseReview, REPORT_MAX, reviewerFor, runChecks } from './gate';

const cwd = process.cwd();

describe('portão: checagens', () => {
  it('código diferente de 0 reprova; 0 aprova; a saída vem mascarada', async () => {
    expect(await runChecks('node -e "process.exit(1)"', cwd)).toMatchObject({ ok: false });
    const pass = await runChecks(`node -e "console.log(['sk','ant','api03',String('a').repeat(40)].join('-')); console.log('fim')"`, cwd);
    expect(pass.ok).toBe(true);
    expect(pass.tail).toContain('fim');
    expect(pass.tail).not.toContain('aaaaaaaaaaaaaaaaaaaa');
  });

  it('passou do prazo: reprova', async () => {
    expect(await runChecks('node -e "setTimeout(() => {}, 20000)"', cwd, 300)).toMatchObject({ ok: false });
  }, 15_000);
});

describe('portão: revisão e relatório', () => {
  it('primeira linha OK passa; PROBLEMAS (ou nada) reprova; revisão indisponível não reprova', () => {
    expect(parseReview('OK\n- nada').ok).toBe(true);
    expect(parseReview('**OK**').ok).toBe(true);
    expect(parseReview('PROBLEMAS\n- a.ts: quebra o login').ok).toBe(false);
    expect(parseReview('').ok).toBe(false);
    expect(gatePassed({ ok: true, tail: '' }, { error: 'sem rede', by: 'claude' })).toBe(true);
    expect(gatePassed({ ok: false, tail: '' }, undefined)).toBe(false);
    expect(gatePassed(undefined, { ok: false, findings: 'PROBLEMAS', by: 'codex' })).toBe(false);
  });

  it('relatório: branch, checagens, revisão e resumo, cortado em REPORT_MAX', () => {
    const r = gateReport({ branch: 'agentic/lista-1', checks: { ok: false, tail: 'x'.repeat(5000) }, review: { ok: false, findings: 'PROBLEMAS\n- a.ts', by: 'claude/sonnet' }, summary: 'y'.repeat(5000), retried: true });
    expect(r.length).toBeLessThanOrEqual(REPORT_MAX);
    expect(r).toContain('agentic/lista-1');
    expect(r).toContain('FALHARAM');
    expect(r).toContain('PROBLEMAS');
    expect(r.endsWith('…')).toBe(true);
  });

  it('revisor por provedor; sem a CLI do codex/agy cai no claude e diz no relatório', () => {
    const bin = { file: 'x', prefix: [] };
    expect(reviewerFor({ reviewer: 'codex', reviewerModel: 'gpt-5' }, cwd, () => bin).by).toBe('codex/gpt-5');
    expect(reviewerFor({ reviewer: 'antigravity' }, cwd, () => bin).by).toBe('agy');
    expect(reviewerFor({ reviewer: 'claude', reviewerModel: 'opus' }, cwd, () => bin).by).toBe('claude/opus');
    expect(reviewerFor({ reviewer: 'codex' }, cwd, (p) => (p === 'claude' ? bin : undefined)).by).toMatch(/^claude\/sonnet .*codex/);
  });
});
