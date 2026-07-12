import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";

type PollType = "basic" | "game_request";
type PollStatus = "draft" | "open" | "closed";

type PollRow = {
  id: number;
  type: PollType;
  question: string;
  status: PollStatus;
  currency_code: string;
  sort_order: number;
  opened_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
};

type PollOptionRow = {
  id: number;
  poll_id: number;
  label: string;
  game_app_id: string | null;
  sort_order: number;
};

type PollContributionOptionRow = {
  id: number;
  poll_id: number;
  label: string;
  min_amount: number | null;
  max_amount: number | null;
  sort_order: number;
};

type PollVoteRow = {
  id: number;
  poll_id: number;
  license_id: number;
  option_id: number;
  contribution_option_id: number | null;
  contribution_skipped: number;
  created_at: string;
  updated_at: string;
};

type VoteCountRow = {
  id: number;
  count: number;
};

type ContributionVoteCountRow = {
  option_id: number;
  contribution_option_id: number | null;
  contribution_skipped: number;
  count: number;
};

export type PollInput = {
  type: PollType;
  question: string;
  status?: PollStatus;
  currencyCode?: string | null;
  options: Array<{
    label: string;
    gameAppId?: string | null;
  }>;
  contributionOptions?: Array<{
    label: string;
    minAmount?: number | null;
    maxAmount?: number | null;
  }> | null;
};

export type PollVoteInput = {
  optionId?: number | null;
  contributionOptionId?: number | null;
  contributionSkipped?: boolean | null;
};

function normalizePollId(value: string | number): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HTTPException(400, { message: "Invalid poll id" });
  }
  return id;
}

function normalizeText(value: string, field: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new HTTPException(400, { message: `Invalid ${field}` });
  }
  return normalized;
}

function normalizeCurrencyCode(value?: string | null): string {
  const normalized = String(value || "BRL").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new HTTPException(400, { message: "Invalid currency code" });
  }
  return normalized;
}

function normalizeOptions(input: PollInput["options"]): PollInput["options"] {
  const options = (input || [])
    .map((option) => ({
      label: normalizeText(option.label, "option label"),
      gameAppId: option.gameAppId ? String(option.gameAppId).trim() : null,
    }))
    .filter((option) => option.label);

  if (options.length < 2 || options.length > 3) {
    throw new HTTPException(400, { message: "Polls must have 2 or 3 options" });
  }

  return options;
}

function normalizeContributionOptions(type: PollType, input?: PollInput["contributionOptions"]): NonNullable<PollInput["contributionOptions"]> {
  if (type !== "game_request") {
    return [];
  }

  const options = (input || [])
    .map((option) => ({
      label: normalizeText(option.label, "contribution option label"),
      minAmount: option.minAmount === null || option.minAmount === undefined ? null : Math.max(0, Math.trunc(Number(option.minAmount))),
      maxAmount: option.maxAmount === null || option.maxAmount === undefined ? null : Math.max(0, Math.trunc(Number(option.maxAmount))),
    }));

  if (options.length < 2 || options.length > 4) {
    throw new HTTPException(400, { message: "Game request polls must have 2 to 4 contribution options" });
  }

  return options;
}

function percent(count: number, total: number): number {
  if (!total) return 0;
  return Math.round((count / total) * 100);
}

