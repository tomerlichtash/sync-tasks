import * as functions from '@google-cloud/functions-framework';
import { Request, Response } from '@google-cloud/functions-framework';
import { loadSecrets } from './config/secrets';
import { GoogleTasksClient } from './google/tasks';
import {
  saveSyncedItem,
  getSyncedItem,
  getAllSyncedItems,
  updateSyncedItem,
} from './storage/firestore';
import { Timestamp } from '@google-cloud/firestore';
import * as crypto from 'crypto';

export interface WebhookPayload {
  title: string;
  notes?: string;
  list?: string;
  dueDate?: string;
  uid?: string;
  force?: boolean; // Force re-sync even if already synced
}

export interface SyncResponse {
  success: boolean;
  message: string;
  taskId?: string;
  timestamp: string;
}

export interface CompletedTask {
  uid: string;
  title: string;
  completedAt?: string;
}

export interface CompletedTasksResponse {
  success: boolean;
  completed: CompletedTask[];
  timestamp: string;
}

export interface NewTask {
  googleTaskId: string;
  googleListId: string;
  listName: string;
  title: string;
  notes?: string;
  due?: string;
  completed: boolean;
}

export interface NewTasksResponse {
  success: boolean;
  tasks: NewTask[];
  timestamp: string;
}

export interface RegisterTaskPayload {
  googleTaskId: string;
  googleListId: string;
  icloudUid: string;
  title: string;
  completed: boolean;
}

export interface SyncedItem {
  icloudUid: string;
  googleTaskId: string;
  googleListId: string;
  title: string;
  completed: boolean;
}

export interface IncompleteSyncedItemsResponse {
  success: boolean;
  items: SyncedItem[];
  timestamp: string;
}

export interface CompleteTaskPayload {
  icloudUid: string;
  completed: boolean;
}

export interface StatusChange {
  uid: string;
  title: string;
  completed: boolean;
  changedAt?: string;
}

export interface StatusChangesResponse {
  success: boolean;
  changes: StatusChange[];
  timestamp: string;
}

export async function getGoogleStatusChanges(): Promise<StatusChangesResponse> {
  console.log('Fetching status changes from Google');

  // Load secrets and create Google Tasks client
  const secrets = await loadSecrets();
  const googleClient = new GoogleTasksClient(
    secrets.googleClientId,
    secrets.googleClientSecret,
    secrets.googleRefreshToken,
    ''
  );

  // Get all synced items from Firestore
  const syncedItems = await getAllSyncedItems();
  const changes: StatusChange[] = [];

  // Check each synced item's completion status in Google Tasks
  for (const [uid, item] of syncedItems) {
    const task = await googleClient.getTask(item.googleListId, item.googleTaskId);
    if (!task) continue;

    const googleCompleted = task.status === 'completed';
    const firestoreCompleted = item.completed || false;

    // Check if status differs
    if (googleCompleted !== firestoreCompleted) {
      const action = googleCompleted ? 'completed' : 'uncompleted';
      console.log(`Task ${item.title} (${uid}) is ${action} in Google`);

      // Update Firestore to match Google status
      await updateSyncedItem(uid, { completed: googleCompleted });

      changes.push({
        uid,
        title: item.title,
        completed: googleCompleted,
        changedAt: googleCompleted ? (task.completed || undefined) : undefined,
      });
    }
  }

  console.log(`Found ${changes.length} status changes from Google`);

  return {
    success: true,
    changes,
    timestamp: new Date().toISOString(),
  };
}

