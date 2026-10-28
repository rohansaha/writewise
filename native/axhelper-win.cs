// WriteWise accessibility helper (Windows).
//
// The Windows twin of native/axhelper.swift, speaking the same newline-delimited JSON protocol so the
// Electron side (electron/ax.cjs, electron/overlay.cjs) works unchanged. It reads the text box that has
// keyboard focus in whatever app is in front, reports where characters are on screen, and writes
// replacements back, all through Windows UI Automation. Unlike macOS no permission is needed, but apps
// running elevated (as administrator) cannot be read from a normal-privilege process.
//
// Commands (one JSON object per line):
//   {"cmd":"read","id":1}                                   -> the focused text box (text, caret, bounds)
//   {"cmd":"bounds","id":2,"ranges":[[start,len],...]}      -> screen rects for character ranges
//   {"cmd":"replace","id":3,"start":s,"length":l,"text":t}  -> replace a range in the focused box
//   {"cmd":"select","id":4,"start":s,"length":l}            -> move the caret / selection
//   {"cmd":"watch","on":true}                               -> stream focus/text/moved/blur events
//   {"cmd":"trusted","id":5}                                -> always ok (kept for protocol parity)
//   {"cmd":"quit"}
//
// Rects are physical screen pixels (the helper is per-monitor DPI aware); electron/ax.cjs converts them
// to Electron's device-independent pixels.
//
// Built by scripts/build-axhelper.mjs with the C# compiler that ships with the .NET Framework, so it
// needs no SDK on the build machine and runs on every Windows 10/11 install.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Text;

static class Program {
  // ---------- stdout ----------
  static readonly object outLock = new object();
  static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
  static StreamWriter stdout;

  static void Emit(Dictionary<string, object> obj) {
    string line;
    try { line = json.Serialize(obj); } catch { return; }
    lock (outLock) {
      try { stdout.Write(line); stdout.Write("\n"); stdout.Flush(); } catch { Environment.Exit(0); }
    }
  }

  // ---------- one worker thread does all UI Automation work ----------
  // Event handlers and the stdin reader only queue work, so the helper never queries UI Automation from
  // inside one of its own callbacks (which can deadlock) and commands never race the watcher.
  static readonly BlockingCollection<Action> work = new BlockingCollection<Action>();
  static int ownPid;

