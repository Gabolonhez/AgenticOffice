// Pesquisa agendada de ideias: UMA rodada só de leitura (com WebSearch, se o agente tiver) resume oportunidades,
// concorrentes e avaliações de um produto e propõe ideias. O resultado é texto da web: contamina o turno, e criar os
// cards "ideas" (origem `research`) pede cartão (jarvis/tools.ts vboards_ideas_create).
import { maskSecrets } from '../../shared/activity';
import { tr } from '../../shared/i18n';
import type { TriggerRule } from '../../shared/triggers';
import { findDuplicate, type KnownItem } from './triage';

export const RESEARCH_IDEAS_MAX = 8;
export const RESEARCH_ORIGIN = 'research';

export interface ResearchIdea {
  title: string;
  description: string;
}

export interface ResearchResult {
  summary: string;
  ideas: ResearchIdea[];
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function researchPrompt(product: string, known: readonly string[]): string {
  return [
    'Você pesquisa ideias para um produto, em português do Brasil. Só leia e pesquise: não edite nada. Use a busca na web se tiver.',
    `Produto: ${cut(product, 100)}`,
    'Levante oportunidades, concorrentes e avaliações de usuários (lojas, fóruns). Resuma e proponha ideias novas, pequenas e concretas.',
    'Responda com UM único bloco ```json, sem nada depois dele:',
    `{"summary": "oportunidades, concorrentes e reviews em poucas linhas", "ideas": [{"title": "até 120 caracteres", "description": "o que e por quê, com a fonte"}]}`,
    `No máximo ${RESEARCH_IDEAS_MAX} ideias; não repita estas, que já existem:\n${known.slice(0, 80).map((t) => `- ${cut(t, 100)}`).join('\n') || '(nenhuma)'}`,
  ].join('\n');
}

export function parseResearchOutput(text: string): ResearchResult | undefined {
  const fences = [...text.matchAll(/```json[^\n]*\n([\s\S]*?)```/gi)];
  if (!fences.length) return undefined;
  let j: unknown;
  try {
    j = JSON.parse(fences[fences.length - 1][1]);
  } catch {
    return undefined;
  }
  const o = (j && typeof j === 'object' && !Array.isArray(j) ? j : {}) as Record<string, unknown>;
  const summary = typeof o.summary === 'string' ? cut(maskSecrets(o.summary.trim()), 3_000) : '';
  if (!summary || !Array.isArray(o.ideas)) return undefined;
  const ideas = o.ideas.flatMap((x) => {
    const i = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const title = typeof i.title === 'string' ? cut(maskSecrets(i.title.trim()), 120) : '';
    return title ? [{ title, description: typeof i.description === 'string' ? cut(maskSecrets(i.description.trim()), 2_000) : '' }] : [];
  });
  return { summary, ideas: ideas.slice(0, RESEARCH_IDEAS_MAX) };
}

/** Tira das ideias as que já existem (cards ou journal). */
export const freshIdeas = (ideas: readonly ResearchIdea[], known: readonly KnownItem[]): ResearchIdea[] => ideas.filter((i) => !findDuplicate(i.title, known));

/** A mensagem do agendamento "Pesquisar ideias para <produto>" (vai ao Jarvis; o resultado é dado de fora). */
export const researchMessage = (product: string): string =>
  `Pesquisar ideias para ${product}: chame vboards_research com o produto "${product}", resuma ao dono as oportunidades, concorrentes e reviews, e proponha criar as ideias com vboards_ideas_create (isso pede cartão de aprovação).`;

/** Modelo de gatilho pronto: toda segunda às 9h, mandando a mensagem ao Jarvis. */
export const researchTrigger = (product: string, jarvisId: string): Pick<TriggerRule, 'name' | 'enabled' | 'when' | 'do'> => ({
  name: cut(tr('Pesquisar ideias para {0}', [product]), 60),
  enabled: true,
  when: { kind: 'schedule', time: '09:00', days: [1] },
  do: { kind: 'send', agentId: jarvisId, message: researchMessage(product) },
});
