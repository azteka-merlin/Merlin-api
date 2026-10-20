# Runner de integridade dos jogos

> A produção usa agora [Cloudflare Queues + Workers + R2](CUSTOM_GAME_INDEXING_CLOUDFLARE.md).
> Não é necessário iniciar este CLI em computador local ou VPS. Este documento
> descreve a ferramenta Node de diagnóstico e compatibilidade; ela não é o
> executor de produção.
> Quando `CUSTOM_GAME_INDEX_QUEUE` está configurado, a rota de claim do CLI retorna
> `job: null`; o consumidor da Cloudflare mantém a exclusividade do processamento.

O indexador roda em Node.js 22 ou mais recente, em uma máquina ou serviço com
acesso à API Merlin. Ele processa um jogo por vez. Não precisa de credenciais
R2 nem acesso direto ao banco: usa as rotas internas autenticadas da API.

Para iniciar, instale as dependências do projeto com `npm ci`, defina
`CUSTOM_GAME_INDEXER_API_URL` com a origem HTTPS da API e
`CUSTOM_GAME_INDEXER_SECRET` com o mesmo segredo configurado no Worker.
O segredo fica em variável de ambiente, nunca em argumento de linha de comando
ou arquivo versionado.

```powershell
$env:CUSTOM_GAME_INDEXER_API_URL = 'https://SUA-API'
$env:CUSTOM_GAME_INDEXER_SECRET = '<segredo configurado no Worker>'
$env:CUSTOM_GAME_INDEXER_TEMP_DIR = 'E:\Merlin-index-temp'
node scripts/custom-game-indexer.mjs
```

Sem opções o processo acompanha a fila. `--once` consulta a fila, processa no
máximo um job e encerra; é útil em um agendador ou para operação pontual.
`--help` lista as opções. HTTP só é aceito em localhost para desenvolvimento.

## Disco, leitura e progresso

Para um ZIP é necessário espaço temporário para **o ZIP inteiro**, mais uma
reserva de 1 GiB. O jogo descompactado não é escrito no disco. O download usa
intervalos de 16 MiB por padrão, com memória limitada pelo streaming, e calcula
o SHA-256 do ZIP na mesma passagem. Uma segunda leitura local percorre o
diretório central, depois cada arquivo descomprimido passa pelo SHA-256 e CRC32.
O manifesto inclui a posição do conteúdo comprimido de cada membro para
atualizações e reparos seletivos pelo launcher. ZIP64, stored e deflate são
suportados; ZIPs criptografados, links simbólicos, nomes inseguros, conflitos
de caminho e CRC incorreto são rejeitados.

O processo emite progresso e renova o lease independentemente da transferência
a cada 15 segundos. Uma falha transitória retoma o download a partir do último
byte processado. Se o processo for interrompido com Ctrl+C/SIGTERM, o lease
expira e outro runner pode recomeçar o job; esse recomeço baixa o ZIP novamente.
O ZIP temporário é removido ao finalizar ou ao tratar uma falha/interrupção.
Um encerramento forçado do processo ou da máquina pode deixar uma pasta
`merlin-index-*`; ela pode ser removida quando não existir runner utilizando-a.

Pastas legadas sem todos os hashes são lidas arquivo por arquivo, sem cópia
temporária do jogo. Pacotes de pasta atuais já possuem hashes no manifesto e
podem usar esses hashes diretamente.

## Configuração opcional

| Variável | Padrão |
|---|---|
| `CUSTOM_GAME_INDEXER_TEMP_DIR` | pasta temporária do sistema |
| `CUSTOM_GAME_INDEXER_POLL_MS` | `15000` (mínimo `1000`) |
| `CUSTOM_GAME_INDEXER_RANGE_BYTES` | `16777216` (máximo `67108864`) |
| `CUSTOM_GAME_INDEXER_MAX_ARCHIVE_BYTES` | `107374182400` (100 GiB) |
| `CUSTOM_GAME_INDEXER_MAX_GAME_BYTES` | `214748364800` (200 GiB) |
| `CUSTOM_GAME_INDEXER_MAX_FILE_BYTES` | `32212254720` (30 GiB) |
| `CUSTOM_GAME_INDEXER_RESERVE_DISK_BYTES` | `1073741824` (1 GiB) |

Os limites configurados no runner não ampliam os limites aceitos pela API.
Cada manifesto pode conter até 100 mil arquivos e o ZIP até 200 mil entradas,
incluindo diretórios. O índice de caminhos/hashes fica na memória; os conteúdos
dos arquivos continuam em streaming. A taxa de compressão máxima aceita é
10 mil vezes o tamanho comprimido de cada arquivo.

As mensagens de log são JSON, com ID do job, ID do jogo, fase e contadores.
O runner não imprime segredo, token de lease, URLs autenticadas ou conteúdo de
arquivos. Falhas permanentes aparecem no menu de indexação do admin e podem
ser reencaminhadas depois de corrigir o pacote ou a configuração.

## Verificação local

```powershell
node --test scripts/custom-game-indexer.test.mjs
node scripts/custom-game-indexer.mjs --help
```

