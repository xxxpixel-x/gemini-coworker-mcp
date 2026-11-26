// Probe whether the Gemini app for macOS can be driven in the background through the Accessibility API.
// Read-only except `roundtrip`, which sends one test message to a chat you name.
//
// Build: swiftc -O -o gemini-ax-probe native/macos/GeminiAXProbe.swift
// Usage: ./gemini-ax-probe [inventory|probe|dump|roundtrip] [options]   (see usage() below)
//
// The output is one JSON report on stdout. Conversation text and text-field contents are redacted
// unless --show-text is given; window titles, button labels and link names may still appear.

import AppKit
import ApplicationServices
import CryptoKit
import Foundation

let opts = parseOptions()
let report = Report()
let systemWide = AXUIElementCreateSystemWide()

// MARK: - Options

struct Options {
    var command = "inventory"
    var pid: pid_t? = nil
    var window: Int? = nil
    var depth = 80
    var maxNodes = 15000
    var showText = false
    var enhanced = false
    var delay = 8
    var scenario = "unspecified"
    var timeout = 120.0
    var input = "value"
}

func usage() -> Never {
    say("""
    usage: gemini-ax-probe <command> [options]

    commands
      inventory   Installed and running Gemini apps, Accessibility permission, windows and chat routes (default)
      probe       Read-only: composer, send button and conversation text the helper could use
      dump        Read-only: the Accessibility tree of the app or of one window
      roundtrip   Sends ONE test message to the chat in --window and checks focus, clipboard and the reply

    options
      --pid N          Pick the Gemini process when several are running
      --window N       Window index from inventory (required for roundtrip; limits probe and dump)
      --scenario NAME  Label stored in the roundtrip report, e.g. behind-other-app, minimized, hidden
      --delay N        Seconds before roundtrip sends, to switch to another app (default 8)
      --timeout N      Seconds to wait for the reply (default 120)
      --input MODE     How roundtrip writes the draft: value (default) or selected-text
      --enhanced       Also set AXEnhancedUserInterface if the web content tree stays empty
      --depth N        Maximum tree depth (default 80)
      --max-nodes N    Maximum elements visited per walk (default 15000)
      --show-text      Do not redact conversation text (do not share such output)
    """)
    exit(2)
}

func parseOptions() -> Options {
    var o = Options()
    var args = Array(CommandLine.arguments.dropFirst())
    if let first = args.first, !first.hasPrefix("-") {
        o.command = first
        args.removeFirst()
    }
    guard ["inventory", "probe", "dump", "roundtrip"].contains(o.command) else { usage() }
    var i = 0
    func value() -> String {
        i += 1
        if i >= args.count { usage() }
        return args[i]
    }
    func number(_ s: String) -> Int {
        guard let n = Int(s), n >= 0 else { usage() }
        return n
    }
    while i < args.count {
        switch args[i] {
        case "--pid": o.pid = pid_t(number(value()))
        case "--window": o.window = number(value())
        case "--depth": o.depth = number(value())
        case "--max-nodes": o.maxNodes = number(value())
        case "--delay": o.delay = number(value())
        case "--timeout": o.timeout = Double(number(value()))
        case "--scenario": o.scenario = value()
        case "--input":
            o.input = value()
            guard ["value", "selected-text"].contains(o.input) else { usage() }
        case "--show-text": o.showText = true
        case "--enhanced": o.enhanced = true
        default: usage()
        }
        i += 1
    }
    return o
}

// MARK: - Report

struct ProbeError: Error {
    let message: String
    let notSent: Bool
    init(_ message: String, notSent: Bool = true) {
        self.message = message
        self.notSent = notSent
    }
}

final class Report {
    var data: [String: Any] = [:]
    var events: [[String: Any]] = []
    let started = Date()

    func elapsed() -> Double { (Date().timeIntervalSince(started) * 1000).rounded() / 1000 }

    func event(_ name: String, _ extra: [String: Any] = [:]) {
        var e = extra
        e["event"] = name
        e["t"] = elapsed()
        events.append(e)
    }
}

