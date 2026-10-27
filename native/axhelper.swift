// WriteWise Accessibility helper (macOS).
//
// Spawned by the Electron main process. Speaks newline-delimited JSON: commands arrive on stdin,
// events and replies go out on stdout. It reads the text box that has keyboard focus in whatever
// app is in front, reports where characters are on screen, and writes replacements back, all
// through the macOS Accessibility API (the same mechanism Grammarly uses). It needs the user to
// allow WriteWise under System Settings > Privacy & Security > Accessibility.
//
// Commands (one JSON object per line):
//   {"cmd":"read","id":1}                                   -> the focused text box (text, caret, bounds)
//   {"cmd":"bounds","id":2,"ranges":[[start,len],...]}      -> screen rects for character ranges
//   {"cmd":"replace","id":3,"start":s,"length":l,"text":t}  -> replace a range in the focused box
//   {"cmd":"select","id":4,"start":s,"length":l}            -> move the caret / selection
//   {"cmd":"watch","on":true}                               -> stream focus/text/moved/blur events
//   {"cmd":"trusted","id":5,"prompt":true}                  -> Accessibility permission state (optionally prompt)
//   {"cmd":"quit"}
import Cocoa
import ApplicationServices
import Foundation

// MARK: - stdout

let outQueue = DispatchQueue(label: "writewise.axhelper.out")
func emit(_ obj: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(obj), let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
  outQueue.sync {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  }
}

// MARK: - Accessibility primitives

let systemWide = AXUIElementCreateSystemWide()
/// The WriteWise process that spawned us (--own-pid): its windows (the overlay panel, the editor) are never watched.
let ownPid: pid_t = {
  let a = CommandLine.arguments
  if let i = a.firstIndex(of: "--own-pid"), i + 1 < a.count, let p = Int32(a[i + 1]) { return p }
  return 0
}()
let textRoles: Set<String> = [kAXTextAreaRole as String, kAXTextFieldRole as String, kAXComboBoxRole as String]

func axAttr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}

func axSet(_ el: AXUIElement, _ name: String, _ value: AnyObject) -> AXError {
  return AXUIElementSetAttributeValue(el, name as CFString, value)
}

func makeRange(_ start: Int, _ length: Int) -> AXValue? {
  var range = CFRange(location: start, length: length)
  return AXValueCreate(.cfRange, &range)
}

func selectedRange(_ el: AXUIElement) -> (Int, Int)? {
  guard let value = axAttr(el, kAXSelectedTextRangeAttribute) else { return nil }
  var range = CFRange()
  guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return nil }
  return (range.location, range.length)
}

func frame(_ el: AXUIElement) -> [Double]? {
  guard let p = axAttr(el, kAXPositionAttribute), let s = axAttr(el, kAXSizeAttribute) else { return nil }
  var point = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
  return [point.x, point.y, size.width, size.height]
}

func boundsForRange(_ el: AXUIElement, _ start: Int, _ length: Int) -> [Double]? {
  guard let param = makeRange(start, length) else { return nil }
  var out: AnyObject?
  let err = AXUIElementCopyParameterizedAttributeValue(el, kAXBoundsForRangeParameterizedAttribute as CFString, param, &out)
  guard err == .success, let value = out else { return nil }
  var rect = CGRect.zero
  guard AXValueGetValue(value as! AXValue, .cgRect, &rect) else { return nil }
  if rect.width <= 0 && rect.height <= 0 { return nil }
  return [rect.origin.x, rect.origin.y, rect.width, rect.height]
}

/// Chromium-based apps (Chrome, Electron apps such as Claude or Slack) keep their accessibility tree
/// switched off until an assistive client asks for it. Setting this attribute on the application
/// element turns it on; the first queries after that can still fail for a moment, so callers retry.
func enableChromiumAccessibility(_ app: AXUIElement) {
  _ = axSet(app, "AXManualAccessibility", kCFBooleanTrue)
}

