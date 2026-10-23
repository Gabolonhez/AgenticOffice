// Fila do VBoards (server/vboards/vboards.ts): as subtarefas que você marcou "mandar para o agente" no quadro do time.
// Um contador na barra do topo (como o "precisa de você") abre a lista; cada uma mostra o card, o texto e a pasta do
// projeto. Só começa com o seu clique em "Iniciar" (POST /api/vboards/start, só pelo próprio computador), ou fica com
// uma conversa já aberta na pasta, de qualquer provedor ("Ligar a uma conversa aberta", POST /api/vboards/attach);
// "Ignorar" esconde nesta página. Some sem o Novo agente ou com o recurso desligado no servidor (404).
// Embaixo, o "Refinar" pedido no VBoards: o card sendo planejado aqui, pronto ou que falhou (só leitura).
import { tr } from '../../../shared/i18n';
import { access } from '../net/access';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setAttr, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { shortPath } from './spawn';

const POLL_MS = 15_000;
const IGNORED_KEY = 'habblaud.vboards.ignored';
const IGNORED_MAX = 200;

export interface VBoardsTask {
  id: string;
  cardTitle: string;
  text: string;
  date?: string;
  folder?: string;
  candidates: Array<{ path: string; name: string }>;
  agents?: Array<{ id: string; name: string; title?: string; provider: string; folder: string }>;
}

/** "Refinar" de um card (server/vboards/vboards.ts RefineView). */
export interface VBoardsRefine {
  cardId: string;
  cardTitle: string;
  state: 'running' | 'ready' | 'failed';
  error?: string;
}

