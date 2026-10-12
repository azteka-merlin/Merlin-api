-- An initial purchase is not tied to a license yet. Prevent simultaneous
-- Stripe and Pix purchases for the same verified internal customer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_new_customer_financial_operation
ON checkout_sessions(customer_id)
WHERE license_id IS NULL AND reactivation_license_id IS NULL
  AND scheduled_renewal_license_id IS NULL AND upgrade_license_id IS NULL
  AND (payment_status = 'paid' OR status IN ('open', 'processing', 'complete', 'completed'));
