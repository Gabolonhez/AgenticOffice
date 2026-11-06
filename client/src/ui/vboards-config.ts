// Configurações › VBoards por pasta (GET/POST /api/vboards/config): lê e grava o `git config --local vboards.*` da
// pasta escolhida, a única fonte (o servidor usa a mesma). Só pastas conhecidas. Pela porta do celular é só leitura:
// vboards.check é um comando de shell e vboards.auto abre agentes sozinho. Some com o VBoards desligado (404) ou sem
// acesso (403). Junto, os avisos ao dono (GET/POST /api/vboards/notify): ntfy, WhatsApp (WA-AKG), o canal e o horário
// do briefing do Jarvis, globais e com a mesma regra (a chave do WA-AKG nunca volta à página). JarvisConfigGroup: o
// provedor e o modelo do Jarvis (GET/POST /api/chat/jarvis/settings), só para quem pode ser o Jarvis.
import { tr } from '../../../shared/i18n';
import { h, setHidden, setText } from './dom';
import { LojaPanel } from './loja-panel';
import { shortPath } from './spawn';

interface NotifyView {
  configured?: boolean;
  waConfigured?: boolean;
  channel?: string;
  url?: string;
  wa?: { url: string; sessionId: string; ownerJid: string; apiKeySet?: boolean } | null;
  briefing?: { time: string; days: number[] };
  closing?: { time: string; days: number[] };
  weekly?: { time: string; days: number[] };
  editable?: boolean;
}

const ROUTINES = ['briefing', 'closing', 'weekly'] as const;
const routineLabel = (k: (typeof ROUTINES)[number]): string => (k === 'closing' ? tr('Horário do fechamento do dia') : k === 'weekly' ? tr('Horário do resumo semanal') : tr('Horário do briefing'));

interface FolderConfig { card?: string; auto: boolean; provider: string; budget: number; check?: string; qa?: string; reviewer: string; reviewerModel?: string; copy?: string; ship?: string; base?: string; remote?: string; deploy?: string; ciMinutes?: number; store?: string; storeWorkflow?: string; otaChannel?: string; versionBump?: string; autoMerge?: string; riskPaths?: string; riskLines?: number }

const PROVIDERS = ['claude', 'codex', 'agy'];

