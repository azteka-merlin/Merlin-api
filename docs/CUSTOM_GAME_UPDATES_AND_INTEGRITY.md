# Atualizações e integridade do Jogue Agora

Implementação em `Merlin-api`, `Merlin-admin` e `Merlin-luncher`, com publicação
de produção autorizada em 20/10/2026. A migração 0085 e API/admin já foram publicados;
os índices dos quatro jogos enviados por pasta foram gerados com os hashes existentes.
O launcher 2.3.0 foi publicado no GitHub e no canal de atualização da API.
A execução dos ZIPs usa Cloudflare Queues; Deflate64 também é suportado no indexador
e na revisão 2.3.1 do launcher.

Em 20/10/2026 às 09:18 BRT, o canal de atualização da API já informa **2.3.1**.
O instalador de produção tem 112.197.580 bytes e SHA-256
`69abce19029d0a55a3bb959d84f62edb466efe928152d42343bcdcfade3cab59`,
conferido após download pela própria API. As versões anteriores foram arquivadas
no R2 para retorno operacional.

A fila real já concluiu os quatro jogos por pasta e o ZIP Deflate64 de
Mortal Kombat: Shaolin Monks, com 16 arquivos e 3.960.857.278 bytes descomprimidos.
Os outros cinco ZIPs continuam na fila/processamento, sem falhas na consulta desse
horário. O painel reflete o estado atual; esses números são um registro da ativação.

## Regra de publicação

O administrador envia um pacote ZIP ou pasta para a nova versão. Em ports, se o
pacote trouxer `game`, seus arquivos catalogados também participam da atualização;
se não trouxer, a instalação existente de `game` permanece intacta. O cliente
calcula a diferença; não é necessário separar um patch.

O cadastro agora informa origem (`native` ou `port`), versão de exibição e caminhos
preservados. Ports podem informar repositório GitHub, convite Discord e a tag da
release utilizada. Saves e outros caminhos preservados continuam protegidos;
arquivos extras fora dos manifestos não são apagados.
Cadastros antigos começam como nativos; a origem pode ser corrigida no painel.

Salvar um pacote novo registra sua identidade imutável e publica a referência
nova em uma transação com a aposentadoria das versões substituídas. Uma falha
no banco não publica parcialmente a versão. Publicações concorrentes não deixam
versões substituídas ativas. Um cadastro removido não pode ser ressuscitado por
um formulário aberto anteriormente.

O aviso de release GitHub aparece no admin comparando a última release estável
com a tag cadastrada. A consulta tem cache de uma hora e recuo de cinco minutos
em falhas. Uma release externa não é instalada nem publicada automaticamente.
O usuário vê **Atualizar jogo** quando o pacote publicado difere do instalado.

## Atualização no launcher

1. Obtém o manifesto da versão instalada e o da versão publicada.
2. Compara caminho, tamanho e SHA-256, conferindo existência/tamanho no disco.
   Não recalcula todos os hashes do jogo antes de uma atualização normal.
3. Baixa arquivos novos, alterados ou ausentes, verificando o conteúdo recebido.
4. Só depois de concluir os downloads aplica substituições e remoções.
5. Atualiza a identidade instalada ao concluir a operação.

Em upload por pasta, arquivos diretos são baixados individualmente. Um pacote
agrupado é baixado se contiver algum membro necessário; somente os membros
planejados são aplicados. Em ZIP indexado, o cliente baixa os intervalos dos
membros necessários e descomprime localmente, sem baixar o ZIP inteiro de novo.
Métodos ZIP stored e deflate são suportados.

Um `.pak` alterado é transferido inteiro. Esta entrega compara arquivos, não
blocos internos de arquivos grandes.

Arquivos removidos da versão nova só são apagados se constavam no manifesto
instalado. Arquivos extras do usuário não são inferidos como lixo. Sem uma lista
anterior confiável, o sistema não deduz remoções.

