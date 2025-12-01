import EventKit
import Foundation

// Initialize logger
let log = CLILogger()

// Configuration
let webhookURL = ProcessInfo.processInfo.environment["WEBHOOK_URL"] ?? ""
let webhookSecret = ProcessInfo.processInfo.environment["WEBHOOK_SECRET"] ?? ""
let syncStateFile = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent(".sync-tasks-state.json")
let forceSync = CommandLine.arguments.contains("--force")
let resetSync = CommandLine.arguments.contains("--reset")

struct SyncState: Codable {
  var syncedReminders: [String: SyncedReminder]
}

struct SyncedReminder: Codable {
  let googleTaskId: String?
  let syncedAt: Date
  let title: String
}

struct WebhookPayload: Codable {
  let title: String
  let notes: String?
  let list: String?
  let dueDate: String?
  let uid: String
  let force: Bool?
}

struct WebhookResponse: Codable {
  let success: Bool
  let message: String
  let taskId: String?
}

struct StatusChange: Codable {
  let uid: String
  let title: String
  let completed: Bool
  let changedAt: String?
}

struct StatusChangesResponse: Codable {
  let success: Bool
  let changes: [StatusChange]
  let timestamp: String
}

struct NewTask: Codable {
  let googleTaskId: String
  let googleListId: String
  let listName: String
  let title: String
  let notes: String?
  let due: String?
  let completed: Bool
}

struct NewTasksResponse: Codable {
  let success: Bool
  let tasks: [NewTask]
  let timestamp: String
}

struct RegisterTaskPayload: Codable {
  let googleTaskId: String
  let googleListId: String
  let icloudUid: String
  let title: String
  let completed: Bool
}

struct SyncedItem: Codable {
  let icloudUid: String
  let googleTaskId: String
  let googleListId: String?
  let title: String
  let completed: Bool
}

struct IncompleteSyncedItemsResponse: Codable {
  let success: Bool
  let items: [SyncedItem]
  let timestamp: String
}

struct StatusUpdatePayload: Codable {
  let icloudUid: String
  let completed: Bool
}

// Load sync state
func loadSyncState() -> SyncState {
  guard FileManager.default.fileExists(atPath: syncStateFile.path),
    let data = try? Data(contentsOf: syncStateFile),
    let state = try? JSONDecoder().decode(SyncState.self, from: data)
  else {
    return SyncState(syncedReminders: [:])
  }
  return state
}

// Save sync state
func saveSyncState(_ state: SyncState) {
  guard let data = try? JSONEncoder().encode(state) else { return }
  try? data.write(to: syncStateFile)
}

// Fetch status changes from Google (completed or uncompleted)
func fetchGoogleStatusChanges() -> [StatusChange] {
  guard let url = URL(string: "\(webhookURL)?secret=\(webhookSecret)&action=google-status") else {
    log.failed("Invalid webhook URL")
    return []
  }

  var request = URLRequest(url: url)
  request.httpMethod = "GET"

  let semaphore = DispatchSemaphore(value: 0)
  var changes: [StatusChange] = []

  URLSession.shared.dataTask(with: request) { data, response, error in
    defer { semaphore.signal() }

    if let error = error {
      log.failed("Error fetching Google status changes: \(error.localizedDescription)")
      return
    }

    guard let data = data,
      let response = try? JSONDecoder().decode(StatusChangesResponse.self, from: data)
    else {
      log.failed("Invalid response from google-status endpoint")
      return
    }

    if response.success {
      changes = response.changes
    }
  }.resume()

  semaphore.wait()
  return changes
}

// Fetch new tasks from server (tasks created in Google, not synced from Apple)
func fetchNewTasks() -> [NewTask] {
  guard let url = URL(string: "\(webhookURL)?secret=\(webhookSecret)&action=new-tasks") else {
    log.failed("Invalid webhook URL")
    return []
  }

  var request = URLRequest(url: url)
  request.httpMethod = "GET"

  let semaphore = DispatchSemaphore(value: 0)
  var newTasks: [NewTask] = []

  URLSession.shared.dataTask(with: request) { data, response, error in
    defer { semaphore.signal() }

    if let error = error {
      log.failed("Error fetching new tasks: \(error.localizedDescription)")
      return
    }

    guard let data = data,
      let response = try? JSONDecoder().decode(NewTasksResponse.self, from: data)
    else {
      log.failed("Invalid response from new-tasks endpoint")
      return
    }

    if response.success {
      newTasks = response.tasks
    }
  }.resume()

  semaphore.wait()
  return newTasks
}

