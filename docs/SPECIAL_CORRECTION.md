# Correcao especial com token de licenca

Este documento descreve o contrato entre API, Admin e Launcher para a correcao do AppID `4407750`. Ele nao altera o fluxo Premium nem reserva vagas, cooldowns ou ativacoes Premium.

## Responsabilidade da API

- `GET /api/fixes/catalog` marca o item com `activationType: "license_token"` e `minimumLauncherVersion: "1.6.8"` quando o modo especial esta ativo. Com a opcao desativada no Admin, publica `activationType: "standard"`.
- `GET /api/fixes/download?appid=4407750` continua entregando o ZIP original para um launcher autenticado e compativel.
- `POST /api/fixes/license-token?appid=4407750` recebe somente o arquivo de licenca bruto e devolve o token extraido. Nao recebe ZIP, nao extrai arquivos e nao grava token ou conteudo da licenca.
- No modo especial, ambas as rotas exigem `X-Merlin-Version`; versao ausente, invalida ou menor que `1.6.8` recebe `426` com `launcher_update_required`. No modo comum, o download aceita launchers anteriores e a rota de token retorna 404.

## Seguranca e limites

- A rota do token exige bearer token valido, rate limit de manifests e um `fixOverride` ativo para o AppID.
- O arquivo enviado tem limite de 1 MB. A chave `LICENSE_FILE_AES_KEY_BASE64` fica apenas nos secrets do Worker e precisa ter 16, 24 ou 32 bytes apos Base64.
- A API valida e retorna erros genericos ao cliente; nao expor, registrar ou persistir licenca, token ou segredo.

## Override e imagem

O override de producao permanece em `MERLIN_FILES/overrides.json`. O AppID 4407750 pode ser editado no staging sem alterar producao: a configuracao de teste fica em `_fix-import/staging/overrides.json` e novos uploads vao para `4407750/fixes/_staging/` ou `4407750/manifests/_staging/`. Alem de nome, nota e arquivos, o override pode conter `coverUrl` HTTPS e `specialCorrectionEnabled` (ausente equivale a ativo).

O Admin e a unica superficie que deve editar essa configuracao. O valor nao deve ser codificado no Launcher ou na API por AppID adicional.

A opcao de token controla somente a instalacao do fix. `manifestOverride` continua independente e pode ser configurado e usado nos dois modos.

## Staging e verificacao

- O fluxo nao cria migration propria: usa R2 e os bindings existentes.
- Esta opcao nao exige migration. Publique painel/API em staging com `npm run deploy-stage:panel`.
- Confirme `GET /api/health`, atualize o catalogo no Launcher e teste primeiro o download simples. O teste completo de instalacao exige um Launcher `1.6.8+`, override ativo e o arquivo de licenca presente no Windows.