export async function getNewTasks(): Promise<NewTasksResponse> {
  console.log('Fetching new tasks from Google (not synced from Apple)');

  // Load secrets and create Google Tasks client
  const secrets = await loadSecrets();
  const googleClient = new GoogleTasksClient(
    secrets.googleClientId,
    secrets.googleClientSecret,
    secrets.googleRefreshToken,
    ''
  );

  // Get all synced items from Firestore (keyed by iCloud UID)
  const syncedItems = await getAllSyncedItems();

  // Build a set of Google Task IDs that are already synced
  const syncedGoogleTaskIds = new Set<string>();
  for (const [, item] of syncedItems) {
    syncedGoogleTaskIds.add(item.googleTaskId);
  }

  // Get all task lists
  const taskLists = await googleClient.getTaskLists();
  const newTasks: NewTask[] = [];

  // Check each list for tasks not in our sync records
  for (const list of taskLists) {
    if (!list.id || !list.title) continue;

    const tasks = await googleClient.listTasksInList(list.id);

    for (const task of tasks) {
      if (!task.id || !task.title) continue;

      // Skip if already synced (exists in Firestore)
      if (syncedGoogleTaskIds.has(task.id)) {
        continue;
      }

      // Skip deleted tasks
      if (task.deleted) {
        continue;
      }

      newTasks.push({
        googleTaskId: task.id,
        googleListId: list.id,
        listName: list.title,
        title: task.title,
        notes: task.notes || undefined,
        due: task.due || undefined,
        completed: task.status === 'completed',
      });
    }
  }

  console.log(`Found ${newTasks.length} new tasks from Google`);

  return {
    success: true,
    tasks: newTasks,
    timestamp: new Date().toISOString(),
  };
}

export async function registerSyncedTask(payload: RegisterTaskPayload): Promise<SyncResponse> {
  console.log('Registering reverse-synced task:', JSON.stringify(payload));

  // Save sync record for a task created in Google and imported to Apple
  await saveSyncedItem({
    icloudUid: payload.icloudUid,
    googleTaskId: payload.googleTaskId,
    googleListId: payload.googleListId,
    title: payload.title,
    syncedAt: Timestamp.now(),
    lastModified: Timestamp.now(),
    completed: payload.completed,
  });

  return {
    success: true,
    message: 'Task registered successfully',
    taskId: payload.googleTaskId,
    timestamp: new Date().toISOString(),
  };
}

export async function getSyncedItems(): Promise<IncompleteSyncedItemsResponse> {
  console.log('Fetching all synced items for status check');

  // Get all synced items from Firestore
  const syncedItems = await getAllSyncedItems();
  const items: SyncedItem[] = [];

  // Return all items with their completion status
  for (const [uid, item] of syncedItems) {
    items.push({
      icloudUid: uid,
      googleTaskId: item.googleTaskId,
      googleListId: item.googleListId,
      title: item.title,
      completed: item.completed || false,
    });
  }

  console.log(`Found ${items.length} synced items`);

  return {
    success: true,
    items,
    timestamp: new Date().toISOString(),
  };
}

export async function updateTaskStatus(payload: CompleteTaskPayload): Promise<SyncResponse> {
  const action = payload.completed ? 'completed' : 'incomplete';
  console.log(`Marking task as ${action}:`, payload.icloudUid);

  // Get the synced item to find the Google Task ID
  const syncedItem = await getSyncedItem(payload.icloudUid);
  if (!syncedItem) {
    return {
      success: false,
      message: 'Synced item not found',
      timestamp: new Date().toISOString(),
    };
  }

  // Load secrets and create Google Tasks client
  const secrets = await loadSecrets();
  const googleClient = new GoogleTasksClient(
    secrets.googleClientId,
    secrets.googleClientSecret,
    secrets.googleRefreshToken,
    ''
  );

  // Update the Google Task status
  await googleClient.updateTaskInList(syncedItem.googleListId, syncedItem.googleTaskId, {
    completed: payload.completed,
  });

  // Update Firestore
  await updateSyncedItem(payload.icloudUid, { completed: payload.completed });

  console.log(`Marked Google Task ${syncedItem.googleTaskId} as ${action}`);

  return {
    success: true,
    message: `Task marked as ${action}`,
    taskId: syncedItem.googleTaskId,
    timestamp: new Date().toISOString(),
  };
}

