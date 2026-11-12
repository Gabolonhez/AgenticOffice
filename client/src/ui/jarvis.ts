// Jarvis em tela cheia, estilo HUD: o orb de luz no centro (um movimento por estado, jarvis-orb.ts), à esquerda o que
// ele está fazendo agora (as ferramentas e cartões da rodada), à direita as últimas falas (a resposta nova aparece no
// ritmo da voz) e os cartões de aprovação do Jarvis ali mesmo (PermissionCard: o PIN é sempre digitado no cartão). Abre
// pela barra de cima ou pela tecla J; Esc fecha, Espaço interrompe. A conversa chega pelo evento SSE "jarvis" (store),
// sem polling: cada aviso busca os itens novos por GET /api/chat/agents/:id?after=. A voz é do motor escolhido
// (jarvis-voice.ts). No modo demonstração (?mock=1) mostra uma conversa de exemplo, sem microfone nem servidor.
import type { ChatItem, ChatView } from '../../../shared/chat';
import { tr } from '../../../shared/i18n';
import type { Img } from '../net/store';
import { mergeItems } from './chat-model';
import type { UiComponent, UiContext } from './context';
import { ImageAttach } from './images';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { activityOf, historyTail, phaseLabel, stepVoice, VOICE_OFF, type ActivityIcon, type ActivityRow, type VoiceEvent, type VoiceUi } from './jarvis-model';
import { HudOrb } from './jarvis-orb';
import { createEngine, type EngineId, type VoiceEngine, type VoiceViewLite } from './jarvis-voice';
import { PermissionCard } from './permission';

const ENGINE_LABEL: Record<EngineId, string> = { realtime: 'Realtime', browser: tr('Navegador'), local: tr('Local') };
/** Ritmo da resposta nova na tela: o da fala (caracteres por segundo) enquanto ele fala, mais rápido só escrita. */
const CPS_SPEAKING = 15;
const CPS_TYPED = 55;
/** Miniaturas das imagens mandadas daqui (o servidor guarda só o nome no item da conversa). */
const THUMBS_MAX = 16;
const THUMB_PREFIX = '📎 ';

/** Ícones de traço do painel de atividade (24×24, desenhados em currentColor). */
const ACT_ICON: Record<ActivityIcon, string> = {
  web: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  open: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  agent: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  project: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  board: 'M4 4h16v16H4zM9.5 4v16M15 4v16',
  memory: 'M6 3h12v18l-6-4-6 4z',
  notify: 'M6 16v-5a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  gauge: 'M4 18a8 8 0 1 1 16 0M12 18l4-6',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
};
const STATE_ICON = { done: 'M5 12.5l4.5 4.5L19 7.5', error: 'M7 7l10 10M17 7 7 17' };

function svgIcon(d: string, cls: string): HTMLElement {
  const el = h('span', { class: cls, attrs: { 'aria-hidden': 'true' } });
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  return el;
}

function demoItems(): ChatItem[] {
  return [
    { seq: 1, at: 0, kind: 'user', text: tr('Jarvis, como está o dia?'), from: { agentId: 'voice', name: tr('voz') } },
    { seq: 2, at: 0, kind: 'assistant', text: tr('Três agentes trabalhando: dois no app e um no servidor. Uma lista espera revisão e nenhum cartão está pendente.') },
    { seq: 3, at: 0, kind: 'user', text: tr('O que falta no app?'), from: { agentId: 'voice', name: tr('voz') } },
    { seq: 4, at: 0, kind: 'tool', toolId: 'd1', name: 'mcp__habblaud__vboards_tasks_list', input: '{"product":"app"}', output: 'ok' },
    { seq: 5, at: 0, kind: 'tool', toolId: 'd2', name: 'mcp__habblaud__web_research', input: '{"question":"boas práticas de tela de assinatura"}' },
    { seq: 6, at: 0, kind: 'assistant', text: tr('Falta a tela de assinatura e o teste do pagamento. Quer que eu abra um agente para isso?') },
  ];
}

