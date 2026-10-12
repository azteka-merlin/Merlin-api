# Planos: contrato operacional

## Limites Premium

- O tier efetivo e calculado na API. O Launcher somente consome o catalogo devolvido.
- A ativacao Premium continua contabilizada em `completePremiumActivation`, antes da etapa local do Launcher. Esta regra nao deve ser movida por mudancas de plano.
- Bronze possui tres ativacoes Premium por mes calendario do ciclo da licenca, inclusive para assinaturas semestrais e anuais. O contador `premium_activation_cycle_usage` e atualizado de forma condicional para nao ultrapassar o limite sob concorrencia.
- Prata e Ouro nao possuem limite mensal. Cooldowns e prazo de lancamento permanecem em `src/lib/plan-tiers.ts`.

## Acesso antecipado individual

Um acesso antecipado e uma excecao **por jogo e por licenca**. Ele serve para liberar um titulo a pessoas escolhidas antes da disponibilidade normal do tier, sem transformar essa liberacao em regra para o plano inteiro.

### Regra de decisao

Para um jogo Premium ativo, uma licenca pode prosseguir quando uma destas condicoes for verdadeira:

1. o tier ja possui acesso imediato ou a janela normal daquele tier ja venceu; ou
2. existe uma concessao individual para o par `app_id` + `license_id`.

A segunda condicao substitui apenas a trava de disponibilidade por tier e a politica de catalogo futuro para aquela combinacao. Ela nao altera a configuracao global do jogo nem o plano armazenado na licenca.

Exemplo operacional: para liberar um jogo a tres pessoas antes do Ouro, o jogo deve ficar ativo, Bronze/Prata/Ouro devem permanecer sem liberacao imediata e as tres licencas devem receber a concessao individual. O Ouro continua sendo liberado na janela automatica ja configurada.

### Invariantes que nao podem mudar

- O jogo precisa continuar `enabled`; uma concessao individual nao publica jogo oculto.
- A checagem deve existir em `GET /api/premium/catalog` **e** em `POST /api/premium/activate`. O catalogo sozinho nao e uma fronteira de seguranca.
- Arquivo de ativacao disponivel, limite de slots do jogo, cooldown, reserva em andamento e limites de ativacao da licenca continuam sendo aplicados.
- Bronze continua consumindo seu limite mensal; acesso antecipado nao vira ativacao gratuita nem aumenta cota.
- A conclusao da ativacao continua em `completePremiumActivation`; nao criar caminho alternativo de download ou confirmacao.
- A concessao nao muda tier, vencimento, billing, chave, HWID, politica Pix ou regras de Stripe.
- Remover a concessao bloqueia novas ativacoes antecipadas, mas nao invalida uma reserva ou ativacao ja existente. Esses estados continuam sob as regras normais de reserva e cooldown.

### Dados e administracao

- D1 guarda somente os pares concedidos em `premium_game_early_access`; nao duplica cadastro de licenca ou de jogo.
- O Admin mostra uma contagem no card do jogo e abre um modal com busca de licencas ativas; nomes nao ficam expostos na grade principal.
- Conceder e remover exigem sessao administrativa, CSRF e registro em `admin_audit_logs`.
- As rotas administrativas sao `GET` e `POST /panel-api/premium/games/:appId/early-access`, alem de `DELETE /panel-api/premium/games/:appId/early-access/:licenseId`. Elas nunca devem ser expostas ao Launcher.

### Escopo e regressao antes de producao

O recurso nao inclui grupos, regras por e-mail, expiracao programada, importacao em massa, visibilidade exclusiva no catalogo, nem mudanca no Launcher. O Launcher continua consumindo o catalogo calculado pela API.

Validar em staging, no minimo:

1. licenca Bronze concedida consegue ativar antes da janela; Bronze nao concedido continua bloqueado;
2. Ouro sem toggle imediato continua bloqueado ate a janela normal; Ouro com toggle imediato segue o comportamento atual;
3. limite Bronze, cooldown global e slots do jogo ainda bloqueiam uma licenca concedida quando aplicaveis;
4. jogo oculto e arquivo ausente continuam indisponiveis mesmo com concessao;
5. remover a concessao impede uma nova reserva e cria evento de auditoria;
6. uma tentativa direta de `POST /api/premium/activate` sem concessao nao contorna o bloqueio do catalogo.

## Catalogo futuro para acessos gratuitos

`billing_settings.premium_catalog_cutoff_at` e a unica data global que define quais sao os jogos Premium futuros. Ela e configurada uma vez no Admin; nao existe data por licenca.

