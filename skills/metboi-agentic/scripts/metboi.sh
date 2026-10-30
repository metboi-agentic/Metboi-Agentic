#!/bin/sh
# Runs the metboi CLI for an agent, from PATH or METBOI_HOME, optionally loading settings from METBOI_ENV_FILE.
# Owner commands are refused, and the owner key is removed from the environment.
unset METBOI_OWNER_KEY
case "$1" in
  init|policy|pause|resume|set-agent|withdraw-sol|withdraw-token|owner-scan|owner-dlmm-close|owner-damm-close|owner-limit-cancel)
    echo '{"ok":false,"error":"Owner commands are not available to the agent. Ask the owner to run this. See references/setup.md."}'
    exit 3
    ;;
esac
for arg in "$@"; do
  case "$arg" in
    --owner-key|--owner-key=*)
      echo '{"ok":false,"error":"Owner keys are not available to the agent."}'
      exit 3
      ;;
  esac
done
if [ -n "$METBOI_ENV_FILE" ] && [ ! -f "$METBOI_ENV_FILE" ]; then
  echo '{"ok":false,"error":"METBOI_ENV_FILE does not point to a file. See references/setup.md."}'
  exit 2
fi
if [ -n "$METBOI_HOME" ] && [ -f "$METBOI_HOME/bin/metboi.mjs" ]; then
  if [ -n "$METBOI_ENV_FILE" ]; then
    exec node --env-file="$METBOI_ENV_FILE" "$METBOI_HOME/bin/metboi.mjs" "$@"
  fi
  exec node "$METBOI_HOME/bin/metboi.mjs" "$@"
fi
if command -v metboi >/dev/null 2>&1; then
  if [ -n "$METBOI_ENV_FILE" ]; then
    exec node --env-file="$METBOI_ENV_FILE" "$(command -v metboi)" "$@"
  fi
  exec metboi "$@"
fi
echo '{"ok":false,"error":"The metboi CLI was not found. Set METBOI_HOME or install it. See references/setup.md."}'
exit 127
