# Indexação de jogos na Cloudflare

A execução de produção acontece em **Cloudflare Queues + Workers + R2**.
Nenhum computador local, VPS, gerador de tokens ou processo Node externo precisa
permanecer ligado. O Worker publica o trabalho na fila e recebe os eventos de
consumo na própria plataforma.

## Recursos

| Ambiente | Fila | Fila de mensagens que esgotaram as tentativas |
|---|---|---|
| Produção | `merlin-game-integrity` | `merlin-game-integrity-dead` |
| Staging | `merlin-game-integrity-staging` | `merlin-game-integrity-staging-dead` |

O binding `CUSTOM_GAME_INDEX_QUEUE` envia mensagens pequenas com `jobId` e
`generation`. O progresso, os checkpoints e os manifestos permanecem no R2;
o conteúdo do jogo não é enviado dentro da mensagem. Os recursos e os prefixos
R2 de produção e staging são separados.

O consumer usa lote de uma mensagem, até duas execuções simultâneas e três
retentativas. A fila de mensagens que esgotaram as tentativas mantém os pedidos
para inspeção operacional; ela não recebe um consumer automático que repetiria
indefinidamente a mesma falha.

## Processamento

A leitura dos ZIPs usa intervalos do objeto R2, incluindo o diretório central
e o payload comprimido de cada arquivo. Os arquivos são descomprimidos em
stream com `DecompressionStream('deflate-raw')` quando necessário. Deflate64
(método ZIP 9, usado pelo pacote MKSM) usa `zlib-streams` 1.4.0 em WASM com buffers
de 64 KiB e leitura por demanda, mantendo o conteúdo descomprimido fora da memória
integral. O SHA-256
é calculado com `crypto.DigestStream`; CRC32 e os tamanhos são conferidos
durante a leitura. O ZIP e o jogo descompactado não são gravados em disco.

O trabalho salva checkpoints entre unidades de processamento e a próxima
mensagem continua a geração atual. A identificação da geração permite
descartar mensagens antigas depois de cancelamento ou reindexação. As leituras
ficam vinculadas à versão e ao ETag do pacote, para não combinar arquivos de
publicações diferentes.

Os hashes já presentes em manifestos de pasta são aproveitados. A indexação
lê o conteúdo das pastas legadas que ainda não possuem os hashes necessários.
O manifesto concluído continua sendo usado pelo launcher para verificar a
instalação, escolher os arquivos necessários e reparar problemas.

## Configuração e publicação

O `wrangler.example.jsonc` documenta os bindings de fila e R2. O arquivo
`wrangler.jsonc` contém os recursos da instalação e permanece fora do Git.
Preserve os outros bindings e limites ao copiar a configuração.

Antes da primeira publicação de produção:

```powershell
npx wrangler queues create merlin-game-integrity
npx wrangler queues create merlin-game-integrity-dead
npm run types
```

As filas de staging só precisam ser criadas antes de publicar esse ambiente.
O consumer é registrado pelo deploy do Worker. Apenas criar a fila não começa
o processamento; o Worker publicado precisa conter o handler e os jobs
precisam ser enfileirados.

Nenhum segredo externo é necessário para a comunicação do consumer com R2 e
Queues: o Worker usa seus bindings. `CUSTOM_GAME_INDEXER_SECRET`, quando
configurado, protege as rotas internas de operação e compatibilidade; ele
não representa uma dependência de um runner externo em produção.

## Acompanhamento

Use o menu **Indexação de jogos** no admin para acompanhar a cobertura, a
fila, o progresso e as falhas, solicitar os pacotes pendentes e repetir um
trabalho após corrigir sua causa. O painel Cloudflare mostra as métricas e a
fila de mensagens que esgotaram as tentativas. Logs do consumer podem ser
acompanhados com:

```powershell
npx wrangler queues list
npx wrangler tail
```

Não limpe a fila de mensagens com falha antes de identificar a causa. Não
publique segredos, tokens de lease ou URLs autenticadas nos logs.

## Limites da plataforma

O Worker está configurado com `limits.cpu_ms = 300000`, mantendo o limite de
subrequests existente. Cada invocação de Queues tem até 15 minutos de duração
e até 5 minutos de CPU. Os checkpoints distribuem o pacote entre invocações;
uma entrada comprimida individual é descomprimida como um stream contínuo e,
se a execução for interrompida, essa entrada é retomada por uma nova leitura.

Referências oficiais consultadas para esta configuração:

- [Limites do Queues](https://developers.cloudflare.com/queues/platform/limits/)
- [Bindings e configuração](https://developers.cloudflare.com/queues/configuration/configure-queues/)
- [Mensagens que esgotaram as tentativas](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
- [DigestStream](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Compression Streams](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)
- [API R2 para Workers](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