  [MTAThread]
  static void Main(string[] args) {
    for (int i = 0; i + 1 < args.Length; i++) if (args[i] == "--own-pid") int.TryParse(args[i + 1], out ownPid);
    Native.MakeDpiAware();
    stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    var reader = new Thread(() => {
      var parser = new JavaScriptSerializer { MaxJsonLength = int.MaxValue }; // the serializer is not thread-safe
      using (var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false))) {
        string line;
        while ((line = stdin.ReadLine()) != null) {
          if (line.Trim().Length == 0) continue;
          Dictionary<string, object> obj;
          try { obj = parser.DeserializeObject(line) as Dictionary<string, object>; } catch { continue; }
          if (obj == null) continue;
          work.Add(() => HandleCommand(obj));
        }
      }
      Environment.Exit(0); // parent closed the pipe
    }) { IsBackground = true };
    reader.Start();
    Emit(new Dictionary<string, object> { { "type", "ready" }, { "trusted", true }, { "pid", Process.GetCurrentProcess().Id } });
    foreach (var job in work.GetConsumingEnumerable()) {
      try { job(); } catch (Exception e) { Console.Error.WriteLine("axhelper: " + e.Message); }
    }
  }

  // ---------- UI Automation primitives ----------
  static T Pattern<T>(AutomationElement el, AutomationPattern p) where T : class {
    object o;
    try { return el.TryGetCurrentPattern(p, out o) ? o as T : null; } catch { return null; }
  }

  static int Pid(AutomationElement el) { try { return el.Current.ProcessId; } catch { return 0; } }

  static readonly Dictionary<int, string[]> procNames = new Dictionary<int, string[]>();
  /// [display name, executable name] for a process, e.g. ["Claude", "claude.exe"].
  static string[] ProcessNames(int pid) {
    string[] names;
    if (procNames.TryGetValue(pid, out names)) return names;
    string exe = "", display = "";
    try {
      var p = Process.GetProcessById(pid);
      exe = p.ProcessName.ToLowerInvariant() + ".exe";
      display = p.ProcessName;
      try { var d = p.MainModule.FileVersionInfo.FileDescription; if (!string.IsNullOrWhiteSpace(d)) display = d; } catch { /* other bitness or access denied */ }
    } catch { /* process gone */ }
    names = new[] { display, exe };
    if (procNames.Count > 200) procNames.Clear();
    procNames[pid] = names;
    return names;
  }

  /// Whether the element is a text box the user can type into. Chromium (Chrome, Edge, Electron apps such as
  /// Claude or Slack) exposes rich editors as groups with a writable Value pattern, Win32 and WinUI boxes as
  /// Edit controls, and word processors as documents whose text reports IsReadOnly = false.
  static bool IsEditable(AutomationElement el) {
    try {
      var ct = el.Current.ControlType;
      var vp = Pattern<ValuePattern>(el, ValuePattern.Pattern);
      var tp = Pattern<TextPattern>(el, TextPattern.Pattern);
      if (vp != null) {
        if (vp.Current.IsReadOnly) return false;
        return tp != null || ct == ControlType.Edit || ct == ControlType.Document || ct == ControlType.ComboBox;
      }
      if (tp != null) {
        if (ct == ControlType.Edit) return true;
        var ro = tp.DocumentRange.GetAttributeValue(TextPattern.IsReadOnlyAttribute);
        return ro is bool && !(bool)ro;
      }
    } catch { /* element went away */ }
    return false;
  }

  /// The element's text, read the same way the offsets are measured (TextPattern when there is one).
  static string ReadText(AutomationElement el) {
    var tp = Pattern<TextPattern>(el, TextPattern.Pattern);
    if (tp != null) { try { return tp.DocumentRange.GetText(-1) ?? ""; } catch { } }
    var vp = Pattern<ValuePattern>(el, ValuePattern.Pattern);
    if (vp != null) { try { return vp.Current.Value ?? ""; } catch { } }
    return null;
  }

  /// Selection as (start, length) in the element's text, or null when the control does not report one.
  static int[] Selection(TextPattern tp) {
    try {
      var sel = tp.GetSelection();
      if (sel == null || sel.Length == 0) return null;
      var before = tp.DocumentRange.Clone();
      before.MoveEndpointByRange(TextPatternRangeEndpoint.End, sel[0], TextPatternRangeEndpoint.Start);
      int start = (before.GetText(-1) ?? "").Length;
      int len = (sel[0].GetText(-1) ?? "").Length;
      return new[] { start, len };
    } catch { return null; }
  }

  /// A text range covering [start, start + length) of the document, counted in characters.
  static TextPatternRange RangeAt(TextPattern tp, int start, int length) {
    var r = tp.DocumentRange.Clone();
    r.MoveEndpointByRange(TextPatternRangeEndpoint.End, r, TextPatternRangeEndpoint.Start);
    if (start > 0) {
      r.MoveEndpointByUnit(TextPatternRangeEndpoint.End, TextUnit.Character, start);
      r.MoveEndpointByRange(TextPatternRangeEndpoint.Start, r, TextPatternRangeEndpoint.End);
    }
    if (length > 0) r.MoveEndpointByUnit(TextPatternRangeEndpoint.End, TextUnit.Character, length);
    return r;
  }

  static List<object> RectList(Rect r) { return new List<object> { r.X, r.Y, r.Width, r.Height }; }

  static List<object> Frame(AutomationElement el) {
    try {
      var r = el.Current.BoundingRectangle;
      if (r.IsEmpty || r.Width <= 0 || r.Height <= 0) return null;
      return RectList(r);
    } catch { return null; }
  }

  /// Everything the Electron side needs to know about a text box (same fields as the macOS helper).
  static Dictionary<string, object> Describe(AutomationElement el) {
    if (el == null) return null;
    try {
      int pid = Pid(el);
      var names = ProcessNames(pid);
      bool secure = el.Current.IsPassword;
      var info = new Dictionary<string, object> {
        { "role", el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "") },
        { "pid", pid }, { "app", names[0] }, { "bundle", names[1] }, { "secure", secure }, { "editable", false },
      };
      if (!secure && IsEditable(el)) {
        var text = ReadText(el);
        if (text != null) {
          info["editable"] = true;
          info["text"] = text;
          var tp = Pattern<TextPattern>(el, TextPattern.Pattern);
          var sel = tp != null ? Selection(tp) : null;
          info["selStart"] = sel != null ? sel[0] : text.Length;
          info["selLen"] = sel != null ? sel[1] : 0;
        }
      }
      var f = Frame(el);
      if (f != null) info["bounds"] = f;
      return info;
    } catch (ElementNotAvailableException) { return null; }
  }

  static AutomationElement Focused() {
    try { return AutomationElement.FocusedElement; } catch { return null; }
  }

  // ---------- writing ----------
  static string Normalized(string s) {
    var t = (s ?? "").Replace("\r\n", "\n").Replace('\r', '\n');
    return t.TrimEnd('\n');
  }

  enum Outcome { Matched, Changed, Unchanged }

  /// Waits briefly for a write to land and reports whether the text now matches `expected`.
  static Outcome Settle(AutomationElement el, string before, string expected, int initialWaitMs) {
    if (initialWaitMs > 0) Thread.Sleep(initialWaitMs);
    for (int i = 0; i < 8; i++) {
      var now = ReadText(el) ?? before;
      if (Normalized(now) == Normalized(expected)) return Outcome.Matched;
      if (now != before) {
        Thread.Sleep(60);
        return Normalized(ReadText(el) ?? now) == Normalized(expected) ? Outcome.Matched : Outcome.Changed;
      }
      Thread.Sleep(40);
    }
    return Outcome.Unchanged;
  }

  /// Replaces a character range, verifying each attempt by reading the text back:
  ///   1. select the range and type the replacement as Unicode keystrokes (keeps the app's undo history and
  ///      formatting; works in Chromium editors, Win32 and WinUI boxes, Word),
  ///   2. set the whole value with the range spliced in (plain boxes that ignore synthetic input).
  /// Returns (error, method).
  static string[] Replace(AutomationElement el, int start, int length, string text) {
    var before = ReadText(el);
    if (before == null) return new[] { "could not read the text", "" };
    if (start < 0 || length < 0 || start + length > before.Length) return new[] { "range " + start + "+" + length + " is outside the text (" + before.Length + " chars)", "" };
    var expected = before.Substring(0, start) + text + before.Substring(start + length);
    var tp = Pattern<TextPattern>(el, TextPattern.Pattern);
    if (tp != null) {
      try {
        if (Pid(Focused()) != Pid(el)) { try { el.SetFocus(); Thread.Sleep(80); } catch { } }
        RangeAt(tp, start, length).Select();
        Native.WaitForModifiersReleased();
        if (text.Length == 0) { if (length > 0) Native.TapKey(Native.VK_BACK); } else Native.TypeUnicode(text);
        switch (Settle(el, before, expected, Math.Min(400, 30 + 8 * text.Length))) {
          case Outcome.Matched: return new[] { null, "keystrokes" };
          case Outcome.Changed: return new[] { null, "keystrokes~" }; // changed somehow: never apply the edit twice
        }
      } catch (Exception) { /* fall through to the value */ }
    }
    var vp = Pattern<ValuePattern>(el, ValuePattern.Pattern);
    if (vp != null) {
      try {
        if (!vp.Current.IsReadOnly) {
          vp.SetValue(expected);
          switch (Settle(el, before, expected, 0)) {
            case Outcome.Matched: return new[] { null, "value" };
            case Outcome.Changed: return new[] { null, "value~" };
          }
        }
      } catch (Exception) { }
    }
    return new[] { "the text did not change (tried keystrokes and value)", tp != null ? "keystrokes" : "value" };
  }

  // ---------- watcher: follows the focused text box across apps ----------
  static class Watcher {
    public static bool On;
    public static AutomationElement Current;
    public static AutomationElement LastBox;
    public static int LastBoxPid;
    static AutomationElement window;
    static string lastText;
    static string lastSel;
    static string lastRects;
    static int gen;
    static Timer timer;
    static int ticking;
    static AutomationFocusChangedEventHandler focusHandler;

    public static void Start() {
      if (On) return;
      On = true;
      focusHandler = (sender, e) => {
        var el = sender as AutomationElement;
        work.Add(() => Refocus(el));
      };
      try { Automation.AddAutomationFocusChangedEventHandler(focusHandler); } catch (Exception e) { Console.Error.WriteLine("axhelper: focus events unavailable: " + e.Message); }
      // Text, caret and window movement are polled: Chromium, WinUI and Win32 boxes each raise a different
      // subset of UI Automation events, and a poll catches all of them for the cost of one read per tick.
      timer = new Timer(_ => {
        if (Interlocked.Exchange(ref ticking, 1) == 1) return;
        work.Add(() => { try { Tick(); } finally { Interlocked.Exchange(ref ticking, 0); } });
      }, null, 250, 250);
      Refocus(Focused());
    }

    public static void Stop() {
      if (!On) return;
      On = false;
      if (timer != null) { timer.Dispose(); timer = null; }
      try { if (focusHandler != null) Automation.RemoveAutomationFocusChangedEventHandler(focusHandler); } catch { }
      focusHandler = null;
      Current = null;
      window = null;
      EmitBlur();
    }

    static AutomationElement TopWindow(AutomationElement el) {
      try {
        var walker = TreeWalker.ControlViewWalker;
        var root = AutomationElement.RootElement;
        var cur = el;
        for (int i = 0; i < 200 && cur != null; i++) {
          var parent = walker.GetParent(cur);
          if (parent == null || parent == root) return cur;
          cur = parent;
        }
      } catch { }
      return null;
    }

    static void Refocus(AutomationElement el) {
      if (!On) return;
      if (el == null) { EmitBlur(); return; }
      int pid = Pid(el);
      if (ownPid != 0 && pid == ownPid) return; // our own card or editor: keep watching the box being edited
      if (Current != null) {
        try { if (Automation.Compare(el, Current)) { EmitText("focus"); return; } } catch { }
      }
      var info = Describe(el);
      if (info == null || !(bool)info["editable"]) {
        // Not a text box. Keep the last box as the write target so a fix chosen on the card still lands in it.
        Current = null;
        window = null;
        EmitBlur();
        return;
      }
      Current = el;
      LastBox = el;
      LastBoxPid = pid;
      window = TopWindow(el);
      lastRects = Rects();
      EmitInfo(info, "focus");
    }

    static string Rects() {
      var a = Current != null ? Frame(Current) : null;
      var b = window != null ? Frame(window) : null;
      return (a == null ? "" : string.Join(",", a)) + "|" + (b == null ? "" : string.Join(",", b));
    }

    static void Tick() {
      if (!On || Current == null) return;
      try {
        var text = ReadText(Current);
        if (text == null) throw new ElementNotAvailableException();
        var tp = Pattern<TextPattern>(Current, TextPattern.Pattern);
        var sel = tp != null ? Selection(tp) : null;
        var selKey = sel == null ? "" : sel[0] + ":" + sel[1];
        if (text != lastText || selKey != lastSel) { EmitText("text"); return; }
        var rects = Rects();
        if (rects != lastRects) { lastRects = rects; Program.Emit(new Dictionary<string, object> { { "type", "moved" } }); }
      } catch (ElementNotAvailableException) {
        Current = null;
        window = null;
        EmitBlur();
      } catch { /* transient; try again next tick */ }
    }

    static void EmitBlur() {
      gen++;
      lastText = null;
      lastSel = null;
      Program.Emit(new Dictionary<string, object> { { "type", "blur" }, { "gen", gen } });
    }

    static void EmitText(string type) {
      var info = Current != null ? Describe(Current) : null;
      if (info == null || !(bool)info["editable"]) { Current = null; EmitBlur(); return; }
      EmitInfo(info, type);
    }

    static void EmitInfo(Dictionary<string, object> info, string type) {
      gen++;
      lastText = info.ContainsKey("text") ? (string)info["text"] : null;
      lastSel = info.ContainsKey("selStart") ? info["selStart"] + ":" + info["selLen"] : "";
      info["type"] = type;
      info["gen"] = gen;
      Program.Emit(info);
    }
  }

  // ---------- commands ----------
  static int Int(Dictionary<string, object> obj, string key, int fallback) {
    object v;
    if (!obj.TryGetValue(key, out v) || v == null) return fallback;
    try { return Convert.ToInt32(v); } catch { return fallback; }
  }

  static void HandleCommand(Dictionary<string, object> obj) {
    object o;
    string cmd = obj.TryGetValue("cmd", out o) ? o as string ?? "" : "";
    object id = obj.TryGetValue("id", out o) ? o : null;
    Action<Dictionary<string, object>> reply = body => { if (id != null) body["id"] = id; Emit(body); };

    // The element an edit applies to: the watched box, else the last box in the requested process, else whatever has focus.
    Func<AutomationElement> target = () => {
      int wanted = Int(obj, "pid", 0);
      var c = Watcher.Current;
      if (c != null && (wanted == 0 || Pid(c) == wanted)) return c;
      if (Watcher.LastBox != null && (wanted == 0 || Watcher.LastBoxPid == wanted)) return Watcher.LastBox;
      return Focused();
    };

    switch (cmd) {
      case "watch": {
        bool on = !obj.TryGetValue("on", out o) || !(o is bool) || (bool)o;
        if (on) Watcher.Start(); else Watcher.Stop();
        reply(new Dictionary<string, object> { { "type", "watch" }, { "on", Watcher.On } });
        break;
      }
      case "read": {
        var info = Describe(Focused());
        if (info == null) { reply(new Dictionary<string, object> { { "type", "read" }, { "ok", false } }); break; }
        info["type"] = "read";
        info["ok"] = true;
        reply(info);
        break;
      }
      case "bounds": {
        var rects = new List<object>();
        var lines = new List<object>();
        bool wantLines = obj.TryGetValue("lines", out o) && o is bool && (bool)o;
        var el = target();
        var tp = el != null ? Pattern<TextPattern>(el, TextPattern.Pattern) : null;
        var ranges = obj.TryGetValue("ranges", out o) ? o as object[] : null;
        if (ranges != null) {
          foreach (var item in ranges) {
            var pair = item as object[];
            if (pair == null || pair.Length != 2) continue;
            List<object> union = null;
            var perLine = new List<object>();
            if (tp != null) {
              try {
                var boxes = RangeAt(tp, Convert.ToInt32(pair[0]), Convert.ToInt32(pair[1])).GetBoundingRectangles();
                Rect u = Rect.Empty;
                foreach (var r in boxes) {
                  if (r.IsEmpty || r.Width <= 0 || r.Height <= 0) continue;
                  perLine.Add(RectList(r));
                  u.Union(r);
                }
                if (!u.IsEmpty) union = RectList(u);
              } catch { /* range off screen or element gone */ }
            }
            rects.Add(union);
            if (wantLines) lines.Add(perLine);
          }
        }
        var res = new Dictionary<string, object> { { "type", "bounds" }, { "rects", rects } };
        if (wantLines) res["lines"] = lines;
        reply(res);
        break;
      }
      case "replace": {
        var el = target();
        string text = obj.TryGetValue("text", out o) ? o as string : null;
        int start = Int(obj, "start", -1), length = Int(obj, "length", -1);
        if (el == null || text == null || start < 0 || length < 0) {
          reply(new Dictionary<string, object> { { "type", "replace" }, { "ok", false }, { "error", "no focused text box or bad arguments" } });
          break;
        }
        var r = Replace(el, start, length, text);
        var res = new Dictionary<string, object> { { "type", "replace" }, { "ok", r[0] == null }, { "method", r[1] } };
        if (r[0] != null) res["error"] = r[0];
        reply(res);
        break;
      }
      case "select": {
        var el = target();
        var tp = el != null ? Pattern<TextPattern>(el, TextPattern.Pattern) : null;
        bool ok = false;
        if (tp != null) { try { RangeAt(tp, Int(obj, "start", 0), Int(obj, "length", 0)).Select(); ok = true; } catch { } }
        reply(new Dictionary<string, object> { { "type", "select" }, { "ok", ok } });
        break;
      }
      case "focus": {
        // Used by tests: focus the first editable box in the foreground window whose name contains `match`.
        string match = obj.TryGetValue("match", out o) ? o as string ?? "" : "";
        AutomationElement found = null;
        try {
          var win = AutomationElement.FromHandle(Native.GetForegroundWindow());
          foreach (AutomationElement el in win.FindAll(TreeScope.Subtree, Condition.TrueCondition)) {
            if (!IsEditable(el)) continue;
            string name = "";
            try { name = el.Current.Name ?? ""; } catch { }
            if (match.Length == 0 || name.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0) { found = el; break; }
          }
        } catch { }
        if (found == null) { reply(new Dictionary<string, object> { { "type", "focus" }, { "ok", false }, { "error", "no text box matching \"" + match + "\"" } }); break; }
        bool focused = true;
        try { found.SetFocus(); } catch { focused = false; }
        Thread.Sleep(150);
        var info = Describe(found) ?? new Dictionary<string, object>();
        info["type"] = "focus";
        info["ok"] = focused;
        reply(info);
        break;
      }
      case "trusted":
        reply(new Dictionary<string, object> { { "type", "trusted" }, { "ok", true } });
        break;
      case "quit":
        Environment.Exit(0);
        break;
      default:
        reply(new Dictionary<string, object> { { "type", "error" }, { "error", "unknown command: " + cmd } });
        break;
    }
  }
}

