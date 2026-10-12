# Auditoria de concorrencia de pagamentos Pix/cartao (staging)

Escopo: operacoes de Meu acesso para renovacao Pix, migracao Pix -> cartao,
reativacao de cartao encerrado por Pix, faturas Stripe e retorno do Checkout.
Publicacao em producao autorizada pelo usuario em 12/10/2026 apos testes funcionais em staging. Os casos manuais de corrida e falha de provedor abaixo nao foram todos confirmados nesta auditoria.

## Correcao dos achados

| Achado | Estado no codigo | Verificacao |
| --- | --- | --- |
| Pix antecipado e Checkout cartao coexistem | A migracao `0080` cria exclusao unica por licenca para transicao Pix e renovacao Pix, inclusive quando sao iniciadas simultaneamente. A rota Pix tambem verifica Checkout cartao pendente. | Testes de exclusao nas duas ordens e no indice D1. |
| Expiracao local libera outra tentativa | A nova tentativa consulta a sessao Stripe anterior mesmo antes dos 30 minutos; se `open`, pede expiracao ao provedor e exige resposta `expired` antes de criar outra. Se `complete`, concilia e nao cancela. Se a expiracao falhar porque o pagamento concluiu entre GET e POST, consulta novamente e concilia. Sem ID do provedor ou com falha de consulta, permanece bloqueada. Pix vencido localmente tambem consulta o pedido Mercado Pago; o relogio local nao converte um pedido `awaiting_payment` em `expired`. | Testes de substituicao imediata, Checkout pago e corrida de pagamento; homologacao com provedores pendente. |
| Primeira linha da fatura define vencimento | O handler escolhe a linha de assinatura nao prorrogada, ignorando item avulso/prorrata. Se nao houver periodo inequivoco, falha sem estender acesso. | Teste com duas linhas e prorrata primeiro. |
| Segunda troca no periodo Pix | Abre Checkout Stripe hospedado com o valor liquido e reserva unica. So apos pagamento confirmado altera a assinatura recorrente existente e a licenca; o pagamento imediato e avulso e a primeira fatura recorrente fica para o novo vencimento. Erro de valor ou resposta mantem reserva para conciliacao, sem criar outro pagamento. | Mocks aprovados; pagamento real, falha, autenticacao e webhook tardio no sandbox ainda pendentes. |
| Cartao -> Pix so validado ao criar QR | A evidencia identifica a migracao e a confirmacao Pix verifica novamente assinatura encerrada, mesmo cliente e ausencia de faturas abertas/rascunho na Stripe antes de alterar a licenca. A migracao `0080` exclui reativacoes Pix/cartao simultaneas. | Testes unitarios da validacao e indice; sequencia completa com QR real pendente. |
| Checkout de reativacao/criacao criado antes da reserva | O Checkout Stripe agora reserva no D1 antes de chamar a Stripe. A migracao `0081` exclui compras iniciais Pix/cartao simultaneas para o mesmo customer; `0080` cobre reativacoes da mesma licenca. | Testes verificam a reserva durante a chamada Stripe e a exclusao com Pix. |
| Falha da fatura de alteracao mostra periodo pago como vencido | Falha/acao requerida de uma fatura `subscription_update` associada a uma alteracao pendente nao modifica `billing_status` da licenca ainda paga; falha da renovacao normal continua marcando `past_due`. | Testes dos dois tipos de fatura. |
| Interface e documentos defasados | Meu acesso distingue confirmacao demorada de falha, orienta a nao pagar novamente e oferece nova consulta. `PAYMENTS_AUDIT.md` e `PLANO_TIERS_OPERACAO.md` descrevem a fatura recorrente, o limite de 24h30 e a exclusao por licenca. | Public: typecheck, testes e build. |

## Invariantes e limites

1. Reservar a operacao no D1 acontece antes de criar um pedido Mercado Pago ou Checkout Stripe. Os indices unicos sao a ultima linha de defesa contra dois pedidos criados em paralelo para a mesma licenca ou primeira compra do mesmo customer.
2. O indice nao e uma transacao distribuida com provedores. Se a chamada ao provedor funcionar mas a resposta nao puder ser persistida, a reserva fica bloqueada para conciliacao; nao abrimos outra cobranca automaticamente.
3. Um Pix pago depois de a licenca migrar para Stripe nao pode estender nem alterar essa licenca. O pagamento deve ficar visivel para conciliacao; nao e convertido silenciosamente em acesso sobreposto.
4. Uma fatura sem linha de assinatura identificavel nao deve gerar vencimento por inferencia da primeira linha. Ela precisa ser conciliada; evento falho permanece observavel para nova tentativa.
5. A regra de cartao -> Pix verifica a Stripe na abertura e novamente na confirmacao. Uma mudanca externa na Stripe durante a vida do QR fica bloqueada na aplicacao local e exige conciliacao do Pix ja pago.
6. Checkout em estado `complete` mas ainda nao refletido no D1 nao e tratado como expirado. Reconciliacao ou intervencao e necessaria antes de permitir nova tentativa.
7. Se uma consulta ao provedor confirmar um pagamento antigo durante a abertura de outro checkout, a requisicao nova para imediatamente: plano e vencimento lidos antes da conciliacao nao podem ser reutilizados.

## Homologacao que ainda nao pode ser substituida por mocks

- Executar no sandbox Stripe a primeira migracao Pix -> cartao com e sem cobranca, inclusive primeira fatura com desconto e datas do ciclo.
- Fazer segunda troca durante o periodo Pix: pagamento aprovado, recusado, autenticacao requerida, pagamento tardio e Checkout expirado; conferir que nao ha segunda fatura imediata e que Stripe/D1 concordam sobre plano e proximo vencimento.
- Abrir Checkout e QR em ambas as ordens e com requisicoes simultaneas; confirmar que o segundo nao e emitido. Repetir apos o prazo local e verificar o estado real do provedor.
- Confirmar Pix de reativacao depois que o estado Stripe muda durante a vida do QR; verificar que a licenca nao e sobrescrita e que a ocorrencia gera diagnostico.
- Revisar eventos Stripe/Mercado Pago atrasados, duplicados e fora de ordem com IDs de sandbox, sem numeros de cartao em codigo ou logs.

Nao declarar garantia absoluta de ausencia de cobranca duplicada em producao. Monitorar os casos manuais ainda pendentes; se um pagamento ja capturado for impedido de alterar a licenca, nao cobrar de novo: manter bloqueio e tratar o valor explicitamente na conciliacao.

## Resultado automatizado e publicacao de staging

- API: `npm run typecheck` e 196 testes em 41 arquivos aprovados.
- Public: typecheck, 22 testes e build aprovados.
- D1 staging: migracoes `0080` e `0081` aplicadas apos consultas de preflight sem conflitos; nenhuma migracao pendente.
- API staging: Worker `1f4bc5fd-3cb7-4d5b-9d3c-71acb15975bc`, `/api/health` respondeu 200 apos o deploy final.
- Public staging: Worker `6e1ecbcc-43a4-48d1-b3d2-4740dab2f6a4`, `/meu-acesso` respondeu 200.
- Em 12/10/2026, as migracoes `0078` a `0081` foram aplicadas no D1 de producao apos preflight sem conflitos. API (`82b39c32-37d4-42ca-bd91-547ecaf13e97`) e Public (`fb3b5740-e5a9-4b68-807b-2cb36fba7b1e`) foram publicados; `/api/health` e `/meu-acesso` responderam 200. Nenhum numero de cartao foi usado em codigo ou testes.
