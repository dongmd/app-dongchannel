#!/usr/bin/env bash
#
# Q35b / AUDIT-ROLE-SEPARATION — put the migration credential out of reach of
# the RUNTIME OS IDENTITY, not just out of reach of the runtime DB role.
#
#   sudo bash q35b-migration-secret-isolation.sh
#
# Run on the VPS, as root. Idempotent.
#
# ## The gap this closes
#
# Q35 separated the DATABASE roles: `dc_migrator` owns the schema, `opsdash`
# holds DML and no DDL. But the credential FOR `dc_migrator` lived in
# `/home/opssite/.env.migrate`, mode 600 owned by `opssite` — and the
# application also runs as `opssite`. Remote code execution in the application
# would have read the file and recovered the DDL authority the whole gate exists
# to remove. A separation the attacker can undo by reading a file is not a
# separation.
#
# ## Why root-owned rather than peer auth or a dedicated OS user
#
# Peer authentication over the unix socket would remove the secret entirely,
# which is strictly better in the abstract. Two facts about THIS machine argue
# against it:
#
#   - `/home/opssite` is mode 770. A separate migration OS user would need
#     membership of the `opssite` group to traverse it, which grants GROUP WRITE
#     on the runtime user's home — a privilege flowing in exactly the wrong
#     direction.
#   - The PostgreSQL cluster is shared with three databases belonging to other
#     applications. Editing `pg_hba.conf`/`pg_ident.conf` to map an identity has
#     a blast radius outside this project.
#
# The deploy already runs as root, so a root-owned file needs no new privilege,
# no new sudo rule, and no shared configuration change. It is the mechanism with
# the smallest blast radius that actually achieves the invariant.
#
# ## Why the credential is ROTATED and not merely moved
#
# The current value has sat in three places `opssite` could read: `.env`, the
# copy the build placed in `.next/standalone/.env`, and — still, at the time of
# writing — `/home/opssite/.pm2/dump.pm2.bak`, where PM2 stored the process
# environment. Moving a value that may already have been captured protects
# nothing. The old value is retired here, so every stale copy becomes inert.
#
# ## Rollback
#
#   sudo -u postgres psql -d dongchannel_ops \
#     -c 'REASSIGN OWNED BY dc_migrator TO opsdash' \
#     -c 'GRANT CREATE ON SCHEMA public TO opsdash'
#   sudo -u postgres psql -c 'DROP ROLE dc_migrator'
#   sudo rm -rf /root/.dongchannel

set -euo pipefail

DB=dongchannel_ops
RUNTIME_USER=opssite
SECRET_DIR=/root/.dongchannel
SECRET_FILE="$SECRET_DIR/migrate.env"
OLD_SECRET_FILE=/home/opssite/.env.migrate

[ "$(id -u)" = "0" ] || { echo "FAIL: run as root (sudo)" >&2; exit 1; }

# Generated here, never on a command line where `ps` would show it, never in a
# shell history, never echoed.
PW="$(openssl rand -hex 24)"

sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB" >/dev/null <<SQL
DO \$do\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dc_migrator') THEN
    RAISE EXCEPTION 'dc_migrator does not exist -- run q35-role-separation.sh first';
  END IF;
  EXECUTE format('ALTER ROLE dc_migrator PASSWORD %L', '${PW}');
END
\$do\$;
SQL

install -d -m 700 -o root -g root "$SECRET_DIR"

# `install` creates the file with the mode already set, so there is no window in
# which it exists world-readable. Writing then chmod-ing would leave one.
install -m 600 -o root -g root /dev/null "$SECRET_FILE"
printf 'MIGRATION_DATABASE_URL=postgres://dc_migrator:%s@127.0.0.1:5432/%s\n' "$PW" "$DB" > "$SECRET_FILE"

unset PW

# Every copy the runtime identity could reach. The rotation above already made
# them inert, but an inert credential still reads as a live one to anyone who
# finds it later, and to any scanner.
rm -f "$OLD_SECRET_FILE"
for f in /home/opssite/.pm2/dump.pm2 /home/opssite/.pm2/dump.pm2.bak \
         /home/opssite/.pm2/dump.pm2.preQ35env \
         /home/opssite/htdocs/app.dongchannel.com/app/.next/standalone/.env \
         /home/opssite/.env; do
  [ -f "$f" ] || continue
  if grep -q 'MIGRATION_DATABASE_URL' "$f" 2>/dev/null; then
    case "$f" in
      *dump.pm2.bak|*dump.pm2.preQ35env)
        # Stale PM2 snapshots. Nothing reads them except `pm2 resurrect`, and
        # the live dump.pm2 is current, so removing them loses no recovery path.
        rm -f "$f" ;;
      *)
        sed -i '/^MIGRATION_DATABASE_URL=/d' "$f" ;;
    esac
  fi
done

# The invariant, tested directly rather than through mode bits: can the runtime
# identity actually read it?
if runuser -u "$RUNTIME_USER" -- test -r "$SECRET_FILE" 2>/dev/null; then
  echo "FAIL: $RUNTIME_USER can still read $SECRET_FILE" >&2
  exit 1
fi

echo "migration secret isolated: root-owned, rotated, and unreadable to $RUNTIME_USER"
