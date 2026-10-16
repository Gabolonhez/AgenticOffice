# Chat com agentes pelo celular

Projeto 5 do AgenticOffice. Usar o chat com agentes (abrir agente, conversar, checklist, gatilhos, canvas) pelo
celular, pela porta remota que já existe (login + HTTPS, `npm run remote:setup`).

## Objetivos

- O chat com agentes funciona pela porta do celular quando o dono do computador libera de propósito.
- No celular, o painel do chat, o formulário de abrir agente (com "Mais opções"), a checklist, os gatilhos e o canvas
  dão para usar com o dedo: alvos de toque de 40 px ou mais, campo de mensagem preso embaixo, popovers viram folhas de
  tela cheia em telas estreitas, nada que só aparece com o mouse em cima.

## Fora do escopo

- App nativo, notificações push, acesso fora da rede local (continua o que o `remote:setup` já oferece).
- Terminal interativo (pty) e Habblaud World pelo celular: continuam só no próprio computador.
- Novo tipo de login ou segundo fator.

## Regra de segurança (decisão do dono do produto)

Os agentes do chat podem ter acesso total ao PC. Comandá-los de fora do computador fica **desligado por padrão**:

- Só existe com o recurso novo `chat` em `HABBLAUD_REMOTE_ALLOW` (ou `npm run remote:setup -- --allow ...,chat`).
  Nunca entra no padrão (`permissions`) nem em listas que não o citem pelo nome.
- Exige o login da porta remota e HTTPS, como os outros recursos.
- Mesmo liberado:
  - o MCP do permission tool (`/api/chat/mcp/*`) nunca responde pela porta remota (403), nem com Bearer e Host imitado;
    na porta local continua loopback + Bearer do agente;
  - a pasta de trabalho continua limitada às pastas conhecidas (mesma validação do servidor);
  - cartões de delegação, gatilho e aprovação continuam exigindo aprovação; responder pelo celular só com
    `permissions` também liberado (como hoje).
- Ao subir com `chat` liberado, o servidor escreve um aviso no log.

## Decisões

- Servidor: `RemoteFeature` ganha `chat`. Em `app.ts`, `/api/chat/*` passa pela porta remota só com
  `trusted(req, 'chat')` e nunca para `/api/chat/mcp/*`. `chat/http.ts` recebe do `app.ts` um predicado
  `{is, trusted}`: pedido local continua com `ptyRequestProblem`; pedido remoto precisa de `trusted` (defesa em
  profundidade, mesmo critério nos dois lugares). O MCP recusa qualquer pedido remoto.
- `/api/access` diz `chat: true` na porta remota só com `chat` liberado (o cliente já esconde o chat sem ele).
- Cliente: só CSS dentro das convenções que já existem (`@media (max-width: …)` e `(pointer: coarse)`), sem lógica
  nova; o campo do chat segue o padrão `.ui-sec--msg` (fixo embaixo).

## Testes

- `parseAllow` aceita `chat` e o padrão não o inclui.
- Porta remota: sem `chat` → 403 em `/api/chat/*` e `access.chat = false`; com `chat` + login → chega às rotas;
  sem login → 401; `/api/chat/mcp/*` → 403 sempre pela porta remota; local sem Bearer → 401.