/// Rich-text editors in Chromium (contenteditable: Claude, Slack, Notion, Gmail) only report character bounds on
/// their static-text leaves, never on the editable element itself. Ranges in the editor's value are therefore
/// mapped onto those leaves, found in document order and located in the value by sequential search (which
/// skips the newlines the value inserts between paragraphs).
struct Segment { let el: AXUIElement; let start: Int; let length: Int }

func textSegments(_ root: AXUIElement, fullText: String) -> [Segment] {
  let ns = fullText as NSString
  var segments: [Segment] = []
  var cursor = 0
  var stack: [AXUIElement] = (axAttr(root, kAXChildrenAttribute) as? [AXUIElement] ?? []).reversed()
  var visited = 0
  while let el = stack.popLast(), visited < 3000 {
    visited += 1
    let role = axAttr(el, kAXRoleAttribute) as? String ?? ""
    if role == (kAXStaticTextRole as String) {
      if let v = axAttr(el, kAXValueAttribute) as? String, !v.isEmpty, cursor < ns.length {
        let r = ns.range(of: v, options: [], range: NSRange(location: cursor, length: ns.length - cursor))
        if r.location != NSNotFound {
          segments.append(Segment(el: el, start: r.location, length: r.length))
          cursor = r.location + r.length
        }
      }
      continue
    }
    if let kids = axAttr(el, kAXChildrenAttribute) as? [AXUIElement] { stack.append(contentsOf: kids.reversed()) }
  }
  return segments
}

func boundsViaSegments(_ segments: [Segment], start: Int, length: Int) -> [Double]? {
  var union: CGRect? = nil
  let end = start + length
  for seg in segments where seg.start < end && seg.start + seg.length > start {
    let s = max(start, seg.start) - seg.start
    let e = min(end, seg.start + seg.length) - seg.start
    if e <= s { continue }
    if let r = boundsForRange(seg.el, s, e - s) {
      let rect = CGRect(x: r[0], y: r[1], width: r[2], height: r[3])
      union = union.map { $0.union(rect) } ?? rect
    }
  }
  guard let u = union else { return nil }
  return [u.origin.x, u.origin.y, u.width, u.height]
}

func focusedElement() -> AXUIElement? {
  if let f = axAttr(systemWide, kAXFocusedUIElementAttribute) { return (f as! AXUIElement) }
  guard let front = NSWorkspace.shared.frontmostApplication else { return nil }
  let app = AXUIElementCreateApplication(front.processIdentifier)
  enableChromiumAccessibility(app)
  for _ in 0..<6 {
    if let f = axAttr(app, kAXFocusedUIElementAttribute) { return (f as! AXUIElement) }
    usleep(100_000)
  }
  return nil
}

/// Everything the Electron side needs to know about a text box.
func describe(_ el: AXUIElement) -> [String: Any]? {
  guard let role = axAttr(el, kAXRoleAttribute) as? String else { return nil }
  var pid: pid_t = 0
  AXUIElementGetPid(el, &pid)
  let app = NSRunningApplication(processIdentifier: pid)
  let subrole = axAttr(el, kAXSubroleAttribute) as? String
  let secure = subrole == (kAXSecureTextFieldSubrole as String)
  var info: [String: Any] = [
    "role": role,
    "pid": Int(pid),
    "app": app?.localizedName ?? "",
    "bundle": app?.bundleIdentifier ?? "",
    "secure": secure,
    "editable": false,
  ]
  if let sub = subrole { info["subrole"] = sub }
  if textRoles.contains(role), !secure, let text = axAttr(el, kAXValueAttribute) as? String {
    info["editable"] = true
    info["text"] = text
    if let (s, l) = selectedRange(el) { info["selStart"] = s; info["selLen"] = l }
  }
  if let r = frame(el) { info["bounds"] = r }
  return info
}

