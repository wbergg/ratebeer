-- Bootstrap the first admin. Edit the nickname if you like, then:
--   npx wrangler d1 execute ratebeer --remote --file seed/admin.sql
INSERT INTO users (email, nickname, role) VALUES ('user@example.com', 'user', 'admin')
  ON CONFLICT (email) DO UPDATE SET role = 'admin';
