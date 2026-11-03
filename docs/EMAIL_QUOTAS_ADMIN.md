# Consulta de cota no Admin

Em **Avisos por e-mail**, o botão **Consultar cota** abre um painel compacto.
A consulta só acontece ao abrir ou clicar em Atualizar; não envia e-mails.
O horário da consulta é mostrado em Brasília. Em falhas, dados anteriores
ficam atenuados e identificados como a última consulta válida.

## Dados exibidos

- **Brevo:** créditos disponíveis retornados por `GET /v3/account`.
  No plano gratuito, são identificados como o saldo de hoje. Não é inferido
  um total nem um número de envios a partir desse saldo.
- **Resend:** saldo, consumo e limite de `emails.daily` (últimas 24h) e
  `emails.monthly` (mês atual) em `GET /usage`. `limit=null` aparece como
  Sem limite. Nunca usar os cabeçalhos de rate limit como cota de e-mails.
- Ausência de configuração, falha e falta de permissão são estados distintos;
  nenhum deles aparece como saldo zero. Cada provedor é consultado de forma
  independente, com prazo de três segundos incluindo leitura da resposta.
- Se a chave Resend só permitir envio, o serviço responde como restrito e o
  painel orienta consultar o provedor. A Usage API exige chave Full Access.
  Não são modificadas chaves nem permissões automaticamente.

## Segurança e escopo

`GET /panel-api/email/quotas` exige a sessão existente do Admin e retorna
`Cache-Control: no-store`. As chaves permanecem no Worker. A resposta contém
somente cotas, estado da consulta e links fixos para os painéis, sem dados
da conta dos provedores nem detalhes brutos de erros.

Não há migração ou alteração no transporte de e-mails. Os rótulos de sucesso
dos vencimentos passam a dizer Aceito pelo provedor, pois os envios agora
podem usar Brevo ou Resend.

## Verificação

- 10 testes de cota: campos e limites, saldo zero, permissões, resultados
  parciais, falta de configuração, dados inválidos, timeout e autenticação.
- Testes do transporte continuam passando; gate Premium obrigatório aprovado.
- Admin compilado e componente real renderizado a 1200px e 390px; abrir,
  consultar somente por ação e fechar verificados, painel dentro da tela.

Referências oficiais:
[Brevo Account](https://developers.brevo.com/reference/get-account),
[Resend Usage](https://resend.com/docs/api-reference/usage/retrieve-usage).
