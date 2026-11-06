# Escritório autônomo: da demanda ao deploy, com Jarvis por voz e escritório 3D

Data: 2026-11-06. Base: este fork (AgenticOffice). O dono é o orquestrador e aprova nos pontos-chave.

## Princípios

- **VBoards é a fonte da verdade** (fila, status, registro por projeto). O Habblaud executa e reporta.
- **Fontes de demanda são plugáveis e opcionais.** WhatsApp, manual, pesquisa agendada e AppsBrain (via webhook → VBoards) só criam cards. Nenhuma é dependência.
- **Deploy é do repositório**, via CI (GitHub Actions). O Habblaud faz push + PR, acompanha o CI e marca `deployed`. Ele nunca roda SSH nem EAS.
- **Captação na nuvem, execução local.** O Habblaud roda no PC e retoma a fila quando liga.
- **Tudo chamativo.** Cada entrega visível passa por um polimento visual antes de ser dada como pronta.
- Mantêm-se as regras do projeto:
  - servidor sem dependências de runtime;
  - `tr()` em todo texto e `npm run i18n:check`;
  - não mexer em `shared/world` nem em `server/world`;
  - CHANGELOG em "Não lançado";
  - PIN e cartões continuam valendo, e turno contaminado nunca aprova.

## Trilha A: pipeline

### A1a: botão "Subir" (commit, push do branch e PR), com PIN

**Arquivos**
- `server/chat/worktree.ts`: extrair `commit(w, msg)` do `merge` e criar `push(repo, w, remote, sha)`.
  - Só aceita branch `agentic/*`.
  - Sem force.
  - Com `GIT_TERMINAL_PROMPT=0`.
  - Prazo de 2 min.
- `server/chat/github.ts` (novo): REST com `fetch`.
  - `parseRemote`, `openPr`, `checks`, `mergePr`, `workflowRuns`.
  - `ciVerdict` é uma função pura.
  - Sem `gh` e sem Octokit.
- `server/chat/ship.ts` (novo): máquina de estados gravada em `ChatRun.ship`: `pushing → pr → ci → merging → deploying → deployed | failed`.
- `runs.ts`: `ship(id)`. `http.ts`: rota `ship` com `{pin}`. `jarvis/tools.ts`: `runs_ship` sempre como cartão critical, e `runs_ship_status`.
- Client: botão "Subir" em `ui/runs.ts` e os campos novos em `ui/vboards-config.ts`.

**Configuração por pasta**
- `vboards.ship` = `off` | `pr` | `merge`.
- `vboards.base`.
- `vboards.remote`.

**Token**
- Vem de `HABBLAUD_GITHUB_TOKEN` ou de `~/.habblaud/github.json` (permissão 600).
- Tipo fine-grained, com os escopos: PR RW, Contents RW, Actions/Checks/Statuses R.

**Trava**
- O cartão mostra o SHA exato, o diffstat e o resultado do portão. O push e o merge ficam presos a esse SHA.
- Destacar no cartão qualquer diff em `.husky/`, `.githooks/` e `.github/workflows/`, porque hooks rodam com a credencial do dono.

### A1b: CI, merge, deployed e aviso

- Consulta a cada 60 s, com retomada após reiniciar e prazo `vboards.ciMinutes` (30).
- `ship=merge` com CI verde → merge pelo SHA aprovado.
- Deploy:
  - `vboards.deploy=workflow:<arquivo.yml>`: espera esse workflow na base.
  - `vboards.deploy=none`: o merge conta como deployed.
- No fim: VBoards `deployed`, aviso por ntfy e WhatsApp (`pr`, `ci_failed`, `deployed`) e descarte da cópia.

### A2: registro por projeto e status automático

- `server/chat/journal.ts` (novo): `~/.habblaud/chat/journal.jsonl`, com as etapas `queued` … `deployed`/`failed`/`discarded`. `projectLedger()` monta feito / fazendo / a fazer.
- Juntar e Descartar passam a avisar o VBoards (`settle`). `reportAll` envia `stage` e `prUrl`.
  - **Do lado do VBoards:** mapear `stage` para o status.
- Briefing: uma seção por projeto. Ferramentas `projects_status` e `release_notes`, com os dados de fora embrulhados.

**Relatórios do Jarvis**, todos a partir do journal mais o VBoards:
- Briefing da manhã (já existe; ganha a seção por projeto).
- **Fechamento do dia**, numa rotina agendada: o que foi feito, com os PRs; o que travou e por quê; o que fica para amanhã.
- **Semanal:** resumo por app, sugestão de versão para a loja e custo dos agentes.
- **Sob demanda, por voz:** "como está o dia", "o que falta no X", "o que está rodando".
- Na tela cheia (B1), o relatório sai falado e também em cartões. Os agendados também vão por WhatsApp e ntfy.

### A3: áudio do WhatsApp → Whisper local → Jarvis

- `api.ts`: `InboxMessage.audio` e `inboxAudio(id)`.
  - **Do lado do VBoards:** guardar a mídia do WA-AKG por pouco tempo.
- `jarvis/service.ts`: transcreve com `createWhisperTranscriber` e responde "Entendi: «…»". O turno fica sempre contaminado.

### A4: risco e merge automático

