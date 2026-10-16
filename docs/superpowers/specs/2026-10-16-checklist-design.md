# AgenticOffice — Checklist que roda sozinho (projeto 3 de 6)

Data: 2026-10-16 · Repositório: `C:\Projects\habblaud` · Depende da Base e dos Agentes conversando.

## Objetivos

- Rodar uma lista como **um agente novo do chat por item**, em sequência (contexto limpo a cada item, como um task
  runner). O próximo item começa quando a rodada do agente anterior termina.
- Fontes: (a) checklist em Markdown colado (`- [ ] texto` ou `* [ ] texto`; `- [x]` e linhas que não são tarefa são
  ignoradas; até 50 itens); (b) tarefas do VBoards escolhidas na lista pendente: cada item fica ligado à tarefa e é
  concluído (done/failed com o resumo) pelo fluxo que já existe (`VBoardsService.begin` com as opções do chat).
- Opções = as da janela de abrir agente (pasta conhecida, agente, modelo, conta, papel, permissão, limites por item) +
  contexto comum (vai antes de cada item) + cópia isolada + "parar se um item falhar" (ligado por padrão).
- Progresso ao vivo: cada item pendente / rodando / feito / falhou / interrompido / cancelado, com o agente dele
  (clique seleciona); Parar / Continuar; com cópia isolada, Juntar / Descartar no fim.

## Não-objetivos

- Itens em paralelo, dependências entre itens, repetir um item, editar a lista depois de aprovada.
- Gatilhos (projeto 4) e começar uma lista sozinho por qualquer motivo.
- Subtarefas aninhadas no Markdown (cada linha `- [ ]`, de qualquer nível, é um item).

## A regra de segurança (decisão do dono do produto)

Nada começa sem a pessoa. A lista só roda quando ela clica **"Rodar lista"** na tela de confirmação, que mostra **todos**
os itens que vão rodar, a pasta, o agente/provedor, o papel e o modo de permissão. Esse clique (o `POST /api/chat/runs`)
é a aprovação da lista inteira. Ela pode parar a qualquer momento: Parar interrompe o agente atual e cancela o resto.
Reiniciar o servidor **não** retoma nada: o item que rodava vira "interrompido", a lista fica pausada e só volta com
"Continuar" (outro clique).

## Decisões

- **Servidor** (`server/chat/runs.ts`): fila sequencial; um item = `ChatService.open` (ou `vboards.begin` para itens do
  VBoards) com o prompt `contexto comum + texto do item`. O fim vem do `onTurnEnd` + `turnOutcome`: respondeu = feito;
  senão = falhou (e a lista para, se a opção estiver ligada). O resumo do item é a última resposta (cortada).
- **Uma lista rodando por vez** (409 para a segunda): é uma fila, não um enxame.
- **Os agentes da lista não contam no limite de 8 agentes do chat** (só um roda por vez); ficam no escritório e no
  quadro como qualquer outro e o usuário fecha quando quiser.
- **Cópia isolada da lista**: um git worktree criado pela própria lista e compartilhado pelos itens (o agente roda nele;
  a sala continua sendo a do projeto). Juntar/Descartar ficam na lista (não em cada agente). Descartar devolve os
  agentes da lista à pasta do projeto.
- **Persistência** em `<dataDir>/chat/runs.json` (escrita atômica, leitura tolerante a lixo, últimas 20 listas).
- **Continuar** vale para lista pausada (reinício) ou parada por falha: o item interrompido volta a pendente e roda num
  agente novo. "Parar" é definitivo (o resto vira cancelado).
- **Rotas** (só pelo próprio computador, a mesma trava do `/api/chat`): `POST /api/chat/runs` (cria = aprova; valida
  itens e opções antes de abrir qualquer agente), `GET /api/chat/runs`, `GET /api/chat/runs/:id`,
  `POST /api/chat/runs/:id/{stop,continue,merge,discard}`.
- **UI**: botão "Rodar lista" na barra do topo (ao lado do Novo agente) e "Rodar como lista" na fila do VBoards com
  duas ou mais tarefas marcadas. Painel: colar/ver itens + opções → confirmação com todos os itens → progresso.

## Limites conhecidos

- Item do VBoards interrompido por reinício não roda de novo no "Continuar": a tarefa já está ligada ao agente antigo
  (o VBoards a conclui pelo resultado dele) e o item falha com o motivo.
- O chat do Codex/Antigravity não pede aprovação por ação (Base): na confirmação aparece o modo efetivo.
