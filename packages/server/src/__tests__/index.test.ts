import { Request, Response } from '@google-cloud/functions-framework';

// Mock dependencies before importing
jest.mock('@google-cloud/functions-framework', () => ({
  http: jest.fn(),
}));

jest.mock('../config/secrets', () => ({
  loadSecrets: jest.fn().mockResolvedValue({
    googleClientId: 'mock-client-id',
    googleClientSecret: 'mock-client-secret',
    googleRefreshToken: 'mock-refresh-token',
  }),
}));

jest.mock('../storage/firestore', () => ({
  getSyncedItem: jest.fn(),
  saveSyncedItem: jest.fn(),
  getAllSyncedItems: jest.fn(),
  updateSyncedItem: jest.fn(),
}));

jest.mock('../google/tasks', () => ({
  GoogleTasksClient: jest.fn().mockImplementation(() => ({
    findOrCreateTaskList: jest.fn().mockResolvedValue('mock-list-id'),
    createTaskInList: jest.fn().mockResolvedValue('mock-task-id'),
    getTaskLists: jest.fn().mockResolvedValue([]),
    listTasksInList: jest.fn().mockResolvedValue([]),
  })),
}));

import { handleRequest } from '../index';
import {
  getSyncedItem,
  saveSyncedItem,
  getAllSyncedItems,
  updateSyncedItem,
} from '../storage/firestore';
import { GoogleTasksClient } from '../google/tasks';

// Helper to create mock request/response
function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    headers: {},
    query: {},
    body: {},
    ...overrides,
  } as Request;
}

