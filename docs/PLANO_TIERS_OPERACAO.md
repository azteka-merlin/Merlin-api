# Planos: contrato operacional

## Limites Premium

- O tier efetivo e calculado na API. O Launcher somente consome o catalogo devolvido.
- A ativacao Premium continua contabilizada em `completePremiumActivation`, antes da etapa local do Launcher. Esta regra nao deve ser movida por mudancas de plano.
- Bronze possui tres ativacoes Premium por mes calendario do ciclo da licenca, inclusive para assinaturas anuais. O contador `premium_activation_cycle_usage` e atualizado de forma condicional para nao ultrapassar o limite sob concorrencia.
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

O Pix e manual. Enquanto um acesso Pix mensal/anual estiver ativo, nao ha upgrade, downgrade, proracao ou Stripe Portal para ele. No vencimento, o usuario volta aos planos publicos, escolhe tier e periodo e gera um novo Pix para reativar a mesma licenca.

## Staging

O codigo `12345` e aceito exclusivamente em staging depois de uma solicitacao de verificacao. O Admin de staging pode habilitar temporariamente o envio real pelo Resend. Em producao esse controle nao e exibido e nunca muda a entrega real.
