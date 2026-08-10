CREATE TABLE IF NOT EXISTS billing_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER,
  customer_id INTEGER,
  provider TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (license_id) REFERENCES licenses(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE INDEX IF NOT EXISTS idx_billing_notifications_license
ON billing_notifications(license_id);

CREATE INDEX IF NOT EXISTS idx_billing_notifications_customer
ON billing_notifications(customer_id);

CREATE INDEX IF NOT EXISTS idx_billing_notifications_type
ON billing_notifications(notification_type);

CREATE INDEX IF NOT EXISTS idx_billing_notifications_status
ON billing_notifications(status);
