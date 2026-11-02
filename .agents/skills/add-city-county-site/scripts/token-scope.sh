#!/usr/bin/env bash
# token-scope.sh — make sure SLICC will attach the Adobe login token to every host this skill calls.
# SLICC only sends oauth.adobe.token to allow-listed hosts; a missing host fails LOCALLY with
#   curl: (1) forbidden: oauth.adobe.token on admin.da.live
# (DA never sees the request). Adds any missing host with `oauth-domain add adobe <host>`.
# New hosts only take effect after a SLICC page reload, so it then stops and asks for one.
# Usage: bash token-scope.sh            Exit 0 = ready; 1 = reload needed (or login failed).
# Run it before anything else; it is idempotent and takes about 1 s.
oauth-token adobe >/dev/null 2>&1 || { echo "STOP: Adobe login failed. Run: oauth-token adobe"; exit 1; }
NEED="admin.da.live content.da.live admin.hlx.page"
MISSING=""
for h in $NEED; do secret test oauth.adobe.token "https://$h/" >/dev/null 2>&1 || MISSING="$MISSING $h"; done
if [ -n "$MISSING" ]; then
  for h in $MISSING; do oauth-domain add adobe "$h" >/dev/null 2>&1 || echo "warn: oauth-domain add adobe $h failed"; done
  echo "STOP: added$MISSING to the Adobe token's allowed hosts."
  echo "Tell the requester: reload the SLICC page once (Cmd+R / Ctrl+R), then ask again. Nothing has been written yet."
  exit 1
fi
echo "Adobe token scope OK: $NEED"
