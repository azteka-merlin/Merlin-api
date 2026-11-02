# Publicação Premium e limite de pastas — 02/11/2026

Publicação em staging e produção autorizada pelo usuário e concluída.

| Ambiente | API e Admin | Site público |
| --- | --- | --- |
| Staging | `d0bf00d2-9455-4a77-8695-1a8b22875bcc` | `97593295-362f-4845-9ff1-5f33f986f03f` |
| Produção | `04f0bec6-a3a8-4a23-a634-faba6b722308` | `04324b45-b6b9-4395-af43-47e6fcc97471` |

- Migração `0090_premium_wishes_and_retries.sql` aplicada nos bancos `merlin-db-stage` e `merlin-db`.
- Admin e API incluem jogos em breve, lista de desejos, fila de avisos Premium e autorização de nova tentativa exclusiva por 15 minutos.
- Site inclui a lista de desejos na conta. Pastas aceitam até 200.000 arquivos no Admin, API, indexação e integridade; os limites de bytes de manifesto acompanham o novo volume.
- Os arquivos locais do launcher foram preparados para os novos fluxos. O usuário fará o teste local com `npm run start`; esta publicação não gerou uma release do launcher.
- Saúde da API respondeu 200 nos dois ambientes. Catálogo Premium, estado de operação, interessados e notificações responderam 401 sem autenticação.
- Login do Admin, `/download` e `/meu-acesso` responderam 200. Os assets publicados confirmaram a lista de desejos, Nova tentativa e o limite de 200.000 arquivos.
- Cron de produção permanece a cada minuto. O cron de staging permanece desativado conforme a configuração existente.

Antes da publicação, as suítes gerais passaram e a mudança de limite foi verificada com 69 testes da API, 23 do indexador, 10 de upload do Admin e 2 de fronteira do launcher, além do typecheck da API. Os builds finais do Admin e do site passaram. Os testes não enviaram e-mails reais nem acionaram ativações Steam.
