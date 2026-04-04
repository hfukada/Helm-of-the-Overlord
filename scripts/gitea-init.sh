#!/bin/sh
# Gitea entrypoint wrapper: creates the admin user on first boot,
# then hands off to the real Gitea entrypoint.

MARKER="/data/gitea/.hoto-initialized"
TOKEN_FILE="/data/gitea/hoto-admin-token"

# Start Gitea in the background so we can run admin commands
/usr/bin/entrypoint &
GITEA_PID=$!

# Wait for Gitea to be ready
echo "[hoto-init] Waiting for Gitea to start..."
for i in $(seq 1 60); do
  if wget -q -O /dev/null http://127.0.0.1:3777/api/v1/version 2>/dev/null; then
    break
  fi
  sleep 1
done

if [ ! -f "$MARKER" ]; then
  echo "[hoto-init] First boot -- configuring Gitea..."

  # Enable push-create for users and orgs
  grep -q ENABLE_PUSH_CREATE_ORG /data/gitea/conf/app.ini 2>/dev/null || cat >> /data/gitea/conf/app.ini <<'APPINI'

[repository]
ENABLE_PUSH_CREATE_USER = true
ENABLE_PUSH_CREATE_ORG = true
APPINI

  echo "[hoto-init] Creating admin user..."

  OUTPUT=$(gitea admin user create \
    --username hoto-admin \
    --password hoto-admin-default \
    --email hoto-admin@localhost \
    --admin \
    --access-token \
    --must-change-password=false 2>&1)

  echo "[hoto-init] gitea output: $OUTPUT"

  # Extract token: look for a 40-char hex string after ":" on the access token line
  TOKEN=$(echo "$OUTPUT" | grep -i "access token" | sed 's/.*: //' | tr -d '[:space:]')

  if [ -n "$TOKEN" ]; then
    echo "$TOKEN" > "$TOKEN_FILE"
    echo "[hoto-init] Admin token written to $TOKEN_FILE"
  else
    echo "[hoto-init] Warning: could not extract token from output"
  fi

  touch "$MARKER"
  echo "[hoto-init] Initialization complete."
else
  echo "[hoto-init] Already initialized, skipping."
fi

# Wait for Gitea process
wait $GITEA_PID
