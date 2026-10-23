// Diff da cópia isolada de uma lista (ui/runs.ts) com comentários por linha: tocar numa linha abre a caixa do
// comentário; os comentários ficam juntos aqui até "Enviar comentários ao agente" (POST .../items/:n/feedback, que
// manda UMA mensagem ao mesmo agente). Todo texto do diff entra como textContent (nada de HTML do diff).
import { parseDiff, type DiffFile, type DiffLine } from '../../../shared/diff';
import { tr } from '../../../shared/i18n';
import { RUN_FEEDBACK_MAX, RUN_FEEDBACK_TEXT_MAX, type RunFeedbackComment } from '../../../shared/runs';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';

/** Linhas desenhadas no máximo (um diff enorme não trava o celular). */
const LINES_MAX = 4000;

export interface RunDiffDeps {
  load(runId: string): Promise<{ diff: string; cut?: boolean }>;
  send(runId: string, index: number, comments: RunFeedbackComment[]): Promise<void>;
  say(text: string, error?: boolean): void;
}

const button = (text: string, click: () => void, allow = false) => h('button', { class: `ui-btn ui-perm__btn${allow ? ' ui-perm__btn--allow' : ''}`, type: 'button', on: { click } }, text);

export class RunDiffView {
  readonly el: HTMLElement;
  private review?: { runId: string; index: number; comments: RunFeedbackComment[] };
  private readonly sendBtn: HTMLButtonElement;
  private busy = false;

  constructor(private readonly deps: RunDiffDeps) {
    this.sendBtn = button('', () => void this.send(), true);
    this.el = h('section', { class: 'ui-diff', attrs: { 'aria-label': tr('Diff da cópia isolada') } });
    setHidden(this.el, true);
  }

  /** Abre o diff do item (substitui o que estava aberto e os comentários não enviados). */
  async open(runId: string, index: number, title: string): Promise<void> {
    let r: { diff: string; cut?: boolean };
    try {
      r = await this.deps.load(runId);
    } catch (err) {
      return this.deps.say((err as Error).message, true);
    }
    this.review = { runId, index, comments: [] };
    const files = parseDiff(r.diff);
    let budget = LINES_MAX;
    const blocks = files.map((f) => {
      const lines = f.lines.slice(0, Math.max(0, budget));
      budget -= lines.length;
      return this.file(f, lines);
    });
    this.updateSend();
    this.el.replaceChildren(
      h('div', { class: 'ui-diff__head' }, h('p', { class: 'ui-spawn__label', text: tr('Diff de: {0}', [title]) }), iconButton(ICONS.close, tr('Fechar o diff'), () => this.close(), 'ui-icon-btn--sm')),
      h('p', { class: 'ui-rename__hint', text: tr('Toque numa linha para comentar. Os comentários vão juntos, numa mensagem só, ao mesmo agente.') }),
      ...(blocks.length ? blocks : [h('p', { class: 'ui-rename__hint', text: tr('Sem mudanças na cópia.') })]),
      h('div', { class: 'ui-vboards__actions' }, this.sendBtn, button(tr('Fechar'), () => this.close())),
    );
    if (r.cut || files.reduce((n, f) => n + f.lines.length, 0) > LINES_MAX) this.el.lastElementChild?.before(h('p', { class: 'ui-rename__hint', text: tr('Diff grande: só o começo aparece aqui.') }));
    setHidden(this.el, false);
    this.el.scrollIntoView?.({ block: 'nearest' });
  }

  close(): void {
    this.review = undefined;
    this.el.replaceChildren();
    setHidden(this.el, true);
  }

  private file(f: DiffFile, lines: DiffLine[]): HTMLElement {
    return h(
      'section',
      { class: 'ui-diff__file' },
      h('p', { class: 'ui-diff__name', text: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path }),
      h('div', { class: 'ui-diff__lines' }, ...lines.map((l) => this.line(f, l))),
    );
  }

  private line(f: DiffFile, l: DiffLine): HTMLElement {
    if (l.kind === 'hunk' || l.kind === 'meta') return h('div', { class: `ui-diff__line is-${l.kind}`, text: l.text });
    const side: RunFeedbackComment['side'] = l.kind === 'del' ? 'old' : 'new';
    const n = (side === 'old' ? l.old : l.new) ?? 0;
    const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
    const el: HTMLButtonElement = h(
      'button',
      { class: `ui-diff__line is-${l.kind}`, type: 'button', attrs: { 'aria-label': tr('Comentar a linha {0} de {1}', [n, f.path]) }, on: { click: () => this.edit(el, { file: f.path, line: n, side }) } },
      h('span', { class: 'ui-diff__num', text: String(n) }),
      h('span', { class: 'ui-diff__code', text: `${sign}${l.text}` }),
    );
    return el;
  }

  /** Caixa do comentário logo abaixo da linha (uma por linha aberta de cada vez). */
  private edit(anchor: HTMLElement, at: Omit<RunFeedbackComment, 'text'>): void {
    const open = anchor.nextElementSibling;
    if (open?.classList.contains('ui-diff__editor')) return void open.querySelector('textarea')?.focus();
    const box = h('textarea', { class: 'ui-rename__input', attrs: { rows: 3, maxlength: RUN_FEEDBACK_TEXT_MAX, placeholder: tr('Comentário para o agente'), 'aria-label': tr('Comentário da linha {0}', [at.line]) } });
    box.addEventListener('keydown', (e) => e.stopPropagation());
    box.addEventListener('keyup', (e) => e.stopPropagation());
    const editor = h('div', { class: 'ui-diff__editor' });
    const add = () => {
      const text = box.value.trim();
      if (!text || !this.review) return;
      if (this.review.comments.length >= RUN_FEEDBACK_MAX) return this.deps.say(tr('No máximo {0} comentários por envio.', [RUN_FEEDBACK_MAX]), true);
      const c = { ...at, text };
      this.review.comments.push(c);
      editor.replaceWith(this.note(c));
      this.updateSend();
    };
    editor.append(box, h('div', { class: 'ui-vboards__actions' }, button(tr('Adicionar'), add, true), button(tr('Cancelar'), () => editor.remove())));
    anchor.after(editor);
    box.focus();
  }

  private note(c: RunFeedbackComment): HTMLElement {
    const el = h('div', { class: 'ui-diff__note' }, h('span', { text: c.text }));
    el.append(
      iconButton(
        ICONS.close,
        tr('Tirar o comentário'),
        () => {
          if (this.review) this.review.comments = this.review.comments.filter((x) => x !== c);
          el.remove();
          this.updateSend();
        },
        'ui-icon-btn--sm',
      ),
    );
    return el;
  }

  private updateSend(): void {
    const n = this.review?.comments.length ?? 0;
    setText(this.sendBtn, tr('Enviar comentários ao agente ({0})', [n]));
    this.sendBtn.disabled = !n || this.busy;
  }

  private async send(): Promise<void> {
    const r = this.review;
    if (!r || !r.comments.length || this.busy) return;
    this.busy = true;
    this.updateSend();
    try {
      await this.deps.send(r.runId, r.index, r.comments);
      this.deps.say(tr('Comentários enviados: o agente voltou a trabalhar no item.'));
      this.close();
    } catch (err) {
      this.deps.say(tr('Não enviou: {0}', [(err as Error).message]), true);
    } finally {
      this.busy = false;
      this.updateSend();
    }
  }
}