export class JarvisOverlay implements UiComponent {
  readonly el: HTMLElement;
  private open = false;
  private agentId = '';
  private items: ChatItem[] = [];
  private linesKey = '';
  private actKey = '';
  private voice: VoiceUi = VOICE_OFF;
  private engine: VoiceEngine | null = null;
  private opener: HTMLElement | null = null;
  private raf = 0;
  private level = 0;
  private fetching = false;
  private refetch = false;
  private offJarvis: (() => void) | null = null;
  private readonly reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** Respostas até este seq já estavam na tela ao abrir (ou já terminaram de aparecer): sem efeito de digitação. */
  private seenSeq = Infinity;
  private reveal: { seq: number; full: string; shown: number; el: HTMLElement | null } | null = null;
  private readonly thumbs = new Map<string, string>();

  private readonly canvas: HTMLCanvasElement;
  private readonly orb: HudOrb;
  private readonly orbBtn: HTMLButtonElement;
  private readonly stateEl: HTMLElement;
  private readonly heardEl: HTMLElement;
  private readonly saidEl: HTMLElement;
  private readonly warnEl: HTMLElement;
  private readonly chip: HTMLElement;
  private readonly history: HTMLOListElement;
  private readonly activity: HTMLOListElement;
  private readonly card: PermissionCard;
  private readonly stopBtn: HTMLButtonElement;
  private readonly input: HTMLInputElement;
  private readonly attach = new ImageAttach();
  private readonly closeBtn: HTMLButtonElement;

  constructor(private readonly ctx: UiContext) {
    this.canvas = h('canvas', { class: 'ui-jarvis__canvas', attrs: { 'aria-hidden': 'true' } });
    this.orb = new HudOrb(this.canvas);
    this.orbBtn = h('button', { class: 'ui-jarvis__orb', type: 'button', on: { click: () => this.orbClick() } }, this.canvas);
    this.stateEl = h('p', { class: 'ui-jarvis__state', role: 'status', attrs: { 'aria-live': 'polite' } });
    this.heardEl = h('p', { class: 'ui-jarvis__heard', attrs: { 'aria-live': 'polite' } });
    this.saidEl = h('p', { class: 'ui-jarvis__said' });
    this.warnEl = h('p', { class: 'ui-jarvis__warn', role: 'alert' });
    this.chip = h('span', { class: 'ui-jarvis__chip' });
    this.history = h('ol', { class: 'ui-jarvis__history', role: 'log', attrs: { 'aria-label': tr('Últimas falas') } });
    this.activity = h('ol', { class: 'ui-jarvis__acts', attrs: { 'aria-label': tr('O que o Jarvis está fazendo'), 'aria-live': 'polite' } });
    this.card = new PermissionCard(ctx);
    this.card.el.classList.add('ui-jarvis__card');
    const stopIcon = h('span', { class: 'ui-jarvis__ico', attrs: { 'aria-hidden': 'true' } });
    stopIcon.innerHTML = ICONS.stopRec;
    this.stopBtn = h('button', { class: 'ui-btn ui-jarvis__stop', type: 'button', attrs: { 'aria-keyshortcuts': 'Space' }, on: { click: () => this.interrupt() } }, stopIcon, h('span', { text: tr('Interromper') }), h('kbd', { class: 'ui-kbd', text: tr('Espaço') }));
    this.input = h('input', { class: 'ui-jarvis__input', type: 'text', attrs: { maxlength: 8000, placeholder: tr('Ou escreva para o Jarvis…'), 'aria-label': tr('Mensagem para o Jarvis') } }) as HTMLInputElement;
    const form = h('form', { class: 'ui-jarvis__form', on: { submit: (e: Event) => (e.preventDefault(), void this.sendTyped()) } }, this.input, this.attach.button, h('button', { class: 'ui-btn ui-jarvis__send', type: 'submit', text: tr('Enviar') }));
    this.input.addEventListener('paste', this.attach.onPaste);
    const drawerBtn = h('button', { class: 'ui-btn ui-jarvis__link', type: 'button', text: tr('Abrir a conversa completa'), on: { click: () => this.toDrawer() } });
    this.closeBtn = iconButton(ICONS.close, tr('Fechar (Esc)'), () => this.close(), 'ui-jarvis__close');
    const title = h('h2', { class: 'ui-jarvis__title', attrs: { id: 'ui-jarvis-title' } }, h('span', { class: 'ui-jarvis__dot', attrs: { 'aria-hidden': 'true' } }), h('span', { text: 'JARVIS' }));
    this.el = h(
      'div',
      { class: 'ui-jarvis', hidden: true, role: 'dialog', attrs: { 'aria-modal': 'true', 'aria-labelledby': 'ui-jarvis-title' }, on: { keydown: (e: Event) => this.onKey(e as KeyboardEvent) } },
      h('div', { class: 'ui-jarvis__fx', attrs: { 'aria-hidden': 'true' } }, h('div', { class: 'ui-jarvis__grid' })),
      h('header', { class: 'ui-jarvis__head' }, title, this.chip, this.closeBtn),
      h(
        'div',
        { class: 'ui-jarvis__body' },
        h('aside', { class: 'ui-jarvis__panel ui-jarvis__now' }, h('h3', { class: 'ui-jarvis__sub', text: tr('Agora') }), this.activity),
        h('section', { class: 'ui-jarvis__stage' }, this.orbBtn, this.stateEl, this.heardEl, this.saidEl, this.warnEl),
        h('aside', { class: 'ui-jarvis__panel ui-jarvis__side' }, this.card.el, h('h3', { class: 'ui-jarvis__sub', text: tr('Últimas falas') }), this.history),
      ),
      h('footer', { class: 'ui-jarvis__foot' }, this.stopBtn, form, this.attach.el, drawerBtn),
    );
    this.paintVoice();
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.close();
    else void this.show();
  }

