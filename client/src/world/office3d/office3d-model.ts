// Lógica pura do escritório 3D (sem three): qual escritório do pacote, qual funcionário e qual lugar para cada agente,
// qual animação para cada estado. A cena (index.ts) só desenha o que sair daqui.
import type { AgentStatus } from '../../../../shared/types';

export type SeatPose = 'type' | 'laptop' | 'rest' | 'lounge' | 'stand';

/** Um lugar de `escritorios/<id>.json` (chave `assentos`). */
export interface Seat {
  id: string;
  andar: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  altura: number;
  pose: SeatPose;
  trabalho: boolean;
  sala: string;
}

/** Uma linha de `escritorios/indice.json`. */
export interface OfficeEntry {
  id: string;
  nome: string;
  arquivo: string;
  dados: string;
  andares: number;
  postos_de_trabalho: number;
  assentos: number;
  mb: number;
}

export type ClipName = 'parado' | 'digitando' | 'notebook' | 'sentado' | 'sofa' | 'digitando_em_pe' | 'acenando' | 'apresentando' | 'cafe';

/** Altura do assento em que os clipes sentados foram gravados. */
export const SEATED_HEIGHT = 0.47;
/** Quanto o funcionário que se levanta (acena, apresenta) recua da cadeira. */
export const STAND_BACK = 0.65;
/** Ocioso há mais que isso vai tomar um café. */
export const COFFEE_AFTER_MS = 10 * 60_000;
export const EMPLOYEE_MODELS = 8;

/** Clipe de quem está sentado, pela pose do lugar (COMECE-AQUI.md do pacote). */
const SEATED_CLIP: Record<SeatPose, ClipName> = { type: 'digitando', laptop: 'notebook', rest: 'sentado', lounge: 'sofa', stand: 'digitando_em_pe' };

export interface Mood {
  clip: ClipName;
  /** Em pé ao lado da cadeira (acenar, apresentar, café) em vez de sentado nela. */
  standing: boolean;
}

/** Estado do agente -> animação. `idleMs` = há quanto tempo está parado. */
export function moodFor(status: AgentStatus, pose: SeatPose, idleMs = 0): Mood {
  switch (status) {
    case 'working':
    case 'shell':
      return { clip: SEATED_CLIP[pose], standing: false };
    case 'waiting':
      return { clip: 'acenando', standing: true };
    case 'done':
      return { clip: 'apresentando', standing: true };
    case 'idle':
      return idleMs >= COFFEE_AFTER_MS ? { clip: 'cafe', standing: true } : { clip: pose === 'stand' ? 'parado' : 'sentado', standing: false };
    default:
      return { clip: pose === 'stand' ? 'parado' : 'sentado', standing: false };
  }
}

export interface Placement {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Onde pôr a raiz do funcionário: sentado (y + altura - 0,47) ou em pé atrás da cadeira. */
export function placementFor(seat: Seat, standing: boolean): Placement {
  if (seat.pose === 'stand') return { x: seat.x, y: seat.y, z: seat.z, yaw: seat.yaw };
  if (standing) {
    // a frente do lugar é (sin yaw, cos yaw); a cadeira fica de frente para a mesa, então recua pelas costas
    return { x: seat.x - Math.sin(seat.yaw) * STAND_BACK, y: seat.y, z: seat.z - Math.cos(seat.yaw) * STAND_BACK, yaw: seat.yaw };
  }
  return { x: seat.x, y: seat.y + seat.altura - SEATED_HEIGHT, z: seat.z, yaw: seat.yaw };
}

/** Modelo do funcionário (1..8) estável por id de agente (FNV-1a). */
export function employeeModelFor(agentId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i++) h = Math.imul(h ^ agentId.charCodeAt(i), 0x01000193) >>> 0;
  return (h % EMPLOYEE_MODELS) + 1;
}

export const employeeFile = (n: number): string => `funcionarios/funcionario-${String(n).padStart(2, '0')}.glb`;

