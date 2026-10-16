// Gatilhos (server/chat/triggers.ts): regras "quando X, faça Y". Duas vistas no mesmo popover: a lista (ligar/desligar,
// editar, apagar, "Testar agora" e o histórico dos disparos) e o formulário (quando + faça + prévia do texto). Nenhum
// disparo roda sozinho: cada um vira um cartão de aprovação no escritório.
import { tr } from '../../../shared/i18n';
import { TRIGGER_DEBOUNCE_DEFAULT, TRIGGER_INTERVAL_MIN, TRIGGER_WINDOW_DEFAULT, type TriggerFiring, type TriggerRule } from '../../../shared/triggers';
import { ChatOptionsFields } from './chat-options';
import type { UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { ago, shortPath } from './spawn';
import { dayNames, doText, outcomeLabel, previewText, toTriggerBody, whenText, type TriggerForm, type WhenKind } from './triggers-model';

const POLL_MS = 3_000;
const HISTORY_SHOWN = 30;

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error(tr('o Habblaud não respondeu'));
  }
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(out.error ?? tr('erro {0}', [res.status]));
  return out;
}

function input(type: string, attrs: Record<string, string> = {}): HTMLInputElement {
  const el = h('input', { class: 'ui-rename__input', type, attrs });
  el.addEventListener('keydown', (e) => e.stopPropagation());
  el.addEventListener('keyup', (e) => e.stopPropagation());
  return el;
}

function textarea(rows: number, placeholder: string): HTMLTextAreaElement {
  const el = h('textarea', { class: 'ui-rename__input ui-spawn__prompt', attrs: { rows, placeholder } });
  el.addEventListener('keydown', (e) => e.stopPropagation());
  el.addEventListener('keyup', (e) => e.stopPropagation());
  return el;
}

const select = (label: string, change?: () => void) => h('select', { class: 'ui-rename__input', attrs: { 'aria-label': label }, ...(change ? { on: { change } } : {}) });
const field = (label: string, control: HTMLElement) => h('label', { class: 'ui-spawn__field' }, h('span', { text: label }), control);
const option = (value: string, text: string) => h('option', { attrs: { value }, text });

