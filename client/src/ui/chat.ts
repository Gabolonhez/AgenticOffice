// Chat com um agente aberto pelo escritório (server/chat): a conversa, o status ao vivo, Parar, Juntar/Descartar a cópia
// isolada e o limite. Busca a conversa por GET /api/chat/agents/:id?after= só enquanto o painel está aberto nele.
import type { ChatItem, ChatState, ChatView } from '../../../shared/chat';
import { tr } from '../../../shared/i18n';
import type { AgentInfo } from '../../../shared/types';
import { afterSeq, canSendChat, chatStatusText, mergeItems, pollDelayChat, toolLine, usageText } from './chat-model';
import { enterSends } from './composer-model';
import type { UiContext } from './context';
import { h, KeyedList, setHidden, setText } from './dom';

const IDLE: ChatState = { phase: 'idle', spentUsd: 0, spentTokens: 0, limits: {} };

async function call(url: string, method: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

function itemEl(i: ChatItem): HTMLElement {
  return i.kind === 'tool' ? h('details', { class: 'ui-chat__tool' }) : h('div', { class: `ui-chat__item ui-chat__item--${i.kind}` });
}

function fillItem(el: HTMLElement, i: ChatItem): void {
  el.className = i.kind === 'tool' ? 'ui-chat__tool' : `ui-chat__item ui-chat__item--${i.kind}`;
  switch (i.kind) {
    case 'user':
      // Mensagem de outro agente (delegação aprovada pelo usuário): mostra quem mandou.
      if (i.from) {
        el.classList.add('is-from-agent');
        el.replaceChildren(h('span', { class: 'ui-chat__from', text: tr('De {0}', [i.from.name]) }), document.createTextNode(i.text));
      } else setText(el, i.text);
      return;
    case 'assistant':
      setText(el, i.text);
      return;
    case 'notice':
      el.classList.toggle('is-error', i.level === 'error');
      setText(el, i.text);
      return;
    case 'usage':
      setText(el, usageText(i));
      return;
    case 'approval': {
      const state = i.outcome === 'allow' ? tr('aprovado') : i.outcome === 'deny' ? tr('recusado') : tr('esperando você');
      setText(el, tr('Pedido de aprovação: {0} ({1})', [i.text, state]));
      return;
    }
    case 'tool': {
      const line = toolLine(i);
      el.classList.toggle('is-error', line.failed);
      el.replaceChildren(h('summary', { text: line.title }), ...(line.detail ? [h('pre', { class: 'ui-mono', text: line.detail })] : []));
      return;
    }
  }
}

export class ChatPanel {
  readonly el: HTMLElement;
  private agentId = '';
  private items: ChatItem[] = [];
  private state: ChatState = IDLE;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private gen = 0;
  private readonly list: KeyedList<ChatItem>;
  private readonly status: HTMLElement;
  private readonly box: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly mergeBtn: HTMLButtonElement;
  private readonly discardBtn: HTMLButtonElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly limitRow: HTMLElement;
  private readonly limitInput: HTMLInputElement;
  private readonly error: HTMLElement;

  constructor(private readonly ctx: UiContext) {
    const listEl = h('div', { class: 'ui-chat__list', role: 'log', attrs: { 'aria-live': 'polite' } });
    this.list = new KeyedList<ChatItem>(listEl, { key: (i) => String(i.seq), create: itemEl, update: fillItem, animate: false });
    this.status = h('p', { class: 'ui-chat__status', role: 'status' });
    this.box = h('textarea', { class: 'ui-chat__input', attrs: { rows: '2', placeholder: tr('Mensagem para o agente (Enter envia, Shift+Enter quebra a linha)') } }) as HTMLTextAreaElement;
    this.box.addEventListener('keydown', (e) => {
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
      if (enterSends(e)) {
        e.preventDefault();
        void this.send();
      }
    });
    this.sendBtn = h('button', { class: 'ui-btn ui-chat__send', type: 'button', text: tr('Enviar'), on: { click: () => void this.send() } });
    this.stopBtn = h('button', { class: 'ui-btn', type: 'button', text: tr('Parar'), on: { click: () => void this.action('stop') } });
    this.mergeBtn = h('button', { class: 'ui-btn', type: 'button', text: tr('Juntar ao projeto'), on: { click: () => void this.action('merge') } });
    this.closeBtn = h('button', { class: 'ui-btn', type: 'button', text: tr('Fechar agente'), attrs: { title: tr('Tira o agente do escritório (a conversa é apagada)') }, on: { click: () => void this.closeAgent() } });
    this.discardBtn = h('button', { class: 'ui-btn', type: 'button', text: tr('Descartar cópia'), on: { click: () => void this.discard() } });
    this.limitInput = h('input', { class: 'ui-chat__limit', attrs: { type: 'number', min: '0', step: 'any', 'aria-label': tr('Novo limite') } }) as HTMLInputElement;
    this.limitRow = h('div', { class: 'ui-chat__row' }, this.limitInput, h('button', { class: 'ui-btn', type: 'button', text: tr('Aumentar limite'), on: { click: () => void this.raiseLimit() } }));
    this.error = h('p', { class: 'ui-chat__error', role: 'alert' });
    this.el = h(
      'div',
      { class: 'ui-chat' },
      listEl,
      this.status,
      h('div', { class: 'ui-chat__row' }, this.stopBtn, this.mergeBtn, this.discardBtn, this.closeBtn),
      this.limitRow,
      // No celular a caixa fica presa no rodapé da gaveta, como a das mensagens (styles.css, .ui-chat__compose).
      h('div', { class: 'ui-chat__row ui-chat__compose' }, this.box, this.sendBtn),
      this.error,
    );
    this.paint();
  }

  open(agentId: string): void {
    if (this.agentId === agentId) return;
    this.close();
    this.agentId = agentId;
    this.items = [];
    this.state = IDLE;
    this.list.sync([]);
    setText(this.error, '');
    this.paint();
    void this.poll();
  }

  close(): void {
    this.gen++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.agentId = '';
  }

  /** O drawer chama a cada quadro; o chat se atualiza pelo próprio polling. */
  render(_agent: AgentInfo): void {}

  private url(suffix = ''): string {
    return `/api/chat/agents/${encodeURIComponent(this.agentId)}${suffix}`;
  }

  private async poll(): Promise<void> {
    const gen = this.gen;
    if (!this.agentId) return;
    try {
      const { status, data } = await call(this.url(`?after=${afterSeq(this.items, this.state)}`), 'GET');
      if (gen !== this.gen) return;
      if (status === 200) {
        const v = data as unknown as ChatView;
        this.items = mergeItems(this.items, v.items);
        this.state = v.state;
        this.paint();
      }
    } catch {
      // rede: tenta de novo no próximo ciclo
    }
    if (gen !== this.gen) return;
    this.timer = setTimeout(() => void this.poll(), pollDelayChat(this.state));
  }

  private paint(): void {
    const atBottom = this.list.container.scrollHeight - this.list.container.scrollTop - this.list.container.clientHeight < 40;
    this.list.sync(this.items);
    if (atBottom) this.list.container.scrollTop = this.list.container.scrollHeight;
    const text = chatStatusText(this.state);
    setText(this.status, text);
    setHidden(this.status, !text);
    const busy = this.state.phase !== 'idle';
    setHidden(this.stopBtn, !busy);
    const iso = this.state.isolated;
    const openCopy = !!iso && !iso.merged && !iso.discarded && !busy;
    setHidden(this.mergeBtn, !openCopy);
    setHidden(this.discardBtn, !openCopy);
    // Fecha só parado; com cópia isolada aberta, primeiro Juntar ou Descartar.
    setHidden(this.closeBtn, busy || (!!iso && !iso.merged && !iso.discarded));
    setHidden(this.limitRow, !this.state.blocked);
    this.sendBtn.disabled = busy || !!this.state.blocked;
  }

  private async send(): Promise<void> {
    const text = this.box.value;
    const ok = canSendChat(text, this.state);
    if (!ok.ok) return setText(this.error, ok.why);
    setText(this.error, '');
    const { status, data } = await call(this.url('/messages'), 'POST', { text: text.trim() });
    if (status === 202) {
      this.box.value = '';
      this.state = { ...this.state, phase: 'thinking' };
      this.paint();
      this.restartPoll();
    } else setText(this.error, String(data.error ?? tr('erro {0}', [status])));
  }

  private async action(kind: 'stop' | 'merge' | 'discard'): Promise<void> {
    const { status, data } = await call(this.url(`/${kind}`), 'POST');
    if (status >= 400) setText(this.error, String(data.error ?? tr('erro {0}', [status])));
    else setText(this.error, '');
    this.restartPoll();
  }

  /** Tira o agente do escritório (DELETE): sem isso, depois de 8 agentes não dava para abrir outro. */
  private async closeAgent(): Promise<void> {
    if (!confirm(tr('Fechar este agente? Ele sai do escritório e a conversa é apagada.'))) return;
    const { status, data } = await call(this.url(), 'DELETE', {});
    if (status >= 400) return setText(this.error, String(data.error ?? tr('erro {0}', [status])));
    this.close();
    this.ctx.select(null);
    this.ctx.invalidate();
  }

  private async discard(): Promise<void> {
    const branch = this.state.isolated?.branch ?? '';
    if (!confirm(tr('Descartar a cópia isolada e o branch {0}? O trabalho não juntado se perde.', [branch]))) return;
    await this.action('discard');
  }

  private async raiseLimit(): Promise<void> {
    const n = Number(this.limitInput.value.replace(',', '.'));
    if (!(n > 0)) return setText(this.error, tr('Informe um número maior que zero.'));
    const limits = { ...this.state.limits, ...(this.state.blocked === 'cost' ? { maxCostUsd: n } : { maxTokens: n }) };
    const { status, data } = await call(this.url('/limits'), 'PUT', limits);
    if (status >= 400) setText(this.error, String(data.error ?? tr('erro {0}', [status])));
    else {
      setText(this.error, '');
      this.limitInput.value = '';
    }
    this.restartPoll();
  }

  private restartPoll(): void {
    this.gen++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), 300);
    this.ctx.invalidate();
  }
}
