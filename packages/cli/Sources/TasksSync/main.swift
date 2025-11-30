import EventKit
import Foundation

// Configuration
let webhookURL = ProcessInfo.processInfo.environment["WEBHOOK_URL"] ?? ""
let webhookSecret = ProcessInfo.processInfo.environment["WEBHOOK_SECRET"] ?? ""
let syncStateFile = FileManager.default.homeDirectoryForCurrentUser
  .appendingPathComponent(".tasks-sync-state.json")
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

// Send reminder to webhook - returns synced reminder info if successful
func syncReminder(_ reminder: EKReminder) -> (uid: String, synced: SyncedReminder)? {
  let uid = reminder.calendarItemIdentifier

  let listName = reminder.calendar?.title
  print("  List: \(listName ?? "none")")

  let payload = WebhookPayload(
    title: reminder.title ?? "Untitled",
    notes: reminder.notes,
    list: listName,
    dueDate: reminder.dueDateComponents?.date?.ISO8601Format(),
    uid: uid,
    force: forceSync ? true : nil
  )

  guard let url = URL(string: "\(webhookURL)?secret=\(webhookSecret)") else {
    print("Invalid webhook URL")
    return nil
  }

  var request = URLRequest(url: url)
  request.httpMethod = "POST"
  request.setValue("application/json", forHTTPHeaderField: "Content-Type")
  request.httpBody = try? JSONEncoder().encode(payload)

  let semaphore = DispatchSemaphore(value: 0)
  var result: (uid: String, synced: SyncedReminder)?

  URLSession.shared.dataTask(with: request) { data, response, error in
    defer { semaphore.signal() }

    if let error = error {
      print("Error syncing '\(reminder.title ?? "")': \(error.localizedDescription)")
      return
    }

    guard let data = data,
      let response = try? JSONDecoder().decode(WebhookResponse.self, from: data)
    else {
      print("✗ Invalid response for '\(reminder.title ?? "")'")
      return
    }

    if response.success {
      if response.message == "Already synced" {
        print("⏭ Skipped (already synced): \(reminder.title ?? "")")
      } else if response.message == "Task updated successfully" {
        print("✓ Updated: \(reminder.title ?? "")")
      } else {
        print("✓ Synced: \(reminder.title ?? "")")
      }
      result = (
        uid: uid,
        synced: SyncedReminder(
          googleTaskId: response.taskId,
          syncedAt: Date(),
          title: reminder.title ?? ""
        )
      )
    } else {
      print("✗ Failed: \(reminder.title ?? "") - \(response.message)")
    }
  }.resume()

  semaphore.wait()
  return result
}

// Main
func main() {
  guard !webhookURL.isEmpty else {
    print("Error: WEBHOOK_URL environment variable is required")
    print("Usage: WEBHOOK_URL=https://... WEBHOOK_SECRET=... tasks-sync")
    exit(1)
  }

  let eventStore = EKEventStore()

  // Request access to reminders
  let semaphore = DispatchSemaphore(value: 0)
  var accessGranted = false

  if #available(macOS 14.0, *) {
    eventStore.requestFullAccessToReminders { granted, error in
      accessGranted = granted
      if let error = error {
        print("Error requesting access: \(error.localizedDescription)")
      }
      semaphore.signal()
    }
  } else {
    eventStore.requestAccess(to: .reminder) { granted, error in
      accessGranted = granted
      if let error = error {
        print("Error requesting access: \(error.localizedDescription)")
      }
      semaphore.signal()
    }
  }

  semaphore.wait()

  guard accessGranted else {
    print("Error: Access to Reminders was denied")
    print("Grant access in System Settings → Privacy & Security → Reminders")
    exit(1)
  }

  // Fetch incomplete reminders
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

  print("Found \(reminders.count) incomplete reminders")

  // Handle reset
  var state = loadSyncState()
  if resetSync {
    print("Resetting sync state...")
    state = SyncState(syncedReminders: [:])
    saveSyncState(state)
  }

  let previousCount = state.syncedReminders.count

  for reminder in reminders {
    // Skip if already synced (unless force flag is set)
    if !forceSync && state.syncedReminders[reminder.calendarItemIdentifier] != nil {
      print("⏭ Skipped: \(reminder.title ?? "Untitled")")
      continue
    }

    print("Syncing: \(reminder.title ?? "Untitled")")
    if let result = syncReminder(reminder) {
      state.syncedReminders[result.uid] = result.synced
    }
  }

  saveSyncState(state)

  let newlySynced = state.syncedReminders.count - previousCount
  print("Sync complete: \(newlySynced) new reminders synced")
}

main()
