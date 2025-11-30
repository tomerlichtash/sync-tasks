import Foundation
import Logging
import Rainbow

/// CLI Logger with timestamps, colors, and spinners
class CLILogger {
    private let logger: Logger
    private var spinner: Spinner?

    init(label: String = "sync-tasks") {
        // Create logger
        var logger = Logger(label: label)
        logger.logLevel = .info

        // Set custom log handler with timestamps and colors
        LoggingSystem.bootstrap { label in
            var handler = StreamLogHandler.standardOutput(label: label)
            handler.logLevel = .info
            return handler
        }

        self.logger = logger
    }

    // MARK: - Logging Methods

    func debug(_ message: String) {
        stopSpinner()
        print(formatLog("DEBUG", message, color: .lightBlack))
    }

    func info(_ message: String) {
        stopSpinner()
        print(formatLog("INFO", message, color: .cyan))
    }

    func success(_ message: String) {
        stopSpinner()
        print(formatLog("OK", message, color: .green))
    }

    func warn(_ message: String) {
        stopSpinner()
        print(formatLog("WARN", message, color: .yellow))
    }

    func error(_ message: String) {
        stopSpinner()
        print(formatLog("ERROR", message, color: .red))
    }

    func skipped(_ message: String) {
        stopSpinner()
        let timestamp = getCurrentTimestamp()
        print("[\(timestamp)]".lightBlack + " " + "⏭".cyan + " " + message)
    }

    func synced(_ message: String) {
        stopSpinner()
        let timestamp = getCurrentTimestamp()
        print("[\(timestamp)]".lightBlack + " " + "✓".green + " " + message)
    }

    func failed(_ message: String) {
        stopSpinner()
        let timestamp = getCurrentTimestamp()
        print("[\(timestamp)]".lightBlack + " " + "✗".red + " " + message)
    }

    // MARK: - Spinner Methods

    func startSpinner(_ message: String) {
        stopSpinner()
        spinner = Spinner(message: message)
        spinner?.start()
    }

    func stopSpinner(success: Bool = true, message: String? = nil) {
        spinner?.stop(success: success, message: message)
        spinner = nil
    }

    // MARK: - Private Helpers

    private func formatLog(_ level: String, _ message: String, color: NamedColor) -> String {
        let timestamp = getCurrentTimestamp()
        let levelPadded = level.padding(toLength: 5, withPad: " ", startingAt: 0)
        return "[\(timestamp)]".lightBlack + " " + levelPadded.applyingColor(color) + " " + message
    }

    private func getCurrentTimestamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        return formatter.string(from: Date())
    }
}

/// ASCII Spinner for CLI operations
class Spinner {
    private let frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    private var currentFrame = 0
    private var spinnerThread: Thread?
    private let message: String
    private var isRunning = false
    private let lock = NSLock()

    init(message: String) {
        self.message = message
    }

    func start() {
        lock.lock()
        guard !isRunning else {
            lock.unlock()
            return
        }
        isRunning = true
        lock.unlock()

        hideCursor()

        // Run spinner on background thread to avoid RunLoop blocking
        spinnerThread = Thread { [weak self] in
            while true {
                self?.lock.lock()
                let running = self?.isRunning ?? false
                self?.lock.unlock()

                if !running { break }

                self?.render()
                Thread.sleep(forTimeInterval: 0.08)
            }
        }
        spinnerThread?.start()
    }

    func stop(success: Bool = true, message: String? = nil) {
        lock.lock()
        guard isRunning else {
            lock.unlock()
            return
        }
        isRunning = false
        lock.unlock()

        // Wait for thread to finish
        while spinnerThread?.isFinished == false {
            Thread.sleep(forTimeInterval: 0.01)
        }
        spinnerThread = nil

        // Clear the line
        print("\r\u{001B}[K", terminator: "")
        fflush(stdout)

        // Print final message with symbol
        if let finalMessage = message {
            let symbol = success ? "✓".green : "✗".red
            let timestamp = getCurrentTimestamp()
            print("[\(timestamp)]".lightBlack + " " + symbol + " " + finalMessage)
        }

        showCursor()
    }

    private func render() {
        lock.lock()
        let frame = frames[currentFrame].cyan
        currentFrame = (currentFrame + 1) % frames.count
        lock.unlock()

        let timestamp = getCurrentTimestamp()
        print("\r\u{001B}[K[\(timestamp)]".lightBlack + " " + frame + " " + message, terminator: "")
        fflush(stdout)
    }

    private func hideCursor() {
        print("\u{001B}[?25l", terminator: "")
        fflush(stdout)
    }

    private func showCursor() {
        print("\u{001B}[?25h", terminator: "")
        fflush(stdout)
    }

    private func getCurrentTimestamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        return formatter.string(from: Date())
    }
}

// MARK: - Extensions

extension String {
    func applyingColor(_ color: NamedColor) -> String {
        switch color {
        case .black: return self.black
        case .red: return self.red
        case .green: return self.green
        case .yellow: return self.yellow
        case .blue: return self.blue
        case .magenta: return self.magenta
        case .cyan: return self.cyan
        case .white: return self.white
        case .default: return self
        case .lightBlack: return self.lightBlack
        case .lightRed: return self.lightRed
        case .lightGreen: return self.lightGreen
        case .lightYellow: return self.lightYellow
        case .lightBlue: return self.lightBlue
        case .lightMagenta: return self.lightMagenta
        case .lightCyan: return self.lightCyan
        case .lightWhite: return self.lightWhite
        }
    }
}
