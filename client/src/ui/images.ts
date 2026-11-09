// Imagens anexadas às mensagens (caixa do agente, chat da gaveta e overlay do Jarvis): leitura, redução e a UI de
// anexar (botão 📎, colar, miniaturas). O servidor aceita as mesmas constantes (png/jpeg/gif/webp, 4 por mensagem).
import type { Img } from '../net/store';
import { tr } from '../../../shared/i18n';
import { h, setHidden, setText } from './dom';

export type { Img };

export const IMAGES_PER_MESSAGE = 4;
export const IMAGE_MAX_BYTES = 3_750_000;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_SIDE = 1568;

function toBase64(blob: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => fail(new Error('read'));
    r.readAsDataURL(blob);
  });
}

function canvasBlob(c: HTMLCanvasElement, type: string, q?: number): Promise<Blob | null> {
  return new Promise((ok) => c.toBlob(ok, type, q));
}

/** Lê o arquivo; reduz a no máximo 1568 px e/ou abaixo de IMAGE_MAX_BYTES quando preciso. */
export async function prepareImage(file: File): Promise<Img | { error: string }> {
  const name = file.name || 'imagem';
  if (!IMAGE_TYPES.includes(file.type)) return { error: tr('{0}: só PNG, JPEG, GIF e WebP', [name]) };
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size <= IMAGE_MAX_BYTES) {
      bmp.close();
      return { name, type: file.type, data: await toBase64(file) };
    }
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const jpeg = file.type === 'image/jpeg';
    let out = await canvasBlob(c, jpeg ? 'image/jpeg' : 'image/png', jpeg ? 0.9 : undefined);
    if (out && out.size > IMAGE_MAX_BYTES) out = await canvasBlob(c, 'image/jpeg', 0.85);
    if (!out || out.size > IMAGE_MAX_BYTES) return { error: tr('{0}: imagem grande demais', [name]) };
    return { name, type: out.type, data: await toBase64(out) };
  } catch {
    return { error: tr('{0}: não deu para ler a imagem', [name]) };
  }
}

interface Entry {
  img: Img;
  url: string;
  el: HTMLElement;
}

/** Botão 📎 + miniaturas + erro curto. `el` vai ao lado do campo; `onPaste` liga-se ao campo de texto. */
export class ImageAttach {
  readonly el: HTMLElement;
  /** Só o botão 📎 (para pôr na fileira do campo). */
  readonly button: HTMLButtonElement;
  private entries: Entry[] = [];
  private pending = 0;
  private strip = h('div', { class: 'ui-imgs__strip' });
  private err = h('p', { class: 'ui-imgs__err', role: 'alert', hidden: true });
  private input = h('input', { type: 'file', hidden: true, attrs: { accept: IMAGE_TYPES.join(','), multiple: true } });

  constructor(private onChange: () => void = () => {}) {
    this.input.addEventListener('change', () => {
      void this.add([...(this.input.files ?? [])]);
      this.input.value = '';
    });
    this.button = h('button', { class: 'ui-btn ui-imgs__btn', type: 'button', text: '📎', title: tr('Anexar imagem'), attrs: { 'aria-label': tr('Anexar imagem') }, on: { click: () => this.input.click() } });
    this.el = h('div', { class: 'ui-imgs' }, this.strip, this.err, this.input);
    setHidden(this.strip, true);
  }

  images(): Img[] {
    return this.entries.map((e) => e.img);
  }

  /** Há imagem anexada ou ainda sendo preparada. */
  get busy(): boolean {
    return this.pending > 0;
  }

  /** Evento `paste` do campo de texto: pega as imagens da área de transferência (o texto colado segue normal). */
  onPaste = (e: ClipboardEvent): void => {
    const files = [...(e.clipboardData?.items ?? [])].filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => !!f);
    if (!files.length) return;
    e.preventDefault();
    void this.add(files);
  };

  async add(files: File[]): Promise<void> {
    this.say('');
    for (const f of files) {
      if (this.entries.length + this.pending >= IMAGES_PER_MESSAGE) return this.say(tr('No máximo {0} imagens por mensagem', [IMAGES_PER_MESSAGE]));
      this.pending++;
      this.onChange();
      const r = await prepareImage(f);
      this.pending--;
      if ('error' in r) this.say(r.error);
      else this.push(r, f);
      this.onChange();
    }
  }

  private push(img: Img, src: Blob): void {
    const url = URL.createObjectURL(src);
    const rm = h('button', { class: 'ui-imgs__rm', type: 'button', text: '×', title: tr('Remover imagem'), attrs: { 'aria-label': tr('Remover imagem') } });
    const el = h('span', { class: 'ui-imgs__thumb' }, h('img', { attrs: { src: url, alt: img.name } }), rm);
    const entry = { img, url, el };
    rm.addEventListener('click', () => {
      URL.revokeObjectURL(url);
      el.remove();
      this.entries = this.entries.filter((x) => x !== entry);
      setHidden(this.strip, !this.entries.length);
      this.onChange();
    });
    this.entries.push(entry);
    this.strip.append(el);
    setHidden(this.strip, false);
  }

  clear(): void {
    for (const e of this.entries) URL.revokeObjectURL(e.url);
    this.entries = [];
    this.strip.replaceChildren();
    setHidden(this.strip, true);
    this.say('');
    this.onChange();
  }

  private say(text: string): void {
    setText(this.err, text);
    setHidden(this.err, !text);
  }
}
