// Configurações › VBoards por pasta (GET/POST /api/vboards/config): lê e grava o `git config --local vboards.*` da
// pasta escolhida, a única fonte (o servidor usa a mesma). Só pastas conhecidas. Pela porta do celular é só leitura:
// vboards.check é um comando de shell e vboards.auto abre agentes sozinho. Some com o VBoards desligado (404) ou sem
// acesso (403). Junto, o aviso no celular pelo ntfy (GET/POST /api/vboards/notify), global e com a mesma regra.
import { tr } from '../../../shared/i18n';
import { h, setHidden, setText } from './dom';
import { shortPath } from './spawn';

interface FolderConfig { card?: string; auto: boolean; provider: string; budget: number; check?: string; reviewer: string; reviewerModel?: string; copy?: string }

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
  private readonly copy = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 500, placeholder: '.env, apps/web/.env.local' } });
  private readonly ntfy = h('input', { class: 'ui-rename__input', type: 'url', attrs: { maxlength: 300, placeholder: 'https://ntfy.sh/<tópico>' } });
  private readonly ntfySave = h('button', { class: 'ui-btn', type: 'button', text: tr('Gravar aviso'), on: { click: () => void this.storeNtfy() } });
  private readonly ntfyStatus = h('p', { class: 'ui-set__hint', attrs: { role: 'status', 'aria-live': 'polite' } });
  private readonly ntfyGroup = h(
    'div',
    { hidden: true },
    h('h3', { text: tr('Aviso no celular (ntfy)') }),
    h('p', { class: 'ui-set__hint', text: tr('Opcional: o endereço de um tópico do ntfy (https://ntfy.sh/<tópico> ou um servidor seu). Vai só o título do card e "aguardando revisão", "plano pronto" ou "falhou"; nunca código, diff nem resumo. Quem souber o tópico lê os avisos: use um nome difícil.') }),
    row(tr('Tópico do ntfy'), this.ntfy),
    this.ntfySave,
    this.ntfyStatus,
  );
  private readonly save = h('button', { class: 'ui-btn', type: 'button', text: tr('Gravar na pasta'), on: { click: () => void this.store() } });
  private readonly status = h('p', { class: 'ui-set__hint', attrs: { role: 'status', 'aria-live': 'polite' } });
  private readonly fields = [this.card, this.auto, this.provider, this.budget, this.check, this.reviewer, this.reviewerModel, this.copy];

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
      row(tr('Copiar para a cópia isolada (vboards.copy): caminhos relativos separados por vírgula; ficam fora do Juntar'), this.copy),
      this.save,
      this.status,
      this.ntfyGroup,
    );
    void this.start();
    void this.loadNtfy();
  }

  private async loadNtfy(): Promise<void> {
    try {
      const res = await fetch('/api/vboards/notify', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { configured?: boolean; url?: string; editable?: boolean };
      this.showNtfy(body);
      setHidden(this.el, false);
      setHidden(this.ntfyGroup, false);
    } catch {
      // sem VBoards: fica escondido
    }
  }

  private showNtfy(b: { configured?: boolean; url?: string; editable?: boolean }): void {
    const editable = b.editable === true;
    this.ntfy.value = editable ? (b.url ?? '') : '';
    this.ntfy.disabled = !editable;
    setHidden(this.ntfySave, !editable);
    if (!editable) setText(this.ntfyStatus, b.configured ? tr('Ligado. Só muda pelo próprio computador.') : tr('Desligado. Só muda pelo próprio computador.'));
  }

  private async storeNtfy(): Promise<void> {
    try {
      const res = await fetch('/api/vboards/notify', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: this.ntfy.value }) });
      const body = (await res.json().catch(() => ({}))) as { configured?: boolean; url?: string; editable?: boolean; error?: string };
      if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
      this.showNtfy(body);
      setText(this.ntfyStatus, body.configured ? tr('Gravado: os avisos vão para este tópico.') : tr('Aviso no celular desligado.'));
      this.ntfyStatus.classList.remove('is-error');
    } catch (err) {
      setText(this.ntfyStatus, tr('Não gravou: {0}', [(err as Error).message]));
      this.ntfyStatus.classList.add('is-error');
    }
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
    this.copy.value = c.copy ?? '';
    for (const f of this.fields) f.disabled = !editable;
    setHidden(this.save, !editable);
    this.say(editable ? '' : tr('Só leitura pela porta do celular: mude no próprio computador.'));
  }

  private async store(): Promise<void> {
    const config = { card: this.card.value, auto: this.auto.checked, provider: this.provider.value, budget: this.budget.value, check: this.check.value, reviewer: this.reviewer.value, reviewerModel: this.reviewerModel.value, copy: this.copy.value };
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