async function loadPollBundle(c: AppContext, pollIds: number[], licenseId?: number | null) {
  if (!pollIds.length) {
    return [];
  }

  const placeholders = pollIds.map(() => "?").join(", ");
  const [optionRows, contributionRows, voteCountRows, contributionVoteRows] = await Promise.all([
    c.env.merlin_db
      .prepare(`
        SELECT id, poll_id, label, game_app_id, sort_order
        FROM poll_options
        WHERE poll_id IN (${placeholders})
        ORDER BY sort_order ASC, id ASC
      `)
      .bind(...pollIds)
      .all<PollOptionRow>(),
    c.env.merlin_db
      .prepare(`
        SELECT id, poll_id, label, min_amount, max_amount, sort_order
        FROM poll_contribution_options
        WHERE poll_id IN (${placeholders})
        ORDER BY sort_order ASC, id ASC
      `)
      .bind(...pollIds)
      .all<PollContributionOptionRow>(),
    c.env.merlin_db
      .prepare(`
        SELECT option_id AS id, COUNT(*) AS count
        FROM poll_votes
        WHERE poll_id IN (${placeholders})
        GROUP BY option_id
      `)
      .bind(...pollIds)
      .all<VoteCountRow>(),
    c.env.merlin_db
      .prepare(`
        SELECT option_id, contribution_option_id, contribution_skipped, COUNT(*) AS count
        FROM poll_votes
        WHERE poll_id IN (${placeholders})
          AND (contribution_option_id IS NOT NULL OR contribution_skipped = 1)
        GROUP BY option_id, contribution_option_id, contribution_skipped
      `)
      .bind(...pollIds)
      .all<ContributionVoteCountRow>(),
  ]);

  const viewerRows = licenseId
    ? await c.env.merlin_db
      .prepare(`
        SELECT id, poll_id, license_id, option_id, contribution_option_id, contribution_skipped, created_at, updated_at
        FROM poll_votes
        WHERE poll_id IN (${placeholders})
          AND license_id = ?
      `)
      .bind(...pollIds, licenseId)
      .all<PollVoteRow>()
    : { results: [] as PollVoteRow[] };

  return [{
    options: optionRows.results || [],
    contributionOptions: contributionRows.results || [],
    voteCounts: voteCountRows.results || [],
    contributionVoteCounts: contributionVoteRows.results || [],
    viewerVotes: viewerRows.results || [],
  }];
}

async function mapPolls(c: AppContext, rows: PollRow[], licenseId?: number | null) {
  const bundle = (await loadPollBundle(c, rows.map((row) => row.id), licenseId))[0] || {
    options: [],
    contributionOptions: [],
    voteCounts: [],
    contributionVoteCounts: [],
    viewerVotes: [],
  };

  const voteCounts = new Map(bundle.voteCounts.map((row) => [Number(row.id), Number(row.count || 0)]));
  const viewerVotes = new Map(bundle.viewerVotes.map((row) => [row.poll_id, row]));

  return rows.map((row) => {
    const options = bundle.options.filter((option) => option.poll_id === row.id);
    const contributionOptions = bundle.contributionOptions.filter((option) => option.poll_id === row.id);
    const viewerVote = viewerVotes.get(row.id) || null;
    const totalVotes = options.reduce((sum, option) => sum + (voteCounts.get(option.id) || 0), 0);

    const contributionTotalsByOption = new Map<number, number>();
    for (const contributionRow of bundle.contributionVoteCounts) {
      if (contributionRow.contribution_skipped || !contributionRow.contribution_option_id) {
        continue;
      }
      contributionTotalsByOption.set(
        contributionRow.option_id,
        (contributionTotalsByOption.get(contributionRow.option_id) || 0) + Number(contributionRow.count || 0)
      );
    }

    const contributionResultsByOptionId: Record<string, Array<{
      id: number | null;
      label: string;
      minAmount: number | null;
      maxAmount: number | null;
      votes: number;
      percent: number;
      selected: boolean;
      skipped: boolean;
    }>> = {};

    for (const option of options) {
      const contributionTotal = contributionTotalsByOption.get(option.id) || 0;
      contributionResultsByOptionId[String(option.id)] = contributionOptions
        .map((contributionOption) => {
          const count = bundle.contributionVoteCounts
            .filter((countRow) =>
              countRow.option_id === option.id
              && countRow.contribution_option_id === contributionOption.id
              && !countRow.contribution_skipped
            )
            .reduce((sum, countRow) => sum + Number(countRow.count || 0), 0);

          return {
            id: contributionOption.id,
            label: contributionOption.label,
            minAmount: contributionOption.min_amount,
            maxAmount: contributionOption.max_amount,
            votes: count,
            percent: percent(count, contributionTotal),
            selected: Boolean(viewerVote?.contribution_option_id === contributionOption.id),
            skipped: false,
          };
        })
        .map((entry) => ({
          ...entry,
          percent: percent(entry.votes, contributionTotal),
        }));
    }

    return {
      id: row.id,
      type: row.type,
      question: row.question,
      status: row.status,
      currencyCode: row.currency_code,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      totalVotes,
      options: options.map((option) => {
        const votes = voteCounts.get(option.id) || 0;
        return {
          id: option.id,
          label: option.label,
          gameAppId: option.game_app_id,
          votes,
          percent: percent(votes, totalVotes),
          selected: Boolean(viewerVote?.option_id === option.id),
        };
      }),
      contributionOptions: contributionOptions.map((option) => ({
        id: option.id,
        label: option.label,
        minAmount: option.min_amount,
        maxAmount: option.max_amount,
      })),
      contributionResultsByOptionId,
      viewer: {
        voted: Boolean(viewerVote),
        optionId: viewerVote?.option_id || null,
        contributionOptionId: viewerVote?.contribution_option_id || null,
        contributionSkipped: Boolean(viewerVote?.contribution_skipped),
        votedAt: viewerVote?.created_at || null,
      },
    };
  });
}

