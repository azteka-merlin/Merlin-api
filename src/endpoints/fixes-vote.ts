import { OpenAPIRoute } from "chanfana";
import { HTTPException } from "hono/http-exception";
import { getCorrectionVoteTotals, upsertCorrectionVote } from "../lib/correction-votes";
import { requireLauncherLicense } from "../lib/launcher-auth";
import { type AppContext, CorrectionVoteRequest, CorrectionVoteResponse } from "../types";

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
    const license = await requireLauncherLicense(c);
    const data = await this.getValidatedData<typeof this.schema>();
    const appId = data.body.appId;
    const vote = data.body.vote;

    await upsertCorrectionVote(c.env, {
      appId,
      licenseId: license.id,
      hwid: license.hwid,
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
