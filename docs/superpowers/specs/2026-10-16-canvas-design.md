# Quadro (canvas view) — desenho

Segunda vista do escritório, alternando com a pixel art (que continua sendo a padrão).

## Como abre
- Botão "Quadro" no grupo de painéis da barra superior e atalho **V** (livre: a ajuda lista `/ ? F T L P M O 0 [ ] WASD + −`).
- Ao abrir, a pixel art fica suspensa (`world.setSuspended`), como na cena da cidade; O/+/− e os botões de câmera passam a mover o quadro.
- Abrir a cidade fecha o quadro; na cidade o botão some.

## O que mostra
- Um **cartão por agente principal** (linha de agente da casa: avatar, nome, chip da conta/provedor, papel, status com cor, título, atividade) + nome da sala; borda esquerda na cor do status.
- **Subagentes** como chips dentro do cartão; o fio vertical à esquerda dos chips é a ligação principal → subagente. Subagente sem o principal presente ganha cartão próprio.
- **Linhas de conversa** entre agentes: `GET /api/chat/links` (`[{from, to, at}]`), consultado a cada 15 s só com o quadro aberto. 404/erro = sem linhas. Pares nos dois sentidos viram uma linha; conversa nos últimos 10 min fica em destaque (tracejado animado; parado com reduced-motion). Subagente liga pelo cartão do principal.
- **Notas adesivas**: duplo clique no fundo cria; texto, 4 cores (botão alterna), arrastar pela barra, apagar.

## Interação
- Arrastar o fundo move; roda/pinça (touchpad ou dois dedos) aproxima em volta do cursor; "Enquadrar tudo" (botão no quadro, O, botão da barra) cabe tudo na área livre.
- Cartões arrastáveis; clique (sem arrasto) seleciona o agente e abre a mesma gaveta (inclusive o chat). Cartões são botões focáveis (Tab, Enter); focar um cartão fora da tela leva a câmera até ele.

## Persistência
`localStorage["habblaud:canvas"] = {pos: {agentId: {x,y}}, notes: [...]}`, lido com tolerância a lixo; acesso em try/catch. Posições: até 300 (corta as mais antigas pela ordem de inserção). Notas no servidor: fora do escopo.

## Arrumação
Tamanho fixo (cartão 264×156, nota 180×140) para que geometria não dependa do DOM. Cartões novos vão para a coluna da sua sala (ordem das salas = `slot`), na primeira vaga livre de cima para baixo sem cobrir cartões nem notas.

## Código
- `client/src/ui/canvas-model.ts` (+ teste): cartões, arrumação, ligações, câmera, persistência — puro.
- `client/src/ui/canvas.ts`: DOM (sem dependências novas).