/// Types text into the focused element as synthetic keystrokes (last-resort replacement path).
func typeText(_ text: String, deleteSelection: Bool) {
  let source = CGEventSource(stateID: .combinedSessionState)
  if text.isEmpty {
    if deleteSelection, let down = CGEvent(keyboardEventSource: source, virtualKey: 51, keyDown: true), let up = CGEvent(keyboardEventSource: source, virtualKey: 51, keyDown: false) {
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
    }
    return
  }
  let units = Array(text.utf16)
  var i = 0
  while i < units.count {
    let n = min(20, units.count - i)
    var chunk = Array(units[i..<(i + n)])
    if let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true) {
      down.keyboardSetUnicodeString(stringLength: n, unicodeString: &chunk)
      down.post(tap: .cghidEventTap)
    }
    if let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) {
      up.keyboardSetUnicodeString(stringLength: n, unicodeString: &chunk)
      up.post(tap: .cghidEventTap)
    }
    i += n
    usleep(4_000)
  }
}

/// Rich editors (ProseMirror, Slate) report an empty document as a lone newline and shuffle trailing
/// newlines around paragraphs, so values are compared without trailing line breaks.
func normalizedText(_ s: String) -> String {
  var t = s.replacingOccurrences(of: "\r\n", with: "\n")
  while t.hasSuffix("\n") || t.hasSuffix("\r") { t.removeLast() }
  return t
}

enum WriteOutcome { case matched, changed, unchanged }

/// Waits briefly for a write to land (they reach the app asynchronously) and reports whether the text now
/// matches `expected`, changed in some other way, or did not change at all.
func settle(_ el: AXUIElement, before: String, expected: String, initialWait: UInt32 = 0) -> WriteOutcome {
  if initialWait > 0 { usleep(initialWait) }
  var outcome = WriteOutcome.unchanged
  for _ in 0..<8 {
    let now = axAttr(el, kAXValueAttribute) as? String ?? before
    if normalizedText(now) == normalizedText(expected) { return .matched }
    outcome = now != before ? .changed : .unchanged
    if outcome == .changed { usleep(60_000); let again = axAttr(el, kAXValueAttribute) as? String ?? now; return normalizedText(again) == normalizedText(expected) ? .matched : .changed }
    usleep(40_000)
  }
  return outcome
}

/// Replaces a character range. Different toolkits honour different writes, and some report success
/// without changing anything, so every attempt is verified by reading the text back:
///   1. select the range and set the selected text (Cocoa text views),
///   2. set the whole value with the range spliced in (Chromium: Chrome, Electron apps),
///   3. select the range and type the replacement as keystrokes (anything else).
/// Returns (error, method).
func replace(_ el: AXUIElement, start: Int, length: Int, text: String) -> (String?, String) {
  guard let before = axAttr(el, kAXValueAttribute) as? String else { return ("could not read the text", "") }
  let ns = before as NSString
  guard start >= 0, length >= 0, start + length <= ns.length else { return ("range \(start)+\(length) is outside the text (\(ns.length) chars)", "") }
  let expected = ns.replacingCharacters(in: NSRange(location: start, length: length), with: text)
  // Once the text has changed at all we stop: trying another method would apply the edit twice.
  if let range = makeRange(start, length), axSet(el, kAXSelectedTextRangeAttribute, range) == .success, axSet(el, kAXSelectedTextAttribute, text as CFString) == .success {
    switch settle(el, before: before, expected: expected) {
    case .matched: return (nil, "selectedText")
    case .changed: return (nil, "selectedText~")
    case .unchanged: break
    }
  }
  if axSet(el, kAXValueAttribute, expected as CFString) == .success {
    switch settle(el, before: before, expected: expected) {
    case .matched: return (nil, "value")
    case .changed: return (nil, "value~")
    case .unchanged: break
    }
  }
  if let range = makeRange(start, length), axSet(el, kAXSelectedTextRangeAttribute, range) == .success {
    typeText(text, deleteSelection: length > 0)
    switch settle(el, before: before, expected: expected, initialWait: UInt32(min(400_000, 30_000 + 8_000 * text.utf16.count))) {
    case .matched: return (nil, "keystrokes")
    case .changed: return (nil, "keystrokes~")
    case .unchanged: return ("the text did not change (tried selection, value and keystrokes)", "keystrokes")
    }
  }
  return ("could not select the range", "")
}

