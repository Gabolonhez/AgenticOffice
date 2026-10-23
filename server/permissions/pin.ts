// PIN de aprovação: os cartões "críticos" (os GATED do Jarvis, as office_* entre agentes e o que um turno contaminado do
// Jarvis pede) só se aprovam com ele. A rota de decisão vale do loopback para qualquer processo do computador (um agente
// com shell inclusive); o PIN é o que só o dono sabe. Guardado como scrypt (sal aleatório, N = 2^15) num arquivo 600:
// os agentes rodam com o mesmo usuário e conseguem ler o arquivo, então a força está na frase (a tela recomenda uma
// frase-senha). 5 erros = 15 min sem aprovar cartões críticos; o contador sobrevive a reinícios. O hash vale o que foi
// lido na partida ou gravado por aqui: trocar o arquivo por fora só pega depois de reiniciar o Habblaud.
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';

export const PIN_MIN = 6;
export const PIN_MAX = 200;
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MS = 15 * 60_000;
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;

interface PinFile {
  v: 1;
  salt?: string;
  hash?: string;
  n?: number;
  /** "Exigir PIN em todos os cartões". */
  all?: boolean;
  failures: number;
  lockedUntil?: number;
}

export type PinCheck = 'ok' | 'unset' | 'missing' | 'wrong' | 'locked';
export interface PinView { set: boolean; all: boolean; lockedUntil?: number }

const derive = (pin: string, salt: Buffer, n: number) =>
  new Promise<Buffer>((ok, fail) => scryptCb(pin.normalize('NFKC'), salt, KEYLEN, { N: n, r: R, p: P, maxmem: 256 * n * R }, (err, key) => (err ? fail(err) : ok(key))));

export class ApprovalPin {
  private data: PinFile = { v: 1, failures: 0 };
  private readonly now: () => number;
  /** Custo do scrypt (os testes usam um menor). */
  private readonly n: number;

  constructor(
    private readonly file: string,
    o: { now?: () => number; n?: number } = {},
  ) {
    this.now = o.now ?? Date.now;
    this.n = o.n ?? N;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PinFile>;
      this.data = {
        v: 1,
        ...(typeof raw.salt === 'string' && typeof raw.hash === 'string' ? { salt: raw.salt, hash: raw.hash, n: typeof raw.n === 'number' ? raw.n : N } : {}),
        ...(raw.all === true ? { all: true } : {}),
        failures: typeof raw.failures === 'number' && raw.failures > 0 ? Math.floor(raw.failures) : 0,
        ...(typeof raw.lockedUntil === 'number' ? { lockedUntil: raw.lockedUntil } : {}),
      };
    } catch {
      // sem arquivo (ou estragado): sem PIN
    }
  }

  isSet(): boolean {
    return !!this.data.hash;
  }

  /** "Exigir PIN em todos os cartões" (só com PIN definido). */
  all(): boolean {
    return this.isSet() && !!this.data.all;
  }

  view(): PinView {
    const locked = this.lockedUntil();
    return { set: this.isSet(), all: this.all(), ...(locked ? { lockedUntil: locked } : {}) };
  }

  private lockedUntil(): number | undefined {
    const t = this.data.lockedUntil;
    return t && t > this.now() ? t : undefined;
  }

  /** Confere o PIN (comparação em tempo constante). Erro conta para o bloqueio; acerto zera. */
  async check(pin: unknown): Promise<PinCheck> {
    if (!this.data.hash || !this.data.salt) return 'unset';
    if (this.lockedUntil()) return 'locked';
    if (typeof pin !== 'string' || !pin) return 'missing';
    const want = Buffer.from(this.data.hash, 'base64');
    const got = pin.length > PIN_MAX ? Buffer.alloc(want.length) : await derive(pin, Buffer.from(this.data.salt, 'base64'), this.data.n ?? N);
    const good = got.length === want.length && timingSafeEqual(got, want) && pin.length <= PIN_MAX;
    if (good) {
      if (this.data.failures || this.data.lockedUntil) {
        this.data.failures = 0;
        delete this.data.lockedUntil;
        this.save();
      }
      return 'ok';
    }
    this.data.failures++;
    if (this.data.failures >= PIN_MAX_FAILURES) {
      this.data.failures = 0;
      this.data.lockedUntil = this.now() + PIN_LOCK_MS;
    }
    this.save();
    return this.lockedUntil() ? 'locked' : 'wrong';
  }

  /** Quantos erros ainda cabem antes do bloqueio. */
  triesLeft(): number {
    return PIN_MAX_FAILURES - this.data.failures;
  }

  /**
   * Define, troca ou apaga (pin '') o PIN e liga/desliga o "todos os cartões". Com PIN definido, qualquer mudança pede
   * o atual (senão um processo qualquer do computador trocaria o PIN pelo dele). Devolve o erro, se houver.
   */
  async update(b: { pin?: unknown; current?: unknown; all?: unknown }): Promise<string | undefined> {
    if (this.isSet()) {
      const c = await this.check(b.current);
      if (c === 'locked') return tr('Muitos PINs errados: espere 15 minutos.');
      if (c !== 'ok') return tr('PIN atual errado.');
    }
    const next: PinFile = { ...this.data };
    if (b.pin !== undefined) {
      if (typeof b.pin !== 'string') return tr('PIN inválido.');
      if (b.pin === '') {
        delete next.salt;
        delete next.hash;
        delete next.n;
        delete next.all;
      } else {
        if (b.pin.length < PIN_MIN || b.pin.length > PIN_MAX) return tr('O PIN precisa ter de {0} a {1} caracteres.', [PIN_MIN, PIN_MAX]);
        const salt = randomBytes(16);
        next.salt = salt.toString('base64');
        next.hash = (await derive(b.pin, salt, this.n)).toString('base64');
        next.n = this.n;
      }
    }
    if (b.all !== undefined) {
      if (b.all === true && !next.hash) return tr('Defina um PIN antes.');
      if (b.all === true) next.all = true;
      else delete next.all;
    }
    next.failures = 0;
    delete next.lockedUntil;
    const prev = this.data;
    this.data = next;
    const err = this.save();
    if (err) this.data = prev;
    return err;
  }

  private save(): string | undefined {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
      return undefined;
    } catch (err) {
      log.warnOnce(`pin:${errMsg(err)}`, tr('Não deu para gravar o PIN de aprovação ({0}).', [errMsg(err)]));
      return errMsg(err);
    }
  }
}

/** A frase do erro de um PIN que não passou (rota de decisão). */
export function pinError(c: Exclude<PinCheck, 'ok'>, triesLeft: number): { status: number; error: string } {
  if (c === 'unset') return { status: 403, error: tr('Este cartão pede o PIN de aprovação: defina um PIN de aprovação em Configurações.') };
  if (c === 'locked') return { status: 429, error: tr('Muitos PINs errados: os cartões críticos ficam bloqueados por 15 minutos.') };
  if (c === 'missing') return { status: 403, error: tr('Este cartão pede o PIN de aprovação.') };
  return { status: 403, error: tr('PIN errado ({0} tentativas antes do bloqueio).', [triesLeft]) };
}
