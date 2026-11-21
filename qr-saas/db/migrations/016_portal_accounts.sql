-- Web portal accounts: Cloud administrators and shop owners (one shop each).
CREATE TABLE portal_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'owner')),
  tenant_id uuid REFERENCES tenants(id),
  password_hash text,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'admin') = (tenant_id IS NULL))
);
CREATE UNIQUE INDEX portal_users_email ON portal_users (lower(email));

CREATE TABLE portal_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX portal_sessions_user ON portal_sessions (user_id);

CREATE TABLE portal_invites (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX portal_invites_user ON portal_invites (user_id);

CREATE TABLE portal_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid REFERENCES portal_users(id),
  action text NOT NULL,
  tenant_id uuid,
  branch_id uuid,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE connector_installations ADD COLUMN last_seen_at timestamptz;

-- Portal tables are read only by the owner role; qr_app request handlers never see them.
ALTER TABLE portal_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON portal_users, portal_sessions, portal_invites, portal_audit FROM qr_app;