func say(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}

func emit(_ object: [String: Any]) {
    let options: JSONSerialization.WritingOptions = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: options) else {
        say("Internal error: report is not valid JSON.")
        print(object)
        return
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

/// Sleep while still letting the run loop deliver anything it has.
func pause(_ seconds: Double) {
    let until = Date(timeIntervalSinceNow: seconds)
    while Date() < until {
        if !RunLoop.current.run(mode: .default, before: until) { Thread.sleep(until: until) }
    }
}

func j(_ value: Any?) -> Any { value ?? NSNull() }

func redact(_ s: String) -> String {
    if opts.showText { return String(s.prefix(400)) }
    return s.isEmpty ? "" : "<\(s.count) chars>"
}

func redactOptional(_ s: String?) -> Any {
    guard let s else { return NSNull() }
    return redact(s)
}

func normalize(_ s: String) -> String {
    var out = s.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
    while out.hasSuffix("\n") { out.removeLast() }
    return out
}

func sha256(_ s: String) -> String {
    SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}

// MARK: - Accessibility helpers

func axName(_ e: AXError) -> String {
    switch e {
    case .success: return "success"
    case .failure: return "failure"
    case .illegalArgument: return "illegalArgument"
    case .invalidUIElement: return "invalidUIElement"
    case .cannotComplete: return "cannotComplete"
    case .attributeUnsupported: return "attributeUnsupported"
    case .actionUnsupported: return "actionUnsupported"
    case .notImplemented: return "notImplemented"
    case .apiDisabled: return "apiDisabled"
    case .noValue: return "noValue"
    case .parameterizedAttributeUnsupported: return "parameterizedAttributeUnsupported"
    default: return "AXError(\(e.rawValue))"
    }
}

func copyAttr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success, let value else { return nil }
    return value
}

func string(_ el: AXUIElement, _ name: String) -> String? { copyAttr(el, name) as? String }

func bool(_ el: AXUIElement, _ name: String) -> Bool? { (copyAttr(el, name) as? NSNumber)?.boolValue }

