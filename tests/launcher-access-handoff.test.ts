import { describe, expect, test } from "vitest";
import {
  consumeLauncherAccessHandoff,
  createLauncherAccessHandoff,
} from "../src/lib/public-access-session";

type HandoffRow = {
  id: string;
  license_id: number;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
};

class FakeStatement {
  private values: unknown[] = [];

  constructor(private readonly db: FakeD1Database, private readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  first<T>() {
    return Promise.resolve(this.db.first(this.sql, this.values) as T | null);
  }

  run() {
    return Promise.resolve({ meta: { changes: this.db.run(this.sql, this.values) } });
  }
}

class FakeD1Database {
  handoffs: HandoffRow[] = [];
  sessions: Array<Record<string, unknown>> = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  first(sql: string, values: unknown[]) {
    if (sql.includes("FROM launcher_access_handoffs")) {
      return this.handoffs.find(
        (row) => row.token_hash === String(values[0]) && row.consumed_at === null,
      ) || null;
    }
    return null;
  }

  run(sql: string, values: unknown[]) {
    if (sql.includes("INSERT INTO launcher_access_handoffs")) {
      this.handoffs.push({
        id: String(values[0]),
        license_id: Number(values[1]),
        token_hash: String(values[2]),
        expires_at: String(values[4]),
        consumed_at: null,
      });
      return 1;
    }
    if (sql.includes("UPDATE launcher_access_handoffs")) {
      const row = this.handoffs.find(
        (candidate) => candidate.id === String(values[1]) && candidate.consumed_at === null,
      );
      if (!row) return 0;
      row.consumed_at = String(values[0]);
      return 1;
    }
    if (sql.includes("INSERT INTO public_access_sessions")) {
      this.sessions.push({ id: values[0], license_id: values[1] });
      return 1;
    }
    return 0;
  }
}

function context(db: FakeD1Database) {
  const responseHeaders = new Headers();
  return {
    req: { header: () => "Merlin-Test/1.0" },
    header: (name: string, value: string) => responseHeaders.set(name, value),
    env: { merlin_db: db, SESSION_HASH_SECRET: "test-only-secret" },
  } as any;
}

describe("launcher access handoff", () => {
  test("creates an opaque token and consumes it exactly once", async () => {
    const db = new FakeD1Database();
    const c = context(db);
    const handoff = await createLauncherAccessHandoff(c, 42);

    expect(handoff.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(db.handoffs[0].token_hash).not.toBe(handoff.token);

    await expect(consumeLauncherAccessHandoff(c, handoff.token)).resolves.toMatchObject({
      csrfToken: expect.any(String),
    });
    await expect(consumeLauncherAccessHandoff(c, handoff.token)).rejects.toThrow(
      "Access handoff expired",
    );
    expect(db.sessions).toHaveLength(1);
  });

  test("rejects an expired handoff before creating a session", async () => {
    const db = new FakeD1Database();
    const c = context(db);
    const handoff = await createLauncherAccessHandoff(c, 42);
    db.handoffs[0].expires_at = new Date(Date.now() - 1000).toISOString();

    await expect(consumeLauncherAccessHandoff(c, handoff.token)).rejects.toThrow(
      "Access handoff expired",
    );
    expect(db.sessions).toHaveLength(0);
  });
});