export class VBoardsConfigGroup {
  readonly el: HTMLElement;
  private readonly folder = h('select', { class: 'ui-rename__input', attrs: { 'aria-label': tr('Pasta do projeto') } });
  private readonly card = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 100, placeholder: tr('nome da pasta') } });
  private readonly auto = h('input', { type: 'checkbox' });
  private readonly provider = select(PROVIDERS);
  private readonly budget = h('input', { class: 'ui-rename__input', type: 'number', attrs: { min: '0.01', step: '0.5' } });
  private readonly check = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 500, placeholder: 'npm ci && npm test' } });
  private readonly reviewer = select(PROVIDERS);
  private readonly reviewerModel = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 60 } });
  private readonly qa = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 500, placeholder: 'npx playwright test --project=qa' } });
  private readonly copy = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 500, placeholder: '.env, apps/web/.env.local' } });
  private readonly ship = h('select', { class: 'ui-rename__input' }, h('option', { attrs: { value: 'off' }, text: tr('off: nunca sobe') }), h('option', { attrs: { value: 'pr' }, text: tr('pr: abre só o PR') }), h('option', { attrs: { value: 'merge' }, text: tr('merge: com CI verde, faz o merge') }));
  private readonly base = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 100, placeholder: 'main' } });
  private readonly remote = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 100, placeholder: 'origin' } });
  private readonly deploy = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 200, placeholder: tr('none ou workflow:deploy.yml') } });
  private readonly ciMinutes = h('input', { class: 'ui-rename__input', type: 'number', attrs: { min: '1', max: '240', step: '1' } });
  private readonly autoMerge = h('select', { class: 'ui-rename__input' }, h('option', { attrs: { value: 'off' }, text: tr('off: sempre com PIN') }), h('option', { attrs: { value: 'low' }, text: tr('low: risco baixo sobe sem PIN') }));
  private readonly riskPaths = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 1000, placeholder: 'src/core/**, *.tf' } });
  private readonly riskLines = h('input', { class: 'ui-rename__input', type: 'number', attrs: { min: '1', step: '50', placeholder: '300' } });
  /** O autoMerge como veio do servidor: ligar pede uma confirmação explícita. */
  private loadedAutoMerge = 'off';
  private readonly storeMode = h('select', { class: 'ui-rename__input' }, h('option', { attrs: { value: 'off' }, text: tr('off: sem loja') }), h('option', { attrs: { value: 'ota' }, text: tr('ota: atualização OTA depois do deploy') }), h('option', { attrs: { value: 'ota+build' }, text: tr('ota+build: também build e envio à loja') }));
  private readonly storeWorkflow = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 100, placeholder: 'store.yml' } });
  private readonly otaChannel = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 40, placeholder: 'preview' } });
  private readonly versionBump = select(['auto', 'patch', 'minor', 'major']);
  private readonly loja = new LojaPanel();
  private readonly ntfy = h('input', { class: 'ui-rename__input', type: 'url', attrs: { maxlength: 300, placeholder: 'https://ntfy.sh/<tópico>' } });
  private readonly channel = h('select', { class: 'ui-rename__input' }, h('option', { attrs: { value: 'ntfy' }, text: 'ntfy' }), h('option', { attrs: { value: 'whatsapp' }, text: 'WhatsApp' }), h('option', { attrs: { value: 'both' }, text: tr('os dois') }));
  private readonly waUrl = h('input', { class: 'ui-rename__input', type: 'url', attrs: { maxlength: 300, placeholder: 'https://wa.exemplo.com' } });
  private readonly waSession = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 80, placeholder: 'pessoal' } });
  private readonly waOwner = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 60, placeholder: '5511999999999@s.whatsapp.net' } });
  private readonly waKey = h('input', { class: 'ui-rename__input', type: 'password', attrs: { maxlength: 200, autocomplete: 'off' } });
  /** As rotinas do Jarvis com horário (server/vboards/ntfy.ts ROUTINES): briefing, fechamento do dia e semanal. */
  private readonly routines = ROUTINES.map((key) => ({
    key,
    label: routineLabel(key),
    time: h('input', { class: 'ui-rename__input', type: 'time' }) as HTMLInputElement,
    days: [tr('dom'), tr('seg'), tr('ter'), tr('qua'), tr('qui'), tr('sex'), tr('sáb')].map((d) => ({ label: d, box: h('input', { type: 'checkbox' }) as HTMLInputElement })),
  }));
  private readonly ntfySave = h('button', { class: 'ui-btn', type: 'button', text: tr('Gravar avisos'), on: { click: () => void this.storeNtfy() } });
  private readonly ntfyStatus = h('p', { class: 'ui-set__hint', attrs: { role: 'status', 'aria-live': 'polite' } });
  private readonly ntfyGroup = h(
    'div',
    { hidden: true },
    h('h3', { text: tr('Aviso no celular (ntfy)') }),
    h('p', { class: 'ui-set__hint', text: tr('Opcional: o endereço de um tópico do ntfy (https://ntfy.sh/<tópico> ou um servidor seu). Vai só o título do card e "aguardando revisão", "plano pronto" ou "falhou"; nunca código, diff nem resumo. Quem souber o tópico lê os avisos: use um nome difícil.') }),
    row(tr('Tópico do ntfy'), this.ntfy),
    h('p', { class: 'ui-set__hint', text: tr('WhatsApp (opcional), por um WA-AKG seu: os mesmos avisos, as respostas do Jarvis e o briefing vão só para o número do dono; as mensagens "Jarvis ..." que você manda chegam pelo VBoards (token vb_). A chave fica só neste computador.') }),
    row(tr('Endereço do WA-AKG'), this.waUrl),
    row(tr('Sessão do WA-AKG'), this.waSession),
    row(tr('Número do dono (JID)'), this.waOwner),
    row(tr('Chave do WA-AKG (x-api-key)'), this.waKey),
    row(tr('Avisos por'), this.channel),
    h('p', { class: 'ui-set__hint', text: tr('Briefing do Jarvis: um resumo no horário escolhido (vazio = desligado), na conversa dele, no ntfy (a manchete) e no WhatsApp (inteiro).') }),
    h('p', { class: 'ui-set__hint', text: tr('O fechamento do dia (feito, travado, o que fica para amanhã) e o resumo semanal (por projeto, com o custo) saem pelos mesmos canais; vêm desligados.') }),
    ...this.routines.flatMap((r) => [row(r.label, r.time), h('div', { class: 'ui-chat__row' }, ...r.days.map((d) => h('label', { class: 'ui-spawn__check' }, d.box, h('span', { text: d.label }))))]),
    this.ntfySave,
    this.ntfyStatus,
  );
  private readonly save = h('button', { class: 'ui-btn', type: 'button', text: tr('Gravar na pasta'), on: { click: () => void this.store() } });
  private readonly status = h('p', { class: 'ui-set__hint', attrs: { role: 'status', 'aria-live': 'polite' } });
  private readonly fields = [this.card, this.auto, this.provider, this.budget, this.check, this.qa, this.reviewer, this.reviewerModel, this.copy, this.ship, this.base, this.remote, this.deploy, this.ciMinutes, this.storeMode, this.storeWorkflow, this.otaChannel, this.versionBump, this.autoMerge, this.riskPaths, this.riskLines];

  constructor() {
    this.folder.addEventListener('change', () => void this.load());
    this.el = h(
      'div',
      { class: 'ui-set-group', hidden: true },
      h('h3', { text: tr('VBoards por pasta') }),
      h('p', { class: 'ui-set__hint', text: tr('Fica no git config --local da pasta. A abertura automática vem desligada: ligada, as subtarefas da fila que só combinam com esta pasta viram uma lista numa cópia isolada, sem push, e terminam esperando a sua revisão. Juntar é sempre um clique seu.') }),
      row(tr('Pasta'), this.folder),
      row(tr('Card (vboards.card)'), this.card),
      h('label', { class: 'ui-spawn__check' }, this.auto, h('span', { text: tr('Abrir sozinho (vboards.auto)') })),
      row(tr('Agente (vboards.provider)'), this.provider),
      row(tr('Orçamento por item, US$ (vboards.budget)'), this.budget),
      row(tr('Checagens (vboards.check): a cópia não tem node_modules nem .env, então o comando instala o que precisar'), this.check),
      row(tr('QA visual (vboards.qa): roda depois das checagens e grava PNGs na pasta $HABBLAUD_QA_DIR; falhar só avisa'), this.qa),
      row(tr('Revisor (vboards.reviewer)'), this.reviewer),
      row(tr('Modelo do revisor (vboards.reviewerModel)'), this.reviewerModel),
      row(tr('Copiar para a cópia isolada (vboards.copy): caminhos relativos separados por vírgula; ficam fora do Juntar'), this.copy),
      row(tr('Subir (vboards.ship)'), this.ship),
      h('p', { class: 'ui-set__hint', text: tr('Subir: off = nunca sobe; pr = abre só o PR; merge = com CI verde faz o merge (e o deploy do repo). Exige o token do GitHub e o PIN.') }),
      row(tr('Branch base (vboards.base)'), this.base),
      row(tr('Remoto (vboards.remote)'), this.remote),
      row(tr('Deploy (vboards.deploy)'), this.deploy),
      row(tr('Minutos de espera do CI (vboards.ciMinutes)'), this.ciMinutes),
      row(tr('Merge automático (vboards.autoMerge)'), this.autoMerge),
      h('p', { class: 'ui-set__hint is-error', text: tr('low: isto permite subir sem PIN tarefas de risco baixo (push, PR e merge com CI verde, e o deploy do repo). Só quando todas valem: vboards.ship=merge, plano aprovado no VBoards, portão sem volta de correção, risco final baixo e CI de PR verde (repo sem CI de PR nunca sobe sozinho).') }),
      row(tr('Caminhos de risco alto (vboards.riskPaths): globs separados por vírgula'), this.riskPaths),
      row(tr('Linhas do diff acima das quais o risco é médio (vboards.riskLines)'), this.riskLines),
      row(tr('Loja (vboards.store)'), this.storeMode),
      h('p', { class: 'ui-set__hint', text: tr('Só para apps Expo. Depois do deploy, o Habblaud dispara o workflow do repo (o CI roda o eas): OTA em canal que não é production sai sozinho; OTA em production, build e envio à loja pedem o PIN.') }),
      row(tr('Workflow da loja (vboards.storeWorkflow)'), this.storeWorkflow),
      row(tr('Canal do OTA automático (vboards.otaChannel)'), this.otaChannel),
      row(tr('Versão nova (vboards.versionBump)'), this.versionBump),
      this.loja.el,
      this.save,
      this.status,
      this.ntfyGroup,
    );
    void this.start();
    void this.loadNtfy();
  }

  private async loadNtfy(): Promise<void> {
    try {
      const res = await fetch('/api/vboards/notify', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as NotifyView;
      this.showNtfy(body);
      setHidden(this.el, false);
      setHidden(this.ntfyGroup, false);
    } catch {
      // sem VBoards: fica escondido
    }
  }

  private showNtfy(b: NotifyView): void {
    const editable = b.editable === true;
    this.ntfy.value = editable ? (b.url ?? '') : '';
    this.waUrl.value = b.wa?.url ?? '';
    this.waSession.value = b.wa?.sessionId ?? '';
    this.waOwner.value = b.wa?.ownerJid ?? '';
    this.waKey.value = '';
    this.waKey.placeholder = b.wa?.apiKeySet ? tr('guardada (deixe vazio para manter)') : '';
    this.channel.value = b.channel ?? 'ntfy';
    for (const r of this.routines) {
      r.time.value = b[r.key]?.time ?? '';
      r.days.forEach((d, i) => (d.box.checked = !!b[r.key]?.days.includes(i)));
    }
    for (const f of [this.ntfy, this.waUrl, this.waSession, this.waOwner, this.waKey, this.channel, ...this.routines.flatMap((r) => [r.time, ...r.days.map((d) => d.box)])]) f.disabled = !editable;
    setHidden(this.ntfySave, !editable);
    if (!editable) {
      const on = [b.configured ? 'ntfy' : '', b.waConfigured ? 'WhatsApp' : ''].filter(Boolean).join(', ');
      setText(this.ntfyStatus, on ? tr('Ligado ({0}). Só muda pelo próprio computador.', [on]) : tr('Desligado. Só muda pelo próprio computador.'));
    }
  }

  private async storeNtfy(): Promise<void> {
    try {
      const wa = this.waUrl.value.trim() ? { url: this.waUrl.value, sessionId: this.waSession.value, ownerJid: this.waOwner.value, ...(this.waKey.value ? { apiKey: this.waKey.value } : {}) } : { url: '' };
      const schedules = Object.fromEntries(this.routines.map((r) => [r.key, { time: r.time.value, days: r.days.flatMap((d, i) => (d.box.checked ? [i] : [])) }]));
      const res = await fetch('/api/vboards/notify', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: this.ntfy.value, channel: this.channel.value, wa, ...schedules }) });
      const body = (await res.json().catch(() => ({}))) as NotifyView & { error?: string };
      if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
      this.showNtfy(body);
      setText(this.ntfyStatus, body.configured || body.waConfigured ? tr('Gravado: os avisos vão pelo canal escolhido.') : tr('Aviso no celular desligado.'));
      this.ntfyStatus.classList.remove('is-error');
    } catch (err) {
      setText(this.ntfyStatus, tr('Não gravou: {0}', [(err as Error).message]));
      this.ntfyStatus.classList.add('is-error');
    }
  }

  private async start(): Promise<void> {
    try {
      const res = await fetch('/api/vboards/config', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { folders?: Array<{ path: string; name: string }> };
      const folders = body.folders ?? [];
      if (!folders.length) return;
      this.folder.replaceChildren(...folders.map((f) => h('option', { attrs: { value: f.path }, text: `${f.name} — ${shortPath(f.path)}` })));
      setHidden(this.el, false);
      await this.load();
    } catch {
      // sem VBoards: o grupo fica escondido
    }
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch(`/api/vboards/config?folder=${encodeURIComponent(this.folder.value)}`, { credentials: 'same-origin', cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { config?: FolderConfig; editable?: boolean; error?: string };
      if (!res.ok || !body.config) throw new Error(body.error ?? tr('erro {0}', [res.status]));
      this.show(body.config, body.editable === true);
    } catch (err) {
      this.say((err as Error).message, true);
    }
  }

  private show(c: FolderConfig, editable: boolean): void {
    this.card.value = c.card ?? '';
    this.auto.checked = c.auto;
    this.provider.value = c.provider;
    this.budget.value = String(c.budget);
    this.check.value = c.check ?? '';
    this.qa.value = c.qa ?? '';
    this.reviewer.value = c.reviewer;
    this.reviewerModel.value = c.reviewerModel ?? '';
    this.copy.value = c.copy ?? '';
    this.ship.value = c.ship ?? 'off';
    this.base.value = c.base ?? '';
    this.remote.value = c.remote ?? '';
    this.deploy.value = c.deploy ?? '';
    this.ciMinutes.value = String(c.ciMinutes ?? 30);
    this.autoMerge.value = this.loadedAutoMerge = c.autoMerge === 'low' ? 'low' : 'off';
    this.riskPaths.value = c.riskPaths ?? '';
    this.riskLines.value = c.riskLines ? String(c.riskLines) : '';
    this.storeMode.value = c.store ?? 'off';
    this.storeWorkflow.value = c.storeWorkflow ?? '';
    this.otaChannel.value = c.otaChannel === 'preview' ? '' : (c.otaChannel ?? '');
    this.versionBump.value = c.versionBump ?? 'auto';
    void this.loja.setFolder(this.folder.value, !!c.store && c.store !== 'off');
    for (const f of this.fields) f.disabled = !editable;
    setHidden(this.save, !editable);
    this.say(editable ? '' : tr('Só leitura pela porta do celular: mude no próprio computador.'));
  }

  private async store(): Promise<void> {
    const config = { card: this.card.value, auto: this.auto.checked, provider: this.provider.value, budget: this.budget.value, check: this.check.value, qa: this.qa.value, reviewer: this.reviewer.value, reviewerModel: this.reviewerModel.value, copy: this.copy.value, ship: this.ship.value, base: this.base.value, remote: this.remote.value, deploy: this.deploy.value, ciMinutes: this.ciMinutes.value, store: this.storeMode.value === 'off' ? '' : this.storeMode.value, storeWorkflow: this.storeWorkflow.value, otaChannel: this.otaChannel.value, versionBump: this.versionBump.value === 'auto' ? '' : this.versionBump.value, autoMerge: this.autoMerge.value, riskPaths: this.riskPaths.value, riskLines: this.riskLines.value };
    if (config.autoMerge === 'low' && this.loadedAutoMerge !== 'low' && !confirm(tr('Ligar o merge automático? Isto permite subir sem PIN tarefas de risco baixo desta pasta.'))) return;
    try {
      const res = await fetch('/api/vboards/config', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: this.folder.value, config }) });
      const body = (await res.json().catch(() => ({}))) as { config?: FolderConfig; editable?: boolean; error?: string };
      if (!res.ok || !body.config) throw new Error(body.error ?? tr('erro {0}', [res.status]));
      this.show(body.config, body.editable === true);
      this.say(tr('Gravado no git config da pasta.'));
    } catch (err) {
      this.say(tr('Não gravou: {0}', [(err as Error).message]), true);
    }
  }

  private say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
  }
}

