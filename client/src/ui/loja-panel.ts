// Painel "Loja" de uma pasta (Configurações › VBoards): último OTA, build e envio à loja com o link da execução, e o
// botão "Preparar versão" (release_cut): versão proposta, tarefas, texto da novidade em pt/en/es e o pedido de revisão,
// que só sai com o PIN. OTA em production e build também pedem o PIN. O texto vem de títulos de PR: vai como texto puro.
import { tr } from '../../../shared/i18n';
import { h, setHidden } from './dom';

type Kind = 'ota' | 'build' | 'submit';
interface Ev { id: string; kind: Kind; channel: string; version?: string; state: 'pending' | 'running' | 'success' | 'failed'; requestedAt: number; endedAt?: number; url?: string; note?: string }
interface Cut { version: string; lastVersion?: string; items: Array<{ title: string }>; notes: { pt: string; en: string; es: string }; translated: boolean }

const STATE: Record<Ev['state'], () => string> = { pending: () => tr('espera o PIN'), running: () => tr('rodando'), success: () => tr('concluído'), failed: () => tr('falhou') };
const KIND: Record<Kind, () => string> = { ota: () => tr('Atualização OTA'), build: () => tr('Build da loja'), submit: () => tr('Envio para revisão') };

async function call<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error ?? tr('erro {0}', [res.status]));
  return j;
}

export class LojaPanel {
  readonly el: HTMLElement;
  private folder = '';
  private readonly rows = h('div', { class: 'ui-loja__rows' });
  private readonly cutBox = h('div', { class: 'ui-loja__cut', hidden: true });
  private readonly pin = h('input', { class: 'ui-rename__input', type: 'password', attrs: { autocomplete: 'off', maxlength: 200, placeholder: tr('PIN de aprovação'), 'aria-label': tr('PIN de aprovação') } });
  private readonly status = h('p', { class: 'ui-set__hint', attrs: { role: 'status', 'aria-live': 'polite' } });

  constructor() {
    const btn = (text: string, fn: () => void, cls = '') => h('button', { class: `ui-btn ${cls}`.trim(), type: 'button', text, on: { click: fn } });
    this.el = h(
      'div',
      { class: 'ui-loja', hidden: true },
      h('h4', { class: 'ui-loja__title', text: tr('Loja') }),
      this.rows,
      h('div', { class: 'ui-chat__row' }, btn(tr('Preparar versão'), () => void this.prepare(), 'ui-loja__primary'), btn(tr('OTA em production'), () => void this.send('ota', 'production')), btn(tr('Gerar build'), () => void this.send('build'))),
      this.cutBox,
      this.pin,
      this.status,
    );
  }

  /** Pasta escolhida: busca o status; o painel só aparece com vboards.store ligado. */
  async setFolder(folder: string, storeOn: boolean): Promise<void> {
    this.folder = folder;
    this.cutBox.hidden = true;
    setHidden(this.el, !storeOn);
    if (!storeOn) return;
    try {
      this.show((await call<{ last: Partial<Record<Kind, Ev>> }>(`/api/chat/lojas?folder=${encodeURIComponent(folder)}`)).last);
    } catch (err) {
      this.say((err as Error).message, true);
    }
  }

  private show(last: Partial<Record<Kind, Ev>>): void {
    this.rows.replaceChildren(
      ...(['ota', 'build', 'submit'] as const).map((k) => {
        const e = last[k];
        return h(
          'div',
          { class: `ui-loja__row ui-loja__row--${e?.state ?? 'none'}` },
          h('span', { class: 'ui-loja__dot', attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'ui-loja__kind', text: KIND[k]() }),
          h('span', { class: 'ui-loja__what', text: e ? [e.kind === 'ota' ? e.channel : '', e.version ?? '', STATE[e.state](), new Date(e.endedAt ?? e.requestedAt).toLocaleString()].filter(Boolean).join(' · ') : tr('ainda não') }),
          e?.url && /^https:\/\//.test(e.url) ? h('a', { class: 'ui-loja__link', attrs: { href: e.url, target: '_blank', rel: 'noopener noreferrer' }, text: tr('ver execução') }) : null,
          e?.state === 'pending' ? h('button', { class: 'ui-btn', type: 'button', text: tr('Aprovar com PIN'), on: { click: () => void this.approve(e.id) } }) : null,
          e?.state === 'failed' && e.note ? h('span', { class: 'ui-set__hint is-error', text: e.note }) : null,
        );
      }),
    );
  }

  private say(text: string, error = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('is-error', error);
  }

  private async approve(id: string): Promise<void> {
    try {
      await call('/api/chat/lojas/approve', { id, pin: this.pin.value });
      this.pin.value = '';
      this.say(tr('Aprovado: disparado.'));
      await this.setFolder(this.folder, true);
    } catch (err) {
      this.say((err as Error).message, true);
    }
  }

  private async send(kind: Kind, channel?: string, version?: string): Promise<void> {
    if (!this.pin.value) return this.say(tr('Digite o PIN de aprovação.'), true);
    try {
      await call('/api/chat/lojas/request', { folder: this.folder, kind, ...(channel ? { channel } : {}), ...(version ? { version } : {}), pin: this.pin.value });
      this.pin.value = '';
      this.say(tr('Disparado: o workflow do repo está rodando.'));
      await this.setFolder(this.folder, true);
    } catch (err) {
      this.say((err as Error).message, true);
    }
  }

  private async prepare(): Promise<void> {
    try {
      const c = await call<Cut>('/api/chat/lojas/cut', { folder: this.folder });
      const notes = (['pt', 'en', 'es'] as const).map((l) => h('details', { class: 'ui-loja__notes' }, h('summary', { text: l.toUpperCase() }), h('pre', { text: c.notes[l] })));
      this.cutBox.replaceChildren(
        h('div', { class: 'ui-loja__ver' }, h('span', { class: 'ui-loja__from', text: c.lastVersion ?? tr('nova') }), h('span', { class: 'ui-loja__arrow', text: '→' }), h('strong', { class: 'ui-loja__to', text: c.version })),
        h('p', { class: 'ui-set__hint', text: c.items.length ? tr('{0} tarefas no ar desde a última versão:', [c.items.length]) : tr('Nenhuma tarefa nova no ar desde a última versão.') }),
        h('ul', { class: 'ui-loja__items' }, ...c.items.slice(0, 20).map((i) => h('li', { text: i.title }))),
        ...(c.items.length && !c.translated ? [h('p', { class: 'ui-set__hint is-error', text: tr('Sem tradução automática: en e es estão em português. Confira antes de enviar.') })] : []),
        ...notes,
        h('p', { class: 'ui-set__hint', text: tr('Enviar para revisão da loja é público e irreversível: só sai com o PIN.') }),
        h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'button', text: tr('Enviar para revisão da loja'), on: { click: () => void this.send('submit', undefined, c.version) } }),
      );
      this.cutBox.hidden = false;
    } catch (err) {
      this.say((err as Error).message, true);
    }
  }
}
