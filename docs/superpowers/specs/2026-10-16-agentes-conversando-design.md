# AgenticOffice — Agentes conversando entre si (projeto 2 de 6)

Data: 2026-10-16 · Repositório: `C:\Projects\habblaud` · Depende da Base (`2026-10-16-base-orquestracao-design.md`).

## Objetivos

- O Orquestrador (e qualquer agente Claude Code aberto pelo chat do escritório) consegue **ver** os outros agentes do
  chat, **abrir** um agente novo e **mandar mensagem** a outro agente, recebendo a resposta final dele.
- Tudo visível: o cartão de aprovação no escritório e no chat de quem pede; a mensagem no chat de quem recebe, com o
  remetente ("De Ana (Orquestrador)"); atividades no Office dos dois; linhas no quadro (GET `/api/chat/links`).

## Não-objetivos

- Dar as ferramentas ao Codex e ao Antigravity: eles só **recebem** pedidos (são "chamados").
- Sessões abertas fora do escritório (VS Code/terminal) como remetentes ou destinatários.
- Guardar as ligações em disco: o histórico do quadro é em memória (últimas 50).

## A regra de aprovação (decisão do dono do produto, sem exceção)

Um agente **nunca** abre nem manda mensagem a outro agente sozinho. Toda delegação (abrir um agente, mandar mensagem a
outro) vira um cartão de aprovação para a pessoa, e só acontece depois de ela aprovar, **nos dois modos de permissão**
(automático e pedir aprovação). Recusado ou sem resposta (prazo) = a ferramenta devolve um texto de recusa a quem pediu
e nada acontece. Não há flag que pule isso nem "aprovar e não perguntar de novo" nesses cartões.

## Ferramentas (MCP `habblaud`, só para agentes Claude do chat)

| Ferramenta | Aprovação | O que faz |
|---|---|---|
| `office_list_agents` | não (só leitura) | Agentes do chat: id, nome, papel, provedor, pasta, status, resumo da última resposta. |
| `office_open_agent` {provider?, role?, folder?, name?, prompt} | **sim** | Abre um agente do chat e devolve o id. |
| `office_ask_agent` {agentId, message, timeoutMinutes? = 30} | **sim** | Entrega a mensagem (fila até o destino ficar livre), espera a rodada dele terminar e devolve a resposta final. |

Texto dos cartões: quem pede e exatamente o quê ("Ana (Orquestrador) quer abrir um agente Dev (Claude Code) em
frontline-rush para: …"; "Ana (Orquestrador) quer mandar para Bia (Dev): …").

## Decisões

- **O agente aberto por outro nasce em "pedir aprovação"**, qualquer que seja o modo de quem pediu (Claude). Codex e
  Antigravity não têm aprovação por ação (Base): nascem no automático, e o cartão diz o provedor antes da aprovação.
- **Pasta**: só pastas que o escritório conhece; sem pasta, a de quem pede.
- **Papel**: pelo id ou pelo nome (sem diferenciar maiúsculas).
- **MCP sempre ligado no Claude do chat**: o servidor `habblaud` entra por `--mcp-config` em todas as rodadas. No
  automático sem `--strict-mcp-config` (os MCPs do usuário continuam); em "pedir aprovação" continua o
  `--permission-prompt-tool` (e o strict, como na Base). As ferramentas `office_*` não passam pelo permission tool: elas
  mesmas pedem a aprovação (sem cartão duplo).
- **Esperas longas**: a resposta do `tools/call` vai por SSE com batidas a cada 15 s quando o cliente aceita
  `text/event-stream` (não estoura prazos de cabeçalho/corpo do HTTP); o Claude roda com `MCP_TOOL_TIMEOUT` de 2,5 h.
- **Guardas do `office_ask_agent`**: não pode pedir a si mesmo; ciclo (A espera B e B pede A, direto ou em cadeia) é
  erro; no máximo 4 esperas ao mesmo tempo; prazo de 1 a 120 min. A espera é registrada antes do cartão, então dois
  pedidos cruzados não ficam presos esperando aprovação.
- **Prazo vencido**: a ferramenta devolve "sem resposta em N min"; se a mensagem ainda estava na fila, sai da fila; se
  já estava rodando, o destino continua (a resposta aparece no chat dele).
- **Rodada de quem pediu terminou/parou** (Parar, limite de tempo): os cartões abertos dele são soltos no registro de
  permissões e as esperas dele são canceladas (a mensagem na fila sai).
- **A mensagem entregue** leva para a CLI do destino um cabeçalho com o remetente; no chat aparece só o texto, com o
  campo `from` no item.

## Segurança

- O endpoint MCP continua só do loopback e com o Bearer do próprio agente (`/api/chat/mcp/:agentId`); o token vive em
  memória e muda a cada reinício. Ele vai no argv do `claude` (como na Base): outro processo do mesmo usuário pode lê-lo.
- O agente só escolhe ids de agentes e pastas que o escritório já conhece; nenhum caminho arbitrário.
- A aprovação é obrigatória no servidor (não depende do modo nem do prompt do papel); recusa/prazo/soltura = nada roda.
- Mensagens e prompts passam pelo `maskSecrets` ao virar itens do chat, como na Base.
