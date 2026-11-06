// Botão 3D/2D na barra do topo: troca o escritório 2D pelo escritório 3D (pacote importado nas Configurações) e volta
// (botão 2D ou Esc). A cena em si é montada por app.ts (Office3dHost); aqui ficam o botão, a classe `is-3d` do #ui e a
// ida e volta. Convive com a cidade: abrir uma fecha a outra.
import { tr } from '../../../../shared/i18n';
import type { UiComponent, UiContext } from '../context';
import { h, setAttr, setHidden, setText, setTitle } from '../dom';
import { ICONS } from '../icons';

/** O que a interface precisa da cena 3D (implementado em app.ts, com a cena carregada sob demanda). */
export interface Office3dHost {
  readonly open: boolean;
  show(): Promise<void>;
  hide(): void;
  zoomBy(factor: number): void;
  recenter(): void;
  /** Liga a cena à interface: clique num funcionário seleciona o agente; o estado vazio abre as configurações. */
  bind(actions: { pick(agentId: string | null): void; openSettings(): void }): void;
}

export class Office3dSwitch implements UiComponent {
  readonly button: HTMLButtonElement;
  private readonly icon: HTMLElement;
  private readonly label: HTMLElement;
  private busy = false;
  private autoOpen: boolean;

  constructor(
    private readonly ctx: UiContext,
    private readonly host: Office3dHost,
    /** Fecha a cidade, se aberta (as duas cenas não convivem). */
    private readonly beforeOpen: () => void,
    private readonly cityOpen: () => boolean,
    private readonly onChange: () => void,
  ) {
    this.icon = h('span', { class: 'ui-scene-btn__icon', attrs: { 'aria-hidden': 'true' } });
    this.label = h('span', { class: 'ui-scene-btn__label' });
    this.button = h('button', { class: 'ui-scene-btn ui-scene-btn--3d', type: 'button', hidden: true, on: { click: () => void this.toggle() } }, this.icon, this.label);
    // ?scene=3d: abre direto no 3D (capturas)
    this.autoOpen = typeof location !== 'undefined' && new URLSearchParams(location.search).get('scene') === '3d';
  }

  get is3d(): boolean {
    return this.host.open;
  }

  private available(): boolean {
    return !this.ctx.store.replaying && !this.ctx.isTimelapseOpen();
  }

  async toggle(): Promise<void> {
    if (this.host.open) this.close();
    else await this.open();
  }

  async open(): Promise<void> {
    if (this.busy || this.host.open || !this.available()) return;
    this.busy = true;
    try {
      this.beforeOpen();
      await this.host.show();
      this.ctx.announce(tr('Você está no escritório 3D. Esc volta ao escritório.'));
    } catch (err) {
      console.error('[ui] o escritório 3D não abriu', err);
      this.host.hide();
    } finally {
      this.busy = false;
      this.onChange();
    }
  }

  close(): void {
    if (!this.host.open) return;
    this.host.hide();
    this.ctx.announce(tr('De volta ao escritório.'));
    this.onChange();
  }

  render(): void {
    const ok = this.available() && !this.cityOpen();
    if (!this.available() && this.host.open) this.close();
    setHidden(this.button, !ok && !this.host.open);
    const on = this.host.open;
    this.ctx.root.classList.toggle('is-3d', on);
    this.icon.innerHTML = on ? ICONS.office : ICONS.cube;
    setText(this.label, on ? tr('2D') : tr('3D'));
    const title = on ? tr('Voltar ao escritório 2D (Esc)') : tr('Ver o escritório em 3D');
    setTitle(this.button, title);
    setAttr(this.button, 'aria-label', title);
    setAttr(this.button, 'aria-pressed', String(on));
    this.button.classList.toggle('is-city', on);
    if (this.autoOpen && ok) {
      this.autoOpen = false;
      void this.open();
    }
  }
}
