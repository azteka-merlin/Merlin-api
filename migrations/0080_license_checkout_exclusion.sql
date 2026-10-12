-- A Pix renewal and a Pix-origin card transition must not both be payable
-- for the same license. This is enforced by D1, not by a read-before-write.
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_pix_license_financial_operation
ON checkout_sessions(COALESCE(upgrade_license_id, scheduled_renewal_license_id))
WHERE (
  operation_type = 'pix_plan_transition'
  AND upgrade_license_id IS NOT NULL
  AND upgrade_processed_at IS NULL
  AND status NOT IN ('expired', 'failed', 'canceled')
) OR (
  provider = 'mercadopago'
  AND scheduled_renewal_license_id IS NOT NULL
  AND renewal_applied_at IS NULL
  AND (payment_status = 'paid' OR status IN ('open', 'processing'))
);

-- Expired card access can be reactivated by either Stripe or Pix, never both
-- at once. Both paths reserve checkout_sessions before contacting a provider.
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_reactivation_license_financial_operation
ON checkout_sessions(reactivation_license_id)
WHERE reactivation_license_id IS NOT NULL AND license_id IS NULL
  AND (payment_status = 'paid' OR status IN ('open', 'processing', 'complete', 'completed'));
