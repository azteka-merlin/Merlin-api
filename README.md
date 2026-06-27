# Merlin API

Backend do Merlin em Cloudflare Workers + D1, servindo tanto a API publica quanto o painel administrativo.

## Superficie atual

- `GET /doc` Swagger / OpenAPI
- `GET /api/health`
- `GET /api/version`
- `GET /api/manifests?appid=...`
- `POST /api/auth/login`
- `POST /panel-api/auth/login`
- `GET /panel-api/auth/session`
- `POST /panel-api/auth/logout`
- `GET /panel-api/licenses`
- `POST /panel-api/licenses`
- `GET /panel-api/licenses/:id`
- `PUT /panel-api/licenses/:id`
- `POST /panel-api/licenses/:id/renew`
- `POST /panel-api/licenses/:id/revoke`
- `POST /panel-api/licenses/:id/reset-hwid`

## Arquitetura

- `api-merlin.com` abre o painel admin / login
- `api-merlin.com/api/*` continua atendendo a API publica existente
- `api-merlin.com/doc` expoe o Swagger
- o frontend compilado do `merlin-admin` e servido como asset pelo mesmo Worker da API
- o token administrativo real continua server-side

## Estrutura

- `src/index.ts`: router principal, painel, auth admin e API publica
- `src/lib/admin-security.ts`: hash de senha, sessoes, CSRF e auditoria admin
- `src/lib/admin-license-service.ts`: operacoes administrativas de licenca
- `migrations/0002_admin_auth.sql`: tabelas admin no D1
- `scripts/bootstrap-admin.mjs`: gera o SQL do primeiro admin com hash seguro

## Desenvolvimento local

1. Instale dependencias da API: `npm install`
2. Instale dependencias do front em `../merlin-admin`: `npm install`
3. Gere os tipos do Worker: `npx wrangler types`
4. Rode a API: `npx wrangler dev`
5. Acesse `http://localhost:8787/login`
6. Para Swagger, use `http://localhost:8787/doc`

## Bootstrap do primeiro admin

1. Gere o SQL do primeiro admin:
   `npm run admin:bootstrap`
2. Informe `username` e `senha`
3. O script vai imprimir um comando pronto de `wrangler d1 execute` para inserir esse admin no banco remoto

Observacoes:

- a senha nunca e salva em texto puro
- o hash segue o mesmo formato PBKDF2 usado pelo Worker
- o script so gera o SQL; ele nao grava nada sozinho no banco

## Ordem recomendada para deploy

1. Build do front:
   `cd ../merlin-admin && npm run build`
2. Volte para a API:
   `cd ../merlin-api`
3. Gere os tipos do Worker:
   `npx wrangler types`
4. Aplique migrations no D1 remoto:
   `npx wrangler d1 migrations apply merlin-db --remote`
5. Configure secrets obrigatorios:
   `npx wrangler secret put RYUU_AUTH_CODE`
   `npx wrangler secret put HUBCAP_TOKEN`
   `npx wrangler secret put JWT_SECRET`
   `npx wrangler secret put SESSION_HASH_SECRET`
6. Gere o primeiro admin:
   `npm run admin:bootstrap`
7. Execute no terminal o comando de `wrangler d1 execute` que o script imprimir
8. Faça o deploy do Worker:
   `npx wrangler deploy`

## Validacao pos-deploy

- `https://api-merlin.com/login` deve abrir a tela de login
- `https://api-merlin.com/doc` deve abrir o Swagger
- `https://api-merlin.com/api/health` deve seguir respondendo normalmente
- sem sessao valida, `https://api-merlin.com/licenses` deve redirecionar para `/login`
- apos login, o painel deve carregar licencas reais por `/panel-api/*`

## Notas de seguranca

- painel servido apenas por sessao administrativa com cookie HttpOnly + CSRF
- o cookie `merlin_admin_session` e `HttpOnly`, `Secure` e `SameSite=Strict`
- rotas mutaveis do painel exigem sessao valida e CSRF token
- falhas de login sao auditadas e participam de lock por usuario e bloqueio por IP
