# Importação de correções da Ryuu

No admin: **Fila do catálogo → Importar correções**. Não há menu novo.

## Operação

1. Consultar catálogo da Ryuu registra os candidatos em **Não baixados**. Não
   baixa arquivos nem coloca jogos automaticamente na fila.
   Queda de conexão, timeout, resposta HTTP de erro e JSON inválido retornam
   502 com mensagem explicativa. A lista existente é preservada e a reserva de
   consulta é liberada, permitindo tentar novamente sem aguardar cinco minutos.
2. A descoberta usa `normalizeRemoteEntries` e `sortCorrectionCatalog`, com os
   mesmos metadados e totais de avaliações utilizados na tela Correções. Só o
   primeiro fix elegível por jogo é considerado; online e hypervisor são excluídos.
3. Overrides de **fix** já existentes e jogos ocultos são excluídos. Jogos que
   tenham apenas override de manifest entram normalmente; o manifest é preservado.
   O catálogo é consultado novamente apenas quando o admin solicita.
4. O admin seleciona até 200 jogos por ação e clica em **Colocar na fila**.
   O cron processa somente itens em Aguardando, seguindo a posição registrada.
5. **Baixando** mostra a fase, bytes e tentativas. **Falhou** permite selecionar
   jogos para tentar novamente, preservando a posição original. Não existe pausa.
6. Ao concluir, o arquivo fica no R2 e um fix override habilitado é cadastrado.
   O estado da fila passa a **Migrado** e o override recebe `migrated: true`.
7. O card de Overrides mostra **Migrado · revisar**. Salvar normalmente o
   override remove `migrated`, inclusive se o conteúdo não foi alterado. O
   histórico da fila continua como Migrado. Abrir sem salvar não remove a badge.

## Persistência e arquivos

- Migração D1: `0096_fix_import_queue.sql`. Nenhum binding novo.
- O cron existente obtém uma reserva atômica por ambiente, válida por 10 minutos.
  São processados até cinco itens por rodada, interrompendo a escolha de novos
  itens após 45 segundos. Um download individual tem timeout de 120 segundos.
- O arquivo é transferido por partes de 8 MiB, sem carregar o pacote inteiro na
  memória. O limite atual por arquivo é 2 GiB; acima disso o item falha e pode
  ser tratado manualmente.
- Verificam-se origem, extensão, assinatura ZIP/RAR, tamanho recebido e tamanho
  declarado quando disponível. O SHA-256 é registrado. Isso não substitui uma
  análise do conteúdo de um arquivo do fornecedor.
- Objetos usam nomes UUID sob `<appid>/fixes/`, preservando arquivos anteriores.
  Um pacote completo pode ser reaproveitado após falha no cadastro.
- O override é conferido antes e depois do download e novamente na gravação
  condicional no R2. Cadastro, exclusão e importação usam comparação de ETag;
  conflito exige nova leitura. Jogos ocultos ou com fix próprio não são
  substituídos. Tarefas interrompidas viram Falhou após vencer a reserva.
- URLs autenticadas não são armazenadas nem retornadas ao painel. A chave Ryuu
  é adicionada somente no download, sem seguir redirecionamentos.
- Consulta e download usam `fetchFixSource`, com `redirect: 'manual'` e rejeição
  explícita de HTTP 3xx. Não usar `redirect: 'error'`: o runtime dos Workers
  rejeita esse valor antes mesmo de fazer a requisição. Uma resposta de
  redirecionamento não é seguida nem recebe a autenticação da origem.

## Staging

Staging compartilha o bucket físico com produção. Por isso as importações de
teste gravam o documento `_fix-import/staging/overrides.json` e arquivos sob
`<appid>/fixes/_staging/`. O admin e o catálogo de staging combinam essa camada
com os overrides existentes. Um fix próprio ou jogo oculto original tem
prioridade; um manifest original é preservado e combinado com o fix de teste.

Salvar ou remover um override dessa camada de teste continua operando nela.
Isso também vale se alguém cadastrar um fix próprio de produção para o mesmo
jogo após a importação: salvar a revisão de teste não altera o documento original.
Produção não lê essa camada. Os testes não fazem downloads reais ou alterações
no armazenamento remoto.

O cron de staging precisa estar configurado para `* * * * *`. O handler executa
somente essa fila no ambiente de teste e retorna antes das notificações,
cobranças e demais rotinas anteriormente desativadas nesse ambiente. Nenhum
download começa sem uma seleção manual, mesmo com o cron ligado.

Os estados finais e os registros de progresso conferem também o token e o prazo
da reserva no SQL. Um processador antigo não pode sobrescrever o estado de um
novo processador caso uma operação demore além da reserva.

## Publicação

Aplicar a migração no banco do ambiente antes do deploy. Usar os scripts npm de
deploy, que executam a validação Premium obrigatória. Em staging, preparar a
lista apenas por descoberta, mantendo todos os candidatos em Não baixados.
Não iniciar downloads em nome do admin: a seleção é manual.

`npm run fixes:prepare-stage` usa as credenciais atuais do Wrangler para executar
essa mesma descoberta no banco de staging. O comando lista candidatos e verifica
as contagens; não coloca itens em Aguardando nem baixa pacotes de correção.

## Verificação

`tests/fix-import.test.ts` usa D1 e R2 locais do Miniflare para cobrir descoberta,
ordem, exclusões, seleção manual, concorrência de processadores, falhas e retry,
marcação de migrado, revisão ao salvar e isolamento de staging.
`tests/overrides-concurrency.test.ts` cobre gravações simultâneas de overrides.

`tests/fix-source-fetch-runtime.test.ts` executa o helper real dentro do workerd,
com a saída de rede interceptada, sem mockar o `fetch` do Worker. Confere sucesso
HTTP 200 e rejeição de 301/302/303/307/308 com uma única chamada à origem. Os
testes do fluxo conferem também a configuração manual na consulta e no download,
preservação da lista e ausência de publicação ao receber redirecionamento.

`npm run test:fix-import` executa essas regressões. Os hooks de publicação de
staging e produção agora executam esse comando antes da validação Premium.
