#!/usr/bin/env bash
# Test script for auth + sync flow against wrangler dev (http://localhost:8787)
# Prerequisites: wrangler dev must be running in another terminal
set -euo pipefail

BASE="http://localhost:8787"
EMAIL="test@epicenter.so"
PASSWORD="testpassword123"

echo "=== 1. Health check ==="
curl -s "$BASE/" | jq .

echo ""
echo "=== 2. Run migrations ==="
curl -s -X POST "$BASE/migrate" \
  -H "x-migrate-secret: I2EhbQto4NZT07/EBXEUo9jZiNenuvDMEbWfKSYcnNI=" | jq .

echo ""
echo "=== 3. Sign up ==="
SIGNUP_RESPONSE=$(curl -s -X POST "$BASE/auth/sign-up/email" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$EMAIL\", \"password\": \"$PASSWORD\", \"name\": \"Test User\"}" \
  -D /dev/stderr 2>&1)

# Extract token from set-auth-token header or response body
echo "$SIGNUP_RESPONSE" | head -20
TOKEN=$(echo "$SIGNUP_RESPONSE" | grep -i 'set-auth-token' | awk '{print $2}' | tr -d '\r' || true)

if [ -z "$TOKEN" ]; then
  echo ""
  echo "No set-auth-token header found, trying sign-in instead..."
  echo ""
  echo "=== 3b. Sign in ==="
  SIGNIN_RESPONSE=$(curl -s -X POST "$BASE/auth/sign-in/email" \
    -H "Content-Type: application/json" \
    -d "{\"email\": \"$EMAIL\", \"password\": \"$PASSWORD\"}" \
    -D /dev/stderr 2>&1)
  echo "$SIGNIN_RESPONSE" | head -20
  TOKEN=$(echo "$SIGNIN_RESPONSE" | grep -i 'set-auth-token' | awk '{print $2}' | tr -d '\r' || true)
fi

if [ -z "$TOKEN" ]; then
  echo "ERROR: Could not obtain auth token"
  exit 1
fi

echo ""
echo "=== Got token: ${TOKEN:0:20}... ==="

echo ""
echo "=== 4. Validate session via Bearer token ==="
curl -s "$BASE/auth/get-session" \
  -H "Authorization: Bearer $TOKEN" | jq .

echo ""
echo "=== 5. Test protected route (sync room) ==="
echo "--- Without token (should 401): ---"
curl -s "$BASE/rooms/test-room" | jq .

echo ""
echo "--- With token (should connect or return doc): ---"
curl -s "$BASE/rooms/test-room" \
  -H "Authorization: Bearer $TOKEN" | head -5

echo ""
echo "=== 6. OAuth Discovery ==="
echo "--- OpenID Configuration: ---"
curl -s "$BASE/.well-known/openid-configuration" | jq .

echo ""
echo "--- OAuth Authorization Server: ---"
curl -s "$BASE/.well-known/oauth-authorization-server" | jq .

echo ""
echo "=== Done! ==="
echo "To test WebSocket sync, use wscat or a browser:"
echo "  wscat -c 'ws://localhost:8787/rooms/test-room?token=$TOKEN'"
