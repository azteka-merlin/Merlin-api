# Aviso cancelado sem reagendamento — 02/11/2026

## Diagnóstico

No Phantom Blade Zero, a inscrição interna 7 continuava `watching`, mas seus
dois eventos estavam `canceled`, sem tentativas de envio ou erro do provedor.
O evento 6 previa liberação em 03/11 às 10:36 BRT; o evento 7 passou a prever
13:39 BRT. Quando a previsão voltou ao primeiro horário, o evento 6 permaneceu
cancelado: `INSERT OR IGNORE` e a consulta por `dedupe_key` impediam recriá-lo.

O cancelamento de uma previsão antiga é esperado; perder o aviso quando o
horário anterior volta a ser válido era uma falha do agendador. A inscrição
não havia sido cancelada e não precisava ser feita novamente.

O evento 1 é outro caso: foi cancelado antes da inscrição da mesma licença
com outro endereço. O evento 2 dessa inscrição foi enviado. Os eventos 2 a 5
foram confirmados como enviados às 21:52 BRT, sem erro do provedor.

## Correção

- Reagendar o mesmo evento cancelado quando seu horário público e a versão
  do evento voltam a ser válidos, com inscrição ainda ativa, mesmo contato e
  mesma data de atualização da inscrição.
- Preservar tentativas, corpo congelado e início do primeiro envio. A chave
  de idempotência continua sendo a mesma, inclusive em resultado incerto.
- Manter o limite de tentativas e a proteção de 23 horas do provedor.
- Não reabrir inscrições canceladas, avisos enviados nem liberações privadas
  de novas tentativas do suporte.
- A recuperação ocorre no cron normal; não enviar e-mails durante os testes
  nem editar manualmente os registros de produção.

## Regressão

O teste de capacidade 2 → 1 → 2 falhou no código anterior: `scheduled` era 0
em vez de 1 quando a previsão retornava. Com a correção, reutiliza o evento,
envia uma única vez dentro da janela e encerra a inscrição.

Outro teste reproduz perda da resposta do provedor e cancelamento temporário:
o reagendamento conserva o corpo, a chave, o início e a contagem de tentativas.
Os testes de cancelamento explícito, nova tentativa privada, limite de envios
e interrupção de repetições continuam na suíte de notificações.

## Publicação

- `npm run deploy`, com o gate obrigatório: 58 testes Premium e TypeScript passaram.
- Versão de produção: `2ef37b40-7cec-49b8-95bf-87689859913a`.
- Sem migração, mudança de bindings, alteração dos assets do Admin ou release do launcher.
