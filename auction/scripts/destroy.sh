#!/usr/bin/env bash
# Deletes auction-<stage> completely: table, user pool, both buckets and
# everything in them, CloudFront, functions, schedules, logs. No undo.
#
#   auction/scripts/destroy.sh dev
#
# Safe to re-run: it picks up from wherever a previous attempt stopped.
# Needs: AWS CLI v2, credentials for the target account.
set -euo pipefail

STAGE="${1:-}"
case "$STAGE" in
  dev|prod) ;;
  *) echo "usage: $0 <dev|prod>" >&2; exit 2 ;;
esac

export AWS_REGION="${AWS_REGION:-us-east-1}"
STACK="auction-$STAGE"

# tr drops the CR the Windows AWS CLI adds under Git Bash.
stack_query() {
  aws cloudformation describe-stacks --stack-name "$STACK" --query "$1" --output text | tr -d '\r'
}
physical_id() {
  aws cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id "$1" \
    --query 'StackResourceDetail.PhysicalResourceId' --output text 2>/dev/null | tr -d '\r' || true
}

if ! STATUS=$(stack_query 'Stacks[0].StackStatus' 2>/dev/null); then
  echo "ℹ️ $STACK does not exist. Nothing to delete."
  exit 0
fi
echo "💥 Destroying $STACK (status: $STATUS)"

# 1. Unlock the table and the user pool.
PROTECT=$(stack_query "Stacks[0].Parameters[?ParameterKey=='DataProtection'].ParameterValue")
if [ "$PROTECT" = true ]; then
  case "$STATUS" in
    CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE|IMPORT_COMPLETE)
      # Through CloudFormation, so the stack's own record stays accurate.
      echo "🔓 DataProtection -> false"
      PARAMS=()
      for key in $(stack_query 'Stacks[0].Parameters[].ParameterKey'); do
        if [ "$key" = DataProtection ]; then
          PARAMS+=("ParameterKey=$key,ParameterValue=false")
        else
          PARAMS+=("ParameterKey=$key,UsePreviousValue=true")
        fi
      done
      aws cloudformation update-stack --stack-name "$STACK" --use-previous-template \
        --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --parameters "${PARAMS[@]}" >/dev/null
      aws cloudformation wait stack-update-complete --stack-name "$STACK"
      ;;
    *)
      # Stack can't take an update (e.g. DELETE_FAILED). Unlock the resources directly.
      echo "🔓 $STATUS can't be updated, unlocking resources directly"
      TABLE=$(physical_id Table)
      POOL=$(physical_id UserPool)
      if [ -n "$TABLE" ]; then
        aws dynamodb update-table --table-name "$TABLE" --no-deletion-protection-enabled >/dev/null || true
      fi
      if [ -n "$POOL" ]; then
        # update-user-pool resets every setting it isn't given. Harmless here:
        # the pool is deleted next.
        aws cognito-idp update-user-pool --user-pool-id "$POOL" --deletion-protection INACTIVE >/dev/null || true
      fi
      ;;
  esac
fi

# 2. CloudFormation can't delete a bucket that still holds objects.
empty_bucket() {
  local bucket="$1" batch
  if [ -z "$bucket" ] || [ "$bucket" = None ]; then return 0; fi
  if ! aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then return 0; fi
  echo "🪣 Emptying s3://$bucket"
  # One page per round (max 1000 = the delete-objects limit): current
  # objects, old versions and delete markers alike.
  while :; do
    # shellcheck disable=SC2016  # the backticks are a JMESPath literal, not shell
    batch=$(aws s3api list-object-versions --bucket "$bucket" --no-paginate --max-keys 1000 \
      --query '{Objects: [Versions, DeleteMarkers][].{Key: Key, VersionId: VersionId}, Quiet: `true`}' \
      --output json | tr -d '\r')
    case "$batch" in *'"Key"'*) ;; *) break ;; esac
    aws s3api delete-objects --bucket "$bucket" --delete "$batch" >/dev/null
  done
}
empty_bucket "$(physical_id WebBucket)"
empty_bucket "$(physical_id MediaBucket)"

# 3. Delete. CloudFront takes ~15 minutes to disable and remove.
echo "🗑️ Deleting stack $STACK"
aws cloudformation delete-stack --stack-name "$STACK"
if ! aws cloudformation wait stack-delete-complete --stack-name "$STACK"; then
  echo "❌ Delete did not finish. Check the stack events, then re-run this script." >&2
  exit 1
fi
echo "✅ $STACK deleted"
