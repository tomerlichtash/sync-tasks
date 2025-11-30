# iOS Reminders → Google Tasks Sync

Automatically sync your iOS Reminders to Google Tasks. Reminders are synced to matching Google Tasks lists (created automatically if they don't exist).

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Mac (launchd)  │────▶│  Cloud Function  │────▶│  Google Tasks   │
│  EventKit CLI   │     │  (GCP)           │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
        │
        ▼
  Local Reminders
   (syncs via iCloud)
```

- **Local Swift CLI** reads reminders via EventKit (runs every 15 min)
- **Cloud Function** creates tasks in Google Tasks
- Lists are created dynamically to match your iOS Reminder lists

## Prerequisites

- macOS with Reminders app
- Google Cloud account (free tier is sufficient)
- Node.js 20+
- Swift 5.9+

## Setup

### 1. Clone and Install

```bash
cd /path/to/tasks-sync
cp .env.example .env
npm install
```

### 2. Configure Environment

Edit `.env` with your values:

```bash
# Google Cloud Project ID
GCP_PROJECT_ID=my-project-123

# Google OAuth credentials (from step 4)
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REFRESH_TOKEN=your-refresh-token

# Webhook secret (generate with: openssl rand -hex 16)
WEBHOOK_SECRET=your-webhook-secret
```

The `.env` file is gitignored. For local development, secrets are read from `.env`. In production (Cloud Function), they're read from Secret Manager.

### 3. Google Cloud Project Setup

```bash
source .env

# Enable APIs
gcloud services enable \
  cloudfunctions.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  --project=$GCP_PROJECT_ID

# Create Firestore database
gcloud firestore databases create --location=us-central1 --project=$GCP_PROJECT_ID
```

### 4. Google OAuth Setup

1. Go to [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Create OAuth 2.0 Client ID (Desktop app type)
3. Configure OAuth consent screen:
   - Add yourself as a test user
   - Add scope: `https://www.googleapis.com/auth/tasks`
4. Get refresh token:

```bash
npx ts-node deploy/get-google-token.ts YOUR_CLIENT_ID YOUR_CLIENT_SECRET
```

### 5. Store Secrets

```bash
source .env

# Run interactive setup
./deploy/setup-secrets.sh

# Or manually create secrets:
echo -n "your-value" | gcloud secrets create SECRET_NAME --data-file=- --project=$GCP_PROJECT_ID
```

Required secrets:
- `google-oauth-client-id` - From step 4
- `google-oauth-client-secret` - From step 4
- `google-tasks-refresh-token` - From step 4

### 6. Deploy Cloud Function

```bash
source .env

# Build
npm run build

# Deploy
gcloud functions deploy tasks-sync \
  --gen2 \
  --region=us-central1 \
  --source=. \
  --entry-point=syncHandler \
  --allow-unauthenticated \
  --update-env-vars="WEBHOOK_SECRET=$(openssl rand -hex 16),GCP_PROJECT_ID=$GCP_PROJECT_ID" \
  --project=$GCP_PROJECT_ID

# Get the function URL and webhook secret (save these!)
gcloud functions describe tasks-sync \
  --gen2 \
  --region=us-central1 \
  --project=$GCP_PROJECT_ID \
  --format='value(serviceConfig.uri)'

gcloud functions describe tasks-sync \
  --gen2 \
  --region=us-central1 \
  --project=$GCP_PROJECT_ID \
  --format='value(serviceConfig.environmentVariables.WEBHOOK_SECRET)'
```

### 7. Build Local CLI

```bash
cd local
swift build -c release
```

### 8. Test Manually

```bash
WEBHOOK_URL="https://YOUR_FUNCTION_URL" \
WEBHOOK_SECRET="YOUR_SECRET" \
./local/.build/release/tasks-sync
```

First run will prompt for Reminders access - grant it in System Settings → Privacy & Security → Reminders.

## Automation (launchd)

Run the sync automatically every 15 minutes using the provided scripts:

```bash
cd local

# Install and start (builds automatically if needed)
WEBHOOK_URL="https://YOUR_FUNCTION_URL" \
WEBHOOK_SECRET="YOUR_SECRET" \
./install.sh

# Check status and logs
./status.sh

# Stop automation
./stop.sh

# Start automation
./start.sh

# Uninstall completely
./uninstall.sh
```

## CLI Options

```bash
# Normal sync (only new reminders)
./local/.build/release/tasks-sync

# Reset local state and re-sync all reminders
./local/.build/release/tasks-sync --reset

# Force re-sync everything (may create duplicates)
./local/.build/release/tasks-sync --force
```

## How It Works

1. **Local CLI** uses EventKit to read incomplete reminders from your Mac
2. Each reminder is sent to the **Cloud Function** via webhook
3. Cloud Function finds/creates matching Google Tasks list
4. Task is created in Google Tasks
5. Sync state is saved locally (`~/.tasks-sync-state.json`) to avoid duplicates

## File Structure

```
tasks-sync/
├── src/                      # Cloud Function (TypeScript)
│   ├── index.ts              # HTTP handler
│   ├── google/tasks.ts       # Google Tasks API client
│   ├── storage/firestore.ts  # State tracking
│   └── config/secrets.ts     # Secret Manager
├── local/                    # Local CLI (Swift)
│   ├── Sources/main.swift    # EventKit sync
│   ├── Package.swift
│   ├── install.sh            # Install automation
│   ├── start.sh              # Start automation
│   ├── stop.sh               # Stop automation
│   ├── status.sh             # Check status
│   └── uninstall.sh          # Remove automation
├── deploy/
│   ├── setup-secrets.sh
│   └── get-google-token.ts
├── .env.example
└── package.json
```

## Cost

All within GCP free tier for personal use:
- Cloud Functions: 2M invocations/month free
- Firestore: 50K reads/day free
- Secret Manager: 10K accesses/month free

## Troubleshooting

**"Invalid webhook secret"**
- Check your `WEBHOOK_SECRET` matches what's deployed
- Get current secret: `gcloud functions describe tasks-sync --gen2 --region=us-central1 --format='value(serviceConfig.environmentVariables.WEBHOOK_SECRET)'`

**"Access to Reminders was denied"**
- Go to System Settings → Privacy & Security → Reminders
- Enable access for the tasks-sync binary

**Tasks not appearing in correct list**
- Check Cloud Function logs: `gcloud functions logs read tasks-sync --gen2 --region=us-central1 --limit=20`
- Look for "Using task list" entries

**Duplicate tasks**
- Delete `~/.tasks-sync-state.json` and tasks in Google, then run with `--reset`

## License

MIT
