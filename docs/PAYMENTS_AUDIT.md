# Pagamentos: contrato integrado e auditoria

Auditoria de 2026-10-10. O semestral reutiliza as engines de Stripe/Pix existentes; nao existe um segundo fluxo de cobranca.

## Responsabilidades

| Projeto | Responsabilidade |
| --- | --- |
| Public | Planos, selecao tier/periodo/metodo, cadastro, retorno e Meu acesso. Nao envia valores ou Price IDs como fonte de verdade. |
| API | Flags, precos, autenticacao, checkout, webhook, idempotencia, vencimento, renovacao, troca e avisos. |
| Admin | Configura disponibilidade e precos por tier/metodo/periodo. Valida recorrencia Stripe antes de salvar/sincronizar. |
| Launcher | Consome entitlement e avisos; abre Meu acesso por handoff. Nao calcula cobranca. |

## Invariantes

1. Cartao: mensal `month/1`, semestral `month/6`, anual `year/1`. O pagamento e pelo total do periodo, sem parcelamento implicito.
2. Pix: mensal/semestral/anual manuais. O prazo inicial parte da confirmacao; antecipacao parte do vencimento ja pago. Meses curtos nao podem transbordar para o seguinte.
3. Tiers e metodos possuem precos separados. Somente Pix mensal espelha o cartao mensal. Periodos desabilitados ou precos inativos nao sao vendidos.
4. Prepagamento Pix estende imediatamente a mesma chave. Tier/periodicidade diferentes sao aplicados na fronteira, nao ao gerar o QR e nao antes de pagar. Repeticao de webhook nao soma prazo novamente.
5. Cartao ativo troca via preview e confirmacao Stripe. Downgrade ou reducao de intervalo agenda para o fim do periodo; pagamento pendente/falho nao libera tier superior.
6. Cartao cancelado e vencido reativa o mesmo plano/licenca. `past_due`/`unpaid` vai para regularizacao de cobranca, nao nova assinatura arbitraria.
7. Cota Bronze continua mensal, ainda que a cobranca seja semestral/anual. Nao multiplica cota no primeiro mes.
8. Avisos de vencimento reconhecem os novos tipos de acesso e diferenciam renovacao automatica e Pix. Pagamento Pix confirmado afasta o aviso do periodo ja coberto.
9. Retorno do navegador nao comprova pagamento sozinho. Webhooks/reconciliacao confirmam o provedor antes de ativar acesso.
10. Semestral e opt-in somente em tiers. Novas vendas vitalicias permanecem bloqueadas nessa estrutura; vitalicios existentes nao mudam.

## Correcoes desta auditoria

- Renovacao pela modal antiga passa tier/periodo selecionados e usa a mesma rota protegida da pagina Meu acesso; nao tenta recomprar via cadastro publico.
- Seletor Pix respeita flags globais, de periodo e de metodo e escolhe alternativa valida quando o plano anterior ficou indisponivel.
- Consulta de renovacao usa os precos do tier nos tres periodos, nao defaults legados mensal/anual.
- Preview publico de troca rejeita qualquer periodo desabilitado e billing desligado.
- Textos novos de renovacao usam o i18n existente nos cinco idiomas. Semestral exibe economia Pix e alternativa cartao com a mesma regra do anual.
- Meu acesso mostra o valor do metodo efetivo da licenca, sem exibir o preco de cartao para um acesso Pix. Erros de renovacao direta sao capturados e apresentados, sem promessa rejeitada silenciosa.

## Validacao e limites

Testes automatizados cobrem recorrencia `interval_count`, calendario, credito Pix imediato/idempotente, aplicacao do tier futuro, flags/precos de renovacao, combinacoes de tiers/intervalos, datas/avisos e contratos do Public/Launcher.

Esses testes nao substituem checkout e webhooks reais em sandbox. Antes de producao, verificar no ambiente de teste: compra por cada metodo, renovacao antecipada e vencida, falha/cancelamento de cartao, eventos duplicados e troca de periodo. Stripe Prices devem estar no modo teste correto e configurados no stage; nao inserir IDs inventados nem criar oferta de cartao sem Price validado.

Os precos aprovados para semestral sao totais: Pix Bronze 65,90 / Prata 83,90 / Ouro 107,90; cartao Bronze 71,90 / Prata 95,90 / Ouro 119,90 (BRL). A auditoria nao altera valores anuais nem contratos ja pagos. Criar novo Price nao migra assinaturas existentes automaticamente.

### Resultado desta execucao em stage

- API: 117 testes em 31 arquivos e typecheck aprovados. Public: 20 testes, typecheck e build aprovados, incluindo completude das traducoes. Admin: build aprovado. Launcher: seis testes do monitor/avisos aprovados; nao foi gerado instalador.
- Tres compras semestrais Pix no sandbox foram confirmadas nos valores aprovados, com acesso `semiannual_manual` ate 2027-04-10. Consultas repetidas preservaram o vencimento e nao duplicaram o periodo. Os registros criados sao exclusivamente QA no D1 de stage.
- API/Admin e Public publicados em stage, com health e precos publicos conferidos. Depois dos testes do operador, a migracao e os precos tambem foram aplicados ao D1 de producao e API/Admin/Public foram publicados em producao.
- Os tres Prices semestrais de cartao foram criados no produto Stripe de teste, ativos em BRL com recorrencia `month/6`, e cadastrados no D1 de stage. A API publica de precos retornou os seis valores semestrais corretos (Pix e cartao).
- Um checkout de assinatura Stripe de teste foi criado para cada tier. As tres sessoes foram consultadas diretamente na Stripe: `livemode=false`, `mode=subscription`, moeda BRL e totais de 71,90 / 95,90 / 119,90. Permanecem `unpaid`; nenhum cartao foi cobrado nem licenca ativada por esses checkouts.
- O operador relatou pagamentos de teste de cada plano no Public e testes de upgrade/downgrade aprovados em stage. Esta auditoria nao inspecionou individualmente os respectivos eventos Stripe/licencas; falhas/agenda de Stripe, renovacoes e eventos duplicados ainda requerem homologacao operacional completa. Nao declarar homologacao integral antes dessas verificacoes.

### Preparacao Stripe live

- Tres Prices semestrais live foram criados no produto Merlin de producao e verificados ativos em BRL, com recorrencia `month/6`: Bronze 71,90; Prata 95,90; Ouro 119,90.
- A migracao `0077` foi aplicada em producao, os seis precos por tier/metodo foram cadastrados e as flags semestral e Pix semestral foram ativadas. A API publica confirmou seis precos ativos nos valores aprovados, e `/api/health` e `/download` responderam com sucesso. Nenhuma compra live foi criada nesta verificacao.
