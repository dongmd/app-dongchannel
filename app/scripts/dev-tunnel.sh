#!/bin/bash
# SSH tunnel để dev local reach Hermes REST + Postgres trên VPS vocapro.
# Chạy trong 1 terminal riêng, để trống terminal đó cho tunnel chạy.
#
# Usage:
#   ./scripts/dev-tunnel.sh          # both tunnels
#   ./scripts/dev-tunnel.sh hermes   # chỉ Hermes 9119
#   ./scripts/dev-tunnel.sh pg       # chỉ Postgres 5432
#
# Ctrl+C để đóng.

set -e

TARGETS="${1:-both}"

case "$TARGETS" in
  hermes)
    exec ssh -o ExitOnForwardFailure=yes -N -L 9119:127.0.0.1:9119 vocapro
    ;;
  pg|postgres)
    exec ssh -o ExitOnForwardFailure=yes -N -L 5432:127.0.0.1:5432 vocapro
    ;;
  both|"")
    exec ssh -o ExitOnForwardFailure=yes -N \
      -L 9119:127.0.0.1:9119 \
      -L 5432:127.0.0.1:5432 \
      vocapro
    ;;
  *)
    echo "Usage: $0 [both|hermes|pg]" >&2
    exit 1
    ;;
esac
