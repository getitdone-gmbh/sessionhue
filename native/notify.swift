// sessionhue notifier: native macOS notifications with answer actions for terminal sessions.
// Posted by the sessionhue CLI, answers are typed into the iTerm2 session the notification belongs to.
import AppKit
import CloudKit
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
    // After the keys (e.g. "/exit"), closes the iTerm2 session, and with it the tab or window.
    var close: Bool?
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
    // When set, the title becomes the iTerm2 session name plus this suffix.
    var titleSuffix: String?
    // Forward to iPhone / Apple Watch while the Mac is locked or unused.
    var remote: Remote?
}

struct Remote: Codable {
    var iphone: Bool
    var watch: Bool
    // Minutes without input on the Mac before a waiting notification goes to the phone.
    var awayMinutes: Double?
    // Approval or question with choices: the only kind that goes to Apple Watch.
    var choices: Bool?
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

func closeSession(_ tty: String) {
    // Give the agent a moment to exit, so iTerm2 sees only the shell and closes without asking.
    Thread.sleep(forTimeInterval: 1.5)
    _ = runScript(inSession(tty, "tell s to close"))
}

// The iTerm2 session name without the spinner glyph in front and the "(claude)" behind, e.g. "Workbase renaming".
func sessionName(_ tty: String) -> String? {
    guard let raw = runScript(inSession(tty, "return name of s")), raw != "missing" else { return nil }
    let name = raw
        .replacingOccurrences(of: "^[^\\p{L}\\p{N}]+", with: "", options: .regularExpression)
        .replacingOccurrences(of: "\\s*\\([^)]*\\)$", with: "", options: .regularExpression)
        .trimmingCharacters(in: .whitespaces)
    return name.isEmpty ? nil : name
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

// The title as shown, kept for forwarding the same text to the phone.
var shownTitle: String?

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
            if let suffix = p.titleSuffix, let name = sessionName(p.tty) { content.title = name + suffix } else { content.title = p.title }
            if let s = p.subtitle { content.subtitle = s }
            content.body = p.body
            shownTitle = content.title
            content.sound = .default
            content.categoryIdentifier = categoryId
            content.threadIdentifier = p.tty
            var info: [String: Any] = ["tty": p.tty, "keys": Dictionary(uniqueKeysWithValues: p.actions.map { ($0.id, $0.keys ?? []) }), "close": p.actions.filter { $0.close == true }.map(\.id)]
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

// Types the chosen answer into the session, from a click on the Mac or an answer from the phone.
func answer(_ info: [AnyHashable: Any], _ action: String, text: String?) {
    let tty = info["tty"] as? String ?? ""
    let keys = (info["keys"] as? [String: [String]])?[action] ?? []
    if !stillPending(info) {
        // Answered in the terminal meanwhile: just show the session.
        focus(tty)
    } else if let text {
        type(tty, keys + [text, "\r"])
    } else {
        type(tty, keys)
        if (info["close"] as? [String])?.contains(action) == true { closeSession(tty) }
    }
}

let containerId = "iCloud.com.getitdone.sessionhue"

// Only a notifier signed with the iCloud container can relay; the plain build stays local.
func canRelay() -> Bool {
    guard let task = SecTaskCreateFromSelf(nil) else { return false }
    return SecTaskCopyValueForEntitlement(task, "com.apple.developer.icloud-container-identifiers" as CFString, nil) != nil
}

func macAway(minutes: Double) -> Bool {
    if let session = CGSessionCopyCurrentDictionary() as? [String: Any], (session["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue == true { return true }
    let idle = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!)
    return idle >= minutes * 60
}

// Waits while a notification is open: hands it to the phone once the Mac is unused, and types the answer that comes back.
final class Relay {
    let p: Post
    let remote: Remote
    let title: String
    // Held strongly: operations on a database whose container is gone never finish.
    // All operations run as user initiated; the default (utility) can wait minutes in a background app.
    let container = CKContainer(identifier: containerId)
    var db: CKDatabase { container.privateCloudDatabase }
    let started = Date()
    var forwarded = false
    var answered = false
    var busy = false
    var timer: Timer?

    init(_ p: Post, remote: Remote, title: String) {
        self.p = p
        self.remote = remote
        self.title = title
    }

    var token: String { p.token ?? "" }
    var info: [AnyHashable: Any] {
        ["tty": p.tty, "pendingFile": p.pendingFile ?? "", "token": token, "keys": Dictionary(uniqueKeysWithValues: p.actions.map { ($0.id, $0.keys ?? []) }), "close": p.actions.filter { $0.close == true }.map(\.id)]
    }
    var noticeID: CKRecord.ID { CKRecord.ID(recordName: "notice-\(token)") }
    var replyID: CKRecord.ID { CKRecord.ID(recordName: "reply-\(token)") }

    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.tick() }
        tick()
    }

    func tick() {
        guard !busy, !answered else { return }
        // A day is long enough; an agent waiting longer gets its answer in the terminal.
        if !stillPending(info) || Date().timeIntervalSince(started) > 86_400 { return finish() }
        if !forwarded {
            if macAway(minutes: remote.awayMinutes ?? 3) { forward() }
        } else {
            checkReply()
        }
    }

    func forward() {
        let phone = remote.iphone
        let watch = remote.watch && remote.choices == true
        guard phone || watch else { return finish() }
        let record = CKRecord(recordType: "Notice", recordID: noticeID)
        record["title"] = title
        record["subtitle"] = p.subtitle ?? ""
        record["body"] = String(p.body.prefix(600))
        record["sendTitle"] = p.sendTitle ?? "Send"
        let actions = p.actions.map { a -> [String: Any] in
            ["id": a.id, "title": a.title, "reply": a.reply ?? false, "placeholder": a.placeholder ?? "", "destructive": a.destructive ?? false]
        }
        record["actions"] = String(data: try! JSONSerialization.data(withJSONObject: actions), encoding: .utf8)
        record["phone"] = phone ? 1 : 0
        record["watch"] = watch ? 1 : 0
        busy = true
        let op = CKModifyRecordsOperation(recordsToSave: [record], recordIDsToDelete: nil)
        op.qualityOfService = .userInitiated
        op.modifyRecordsResultBlock = { result in
            DispatchQueue.main.async {
                self.busy = false
                if case .failure(let error) = result { return log("relay: \(error.localizedDescription)") }
                self.forwarded = true
                log("relay \(self.p.id) to\(phone ? " iphone" : "")\(watch ? " watch" : "")")
            }
        }
        db.add(op)
    }

    func checkReply() {
        busy = true
        let op = CKFetchRecordsOperation(recordIDs: [replyID])
        op.qualityOfService = .userInitiated
        var found: CKRecord?
        op.perRecordResultBlock = { _, result in found = try? result.get() }
        op.fetchRecordsResultBlock = { _ in
            DispatchQueue.main.async {
                self.busy = false
                // Typing can take a while; a reply fetched again meanwhile must not be typed twice.
                guard !self.answered, let record = found, let action = record["action"] as? String else { return }
                self.answered = true
                let text = record["text"] as? String
                log("reply \(action) for \(self.p.tty) from \(record["device"] as? String ?? "phone")")
                answer(self.info, action, text: text?.isEmpty == false || self.p.actions.first { $0.id == action }?.reply == true ? text ?? "" : nil)
                center.removeDeliveredNotifications(withIdentifiers: [self.p.id])
                self.finish()
            }
        }
        db.add(op)
    }

    // Withdraws the notification from the phone and leaves.
    func finish() {
        timer?.invalidate()
        guard forwarded else { return NSApp.terminate(nil) }
        busy = true
        let op = CKModifyRecordsOperation(recordsToSave: nil, recordIDsToDelete: [noticeID, replyID])
        op.qualityOfService = .userInitiated
        op.perRecordDeleteBlock = { id, result in
            if case .failure(let error) = result, (error as? CKError)?.code != .unknownItem { log("withdraw \(id.recordName): \(error.localizedDescription)") }
        }
        op.modifyRecordsResultBlock = { _ in
            log("withdrew \(self.p.id) from the phone")
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
        db.add(op)
        // Never hang on a missing network.
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { NSApp.terminate(nil) }
    }
}

var relay: Relay?

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
            post(p) {
                if let remote = p.remote, remote.iphone || remote.watch, p.token != nil, let title = shownTitle, canRelay() {
                    DispatchQueue.main.async {
                        relay = Relay(p, remote: remote, title: title)
                        relay?.start()
                    }
                } else {
                    quit()
                }
            }
        case "clear":
            let ids = Array(args.dropFirst())
            log("clear \(ids)")
            center.removeDeliveredNotifications(withIdentifiers: ids)
            center.removePendingNotificationRequests(withIdentifiers: ids)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: quit)
        case "relay-check":
            // For `sessionhue notify status`: can this build relay, and is iCloud signed in?
            guard canRelay() else { print("no-entitlement"); return quit() }
            let container = CKContainer(identifier: containerId)
            container.accountStatus { status, _ in
                guard status == .available else { print("no-account"); return quit() }
                // Which devices listen: the apps subscribe as "phone-notices" and "watch-notices".
                container.privateCloudDatabase.fetchAllSubscriptions { subs, _ in
                    let devices = (subs ?? []).map(\.subscriptionID).filter { $0.hasSuffix("-notices") }.map { $0.replacingOccurrences(of: "-notices", with: "") }
                    print("devices \(devices.sorted().joined(separator: ","))")
                    print("ok")
                    quit()
                }
            }
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
        log("action \(response.actionIdentifier) for \(tty)")
        switch response.actionIdentifier {
        case UNNotificationDismissActionIdentifier:
            // Closed with X: nothing happens, the session keeps waiting in the terminal.
            break
        case UNNotificationDefaultActionIdentifier:
            focus(tty)
        default:
            answer(info, response.actionIdentifier, text: (response as? UNTextInputNotificationResponse)?.userText)
        }
        completionHandler()
        // A process that relays its own notification to the phone keeps going until that one is settled.
        if relay == nil { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) } }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
}

@main
struct Notifier {
    static let delegate = Delegate()

    static func main() {
        let app = NSApplication.shared
        app.delegate = delegate
        app.setActivationPolicy(.prohibited)
        app.run()
    }
}