// Update reminder status in Apple Reminders (complete or incomplete)
func updateReminderStatus(uid: String, completed: Bool, eventStore: EKEventStore) -> Bool {
  guard let reminder = eventStore.calendarItem(withIdentifier: uid) as? EKReminder else {
    return false
  }

  reminder.isCompleted = completed
  reminder.completionDate = completed ? Date() : nil

  do {
    try eventStore.save(reminder, commit: true)
    return true
  } catch {
    let action = completed ? "complete" : "uncomplete"
    log.failed("Failed to \(action) reminder: \(error.localizedDescription)")
    return false
  }
}

// Create a new reminder in Apple Reminders from a Google Task
func createReminder(from task: NewTask, eventStore: EKEventStore) -> String? {
  let reminder = EKReminder(eventStore: eventStore)
  reminder.title = task.title
  reminder.notes = task.notes

  // Find or use default calendar matching the list name
  if let calendar = eventStore.calendars(for: .reminder).first(where: { $0.title == task.listName }) {
    reminder.calendar = calendar
  } else {
    reminder.calendar = eventStore.defaultCalendarForNewReminders()
  }

  // Parse due date if provided
  if let dueString = task.due {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let dueDate = formatter.date(from: dueString) {
      reminder.dueDateComponents = Calendar.current.dateComponents(
        [.year, .month, .day, .hour, .minute],
        from: dueDate
      )
    }
  }

  // Set completion status
  if task.completed {
    reminder.isCompleted = true
    reminder.completionDate = Date()
  }

  do {
    try eventStore.save(reminder, commit: true)
    return reminder.calendarItemIdentifier
  } catch {
    log.failed("Failed to create reminder: \(error.localizedDescription)")
    return nil
  }
}

// Register a synced task with the server
func registerSyncedTask(task: NewTask, icloudUid: String) -> Bool {
  guard let url = URL(string: "\(webhookURL)?secret=\(webhookSecret)&action=register") else {
    log.failed("Invalid webhook URL")
    return false
  }

  let payload = RegisterTaskPayload(
    googleTaskId: task.googleTaskId,
    googleListId: task.googleListId,
    icloudUid: icloudUid,
    title: task.title,
    completed: task.completed
  )

  var request = URLRequest(url: url)
  request.httpMethod = "POST"
  request.setValue("application/json", forHTTPHeaderField: "Content-Type")
  request.httpBody = try? JSONEncoder().encode(payload)

  let semaphore = DispatchSemaphore(value: 0)
  var success = false

  URLSession.shared.dataTask(with: request) { data, response, error in
    defer { semaphore.signal() }

    if let error = error {
      log.failed("Error registering task: \(error.localizedDescription)")
      return
    }

    guard let data = data,
      let response = try? JSONDecoder().decode(WebhookResponse.self, from: data)
    else {
      log.failed("Invalid response from register endpoint")
      return
    }

    success = response.success
  }.resume()

  semaphore.wait()
  return success
}

// Fetch all synced items from server (to check for Apple status changes)
func fetchSyncedItems() -> [SyncedItem] {
  guard let url = URL(string: "\(webhookURL)?secret=\(webhookSecret)&action=synced") else {
    log.failed("Invalid webhook URL")
    return []
  }

  var request = URLRequest(url: url)
  request.httpMethod = "GET"

  let semaphore = DispatchSemaphore(value: 0)
  var items: [SyncedItem] = []

  URLSession.shared.dataTask(with: request) { data, response, error in
    defer { semaphore.signal() }

    if let error = error {
      log.failed("Error fetching synced items: \(error.localizedDescription)")
      return
    }

    guard let data = data,
      let response = try? JSONDecoder().decode(IncompleteSyncedItemsResponse.self, from: data)
    else {
      log.failed("Invalid response from synced endpoint")
      return
    }

    if response.success {
      items = response.items
    }
  }.resume()

  semaphore.wait()
  return items
}

// Update task status in Google (complete or incomplete)
func updateGoogleTaskStatus(icloudUid: String, completed: Bool) -> Bool {
  guard let url = URL(string: "\(webhookURL)?secret=\(webhookSecret)&action=status") else {
    log.failed("Invalid webhook URL")
    return false
  }

  let payload = StatusUpdatePayload(icloudUid: icloudUid, completed: completed)

  var request = URLRequest(url: url)
  request.httpMethod = "POST"
  request.setValue("application/json", forHTTPHeaderField: "Content-Type")
  request.httpBody = try? JSONEncoder().encode(payload)

  let semaphore = DispatchSemaphore(value: 0)
  var success = false

  URLSession.shared.dataTask(with: request) { data, response, error in
    defer { semaphore.signal() }

    if let error = error {
      log.failed("Error updating task status: \(error.localizedDescription)")
      return
    }

    guard let data = data,
      let response = try? JSONDecoder().decode(WebhookResponse.self, from: data)
    else {
      log.failed("Invalid response from status endpoint")
      return
    }

    success = response.success
  }.resume()

  semaphore.wait()
  return success
}

