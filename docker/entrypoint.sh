#!/bin/sh
# Dispatches the image's commands: service (default), replay, bench, decoder-bench.
set -e
cmd="${1:-service}"
[ "$#" -gt 0 ] && shift
case "$cmd" in
  service) exec node apps/service/dist/main.js "$@" ;;
  replay) exec node apps/replay/dist/main.js serve "$@" ;;
  bench) exec node bench/dist/run.js "$@" ;;
  decoder-bench) exec node bench/dist/decoder.js "$@" ;;
  *) exec "$cmd" "$@" ;;
esac
