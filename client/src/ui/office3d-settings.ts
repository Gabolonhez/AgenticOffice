// Configurações > Escritório 3D: importar o zip do pacote 3D (que o dono baixou) para o servidor extrair em
// ~/.habblaud/assets/3d. O pacote não vem no Habblaud: a licença dele não deixa redistribuir.
import { tr } from '../../../shared/i18n';
import { h, setText } from './dom';

const PACK_URL = 'https://iacom.com.br/buildoffice';

export class Office3dImportGroup {
  readonly el: HTMLElement;
  private readonly status = h('span', { class: 'ui-set__hint', attrs: { role: 'status' } });
  private readonly input = h('input', { type: 'file', hidden: true, attrs: { accept: '.zip,application/zip', 'aria-label': tr('Importar pacote 3D') } }) as HTMLInputElement;
  private readonly button: HTMLButtonElement;

  constructor() {
    this.button = h('button', { class: 'ui-btn', type: 'button', text: tr('Importar pacote 3D'), on: { click: () => this.input.click() } }) as HTMLButtonElement;
    this.input.addEventListener('change', () => {
      const file = this.input.files?.[0];
      this.input.value = '';
      if (file) void this.upload(file);
    });
    this.el = h(
      'div',
      { class: 'ui-set-group' },
      h('h3', { text: tr('Escritório 3D') }),
      h(
        'div',
        { class: 'ui-set' },
        h(
          'div',
          { class: 'ui-set__text' },
          h('span', { class: 'ui-set__label', text: tr('Pacote 3D') }),
          h('span', { class: 'ui-set__hint', text: tr('Para ver os agentes como funcionários num escritório 3D (botão 3D na barra do topo), baixe o pacote em {0} e importe o zip aqui. Ele fica só neste computador.', [PACK_URL]) }),
          this.status,
        ),
        this.button,
        this.input,
      ),
    );
    void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const r = await fetch('/api/assets3d');
      const s = r.ok ? ((await r.json()) as { installed: boolean; offices: number }) : null;
      setText(this.status, s?.installed ? tr('Pacote importado: {0} escritórios.', [s.offices]) : tr('Nenhum pacote importado ainda.'));
    } catch {
      setText(this.status, '');
    }
  }

  private async upload(file: File): Promise<void> {
    this.button.disabled = true;
    setText(this.status, tr('Importando {0}…', [file.name]));
    try {
      const data = await new Promise<string>((ok, fail) => {
        const fr = new FileReader();
        fr.onload = () => ok(String(fr.result).replace(/^data:[^,]*,/, ''));
        fr.onerror = () => fail(fr.error);
        fr.readAsDataURL(file);
      });
      const r = await fetch('/api/assets3d/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
      const body = (await r.json().catch(() => ({}))) as { error?: string; offices?: number };
      if (!r.ok) throw new Error(body.error ?? String(r.status));
      setText(this.status, tr('Pacote importado: {0} escritórios.', [body.offices ?? 0]));
      window.dispatchEvent(new Event('habblaud:3d-imported'));
    } catch (err) {
      setText(this.status, tr('Não consegui importar: {0}', [err instanceof Error ? err.message : String(err)]));
    } finally {
      this.button.disabled = false;
    }
  }
}