function readIgnored(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(IGNORED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeIgnored(ids: string[]): void {
  try {
    localStorage.setItem(IGNORED_KEY, JSON.stringify(ids.slice(-IGNORED_MAX)));
  } catch {
    // sem armazenamento: só não lembra
  }
}

export class VBoardsPanel implements UiComponent {
  readonly button: HTMLButtonElement;
  readonly el: HTMLElement;
  private readonly value: HTMLElement;
  private readonly label: HTMLElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  private tasks: VBoardsTask[] = [];
  private refines: VBoardsRefine[] = [];
  private ignored = readIgnored();
  /** Pasta escolhida na página por tarefa (sobrevive às atualizações da lista). */
  private readonly picked = new Map<string, string>();
  private busy?: string;
  /** Tarefas marcadas para "Rodar como lista" (só com o chat ligado). */
  private readonly marked = new Set<string>();
  private readonly listBtn: HTMLButtonElement;
  private shown = '';
  private off = false;

  constructor(private readonly ctx: UiContext) {
    const icon = h('span', { class: 'ui-counter__icon', attrs: { 'aria-hidden': 'true' } });
    icon.innerHTML = ICONS.newAgent;
    this.value = h('span', { class: 'ui-counter__value', text: '0' });
    this.label = h('span', { class: 'ui-counter__label', text: 'VBoards' });
    this.button = h(
      'button',
      { class: 'ui-counter ui-counter--vboards', type: 'button', hidden: true, title: tr('Tarefas do VBoards esperando um agente: clique para ver'), attrs: { 'aria-haspopup': 'dialog' }, on: { click: () => this.toggle() } },
      icon,
      h('span', { class: 'ui-counter__stack' }, this.value, this.label),
    );
    this.list = h('ul', { class: 'ui-vboards__list' });
    this.status = h('p', { class: 'ui-rename__hint ui-spawn__status', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.listBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', hidden: true, on: { click: () => this.runAsList() } }, tr('Rodar como lista'));
    this.el = h(
      'div',
      { class: 'ui-popover ui-spawn ui-vboards', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': tr('Tarefas do VBoards'), id: 'ui-vboards', popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, h('h2', { text: tr('Tarefas do VBoards') }), iconButton(ICONS.close, tr('Fechar'), () => this.hide(), 'ui-icon-btn--sm')),
      h(
        'div',
        { class: 'ui-set-group ui-spawn__body' },
        this.list,
        this.listBtn,
        h('p', { class: 'ui-rename__hint', text: tr('"Iniciar" começa um agente do Claude Code na pasta do projeto com a subtarefa como pedido. Quando ele terminar, a subtarefa é concluída no VBoards com a última resposta como resumo.') }),
        this.status,
      ),
    );
    void this.load();
    setInterval(() => void this.load(), POLL_MS);
  }

  private get enabled(): boolean {
    return !this.off && access().spawn && !this.ctx.store.mock && !this.ctx.store.replaying;
  }

  private visible(): VBoardsTask[] {
    return this.tasks.filter((t) => !this.ignored.includes(t.id));
  }

  render(): void {
    const n = this.enabled ? this.visible().length + this.refines.length : 0;
    setHidden(this.button, n === 0);
    setText(this.value, String(n));
    setAttr(this.button, 'aria-label', tr('{0} tarefa(s) do VBoards esperando', [n]));
    if (!n && this.isOpen) this.hide();
  }

  private async load(): Promise<void> {
    if (this.off || !access().spawn || this.ctx.store.mock) return;
    try {
      const res = await fetch('/api/vboards', { credentials: 'same-origin', cache: 'no-store' });
      if (res.status === 404) this.off = true;
      else if (res.ok) {
        const body = (await res.json()) as { tasks?: VBoardsTask[]; refines?: VBoardsRefine[] };
        this.tasks = Array.isArray(body.tasks) ? body.tasks : [];
        this.refines = Array.isArray(body.refines) ? body.refines : [];
      }
    } catch {
      // fica a lista de antes
    }
    this.renderList();
    this.ctx.invalidate();
  }

  get isOpen(): boolean {
    try {
      return this.el.matches(':popover-open');
    } catch {
      return this.el.classList.contains('is-open');
    }
  }

  private toggle(): void {
    if (this.isOpen) return this.hide();
    setText(this.status, '');
    this.renderList(true);
    const r = this.button.getBoundingClientRect();
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    this.el.style.left = `${Math.max(8, Math.min(Math.round(r.left), innerWidth - 338))}px`;
    if (typeof this.el.showPopover === 'function') this.el.showPopover();
    else this.el.classList.add('is-open');
    this.button.setAttribute('aria-expanded', 'true');
  }

  private hide(): void {
    if (typeof this.el.hidePopover === 'function' && this.isOpen) this.el.hidePopover();
    this.el.classList.remove('is-open');
    this.button.setAttribute('aria-expanded', 'false');
  }

  private say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
  }

  /** Redesenha só quando a lista mudou (a escolha da pasta e o foco não se perdem a cada atualização). */
  private renderList(force = false): void {
    const tasks = this.visible();
    const sig = JSON.stringify([tasks, this.refines, this.busy]);
    if (!force && sig === this.shown) return;
    this.shown = sig;
    this.list.replaceChildren(...tasks.map((t) => this.item(t)), ...this.refines.map((r) => this.refineItem(r)));
    this.syncListBtn();
  }

  private marks(): VBoardsTask[] {
    return this.visible().filter((t) => this.marked.has(t.id));
  }

  private syncListBtn(): void {
    const n = this.marks().length;
    setHidden(this.listBtn, n < 2);
    setText(this.listBtn, tr('Rodar como lista ({0})', [n]));
  }

  /** As marcadas viram os itens de uma lista (ui/runs.ts), que ainda passa pela confirmação. */
  private runAsList(): void {
    const tasks = this.marks();
    if (tasks.length < 2) return;
    const folder = tasks.map((t) => this.picked.get(t.id) ?? t.folder ?? '').find(Boolean) ?? '';
    const items = tasks.map((t) => ({ text: `${tr('Tarefa do VBoards (card {0}):', [t.cardTitle])} ${t.text}`, vboardsTaskId: t.id }));
    this.marked.clear();
    this.hide();
    window.dispatchEvent(new CustomEvent('habblaud:run-list', { detail: { folder, items } }));
  }

  private item(t: VBoardsTask): HTMLElement {
    const folder = this.picked.get(t.id) ?? t.folder ?? '';
    const select = h('select', { class: 'ui-rename__input ui-vboards__folder', attrs: { 'aria-label': tr('Pasta do projeto') } });
    if (!folder) select.append(h('option', { attrs: { value: '' }, text: tr('Escolha a pasta…') }));
    for (const c of t.candidates) select.append(h('option', { attrs: { value: c.path }, text: `${c.name} — ${shortPath(c.path)}` }));
    select.value = folder;
    select.addEventListener('change', () => this.picked.set(t.id, select.value));
    const busy = this.busy === t.id;
    const go = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', on: { click: () => void this.begin(t, select.value) } }, busy ? tr('Iniciando…') : tr('Iniciar'));
    go.disabled = !!this.busy;
    const skip = h('button', { class: 'ui-btn ui-perm__btn', type: 'button', on: { click: () => this.ignore(t.id) } }, tr('Ignorar'));
    const open = t.agents ?? [];
    const convo = h('select', { class: 'ui-rename__input ui-vboards__folder', attrs: { 'aria-label': tr('Conversa aberta') } });
    for (const a of open) convo.append(h('option', { attrs: { value: a.id }, text: `${a.title || a.name} (${a.provider}) — ${shortPath(a.folder)}` }));
    const link = h('button', { class: 'ui-btn ui-perm__btn', type: 'button', on: { click: () => void this.attach(t, convo.value) } }, tr('Ligar a uma conversa aberta'));
    link.disabled = !!this.busy;
    const mark = h('input', { type: 'checkbox' });
    mark.checked = this.marked.has(t.id);
    mark.addEventListener('change', () => {
      if (mark.checked) this.marked.add(t.id);
      else this.marked.delete(t.id);
      this.syncListBtn();
    });
    return h(
      'li',
      { class: 'ui-vboards__item' },
      access().chat ? h('label', { class: 'ui-spawn__check' }, mark, h('span', { text: tr('Marcar para rodar como lista') })) : null,
      h('span', { class: 'ui-spawn__folder-name', text: t.cardTitle || tr('(card sem título)') }),
      h('p', { class: 'ui-vboards__text', text: t.text }),
      select,
      h('div', { class: 'ui-vboards__actions' }, go, skip),
      open.length ? convo : null,
      open.length ? h('div', { class: 'ui-vboards__actions' }, link) : null,
    );
  }

  private refineItem(r: VBoardsRefine): HTMLElement {
    const state = r.state === 'running' ? tr('Refinando: lendo o projeto, só leitura…') : r.state === 'ready' ? tr('Plano pronto: veja no card do VBoards.') : tr('Refinar falhou: {0}', [r.error ?? '']);
    return h(
      'li',
      { class: `ui-vboards__item is-${r.state}` },
      h('span', { class: 'ui-spawn__folder-name', text: r.cardTitle || tr('(card sem título)') }),
      h('p', { class: `ui-vboards__text${r.state === 'failed' ? ' is-error' : ''}`, text: state }),
    );
  }

  private ignore(id: string): void {
    this.ignored = [...this.ignored.filter((x) => x !== id), id];
    writeIgnored(this.ignored);
    this.renderList();
    this.ctx.invalidate();
  }

  /** Liga a subtarefa a uma conversa já aberta: ela conclui quando essa sessão acabar. */
  private async attach(t: VBoardsTask, agentId: string): Promise<void> {
    if (this.busy || !agentId) return;
    this.busy = t.id;
    this.renderList();
    try {
      const res = await fetch('/api/vboards/attach', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.id, agentId }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
      this.tasks = this.tasks.filter((x) => x.id !== t.id);
      this.say(tr('Ligada: a subtarefa conclui quando essa conversa acabar.'));
    } catch (err) {
      this.say(tr('Não ligou: {0}', [(err as Error).message]), true);
    } finally {
      this.busy = undefined;
      this.renderList();
      this.ctx.invalidate();
    }
  }

  private async begin(t: VBoardsTask, folder: string): Promise<void> {
    if (this.busy) return;
    if (!folder) return this.say(tr('Escolha a pasta do projeto.'), true);
    if (access().chat) {
      // Com o chat: a janela de novo agente abre preenchida (agente, papel, permissão...) e inicia a task.
      const prompt = `${tr('Tarefa do VBoards (card {0}):', [t.cardTitle])} ${t.text}`;
      window.dispatchEvent(new CustomEvent('habblaud:vboards-start', { detail: { folder, prompt, vboardsTaskId: t.id } }));
      return;
    }
    this.busy = t.id;
    this.renderList();
    this.say(tr('Começando no computador…'));
    try {
      const res = await fetch('/api/vboards/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: t.id, folder }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
      this.tasks = this.tasks.filter((x) => x.id !== t.id);
      this.say(tr('Iniciado: o agente aparece no escritório em instantes.'));
      this.ctx.announce(tr('Agente novo rodando.'));
    } catch (err) {
      this.say(tr('Não abriu: {0}', [(err as Error).message]), true);
    } finally {
      this.busy = undefined;
      this.renderList();
      this.ctx.invalidate();
    }
  }
}
