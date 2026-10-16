# Base de orquestração (chat com agentes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Abrir pelo escritório agentes do Claude Code, Codex e Antigravity e conversar com eles por um chat no painel do agente. A conversa é retomável e persistida. O personagem se anima no pixel-art. Por padrão o agente roda no automático, com uma trava para ações irreversíveis. Há papéis, cópia isolada (worktree), limites de custo e tempo, e o "Iniciar" do VBoards passa a abrir agentes por esta Base.

**Architecture:** Um `ChatService` no servidor roda uma rodada por mensagem do usuário: dispara a CLI do provedor sem shell (`spawn` + argv, pedido por stdin ou `--print=`), lê o JSONL e retoma a mesma conversa pelo id. Os trechos específicos de cada provedor ficam em um driver (`invocation()` + parser de stream) atrás de uma interface comum. O agente entra no `Office` com id próprio (`chat:<uuid>`), e as fontes que leem sessões de fora passam a ignorá-lo. As aprovações do Claude passam pelo `--permission-prompt-tool`, servido pelo próprio servidor como MCP HTTP. Esse caminho reaproveita o `PermissionRegistry` e o cartão de permissão que já existem. Codex e Antigravity rodam em sandbox e com `git push` bloqueado pelo ambiente.

**Tech Stack:** Node ≥ 22.12 + TypeScript (`node:http` próprio, `node:child_process`, `node:readline`), Vite + DOM puro com o helper `h()`, vitest em ambiente `node`, git worktree.

**Spec:** `docs/superpowers/specs/2026-10-16-base-orquestracao-design.md`

## Global Constraints

- Só acesso local nas rotas novas: `ptyRequestProblem(req) === null` e `trusted(req)` sem feature remota (o `isRemote` nega).
- O cliente manda ids, nunca caminhos arbitrários. A pasta tem de ser uma conhecida (lista de `recentFolders` / candidatos do VBoards).
- Sem shell ao chamar as CLIs: `spawn(file, args, { shell: false, windowsHide: true })`. O pedido vai por stdin (Claude, Codex `-`) ou como um único argv `--print=<texto>` (agy).
- Segredos nunca vão para o snapshot, o cliente ou os logs: `maskSecrets()` (shared/activity.ts:125) em todo texto de ferramenta, resposta e erro. O token MCP nunca sai do servidor.
- Textos visíveis com `tr('…')` (primeiro argumento literal), com tradução em `shared/locales/{en,es,fr}.ts`. Cada mudança visível ganha uma linha em `CHANGELOG.md` > `## [Não lançado]`.
- Mudanças em `shared/types.ts` só aditivas (campos opcionais).
- Testes vitest co-localizados (`x.test.ts` ao lado de `x.ts`) para a lógica nova: parsers, decisão de permissão/trava, persistência, limites.
- Windows 11 é a plataforma principal (servidor com `HABBLAUD_PTY=1`). Não quebrar macOS, Linux nem Docker.
- No Docker o chat fica indisponível, com aviso na tela. O resto do modo Docker (incluindo o Novo agente atual via host) segue igual.
- Nada do AgenticOffice é gravado no repositório do usuário. Papéis, conversas e worktrees ficam em `config.dataDir` (`~/.habblaud`). A única exceção é o metadado interno do git (`.git/worktrees/`), criado pelo `git worktree add`.
- Limites: custo somado por todas as rodadas (persistido; em tokens quando o provedor não informa US$). Tempo por rodada. Estourou: a rodada para, o chat avisa, e o agente só aceita nova mensagem se o usuário aumentar o limite.
- Permissão padrão `auto`. "Pedir aprovação" só existe no Claude; nos outros a opção fica desabilitada, com o motivo.
- Nenhum código, prompt ou formato do Maestro/Maestri.
- Processo: commit local por tarefa e nada de push. O usuário testa antes (build, reinício do servidor local, teste, depois push).

## Review Focus

1. **Shims `.cmd` do npm no Windows.** `claude` e `codex` neste PC são `…\npm\claude.cmd` e `…\npm\codex.cmd`, e o `spawn` sem shell não roda `.cmd`. O alvo real é `node_modules\@anthropic-ai\claude-code\bin\claude.exe` e `node node_modules\@openai\codex\bin\codex.js`. Teste fixado na Task 4.
2. **Comando reescrito por hook do usuário, ou composto.** Na sonda real, o `git push origin main` chegou ao permission tool como `rtk git push origin main` (hook PreToolUse do usuário). Também existem `cd x && git push` e `git -C ../o push`. A trava não pode ancorar no início. Teste fixado na Task 5.
3. **Custo do Claude é cumulativo por sessão e vem 0 no erro.** `total_cost_usd` da rodada 2 retomada foi 0.11005549 (a rodada 1 tinha dado 0.1015494). No `error_during_execution` vem `0`. Somar ingenuamente dobra o custo, e zerar a base no erro faz o limite errar. Teste fixado na Task 6.
4. **Parar no Windows deixa neto vivo.** `node codex.js` → `codex.exe`, e o `claude.exe` → shell da ferramenta. `child.kill()` só mata o primeiro. Teste fixado na Task 8 (`taskkill /PID <pid> /T /F`).
5. **Agente em dobro e cartão em dobro.** O `claude -p` grava `~/.claude/sessions/<pid>.json` (`"kind":"interactive","entrypoint":"sdk-cli"`, confirmado), que o `ClaudeWatcher` mostraria. Os hooks de plugin do usuário (inclusive o PermissionRequest do habblaud-permissoes) rodam dentro do `-p`. Testes fixados na Task 9.

---

## File Structure

Criados (servidor, `server/chat/`):
- `server/chat/types.ts`: tipos internos do runtime (`ChatEvent`, `TurnSpec`, `CliInvocation`, `ChatDriver`, `StreamParser`).
- `server/chat/drivers/claude.ts`: argv/env e parser do `claude -p --output-format stream-json`.
- `server/chat/drivers/codex.ts`: argv/env e parser do `codex exec --json` / `codex exec resume`.
- `server/chat/drivers/agy.ts`: argv/env e parser do `agy --print= --output-format stream-json`.
- `server/chat/fixtures/*.jsonl`: streams reais (redigidos) usados pelos testes dos parsers.
- `server/chat/bins.ts`: acha o executável de cada CLI (shims do npm no Windows).
- `server/chat/trava.ts`: decide o que é irreversível (`travaReason`) e monta o env que bloqueia `git push`.
- `server/chat/usage.ts`: acumula uso/custo e checa os limites.
- `server/chat/store.ts`: persistência de cada conversa em `<dataDir>/chat/agents/<id>.json`.
- `server/chat/roles.ts`: os 6 papéis prontos + CRUD em `<dataDir>/chat/roles.json`.
- `server/chat/worktree.ts`: cópia isolada (criar, resumo do diff, Juntar, Descartar).
- `server/chat/permission.ts`: decisão auto/pedir (`decideClaudeTool`) e o endpoint MCP HTTP do permission tool.
- `server/chat/service.ts`: `ChatService` (abrir, rodada, retomar, parar, limites, Office, reinício).
- `server/chat/http.ts`: rotas `/api/chat/*`.

Criados (compartilhado/cliente):
- `shared/chat.ts`: tipos do protocolo do chat (cliente ↔ servidor) e constantes.
- `client/src/ui/chat-model.ts`: lógica pura do painel (status, uso, envio, itens).
- `client/src/ui/chat.ts`: `ChatPanel` (DOM) dentro do drawer.
- `client/src/ui/spawn-model.ts`: lógica pura da janela de abrir agente (padrões, validação, desabilitar "pedir aprovação").

Modificados:
- `shared/types.ts`: `AgentInfo.chat?`, `AccessInfo.chat?`, `OfficeSnapshot.meta.chat?`.
- `server/model/office.ts`: `MainInput.chat?` → `AgentInfo.chat`.
- `server/sources/watcher.ts`, `server/sources/codex/source.ts`: opção `ignoreSession`.
- `server/permissions/registry.ts`: pedidos vindos do chat (`registerChat`) e o hook ignorado para agentes do chat.
- `server/pty/manager.ts`: exportar `INHERITED_SESSION_VARS`.
- `server/http/app.ts`: `ApiDeps.chat`, rota `/api/chat*`, `access.chat`.
- `server/index.ts`: liga o `ChatService` (fora do Docker e com `HABBLAUD_PTY`).
- `server/vboards/vboards.ts`: o "Iniciar" passa pelo chat quando ele existe.
- `client/src/ui/spawn.ts`: "Mais opções" e envio para `/api/chat/agents`.
- `client/src/ui/drawer.ts`: seção do chat, sem composer nem terminal para agentes do chat.
- `client/src/ui/vboards.ts`: "Iniciar" abre a janela preenchida.
- `client/src/net/access.ts`: aceita `chat`.
- `client/src/ui/styles.css`, `shared/locales/{en,es,fr}.ts`, `CHANGELOG.md`.

---

## Protocolos confirmados nesta máquina (2026-10-16)

| CLI | Versão | Confirmado ao vivo | Não confirmado |
|---|---|---|---|
| `claude` | 2.1.300 | `-p --output-format stream-json --verbose`, prompt por stdin, `--session-id <uuid>` na 1ª rodada, `--resume <uuid>`, eventos `system/init`, `assistant` (thinking/tool_use/text), `user` (tool_result), `result` (success e `error_during_execution`). `--permission-prompt-tool mcp__<srv>__<tool>` com MCP **HTTP** (`{"type":"http","url","headers"}`): chega `tools/call` com `{tool_name,input,tool_use_id}`, e a resposta é texto JSON `{"behavior":"allow","updatedInput":{…}}` ou `{"behavior":"deny","message":"…"}`. O flag não aparece no `--help`, mas funciona. `--append-system-prompt`, `--max-budget-usd`, `--permission-mode default\|acceptEdits`, e `-p` grava `sessions/<pid>.json` com `entrypoint:"sdk-cli"`. | Se o hook `PermissionRequest` do plugin dispara antes do permission tool no `-p` (a Task 9 cobre os dois casos). |
| `codex` | 0.154.0 | `exec --json`, prompt `-` por stdin, `thread.started{thread_id}`, `turn.started`, `item.completed{item:{type:"error"}}`, `error{message}`, `turn.failed{error:{message}}`. `exec resume` **não** aceita `--sandbox`/`-C`/`--add-dir` (só `-c`, `-m`, `--json`, `--skip-git-repo-check`). As chaves de config `sandbox_mode`, `sandbox_workspace_write`, `network_access`, `writable_roots` e `developer_instructions` existem no binário. | Rodada com sucesso: o limite de uso do ChatGPT esgotou e volta em 22/10. Nomes `item.started/updated/completed`, `agent_message`, `command_execution` (`command`, `aggregated_output`, `exit_code`, `status`), `file_change` (`changes`), `turn.completed{usage:{input_tokens,cached_input_tokens,output_tokens}}` estão no binário, mas não foram vistos num stream. Não se sabe se o `usage` é por rodada ou cumulativo, nem se o sandbox `unelevated` do Windows corta rede e protege `.git`. **Task 1 (spike).** |
| `agy` | 1.1.19 (auto-atualiza; o help mudou durante a sonda) | `--print=<texto>` (o `-p` consome o próximo argv; `-- texto` falha), `--output-format stream-json`, `{"event":"init","conversation_id",…}`, `{"event":"result","result":{status,response,num_turns,usage}}`. **Sem login**, devolve `status:"SUCCESS"`, `response:""`, `num_turns:0`. O `--print-timeout` agora é 0 (espera para sempre). As conversas vão para `~/.gemini/antigravity-cli/` (a fonte atual lê `antigravity-ide/`, então não duplica). | Eventos intermediários (texto, ferramenta), o efeito de `--sandbox` e `--mode accept-edits\|auto`, e se ações em `request-review` travam ou são negadas no print. O agy não está logado nesta máquina. **Task 1 (spike).** |
| git | – | `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.habblaud-trava:blocked/.pushInsteadOf GIT_CONFIG_VALUE_0=` faz **todo** `git push` falhar (exit 128) e o `fetch` seguir (testado). | – |

