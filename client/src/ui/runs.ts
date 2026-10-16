// Rodar lista (server/chat/runs.ts): um agente novo do chat por item, em sequência. Três vistas no mesmo popover:
// montar (colar um checklist em Markdown ou as tarefas marcadas no VBoards + as opções da janela de abrir agente),
// confirmar (todos os itens, a pasta, o agente, o papel e a permissão; "Rodar lista" é a aprovação da lista inteira) e
// acompanhar (cada item com o agente dele; Parar, Continuar, Juntar/Descartar).
import { tr } from '../../../shared/i18n';
import { parseChecklist, type ChatRun, type RunCreateRequest } from '../../../shared/runs';
import { ChatOptionsFields } from './chat-options';
import type { UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { ITEM_MARK, itemStateLabel, runStateLabel, toRunRequest, type RunSource } from './runs-model';
import { ago, shortPath } from './spawn';
import { providerLabel } from './spawn-model';

const POLL_MS = 2_000;

async function api<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(tr('o Habblaud não respondeu'));
  }
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(out.error ?? tr('erro {0}', [res.status]));
  return out;
}

const textarea = (rows: number, placeholder: string) => {
  const el = h('textarea', { class: 'ui-rename__input ui-spawn__prompt', attrs: { rows, placeholder } });
  el.addEventListener('keydown', (e) => e.stopPropagation());
  el.addEventListener('keyup', (e) => e.stopPropagation());
  return el;
};

