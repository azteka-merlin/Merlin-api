CREATE TABLE admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  status TEXT NOT NULL DEFAULT 'active',
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  admin_user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  ip_hash TEXT NOT NULL,
  user_agent_hash TEXT NOT NULL,
  device_hash TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT,
  FOREIGN KEY (admin_user_id) REFERENCES admin_users(id)
);

CREATE TABLE admin_login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  admin_user_id INTEGER,
  ip_hash TEXT NOT NULL,
  user_agent_hash TEXT,
  success INTEGER NOT NULL,
  failure_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE admin_blocked_ips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0,
  blocked_at TEXT NOT NULL,
  blocked_until TEXT,
  manually_unblocked_at TEXT,
  manually_unblocked_by INTEGER
);

CREATE TABLE admin_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  ip_hash TEXT,
  user_agent_hash TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (admin_user_id) REFERENCES admin_users(id)
);

CREATE INDEX idx_admin_users_username ON admin_users(username);
CREATE INDEX idx_admin_users_status ON admin_users(status);
CREATE INDEX idx_admin_sessions_admin_user_id ON admin_sessions(admin_user_id);
CREATE INDEX idx_admin_sessions_expires_at ON admin_sessions(expires_at);
CREATE INDEX idx_admin_sessions_absolute_expires_at ON admin_sessions(absolute_expires_at);
CREATE INDEX idx_admin_login_attempts_username ON admin_login_attempts(username);
CREATE INDEX idx_admin_login_attempts_admin_user_id ON admin_login_attempts(admin_user_id);
CREATE INDEX idx_admin_login_attempts_ip_hash ON admin_login_attempts(ip_hash);
CREATE INDEX idx_admin_audit_logs_admin_user_id ON admin_audit_logs(admin_user_id);
CREATE INDEX idx_admin_audit_logs_action ON admin_audit_logs(action);
CREATE INDEX idx_admin_audit_logs_created_at ON admin_audit_logs(created_at);
