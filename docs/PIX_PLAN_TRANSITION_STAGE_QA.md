# Trocas a partir de Pix: regra e validacao em staging

`T` = confirmacao do pagamento na Stripe ou Mercado Pago; `V` = vencimento atual do Pix. O credito e calculado com o valor **efetivamente pago** no ciclo Pix e a fracao ainda nao usada. A mesma licenca, chave, titular e HWID sao mantidos.

| Origem e destino | Cobranca agora | Plano efetivo | Novo vencimento |
| --- | --- | --- | --- |
| Pix ativo -> Pix, tier superior no mesmo periodo | Diferenca proporcional do tier | Apos Pix confirmado | Mantem `V` |
| Pix ativo -> Pix, periodo maior com ou sem outro tier | Preco Pix integral do destino menos credito Pix | Apos Pix confirmado | `T` + periodo do destino |
| Pix ativo -> cartao, mesmo tier e periodo | R$ 0; coleta cartao | Mesmo plano | Mantem `V`; primeira fatura cheia em `V` |
| Pix ativo -> cartao, tier superior no mesmo periodo | **Primeira fatura recorrente integral do destino menos credito Pix** | Apos fatura paga | `T` + periodo do destino; nada em `V` |
| Pix ativo -> cartao, periodo maior com ou sem outro tier | **Primeira fatura recorrente integral do destino menos credito Pix** | Apos fatura paga | `T` + periodo do destino; nada em `V` |
| Pix vencido -> Pix ou cartao | Preco integral do destino, sem credito antigo | Apos pagamento confirmado | `T` + periodo do destino |
| Downgrade de tier ou periodo | Regra existente: somente perto de `V`, aplicado no proximo ciclo | Nao reduz acesso ja pago | Conforme periodo agendado |
| Cartao apos migracao Pix -> tier menor ou periodo mais curto | Nada agora; agenda na Stripe | Mantem plano atual ate o vencimento do cartao | Vencimento atual preservado; novo preco no ciclo seguinte |

A primeira fatura paga no cartao e uma fatura **da assinatura**, nao um ajuste avulso. O credito Pix vira desconto de uso unico na primeira fatura. A partir da segunda, a Stripe cobra o preco recorrente integral do plano de destino. A data real de inicio/fim da assinatura na Stripe e a fonte de verdade no webhook, mesmo se ele atrasar. Se o valor liquido devido for inferior a R$ 1, a diferenca e dispensada na primeira fatura; o cartao ainda e coletado.

## Limite de 24 horas para a primeira migracao Pix -> cartao

O Checkout Stripe permanece aberto por pelo menos 30 minutos. Para impedir a conclusao depois do limite de 24 horas antes de `V`, a API deixa de **criar** um Checkout quando restam 24h30 ou menos para `V`. Um Checkout aberto antes disso expira em 30 minutos, ainda com pelo menos 24 horas ate `V`. O limite vale apenas para Pix **ativo** indo ao cartao. Pix vencido pode contratar cartao pelo preco cheio. Trocas posteriores de cartao para cartao nao recebem essa restricao.

Nenhuma extensao temporaria da licenca e criada. Um Checkout abandonado nao muda plano nem vencimento. Ao iniciar outra tentativa, a API consulta a sessao anterior na Stripe: se `open`, expira a antiga no provedor antes de criar a nova, sem esperar os 30 minutos; se `complete`, concilia o resultado e nao abre outra cobranca. Falha de consulta ou expiracao mantem a trava.

## Segunda troca apos migracao sem cobranca

Uma migracao apenas de metodo coleta o cartao em Checkout `setup` e deixa a assinatura em `trialing` ate `V`, porque o Pix ja pagou esse periodo. Se o cliente pedir upgrade de tier e/ou periodo antes de `V`, o Merlin calcula o credito ainda nao usado e abre **uma pagina Stripe Checkout** com o valor liquido: preco integral do destino menos o credito. Abrir a pagina nao muda nem cobra a assinatura. Somente apos o pagamento confirmado pelo webhook o Merlin altera o preco da assinatura existente, agenda a proxima cobranca cheia para `T` + periodo do destino e aplica o novo plano a licenca. O pagamento imediato aparece como pagamento avulso vinculado a essa troca, nao como fatura recorrente; a primeira fatura recorrente acontece no novo vencimento. Valores liquidos abaixo de R$ 1 sao dispensados e a pagina coleta o cartao sem cobrar.

Um Checkout ainda aberto e substituido somente depois de a Stripe confirmar sua expiracao; um Checkout concluido nunca e cancelado para abrir outro. Para impedir que a renovacao da assinatura antiga atravesse esse Checkout, a segunda troca nao pode comecar quando restam 24h30 ou menos para `V`. Checkout abandonado ou pagamento recusado nao altera plano nem vencimento. Depois de confirmado o pagamento, outra troca antes da primeira fatura cheia ainda utiliza o saldo proporcional do periodo ja pago e tambem abre Checkout. Apos a primeira fatura recorrente, as trocas seguem o fluxo cartao -> cartao comum. Operacoes diretas anteriores permanecem no historico para conciliacao, mas nao sao criadas novamente.