// MARK: - Watcher (phase 1): follows the focused text box across apps

final class Watcher {
  static let shared = Watcher()
  private(set) var on = false
  private var observer: AXObserver?
  private var appElement: AXUIElement?
  private var windowElement: AXUIElement?
  private(set) var current: AXUIElement?
  /// The last editable box reported, kept even when focus wanders (to our own panel, say) so edits still land.
  private(set) var lastBox: AXUIElement?
  private(set) var lastBoxPid: pid_t = 0
  private var pending: DispatchWorkItem?
  private var gen = 0
  private var retries = 0
  private let elementNotes = [kAXValueChangedNotification, kAXSelectedTextChangedNotification, kAXUIElementDestroyedNotification] as [String]
  private let windowNotes = [kAXWindowMovedNotification, kAXWindowResizedNotification, kAXUIElementDestroyedNotification] as [String]

  func start() {
    if on { return }
    on = true
    NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(appActivated(_:)), name: NSWorkspace.didActivateApplicationNotification, object: nil)
    if let front = NSWorkspace.shared.frontmostApplication { attach(front.processIdentifier) } else { emitBlur() }
  }

  func stop() {
    if !on { return }
    on = false
    NSWorkspace.shared.notificationCenter.removeObserver(self)
    detach()
    emitBlur()
  }

  @objc private func appActivated(_ note: Notification) {
    guard on, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
    if ownPid != 0 && app.processIdentifier == ownPid { return } // our own panel or window: keep watching the app being edited
    attach(app.processIdentifier)
  }

  private func detach() {
    if let o = observer {
      if let c = current { for n in elementNotes { AXObserverRemoveNotification(o, c, n as CFString) } }
      if let w = windowElement { for n in windowNotes { AXObserverRemoveNotification(o, w, n as CFString) } }
      CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode)
    }
    observer = nil
    appElement = nil
    windowElement = nil
    current = nil
  }

  private func attach(_ pid: pid_t) {
    if ownPid != 0 && pid == ownPid { return }
    detach()
    var obs: AXObserver?
    guard AXObserverCreate(pid, axCallback, &obs) == .success, let o = obs else { emitBlur(); return }
    observer = o
    let app = AXUIElementCreateApplication(pid)
    appElement = app
    enableChromiumAccessibility(app)
    for n in [kAXFocusedUIElementChangedNotification, kAXMainWindowChangedNotification, kAXFocusedWindowChangedNotification] as [String] {
      AXObserverAddNotification(o, app, n as CFString, nil)
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(o), .defaultMode)
    refocus()
  }

  func refocus() {
    guard let app = appElement, let o = observer else { return }
    guard let f = axAttr(app, kAXFocusedUIElementAttribute) else {
      // Two reasons this fails for a moment: accessibility is still switching on in a Chromium app, or the
      // app's window just lost key status to our overlay panel. Keep the current box and look again before
      // reporting a blur.
      retries += 1
      if retries <= 4 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.refocus() }
        if current == nil { emitBlur() }
        return
      }
      retries = 0
      dropCurrent()
      emitBlur()
      return
    }
    retries = 0
    let el = f as! AXUIElement
    if let c = current, CFEqual(el, c) { emitText("focus"); return } // same box as before: nothing to re-subscribe
    guard let info = describe(el), info["editable"] as? Bool == true else {
      // Focus moved to something that is not a text box (often just our own overlay panel taking key status).
      // Keep the last box as the write target so a fix chosen on the card still lands in it.
      emitBlur()
      return
    }
    dropCurrent()
    current = el
    lastBox = el
    var p: pid_t = 0
    AXUIElementGetPid(el, &p)
    lastBoxPid = p
    for n in elementNotes { AXObserverAddNotification(o, el, n as CFString, nil) }
    if let w = axAttr(app, kAXFocusedWindowAttribute) {
      let win = w as! AXUIElement
      windowElement = win
      for n in windowNotes { AXObserverAddNotification(o, win, n as CFString, nil) }
    }
    emitText("focus")
  }

  private func dropCurrent() {
    guard let o = observer else { current = nil; windowElement = nil; return }
    if let c = current { for n in elementNotes { AXObserverRemoveNotification(o, c, n as CFString) } }
    if let w = windowElement { for n in windowNotes { AXObserverRemoveNotification(o, w, n as CFString) } }
    current = nil
    windowElement = nil
  }

  private func emitBlur() {
    gen += 1
    emit(["type": "blur", "gen": gen])
  }

  private func scheduleText() {
    pending?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.emitText("text") }
    pending = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.06, execute: work)
  }

  private func emitText(_ type: String) {
    guard let el = current, var info = describe(el), info["editable"] as? Bool == true else { emitBlur(); return }
    gen += 1
    info["type"] = type
    info["gen"] = gen
    emit(info)
  }

  func handle(_ note: String, _ el: AXUIElement) {
    if note == (kAXFocusedUIElementChangedNotification as String) || note == (kAXMainWindowChangedNotification as String) || note == (kAXFocusedWindowChangedNotification as String) {
      refocus()
    } else if note == (kAXValueChangedNotification as String) || note == (kAXSelectedTextChangedNotification as String) {
      scheduleText()
    } else if note == (kAXUIElementDestroyedNotification as String) {
      if let c = current, CFEqual(el, c) { current = nil; emitBlur() } else if let w = windowElement, CFEqual(el, w) { windowElement = nil; emitBlur() }
    } else if note == (kAXWindowMovedNotification as String) || note == (kAXWindowResizedNotification as String) {
      if current != nil { emit(["type": "moved"]) }
    }
  }
}