  async show(): Promise<void> {
    if (this.open) return;
    this.open = true;
    this.seenSeq = Infinity;
    this.reveal = null;
    this.opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setHidden(this.el, false);
    document.documentElement.classList.add('has-jarvis');
    this.closeBtn.focus();
    this.loop();
    if (this.ctx.store.mock) return this.demo();
    this.offJarvis = this.ctx.store.on('jarvis', (j) => {
      if (j.agentId === this.agentId) void this.fetchItems();
    });
    try {
      const res = await fetch('/api/chat/jarvis', { credentials: 'same-origin', cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { agentId?: string; error?: string };
      if (!res.ok || !body.agentId) throw new Error(body.error ?? tr('erro {0}', [res.status]));
      this.agentId = body.agentId;
      void this.fetchItems();
      const vres = await fetch('/api/chat/jarvis/voice', { credentials: 'same-origin', cache: 'no-store' });
      const view = (await vres.json().catch(() => ({}))) as VoiceViewLite & { error?: string };
      if (!vres.ok) throw new Error(view.error ?? tr('erro {0}', [vres.status]));
      if (!this.open) return;
      await this.startEngine(view);
    } catch (err) {
      this.emit({ type: 'start' });
      this.emit({ type: 'fail', error: tr('Jarvis indisponível: {0}', [(err as Error).message]) });
    }
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.engine?.stop();
    this.engine = null;
    this.offJarvis?.();
    this.offJarvis = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.voice = VOICE_OFF;
    setText(this.warnEl, '');
    setHidden(this.el, true);
    document.documentElement.classList.remove('has-jarvis');
    this.opener?.focus();
  }

  render(): void {
    if (!this.open) return;
    this.card.render(this.agentId ? this.ctx.agent(this.agentId) : undefined);
    this.renderActivity();
    const lines = historyTail(this.items);
    const key = lines.map((l) => `${l.seq}:${l.text.length}`).join(',');
    if (key === this.linesKey) return;
    this.linesKey = key;
    const newest = lines.findLast((l) => l.who === 'jarvis')?.seq ?? -1;
    this.history.replaceChildren(
      ...lines.map((l) => {
        const who = h('span', { class: 'ui-jarvis__who', text: l.who === 'you' ? (l.from ? tr('Você ({0})', [l.from]) : tr('Você')) : l.who === 'jarvis' ? 'Jarvis' : tr('Aviso') });
        const li = h('li', { class: `ui-jarvis__line is-${l.who}${l.error ? ' is-error' : ''}` }, who);
        if (l.seq === newest && l.seq > this.seenSeq && !this.reduced) li.append(...this.revealing(l.seq, l.text));
        else if (l.who === 'you') li.append(...this.withThumbs(l.text));
        else li.append(h('span', { class: 'ui-jarvis__text', text: l.text }));
        return li;
      }),
    );
    if (!lines.length) this.history.append(h('li', { class: 'ui-jarvis__line is-note', text: tr('Fale com o Jarvis: "como está o dia?", "o que falta no projeto X?"') }));
    this.history.scrollTop = this.history.scrollHeight;
  }

  /** A resposta nova: o texto inteiro para o leitor de tela e, na tela, o pedaço já "dito" (o loop avança). */
  private revealing(seq: number, full: string): HTMLElement[] {
    if (!this.reveal || this.reveal.seq !== seq) this.reveal = { seq, full, shown: 0, el: null };
    this.reveal.full = full;
    const shown = h('span', { class: 'ui-jarvis__text is-typing', attrs: { 'aria-hidden': 'true' }, text: full.slice(0, Math.floor(this.reveal.shown)) });
    this.reveal.el = shown;
    return [h('span', { class: 'ui-sr', text: full }), shown];
  }

  /** O seu pedido, com as imagens mandadas daqui em miniatura no lugar da linha "📎 nomes". */
  private withThumbs(text: string): HTMLElement[] {
    const rows = text.split('\n');
    const last = rows.at(-1) ?? '';
    const names = last.startsWith(THUMB_PREFIX) ? last.slice(THUMB_PREFIX.length).split(', ') : [];
    const imgs = names.flatMap((n) => (this.thumbs.has(n) ? [h('img', { class: 'ui-jarvis__thumb', attrs: { src: this.thumbs.get(n)!, alt: n, loading: 'lazy' } })] : []));
    if (!imgs.length) return [h('span', { class: 'ui-jarvis__text', text })];
    const body = rows.slice(0, -1).join('\n');
    return [...(body ? [h('span', { class: 'ui-jarvis__text', text: body })] : []), h('span', { class: 'ui-jarvis__thumbs' }, ...imgs)];
  }

  private renderActivity(): void {
    const rows = activityOf(this.items);
    const thinking = this.voice.phase === 'thinking';
    const key = `${thinking}|${rows.map((r) => `${r.seq}:${r.state}`).join(',')}`;
    if (key === this.actKey) return;
    this.actKey = key;
    if (!rows.length) {
      this.activity.replaceChildren(h('li', { class: 'ui-jarvis__act is-empty', text: thinking ? tr('Pensando no que fazer…') : tr('Nada em andamento. O que o Jarvis fizer aparece aqui.') }));
      return;
    }
    this.activity.replaceChildren(...rows.map((r) => this.actRow(r)));
  }

  private actRow(r: ActivityRow): HTMLElement {
    const agent = r.agentId ? this.ctx.agent(r.agentId)?.name : undefined;
    const detail = agent ? (r.detail ? `${agent}: ${r.detail}` : agent) : r.detail;
    const state =
      r.state === 'running'
        ? h('span', { class: 'ui-jarvis__spin', attrs: { 'aria-hidden': 'true' } })
        : r.state === 'waiting'
          ? h('span', { class: 'ui-jarvis__pulse', attrs: { 'aria-hidden': 'true' } })
          : svgIcon(STATE_ICON[r.state], 'ui-jarvis__mark');
    const status = { running: tr('em andamento'), waiting: tr('esperando você'), done: tr('feito'), error: tr('falhou') }[r.state];
    return h(
      'li',
      { class: `ui-jarvis__act is-${r.state}` },
      svgIcon(ACT_ICON[r.icon], 'ui-jarvis__aicon'),
      h('span', { class: 'ui-jarvis__abody' }, h('span', { class: 'ui-jarvis__alabel', text: r.label }), ...(detail ? [h('span', { class: 'ui-jarvis__adetail', text: detail, attrs: { title: detail } })] : [])),
      state,
      h('span', { class: 'ui-sr', text: status }),
    );
  }

  private async startEngine(view: VoiceViewLite): Promise<void> {
    setText(this.chip, tr('Voz: {0}', [view.engine === 'realtime' ? `${ENGINE_LABEL.realtime} · ${view.provider === 'gemini' ? 'Gemini' : 'OpenAI'}` : ENGINE_LABEL[view.engine]]));
    this.emit({ type: 'start' });
    const engine: VoiceEngine = (this.engine = createEngine(view, { emit: (e) => this.engine === engine && this.emit(e), warn: (t) => this.engine === engine && setText(this.warnEl, t) }));
    try {
      await engine.start();
    } catch (err) {
      if (this.engine === engine) this.emit({ type: 'fail', error: (err as Error).message });
    }
  }

  private emit(e: VoiceEvent): void {
    const next = stepVoice(this.voice, e);
    if (next === this.voice) return;
    this.voice = next;
    this.paintVoice();
  }

  private paintVoice(): void {
    const v = this.voice;
    this.el.setAttribute('data-phase', v.phase);
    const ptt = !!this.engine?.pushToTalk;
    setText(this.stateEl, v.phase === 'error' ? v.error : v.phase === 'listening' && ptt ? tr('Toque no orb para falar') : phaseLabel(v.phase));
    setText(this.heardEl, v.heard ? `“${v.heard}”` : '');
    setText(this.saidEl, v.said);
    setHidden(this.saidEl, !v.said);
    this.stopBtn.disabled = v.phase !== 'speaking' && v.phase !== 'thinking';
    this.orbBtn.setAttribute(
      'aria-label',
      v.phase === 'error' ? tr('Tentar de novo') : v.phase === 'speaking' ? tr('Interromper o Jarvis') : ptt ? tr('Falar com o Jarvis (toque de novo para enviar)') : tr('Jarvis: {0}', [phaseLabel(v.phase)]),
    );
    if (this.open) this.renderActivity();
  }

  private orbClick(): void {
    if (this.ctx.store.mock) return;
    if (this.voice.phase === 'error') {
      this.engine?.stop();
      this.engine = null;
      this.voice = VOICE_OFF;
      setText(this.warnEl, '');
      void this.restart();
      return;
    }
    if (this.voice.phase === 'speaking') return this.interrupt();
    this.engine?.toggleTalk?.();
  }

  private async restart(): Promise<void> {
    this.close();
    await this.show();
  }

  private interrupt(): void {
    if (this.ctx.store.mock) return;
    this.engine?.interrupt();
    // Pensando: a rodada do Jarvis para também (o pedido já está na conversa).
    if (this.voice.phase === 'thinking' && this.agentId) void fetch(`/api/chat/agents/${encodeURIComponent(this.agentId)}/stop`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  }

  private async sendTyped(): Promise<void> {
    const text = this.input.value.trim();
    const images = this.attach.images();
    if ((!text && !images.length) || this.attach.busy || this.ctx.store.mock) return;
    try {
      const res = await fetch('/api/chat/jarvis', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, ...(images.length ? { images } : {}) }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
      this.keepThumbs(images);
      this.input.value = '';
      this.attach.clear();
      setText(this.warnEl, '');
    } catch (err) {
      setText(this.warnEl, (err as Error).message);
    }
  }

  private keepThumbs(images: Img[]): void {
    for (const i of images) {
      this.thumbs.delete(i.name);
      this.thumbs.set(i.name, `data:${i.type};base64,${i.data}`);
    }
    while (this.thumbs.size > THUMBS_MAX) this.thumbs.delete(this.thumbs.keys().next().value!);
  }

  private toDrawer(): void {
    const id = this.agentId;
    this.close();
    if (id) this.ctx.select({ type: 'agent', id }, { focus: true });
  }

  /** Itens novos da conversa (chamado pelo evento SSE "jarvis"); avisos seguidos viram uma busca a mais, no máximo. */
  private async fetchItems(): Promise<void> {
    if (!this.agentId) return;
    if (this.fetching) {
      this.refetch = true;
      return;
    }
    this.fetching = true;
    try {
      const after = this.items.at(-1)?.seq ?? 0;
      const res = await fetch(`/api/chat/agents/${encodeURIComponent(this.agentId)}?after=${after}`, { credentials: 'same-origin', cache: 'no-store' });
      if (res.ok) {
        const v = (await res.json()) as ChatView;
        this.items = mergeItems(this.items, v.items).slice(-60);
        // A 1ª busca ao abrir é o histórico: aparece pronto; só o que chegar depois "fala" na tela.
        if (this.seenSeq === Infinity) this.seenSeq = this.items.at(-1)?.seq ?? 0;
        this.ctx.invalidate();
      }
    } catch {
      // rede: o próximo aviso tenta de novo
    } finally {
      this.fetching = false;
      if (this.refetch && this.open) {
        this.refetch = false;
        void this.fetchItems();
      }
    }
  }

  private demo(): void {
    this.items = demoItems();
    this.seenSeq = 0;
    setText(this.chip, tr('Voz: {0}', [tr('Demonstração')]));
    this.emit({ type: 'start' });
    this.emit({ type: 'ready' });
    this.emit({ type: 'hearing', text: tr('Jarvis, abre um agente para a tela de assinatura') });
    this.ctx.invalidate();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      return this.close();
    }
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t instanceof HTMLButtonElement);
    if (e.key === ' ' && !typing) {
      e.preventDefault();
      return this.interrupt();
    }
    if (e.key === 'Tab') {
      // Foco preso no overlay (modal).
      const all = [...this.el.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea, select, a[href], [tabindex]:not([tabindex="-1"])')].filter((x) => x.offsetParent !== null);
      if (!all.length) return;
      const first = all[0];
      const last = all[all.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    // Atalhos do escritório ficam desligados com o Jarvis aberto (o index.ts olha defaultPrevented/isOpen).
  }

  // ---------------------------------------------------------------- orb e resposta nova

  private loop(): void {
    let last = 0;
    let prev = 0;
    const frame = (now: number) => {
      if (!this.open) return;
      this.raf = requestAnimationFrame(frame);
      const dt = prev ? Math.min(100, now - prev) : 16;
      prev = now;
      this.advanceReveal(dt);
      // Movimento reduzido: 4 quadros por segundo, nada gira.
      if (this.reduced && now - last < 250) return;
      last = now;
      const raw = this.ctx.store.mock ? 0.35 + Math.sin(now / 260) * 0.18 + Math.sin(now / 97) * 0.08 : (this.engine?.level(now) ?? 0);
      this.level += (raw - this.level) * (raw > this.level ? 0.5 : 0.12);
      this.orb.draw(this.reduced ? 0 : now, this.level, this.voice.phase);
    };
    this.raf = requestAnimationFrame(frame);
  }

  /** A resposta nova aparece no ritmo da fala; termina = vira texto comum (sem efeito ao reabrir). */
  private advanceReveal(dt: number): void {
    const r = this.reveal;
    if (!r?.el || r.shown >= r.full.length) return;
    r.shown = Math.min(r.full.length, r.shown + (dt * (this.voice.phase === 'speaking' ? CPS_SPEAKING : CPS_TYPED)) / 1000);
    r.el.textContent = r.full.slice(0, Math.floor(r.shown));
    if (r.shown >= r.full.length) {
      r.el.classList.remove('is-typing');
      this.seenSeq = Math.max(this.seenSeq, r.seq);
    }
  }
}
