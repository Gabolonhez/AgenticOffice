import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatePassed, gateReport, listShots, parseReview, refineArgs, refinerFor, REPORT_MAX, reviewerFor, runChecks, runQa } from './gate';

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

describe('portão: QA visual', () => {
  const dir = () => join(mkdtempSync(join(tmpdir(), 'hb-qa-')), 'out');
  it('o comando recebe HABBLAUD_QA_DIR e os PNGs viram capturas (até o limite, só .png)', async () => {
    const d = dir();
    const script = "const fs=require('fs'),p=require('path');const d=process.env.HABBLAUD_QA_DIR;for(const n of ['b.png','a.png','c.png','nota.txt'])fs.writeFileSync(p.join(d,n),'x')";
    const r = await runQa(`node -e "${script}"`, cwd, d);
    expect(r.ok).toBe(true);
    expect(r.shots).toEqual(['a.png', 'b.png', 'c.png']);
    expect(listShots(d, 2)).toEqual(['a.png', 'b.png']);
  });

  it('falha não reprova: o relatório só avisa, e o portão segue passando', async () => {
    const r = await runQa('node -e "process.exit(2)"', cwd, dir());
    expect(r.ok).toBe(false);
    expect(gatePassed({ ok: true, tail: '' }, undefined)).toBe(true);
    expect(gateReport({ branch: 'b', checks: { ok: true, tail: '' }, qa: r })).toContain('QA visual: FALHOU');
    expect(gateReport({ branch: 'b', qa: { ok: true, tail: '', shots: ['a.png'] } })).toContain('QA visual: 1 captura');
  });

  it('passada nova limpa as capturas antigas', async () => {
    const d = dir();
    await runQa('node -e "1"', cwd, d);
    writeFileSync(join(d, 'velha.png'), 'x');
    expect((await runQa('node -e "1"', cwd, d)).shots).toEqual([]);
  });
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
    const r = gateReport({ branch: 'agentic/lista-1', checks: { ok: false, tail: 'x'.repeat(5000) }, review: { ok: false, findings: 'PROBLEMAS\n- a.ts', by: 'claude/sonnet' }, summary: 'y'.repeat(5000), retried: true, missing: ['falta.env'] });
    expect(r).toContain('falta.env');
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

describe('Refinar: rodada só de leitura por provedor', () => {
  it('claude só com Read/Grep/Glob e o orçamento; codex read-only; agy em plan; sem a CLI cai no claude', () => {
    const claude = refineArgs('claude', 1.5, 'pedido');
    expect(claude).toEqual(expect.arrayContaining(['--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--max-budget-usd', '1.5']));
    expect(claude.join(' ')).not.toMatch(/bypassPermissions|pedido/);
    expect(refineArgs('codex', 1, 'pedido')).toEqual(expect.arrayContaining(['exec', '--sandbox', 'read-only', '-']));
    expect(refineArgs('antigravity', 1, 'pedido')).toEqual(expect.arrayContaining(['--mode', 'plan', '--print=pedido']));
    expect(refineArgs('antigravity', 1, 'x').join(' ')).not.toContain('dangerously');
    const bin = { file: 'x', prefix: [] };
    expect(refinerFor('codex', cwd, 1, () => bin).by).toBe('codex');
    expect(refinerFor('antigravity', cwd, 1, () => bin).by).toBe('agy');
    expect(refinerFor('antigravity', cwd, 1, (p) => (p === 'claude' ? bin : undefined)).by).toMatch(/^claude .*agy/);
  });

  it('sem nenhuma CLI: falha com motivo (vira failed no VBoards)', async () => {
    await expect(refinerFor('claude', cwd, 1, () => undefined).run('x')).rejects.toThrow(/Claude Code/);
  });
});