export class TriggersPanel {
  readonly el: HTMLElement;
  private readonly options = new ChatOptionsFields(false);
  private readonly listEl: HTMLElement;
  private readonly editEl: HTMLElement;
  private readonly rulesList: HTMLElement;
  private readonly historyList: HTMLElement;
  private readonly status: HTMLElement;
  private readonly title: HTMLElement;
  // formulário
  private readonly name = input('text', { maxlength: '60' });
  private readonly enabled = input('checkbox');
  private readonly windowMinutes = input('number', { min: '1', max: '1440' });
  private readonly when = select(tr('Quando'), () => this.syncForm());
  private readonly time = input('time');
  private readonly days = dayNames().map(() => input('checkbox'));
  private readonly minutes = input('number', { min: String(TRIGGER_INTERVAL_MIN) });
  private readonly watch = select(tr('Agente ou papel'));
  private readonly alsoFailed = input('checkbox');
  private readonly filesFolder = select(tr('Pasta'));
  private readonly glob = input('text', { placeholder: 'src/**/*.ts', spellcheck: 'false' });
  private readonly debounce = input('number', { min: '5', max: '3600' });
  private readonly action = select(tr('Faça'), () => this.syncForm());
  private readonly openFolder = select(tr('Pasta'));
  private readonly prompt = textarea(4, tr('Revise as mudanças em {{arquivos}} e aponte problemas.'));
  private readonly sendTo = select(tr('Agente'));
  private readonly message = textarea(3, tr('{{agente}} terminou: {{saida}}'));
  private readonly preview = h('pre', { class: 'ui-trig__preview' });
  private readonly whenParts: Record<WhenKind, HTMLElement>;
  private readonly openPart: HTMLElement;
  private readonly sendPart: HTMLElement;
  private anchor?: HTMLElement;
  private rules: TriggerRule[] = [];
  private history: TriggerFiring[] = [];
  private editing?: TriggerRule;
  private shown = '';
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  constructor(private readonly ctx: UiContext) {
    this.status = h('p', { class: 'ui-rename__hint ui-spawn__status', attrs: { role: 'status', 'aria-live': 'polite' } });
    const label = (text: string) => h('p', { class: 'ui-spawn__label', text });
    const primary = (text: string, click: () => void) => h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', on: { click } }, text);
    const secondary = (text: string, click: () => void) => h('button', { class: 'ui-btn ui-perm__btn', type: 'button', on: { click } }, text);

    this.when.append(option('schedule', tr('Horário')), option('interval', tr('A cada N minutos')), option('agent', tr('Um agente terminou')), option('files', tr('Arquivos mudaram')));
    this.action.append(option('open', tr('Abrir um agente')), option('send', tr('Mandar mensagem a um agente')));
    const names = dayNames();
    this.whenParts = {
      schedule: h(
        'div',
        { class: 'ui-runs__view' },
        field(tr('Hora (deste computador)'), this.time),
        h('fieldset', { class: 'ui-trig__days' }, h('legend', { text: tr('Dias') }), ...this.days.map((d, i) => h('label', {}, d, h('span', { text: names[i] })))),
      ),
      interval: field(tr('A cada (minutos, mínimo {0})', [TRIGGER_INTERVAL_MIN]), this.minutes),
      agent: h('div', { class: 'ui-runs__view' }, field(tr('Agente ou papel'), this.watch), h('label', { class: 'ui-spawn__check' }, this.alsoFailed, h('span', { text: tr('Também quando falhar') }))),
      files: h(
        'div',
        { class: 'ui-runs__view' },
        field(tr('Pasta'), this.filesFolder),
        field(tr('Filtro (glob, opcional)'), this.glob),
        field(tr('Esperar quietar (segundos)'), this.debounce),
        h('p', { class: 'ui-rename__hint', text: tr('Ignora .git, node_modules e dist.') }),
      ),
    };
    this.openPart = h('div', { class: 'ui-runs__view' }, field(tr('Pasta'), this.openFolder), this.options.el, label(tr('Pedido')), this.prompt);
    this.sendPart = h('div', { class: 'ui-runs__view' }, field(tr('Agente'), this.sendTo), label(tr('Mensagem')), this.message);
    for (const el of [this.name, this.prompt, this.message]) el.addEventListener('input', () => this.renderPreview());

    this.editEl = h(
      'div',
      { class: 'ui-runs__view' },
      field(tr('Nome'), this.name),
      field(tr('Quando'), this.when),
      ...Object.values(this.whenParts),
      field(tr('Faça'), this.action),
      this.openPart,
      this.sendPart,
      h('p', { class: 'ui-rename__hint', text: tr('No texto: {{regra}}, {{motivo}}, {{arquivos}}, {{saida}}, {{agente}}, {{hora}}.') }),
      label(tr('Prévia (com valores de exemplo)')),
      this.preview,
      field(tr('Prazo para aprovar (minutos)'), this.windowMinutes),
      h('label', { class: 'ui-spawn__check' }, this.enabled, h('span', { text: tr('Ligado') })),
      h('p', { class: 'ui-rename__hint', text: tr('Cada disparo vira um cartão de aprovação: nada roda sem você aprovar.') }),
      h('div', { class: 'ui-vboards__actions' }, primary(tr('Salvar'), () => void this.save()), secondary(tr('Voltar'), () => this.show('list'))),
    );
    this.rulesList = h('ul', { class: 'ui-vboards__list ui-runs__runs' });
    this.historyList = h('ol', { class: 'ui-runs__items ui-trig__history' });
    this.listEl = h(
      'div',
      { class: 'ui-runs__view' },
      h('div', { class: 'ui-vboards__actions' }, primary(tr('Novo gatilho'), () => this.edit())),
      this.rulesList,
      label(tr('Últimos disparos')),
      this.historyList,
    );
    this.title = h('h2', { text: tr('Gatilhos') });
    this.el = h(
      'div',
      { class: 'ui-popover ui-spawn ui-runs', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': tr('Gatilhos'), id: 'ui-triggers', popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, this.title, iconButton(ICONS.close, tr('Fechar'), () => this.hide(), 'ui-icon-btn--sm')),
      h('div', { class: 'ui-set-group ui-spawn__body' }, this.listEl, this.editEl, this.status),
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

  toggle(anchor: HTMLElement): void {
    if (this.isOpen) return this.hide();
    this.anchor = anchor;
    setText(this.status, '');
    void this.options.load().then((o) => {
      if (!o) return this.say(tr('Chat com agentes indisponível.'), true);
      const folders = o.folders.map((f) => option(f.path, `${f.name || f.path.split(/[\\/]/).pop() || f.path} — ${shortPath(f.path)}`));
      this.openFolder.replaceChildren(...folders);
      this.filesFolder.replaceChildren(...folders.map((f) => f.cloneNode(true)));
    });
    const r = anchor.getBoundingClientRect();
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    this.el.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 4))}px`;
    if (typeof this.el.showPopover === 'function') this.el.showPopover();
    else this.el.classList.add('is-open');
    anchor.setAttribute('aria-expanded', 'true');
    this.show('list');
    void this.refresh();
    this.stopPolling();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
  }

  hide(): void {
    this.stopPolling();
    if (typeof this.el.hidePopover === 'function' && this.isOpen) this.el.hidePopover();
    this.el.classList.remove('is-open');
    this.anchor?.setAttribute('aria-expanded', 'false');
  }

  private stopPolling(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private show(view: 'list' | 'edit'): void {
    setHidden(this.listEl, view !== 'list');
    setHidden(this.editEl, view !== 'edit');
    setText(this.title, view === 'list' ? tr('Gatilhos') : this.editing ? tr('Editar gatilho') : tr('Novo gatilho'));
    if (view === 'list') this.render(true);
  }

  private names() {
    return {
      agent: (id: string) => this.ctx.agent(id)?.name ?? id,
      role: (id: string) => this.options.roleName(id) || id,
    };
  }

  /** Agentes do chat e papéis para os selects (o que existe agora). */
  private fillAgents(keepWatch: string, keepSend: string): void {
    const agents = (this.ctx.store.snapshot?.agents ?? []).filter((a) => a.chat && a.status !== 'offline');
    const agentOpts = () => agents.map((a) => option(a.id, a.role ? `${a.name} (${a.role})` : a.name));
    const roles = this.options.data?.roles ?? [];
    this.watch.replaceChildren(
      option('', tr('Escolha…')),
      h('optgroup', { attrs: { label: tr('Agente') } }, ...agents.map((a) => option(`agent:${a.id}`, a.role ? `${a.name} (${a.role})` : a.name))),
      h('optgroup', { attrs: { label: tr('Qualquer agente com o papel') } }, ...roles.map((r) => option(`role:${r.id}`, r.name))),
    );
    this.sendTo.replaceChildren(option('', tr('Escolha…')), ...agentOpts());
    // Agente que já saiu continua escolhido (o servidor diz se ainda existe).
    for (const [sel, keep] of [
      [this.watch, keepWatch],
      [this.sendTo, keepSend],
    ] as const) {
      if (keep && ![...sel.options].some((o) => o.value === keep)) sel.append(option(keep, keep.replace(/^agent:/, '')));
      sel.value = keep;
    }
  }

  /** Novo (sem argumento) ou editar. */
  private edit(rule?: TriggerRule): void {
    this.editing = rule;
    const w = rule?.when;
    const d = rule?.do;
    this.name.value = rule?.name ?? '';
    this.enabled.checked = rule?.enabled ?? true;
    this.windowMinutes.value = String(rule?.windowMinutes ?? TRIGGER_WINDOW_DEFAULT);
    this.when.value = w?.kind ?? 'schedule';
    this.time.value = w?.kind === 'schedule' ? w.time : '09:00';
    this.days.forEach((c, i) => (c.checked = w?.kind === 'schedule' ? !w.days.length || w.days.includes(i) : i >= 1 && i <= 5));
    this.minutes.value = String(w?.kind === 'interval' ? w.minutes : 60);
    this.alsoFailed.checked = w?.kind === 'agent' && !!w.alsoFailed;
    this.glob.value = w?.kind === 'files' ? (w.glob ?? '') : '';
    this.debounce.value = String(w?.kind === 'files' ? (w.debounceSec ?? TRIGGER_DEBOUNCE_DEFAULT) : TRIGGER_DEBOUNCE_DEFAULT);
    if (w?.kind === 'files') this.filesFolder.value = w.folder;
    this.action.value = d?.kind ?? 'open';
    this.prompt.value = d?.kind === 'open' ? d.prompt : '';
    this.message.value = d?.kind === 'send' ? d.message : '';
    if (d?.kind === 'open') {
      this.openFolder.value = d.options.folder;
      this.options.set(d.options);
    } else this.options.set({ provider: 'claude', permission: 'ask' });
    this.fillAgents(w?.kind === 'agent' ? (w.agentId ? `agent:${w.agentId}` : `role:${w.roleId}`) : '', d?.kind === 'send' ? d.agentId : '');
    this.syncForm();
    this.say('');
    this.show('edit');
  }

  private syncForm(): void {
    for (const [k, el] of Object.entries(this.whenParts)) setHidden(el, k !== this.when.value);
    setHidden(this.openPart, this.action.value !== 'open');
    setHidden(this.sendPart, this.action.value !== 'send');
    this.renderPreview();
  }

  private renderPreview(): void {
    setText(this.preview, previewText(this.action.value === 'send' ? this.message.value : this.prompt.value, this.name.value));
  }

  private form(): TriggerForm {
    return {
      name: this.name.value,
      enabled: this.enabled.checked,
      windowMinutes: this.windowMinutes.value,
      when: this.when.value as WhenKind,
      time: this.time.value,
      days: this.days.flatMap((c, i) => (c.checked ? [i] : [])),
      minutes: this.minutes.value,
      watch: this.watch.value,
      alsoFailed: this.alsoFailed.checked,
      filesFolder: this.filesFolder.value,
      glob: this.glob.value,
      debounceSec: this.debounce.value,
      action: this.action.value as 'open' | 'send',
      open: this.options.form(this.openFolder.value, this.prompt.value),
      sendTo: this.sendTo.value,
      message: this.message.value,
    };
  }

  private async save(): Promise<void> {
    if (this.busy) return;
    const body = toTriggerBody(this.form());
    if ('error' in body) return this.say(body.error as string, true);
    this.busy = true;
    try {
      if (this.editing) await api(`/api/chat/triggers/${encodeURIComponent(this.editing.id)}`, 'PUT', body);
      else await api('/api/chat/triggers', 'POST', body);
      this.say(tr('Gatilho salvo.'));
      this.editing = undefined;
      await this.refresh();
      this.show('list');
    } catch (err) {
      this.say(tr('Não salvou: {0}', [(err as Error).message]), true);
    } finally {
      this.busy = false;
    }
  }

  private async act(rule: TriggerRule, what: 'toggle' | 'test' | 'delete'): Promise<void> {
    try {
      if (what === 'delete') {
        if (!confirm(tr('Apagar o gatilho "{0}"?', [rule.name]))) return;
        await api(`/api/chat/triggers/${encodeURIComponent(rule.id)}`, 'DELETE');
      } else if (what === 'test') {
        await api(`/api/chat/triggers/${encodeURIComponent(rule.id)}/test`, 'POST', {});
        this.say(tr('Disparado: aprove o cartão no escritório para rodar.'));
        this.ctx.announce(tr('Gatilho disparado; aprovação pendente.'));
      } else {
        await api(`/api/chat/triggers/${encodeURIComponent(rule.id)}`, 'PUT', { ...rule, enabled: !rule.enabled });
      }
    } catch (err) {
      this.say((err as Error).message, true);
    }
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      [this.rules, this.history] = await Promise.all([api<TriggerRule[]>('/api/chat/triggers'), api<TriggerFiring[]>('/api/chat/triggers/history')]);
    } catch {
      return;
    }
    if (!this.listEl.hidden) this.render();
  }

  private say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
  }

  /** Redesenha só quando algo mudou (o foco não se perde a cada consulta). */
  private render(force = false): void {
    const sig = JSON.stringify([this.rules, this.history.slice(0, HISTORY_SHOWN)]);
    if (!force && sig === this.shown) return;
    this.shown = sig;
    const names = this.names();
    this.rulesList.replaceChildren(
      ...(this.rules.length
        ? this.rules.map((r) => {
            const toggle = h('input', { type: 'checkbox', attrs: { 'aria-label': tr('Ligado') }, on: { change: () => void this.act(r, 'toggle') } });
            toggle.checked = r.enabled;
            const btn = (text: string, click: () => void) => h('button', { class: 'ui-btn ui-perm__btn', type: 'button', on: { click } }, text);
            return h(
              'li',
              { class: `ui-vboards__item ui-runs__run${r.enabled ? '' : ' is-off'}` },
              h('label', { class: 'ui-spawn__check' }, toggle, h('span', { class: 'ui-spawn__folder-name', text: r.name })),
              h('span', { class: 'ui-spawn__folder-path', text: `${whenText(r.when, names)} → ${doText(r, names)}` }),
              h('div', { class: 'ui-vboards__actions' }, btn(tr('Testar agora'), () => void this.act(r, 'test')), btn(tr('Editar'), () => this.edit(r)), btn(tr('Apagar'), () => void this.act(r, 'delete'))),
            );
          })
        : [h('li', { class: 'ui-rename__hint', text: tr('Nenhum gatilho ainda.') })]),
    );
    const shown = this.history.slice(0, HISTORY_SHOWN);
    this.historyList.replaceChildren(
      ...(shown.length
        ? shown.map((f) =>
            h(
              'li',
              { class: `ui-trig__firing is-${f.outcome}`, attrs: { title: f.action ?? '' } },
              h('span', { text: `${ago(f.at)} · ${f.ruleName} · ${outcomeLabel(f.outcome)}${f.coalesced ? ` (+${f.coalesced})` : ''}` }),
              h('span', { class: 'ui-runs__summary-text', text: f.note ? `${f.reason} — ${f.note}` : f.reason }),
            ),
          )
        : [h('li', { class: 'ui-rename__hint', text: tr('Nenhum disparo ainda.') })]),
    );
  }
}