interface ProductsView { products?: unknown[]; error?: string; editable?: boolean }

/**
 * Configurações › Produtos (GET/POST /api/vboards/products): o registro ~/.habblaud/products.json, um produto do VBoards
 * (o card) com os repositórios dele. Editado como JSON; o servidor valida tudo e devolve a frase do erro. Some com o
 * VBoards desligado; pela porta do celular é só leitura.
 */
export class ProductsConfigGroup {
  readonly el: HTMLElement;
  private readonly json = h('textarea', { class: 'ui-rename__input ui-products__json', attrs: { 'aria-label': tr('Produtos (JSON)'), spellcheck: 'false', rows: 10 } });
  private readonly save = h('button', { class: 'ui-btn', type: 'button', text: tr('Gravar os produtos'), on: { click: () => void this.store() } });
  private readonly status = h('p', { class: 'ui-set__hint', attrs: { role: 'status', 'aria-live': 'polite' } });

  constructor() {
    this.el = h(
      'div',
      { class: 'ui-set-group', hidden: true },
      h('h3', { text: tr('Produtos e repositórios') }),
      h('p', {
        class: 'ui-set__hint',
        text: tr('Um produto do VBoards pode ter vários repositórios. A subtarefa diz qual no começo do texto, ex.: "[server] corrigir o login" (o papel ou o nome da pasta); produto com um repositório só usa ele, e sem dizer num produto com vários nada abre sozinho. Cards sem produto seguem pelo nome da pasta ou vboards.card.'),
      }),
      h('p', { class: 'ui-set__hint', text: '[{"id": "peptpro", "name": "PeptPro", "cardName": "PeptPro", "repos": [{"path": "D:\\\\Projects\\\\peptpro\\\\helix-server", "role": "server", "deploy": "none"}, {"path": "...", "role": "app", "store": "ota"}]}]' }),
      this.json,
      this.save,
      this.status,
    );
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch('/api/vboards/products', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      this.show((await res.json()) as ProductsView);
      setHidden(this.el, false);
    } catch {
      // sem VBoards: fica escondido
    }
  }

