# Falso conflito ao reservar ativação Premium — 02/11/2026

## Diagnóstico confirmado

Após a publicação da migração 0090, a API exigia `meta.changes === 1`
ao inserir uma reserva e ao concluir uma ativação. O D1 usa a diferença de
`total_changes()`, que inclui gravações dos triggers que vinculam a operação
e a nova tentativa do suporte. Uma reserva normal passa a contar duas
alterações; uma nova tentativa pode contar três. A conclusão também pode
contar mais de uma alteração.

Assim a reserva era gravada e a API devolvia 409 antes de chamar o gerador.
O problema ocorre também com o launcher já distribuído: a API cria o
identificador de operação quando o cliente não o envia.

Referências: [metadados do D1](https://developers.cloudflare.com/api/resources/d1/),
runtime D1 local em `node_modules/miniflare/dist/src/workers/d1/database.worker.js`.

## Evidência de produção

- Licença interna 201, Thiago, jogo 2638890.
- Reservas 438, 439, 440, 443 e 445 persistiram, seguidas de falha na reserva.
- Reserva 445 criada às 17:15:07.946 BRT; log de atividade 32687 às
  17:15:08.369 BRT: `premium_reservation_failed`, HTTP 409.
- Observability às 17:15:08.519 BRT confirmou `POST /api/premium/activate`,
  409, mensagem “A vaga foi ocupada ou já existe uma ativação em andamento.
  Atualize a lista.”.
- Request ID: `0fe02bb0dc40d01840e3641506219218`.
- Ray ID: `a545cf30eb6eff14`.
- Nenhuma geração/conclusão ocorreu nessas cinco reservas; ativação 434
  é uma conclusão anterior, às 12:36:59 BRT, e não foi alterada neste reparo.
- Também havia reservas de outra licença afetadas pelo mesmo problema.

## Correção e recuperação

- Rejeitar somente `meta.changes < 1` na reserva e conclusão. As cláusulas
  SQL continuam limitando a criação a uma reserva e mantendo os bloqueios
  de vagas, identidade, operação e concorrência.
- Fixture de integração corrigida para emular `total_changes()` do D1.
- Regressões cobrem cliente sem operationId, contagem dos triggers, conclusão,
  nova tentativa exclusiva e cota Bronze sem consumo duplo. Os comparadores
  antigos reproduziram a falha nos testes.
- 48 testes Premium passaram e `npm run typecheck` passou.
- Reserva 445 encerrada como `failed`, com etapa `reservation` e motivo
  registrado, somente se ainda estivesse reservada, sem ativação/cooldown
  e ligada à operação já falha. A atualização confirmou uma linha alterada.
- Não foi gerada uma ativação para o cliente durante o diagnóstico.

## Publicação

| Ambiente | Versão |
| --- | --- |
| Staging | `d92771b2-8195-408f-a56f-100dca73b83e` |
| Produção | `987d6696-00d1-4f92-a004-524df4975985` |

Health 200 e catálogo Premium sem autenticação 401 verificados nos dois
ambientes. Assets do Admin não mudaram. Não houve nova migração, release do
launcher, commit ou push neste reparo. Teste real com o cliente ficou a cargo
do usuário após o aviso da publicação em produção.

O OAuth do Wrangler não tinha acesso ao Observability (403). O token fornecido
pelo usuário permitiu consultar o histórico; foi usado somente na memória
do processo, sem ser salvo no projeto ou neste relatório.

## Teste seguinte e diagnóstico do download

O Observability registrou às 17:24:44.492 BRT uma nova chamada
`POST /api/premium/activate` com HTTP 200 (3.649 ms de wall time), seguida
às 17:24:45.447 BRT por `GET /api/premium/download?appid=2638890`, HTTP 200
(717 ms de wall time). Isso confirma que a solicitação passou da falha de
reserva anterior. O HTTP 200 não comprova que o cliente recebeu o ZIP inteiro.

Ao investigar os 186 KB/s informados na tela, o ZIP original no R2 foi lido
com Wrangler: 28.103.277 bytes em 4,38 segundos, incluindo inicialização do
CLI (cerca de 6.268 KiB/s). O teste usa a API administrativa do armazenamento,
não o caminho autenticado do Worker até o cliente, e não determina sozinho
onde a transferência do cliente está limitada.

Não há cap de banda no download Premium da API ou do launcher: a resposta
transmite `object.body` e o launcher grava um stream. A velocidade mostrada
é uma média e só muda quando chegam dados; uma transferência interrompida
pode manter na tela o último valor positivo. Nenhuma alteração no fluxo de
download foi publicada durante este diagnóstico.

## Prevenção de recorrência

A solicitação posterior do usuário resultou na suíte HTTP com D1 local
`src/lib/premium-d1-runtime.test.ts` e na prova negativa reproduzível
`npm run test:premium:proof`. A suíte aceita clientes antigos/novos e cobre
conclusão, repetição, cota Bronze, nova tentativa e disputa da última vaga.
A prova negativa confirmou que os dois comparadores antigos são detectados.

O procedimento obrigatório está em [PREMIUM_REGRESSION_GUARD.md](./PREMIUM_REGRESSION_GUARD.md)
e também nas instruções do projeto. Os scripts npm de deploy agora executam
automaticamente `npm run validate:premium` antes da publicação.
