# AgenticOffice — Gatilhos (projeto 4 de 6)

Data: 2026-10-16 · Repositório: `C:\Projects\habblaud` · Depende da Base, dos Agentes conversando e do Checklist.

## Objetivos

- Regras "quando X, faça Y", ligadas e desligadas na página, guardadas em `<dataDir>/chat/triggers.json` (gravação
  atômica, como `runs.json`), com o histórico dos últimos 100 disparos.
- Quando (gatilho):
  1. **horário**: todo dia às HH:MM, nos dias da semana escolhidos (hora local da máquina);
  2. **intervalo**: a cada N minutos (mínimo 15);
  3. **agente terminou**: um agente do chat (um id, ou qualquer um com um papel) fechou a rodada com resposta
     (`turnOutcome = done`) e, se marcado, também quando falhou;
  4. **arquivos mudaram**: numa pasta conhecida, com filtro glob opcional (`src/**/*.ts`), juntando as mudanças por
     um tempo (padrão 60 s) e ignorando `.git`, `node_modules` e `dist`.
- Faça (ação):
  a. **abrir um agente do chat** com as mesmas opções da janela de abrir agente (provedor, modelo, conta, papel,
     permissão, cópia isolada, limites, nome, pasta) e um modelo de pedido;
  b. **mandar uma mensagem** a um agente do chat que já existe (pela fila do `deliver`).
- Modelos de texto com `{{regra}}`, `{{motivo}}`, `{{arquivos}}`, `{{saida}}` (última resposta do agente que terminou,
  até ~4000 caracteres, com `maskSecrets`), `{{agente}}` e `{{hora}}`.
- Rotas só do próprio computador (a mesma trava de `/api/chat`): `GET/POST /api/chat/triggers`,
  `PUT/DELETE /api/chat/triggers/:id`, `POST /api/chat/triggers/:id/test`, `GET /api/chat/triggers/history`.
- Painel "Gatilhos" na barra do topo, ao lado do "Rodar lista".

## Não-objetivos

- Aprovar sozinho, "sempre permitir" ou qualquer modo sem a pessoa.
- Recuperar disparos perdidos com o servidor desligado (horário e intervalo recomeçam a contar ao subir).
- Cron completo, fuso horário por regra, gatilhos de VBoards/GitHub, encadear ações numa regra só.

## A regra de segurança (decisão do dono do produto)

Um gatilho **nunca** abre nem manda mensagem a um agente sozinho. Todo disparo vira um **cartão de aprovação** no
escritório (o mesmo do "precisa de você" e dos cartões de delegação: `PermissionRegistry.registerChat` + `askHuman`).
O cartão diz qual regra disparou, por quê ("arquivo mudou: src/a.ts", "agente Ana terminou", "horário 09:00") e
exatamente o que vai acontecer (abrir o agente X com papel/provedor/pasta e o pedido inteiro, ou mandar a mensagem M ao
agente Y). Só roda depois de **Aprovar**. Recusar, "responder no terminal" ou não responder dentro da janela da regra
(padrão 30 min) = não roda, e o histórico registra. No máximo **um cartão pendente por regra**: disparos enquanto ele
espera são juntados (o histórico conta quantos). "Testar agora" também só cria o cartão.

## Decisões

- **Quem segura o cartão:** o registro de permissões guarda pedidos por agente do escritório. Cada regra com cartão
  pendente põe no escritório um agente próprio (`trigger:<id regra>`, papel "Gatilho", na sala da pasta da ação) só
  enquanto o cartão espera; ele sai quando a pessoa responde ou o prazo acaba. Assim o cartão entra no contador
  "precisa de você", no sino e nas notificações sem mudar a página.
- O cartão usa a ferramenta `Gatilho` (título "Gatilho(nome da regra)") e mostra no corpo o motivo, a ação e o texto
  completo. A prévia do cartão corta em 2000 caracteres; o texto inteiro fica no histórico do painel.
- O texto do modelo é montado **no disparo** (com os valores daquele momento) e é exatamente o que roda se aprovado.
  Antes do cartão, a ação é validada (`ChatService.check` / agente existe); inválida = disparo "falhou", sem cartão.
- Horário e intervalo: um relógio de 30 s compara com o próximo horário calculado em hora local (sem depender de
  fuso/horário de verão: soma dias no calendário local e monta a data com `new Date(y, m, d, h, min)`).
- Arquivos: `fs.watch` recursivo onde existe (Windows, macOS, Linux com Node 20+); se falhar, varredura das datas de
  modificação a cada 10 s. O observador é injetado nos testes.
- Agente terminou: mensagem mandada por um gatilho também conta (a pessoa aprova cada passo, então não há laço sem
  ela). O agente da própria regra não existe no chat, então não dispara nada.
- Regra desligada ou apagada com cartão pendente: o cartão some e o disparo fica "expirado". "Testar agora" vale também
  com a regra desligada (para conferir antes de ligar).
- O agente aberto pelo gatilho usa a permissão escolhida na regra (a pessoa viu e aprovou no cartão).
