// Campos de abrir agente pelo chat (agente + "Mais opções": conta, modelo, papel, permissão, cópia isolada, limites e
// nome), usados pela janela de Novo agente (ui/spawn.ts) e pela lista (ui/runs.ts). Opções do servidor em
// GET /api/chat/options.
import { tr } from '../../../shared/i18n';
import type { Provider } from '../../../shared/types';
import { askDisabledReason, defaultForm, providerLabel, type OpenForm } from './spawn-model';
import { h, setHidden } from './dom';

export interface ChatProviderOption { id: Provider; available: boolean; reason?: string; ask: boolean }
export interface ChatAccountOption { id: string; provider: Provider; short?: string }
export interface ChatOptionsData {
  providers: ChatProviderOption[];
  roles: Array<{ id: string; name: string }>;
  folders: Array<{ path: string; name?: string }>;
  accounts: ChatAccountOption[];
}

let groups = 0;

export class ChatOptionsFields {
  readonly el: HTMLElement;
  data?: ChatOptionsData;
  private readonly provider: HTMLSelectElement;
  private readonly account: HTMLSelectElement;
  private readonly model: HTMLInputElement;
  private readonly role: HTMLSelectElement;
  private readonly permAuto: HTMLInputElement;
  private readonly permAsk: HTMLInputElement;
  private readonly isolated: HTMLInputElement;
  private readonly limitUsd: HTMLInputElement;
  private readonly limitTokens: HTMLInputElement;
  private readonly limitMinutes: HTMLInputElement;
  private readonly agentName: HTMLInputElement;

  /** `list`: na lista o nome é sorteado por item, a cópia isolada é uma só e os limites valem por item. */
  constructor(list = false) {
    const field = (label: string, control: HTMLElement) => h('label', { class: 'ui-spawn__field' }, h('span', { text: label }), control);
    const input = (type: string, attrs: Record<string, string> = {}) => {
      const el = h('input', { class: 'ui-rename__input', type, attrs }) as HTMLInputElement;
      el.addEventListener('keydown', (e) => e.stopPropagation());
      el.addEventListener('keyup', (e) => e.stopPropagation());
      return el;
    };
    const perm = `ui-chat-perm-${++groups}`;
    this.provider = h('select', { class: 'ui-rename__input', attrs: { 'aria-label': tr('Agente') }, on: { change: () => this.sync() } }) as HTMLSelectElement;
    this.account = h('select', { class: 'ui-rename__input', attrs: { 'aria-label': tr('Conta') } }) as HTMLSelectElement;
    this.model = input('text', { placeholder: tr('padrão da ferramenta'), spellcheck: 'false' });
    this.role = h('select', { class: 'ui-rename__input', attrs: { 'aria-label': tr('Papel') } }) as HTMLSelectElement;
    this.permAuto = input('radio', { name: perm, value: 'auto' });
    this.permAsk = input('radio', { name: perm, value: 'ask' });
    this.permAuto.checked = true;
    this.isolated = input('checkbox');
    this.limitUsd = input('text', { inputmode: 'decimal', placeholder: tr('sem limite') });
    this.limitTokens = input('text', { inputmode: 'numeric', placeholder: tr('sem limite') });
    this.limitMinutes = input('text', { inputmode: 'decimal', placeholder: tr('sem limite') });
    this.agentName = input('text', { maxlength: '40', placeholder: tr('sorteado') });
    const name = field(tr('Nome do personagem'), this.agentName);
    setHidden(name, list);
    this.el = h(
      'div',
      { class: 'ui-spawn__chat' },
      field(tr('Agente'), this.provider),
      h(
        'details',
        { class: 'ui-spawn__more' },
        h('summary', { text: tr('Mais opções') }),
        field(tr('Conta'), this.account),
        field(tr('Modelo'), this.model),
        field(tr('Papel'), this.role),
        h(
          'fieldset',
          { class: 'ui-spawn__perm' },
          h('legend', { text: tr('Permissões') }),
          h('label', {}, this.permAuto, h('span', { text: tr('Automático (faz tudo sozinho)') })),
          h('label', {}, this.permAsk, h('span', { text: tr('Pedir aprovação a cada ação') })),
        ),
        h('label', { class: 'ui-spawn__check' }, this.isolated, h('span', { text: list ? tr('Cópia isolada (um git worktree para a lista toda)') : tr('Cópia isolada (git worktree, num branch próprio)') })),
        field(list ? tr('Limite de custo por item (US$)') : tr('Limite de custo (US$)'), this.limitUsd),
        field(list ? tr('Limite de tokens por item') : tr('Limite de tokens'), this.limitTokens),
        field(tr('Limite por rodada (minutos)'), this.limitMinutes),
        name,
      ),
    );
  }

  /** Busca as opções do servidor e preenche os campos; undefined = chat indisponível. */
  async load(): Promise<ChatOptionsData | undefined> {
    try {
      const res = await fetch('/api/chat/options', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return undefined;
      const o = (await res.json()) as ChatOptionsData;
      this.data = o;
      const keep = this.provider.value;
      const keepRole = this.role.value;
      this.provider.replaceChildren(
        ...o.providers.map((p) =>
          h('option', {
            attrs: { value: p.id, ...(p.available ? {} : { disabled: 'true', title: p.reason ?? '' }) },
            text: p.available ? providerLabel(p.id) : `${providerLabel(p.id)} (${p.reason ?? tr('indisponível')})`,
          }),
        ),
      );
      this.provider.value = o.providers.some((p) => p.id === keep && p.available) ? keep : defaultForm('', o.providers).provider;
      this.role.replaceChildren(h('option', { attrs: { value: '' }, text: tr('Sem papel') }), ...o.roles.map((r) => h('option', { attrs: { value: r.id }, text: r.name })));
      if (o.roles.some((r) => r.id === keepRole)) this.role.value = keepRole;
      this.sync();
      return o;
    } catch {
      return undefined;
    }
  }

  form(folder: string, prompt: string): OpenForm {
    return {
      ...defaultForm(folder, this.data?.providers ?? []),
      provider: this.provider.value as Provider,
      ...(this.account.value ? { account: this.account.value } : {}),
      model: this.model.value,
      roleId: this.role.value,
      permission: this.permAsk.checked ? 'ask' : 'auto',
      isolated: this.isolated.checked,
      limitUsd: this.limitUsd.value,
      limitTokens: this.limitTokens.value,
      limitMinutes: this.limitMinutes.value,
      name: this.agentName.value,
      prompt,
    };
  }

  roleName(id: string | undefined): string {
    return (id && this.data?.roles.find((r) => r.id === id)?.name) || '';
  }

  /** Conta e aprovação conforme o agente escolhido (só o Claude pede aprovação ação por ação). */
  private sync(): void {
    const provider = this.provider.value as Provider;
    const accounts = this.data?.accounts ?? [];
    this.account.replaceChildren(
      h('option', { attrs: { value: '' }, text: tr('Conta padrão') }),
      ...accounts.filter((a) => a.provider === provider).map((a) => h('option', { attrs: { value: a.id }, text: a.short ?? a.id })),
    );
    const why = askDisabledReason(provider);
    this.permAsk.disabled = !!why;
    this.permAsk.parentElement?.setAttribute('title', why ?? '');
    if (why) this.permAuto.checked = true;
    setHidden(this.limitUsd.parentElement as HTMLElement, provider !== 'claude');
    setHidden(this.limitTokens.parentElement as HTMLElement, provider === 'claude');
  }
}
