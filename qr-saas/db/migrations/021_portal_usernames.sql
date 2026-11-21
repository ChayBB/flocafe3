-- Optional sign-in name for portal accounts; email sign-in keeps working.
ALTER TABLE portal_users ADD COLUMN username text
  CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$');
CREATE UNIQUE INDEX portal_users_username ON portal_users (username);
REVOKE ALL ON portal_users FROM qr_app;
