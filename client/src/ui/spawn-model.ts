// Janela de abrir agente pelo chat (ui/spawn.ts): o formulário, os padrões e o pedido para POST /api/chat/agents.
import type { ChatLimits, ChatOpenRequest, ChatPermission } from '../../../shared/chat';
import { tr } from '../../../shared/i18n';
import type { Provider } from '../../../shared/types';

export interface OpenForm {
  folder: string;
  provider: Provider;
  account?: string;
  model: string;
  roleId: string;
  permission: ChatPermission;
  isolated: boolean;
  limitUsd: string;
  limitTokens: string;
  limitMinutes: string;
  name: string;
  prompt: string;
  vboardsTaskId?: string;
}

const PROVIDER_NAMES: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

export function providerLabel(p: Provider): string {
  return PROVIDER_NAMES[p];
}

/** Claude se disponível (senão o primeiro disponível), automático, sem papel, sem cópia, sem limites. */
export function defaultForm(folder: string, providers: Array<{ id: Provider; available: boolean }>): OpenForm {
  const provider = providers.find((p) => p.id === 'claude' && p.available)?.id ?? providers.find((p) => p.available)?.id ?? 'claude';
  return { folder, provider, model: '', roleId: '', permission: 'auto', isolated: false, limitUsd: '', limitTokens: '', limitMinutes: '', name: '', prompt: '' };
}

export function askDisabledReason(provider: Provider): string | undefined {
  if (provider === 'claude') return undefined;
  return tr('O {0} não pede aprovação ação por ação: roda sempre no automático, com acesso total.', [PROVIDER_NAMES[provider]]);
}

/** Número digitado (aceita vírgula). undefined = vazio; null = inválido. */
function amount(raw: string): number | undefined | null {
  const t = raw.trim().replace(',', '.');
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function toRequest(f: OpenForm): ChatOpenRequest | { error: string } {
  const prompt = f.prompt.trim();
  if (!prompt) return { error: tr('Escreva o pedido para o agente.') };
  const limits: ChatLimits = {};
  // US$ só o Claude informa; os outros contam tokens.
  const money = f.provider === 'claude' ? amount(f.limitUsd) : undefined;
  const tokens = f.provider === 'claude' ? undefined : amount(f.limitTokens);
  const minutes = amount(f.limitMinutes);
  if (money === null || tokens === null || minutes === null) return { error: tr('Os limites precisam ser números maiores que zero.') };
  if (money !== undefined) limits.maxCostUsd = money;
  if (tokens !== undefined) limits.maxTokens = Math.round(tokens);
  if (minutes !== undefined) limits.maxTurnMinutes = minutes;
  const name = f.name.trim();
  const model = f.model.trim();
  return {
    folder: f.folder,
    provider: f.provider,
    ...(f.account ? { account: f.account } : {}),
    ...(model ? { model } : {}),
    ...(f.roleId ? { roleId: f.roleId } : {}),
    permission: f.provider === 'claude' ? f.permission : 'auto',
    isolated: f.isolated,
    limits,
    ...(name ? { name } : {}),
    prompt,
    ...(f.vboardsTaskId ? { vboardsTaskId: f.vboardsTaskId } : {}),
  };
}
