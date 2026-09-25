import type { AppContext } from "../types";

type UsageRow = {
  id: number;
  name: string;
  license_key: string;
  plan_tier: string | null;
  source: string | null;
  access_type: string | null;
  billing_status: string | null;
  stripe_subscription_id: string | null;
  billing_cancel_at_period_end: number | null;
  expires_at: string;
  status: string;
  billing_current_period_start: string | null;
  normal_all_time: number | null;
  premium_all_time: number | null;
  normal_week: number | null;
  premium_week: number | null;
  normal_month: number | null;
  premium_month: number | null;
  normal_cycle: number | null;
  premium_cycle: number | null;
  login_all_time: number | null;
};

const realUsageActions = "'game_activation_success', 'premium_activation_success'";

function count(value: number | null) {
  return Number(value || 0);
}

function mapRow(row: UsageRow) {
  const allTime = count(row.normal_all_time) + count(row.premium_all_time);
  const week = count(row.normal_week) + count(row.premium_week);
  const month = count(row.normal_month) + count(row.premium_month);
  const cycle = count(row.normal_cycle) + count(row.premium_cycle);
  const autoRenewingCard = Boolean(
    row.stripe_subscription_id
    && row.billing_status === "active"
    && !row.billing_cancel_at_period_end,
  );

  return {
    licenseId: row.id,
    name: row.name,
    licenseKey: row.license_key,
    tier: row.plan_tier || "ouro",
    source: row.source || "admin",
    accessType: row.access_type || "free",
    billingStatus: row.billing_status || "none",
    autoRenewingCard,
    expiresAt: row.expires_at,
    status: row.status,
    cycleStartedAt: row.billing_current_period_start || null,
    cycleTracked: Boolean(row.billing_current_period_start),
    usage: {
      allTime: { total: allTime, normal: count(row.normal_all_time), premium: count(row.premium_all_time) },
      week: { total: week, normal: count(row.normal_week), premium: count(row.premium_week) },
      month: { total: month, normal: count(row.normal_month), premium: count(row.premium_month) },
      cycle: { total: cycle, normal: count(row.normal_cycle), premium: count(row.premium_cycle) },
    },
    // Intentionally not included in the usage score; it is context only.
    loginsAllTime: count(row.login_all_time),
  };
}

export async function getUsageAnalytics(
  c: AppContext,
  input: { expiryDays?: number; includeAutoRenewing?: boolean } = {},
) {
  const now = new Date();
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const monthStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const expiryDays = Math.min(Math.max(Math.trunc(input.expiryDays || 30), 1), 90);
  const expiryLimit = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000).toISOString();

  const result = await c.env.merlin_db.prepare(`
    SELECT
      l.id, l.name, l.license_key, l.plan_tier, l.source,
      l.access_type, l.billing_status, l.stripe_subscription_id,
      l.billing_cancel_at_period_end, l.expires_at, l.status,
      l.billing_current_period_start,
      SUM(CASE WHEN u.action = 'game_activation_success' THEN 1 ELSE 0 END) AS normal_all_time,
      SUM(CASE WHEN u.action = 'premium_activation_success' THEN 1 ELSE 0 END) AS premium_all_time,
      SUM(CASE WHEN u.action = 'game_activation_success' AND u.created_at >= ? THEN 1 ELSE 0 END) AS normal_week,
      SUM(CASE WHEN u.action = 'premium_activation_success' AND u.created_at >= ? THEN 1 ELSE 0 END) AS premium_week,
      SUM(CASE WHEN u.action = 'game_activation_success' AND u.created_at >= ? THEN 1 ELSE 0 END) AS normal_month,
      SUM(CASE WHEN u.action = 'premium_activation_success' AND u.created_at >= ? THEN 1 ELSE 0 END) AS premium_month,
      SUM(CASE WHEN l.billing_current_period_start IS NOT NULL AND u.action = 'game_activation_success' AND u.created_at >= l.billing_current_period_start THEN 1 ELSE 0 END) AS normal_cycle,
      SUM(CASE WHEN l.billing_current_period_start IS NOT NULL AND u.action = 'premium_activation_success' AND u.created_at >= l.billing_current_period_start THEN 1 ELSE 0 END) AS premium_cycle,
      SUM(CASE WHEN u.action = 'user_login_success' THEN 1 ELSE 0 END) AS login_all_time
    FROM licenses l
    LEFT JOIN user_activity_logs u
      ON u.license_id = l.id
      AND u.status = 'success'
      AND u.action IN (${realUsageActions}, 'user_login_success')
    WHERE COALESCE(l.license_type, 'normal') <> 'test'
    GROUP BY l.id
    ORDER BY normal_month + premium_month DESC, normal_cycle + premium_cycle DESC,
      normal_all_time + premium_all_time DESC, l.id DESC
  `).bind(weekStart, weekStart, monthStart, monthStart).all<UsageRow>();

  const users = result.results.map(mapRow);
  const expiringUsers = users
    .filter((user) => user.status !== "revoked" && user.expiresAt > now.toISOString() && user.expiresAt <= expiryLimit)
    .filter((user) => input.includeAutoRenewing || !user.autoRenewingCard)
    .sort((left, right) => right.usage.month.total - left.usage.month.total || right.usage.allTime.total - left.usage.allTime.total);

  const sum = (period: "allTime" | "week" | "month" | "cycle", kind: "total" | "normal" | "premium") =>
    users.reduce((total, user) => total + user.usage[period][kind], 0);

  return {
    generatedAt: now.toISOString(),
    expiryDays,
    excludesAutoRenewing: !input.includeAutoRenewing,
    summary: {
      licenses: users.length,
      usersWithRealUsage: users.filter((user) => user.usage.allTime.total > 0).length,
      cycleTrackedLicenses: users.filter((user) => user.cycleTracked).length,
      week: { total: sum("week", "total"), normal: sum("week", "normal"), premium: sum("week", "premium") },
      month: { total: sum("month", "total"), normal: sum("month", "normal"), premium: sum("month", "premium") },
      cycle: { total: sum("cycle", "total"), normal: sum("cycle", "normal"), premium: sum("cycle", "premium") },
    },
    users,
    expiringUsers,
  };
}
