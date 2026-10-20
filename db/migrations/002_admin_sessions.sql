-- Server-side admin sessions so logout revokes a session before its cookie expires.
-- Only a sha256 of the session id is stored; expires_at is epoch milliseconds.
CREATE TABLE IF NOT EXISTS admin_sessions (
  sid_hash CHAR(64) NOT NULL PRIMARY KEY,
  expires_at BIGINT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
