#!/bin/bash
set -e

# Configuration
PROJECT_ID="${GCP_PROJECT_ID:-}"

if [ -z "$PROJECT_ID" ]; then
  echo "Error: GCP_PROJECT_ID environment variable is required"
  exit 1
fi

echo "Setting up secrets for project: $PROJECT_ID"
echo ""
echo "This script will help you create the required secrets in Secret Manager."
echo "You will need:"
echo "  - Google OAuth client ID and secret"
echo "  - Google OAuth refresh token"
echo ""

# Function to create or update secret
create_secret() {
  local name=$1
  local prompt=$2

  echo ""
  echo "========================================"
  read -sp "$prompt: " value
  echo ""

  if gcloud secrets describe "$name" --project="$PROJECT_ID" &>/dev/null; then
    echo "Updating existing secret: $name"
    echo -n "$value" | gcloud secrets versions add "$name" \
      --data-file=- \
      --project="$PROJECT_ID"
  else
    echo "Creating new secret: $name"
    echo -n "$value" | gcloud secrets create "$name" \
      --data-file=- \
      --replication-policy="automatic" \
      --project="$PROJECT_ID"
  fi

  echo "Secret '$name' saved."
}

# Google OAuth credentials
create_secret "google-oauth-client-id" "Enter Google OAuth Client ID"
create_secret "google-oauth-client-secret" "Enter Google OAuth Client Secret"
create_secret "google-tasks-refresh-token" "Enter Google OAuth Refresh Token"

# Grant the Cloud Function access to secrets
SA_EMAIL=$(gcloud functions describe tasks-sync \
  --gen2 \
  --region="${GCP_REGION:-us-central1}" \
  --project="$PROJECT_ID" \
  --format='value(serviceConfig.serviceAccountEmail)' 2>/dev/null || echo "")

if [ -n "$SA_EMAIL" ]; then
  echo ""
  echo "Granting secret access to Cloud Function service account..."

  for secret in "google-oauth-client-id" "google-oauth-client-secret" "google-tasks-refresh-token"; do
    gcloud secrets add-iam-policy-binding "$secret" \
      --member="serviceAccount:$SA_EMAIL" \
      --role="roles/secretmanager.secretAccessor" \
      --project="$PROJECT_ID" \
      --quiet
  done
fi

echo ""
echo "========================================="
echo "Secrets setup complete!"
echo "========================================="