  private show(v: ProductsView): void {
    this.json.value = JSON.stringify(v.products ?? [], null, 2);
    const editable = v.editable !== false;
    this.json.readOnly = !editable;
    setHidden(this.save, !editable);
    this.say(v.error ? tr('O arquivo atual não vale: {0}', [v.error]) : editable ? '' : tr('Só muda pelo próprio computador.'), !!v.error);
  }

  private async store(): Promise<void> {
    let products: unknown;
    try {
      products = JSON.parse(this.json.value || '[]');
    } catch (err) {
      return this.say(tr('JSON inválido: {0}', [(err as Error).message]), true);
    }
    try {
      const res = await fetch('/api/vboards/products', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ products }) });
      const body = (await res.json().catch(() => ({}))) as ProductsView;
      if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
      this.show(body);
      this.say(tr('Gravado.'));
    } catch (err) {
      this.say(tr('Não gravou: {0}', [(err as Error).message]), true);
    }
  }

  private say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
  }
}

interface JarvisSettingsView { provider: string; model?: string; editable?: boolean; providers: Array<{ id: string; available: boolean; reason?: string }>; note?: string; error?: string }

/** Provedor e modelo do Jarvis: só os que rodam sem ferramentas internas e com o MCP do escritório (o resto, com o motivo). */
export class JarvisConfigGroup {
  readonly el: HTMLElement;
  private readonly provider = h('select', { class: 'ui-rename__input', attrs: { 'aria-label': tr('Provedor do Jarvis') } });
  private readonly model = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 60, placeholder: 'sonnet' } });
  private readonly reasons = h('ul', { class: 'ui-set__hint' });
  private readonly save = h('button', { class: 'ui-btn', type: 'button', text: tr('Gravar o Jarvis'), on: { click: () => void this.store() } });
  private readonly status = h('p', { class: 'ui-set__hint', attrs: { role: 'status', 'aria-live': 'polite' } });

  constructor() {
    this.el = h(
      'div',
      { class: 'ui-set-group', hidden: true },
      h('h3', { text: 'Jarvis' }),
      h('p', { class: 'ui-set__hint', text: tr('O orquestrador do escritório. Trocar o provedor começa uma conversa nova (a memória fica). Ele roda sem ferramentas próprias: só as do escritório, e as que mudam algo pedem a sua aprovação.') }),
      row(tr('Provedor'), this.provider),
      row(tr('Modelo (vazio = o padrão da CLI)'), this.model),
      this.reasons,
      this.save,
      this.status,
    );
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch('/api/chat/jarvis/settings', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      this.show((await res.json()) as JarvisSettingsView);
      setHidden(this.el, false);
    } catch {
      // chat desligado: fica escondido
    }
  }

  private show(v: JarvisSettingsView): void {
    this.provider.replaceChildren(...v.providers.map((p) => h('option', { attrs: { value: p.id, ...(p.available ? {} : { disabled: 'true' }) }, text: p.id === 'antigravity' ? 'agy' : p.id })));
    this.provider.value = v.provider;
    this.model.value = v.model ?? '';
    this.reasons.replaceChildren(...v.providers.filter((p) => !p.available && p.reason).map((p) => h('li', { text: `${p.id === 'antigravity' ? 'agy' : p.id}: ${p.reason}` })));
    const editable = v.editable !== false;
    this.provider.disabled = !editable;
    this.model.disabled = !editable;
    setHidden(this.save, !editable);
    setText(this.status, v.note ?? (editable ? '' : tr('Só muda pelo próprio computador.')));
  }

  private async store(): Promise<void> {
    try {
      const res = await fetch('/api/chat/jarvis/settings', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: this.provider.value, model: this.model.value }) });
      const body = (await res.json().catch(() => ({}))) as JarvisSettingsView;
      if (!res.ok) throw new Error(body.error ?? tr('erro {0}', [res.status]));
      this.show({ ...body, editable: true });
      if (!body.note) setText(this.status, tr('Gravado.'));
      this.status.classList.remove('is-error');
    } catch (err) {
      setText(this.status, tr('Não gravou: {0}', [(err as Error).message]));
      this.status.classList.add('is-error');
    }
  }
}

