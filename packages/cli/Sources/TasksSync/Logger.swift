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
    private var timer: Timer?
    private let message: String
    private var isRunning = false

    init(message: String) {
        self.message = message
    }

    func start() {
        guard !isRunning else { return }
        isRunning = true
        hideCursor()

        // Update spinner every 80ms
        timer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.render()
            self.currentFrame = (self.currentFrame + 1) % self.frames.count
        }

        RunLoop.current.add(timer!, forMode: .common)
    }

    func stop(success: Bool = true, message: String? = nil) {
        guard isRunning else { return }
        isRunning = false

        timer?.invalidate()
        timer = nil

        // Clear the line
        print("\r\u{001B}[K", terminator: "")

        // Print final message with symbol
        if let finalMessage = message {
            let symbol = success ? "✓".green : "✗".red
            let timestamp = getCurrentTimestamp()
            print("[\(timestamp)]".lightBlack + " " + symbol + " " + finalMessage)
        }

        showCursor()
    }

    private func render() {
        let frame = frames[currentFrame].cyan
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
