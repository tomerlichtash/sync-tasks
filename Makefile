include .env
export

REGION := us-central1
FUNCTION_NAME := tasks-sync

# Get webhook URL from deployed function
WEBHOOK_URL := $(shell gcloud functions describe $(FUNCTION_NAME) --gen2 --region=$(REGION) --project=$(GCP_PROJECT_ID) --format='value(serviceConfig.uri)')

.PHONY: build test deploy sync sync-force sync-reset build-swift logs lint lint-swift format-swift

# Build TypeScript
build:
	npm run build

# Run tests
test:
	npm test

# Deploy Cloud Function
deploy: build
	gcloud functions deploy $(FUNCTION_NAME) \
		--gen2 \
		--runtime=nodejs20 \
		--trigger-http \
		--entry-point=syncHandler \
		--source=. \
		--allow-unauthenticated \
		--region=$(REGION) \
		--project=$(GCP_PROJECT_ID)

# Build Swift CLI
build-swift:
	cd local && swift build -c release

# Sync reminders
sync:
	WEBHOOK_URL=$(WEBHOOK_URL) WEBHOOK_SECRET=$(WEBHOOK_SECRET) ./local/.build/release/tasks-sync

# Force sync all reminders (updates existing)
sync-force:
	WEBHOOK_URL=$(WEBHOOK_URL) WEBHOOK_SECRET=$(WEBHOOK_SECRET) ./local/.build/release/tasks-sync --force

# Reset sync state and sync all
sync-reset:
	WEBHOOK_URL=$(WEBHOOK_URL) WEBHOOK_SECRET=$(WEBHOOK_SECRET) ./local/.build/release/tasks-sync --reset

# View Cloud Function logs
logs:
	gcloud functions logs read $(FUNCTION_NAME) --gen2 --region=$(REGION) --project=$(GCP_PROJECT_ID) --limit=50

# Lint TypeScript
lint:
	npm run lint

# Lint Swift
lint-swift:
	swift-format lint local/Sources/main.swift

# Format Swift
format-swift:
	swift-format format -i local/Sources/main.swift
