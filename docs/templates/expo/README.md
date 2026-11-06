# Lojas para apps Expo (modelos do Habblaud)

O Habblaud não roda `eas`: ele dispara o workflow `store.yml` do repo do app (`workflow_dispatch` com `kind`, `channel`
e `version`) e acompanha a execução. O CI do próprio repo faz o trabalho, com os segredos dele.

## Fase 0, uma vez por app (helix-app, menopro-app, voer/app, amem/app, expire-app, puro-app)

1. `npx expo install expo-updates` e `eas update:configure` (cria o `updates.url` e o `runtimeVersion`).
2. No `app.json`: `"runtimeVersion": { "policy": "fingerprint" }`. Mudança nativa muda o fingerprint e exige build novo:
   nunca vai por OTA.
3. `eas.json`: perfis `preview` (canal `preview`) e `production` (canal `production`, `autoIncrement: true`) e
   `submit.production` (App Store: `ascAppId`; Play: `serviceAccountKeyPath`, faixa `internal`). `expire-app` e
   `puro-app` ainda não têm `eas.json`: `eas build:configure`.
4. Primeiro build nativo de `preview` e `production` (`eas build`), já com o expo-updates. Sem ele, OTA não chega ao app.
5. Copie `pr.yml` e `store.yml` para `.github/workflows/` do repo.
6. Secrets do repo: `EXPO_TOKEN` (token de acesso do Expo). Credenciais da loja: `eas credentials` (iOS) e a chave
   de serviço do Play referenciada no `eas.json` (guarde o arquivo como secret e grave-o antes do submit, se preferir).
7. No Habblaud (git config da pasta ou Configurações › VBoards):
   `vboards.store=ota` (ou `ota+build`), `vboards.storeWorkflow=store.yml`, `vboards.otaChannel=preview`.
   O token do GitHub precisa de Actions: Read and write.

## O que sai sozinho e o que pede PIN

| Etapa | Automático? |
| --- | --- |
| OTA em `preview` (ou outro canal que não seja `production`) | sim, depois do deployed |
| OTA em `production` | não: PIN |
| Build de loja (`eas build --auto-submit`) | não: PIN |
| Enviar para revisão da loja (`submit`) | não: PIN, pelo cartão "Preparar versão" |

Antes do `submit`, confira no App Store Connect / Play Console o texto "o que há de novo" que o Habblaud propôs
(pt/en/es): ele vem dos títulos dos PRs.
