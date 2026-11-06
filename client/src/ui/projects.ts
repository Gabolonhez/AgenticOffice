// Assistente "Novo projeto" (server/projects): ideia → perguntas → revisão da spec → checklist dos passos → Criar com o
// PIN. A criação roda no servidor e é retomável: reabrir o assistente mostra onde parou, e "Criar" de novo tenta o que
// falta. Ao terminar, o agente contratado abre a sala nova no escritório. Só pelo próprio computador, com o chat ligado.
import { tr } from '../../../shared/i18n';
import { access } from '../net/access';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';

type Role = 'app' | 'server' | 'web';
type StepStatus = 'pending' | 'running' | 'done' | 'manual' | 'skipped' | 'failed';
interface Step { id: string; status: StepStatus; note?: string }
interface State { slug: string; name: string; root: string; repos: Array<{ role: Role; path: string }>; options: { github: boolean; githubOwner?: string; vboards: boolean; agent: boolean }; steps: Step[]; running?: boolean }
interface Draft { slug: string; name: string; state?: State }
type View = 'idea' | 'questions' | 'spec' | 'create';

const POLL_MS = 1_500;

/** Prédio com um +: projeto novo. */
const ICON =
  '<svg class="ui-px-icon" width="20" height="20" viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M1 3h5v7H1zM2 4h1v1H2zM4 4h1v1H4zM2 6h1v1H2zM4 6h1v1H4zM3 8h1v2H3zM7 0h1v5H7zM5.5 2h4v1h-4z"/></svg>';

export const STEP_LABELS = (): Record<string, string> => ({
  copy: tr('Copiar o molde'),
  personalize: tr('Personalizar nome, bundle id e cores'),
  ci: tr('CI de pull request e eas.json'),
  deploy: tr('Configurar o deploy (secrets e host próprios)'),
  git: tr('git init e commit inicial'),
  github: tr('Repositórios privados no GitHub'),
  register: tr('Registrar o produto e as chaves vboards.*'),
  vboards: tr('Card do produto no VBoards'),
  agent: tr('Contratar um agente (sala nova)'),
});

export const STATUS_LABELS = (): Record<StepStatus, string> => ({
  pending: tr('pendente'),
  running: tr('rodando…'),
  done: tr('feito'),
  manual: tr('manual'),
  skipped: tr('pulado'),
  failed: tr('falhou'),
});

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T & { error?: string }> {
  let res: Response;
  try {
    res = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  } catch {
    throw new Error(tr('o Habblaud não respondeu'));
  }
  const out = (await res.json().catch(() => ({}))) as T & { error?: string; errors?: string[] };
  if (!res.ok && !out.errors?.length) throw new Error(out.error ?? tr('erro {0}', [res.status]));
  return out;
}

const stop = (el: HTMLElement) => {
  el.addEventListener('keydown', (e) => e.stopPropagation());
  el.addEventListener('keyup', (e) => e.stopPropagation());
  return el;
};
const input = (type: string, attrs: Record<string, string> = {}) => stop(h('input', { class: 'ui-rename__input', type, attrs })) as HTMLInputElement;
const field = (label: string, control: HTMLElement, hint?: string) => h('label', { class: 'ui-spawn__field' }, h('span', { text: label }), control, ...(hint ? [h('small', { class: 'ui-proj__hint', text: hint })] : []));
const check = (box: HTMLInputElement, text: string) => h('label', { class: 'ui-spawn__check' }, box, h('span', { text }));

export class ProjectWizard implements UiComponent {
  readonly button: HTMLButtonElement;
  readonly el: HTMLElement;
  private view: View = 'idea';
  private slug = '';
  private state?: State;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private readonly status = h('p', { class: 'ui-rename__hint ui-spawn__status', attrs: { role: 'status', 'aria-live': 'polite' } });
  private readonly stepper: HTMLElement;
  private readonly views: Record<View, HTMLElement>;
  // ideia
  private readonly idea = stop(h('textarea', { class: 'ui-rename__input ui-spawn__prompt', attrs: { rows: 4, maxlength: '2000', placeholder: tr('Ex.: um app que ajuda quem treina em casa a montar a série do dia e acompanhar a evolução.') } })) as HTMLTextAreaElement;
  private readonly drafts = h('ul', { class: 'ui-proj__drafts' });
  // perguntas
  private readonly name = input('text', { maxlength: '40', placeholder: tr('Ex.: Treino Pro') });
  private readonly audience = input('text', { maxlength: '300' });
  private readonly monetization = input('text', { maxlength: '300', placeholder: tr('assinatura com paywall (Superwall)') });
  private readonly parts: Record<Role, HTMLInputElement> = { app: input('checkbox'), server: input('checkbox'), web: input('checkbox') };
  private readonly bundleId = input('text', { maxlength: '100', spellcheck: 'false', placeholder: 'com.empresa.app' });
  private readonly primary = input('color');
  private readonly useSecondary = input('checkbox');
  private readonly secondary = input('color');
  private readonly errors = h('ul', { class: 'ui-proj__errors', attrs: { role: 'alert' } });
  // spec
  private readonly spec = stop(h('textarea', { class: 'ui-rename__input ui-proj__spec', attrs: { rows: 16, spellcheck: 'false', 'aria-label': tr('Spec do projeto (Markdown)') } })) as HTMLTextAreaElement;
  // criar
  private readonly where = h('p', { class: 'ui-proj__where' });
  private readonly github = input('checkbox');
  private readonly owner = input('text', { maxlength: '39', spellcheck: 'false', placeholder: tr('usuário ou organização') });
  private readonly vboards = input('checkbox');
  private readonly agent = input('checkbox');
  private readonly steps = h('ol', { class: 'ui-proj__steps' });
  private readonly pin = input('password', { autocomplete: 'off', placeholder: tr('PIN de aprovação') });
  private readonly createBtn: HTMLButtonElement;
  private bundleTouched = false;

