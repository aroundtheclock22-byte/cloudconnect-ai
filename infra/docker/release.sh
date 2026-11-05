#!/bin/sh
# Pre-deploy (release) command: apply migrations, optionally seed the demo tenant. Idempotent.
set -e
node scripts/migrate.js
if [ "$SEED_DEMO" = "true" ]; then node build/scripts/seed.js; fi