// Result of syncing a reminder
enum SyncResult {
  case success(String, SyncedReminder) // uid, synced reminder
  case alreadySynced
  case updated
  case failed(String) // error message
  case error(String) // error message
}

// Send reminder to webhook - returns sync result
func syncReminder(_ reminder: EKReminder) -> SyncResult {
  let uid = reminder.calendarItemIdentifier

  let payload = WebhookPayload(
    title: reminder.title ?? "Untitled",
    notes: reminder.notes,
    list: reminder.calendar?.title,
    dueDate: reminder.dueDateComponents?.date?.ISO8601Format(),
    uid: uid,
    force: forceSync ? true : nil
  )

  guard let url = URL(string: "\(webhookURL)?secret=\(webhookSecret)") else {
    return .error("Invalid webhook URL")
  }

  var request = URLRequest(url: url)
  request.httpMethod = "POST"
  request.setValue("application/json", forHTTPHeaderField: "Content-Type")
  request.httpBody = try? JSONEncoder().encode(payload)

  let semaphore = DispatchSemaphore(value: 0)
  var syncResult: SyncResult = .error("Unknown error")

  URLSession.shared.dataTask(with: request) { data, response, error in
    defer { semaphore.signal() }

    if let error = error {
      syncResult = .error(error.localizedDescription)
      return
    }

    guard let data = data,
      let response = try? JSONDecoder().decode(WebhookResponse.self, from: data)
    else {
      syncResult = .error("Invalid response")
      return
    }

    if response.success {
      let synced = SyncedReminder(
        googleTaskId: response.taskId,
        syncedAt: Date(),
        title: reminder.title ?? ""
      )

      if response.message == "Already synced" {
        syncResult = .alreadySynced
      } else if response.message == "Task updated successfully" {
        syncResult = .updated
      } else {
        syncResult = .success(uid, synced)
      }
    } else {
      syncResult = .failed(response.message)
    }
  }.resume()

  semaphore.wait()
  return syncResult
}

