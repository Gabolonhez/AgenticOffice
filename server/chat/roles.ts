// Papéis do chat: instruções que o agente recebe antes de começar. Ficam em <dataDir>/chat/roles.json, nunca no projeto
// do usuário. Nomes e textos são dados do usuário (não passam pelo tr).
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tr } from '../../shared/i18n';

export interface RoleInfo { id: string; name: string; text: string; builtin?: true }

const NAME_MAX = 40;
const TEXT_MAX = 8000;

export const BUILTIN_ROLES: readonly RoleInfo[] = [
  {
    id: 'dev',
    name: 'Dev',
    builtin: true,
    text: 'Você é o Dev deste projeto. Implemente o pedido de ponta a ponta: leia o código antes de mudar, rode os testes do que fez e faça commit com mensagem em português. No fim, diga em poucas linhas o que mudou e o que ficou de fora.',
  },
  {
    id: 'qa',
    name: 'QA',
    builtin: true,
    text: 'Você é o QA deste projeto. Só teste, não corrija nada. Rode o app (emulador, navegador ou testes), siga os fluxos principais, tire prints quando puder e devolva uma lista de bugs, cada um com o passo a passo para reproduzir.',
  },
  {
    id: 'revisor',
    name: 'Revisor',
    builtin: true,
    text: 'Você é o Revisor. Não edite arquivos. Leia o diff ou o branch que o usuário indicar e aponte bugs, riscos de segurança e o que ficou faltando, do mais grave ao menos grave, com o arquivo e a linha.',
  },
  {
    id: 'designer',
    name: 'Designer',
    builtin: true,
    text: 'Você é o Designer. Cuide de telas e visual usando as skills de design do usuário (impeccable, ui-ux-pro-max). Entregue ajustes de UI ou mockups, explicando cada escolha em uma linha.',
  },
  {
    id: 'pesquisador',
    name: 'Pesquisador',
    builtin: true,
    text: 'Você é o Pesquisador. Investigue antes de construir: documentação, concorrentes, como um app funciona. Não mexa em código. Devolva um relatório curto com as conclusões e as fontes.',
  },
  {
    id: 'orquestrador',
    name: 'Orquestrador',
    builtin: true,
    text: 'Você é o Orquestrador. Quebre o pedido em partes e diga, para cada uma, a quem delegaria (Dev, QA, Revisor, Designer, Pesquisador) e o que pediria. Por enquanto você ainda não abre outros agentes: entregue o plano de delegação.',
  },
];

export class RoleStore {
  private roles: RoleInfo[];

  constructor(private readonly file: string) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      this.roles = Array.isArray(saved) ? saved.filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string' && typeof r.text === 'string') : [...BUILTIN_ROLES];
    } catch {
      this.roles = [...BUILTIN_ROLES];
    }
  }

  list(): RoleInfo[] {
    return [...this.roles];
  }

  get(id: string): RoleInfo | undefined {
    return this.roles.find((r) => r.id === id);
  }

  put(raw: unknown): RoleInfo | { error: string } {
    const r = raw as Partial<RoleInfo> | null;
    const name = typeof r?.name === 'string' ? r.name.trim() : '';
    const text = typeof r?.text === 'string' ? r.text.trim() : '';
    if (!name || name.length > NAME_MAX) return { error: tr('O nome do papel precisa ter de 1 a {0} caracteres.', [NAME_MAX]) };
    if (!text || text.length > TEXT_MAX) return { error: tr('O texto do papel precisa ter de 1 a {0} caracteres.', [TEXT_MAX]) };
    const id = typeof r?.id === 'string' && r.id ? r.id : randomUUID();
    const prev = this.get(id);
    const role: RoleInfo = { id, name, text, ...(prev?.builtin ? { builtin: true as const } : {}) };
    this.roles = prev ? this.roles.map((x) => (x.id === id ? role : x)) : [...this.roles, role];
    this.write();
    return role;
  }

  remove(id: string): boolean {
    if (!this.get(id)) return false;
    this.roles = this.roles.filter((r) => r.id !== id);
    this.write();
    return true;
  }

  private write(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.roles, null, 2));
    renameSync(tmp, this.file);
  }
}
