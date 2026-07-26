import { OpenAPIRoute } from "chanfana";
import {
	type AppContext,
	PublicEmailVerificationStartRequest,
	PublicEmailVerificationStartResponse,
	PublicEmailVerificationVerifyRequest,
	PublicEmailVerificationVerifyResponse,
} from "../types";
import { enforcePublicEmailVerificationRateLimit } from "../lib/rate-limit";
import { startPublicEmailVerification, verifyPublicEmailCode } from "../lib/email-verification";

export class PublicEmailVerificationStartRoute extends OpenAPIRoute {
	schema = {
		tags: ["Public"],
		summary: "Send a public signup email verification code",
		request: {
			body: {
				content: {
					"application/json": {
						schema: PublicEmailVerificationStartRequest,
						example: {
							email: "usuario@email.com",
						},
					},
				},
			},
		},
		responses: {
			"200": {
				description: "Verification code sent",
				content: {
					"application/json": {
						schema: PublicEmailVerificationStartResponse,
						example: {
							success: true,
							cooldownSeconds: 60,
							expiresIn: 600,
						},
					},
				},
			},
			"429": {
				description: "Temporary email verification rate limit reached",
			},
			"502": {
				description: "Email provider could not send the message",
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		await enforcePublicEmailVerificationRateLimit(c, data.body.email);
		return startPublicEmailVerification(c, data.body.email);
	}
}

export class PublicEmailVerificationVerifyRoute extends OpenAPIRoute {
	schema = {
		tags: ["Public"],
		summary: "Verify a public signup email code",
		request: {
			body: {
				content: {
					"application/json": {
						schema: PublicEmailVerificationVerifyRequest,
						example: {
							email: "usuario@email.com",
							code: "123456",
						},
					},
				},
			},
		},
		responses: {
			"200": {
				description: "Email verified",
				content: {
					"application/json": {
						schema: PublicEmailVerificationVerifyResponse,
						example: {
							success: true,
							verified: true,
						},
					},
				},
			},
			"400": {
				description: "Invalid or expired verification code",
			},
			"429": {
				description: "Temporary verification attempt limit reached",
			},
		},
	};

	async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		return verifyPublicEmailCode(c, data.body);
	}
}
