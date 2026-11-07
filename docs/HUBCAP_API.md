# Hubcap: API e integração com o Merlin

Referência de trabalho para a integração atual e para a possível troca das fontes de busca e capas. Atualizada em 06/11/2026 a partir da documentação fornecida pelo proprietário, do código do Merlin e das consultas gratuitas realizadas nessa data. A API externa pode mudar; conferir novamente antes de implementar.

## Acesso e cotas

- Base: `https://hubcapmanifest.com/api/v1`.
- Autenticação: `Authorization: Bearer <API_KEY>`. O health é público; os demais exemplos abaixo usam autenticação.
- No Worker, usar o secret `HBCP_KEY`; o código também aceita `HUBCAP_TOKEN` como compatibilidade. Nunca colocar o valor da chave no repositório, no launcher, em logs ou em URLs.
- O proprietário informou que a chave contratada tem limite diário de **1.000 requisições contabilizadas**. Isso é uma característica da conta atual, não um limite universal da API.
- A documentação informa reset à meia-noite no horário do leste dos EUA. O código do Merlin verifica novamente a partir das **06:00 UTC**, depois da meia-noite tanto em EST quanto em EDT; se necessário, repete a consulta a cada cinco minutos.
- Endpoints gratuitos abaixo não contam para o limite de uso informado pela Hubcap. Isso não garante ausência de outros limites de taxa ou disponibilidade.

## Endpoints fornecidos pela Hubcap

| Método e caminho | Uso | Cota |
| --- | --- | --- |
| `GET /health` | Saúde do sistema e componentes como Redis, banco e armazenamento de manifests; estado `healthy` ou `degraded`. | Gratuito |
| `GET /user/stats` | Uso diário, limites e informações da conta. | Gratuito |
| `GET /library` | Lista de jogos com paginação, busca, ordenação e filtros. | Gratuito |
| `POST /library` | Mesma consulta, com parâmetros no JSON; aceita lista longa de App IDs. | Gratuito |
| `GET /status/{app_id}` | Verifica existência do manifest, tamanho, data de modificação e estado de atualização. | Gratuito |
| `GET /search` | Busca por nome ou App ID. | Gratuito |
| `GET /manifest/{app_id}` | Baixa ZIP do manifest V1; aceita `force_update` e seletor opcional `content`. | Conta no uso diário |
| `GET /manifest/{app_id}/contents` | Lista em JSON os manifests dentro do ZIP, sem baixá-lo. | Gratuito |
| `GET /lua/{app_id}` | Baixa o Lua completo. | Conta no uso diário |
| `GET /lua/basegame/{app_id}` | Baixa apenas as seções do jogo base. | Conta no uso diário |
| `GET /lua/dlc/{app_id}` | Baixa apenas as seções de DLC. | Conta no uso diário |
| `GET /depot-keys` | Lista IDs de depots disponíveis, não as chaves. | Gratuito |
| `GET /generate/manifest` | Gera um `.manifest` individual a partir de `depot_id` e `manifest_id`. | Conta na cota de geração |
| `GET /generate/appmanifest/{app_id}` | Geração de pacote de aplicativo descontinuada; documentação informa retorno 503. | Indisponível |
| `GET /generate/workshopmanifest/{workshop_id}` | Gera um manifest de item da oficina. | Conta na cota de geração |
| `GET /generate/usage` | Consulta uso de geração, cotas restantes e disponibilidade do serviço Steam. | Gratuito |

### Biblioteca e busca

`GET /library` aceita `limit` (padrão 100), `offset`, `search`, `sort_by`, `include_adult`, `app_types`, `include_dlc` e `app_ids`. A documentação lista ordenações `updated`, `updated_newest`, `updated_oldest`, `date_oldest`, `date_newest`, `name`, `name_desc`, `appid`, `appid_desc`, `popular` e `trending`. Sem busca, conteúdo adulto fica oculto por padrão. DLC é excluído da lista de jogos; `include_dlc=true` adiciona um objeto de DLC para cada jogo e exige uma leitura extra por jogo. Até 5.000 App IDs podem ser filtrados; usar POST para listas longas. A paginação pode trazer cabeçalho `Link`.

