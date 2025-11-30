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

struct CompletedTask: Codable {
  let uid: String
  let title: String
  let completedAt: String?
}

struct CompletedTasksResponse: Codable {
  let success: Bool
  let completed: [CompletedTask]
  let timestamp: String
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

// Fetch completed tasks from server
func fetchCompletedTasks() -> [CompletedTask] {
  guard let url = URL(string: "\(webhookURL)?secret=\(webhookSecret)&action=completed") else {
    log.failed("Invalid webhook URL")
    return []
  }

  var request = URLRequest(url: url)
  request.httpMethod = "GET"

  let semaphore = DispatchSemaphore(value: 0)
  var completedTasks: [CompletedTask] = []

  URLSession.shared.dataTask(with: request) { data, response, error in
    defer { semaphore.signal() }

    if let error = error {
      log.failed("Error fetching completed tasks: \(error.localizedDescription)")
      return
    }

    guard let data = data,
      let response = try? JSONDecoder().decode(CompletedTasksResponse.self, from: data)
    else {
      log.failed("Invalid response from completed tasks endpoint")
      return
    }

    if response.success {
      completedTasks = response.completed
    }
  }.resume()

  semaphore.wait()
  return completedTasks
}

// Mark a reminder as complete in Apple Reminders
func markReminderComplete(uid: String, eventStore: EKEventStore) -> Bool {
  guard let reminder = eventStore.calendarItem(withIdentifier: uid) as? EKReminder else {
    return false
  }

  reminder.isCompleted = true
  reminder.completionDate = Date()

  do {
    try eventStore.save(reminder, commit: true)
    return true
  } catch {
    log.failed("Failed to mark reminder complete: \(error.localizedDescription)")
    return false
  }
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

  // Step 1: Pull completions from Google Tasks
  log.startSpinner("Checking for completed tasks in Google")
  let completedTasks = fetchCompletedTasks()
  log.stopSpinner(success: true, message: "Found \(completedTasks.count) completed tasks")

  // Mark completed tasks as complete in Apple Reminders
  var completedCount = 0
  for task in completedTasks {
    let listName = "Google" // We don't have list info from server yet
    let prefix = "[\(listName)] \(task.title)"

    if markReminderComplete(uid: task.uid, eventStore: eventStore) {
      log.synced("\(prefix) (completed)")
      completedCount += 1
    } else {
      log.skipped("\(prefix) (not found locally)")
    }
  }

  if completedCount > 0 {
    log.success("\(completedCount) reminders marked as complete")
  }

  // Step 2: Fetch incomplete reminders (excludes just-completed ones)
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

    // Skip if already synced (unless force flag is set)
    if !forceSync && state.syncedReminders[reminder.calendarItemIdentifier] != nil {
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