export async function createTaskFromWebhook(payload: WebhookPayload): Promise<SyncResponse> {
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

  // Check if already synced
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
  const listName = payload.list || 'Reminders'; // Default list name if none provided

  try {
    targetListId = await googleClient.findOrCreateTaskList(listName);
    console.log(`Using task list "${listName}" (${targetListId})`);
  } catch (err) {
    console.error(`Failed to find/create list "${listName}": ${err}`);
    throw new Error(`Cannot create task list: ${err}`);
  }

  let taskId: string;
  let message: string;

  // If force and existing, check if task still exists, then update or create
  if (existing && payload.force) {
    const listIdForUpdate = existing.googleListId || targetListId;
    const taskExists = await googleClient.taskExistsInList(listIdForUpdate, existing.googleTaskId);

    if (taskExists) {
      console.log(`Task ${existing.googleTaskId} exists, updating`);
      await googleClient.updateTaskInList(listIdForUpdate, existing.googleTaskId, {
        title: payload.title,
        notes: payload.notes || undefined,
        due: dueDate,
      });
      taskId = existing.googleTaskId;
      console.log(`Updated Google Task: ${taskId} in list ${listIdForUpdate}`);
      message = 'Task updated successfully';
    } else {
      console.log(`Task ${existing.googleTaskId} not found, creating new task`);
      taskId = await googleClient.createTaskInList(targetListId, {
        title: payload.title,
        notes: payload.notes || undefined,
        due: dueDate,
      });
      console.log(`Created Google Task: ${taskId}`);
      message = 'Task created successfully';
    }
  } else {
    // Create new task in Google Tasks
    taskId = await googleClient.createTaskInList(targetListId, {
      title: payload.title,
      notes: payload.notes || undefined,
      due: dueDate,
    });
    console.log(`Created Google Task: ${taskId}`);
    message = 'Task created successfully';
  }

  // Save/update sync record
  await saveSyncedItem({
    icloudUid: uid,
    googleTaskId: taskId,
    googleListId: targetListId,
    title: payload.title,
    syncedAt: Timestamp.now(),
    lastModified: Timestamp.now(),
    completed: false,
  });

  return {
    success: true,
    message,
    taskId,
    timestamp: new Date().toISOString(),
  };
}

// Cloud Function HTTP handler
export async function handleRequest(req: Request, res: Response): Promise<void> {
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
      // Register a task that was imported from Google to Apple
      if (req.query.action === 'register') {
        const payload: RegisterTaskPayload = req.body;
        const response = await registerSyncedTask(payload);
        res.status(response.success ? 200 : 400).json(response);
        return;
      }

      // Update task status in Google (complete/incomplete from Apple)
      if (req.query.action === 'status') {
        const payload: CompleteTaskPayload = req.body;
        const response = await updateTaskStatus(payload);
        res.status(response.success ? 200 : 400).json(response);
        return;
      }

      // Webhook from iOS Shortcuts - create task in Google
      const payload: WebhookPayload = req.body;
      const response = await createTaskFromWebhook(payload);

      res.status(response.success ? 200 : 400).json(response);
    } else if (req.method === 'GET') {
      // Get status changes from Google (completed or uncompleted)
      if (req.query.action === 'google-status') {
        const response = await getGoogleStatusChanges();
        res.status(200).json(response);
        return;
      }

      // Get new tasks from Google (not synced from Apple)
      if (req.query.action === 'new-tasks') {
        const response = await getNewTasks();
        res.status(200).json(response);
        return;
      }

      // Get all synced items (for checking Apple status changes)
      if (req.query.action === 'synced') {
        const response = await getSyncedItems();
        res.status(200).json(response);
        return;
      }

      // Debug: list tasks in a specific list
      if (req.query.debug === 'list' && req.query.listName) {
        const secrets = await loadSecrets();
        const googleClient = new GoogleTasksClient(
          secrets.googleClientId,
          secrets.googleClientSecret,
          secrets.googleRefreshToken,
          ''
        );
        const listId = await googleClient.findOrCreateTaskList(req.query.listName as string);
        const tasks = await googleClient.listTasksInList(listId);
        res.status(200).json({
          success: true,
          listId,
          listName: req.query.listName,
          tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
        });
        return;
      }

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
}

// Register the handler
functions.http('syncHandler', handleRequest);