---

### Task 1: Spike: capturar Codex e agy ao vivo (bloqueada pelo usuário)

Pré-requisitos que só o usuário resolve: a cota do Codex voltar (22/10) e rodar `agy` interativo uma vez para fazer login. Nenhuma outra task depende desta para começar. As Tasks 3 e 4 trazem fixtures provisórias, e esta task troca as provisórias pelas reais e ajusta o que divergir.

**Files:**
- Create: `server/chat/fixtures/codex-turn.jsonl`, `server/chat/fixtures/agy-turn.jsonl`
- Modify: `server/chat/drivers/codex.ts`, `server/chat/drivers/agy.ts` e os testes deles, se os nomes divergirem; a tabela "Protocolos confirmados" deste plano.

**Interfaces:**
- Consumes: os drivers das Tasks 3 e 4.
- Produces: fixtures reais e as decisões abaixo, gravadas na tabela.

- [ ] **Step 1: Capturar.** Numa pasta vazia em `%TEMP%`, com `git init`, rodar `"Run: echo hi > c.txt, then git push origin main, then reply ok"`:
  - `codex exec --json --skip-git-repo-check -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=false -m gpt-5.6-luna -` (prompt por stdin)
  - depois `codex exec resume <thread_id> --json -c sandbox_mode="workspace-write" -`
  - `agy --print="<prompt>" --output-format stream-json --sandbox --mode accept-edits`, depois `--conversation <id>`

  Redigir caminhos e ids de usuário. Gravar as 2 rodadas de cada em `server/chat/fixtures/`.
- [ ] **Step 2: Decidir e anotar.** Responder com evidência:
  - (a) o `turn.completed.usage` do Codex é por rodada ou cumulativo;
  - (b) o `git push` sai negado sob o sandbox `unelevated`, e `c.txt` foi criado;
  - (c) o `git commit` funciona com `.git` fora do writable root (caso da worktree, Task 12);
  - (d) no agy, o que acontece com um comando que pediria revisão (nega, trava ou roda);
  - (e) quais eventos o agy emite entre `init` e `result`.

  Regras de decisão já fixadas:
  - Se (b) falhar, a Task 8 passa a forçar a cópia isolada para o Codex. O env do git (Task 5) continua.
  - Se (d) travar, o agy usa `--mode auto` mais o env da Task 5.
  - Se nada disso bloquear o `git push`, a opção Antigravity sai do seletor com o motivo `tr('Antigravity: sem como travar ações irreversíveis nesta versão do agy')`.
- [ ] **Step 3: Ajustar** os parsers e os testes das Tasks 3 e 4 às fixtures reais. Rodar `npx vitest run server/chat` e esperar PASS.
- [ ] **Step 4: Commit.** `git add server/chat docs/superpowers/plans/2026-10-16-base-orquestracao.md && git commit -m "test: fixtures reais do Codex e do Antigravity para o chat"`

---

### Task 2: Tipos do chat, interface de driver e parser do Claude

**Files:**
- Create: `shared/chat.ts`, `server/chat/types.ts`, `server/chat/drivers/claude.ts`, `server/chat/drivers/claude.test.ts`, `server/chat/fixtures/claude-turn.jsonl`, `server/chat/fixtures/claude-error.jsonl`

**Interfaces:**
- Produces (`shared/chat.ts`):
  ```ts
  export type ChatPermission = 'auto' | 'ask';
  export interface ChatLimits { maxCostUsd?: number; maxTokens?: number; maxTurnMinutes?: number }
  export type ChatItem =
    | { seq: number; at: number; kind: 'user'; text: string }
    | { seq: number; at: number; kind: 'assistant'; text: string }
    | { seq: number; at: number; kind: 'tool'; toolId: string; name: string; input: string; output?: string; error?: boolean; blocked?: string }
    | { seq: number; at: number; kind: 'approval'; permissionId: string; tool: string; text: string; outcome?: 'allow' | 'deny' }
    | { seq: number; at: number; kind: 'notice'; level: 'info' | 'error'; text: string }
    | { seq: number; at: number; kind: 'usage'; tokensIn: number; tokensOut: number; costUsd?: number; ms: number };
  export type ChatPhase = 'idle' | 'thinking' | 'tool' | 'approval' | 'stopping';
  export interface ChatState { phase: ChatPhase; tool?: string; blocked?: 'cost' | 'tokens'; spentUsd: number; spentTokens: number; limits: ChatLimits; isolated?: { branch: string; merged?: boolean; discarded?: boolean } }
  export interface ChatView { agentId: string; provider: Provider; items: ChatItem[]; state: ChatState; lastSeq: number }
  export const CHAT_TEXT_MAX = 8000;      // igual ao SPAWN_PROMPT_MAX
  export const CHAT_TOOL_OUTPUT_MAX = 4000; // por item, depois de maskSecrets
  ```
- Produces (`server/chat/types.ts`):
  ```ts
  export type ChatEvent =
    | { type: 'session'; id: string }
    | { type: 'thinking' }
    | { type: 'text'; text: string }
    | { type: 'tool'; id: string; name: string; input: string }
    | { type: 'tool-result'; id: string; output: string; error: boolean }
    | { type: 'notice'; text: string }
    | { type: 'usage'; tokensIn: number; tokensOut: number; costUsd?: number; costIsCumulative?: boolean }
    | { type: 'done'; ok: boolean; error?: string };
  export interface StreamParser { line(raw: string): ChatEvent[]; end(exitCode: number | null, stderr: string): ChatEvent[] }
  export interface TurnSpec { folder: string; prompt: string; first: boolean; sessionId?: string; resumeId?: string; model?: string; role?: string; permission: ChatPermission; budgetUsd?: number; mcp?: { url: string; token: string }; accountDir?: string; writableRoots: string[] }
  export interface CliInvocation { args: string[]; stdin?: string; env: Record<string, string | undefined> }
  export interface ChatDriver { readonly provider: Provider; invocation(spec: TurnSpec): CliInvocation; parser(): StreamParser }
  ```
- Produces (`server/chat/drivers/claude.ts`): `export const claudeDriver: ChatDriver`, `export function claudeArgs(spec: TurnSpec): string[]`, `export const PERMISSION_TOOL = 'mcp__habblaud__approve'`.

- [ ] **Step 1: Fixtures.** Gravar `server/chat/fixtures/claude-turn.jsonl`, tirado da rodada real `a202b58e…`. Os ids, o shape e os números são reais; caminhos e assinatura foram redigidos. Cada linha é um objeto JSON:

  ```jsonl
  {"type":"system","subtype":"hook_started","hook_id":"h1","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"u0","session_id":"a202b58e-04e5-40b3-bbe5-0cbe9be49d86"}
  {"type":"system","subtype":"init","cwd":"C:\\proj","session_id":"a202b58e-04e5-40b3-bbe5-0cbe9be49d86","tools":["Bash","Read"],"model":"claude-haiku-5-5","permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.300","uuid":"u1"}
  {"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"estimated_tokens_delta":50,"session_id":"a202b58e-04e5-40b3-bbe5-0cbe9be49d86","uuid":"u2"}
  {"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_1","type":"message","role":"assistant","content":[{"type":"thinking","thinking":"","signature":"REDACTED"}],"usage":{"input_tokens":2,"output_tokens":2}},"parent_tool_use_id":null,"session_id":"a202b58e-04e5-40b3-bbe5-0cbe9be49d86","uuid":"u3"}
  {"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_1","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01DrZF1NgtQPYtyUAaaAaShC","name":"Read","input":{"file_path":"C:\\proj\\a.txt"},"caller":{"type":"direct"}}],"usage":{"input_tokens":2,"output_tokens":2}},"parent_tool_use_id":null,"session_id":"a202b58e-04e5-40b3-bbe5-0cbe9be49d86","uuid":"u4"}
  {"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01DrZF1NgtQPYtyUAaaAaShC","type":"tool_result","content":"1\thello-file\n2\t"}]},"parent_tool_use_id":null,"session_id":"a202b58e-04e5-40b3-bbe5-0cbe9be49d86","uuid":"u5","tool_result_meta":[{"id":"toolu_01DrZF1NgtQPYtyUAaaAaShC","permission_decision":{"decision":"accept","source":"config","reason_type":"mode"}}]}
  {"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_2","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01VhL9v69zU1xjVKcNRubTQX","name":"Bash","input":{"command":"rtk git push origin main","description":"Push main branch to origin"},"caller":{"type":"direct"}}],"usage":{"input_tokens":2,"output_tokens":16}},"parent_tool_use_id":null,"session_id":"a202b58e-04e5-40b3-bbe5-0cbe9be49d86","uuid":"u6"}
  {"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Trava: git push recusado","is_error":true,"tool_use_id":"toolu_01VhL9v69zU1xjVKcNRubTQX"}]},"parent_tool_use_id":null,"session_id":"a202b58e-04e5-40b3-bbe5-0cbe9be49d86","uuid":"u7","tool_use_result":"Error: Trava: git push recusado","tool_result_meta":[{"id":"toolu_01VhL9v69zU1xjVKcNRubTQX","non_execution_kind":"permission-rule","permission_decision":{"decision":"reject","source":"user_reject"}}]}
  {"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_3","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_sub","name":"Read","input":{"file_path":"C:\\proj\\b.txt"}}]},"parent_tool_use_id":"toolu_task","session_id":"a202b58e-04e5-40b3-bbe5-0cbe9be49d86","uuid":"u8"}
  {"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_4","type":"message","role":"assistant","content":[{"type":"text","text":"Li a.txt; o push foi recusado."}],"usage":{"input_tokens":2,"output_tokens":5}},"parent_tool_use_id":null,"session_id":"a202b58e-04e5-40b3-bbe5-0cbe9be49d86","uuid":"u9"}
  {"type":"system","subtype":"ui_status","plugin":"habblaud","text":null,"uuid":"u10","session_id":"a202b58e-04e5-40b3-bbe5-0cbe9be49d86"}
  {"type":"result","subtype":"success","is_error":false,"duration_ms":4591,"num_turns":3,"result":"Li a.txt; o push foi recusado.","stop_reason":"end_turn","session_id":"a202b58e-04e5-40b3-bbe5-0cbe9be49d86","total_cost_usd":0.11005549,"usage":{"input_tokens":6,"cache_creation_input_tokens":33451,"cache_read_input_tokens":152029,"output_tokens":590},"permission_denials":[],"terminal_reason":"completed","uuid":"u11"}
  ```

  E `server/chat/fixtures/claude-error.jsonl`, real (sessão inexistente, exit 1):

  ```jsonl
  {"type":"result","subtype":"error_during_execution","duration_ms":0,"duration_api_ms":0,"is_error":true,"num_turns":0,"stop_reason":null,"session_id":"00000000-0000-4000-8000-000000000000","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0},"modelUsage":{},"permission_denials":[],"uuid":"e1","errors":["No conversation found with session ID: 00000000-0000-4000-8000-000000000000"]}
  ```

