// Lista que roda um agente por item (ui/runs.ts): o pedido de POST /api/chat/runs e os nomes dos estados.
import { tr } from '../../../shared/i18n';
import { RUN_ITEMS_MAX, type RunCreateRequest, type RunItemState, type RunState } from '../../../shared/runs';
import { toRequest, type OpenForm } from './spawn-model';

export type RunSource = Array<{ text: string; vboardsTaskId?: string }>;

export function toRunRequest(form: OpenForm, items: RunSource, context: string, stopOnFail: boolean): RunCreateRequest | { error: string } {
  if (!items.length) return { error: tr('A lista não tem itens: use linhas "- [ ] tarefa".') };
  if (items.length > RUN_ITEMS_MAX) return { error: tr('No máximo {0} itens por lista.', [RUN_ITEMS_MAX]) };
  const req = toRequest({ ...form, prompt: items[0].text, name: '' });
  if ('error' in req) return req;
  const { prompt: _p, isolated: _i, name: _n, vboardsTaskId: _v, ...options } = req;
  return { items, ...(context.trim() ? { context: context.trim() } : {}), stopOnFail, isolated: form.isolated, options };
}

export function runStateLabel(s: RunState): string {
  return { running: tr('rodando'), paused: tr('pausada (o servidor reiniciou)'), stopped: tr('parada'), failed: tr('parou com falha'), done: tr('terminou') }[s];
}

export function itemStateLabel(s: RunItemState): string {
  return { pending: tr('na fila'), running: tr('rodando'), done: tr('feito'), failed: tr('falhou'), interrupted: tr('interrompido'), canceled: tr('cancelado') }[s];
}

export const ITEM_MARK: Record<RunItemState, string> = { pending: '○', running: '▶', done: '✓', failed: '✗', interrupted: '⏸', canceled: '–' };
