# Capas de jogos no launcher

As capas são carregadas pelo processo principal do Merlin e guardadas em
`userData/cache/game-covers`, por AppID. A interface pede uma capa pelo IPC;
ela não acessa diretamente a Hubcap nem a Ryuu.

## Origem e fallback

- URLs válidas já presentes no catálogo Merlin ou da Steam podem fornecer a
  primeira imagem. Se não houver uma URL aceita, o launcher consulta a imagem
  original da Ryuu.
- A Hubcap não participa de consultas, seleção ou entrega de capas. Seu uso no
  Merlin permanece restrito ao fluxo de manifests/ativações.
- Ao falhar uma solicitação à Ryuu por erro de rede, timeout, bloqueio ou
  resposta inválida, o circuito pausa somente as requisições de imagem à Ryuu
  por 60 segundos. URLs Steam/Merlin já conhecidas continuam funcionando.
  Um jogo sem cache nem uma capa acessível nessas origens usa o placeholder.
- Depois da pausa, uma única solicitação à Ryuu testa a recuperação. Se der
  certo, o circuito fecha; se falhar, inicia outra pausa. Um 404 isolado indica
  que aquele AppID não tem capa e não abre o circuito.
- A falha de uma capa nunca apaga o arquivo local. Cópias locais com mais de
  24 horas podem ser atualizadas em segundo plano. A atualização pela Ryuu
  aguarda o circuito; atualizações de URLs Steam/Merlin não dependem dele.

## Limites e validação

O cache aceita arquivos JPEG, PNG, WebP ou AVIF de até 5 MiB. Downloads têm
timeout de 4 segundos, no máximo quatro operações simultâneas e gravação
atômica. Redirecionamentos não são seguidos. O renderer inicia o carregamento
lazy quando a imagem entra na tela e mantém a imagem durante atualizações da
lista.

## Biblioteca offline

A biblioteca abre com os Lua e o cache local, sem esperar pela rede. O modo
`metadataOnly` consulta apenas `games_catalog` no Merlin; nomes ausentes não
acionam Hubcap, Ryuu, DepotBox ou a loja Steam. Capas já salvas no computador
continuam disponíveis quando a API ou a Ryuu falhar.

## Manifests

A decisão de capas não muda a cascata de manifests. A Hubcap continua disponível
no fluxo de manifests conforme a configuração atual, com as regras de cota
descritas em [HUBCAP_API.md](HUBCAP_API.md).
