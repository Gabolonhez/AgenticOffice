// PIN de aprovação: o hash (scrypt) e o bloqueio no arquivo, e a rota de decisão: cartão crítico sem PIN definido, PIN
// errado, bloqueio depois de 5 erros (sobrevive a reinício), PIN certo, cartão comum sem PIN e "exigir em todos".
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { MAIN, request, servePermissions, type PermissionServer } from '../test/permission-server';
import { ApprovalPin, PIN_LOCK_MS, PIN_MAX_FAILURES } from './pin';

setQuiet(true);

// scrypt barato nos testes (o de verdade usa N = 2^15).
const FAST = { n: 2 ** 10 };
const GOOD = 'cavalo bateria grampo';

const dirs: Array<{ cleanup: () => void }> = [];
let srv: PermissionServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  while (dirs.length) dirs.pop()!.cleanup();
});

function pinFile(): string {
  const t = tempDir();
  dirs.push(t);
  return join(t.dir, 'approval-pin.json');
}

describe('ApprovalPin', () => {
  it('sem PIN: unset; definir pede de 6 caracteres; o arquivo guarda só sal e hash (scrypt)', async () => {
    const file = pinFile();
    const pin = new ApprovalPin(file, FAST);
    expect(await pin.check(GOOD)).toBe('unset');
    expect(await pin.update({ pin: '12345' })).toMatch(/6/);
    expect(await pin.update({ pin: GOOD })).toBeUndefined();
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(GOOD);
    expect(JSON.parse(raw)).toMatchObject({ salt: expect.any(String), hash: expect.any(String), n: FAST.n });
    expect(await pin.check(GOOD)).toBe('ok');
    expect(await pin.check('outra coisa')).toBe('wrong');
    expect(await pin.check(undefined)).toBe('missing');
  });

  it.skipIf(process.platform === 'win32')('o arquivo fica com modo 600', async () => {
    const file = pinFile();
    await new ApprovalPin(file, FAST).update({ pin: GOOD });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it(`${PIN_MAX_FAILURES} erros bloqueiam por 15 min, até o PIN certo; o contador sobrevive a reinício`, async () => {
    const file = pinFile();
    let now = 1_000_000;
    const pin = new ApprovalPin(file, { ...FAST, now: () => now });
    await pin.update({ pin: GOOD });
    for (let i = 0; i < PIN_MAX_FAILURES - 2; i++) expect(await pin.check('errado!')).toBe('wrong');
    // Reinício no meio: os erros continuam contando.
    const again = new ApprovalPin(file, { ...FAST, now: () => now });
    expect(again.triesLeft()).toBe(2);
    expect(await again.check('errado!')).toBe('wrong');
    expect(await again.check('errado!')).toBe('locked');
    expect(await again.check(GOOD)).toBe('locked');
    expect(await new ApprovalPin(file, { ...FAST, now: () => now }).check(GOOD)).toBe('locked');
    now += PIN_LOCK_MS + 1;
    expect(await again.check(GOOD)).toBe('ok');
    expect(again.triesLeft()).toBe(PIN_MAX_FAILURES);
  });

  it('trocar, apagar ou ligar "todos os cartões" pede o PIN atual', async () => {
    const pin = new ApprovalPin(pinFile(), FAST);
    expect(await pin.update({ all: true })).toMatch(/Defina um PIN/);
    await pin.update({ pin: GOOD });
    expect(await pin.update({ pin: 'outro pin longo' })).toMatch(/PIN atual/);
    expect(await pin.update({ all: true, current: GOOD })).toBeUndefined();
    expect(pin.view()).toEqual({ set: true, all: true });
    expect(await pin.update({ pin: 'outro pin longo', current: GOOD })).toBeUndefined();
    expect(await pin.check(GOOD)).toBe('wrong');
    expect(await pin.update({ pin: '', current: 'outro pin longo' })).toBeUndefined();
    expect(pin.view()).toEqual({ set: false, all: false });
  });
});

describe('rota de decisão com o PIN', () => {
  async function serve(o: { set?: boolean; all?: boolean } = {}) {
    const pin = new ApprovalPin(pinFile(), FAST);
    if (o.set !== false) await pin.update({ pin: GOOD, ...(o.all ? { all: true } : {}) });
    srv = await servePermissions({ pin });
    const card = (critical: boolean) => {
      const r = srv!.registry!.registerChat({ agentId: MAIN, sessionId: 's', tool: 'Jarvis · runs_merge', input: {}, timeoutMs: 60_000, text: 'Jarvis quer: runs_merge', body: 'JUNTAR a lista r1\n--- texto completo ---\ntudo', ...(critical ? { critical: true } : {}) });
      if (!('id' in r)) throw new Error('sem cartão');
      return r.id;
    };
    const decide = (id: string, body: unknown) => request(srv!.base, `/api/permissions/${id}/decision`, { method: 'POST', body });
    return { pin, card, decide };
  }

  it('sem PIN definido: o cartão crítico diz "defina um PIN" e não se aprova; recusar vale', async () => {
    const s = await serve({ set: false });
    const id = s.card(true);
    expect(srv!.registry!.detail(id)).toMatchObject({ critical: true, pin: 'unset', input: expect.stringContaining('tudo') });
    const r = await s.decide(id, { behavior: 'allow', pin: GOOD });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ error: expect.stringMatching(/defina um PIN de aprovação em Configurações/) });
    expect((await s.decide(id, { behavior: 'deny' })).status).toBe(200);
  });

  it('PIN errado (403, sem decidir), depois o certo (200); 5 errados bloqueiam (429)', async () => {
    const s = await serve();
    const id = s.card(true);
    expect(srv!.registry!.snapshot().get(MAIN)).toMatchObject({ critical: true, pin: 'required' });
    expect((await s.decide(id, { behavior: 'allow' })).status).toBe(403);
    const wrong = await s.decide(id, { behavior: 'allow', pin: 'nao e este' });
    expect(wrong.status).toBe(403);
    expect(wrong.json).toMatchObject({ error: expect.stringMatching(/PIN errado/) });
    expect(srv!.registry!.needsPin(id)).toBe(true);
    expect((await s.decide(id, { behavior: 'allow', pin: GOOD })).status).toBe(200);
    const other = s.card(true);
    for (let i = 0; i < PIN_MAX_FAILURES - 1; i++) expect((await s.decide(other, { behavior: 'allow', pin: 'x'.repeat(8) })).status).toBe(403);
    expect((await s.decide(other, { behavior: 'allow', pin: 'x'.repeat(8) })).status).toBe(429);
    expect((await s.decide(other, { behavior: 'allow', pin: GOOD })).status).toBe(429);
  });

  it('cartão comum não pede PIN; com "exigir em todos os cartões", pede', async () => {
    const plain = await serve();
    const id = plain.card(false);
    expect(srv!.registry!.detail(id)?.pin).toBeUndefined();
    expect((await plain.decide(id, { behavior: 'allow' })).status).toBe(200);
    await srv!.close();
    srv = undefined;
    const all = await serve({ all: true });
    const id2 = all.card(false);
    expect(srv!.registry!.detail(id2)?.pin).toBe('required');
    expect((await all.decide(id2, { behavior: 'allow' })).status).toBe(403);
    expect((await all.decide(id2, { behavior: 'allow', pin: GOOD })).status).toBe(200);
  });

  it('GET /api/approval-pin mostra o estado; POST local define (e pede o atual para trocar)', async () => {
    const s = await serve({ set: false });
    expect((await request(srv!.base, '/api/approval-pin')).json).toEqual({ set: false, all: false, editable: true });
    expect((await request(srv!.base, '/api/approval-pin', { method: 'POST', body: { pin: GOOD } })).json).toEqual({ set: true, all: false, editable: true });
    const swap = await request(srv!.base, '/api/approval-pin', { method: 'POST', body: { pin: 'pin de outro processo' } });
    expect(swap.status).toBe(400);
    expect(await s.pin.check(GOOD)).toBe('ok');
  });
});
