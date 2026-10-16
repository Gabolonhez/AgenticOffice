// Quadro: segunda vista do escritório (atalho V), alternando com a pixel art. Um cartão por agente principal (os
// subagentes como chips dentro), arrumados por sala e arrastáveis, linhas das conversas entre agentes
// (GET /api/chat/links) e notas adesivas. Posições e notas ficam no navegador (localStorage). Contas em canvas-model.ts.
import { tr } from '../../../shared/i18n';
import type { AgentInfo } from '../../../shared/types';
import { createAvatar, updateAvatar } from './avatar';
import {
  autoLayout,
  buildLinks,
  CARD_H,
  CARD_W,
  fitView,
  groupCards,
  NOTE_COLORS,
  NOTE_H,
  NOTE_MAX,
  NOTE_W,
  parseLinks,
  parseState,
  serializeState,
  toWorld,
  zoomAt,
  type CanvasState,
  type ChatLink,
  type Note,
  type Pos,
  type Rect,
  type View,
} from './canvas-model';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, KeyedList, setAttr, setHidden, setText, setVariant } from './dom';
import { ICONS } from './icons';
import { displayStatus, statusLabel } from './model';
import { safeLocalStorage } from './prefs';
import { createAgentRow, updateAgentRow } from './rows';

const STORE_KEY = 'habblaud:canvas';
const LINKS_POLL_MS = 15_000;
/** Movimento mínimo (px) para um toque virar arrasto (abaixo disso é clique). */
const DRAG_PX = 5;
/** shortcut: corta pela ordem de inserção, não por uso; trocar por "visto por último" se agentes voltarem sem lugar. */
const MAX_SAVED_POS = 300;
const NOTE_COLOR_LABEL: Record<Note['color'], string> = { yellow: tr('amarela'), pink: tr('rosa'), blue: tr('azul'), green: tr('verde') };

type Card = { card: AgentInfo; subs: AgentInfo[] };
type Grab =
  | { kind: 'pan'; view: View }
  | { kind: 'card'; id: string; from: Pos }
  | { kind: 'note'; id: string; from: Pos };

export class CanvasView implements UiComponent {
  readonly el: HTMLElement;
  readonly button: HTMLButtonElement;
  private plane: HTMLElement;
  /** Camada das linhas: um <svg> refeito a cada mudança (poucas linhas). */
  private links: HTMLElement;
  private linksSvg = '';
  private cards: KeyedList<Card, HTMLElement>;
  private notes: KeyedList<Note, HTMLElement>;
  private storage = safeLocalStorage();
  private state: CanvasState;
  private view: View = { x: 40, y: 40, k: 1 };
  private fitted = false;
  private chatLinks: ChatLink[] = [];
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pointers = new Map<number, Pos>();
  private grab: { g: Grab; start: Pos; moved: boolean } | null = null;
  private pinch: { dist: number; view: View } | null = null;
  private suppressClick = false;
  /** Cartões na tela (id do agente → id do cartão), para as linhas. */
  private cardOf = new Map<string, string>();
  open = false;

  constructor(private ctx: UiContext) {
    this.state = parseState(this.read());
    this.button = iconButton(ICONS.board, tr('Quadro: os agentes em cartões (V)'), () => this.toggle(), 'ui-btn-canvas');
    this.links = h('div', { class: 'ui-canvas__links', attrs: { 'aria-hidden': 'true' } });
    const cardLayer = h('div', { class: 'ui-canvas__cards' });
    const noteLayer = h('div', { class: 'ui-canvas__notes' });
    this.plane = h('div', { class: 'ui-canvas__plane' }, this.links, noteLayer, cardLayer);
    const fit = iconButton(ICONS.overview, tr('Enquadrar tudo (O)'), () => this.fit());
    this.el = h(
      'section',
      { class: 'ui-canvas', hidden: true, tabIndex: -1, attrs: { 'aria-label': tr('Quadro dos agentes') } },
      this.plane,
      h('div', { class: 'ui-canvas__tools' }, fit, h('span', { class: 'ui-canvas__hint', text: tr('Arraste para mover · duplo clique cria uma nota') })),
    );
    this.cards = new KeyedList(cardLayer, { key: (c) => c.card.id, create: (c) => this.createCard(c), update: (el, c) => this.updateCard(el, c) });
    this.notes = new KeyedList(noteLayer, { key: (n) => n.id, create: (n) => this.createNote(n), update: (el, n) => this.updateNote(el, n), animate: false });
    this.bindPointer();
  }

