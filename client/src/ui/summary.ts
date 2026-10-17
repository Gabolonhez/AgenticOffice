// Resumo do dia: botão na barra do topo (ao lado do "Meu dia") e painel com "Feito hoje" e "Em andamento agora" por
// projeto (POST /api/summary/day, server/summary). "Gerar resumo" pede a escrita da IA; "Lista simples" é o digest sem
// IA. Só aparece onde o chat está liberado (o servidor roda um turno do Claude).
import { tr } from '../../../shared/i18n';
import type { DaySummary } from '../../../shared/summary';
import { access } from '../net/access';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { summaryFooter } from './summary-model';

const ICON =
  '<svg class="ui-px-icon" width="20" height="20" viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M1 1h8v1H1zM1 4h8v1H1zM1 7h5v1H1z"/></svg>';

export class SummaryPanel implements UiComponent {
  readonly button: HTMLButtonElement;
  readonly el: HTMLElement;
  private readonly body = h('pre', { class: 'ui-rename__hint', style: 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:360px;overflow-y:auto;margin:0' });
  private readonly foot = h('p', { class: 'ui-rename__hint', attrs: { role: 'status', 'aria-live': 'polite' } });
  private readonly copyBtn: HTMLButtonElement;
  private busy = false;
  private text = '';

  constructor(private readonly ctx: UiContext) {
    this.button = iconButton(ICON, tr('Resumo do dia: o que foi feito e o que está em andamento'), () => this.toggle());
    this.button.setAttribute('aria-haspopup', 'dialog');
    const gen = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', on: { click: () => void this.run('ai') } }, tr('Gerar resumo'));
    this.copyBtn = h('button', { class: 'ui-btn ui-perm__btn', type: 'button', on: { click: () => void this.copy() } }, tr('Copiar'));
    const list = h('button', { class: 'ui-btn ui-perm__btn', type: 'button', on: { click: () => void this.run('list') } }, tr('Lista simples'));
    this.el = h(
      'div',
      { class: 'ui-popover ui-spawn', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': tr('Resumo do dia'), id: 'ui-summary', popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, h('h2', { text: tr('Resumo do dia') }), iconButton(ICONS.close, tr('Fechar'), () => this.hide(), 'ui-icon-btn--sm')),
      h('div', { class: 'ui-set-group ui-spawn__body' }, this.body, h('div', { class: 'ui-vboards__actions' }, gen, this.copyBtn, list), this.foot),
    );
    this.show(undefined);
  }

  private get usable(): boolean {
    return !!access().chat && !this.ctx.store.mock && !this.ctx.store.replaying;
  }

  render(): void {
    setHidden(this.button, !this.usable);
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
    this.el.style.left = `${Math.max(8, Math.min(Math.round(r.left), innerWidth - 400))}px`;
    if (typeof this.el.showPopover === 'function') this.el.showPopover();
    else this.el.classList.add('is-open');
    this.button.setAttribute('aria-expanded', 'true');
    if (!this.text) void this.fetchLast();
  }

  private hide(): void {
    if (typeof this.el.hidePopover === 'function' && this.isOpen) this.el.hidePopover();
    this.el.classList.remove('is-open');
    this.button.setAttribute('aria-expanded', 'false');
  }

  private show(s: DaySummary | undefined): void {
    this.text = s?.text ?? '';
    setText(this.body, this.text || tr('Clique em "Gerar resumo" para a IA escrever o dia, ou em "Lista simples".'));
    setText(this.foot, s ? summaryFooter(s) : '');
    this.copyBtn.disabled = !this.text;
  }

  /** Último resumo da IA gerado hoje no servidor (GET), se houver. */
  private async fetchLast(): Promise<void> {
    try {
      const res = await fetch('/api/summary/day', { credentials: 'same-origin', cache: 'no-store' });
      const s = (await res.json()) as Partial<DaySummary>;
      if (res.ok && typeof s.text === 'string' && typeof s.generatedAt === 'number' && !this.busy && !this.text) this.show(s as DaySummary);
    } catch {
      // sem resumo guardado
    }
  }

  private async run(mode: 'ai' | 'list'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    setText(this.foot, mode === 'ai' ? tr('A IA está escrevendo o resumo…') : tr('Montando a lista…'));
    try {
      const res = await fetch('/api/summary/day', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
      const body = (await res.json()) as DaySummary & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      this.show(body);
    } catch (err) {
      setText(this.foot, tr('Não foi possível gerar o resumo: {0}', [err instanceof Error ? err.message : String(err)]));
    } finally {
      this.busy = false;
    }
  }

  private async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.text);
      this.ctx.announce(tr('Resumo copiado.'));
    } catch {
      this.ctx.announce(tr('Não foi possível copiar.'));
    }
  }
}
