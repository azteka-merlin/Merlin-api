# Brevo — validação dos modelos e regra de integração

## Configuração concluída

- Domínio `api-merlin.com` verificado e autenticado no Brevo.
- Código Brevo, dois CNAME DKIM e DMARC cadastrados na Cloudflare; CNAME sem proxy.
- Remetente cadastrado e ativo: `Merlin <no-reply@api-merlin.com>`.
- Chaves de API não fazem parte deste relatório nem dos arquivos do repositório.

## Testes solicitados

Foram enviados somente dois testes para `azteka.merlin@gmail.com`, com os modelos
atuais de `src/lib/premium-notifications.ts`. O renderer foi carregado em memória,
sem mudar o código dos templates, o cron ou os registros de inscrições.

| Modelo | Assunto | Aceitação pela API Brevo |
| --- | --- | --- |
| Sininho | `[TESTE] Próxima ativação disponível: Phantom Blade Zero` | 250 ms |
| Lista de desejos | `[TESTE] Phantom Blade Zero chegou ao Premium` | 232 ms |

As mensagens usam o mesmo conteúdo dos modelos atuais, acompanhado de indicação
explícita de teste e dados de demonstração. Foram enviados HTML e texto simples,
links HTTPS para o domínio público, remetente autenticado e identificadores
distintos de idempotência. Não houve campanha nem disparo para outros clientes.

O usuário confirmou que **os dois chegaram à caixa de entrada do Gmail**. O tempo
da tabela mede aceitação pela API, não o tempo até chegar ao destinatário. As
consultas de eventos ainda retornaram objetos vazios durante a verificação; a
confirmação de chegada veio do próprio destinatário. Isso não garante a pasta de
entrega para todos os destinatários futuros.

## Revisão visual solicitada após a primeira prévia

O usuário rejeitou o formato simples dos modelos Premium e o link para Minha conta.
Os dois modelos foram ajustados localmente para usar a mesma estrutura dos e-mails
de cobrança: cabeçalho MERLIN escuro, contorno roxo, conteúdo em cartão branco,
destaque para jogo/horário/planos e rodapé com a origem da inscrição. Não há CTA
para Minha conta; a ação orienta abrir o launcher na aba Premium.

O shell existente foi reutilizado, tornando o CTA opcional. Os e-mails de cobrança
continuam com seus CTAs. Validação: 21 testes de notificações, 8 testes de cobrança
e TypeScript passaram. As prévias foram renderizadas em 720 e 390 pixels de largura,
sem rolagem horizontal.

## Regra aprovada para a próxima etapa

1. Brevo como provedor principal; Resend como fallback.
2. Uma tentativa Brevo, com prazo máximo de três segundos, sem repetição no
   Brevo antes de seguir para o Resend.
3. Falha ou timeout segue imediatamente para o Resend. Reutilizar exatamente o
   mesmo conteúdo e o mesmo código de verificação; nunca gerar outro código por
   causa da troca de provedor.
4. Um timeout pode ocorrer após o provedor aceitar a mensagem. Portanto, podem
   chegar duas cópias do mesmo conteúdo; não prometer ausência de duplicidade
   entre provedores apenas usando chaves de idempotência diferentes.
5. Registrar o provedor e o resultado para evitar que uma repetição da fila volte
   ao Brevo depois de usar o Resend. Preservar cancelamento, revalidação da
   previsão, corpo congelado e contagem de tentativas dos fluxos atuais.
6. Respeitar a janela de idempotência de cada provedor: Brevo documenta 30 minutos
   para seu mecanismo; não transportar para ele a suposição de 24 horas do Resend.
7. Controlar a cota antes do envio. No plano gratuito, o Brevo pode aceitar e
   enfileirar mensagens além dos 300 envios diários; nesse caso não há erro HTTP
   imediato que permita descobrir o atraso apenas pela resposta do envio.
8. Testar com rede simulada a resposta imediata, timeout, erro, confirmação
   inválida, cota e persistência do provedor antes de ativar nos fluxos reais.

## Integração autorizada para produção

O usuário aprovou publicar o transporte em 03/11/2026. O Public envia seus pedidos
para `/api/public/email-verification/start`, atendido pelo Worker da API; não
possui transporte ou chave de e-mail no frontend. A alteração cobre verificação,
boas-vindas, recuperação, cobrança, wishlist e aviso de próxima ativação.

