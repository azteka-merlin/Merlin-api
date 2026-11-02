# Publicação Merlin 2.4.23 — 02/11/2026

Publicação em produção, commits e pushes autorizados pelo usuário. Build do
instalador delegado ao workflow do GitHub, sem aguardar sua conclusão.

## Produção

| Projeto | Worker/versionamento publicado |
| --- | --- |
| API e Admin | `be848364-4c5a-4828-a0ba-159832c37224` |
| Site público | `40fe9152-d928-4ce6-ba20-5f819d4ff26f` |
| Launcher | `2.4.23`; publicação pelo workflow de release após push em master |

Não há migrações pendentes no D1 de produção. Health, login do Admin,
download e Minha conta retornaram 200. Catálogo Premium e listas de desejos
privadas sem autenticação retornaram 401. Os assets do Admin conferem com
o build atual, incluindo o telefone formatado.

## Escopo sincronizado

- Wishlist Premium, inscrições com consentimento, Minha conta e avisos por e-mail.
- Aviso da próxima vaga, nova tentativa exclusiva do suporte e identificação
  da operação para impedir duplicidade e confirmar o estado após interrupções.
- Correção do falso 409 na reserva/conclusão com D1 e seus testes de regressão.
- Relatórios de downloads/pagamentos e média mensal de assinantes pagos.
- Limite de pastas de 200 mil arquivos no Admin, API, indexador e launcher.
- Ajuste do reparo de DLLs, sem modificar os binários atuais.
- Textos aprovados dos planos e lista de desejos no site público.

O ativador manual do FC 27 permanece fora dos repositórios e da release.
O `config.json` local do launcher contém preferências e marcadores da conta
de desenvolvimento; não faz parte do commit. Nenhuma DLL foi revertida.

## Validação

- API: 460 testes Vitest + 23 testes do indexador.
- Prova negativa Premium: correção passa; comparadores antigos da reserva e
  da conclusão são detectados independentemente.
- Predeploy obrigatório: 56 regressões Premium e TypeScript passaram.
- Admin: 38 testes e build passaram.
- Site: 42 testes, TypeScript e build passaram.
- Launcher: 339 testes passaram; houve falhas transitórias de acesso a
  arquivos temporários nas primeiras execuções. A execução final completa,
  com TEMP normalizado como no workflow, passou sem mudanças no código.

Não foi compilado um EXE local. O workflow gera instalador e `integrity.json`
e publica uma release normal do GitHub com as notas em `docs/releases/2.4.23.md`
do repositório do launcher. O envio do novo EXE para o mecanismo de atualização
do Admin só pode acontecer após o build; não antecipar seus metadados.