- [ ] **Step 2: Teste que falha.** Criar `server/chat/drivers/claude.test.ts`:

  ```ts
  import { readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { describe, expect, it } from 'vitest';
  import { claudeArgs, claudeDriver, PERMISSION_TOOL } from './claude';
  import type { ChatEvent, TurnSpec } from '../types';

  const fx = (n: string) => readFileSync(join(__dirname, '..', 'fixtures', n), 'utf8').split(/\r?\n/).filter(Boolean);
  const run = (n: string, exit = 0): ChatEvent[] => { const p = claudeDriver.parser(); return [...fx(n).flatMap((l) => p.line(l)), ...p.end(exit, '')]; };
  const base: TurnSpec = { folder: 'C:\\proj', prompt: '-oi', first: true, sessionId: 'a202b58e-04e5-40b3-bbe5-0cbe9be49d86', permission: 'auto', writableRoots: ['C:\\proj'] };

  describe('chat: driver do Claude', () => {
    it('argv da 1ª rodada fixa o id; as outras retomam; pedido nunca vai no argv', () => {
      expect(claudeArgs(base)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--session-id', 'a202b58e-04e5-40b3-bbe5-0cbe9be49d86', '--permission-mode', 'acceptEdits']);
      const next = claudeArgs({ ...base, first: false, resumeId: 'a202b58e-04e5-40b3-bbe5-0cbe9be49d86', permission: 'ask', model: 'sonnet', role: 'Seja breve.', budgetUsd: 0.5, mcp: { url: 'http://127.0.0.1:4747/api/chat/mcp/chat:1', token: 't0k' } });
      expect(next.slice(0, 6)).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--resume', 'a202b58e-04e5-40b3-bbe5-0cbe9be49d86']);
      expect(next).toContain('--permission-prompt-tool');
      expect(next[next.indexOf('--permission-prompt-tool') + 1]).toBe(PERMISSION_TOOL);
      expect(next[next.indexOf('--permission-mode') + 1]).toBe('default');
      expect(next[next.indexOf('--append-system-prompt') + 1]).toBe('Seja breve.');
      expect(next[next.indexOf('--max-budget-usd') + 1]).toBe('0.5');
      expect(JSON.parse(next[next.indexOf('--mcp-config') + 1])).toEqual({ mcpServers: { habblaud: { type: 'http', url: 'http://127.0.0.1:4747/api/chat/mcp/chat:1', headers: { Authorization: 'Bearer t0k' } } } });
      expect(next).toContain('--strict-mcp-config');
      expect(next.join(' ')).not.toContain('-oi');
      expect(claudeDriver.invocation(base).stdin).toBe('-oi');
    });

    it('rodada real: sessão, ferramentas, texto, uso cumulativo e fim', () => {
      const ev = run('claude-turn.jsonl');
      expect(ev[0]).toEqual({ type: 'session', id: 'a202b58e-04e5-40b3-bbe5-0cbe9be49d86' });
      expect(ev).toContainEqual({ type: 'tool', id: 'toolu_01DrZF1NgtQPYtyUAaaAaShC', name: 'Read', input: 'C:\\proj\\a.txt' });
      expect(ev).toContainEqual({ type: 'tool-result', id: 'toolu_01DrZF1NgtQPYtyUAaaAaShC', output: '1\thello-file\n2\t', error: false });
      expect(ev).toContainEqual({ type: 'tool', id: 'toolu_01VhL9v69zU1xjVKcNRubTQX', name: 'Bash', input: 'rtk git push origin main' });
      expect(ev).toContainEqual({ type: 'tool-result', id: 'toolu_01VhL9v69zU1xjVKcNRubTQX', output: 'Trava: git push recusado', error: true });
      expect(ev.some((e) => e.type === 'tool' && e.id === 'toolu_sub')).toBe(false); // subagente (parent_tool_use_id) não vira item
      expect(ev).toContainEqual({ type: 'text', text: 'Li a.txt; o push foi recusado.' });
      expect(ev).toContainEqual({ type: 'usage', tokensIn: 6 + 33451 + 152029, tokensOut: 590, costUsd: 0.11005549, costIsCumulative: true });
      expect(ev.at(-1)).toEqual({ type: 'done', ok: true });
      expect(ev.filter((e) => e.type === 'thinking').length).toBeGreaterThan(0);
    });

    it('erro: done com a mensagem de errors[], sem uso de custo', () => {
      const ev = run('claude-error.jsonl', 1);
      expect(ev.at(-1)).toEqual({ type: 'done', ok: false, error: 'No conversation found with session ID: 00000000-0000-4000-8000-000000000000' });
      expect(ev.some((e) => e.type === 'usage' && e.costUsd !== undefined)).toBe(false);
    });

    it('linha quebrada ou desconhecida é ignorada; sem result = falha com stderr', () => {
      const p = claudeDriver.parser();
      expect(p.line('{"type":"assi')).toEqual([]);
      expect(p.line('{"type":"rate_limit_event"}')).toEqual([]);
      expect(p.end(1, 'boom')).toEqual([{ type: 'done', ok: false, error: 'boom' }]);
    });
  });
  ```

- [ ] **Step 3: Rodar** `npx vitest run server/chat/drivers/claude.test.ts`. Esperado: FAIL (módulo inexistente).
- [ ] **Step 4: Implementar.**
  - Ordem do argv: `['-p','--output-format','stream-json','--verbose']`, depois `--session-id <id>` (first) ou `--resume <id>`, depois `--permission-mode` (`acceptEdits` no auto, `default` no ask), e então, na ordem, `--model`, `--append-system-prompt`, `--max-budget-usd` (`String(n)`) e, com `mcp`, `--strict-mcp-config --mcp-config <json> --permission-prompt-tool mcp__habblaud__approve`.
  - Env: `accountDir` vira `CLAUDE_CONFIG_DIR` (ausente = a conta padrão).
  - Parser: `tool.input` é o primeiro de `command` | `file_path` | `pattern` | `url`, ou `JSON.stringify(input)`. O `tool_result.content` pode ser string ou array de `{type:'text',text}` (juntar com `\n`). `usage.tokensIn` = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
  - `result` com `is_error` vira `done{ok:false,error: errors?.join('\n') || result || subtype}` e **não** emite usage com custo.
  - Sem `result` até o `end`: `done{ok:false, error: stderr.trim() || tr('A CLI terminou sem resposta (código {0})', [code])}`.
- [ ] **Step 5: Rodar** de novo. Esperado: PASS.
- [ ] **Step 6: Commit.** `git add shared/chat.ts server/chat && git commit -m "feat: tipos do chat com agentes e leitura do stream do Claude Code"`

---

### Task 3: Driver do Codex

**Files:**
- Create: `server/chat/drivers/codex.ts`, `server/chat/drivers/codex.test.ts`, `server/chat/fixtures/codex-error.jsonl`, `server/chat/fixtures/codex-turn.jsonl` (provisória até a Task 1)

**Interfaces:**
- Consumes: `ChatDriver`, `TurnSpec`, `ChatEvent` (Task 2).
- Produces: `export const codexDriver: ChatDriver`, `export function codexArgs(spec: TurnSpec): string[]`.