São preservados caminhos definidos no admin, `game` de ports e configurações
existentes `.ini`, `.cfg`, `.sav`, `settings.json`, além de arquivos dentro de
`save`, `saves`, `savegames`, `savedata`, `user` e `userdata`. Arquivos ausentes
que a nova versão exige podem ser restaurados, com validação de caminho.

O launcher bloqueia alterações enquanto detecta processos do jogo em execução.
Há staging, backup e journal append-only com recuperação após interrupção.
Erros ou cancelamentos mantêm/restauram a instalação anterior. A estrutura
suporta transições entre arquivo e pasta sem remover conteúdo desconhecido.

**Limitação:** atualização/reparo cancelado não conserva o staging para retomar
os ranges posteriormente; a próxima tentativa baixa novamente o delta necessário.
A retomada por ranges da instalação inicial continua disponível.

## Downloads em andamento e exclusão no servidor

Cada transferência do protocolo 2 abre uma sessão autenticada vinculada à licença
e à chave exata do pacote. A versão não muda no meio do download, mesmo que outra
seja publicada. O estado local permite retomar uma instalação antiga usando o
snapshot correto de tamanho, formato e executável.

As sessões duram 24 horas, renovadas por pedidos de arquivos e heartbeat a cada
60 segundos. Conclusão ou cancelamento encerra a reserva. Uma instalação
interrompida por mais tempo só pode retomar a versão antiga se ela ainda estiver
armazenada; nunca mistura arquivos com uma versão nova.

Versões aposentadas têm carência mínima de 24 horas. A limpeza horária só pode
reivindicar uma versão sem sessões ativas, sem referência atual e com índice de
integridade preservado. Uma indexação em fila/em execução também impede a coleta.
O banco exclui a corrida entre abrir uma sessão e reivindicar a versão.

Arquivos compartilhados por outros manifestos são preservados. Manifestos de
transporte são imutáveis: repetir a finalização é idempotente se o conteúdo for
igual; tentar sobrescrever o mesmo identificador com conteúdo diferente falha.
Descarte de upload não pode remover objetos já referenciados por uma versão.
A revisão de armazenamento e as travas de publicação impedem publicar um pacote
com referências que foram removidas durante a limpeza.

**Compatibilidade:** launchers antigos não informam qual versão estão baixando.
Para não misturar seus ranges, eles continuam recebendo o primeiro pacote do jogo,
mantido como baseline com `legacy_hold`. Essa baseline não é coletada
automaticamente. Liberação desse espaço exige encerrar explicitamente o suporte
ao protocolo antigo em uma migração futura; um TTL sozinho não comprova que esses
downloads terminaram. Novos clientes recebem normalmente a versão mais recente.

A remoção administrativa do cadastro usa tombstone: sai do catálogo e não permite
novos downloads, mas sessões válidas já abertas podem terminar. A coleta continua
seguindo carência e reservas. Índices pequenos são preservados para verificar
instalações antigas mesmo depois de retirar seus pacotes do download.

O `wrangler.jsonc` atual usa `custom-games` em produção e `custom-games-staging`
em staging, com bancos separados. Filas e heartbeats também têm namespace por
ambiente. Essa separação deve ser mantida: a coleta não pode consultar referências
de um banco e apagar pacotes de outro ambiente. O cron de staging permanece
desabilitado na configuração atual.

## Verificar e reparar

**Verificar integridade** lê os arquivos declarados em streaming e compara tamanho
e SHA-256 com uma referência do servidor, nunca com hashes criados a partir da
instalação potencialmente corrompida. Detecta ausentes, conteúdo alterado inclusive
com mesmo tamanho, e arquivos sem acesso. Tem progresso, cancelamento e relatório
de caminhos. Não modifica a instalação.

O manifesto exato instalado fica em cache por ambiente, jogo e versão. Pode ser
usado offline e não é substituído pelo índice de uma atualização ainda não aplicada.
Um índice indisponível/pendente não é apresentado como verificação bem-sucedida.