func elementValue(_ value: AnyObject?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func elements(_ el: AXUIElement, _ name: String) -> [AXUIElement] {
    guard let list = copyAttr(el, name) as? NSArray else { return [] }
    return list.compactMap { elementValue($0 as AnyObject) }
}

func isSettable(_ el: AXUIElement, _ name: String) -> Bool {
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(el, name as CFString, &settable) == .success && settable.boolValue
}

func actionNames(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success, let names else { return [] }
    return (names as NSArray).compactMap { $0 as? String }
}

func pidOf(_ el: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    return AXUIElementGetPid(el, &pid) == .success ? pid : nil
}

func label(_ el: AXUIElement) -> String? {
    for name in ["AXTitle", "AXDescription", "AXHelp"] {
        if let s = string(el, name), !s.isEmpty { return s }
    }
    return nil
}

/// Labels of these roles are usually user content (chat titles, message text).
let contentRoles: Set<String> = ["AXLink", "AXStaticText", "AXHeading", "AXCell", "AXRow", "AXListItem"]

func shownLabel(_ el: AXUIElement) -> Any {
    guard let l = label(el) else { return NSNull() }
    return contentRoles.contains(string(el, "AXRole") ?? "") ? redact(l) : String(l.prefix(80))
}

func domClasses(_ el: AXUIElement) -> [String] {
    guard let list = copyAttr(el, "AXDOMClassList") as? NSArray else { return [] }
    return list.compactMap { $0 as? String }
}

/// Pre-order walk. `visit` returns whether to descend. Returns true when the node budget ran out.
@discardableResult
func walk(_ root: AXUIElement, maxDepth: Int = opts.depth, maxNodes: Int = opts.maxNodes,
          _ visit: (AXUIElement, Int) -> Bool) -> Bool {
    var stack: [(AXUIElement, Int)] = [(root, 0)]
    var count = 0
    while let item = stack.popLast() {
        if count >= maxNodes { return true }
        count += 1
        let (el, depth) = item
        if visit(el, depth), depth < maxDepth {
            stack.append(contentsOf: elements(el, "AXChildren").reversed().map { ($0, depth + 1) })
        }
    }
    return false
}

func collect(_ root: AXUIElement, limit: Int = Int.max, _ match: (AXUIElement) -> Bool) -> [AXUIElement] {
    var found: [AXUIElement] = []
    walk(root) { el, _ in
        if found.count < limit, match(el) { found.append(el) }
        return true
    }
    return found
}

func focusedAppPid() -> pid_t? { elementValue(copyAttr(systemWide, "AXFocusedApplication")).flatMap(pidOf) }

func focusedElement() -> AXUIElement? { elementValue(copyAttr(systemWide, "AXFocusedUIElement")) }

// MARK: - Apps and installs

func archName(_ arch: Int) -> String {
    switch arch {
    case NSBundleExecutableArchitectureARM64: return "arm64"
    case NSBundleExecutableArchitectureX86_64: return "x86_64"
    default: return "other(\(arch))"
    }
}

func policyName(_ p: NSApplication.ActivationPolicy) -> String {
    switch p {
    case .regular: return "regular"
    case .accessory: return "accessory"
    case .prohibited: return "background"
    @unknown default: return "unknown"
    }
}

func bundleInfo(_ url: URL) -> [String: Any] {
    let fm = FileManager.default
    let info = Bundle(url: url)?.infoDictionary ?? [:]
    let frameworks = (try? fm.contentsOfDirectory(atPath: url.appendingPathComponent("Contents/Frameworks").path)) ?? []
    var engine = "native-or-webkit"
    if frameworks.contains("Electron Framework.framework") {
        engine = "electron"
    } else if frameworks.contains(where: { $0.localizedCaseInsensitiveContains("chrom") }) {
        engine = "chromium"
    } else if fm.fileExists(atPath: url.appendingPathComponent("Contents/MacOS/app_mode_loader").path) {
        engine = "chrome-web-app-shim"
    }
    return [
        "path": url.path,
        "bundle_id": j(info["CFBundleIdentifier"]),
        "version": j(info["CFBundleShortVersionString"]),
        "build": j(info["CFBundleVersion"]),
        "minimum_os": j(info["LSMinimumSystemVersion"]),
        "engine": engine,
        "frameworks": Array(frameworks.sorted().prefix(30)),
    ]
}

func installs() -> [[String: Any]] {
    let fm = FileManager.default
    let home = fm.homeDirectoryForCurrentUser.path
    var out: [[String: Any]] = []
    for dir in ["/Applications", home + "/Applications", home + "/Applications/Chrome Apps.localized"] {
        guard let names = try? fm.contentsOfDirectory(atPath: dir) else { continue }
        for name in names where name.hasSuffix(".app") && name.localizedCaseInsensitiveContains("gemini") {
            out.append(bundleInfo(URL(fileURLWithPath: dir).appendingPathComponent(name)))
        }
    }
    return out
}

func candidates() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter {
        ($0.localizedName ?? "").localizedCaseInsensitiveContains("gemini")
            || ($0.bundleIdentifier ?? "").localizedCaseInsensitiveContains("gemini")
    }
}

func describeRunning(_ app: NSRunningApplication) -> [String: Any] {
    [
        "pid": Int(app.processIdentifier),
        "name": j(app.localizedName),
        "bundle_id": j(app.bundleIdentifier),
        "bundle_path": j(app.bundleURL?.path),
        "policy": policyName(app.activationPolicy),
        "active": app.isActive,
        "hidden": app.isHidden,
        "arch": archName(app.executableArchitecture),
    ]
}