- `src/lib/email-transport.ts`: Brevo principal, uma tentativa, com orçamento
  conjunto de 3 segundos para consultar saldo e enviar (inclui leitura da resposta).
  Em falha segue para Resend, com orçamento de 5 segundos. Mantém conteúdo e código.
- `0091_email_delivery_routes.sql`: seleção persistida, hash do conteúdo e
  confirmação de envio. Não armazena código, chave de licença ou corpo do e-mail.
  A passagem para Resend é gravada antes de chamar o fallback. Envios confirmados
  não são repetidos; recuperação explícita pode enviar novamente após 24 horas.
- Brevo: consulta saldo por envio e reserva atomicamente até 280 destinatários
  numa janela móvel de 24h; exige margem de pelo menos 10 créditos no saldo da
  conta. Reserva conservadora permanece contada mesmo se houver fallback.
  Isso evita depender do erro HTTP de cota e de um horário de reset presumido.
  Consumo externo ao Merlin também pode afetar a conta; a consulta de saldo não
  é uma reserva no provedor e não garante capacidade diante de envios externos
  simultâneos. Não usar a mesma conta para campanhas volumosas sem revisar a cota.
- Brevo usa UUID estável e bloqueia repetição incerta após 25 minutos; resposta
  `duplicate_parameter` exige conferência, sem fallback que duplicaria uma aceitação.
  Resend mantém a chave anterior e bloqueio de envio incerto após 23 horas.
- Notificações Premium com corpo congelado antes desta migração permanecem no
  Resend. Novas usam Brevo. Inscrição e previsão são revalidadas imediatamente
  antes de enviar por qualquer provedor, inclusive depois da consulta de saldo.
- HTML e texto dos fluxos existentes são preservados; nos dois modelos Premium,
  aplica-se a revisão visual aprovada. Não há mudança no fluxo de ativação.

### Configuração e rollback

1. Aplicar a migração `0091` antes de habilitar `BREVO_API_KEY` e publicar o código.
2. Cadastrar `BREVO_API_KEY` como secret do Worker, nunca no frontend ou no Git.
3. `BREVO_EMAIL_FROM` identifica o remetente autenticado. `EMAIL_FROM` continua
   sendo o remetente já configurado para Resend, preservando sua autenticação.
4. Sem `BREVO_API_KEY`, o transporte permanece Resend e não exige a nova tabela.
   Para rollback, publicar a versão anterior; a migração é aditiva.
5. Não remover a tabela durante rollback: ela preserva as decisões de envio.

### Teste adicional da foto

Após criar o encaminhamento `no-reply@api-merlin.com` para o Gmail e configurar
a foto da conta Google, foi enviado um teste `[TESTE FOTO DO REMETENTE]`.
A API Brevo confirmou em 234 ms. Essa confirmação não comprova exibição da foto;
o Gmail decide se a apresenta. Não houve disparo para clientes.

### Regressões

- 53 testes passaram em cinco arquivos de e-mail, incluindo Brevo/Resend,
  timeout de consulta/envio/corpo, confirmação inválida, concorrência na cota,
  rota persistida após falha, código entregue e verificado pelo mesmo hash,
  templates de cobrança/acesso e cancelamento Premium durante a consulta de saldo.
- Gate Premium: 60 testes em oito arquivos, incluindo D1 nativo e migrações.
- Public: TypeScript e 42 testes passaram; não precisa de nova publicação do frontend.

### Produção

- Migração `0091` aplicada e secret `BREVO_API_KEY` cadastrado no Worker de produção.
- Publicado via `npm run deploy`, com o gate Premium executado novamente e aprovado.
- Worker: `8f935794-77ee-485b-a5ca-bbcf1a0a61d9`.
- Teste real em `/api/public/email-verification/start`, somente para
  `azteka.merlin@gmail.com`: HTTP 200 em 2.238 ms. D1 confirmou `provider=brevo`,
  verificação pendente e confirmação de envio gravada no ledger. Isso comprova
  aceitação pelo provedor; chegada e pasta no Gmail dependem da entrega.
- `/health`, `/download` e login do Admin responderam 200. O catálogo Premium e
  o histórico de notificações do painel continuam exigindo autenticação.
- Assets do Admin conferidos contra produção; Wrangler informou nenhum arquivo
  novo para upload. O Worker do Public e o launcher não precisaram ser alterados.
