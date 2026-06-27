import { OpenAPIRoute } from "chanfana";
import { HTTPException } from "hono/http-exception";
import { verifyAccessToken } from "../lib/auth";
import { getCorrectionVoteTotals, upsertCorrectionVote } from "../lib/correction-votes";
import { type AppContext, CorrectionVoteRequest, CorrectionVoteResponse } from "../types";

type LicenseLookup = {
  id: number;
  hwid: string | null;
  expires_at: string;
  status: "active" | "revoked";
};

function parseBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const [scheme, token] = header.split(" ");
  return scheme === "Bearer" && token ? token : null;
}

async function requireAuthorizedLicense(c: AppContext, accessToken: string) {
  if (!c.env.JWT_SECRET) {
    throw new HTTPException(500, { message: "JWT secret is not configured" });
  }

  const tokenPayload = await verifyAccessToken(accessToken, c.env.JWT_SECRET);
  if (tokenPayload.exp <= Math.floor(Date.now() / 1000)) {
    throw new HTTPException(401, { message: "Access token expired" });
  }

  const license = await c.env.merlin_db
    .prepare(
      `SELECT id, hwid, expires_at, status
       FROM licenses
       WHERE id = ?`,
    )
    .bind(tokenPayload.sub)
    .first<LicenseLookup>();

  if (!license) {
    throw new HTTPException(401, { message: "License not found" });
  }
  if (license.status !== "active") {
    throw new HTTPException(401, { message: "License is not active" });
  }
  if (!license.hwid || license.hwid !== tokenPayload.hwid) {
    throw new HTTPException(401, { message: "HWID mismatch" });
  }

  const expiresAt = new Date(license.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    throw new HTTPException(401, { message: "License expired" });
  }

  return {
    licenseId: license.id,
    hwid: license.hwid,
  };
}

export class FixesVoteRoute extends OpenAPIRoute {
  schema = {
    tags: ["Fixes"],
    summary: "Register or update a community correction vote",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        content: {
          "application/json": {
            schema: CorrectionVoteRequest,
          },
        },
      },
    },
    responses: {
      "200": {
        description: "Vote saved successfully",
        content: {
          "application/json": {
            schema: CorrectionVoteResponse,
          },
        },
      },
      "401": {
        description: "Missing, invalid or expired access token",
      },
    },
  };

  async handle(c: AppContext) {
    const accessToken = parseBearerToken(c.req.raw);
    if (!accessToken) {
      throw new HTTPException(401, { message: "Missing access token" });
    }

    const authorized = await requireAuthorizedLicense(c, accessToken);
    const data = await this.getValidatedData<typeof this.schema>();
    const appId = data.body.appId;
    const vote = data.body.vote;

    await upsertCorrectionVote(c.env, {
      appId,
      licenseId: authorized.licenseId,
      hwid: authorized.hwid,
      vote,
    });

    const totals = await getCorrectionVoteTotals(c.env, appId);
    return c.json(
      {
        success: true,
        appId,
        vote,
        viewerVote: vote,
        upvotes: totals.upvotes,
        downvotes: totals.downvotes,
        score: totals.score,
      },
      200,
    );
  }
}