interface VoiceView {
  engine: string;
  configured?: string;
  provider: string;
  voice?: string;
  keySet: Record<string, boolean>;
  ttsUrl?: string;
  ttsVoice?: string;
  ttsModel?: string;
  editable?: boolean;
  error?: string;
}

/**
 * Voz do Jarvis em tela cheia (GET/POST /api/chat/jarvis/voice): o motor, a chave do realtime (gravada no computador, em
 * ~/.habblaud/voice.json; nunca volta para a página) e o TTS local. Só muda pelo próprio computador.
 */
export class JarvisVoiceGroup {
  readonly el: HTMLElement;
  private readonly engine = h(
    'select',
    { class: 'ui-rename__input', attrs: { 'aria-label': tr('Motor de voz') } },
    h('option', { attrs: { value: '' }, text: tr('Automático (realtime se houver chave)') }),
    h('option', { attrs: { value: 'realtime' }, text: tr('Realtime (OpenAI): conversa natural, pago') }),
    h('option', { attrs: { value: 'browser' }, text: tr('Navegador: grátis') }),
    h('option', { attrs: { value: 'local' }, text: tr('Local: Whisper + TTS do computador') }),
  );
  private readonly provider = h(
    'select',
    { class: 'ui-rename__input', attrs: { 'aria-label': tr('Provedor realtime') } },
    h('option', { attrs: { value: 'openai' }, text: 'OpenAI Realtime' }),
    h('option', { attrs: { value: 'gemini' }, text: tr('Gemini Live (em breve)') }),
  );
  private readonly key = h('input', { class: 'ui-rename__input', type: 'password', attrs: { maxlength: 300, autocomplete: 'off' } });
  private readonly voice = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 60, placeholder: 'marin' } });
  private readonly ttsUrl = h('input', { class: 'ui-rename__input', type: 'url', attrs: { maxlength: 300, placeholder: 'http://127.0.0.1:8880/v1/audio/speech' } });
  private readonly ttsVoice = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 60, placeholder: 'alloy' } });
  private readonly ttsModel = h('input', { class: 'ui-rename__input', type: 'text', attrs: { maxlength: 60, placeholder: 'tts-1' } });
  private readonly save = h('button', { class: 'ui-btn', type: 'button', text: tr('Gravar a voz'), on: { click: () => void this.store() } });
  private readonly forget = h('button', { class: 'ui-btn', type: 'button', text: tr('Apagar a chave'), on: { click: () => void this.store(true) } });
  private readonly status = h('p', { class: 'ui-set__hint', attrs: { role: 'status', 'aria-live': 'polite' } });
  private readonly fields = [this.engine, this.provider, this.key, this.voice, this.ttsUrl, this.ttsVoice, this.ttsModel];

  constructor() {
    this.el = h(
      'div',
      { class: 'ui-set-group', hidden: true },
      h('h3', { text: tr('Voz do Jarvis') }),
      h('p', { class: 'ui-set__hint', text: tr('A tela cheia do Jarvis (tecla J). Pedidos por voz contam como de fora (o microfone ouve o ambiente): ações pedem cartão, e o PIN é sempre digitado, nunca falado. A chave fica só neste computador; o navegador recebe um token que vale por 2 minutos.') }),
      row(tr('Motor'), this.engine),
      row(tr('Provedor realtime'), this.provider),
      row(tr('Chave da API (vazio = manter)'), this.key),
      row(tr('Voz do realtime'), this.voice),
      row(tr('TTS local: URL (OpenAI-compatível, /v1/audio/speech)'), this.ttsUrl),
      row(tr('TTS local: voz'), this.ttsVoice),
      row(tr('TTS local: modelo'), this.ttsModel),
      h('div', { class: 'ui-chat__row' }, this.save, this.forget),
      this.status,
    );
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch('/api/chat/jarvis/voice', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      this.show((await res.json()) as VoiceView);
      setHidden(this.el, false);
    } catch {
      // chat desligado: fica escondido
    }
  }

  private show(v: VoiceView): void {
    this.engine.value = v.configured ?? '';
    this.provider.value = v.provider;
    this.key.value = '';
    this.key.placeholder = v.keySet[v.provider] ? tr('guardada neste computador') : tr('sem chave');
    this.voice.value = v.voice ?? '';
    this.ttsUrl.value = v.ttsUrl ?? '';
    this.ttsVoice.value = v.ttsVoice ?? '';
    this.ttsModel.value = v.ttsModel ?? '';
    const editable = v.editable !== false;
    for (const f of this.fields) f.disabled = !editable;
    setHidden(this.save, !editable);
    setHidden(this.forget, !editable || !v.keySet[v.provider]);
    setText(this.status, editable ? tr('Em uso: {0}.', [v.engine]) : tr('Só muda pelo próprio computador.'));
  }

  private async store(forget = false): Promise<void> {
    const keyField = this.provider.value === 'gemini' ? 'geminiKey' : 'openaiKey';
    const body = forget
      ? { [keyField]: null }
      : { engine: this.engine.value, provider: this.provider.value, voice: this.voice.value, ttsUrl: this.ttsUrl.value, ttsVoice: this.ttsVoice.value, ttsModel: this.ttsModel.value, ...(this.key.value.trim() ? { [keyField]: this.key.value.trim() } : {}) };
    try {
      const res = await fetch('/api/chat/jarvis/voice', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const v = (await res.json().catch(() => ({}))) as VoiceView;
      if (!res.ok) throw new Error(v.error ?? tr('erro {0}', [res.status]));
      this.show(v);
      this.status.classList.remove('is-error');
    } catch (err) {
      setText(this.status, tr('Não gravou: {0}', [(err as Error).message]));
      this.status.classList.add('is-error');
    }
  }
}

