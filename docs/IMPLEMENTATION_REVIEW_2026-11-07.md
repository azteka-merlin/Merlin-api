# Revisão do pacote de API, admin e launcher — 07/11/2026

## Escopo

Revisão das alterações locais de biblioteca, imagens, circuito da Ryuu,
importação de fixes, concorrência dos overrides e interface da fila no admin.
Também foram executadas as suítes completas de regressão da API e do launcher.

## Problemas encontrados e corrigidos

| Problema | Correção e cobertura |
| --- | --- |
| Staging tinha a fila, mas nenhum cron configurado para executá-la. | Cron de um minuto habilitado. O handler de staging retorna depois de agendar somente a importação; não ativa as outras rotinas anteriormente desligadas. Teste do handler real e da configuração em `tests/fix-import-scheduler.test.ts`. |
| Uma requisição de imagem antiga podia ter sucesso depois de outra falhar e cancelar a pausa do circuito. | Geração da reserva impede que respostas antigas reabram o circuito. Testes de concorrência e recuperação em `Merlin/test/circuit-breaker.test.js`. |
| A ausência de foto motivava novas consultas de nome, embora a API de metadados retorne apenas nomes. | Nome conhecido passa a ser suficiente nesse fluxo. Metadados sem foto preservam uma URL já armazenada. Regressões de biblioteca e catálogo no launcher. |
| A oferta de correção ainda carregava imagem diretamente da Ryuu. | Usa o mesmo carregador local das demais telas. URLs de capas do próprio Merlin também são aceitas pela política central. |
| Reutilizar imagens de modais deixava callbacks antigos; imagens que falharam podiam ser retidas como se ainda estivessem carregando. | Remoção dos listeners anteriores, descarte de respostas atrasadas, recuperação após falha e limpeza de observadores de cards removidos. Testes usam EventTarget real. |
| Salvar uma revisão de staging poderia atingir o documento principal caso um fix próprio fosse criado em produção depois da importação. | Uma entrada da camada de teste continua sendo editada nessa camada. Regressão com D1/R2 locais verifica o documento original byte a byte. |
| Um processador que perdesse a reserva poderia registrar uma falha por cima do estado do novo processador. | Gravações de estado e progresso condicionadas ao token e ao prazo da reserva. Teste de perda da reserva durante uma requisição atrasada. |
| JSON inválido ou `null` na seleção da fila causava erro 500. | Retorna 400 com a orientação de seleção. Testes de entradas inválidas e limite de 200 itens. |
| O verificador ZIP aceitava combinações inválidas dos bytes de assinatura. | Apenas os três pares válidos são aceitos. Regressão com assinatura inválida. |
| Testes ainda esperavam proxy de imagens e consultas à Hubcap já descartados. | Contratos atualizados para metadados locais, cache no launcher e ausência de consultas externas nesse modo. |
| Abas dos estados da importação não tinham o comportamento acessível do componente compartilhado. | Reutilização de AdminTabs, navegação por teclado e vínculo entre aba e painel. |

Os testes da importação também cobrem seleção manual, ordem, exclusão de jogos
ocultos e fixes próprios, elegibilidade de manifest-only, falhas de download,
retry, recuperação da publicação, badge de revisão e preservação de mudanças
feitas pelo admin durante o download.

## Resultados

- API: 535 testes Vitest aprovados em 79 arquivos.
- Indexador da API: 23 testes Node aprovados.
- Launcher, rodada final: 410 testes aprovados.
- TypeScript aprovado.
- Build do admin aprovado.
- Gate do deploy: 63 testes Premium, incluindo D1 nativo, e TypeScript aprovados.
- `git diff --check` sem erros nos três repositórios.

Uma rodada do launcher teve uma falha intermitente no teste preexistente
`explicit cancellation clears pipelined extraction and resume state`, antes do
checkpoint. O arquivo passou isolado (9 testes) e as duas rodadas completas
seguintes passaram. A causa dessa oscilação não foi confirmada; ela não deve
ser confundida com uma garantia de ausência de falhas de instalação.

## DLL OpenSteamTool

Comparação da cópia local com HEAD: mesmo tamanho, 1.569.280 bytes, somente seis
bytes diferentes. Essas diferenças estão nos dois timestamps PE, no cabeçalho
COFF e no diretório de debug. A seção executável e todos os outros bytes são
idênticos. A DLL instalada na Steam corresponde à cópia local.

- Local: `26767ed896909b103d21bb6325978abaffb9438cac72cee7504f2c9cb5ef104c`
- HEAD: `21baae14b6e5b36560d559e336efd1439432798760afa1c7d76d0e41900b3f5f`

## Publicação e estado da fila

API/admin publicados somente em staging pelo script `npm run deploy-stage:panel`.
Versão: `335ef1fd-68c6-4512-96e2-053148bab815`.

Checagens após publicação: health 200; fila e catálogo autenticado retornaram
401 sem sessão/token; o admin respondeu com o novo asset.

Havia 14 jogos selecionados, ainda sem tentativas. A pedido do usuário, eles
voltaram para Não baixados porque a Ryuu estava indisponível. Verificação final
no D1 de staging: 350 missing, zero tentativas, zero bytes. O cron não seleciona
itens missing. O primeiro download real desse pacote não foi validado nesta
revisão; o usuário decidirá quando recolocar os itens na fila.

