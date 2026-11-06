// Jarvis em tela cheia: o orb em pixel (nível do microfone, ou da fala), a transcrição ao vivo, as últimas falas e os
// cartões de aprovação do Jarvis ali mesmo (PermissionCard: o PIN é sempre digitado no cartão). Abre pela barra de cima
// ou pela tecla J; Esc fecha, Espaço interrompe. A conversa chega pelo evento SSE "jarvis" (store), sem polling: cada
// aviso busca os itens novos por GET /api/chat/agents/:id?after=. A voz é do motor escolhido (jarvis-voice.ts). No
// modo demonstração (?mock=1) mostra uma conversa de exemplo, sem microfone nem servidor.
import type { ChatItem, ChatView } from '../../../shared/chat';
import { tr } from '../../../shared/i18n';
import { mergeItems } from './chat-model';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { historyTail, phaseLabel, stepVoice, VOICE_OFF, type VoiceEvent, type VoicePhase, type VoiceUi } from './jarvis-model';
import { createEngine, type EngineId, type VoiceEngine, type VoiceViewLite } from './jarvis-voice';
import { PermissionCard } from './permission';

/** Resolução do orb (pixels de verdade; o CSS amplia sem suavizar). */
const ORB = 112;
/** Cores do orb por estado: os tokens do styles.css (--ui-accent, --st-waiting, --st-working, --lv-crit, --st-idle). */
const PALETTE: Record<VoicePhase, [string, string, string]> = {
  off: ['#8b98b3', '#3a4256', '#c9d1e3'],
  connecting: ['#8b98b3', '#3a4256', '#c9d1e3'],
  listening: ['#7cc8ff', '#1f4f7d', '#e3f4ff'],
  thinking: ['#ffb547', '#7a4c0e', '#fff0d1'],
  speaking: ['#4fd18b', '#165a39', '#dcffe9'],
  error: ['#ff6b6b', '#6e2323', '#ffe0e0'],
};
/** Matriz de Bayer 4×4: o degradê do orb vira pontilhado de pixel art. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

const ENGINE_LABEL: Record<EngineId, string> = { realtime: 'Realtime', browser: tr('Navegador'), local: tr('Local') };

function demoItems(): ChatItem[] {
  return [
    { seq: 1, at: 0, kind: 'user', text: tr('Jarvis, como está o dia?'), from: { agentId: 'voice', name: tr('voz') } },
    { seq: 2, at: 0, kind: 'assistant', text: tr('Três agentes trabalhando: dois no app e um no servidor. Uma lista espera revisão e nenhum cartão está pendente.') },
    { seq: 3, at: 0, kind: 'user', text: tr('O que falta no app?'), from: { agentId: 'voice', name: tr('voz') } },
    { seq: 4, at: 0, kind: 'assistant', text: tr('Falta a tela de assinatura e o teste do pagamento. Quer que eu abra um agente para isso?') },
  ];
}

export class JarvisOverlay implements UiComponent {
  readonly el: HTMLElement;
  private open = false;
  private agentId = '';
  private items: ChatItem[] = [];
  private linesKey = '';
  private voice: VoiceUi = VOICE_OFF;
  private engine: VoiceEngine | null = null;
  private opener: HTMLElement | null = null;
  private raf = 0;
  private level = 0;
  private fetching = false;
  private refetch = false;
  private offJarvis: (() => void) | null = null;
  private readonly reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D | null;
  private readonly img: ImageData | null;
  private readonly orbBtn: HTMLButtonElement;
  private readonly stateEl: HTMLElement;
  private readonly heardEl: HTMLElement;
  private readonly saidEl: HTMLElement;
  private readonly warnEl: HTMLElement;
  private readonly chip: HTMLElement;
  private readonly history: HTMLOListElement;
  private readonly card: PermissionCard;
  private readonly stopBtn: HTMLButtonElement;
  private readonly input: HTMLInputElement;
  private readonly closeBtn: HTMLButtonElement;

  constructor(private readonly ctx: UiContext) {
    this.canvas = h('canvas', { class: 'ui-jarvis__canvas', attrs: { width: ORB, height: ORB, 'aria-hidden': 'true' } });
    this.g = this.canvas.getContext('2d');
    this.img = this.g?.createImageData(ORB, ORB) ?? null;
    this.orbBtn = h('button', { class: 'ui-jarvis__orb', type: 'button', on: { click: () => this.orbClick() } }, this.canvas);
    this.stateEl = h('p', { class: 'ui-jarvis__state', role: 'status', attrs: { 'aria-live': 'polite' } });
    this.heardEl = h('p', { class: 'ui-jarvis__heard', attrs: { 'aria-live': 'polite' } });
    this.saidEl = h('p', { class: 'ui-jarvis__said' });
    this.warnEl = h('p', { class: 'ui-jarvis__warn', role: 'alert' });
    this.chip = h('span', { class: 'ui-jarvis__chip' });
    this.history = h('ol', { class: 'ui-jarvis__history', role: 'log', attrs: { 'aria-label': tr('Últimas falas') } });
    this.card = new PermissionCard(ctx);
    this.card.el.classList.add('ui-jarvis__card');
    const stopIcon = h('span', { class: 'ui-jarvis__ico', attrs: { 'aria-hidden': 'true' } });
    stopIcon.innerHTML = ICONS.stopRec;
    this.stopBtn = h('button', { class: 'ui-btn ui-jarvis__stop', type: 'button', attrs: { 'aria-keyshortcuts': 'Space' }, on: { click: () => this.interrupt() } }, stopIcon, h('span', { text: tr('Interromper') }), h('kbd', { class: 'ui-kbd', text: tr('Espaço') }));
    this.input = h('input', { class: 'ui-jarvis__input', type: 'text', attrs: { maxlength: 8000, placeholder: tr('Ou escreva para o Jarvis…'), 'aria-label': tr('Mensagem para o Jarvis') } }) as HTMLInputElement;
    const form = h('form', { class: 'ui-jarvis__form', on: { submit: (e: Event) => (e.preventDefault(), void this.sendTyped()) } }, this.input, h('button', { class: 'ui-btn', type: 'submit', text: tr('Enviar') }));
    const drawerBtn = h('button', { class: 'ui-btn ui-jarvis__link', type: 'button', text: tr('Abrir a conversa completa'), on: { click: () => this.toDrawer() } });
    this.closeBtn = iconButton(ICONS.close, tr('Fechar (Esc)'), () => this.close(), 'ui-jarvis__close');
    const mark = h('span', { class: 'ui-jarvis__mark', attrs: { 'aria-hidden': 'true' } });
    mark.innerHTML = ICONS.jarvis;
    const title = h('h2', { class: 'ui-jarvis__title', attrs: { id: 'ui-jarvis-title' } }, mark, h('span', { text: 'JARVIS' }));
    this.el = h(
      'div',
      { class: 'ui-jarvis', hidden: true, role: 'dialog', attrs: { 'aria-modal': 'true', 'aria-labelledby': 'ui-jarvis-title' }, on: { keydown: (e: Event) => this.onKey(e as KeyboardEvent) } },
      h('div', { class: 'ui-jarvis__fx', attrs: { 'aria-hidden': 'true' } }),
      h('header', { class: 'ui-jarvis__head' }, title, this.chip, this.closeBtn),
      h(
        'div',
        { class: 'ui-jarvis__body' },
        h('section', { class: 'ui-jarvis__stage' }, this.orbBtn, this.stateEl, this.heardEl, this.saidEl, this.warnEl),
        h('aside', { class: 'ui-jarvis__side' }, this.card.el, h('h3', { class: 'ui-jarvis__sub', text: tr('Últimas falas') }), this.history),
      ),
      h('footer', { class: 'ui-jarvis__foot' }, this.stopBtn, form, drawerBtn),
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
    const lines = historyTail(this.items);
    const key = lines.map((l) => `${l.seq}:${l.text.length}`).join(',');
    if (key === this.linesKey) return;
    this.linesKey = key;
    this.history.replaceChildren(
      ...lines.map((l) =>
        h(
          'li',
          { class: `ui-jarvis__line is-${l.who}${l.error ? ' is-error' : ''}` },
          h('span', { class: 'ui-jarvis__who', text: l.who === 'you' ? (l.from ? tr('Você ({0})', [l.from]) : tr('Você')) : l.who === 'jarvis' ? 'Jarvis' : tr('Aviso') }),
          h('span', { class: 'ui-jarvis__text', text: l.text }),
        ),
      ),
    );
    if (!lines.length) this.history.append(h('li', { class: 'ui-jarvis__line is-note', text: tr('Fale com o Jarvis: "como está o dia?", "o que falta no projeto X?"') }));
    this.history.scrollTop = this.history.scrollHeight;
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
    if (this.voice.phase === 'thinking' && this.agentId) void fetch(`/api/chat/agents/${encodeURIComponent(this.agentId)}/stop`, { method: 'POST', credentials: 'same-origin' });
  }

  private async sendTyped(): Promise<void> {
    const text = this.input.value.trim();
    if (!text || this.ctx.store.mock) return;
    try {
      const res = await fetch('/api/chat/jarvis', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
      this.input.value = '';
      setText(this.warnEl, '');
    } catch (err) {
      setText(this.warnEl, (err as Error).message);
    }
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

  // ---------------------------------------------------------------- orb

  private loop(): void {
    let last = 0;
    const frame = (now: number) => {
      if (!this.open) return;
      this.raf = requestAnimationFrame(frame);
      // Movimento reduzido: 4 quadros por segundo, sem giro.
      if (this.reduced && now - last < 250) return;
      last = now;
      const raw = this.ctx.store.mock ? 0.35 + Math.sin(now / 260) * 0.18 + Math.sin(now / 97) * 0.08 : (this.engine?.level(now) ?? 0);
      this.level += (raw - this.level) * (raw > this.level ? 0.5 : 0.12);
      this.draw(this.reduced ? 0 : now, this.level);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private draw(t: number, level: number): void {
    const g = this.g;
    const img = this.img;
    if (!g || !img) return;
    const phase = this.voice.phase;
    const [base, deep, hi] = PALETTE[phase].map(rgb);
    const d = img.data;
    d.fill(0);
    const c = ORB / 2;
    const r = 20 + level * 9 + (phase === 'thinking' ? Math.sin(t / 300) * 1.5 : 0);
    const put = (x: number, y: number, col: number[], a = 255) => {
      x = Math.round(x);
      y = Math.round(y);
      if (x < 0 || y < 0 || x >= ORB || y >= ORB) return;
      const i = (y * ORB + x) * 4;
      d[i] = col[0];
      d[i + 1] = col[1];
      d[i + 2] = col[2];
      d[i + 3] = a;
    };
    // Núcleo: esfera pontilhada (luz em cima à esquerda).
    for (let y = Math.floor(c - r); y <= c + r; y++) {
      for (let x = Math.floor(c - r); x <= c + r; x++) {
        const dist = Math.hypot(x - c, y - c);
        if (dist > r) continue;
        const light = 1 - Math.hypot(x - (c - r * 0.35), y - (c - r * 0.35)) / (r * 1.6);
        const thr = BAYER[(y & 3) * 4 + (x & 3)];
        put(x, y, light > 0.72 + thr * 0.2 ? hi : light > thr * 0.9 ? base : deep);
      }
    }
    // Contorno.
    for (let a = 0; a < Math.PI * 2; a += 1 / (r + 2)) put(c + Math.cos(a) * (r + 1), c + Math.sin(a) * (r + 1), deep);
    // Raios: barras em volta, crescem com o nível (cada uma no seu ritmo).
    const spokes = 28;
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2 + t / 4000;
      const wob = 0.55 + 0.45 * Math.sin(t / 140 + i * 1.7) * Math.sin(t / 330 + i * 0.6);
      const len = phase === 'off' || phase === 'error' ? 1 : 1 + Math.round(level * 16 * wob);
      for (let k = 0; k < len; k++) put(c + Math.cos(a) * (r + 4 + k), c + Math.sin(a) * (r + 4 + k), k > len - 2 ? hi : base, 255 - k * 9);
    }
    // Pensando: três pontos em órbita. Conectando: anel tracejado girando.
    if (phase === 'thinking' || phase === 'connecting') {
      const R = r + 22;
      const n = phase === 'thinking' ? 3 : 12;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + t / (phase === 'thinking' ? 420 : 900);
        const x = c + Math.cos(a) * R;
        const y = c + Math.sin(a) * R;
        put(x, y, hi);
        if (phase === 'thinking') {
          put(x + 1, y, base);
          put(x, y + 1, base);
          put(x + 1, y + 1, deep);
        }
      }
    }
    g.putImageData(img, 0, 0);
  }
}

function rgb(hex: string): number[] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
