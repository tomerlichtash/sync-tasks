import { GoogleTasksClient } from '../../google/tasks';

// Mock googleapis
jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        setCredentials: jest.fn(),
      })),
    },
    tasks: jest.fn().mockImplementation(() => ({
      tasks: {
        insert: jest.fn(),
        patch: jest.fn(),
        delete: jest.fn(),
        list: jest.fn(),
      },
      tasklists: {
        list: jest.fn(),
        insert: jest.fn(),
      },
    })),
  },
}));

import { google } from 'googleapis';

describe('GoogleTasksClient', () => {
  let client: GoogleTasksClient;
  let mockTasksApi: {
    tasks: {
      insert: jest.Mock;
      patch: jest.Mock;
      delete: jest.Mock;
      list: jest.Mock;
    };
    tasklists: {
      list: jest.Mock;
      insert: jest.Mock;
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockTasksApi = {
      tasks: {
        insert: jest.fn(),
        patch: jest.fn(),
        delete: jest.fn(),
        list: jest.fn(),
      },
      tasklists: {
        list: jest.fn(),
        insert: jest.fn(),
      },
    };

    (google.tasks as jest.Mock).mockReturnValue(mockTasksApi);

    client = new GoogleTasksClient(
      'client-id',
      'client-secret',
      'refresh-token',
      'default-list-id'
    );
  });

  describe('createTask', () => {
    it('should create a task with title only', async () => {
      mockTasksApi.tasks.insert.mockResolvedValue({
        data: { id: 'new-task-id' },
      });

      const taskId = await client.createTask({ title: 'Test task' });

      expect(taskId).toBe('new-task-id');
      expect(mockTasksApi.tasks.insert).toHaveBeenCalledWith({
        tasklist: 'default-list-id',
        requestBody: {
          title: 'Test task',
          notes: undefined,
          due: undefined,
          status: 'needsAction',
        },
      });
    });

    it('should create a task with all fields', async () => {
      mockTasksApi.tasks.insert.mockResolvedValue({
        data: { id: 'full-task-id' },
      });

      const dueDate = new Date('2024-12-25T00:00:00Z');
      const taskId = await client.createTask({
        title: 'Holiday shopping',
        notes: 'Buy presents',
        due: dueDate,
        completed: false,
      });

      expect(taskId).toBe('full-task-id');
      expect(mockTasksApi.tasks.insert).toHaveBeenCalledWith({
        tasklist: 'default-list-id',
        requestBody: {
          title: 'Holiday shopping',
          notes: 'Buy presents',
          due: dueDate.toISOString(),
          status: 'needsAction',
        },
      });
    });

    it('should create a completed task', async () => {
      mockTasksApi.tasks.insert.mockResolvedValue({
        data: { id: 'completed-task-id' },
      });

      await client.createTask({
        title: 'Done task',
        completed: true,
      });

      expect(mockTasksApi.tasks.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            status: 'completed',
          }),
        })
      );
    });

    it('should throw if no ID returned', async () => {
      mockTasksApi.tasks.insert.mockResolvedValue({ data: {} });

      await expect(client.createTask({ title: 'Test' })).rejects.toThrow(
        'Failed to create task: no ID returned'
      );
    });
  });

  describe('findOrCreateTaskList', () => {
    it('should return existing list ID if found', async () => {
      mockTasksApi.tasklists.list.mockResolvedValue({
        data: {
          items: [
            { id: 'list-1', title: 'Shopping' },
            { id: 'list-2', title: 'Work' },
          ],
        },
      });

      const listId = await client.findOrCreateTaskList('Shopping');

      expect(listId).toBe('list-1');
      expect(mockTasksApi.tasklists.insert).not.toHaveBeenCalled();
    });

    it('should create new list if not found', async () => {
      mockTasksApi.tasklists.list.mockResolvedValue({
        data: {
          items: [{ id: 'list-1', title: 'Existing' }],
        },
      });
      mockTasksApi.tasklists.insert.mockResolvedValue({
        data: { id: 'new-list-id' },
      });

      const listId = await client.findOrCreateTaskList('New List');

      expect(listId).toBe('new-list-id');
      expect(mockTasksApi.tasklists.insert).toHaveBeenCalledWith({
        requestBody: { title: 'New List' },
      });
    });

    it('should handle empty task lists', async () => {
      mockTasksApi.tasklists.list.mockResolvedValue({
        data: { items: undefined },
      });
      mockTasksApi.tasklists.insert.mockResolvedValue({
        data: { id: 'first-list-id' },
      });

      const listId = await client.findOrCreateTaskList('First List');

      expect(listId).toBe('first-list-id');
    });
  });

  describe('completeTask', () => {
    it('should mark task as completed', async () => {
      mockTasksApi.tasks.patch.mockResolvedValue({ data: {} });

      await client.completeTask('task-123');

      expect(mockTasksApi.tasks.patch).toHaveBeenCalledWith({
        tasklist: 'default-list-id',
        task: 'task-123',
        requestBody: { status: 'completed' },
      });
    });
  });

  describe('deleteTask', () => {
    it('should delete a task', async () => {
      mockTasksApi.tasks.delete.mockResolvedValue({});

      await client.deleteTask('task-to-delete');

      expect(mockTasksApi.tasks.delete).toHaveBeenCalledWith({
        tasklist: 'default-list-id',
        task: 'task-to-delete',
      });
    });
  });
});