func chooseApp() throws -> NSRunningApplication {
    if let pid = opts.pid {
        guard let app = NSRunningApplication(processIdentifier: pid) else { throw ProbeError("No running process \(pid).") }
        return app
    }
    let regular = candidates().filter { $0.activationPolicy == .regular }
    if regular.isEmpty { throw ProbeError("No Gemini app is running. Open it, sign in, and run again.") }
    if regular.count > 1 { throw ProbeError("Several Gemini apps are running (see running); choose one with --pid.") }
    return regular[0]
}

/// Chromium and Electron build their tree only for assistive apps; these attributes ask for it.
func prepare(_ app: NSRunningApplication) -> (AXUIElement, [String: Any]) {
    let el = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(el, 3)
    var notes: [String: Any] = [:]
    notes["AXManualAccessibility"] = axName(AXUIElementSetAttributeValue(el, "AXManualAccessibility" as CFString, kCFBooleanTrue))
    if opts.enhanced {
        notes["AXEnhancedUserInterface"] = axName(AXUIElementSetAttributeValue(el, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue))
    }
    pause(1.5)
    return (el, notes)
}

// MARK: - Windows, conversations and controls

func urlKind(_ url: URL?) -> [String: Any] {
    guard let url else { return ["kind": "none"] }
    guard url.scheme == "https", url.host == "gemini.google.com" else { return ["kind": "other", "host": j(url.host)] }
    var path = url.path
    while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
    if path.range(of: "^/(u/[0-9]+/)?app$", options: .regularExpression) != nil { return ["kind": "blank"] }
    if path.range(of: "^/(u/[0-9]+/)?app/[a-zA-Z0-9_-]+$", options: .regularExpression) != nil {
        return ["kind": "chat", "route": sha256(path)]
    }
    return ["kind": "gemini-other"]
}

func webURL(_ web: AXUIElement) -> URL? { copyAttr(web, "AXURL") as? URL }

func webAreas(_ root: AXUIElement) -> [AXUIElement] {
    var found: [AXUIElement] = []
    walk(root) { el, _ in
        if string(el, "AXRole") == "AXWebArea" {
            found.append(el)
            return false
        }
        return true
    }
    return found
}

func describeWindow(_ w: AXUIElement, index: Int) -> [String: Any] {
    [
        "index": index,
        "title": redactOptional(string(w, "AXTitle")),
        "minimized": j(bool(w, "AXMinimized")),
        "main": j(bool(w, "AXMain")),
        "focused": j(bool(w, "AXFocused")),
        "web_areas": webAreas(w).map { urlKind(webURL($0)) },
    ]
}

let editableRoles: Set<String> = ["AXTextArea", "AXTextField", "AXComboBox", "AXSearchField"]

func editables(in root: AXUIElement) -> [AXUIElement] {
    collect(root) { editableRoles.contains(string($0, "AXRole") ?? "") }
}

func describeEditable(_ el: AXUIElement) -> [String: Any] {
    [
        "role": j(string(el, "AXRole")),
        "subrole": j(string(el, "AXSubrole")),
        "label": shownLabel(el),
        "placeholder": j(string(el, "AXPlaceholderValue")),
        "dom_classes": domClasses(el),
        "value": redactOptional(string(el, "AXValue")),
        "value_settable": isSettable(el, "AXValue"),
        "selected_text_settable": isSettable(el, "AXSelectedText"),
        "enabled": j(bool(el, "AXEnabled")),
        "focused": j(bool(el, "AXFocused")),
        "actions": actionNames(el),
    ]
}

let sendLabels: Set<String> = [
    "send", "send message", "send prompt", "submit", "submit message",
    "发送", "发送消息", "发送提示", "发送提示词", "提交", "提交提示",
]

func isSendLike(_ el: AXUIElement) -> Bool {
    guard string(el, "AXRole") == "AXButton", let l = label(el) else { return false }
    return sendLabels.contains(l.trimmingCharacters(in: .whitespaces).lowercased())
}

func describeButton(_ b: AXUIElement) -> [String: Any] {
    [
        "label": shownLabel(b),
        "enabled": j(bool(b, "AXEnabled")),
        "actions": actionNames(b),
        "dom_classes": domClasses(b),
        "send_like": isSendLike(b),
    ]
}

