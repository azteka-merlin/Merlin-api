import type { AppBindings } from "../types";

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_EMAIL_FROM = "Merlin <onboarding@resend.dev>";

export type BillingEmailKind =
  | "manual_expiration_reminder"
  | "stripe_cancel_expiration_reminder"
  | "payment_failed"
  | "payment_action_required"
  | "access_expired";

export type BillingEmailInput = {
  kind: BillingEmailKind;
  email: string;
  name: string | null;
  ctaUrl: string;
  idempotencyKey: string;
  expiresAt?: string | null;
  invoiceAmount?: string | null;
  licenseKeyMasked?: string | null;
};

type BillingEmailContext = {
  env: AppBindings;
};

function getEmailFrom(c: BillingEmailContext) {
  return String(c.env.EMAIL_FROM || DEFAULT_EMAIL_FROM).trim() || DEFAULT_EMAIL_FROM;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function customerName(name: string | null) {
  return name?.trim() || "usuário Merlin";
}

function optionalLicenseBlock(licenseKeyMasked?: string | null) {
  if (!licenseKeyMasked) return "";
  return `
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border:1px solid #ddd6fe;border-radius:14px;border-collapse:separate;background:#faf5ff;">
                <tr>
                  <td style="padding:16px;font-family:Arial,Helvetica,sans-serif;">
                    <p style="margin:0;color:#6b21a8;font-size:12px;line-height:18px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">Chave</p>
                    <p style="margin:6px 0 0;color:#111827;font-size:16px;line-height:22px;font-weight:700;">${escapeHtml(licenseKeyMasked)}</p>
                  </td>
                </tr>
              </table>`;
}

function renderShell(input: {
  title: string;
  preheader: string;
  eyebrow: string;
  heroLabel: string;
  heading: string;
  bodyHtml: string;
  ctaLabel: string;
  ctaUrl: string;
  footer: string;
}) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;-webkit-text-size-adjust:100%;text-size-adjust:100%;background:#0f0f16;color:#f8fafc;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;background:#0f0f16;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px;border:1px solid #7c3aed;border-radius:18px;border-collapse:separate;overflow:hidden;background:#15151d;">
          <tr>
            <td align="center" style="padding:30px 16px 26px;background:#15151d;font-family:Arial,Helvetica,sans-serif;">
              <div style="font-size:44px;line-height:48px;font-weight:900;letter-spacing:6px;color:#f8fafc;text-transform:uppercase;">MERLIN</div>
              <div style="width:84px;height:3px;margin:16px auto 0;background:#a855f7;line-height:3px;font-size:3px;">&nbsp;</div>
              <p style="margin:14px 0 0;color:#c4b5fd;font-size:14px;line-height:21px;font-weight:700;">${escapeHtml(input.heroLabel)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;font-family:Arial,Helvetica,sans-serif;background:#ffffff;color:#18181b;">
              <p style="margin:0 0 8px;color:#7c3aed;font-size:13px;line-height:18px;letter-spacing:1px;text-transform:uppercase;font-weight:700;">${escapeHtml(input.eyebrow)}</p>
              <h1 style="margin:0 0 12px;font-size:24px;line-height:30px;font-weight:700;color:#111827;">${escapeHtml(input.heading)}</h1>
${input.bodyHtml}
              <p style="margin:24px 0 0;">
                <a href="${escapeHtml(input.ctaUrl)}" style="display:inline-block;padding:13px 18px;border-radius:10px;background:#7c3aed;color:#ffffff;text-decoration:none;font-size:14px;line-height:18px;font-weight:700;">${escapeHtml(input.ctaLabel)}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px;background:#15151d;font-family:Arial,Helvetica,sans-serif;">
              <p style="margin:0;color:#a1a1aa;font-size:12px;line-height:18px;">${escapeHtml(input.footer)}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderManualExpiration(input: BillingEmailInput) {
  const name = escapeHtml(customerName(input.name));
  const expiresAt = escapeHtml(input.expiresAt || "");
  const licenseBlock = optionalLicenseBlock(input.licenseKeyMasked);
  return {
    subject: "Seu acesso Merlin vence em breve",
    preheader: "Renove seu acesso para continuar usando o Merlin sem interrupção.",
    text: [
      "Seu acesso Merlin vence em breve",
      "",
      `Olá, ${customerName(input.name)}. Seu acesso mensal ao Merlin está disponível até ${input.expiresAt || ""}.`,
      "Como este acesso não possui renovação automática, você pode renovar manualmente para continuar usando o Merlin.",
      "",
      `Renovar acesso: ${input.ctaUrl}`,
    ].join("\n"),
    html: renderShell({
      title: "Seu acesso Merlin vence em breve",
      preheader: "Renove seu acesso para continuar usando o Merlin sem interrupção.",
      heroLabel: "Acesso mensal",
      eyebrow: "Renovação",
      heading: "Seu acesso vence em breve",
      ctaLabel: "Renovar acesso",
      ctaUrl: input.ctaUrl,
      footer: "Merlin Launcher • Este e-mail foi enviado porque existe um acesso Merlin vinculado a este endereço.",
      bodyHtml: `
              <p style="margin:0 0 18px;font-size:14px;line-height:22px;color:#374151;">Olá, ${name}. Seu acesso mensal ao Merlin está disponível até <strong>${expiresAt}</strong>.</p>
              <p style="margin:0 0 22px;font-size:14px;line-height:22px;color:#374151;">Como este acesso não possui renovação automática, você pode renovar manualmente para continuar usando o Merlin.</p>
${licenseBlock}
              <p style="margin:22px 0 0;font-size:12px;line-height:18px;color:#6b7280;">Se você já renovou, pode ignorar este aviso.</p>`,
    }),
  };
}

function renderStripeCancelExpiration(input: BillingEmailInput) {
  const name = escapeHtml(customerName(input.name));
  const expiresAt = escapeHtml(input.expiresAt || "");
  const licenseBlock = optionalLicenseBlock(input.licenseKeyMasked);
  return {
    subject: "Sua renovação automática está desativada",
    preheader: "Seu acesso continua ativo até o fim do período pago.",
    text: [
      "Sua renovação automática está desativada",
      "",
      `Olá, ${customerName(input.name)}. Sua assinatura Merlin está ativa até ${input.expiresAt || ""}, mas a renovação automática está desativada.`,
      "Se quiser continuar com a mensalidade sem interrupção, revise as opções da sua assinatura.",
      "",
      `Gerenciar assinatura: ${input.ctaUrl}`,
    ].join("\n"),
    html: renderShell({
      title: "Sua renovação automática está desativada",
      preheader: "Seu acesso continua ativo até o fim do período pago.",
      heroLabel: "Assinatura mensal",
      eyebrow: "Renovação automática desativada",
      heading: "Seu acesso continua ativo por enquanto",
      ctaLabel: "Gerenciar assinatura",
      ctaUrl: input.ctaUrl,
      footer: "Merlin Launcher • Este e-mail foi enviado porque sua assinatura mensal está perto do fim do período pago.",
      bodyHtml: `
              <p style="margin:0 0 18px;font-size:14px;line-height:22px;color:#374151;">Olá, ${name}. Sua assinatura Merlin está ativa até <strong>${expiresAt}</strong>, mas a renovação automática está desativada.</p>
              <p style="margin:0 0 22px;font-size:14px;line-height:22px;color:#374151;">Se quiser continuar com a mensalidade sem interrupção, revise as opções da sua assinatura.</p>
${licenseBlock}
              <p style="margin:22px 0 0;font-size:12px;line-height:18px;color:#6b7280;">Se você desativou a renovação de propósito, não precisa fazer nada.</p>`,
    }),
  };
}

function renderPaymentFailed(input: BillingEmailInput) {
  const name = escapeHtml(customerName(input.name));
  const amount = escapeHtml(input.invoiceAmount || "");
  const licenseBlock = optionalLicenseBlock(input.licenseKeyMasked);
  return {
    subject: "Não conseguimos renovar sua assinatura do Merlin",
    preheader: "Revise seu método de pagamento para evitar interrupção do acesso.",
    text: [
      "Não foi possível processar sua renovação",
      "",
      `Olá, ${customerName(input.name)}. Houve um problema ao processar o pagamento da sua assinatura Merlin.`,
      input.invoiceAmount ? `Valor da renovação: ${input.invoiceAmount}.` : "",
      "Revise seu método de pagamento para evitar a interrupção do acesso.",
      "",
      `Atualizar pagamento: ${input.ctaUrl}`,
    ].filter(Boolean).join("\n"),
    html: renderShell({
      title: "Não conseguimos renovar sua assinatura do Merlin",
      preheader: "Revise seu método de pagamento para evitar interrupção do acesso.",
      heroLabel: "Pagamento da assinatura",
      eyebrow: "Pagamento não processado",
      heading: "Não foi possível processar sua renovação",
      ctaLabel: "Atualizar pagamento",
      ctaUrl: input.ctaUrl,
      footer: "Merlin Launcher • Este e-mail foi enviado porque uma cobrança automática da sua assinatura não foi concluída.",
      bodyHtml: `
              <p style="margin:0 0 18px;font-size:14px;line-height:22px;color:#374151;">Olá, ${name}. Houve um problema ao processar o pagamento da sua assinatura Merlin.</p>
${amount ? `              <p style="margin:0 0 18px;font-size:14px;line-height:22px;color:#374151;">Valor da renovação: <strong>${amount}</strong>.</p>` : ""}
              <p style="margin:0 0 22px;font-size:14px;line-height:22px;color:#374151;">Revise seu método de pagamento para evitar a interrupção do acesso.</p>
${licenseBlock}
              <p style="margin:22px 0 0;font-size:12px;line-height:18px;color:#6b7280;">Se o pagamento for concluído automaticamente em uma nova tentativa, seu acesso será atualizado sem precisar criar outra chave.</p>`,
    }),
  };
}

function renderPaymentActionRequired(input: BillingEmailInput) {
  const name = escapeHtml(customerName(input.name));
  const amount = escapeHtml(input.invoiceAmount || "");
  const licenseBlock = optionalLicenseBlock(input.licenseKeyMasked);
  return {
    subject: "Confirme o pagamento da sua assinatura Merlin",
    preheader: "Falta apenas confirmar o pagamento com seu banco.",
    text: [
      "Seu pagamento precisa de confirmação",
      "",
      `Olá, ${customerName(input.name)}. Seu banco solicitou uma confirmação para concluir a renovação da sua assinatura.`,
      input.invoiceAmount ? `Valor da renovação: ${input.invoiceAmount}.` : "",
      "Revise o pagamento para concluir a renovação.",
      "",
      `Revisar pagamento: ${input.ctaUrl}`,
    ].filter(Boolean).join("\n"),
    html: renderShell({
      title: "Confirme o pagamento da sua assinatura Merlin",
      preheader: "Falta apenas confirmar o pagamento com seu banco.",
      heroLabel: "Confirmação de pagamento",
      eyebrow: "Pagamento precisa de confirmação",
      heading: "Seu pagamento precisa de confirmação",
      ctaLabel: "Revisar pagamento",
      ctaUrl: input.ctaUrl,
      footer: "Merlin Launcher • Este e-mail foi enviado porque seu banco pediu confirmação para concluir a renovação.",
      bodyHtml: `
              <p style="margin:0 0 18px;font-size:14px;line-height:22px;color:#374151;">Olá, ${name}. Seu banco solicitou uma confirmação para concluir a renovação da sua assinatura.</p>
${amount ? `              <p style="margin:0 0 18px;font-size:14px;line-height:22px;color:#374151;">Valor da renovação: <strong>${amount}</strong>.</p>` : ""}
              <p style="margin:0 0 22px;font-size:14px;line-height:22px;color:#374151;">Revise o pagamento para concluir a renovação.</p>
${licenseBlock}
              <p style="margin:22px 0 0;font-size:12px;line-height:18px;color:#6b7280;">Esse link abre uma página segura da Stripe para a cobrança pendente.</p>`,
    }),
  };
}

function renderAccessExpired(input: BillingEmailInput) {
  const name = escapeHtml(customerName(input.name));
  const expiresAt = escapeHtml(input.expiresAt || "");
  const licenseBlock = optionalLicenseBlock(input.licenseKeyMasked);
  return {
    subject: "Seu acesso Merlin expirou",
    preheader: "Regularize seu acesso para voltar a usar o Merlin.",
    text: [
      "Seu acesso Merlin expirou",
      "",
      `Olá, ${customerName(input.name)}. Seu acesso ao Merlin expirou em ${input.expiresAt || ""}.`,
      "Você pode regularizar o acesso usando a mesma chave. Não é necessário criar uma nova conta.",
      "",
      `Regularizar acesso: ${input.ctaUrl}`,
    ].join("\n"),
    html: renderShell({
      title: "Seu acesso Merlin expirou",
      preheader: "Regularize seu acesso para voltar a usar o Merlin.",
      heroLabel: "Acesso expirado",
      eyebrow: "Regularização",
      heading: "Seu acesso Merlin expirou",
      ctaLabel: "Regularizar acesso",
      ctaUrl: input.ctaUrl,
      footer: "Merlin Launcher • Este e-mail foi enviado porque o período de acesso vinculado a esta chave terminou.",
      bodyHtml: `
              <p style="margin:0 0 18px;font-size:14px;line-height:22px;color:#374151;">Olá, ${name}. Seu acesso ao Merlin expirou em <strong>${expiresAt}</strong>.</p>
              <p style="margin:0 0 22px;font-size:14px;line-height:22px;color:#374151;">Você pode regularizar o acesso usando a mesma chave. Não é necessário criar uma nova conta.</p>
${licenseBlock}
              <p style="margin:22px 0 0;font-size:12px;line-height:18px;color:#6b7280;">Se você acredita que isso foi um engano, entre em contato com o suporte Merlin.</p>`,
    }),
  };
}

export function renderBillingEmail(input: BillingEmailInput) {
  if (input.kind === "manual_expiration_reminder") return renderManualExpiration(input);
  if (input.kind === "stripe_cancel_expiration_reminder") return renderStripeCancelExpiration(input);
  if (input.kind === "payment_failed") return renderPaymentFailed(input);
  if (input.kind === "payment_action_required") return renderPaymentActionRequired(input);
  return renderAccessExpired(input);
}

export async function sendBillingEmail(c: BillingEmailContext, input: BillingEmailInput) {
  const apiKey = String(c.env.RESEND_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  const message = renderBillingEmail(input);
  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
      "User-Agent": "Merlin API",
    },
    body: JSON.stringify({
      from: getEmailFrom(c),
      to: [input.email],
      subject: message.subject,
      html: message.html,
      text: message.text,
    }),
  });

  if (response.ok) {
    return response.json().catch(() => ({ success: true }));
  }

  const detail = await response.text().catch(() => "");
  throw new Error(`Billing email failed with ${response.status}: ${detail.slice(0, 300)}`);
}