  constructor(private readonly ctx: UiContext) {
    this.button = iconButton(ICON, tr('Novo projeto: do molde app-base a uma sala nova no escritório'), () => this.toggle());
    this.button.setAttribute('aria-haspopup', 'dialog');
    const primaryBtn = (text: string, click: () => void) => h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', on: { click } }, text);
    const back = (to: View) => h('button', { class: 'ui-btn ui-perm__btn', type: 'button', on: { click: () => this.show(to) } }, tr('Voltar'));

    this.parts.app.checked = this.parts.server.checked = true;
    this.primary.value = '#4F46E5';
    this.secondary.value = '#16A34A';
    this.vboards.checked = this.agent.checked = true;
    this.name.addEventListener('input', () => {
      if (!this.bundleTouched) this.bundleId.value = this.suggestBundle();
    });
    this.bundleId.addEventListener('input', () => (this.bundleTouched = true));
    this.useSecondary.addEventListener('change', () => setHidden(this.secondary, !this.useSecondary.checked));
    setHidden(this.secondary, true);
    this.github.addEventListener('change', () => setHidden(this.owner, !this.github.checked));
    this.createBtn = primaryBtn(tr('Criar com o PIN'), () => void this.create());

    const roleNames: Record<Role, string> = { app: tr('app (Expo)'), server: tr('server (API)'), web: tr('web (site)') };
    this.views = {
      idea: h(
        'div',
        { class: 'ui-runs__view' },
        h('p', { class: 'ui-proj__lead', text: tr('Conte a ideia. O Habblaud faz as perguntas do briefing, escreve a spec e cria os repositórios a partir do molde, já no pipeline.') }),
        field(tr('Ideia'), this.idea),
        h('div', { class: 'ui-vboards__actions' }, primaryBtn(tr('Continuar'), () => this.toQuestions())),
        this.drafts,
      ),
      questions: h(
        'div',
        { class: 'ui-runs__view' },
        field(tr('Nome do produto'), this.name),
        field(tr('Público'), this.audience, tr('Para quem é o app?')),
        field(tr('Monetização'), this.monetization),
        h('fieldset', { class: 'ui-proj__parts' }, h('legend', { text: tr('Partes do molde') }), ...(Object.keys(this.parts) as Role[]).map((r) => check(this.parts[r], roleNames[r]))),
        field(tr('Bundle id (iOS) e package (Android)'), this.bundleId),
        h('div', { class: 'ui-proj__colors' }, field(tr('Cor principal'), this.primary), h('div', { class: 'ui-spawn__field' }, check(this.useSecondary, tr('Cor secundária')), this.secondary)),
        this.errors,
        h('div', { class: 'ui-vboards__actions' }, primaryBtn(tr('Gerar a spec'), () => void this.draft()), back('idea')),
      ),
      spec: h(
        'div',
        { class: 'ui-runs__view' },
        h('p', { class: 'ui-proj__lead', text: tr('Revise a spec e o plano. Os itens de "Cards iniciais" viram as subtarefas do card no VBoards.') }),
        this.spec,
        h('div', { class: 'ui-vboards__actions' }, primaryBtn(tr('Salvar e continuar'), () => void this.saveSpec()), back('questions')),
      ),
      create: h(
        'div',
        { class: 'ui-runs__view' },
        this.where,
        h('fieldset', { class: 'ui-proj__parts' }, h('legend', { text: tr('Opcional') }), check(this.github, tr('Criar repositórios privados no GitHub (sem push)')), this.owner, check(this.vboards, tr('Card do produto no VBoards com os cards iniciais')), check(this.agent, tr('Contratar um agente: a sala nova aparece no escritório'))),
        h('p', { class: 'ui-spawn__label', text: tr('Passos') }),
        this.steps,
        h('p', { class: 'ui-proj__hint', text: tr('Nada é enviado nem publicado: sem push, sem deploy, sem projeto no EAS. Criar pede o PIN de aprovação; rodar de novo retoma o que falta.') }),
        field(tr('PIN de aprovação'), this.pin),
        h('div', { class: 'ui-vboards__actions' }, this.createBtn, back('spec')),
      ),
    };
    const labels: Array<[View, string]> = [
      ['idea', tr('Ideia')],
      ['questions', tr('Perguntas')],
      ['spec', tr('Spec')],
      ['create', tr('Criar')],
    ];
    this.stepper = h('ol', { class: 'ui-proj__stepper', attrs: { 'aria-label': tr('Etapas') } }, ...labels.map(([v, text], i) => h('li', { attrs: { 'data-view': v } }, h('span', { class: 'ui-proj__num', text: String(i + 1) }), h('span', { text }))));
    this.el = h(
      'div',
      { class: 'ui-popover ui-spawn ui-proj', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': tr('Novo projeto'), id: 'ui-projects', popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, h('h2', { text: tr('Novo projeto') }), iconButton(ICONS.close, tr('Fechar'), () => this.hide(), 'ui-icon-btn--sm')),
      h('div', { class: 'ui-set-group ui-spawn__body' }, this.stepper, ...Object.values(this.views), this.status),
    );
    this.el.addEventListener('toggle', () => {
      this.button.setAttribute('aria-expanded', String(this.isOpen));
      if (!this.isOpen) this.stopPolling();
    });
    this.show('idea');
  }

  render(): void {
    setHidden(this.button, !access().chat || !access().local || this.ctx.store.mock || this.ctx.store.replaying);
  }

  get isOpen(): boolean {
    try {
      return this.el.matches(':popover-open');
    } catch {
      return this.el.classList.contains('is-open');
    }
  }

  toggle(): void {
    if (this.isOpen) return this.hide();
    const r = this.button.getBoundingClientRect();
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    this.el.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 4))}px`;
    if (typeof this.el.showPopover === 'function') this.el.showPopover();
    else this.el.classList.add('is-open');
    this.button.setAttribute('aria-expanded', 'true');
    void this.loadDrafts();
    if (this.view === 'create' && this.state?.running) this.poll();
  }

  hide(): void {
    this.stopPolling();
    if (typeof this.el.hidePopover === 'function' && this.isOpen) this.el.hidePopover();
    this.el.classList.remove('is-open');
    this.button.setAttribute('aria-expanded', 'false');
  }

  private say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
  }

  private show(v: View): void {
    this.view = v;
    for (const [k, el] of Object.entries(this.views)) setHidden(el, k !== v);
    const order: View[] = ['idea', 'questions', 'spec', 'create'];
    for (const li of this.stepper.querySelectorAll('li')) {
      const i = order.indexOf(li.getAttribute('data-view') as View);
      li.classList.toggle('is-current', i === order.indexOf(v));
      li.classList.toggle('is-past', i < order.indexOf(v));
      if (i === order.indexOf(v)) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    }
    this.say('');
  }

  private suggestBundle(): string {
    const s = this.name.value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .replace(/^[0-9]+/, '');
    return s ? `com.example.${s}` : '';
  }

  private async loadDrafts(): Promise<void> {
    try {
      const r = await api<{ projects: Draft[]; defaults: { githubOwner?: string } }>('/api/projects');
      if (r.defaults.githubOwner && !this.owner.value) this.owner.value = r.defaults.githubOwner;
      const items = r.projects.map((p) => {
        const done = p.state?.steps.filter((s) => s.status === 'done').length ?? 0;
        const total = p.state?.steps.length ?? 0;
        const label = p.state ? tr('{0} — {1} de {2} passos', [p.name, done, total]) : tr('{0} — spec pronta', [p.name]);
        return h('li', {}, h('button', { class: 'ui-btn ui-perm__btn', type: 'button', on: { click: () => void this.open(p.slug) } }, label));
      });
      this.drafts.replaceChildren(...(items.length ? [h('li', { class: 'ui-spawn__label', text: tr('Retomar') }), ...items] : []));
    } catch {
      this.drafts.replaceChildren();
    }
  }

  private async open(slug: string): Promise<void> {
    try {
      const r = await api<{ spec: string; state: State }>(`/api/projects/${encodeURIComponent(slug)}`);
      this.slug = slug;
      this.spec.value = r.spec;
      this.applyState(r.state);
      this.show(r.state.steps.some((s) => s.status !== 'pending') ? 'create' : 'spec');
      if (r.state.running) this.poll();
    } catch (err) {
      this.say((err as Error).message, true);
    }
  }

  private toQuestions(): void {
    if (!this.idea.value.trim()) return this.say(tr('Escreva a ideia primeiro.'), true);
    this.show('questions');
    this.name.focus();
  }

  private async draft(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say(tr('Escrevendo a spec…'));
    try {
      const r = await api<{ slug?: string; spec?: string; questions?: Array<{ question: string }>; errors?: string[] }>('/api/projects/draft', 'POST', {
        idea: this.idea.value,
        name: this.name.value,
        audience: this.audience.value,
        monetization: this.monetization.value || this.monetization.placeholder,
        parts: (Object.keys(this.parts) as Role[]).filter((k) => this.parts[k].checked),
        bundleId: this.bundleId.value,
        primaryColor: this.primary.value,
        ...(this.useSecondary.checked ? { secondaryColor: this.secondary.value } : {}),
      });
      if (r.slug && r.spec) {
        this.slug = r.slug;
        this.spec.value = r.spec;
        this.errors.replaceChildren();
        this.show('spec');
      } else {
        this.errors.replaceChildren(...[...(r.errors ?? []), ...(r.questions ?? []).map((q) => q.question)].map((t) => h('li', { text: t })));
        this.say('');
      }
    } catch (err) {
      this.say((err as Error).message, true);
    } finally {
      this.busy = false;
    }
  }

  private async saveSpec(): Promise<void> {
    try {
      await api(`/api/projects/${encodeURIComponent(this.slug)}/spec`, 'POST', { spec: this.spec.value });
      const r = await api<{ state: State }>(`/api/projects/${encodeURIComponent(this.slug)}`);
      this.applyState(r.state);
      this.show('create');
    } catch (err) {
      this.say((err as Error).message, true);
    }
  }

  private applyState(st: State): void {
    const wasRunning = this.state?.running && this.state.slug === st.slug;
    this.state = st;
    if (st.steps.some((s) => s.status !== 'pending')) {
      this.github.checked = st.options.github;
      if (st.options.githubOwner) this.owner.value = st.options.githubOwner;
      this.vboards.checked = st.options.vboards;
      this.agent.checked = st.options.agent;
    }
    setHidden(this.owner, !this.github.checked);
    setText(this.where, st.repos.length ? tr('{0} em {1}', [st.name, st.repos.map((r) => r.path).join(', ')]) : st.name);
    const labels = STEP_LABELS();
    const statuses = STATUS_LABELS();
    this.steps.replaceChildren(
      ...st.steps.map((s) =>
        h(
          'li',
          { class: `ui-proj__step is-${s.status}` },
          h('span', { class: 'ui-proj__chip', text: statuses[s.status] ?? s.status }),
          h('span', { class: 'ui-proj__label', text: labels[s.id] ?? s.id }),
          ...(s.note ? [h('pre', { class: 'ui-proj__note', text: s.note })] : []),
        ),
      ),
    );
    const finished = st.steps.every((s) => s.status === 'done' || s.status === 'skipped');
    this.createBtn.disabled = !!st.running || finished;
    setText(this.createBtn, st.steps.some((s) => s.status !== 'pending') ? tr('Retomar com o PIN') : tr('Criar com o PIN'));
    if (wasRunning && !st.running) {
      const failed = st.steps.find((s) => s.status === 'failed');
      const manual = st.steps.filter((s) => s.status === 'manual').length;
      const msg = failed ? tr('Parou em "{0}": veja a nota e tente de novo.', [labels[failed.id] ?? failed.id]) : manual ? tr('Projeto criado; {0} passo(s) ficaram manuais.', [manual]) : tr('Projeto {0} criado.', [st.name]);
      this.say(msg, !!failed);
      this.ctx.announce(msg);
    }
  }

  private async create(): Promise<void> {
    if (this.busy) return;
    if (!this.pin.value) return this.say(tr('Digite o PIN de aprovação.'), true);
    this.busy = true;
    this.say(tr('Criando…'));
    try {
      const r = await api<{ state: State }>(`/api/projects/${encodeURIComponent(this.slug)}/create`, 'POST', {
        pin: this.pin.value,
        options: { github: this.github.checked, githubOwner: this.owner.value.trim(), vboards: this.vboards.checked, agent: this.agent.checked },
      });
      this.pin.value = '';
      this.applyState(r.state);
      this.poll();
    } catch (err) {
      this.say((err as Error).message, true);
    } finally {
      this.busy = false;
    }
  }

  private poll(): void {
    this.stopPolling();
    this.timer = setInterval(() => {
      void api<{ state: State }>(`/api/projects/${encodeURIComponent(this.slug)}`).then(
        (r) => {
          this.applyState(r.state);
          if (!r.state.running) this.stopPolling();
        },
        () => this.stopPolling(),
      );
    }, POLL_MS);
  }

  private stopPolling(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
