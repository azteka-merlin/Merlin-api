import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../types";
import { startPublicEmailVerification, verifyPublicEmailCode, consumePublicEmailVerification } from "./email-verification";
import { enforcePublicAccessKeyRateLimit } from "./rate-limit";
import { requireLauncherSearchLicense } from "./launcher-auth";

type ProfileRow = {
  id: number;
  license_key: string;
  name: string;
  contact: string;
  contact_type: string;
  profile_phone: string | null;
  customer_id: number | null;
};

async function readProfile(c: AppContext, licenseId: number) {
  const row = await c.env.merlin_db.prepare(`
    SELECT id, license_key, name, contact, contact_type, profile_phone, customer_id
    FROM licenses WHERE id = ? LIMIT 1
  `).bind(licenseId).first<ProfileRow>();
  if (!row) throw new HTTPException(404, { message: "License not found" });
  return row;
}

function mapProfile(row: ProfileRow) {
  return {
    licenseKey: row.license_key,
    name: row.name,
    email: row.contact_type === "email" ? row.contact : null,
    phone: row.profile_phone ?? (row.contact_type === "phone" ? row.contact : null),
  };
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

async function assertEmailAvailable(c: AppContext, email: string, licenseId: number) {
  const row = await c.env.merlin_db.prepare(`
    SELECT id FROM licenses WHERE contact_type = 'email' AND lower(contact) = ? AND id <> ? LIMIT 1
  `).bind(email, licenseId).first<{ id: number }>();
  if (row) throw new HTTPException(409, { message: "Este e-mail já está cadastrado em outra licença." });
}

export async function getLauncherProfile(c: AppContext) {
  c.header("Cache-Control", "no-store");
  const identity = await requireLauncherSearchLicense(c);
  return mapProfile(await readProfile(c, identity.id));
}

export async function startLauncherProfileEmailChange(c: AppContext, email: string) {
  const identity = await requireLauncherSearchLicense(c);
  const nextEmail = normalizeEmail(email);
  await enforcePublicAccessKeyRateLimit(c, `launcher-profile-email:${identity.id}`);
  const current = await readProfile(c, identity.id);
  if (current.contact_type === "email" && normalizeEmail(current.contact) === nextEmail) {
    throw new HTTPException(400, { message: "Este e-mail já está cadastrado nesta licença." });
  }
  return startPublicEmailVerification(c, nextEmail);
}

export async function updateLauncherProfile(c: AppContext, input: {
  name: string; email: string; phone: string | null; emailCode?: string;
}) {
  const identity = await requireLauncherSearchLicense(c);
  const current = await readProfile(c, identity.id);
  const nextEmail = normalizeEmail(input.email);
  const emailChanged = current.contact_type !== "email" || normalizeEmail(current.contact) !== nextEmail;
  if (emailChanged) {
    if (!input.emailCode) throw new HTTPException(403, { message: "Confirme o código enviado ao novo e-mail." });
    await verifyPublicEmailCode(c, { email: nextEmail, code: input.emailCode });
    await assertEmailAvailable(c, nextEmail, identity.id);
  }
  const phone = input.phone?.trim() || null;
  const now = new Date().toISOString();
  const result = await c.env.merlin_db.prepare(`
    UPDATE licenses SET name = ?, contact = ?, contact_type = 'email', profile_phone = ?, updated_at = ?
    WHERE id = ? AND contact = ? AND contact_type = ?
      AND NOT EXISTS (
        SELECT 1 FROM licenses duplicate
        WHERE duplicate.id <> ? AND duplicate.contact_type = 'email' AND lower(duplicate.contact) = ?
      )
  `).bind(input.name.trim(), nextEmail, phone,
    now, identity.id, current.contact, current.contact_type, identity.id, nextEmail).run();
  if (!result.success || result.meta?.changes !== 1) {
    throw new HTTPException(409, { message: "Os dados mudaram. Atualize a página e tente novamente." });
  }
  if (emailChanged) {
    const verified = await c.env.merlin_db.prepare(`
      SELECT id FROM email_verifications WHERE email_normalized = ? AND status = 'verified'
      ORDER BY id DESC LIMIT 1
    `).bind(nextEmail).first<{ id: number }>();
    if (verified) await consumePublicEmailVerification(c, verified.id);
  }
  c.header("Cache-Control", "no-store");
  return mapProfile(await readProfile(c, identity.id));
}
