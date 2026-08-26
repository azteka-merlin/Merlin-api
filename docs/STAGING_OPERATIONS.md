# Operacoes de staging

## Entrega de codigo por e-mail

Staging nao envia codigos de verificacao publica pelo Resend por padrao. A API retorna `deliveryMode: "staging_test"` e aceita o codigo `12345` depois de uma solicitacao de verificacao.

Isso protege a cota do Resend durante testes de planos e acesso. Producao continua enviando um codigo aleatorio de seis digitos pelo Resend.

No Admin de staging, `Cadastro publico` possui o controle `Enviar codigos reais por e-mail`. Quando habilitado, o Resend recebe a solicitacao, mas `12345` continua aceito somente em staging para manter os testes praticos. O controle fica oculto em producao e a API so le essa configuracao quando `ENVIRONMENT=staging`; producao sempre envia um codigo aleatorio.
