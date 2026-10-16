// Agentes conversando entre si (projeto 2): as ferramentas office_* do MCP do escritório, para os agentes Claude do
// chat. Regra do dono do produto: um agente NUNCA abre nem manda mensagem a outro sozinho. Toda delegação vira um cartão
// de aprovação (askHuman) nos dois modos de permissão; recusa, prazo ou rodada parada = recusa a quem pediu, nada roda.
import { basename } from 'node:path';
import { CHAT_TEXT_MAX } from '../../shared/chat';
import { maskSecrets, truncate } from '../../shared/activity';
import { tr } from '../../shared/i18n';
import type { Provider } from '../../shared/types';
import type { PermissionRegistry } from '../permissions/registry';
import { askHuman, type HumanAnswer, type McpTool } from './permission';
import type { RoleStore } from './roles';
import type { ChatService } from './service';

export interface ChatLink { from: string; to: string; at: number }

export interface DelegationDeps {
  chat: Pick<ChatService, 'record' | 'agentsList' | 'displayName' | 'open' | 'deliver' | 'onTurnEnd' | 'providers' | 'addApproval' | 'resolveApproval' | 'note'> & { roles: Pick<RoleStore, 'list'> };
  registry: Pick<PermissionRegistry, 'registerChat' | 'wait' | 'releaseAgent'>;
  folders: () => Array<{ path: string; name?: string }>;
  now?: () => number;
  /** Testes: quanto dura um "minuto" do timeoutMinutes. */
  minuteMs?: number;
  maxWaits?: number;
}

export const MAX_WAITS = 4;
export const LINKS_MAX = 50;
export const ASK_DEFAULT_MINUTES = 30;
export const ASK_MAX_MINUTES = 120;
const PROVIDER_LABEL: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

interface Wait { caller: string; target: string; cancel: () => void }

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const fail = (text: string) => ({ text, isError: true });
const sameText = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const normPath = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();

export class Delegation {
  private readonly waits: Wait[] = [];
  private readonly recent: ChatLink[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: DelegationDeps) {
    this.now = deps.now ?? Date.now;
    // Rodada de quem pediu terminou ou parou: solta os cartões dele e deixa de esperar respostas.
    deps.chat.onTurnEnd((id) => {
      deps.registry.releaseAgent(id);
      for (const w of this.waits.filter((x) => x.caller === id)) w.cancel();
    });
  }

  /** Últimas conversas aprovadas (abrir e mandar mensagem), para as linhas do quadro. */
  links(): ChatLink[] {
    return [...this.recent];
  }

