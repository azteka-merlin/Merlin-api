-- One unfinished Pix-origin transition per license, regardless of whether the
-- new charge is made through Mercado Pago or Stripe.
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_pix_transition_in_progress
ON checkout_sessions(upgrade_license_id)
WHERE operation_type = 'pix_plan_transition'
  AND upgrade_processed_at IS NULL
  AND status NOT IN ('expired', 'failed', 'canceled');
