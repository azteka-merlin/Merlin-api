# Metadados para a Biblioteca

`POST /api/games/search` aceita opcionalmente `metadataOnly: true` para consultar
um AppID numérico. A autenticação de licença permanece obrigatória. O padrão
continua sendo a busca convencional, com `metadataOnly: false`.

Nesse modo, a API lê apenas o nome registrado em `games_catalog` e retorna
`coverUrl: null` e `coverSource: null`, sem consultar ou validar imagens externas.
Se o nome não estiver no banco, retorna uma lista
vazia para aquele AppID; não consulta Hubcap, Ryuu, DepotBox ou a loja Steam.
O launcher continua usando os arquivos locais e seu cache de capas.

Uma falha do banco pode resultar em lista de metadados vazia; o launcher deve
continuar mostrando os jogos locais. Não usar esse resultado para marcar um
jogo como inexistente.

```json
{ "searchTerm": "10", "limit": 4, "metadataOnly": true }
```

O modo foi adicionado junto ao carregamento local da Biblioteca no launcher.
Nenhum binding novo é necessário. O launcher atual mantém as capas no cache do
usuário e, quando o circuito da Ryuu está aberto, não inicia novas consultas
remotas de imagem.

Regressão: `npx vitest run tests/library-metadata.test.ts`.

## Publicação em 06/11/2026

- Modo de metadados publicado no Worker de produção pelo script `npm run deploy`.
- Os 8 testes do modo novo passaram. O predeploy aprovou 63 testes Premium,
  incluindo o runtime D1, e a checagem TypeScript.
- Após o deploy, o health respondeu 200. Busca convencional e modo de metadados
  continuaram exigindo autenticação, retornando 401 sem token.
- A consulta autenticada foi coberta nos testes locais; essa checagem de
  produção não utilizou credenciais de clientes nem consumiu ativações.