function createMockResponse(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 200,
    _json: null as unknown,
    set: jest.fn().mockReturnThis(),
    status: jest.fn().mockImplementation(function (this: typeof res, code: number) {
      this._status = code;
      return this;
    }),
    json: jest.fn().mockImplementation(function (this: typeof res, data: unknown) {
      this._json = data;
      return this;
    }),
    send: jest.fn().mockReturnThis(),
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

describe('Webhook Handler', () => {
  beforeAll(() => {
    process.env.GCP_PROJECT_ID = 'test-project';
    process.env.WEBHOOK_SECRET = 'test-secret';
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should reject requests without valid secret', async () => {
      const req = createMockRequest({
        method: 'POST',
        body: { title: 'Test' },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(401);
      expect(res._json).toEqual({ success: false, error: 'Unauthorized' });
    });

    it('should accept requests with valid secret in query', async () => {
      (getSyncedItem as jest.Mock).mockResolvedValue(null);

      const req = createMockRequest({
        method: 'POST',
        query: { secret: 'test-secret' },
        body: { title: 'Test', uid: 'test-uid' },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(200);
    });

    it('should accept requests with valid secret in header', async () => {
      (getSyncedItem as jest.Mock).mockResolvedValue(null);

      const req = createMockRequest({
        method: 'POST',
        headers: { 'x-webhook-secret': 'test-secret' },
        body: { title: 'Test', uid: 'test-uid' },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(200);
    });
  });

  describe('HTTP Methods', () => {
    it('should handle OPTIONS for CORS preflight', async () => {
      const req = createMockRequest({ method: 'OPTIONS' });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(204);
      expect(res.set).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
    });

    it('should return health check on GET', async () => {
      const req = createMockRequest({
        method: 'GET',
        query: { secret: 'test-secret' },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(200);
      expect((res._json as { message: string }).message).toContain('webhook is running');
    });

    it('should reject unsupported methods', async () => {
      const req = createMockRequest({
        method: 'DELETE',
        query: { secret: 'test-secret' },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(405);
    });
  });

  describe('Payload Validation', () => {
    it('should reject payload without title', async () => {
      const req = createMockRequest({
        method: 'POST',
        query: { secret: 'test-secret' },
        body: { notes: 'Some notes' },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(400);
      expect((res._json as { message: string }).message).toContain('Missing required field: title');
    });
  });

  describe('Task Creation', () => {
    it('should create a new task', async () => {
      (getSyncedItem as jest.Mock).mockResolvedValue(null);

      const req = createMockRequest({
        method: 'POST',
        query: { secret: 'test-secret' },
        body: {
          title: 'Buy groceries',
          notes: 'Milk, eggs, bread',
          list: 'Shopping',
          uid: 'unique-id-123',
        },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(200);
      expect((res._json as { success: boolean }).success).toBe(true);
      expect((res._json as { taskId: string }).taskId).toBe('mock-task-id');
      expect(saveSyncedItem).toHaveBeenCalled();
    });

    it('should skip already synced tasks', async () => {
      (getSyncedItem as jest.Mock).mockResolvedValue({
        googleTaskId: 'existing-task-id',
      });

      const req = createMockRequest({
        method: 'POST',
        query: { secret: 'test-secret' },
        body: {
          title: 'Already synced',
          uid: 'existing-uid',
        },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(200);
      expect((res._json as { message: string }).message).toBe('Already synced');
      expect((res._json as { taskId: string }).taskId).toBe('existing-task-id');
      expect(saveSyncedItem).not.toHaveBeenCalled();
    });

    it('should update existing task when force flag is set (no duplicates)', async () => {
      (getSyncedItem as jest.Mock).mockResolvedValue({
        googleTaskId: 'existing-task-id',
        googleListId: 'existing-list-id',
      });

      const mockUpdateTaskInList = jest.fn().mockResolvedValue(undefined);
      const mockCreateTaskInList = jest.fn().mockResolvedValue('new-task-id');
      const mockTaskExistsInList = jest.fn().mockResolvedValue(true);
      (GoogleTasksClient as jest.Mock).mockImplementation(() => ({
        findOrCreateTaskList: jest.fn().mockResolvedValue('mock-list-id'),
        createTaskInList: mockCreateTaskInList,
        updateTaskInList: mockUpdateTaskInList,
        taskExistsInList: mockTaskExistsInList,
      }));

      const req = createMockRequest({
        method: 'POST',
        query: { secret: 'test-secret' },
        body: {
          title: 'Force re-sync',
          uid: 'existing-uid',
          force: true,
        },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(200);
      expect((res._json as { message: string }).message).toBe('Task updated successfully');
      expect((res._json as { taskId: string }).taskId).toBe('existing-task-id');
      expect(mockUpdateTaskInList).toHaveBeenCalledWith(
        'existing-list-id',
        'existing-task-id',
        expect.any(Object)
      );
      expect(mockCreateTaskInList).not.toHaveBeenCalled();
      expect(saveSyncedItem).toHaveBeenCalled();
    });

    it('should use default list name when not provided', async () => {
      (getSyncedItem as jest.Mock).mockResolvedValue(null);

      const mockFindOrCreateTaskList = jest.fn().mockResolvedValue('default-list-id');
      (GoogleTasksClient as jest.Mock).mockImplementation(() => ({
        findOrCreateTaskList: mockFindOrCreateTaskList,
        createTaskInList: jest.fn().mockResolvedValue('mock-task-id'),
      }));

      const req = createMockRequest({
        method: 'POST',
        query: { secret: 'test-secret' },
        body: {
          title: 'No list specified',
          uid: 'no-list-uid',
        },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(mockFindOrCreateTaskList).toHaveBeenCalledWith('Reminders');
    });
  });

  describe('Google Status Changes', () => {
    it('should return status changes from Google (completed)', async () => {
      const syncedItems = new Map([
        [
          'uid-1',
          {
            icloudUid: 'uid-1',
            googleTaskId: 'task-1',
            googleListId: 'list-1',
            title: 'Buy milk',
            completed: false,
          },
        ],
        [
          'uid-2',
          {
            icloudUid: 'uid-2',
            googleTaskId: 'task-2',
            googleListId: 'list-1',
            title: 'Call mom',
            completed: false,
          },
        ],
      ]);
      (getAllSyncedItems as jest.Mock).mockResolvedValue(syncedItems);

      // task-1 is completed in Google, task-2 is not
      const mockGetTask = jest.fn().mockImplementation((listId: string, taskId: string) => {
        if (taskId === 'task-1') {
          return Promise.resolve({ status: 'completed', completed: '2024-01-15T10:00:00Z' });
        }
        return Promise.resolve({ status: 'needsAction' });
      });
      (GoogleTasksClient as jest.Mock).mockImplementation(() => ({
        getTask: mockGetTask,
      }));

      const req = createMockRequest({
        method: 'GET',
        query: { secret: 'test-secret', action: 'google-status' },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(200);
      const response = res._json as {
        success: boolean;
        changes: Array<{ uid: string; title: string; completed: boolean }>;
      };
      expect(response.success).toBe(true);
      expect(response.changes).toHaveLength(1);
      expect(response.changes[0].uid).toBe('uid-1');
      expect(response.changes[0].completed).toBe(true);
      expect(updateSyncedItem).toHaveBeenCalledWith('uid-1', { completed: true });
    });

    it('should return status changes from Google (uncompleted)', async () => {
      const syncedItems = new Map([
        [
          'uid-1',
          {
            icloudUid: 'uid-1',
            googleTaskId: 'task-1',
            googleListId: 'list-1',
            title: 'Was completed',
            completed: true, // Marked as completed in Firestore
          },
        ],
      ]);
      (getAllSyncedItems as jest.Mock).mockResolvedValue(syncedItems);

      // task-1 is now incomplete in Google
      const mockGetTask = jest.fn().mockResolvedValue({ status: 'needsAction' });
      (GoogleTasksClient as jest.Mock).mockImplementation(() => ({
        getTask: mockGetTask,
      }));

      const req = createMockRequest({
        method: 'GET',
        query: { secret: 'test-secret', action: 'google-status' },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(200);
      const response = res._json as {
        success: boolean;
        changes: Array<{ uid: string; completed: boolean }>;
      };
      expect(response.success).toBe(true);
      expect(response.changes).toHaveLength(1);
      expect(response.changes[0].uid).toBe('uid-1');
      expect(response.changes[0].completed).toBe(false);
      expect(updateSyncedItem).toHaveBeenCalledWith('uid-1', { completed: false });
    });

    it('should return empty array when no status changes', async () => {
      const syncedItems = new Map([
        [
          'uid-1',
          {
            icloudUid: 'uid-1',
            googleTaskId: 'task-1',
            googleListId: 'list-1',
            title: 'In sync',
            completed: false,
          },
        ],
      ]);
      (getAllSyncedItems as jest.Mock).mockResolvedValue(syncedItems);

      const mockGetTask = jest.fn().mockResolvedValue({ status: 'needsAction' });
      (GoogleTasksClient as jest.Mock).mockImplementation(() => ({
        getTask: mockGetTask,
      }));

      const req = createMockRequest({
        method: 'GET',
        query: { secret: 'test-secret', action: 'google-status' },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(200);
      const response = res._json as { success: boolean; changes: Array<{ uid: string }> };
      expect(response.success).toBe(true);
      expect(response.changes).toHaveLength(0);
      expect(updateSyncedItem).not.toHaveBeenCalled();
    });
  });

  describe('New Tasks (Google to Apple)', () => {
    it('should return new tasks from Google that are not synced', async () => {
      // No synced items in Firestore
      (getAllSyncedItems as jest.Mock).mockResolvedValue(new Map());

      const mockGetTaskLists = jest.fn().mockResolvedValue([
        { id: 'list-1', title: 'Work' },
        { id: 'list-2', title: 'Personal' },
      ]);
      const mockListTasksInList = jest.fn().mockImplementation((listId: string) => {
        if (listId === 'list-1') {
          return Promise.resolve([
            { id: 'task-1', title: 'New task 1', notes: 'Notes 1', status: 'needsAction' },
            { id: 'task-2', title: 'New task 2', status: 'completed' },
          ]);
        }
        return Promise.resolve([{ id: 'task-3', title: 'New task 3', status: 'needsAction' }]);
      });

      (GoogleTasksClient as jest.Mock).mockImplementation(() => ({
        getTaskLists: mockGetTaskLists,
        listTasksInList: mockListTasksInList,
      }));

      const req = createMockRequest({
        method: 'GET',
        query: { secret: 'test-secret', action: 'new-tasks' },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(200);
      const response = res._json as {
        success: boolean;
        tasks: Array<{ googleTaskId: string; title: string; listName: string; completed: boolean }>;
      };
      expect(response.success).toBe(true);
      expect(response.tasks).toHaveLength(3);
      expect(response.tasks[0]).toMatchObject({
        googleTaskId: 'task-1',
        title: 'New task 1',
        listName: 'Work',
        completed: false,
      });
      expect(response.tasks[1]).toMatchObject({
        googleTaskId: 'task-2',
        title: 'New task 2',
        completed: true,
      });
    });

    it('should exclude tasks already synced from Apple', async () => {
      // task-1 is already synced
      const syncedItems = new Map([
        [
          'apple-uid-1',
          {
            icloudUid: 'apple-uid-1',
            googleTaskId: 'task-1',
            googleListId: 'list-1',
            title: 'Already synced',
            completed: false,
          },
        ],
      ]);
      (getAllSyncedItems as jest.Mock).mockResolvedValue(syncedItems);

      const mockGetTaskLists = jest.fn().mockResolvedValue([{ id: 'list-1', title: 'Work' }]);
      const mockListTasksInList = jest.fn().mockResolvedValue([
        { id: 'task-1', title: 'Already synced', status: 'needsAction' },
        { id: 'task-2', title: 'New from Google', status: 'needsAction' },
      ]);

      (GoogleTasksClient as jest.Mock).mockImplementation(() => ({
        getTaskLists: mockGetTaskLists,
        listTasksInList: mockListTasksInList,
      }));

      const req = createMockRequest({
        method: 'GET',
        query: { secret: 'test-secret', action: 'new-tasks' },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(200);
      const response = res._json as {
        success: boolean;
        tasks: Array<{ googleTaskId: string; title: string }>;
      };
      expect(response.success).toBe(true);
      expect(response.tasks).toHaveLength(1);
      expect(response.tasks[0].googleTaskId).toBe('task-2');
      expect(response.tasks[0].title).toBe('New from Google');
    });

    it('should exclude deleted tasks', async () => {
      (getAllSyncedItems as jest.Mock).mockResolvedValue(new Map());

      const mockGetTaskLists = jest.fn().mockResolvedValue([{ id: 'list-1', title: 'Work' }]);
      const mockListTasksInList = jest.fn().mockResolvedValue([
        { id: 'task-1', title: 'Active task', status: 'needsAction' },
        { id: 'task-2', title: 'Deleted task', status: 'needsAction', deleted: true },
      ]);

      (GoogleTasksClient as jest.Mock).mockImplementation(() => ({
        getTaskLists: mockGetTaskLists,
        listTasksInList: mockListTasksInList,
      }));

      const req = createMockRequest({
        method: 'GET',
        query: { secret: 'test-secret', action: 'new-tasks' },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(200);
      const response = res._json as {
        success: boolean;
        tasks: Array<{ googleTaskId: string }>;
      };
      expect(response.tasks).toHaveLength(1);
      expect(response.tasks[0].googleTaskId).toBe('task-1');
    });
  });

  describe('Synced Items', () => {
    it('should return all synced items with completion status', async () => {
      const syncedItems = new Map([
        [
          'uid-1',
          {
            icloudUid: 'uid-1',
            googleTaskId: 'task-1',
            googleListId: 'list-1',
            title: 'Incomplete task',
            completed: false,
          },
        ],
        [
          'uid-2',
          {
            icloudUid: 'uid-2',
            googleTaskId: 'task-2',
            googleListId: 'list-1',
            title: 'Completed task',
            completed: true,
          },
        ],
      ]);
      (getAllSyncedItems as jest.Mock).mockResolvedValue(syncedItems);

      const req = createMockRequest({
        method: 'GET',
        query: { secret: 'test-secret', action: 'synced' },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(200);
      const response = res._json as {
        success: boolean;
        items: Array<{ icloudUid: string; title: string; completed: boolean }>;
      };
      expect(response.success).toBe(true);
      expect(response.items).toHaveLength(2);
      expect(response.items.find((i) => i.icloudUid === 'uid-1')?.completed).toBe(false);
      expect(response.items.find((i) => i.icloudUid === 'uid-2')?.completed).toBe(true);
    });
  });

  describe('Update Task Status', () => {
    it('should mark a task as completed in Google', async () => {
      (getSyncedItem as jest.Mock).mockResolvedValue({
        icloudUid: 'apple-uid',
        googleTaskId: 'google-task-123',
        googleListId: 'google-list-456',
        title: 'Task to complete',
        completed: false,
      });

      const mockUpdateTaskInList = jest.fn().mockResolvedValue(undefined);
      (GoogleTasksClient as jest.Mock).mockImplementation(() => ({
        updateTaskInList: mockUpdateTaskInList,
      }));

      const req = createMockRequest({
        method: 'POST',
        query: { secret: 'test-secret', action: 'status' },
        body: { icloudUid: 'apple-uid', completed: true },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(200);
      expect((res._json as { success: boolean }).success).toBe(true);
      expect((res._json as { message: string }).message).toBe('Task marked as completed');
      expect(mockUpdateTaskInList).toHaveBeenCalledWith('google-list-456', 'google-task-123', {
        completed: true,
      });
      expect(updateSyncedItem).toHaveBeenCalledWith('apple-uid', { completed: true });
    });

    it('should mark a task as incomplete in Google', async () => {
      (getSyncedItem as jest.Mock).mockResolvedValue({
        icloudUid: 'apple-uid',
        googleTaskId: 'google-task-123',
        googleListId: 'google-list-456',
        title: 'Task to uncomplete',
        completed: true,
      });

      const mockUpdateTaskInList = jest.fn().mockResolvedValue(undefined);
      (GoogleTasksClient as jest.Mock).mockImplementation(() => ({
        updateTaskInList: mockUpdateTaskInList,
      }));

      const req = createMockRequest({
        method: 'POST',
        query: { secret: 'test-secret', action: 'status' },
        body: { icloudUid: 'apple-uid', completed: false },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(200);
      expect((res._json as { success: boolean }).success).toBe(true);
      expect((res._json as { message: string }).message).toBe('Task marked as incomplete');
      expect(mockUpdateTaskInList).toHaveBeenCalledWith('google-list-456', 'google-task-123', {
        completed: false,
      });
      expect(updateSyncedItem).toHaveBeenCalledWith('apple-uid', { completed: false });
    });

    it('should return error if synced item not found', async () => {
      (getSyncedItem as jest.Mock).mockResolvedValue(null);

      const req = createMockRequest({
        method: 'POST',
        query: { secret: 'test-secret', action: 'status' },
        body: { icloudUid: 'nonexistent-uid', completed: true },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(400);
      expect((res._json as { success: boolean }).success).toBe(false);
      expect((res._json as { message: string }).message).toBe('Synced item not found');
    });
  });

  describe('Register Task', () => {
    it('should register a reverse-synced task', async () => {
      const req = createMockRequest({
        method: 'POST',
        query: { secret: 'test-secret', action: 'register' },
        body: {
          googleTaskId: 'google-task-123',
          googleListId: 'google-list-456',
          icloudUid: 'apple-uid-789',
          title: 'Imported task',
          completed: false,
        },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(200);
      expect((res._json as { success: boolean }).success).toBe(true);
      expect((res._json as { message: string }).message).toBe('Task registered successfully');
      expect(saveSyncedItem).toHaveBeenCalledWith(
        expect.objectContaining({
          googleTaskId: 'google-task-123',
          googleListId: 'google-list-456',
          icloudUid: 'apple-uid-789',
          title: 'Imported task',
          completed: false,
        })
      );
    });

    it('should register a completed reverse-synced task', async () => {
      const req = createMockRequest({
        method: 'POST',
        query: { secret: 'test-secret', action: 'register' },
        body: {
          googleTaskId: 'google-task-123',
          googleListId: 'google-list-456',
          icloudUid: 'apple-uid-789',
          title: 'Completed imported task',
          completed: true,
        },
      });
      const res = createMockResponse();

      await handleRequest(req, res);

      expect(res._status).toBe(200);
      expect(saveSyncedItem).toHaveBeenCalledWith(
        expect.objectContaining({
          completed: true,
        })
      );
    });
  });
});
