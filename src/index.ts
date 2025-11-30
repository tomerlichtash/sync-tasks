import * as functions from '@google-cloud/functions-framework';
import { loadSecrets } from './config/secrets';
import { GoogleTasksClient } from './google/tasks';
import { saveSyncedItem, getSyncedItem } from './storage/firestore';
import { Timestamp } from '@google-cloud/firestore';
import * as crypto from 'crypto';

interface WebhookPayload {
  title: string;
  notes?: string;
  list?: string;
  dueDate?: string;
  uid?: string;
  force?: boolean;  // Force re-sync even if already synced
}

interface SyncResponse {
  success: boolean;
  message: string;
  taskId?: string;
  timestamp: string;
}

async function createTaskFromWebhook(payload: WebhookPayload): Promise<SyncResponse> {
  console.log('Received webhook payload:', JSON.stringify(payload));
  console.log(`List name: "${payload.list}"`);

  if (!payload.title) {
    return {
      success: false,
      message: 'Missing required field: title',
      timestamp: new Date().toISOString(),
    };
  }

  // Generate a UID if not provided
  const uid = payload.uid || crypto.randomUUID();

  // Check if already synced (idempotency) - but allow force re-sync
  const existing = await getSyncedItem(uid);
  if (existing && !payload.force) {
    console.log(`Reminder ${uid} already synced as task ${existing.googleTaskId}`);
    return {
      success: true,
      message: 'Already synced',
      taskId: existing.googleTaskId,
      timestamp: new Date().toISOString(),
    };
  }

  // Load secrets and create Google Tasks client
  const secrets = await loadSecrets();
  const defaultListId = process.env.GOOGLE_TASKS_LIST_ID || '';

  const googleClient = new GoogleTasksClient(
    secrets.googleClientId,
    secrets.googleClientSecret,
    secrets.googleRefreshToken,
    defaultListId
  );

  // Parse due date if provided
  let dueDate: Date | undefined;
  if (payload.dueDate) {
    dueDate = new Date(payload.dueDate);
    if (isNaN(dueDate.getTime())) {
      dueDate = undefined;
    }
  }

  // Find or create the matching task list based on reminder's list name
  let targetListId: string;
  const listName = payload.list || 'Reminders';  // Default list name if none provided

  try {
    targetListId = await googleClient.findOrCreateTaskList(listName);
    console.log(`Using task list "${listName}" (${targetListId})`);
  } catch (err) {
    console.error(`Failed to find/create list "${listName}": ${err}`);
    throw new Error(`Cannot create task list: ${err}`);
  }

  // Create task in Google Tasks
  const taskId = await googleClient.createTaskInList(targetListId, {
    title: payload.title,
    notes: payload.notes || undefined,
    due: dueDate,
  });

  console.log(`Created Google Task: ${taskId}`);

  // Save sync record
  await saveSyncedItem({
    icloudUid: uid,
    googleTaskId: taskId,
    title: payload.title,
    syncedAt: Timestamp.now(),
    lastModified: Timestamp.now(),
    completed: false,
  });

  return {
    success: true,
    message: 'Task created successfully',
    taskId,
    timestamp: new Date().toISOString(),
  };
}

// Cloud Function HTTP handler
functions.http('syncHandler', async (req, res) => {
  // Set CORS headers for iOS Shortcuts
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  // Verify webhook secret if configured
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookSecret) {
    const providedSecret = req.headers['x-webhook-secret'] || req.query.secret;
    if (providedSecret !== webhookSecret) {
      console.warn('Invalid webhook secret');
      res.status(401).json({ success: false, error: 'Unauthorized' });
      return;
    }
  }

  try {
    if (req.method === 'POST') {
      // Webhook from iOS Shortcuts
      const payload: WebhookPayload = req.body;
      const response = await createTaskFromWebhook(payload);

      res.status(response.success ? 200 : 400).json(response);
    } else if (req.method === 'GET') {
      // Health check / manual test
      res.status(200).json({
        success: true,
        message: 'Tasks Sync webhook is running. Send POST requests with reminder data.',
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(405).json({ success: false, error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
});
