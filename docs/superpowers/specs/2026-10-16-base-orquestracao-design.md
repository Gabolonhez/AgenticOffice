# AgenticOffice — Base da orquestração (projeto 1 de 6)

Data: 2026-10-16 · Repositório: `C:\Projects\habblaud` (fork "AgenticOffice" do Habblaud, MIT)

## Por quê

Hoje o AgenticOffice **mostra** os agentes (Claude Code, Codex, Antigravity) num escritório em pixel-art, responde
permissões e manda mensagens a sessões abertas fora dele. O usuário quer que ele vire o lugar onde ele **comanda** os
agentes: abre, conversa, acompanha e encadeia trabalho, sem pular entre terminais e janelas do VS Code.

A visão completa tem seis projetos, nesta ordem (cada um apoia o próximo):

1. **Base** (este documento): abrir e conversar com agentes dos três provedores por um chat dentro do escritório.
2. Agentes conversando entre si (um agente pede trabalho a outro; o Orquestrador delega).
3. Checklist que roda sozinho (uma lista, ou tasks do VBoards, vira um agente por item).
4. Gatilhos ("quando X acontecer, um agente faz Y").
5. Controle pelo celular (ampliando o acesso remoto que o Habblaud já tem).
6. Visão de canvas, alternável com o pixel-art.

Inspiração: Maestro (runmaestro.ai, AGPL-3.0) e Maestri (themaestri.app, fechado). **Só ideias**; nenhum código, prompt
ou formato de arquivo deles é copiado (ver Anti-objetivos).

## Objetivos

- Abrir um agente pelo escritório escolhendo provedor (Claude Code, Codex, Antigravity), e conversar com ele por um
  **chat no painel do agente**: mensagens, respostas, ferramentas usadas (recolhidas), status e uso/custo da rodada.
- A conversa continua entre pedidos (o agente lembra do que fez) e sobrevive a reinício do servidor.
- O personagem do agente aparece e se anima no pixel-art como qualquer outro agente.
- Permissão **automática por padrão**, configurável para "pedir aprovação" (aprovar/recusar no chat).
- Opções de abertura (ver abaixo), com papéis opcionais.
- As tasks do VBoards ("Iniciar") passam a abrir agentes por esta Base.

## Não-objetivos (agora)

- Agentes conversando entre si e o Orquestrador delegando de fato (projeto 2). Aqui o papel Orquestrador existe, mas sem
  poder abrir outros agentes.
- Checklist, gatilhos, celular, canvas (projetos 3 a 6).
- Multiusuário / equipe usando a mesma instância. Hoje é uma pessoa no próprio PC; o desenho não deve impedir isso depois.
- Trazer para o chat uma sessão aberta fora do escritório (VS Code/terminal). Essas continuam como hoje: aparecem, recebem
  mensagens pelo plugin e permissões pelo hook.
- Um app de desktop separado. Continua sendo o servidor Node + página no navegador.

## Anti-objetivos (seria um fracasso mesmo funcionando)

- Copiar código, prompts ou formatos do Maestro (AGPL contaminaria o projeto, que pode virar open source ou produto) ou
  do Maestri (fechado).
- Quebrar o que já funciona: monitoramento das sessões de fora, permissões pelo escritório, mensagens pelo plugin,
  botão VS Code/Antigravity, integração com o VBoards.
- Escrever arquivos do AgenticOffice dentro do repositório do projeto do usuário (ex.: papéis gravados no `CLAUDE.md`
  do projeto).

## Decisões do usuário

**Chat dentro do escritório, não terminal.** O agente aberto pelo escritório roda sem tela (modo "print" da CLI, saída
em JSON por linha). Cada mensagem do usuário é uma rodada que retoma a mesma conversa pelo id. As CLIs instaladas e
verificadas nesta máquina:

| Provedor | Rodada | Retomar | Modelo | Permissão |
|---|---|---|---|---|
| Claude Code (`claude`) | `-p --output-format stream-json --verbose` | `--resume <id>` | `--model` | `--permission-mode`, `--permission-prompt-tool` |
| Codex (`codex` 0.154) | `codex exec --json` | `codex exec resume <id>` | `-m` | `--sandbox` (sem aprovação interativa no `exec`) |
| Antigravity (`agy`) | `-p --output-format stream-json` | `--conversation <id>` | `--model` | `--mode accept-edits\|plan`, `--dangerously-skip-permissions`, `--sandbox` |

O `gemini` (Gemini CLI) não está instalado; o Antigravity cobre o Gemini via `agy`. As flags exatas são do `--help` de
cada CLI nesta máquina e devem ser reconferidas pelo builder.