- O Refinar devolve `risk` e `riskWhy`. `server/chat/risk.ts`: `diffRisk` determinístico. O risco final é o maior entre o da IA e o calculado.
- `vboards.autoMerge=low` é desligado por padrão e só se liga com PIN. Exige todas as condições:
  - plano aprovado;
  - portão sem volta de correção;
  - risco baixo;
  - CI verde.

### A6: lançamento nas lojas (apps Expo)

Os apps são todos Expo: `helix-app` (PeptPro), `menopro-app`, `voer/app`, `amem/app`, `expire-app` e `puro-app`. O `expire-app` e o `puro-app` ainda não têm `eas.json`, e nenhum repositório tem CI.

**Dois caminhos**
- **Mudança só de JS:** `eas update` (OTA) no CI, depois do merge. Sem revisão da loja.
  - Respeitar o `runtimeVersion`: mudança nativa nunca vai por OTA.
- **Mudança nativa ou versão nova:** `eas build` mais `eas submit` no CI → TestFlight e faixa interna do Play.
  - O CI decide o caminho: se o fingerprint nativo mudou, vai por build.

**Pacote de versão**
- `release_cut(app)`: o Jarvis agrupa as tarefas `deployed` desde a última versão e gera o texto da novidade em pt/en/es a partir do journal.
- O pedido de revisão na loja (App Store Connect CLI / Play API, ou EAS Submit) **sempre exige cartão e PIN**, porque é público e irreversível.
- Configuração: `vboards.store` = `off` | `ota` | `ota+build`.
- O texto da novidade, que veio dos títulos dos PRs, conta como dado de fora.

### A7: projeto novo a partir do molde

O molde é `D:\Projects\app-base` (`base-app`, `base-server`, `base-web`, `PLAYBOOK.md`, `DESIGN.md`).

**Fluxo**
1. Você pede por voz ou WhatsApp ("Jarvis, quero um app de X").
2. O Jarvis faz as perguntas de briefing (público, nome, monetização, quais partes) e gera a spec e o plano.
3. Você aprova o plano.
4. O agente copia o molde para uma pasta nova em `D:\Projects\<nome>` e personaliza (nome, bundle id, cores pelo `DESIGN.md`).
5. O agente segue o `PLAYBOOK.md`.

**Ações externas**, todas sempre com cartão e PIN:
- Criar o repositório no GitHub (privado por padrão, pela API).
  - O token precisa de Administration write, ou usar uma etapa manual.
- Criar o projeto no VBoards, com os cards iniciais vindos da spec.
- Criar o projeto no EAS.

**Configuração automática do projeto novo**
- Git config da pasta: `check`, `ship`, `deploy`, `store`.
- Workflows de CI e de deploy e `eas.json` vindos do molde, para o projeto já nascer no pipeline.

**No escritório**, aparece uma sala nova. No 3D, um funcionário é "contratado" para a mesa dela.

**Ferramenta nova:** `projects_create`, sempre como cartão critical.

### A5: AppsBrain como fonte (opcional, fora deste repo)

- No `nucleo-server`: um evento de cluster de feedback acima de um limite → webhook HMAC → Edge Function do VBoards cria uma ideia. Precisa do mapeamento app ↔ repo.

## Trilha B: visual

### B1: Jarvis em tela cheia com orb e voz em tempo real

**Interface**
- Overlay no `#ui`, aberto pelo topbar.
  - Orb animado pelo `AnalyserNode`.
  - Transcrição ao vivo.
  - Cartões de aprovação no próprio overlay.
  - Interromper com um toque ou ao falar.

**Voz trocável** (Configurações do Jarvis)
- **Realtime (padrão):** OpenAI Realtime ou Gemini Live conversam e chamam as ferramentas do Jarvis como funções.
  - As ações continuam passando por cartão e PIN.
  - A chave fica em `~/.habblaud`.
- **Grátis:** `SpeechRecognition` do navegador mais `speechSynthesis`, com a voz seguindo `getLocale()`.
- **Local:** Whisper local (`server/dictation`) mais um TTS local (ex.: VoiceStudio/voicebox) por HTTP local.

**Servidor**
- Evento SSE "resposta nova do Jarvis", em vez de polling.

### B2: escritório 3D com toggle 2D/3D

- Segue o padrão da cidade: `cityHost` com o segundo canvas e `ui/world/scene-switch.ts`. `import('three')` sob demanda, com `three` como devDependency.
- **Pacote 3D da IACOM:** 13 escritórios, 82 móveis e 8 funcionários com 12 animações, em GLB.
  - **Não versionar os GLB.** A licença proíbe revender o pacote como está, e o repo é público. O Habblaud baixa o zip para `~/.habblaud/assets/3d` na primeira abertura e serve de lá.
- Cada agente vira um funcionário no posto do projeto dele. O status escolhe o clipe:
  - trabalhando → `digitando`;
  - esperando você → `acenando`;
  - parado → `cafe`;
  - revisão → `apresentando`.
- `server/http/static.ts`: MIME `.glb` → `model/gltf-binary`.

## Ordem sugerida

As trilhas A e B rodam em paralelo, em worktrees separadas: A1a → A1b → A2 → A3 → A4, e B1 → B2. A5 fica por último.

## O que não fazer

- Dependência de runtime no servidor.
- Exigir `gh`.
- Deploy feito pelo Habblaud.
- Force push ou push na base.
- Push pelo agente.
- WhatsApp, VBoards ou turno contaminado aprovando.
- AppsBrain como dependência.
- GLB do pacote dentro do repo.