function select(values: string[]): HTMLSelectElement {
  return h('select', { class: 'ui-rename__input' }, ...values.map((v) => h('option', { attrs: { value: v }, text: v })));
}

function row(label: string, field: HTMLElement): HTMLElement {
  return h('label', { class: 'ui-set' }, h('span', { class: 'ui-set__label', text: label }), field);
}

interface PinView { set: boolean; all: boolean; lockedUntil?: number; editable?: boolean; error?: string }

/**
 * Configurações › PIN de aprovação (GET/POST /api/approval-pin): os cartões críticos (os do Jarvis que mudam algo, e os
 * de agentes conversando entre si) só se aprovam com ele. Só muda pelo próprio computador; trocar, apagar ou ligar
 * "todos os cartões" pede o PIN atual. Os agentes rodam com o seu usuário e conseguem ler o hash: use uma frase.
 */
export class ApprovalPinGroup {
  readonly el: HTMLElement;
  private readonly state = h('p', { class: 'ui-set__hint' });
  private readonly pin = h('input', { class: 'ui-rename__input', type: 'password', attrs: { autocomplete: 'new-password', maxlength: 200, placeholder: tr('uma frase de 4 ou mais palavras') } });
  private readonly again = h('input', { class: 'ui-rename__input', type: 'password', attrs: { autocomplete: 'new-password', maxlength: 200 } });
  private readonly current = h('input', { class: 'ui-rename__input', type: 'password', attrs: { autocomplete: 'current-password', maxlength: 200 } });
  private readonly currentRow = row(tr('PIN atual'), this.current);
  private readonly all = h('input', { type: 'checkbox' });
  private readonly save = h('button', { class: 'ui-btn', type: 'button', text: tr('Gravar o PIN'), on: { click: () => void this.store(false) } });
  private readonly clear = h('button', { class: 'ui-btn', type: 'button', text: tr('Apagar o PIN'), on: { click: () => void this.store(true) } });
  private readonly status = h('p', { class: 'ui-set__hint', attrs: { role: 'status', 'aria-live': 'polite' } });

