# Filtro de correções Online

O catálogo de Correções exclui arquivos cuja lista `badges` contenha `Online`,
ignorando maiúsculas, minúsculas e espaços nas extremidades. A exclusão de
`Hypervisor` permanece ativa.

O filtro é por arquivo: quando um jogo possui outro fix elegível, esse fix
permanece na lista. Jogos que só possuem arquivos excluídos deixam de aparecer.
Uploads manuais sem essa classificação mantêm o comportamento existente.

A seleção usada pelo proxy Ryuu segue a mesma regra para não servir o arquivo
Online quando o catálogo escolheu outro arquivo para o mesmo AppID.

Os avisos de correção ao adicionar um jogo usam o catálogo filtrado. Clientes
com uma cópia antiga precisam usar **Atualizar lista** na aba Correções após a
publicação da API. Esta mudança não exige alterar o contrato JSON ou o banco.

## Regressão

```powershell
npx vitest run tests/fixes-online-filter.test.ts tests/fixes-catalog-order.test.ts
```

Cobertura: jogos somente Online, variações da marca, alternativa elegível no
mesmo jogo, seleção coerente no download, exclusão anterior de Hypervisor e
preservação de correções sem marcas.
