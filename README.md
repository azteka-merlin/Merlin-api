# Merlin API

Minimal Cloudflare Workers backend for the Merlin project, built with [chanfana](https://github.com/cloudflare/chanfana) and [Hono](https://github.com/honojs/hono).

This Worker currently exposes a small proof of concept surface:

- `GET /` OpenAPI / Swagger UI
- `GET /api/health`
- `GET /api/version`
- `GET /api/manifests?appid=...`
- `POST /api/auth/login`

## Get started

1. Sign up for [Cloudflare Workers](https://workers.dev). The free tier is more than enough for most use cases.
2. Clone this project and install dependencies with `npm install`
3. Run `wrangler login` to login to your Cloudflare account in wrangler
4. Run `wrangler deploy` to publish the API to Cloudflare Workers

## Project structure

1. Your main router is defined in `src/index.ts`.
2. System and auth endpoints live in `src/endpoints/`.
3. For more information read the [chanfana documentation](https://chanfana.pages.dev/) and [Hono documentation](https://hono.dev/docs).

## Development

1. Run `wrangler dev` to start a local instance of the API.
2. Open `http://localhost:8787/` in your browser to see the Swagger interface where you can try the endpoints.
3. Changes made in the `src/` folder will automatically trigger the server to reload, you only need to refresh the Swagger interface.