export async function listPolls(c: AppContext) {
  const rows = await c.env.merlin_db
    .prepare(`
      SELECT id, type, question, status, currency_code, sort_order, opened_at, closed_at, created_at, updated_at
      FROM polls
      ORDER BY status = 'open' DESC, updated_at DESC, id DESC
    `)
    .all<PollRow>();

  return mapPolls(c, rows.results || [], null);
}

export async function listActivePolls(c: AppContext, licenseId: number) {
  const rows = await c.env.merlin_db
    .prepare(`
      SELECT id, type, question, status, currency_code, sort_order, opened_at, closed_at, created_at, updated_at
      FROM polls
      WHERE status = 'open'
      ORDER BY sort_order DESC, opened_at DESC, id DESC
      LIMIT 3
    `)
    .all<PollRow>();

  return mapPolls(c, rows.results || [], licenseId);
}

export async function createPoll(c: AppContext, input: PollInput) {
  const type = input.type === "game_request" ? "game_request" : "basic";
  const question = normalizeText(input.question, "question");
  const currencyCode = normalizeCurrencyCode(input.currencyCode);
  const options = normalizeOptions(input.options);
  const contributionOptions = normalizeContributionOptions(type, input.contributionOptions);
  const nowIso = new Date().toISOString();
  const status = input.status === "open" || input.status === "closed" ? input.status : "draft";

  const result = await c.env.merlin_db
    .prepare(`
      INSERT INTO polls (type, question, status, currency_code, opened_at, closed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      type,
      question,
      status,
      currencyCode,
      status === "open" ? nowIso : null,
      status === "closed" ? nowIso : null,
      nowIso,
      nowIso
    )
    .run();

  const pollId = Number(result.meta.last_row_id || 0);
  if (!pollId) {
    throw new HTTPException(500, { message: "Could not create poll" });
  }

  await insertPollOptions(c, pollId, options, contributionOptions);
  return getPoll(c, pollId);
}

async function insertPollOptions(
  c: AppContext,
  pollId: number,
  options: PollInput["options"],
  contributionOptions: NonNullable<PollInput["contributionOptions"]>
) {
  await c.env.merlin_db.batch([
    ...options.map((option, index) =>
      c.env.merlin_db
        .prepare("INSERT INTO poll_options (poll_id, label, game_app_id, sort_order) VALUES (?, ?, ?, ?)")
        .bind(pollId, option.label, option.gameAppId || null, index)
    ),
    ...contributionOptions.map((option, index) =>
      c.env.merlin_db
        .prepare("INSERT INTO poll_contribution_options (poll_id, label, min_amount, max_amount, sort_order) VALUES (?, ?, ?, ?, ?)")
        .bind(pollId, option.label, option.minAmount ?? null, option.maxAmount ?? null, index)
    ),
  ]);
}

export async function getPoll(c: AppContext, value: string | number, licenseId?: number | null) {
  const pollId = normalizePollId(value);
  const row = await c.env.merlin_db
    .prepare(`
      SELECT id, type, question, status, currency_code, sort_order, opened_at, closed_at, created_at, updated_at
      FROM polls
      WHERE id = ?
      LIMIT 1
    `)
    .bind(pollId)
    .first<PollRow>();

  if (!row) {
    throw new HTTPException(404, { message: "Poll not found" });
  }

  const mapped = (await mapPolls(c, [row], licenseId))[0];
  if (!mapped) {
    throw new HTTPException(404, { message: "Poll not found" });
  }
  return mapped;
}

export async function updatePoll(c: AppContext, value: string | number, input: PollInput) {
  const pollId = normalizePollId(value);
  const existing = await getPoll(c, pollId);
  if (existing.totalVotes > 0) {
    throw new HTTPException(409, { message: "Poll with votes cannot be edited" });
  }

  const type = input.type === "game_request" ? "game_request" : "basic";
  const question = normalizeText(input.question, "question");
  const currencyCode = normalizeCurrencyCode(input.currencyCode);
  const options = normalizeOptions(input.options);
  const contributionOptions = normalizeContributionOptions(type, input.contributionOptions);
  const nowIso = new Date().toISOString();

  await c.env.merlin_db.batch([
    c.env.merlin_db
      .prepare("UPDATE polls SET type = ?, question = ?, currency_code = ?, updated_at = ? WHERE id = ?")
      .bind(type, question, currencyCode, nowIso, pollId),
    c.env.merlin_db.prepare("DELETE FROM poll_options WHERE poll_id = ?").bind(pollId),
    c.env.merlin_db.prepare("DELETE FROM poll_contribution_options WHERE poll_id = ?").bind(pollId),
  ]);

  await insertPollOptions(c, pollId, options, contributionOptions);
  return getPoll(c, pollId);
}

export async function setPollStatus(c: AppContext, value: string | number, status: PollStatus) {
  const pollId = normalizePollId(value);
  const nowIso = new Date().toISOString();
  const openedAtSql = status === "open" ? ", opened_at = COALESCE(opened_at, ?)" : "";
  const closedAtSql = status === "closed" ? ", closed_at = ?" : "";
  const binds = status === "open"
    ? [status, nowIso, nowIso, pollId]
    : status === "closed"
      ? [status, nowIso, nowIso, pollId]
      : [status, nowIso, pollId];

  await c.env.merlin_db
    .prepare(`UPDATE polls SET status = ?, updated_at = ?${openedAtSql}${closedAtSql} WHERE id = ?`)
    .bind(...binds)
    .run();

  return getPoll(c, pollId);
}

export async function deletePoll(c: AppContext, value: string | number) {
  const pollId = normalizePollId(value);
  await c.env.merlin_db.prepare("DELETE FROM polls WHERE id = ?").bind(pollId).run();
  return { success: true, id: pollId };
}

export async function votePoll(c: AppContext, value: string | number, licenseId: number, input: PollVoteInput) {
  const pollId = normalizePollId(value);
  const poll = await getPoll(c, pollId, licenseId);
  if (poll.status !== "open") {
    throw new HTTPException(409, { message: "Poll is not open" });
  }

  const optionId = input.optionId ? Number(input.optionId) : null;
  const contributionOptionId = input.contributionOptionId ? Number(input.contributionOptionId) : null;
  const contributionSkipped = input.contributionSkipped === true;
  const existing = await c.env.merlin_db
    .prepare(`
      SELECT id, poll_id, license_id, option_id, contribution_option_id, contribution_skipped, created_at, updated_at
      FROM poll_votes
      WHERE poll_id = ? AND license_id = ?
      LIMIT 1
    `)
    .bind(pollId, licenseId)
    .first<PollVoteRow>();

  const validOption = optionId ? poll.options.find((option) => option.id === optionId) : null;
  const validContributionOption = contributionOptionId
    ? poll.contributionOptions.find((option) => option.id === contributionOptionId)
    : null;

  if (!existing) {
    if (!validOption) {
      throw new HTTPException(400, { message: "Invalid poll option" });
    }
    if (contributionOptionId && !validContributionOption) {
      throw new HTTPException(400, { message: "Invalid contribution option" });
    }

    const nowIso = new Date().toISOString();
    await c.env.merlin_db
      .prepare(`
        INSERT INTO poll_votes (
          poll_id,
          license_id,
          option_id,
          contribution_option_id,
          contribution_skipped,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        pollId,
        licenseId,
        validOption.id,
        contributionOptionId || null,
        contributionSkipped ? 1 : 0,
        nowIso,
        nowIso
      )
      .run();
    return getPoll(c, pollId, licenseId);
  }

  if (optionId && optionId !== existing.option_id) {
    throw new HTTPException(409, { message: "Poll vote cannot be changed" });
  }

  if (poll.type !== "game_request" || existing.contribution_option_id || existing.contribution_skipped) {
    return getPoll(c, pollId, licenseId);
  }

  if (!contributionOptionId && !contributionSkipped) {
    return getPoll(c, pollId, licenseId);
  }

  if (contributionOptionId && !validContributionOption) {
    throw new HTTPException(400, { message: "Invalid contribution option" });
  }

  await c.env.merlin_db
    .prepare(`
      UPDATE poll_votes
      SET contribution_option_id = ?, contribution_skipped = ?, updated_at = ?
      WHERE id = ?
    `)
    .bind(contributionOptionId || null, contributionSkipped ? 1 : 0, new Date().toISOString(), existing.id)
    .run();

  return getPoll(c, pollId, licenseId);
}