// Main
func main() {
  guard !webhookURL.isEmpty else {
    log.error("WEBHOOK_URL environment variable is required")
    log.info("Usage: WEBHOOK_URL=https://... WEBHOOK_SECRET=... sync-tasks")
    exit(1)
  }

  let eventStore = EKEventStore()

  // Request access to reminders
  log.startSpinner("Requesting access to Reminders")
  let semaphore = DispatchSemaphore(value: 0)
  var accessGranted = false

  if #available(macOS 14.0, *) {
    eventStore.requestFullAccessToReminders { granted, error in
      accessGranted = granted
      if let error = error {
        log.error("Error requesting access: \(error.localizedDescription)")
      }
      semaphore.signal()
    }
  } else {
    eventStore.requestAccess(to: .reminder) { granted, error in
      accessGranted = granted
      if let error = error {
        log.error("Error requesting access: \(error.localizedDescription)")
      }
      semaphore.signal()
    }
  }

  semaphore.wait()

  guard accessGranted else {
    log.stopSpinner(success: false, message: "Access to Reminders denied")
    log.info("Grant access in System Settings → Privacy & Security → Reminders")
    exit(1)
  }

  log.stopSpinner(success: true, message: "Access granted")

  // Step 1: Pull status changes from Google Tasks (completed or uncompleted)
  log.startSpinner("Checking for status changes in Google")
  let googleChanges = fetchGoogleStatusChanges()
  log.stopSpinner(success: true, message: "Found \(googleChanges.count) status changes")

  // Apply status changes to Apple Reminders
  var appleStatusChanges = 0
  for change in googleChanges {
    let action = change.completed ? "completed" : "uncompleted"
    let prefix = "[Google] \(change.title)"

    if updateReminderStatus(uid: change.uid, completed: change.completed, eventStore: eventStore) {
      log.synced("\(prefix) (\(action))")
      appleStatusChanges += 1
    } else {
      log.skipped("\(prefix) (not found locally)")
    }
  }

  if appleStatusChanges > 0 {
    log.success("\(appleStatusChanges) reminders updated from Google")
  }

  // Step 1.5: Sync status changes from Apple to Google
  log.startSpinner("Checking for status changes to sync to Google")
  let syncedItems = fetchSyncedItems()
  log.stopSpinner(success: true, message: "Found \(syncedItems.count) items to check")

  var googleStatusChanges = 0
  for item in syncedItems {
    // Check if the reminder exists and compare status
    if let reminder = eventStore.calendarItem(withIdentifier: item.icloudUid) as? EKReminder {
      let appleCompleted = reminder.isCompleted
      let serverCompleted = item.completed

      // Only sync if status differs
      if appleCompleted != serverCompleted {
        let listName = reminder.calendar?.title ?? "Unknown"
        let prefix = "[\(listName)] \(item.title)"
        let action = appleCompleted ? "completed" : "uncompleted"
        log.startSpinner(prefix)

        if updateGoogleTaskStatus(icloudUid: item.icloudUid, completed: appleCompleted) {
          log.synced("\(prefix) (\(action) in Google)")
          googleStatusChanges += 1
        } else {
          log.failed("\(prefix) (failed to \(action) in Google)")
        }
      }
    }
  }

  if googleStatusChanges > 0 {
    log.success("\(googleStatusChanges) status changes synced to Google")
  }

  // Step 2: Import new tasks from Google (created in Google, not synced from Apple)
  log.startSpinner("Checking for new tasks in Google")
  let newTasks = fetchNewTasks()
  log.stopSpinner(success: true, message: "Found \(newTasks.count) new tasks from Google")

  // Track UIDs of imported reminders to skip them during push phase
  var importedUIDs = Set<String>()
  var importedCount = 0

  for task in newTasks {
    let prefix = "[\(task.listName)] \(task.title)"
    log.startSpinner(prefix)

    if let icloudUid = createReminder(from: task, eventStore: eventStore) {
      // Register with server so it knows about the sync
      if registerSyncedTask(task: task, icloudUid: icloudUid) {
        importedUIDs.insert(icloudUid)
        let status = task.completed ? "imported, completed" : "imported"
        log.synced("\(prefix) (\(status))")
        importedCount += 1
      } else {
        log.failed("\(prefix) (failed to register)")
      }
    } else {
      log.failed("\(prefix) (failed to create)")
    }
  }

  if importedCount > 0 {
    log.success("\(importedCount) tasks imported from Google")
  }

  // Step 3: Fetch incomplete reminders (excludes just-completed ones)
  log.startSpinner("Fetching reminders")
  let predicate = eventStore.predicateForIncompleteReminders(
    withDueDateStarting: nil,
    ending: nil,
    calendars: nil
  )

  var reminders: [EKReminder] = []
  let fetchSemaphore = DispatchSemaphore(value: 0)

  eventStore.fetchReminders(matching: predicate) { result in
    reminders = result ?? []
    fetchSemaphore.signal()
  }

  fetchSemaphore.wait()
  log.stopSpinner(success: true, message: "Found \(reminders.count) incomplete reminders")

  // Handle reset
  var state = loadSyncState()
  if resetSync {
    log.info("Resetting sync state...")
    state = SyncState(syncedReminders: [:])
    saveSyncState(state)
  }

  let previousCount = state.syncedReminders.count

  for reminder in reminders {
    let title = reminder.title ?? "Untitled"
    let listName = reminder.calendar?.title ?? "Unknown"
    let prefix = "[\(listName)] \(title)"
    let uid = reminder.calendarItemIdentifier

    // Skip if just imported from Google (prevent sync loop)
    if importedUIDs.contains(uid) {
      log.skipped("\(prefix) (just imported)")
      continue
    }

    // Skip if already synced (unless force flag is set)
    if !forceSync && state.syncedReminders[uid] != nil {
      log.skipped("\(prefix) (skipped)")
      continue
    }

    // Start spinner before sync
    log.startSpinner(prefix)

    // Perform sync
    let result = syncReminder(reminder)

    // Handle result and stop spinner with appropriate message
    switch result {
    case .success(let uid, let synced):
      log.synced("\(prefix) (synced)")
      state.syncedReminders[uid] = synced

    case .alreadySynced:
      log.skipped("\(prefix) (already synced)")

    case .updated:
      log.synced("\(prefix) (updated)")
      state.syncedReminders[reminder.calendarItemIdentifier] = SyncedReminder(
        googleTaskId: nil,
        syncedAt: Date(),
        title: title
      )

    case .failed(let message):
      log.failed("\(prefix) (\(message))")

    case .error(let message):
      log.failed("\(prefix) (\(message))")
    }
  }

  saveSyncState(state)

  let newlySynced = state.syncedReminders.count - previousCount
  log.success("Sync complete: \(newlySynced) new reminders synced")
}

main()
