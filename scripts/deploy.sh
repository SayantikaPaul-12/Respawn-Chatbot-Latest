#!/usr/bin/env bash
set -euo pipefail

# Deploys the infrastructure stack and Amplify app, then prints outputs.
# Required env vars:
#   AWS_PROFILE
#   AWS_REGION
#   AMPLIFY_REPOSITORY
#   AMPLIFY_OAUTH_TOKEN
#   WEB_CRAWL_SEED_URLS (comma-delimited)
# Optional:
#   AMPLIFY_BRANCH (default: main)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="${ROOT_DIR}/backend/infrastructure/cdk"

AWS_PROFILE="${AWS_PROFILE:-}"
AWS_REGION="${AWS_REGION:-}"
AMPLIFY_REPOSITORY="${AMPLIFY_REPOSITORY:-}"
AMPLIFY_OAUTH_TOKEN="${AMPLIFY_OAUTH_TOKEN:-}"
WEB_CRAWL_SEED_URLS="${WEB_CRAWL_SEED_URLS:-}"
AMPLIFY_BRANCH="${AMPLIFY_BRANCH:-main}"

if [[ -z "${AWS_PROFILE}" || -z "${AWS_REGION}" || -z "${AMPLIFY_REPOSITORY}" || -z "${AMPLIFY_OAUTH_TOKEN}" || -z "${WEB_CRAWL_SEED_URLS}" ]]; then
  echo "Missing required env vars."
  echo "Required: AWS_PROFILE, AWS_REGION, AMPLIFY_REPOSITORY, AMPLIFY_OAUTH_TOKEN, WEB_CRAWL_SEED_URLS"
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI is required but not found on PATH."
  exit 1
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "npx is required but not found on PATH."
  exit 1
fi

# Validate comma-delimited URLs.
IFS="," read -r -a URLS <<< "${WEB_CRAWL_SEED_URLS}"
for url in "${URLS[@]}"; do
  trimmed="$(echo "${url}" | xargs)"
  if [[ -z "${trimmed}" || ! "${trimmed}" =~ ^https?:// ]]; then
    echo "Invalid seed URL: '${url}'. All URLs must start with http:// or https://"
    exit 1
  fi
done

echo "Deploying stack to ${AWS_REGION} with profile ${AWS_PROFILE}..."

pushd "${INFRA_DIR}" >/dev/null
npm install

AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
AWS_PROFILE="${AWS_PROFILE}" AWS_REGION="${AWS_REGION}" npx cdk bootstrap "aws://${AWS_ACCOUNT_ID}/${AWS_REGION}" || true

AWS_PROFILE="${AWS_PROFILE}" AWS_REGION="${AWS_REGION}" npx cdk deploy --require-approval never \
  --parameters WebCrawlSeedUrls="${WEB_CRAWL_SEED_URLS}" \
  --parameters AmplifyRepository="${AMPLIFY_REPOSITORY}" \
  --parameters AmplifyOauthToken="${AMPLIFY_OAUTH_TOKEN}" \
  --parameters AmplifyBranch="${AMPLIFY_BRANCH}"

AWS_PROFILE="${AWS_PROFILE}" AWS_REGION="${AWS_REGION}" npx cdk output
popd >/dev/null

APP_ID="$(AWS_PROFILE="${AWS_PROFILE}" AWS_REGION="${AWS_REGION}" aws amplify list-apps --query "apps[?name=='adaptive-gaming-guide'].appId | [0]" --output text)"
if [[ -n "${APP_ID}" && "${APP_ID}" != "None" ]]; then
  DOMAIN="$(AWS_PROFILE="${AWS_PROFILE}" AWS_REGION="${AWS_REGION}" aws amplify get-app --app-id "${APP_ID}" --query "app.defaultDomain" --output text)"
  if [[ -n "${DOMAIN}" && "${DOMAIN}" != "None" ]]; then
    echo "Amplify app URL: https://${AMPLIFY_BRANCH}.${DOMAIN}"
    echo "Amplify app URL: https://${AMPLIFY_BRANCH}.${DOMAIN}" > "${ROOT_DIR}/amplify-url.txt"
  fi
fi

echo "Deployment complete."