func ancestor(of el: AXUIElement, levels: Int, stopAt root: AXUIElement) -> AXUIElement {
    var node = el
    for _ in 0..<levels {
        guard let parent = elementValue(copyAttr(node, "AXParent")) else { break }
        node = parent
        if CFEqual(parent, root) { break }
    }
    return node
}

func nearbyButtons(_ editor: AXUIElement, in root: AXUIElement) -> [[String: Any]] {
    collect(ancestor(of: editor, levels: 6, stopAt: root), limit: 40) { string($0, "AXRole") == "AXButton" }
        .map(describeButton)
}

/// Searches outward from the composer so the send button of this composer wins.
func sendButtons(near editor: AXUIElement, in root: AXUIElement, requireEnabled: Bool) -> [AXUIElement] {
    var node = editor
    for _ in 0..<10 {
        guard let parent = elementValue(copyAttr(node, "AXParent")) else { break }
        node = parent
        let found = collect(parent) { el in
            isSendLike(el) && (!requireEnabled || bool(el, "AXEnabled") != false) && actionNames(el).contains("AXPress")
        }
        if !found.isEmpty || CFEqual(parent, root) { return found }
    }
    return []
}

/// Whole conversation text. Text markers keep line breaks; joining static text is the fallback.
func documentText(_ root: AXUIElement) -> (text: String?, method: String) {
    if let start = copyAttr(root, "AXStartTextMarker"), let end = copyAttr(root, "AXEndTextMarker") {
        var range: CFTypeRef?
        if AXUIElementCopyParameterizedAttributeValue(root, "AXTextMarkerRangeForUnorderedTextMarkers" as CFString,
                                                      [start, end] as CFArray, &range) == .success, let range {
            var text: CFTypeRef?
            if AXUIElementCopyParameterizedAttributeValue(root, "AXStringForTextMarkerRange" as CFString, range, &text) == .success,
               let s = text as? String {
                return (s, "text-marker")
            }
        }
    }
    var parts: [String] = []
    walk(root, maxDepth: 200) { el, _ in
        if string(el, "AXRole") == "AXStaticText", let v = string(el, "AXValue") {
            parts.append(v)
            return false
        }
        return true
    }
    return parts.isEmpty ? (nil, "none") : (parts.joined(separator: "\n"), "static-text-join")
}

struct Extracted {
    var reply: String?
    var markerMatches = 0
    var body: String?
}

func extractReply(_ text: String, receipt: String) -> Extracted {
    let begin = "MCP_BEGIN_\(receipt)"
    let end = "MCP_END_\(receipt)"
    let pattern = "(?ms)^[ \\t]*\(begin)[ \\t]*\\r?\\n(.*?)\\r?\\n[ \\t]*\(end)[ \\t]*\\r?$"
    guard let re = try? NSRegularExpression(pattern: pattern) else { return Extracted() }
    let ns = text as NSString
    let matches = re.matches(in: text, range: NSRange(location: 0, length: ns.length))
    var out = Extracted(markerMatches: matches.count)
    guard matches.count == 1 else { return out }
    let body = ns.substring(with: matches[0].range(at: 1)).trimmingCharacters(in: .whitespacesAndNewlines)
    out.body = String(body.prefix(2000))
    if let data = body.data(using: .utf8),
       let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
       let reply = object["reply"] as? String, !reply.isEmpty {
        out.reply = reply
    }
    return out
}

// MARK: - Commands

func selectedWindows(_ all: [AXUIElement]) throws -> [(Int, AXUIElement)] {
    let indexed = Array(all.enumerated()).map { ($0.offset, $0.element) }
    guard let index = opts.window else { return indexed }
    guard all.indices.contains(index) else { throw ProbeError("No window \(index); run inventory for indexes.") }
    return [indexed[index]]
}

