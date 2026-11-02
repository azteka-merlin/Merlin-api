# Proteção contra falso erro nas ativações Premium

## Causa e regra de implementação

Em 02/11/2026, a API gravava uma reserva e devolvia 409 porque exigia
`meta.changes === 1`. O D1 conta também as gravações feitas pelos triggers:
vincular a operação já pode produzir duas alterações. A mesma comparação
errada existia na conclusão da ativação.

O teste antigo usava `DatabaseSync.run().changes`, que conta só a alteração
direta. Por isso ele passava sem reproduzir o comportamento de produção.
O [relatório do incidente](./INCIDENT_PREMIUM_D1_2026-11-02.md) registra as
evidências e a recuperação realizada.

- Nessas operações, o próprio SQL limita a criação/atualização a uma ativação.
  `meta.changes < 1` significa que nenhuma linha foi obtida. Valores maiores
  que um podem ser legítimos por causa dos triggers.
- Não usar `meta.changes` como quantidade de vagas ou ativações consumidas.
  Conferir os registros e limites de negócio, mantendo as condições atômicas
  do SQL. O ID vem de `last_row_id`, não da contagem de alterações.
- Não substituir comparações em todo o projeto sem analisar o SQL e os
  triggers de cada operação.
- Ao alterar triggers ou fluxo, cobrir zero linhas alteradas: concorrência,
  repetição e identidade errada continuam sendo negadas. Aceitar contagens
  maiores não autoriza ignorar esses bloqueios.

Referências oficiais: [respostas do D1](https://developers.cloudflare.com/d1/worker-api/return-object/),
[metadados da API D1](https://developers.cloudflare.com/api/resources/d1/),
[D1 no Miniflare](https://developers.cloudflare.com/workers/testing/miniflare/storage/d1/).

## Cobertura obrigatória

| Teste | O que precisa provar |
| --- | --- |
| `src/lib/premium-d1-runtime.test.ts` | A rota real responde 200 para launcher antigo sem `operationId` e para cliente que envia o ID. Operação e ativação ficam ativas com cooldown e uma única cobrança Bronze. |
| Mesmo arquivo | Nova tentativa acompanhada conclui com os triggers reais, substitui a tentativa original e não cobra outra cota Bronze. |
| Mesmo arquivo | Dois clientes disputando a última vaga produzem um sucesso, um conflito real e uma chamada ao gerador. Repetir a operação não gera outro token nem cobrança. |
| `src/lib/premium-flow.integration.test.ts` | O adaptador SQLite usa a diferença de `total_changes()` por statement, inclusive em batch. Confere contagens 2/3 na reserva e 2/4 na conclusão, IDs e vínculos corretos. |
| Mesmo arquivo | Timeout antes da geração libera a reserva; resultado incerto exige suporte; datas originais, propriedade da operação e autorização exclusiva são preservadas. |
| Demais testes `premium` | Cooldown, migração de estados, lista de desejos e avisos continuam passando. |

O teste de runtime usa o D1 local do Miniflare/workerd, sem substituir
`run()`, `batch()` ou `meta.changes`. Aplica as migrações em SQLite para
obter o esquema final e carrega suas definições e triggers no D1 local.
O gerador e a existência do arquivo no R2 são simulados. O teste não usa
credenciais reais, não gera tickets, não envia e-mails e não acessa produção.

## Comandos

```powershell
# Regressões Premium, incluindo rotas HTTP com D1 local
npm run test:premium

# Regressões + TypeScript: obrigatório antes de publicar
npm run validate:premium

# Provar que os testes detectam os dois erros originais
npm run test:premium:proof
```

A prova negativa executa três cenários: código corrigido passa; o comparador
antigo da reserva provoca o falso 409 e é detectado; o comparador antigo da
conclusão também é detectado. A alteração ocorre só na transformação em
memória do Vitest, sem modificar `premium-games.ts`. Uma falha de inicialização
ou de outro motivo não conta como prova válida.

O Miniflare é uma dependência explícita dos testes. Ao atualizar Wrangler,
Miniflare ou o adaptador SQLite, rodar `validate:premium` e `test:premium:proof`
para conferir também a fidelidade do ambiente de teste.

## Antes de publicar

1. Rodar a validação no código que será publicado. Se falhar, corrigir antes
   de prosseguir. Não ignorar a falha para terminar o deploy.
2. Usar `npm run deploy-stage` e `npm run deploy`. Os hooks `predeploy-stage`
   e `predeploy` executam `validate:premium` automaticamente e interrompem o
   comando quando há falha. A publicação do painel também passa por esses
   hooks, pois seus scripts chamam os mesmos comandos.
3. Depois de publicar, verificar saúde e autenticação. Para conferir o fluxo
   real em staging, usar apenas licença e gerador de teste. Health 200 não
   substitui os testes de ativação.
4. Conferir resposta da ativação, registro `active`, operação vinculada,
   cooldown e uma única cobrança/vaga. HTTP 200 no download não comprova
   recebimento completo do arquivo pelo launcher.

Os hooks cobrem os comandos npm documentados. Uma chamada direta a
`npx wrangler deploy` não executa esses hooks; não usar esse atalho para
contornar a validação. Falhas precisam constar no histórico do incidente.

## Validação registrada em 02/11/2026

- `npm run validate:premium`: 56 testes passaram em 8 arquivos; TypeScript passou.
- `npm run test:premium:proof`: os três cenários passaram, incluindo a detecção
  independente dos comparadores antigos da reserva e da conclusão.
- `git diff --check`: sem erros de whitespace.
- Esta etapa acrescentou testes, documentação e hooks locais. Não publicou
  uma nova versão do Worker nem do launcher.