  constructor() {
    this.el = h(
      'div',
      { class: 'ui-set-group', hidden: true },
      h('h3', { text: tr('PIN de aprovação') }),
      h('p', {
        class: 'ui-set__hint',
        text: tr('Os cartões críticos (o que o Jarvis quer mudar e os pedidos entre agentes) só se aprovam com este PIN: assim um agente que roda no seu computador não aprova os próprios pedidos. Os agentes conseguem ler o arquivo do PIN (guardado com hash), então use uma frase longa, não um número.'),
      }),
      this.state,
      row(tr('PIN novo (mínimo 6 caracteres)'), this.pin),
      row(tr('Repita o PIN novo'), this.again),
      this.currentRow,
      h('label', { class: 'ui-set' }, this.all, h('span', { class: 'ui-set__label', text: tr('Exigir o PIN em todos os cartões') })),
      this.save,
      this.clear,
      this.status,
    );
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch('/api/approval-pin', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      this.show((await res.json()) as PinView);
      setHidden(this.el, false);
    } catch {
      // sem a rota (responder pelo escritório desligado): fica escondido
    }
  }

  private show(v: PinView): void {
    const editable = v.editable !== false;
    setText(
      this.state,
      v.lockedUntil
        ? tr('PIN definido. Bloqueado por PINs errados até {0}.', [new Date(v.lockedUntil).toLocaleTimeString()])
        : v.set
          ? tr('PIN definido{0}.', [v.all ? tr(' (pedido em todos os cartões)') : ''])
          : tr('Sem PIN: os cartões críticos não podem ser aprovados (o Jarvis continua com as ferramentas SAFE).'),
    );
    this.all.checked = v.all;
    setHidden(this.currentRow, !v.set);
    setHidden(this.clear, !v.set || !editable);
    for (const el of [this.pin, this.again, this.current, this.all]) el.disabled = !editable;
    setHidden(this.save, !editable);
    if (!editable) setText(this.status, tr('Só muda pelo próprio computador.'));
  }

