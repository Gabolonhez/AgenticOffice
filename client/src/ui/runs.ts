// Rodar lista (server/chat/runs.ts): um agente novo do chat por item, em sequência. Três vistas no mesmo popover:
// montar (colar um checklist em Markdown ou as tarefas marcadas no VBoards + as opções da janela de abrir agente),
// confirmar (todos os itens, a pasta, o agente, o papel e a permissão; "Rodar lista" é a aprovação da lista inteira) e
// acompanhar (cada item com o agente dele; Parar, Continuar, Juntar/Descartar; o diff da cópia com comentários por linha).
import { tr } from '../../../shared/i18n';
import { parseChecklist, shipActive, shipApprovalOf, type ChatRun, type ShipApproval, type RunCreateRequest, type RunFeedbackComment, type RiskLevel, type RunShip, type ShipPreview, type ShipStep } from '../../../shared/runs';
import { ChatOptionsFields } from './chat-options';
import type { UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { RunDiffView } from './run-diff';
import { ITEM_MARK, itemStateLabel, runLabel, toRunRequest, type RunSource } from './runs-model';
import { ago, shortPath } from './spawn';
import { providerLabel } from './spawn-model';

const POLL_MS = 2_000;

async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
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

/** Etapas da barra do "Subir" (com mode 'pr' só as duas primeiras). */
const SHIP_STEPS: Array<{ step: ShipStep; label: () => string }> = [
  { step: 'pushing', label: () => tr('Push') },
  { step: 'pr', label: () => tr('PR') },
  { step: 'ci', label: () => tr('CI') },
  { step: 'merging', label: () => tr('Merge') },
  { step: 'deploying', label: () => tr('Deploy') },
];

/** Estado de cada etapa da barra: done, current, failed ou pending. */
/** Selo do risco (server/chat/risk.ts): baixo, médio ou alto, com cor e texto (não só a cor). */
const riskBadge = (r: RiskLevel): HTMLElement => h('span', { class: `ui-risk is-${r}`, text: r === 'low' ? tr('baixo') : r === 'medium' ? tr('médio') : tr('alto') });

function shipStates(s: RunShip): Array<{ step: ShipStep; label: string; state: 'done' | 'current' | 'failed' | 'pending' }> {
  const steps = s.mode === 'pr' ? SHIP_STEPS.slice(0, 2) : SHIP_STEPS;
  const at = (st: ShipStep | undefined) => steps.findIndex((x) => x.step === st);
  const cur = s.step === 'failed' ? at(s.failedAt) : at(s.step);
  return steps.map((x, i) => {
    const state = s.step === 'deployed' || (!shipActive(s) && s.step !== 'failed') ? 'done' : i < cur ? 'done' : i === cur ? (s.step === 'failed' ? 'failed' : 'current') : 'pending';
    return { step: x.step, label: x.label(), state };
  });
}

const CI_TEXT: Record<string, () => string> = {
  pending: () => tr('CI rodando…'),
  pass: () => tr('CI verde'),
  fail: () => tr('CI falhou'),
  'no-ci': () => tr('Repo sem CI de PR'),
};

/** Estado de tela de um cartão que não vem do servidor (sobrevive ao redesenho de cada consulta). */
interface CardUi {
  preview?: ShipPreview;
  loading?: boolean;
  pin: string;
  noCiPin: string;
  vscodePath?: string;
}

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
  private readonly diff: RunDiffView;
  private readonly ui = new Map<string, CardUi>();

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
    this.diff = new RunDiffView({
      load: (id) => api(`/api/chat/runs/${encodeURIComponent(id)}/diff`),
      send: async (id, index, comments: RunFeedbackComment[]) => {
        await api(`/api/chat/runs/${encodeURIComponent(id)}/items/${index}/feedback`, { comments });
        await this.refresh();
      },
      say: (text, error) => this.say(text, error),
    });
    this.listEl = h('div', { class: 'ui-runs__view' }, h('div', { class: 'ui-vboards__actions' }, primary(tr('Nova lista'), () => this.show('edit'))), this.runsList, this.diff.el);
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
      const run = await api<ChatRun>('/api/chat/runs', this.pending);
      this.pending = undefined;
      this.items.value = '';
      this.fixed = undefined;
      this.say(run.quotaOverride && run.note ? run.note : run.state === 'queued' ? tr('Lista na fila: começa sozinha quando a pasta (ou uma vaga) ficar livre.') : tr('Lista rodando: um item por vez.'));
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
    // Digitando o PIN: não redesenha (o foco e o texto ficam); a próxima consulta tenta de novo.
    if (!force && document.activeElement instanceof HTMLInputElement && this.runsList.contains(document.activeElement)) return;
    this.shown = sig;
    if (!this.runs.length) return void this.runsList.replaceChildren(h('li', { class: 'ui-rename__hint', text: tr('Nenhuma lista ainda.') }));
    this.runsList.replaceChildren(...this.runs.map((r) => this.card(r)));
  }

  private cardUi(id: string): CardUi {
    let u = this.ui.get(id);
    if (!u) this.ui.set(id, (u = { pin: '', noCiPin: '' }));
    return u;
  }

  /** "Subir": só prepara (commit local, sem rede) e abre a caixa de confirmação no cartão. */
  private async prepareShip(run: ChatRun): Promise<void> {
    const u = this.cardUi(run.id);
    u.loading = true;
    this.renderRuns(true);
    try {
      u.preview = await api<ShipPreview>(`/api/chat/runs/${encodeURIComponent(run.id)}/ship/prepare`, {});
      u.pin = '';
      this.say('');
    } catch (err) {
      this.say((err as Error).message, true);
    }
    u.loading = false;
    this.renderRuns(true);
  }

  /** Manda o cartão inteiro que a pessoa viu: o servidor recusa se qualquer campo mudou. */
  private async sendShip(run: ChatRun, approval: ShipApproval): Promise<void> {
    const u = this.cardUi(run.id);
    const noCi = !!approval.noCi;
    const pin = noCi ? u.noCiPin : u.pin;
    if (!pin) return this.say(tr('Digite o PIN de aprovação.'), true);
    try {
      await api(`/api/chat/runs/${encodeURIComponent(run.id)}/ship`, { pin, ...approval });
      u.preview = undefined;
      u.pin = u.noCiPin = '';
      this.say('');
    } catch (err) {
      this.say((err as Error).message, true);
    }
    await this.refresh();
    this.renderRuns(true);
  }

  private async openVscode(run: ChatRun): Promise<void> {
    try {
      const r = await api<{ opened: boolean; path: string }>(`/api/chat/runs/${encodeURIComponent(run.id)}/vscode`, {});
      this.cardUi(run.id).vscodePath = r.opened ? undefined : r.path;
      this.say('');
    } catch (err) {
      this.say((err as Error).message, true);
    }
    this.renderRuns(true);
  }

  private pinInput(get: () => string, set: (v: string) => void, enter: () => void): HTMLInputElement {
    const el = h('input', { class: 'ui-rename__input', type: 'password', attrs: { autocomplete: 'off', maxlength: 200, placeholder: tr('PIN de aprovação'), 'aria-label': tr('PIN de aprovação') } });
    el.value = get();
    el.addEventListener('input', () => set(el.value));
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') enter();
    });
    el.addEventListener('keyup', (e) => e.stopPropagation());
    return el;
  }

  private shipConfirm(run: ChatRun, p: ShipPreview): HTMLElement {
    const u = this.cardUi(run.id);
    const row = (k: string, v: string | HTMLElement) => h('div', { class: 'ui-runs__row' }, h('dt', { text: k }), h('dd', {}, v));
    const gate = p.gate === 'pass' ? tr('passou') : p.gate === 'fail' ? tr('falhou') : tr('sem portão');
    const go = () => void this.sendShip(run, shipApprovalOf(p));
    return h(
      'div',
      { class: 'ui-ship__box' },
      h(
        'dl',
        { class: 'ui-runs__summary' },
        row(tr('Pasta'), shortPath(p.folder)),
        row(tr('Repositório'), `${p.owner}/${p.repo}`),
        row(tr('Base'), `${p.base} ← ${p.branch}`),
        row('SHA', h('code', { class: 'ui-ship__sha', text: p.sha })),
        row(tr('Modo'), p.mode === 'merge' ? tr('merge automático') : tr('só PR')),
        row(tr('Deploy'), p.deploy === 'none' ? tr('nenhum') : p.deploy),
        row(tr('Portão'), gate),
        row(tr('Risco'), riskBadge(p.risk)),
      ),
      p.riskWhy.length ? h('p', { class: 'ui-rename__hint', text: p.riskWhy.join('; ') }) : null,
      p.stat ? h('pre', { class: 'ui-ship__stat', text: p.stat }) : null,
      p.risky.length ? h('p', { class: 'ui-ship__warn', text: tr('Muda hooks/CI que rodam com a sua credencial: {0}', [p.risky.join(', ')]) }) : null,
      p.mode === 'merge' ? h('p', { class: 'ui-rename__hint', text: tr('Com CI verde, o merge vai para {0} e dispara o deploy.', [p.base]) }) : null,
      this.pinInput(() => u.pin, (v) => (u.pin = v), go),
      h(
        'div',
        { class: 'ui-vboards__actions' },
        h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', on: { click: go } }, tr('Subir com PIN')),
        h('button', { class: 'ui-btn ui-perm__btn', type: 'button', on: { click: () => { u.preview = undefined; u.pin = ''; this.renderRuns(true); } } }, tr('Cancelar')),
      ),
    );
  }

  private shipProgress(run: ChatRun, s: RunShip): HTMLElement {
    const u = this.cardUi(run.id);
    const go = () => void this.sendShip(run, shipApprovalOf(s, true));
    return h(
      'div',
      { class: 'ui-ship' },
      s.step === 'waiting'
        ? h('p', { class: 'ui-rename__hint', text: tr('Esperando o repo anterior do produto') })
        : h(
            'ol',
            { class: 'ui-ship__bar', attrs: { 'aria-label': tr('Progresso do Subir') } },
            ...shipStates(s).map((x) => h('li', { class: `ui-ship__step is-${x.state}`, attrs: x.state === 'current' ? { 'aria-current': 'step' } : {} }, h('span', { class: 'ui-ship__dot' }), h('span', { text: x.label }))),
          ),
      s.auto ? h('p', { class: 'ui-rename__hint', text: tr('Subiu sozinho, sem PIN (vboards.autoMerge=low, risco baixo).') }) : null,
      s.prUrl ? h('a', { class: 'ui-runs__link', text: tr('PR #{0}', [s.prNumber ?? '']), attrs: { href: s.prUrl, target: '_blank', rel: 'noopener' } }) : null,
      s.step === 'ci' && s.ci ? h('p', { class: 'ui-rename__hint', text: CI_TEXT[s.ci]?.() ?? '' }) : null,
      s.note ? h('p', { class: `ui-rename__hint${s.step === 'failed' ? ' is-error' : ''}`, text: s.note }) : null,
      s.needs === 'no-ci'
        ? h(
            'div',
            { class: 'ui-ship__box ui-ship__box--danger' },
            h('p', { class: 'ui-ship__warn', text: s.risky?.length ? tr('O diff muda workflows ou hooks ({0}): CI verde não prova nada; merge = deploy em produção.', [s.risky.join(', ')]) : tr('Este repo não tem CI de PR; merge = deploy em produção.') }),
            h('p', { class: 'ui-rename__hint', text: `${s.owner}/${s.repo} · ${s.base} ← ${s.branch} · ${s.remote} · ${s.deploy}` }),
            h('code', { class: 'ui-ship__sha', text: s.sha }),
            this.pinInput(() => u.noCiPin, (v) => (u.noCiPin = v), go),
            h('div', { class: 'ui-vboards__actions' }, h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', on: { click: go } }, tr('Aprovar merge sem CI'))),
          )
        : null,
    );
  }

  private vscodeFallback(path: string): HTMLElement {
    const field = h('input', { class: 'ui-rename__input', type: 'text', attrs: { readonly: true, 'aria-label': tr('Caminho da cópia') } });
    field.value = path;
    field.addEventListener('focus', () => field.select());
    field.addEventListener('keydown', (e) => e.stopPropagation());
    return h(
      'div',
      { class: 'ui-ship__path' },
      h('p', { class: 'ui-rename__hint', text: tr('VS Code (comando code) não encontrado: copie o caminho') }),
      field,
      h('button', { class: 'ui-btn ui-perm__btn', type: 'button', on: { click: () => { field.select(); void navigator.clipboard?.writeText(path).catch(() => undefined); } } }, tr('Copiar')),
    );
  }

  private card(run: ChatRun): HTMLElement {
    const btn = (text: string, action: 'stop' | 'continue' | 'merge' | 'discard', allow = false) =>
      h('button', { class: `ui-btn ui-perm__btn${allow ? ' ui-perm__btn--allow' : ''}`, type: 'button', on: { click: () => void this.act(run, action) } }, text);
    const done = run.items.filter((i) => i.state === 'done').length;
    const w = run.isolated;
    const open = !!w && !w.merged && !w.discarded;
    const copyOpen = open && run.state !== 'running';
    const shipping = shipActive(run.ship);
    const u = this.cardUi(run.id);
    // Reinício antes do merge: o mesmo botão prepara o cartão de novo e pede o PIN para continuar.
    const canShip = copyOpen && (!shipping || run.ship?.needs === 'reapprove') && run.ship?.step !== 'deployed';
    const canMerge = copyOpen && !shipping && (!run.ship || run.ship.step === 'failed');
    // Comentar o diff: item que terminou, com a cópia aberta e nenhum item da lista rodando (a cópia é a mesma).
    const canComment = !!w && !w.merged && !w.discarded && !run.items.some((i) => i.state === 'running');
    return h(
      'li',
      { class: `ui-vboards__item ui-runs__run is-${run.state}` },
      h('span', { class: 'ui-spawn__folder-name', text: `${runLabel(run, Date.now())} · ${done}/${run.items.length} · ${ago(run.createdAt)}` }),
      h('span', { class: 'ui-spawn__folder-path', text: shortPath(run.options.folder) + (w ? ` · ${w.branch}` : '') }),
      run.note ? h('p', { class: 'ui-rename__hint is-error', text: run.note }) : null,
      h(
        'ol',
        { class: 'ui-runs__items' },
        ...run.items.map((i, index) =>
          h(
            'li',
            { class: `ui-runs__item is-${i.state}`, attrs: { title: i.summary ?? '' } },
            h('span', { class: 'ui-runs__mark', text: ITEM_MARK[i.state], attrs: { 'aria-label': itemStateLabel(i.state) } }),
            i.agentId
              ? h('button', { class: 'ui-runs__link', type: 'button', text: i.text, attrs: { title: tr('Ver o agente deste item') }, on: { click: () => this.ctx.select({ type: 'agent', id: i.agentId! }, { focus: true }) } })
              : h('span', { class: 'ui-runs__text', text: i.text }),
            i.summary ? h('span', { class: 'ui-runs__summary-text', text: i.summary }) : null,
            i.shots?.length
              ? h(
                  'span',
                  { class: 'ui-runs__shots' },
                  ...i.shots.map((n) =>
                    h(
                      'a',
                      { class: 'ui-runs__shot', attrs: { href: `/api/chat/runs/${encodeURIComponent(run.id)}/items/${index}/shots/${encodeURIComponent(n)}`, target: '_blank', rel: 'noopener', title: n } },
                      h('img', { attrs: { src: `/api/chat/runs/${encodeURIComponent(run.id)}/items/${index}/shots/${encodeURIComponent(n)}`, alt: tr('Captura do QA visual: {0}', [n]), loading: 'lazy' } }),
                    ),
                  ),
                )
              : null,
            canComment && i.agentId && (i.state === 'review' || i.state === 'done')
              ? h('button', { class: 'ui-runs__link ui-runs__comment', type: 'button', text: tr('Ver o diff e comentar'), on: { click: () => void this.diff.open(run.id, index, i.text) } })
              : null,
          ),
        ),
      ),
      h(
        'div',
        { class: 'ui-vboards__actions' },
        run.state === 'paused' || run.state === 'failed' ? btn(tr('Continuar'), 'continue', true) : null,
        run.state === 'running' || run.state === 'queued' || run.state === 'paused' || run.state === 'failed' ? btn(tr('Parar'), 'stop') : null,
        canShip && !u.preview
          ? h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', attrs: { disabled: u.loading }, on: { click: () => void this.prepareShip(run) } }, u.loading ? tr('Preparando…') : run.ship?.needs === 'reapprove' ? tr('Aprovar de novo') : tr('Subir'))
          : null,
        canMerge ? btn(tr('Juntar'), 'merge', true) : null,
        copyOpen && !shipping ? btn(tr('Descartar'), 'discard') : null,
        open ? h('button', { class: 'ui-btn ui-perm__btn', type: 'button', on: { click: () => void this.openVscode(run) } }, tr('Abrir no VS Code')) : null,
      ),
      u.vscodePath ? this.vscodeFallback(u.vscodePath) : null,
      canShip && u.preview ? this.shipConfirm(run, u.preview) : null,
      run.ship ? this.shipProgress(run, run.ship) : null,
      !run.ship && run.autoShip?.blocked ? h('p', { class: 'ui-rename__hint', text: tr('Não subiu sozinho: {0}', [run.autoShip.blocked]) }) : null,
    );
  }
}