  tools(caller: string): McpTool[] {
    return [
      {
        name: 'office_list_agents',
        description: 'Lists the chat agents in the AgenticOffice (id, name, role, provider, folder, status, last reply). Read-only.',
        inputSchema: { type: 'object', properties: {} },
        run: async () => ({ text: JSON.stringify(this.deps.chat.agentsList().map((a) => (a.id === caller ? { ...a, you: true } : a)), null, 1) }),
      },
      {
        name: 'office_open_agent',
        description:
          'Opens a new chat agent in the AgenticOffice with a first request. ALWAYS needs the human user to approve a card first; if refused or unanswered, nothing is opened. Returns the new agent id.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: { type: 'string', enum: ['claude', 'codex', 'antigravity'], description: 'Default: claude' },
            role: { type: 'string', description: 'Role id or name (e.g. Dev, QA, Revisor, Designer, Pesquisador)' },
            folder: { type: 'string', description: 'A folder the office knows (path or name). Default: your folder' },
            name: { type: 'string' },
            prompt: { type: 'string', description: 'The first request for the new agent' },
          },
          required: ['prompt'],
        },
        run: (args) => this.openAgent(caller, args),
      },
      {
        name: 'office_ask_agent',
        description:
          'Sends a message to another chat agent and waits for its final reply. ALWAYS needs the human user to approve a card first; if refused or unanswered, nothing is sent. The message waits in a queue while the agent is busy.',
        inputSchema: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: 'Id from office_list_agents' },
            message: { type: 'string' },
            timeoutMinutes: { type: 'number', description: `Default ${ASK_DEFAULT_MINUTES}, max ${ASK_MAX_MINUTES}` },
          },
          required: ['agentId', 'message'],
        },
        run: (args) => this.askAgent(caller, args),
      },
    ];
  }

  private async openAgent(caller: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
    const { chat } = this.deps;
    const rec = chat.record(caller);
    if (!rec) return fail(tr('Agente não encontrado.'));
    const prompt = str(args.prompt);
    if (!prompt || prompt.length > CHAT_TEXT_MAX) return fail(tr('Escreva o pedido (até {0} caracteres).', [CHAT_TEXT_MAX]));
    const provider = (str(args.provider) || 'claude') as Provider;
    const option = chat.providers().find((p) => p.id === provider);
    if (!option) return fail(tr('Provedor inválido.'));
    if (!option.available) return fail(option.reason ?? tr('Provedor inválido.'));
    const roleWant = str(args.role);
    const role = roleWant ? chat.roles.list().find((r) => sameText(r.id, roleWant) || sameText(r.name, roleWant)) : undefined;
    if (roleWant && !role) return fail(tr('Papel não encontrado. Papéis: {0}', [chat.roles.list().map((r) => r.name).join(', ')]));
    const folderWant = str(args.folder);
    const known = this.deps.folders();
    const folder = folderWant
      ? known.find((f) => normPath(f.path) === normPath(folderWant) || sameText(f.name ?? '', folderWant) || sameText(basename(f.path), folderWant))
      : (known.find((f) => normPath(f.path) === normPath(rec.folder)) ?? { path: rec.folder });
    if (!folder) return fail(tr('Pasta desconhecida: abra uma sessão nela antes.'));
    const name = str(args.name);

    const who = chat.displayName(caller);
    const what = role ? `${role.name} (${PROVIDER_LABEL[provider]})` : PROVIDER_LABEL[provider];
    const text = tr('{0} quer abrir um agente {1} em {2} para: {3}', [who, what, folder.name || basename(folder.path), prompt]);
    const a = await askHuman({ registry: this.deps.registry, chat }, caller, this.cardOf('office_open_agent', { provider, role: role?.name ?? '', folder: folder.path, prompt }, text));
    if (a.answer !== 'allow') return fail(this.refusal(a, tr('nada foi aberto')));

    // Decisão: o agente aberto por outro nasce em "pedir aprovação" (no Claude), qualquer que seja o modo de quem pediu.
    const r = chat.open({ folder: folder.path, provider, prompt, permission: 'ask', ...(role ? { roleId: role.id } : {}), ...(name ? { name } : {}) }, { agentId: caller, name: who });
    if (!('agentId' in r)) return fail(r.reason);
    this.link(caller, r.agentId, prompt);
    return { text: tr('Agente aberto: {0} ({1}). Ele já começou o pedido; fale com ele por office_ask_agent.', [r.agentId, chat.displayName(r.agentId)]) };
  }

  private async askAgent(caller: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
    const { chat } = this.deps;
    const target = str(args.agentId);
    const message = str(args.message);
    if (!message || message.length > CHAT_TEXT_MAX) return fail(tr('Escreva a mensagem (até {0} caracteres).', [CHAT_TEXT_MAX]));
    if (target === caller) return fail(tr('Você não pode mandar mensagem para si mesmo.'));
    if (!chat.record(caller)) return fail(tr('Agente não encontrado.'));
    if (!chat.record(target)) return fail(tr('Agente não encontrado: {0}. Veja os ids em office_list_agents.', [target]));
    if (this.reaches(target, caller)) return fail(tr('{0} já está esperando uma resposta sua: responda sem pedir a ele (ciclo).', [chat.displayName(target)]));
    if (this.waits.length >= (this.deps.maxWaits ?? MAX_WAITS)) return fail(tr('Muitas conversas entre agentes em andamento ({0}); espere uma terminar.', [this.waits.length]));
    const raw = Number(args.timeoutMinutes);
    const minutes = Number.isFinite(raw) && raw > 0 ? Math.min(raw, ASK_MAX_MINUTES) : ASK_DEFAULT_MINUTES;

    // A espera conta já durante o cartão: dois pedidos cruzados não ficam presos esperando aprovação.
    const wait: Wait = { caller, target, cancel: () => {} };
    this.waits.push(wait);
    try {
      const who = chat.displayName(caller);
      const to = chat.displayName(target);
      let stopped = false;
      wait.cancel = () => void (stopped = true);
      const a = await askHuman({ registry: this.deps.registry, chat }, caller, this.cardOf('office_ask_agent', { to, message }, tr('{0} quer mandar para {1}: {2}', [who, to, message])));
      if (a.answer !== 'allow') return fail(this.refusal(a, tr('nada foi enviado')));
      if (stopped || !chat.record(target)) return fail(tr('Agente não encontrado: {0}. Veja os ids em office_list_agents.', [target]));
      const d = chat.deliver(target, message, { agentId: caller, name: who });
      if (!d) return fail(tr('Agente não encontrado: {0}. Veja os ids em office_list_agents.', [target]));
      this.link(caller, target, message);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((ok) => (timer = setTimeout(() => ok('timeout'), minutes * (this.deps.minuteMs ?? 60_000))));
      wait.cancel = d.cancel;
      const r = await Promise.race([d.result, timedOut]);
      clearTimeout(timer);
      if (r === 'timeout') {
        d.cancel();
        return fail(tr('{0} não respondeu em {1} min. Se a mensagem já estava rodando, ele continua e a resposta aparece no chat dele.', [to, minutes]));
      }
      if (!r.ok) return fail(tr('{0} não terminou a rodada: {1}', [to, r.error]));
      return { text: tr('Resposta de {0}:', [to]) + `\n\n${r.reply}` };
    } finally {
      this.waits.splice(this.waits.indexOf(wait), 1);
    }
  }

  private cardOf(tool: string, input: Record<string, unknown>, text: string) {
    return { tool, input, text: truncate(maskSecrets(text), 2000) };
  }

  private refusal(a: HumanAnswer, nothing: string): string {
    if (a.answer === 'deny') return tr('O usuário recusou no AgenticOffice ({0}){1}', [nothing, a.message ? `: ${a.message}` : '.']);
    if (a.answer === 'too-many') return tr('Muitos pedidos de aprovação abertos ({0}).', [nothing]);
    return tr('Sem resposta do usuário a tempo ({0}).', [nothing]);
  }

  /** `from` já espera (direta ou indiretamente) por `to`? */
  private reaches(from: string, to: string, seen = new Set<string>()): boolean {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return this.waits.some((w) => w.caller === from && this.reaches(w.target, to, seen));
  }

  private link(from: string, to: string, text: string): void {
    this.recent.push({ from, to, at: this.now() });
    if (this.recent.length > LINKS_MAX) this.recent.splice(0, this.recent.length - LINKS_MAX);
    const { chat } = this.deps;
    chat.note(from, '📤', tr('Pediu a {0}', [chat.displayName(to)]), text);
    chat.note(to, '📥', tr('Pedido de {0}', [chat.displayName(from)]), text);
  }
}