func probeWindow(_ w: AXUIElement, index: Int) -> [String: Any] {
    var out = describeWindow(w, index: index)
    let areas = webAreas(w)
    out["content_root"] = areas.isEmpty ? "window (no AXWebArea)" : "AXWebArea"
    out["roots"] = (areas.isEmpty ? [w] : areas).map { root -> [String: Any] in
        let found = editables(in: root)
        let doc = documentText(root)
        return [
            "url": urlKind(webURL(root)),
            "editable_count": found.count,
            "editables": found.prefix(10).map { editor -> [String: Any] in
                var d = describeEditable(editor)
                d["nearby_buttons"] = nearbyButtons(editor, in: root)
                d["send_buttons_near"] = sendButtons(near: editor, in: root, requireEnabled: false).count
                return d
            },
            "text_method": doc.method,
            "text_length": doc.text?.count ?? 0,
            "text_tail": redactOptional(doc.text.map { String($0.suffix(200)) }),
        ]
    }
    return out
}

func describeLine(_ el: AXUIElement) -> String {
    var head = string(el, "AXRole") ?? "?"
    if let sub = string(el, "AXSubrole") { head += "/" + sub }
    var parts = [head]
    if label(el) != nil { parts.append("label=\"\(shownLabel(el))\"") }
    if let v = string(el, "AXValue") { parts.append("value=\(redact(v))") }
    if let url = webURL(el) { parts.append("url=\(urlKind(url)["kind"] ?? "?")") }
    let classes = domClasses(el)
    if !classes.isEmpty { parts.append("class=" + classes.prefix(4).joined(separator: ".")) }
    let settable = ["AXValue", "AXSelectedText", "AXFocused"].filter { isSettable(el, $0) }
    if !settable.isEmpty { parts.append("settable=" + settable.joined(separator: ",")) }
    let acts = actionNames(el).filter { $0 != "AXShowMenu" && $0 != "AXScrollToVisible" }
    if !acts.isEmpty { parts.append("actions=" + acts.joined(separator: ",")) }
    return parts.joined(separator: " ")
}

func dumpTree(_ root: AXUIElement) -> [String] {
    var lines: [String] = []
    let truncated = walk(root) { el, depth in
        lines.append(String(repeating: "  ", count: depth) + describeLine(el))
        return true
    }
    if truncated { lines.append("... stopped after \(opts.maxNodes) elements (--max-nodes)") }
    return lines
}

func clearDraft(_ editor: AXUIElement) {
    let result = AXUIElementSetAttributeValue(editor, "AXValue" as CFString, "" as CFString)
    report.event("draft_cleared", ["ax_error": axName(result)])
}

func writeDraft(_ editor: AXUIElement, _ text: String) -> AXError {
    if opts.input == "selected-text" {
        var range = CFRange(location: 0, length: 0)
        if let value = AXValueCreate(.cfRange, &range) {
            _ = AXUIElementSetAttributeValue(editor, "AXSelectedTextRange" as CFString, value)
        }
        return AXUIElementSetAttributeValue(editor, "AXSelectedText" as CFString, text as CFString)
    }
    return AXUIElementSetAttributeValue(editor, "AXValue" as CFString, text as CFString)
}

func jsonString(_ s: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: s, options: [.fragmentsAllowed, .withoutEscapingSlashes])
    return String(data: data, encoding: .utf8)!
}