**Reparar arquivos** é uma ação explícita depois da verificação. Baixa somente os
problemas identificados, da mesma versão, respeitando dados protegidos. Não apaga
extras. Se o pacote antigo já foi coletado, orienta atualizar para a versão atual.

## Indexação e menu do admin

Uploads por pasta v2/v3 já têm hashes de arquivos e dos membros dos bundles;
esses dados são reaproveitados. Pastas legadas sem hashes entram na fila.
ZIPs precisam de um índice dos arquivos **descomprimidos**, além do hash do ZIP.

O menu **Integridade dos jogos** informa cobertura, pendências, progresso por fase,
bytes/arquivos, falhas, estado do serviço e ações para enfileirar, repetir ou cancelar.
O painel não precisa ficar aberto para o trabalho continuar.

Cloudflare Queues executa os trabalhos; R2 guarda estado, plano e checkpoints,
com alterações condicionais por ETag. Cada mensagem processa até 32 arquivos ou
45 segundos entre arquivos e envia a continuação. Uma entrada grande é processada
em fluxo contínuo. Falhas repetem o trecho atual, preservando os trechos concluídos.
O lease de execução dura 20 minutos, acima do teto de 15 minutos do consumer,
para impedir duas leituras concorrentes do mesmo checkpoint após uma interrupção.
Gerações e tokens impedem que mensagens antigas alterem um trabalho substituído.
O cron recupera envios interrompidos e execuções cujo lease expirou. Há três
repetições automáticas e fila de mensagens que esgotaram as tentativas.

O Worker consulta o diretório central do ZIP por intervalos no R2, com suporte
ZIP64, inclusive localizadores de volume único com contador zero gerados por
alguns compactadores. Cada arquivo é descomprimido em streaming, com SHA-256 por
DigestStream e CRC32 nativo. Stored e deflate usam APIs nativas; Deflate64 usa o
codec WASM zlib-streams 1.4.0 com buffers de 64 KiB e controle de leitura por demanda.
Registra posições dos payloads para download seletivo. O pacote
inteiro não é carregado na memória nem baixado para computador ou VPS. Links,
caminhos inseguros, duplicatas/conflitos, criptografia, compressão não suportada
e conteúdo inválido são rejeitados. Todas as leituras fixam o ETag do pacote.
O hash agregado do ZIP é opcional; a integridade utiliza SHA-256 de cada arquivo
descomprimido. O CLI Node permanece apenas como ferramenta de diagnóstico.

ZIP sem índice permanece instalável pelo fluxo inicial anterior; atualização
seletiva, verificação e reparo aguardam a indexação correspondente.

## Ativação em produção

- Migração `0085_custom_game_versions.sql` aplicada antes da nova API.
- API/admin disponíveis com contratos do protocolo 2; launcher 2.3.0 publicado por release.
- Filas `merlin-game-integrity` e `merlin-game-integrity-dead` criadas na Cloudflare.
- Binding `CUSTOM_GAME_INDEX_QUEUE`, consumer com lote 1, concorrência 2 e CPU de
  até 300.000 ms; limite de 15 minutos por execução da plataforma.
- O botão **Indexar pendentes** enfileira todos os pacotes sem índice. Publicações
  futuras enfileiram automaticamente o pacote novo e a referência antiga necessária.
- `CUSTOM_GAME_INDEXER_SECRET` protege apenas as operações internas de manutenção;
  a execução em Queues usa o binding, sem segredo externo ou serviço persistente.
- `CUSTOM_GAME_GITHUB_TOKEN` é opcional para a consulta de releases públicas.

Detalhes: [indexação na Cloudflare](CUSTOM_GAME_INDEXING_CLOUDFLARE.md),
[CLI de diagnóstico](CUSTOM_GAME_INDEXER_RUNNER.md),
[upload de pastas](CUSTOM_GAME_UPLOADS.md), documentação do Admin em
`Merlin-admin/docs/CUSTOM_GAMES.md` e do launcher em
`Merlin-luncher/docs/features/custom-games.md`.

