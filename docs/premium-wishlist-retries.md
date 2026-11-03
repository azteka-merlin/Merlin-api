# Lista de desejos, avisos e nova tentativa Premium

Implementação das regras aprovadas em 02/11/2026. A migração 0090 é necessária antes de executar a nova API. Não há novos bindings nem alteração do envio de vencimentos.

## Lista de desejos

- O Admin cadastra o jogo como **Em breve / Lista de desejos**, mesmo sem arquivo de ativação.
- O launcher oferece inscrição com e-mail obrigatório, preenchido com o contato da licença quando for e-mail. Telefone é opcional e exige consentimento específico sobre aquele jogo.
- Minha conta permite consultar e remover interesses. A lista é privada por licença. O Admin vê os contatos autorizados.
- Para disponibilizar, o Admin desmarca Em breve, mantém o jogo habilitado e precisa ter enviado o arquivo. A data de disponibilidade inicia as janelas dos planos; cadastrar antecipadamente não antecipa essas janelas.
- A mesma atualização agenda os e-mails de lançamento de todos os interessados, inclusive de planos ainda sem acesso. O e-mail informa os planos disponíveis e a dependência de vagas.
- O jogo permanece na lista após o aviso. Remover o interesse cancela o envio ainda não realizado.

## Sininho

- Disponível quando as vagas públicas do jogo estão ocupadas. Solicita apenas e-mail obrigatório e permite cancelamento.
- O agendador calcula a próxima liberação de uma ativação pública de 24 horas. Reservas temporárias e prazos de suporte não são anúncios de vaga.
- Envio previsto cerca de cinco minutos antes, com nova validação imediatamente antes da chamada ao provedor. O aviso não reserva a vaga.
- Alterações na previsão, cancelamento e reativação exclusiva invalidam mensagens antigas. Após envio, a inscrição é encerrada.
- Se a previsão mudar e depois voltar ao mesmo horário, o evento cancelado é reagendado somente enquanto a mesma inscrição continuar ativa. Tentativas, corpo congelado e chave do provedor são preservados; inscrições canceladas e avisos enviados não são reativados.

## Nova tentativa acompanhada

- Na ativação, **Nova tentativa** autoriza somente a mesma licença e jogo por quinze minutos.
- A ativação original e suas datas ficam intactas até a conclusão. Não usar a autorização mantém o bloqueio anterior.
- A correção não gasta outra cota Bronze nem outra cota de licença de teste. O histórico relaciona a tentativa à ativação anterior. Só uma ocupa a vaga após o sucesso.
- A conclusão inicia novas datas de cooldown e de ocupação pública. Não há anúncio de vaga por causa da liberação exclusiva.
- Se a vaga antiga já tiver cumprido as 24 horas, a autorização precisa reservar uma vaga realmente livre; ela não toma a vaga de outro cliente.
- Falha comprovada antes da geração devolve a autorização ao prazo restante. Resultado incerto exige **Verificar tentativa** e confirmação pelo suporte antes de reautorizar.
- Os identificadores de operação impedem cliques duplicados. A confirmação de uma operação ausente fecha o identificador no servidor, impedindo que uma requisição atrasada comece depois.

## E-mails e recuperação

- O cron existente chama a fila Premium separadamente dos avisos de vencimento.
- Mensagens têm chave estável de idempotência, corpo congelado na primeira tentativa, reserva de processamento, repetição limitada e espera crescente.
- Resultado sem confirmação não é reenviado após o prazo de segurança do provedor; fica com falha para conferência.
- O Admin apresenta Vencimentos, Lista de desejos e E-mails Premium em abas distintas.
- Staging atualmente não tem cron configurado. Para testar processamento sem envio real, os testes injetam um provedor simulado. Não ligar envios reais durante uma verificação automatizada.

## Validação manual em staging

1. Aplicar 0090 no banco de staging e publicar somente os projetos de staging.
2. Cadastrar Em breve, inscrever licenças Bronze/Prata/Ouro, verificar Minha conta e contatos autorizados.
3. Remover um interesse; disponibilizar com arquivo; conferir fila para os demais e início correto das janelas dos planos.
4. Ocupar vagas e inscrever sininho; conferir previsão pública e cancelar um aviso antes do processamento.
5. Autorizar Nova tentativa; confirmar que outro cliente continua sem vaga e que o Bronze não perde outra cota.
6. Deixar uma autorização expirar sem uso; conferir datas originais. Testar sucesso, falha anterior à geração e resultado incerto com conferência pelo suporte.
7. Sair da conta durante uma operação e trocar de conta; verificar fechamento da modal e ausência de dados da conta anterior.

Os testes locais usam o esquema completo de migrações, SQLite transacional, provedor de e-mail simulado e serviços/renderer do launcher simulados. Eles não substituem a validação real da Steam e do instalador em staging.
