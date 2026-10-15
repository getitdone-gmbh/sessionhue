// sessionhue notifier: native macOS notifications with answer actions for terminal sessions.
// Posted by the sessionhue CLI, answers are typed into the iTerm2 session the notification belongs to.
import AppKit
import UserNotifications

struct Action: Codable {
    let id: String
    let title: String
    // Keystrokes typed into the session, sent one after another ("\u{1b}" = Esc, "\r" = Enter).
    var keys: [String]?
    // Shows a text field; the typed text is sent followed by Enter.
    var reply: Bool?
    var placeholder: String?
    var destructive: Bool?
}

struct Post: Codable {
    let id: String
    let tty: String
    let title: String
    var subtitle: String?
    let body: String
    // The answer is only typed while this file still holds `token`, so a stale notification never types into a session that moved on.
    var pendingFile: String?
    var token: String?
    var actions: [Action]
    var skipIfFocused: Bool?
    var sendTitle: String?
}

let center = UNUserNotificationCenter.current()
let logFile = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/sessionhue.log")

func log(_ message: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
    // Keep the log small: start over past 512 KB.
    if let size = try? FileManager.default.attributesOfItem(atPath: logFile.path)[.size] as? Int, size > 512_000 {
        try? FileManager.default.removeItem(at: logFile)
    }
    if let h = try? FileHandle(forWritingTo: logFile) {
        h.seekToEndOfFile()
        h.write(line.data(using: .utf8)!)
        try? h.close()
    } else {
        try? line.write(to: logFile, atomically: true, encoding: .utf8)
    }
}

func runScript(_ source: String) -> String? {
    var error: NSDictionary?
    let result = NSAppleScript(source: source)?.executeAndReturnError(&error)
    if let error { log("applescript: \(error)") }
    return result?.stringValue
}

func appleString(_ text: String) -> String {
    var parts: [String] = []
    var literal = ""
    for ch in text.unicodeScalars {
        if ch.value < 32 || ch == "\"" || ch == "\\" {
            if !literal.isEmpty { parts.append("\"\(literal)\""); literal = "" }
            parts.append("(ASCII character \(ch.value))")
        } else {
            literal.unicodeScalars.append(ch)
        }
    }
    if !literal.isEmpty || parts.isEmpty { parts.append("\"\(literal)\"") }
    return parts.joined(separator: " & ")
}

func inSession(_ tty: String, _ body: String) -> String {
    """
    tell application id "com.googlecode.iterm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if tty of s is \(appleString(tty)) then
              \(body)
              return "ok"
            end if
          end repeat
        end repeat
      end repeat
    end tell
    return "missing"
    """
}

func focus(_ tty: String) {
    _ = runScript(inSession(tty, "select w\n              tell t to select\n              tell s to select\n              activate"))
}

func type(_ tty: String, _ keys: [String]) {
    for (i, key) in keys.enumerated() {
        if i > 0 { Thread.sleep(forTimeInterval: 0.15) }
        _ = runScript(inSession(tty, "tell s to write text \(appleString(key)) newline NO"))
    }
}

func isFocused(_ tty: String) -> Bool {
    let script = """
    tell application id "com.googlecode.iterm2"
      if not frontmost then return "no"
      if tty of current session of current window is \(appleString(tty)) then return "yes"
    end tell
    return "no"
    """
    return runScript(script) == "yes"
}

func stillPending(_ info: [AnyHashable: Any]) -> Bool {
    guard let file = info["pendingFile"] as? String, let token = info["token"] as? String else { return true }
    let current = (try? String(contentsOfFile: file, encoding: .utf8))?.split(separator: "\n").first.map(String.init)
    return current == token
}

func post(_ p: Post, done: @escaping () -> Void) {
    if p.skipIfFocused == true && isFocused(p.tty) { return done() }
    center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
        guard granted else {
            log("notifications are turned off for sessionhue in System Settings")
            return done()
        }
        let actions: [UNNotificationAction] = p.actions.map { a in
            let options: UNNotificationActionOptions = a.destructive == true ? [.destructive] : []
            if a.reply == true {
                return UNTextInputNotificationAction(identifier: a.id, title: a.title, options: options, textInputButtonTitle: p.sendTitle ?? "Send", textInputPlaceholder: a.placeholder ?? "")
            }
            return UNNotificationAction(identifier: a.id, title: a.title, options: options)
        }
        let categoryId = "sessionhue.\(p.id).\(p.token ?? "")"
        let category = UNNotificationCategory(identifier: categoryId, actions: actions, intentIdentifiers: [], options: [.customDismissAction])
        center.getNotificationCategories { existing in
            // Keep the categories of notifications that are still on screen, so their buttons stay.
            let kept = existing.filter { !$0.identifier.hasPrefix("sessionhue.\(p.id).") }.suffix(40)
            center.setNotificationCategories(Set(kept).union([category]))
            let content = UNMutableNotificationContent()
            content.title = p.title
            if let s = p.subtitle { content.subtitle = s }
            content.body = p.body
            content.sound = .default
            content.categoryIdentifier = categoryId
            content.threadIdentifier = p.tty
            var info: [String: Any] = ["tty": p.tty, "keys": Dictionary(uniqueKeysWithValues: p.actions.map { ($0.id, $0.keys ?? []) })]
            if let f = p.pendingFile { info["pendingFile"] = f }
            if let t = p.token { info["token"] = t }
            content.userInfo = info
            // Same id per session: a new notification replaces the old one instead of stacking up.
            log("post \(p.id) actions \(p.actions.map { $0.id })")
            center.add(UNNotificationRequest(identifier: p.id, content: content, trigger: nil)) { error in
                if let error { log("post: \(error.localizedDescription)") }
                done()
            }
        }
    }
}

class Delegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    var handled = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        center.delegate = self
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments.dropFirst()
        let quit = { DispatchQueue.main.async { NSApp.terminate(nil) } }
        switch args.first {
        case "post":
            let data = args.count > 1 ? Data(args[args.startIndex + 1].utf8) : FileHandle.standardInput.readDataToEndOfFile()
            guard let p = try? JSONDecoder().decode(Post.self, from: data) else {
                log("invalid post payload")
                exit(2)
            }
            post(p, done: quit)
        case "clear":
            let ids = Array(args.dropFirst())
            center.removeDeliveredNotifications(withIdentifiers: ids)
            center.removePendingNotificationRequests(withIdentifiers: ids)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: quit)
        case "focused":
            print(isFocused(args.dropFirst().first ?? "") ? "yes" : "no")
            quit()
        default:
            // Launched by macOS for a click on a notification: handle it, then leave.
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { NSApp.terminate(nil) }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let tty = info["tty"] as? String ?? ""
        let keys = (info["keys"] as? [String: [String]])?[response.actionIdentifier] ?? []
        log("action \(response.actionIdentifier) for \(tty)")
        switch response.actionIdentifier {
        case UNNotificationDismissActionIdentifier:
            // Closed with X: nothing happens, the session keeps waiting in the terminal.
            break
        case UNNotificationDefaultActionIdentifier:
            focus(tty)
        default:
            if !stillPending(info) {
                // Answered in the terminal meanwhile: just show the session.
                focus(tty)
            } else if let reply = response as? UNTextInputNotificationResponse {
                type(tty, keys + [reply.userText, "\r"])
            } else {
                type(tty, keys)
            }
        }
        completionHandler()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.prohibited)
app.run()