  // ---------------------------------------------------------------- abrir e fechar

  toggle(open = !this.open): void {
    if (open === this.open) return;
    this.open = open;
    setHidden(this.el, !open);
    this.ctx.root.classList.toggle('is-canvas', open);
    // A pixel art fica parada por trás (sem desenho nem teclado da câmera).
    this.ctx.world.setSuspended?.(open);
    if (open) void this.pollLinks();
    else if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.ctx.announce(open ? tr('Quadro aberto') : tr('Escritório aberto'));
    this.ctx.invalidate();
  }

  /** Botões e atalhos da câmera (O, +, −) enquanto o quadro está aberto. */
  camera(action: 'overview' | 'zoomIn' | 'zoomOut'): void {
    if (action === 'overview') return this.fit();
    const r = this.el.getBoundingClientRect();
    this.setView(zoomAt(this.view, action === 'zoomIn' ? 1.25 : 1 / 1.25, r.width / 2, r.height / 2));
  }

  private async pollLinks(): Promise<void> {
    if (!this.open) return;
    try {
      const res = await fetch('/api/chat/links', { credentials: 'same-origin' });
      // 404 (servidor sem o recurso) ou erro: sem linhas de conversa, só as de subagentes.
      this.chatLinks = res.ok ? parseLinks(await res.json().catch(() => null)) : [];
    } catch {
      this.chatLinks = [];
    }
    this.renderLinks();
    if (this.open) this.pollTimer = setTimeout(() => void this.pollLinks(), LINKS_POLL_MS);
  }

  // ---------------------------------------------------------------- renderização

  render(): void {
    this.button.setAttribute('aria-pressed', String(this.open));
    const snap = this.ctx.store.snapshot;
    if (!this.open || !snap) return;
    const rooms = [...snap.rooms].sort((a, b) => a.slot - b.slot);
    const groups = groupCards(snap.agents);
    const placed = autoLayout(
      groups.map((g) => g.card),
      rooms.map((r) => r.id),
      this.state.pos,
      this.state.notes.map(noteRect),
    );
    if (groups.some((g) => !this.state.pos[g.card.id])) {
      this.state.pos = { ...this.state.pos, ...placed };
      this.save();
    }
    this.cardOf.clear();
    for (const g of groups) {
      this.cardOf.set(g.card.id, g.card.id);
      for (const s of g.subs) this.cardOf.set(s.id, g.card.id);
    }
    this.cards.sync(groups);
    this.notes.sync(this.state.notes);
    if (!this.fitted && this.el.clientWidth) {
      this.fitted = true;
      this.fit();
    }
    this.renderLinks();
  }

  private createCard(c: Card): HTMLElement {
    const row = createAgentRow(c.card, (id) => this.pick(id), 'md');
    const room = h('span', { class: 'ui-ccard__room' });
    const subs = h('ul', { class: 'ui-ccard__subs', attrs: { 'aria-label': tr('Subagentes') } });
    const el = h('article', { class: 'ui-ccard', style: `width:${CARD_W}px;height:${CARD_H}px` }, row, room, subs);
    el.addEventListener('focusin', () => this.reveal(this.state.pos[el.dataset.key!]));
    return el;
  }