**Permissão.** Padrão: o agente roda sozinho, com acesso total e **sem trava de ações irreversíveis** (push, deploy,
publicar, instalar pacotes; decisão do usuário em 2026-10-16: "qualquer coisa só pedir permissão ou perguntar, se não só
deixa ele fazer"). Ao abrir (ou como padrão nas configurações), dá para escolher "pedir aprovação": cada
comando/edição aparece no chat com Aprovar / Recusar (e, quando o provedor oferece, "aprovar e não perguntar de novo").

**Codex e Antigravity sem aprovação por ação.** Só o Claude Code consegue pedir aprovação ação por ação rodando sem
tela (`--permission-prompt-tool`). O `codex exec` e o `agy -p` não têm isso. Os três entram nesta Base; Codex e
Antigravity rodam sempre no automático com acesso total (Codex com internet). "Pedir aprovação" aparece só para o
Claude (nos outros, a opção fica desabilitada com o motivo). O chat aceita só pastas que o escritório já conhece.

**Opções ao abrir um agente.** Todas com padrão, para abrir com dois cliques; as extras ficam em "Mais opções":
- pasta e conta (como o "Novo agente" de hoje);
- provedor e modelo;
- papel (opcional — sem papel, o agente roda normal);
- permissão (automático / pedir aprovação);
- cópia isolada: o agente trabalha num git worktree num branch próprio; ao terminar, o usuário revisa e junta ou descarta;
- task do VBoards (opcional; vem preenchida quando se clica "Iniciar" numa task);
- limite de custo ou de tempo: passou, o agente para e avisa no chat;
- nome e personagem no pixel-art (sorteados se não escolhidos, como hoje).

**Papéis prontos** (editáveis, apagáveis; o usuário cria os seus):
- **Dev** — implementa de ponta a ponta, testa, commita em português, diz no fim o que mudou e o que ficou de fora.
- **QA** — só testa: roda o app (emulador/navegador), segue os fluxos principais, tira prints, devolve bugs com passo a
  passo. Não corrige.
- **Revisor** — lê o diff de outro agente e aponta bugs, riscos e faltas. Não edita.
- **Designer** — telas e visual, usando as skills de design do usuário (impeccable, ui-ux-pro-max…).
- **Pesquisador** — investiga antes de construir (docs, concorrentes, apps) e devolve relatório curto. Não mexe em código.
- **Orquestrador** — quebra um pedido grande e delega a outros agentes. Nesta Base só existe como papel; delegar é o
  projeto 2.

**Visual.** O escritório em pixel-art continua sendo a tela principal; a orquestração entra como painéis e ações.

**Processo.** Nada vai para o GitHub antes do usuário testar: commit local, build, reinício do servidor local, teste,
depois push. O usuário usa Windows 11; o servidor roda com `HABBLAUD_PTY=1`.

## Decisões minhas (o usuário pode trocar)

- **Docker**: o chat fica indisponível quando o servidor roda no Docker, com aviso na tela. O usuário roda o
  servidor direto no Windows; levar streaming e aprovações pela ponte do host não vale agora. Não quebrar o resto do
  modo Docker.
- **Limites**: o de **custo** soma todas as rodadas do agente (persistido junto com a conversa); quando o provedor não
  informa custo em dólar (ex.: Codex na assinatura), conta por tokens. O de **tempo** vale por rodada. Estourou: a
  rodada para, o chat avisa, e o agente só recebe nova mensagem se o usuário aumentar o limite.
- **Revisor sem o projeto 2**: é só o papel (instruções). O usuário diz na conversa o que revisar (ex.: o branch da
  cópia isolada de outro agente). Escolher "o agente a revisar" na janela fica para o projeto 2.
- **Orquestrador segue a permissão do agente**: no automático abrirá agentes sozinho; em "pedir aprovação" mostrará o
  plano e esperará o ok (vale quando o projeto 2 existir).
- **Papéis ficam fora do projeto do usuário**: guardados no diretório do AgenticOffice (ex.: `~/.habblaud/`) e entregues
  ao agente pelo mecanismo de instrução de cada CLI (prompt de sistema adicional, arquivo de instruções numa pasta
  própria etc.), nunca editando o `CLAUDE.md`/`AGENTS.md` do repositório.
- **Conversa persistida** no diretório do AgenticOffice (histórico do chat + id da conversa do provedor), para sobreviver
  a reinício e continuar com "retomar".
- **"Mais opções" recolhido** na janela de abrir agente.
- **Parar**: o chat tem um botão para interromper a rodada atual.

## Comportamento esperado do chat

- Envio com Enter (Shift+Enter quebra linha), como a caixa de mensagens atual.
- Durante a rodada: status ao vivo (pensando, ferramenta X, esperando aprovação), espelhado no personagem.
- Resposta final em texto/markdown; ferramentas usadas aparecem como itens recolhidos (comando, arquivo, resultado).
- Ao terminar a rodada: uso (tokens/custo quando o provedor informa) e tempo.
- Com cópia isolada: ao fim, resumo do diff e botões "Juntar" e "Descartar" (como juntar — merge, rebase, PR — fica com o
  builder; o padrão deve ser seguro e não apagar trabalho).
- Com task do VBoards: ao terminar, a subtask é marcada com o resumo, reaproveitando a integração existente
  (`server/vboards/`).

## Restrições

- Mesmas travas de segurança das rotas de terminal/novo agente: só acesso local (`ptyRequestProblem`, `isRemote`); o
  cliente manda ids, nunca caminhos arbitrários; pasta tem de ser uma conhecida.
- Sem shell ao chamar as CLIs (`execFile`/`spawn` com argv), pedido sempre depois de `--` ou por stdin.
- Segredos nunca vão para o snapshot, o cliente ou logs (`maskSecrets`).
- Textos em português com `tr()` e tradução em `shared/locales/{en,es,fr}.ts`.
- Testes no estilo da casa (vitest) para a lógica nova (parsers de cada CLI, decisão de permissão, persistência).
- Windows 11 é a plataforma principal; não quebrar macOS/Linux/Docker que o upstream suporta.

## Deixado ao builder

- Arquitetura interna (um "driver" por provedor atrás de uma interface comum é o caminho óbvio, mas não obrigatório).
- Como o agente do chat aparece no `Office` (novo kind/provider vs. reaproveitar as fontes que já leem transcripts).
- Mecanismo de aprovação por provedor (ex.: `--permission-prompt-tool` no Claude; aprovações do Codex; modos do `agy`).
- Formato de persistência, layout do chat, e como encaixar a janela de abrir agente no "Novo agente" existente.
- Se o "Iniciar" do VBoards migra nesta entrega ou logo depois (sem quebrar o fluxo atual no meio).