Depois da migracao, o metodo e **cartao**. O registro do Pix serve exclusivamente para calcular credito ainda nao usado em upgrades imediatos antes da primeira renovacao cheia. Downgrade de tier ou periodo menor segue o agendamento cartao -> cartao na assinatura Stripe, inclusive durante `trialing`: a fase atual preserva explicitamente o fim do trial/periodo ja pago, e o novo preco so entra no vencimento. Nao se aplica a janela de downgrade do Pix. Um Checkout de upgrade ainda aberto precisa ser expirado na Stripe antes de agendar a reducao; se ja estiver pago, primeiro e conciliado. Apos a primeira fatura cheia do cartao, nao resta credito Pix e todas as trocas seguem as regras regulares de cartao.

## Casos de regressao

- Pix -> Pix nao muda: upgrade proporcional, periodo maior antecipado, downgrade perto de `V`, renovacao Pix agendada.
- Cartao -> cartao comum nao muda: preview e alteracao na Stripe, inclusive quando houve uma migracao Pix anterior ja liquidada.
- A rota administrativa de alteracao de plano, quando encontra uma assinatura ainda no periodo Pix antecipado, tambem devolve Checkout Stripe; nao aplica upgrade nem debita o cartao salvo diretamente.
- Cartao cancelado -> Pix continua liberado apenas depois do vencimento e apos confirmar que a Stripe nao cobrara novamente.
- Pix vencido -> cartao: assinatura nova, preco integral, sem trial ou credito antigo.
- Webhook duplicado ou atrasado nao cria segunda cobranca nem altera outra licenca.
- Valor da fatura diferente do preview bloqueia a aplicacao local e gera diagnostico para conciliacao; nunca se abre um segundo Checkout automaticamente.

## Validacao automatizada

- `tests/pix-plan-transition.test.ts`: tier, periodo, combinacoes Pix/cartao, valor pago real, vencimento e downgrades.
- `tests/pix-card-transition-checkout.test.ts`: cupom de uso unico, primeira fatura recorrente, coletar cartao sem cobrar, janela de 24h30, expiracao e duplicidade.
- `tests/pix-card-transition-webhook.test.ts`: pagamento confirmado, data real Stripe, renovacao, idempotencia e preservacao da licenca.
- `tests/prepaid-card-credit.test.ts` e `tests/prepaid-card-change.test.ts`: credito remanescente, Checkout hospedado para segunda e terceira trocas, nao aplicar antes da confirmacao, rejeitar valor divergente e replay idempotente.
- `tests/prepaid-card-change.test.ts`: downgrade e periodo menor agendados durante o primeiro ciclo no cartao, trial preservado, sem pagamento imediato e Checkout anterior expirado antes do agendamento.
- Suites completas da API e Public para as demais regressoes.

## Casos manuais de sandbox e monitoramento

Usar licencas QA e os meios de teste oficiais da Stripe/Mercado Pago. **Nao gravar numeros de cartao em codigo, testes ou logs.**

1. Migrar Pix ativo no mesmo plano so para cartao: Checkout sem cobranca, assinatura `trialing`, vencimento `V` inalterado e primeira fatura em `V`.
2. Migrar Pix ativo com tier superior, periodo maior, e tier + periodo: conferir em cada caso o preco integral menos o credito como **primeira fatura de assinatura**, plano ativo apos pagamento, primeiro vencimento `T` + periodo e nenhuma fatura no antigo `V`.
3. Depois do caso 1, subir de tier antes de `V`: conferir Checkout hospedado com o valor do preview, nenhum upgrade antes do pagamento, um unico pagamento confirmado e nova assinatura recorrente integral em `T` + periodo. Fazer uma terceira troca antes da primeira renovacao cheia e conferir novo Checkout com credito proporcional; apos a renovacao, verificar o fluxo cartao -> cartao comum.
4. Simular cartao recusado/autenticacao pendente na segunda troca: nenhuma mudanca de tier ou vencimento antes do pagamento; Checkout Stripe disponivel; pagamento tardio aplica uma vez.
5. Tentar criar migracao com 25h, 24h30, 24h e 1h restantes: somente a de 25h pode abrir Checkout; o Checkout expira antes de restarem 24h. Depois de `V`, contratar cartao integralmente.
6. Testar Checkout abandonado, webhook duplicado/atrasado, reativacao Pix vencido, cancelamento de cartao para Pix e preco/periodo desativado.
7. Apos Pix -> cartao, pedir downgrade antes da primeira fatura cheia: confirmar na Stripe as duas fases do agendamento, sem debito agora, sem reducao antecipada, com primeira cobranca do destino apenas no vencimento. Repetir depois de um upgrade de periodo e conferir que o trial preserva o novo vencimento.

A publicacao em producao foi autorizada pelo usuario em 12/10/2026 apos testes funcionais em staging. Os cenarios de borda desta lista nao devem ser considerados validados apenas pelos mocks: conferir no sandbox o valor liquido do Checkout, a ausencia de segunda fatura imediata ao alterar uma assinatura `trialing` e a primeira renovacao cheia na nova data; monitorar divergencias em producao para conciliacao sem nova cobranca automatica.
