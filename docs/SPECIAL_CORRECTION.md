# Correcao especial com token de licenca

Este documento descreve o contrato entre API, Admin e Launcher para a correcao do AppID `4407750`. Ele nao altera o fluxo Premium nem reserva vagas, cooldowns ou ativacoes Premium.

## Responsabilidade da API

- `GET /api/fixes/catalog` marca o item com `activationType: "license_token"` e `minimumLauncherVersion: "1.6.8"`.
- `GET /api/fixes/download?appid=4407750` continua entregando o ZIP original para um launcher autenticado e compativel.
- `POST /api/fixes/license-token?appid=4407750` recebe somente o arquivo de licenca bruto e devolve o token extraido. Nao recebe ZIP, nao extrai arquivos e nao grava token ou conteudo da licenca.
- Ambas as rotas exigem `X-Merlin-Version`; versao ausente, invalida ou menor que `1.6.8` recebe `426` com `launcher_update_required`.

## Seguranca e limites

- A rota do token exige bearer token valido, rate limit de manifests e um `fixOverride` ativo para o AppID.
- O arquivo enviado tem limite de 1 MB. A chave `LICENSE_FILE_AES_KEY_BASE64` fica apenas nos secrets do Worker e precisa ter 16, 24 ou 32 bytes apos Base64.
- A API valida e retorna erros genericos ao cliente; nao expor, registrar ou persistir licenca, token ou segredo.

## Override e imagem

O override permanece em `MERLIN_FILES/overrides.json`, compartilhado por staging e producao. Alem de nome, nota e arquivos, ele pode conter `coverUrl` HTTPS. A API o publica como `imageUrl` no catalogo apenas para apresentacao.

O Admin e a unica superficie que deve editar essa configuracao. O valor nao deve ser codificado no Launcher ou na API por AppID adicional.

## Staging e verificacao

- O fluxo nao cria migration propria: usa R2 e os bindings existentes.
- Antes de testar staging, aplique todas as migrations pendentes com `npm run d1:migrate:stage` e publique painel/API com `npm run deploy-stage:panel`.
- Confirme `GET /api/health`, atualize o catalogo no Launcher e teste primeiro o download simples. O teste completo de instalacao exige um Launcher `1.6.8+`, override ativo e o arquivo de licenca presente no Windows.