/**
 * Escritório do pacote para a quantidade de agentes e de projetos (salas): o menor com postos de trabalho para todos
 * e uns quatro postos por projeto; se nenhum serve, o maior.
 */
export function pickOffice(entries: readonly OfficeEntry[], agents: number, projects: number): OfficeEntry | null {
  if (!entries.length) return null;
  const sorted = [...entries].sort((a, b) => a.postos_de_trabalho - b.postos_de_trabalho || a.andares - b.andares || a.id.localeCompare(b.id));
  const need = Math.max(1, agents, projects * 4);
  return sorted.find((e) => e.postos_de_trabalho >= need) ?? sorted[sorted.length - 1];
}

export interface SeatingAgent {
  id: string;
  roomId: string;
  startedAt: number;
}
export interface SeatingRoom {
  id: string;
  name: string;
  slot: number;
}

const norm = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/**
 * Agente -> lugar. Cada projeto (sala do 2D) ganha uma sala do escritório 3D: a de mesmo nome, se houver; senão a
 * próxima sala de trabalho, na ordem de chegada do projeto. Dentro do projeto, os agentes (do mais antigo ao mais novo)
 * ocupam os postos de trabalho da sala; sem vaga, vão para as outras salas e, por último, para qualquer lugar livre.
 * Quem não couber fica de fora (`missing`). Determinístico: o mesmo snapshot dá sempre a mesma divisão.
 */
export function assignSeats(
  agents: readonly SeatingAgent[],
  rooms: readonly SeatingRoom[],
  seats: readonly Seat[],
  /** Lugares de antes (agente -> id do lugar): quem já estava sentado continua, mesmo se um colega saiu. */
  keep: ReadonlyMap<string, string> = new Map(),
): { seats: Map<string, Seat>; missing: string[] } {
  const groups = new Map<string, Seat[]>();
  for (const s of seats) {
    if (!s.trabalho) continue;
    const key = `${s.andar}|${s.sala}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }
  const groupList = [...groups.entries()].sort((a, b) => a[1][0].andar - b[1][0].andar).map(([, v]) => v);
  const taken = new Set<string>();
  const out = new Map<string, Seat>();
  const missing: string[] = [];
  const projects = [...rooms].sort((a, b) => a.slot - b.slot || a.id.localeCompare(b.id));
  const home = new Map<string, number>();
  const used = new Set<number>();
  // primeiro os de mesmo nome; depois cada projeto pega a próxima sala ainda sem dono (dá a volta se faltar sala)
  for (const r of projects) {
    const i = groupList.findIndex((g, k) => !used.has(k) && norm(g[0].sala) === norm(r.name));
    if (i >= 0) {
      home.set(r.id, i);
      used.add(i);
    }
  }
  let next = 0;
  for (const r of projects) {
    if (home.has(r.id) || !groupList.length) continue;
    let tries = 0;
    while (used.has(next % groupList.length) && used.size < groupList.length && tries++ < groupList.length) next++;
    home.set(r.id, next % groupList.length);
    used.add(next % groupList.length);
    next++;
  }
  const spare = seats.filter((s) => !s.trabalho);
  const free = (list: readonly Seat[]) => list.find((s) => !taken.has(s.id));
  const ordered = [...agents].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
  const byId = new Map(seats.map((s) => [s.id, s]));
  const placed = new Set<string>();
  for (const a of ordered) {
    const old = byId.get(keep.get(a.id) ?? '');
    if (old && !taken.has(old.id)) {
      taken.add(old.id);
      out.set(a.id, old);
      placed.add(a.id);
    }
  }
  for (const a of ordered) {
    if (placed.has(a.id)) continue;
    const h = home.get(a.roomId) ?? 0;
    let seat: Seat | undefined;
    for (let k = 0; k < groupList.length && !seat; k++) seat = free(groupList[(h + k) % groupList.length]);
    seat ??= free(spare);
    if (!seat) {
      missing.push(a.id);
      continue;
    }
    taken.add(seat.id);
    out.set(a.id, seat);
  }
  return { seats: out, missing };
}