let axCallback: AXObserverCallback = { _, element, notification, _ in
  Watcher.shared.handle(notification as String, element)
}

/// Depth-first search of the front app's focused window for an editable text box whose description or
/// role matches `match` (empty string: the first editable box). Used by tests and the "focus" command.
func findTextBox(matching match: String) -> AXUIElement? {
  guard let front = NSWorkspace.shared.frontmostApplication else { return nil }
  let app = AXUIElementCreateApplication(front.processIdentifier)
  enableChromiumAccessibility(app)
  var roots: [AXUIElement] = []
  if let w = axAttr(app, kAXFocusedWindowAttribute) { roots.append(w as! AXUIElement) }
  if let ws = axAttr(app, kAXWindowsAttribute) as? [AXUIElement] { roots.append(contentsOf: ws) }
  var stack = roots
  var seen = 0
  while let el = stack.popLast(), seen < 6000 {
    seen += 1
    if let role = axAttr(el, kAXRoleAttribute) as? String, textRoles.contains(role) {
      let desc = (axAttr(el, kAXDescriptionAttribute) as? String ?? "") + " " + (axAttr(el, kAXTitleAttribute) as? String ?? "")
      if match.isEmpty || desc.localizedCaseInsensitiveContains(match) { return el }
    }
    if let kids = axAttr(el, kAXChildrenAttribute) as? [AXUIElement] { stack.append(contentsOf: kids.reversed()) }
  }
  return nil
}

// MARK: - commands