  private async store(erase: boolean): Promise<void> {
    const pin = this.pin.value;
    if (!erase && pin && pin !== this.again.value) {
      setText(this.status, tr('Os dois PINs novos não são iguais.'));
      this.status.classList.add('is-error');
      return;
    }
    const body = { ...(erase ? { pin: '' } : pin ? { pin } : {}), all: this.all.checked, ...(this.current.value ? { current: this.current.value } : {}) };
    try {
      const res = await fetch('/api/approval-pin', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const v = (await res.json().catch(() => ({}))) as PinView;
      if (!res.ok) throw new Error(v.error ?? tr('erro {0}', [res.status]));
      for (const el of [this.pin, this.again, this.current]) el.value = '';
      this.show(v);
      setText(this.status, erase ? tr('PIN apagado.') : tr('Gravado.'));
      this.status.classList.remove('is-error');
    } catch (err) {
      setText(this.status, tr('Não gravou: {0}', [(err as Error).message]));
      this.status.classList.add('is-error');
    }
  }
}

interface GitHubView { set: boolean; source: 'env' | 'file' | null; editable: boolean; error?: string }

/** Configurações › Token do GitHub (GET/PUT /api/chat/github): o token do "Subir"; nunca volta para a página. */
export class GitHubTokenGroup {
  readonly el: HTMLElement;
  private readonly state = h('p', { class: 'ui-set__hint' });
  private readonly token = h('input', { class: 'ui-rename__input', type: 'password', attrs: { autocomplete: 'off', maxlength: 300 } });
  private readonly tokenRow = row(tr('Token novo'), this.token);
  private readonly save = h('button', { class: 'ui-btn', type: 'button', text: tr('Salvar'), on: { click: () => void this.store(this.token.value) } });
  private readonly clear = h('button', { class: 'ui-btn', type: 'button', text: tr('Remover'), on: { click: () => void this.store('') } });
  private readonly status = h('p', { class: 'ui-set__hint', attrs: { role: 'status', 'aria-live': 'polite' } });

  constructor() {
    this.token.addEventListener('keydown', (e) => e.stopPropagation());
    this.token.addEventListener('keyup', (e) => e.stopPropagation());
    this.el = h(
      'div',
      { class: 'ui-set-group', hidden: true },
      h('h3', { text: tr('Token do GitHub') }),
      h('p', { class: 'ui-set__hint', text: tr('Usado pelo "Subir" para abrir o PR, esperar o CI e fazer o merge. Crie um token fine-grained só para os repositórios que vão subir, com as permissões: Pull requests: leitura e escrita; Contents: leitura e escrita; Actions: leitura e escrita; Checks: leitura; Statuses: leitura (opcional: Administration leitura e escrita, para criar repositórios no futuro).') }),
      h('p', { class: 'ui-set__hint', text: tr('Fica só neste computador (arquivo com permissão 600) e nunca é mostrado de novo.') }),
      h('p', { class: 'ui-set__hint', text: tr('Limite: os agentes rodam com o seu usuário do sistema e conseguem ler os arquivos do Habblaud (~/.habblaud), inclusive este token. Por isso use só token fine-grained restrito aos repositórios necessários; token clássico (ghp_) não é aceito.') }),
      this.state,
      this.tokenRow,
      this.save,
      this.clear,
      this.status,
    );
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch('/api/chat/github', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      this.show((await res.json()) as GitHubView);
      setHidden(this.el, false);
    } catch {
      // sem a rota: fica escondido
    }
  }

  private show(v: GitHubView): void {
    const where = v.source === 'env' ? tr('variável HABBLAUD_GITHUB_TOKEN') : tr('arquivo ~/.habblaud/github.json');
    setText(this.state, v.set ? tr('Token definido ({0}).', [where]) : tr('Sem token: o "Subir" fica indisponível.'));
    const edit = v.editable && v.source !== 'env';
    setHidden(this.tokenRow, !edit);
    setHidden(this.save, !edit);
    setHidden(this.clear, !edit || !v.set);
    if (!v.editable) setText(this.status, tr('Só muda pelo próprio computador.'));
    else if (v.source === 'env') setText(this.status, tr('Definido pela variável de ambiente: mude por lá.'));
  }

  private async store(token: string): Promise<void> {
    try {
      const res = await fetch('/api/chat/github', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      const v = (await res.json().catch(() => ({}))) as GitHubView;
      if (!res.ok) throw new Error(v.error ?? tr('erro {0}', [res.status]));
      this.token.value = '';
      this.show(v);
      setText(this.status, token ? tr('Gravado.') : tr('Token removido.'));
      this.status.classList.remove('is-error');
    } catch (err) {
      setText(this.status, tr('Não gravou: {0}', [(err as Error).message]));
      this.status.classList.add('is-error');
    }
  }
}
