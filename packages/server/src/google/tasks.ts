import { google, tasks_v1 } from 'googleapis';

export interface TaskInput {
  title: string;
  notes?: string;
  due?: Date;
  completed?: boolean;
}

export class GoogleTasksClient {
  private tasksApi: tasks_v1.Tasks;
  private taskListId: string;

  constructor(clientId: string, clientSecret: string, refreshToken: string, taskListId: string) {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    this.tasksApi = google.tasks({ version: 'v1', auth: oauth2Client });
    this.taskListId = taskListId;
  }

  async createTask(input: TaskInput): Promise<string> {
    const response = await this.tasksApi.tasks.insert({
      tasklist: this.taskListId,
      requestBody: {
        title: input.title,
        notes: input.notes,
        due: input.due?.toISOString(),
        status: input.completed ? 'completed' : 'needsAction',
      },
    });

    if (!response.data.id) {
      throw new Error('Failed to create task: no ID returned');
    }

    return response.data.id;
  }

  async updateTask(taskId: string, input: Partial<TaskInput>): Promise<void> {
    const updateBody: tasks_v1.Schema$Task = {};

    if (input.title !== undefined) updateBody.title = input.title;
    if (input.notes !== undefined) updateBody.notes = input.notes;
    if (input.due !== undefined) updateBody.due = input.due.toISOString();
    if (input.completed !== undefined) {
      updateBody.status = input.completed ? 'completed' : 'needsAction';
    }

    await this.tasksApi.tasks.patch({
      tasklist: this.taskListId,
      task: taskId,
      requestBody: updateBody,
    });
  }

  async completeTask(taskId: string): Promise<void> {
    await this.tasksApi.tasks.patch({
      tasklist: this.taskListId,
      task: taskId,
      requestBody: {
        status: 'completed',
      },
    });
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.tasksApi.tasks.delete({
      tasklist: this.taskListId,
      task: taskId,
    });
  }

  async listTasks(): Promise<tasks_v1.Schema$Task[]> {
    const response = await this.tasksApi.tasks.list({
      tasklist: this.taskListId,
      showCompleted: true,
      showHidden: true,
    });

    return response.data.items || [];
  }

  async getTaskLists(): Promise<tasks_v1.Schema$TaskList[]> {
    const response = await this.tasksApi.tasklists.list();
    return response.data.items || [];
  }

  async findOrCreateTaskList(name: string): Promise<string> {
    // Check if list already exists
    const lists = await this.getTaskLists();
    const existing = lists.find((l) => l.title === name);
    if (existing?.id) {
      return existing.id;
    }

    // Create new list
    const response = await this.tasksApi.tasklists.insert({
      requestBody: { title: name },
    });

    if (!response.data.id) {
      throw new Error(`Failed to create task list: ${name}`);
    }

    console.log(`Created new task list: ${name}`);
    return response.data.id;
  }

  async createTaskInList(listId: string, input: TaskInput): Promise<string> {
    const response = await this.tasksApi.tasks.insert({
      tasklist: listId,
      requestBody: {
        title: input.title,
        notes: input.notes,
        due: input.due?.toISOString(),
        status: input.completed ? 'completed' : 'needsAction',
      },
    });

    if (!response.data.id) {
      throw new Error('Failed to create task: no ID returned');
    }

    return response.data.id;
  }

  async updateTaskInList(listId: string, taskId: string, input: Partial<TaskInput>): Promise<void> {
    const updateBody: tasks_v1.Schema$Task = {};

    if (input.title !== undefined) updateBody.title = input.title;
    if (input.notes !== undefined) updateBody.notes = input.notes;
    if (input.due !== undefined) updateBody.due = input.due.toISOString();
    if (input.completed !== undefined) {
      updateBody.status = input.completed ? 'completed' : 'needsAction';
    }

    await this.tasksApi.tasks.patch({
      tasklist: listId,
      task: taskId,
      requestBody: updateBody,
    });
  }

  async taskExistsInList(listId: string, taskId: string): Promise<boolean> {
    try {
      await this.tasksApi.tasks.get({
        tasklist: listId,
        task: taskId,
      });
      return true;
    } catch {
      return false;
    }
  }

  async listTasksInList(listId: string): Promise<tasks_v1.Schema$Task[]> {
    const response = await this.tasksApi.tasks.list({
      tasklist: listId,
      showCompleted: true,
      showHidden: true,
      showDeleted: true,
    });
    return response.data.items || [];
  }
}
