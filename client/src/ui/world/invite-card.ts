// Cartão "Conheça o Habblaud World": aparece uma vez por navegador (a chave vai para o localStorage quando ele aparece),
// só para quem ainda não tem conta, com o servidor do World configurado e a página aberta pelo próprio computador
// (nunca no celular pela porta remota). "Criar conta" abre Configurações › Habblaud World no cadastro; "Agora não" e
// "Não mostrar de novo" só fecham (ele não volta de qualquer jeito; o segundo deixa isso explícito na chave).
import { tr } from '../../../../shared/i18n';
import { access } from '../../net/access';
import type { WorldSource } from '../../net/world';
import type { UiComponent, UiContext } from '../context';
import { h, setHidden } from '../dom';
import { pixelIcon } from '../icons';
import { safeLocalStorage } from '../prefs';
import { extLink, WORLD_PRIVACY_URL } from './links';
import { INVITE_SEEN_KEY, shouldShowInvite } from './world-model';

/** Prédio em pixels (o mundo é uma cidade de prédios). */
const BUILDING = pixelIcon(
  [
    '....####....',
    '....#..#....',
    '.##########.',
    '.#.##.##.##.',
    '.##########.',
    '.#.##.##.##.',
    '.##########.',
    '.#.##.##.##.',
    '.##########.',
    '.####..####.',
    '.####..####.',
    '############',
  ],
  { '#': 'currentColor' },
  'ui-px-icon ui-world-invite__icon',
);

export interface InviteHooks {
  /** Abre Configurações › Habblaud World no cadastro. */
  openWorld(): void;
  /** Configurações aberto: o cartão some para não ficar por cima. */
  settingsOpen(): boolean;
}

export class InviteCard implements UiComponent {
  readonly el: HTMLElement;
  /** Já apareceu nesta página (sem localStorage, vale só isto). */
  private shown = false;
  private closed = false;

  constructor(
    private readonly ctx: UiContext,
    private readonly src: WorldSource,
    private readonly hooks: InviteHooks,
  ) {
    const titleId = 'ui-world-invite-title';
    const icon = h('span', { class: 'ui-world-invite__badge', attrs: { 'aria-hidden': 'true' } });
    icon.innerHTML = BUILDING;
    this.el = h(
      'section',
      { class: 'ui-world-invite', role: 'dialog', hidden: true, attrs: { 'aria-labelledby': titleId, 'aria-modal': 'false' }, on: { keydown: (ev) => this.onKey(ev) } },
      h('div', { class: 'ui-world-invite__head' }, icon, h('h2', { class: 'ui-world-invite__title', text: tr('Conheça o Habblaud World'), attrs: { id: titleId } })),
      h(
        'ul',
        { class: 'ui-world-invite__perks' },
        h('li', { text: tr('Seu escritório vira um prédio numa cidade em pixel art, aceso enquanto os seus agentes trabalham.') }),
        h('li', { text: tr('Crie um personagem, ande pela cidade e visite os prédios de outras pessoas.') }),
        h('li', { text: tr('Cumprimente quem passa e deixe likes nos prédios, sem chat e sem spam.') }),
      ),
      h(
        'p',
        { class: 'ui-world-invite__privacy' },
        tr('Nada do seu trabalho sai do computador: só o tema, quantos andares e se cada personagem está ocupado ou à toa.'),
        ' ',
        extLink(tr('Ver a lista'), WORLD_PRIVACY_URL),
      ),
      h('p', { class: 'ui-set__hint', text: tr('Nada é enviado enquanto você não criar a conta. O acesso é liberado aos poucos, por lista de espera.') }),
      h(
        'div',
        { class: 'ui-world-invite__actions' },
        h('button', { class: 'ui-btn ui-btn--primary', type: 'button', text: tr('Criar conta'), on: { click: () => this.create() } }),
        h('button', { class: 'ui-btn', type: 'button', text: tr('Agora não'), on: { click: () => this.close() } }),
        h('button', { class: 'ui-link-btn', type: 'button', text: tr('Não mostrar de novo'), on: { click: () => this.never() } }),
      ),
    );
  }

  render(): void {
    if (this.closed) return setHidden(this.el, true);
    const meta = this.src.meta();
    const a = access();
    const store = this.ctx.store;
    const gate = { remote: a.remote, local: a.local, terminal: !!store.liveSnapshot?.meta.terminal, fake: this.src.fake, replaying: store.replaying };
    if (!this.shown) {
      if (!shouldShowInvite(meta, gate, this.seen())) return setHidden(this.el, true);
      this.shown = true;
      this.remember('shown');
    }
    // Já apareceu: some se a conta foi criada por outro caminho ou com Configurações aberto por cima.
    setHidden(this.el, meta?.state !== 'logged_out' || this.hooks.settingsOpen());
  }

  private seen(): string | null {
    try {
      return safeLocalStorage()?.getItem(INVITE_SEEN_KEY) ?? null;
    } catch {
      return null;
    }
  }

  private remember(value: 'shown' | 'never'): void {
    try {
      safeLocalStorage()?.setItem(INVITE_SEEN_KEY, value);
    } catch {
      // Sem armazenamento: o cartão vale só para esta página.
    }
  }

  private close(): void {
    this.closed = true;
    setHidden(this.el, true);
    this.ctx.invalidate();
  }

  private create(): void {
    this.close();
    this.hooks.openWorld();
  }

  private never(): void {
    this.remember('never');
    this.close();
  }

  private onKey(ev: KeyboardEvent): void {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    this.close();
  }
}