## Arquivos e responsabilidades

| Projeto | Principais alterações |
|---|---|
| API | Migração 0085; `custom-games.ts`; módulos `custom-game-versions`, `custom-game-integrity`, `custom-game-metadata`, `custom-game-package-lifecycle`; runner/scripts; rotas e cron em `index.ts`; segredos opcionais tipados; testes |
| Admin | Metadados no cadastro; nova página de indexação; menu/rota; estilos; validações; documentação e testes |
| Launcher | Serviço Jogue Agora; módulos de integridade e atualização; processo de instalação; preload/IPC; ações Atualizar/Verificar/Reparar e progresso; documentação e testes |

As alterações de autenticação/acesso que já existiam no checkout do launcher
foram preservadas e incluídas na release após revisão e testes. A indexação roda
inteiramente na Cloudflare. O serviço de tickets `merlin-worker` não foi alterado.

## Validação

Comandos locais utilizados:

```text
Merlin-api:     npm test
Merlin-api:     npm run typecheck
Merlin-admin:   node --test src/utils/*.test.js
Merlin-admin:   npm run build
Merlin-luncher: npm test
Todos:         git diff --check
```

Além das suítes existentes, foram incluídos testes de publicação a 50% do download,
retomada de versão antiga, licenças/sessões, publicação concorrente, tombstones,
limpeza concorrente, referências compartilhadas, índices imutáveis, isolamento
stage/prod, corrupção com mesmo tamanho, ZIP seletivo/ZIP64, CRC, cancelamento,
reparo, paths/junctions, rollback e encerramento abrupto durante aplicação/recuperação.
Há testes integrados com ZIP real ligando runner, API, publicação do índice e
download de membro individual.

Resultados finais:

| Verificação | Resultado |
|---|---:|
| API — Vitest, incluindo integrações, codec WASM, Workerd e migrações SQLite | 381 testes passaram |
| Runner — Node | 22 testes passaram |
| Admin — Node | 34 testes passaram |
| Launcher — suíte completa Node, incluindo Deflate64 | 287 testes passaram |
| Total das suítes | **724 testes passaram** |
| API typecheck | Passou |
| Admin build | Passou; mantém aviso de bundle acima de 500 kB |
| Diff whitespace nos três projetos | Passou |

A suíte completa do launcher passou em duas execuções consecutivas finais.
Oito cenários de pipeline foram repetidos em 12 execuções isoladas, sem falhas.
Na validação anterior houve dois timeouts intermitentes de espera por checkpoint
nesse conjunto. O teste agora reporta uma instalação encerrada antes do checkpoint
em vez de esconder sua causa atrás de um timeout; a falha não voltou a ocorrer
nas repetições finais. Esse cenário permanece um ponto de observação na homologação.

Na produção, foram confirmados o health da API, a proteção das rotas do admin,
a versão do canal de atualização e o SHA-256 do instalador baixado pela API.
Os quatro índices de pastas foram gerados e os seis ZIPs foram enfileirados
no consumer real do Cloudflare Queues. A indexação continua em segundo plano;
o progresso e eventuais falhas ficam no painel administrativo.

O pipeline do launcher passou a executar a suíte antes de compilar e publicar.
As falhas iniciais do runner Windows/Node 22 foram corrigidas nas fixtures:
normalização do TEMP por realpath e uma conexão simulada mantida ativa durante
o teste de timeout. A execução posterior concluiu os 279 testes da release 2.3.0
e publicou o instalador. Os oito testes adicionais cobrem o codec Deflate64 da 2.3.1,
inclusive quatro streams simultâneos. A suíte de 287 passou tanto no Node 22 quanto
no 24, e o codec empacotado no app.asar foi validado no Electron 33/Node 20 real.

Referências técnicas consultadas: [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[D1](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[limites Workers](https://developers.cloudflare.com/workers/platform/limits/),
[GitHub releases](https://docs.github.com/en/rest/releases/releases).