O launcher atualizado permanece local para `npm run start:stage`. Não houve
commit, push ou publicação de produção nesta revisão.

## Limites conhecidos

- Importação: arquivos ZIP/RAR de até 2 GiB; timeout de download de 120 segundos.
  Arquivos acima do limite ou downloads mais lentos são apresentados como falha.
- Assinatura, tamanho e SHA-256 não equivalem à validação integral do conteúdo
  de todos os arquivos de um pacote.
- A apresentação final no Electron ainda requer conferência visual local.
- Para produção, aplicar a migração 0096 antes do deploy e executar novamente
  a validação obrigatória no código publicado.

## Correção adicional: consulta do catálogo retornando 500

Após o relato no admin, foram reproduzidos erros 500 na rota de consulta com
falha de rede, timeout e JSON inválido. Esse tratamento estava incompleto na
revisão anterior: respostas HTTP de erro já retornavam 502, mas exceções da
requisição e do parse ainda escapavam como 500 genérico.

A consulta externa e sua validação agora têm tratamento próprio: retornam 502
com mensagem explicando a falha da Ryuu e preservam a lista atual. Erros do
banco e do armazenamento não são classificados como falhas da Ryuu. A reserva
de consulta é liberada em todos os casos, permitindo nova consulta.

Cinco casos de regressão cobrem rede, timeout, HTTP 503, JSON inválido e esquema
inválido. Eles também conferem que a lista permanece intacta e uma consulta
posterior pode funcionar. Os três primeiros reproduziram 500 antes da correção.
Depois da correção: 20 testes aprovados nos arquivos de importação, agendamento
e concorrência de overrides.

O endpoint público do catálogo respondeu 200 numa consulta feita nesta etapa.
Não foi possível recuperar os logs históricos do clique relatado: as duas
credenciais disponíveis testadas retornaram 403 na API Observability. Portanto,
a reprodução confirma a falha de tratamento, sem atribuir definitivamente a
exceção específica daquele clique a uma indisponibilidade da Ryuu.

Correção publicada em staging pelo script `npm run deploy-stage`, versão
`be612e7b-0d9b-44d4-87ce-4636f681195f`. O gate de 63 testes Premium e TypeScript
passou novamente; health retornou 200 após a publicação.

## Causa confirmada pelo erro de runtime: redirect inválido

O relato posterior trouxe `Invalid redirect value ... "error" won't be implemented`.
Consulta e download usavam `redirect: 'error'`, rejeitado pelo fetch do Worker
antes da requisição. Nesse caso específico, a causa é nossa configuração, não
evidência de indisponibilidade da Ryuu. A correção anterior de mensagens não
resolvia essa causa.

As duas chamadas agora passam pelo helper `fix-source-fetch.ts`: utiliza
`redirect: 'manual'`, rejeita HTTP 3xx e cancela o corpo da resposta. Não segue
Location nem encaminha a chave para outro endereço.

Os testes anteriores usavam fetch simulado no processo Node, com D1/R2 nativos;
isso não validava as opções de fetch no Worker. O novo teste executa o helper
real dentro do workerd via Miniflare, interceptando apenas a saída de rede.
Verifica HTTP 200 e 301/302/303/307/308 com uma única requisição à origem.
O fluxo também verifica a configuração manual em consulta e download e recusa
publicação de arquivos/overrides em caso de redirecionamento.

Validação inicial: 26 testes aprovados em três arquivos. Os hooks predeploy e
predeploy-stage passam a executar `test:fix-import`, além do gate Premium já
existente. Estados Falhou já registrados permanecem históricos até o admin
selecionar Tentar novamente; não são recolocados na fila automaticamente.

Correção do redirect publicada somente em staging, versão
`eb3f7e8d-3114-45b1-8551-58d5c400f0dc`. O predeploy aprovou os 27 testes de
importação, os 63 testes Premium e TypeScript. Health 200 após a publicação.

## Publicação em produção — 07/11/2026

Após aprovação do teste visual com Ryuu indisponível, aplicadas as migrações
0094, 0095 e 0096 no banco de produção. API e admin publicados juntos por
`npm run deploy:panel`, versão `1ed71577-3c04-4b09-aaff-d82baecdba8b`.

- Suíte completa da API: 547 testes Vitest e 23 testes do indexador aprovados.
- Predeploy: 27 testes de importação, 63 testes Premium com D1 nativo e
  TypeScript aprovados. Build do admin aprovado.
- Launcher: 413 testes aprovados; circuito limita somente imagens da Ryuu.
  URLs Steam/Merlin conhecidas continuam funcionando com o circuito aberto.
- Checagens remotas: health 200, login do admin 200, novo bundle do admin 200,
  importação e catálogo privado 401 sem autenticação. A raiz pública mantém
  o redirecionamento para `/download`, cuja resposta é 200.
- Fila de produção inicializada sem tarefas. Nenhum download iniciado; a
  descoberta e a seleção continuam sob controle manual no admin.
- A importação completa de um arquivo real ainda depende de nova tentativa
  com a origem estável. O limite de 120 segundos permanece conforme aprovado.

O launcher segue em publicação separada, versão 2.4.25, pelo pipeline GitHub.
Não foi executado build local do instalador. A simulação de falha é exclusiva
do desenvolvimento e não é ativada no aplicativo empacotado.