  private updateCard(el: HTMLElement, c: Card): void {
    const { ctx } = this;
    const a = c.card;
    const now = ctx.now();
    const agents = ctx.store.snapshot?.agents ?? [];
    const sel = ctx.selection();
    const row = el.firstElementChild as HTMLElement;
    updateAgentRow(row, a, ctx.account(a.account), sel?.type === 'agent' && sel.id === a.id, now, agents);
    setVariant(el, 'is-', displayStatus(a, now));
    const room = ctx.store.snapshot?.rooms.find((r) => r.id === a.roomId);
    setText(el.children[1], room?.name ?? '');
    setAttr(el.children[1] as HTMLElement, 'title', room?.path ?? null);
    const p = this.state.pos[a.id];
    if (p) el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    // Chips dos subagentes (o fio da árvore no CSS é a linha principal → subagente).
    const list = el.children[2] as HTMLElement;
    setHidden(list, !c.subs.length);
    while (list.children.length > c.subs.length) list.lastElementChild!.remove();
    c.subs.forEach((s, i) => {
      let chip = list.children[i]?.firstElementChild as HTMLButtonElement | undefined;
      if (!chip) {
        chip = h('button', { class: 'ui-csub', type: 'button', on: { click: () => this.pick(chip!.dataset.id!) } }, createAvatar(s, 'xs'), h('span', { class: 'ui-csub__name' }));
        list.append(h('li', {}, chip));
      }
      chip.dataset.id = s.id;
      updateAvatar(chip.firstElementChild as HTMLElement, s, 'xs');
      const status = displayStatus(s, now);
      setVariant(chip, 'is-', status);
      setText(chip.lastElementChild!, s.name);
      chip.classList.toggle('is-selected', sel?.type === 'agent' && sel.id === s.id);
      const label = `${s.name}, ${tr('subagente {0}', [s.role])}, ${statusLabel(status)}${s.activity?.text ? `: ${s.activity.text}` : ''}`;
      setAttr(chip, 'aria-label', label);
      setAttr(chip, 'title', label);
    });
  }

  private createNote(n: Note): HTMLElement {
    const text = h('textarea', { class: 'ui-cnote__text', attrs: { 'aria-label': tr('Texto da nota'), maxlength: NOTE_MAX, placeholder: tr('Escreva aqui…') } });
    text.addEventListener('input', () => this.editNote(el.dataset.key!, { text: text.value }));
    const color = h('button', { class: 'ui-cnote__btn ui-cnote__color', type: 'button', on: { click: () => this.cycleColor(el.dataset.key!) } });
    const del = iconButton(ICONS.close, tr('Apagar nota'), () => this.deleteNote(el.dataset.key!), 'ui-icon-btn--sm ui-cnote__btn');
    const el = h('div', { class: 'ui-cnote', style: `width:${NOTE_W}px;height:${NOTE_H}px` }, h('div', { class: 'ui-cnote__bar' }, color, del), text);
    text.value = n.text;
    return el;
  }

  private updateNote(el: HTMLElement, n: Note): void {
    setVariant(el, 'is-', n.color);
    el.style.transform = `translate(${n.x}px, ${n.y}px)`;
    const text = el.querySelector('textarea')!;
    if (document.activeElement !== text && text.value !== n.text) text.value = n.text;
    const color = el.querySelector<HTMLElement>('.ui-cnote__color')!;
    const label = tr('Cor da nota: {0} (trocar)', [NOTE_COLOR_LABEL[n.color]]);
    setAttr(color, 'aria-label', label);
    setAttr(color, 'title', label);
  }

  /** Curvas entre os cartões que conversaram (as recentes em destaque), por baixo dos cartões. */
  private renderLinks(): void {
    if (!this.open) return;
    const links = buildLinks(this.chatLinks, (id) => this.cardOf.get(id), this.ctx.now());
    const center = (id: string) => {
      const p = this.state.pos[id];
      return p && { x: p.x + CARD_W / 2, y: p.y + CARD_H / 2 };
    };
    let out = '';
    for (const l of links) {
      const a = center(l.from);
      const b = center(l.to);
      if (!a || !b) continue;
      const dx = Math.max(60, Math.abs(b.x - a.x) / 2) * (b.x >= a.x ? 1 : -1);
      out += `<path class="ui-canvas__link${l.recent ? ' is-recent' : ''}" d="M${a.x} ${a.y}C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}"/>`;
    }
    if (out === this.linksSvg) return;
    this.linksSvg = out;
    this.links.innerHTML = `<svg width="1" height="1" overflow="visible">${out}</svg>`;
  }

