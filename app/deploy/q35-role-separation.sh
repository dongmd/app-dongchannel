#!/usr/bin/env bash
#
# Q35 / AUDIT-ROLE-SEPARATION — separate the SCHEMA OWNER from the RUNTIME role.
#
#   sudo bash q35-role-separation.sh
#
# Run on the VPS, as root. Idempotent.
#
# ## Why this is ops SQL and not a Drizzle migration
#
# Creating a role and reassigning ownership needs privileges the migration
# runner must not have. Putting it in the migration chain would be the bootstrap
# paradox in its purest form: the runner would need exactly the authority this
# change exists to take away from it.
#
# ## What it fixes
#
# `P3-R06`'s append-only enforcement was a CORRECTNESS control, not a SECURITY
# one, because the runtime application connected as `opsdash` — which OWNED
# `audit_events`. A table owner can `DROP TRIGGER` on its own table, so the
# enforcement was removable by exactly the credential most likely to be
# compromised. Proven by execution on an isolated scratch database:
#
#     direct UPDATE as the non-superuser owner  ->  REFUSED
#     DROP TRIGGER as the same role             ->  SUCCEEDED
#     UPDATE afterwards                         ->  SUCCEEDED
#
# ## The password
#
# Generated here and written straight into `.env`. It never appears on a command
# line (where `ps` would show it), never in a shell history, and never in
# output.
#
# ## Rollback
#
#   sudo -u postgres psql -d dongchannel_ops \
#     -c 'REASSIGN OWNED BY dc_migrator TO opsdash' \
#     -c 'GRANT CREATE ON SCHEMA public TO opsdash'
#   sudo -u postgres psql -c 'DROP ROLE dc_migrator'
#   sed -i '/^MIGRATION_DATABASE_URL=/d' /home/opssite/.env
#
# That returns the database to exactly the shape the pre-change dump captured,
# without needing the dump.

set -euo pipefail

DB=dongchannel_ops
ENV_FILE=/home/opssite/.env

[ "$(id -u)" = "0" ] || { echo "FAIL: run as root (sudo)" >&2; exit 1; }

PW="$(openssl rand -hex 24)"

sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB" >/dev/null <<SQL
DO \$do\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dc_migrator') THEN
    EXECUTE format(
      'CREATE ROLE dc_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
      '${PW}');
  ELSE
    EXECUTE format('ALTER ROLE dc_migrator PASSWORD %L', '${PW}');
  END IF;
END
\$do\$;

-- Everything opsdash owns becomes dc_migrator's, in one statement, so no object
-- is left behind on a role that is about to lose its DDL authority.
REASSIGN OWNED BY opsdash TO dc_migrator;

-- The runtime keeps USAGE on the schema and loses CREATE.
REVOKE CREATE ON SCHEMA public FROM opsdash;
GRANT  USAGE          ON SCHEMA public  TO opsdash;
GRANT  USAGE, CREATE  ON SCHEMA public  TO dc_migrator;
GRANT  USAGE          ON SCHEMA drizzle TO dc_migrator;
GRANT  ALL            ON ALL TABLES IN SCHEMA drizzle TO dc_migrator;

-- Runtime DML on the application tables it genuinely needs. Deliberately not
-- narrowed further: the canonical app behaviour needs full CRUD on its own
-- domain tables, and restricting unrelated tables would be scope creep.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO opsdash;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO opsdash;

-- The append-only table is the exception. INSERT because the app writes audit
-- entries; SELECT because an append-only log nobody can read is a write-only
-- file (P3-R06 AC-10). No UPDATE, no DELETE, no TRUNCATE, and no ownership.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM opsdash;

-- Future objects created by the migrator grant the runtime DML automatically,
-- so a table added by a later migration does not silently arrive unreadable.
ALTER DEFAULT PRIVILEGES FOR ROLE dc_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO opsdash;
ALTER DEFAULT PRIVILEGES FOR ROLE dc_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO opsdash;
SQL

# Hand the credential to the deploy through .env, never through a shell line.
sed -i '/^MIGRATION_DATABASE_URL=/d' "$ENV_FILE"
printf 'MIGRATION_DATABASE_URL=postgres://dc_migrator:%s@127.0.0.1:5432/%s\n' "$PW" "$DB" >> "$ENV_FILE"
chown opssite:opssite "$ENV_FILE"
chmod 600 "$ENV_FILE"

unset PW

echo "role separation applied; MIGRATION_DATABASE_URL written to .env"
