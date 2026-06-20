import { fromHono } from "chanfana";
import { Hono } from "hono";
import { AdminCreateLicenseRoute } from "./endpoints/admin-create-license";
import { AdminGetLicenseRoute } from "./endpoints/admin-get-license";
import { AdminListLicensesRoute } from "./endpoints/admin-list-licenses";
import { AdminRenewLicenseRoute } from "./endpoints/admin-renew-license";
import { AdminResetHwidRoute } from "./endpoints/admin-reset-hwid";
import { AdminRevokeLicenseRoute } from "./endpoints/admin-revoke-license";
import { HealthRoute } from "./endpoints/health";
import { ManifestsRoute } from "./endpoints/manifests";
import { LoginRoute } from "./endpoints/login";
import { VersionRoute } from "./endpoints/version";

// Start a Hono app
const app = new Hono<{ Bindings: Env }>();

// Setup OpenAPI registry
const openapi = fromHono(app, {
	docs_url: "/",
	schema: {
		info: {
			title: "Merlin API",
			version: "1.0.0",
		},
	},
});

openapi.registry.registerComponent("securitySchemes", "bearerAuth", {
	type: "http",
	scheme: "bearer",
	bearerFormat: "API Token",
});

// Register OpenAPI endpoints
openapi.get("/api/health", HealthRoute);
openapi.get("/api/version", VersionRoute);
openapi.get("/api/manifests", ManifestsRoute);
openapi.post("/api/auth/login", LoginRoute);
openapi.get("/api/admin/licenses", AdminListLicensesRoute);
openapi.post("/api/admin/licenses", AdminCreateLicenseRoute);
openapi.get("/api/admin/licenses/:id", AdminGetLicenseRoute);
openapi.post("/api/admin/licenses/:id/renew", AdminRenewLicenseRoute);
openapi.post("/api/admin/licenses/:id/revoke", AdminRevokeLicenseRoute);
openapi.post("/api/admin/licenses/:id/reset-hwid", AdminResetHwidRoute);

// You may also register routes for non OpenAPI directly on Hono
// app.get('/test', (c) => c.text('Hono!'))

// Export the Hono app
export default app;