  // ---------------------------------------------------------------- câmera

  private setView(v: View): void {
    this.view = v;
    this.plane.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
    this.el.style.setProperty('--zoom', String(v.k));
  }

  private fit(): void {
    const rects: Rect[] = [...Object.entries(this.state.pos).filter(([id]) => this.cards.get(id)).map(([, p]) => ({ ...p, w: CARD_W, h: CARD_H })), ...this.state.notes.map(noteRect)];
    // Enquadra na área livre (fora da barra lateral, do feed e da gaveta), que ui/viewport.ts mantém em px.
    const free = (side: string) => parseFloat(this.ctx.root.style.getPropertyValue(`--free-${side}`)) || 0;
    const left = free('left');
    const top = Math.max(0, free('top') - this.el.getBoundingClientRect().top);
    const v = fitView(rects, this.el.clientWidth - left - free('right'), this.el.clientHeight - top - free('bottom'));
    this.setView({ ...v, x: v.x + left, y: v.y + top });
  }

  /** Cartão focado pelo teclado fora da tela: a câmera vai até ele. */
  private reveal(p: Pos | undefined): void {
    if (!p) return;
    const { x, y, k } = this.view;
    const w = this.el.clientWidth;
    const hgt = this.el.clientHeight;
    const sx = p.x * k + x;
    const sy = p.y * k + y;
    if (sx >= 0 && sy >= 0 && sx + CARD_W * k <= w && sy + CARD_H * k <= hgt) return;
    this.setView({ k, x: w / 2 - (p.x + CARD_W / 2) * k, y: hgt / 2 - (p.y + CARD_H / 2) * k });
    this.el.scrollTop = this.el.scrollLeft = 0;
  }

  // ---------------------------------------------------------------- arrastar, pinçar e roda

