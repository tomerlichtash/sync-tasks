include .env
export

FUNCTION_NAME := sync-tasks
SERVER_DIR := packages/server
CLI_DIR := packages/cli

# Get webhook URL from deployed function (lazy evaluation)
WEBHOOK_URL = $(shell gcloud functions describe $(FUNCTION_NAME) --gen2 --region=$(GCP_REGION) --project=$(GCP_PROJECT_ID) --format='value(serviceConfig.uri)' 2>/dev/null)

.PHONY: build test deploy sync sync-force sync-reset build-swift logs lint lint-swift format-swift

# Build TypeScript
build:
	cd $(SERVER_DIR) && npm run build

# Run tests
test:
	cd $(SERVER_DIR) && npm test

# Deploy Cloud Function
deploy: build
	cd $(SERVER_DIR) && gcloud functions deploy $(FUNCTION_NAME) \
		--gen2 \
		--runtime=nodejs20 \
		--trigger-http \
		--entry-point=syncHandler \
		--source=. \
		--allow-unauthenticated \
		--region=$(GCP_REGION) \
		--project=$(GCP_PROJECT_ID)

# Build Swift CLI
build-swift:
	cd $(CLI_DIR) && swift build -c release

# Sync reminders with optional flags
# Usage: make sync [ARGS="--force|--reset"]
sync:
	WEBHOOK_URL=$(WEBHOOK_URL) WEBHOOK_SECRET=$(WEBHOOK_SECRET) $(CLI_DIR)/.build/release/sync-tasks $(ARGS)

# Force sync all reminders (updates existing)
sync-force:
	$(MAKE) sync ARGS="--force"

# Reset sync state and sync all
sync-reset:
	$(MAKE) sync ARGS="--reset"

# View Cloud Function logs
logs:
	gcloud functions logs read $(FUNCTION_NAME) --gen2 --region=$(GCP_REGION) --project=$(GCP_PROJECT_ID) --limit=50

# Lint TypeScript
lint:
	cd $(SERVER_DIR) && npm run lint

# Lint Swift
lint-swift:
	swift-format lint $(CLI_DIR)/Sources/TasksSync/main.swift

# Format Swift
format-swift:
	swift-format format -i $(CLI_DIR)/Sources/TasksSync/main.swift

# Install dependencies
install:
	cd $(SERVER_DIR) && npm ci