func handleCommand(_ obj: [String: Any]) {
  let cmd = obj["cmd"] as? String ?? ""
  let id = obj["id"]
  func reply(_ body: [String: Any]) {
    var out = body
    if let id = id { out["id"] = id }
    emit(out)
  }
  /// The element an edit applies to: the watched box, else the last box in the requested process, else whatever has focus.
  func target() -> AXUIElement? {
    let wanted = obj["pid"] as? Int ?? 0
    if let c = Watcher.shared.current {
      var p: pid_t = 0
      AXUIElementGetPid(c, &p)
      if wanted == 0 || Int(p) == wanted { return c }
    }
    if let l = Watcher.shared.lastBox, wanted == 0 || Int(Watcher.shared.lastBoxPid) == wanted { return l }
    if wanted != 0 {
      // A specific app was named: use its own focused element, which works even when it is not in front.
      let app = AXUIElementCreateApplication(pid_t(wanted))
      enableChromiumAccessibility(app)
      for _ in 0..<4 {
        if let f = axAttr(app, kAXFocusedUIElementAttribute) { return (f as! AXUIElement) }
        usleep(80_000)
      }
    }
    return focusedElement()
  }

  switch cmd {
  case "watch":
    if obj["on"] as? Bool ?? true { Watcher.shared.start() } else { Watcher.shared.stop() }
    reply(["type": "watch", "on": Watcher.shared.on])
  case "read":
    if let el = focusedElement(), let info = describe(el) {
      var out = info
      out["type"] = "read"
      out["ok"] = true
      reply(out)
    } else {
      reply(["type": "read", "ok": false])
    }
  case "bounds":
    var rects: [Any] = []
    if let el = target(), let ranges = obj["ranges"] as? [[Int]] {
      var segments: [Segment]? = nil
      for r in ranges where r.count == 2 {
        var rect = boundsForRange(el, r[0], r[1])
        if rect == nil {
          if segments == nil { segments = textSegments(el, fullText: axAttr(el, kAXValueAttribute) as? String ?? "") }
          rect = boundsViaSegments(segments!, start: r[0], length: r[1])
        }
        rects.append(rect ?? NSNull())
      }
    }
    reply(["type": "bounds", "rects": rects])
  case "replace":
    guard let el = target(), let start = obj["start"] as? Int, let length = obj["length"] as? Int, let text = obj["text"] as? String else {
      reply(["type": "replace", "ok": false, "error": "no focused text box or bad arguments"]); return
    }
    let (err, method) = replace(el, start: start, length: length, text: text)
    if let err = err { reply(["type": "replace", "ok": false, "error": err, "method": method]) } else { reply(["type": "replace", "ok": true, "method": method]) }
  case "select":
    guard let el = target(), let start = obj["start"] as? Int, let length = obj["length"] as? Int, let range = makeRange(start, length) else {
      reply(["type": "select", "ok": false]); return
    }
    reply(["type": "select", "ok": axSet(el, kAXSelectedTextRangeAttribute, range) == .success])
  case "focus":
    let match = obj["match"] as? String ?? ""
    guard let el = findTextBox(matching: match) else { reply(["type": "focus", "ok": false, "error": "no text box matching \"\(match)\""]); return }
    let err = axSet(el, kAXFocusedAttribute, kCFBooleanTrue)
    usleep(150_000)
    var out = describe(el) ?? [:]
    out["type"] = "focus"
    out["ok"] = err == .success
    reply(out)
  case "trusted":
    let prompt = obj["prompt"] as? Bool ?? false
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    reply(["type": "trusted", "ok": AXIsProcessTrustedWithOptions(options)])
  case "quit":
    exit(0)
  default:
    reply(["type": "error", "error": "unknown command: \(cmd)"])
  }
}

// MARK: - main

let reader = Thread {
  while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8), let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
    DispatchQueue.main.async { handleCommand(obj) }
  }
  DispatchQueue.main.async { exit(0) } // parent closed the pipe
}
reader.start()
emit(["type": "ready", "trusted": AXIsProcessTrusted(), "pid": Int(getpid())])
RunLoop.main.run()