- [ ] **Step 1: Fixtures.** `codex-error.jsonl` com as **linhas reais** capturadas:

  ```jsonl
  {"type":"thread.started","thread_id":"01a14670-09a5-7761-b763-5c4bda855648"}
  {"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `gpt-6.1-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}
  {"type":"turn.started"}
  {"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.\"}}"}
  {"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.\"}}"}}
  ```

  `codex-turn.jsonl` é **provisória**: os nomes vêm do binário 0.154, e a Task 1 a substitui pela captura real.

  ```jsonl
  {"type":"thread.started","thread_id":"01a14670-48d2-7781-8dee-d5aaf4ebd0f3"}
  {"type":"turn.started"}
  {"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"**Planning**"}}
  {"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"git push origin main","aggregated_output":"","exit_code":null,"status":"in_progress"}}
  {"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"git push origin main","aggregated_output":"ssh: Could not resolve hostname habblaud-trava","exit_code":128,"status":"failed"}}
  {"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"C:\\proj\\c.txt","kind":"add"}],"status":"completed"}}
  {"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"ok"}}
  {"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":800,"output_tokens":40}}
  ```

- [ ] **Step 2: Teste que falha** (`codex.test.ts`, mesmo helper `run` da Task 2):

  ```ts
  it('argv: exec na 1ª, exec resume depois; sandbox e papel por -c; pedido por stdin', () => {
    const s: TurnSpec = { folder: 'C:\\proj', prompt: '--x', first: true, permission: 'auto', writableRoots: ['C:\\proj', 'C:\\proj\\.git'], role: 'Diga "oi"\n' };
    expect(codexArgs(s)).toEqual(['exec', '--json', '--skip-git-repo-check',
      '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=false',
      '-c', 'sandbox_workspace_write.writable_roots=["C:\\\\proj","C:\\\\proj\\\\.git"]',
      '-c', 'developer_instructions="Diga \\"oi\\"\\n"', '-']);
    expect(codexArgs({ ...s, first: false, resumeId: '01a14670-48d2-7781-8dee-d5aaf4ebd0f3', model: 'gpt-5.6-luna', role: undefined }))
      .toEqual(['exec', 'resume', '01a14670-48d2-7781-8dee-d5aaf4ebd0f3', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.writable_roots=["C:\\\\proj","C:\\\\proj\\\\.git"]', '-m', 'gpt-5.6-luna', '-']);
    expect(codexDriver.invocation(s).stdin).toBe('--x');
  });
  it('erro real: aviso vira notice, falha traz a mensagem de dentro do JSON', () => {
    const ev = run('codex-error.jsonl', 1);
    expect(ev[0]).toEqual({ type: 'session', id: '01a14670-09a5-7761-b763-5c4bda855648' });
    expect(ev).toContainEqual({ type: 'notice', text: 'Model metadata for `gpt-6.1-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' });
    expect(ev.at(-1)).toEqual({ type: 'done', ok: false, error: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." });
  });
  it('rodada: comando, arquivo, texto e uso em tokens (sem US$)', () => {
    const ev = run('codex-turn.jsonl');
    expect(ev).toContainEqual({ type: 'tool', id: 'item_1', name: 'command', input: 'git push origin main' });
    expect(ev).toContainEqual({ type: 'tool-result', id: 'item_1', output: 'ssh: Could not resolve hostname habblaud-trava', error: true });
    expect(ev).toContainEqual({ type: 'tool', id: 'item_2', name: 'file_change', input: 'add C:\\proj\\c.txt' });
    expect(ev).toContainEqual({ type: 'text', text: 'ok' });
    expect(ev).toContainEqual({ type: 'usage', tokensIn: 1200, tokensOut: 40 });
    expect(ev.at(-1)).toEqual({ type: 'done', ok: true });
  });
  ```

- [ ] **Step 3: Rodar** `npx vitest run server/chat/drivers/codex.test.ts`. Esperado: FAIL.
- [ ] **Step 4: Implementar.**
  - Os valores `-c` são TOML: strings com `JSON.stringify` (escapes válidos em TOML) e arrays como `[...].map(JSON.stringify)`.
  - O resume não aceita `--sandbox`/`-C`/`--add-dir`, por isso tudo vai por `-c`. A pasta vem do `cwd` do processo.
  - Env: `accountDir` vira `CODEX_HOME`.
  - `tokensIn` = `input_tokens` (o `cached_input_tokens` já está contido).
  - O `error` solto só guarda a mensagem; o `turn.failed` fecha. Mensagem que é JSON: usar `error.message` de dentro.
  - `file_change` emite `tool` e `tool-result` (`output: ''`, `error: status==='failed'`).
- [ ] **Step 5: Rodar.** Esperado: PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat: leitura do stream do Codex (codex exec --json) para o chat"`

---

### Task 4: Driver do Antigravity e executáveis das CLIs

**Files:**
- Create: `server/chat/drivers/agy.ts`, `server/chat/drivers/agy.test.ts`, `server/chat/fixtures/agy-nologin.jsonl`, `server/chat/fixtures/agy-turn.jsonl` (provisória), `server/chat/bins.ts`, `server/chat/bins.test.ts`

**Interfaces:**
- Consumes: `findExecutable`, `isExecutableFile` (server/claude-bin.ts), `findCodexBin` (server/messages/codex.ts).
- Produces:
  - `export const agyDriver: ChatDriver`, `export function agyArgs(spec: TurnSpec): string[]`
  - `export interface CliBin { file: string; prefix: string[] }`
  - `export function resolveCliBin(provider: Provider, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, exists?: (p: string) => boolean): CliBin | undefined` (env: `HABBLAUD_CLAUDE_BIN`, `HABBLAUD_CODEX_BIN`, `HABBLAUD_AGY_BIN`)

- [ ] **Step 1: Fixtures.** `agy-nologin.jsonl` (real, sem login):

  ```jsonl
  {"event":"init","conversation_id":"d38f4d9a-1217-40ed-87e9-1ebc9a747fae","init":{"cwd":"C:\\proj","tools":["ask_custom_permission","ask_permission","ask_question"],"permission_mode":"request-review"}}
  {"event":"result","result":{"conversation_id":"d38f4d9a-1217-40ed-87e9-1ebc9a747fae","status":"SUCCESS","response":"","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}
  ```

  `agy-turn.jsonl` (provisória, só init + result com `"response":"ok","num_turns":1,"usage":{"input_tokens":900,"output_tokens":3,"thinking_tokens":10,"cache_read_tokens":0,"total_tokens":913}`).
- [ ] **Step 2: Teste que falha.**

  ```ts
  it('argv: o pedido vai grudado em --print= (texto que começa com "-" não vira flag)', () => {
    const s: TurnSpec = { folder: 'C:\\proj', prompt: '--model x', first: true, permission: 'auto', writableRoots: ['C:\\proj'], role: 'Papel.' };
    expect(agyArgs(s)).toEqual(['--output-format', 'stream-json', '--sandbox', '--mode', 'accept-edits', '--print=Papel.\n\n---\n\n--model x']);
    expect(agyArgs({ ...s, first: false, resumeId: 'd38f4d9a-1217-40ed-87e9-1ebc9a747fae', model: 'gemini-x' }))
      .toEqual(['--output-format', 'stream-json', '--sandbox', '--mode', 'accept-edits', '--conversation', 'd38f4d9a-1217-40ed-87e9-1ebc9a747fae', '--model', 'gemini-x', '--print=--model x']);
  });
  it('sem login: SUCCESS vazio com 0 rodadas é erro com aviso de login', () => {
    const ev = run('agy-nologin.jsonl');
    expect(ev[0]).toEqual({ type: 'session', id: 'd38f4d9a-1217-40ed-87e9-1ebc9a747fae' });
    expect(ev.at(-1)).toEqual({ type: 'done', ok: false, error: 'O Antigravity não respondeu. Faça login rodando `agy` num terminal.' });
  });
  it('rodada: texto do response e tokens', () => {
    const ev = run('agy-turn.jsonl');
    expect(ev).toContainEqual({ type: 'text', text: 'ok' });
    expect(ev).toContainEqual({ type: 'usage', tokensIn: 900, tokensOut: 13 });
    expect(ev.at(-1)).toEqual({ type: 'done', ok: true });
  });
  ```

  Em `bins.test.ts`, a Review Focus 1:

  ```ts
  it('Windows: shim .cmd do npm vira o binário real', () => {
    const npm = 'C:\\Users\\u\\AppData\\Roaming\\npm';
    const files = new Set([`${npm}\\claude.cmd`, `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`, `${npm}\\codex.cmd`, `${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`, 'C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe']);
    const env = { PATH: `${npm};C:\\Users\\u\\AppData\\Local\\agy\\bin`, PATHEXT: '.EXE;.CMD' };
    const has = (p: string) => files.has(p);
    expect(resolveCliBin('claude', env, 'win32', has)).toEqual({ file: `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`, prefix: [] });
    expect(resolveCliBin('codex', env, 'win32', has)).toEqual({ file: process.execPath, prefix: [`${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`] });
    expect(resolveCliBin('antigravity', env, 'win32', has)).toEqual({ file: 'C:\\Users\\u\\AppData\\Local\\agy\\bin\\agy.exe', prefix: [] });
    expect(resolveCliBin('claude', { PATH: npm, PATHEXT: '.CMD' }, 'win32', (p) => p.endsWith('claude.cmd'))).toBeUndefined(); // .cmd sem alvo: indisponível
  });
  ```

- [ ] **Step 3: Rodar** `npx vitest run server/chat/drivers/agy.test.ts server/chat/bins.test.ts`. Esperado: FAIL.
- [ ] **Step 4: Implementar.**
  - O papel do agy vai **no primeiro pedido** (`<papel>\n\n---\n\n<pedido>`), porque o agy não tem prompt de sistema por flag e não se escreve nada no projeto.
  - `tokensOut` = `output_tokens + thinking_tokens`. Erro sem login: `tr('O Antigravity não respondeu. Faça login rodando `agy` num terminal.')`.
  - stderr com `print timeout` também vira `done{ok:false}`.
  - `resolveCliBin`: o override de env vence. Fora dele, `findExecutable(name)`. Se o achado termina em `.cmd` (win32), procura o alvo conhecido ao lado (`node_modules\@anthropic-ai\claude-code\bin\claude.exe`, ou `node_modules\@openai\codex\bin\codex.js` rodado com `process.execPath`). Sem alvo, devolve `undefined`.
  - Injetar `exists` para testar; o padrão é `isExecutableFile`.
- [ ] **Step 5: Rodar.** Esperado: PASS.
- [ ] **Step 6: Commit.** `git commit -m "feat: chat com o Antigravity (agy) e busca dos executáveis das CLIs no Windows"`

---

### Task 5: Trava do automático

**Files:**
- Create: `server/chat/trava.ts`, `server/chat/trava.test.ts`

**Interfaces:**
- Produces:
  - `export function travaReason(tool: string, input: Record<string, unknown>, root: string): string | undefined` (motivo em PT via `tr`; `undefined` = livre). Ferramentas de shell: `Bash`, `PowerShell`, `command` (Codex), `run_command` (agy).
  - `export function travaEnv(env: NodeJS.ProcessEnv): Record<string, string>`: soma ao `GIT_CONFIG_COUNT` existente a regra `url.habblaud-trava:blocked/.pushInsteadOf` = `''`.

- [ ] **Step 1: Teste que falha** (Review Focus 2):

  ```ts
  const root = 'C:\\proj';
  const sh = (command: string) => travaReason('Bash', { command }, root);
  it('push, publicar, deploy e banco de produção pedem/recusam em qualquer posição do comando', () => {
    for (const c of ['git push origin main', 'rtk git push origin main', 'cd app && git push', 'git -C ../o push --force', 'npm publish', 'pnpm publish --access public', 'cargo publish', 'twine upload dist/*', 'gh release create v1', 'vercel --prod', 'vercel deploy', 'netlify deploy --prod', 'firebase deploy', 'fly deploy', 'eas submit -p ios', 'eas update', 'wrangler deploy', 'supabase db push', 'prisma migrate deploy', 'terraform apply', 'kubectl delete pod x', 'psql -c "DROP TABLE users"'])
      expect(sh(c), c).toBeDefined();
    expect(travaReason('PowerShell', { command: 'git push' }, root)).toBeDefined();
    expect(travaReason('command', { command: 'git push' }, root)).toBeDefined();
  });
  it('apagar fora da pasta pede; dentro é livre', () => {
    expect(sh('rm -rf C:\\Users\\u\\docs')).toBeDefined();
    expect(sh('rm -rf ../outro')).toBeDefined();
    expect(sh('rm -rf ~/x')).toBeDefined();
    expect(travaReason('PowerShell', { command: 'Remove-Item -Recurse D:\\dados' }, root)).toBeDefined();
    expect(sh('rm -rf dist node_modules')).toBeUndefined();
    expect(sh('rm C:\\proj\\tmp.txt')).toBeUndefined();
  });
  it('escrever fora da pasta pede', () => {
    expect(travaReason('Write', { file_path: 'C:\\Windows\\x.txt' }, root)).toBeDefined();
    expect(travaReason('Edit', { file_path: 'C:\\proj\\src\\a.ts' }, root)).toBeUndefined();
  });
  it('comandos comuns são livres', () => {
    for (const c of ['git status', 'git commit -m "push later"', 'npm test', 'npm run build', 'git pushd', 'echo git push']) expect(sh(c), c).toBeUndefined();
  });
  it('env bloqueia todo push e preserva GIT_CONFIG já existente', () => {
    expect(travaEnv({})).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.habblaud-trava:blocked/.pushInsteadOf', GIT_CONFIG_VALUE_0: '' });
    expect(travaEnv({ GIT_CONFIG_COUNT: '2' })).toEqual({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: 'url.habblaud-trava:blocked/.pushInsteadOf', GIT_CONFIG_VALUE_2: '' });
  });
  ```

  Nota: o caso `echo git push` é livre, e `git commit -m "push later"` também. O matcher quebra o comando em segmentos por `&&`, `||`, `;`, `|` e quebra de linha, tira prefixos de wrapper (`rtk`, `sudo`, `env X=Y`, `npx`), e só então compara o primeiro token mais o subcomando. O subcomando é o primeiro token que não é opção, pulando as opções do git com valor (`-C <dir>`, `-c <k=v>`). Use `shellWords` (shared/activity.ts:137) para tokenizar.
- [ ] **Step 2: Rodar** `npx vitest run server/chat/trava.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Implementar.** Tabela de regras como `{ cmd: string; sub?: RegExp; reason: string }[]`. O `psql`/`mysql`/`sqlcmd` só pede com `DROP|TRUNCATE|DELETE FROM` sem `WHERE`.
  - "Fora da pasta": o caminho absoluto, ou relativo resolvido contra `root`, que não começa com `root + sep` (comparação sem diferenciar maiúsculas no win32), ou que começa com `~`.
- [ ] **Step 4: Rodar.** Esperado: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: trava do automático (push, publicar, deploy, banco e apagar fora da pasta)"`

---

### Task 6: Uso e limites

**Files:**
- Create: `server/chat/usage.ts`, `server/chat/usage.test.ts`

**Interfaces:**
- Consumes: `ChatLimits`, `ChatState` (shared/chat.ts), `ChatEvent` 'usage'.
- Produces:
  - `export interface Spend { usd: number; tokens: number; lastCumulativeUsd?: number }`
  - `export function addUsage(s: Spend, e: Extract<ChatEvent, { type: 'usage' }>): { spend: Spend; turnUsd?: number }`
  - `export function overLimit(s: Spend, l: ChatLimits): 'cost' | 'tokens' | undefined`
  - `export function remainingUsd(s: Spend, l: ChatLimits): number | undefined`

- [ ] **Step 1: Teste que falha** (Review Focus 3, com os números reais):

  ```ts
  it('custo cumulativo do Claude: soma só a diferença e não zera no erro', () => {
    let s: Spend = { usd: 0, tokens: 0 };
    let r = addUsage(s, { type: 'usage', tokensIn: 100, tokensOut: 4, costUsd: 0.1015494, costIsCumulative: true });
    expect(r.turnUsd).toBeCloseTo(0.1015494); s = r.spend;
    r = addUsage(s, { type: 'usage', tokensIn: 200, tokensOut: 590, costUsd: 0.11005549, costIsCumulative: true });
    expect(r.turnUsd).toBeCloseTo(0.00850609); s = r.spend;
    expect(s.usd).toBeCloseTo(0.11005549);
    r = addUsage(s, { type: 'usage', tokensIn: 0, tokensOut: 0, costUsd: 0, costIsCumulative: true }); // rodada que falhou
    expect(r.spend.usd).toBeCloseTo(0.11005549);
    expect(r.spend.lastCumulativeUsd).toBeCloseTo(0.11005549);
    expect(s.tokens).toBe(100 + 4 + 200 + 590);
  });
  it('limite: US$ quando há custo, tokens quando não; bloqueia a partir do limite', () => {
    expect(overLimit({ usd: 0.5, tokens: 10 }, { maxCostUsd: 0.5 })).toBe('cost');
    expect(overLimit({ usd: 0.49, tokens: 10 }, { maxCostUsd: 0.5 })).toBeUndefined();
    expect(overLimit({ usd: 0, tokens: 50_000 }, { maxTokens: 50_000 })).toBe('tokens');
    expect(remainingUsd({ usd: 0.2, tokens: 0 }, { maxCostUsd: 0.5 })).toBeCloseTo(0.3);
    expect(remainingUsd({ usd: 0.2, tokens: 0 }, {})).toBeUndefined();
  });
  ```

- [ ] **Step 2: Rodar.** Esperado: FAIL.
- [ ] **Step 3: Implementar.** Cumulativo: `turnUsd = max(0, cost - (lastCumulativeUsd ?? 0))`, e `lastCumulativeUsd = max(last, cost)`. Não cumulativo: soma direta. Tokens sempre somados (`tokensIn + tokensOut`).
- [ ] **Step 4: Rodar.** Esperado: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: soma de uso e limites de custo/tokens do chat"`

---

### Task 7: Persistência das conversas e papéis

**Files:**
- Create: `server/chat/store.ts`, `server/chat/store.test.ts`, `server/chat/roles.ts`, `server/chat/roles.test.ts`

**Interfaces:**
- Produces (`store.ts`):
  ```ts
  export interface ChatRecord { v: 1; agentId: string; provider: Provider; account?: string; folder: string; cwd: string; model?: string; roleId?: string; permission: ChatPermission; providerSessionId?: string; limits: ChatLimits; spend: Spend; items: ChatItem[]; isolated?: { branch: string; path: string; base: string; merged?: boolean; discarded?: boolean }; vboardsTaskId?: string; name?: string; seed: number; createdAt: number; running?: boolean; alwaysAllow: string[] }
  export class ChatStore { constructor(dir: string); load(): ChatRecord[]; save(r: ChatRecord): void; remove(agentId: string): void }
  export const ITEMS_KEEP = 500;
  ```
- Produces (`roles.ts`):
  ```ts
  export interface RoleInfo { id: string; name: string; text: string; builtin?: true }
  export const BUILTIN_ROLES: readonly RoleInfo[]; // ids: dev, qa, revisor, designer, pesquisador, orquestrador
  export class RoleStore { constructor(file: string); list(): RoleInfo[]; get(id: string): RoleInfo | undefined; put(raw: unknown): RoleInfo | { error: string }; remove(id: string): boolean }
  ```

- [ ] **Step 1: Teste que falha.**
  - `store.test.ts` (dir `mkdtempSync`):
    - `save` grava `<dir>/<encodeURIComponent(agentId)>.json` de forma atômica (tmp + `renameSync`) e `load` devolve o mesmo.
    - Com 600 itens, `save` corta para os 500 últimos (`ITEMS_KEEP`).
    - Um arquivo corrompido é ignorado e o resto carrega.
    - `load` marca quem tinha `running: true` com `running: false` e anexa `{kind:'notice',level:'error',text:'A rodada foi interrompida porque o servidor reiniciou.'}`.
  - `roles.test.ts`:
    - Sem arquivo, `list()` devolve os 6 prontos, na ordem Dev, QA, Revisor, Designer, Pesquisador, Orquestrador.
    - `put({id:'qa', name:'QA', text:'x'})` edita.
    - `put({name:'Meu', text:'y'})` cria com id novo.
    - `remove('dev')` apaga, e o papel continua apagado depois de recriar o `RoleStore`.
    - `put` com `text` acima de 8000 ou `name` vazio/acima de 40 devolve `{error}`.
    - O arquivo fica em `<dataDir>/chat/roles.json`, nunca na pasta do projeto.
- [ ] **Step 2: Rodar** `npx vitest run server/chat/store.test.ts server/chat/roles.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Implementar.** O texto dos 6 papéis segue o spec (seção "Papéis prontos"), em PT, escrito do zero.
  - Dev: "implementa de ponta a ponta, testa, commita em português e no fim diz o que mudou e o que ficou de fora".
  - QA: "só testa, não corrige".
  - Revisor: "não edita".
  - Designer: "usa as skills de design do usuário (impeccable, ui-ux-pro-max)".
  - Pesquisador: "relatório curto, não mexe em código".
  - Orquestrador: "quebra o pedido em partes e diz a quem delegaria; ainda não abre outros agentes".

  Nomes e textos são dados do usuário, não `tr()`. O `RoleStore` grava a lista inteira na primeira mudança.
- [ ] **Step 4: Rodar.** Esperado: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: conversas do chat e papéis guardados em ~/.habblaud"`

---

### Task 8: ChatService: rodadas, retomar, parar, limites e Office

**Files:**
- Create: `server/chat/service.ts`, `server/chat/service.test.ts`; acrescentar a `server/chat/types.ts` a interface `WorktreeOps` (forma na Task 11)
- Modify: `shared/types.ts` (`AgentInfo.chat?: true`), `server/model/office.ts` (`MainInput.chat?: true` copiado para o `AgentInfo`), `server/pty/manager.ts` (`export const INHERITED_SESSION_VARS`)

**Interfaces:**
- Consumes: drivers (Tasks 2–4), `resolveCliBin`, `travaEnv` (Task 5), `addUsage`/`overLimit`/`remainingUsd` (Task 6), `ChatStore`/`RoleStore` (Task 7), `Office.addMain`/`setStatus`/`addActivity`/`applyTranscript`/`closeMain`/`setCharacter`, `describeTool` (shared/activity.ts:658), `maskSecrets`, `pickName`.
- Produces:
  ```ts
  export interface ChatOpenRequest { folder: string; provider: Provider; account?: string; model?: string; roleId?: string; permission?: ChatPermission; isolated?: boolean; limits?: ChatLimits; name?: string; prompt: string; vboardsTaskId?: string }
  export type ChatOpenResult = { agentId: string } | { error: 'invalid' | 'unavailable' | 'too-many'; reason: string };
  export interface ChatProcess { pid?: number; stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream; stdin: NodeJS.WritableStream; on(e: 'close', cb: (code: number | null) => void): void }
  export interface ChatServiceDeps { office: Office; dataDir: string; port: number; knownFolders: () => string[]; accounts: AccountsService; bins?: (p: Provider) => CliBin | undefined; spawnProcess?: (file: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => ChatProcess; kill?: (pid: number) => void; now?: () => number; newId?: () => string; platform?: NodeJS.Platform; worktrees?: WorktreeOps; onFinish?: (agentId: string) => void }
  export class ChatService {
    constructor(deps: ChatServiceDeps);
    start(): void;                                   // carrega o store e recoloca os agentes no Office
    providers(): Array<{ id: Provider; available: boolean; reason?: string; ask: boolean }>;
    open(raw: unknown): ChatOpenResult;
    send(agentId: string, raw: unknown): 'ok' | 'not-found' | 'busy' | 'blocked' | 'invalid';
    stop(agentId: string): 'ok' | 'not-found' | 'idle';
    setLimits(agentId: string, raw: unknown): 'ok' | 'not-found' | 'invalid';
    view(agentId: string, after?: number): ChatView | undefined;
    close(agentId: string): 'ok' | 'not-found' | 'busy';
    isChatSession(sessionId: string): boolean;       // id da conversa do provedor (Task 9)
    lastReply(agentId: string): string | undefined;  // VBoards (Task 15)
    tokenOwner(token: string): string | undefined;   // MCP (Task 10)
    addApproval(agentId: string, item: Omit<Extract<ChatItem, { kind: 'approval' }>, 'seq' | 'at'>): void;
  }
  export const MAX_CHAT_AGENTS = 8;
  ```

- [ ] **Step 1: Teste que falha** (`service.test.ts`). `spawnProcess` falso: devolve streams `PassThrough`, grava `{file,args,cwd,env,stdin}` e, quando o teste manda, escreve as linhas de uma fixture e emite `close`.
  1. **Abrir.** `open({folder:'C:\\proj', provider:'claude', prompt:'oi'})` com `knownFolders` = `['C:\\proj']` devolve `{agentId:'chat:<newId>'}`. O Office tem `{kind:'main', provider:'claude', chat:true, status:'working'}`. O argv tem `--session-id <uuid>`, e o `ChatRecord.providerSessionId` já é esse uuid antes do fim.
  2. **Pasta desconhecida.** `open({folder:'C:\\outro',…})` devolve `{error:'invalid'}`, e nenhum processo é criado.
  3. **Rodada.** Com a fixture `claude-turn.jsonl` e `close(0)`:
     - itens `user`, `tool` × 2 (o do push com `error:true`), `assistant` e `usage`;
     - o Office fica com `status:'idle'` e `stats.tokensOut` 590;
     - o `onFinish` é chamado com o id.
  4. **Retomar.** O 2º `send` usa `--resume <mesmo uuid>`. Um `send` durante uma rodada devolve `'busy'`.
  5. **Parar.**
     - `stop()` no win32 chama `kill(pid)` e acrescenta o notice `'Rodada interrompida.'`.
     - Review Focus 4: o `kill` padrão no win32 roda `execFile('taskkill', ['/PID', String(pid), '/T', '/F'])`. Testar a função exportada `defaultKill(pid, platform, exec)`, que recebe o `exec` injetado.
     - Fora do win32: `process.kill(-pid, 'SIGTERM')`, com o filho criado em `detached: true`.
  6. **Tempo.** Com `limits:{maxTurnMinutes:1}` e `now`/timers falsos (`vi.useFakeTimers()`), depois de 60_000 ms a rodada para e entra o notice `'Tempo da rodada esgotado (1 min).'`.
  7. **Custo.**
     - `limits:{maxCostUsd:0.1}` mais a fixture (0.11005549) deixa `state.blocked='cost'`, e o `send` devolve `'blocked'`.
     - `setLimits({maxCostUsd:1})` libera.
     - O argv seguinte tem `--max-budget-usd` com o restante (`0.88994451`, conferido com `toBeCloseTo`).
  8. **Env.**
     - Sem `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` nem `CLAUDE_CODE_SESSION_ID` (`INHERITED_SESSION_VARS`).
     - Conta não padrão vira `CLAUDE_CONFIG_DIR`.
     - Codex/agy recebem `travaEnv`, e o Claude **não** (a trava dele é a aprovação).
  9. **Reinício.** Um `ChatService` novo sobre o mesmo `dataDir` recoloca o agente no Office (status `idle`) com os itens e o mesmo `providerSessionId`.
  10. **Segredos.** Uma saída de ferramenta com `sk-ant-…` chega ao `view()` já mascarada.
- [ ] **Step 2: Rodar** `npx vitest run server/chat/service.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Implementar.**
  - Uma rodada por vez por agente.
  - `spawn(bin.file, [...bin.prefix, ...inv.args], { cwd, env, shell: false, windowsHide: true, detached: platform !== 'win32' })`, com `stdin.end(inv.stdin ?? '')`.
  - Linhas lidas com `readline.createInterface({ input: stdout, crlfDelay: Infinity })`, que trata chunk partido e UTF-8.
  - Os eventos atualizam:
    - os itens (com `maskSecrets` e corte em `CHAT_TOOL_OUTPUT_MAX`);
    - o Office: `addActivity` com `describeTool(name, input)` e `setStatus('working')`; `approval` vira `setStatus('waiting', tr('aprovação'))`; o fim vira `setStatus('idle')` mais `applyTranscript` com `stats`;
    - o `state.phase`.
  - Sempre salvar ao fim da rodada e a cada item de ferramenta.
  - O id do Claude é `randomUUID()` na abertura. Codex e agy ganham o id no evento `session`.
  - `providers()` usa `resolveCliBin`. O motivo vem em `tr('{0} não encontrado no PATH', [nome])`, e `ask` é `provider === 'claude'`.
  - O nome sorteado vem de `pickName(agentId, usados)`, salvo se o pedido trouxer um. Nome dado vira `office.setCharacter(id, { name, seed })`.
  - `MAX_CHAT_AGENTS = 8` abertos; acima disso, `'too-many'`.
  - O `role` (texto do `RoleStore`) vai em toda rodada; o driver do agy só o usa com `first`. O Claude sempre recebe `mcp` (no automático também, por causa da trava) e `budgetUsd = remainingUsd(...)`.
- [ ] **Step 4: Rodar.** Esperado: PASS. Rodar também `npx vitest run server/model` (Office) e esperar PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: runtime do chat com agentes (rodada por mensagem, retomar, parar, limites)"`

---

### Task 9: Sem agente em dobro e sem cartão em dobro

**Files:**
- Modify: `server/sources/watcher.ts` (`WatcherOptions.ignoreSession?: (sessionId: string) => boolean`, checado em `poll`/`syncSession` antes do `addMain`), `server/sources/codex/source.ts` (`CodexSourceOptions.ignoreSession?`, checado pelo thread id), `server/permissions/registry.ts`
- Test: `server/sources/watcher.test.ts`, `server/sources/codex/source.test.ts`, `server/permissions/registry.test.ts` (acrescentar casos)

**Interfaces:**
- Consumes: `ChatService.isChatSession` (Task 8).
- Produces (registry):
  - `registerChat(p: { agentId: string; sessionId: string; tool: string; input: Record<string, unknown>; timeoutMs: number }): { id: string; expiresAt: number } | { skip: 'too-many' }`
  - O `register(raw)` atual devolve `{ skip: 'chat-agent' }` quando o alvo resolvido tem `chat: true`. O `RegisterResult` ganha `'chat-agent'`, e o hook sai sem decidir, o que deixa o pedido seguir para o permission tool.

- [ ] **Step 1: Testes que falham** (Review Focus 5):
  - `watcher.test.ts`: uma entrada de registro `{"pid":4242,"sessionId":"80aa7451-3f3d-455c-aea0-72f7149af416","kind":"interactive","entrypoint":"sdk-cli",…}` com `ignoreSession: (s) => s === '80aa7451-…'` não cria agente. Sem a opção, cria (o comportamento atual se mantém).
  - `codex/source.test.ts`: um thread com `ignoreSession` devolvendo true não aparece.
  - `registry.test.ts`:
    - Com um agente `{provider:'claude', chat:true, sessionId:'S'}` no Office, `register({session_id:'S', tool_name:'Bash', tool_input:{command:'ls'}, hook_event_name:'PermissionRequest'})` devolve `{skip:'chat-agent'}`.
    - `registerChat({agentId, sessionId:'S', tool:'Bash', input:{command:'git push'}, timeoutMs:300_000})` devolve `{id}` **mesmo com `viewers() === 0`** (o pedido espera a página abrir).
    - O `snapshot()` traz o pedido nesse agente, e `decide(id,{behavior:'allow'})` resolve o `wait()`.
- [ ] **Step 2: Rodar** `npx vitest run server/sources server/permissions`. Esperado: FAIL nos novos.
- [ ] **Step 3: Implementar.** `registerChat` reaproveita `describeTool`/`toolView` e o mesmo `Pending`, e não marca `codex`. Ele não passa pelo `answeredInTerminal`: põe no `Pending` um `chat: true` que o laço de varredura pula.
- [ ] **Step 4: Rodar.** Esperado: PASS em todos (os testes antigos inclusive).
- [ ] **Step 5: Commit.** `git commit -m "fix: agente aberto pelo chat não aparece duas vezes nem pede permissão em dobro"`

---

### Task 10: Aprovações do Claude (permission tool via MCP HTTP)

**Files:**
- Create: `server/chat/permission.ts`, `server/chat/permission.test.ts`

**Interfaces:**
- Consumes: `travaReason` (Task 5), `PermissionRegistry.registerChat`/`wait` (Task 9), `ChatService.tokenOwner`/`addApproval` (Task 8).
- Produces:
  ```ts
  export type ToolDecision = { behavior: 'allow' } | { behavior: 'ask'; reason?: string } | { behavior: 'deny'; message: string };
  export function decideClaudeTool(tool: string, input: Record<string, unknown>, o: { permission: ChatPermission; root: string; alwaysAllow: readonly string[] }): ToolDecision;
  export function alwaysKey(tool: string, input: Record<string, unknown>): string; // 'Bash:npm' | 'Edit'
  export function handleMcp(body: unknown, call: (args: { tool_name: string; input: Record<string, unknown>; tool_use_id?: string }) => Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }>): Promise<unknown | undefined>; // undefined = notificação (202)
  ```

- [ ] **Step 1: Teste que falha.**

  ```ts
  const o = { permission: 'auto' as const, root: 'C:\\proj', alwaysAllow: [] };
  it('auto: libera tudo menos a trava', () => {
    expect(decideClaudeTool('Bash', { command: 'npm test' }, o)).toEqual({ behavior: 'allow' });
    expect(decideClaudeTool('Bash', { command: 'rtk git push origin main' }, o).behavior).toBe('ask');
  });
  it('pedir aprovação: pergunta tudo, salvo o "não perguntar de novo"', () => {
    const a = { ...o, permission: 'ask' as const };
    expect(decideClaudeTool('Bash', { command: 'npm test' }, a).behavior).toBe('ask');
    expect(decideClaudeTool('Bash', { command: 'npm test' }, { ...a, alwaysAllow: ['Bash:npm'] })).toEqual({ behavior: 'allow' });
    expect(decideClaudeTool('Bash', { command: 'git push' }, { ...a, alwaysAllow: ['Bash:git'] }).behavior).toBe('ask'); // a trava vence o "sempre"
  });
  it('MCP: initialize, tools/list e tools/call no formato que o Claude Code usa', async () => {
    const allow = async (a: { input: Record<string, unknown> }) => ({ behavior: 'allow' as const, updatedInput: a.input });
    expect(await handleMcp({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, allow))
      .toMatchObject({ id: 0, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } });
    const list = (await handleMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, allow)) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['approve']);
    const call = await handleMcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_1' } } }, allow);
    expect(call).toEqual({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"behavior":"allow","updatedInput":{"command":"ls"}}' }] } });
    expect(await handleMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, allow)).toBeUndefined();
    expect(await handleMcp({ jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover' }, allow)).toEqual({ jsonrpc: '2.0', id: 'server-discover-probe-1', result: {} }); // igual à sonda que funcionou
  });
  ```

- [ ] **Step 2: Rodar** `npx vitest run server/chat/permission.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Implementar.**
  - `decideClaudeTool`: a trava devolve `ask` com o motivo. No `ask`, a resposta é `ask`, salvo quando `alwaysKey` está em `alwaysAllow`. No `auto`, `allow`.
  - O `call` real, montado na Task 12, segue esta ordem:
    1. `decideClaudeTool`.
    2. Se `allow`, devolve `{behavior:'allow', updatedInput: input}`.
    3. Se `ask`, chama `registry.registerChat` e `chat.addApproval(...)`, e espera em laço `registry.wait(id, 25_000)` até `decided`/`released`.
  - Mapeamento do resultado:
    - `allow` com `suggestion === 0` acrescenta `alwaysKey` a `alwaysAllow` (o botão "aprovar e não perguntar de novo" usa a sugestão 0).
    - `deny` devolve `{behavior:'deny', message: tr('Recusado pelo usuário no AgenticOffice: {0}', [msg])}`.
    - `released`/timeout devolvem `deny` com `tr('Sem resposta a tempo.')`.
  - O pedido do chat carrega `suggestions: [{ label: tr('Aprovar e não perguntar de novo') }]`, no formato `PermissionSuggestionInfo` existente.
- [ ] **Step 4: Rodar.** Esperado: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: aprovar/recusar no chat as ações do Claude Code (permission tool)"`

---

### Task 11: Cópia isolada (git worktree)

**Files:**
- Create: `server/chat/worktree.ts`, `server/chat/worktree.test.ts`

**Interfaces:**
- Consumes: a interface `WorktreeOps`, que a Task 8 declara em `server/chat/types.ts` (o `ChatService` já recebe `deps.worktrees`). Esta task só a implementa.
- Produces (a forma da interface, para a Task 8 copiar em `types.ts`, e a fábrica):
  ```ts
  export interface WorktreeOps {
    create(repo: string, agentId: string, label: string): Promise<{ path: string; branch: string; base: string } | { error: string }>;
    summary(w: { path: string; base: string }): Promise<{ files: number; added: number; removed: number; commits: number; stat: string }>;
    merge(repo: string, w: { path: string; branch: string }, message: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    discard(repo: string, w: { path: string; branch: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
  }
  export function createWorktreeOps(dataDir: string, git?: (args: string[], cwd: string) => Promise<{ code: number; out: string }>): WorktreeOps;
  ```

- [ ] **Step 1: Teste que falha** (git real num repo `mkdtempSync`, padrão dos testes de spawn):
  1. **Criar.** `create` faz `git worktree add -b agentic/<label-slug>-<6 hex> <dataDir>/chat/worktrees/<id seguro> HEAD`. O caminho fica fora do repo, e `base` é o sha do HEAD.
  2. **Pasta sem git.** `create` devolve `{error: 'A pasta não é um repositório git.'}`.
  3. **Resumo.** Depois de escrever e commitar 1 arquivo na worktree, `summary` traz `files: 1` e `commits: 1`.
  4. **Juntar com repo limpo.** `merge` primeiro commita o que estiver sem commit na worktree (`git add -A` + `git commit -m <message>`) e depois roda `git merge --no-ff --no-edit <branch>` no repo. O arquivo aparece no repo, e a worktree e o branch **continuam** (só o Descartar apaga).
  5. **Juntar com repo sujo.** `merge` devolve `{ok:false, reason:'A pasta do projeto tem mudanças sem commit; faça commit ou guarde antes de juntar.'}` e não toca em nada.
  6. **Conflito.** `merge` roda `git merge --abort`, devolve `{ok:false, reason:'Conflito ao juntar; nada foi alterado no projeto.'}`, e o repo fica no HEAD anterior.
  7. **Descartar.** `discard` roda `git worktree remove --force` e `git branch -D`, e o branch some.
- [ ] **Step 2: Rodar** `npx vitest run server/chat/worktree.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Implementar** com `execFile('git', args, { cwd, windowsHide: true })` sem shell.
  - O `ChatService` (Task 8, via `deps.worktrees`) usa `create` no `open` quando `isolated`.
  - Nesse caso, `cwd` = worktree e `writableRoots` = `[worktree, <repo>/.git]`, porque o commit numa worktree escreve no `.git` do repo. A Task 1, passo (c), confirma isso no Codex.
  - Ao fim de cada rodada com cópia isolada, entra um item `notice` com o `summary.stat`.
- [ ] **Step 4: Rodar.** Esperado: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: cópia isolada do agente em git worktree com Juntar e Descartar"`

---

### Task 12: Rotas HTTP do chat, acesso e Docker

**Files:**
- Create: `server/chat/http.ts`, `server/chat/http.test.ts`
- Modify: `server/http/app.ts` (`ApiDeps.chat?: ChatRoutes`, bloco `/api/chat`, `access.chat`), `shared/types.ts` (`AccessInfo.chat?: boolean`, `OfficeSnapshot.meta.chat?: { enabled: boolean; reason?: string }`), `server/index.ts` (liga o `ChatService`), `client/src/net/access.ts` (aceita `chat`), `shared/locales/{en,es,fr}.ts`

**Interfaces:**
- Consumes: `ChatService`, `RoleStore`, `WorktreeOps`, `handleMcp`/`decideClaudeTool`, `PermissionRegistry`, `ptyRequestProblem` (server/http/pty.ts:26), `readJson`/`sendJson` (app.ts).
- Produces: `export function createChatRoutes(d: { chat: ChatService; roles: RoleStore; registry: PermissionRegistry }): (req: IncomingMessage, res: ServerResponse, path: string) => boolean`. Rotas:

  | Método e caminho | Corpo | Resposta |
  |---|---|---|
  | `GET /api/chat/options` | – | `{ providers, roles, folders: SpawnFolder[], accounts: {id,provider,short}[] }` |
  | `POST /api/chat/agents` | `ChatOpenRequest` | 201 `{agentId}` / 400 / 409 / 429 |
  | `GET /api/chat/agents/:id?after=<seq>` | – | `ChatView` |
  | `POST /api/chat/agents/:id/messages` | `{text}` | 202 / 409 `busy` / 409 `blocked` |
  | `POST /api/chat/agents/:id/stop` | – | 200 |
  | `PUT /api/chat/agents/:id/limits` | `ChatLimits` | 200 |
  | `POST /api/chat/agents/:id/merge` · `/discard` | – | 200 / 409 `{error: reason}` |
  | `DELETE /api/chat/agents/:id` | – | 200 (fecha; o `closeMain` tira do escritório) |
  | `GET/PUT /api/chat/roles`, `DELETE /api/chat/roles/:id` | `RoleInfo` | lista |
  | `POST /api/chat/mcp/:agentId` | JSON-RPC + `Authorization: Bearer <token>` | JSON-RPC / 202 / 401 |

- [ ] **Step 1: Teste que falha** (`http.test.ts`, no estilo de `server/test/permission-server.ts`: servidor HTTP efêmero com deps falsas):
  - Um pedido com `Host: 192.168.0.10` ou com `Origin: http://evil` em `/api/chat/agents` devolve 403 com a mensagem de `ptyRequestProblem`.
  - Um `POST /api/chat/mcp/chat:1` sem `Bearer` ou com token de outro agente devolve 401. Com o token certo, `tools/call` devolve o texto JSON da Task 10.
  - `GET /api/chat/agents/x?after=3` só devolve itens com `seq > 3`.
  - Um corpo acima de `MAX_BODY` devolve 413.
  - Em `app.test.ts` (acrescentar): sem `deps.chat` (Docker), `/api/access` traz `chat: false` e `/api/chat/options` devolve 403 com `tr('Chat com agentes indisponível no Docker: rode o servidor direto no computador.')`.
- [ ] **Step 2: Rodar** `npx vitest run server/chat/http.test.ts server/http`. Esperado: FAIL.
- [ ] **Step 3: Implementar.**
  - `index.ts`: `const chatOn = !config.inDocker && ptyOptIn`.
  - O `ChatService` recebe:
    - `knownFolders: () => recentFolders(...)` (as mesmas entradas do `/api/spawn/folders`), mais os candidatos do VBoards;
    - `accounts`, `port: config.port` e `dataDir: config.dataDir`.
  - Passar `ignoreSession: (s) => chat?.isChatSession(s) ?? false` ao `ClaudeWatcher` e ao `CodexSource`. Os dois são criados antes do chat, então a opção é uma closure.
  - `meta.chat`:
    - Docker: `{enabled:false, reason: tr('Chat com agentes indisponível no Docker: rode o servidor direto no computador.')}`.
    - Sem `HABBLAUD_PTY`: `{enabled:false, reason: tr('Chat com agentes desligado: inicie o servidor com HABBLAUD_PTY=1.')}`.
  - O token MCP sai de `randomBytes(24).toString('base64url')` por agente, fica só na memória e não entra no `ChatRecord`. Ele é recriado a cada rodada.
  - A URL do MCP é `http://127.0.0.1:<port>/api/chat/mcp/<encodeURIComponent(agentId)>`.
  - O `/api/chat/mcp/` entra em `isLocalOnlyPath` e fica isento da exigência de `Origin` do `http/guard.ts` (a chamada vem do `claude.exe`, sem Origin). Ele exige `req.socket.remoteAddress` em loopback e o Bearer. Um `GET` nele (o Claude tenta abrir SSE) devolve 405.
  - Traduções das strings novas em en/es/fr.
- [ ] **Step 4: Rodar** os testes da etapa e depois `npm run typecheck` e `npm run i18n:check` (sem "sem tradução" das chaves novas). Esperado: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: rotas locais do chat com agentes (desligado no Docker com aviso)"`

---

### Task 13: Painel do chat no drawer

**Files:**
- Create: `client/src/ui/chat-model.ts`, `client/src/ui/chat-model.test.ts`, `client/src/ui/chat.ts`
- Modify: `client/src/ui/drawer.ts` (seção do chat; sem `msgSec`, sem botão de terminal e sem `PermissionCard` solto para `agent.chat`), `client/src/ui/styles.css`, `shared/locales/{en,es,fr}.ts`

**Interfaces:**
- Consumes: `ChatView`, `ChatItem`, `ChatState` (shared/chat.ts), `enterSends` (composer-model.ts:60), `h`, `iconButton`, `KeyedList` (dom.ts), `PermissionCard` (permission.ts:189; o cartão continua o mesmo e entra dentro do chat), `store.decidePermission`, preview helpers de `terminal.ts`.
- Produces:
  ```ts
  // chat-model.ts
  export function chatStatusText(s: ChatState): string;
  export function usageText(i: Extract<ChatItem, { kind: 'usage' }>): string;
  export function toolLine(i: Extract<ChatItem, { kind: 'tool' }>): { title: string; detail: string; failed: boolean };
  export function canSendChat(raw: string, s: ChatState): { ok: true } | { ok: false; why: string };
  export function mergeItems(have: ChatItem[], incoming: ChatItem[]): ChatItem[]; // por seq, sem duplicar
  export function pollDelayChat(s: ChatState): number; // 700 rodando, 4000 parado
  // chat.ts
  export class ChatPanel { readonly el: HTMLElement; constructor(ctx: UiContext); open(agentId: string): void; render(agent: AgentInfo): void; close(): void }
  ```

- [ ] **Step 1: Teste que falha** (`chat-model.test.ts`, só lógica, em node):

  ```ts
  const st = (o: Partial<ChatState> = {}): ChatState => ({ phase: 'idle', spentUsd: 0, spentTokens: 0, limits: {}, ...o });
  it('status ao vivo', () => {
    expect(chatStatusText(st({ phase: 'thinking' }))).toBe('Pensando…');
    expect(chatStatusText(st({ phase: 'tool', tool: 'Bash' }))).toBe('Usando Bash…');
    expect(chatStatusText(st({ phase: 'approval' }))).toBe('Esperando sua aprovação');
    expect(chatStatusText(st({ blocked: 'cost', limits: { maxCostUsd: 1 } }))).toBe('Limite de custo atingido (US$ 1,00). Aumente o limite para continuar.');
  });
  it('uso da rodada', () => {
    expect(usageText({ seq: 1, at: 0, kind: 'usage', tokensIn: 185486, tokensOut: 590, costUsd: 0.0085, ms: 11191 })).toBe('185,5 mil tokens de entrada · 590 de saída · US$ 0,0085 · 11 s');
    expect(usageText({ seq: 1, at: 0, kind: 'usage', tokensIn: 1200, tokensOut: 40, ms: 3000 })).toBe('1,2 mil tokens de entrada · 40 de saída · 3 s');
  });
  it('envio: Enter manda, vazio/rodando/bloqueado não', () => {
    expect(canSendChat('  ', st())).toMatchObject({ ok: false });
    expect(canSendChat('oi', st({ phase: 'thinking' }))).toEqual({ ok: false, why: 'Espere a rodada terminar ou toque em Parar.' });
    expect(canSendChat('oi', st({ blocked: 'tokens' }))).toMatchObject({ ok: false });
    expect(canSendChat('oi', st())).toEqual({ ok: true });
  });
  it('itens chegam por seq sem duplicar', () => {
    const a = { seq: 1, at: 0, kind: 'user', text: 'a' } as const, b = { seq: 2, at: 0, kind: 'assistant', text: 'b' } as const;
    expect(mergeItems([a], [a, b])).toEqual([a, b]);
  });
  ```

  (Os números usam `intlLocale()`, que nos testes está em pt-BR.)
- [ ] **Step 2: Rodar** `npx vitest run client/src/ui/chat-model.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Implementar.**
  - `ChatPanel`: lista (`KeyedList` por `seq`) e textarea `ui-chat__input` (Enter envia via `enterSends`, e Shift+Enter quebra linha, como no `MessageComposer.onKey`, incluindo o `stopPropagation`).
  - Botões:
    - `Parar`: `POST …/stop`, visível com `phase !== 'idle'`.
    - `Juntar` e `Descartar`: com `state.isolated` e sem rodada em andamento. O Descartar pede `confirm(tr('Descartar a cópia isolada e o branch {0}? O trabalho não juntado se perde.', [branch]))`.
    - Limite: um campo para aumentar o limite quando `blocked`.
  - Itens:
    - `tool` é um `<details>` recolhido com `toolLine`;
    - `approval` reaproveita o `PermissionCard` atual, que já lê `AgentInfo.permission`;
    - `assistant` é texto com quebra de linha preservada (sem HTML do agente: `textContent`).
  - Polling `GET /api/chat/agents/:id?after=` com `pollDelayChat`, só com o drawer aberto nesse agente.
  - No `drawer.ts`, construir ao lado do `MessageComposer` (por volta da linha 362) e inserir antes de `msgSec.el`. Em `AgentView.render` (:537), mostrar o chat e esconder `msgSec`, `termBtn` e `perm` (que vai para dentro do chat) quando `this.last?.chat`. Em `open(id)` (:442), chamar `chat.open(id)`.
  - O status do chat se espelha no personagem pelo `AgentInfo.status`/`activity` que a Task 8 já alimenta.
- [ ] **Step 4: Rodar** `npx vitest run client/src/ui`, depois `npm run typecheck` e `npm run i18n:check`. Esperado: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: chat do agente no painel lateral (Enter envia, Parar, ferramentas recolhidas, uso)"`

---

### Task 14: Janela de abrir agente ("Mais opções")

**Files:**
- Create: `client/src/ui/spawn-model.ts`, `client/src/ui/spawn-model.test.ts`
- Modify: `client/src/ui/spawn.ts` (`SpawnPanel`), `client/src/ui/styles.css`, `shared/locales/{en,es,fr}.ts`

**Interfaces:**
- Consumes: `GET /api/chat/options`, `POST /api/chat/agents`, `access().chat`, `snapshot.meta.chat`.
- Produces:
  ```ts
  export interface OpenForm { folder: string; provider: Provider; account?: string; model: string; roleId: string; permission: ChatPermission; isolated: boolean; limitUsd: string; limitTokens: string; limitMinutes: string; name: string; prompt: string; vboardsTaskId?: string }
  export function defaultForm(folder: string, providers: Array<{ id: Provider; available: boolean }>): OpenForm; // claude se disponível, auto, sem papel, sem cópia, sem limites
  export function askDisabledReason(provider: Provider): string | undefined;
  export function toRequest(f: OpenForm): ChatOpenRequest | { error: string };
  ```

- [ ] **Step 1: Teste que falha.**
  - `defaultForm('C:\\proj', [{id:'claude',available:false},{id:'codex',available:true}])` escolhe `codex`, com `permission:'auto'`, `isolated:false` e `roleId:''`.
  - `askDisabledReason('codex')` é `'O Codex não pede aprovação ação por ação: roda no automático, em sandbox, e recusa ações irreversíveis.'`, e o do `'antigravity'` segue o mesmo modelo. O do `'claude'` é `undefined`.
  - `toRequest` com `limitUsd:'0,5'` dá `limits:{maxCostUsd:0.5}`. `limitUsd:'abc'` dá `{error}`. Vazio dá sem limite. `permission:'ask'` com codex vira `auto`. O `name` vem aparado.
  - Limite de tokens só para Codex/agy, e US$ só para Claude: `toRequest` ignora o outro.
- [ ] **Step 2: Rodar** `npx vitest run client/src/ui/spawn-model.test.ts`. Esperado: FAIL.
- [ ] **Step 3: Implementar.**
  - Com `access().chat`, o `SpawnPanel` mostra pasta, prompt e provedor no topo e um `<details class="ui-spawn__more">` **fechado**, com o resumo `tr('Mais opções')`, antes do `submitBtn` (spawn.ts:200). Dentro dele:
    - conta;
    - modelo (`<input list>`);
    - papel (`<select>` vindo de `options.roles`, com "Sem papel");
    - permissão (rádio, com "Pedir aprovação" desabilitado e o `title` = `askDisabledReason`);
    - "Cópia isolada (git worktree)";
    - task do VBoards (`<select>` vindo de `GET /api/vboards`);
    - limites;
    - nome.
  - O "Outra pasta" fica escondido no modo chat, porque o servidor só aceita pastas conhecidas.
  - O envio vai para `POST /api/chat/agents`. Com task do VBoards, vai para `POST /api/vboards/start` com `{id, folder, chat: ChatOpenRequest}` (Task 15).
  - Ao abrir, seleciona o agente novo no escritório (`ctx.select(agentId)`), o que abre o drawer no chat.
  - Sem `access().chat` (Docker): o formulário antigo fica intacto, mais a linha `meta.chat.reason` em `ui-spawn__note`.
- [ ] **Step 4: Rodar** `npx vitest run client/src/ui`, `npm run typecheck` e `npm run i18n:check`. Esperado: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: janela de abrir agente com provedor, papel, permissão, cópia isolada e limites"`

---

### Task 15: "Iniciar" do VBoards pela Base

**Files:**
- Modify: `server/vboards/vboards.ts`, `server/vboards/vboards.test.ts`, `server/index.ts` (o `reply` prefere `chat.lastReply`), `client/src/ui/vboards.ts`

**Interfaces:**
- Consumes: `ChatService.open`/`lastReply`.
- Produces:
  - `VBoardsServiceOptions.chat?: { open(raw: unknown): ChatOpenResult }`.
  - `begin(raw)` aceita `{ id, folder?, chat?: Partial<ChatOpenRequest> }`. Com `options.chat`, monta o pedido como hoje e chama `chat.open({ ...raw.chat, folder: picked, prompt, vboardsTaskId: id })`. O `TaskLink` nasce com `agentId` já preenchido, `spawnId: ''` e `session: ''`. A resposta é `{ agentId } | { status, error }`.
  - Sem `options.chat` (Docker), segue o `spawn.submit` de hoje.

- [ ] **Step 1: Teste que falha** (`vboards.test.ts`):
  - Com um `chat` falso, `begin({id:'t1', folder:'C:\\proj'})` chama `chat.open` com `prompt` igual ao que o `spawn.submit` recebia antes e `vboardsTaskId:'t1'`. O `spawn.submit` **não** é chamado.
  - O link fica com `agentId:'chat:1'`. O `advanceLinks` usa esse agente direto: um agente `chat:1` com `status:'idle'` e `stats.tokensOut` > 0 marca `done` com o resumo vindo de `reply('chat:1')`.
  - Sem `chat`, o teste antigo do `spawn.submit` continua passando.
  - `syncTodos`: um agente do chat Claude ligado a uma task não gera item de conversa. Um não ligado gera **um** item ao longo de duas rodadas (o id `chat:…` é estável).
- [ ] **Step 2: Rodar** `npx vitest run server/vboards`. Esperado: FAIL nos novos.
- [ ] **Step 3: Implementar.**
  - No `advanceLinks`, o link com `agentId` pré-preenchido pula o casamento por pasta/título.
  - Cliente: o "Iniciar" (vboards.ts `item(t)`), com `access().chat`, abre o `SpawnPanel` preenchido (pasta, task e prompt da task) em vez de chamar `begin` direto. Sem chat, o comportamento é o atual.
  - Expor `SpawnPanel.openWith(form: Partial<OpenForm>, anchor)`.
- [ ] **Step 4: Rodar** `npx vitest run server/vboards client/src/ui` e `npm run typecheck`. Esperado: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat: Iniciar do VBoards abre o agente pelo chat do escritório"`

---

### Task 16: Verificação final e roteiro de teste do usuário

**Files:**
- Modify: `CHANGELOG.md` (`## [Não lançado]`: uma linha por recurso visível: chat com agentes; janela de abrir agente; papéis; cópia isolada; Iniciar do VBoards pelo chat; chat indisponível no Docker), `server/README.md` (seção curta "Chat com agentes": requisitos, `HABBLAUD_*_BIN`, onde ficam os dados).

- [ ] **Step 1:** `npm run typecheck`. Esperado: sem erros.
- [ ] **Step 2:** `npm run i18n:check`. Esperado: nenhuma linha `sem tradução:` nem `sobrando:` com as chaves novas.
- [ ] **Step 3:** `npx vitest run server/chat server/sources server/permissions server/http server/vboards server/model client/src/ui shared`. Esperado: tudo PASS.
- [ ] **Step 4:** `npm run build`. Esperado: `dist/server/index.js` e o cliente gerados sem erro.
- [ ] **Step 5: Commit.** `git commit -m "docs: changelog e guia do chat com agentes"`. **Sem push.**
- [ ] **Step 6: Entregar ao usuário este roteiro** (em PT), depois de reiniciar o servidor local com `HABBLAUD_PTY=1`:
  1. **Novo agente com Claude.** Abra "Novo agente", escolha uma pasta e o Claude Code e mande "liste os arquivos". O personagem aparece e se anima, e o chat mostra a ferramenta recolhida, a resposta e a linha de uso/custo.
  2. **Continuar.** Mande "o que você fez antes?" no mesmo chat: ele lembra. Reinicie o servidor, abra o agente de novo e mande outra mensagem: a conversa continua.
  3. **Parar.** Peça algo longo e toque em Parar. A rodada para e o chat avisa. No Gerenciador de Tarefas não pode sobrar `claude.exe`, `codex.exe` nem `node`.
  4. **Aprovação no Claude.** Abra outro agente com "Pedir aprovação" e peça "crie um arquivo teste.txt". Aparece o cartão com Aprovar/Recusar: aprove uma vez e recuse outra.
  5. **Trava no automático (Claude).** Num repo de teste, peça "faça git push". O cartão de aprovação aparece mesmo no automático.
  6. **Codex e Antigravity.** Abra um agente de cada. "Pedir aprovação" aparece desabilitado com o motivo. Peça "faça git push": o push é recusado e o chat mostra a falha. Para o Antigravity, faça login com `agy` antes.
  7. **Cópia isolada.** Abra com "Cópia isolada" e peça uma mudança pequena. O fim mostra o resumo do diff. Teste "Juntar" (o arquivo aparece no projeto) e, num segundo agente, "Descartar".
  8. **Limites.** Abra com limite de US$ 0,05 e peça algo maior. O chat avisa que o limite estourou e só aceita mensagem depois de você aumentar o limite.
  9. **VBoards.** Toque em "Iniciar" numa task. A janela abre preenchida. Ao terminar, a subtask fica marcada com o resumo.
  10. **Sem duplicata.** Enquanto um agente do chat trabalha, o escritório **não** mostra um segundo personagem para a mesma conversa, e o cartão de permissão não aparece duas vezes.
  11. **O que já existia.** Sessões abertas no VS Code/terminal seguem aparecendo, e as mensagens pelo plugin e as permissões pelo hook continuam funcionando.

  Só depois do ok do usuário: `git push`.
