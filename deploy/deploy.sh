#!/bin/bash
set -e

# Configuration
PROJECT_ID="${GCP_PROJECT_ID:-}"
REGION="${GCP_REGION:-us-central1}"
FUNCTION_NAME="tasks-sync"
SCHEDULER_NAME="tasks-sync-scheduler"

if [ -z "$PROJECT_ID" ]; then
  echo "Error: GCP_PROJECT_ID environment variable is required"
  exit 1
fi

echo "Deploying to project: $PROJECT_ID in region: $REGION"

# Enable required APIs
echo "Enabling required APIs..."
gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudscheduler.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  tasks.googleapis.com \
  --project="$PROJECT_ID"

# Build TypeScript
echo "Building TypeScript..."
npm run build

# Deploy Cloud Function
echo "Deploying Cloud Function..."
gcloud functions deploy "$FUNCTION_NAME" \
  --gen2 \
  --runtime=nodejs20 \
  --region="$REGION" \
  --source=. \
  --entry-point=syncHandler \
  --trigger-http \
  --no-allow-unauthenticated \
  --memory=256MB \
  --timeout=60s \
  --set-env-vars="GCP_PROJECT_ID=$PROJECT_ID" \
  --project="$PROJECT_ID"

# Get the function URL
FUNCTION_URL=$(gcloud functions describe "$FUNCTION_NAME" \
  --gen2 \
  --region="$REGION" \
  --project="$PROJECT_ID" \
  --format='value(serviceConfig.uri)')

echo "Function deployed at: $FUNCTION_URL"

# Create service account for scheduler (if not exists)
SA_NAME="tasks-sync-scheduler-sa"
SA_EMAIL="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"

if ! gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" &>/dev/null; then
  echo "Creating service account..."
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="Tasks Sync Scheduler SA" \
    --project="$PROJECT_ID"
fi

# Grant invoker permission to service account
echo "Granting invoker permission..."
gcloud functions add-invoker-policy-binding "$FUNCTION_NAME" \
  --gen2 \
  --region="$REGION" \
  --member="serviceAccount:$SA_EMAIL" \
  --project="$PROJECT_ID" || true

# Create Cloud Scheduler job (delete first if exists)
echo "Setting up Cloud Scheduler..."
gcloud scheduler jobs delete "$SCHEDULER_NAME" \
  --location="$REGION" \
  --project="$PROJECT_ID" \
  --quiet 2>/dev/null || true

gcloud scheduler jobs create http "$SCHEDULER_NAME" \
  --location="$REGION" \
  --schedule="*/15 * * * *" \
  --uri="$FUNCTION_URL" \
  --http-method=POST \
  --oidc-service-account-email="$SA_EMAIL" \
  --project="$PROJECT_ID"

echo ""
echo "========================================="
echo "Deployment complete!"
echo "========================================="
echo ""
echo "Function URL: $FUNCTION_URL"
echo "Scheduler: Running every 15 minutes"
echo ""
echo "Next steps:"
echo "1. Set up secrets in Secret Manager (see setup-secrets.sh)"
echo "2. Create Firestore database if not exists"
echo "3. Test manually: gcloud scheduler jobs run $SCHEDULER_NAME --location=$REGION"
