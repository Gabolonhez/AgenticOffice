// Configurações › VBoards por pasta (GET/POST /api/vboards/config): lê e grava o `git config --local vboards.*` da
// pasta escolhida, a única fonte (o servidor usa a mesma). Só pastas conhecidas. Pela porta do celular é só leitura:
// vboards.check é um comando de shell e vboards.auto abre agentes sozinho. Some com o VBoards desligado (404) ou sem
// acesso (403).
import { tr } from '../../../shared/i18n';
import { h, setHidden, setText } from './dom';
import { shortPath } from './spawn';

interface FolderConfig { card?: string; auto: boolean; provider: string; budget: number; check?: string; reviewer: string; reviewerModel?: string }

const PROVIDERS = ['claude', 'codex', 'agy'];

export class VBoardsConfigGroup {
  readonly el: HTMLElement;
  private readonly folder = h('select', { class: 'ui-rename__input', attrs: { 'aria-label': tr('Pasta do projeto') } });
  private readonly card = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 100, placeholder: tr('nome da pasta') } });
  private readonly auto = h('input', { type: 'checkbox' });
  private readonly provider = select(PROVIDERS);
  private readonly budget = h('input', { class: 'ui-rename__input', type: 'number', attrs: { min: '0.01', step: '0.5' } });
  private readonly check = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 500, placeholder: 'npm ci && npm test' } });
  private readonly reviewer = select(PROVIDERS);
  private readonly reviewerModel = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 60 } });
  private readonly save = h('button', { class: 'ui-btn', type: 'button', text: tr('Gravar na pasta'), on: { click: () => void this.store() } });
  private readonly status = h('p', { class: 'ui-set__hint', attrs: { role: 'status', 'aria-live': 'polite' } });
  private readonly fields = [this.card, this.auto, this.provider, this.budget, this.check, this.reviewer, this.reviewerModel];

  constructor() {
    this.folder.addEventListener('change', () => void this.load());
    this.el = h(
      'div',
      { class: 'ui-set-group', hidden: true },
      h('h3', { text: tr('VBoards por pasta') }),
      h('p', { class: 'ui-set__hint', text: tr('Fica no git config --local da pasta. A abertura automática vem desligada: ligada, as subtarefas da fila que só combinam com esta pasta viram uma lista numa cópia isolada, sem push, e terminam esperando a sua revisão. Juntar é sempre um clique seu.') }),
      row(tr('Pasta'), this.folder),
      row(tr('Card (vboards.card)'), this.card),
      h('label', { class: 'ui-spawn__check' }, this.auto, h('span', { text: tr('Abrir sozinho (vboards.auto)') })),
      row(tr('Agente (vboards.provider)'), this.provider),
      row(tr('Orçamento por item, US$ (vboards.budget)'), this.budget),
      row(tr('Checagens (vboards.check): a cópia não tem node_modules nem .env, então o comando instala o que precisar'), this.check),
      row(tr('Revisor (vboards.reviewer)'), this.reviewer),
      row(tr('Modelo do revisor (vboards.reviewerModel)'), this.reviewerModel),
      this.save,
      this.status,
    );
    void this.start();
  }

  private async start(): Promise<void> {
    try {
      const res = await fetch('/api/vboards/config', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { folders?: Array<{ path: string; name: string }> };
      const folders = body.folders ?? [];
      if (!folders.length) return;
      this.folder.replaceChildren(...folders.map((f) => h('option', { attrs: { value: f.path }, text: `${f.name} — ${shortPath(f.path)}` })));
      setHidden(this.el, false);
      await this.load();
    } catch {
      // sem VBoards: o grupo fica escondido
    }
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`/api/vboards/config?folder=${encodeURIComponent(this.folder.value)}`, { credentials: 'same-origin', cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { config?: FolderConfig; editable?: boolean; error?: string };
      if (!res.ok || !body.config) throw new Error(body.error ?? tr('erro {0}', [res.status]));
      this.show(body.config, body.editable === true);
    } catch (err) {
      this.say((err as Error).message, true);
    }
  }

  private show(c: FolderConfig, editable: boolean): void {
    this.card.value = c.card ?? '';
    this.auto.checked = c.auto;
    this.provider.value = c.provider;
    this.budget.value = String(c.budget);
    this.check.value = c.check ?? '';
    this.reviewer.value = c.reviewer;
    this.reviewerModel.value = c.reviewerModel ?? '';
    for (const f of this.fields) f.disabled = !editable;
    setHidden(this.save, !editable);
    this.say(editable ? '' : tr('Só leitura pela porta do celular: mude no próprio computador.'));
  }

  private async store(): Promise<void> {
    const config = { card: this.card.value, auto: this.auto.checked, provider: this.provider.value, budget: this.budget.value, check: this.check.value, reviewer: this.reviewer.value, reviewerModel: this.reviewerModel.value };
    try {
      const res = await fetch('/api/vboards/config', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: this.folder.value, config }) });
      const body = (await res.json().catch(() => ({}))) as { config?: FolderConfig; editable?: boolean; error?: string };
      if (!res.ok || !body.config) throw new Error(body.error ?? tr('erro {0}', [res.status]));
      this.show(body.config, body.editable === true);
      this.say(tr('Gravado no git config da pasta.'));
    } catch (err) {
      this.say(tr('Não gravou: {0}', [(err as Error).message]), true);
    }
  }

  private say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
  }
}

function select(values: string[]): HTMLSelectElement {
  return h('select', { class: 'ui-rename__input' }, ...values.map((v) => h('option', { attrs: { value: v }, text: v })));
}

function row(label: string, field: HTMLElement): HTMLElement {
  return h('label', { class: 'ui-set' }, h('span', { class: 'ui-set__label', text: label }), field);
}