static class Native {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);

  public const ushort VK_BACK = 0x08;
  const uint INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public InputUnion u; }

  /// Rects in physical pixels on every monitor, whatever its scaling.
  public static void MakeDpiAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { /* before Windows 10 1703 */ }
    try { SetProcessDPIAware(); } catch { }
  }

  /// The hotkey that triggered an edit may still be held; typed characters would combine with it (Ctrl+S…).
  public static void WaitForModifiersReleased() {
    int[] keys = { 0x10, 0x11, 0x12, 0x5B, 0x5C }; // Shift, Ctrl, Alt, left and right Windows keys
    for (int i = 0; i < 40; i++) {
      if (!keys.Any(k => (GetAsyncKeyState(k) & 0x8000) != 0)) return;
      Thread.Sleep(25);
    }
  }

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    return new INPUT { type = INPUT_KEYBOARD, u = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags } } };
  }

  public static void TapKey(ushort vk) {
    var inputs = new[] { Key(vk, 0, 0), Key(vk, 0, KEYEVENTF_KEYUP) };
    SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }

  /// Types text as Unicode keystrokes, in small batches so slow editors keep up.
  public static void TypeUnicode(string text) {
    for (int i = 0; i < text.Length; i += 20) {
      var batch = new List<INPUT>();
      foreach (char c in text.Substring(i, Math.Min(20, text.Length - i))) {
        batch.Add(Key(0, c, KEYEVENTF_UNICODE));
        batch.Add(Key(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
      }
      SendInput((uint)batch.Count, batch.ToArray(), Marshal.SizeOf(typeof(INPUT)));
      Thread.Sleep(4);
    }
  }
}