`GET /search` aceita `q` obrigatório com pelo menos três caracteres, `limit` de 1 a 100 e `appid=true` para correspondência exata de ID. Não pressupor que os filtros e o ranking sejam iguais aos da DepotBox.

Exemplos sem credenciais reais:

```bash
curl -H "Authorization: Bearer $HBCP_KEY" \
  "https://hubcapmanifest.com/api/v1/library?app_ids=400,203290&limit=2"
curl -H "Authorization: Bearer $HBCP_KEY" \
  "https://hubcapmanifest.com/api/v1/search?q=400&appid=true&limit=2"
```

### Dados de uso

O Merlin atualmente lê de `/user/stats` os campos numéricos `daily_usage`, `daily_limit` e o booleano `can_make_requests`. Se o retorno for inválido ou não puder ser consultado, a fonte Hubcap é pulada; o código não interpreta um erro HTTP isolado como prova de que a cota acabou.

## O que já foi verificado

- `/library` retornou `game_id`, `game_name`, `header_image`, `manifest_available` e metadados adicionais. As imagens observadas eram URLs da CDN da Steam.
- A consulta por App IDs `400,203290` retornou ambos os jogos. Para `203290` (America's Army: Proving Grounds), o link `header_image` respondeu como JPEG.
- `/search?q=400&appid=true` encontrou Portal. Uma busca de dois caracteres em `/search` retornou HTTP 400; `/library?search=99` aceitou dois caracteres.
- Uma busca de Portal com `app_types=game` foi aceita. Os exemplos retornados mostraram que a ordenação padrão por atualização não é necessariamente a ordem por relevância desejada para a busca do Merlin.
- Em consulta pontual aos dois catálogos principais do Merlin em 06/11/2026, não havia URLs da Ryu gravadas como capa nesses catálogos. Isso **não** prova que o fallback da Ryu não tenha sido exibido: diversas telas constroem a URL durante a renderização, sem salvar histórico do uso.
- As consultas de biblioteca e busca realizadas no teste são descritas como gratuitas; não foi necessário baixar manifest para esse teste.

## Integração atual de manifests

O código em `src/endpoints/manifests.ts` usa `GET /manifest/{app_id}` e configura a Hubcap na cascata. `src/lib/manifest-source-settings.ts` define a ordem padrão Hubcap → Ryuu → DepotBox → Steam API, seguida pelas outras fontes configuradas; o admin pode escolher outra fonte principal. A ordem e a disponibilidade efetivas dependem da configuração.

Antes de baixar, `src/lib/hubcap-quota.ts` consulta o uso gratuito e mantém um circuito por hash da chave em D1. Sem cota, a requisição em andamento continua para as próximas fontes. Após falha HTTP de download diferente de 404, o código consulta o uso novamente para confirmar se a cota foi esgotada. O admin pode consultar o estado do circuito. Os logs identificam a fonte e o estado, sem registrar a chave.

O ZIP de manifest e os endpoints Lua são recursos distintos na documentação; não presumir que todo ZIP sempre contenha todos os arquivos necessários sem verificar o conteúdo real. Evitar chamadas extras de download que consumam cota apenas para obter imagens ou metadados.

## Limite de escopo

A Hubcap é usada pelo Merlin somente no fluxo de manifests. Não consultar
`/library` para nomes ou imagens, nem usar imagens retornadas por esse endpoint.
As capas seguem as fontes atuais do Merlin/Steam e o fallback da Ryuu, com cache
local e circuito de falha descritos em [GAME_IMAGE_SOURCES.md](GAME_IMAGE_SOURCES.md).
