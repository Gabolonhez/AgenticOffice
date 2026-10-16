// Gatilhos (ui/triggers.ts): o formulário vira o corpo de POST/PUT /api/chat/triggers, e os textos da lista.
import { tr } from '../../../shared/i18n';
import { renderTemplate, type TriggerOutcome, type TriggerRule, type TriggerWhen } from '../../../shared/triggers';
import { toRequest, type OpenForm } from './spawn-model';

export type WhenKind = TriggerWhen['kind'];

export interface TriggerForm {
  name: string;
  enabled: boolean;
  windowMinutes: string;
  when: WhenKind;
  time: string;
  days: number[];
  minutes: string;
  /** Agente terminou: "agent:<id>" ou "role:<id>". */
  watch: string;
  alsoFailed: boolean;
  filesFolder: string;
  glob: string;
  debounceSec: string;
  action: 'open' | 'send';
  /** Abrir agente: os campos da janela de abrir agente, com o modelo do pedido em `prompt`. */
  open: OpenForm;
  sendTo: string;
  message: string;
}

const whole = (raw: string): number | undefined => {
  const n = Number(raw.trim());
  return raw.trim() && Number.isInteger(n) ? n : undefined;
};

export function toTriggerBody(f: TriggerForm): Record<string, unknown> | { error: string } {
  const name = f.name.trim();
  if (!name) return { error: tr('Dê um nome ao gatilho.') };
  const windowMinutes = whole(f.windowMinutes);
  if (windowMinutes === undefined || windowMinutes < 1) return { error: tr('Prazo de aprovação inválido.') };
  let when: TriggerWhen;
  if (f.when === 'schedule') {
    if (!/^\d\d:\d\d$/.test(f.time)) return { error: tr('Horário inválido (use HH:MM).') };
    if (!f.days.length) return { error: tr('Marque pelo menos um dia.') };
    when = { kind: 'schedule', time: f.time, days: f.days.length === 7 ? [] : [...f.days].sort() };
  } else if (f.when === 'interval') {
    const minutes = whole(f.minutes);
    if (minutes === undefined) return { error: tr('Intervalo inválido.') };
    when = { kind: 'interval', minutes };
  } else if (f.when === 'agent') {
    const [kind, id] = [f.watch.slice(0, f.watch.indexOf(':')), f.watch.slice(f.watch.indexOf(':') + 1)];
    if (!id || (kind !== 'agent' && kind !== 'role')) return { error: tr('Escolha o agente ou o papel.') };
    when = { kind: 'agent', ...(kind === 'agent' ? { agentId: id } : { roleId: id }), ...(f.alsoFailed ? { alsoFailed: true } : {}) };
  } else {
    if (!f.filesFolder) return { error: tr('Escolha a pasta.') };
    const debounceSec = whole(f.debounceSec);
    if (debounceSec === undefined) return { error: tr('Espera inválida.') };
    when = { kind: 'files', folder: f.filesFolder, ...(f.glob.trim() ? { glob: f.glob.trim() } : {}), debounceSec };
  }
  let act: Record<string, unknown>;
  if (f.action === 'send') {
    if (!f.sendTo) return { error: tr('Escolha o agente que recebe a mensagem.') };
    if (!f.message.trim()) return { error: tr('Escreva a mensagem.') };
    act = { kind: 'send', agentId: f.sendTo, message: f.message.trim() };
  } else {
    if (!f.open.folder) return { error: tr('Escolha a pasta.') };
    const req = toRequest(f.open);
    if ('error' in req) return req;
    const { prompt, vboardsTaskId: _v, ...options } = req;
    act = { kind: 'open', options, prompt };
  }
  return { name, enabled: f.enabled, windowMinutes, when, do: act };
}

/** Prévia do modelo com valores de exemplo. */
export function previewText(tpl: string, ruleName: string): string {
  return renderTemplate(tpl, {
    regra: ruleName || tr('Minha regra'),
    motivo: tr('arquivo mudou: {0}', ['src/a.ts']),
    arquivos: 'src/a.ts\nsrc/b.ts',
    saida: tr('(a última resposta do agente que terminou)'),
    agente: 'Ana (Dev)',
    hora: '09:00',
  });
}

export const dayNames = () => [tr('dom'), tr('seg'), tr('ter'), tr('qua'), tr('qui'), tr('sex'), tr('sáb')];

export function whenText(w: TriggerWhen, names: { agent(id: string): string; role(id: string): string }): string {
  switch (w.kind) {
    case 'schedule':
      return w.days.length ? tr('às {0} ({1})', [w.time, w.days.map((d) => dayNames()[d]).join(', ')]) : tr('todo dia às {0}', [w.time]);
    case 'interval':
      return tr('a cada {0} min', [w.minutes]);
    case 'agent': {
      const who = w.agentId ? names.agent(w.agentId) : tr('qualquer {0}', [names.role(w.roleId ?? '')]);
      return w.alsoFailed ? tr('quando {0} terminar ou falhar', [who]) : tr('quando {0} terminar', [who]);
    }
    case 'files':
      return tr('quando arquivos mudarem em {0}', [w.folder.split(/[\\/]/).pop() || w.folder]) + (w.glob ? ` (${w.glob})` : '');
  }
}

export function doText(r: TriggerRule, names: { agent(id: string): string; role(id: string): string }): string {
  if (r.do.kind === 'send') return tr('mandar mensagem para {0}', [names.agent(r.do.agentId)]);
  const role = r.do.options.roleId ? names.role(r.do.options.roleId) : '';
  return role ? tr('abrir um agente {0} em {1}', [role, r.do.options.folder.split(/[\\/]/).pop() || r.do.options.folder]) : tr('abrir um agente em {0}', [r.do.options.folder.split(/[\\/]/).pop() || r.do.options.folder]);
}

export function outcomeLabel(o: TriggerOutcome): string {
  return { fired: tr('esperando aprovação'), approved: tr('aprovado'), denied: tr('recusado'), expired: tr('sem resposta'), failed: tr('falhou') }[o];
}