  private local(e: { clientX: number; clientY: number }): Pos {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private bindPointer(): void {
    const el = this.el;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const p = this.local(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2) {
        // Dois dedos: pinça (zoom) no lugar do arrasto.
        const [a, b] = [...this.pointers.values()];
        this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, view: this.view };
        this.grab = null;
        el.setPointerCapture(e.pointerId);
        return;
      }
      const t = e.target as HTMLElement;
      const card = t.closest<HTMLElement>('.ui-ccard');
      const note = t.closest<HTMLElement>('.ui-cnote');
      let g: Grab | null = null;
      if (card) g = { kind: 'card', id: card.dataset.key!, from: this.state.pos[card.dataset.key!] };
      else if (note && !t.closest('textarea, button')) {
        const n = this.state.notes.find((x) => x.id === note.dataset.key);
        if (n) g = { kind: 'note', id: n.id, from: { x: n.x, y: n.y } };
      } else if (!note) g = { kind: 'pan', view: this.view };
      if (!g || (g.kind === 'card' && !g.from)) return;
      this.grab = { g, start: p, moved: false };
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const p = this.local(e);
      this.pointers.set(e.pointerId, p);
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        this.setView(zoomAt(this.pinch.view, dist / this.pinch.dist, (a.x + b.x) / 2, (a.y + b.y) / 2));
        return;
      }
      const gr = this.grab;
      if (!gr) return;
      const dx = p.x - gr.start.x;
      const dy = p.y - gr.start.y;
      if (!gr.moved) {
        if (Math.hypot(dx, dy) < DRAG_PX) return;
        gr.moved = true;
        // Só agora captura: um toque sem arrasto continua sendo o clique do botão.
        el.setPointerCapture(e.pointerId);
        el.classList.add('is-dragging');
      }
      const g = gr.g;
      if (g.kind === 'pan') return this.setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
      const to = { x: Math.round(g.from.x + dx / this.view.k), y: Math.round(g.from.y + dy / this.view.k) };
      if (g.kind === 'card') {
        this.state.pos = { ...this.state.pos, [g.id]: to };
        const cardEl = this.cards.get(g.id);
        if (cardEl) cardEl.style.transform = `translate(${to.x}px, ${to.y}px)`;
        this.renderLinks();
      } else {
        const n = this.state.notes.find((x) => x.id === g.id);
        const noteEl = this.notes.get(g.id);
        if (n && noteEl) {
          Object.assign(n, to);
          noteEl.style.transform = `translate(${to.x}px, ${to.y}px)`;
        }
      }
    });
    const end = (e: PointerEvent) => {
      if (!this.pointers.delete(e.pointerId)) return;
      if (this.pinch) {
        if (this.pointers.size < 2) this.pinch = null;
        this.grab = null;
        return;
      }
      const gr = this.grab;
      this.grab = null;
      el.classList.remove('is-dragging');
      if (!gr?.moved) return;
      this.suppressClick = true;
      setTimeout(() => (this.suppressClick = false), 0);
      if (gr.g.kind !== 'pan') this.save();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    // Depois de arrastar um cartão, o clique que o navegador dispara não abre o agente.
    el.addEventListener(
      'click',
      (e) => {
        if (!this.suppressClick) return;
        e.stopPropagation();
        e.preventDefault();
      },
      true,
    );
    el.addEventListener(
      'wheel',
      (e) => {
        if ((e.target as HTMLElement).closest('textarea')) return;
        e.preventDefault();
        const p = this.local(e);
        // Pinça do touchpad chega como roda com Ctrl: mais sensível.
        this.setView(zoomAt(this.view, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y));
      },
      { passive: false },
    );
    el.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.ui-ccard, .ui-cnote, .ui-canvas__tools')) return;
      const l = this.local(e);
      const w = toWorld(this.view, l.x, l.y);
      this.addNote({ x: Math.round(w.x - NOTE_W / 2), y: Math.round(w.y - 16) });
    });
  }

  // ---------------------------------------------------------------- agentes e notas

  private pick(id: string): void {
    this.ctx.select({ type: 'agent', id });
  }

  private addNote(at: Pos): void {
    const id = `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.state.notes = [...this.state.notes, { id, ...at, text: '', color: 'yellow' }];
    this.save();
    this.notes.sync(this.state.notes);
    this.notes.get(id)?.querySelector('textarea')?.focus();
    this.ctx.announce(tr('Nota criada'));
  }

  private editNote(id: string, patch: Partial<Note>): void {
    this.state.notes = this.state.notes.map((n) => (n.id === id ? { ...n, ...patch } : n));
    this.save();
    this.notes.sync(this.state.notes);
  }

  private cycleColor(id: string): void {
    const n = this.state.notes.find((x) => x.id === id);
    if (n) this.editNote(id, { color: NOTE_COLORS[(NOTE_COLORS.indexOf(n.color) + 1) % NOTE_COLORS.length] });
  }

  private deleteNote(id: string): void {
    this.state.notes = this.state.notes.filter((n) => n.id !== id);
    this.save();
    this.notes.sync(this.state.notes);
    this.el.focus();
    this.ctx.announce(tr('Nota apagada'));
  }

  // ---------------------------------------------------------------- localStorage

  private read(): string | null {
    try {
      return this.storage?.getItem(STORE_KEY) ?? null;
    } catch {
      return null;
    }
  }

  private save(): void {
    const ids = Object.keys(this.state.pos);
    if (ids.length > MAX_SAVED_POS) for (const id of ids.slice(0, ids.length - MAX_SAVED_POS)) delete this.state.pos[id];
    try {
      this.storage?.setItem(STORE_KEY, serializeState(this.state));
    } catch {
      // Cheio ou bloqueado: o quadro continua funcionando nesta aba.
    }
  }
}

function noteRect(n: Note): Rect {
  return { x: n.x, y: n.y, w: NOTE_W, h: NOTE_H };
}
