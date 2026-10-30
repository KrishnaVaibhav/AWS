#!/usr/bin/env bash
# Deploys auction-<stage>, publishes the web app, then smoke-tests it.
#
#   auction/scripts/deploy.sh dev              deploy + publish + smoke test
#   auction/scripts/deploy.sh prod --preview   change set only, applies nothing
#
# Needs: AWS CLI v2, SAM CLI, credentials for the target account.
set -euo pipefail

STAGE="${1:-}"
MODE="${2:-}"
case "$STAGE" in
  dev|prod) ;;
  *) echo "usage: $0 <dev|prod> [--preview]" >&2; exit 2 ;;
esac

export AWS_REGION="${AWS_REGION:-us-east-1}"
STACK="auction-$STAGE"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# prod keeps the table and user pool undeletable until destroy.sh unlocks them.
PROTECT=false
if [ "$STAGE" = prod ]; then PROTECT=true; fi

# AppSync API keys live at most 365 days. Every deploy moves the expiry to
# today + 360 days, so the key only lapses after a year without a deploy.
EXPIRES=$(( ( $(date +%s) / 86400 + 360 ) * 86400 ))

SAM_ARGS=(
  --template-file "$ROOT/template.yaml"
  --stack-name "$STACK"
  --region "$AWS_REGION"
  --resolve-s3
  --s3-prefix "$STACK"
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND
  --tags app=auction "stage=$STAGE"
  --parameter-overrides "Stage=$STAGE" "DataProtection=$PROTECT" "ApiKeyExpires=$EXPIRES"
  --no-fail-on-empty-changeset
)

if [ "$MODE" = --preview ]; then
  echo "📋 Change set for $STACK (nothing is applied)"
  sam deploy "${SAM_ARGS[@]}" --no-execute-changeset
  exit 0
fi

echo "🚀 Deploying $STACK ($AWS_REGION)"
sam deploy "${SAM_ARGS[@]}" --no-confirm-changeset

# Outputs as "key<TAB>value" lines. tr drops the CR the Windows AWS CLI adds.
OUTPUTS=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text | tr -d '\r')
out() { awk -F '\t' -v k="$1" '$1 == k { print $2 }' <<<"$OUTPUTS"; }

WEB_BUCKET=$(out WebBucketName)
APP_URL=$(out AppUrl)

echo "🌐 Publishing web/ to s3://$WEB_BUCKET"
CONFIG=$(mktemp)
cat >"$CONFIG" <<EOF
{
  "stage": "$STAGE",
  "region": "$AWS_REGION",
  "userPoolId": "$(out UserPoolId)",
  "userPoolClientId": "$(out UserPoolClientId)",
  "cognitoDomain": "$(out CognitoDomain)",
  "eventsHttp": "$(out EventsHttpDomain)",
  "eventsRealtime": "$(out EventsRealtimeDomain)",
  "eventsApiKey": "$(out EventsApiKey)"
}
EOF
aws s3 sync "$ROOT/web" "s3://$WEB_BUCKET" --delete --exclude config.json --cache-control no-cache
aws s3 cp "$CONFIG" "s3://$WEB_BUCKET/config.json" --cache-control no-cache --content-type application/json
rm -f "$CONFIG"

# MSYS_NO_PATHCONV stops Git Bash from rewriting '/*' into a Windows path.
MSYS_NO_PATHCONV=1 aws cloudfront create-invalidation \
  --distribution-id "$(out DistributionId)" --paths '/*' \
  --query 'Invalidation.Id' --output text

echo "🩺 Smoke test: $APP_URL/api/health"
for _ in $(seq 1 12); do
  if curl -fsS "$APP_URL/api/health"; then
    echo
    echo "✅ $STACK is live at $APP_URL"
    exit 0
  fi
  sleep 10
done
echo "❌ $APP_URL/api/health did not answer within 2 minutes" >&2
exit 1