export class RunsPanel {
  readonly el: HTMLElement;
  private readonly options = new ChatOptionsFields(true);
  private readonly folder: HTMLSelectElement;
  private readonly items: HTMLTextAreaElement;
  private readonly fixedList: HTMLElement;
  private readonly context: HTMLTextAreaElement;
  private readonly stopOnFail: HTMLInputElement;
  private readonly editEl: HTMLElement;
  private readonly confirmEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly runsList: HTMLElement;
  private readonly status: HTMLElement;
  private readonly title: HTMLElement;
  private anchor?: HTMLElement;
  /** Tarefas marcadas no VBoards ("Rodar como lista"): os itens vêm prontos. */
  private fixed?: RunSource;
  private wantFolder = '';
  private pending?: RunCreateRequest;
  private runs: ChatRun[] = [];
  private shown = '';
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(private readonly ctx: UiContext) {
    this.folder = h('select', { class: 'ui-rename__input', attrs: { 'aria-label': tr('Pasta do projeto') } });
    this.items = textarea(7, tr('- [ ] criar a tela de login\n- [ ] escrever os testes\n- [ ] atualizar o README'));
    this.fixedList = h('ol', { class: 'ui-runs__items' });
    this.context = textarea(3, tr('Contexto comum (opcional): vai antes de cada item'));
    this.stopOnFail = h('input', { type: 'checkbox' });
    this.stopOnFail.checked = true;
    this.status = h('p', { class: 'ui-rename__hint ui-spawn__status', attrs: { role: 'status', 'aria-live': 'polite' } });
    const label = (text: string) => h('p', { class: 'ui-spawn__label', text });
    const primary = (text: string, click: () => void) => h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', on: { click } }, text);
    const secondary = (text: string, click: () => void) => h('button', { class: 'ui-btn ui-perm__btn', type: 'button', on: { click } }, text);

    this.editEl = h(
      'div',
      { class: 'ui-runs__view' },
      label(tr('Projeto')),
      this.folder,
      label(tr('Itens (um agente novo por item, em sequência)')),
      this.items,
      this.fixedList,
      this.context,
      this.options.el,
      h('label', { class: 'ui-spawn__check' }, this.stopOnFail, h('span', { text: tr('Parar se um item falhar') })),
      h('p', { class: 'ui-rename__hint', text: tr('Nada roda antes da confirmação: a próxima tela mostra todos os itens.') }),
      h('div', { class: 'ui-vboards__actions' }, primary(tr('Revisar'), () => this.review()), secondary(tr('Ver listas'), () => this.show('list'))),
    );
    this.confirmEl = h('div', { class: 'ui-runs__view' });
    this.runsList = h('ul', { class: 'ui-vboards__list ui-runs__runs' });
    this.listEl = h('div', { class: 'ui-runs__view' }, h('div', { class: 'ui-vboards__actions' }, primary(tr('Nova lista'), () => this.show('edit'))), this.runsList);
    this.title = h('h2', { text: tr('Rodar lista') });
    this.el = h(
      'div',
      { class: 'ui-popover ui-spawn ui-runs', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': tr('Rodar lista'), id: 'ui-runs', popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, this.title, iconButton(ICONS.close, tr('Fechar'), () => this.hide(), 'ui-icon-btn--sm')),
      h('div', { class: 'ui-set-group ui-spawn__body' }, this.editEl, this.confirmEl, this.listEl, this.status),
    );
    this.el.addEventListener('toggle', () => {
      this.anchor?.setAttribute('aria-expanded', String(this.isOpen));
      if (!this.isOpen) this.stopPolling();
    });
  }

  get isOpen(): boolean {
    try {
      return this.el.matches(':popover-open');
    } catch {
      return this.el.classList.contains('is-open');
    }
  }

  /** Botão da barra: abre nas listas (ou direto em "Nova lista", se não houver nenhuma). */
  toggle(anchor: HTMLElement): void {
    if (this.isOpen) return this.hide();
    this.fixed = undefined;
    this.wantFolder = '';
    this.open(anchor);
    this.show('list');
    void this.refresh().then(() => {
      if (!this.runs.length && !this.listEl.hidden) this.show('edit');
    });
  }

  /** "Rodar como lista" no VBoards: as tarefas marcadas viram os itens. */
  openWith(p: { folder: string; items: RunSource }, anchor: HTMLElement): void {
    this.fixed = p.items;
    this.wantFolder = p.folder;
    if (!this.isOpen) this.open(anchor);
    this.show('edit');
    void this.refresh();
  }

  hide(): void {
    this.stopPolling();
    if (typeof this.el.hidePopover === 'function' && this.isOpen) this.el.hidePopover();
    this.el.classList.remove('is-open');
    this.anchor?.setAttribute('aria-expanded', 'false');
  }

  private open(anchor: HTMLElement): void {
    this.anchor = anchor;
    setText(this.status, '');
    void this.loadOptions();
    const r = anchor.getBoundingClientRect();
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    this.el.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 4))}px`;
    if (typeof this.el.showPopover === 'function') this.el.showPopover();
    else this.el.classList.add('is-open');
    anchor.setAttribute('aria-expanded', 'true');
    this.stopPolling();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  private stopPolling(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private show(view: 'edit' | 'confirm' | 'list'): void {
    setHidden(this.editEl, view !== 'edit');
    setHidden(this.confirmEl, view !== 'confirm');
    setHidden(this.listEl, view !== 'list');
    setText(this.title, view === 'list' ? tr('Listas') : view === 'confirm' ? tr('Confirmar a lista') : tr('Rodar lista'));
    if (view === 'edit') {
      setHidden(this.items, !!this.fixed);
      setHidden(this.fixedList, !this.fixed);
      this.fixedList.replaceChildren(...(this.fixed ?? []).map((i) => h('li', { text: i.text })));
      this.pickFolder();
    }
    if (view === 'list') this.renderRuns(true);
  }

  private async loadOptions(): Promise<void> {
    const o = await this.options.load();
    if (!o) return this.say(tr('Chat com agentes indisponível.'), true);
    const keep = this.folder.value;
    this.folder.replaceChildren(...o.folders.map((f) => h('option', { attrs: { value: f.path }, text: `${f.name || f.path.split(/[\\/]/).pop() || f.path} — ${shortPath(f.path)}` })));
    if (keep && o.folders.some((f) => f.path === keep)) this.folder.value = keep;
    this.pickFolder();
  }

  private pickFolder(): void {
    if (this.wantFolder && [...this.folder.options].some((o) => o.value === this.wantFolder)) this.folder.value = this.wantFolder;
  }

  private source(): RunSource {
    return this.fixed ?? parseChecklist(this.items.value).map((text) => ({ text }));
  }

  /** Revisar: monta o pedido e mostra tudo o que vai rodar. */
  private review(): void {
    const folder = this.folder.value;
    if (!folder) return this.say(tr('Escolha o projeto.'), true);
    const req = toRunRequest(this.options.form(folder, ''), this.source(), this.context.value, this.stopOnFail.checked);
    if ('error' in req) return this.say(req.error, true);
    this.pending = req;
    this.say('');
    const o = req.options;
    const limits = [
      o.limits?.maxCostUsd ? `US$ ${o.limits.maxCostUsd}` : '',
      o.limits?.maxTokens ? tr('{0} tokens', [o.limits.maxTokens]) : '',
      o.limits?.maxTurnMinutes ? `${o.limits.maxTurnMinutes} min` : '',
    ].filter(Boolean);
    const row = (k: string, v: string) => h('div', { class: 'ui-runs__row' }, h('dt', { text: k }), h('dd', { text: v }));
    this.confirmEl.replaceChildren(
      h(
        'dl',
        { class: 'ui-runs__summary' },
        row(tr('Pasta'), shortPath(o.folder)),
        row(tr('Agente'), o.model ? `${providerLabel(o.provider)} (${o.model})` : providerLabel(o.provider)),
        row(tr('Papel'), this.options.roleName(o.roleId) || tr('Sem papel')),
        row(tr('Permissões'), o.permission === 'ask' ? tr('Pedir aprovação a cada ação') : tr('Automático (faz tudo sozinho)')),
        row(tr('Cópia isolada'), req.isolated ? tr('sim, um worktree para a lista toda') : tr('não')),
        row(tr('Limites por item'), limits.length ? limits.join(' · ') : tr('sem limite')),
        row(tr('Se um item falhar'), req.stopOnFail ? tr('a lista para') : tr('segue para o próximo')),
        req.context ? row(tr('Contexto comum'), req.context) : null,
      ),
      h('p', { class: 'ui-spawn__label', text: tr('{0} itens, um agente novo para cada, nesta ordem:', [req.items.length]) }),
      h('ol', { class: 'ui-runs__items' }, ...req.items.map((i) => h('li', { text: i.text }))),
      h(
        'div',
        { class: 'ui-vboards__actions' },
        h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', on: { click: () => void this.start() } }, tr('Rodar lista')),
        h('button', { class: 'ui-btn ui-perm__btn', type: 'button', on: { click: () => this.show('edit') } }, tr('Voltar')),
      ),
    );
    this.show('confirm');
  }

  /** "Rodar lista": a aprovação da lista inteira. */
  private async start(): Promise<void> {
    if (this.busy || !this.pending) return;
    this.busy = true;
    try {
      this.say(tr('Começando no computador…'));
      await api<ChatRun>('/api/chat/runs', this.pending);
      this.pending = undefined;
      this.items.value = '';
      this.fixed = undefined;
      this.say(tr('Lista rodando: um item por vez.'));
      this.ctx.announce(tr('Lista rodando.'));
      await this.refresh();
      this.show('list');
    } catch (err) {
      this.say(tr('Não começou: {0}', [(err as Error).message]), true);
    } finally {
      this.busy = false;
    }
  }

  private async act(run: ChatRun, action: 'stop' | 'continue' | 'merge' | 'discard'): Promise<void> {
    try {
      await api(`/api/chat/runs/${encodeURIComponent(run.id)}/${action}`, {});
      this.say('');
    } catch (err) {
      this.say((err as Error).message, true);
    }
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      this.runs = await api<ChatRun[]>('/api/chat/runs');
    } catch {
      return;
    }
    if (!this.listEl.hidden) this.renderRuns();
  }

  private say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
  }

  /** Redesenha só quando algo mudou (o foco não se perde a cada consulta). */
  private renderRuns(force = false): void {
    const sig = JSON.stringify(this.runs);
    if (!force && sig === this.shown) return;
    this.shown = sig;
    if (!this.runs.length) return void this.runsList.replaceChildren(h('li', { class: 'ui-rename__hint', text: tr('Nenhuma lista ainda.') }));
    this.runsList.replaceChildren(...this.runs.map((r) => this.card(r)));
  }

  private card(run: ChatRun): HTMLElement {
    const btn = (text: string, action: 'stop' | 'continue' | 'merge' | 'discard', allow = false) =>
      h('button', { class: `ui-btn ui-perm__btn${allow ? ' ui-perm__btn--allow' : ''}`, type: 'button', on: { click: () => void this.act(run, action) } }, text);
    const done = run.items.filter((i) => i.state === 'done').length;
    const w = run.isolated;
    const copyOpen = !!w && !w.merged && !w.discarded && run.state !== 'running';
    return h(
      'li',
      { class: `ui-vboards__item ui-runs__run is-${run.state}` },
      h('span', { class: 'ui-spawn__folder-name', text: `${runStateLabel(run.state)} · ${done}/${run.items.length} · ${ago(run.createdAt)}` }),
      h('span', { class: 'ui-spawn__folder-path', text: shortPath(run.options.folder) + (w ? ` · ${w.branch}` : '') }),
      run.note ? h('p', { class: 'ui-rename__hint is-error', text: run.note }) : null,
      h(
        'ol',
        { class: 'ui-runs__items' },
        ...run.items.map((i) =>
          h(
            'li',
            { class: `ui-runs__item is-${i.state}`, attrs: { title: i.summary ?? '' } },
            h('span', { class: 'ui-runs__mark', text: ITEM_MARK[i.state], attrs: { 'aria-label': itemStateLabel(i.state) } }),
            i.agentId
              ? h('button', { class: 'ui-runs__link', type: 'button', text: i.text, attrs: { title: tr('Ver o agente deste item') }, on: { click: () => this.ctx.select({ type: 'agent', id: i.agentId! }, { focus: true }) } })
              : h('span', { class: 'ui-runs__text', text: i.text }),
            i.summary ? h('span', { class: 'ui-runs__summary-text', text: i.summary }) : null,
          ),
        ),
      ),
      h(
        'div',
        { class: 'ui-vboards__actions' },
        run.state === 'paused' || run.state === 'failed' ? btn(tr('Continuar'), 'continue', true) : null,
        run.state === 'running' || run.state === 'paused' || run.state === 'failed' ? btn(tr('Parar'), 'stop') : null,
        copyOpen ? btn(tr('Juntar'), 'merge', true) : null,
        copyOpen ? btn(tr('Descartar'), 'discard') : null,
      ),
    );
  }
}