func roundtrip(_ app: NSRunningApplication, _ wins: [AXUIElement]) throws {
    report.data["scenario"] = opts.scenario
    report.data["input_method"] = opts.input
    report.data["sent"] = false
    guard let index = opts.window, wins.indices.contains(index) else {
        throw ProbeError("roundtrip needs --window <index> of the dedicated chat; run inventory first.")
    }
    let win = wins[index]
    report.data["window"] = describeWindow(win, index: index)
    let areas = webAreas(win)
    guard areas.count == 1 else { throw ProbeError("Expected one AXWebArea in window \(index), found \(areas.count).") }
    let web = areas[0]
    let startURL = urlKind(webURL(web))
    report.data["start_url"] = startURL
    guard let kind = startURL["kind"] as? String, kind == "chat" || kind == "blank" else {
        throw ProbeError("Window \(index) does not show a Gemini conversation.")
    }
    let startRoute = startURL["route"] as? String

    let writable = opts.input == "selected-text" ? "AXSelectedText" : "AXValue"
    let composers = editables(in: web).filter { bool($0, "AXEnabled") != false && isSettable($0, writable) }
    guard composers.count == 1 else {
        throw ProbeError("Expected one composer with settable \(writable), found \(composers.count). Run probe for details.")
    }
    let composer = composers[0]
    report.data["composer"] = describeEditable(composer)
    let draft = (string(composer, "AXValue") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !draft.isEmpty && draft != string(composer, "AXPlaceholderValue") {
        throw ProbeError("The composer already holds a draft. Clear it and run again.")
    }
    let before = documentText(web)
    report.data["text_method"] = before.method
    guard before.text != nil else { throw ProbeError("The conversation text cannot be read, so a reply could not be read either.") }

    let receipt = UUID().uuidString.lowercased()
    let expected = "GEMINI-MCP 验收 ✓\n    sample();"
    let begin = "MCP_BEGIN_\(receipt)"
    let end = "MCP_END_\(receipt)"
    let instruction = "Put \(begin) alone on the first line of the response. Between the markers write a JSON object with a single string field named reply containing your entire answer (escape newlines and code). Put \(end) alone on the last line. Use plain text."
    let message = "Use exactly this value for the JSON reply field (one newline and four spaces): "
        + jsonString(expected) + "\n\n" + instruction

    for left in stride(from: opts.delay, to: 0, by: -1) {
        say("Switch to another app (TextEdit works) and keep typing. Sending in \(left)s...")
        pause(1)
    }
    let baseApp = focusedAppPid()
    let baseElement = focusedElement()
    let baseClipboard = NSPasteboard.general.changeCount
    report.data["typing_app"] = j(baseApp.flatMap { NSRunningApplication(processIdentifier: $0)?.bundleIdentifier })
    report.data["focused_element_tracked"] = baseElement != nil
    report.event("baseline")
    if baseApp == app.processIdentifier {
        throw ProbeError("Gemini was the frontmost app when the test started; switch to another app during the countdown.")
    }

    // Conservative: an unreadable focused element is not counted as a change.
    func desktopChange() -> String? {
        if focusedAppPid() != baseApp { return "frontmost app changed" }
        if let a = baseElement, let b = focusedElement(), !CFEqual(a, b) { return "focused element changed" }
        if NSPasteboard.general.changeCount != baseClipboard { return "clipboard changed" }
        return nil
    }

    let writeResult = writeDraft(composer, message)
    report.event("draft_written", ["ax_error": axName(writeResult)])
    guard writeResult == .success else { throw ProbeError("Writing the draft failed (\(axName(writeResult))). Nothing was sent.") }

    var buttons: [AXUIElement] = []
    let buttonDeadline = Date(timeIntervalSinceNow: 5)
    repeat {
        if let change = desktopChange() {
            clearDraft(composer)
            throw ProbeError("Background check failed after writing the draft: \(change). Nothing was sent.")
        }
        buttons = sendButtons(near: composer, in: web, requireEnabled: true)
        if buttons.count == 1 { break }
        pause(0.1)
    } while Date() < buttonDeadline
    report.event("send_button_search", ["found": buttons.count])

    let written = normalize(string(composer, "AXValue") ?? "")
    report.data["draft_matches"] = written == normalize(message)
    if written != normalize(message) {
        report.data["draft_read_back"] = String(written.prefix(600))
        clearDraft(composer)
        throw ProbeError("The composer does not hold exactly the text written. Nothing was sent.")
    }
    guard buttons.count == 1 else {
        report.data["nearby_buttons"] = nearbyButtons(composer, in: web)
        clearDraft(composer)
        throw ProbeError("No single enabled send button appeared after writing the draft. Nothing was sent.")
    }
    report.data["send_button"] = describeButton(buttons[0])
    if let change = desktopChange() {
        clearDraft(composer)
        throw ProbeError("Background check failed before send: \(change). Nothing was sent.")
    }
    if urlKind(webURL(web))["route"] as? String != startRoute {
        clearDraft(composer)
        throw ProbeError("The conversation changed before send. Nothing was sent.")
    }

    let pressResult = AXUIElementPerformAction(buttons[0], "AXPress" as CFString)
    report.data["sent"] = pressResult == .success ? true : "unknown"
    report.event("send_pressed", ["ax_error": axName(pressResult)])

    var violations: [String: Double] = [:]
    var last = Extracted()
    let deadline = Date(timeIntervalSinceNow: opts.timeout)
    while Date() < deadline {
        pause(0.35)
        if let change = desktopChange(), violations[change] == nil {
            violations[change] = report.elapsed()
            report.event("violation", ["what": change])
        }
        let current = webAreas(win).first ?? web
        let url = urlKind(webURL(current))
        if startRoute != nil, url["route"] as? String != startRoute, violations["conversation changed"] == nil {
            violations["conversation changed"] = report.elapsed()
            report.event("violation", ["what": "conversation changed"])
        }
        guard let text = documentText(current).text else { continue }
        last = extractReply(text, receipt: receipt)
        if let reply = last.reply {
            let matches = normalize(reply) == normalize(expected)
            report.data["reply"] = reply
            report.data["reply_matches"] = matches
            report.data["end_url"] = url
            report.event("reply_read")
            break
        }
    }
    report.data["violations"] = violations
    report.data["marker_matches"] = last.markerMatches
    if last.reply == nil, let body = last.body { report.data["unparsed_body"] = body }
    report.data["passed"] = pressResult == .success && violations.isEmpty && (report.data["reply_matches"] as? Bool ?? false)
    if last.reply == nil {
        throw ProbeError("Sent, but no complete reply was read within \(Int(opts.timeout))s. Check the chat.", notSent: false)
    }
}

func run() throws {
    report.data["probe_version"] = 1
    report.data["command"] = opts.command
    report.data["system"] = ["os": ProcessInfo.processInfo.operatingSystemVersionString, "probe_arch": isARM() ? "arm64" : "x86_64"]
    let trusted = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
    report.data["accessibility_trusted"] = trusted
    report.data["installs"] = installs()
    report.data["running"] = candidates().map(describeRunning)
    guard trusted else {
        throw ProbeError("Allow your terminal app under System Settings > Privacy & Security > Accessibility, then run again.")
    }
    let app = try chooseApp()
    let (appElement, notes) = prepare(app)
    var appInfo = describeRunning(app)
    appInfo["accessibility_requests"] = notes
    report.data["app"] = appInfo
    let wins = elements(appElement, "AXWindows")
    report.data["window_count"] = wins.count

    switch opts.command {
    case "inventory":
        report.data["windows"] = wins.enumerated().map { describeWindow($0.element, index: $0.offset) }
    case "probe":
        report.data["windows"] = try selectedWindows(wins).map { probeWindow($0.1, index: $0.0) }
    case "dump":
        if opts.window == nil {
            report.data["tree"] = dumpTree(appElement)
        } else {
            report.data["tree"] = try selectedWindows(wins).flatMap { dumpTree($0.1) }
        }
    case "roundtrip":
        try roundtrip(app, wins)
    default:
        usage()
    }
}

func isARM() -> Bool {
    #if arch(arm64)
    return true
    #else
    return false
    #endif
}

do {
    try run()
} catch let e as ProbeError {
    report.data["error"] = e.message
    report.data["not_sent"] = e.notSent
} catch {
    report.data["error"] = String(describing: error)
}
report.data["events"] = report.events
emit(report.data)
exit(report.data["error"] == nil ? 0 : 1)