Os testes criam ZIPs pequenos temporários e exercitam ZIP64, métodos stored e
deflate, CRC, nomes inseguros, limites, retomada HTTP, heartbeat e limpeza.

## Fila e API

O Worker usa o binding `CUSTOM_GAMES` existente para registros pequenos em
`_integrity-jobs/<ambiente>/<id>.json`. O ambiente vem de `ENVIRONMENT` do
Worker: `staging` ou `production` (padrão). O estado do runner em
`_integrity-worker/<ambiente>/last-seen.json` também é isolado, pois os dois
ambientes podem compartilhar o mesmo bucket. O ID é SHA-256 de
`gameId + archiveKey`, impedindo
duplicação do mesmo pacote. O corpo guarda o lease; os metadados R2 guardam
somente os campos públicos para a consulta do admin. As transições usam
condicionais por ETag para impedir que dois runners assumam o mesmo job.

O menu administrativo consulta `GET /panel-api/custom-games/indexing`, envia
`POST` nesse caminho com `{ "mode": "missing" }` ou `{ "mode": "all" }`, e
pode usar `/:id/retry` e `/:id/cancel`. `gameId` opcional limita o pedido a um
jogo. Pastas cujos manifestos já têm todos os hashes são aproveitadas sem
transferir novamente o conteúdo; o modo `all` refaz os ZIPs, incluindo os que
já possuem índice. Arquivos de pasta antigos sem hashes entram na fila.

Para inicializar e acompanhar a fila por uma operação de serviço, sem sessão
interativa do painel, use `POST /internal/custom-game-indexing/enqueue` e
`GET /internal/custom-game-indexing/status`. Ambos exigem
`Authorization: Bearer <CUSTOM_GAME_INDEXER_SECRET>`, com a mesma autenticação
do runner. O POST aceita os mesmos `mode` e `gameId` opcionais do painel; `missing`
é adequado para a primeira indexação e para incluir novos pacotes sem refazer
índices prontos. Jobs que já estão aguardando ou em execução não são duplicados.
O status retorna cobertura, contadores, jobs e último contato do runner, sem
segredo ou tokens de lease. As respostas não podem ser armazenadas em cache.

Exemplo com o segredo já presente no ambiente, sem incluí-lo no comando:

```powershell
$indexHeaders = @{ Authorization = "Bearer $env:CUSTOM_GAME_INDEXER_SECRET" }
$indexOrigin = $env:CUSTOM_GAME_INDEXER_API_URL.TrimEnd('/')
Invoke-RestMethod -Method Post -Uri "$indexOrigin/internal/custom-game-indexing/enqueue" `
  -Headers $indexHeaders -ContentType 'application/json' -Body '{"mode":"missing"}'
Invoke-RestMethod -Uri "$indexOrigin/internal/custom-game-indexing/status" -Headers $indexHeaders
```

As rotas `/panel-api/` continuam exigindo sessão administrativa e, em operações
de escrita, CSRF. O segredo de serviço não substitui essas verificações.

O runner usa `POST /internal/custom-game-indexing/claim`,
`GET|HEAD /internal/custom-game-indexing/:id/source`, e `POST` em
`/:id/progress`, `/:id/complete` ou `/:id/fail`. Todos exigem o segredo Bearer;
a leitura da origem exige também `x-index-lease`. O token de lease não é
exibido no admin. O lease dura 120 segundos; cada renovação estende esse prazo.
Após três tentativas interrompidas o job falha até uma tentativa manual.
Cancelar invalida o token atual. A publicação final é uma transição curta
que não aceita cancelamento concorrente.

As leituras são limitadas a 64 MiB por solicitação e condicionadas ao ETag da
origem. Um pacote substituído durante o trabalho invalida a leitura. A origem
do job é a versão que foi enfileirada; publicar uma versão nova no catálogo
não interrompe a indexação de uma versão anterior ainda retida.

Os manifestos de pasta são imutáveis: repetir a finalização com o mesmo ID e
conteúdo devolve o pacote existente; mudar o conteúdo exige outro ID. A limpeza
de um pacote antigo consulta os outros manifestos atuais ou retidos antes de
remover arquivos ou bundles. Objetos compartilhados são preservados, e o
descarte individual recusa um objeto ainda referenciado. Uma falha ao ler outro
manifesto interrompe a limpeza para preservar suas referências.

O resultado fica em `<gameId>/integrity/<id>.json`, com hash SHA-256 de cada
arquivo, tamanho total e metadados da versão. ZIPs também incluem SHA-256 do
arquivo ZIP inteiro e localizadores do payload comprimido dos membros. Esses
manifestos pequenos podem ser preservados após a limpeza do pacote antigo
para comparar a instalação com a versão seguinte.

O launcher autenticado consulta
`GET /api/custom-games/:id/integrity?archiveKey=<versão>`; sem a query usa a
versão atual. O endpoint retorna 409 enquanto aquela versão não possui um
índice pronto. Os localizadores do ZIP permitem baixar os membros necessários
pelas rotas de arquivos da API sem transferir o arquivo ZIP completo.
