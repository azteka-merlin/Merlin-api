import { OpenAPIRoute } from "chanfana";
import { mapLicenseResponse, requireAdminToken } from "../lib/licenses";
import { enforceAdminRateLimit } from "../lib/rate-limit";
import type { AppContext } from "../types";
import { LicenseListResponse } from "../types";

export class AdminListLicensesRoute extends OpenAPIRoute {
	schema = {
		tags: ["Admin"],
		summary: "List all licenses",
		security: [
			{
				bearerAuth: [],
			},
		],
		responses: {
			"200": {
				description: "Returns all licenses",
				content: {
					"application/json": {
						schema: LicenseListResponse,
					},
				},
			},
			"401": {
				description: "Missing or invalid admin token",
			},
			"429": {
				description: "Too many administrative requests",
			},
		},
	};

	async handle(c: AppContext) {
		const adminKey = requireAdminToken(c);
		await enforceAdminRateLimit(c, adminKey);

		const result = await c.env.merlin_db
			.prepare(
				`
					SELECT
						id,
						license_key,
						name,
						contact,
						contact_type,
						source,
						recovery_pin_hash,
						recovery_notice_accepted_at,
						hwid,
						expires_at,
						status,
						revoked_reason,
						revoked_origin,
						revoked_event_id,
						customer_id,
						COALESCE(access_type, 'free') AS access_type,
						COALESCE(billing_status, 'none') AS billing_status,
						stripe_customer_id,
						stripe_subscription_id,
						stripe_checkout_session_id,
						billing_current_period_end,
						billing_cancel_at_period_end,
						created_at,
						updated_at
					FROM licenses
					ORDER BY id DESC
				`,
			)
			.all<{
				id: number;
				license_key: string;
				name: string;
				contact: string;
				contact_type: "phone" | "email" | "discord";
				source: "admin" | "public_signup" | "purchase" | "gift" | "manual_import" | "stripe";
				recovery_pin_hash: string | null;
				recovery_notice_accepted_at: string | null;
				hwid: string | null;
				expires_at: string;
				status: "active" | "revoked";
				revoked_reason: string | null;
				revoked_origin: string | null;
				revoked_event_id: string | null;
				customer_id: number | null;
				access_type: string | null;
				billing_status: string | null;
				stripe_customer_id: string | null;
				stripe_subscription_id: string | null;
				stripe_checkout_session_id: string | null;
				billing_current_period_end: string | null;
				billing_cancel_at_period_end: number | null;
				created_at: string;
				updated_at: string;
			}>();

		return c.json(
			{
				licenses: result.results.map(mapLicenseResponse),
			},
			200,
		);
	}
}
