# Planos: contrato operacional

## Limites Premium

- O tier efetivo e calculado na API. O Launcher somente consome o catalogo devolvido.
- A ativacao Premium continua contabilizada em `completePremiumActivation`, antes da etapa local do Launcher. Esta regra nao deve ser movida por mudancas de plano.
- Bronze possui tres ativacoes Premium por mes calendario do ciclo da licenca, inclusive para assinaturas anuais. O contador `premium_activation_cycle_usage` e atualizado de forma condicional para nao ultrapassar o limite sob concorrencia.
- Prata e Ouro nao possuem limite mensal. Cooldowns e prazo de lancamento permanecem em `src/lib/plan-tiers.ts`.

## Catalogo futuro para acessos gratuitos

`billing_settings.premium_catalog_cutoff_at` e a unica data global que define quais sao os jogos Premium futuros. Ela e configurada uma vez no Admin; nao existe data por licenca.

`licenses.premium_catalog_restricted` apenas informa se a politica global se aplica a uma licenca:

- `0`: a licenca recebe lancamentos conforme as regras normais do tier.
- `1`: jogos criados depois da data global continuam no catalogo, mas bloqueados. A API devolve o menor tier que ja os libera para o Launcher exibir a mensagem correta.

Novos cadastros gratuitos nascem em Bronze com a restricao marcada. Quando essa pessoa compra Bronze, Prata ou Ouro, a mesma licenca e convertida para paga e a restricao e removida. Licencas existentes so devem ser classificadas em lote quando a lista aprovada pelo responsavel estiver disponivel. A classificacao nunca altera vencimento, periodicidade ou chave. Execute sempre primeiro em dry run e nunca reutilize scripts de staging em producao.

## Pix

O Pix e manual. Enquanto um acesso Pix mensal/anual estiver ativo, nao ha upgrade, downgrade, proracao ou Stripe Portal para ele. No vencimento, o usuario volta aos planos publicos, escolhe tier e periodo e gera um novo Pix para reativar a mesma licenca.

## Staging

O codigo `12345` e aceito exclusivamente em staging depois de uma solicitacao de verificacao. O Admin de staging pode habilitar temporariamente o envio real pelo Resend. Em producao esse controle nao e exibido e nunca muda a entrega real.
