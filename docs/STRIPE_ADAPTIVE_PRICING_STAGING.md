# Stripe Adaptive Pricing em staging

Esta flag testa a apresentacao de moeda local no Checkout hospedado pela Stripe, sem alterar os precos-base do Merlin.

- `STRIPE_ADAPTIVE_PRICING_STAGING=true` e um secret configurado somente no Worker de `staging`.
- O backend continua enviando os mesmos Price IDs em BRL.
- Pix, valores exibidos no site publico, Customer Portal e trocas de plano continuam em BRL nesta fase.
- A flag nunca e habilitada em producao por configuracao, e o codigo tambem exige `ENVIRONMENT === "staging"`.

## Como testar

1. Crie uma compra de cartao em staging com um email novo no formato `teste+location_PT@exemplo.com`.
2. Confira na pagina hospedada da Stripe se a moeda apresentada foi localizada.
3. Repita com `location_US`, `location_FR` e `location_BR`.
4. Nao use numeros de cartao em codigo. Quando for concluir um pagamento de teste, informe o metodo de teste manualmente na pagina da Stripe.

Se a Stripe recusar a configuracao ou nao localizar uma sessao, a investigacao fica restrita a staging. Nenhuma compra de producao e afetada.
