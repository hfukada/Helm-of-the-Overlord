#!/bin/bash
# Generate Synapse config on first run if it doesn't exist
if [ ! -f /data/homeserver.yaml ]; then
  python -m synapse.app.homeserver \
    --server-name localhost \
    --config-path /data/homeserver.yaml \
    --generate-config \
    --report-stats no

  # Bind to all interfaces so the container port is reachable
  sed -i "s/- ::1/- '::'/" /data/homeserver.yaml
  sed -i "s/- 127.0.0.1/- 0.0.0.0/" /data/homeserver.yaml

  # Enable registration without email verification
  cat >> /data/homeserver.yaml <<'EOF'

enable_registration: true
enable_registration_without_verification: true
EOF
fi

# Start Synapse
exec python -m synapse.app.homeserver --config-path /data/homeserver.yaml
