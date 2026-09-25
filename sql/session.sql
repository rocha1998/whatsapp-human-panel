-- Execute explicitly before using PostgreSQL sessions. Never run at app startup.
BEGIN;

CREATE TABLE IF NOT EXISTS public.user_sessions (
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expire
  ON public.user_sessions (expire);

COMMIT;
