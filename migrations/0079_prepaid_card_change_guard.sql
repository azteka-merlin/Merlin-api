-- A paid Pix period migrated to card can have only one unfinished follow-up
-- change. The reservation is created before opening Stripe Checkout.
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_prepaid_card_change_in_progress
ON checkout_sessions(upgrade_license_id)
WHERE operation_type = 'prepaid_card_plan_change'
  AND upgrade_processed_at IS NULL
  AND status NOT IN ('expired', 'failed', 'canceled');