`licenses.premium_catalog_restricted` apenas informa se a politica global se aplica a uma licenca:

- `0`: a licenca recebe lancamentos conforme as regras normais do tier.
- `1`: jogos criados depois da data global continuam no catalogo, mas bloqueados. A API devolve o menor tier que ja os libera para o Launcher exibir a mensagem correta.

Novos cadastros gratuitos nascem em Bronze com a restricao marcada. Quando essa pessoa compra Bronze, Prata ou Ouro, a mesma licenca e convertida para paga e a restricao e removida. Licencas existentes so devem ser classificadas em lote quando a lista aprovada pelo responsavel estiver disponivel. A classificacao nunca altera vencimento, periodicidade ou chave. Execute sempre primeiro em dry run e nunca reutilize scripts de staging em producao.

## Pix

O Pix e manual. No Meu acesso, a licenca Pix ativa pode subir de tier e/ou passar para periodo mais longo a qualquer momento. A API calcula credito proporcional do periodo Pix ainda nao usado: no mesmo periodo Pix cobra a diferenca proporcional de tier e preserva o vencimento; ao passar para periodo mais longo cobra o total do novo periodo menos esse credito e inicia o novo periodo na confirmacao. Downgrade Pix segue a janela dos ultimos sete dias e paga antecipadamente o periodo seguinte. Se nao houver pagamento antecipado, apos o vencimento o usuario escolhe tier e periodo e gera um novo Pix para reativar a mesma licenca.

A primeira migracao Pix ativo -> cartao no mesmo tier/periodo apenas coleta o cartao e ancora a primeira cobranca cheia no vencimento ja pago. Com upgrade, o credito Pix nao usado reduz o primeiro pagamento da assinatura e o novo ciclo comeca apos a confirmacao. Nao se usa Stripe Portal nessa migracao. Ela so abre Checkout com mais de 24h30 restantes; Pix vencido pode contratar cartao pelo valor integral. O acesso preserva chave e HWID.

Depois de migrar, a licenca e de cartao. Antes da primeira renovacao cheia, upgrades adicionais usam Checkout Stripe para cobrar o preco do novo periodo menos o credito pre-pago restante; apos a confirmacao, comeca um novo ciclo. Downgrade de tier ou periodo menor agenda a troca para o vencimento atual na assinatura Stripe, sem debito imediato nem reducao antecipada do acesso. Um Checkout pendente deve ser encerrado ou conciliado antes de agendar outra troca. Depois da primeira fatura cheia, nao ha credito anterior e valem apenas as regras cartao -> cartao. Cobrancas pendentes bloqueiam outra operacao financeira na mesma licenca ate conciliacao/encerramento confirmado no provedor.

## Periodos de cobranca

- `monthly`: um mes; `semiannual`: seis meses; `annual`: doze meses. Pix soma meses calendario, ajustando o ultimo dia quando necessario. No cartao, as datas confirmadas pela Stripe sao a fonte de verdade.
- Cartao semestral exige Price recorrente `interval=month`, `interval_count=6`; mensal exige `month/1`, anual `year/1`. Os valores sao o total do periodo, nao parcelas mensais.
- Precos de Bronze, Prata e Ouro sao escolhidos pela API em `billing_plan_prices`, inclusive na consulta de renovacao. Nao usar precos legados como fallback quando os tiers estiverem ativos.
- Semestral so existe com tiers ativos. A migration `0077_semiannual_billing.sql` adiciona flags opt-in; nao habilita producao automaticamente.
- Downgrade de tier ou encurtamento de periodo fica para o fim do periodo pago. Outras alteracoes elegiveis de cartao usam a confirmacao hospedada da Stripe; o tier alvo nao e liberado antes do pagamento.
- Precos Pix semestrais/anuais sao independentes do cartao. Pix mensal continua espelhando o cartao mensal.
- Depois da migracao Pix -> cartao, o metodo da licenca e cartao: downgrade de tier e reducao de periodo podem ser agendados no vencimento atual, mesmo antes da primeira fatura cheia. O Pix anterior so fornece credito proporcional a upgrades imediatos enquanto houver prazo pre-pago; nao define bloqueios nem novas renovacoes. Apos a primeira fatura cheia no cartao, esse credito se encerra e o fluxo cartao -> cartao regular assume integralmente.
- Consulte `PAYMENTS_AUDIT.md` para o mapa integrado e os limites de validacao.

## Staging

O codigo `12345` e aceito exclusivamente em staging depois de uma solicitacao de verificacao. O Admin de staging pode habilitar temporariamente o envio real pelo Resend. Em producao esse controle nao e exibido e nunca muda a entrega real.
