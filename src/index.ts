import { fromHono } from "chanfana";
import { Hono } from "hono";
import { AdminCreateLicenseRoute } from "./endpoints/admin-create-license";
import { AdminDeleteOverrideRoute } from "./endpoints/admin-delete-override";
import { AdminGetLicenseRoute } from "./endpoints/admin-get-license";
import { AdminListLicensesRoute } from "./endpoints/admin-list-licenses";
import { AdminListOverridesRoute } from "./endpoints/admin-list-overrides";
import { AdminRenewLicenseRoute } from "./endpoints/admin-renew-license";
import { AdminResetHwidRoute } from "./endpoints/admin-reset-hwid";
import { AdminRevokeLicenseRoute } from "./endpoints/admin-revoke-license";
import { AdminUpsertOverrideRoute } from "./endpoints/admin-upsert-override";
import { FixesCatalogRoute } from "./endpoints/fixes-catalog";
import { FixesDownloadRoute } from "./endpoints/fixes-download";
import { HealthRoute } from "./endpoints/health";
import { ManifestsRoute } from "./endpoints/manifests";
import { LoginRoute } from "./endpoints/login";
import { VersionRoute } from "./endpoints/version";

const app = new Hono<{ Bindings: Env }>();

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

openapi.get("/api/health", HealthRoute);
openapi.get("/api/version", VersionRoute);
openapi.get("/api/manifests", ManifestsRoute);
openapi.get("/api/fixes/catalog", FixesCatalogRoute);
openapi.get("/api/fixes/download", FixesDownloadRoute);
openapi.post("/api/auth/login", LoginRoute);
openapi.get("/api/admin/licenses", AdminListLicensesRoute);
openapi.post("/api/admin/licenses", AdminCreateLicenseRoute);
openapi.get("/api/admin/licenses/:id", AdminGetLicenseRoute);
openapi.post("/api/admin/licenses/:id/renew", AdminRenewLicenseRoute);
openapi.post("/api/admin/licenses/:id/revoke", AdminRevokeLicenseRoute);
openapi.post("/api/admin/licenses/:id/reset-hwid", AdminResetHwidRoute);
openapi.get("/api/admin/overrides", AdminListOverridesRoute);
openapi.post("/api/admin/overrides", AdminUpsertOverrideRoute);
openapi.delete("/api/admin/overrides/:appId", AdminDeleteOverrideRoute);

export default app;
