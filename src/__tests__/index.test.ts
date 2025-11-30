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
}));

jest.mock('../google/tasks', () => ({
  GoogleTasksClient: jest.fn().mockImplementation(() => ({
    findOrCreateTaskList: jest.fn().mockResolvedValue('mock-list-id'),
    createTaskInList: jest.fn().mockResolvedValue('mock-task-id'),
  })),
}));

import { handleRequest } from '../index';
import { getSyncedItem, saveSyncedItem } from '../storage/firestore';
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

    it('should re-sync when force flag is set', async () => {
      (getSyncedItem as jest.Mock).mockResolvedValue({
        googleTaskId: 'existing-task-id',
      });

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
      expect((res._json as { message: string }).message).toBe('Task created successfully');
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
});
