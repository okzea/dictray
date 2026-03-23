using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Forms;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true
    };
    private static readonly JsonSerializerOptions CompactJsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false
    };

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            var command = args.Length > 0 ? args[0].Trim().ToLowerInvariant() : "health";
            return command switch
            {
                "health" => WriteJson(new
                {
                    ok = true,
                    platform = "windows",
                    backend = "uia",
                    supports = new[]
                    {
                        "list-windows",
                        "snapshot",
                        "action"
                    }
                }),
                "list-windows" => HandleListWindows(ReadRequest<ListWindowsRequest>() ?? new ListWindowsRequest()),
                "snapshot" => HandleSnapshot(ReadRequest<SnapshotRequest>() ?? new SnapshotRequest()),
                "action" => HandleAction(ReadRequest<ActionRequest>() ?? new ActionRequest()),
                "serve" => RunServer(),
                _ => Fail($"Unknown command \"{command}\".")
            };
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return WriteJson(new
            {
                ok = false,
                error = error.Message
            }, exitCode: 1);
        }
    }

    private static T? ReadRequest<T>()
    {
        if (!Console.IsInputRedirected)
        {
            return default;
        }

        var raw = Console.In.ReadToEnd();
        if (string.IsNullOrWhiteSpace(raw))
        {
            return default;
        }

        return JsonSerializer.Deserialize<T>(raw, JsonOptions);
    }

    private static int HandleListWindows(ListWindowsRequest request)
    {
        var windows = WindowCatalog.ListWindows(request.Selector, request.Limit);
        return WriteJson(new
        {
            ok = true,
            count = windows.Count,
            windows
        });
    }

    private static int HandleSnapshot(SnapshotRequest request)
    {
        var window = WindowCatalog.ResolveWindow(request.Window);
        if (window is null)
        {
            return Fail("No matching application window was found.");
        }

        var target = AutomationSearch.ResolveElement(window.Element, request.Element, request.SearchLimit);
        if (target is null)
        {
            return Fail("No matching UI element was found in the selected window.");
        }

        var budget = new SnapshotBudget(request.MaxNodes ?? 120);
        var tree = SnapshotBuilder.Build(target, 0, Math.Max(0, request.MaxDepth ?? 4), budget);
        return WriteJson(new
        {
            ok = true,
            window = SnapshotBuilder.BuildWindow(window),
            target = tree,
            truncated = budget.Truncated,
            nodeCount = budget.Visited
        });
    }

    private static int HandleAction(ActionRequest request)
    {
        var totalTimer = Stopwatch.StartNew();
        var action = NormalizeAction(request.Action);
        var windowTimer = Stopwatch.StartNew();
        var window = WindowCatalog.ResolveWindow(request.Window);
        var windowResolveMs = windowTimer.ElapsedMilliseconds;
        if (window is null)
        {
            return Fail("No matching application window was found.");
        }

        AutomationElement target;
        object? actionTimings = null;
        long elementResolveMs = 0;
        if (action == "focus_window")
        {
            target = window.Element;
            var actionTimer = Stopwatch.StartNew();
            UiAutomationActions.FocusWindow(window);
            actionTimings = new
            {
                focusWindow = actionTimer.ElapsedMilliseconds
            };
        }
        else
        {
            var elementTimer = Stopwatch.StartNew();
            target = AutomationSearch.ResolveElement(window.Element, request.Element, request.SearchLimit)
                ?? throw new InvalidOperationException("No matching UI element was found in the selected window.");
            elementResolveMs = elementTimer.ElapsedMilliseconds;
            var actionTimer = Stopwatch.StartNew();
            actionTimings = UiAutomationActions.Perform(action, window, target, request);
            if (actionTimings is null)
            {
                actionTimings = new
                {
                    action = actionTimer.ElapsedMilliseconds
                };
            }
        }

        return WriteJson(new
        {
            ok = true,
            action,
            window = SnapshotBuilder.BuildWindow(window),
            target = SnapshotBuilder.BuildLeaf(target),
            timings = new
            {
                total = totalTimer.ElapsedMilliseconds,
                windowResolve = windowResolveMs,
                elementResolve = elementResolveMs,
                action = actionTimings
            }
        });
    }

    private static string NormalizeAction(string? value)
    {
        return string.Concat(value ?? string.Empty)
            .Trim()
            .ToLowerInvariant()
            .Replace("-", "_")
            .Replace(" ", "_");
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine(message);
        return WriteJson(new
        {
            ok = false,
            error = message
        }, exitCode: 1);
    }

    private static int WriteJson(object payload, int exitCode = 0)
    {
        Console.Out.WriteLine(JsonSerializer.Serialize(payload, JsonOptions));
        return exitCode;
    }

    private static int RunServer()
    {
        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            object response;
            try
            {
                var request = JsonSerializer.Deserialize<ServeRequest>(line, CompactJsonOptions)
                    ?? throw new InvalidOperationException("Invalid server request.");
                response = HandleServeRequest(request);
            }
            catch (Exception error)
            {
                response = new ServeResponse
                {
                    Ok = false,
                    Error = error.Message
                };
            }

            Console.Out.WriteLine(JsonSerializer.Serialize(response, CompactJsonOptions));
        }

        return 0;
    }

    private static object HandleServeRequest(ServeRequest request)
    {
        var command = (request.Command ?? string.Empty).Trim().ToLowerInvariant();
        object payload = command switch
        {
            "health" => new
            {
                ok = true,
                platform = "windows",
                backend = "uia",
                supports = new[] { "list-windows", "snapshot", "action", "serve" }
            },
            "list-windows" => BuildListWindowsResponse(ReadPayload<ListWindowsRequest>(request.Payload) ?? new ListWindowsRequest()),
            "snapshot" => BuildSnapshotResponse(ReadPayload<SnapshotRequest>(request.Payload) ?? new SnapshotRequest()),
            "action" => BuildActionResponse(ReadPayload<ActionRequest>(request.Payload) ?? new ActionRequest()),
            _ => new { ok = false, error = $"Unknown command \"{command}\"." }
        };

        return new ServeResponse
        {
            Id = request.Id,
            Payload = payload,
            Ok = true
        };
    }

    private static T? ReadPayload<T>(JsonElement? payload)
    {
        if (payload is null || payload.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return default;
        }

        return payload.Value.Deserialize<T>(CompactJsonOptions);
    }

    private static object BuildListWindowsResponse(ListWindowsRequest request)
    {
        var windows = WindowCatalog.ListWindows(request.Selector, request.Limit);
        return new
        {
            ok = true,
            count = windows.Count,
            windows
        };
    }

    private static object BuildSnapshotResponse(SnapshotRequest request)
    {
        var window = WindowCatalog.ResolveWindow(request.Window);
        if (window is null)
        {
            return new { ok = false, error = "No matching application window was found." };
        }

        var target = AutomationSearch.ResolveElement(window.Element, request.Element, request.SearchLimit);
        if (target is null)
        {
            return new { ok = false, error = "No matching UI element was found in the selected window." };
        }

        var budget = new SnapshotBudget(request.MaxNodes ?? 120);
        var tree = SnapshotBuilder.Build(target, 0, Math.Max(0, request.MaxDepth ?? 4), budget);
        return new
        {
            ok = true,
            window = SnapshotBuilder.BuildWindow(window),
            target = tree,
            truncated = budget.Truncated,
            nodeCount = budget.Visited
        };
    }

    private static object BuildActionResponse(ActionRequest request)
    {
        var totalTimer = Stopwatch.StartNew();
        var action = NormalizeAction(request.Action);
        var windowTimer = Stopwatch.StartNew();
        var window = WindowCatalog.ResolveWindow(request.Window);
        var windowResolveMs = windowTimer.ElapsedMilliseconds;
        if (window is null)
        {
            return new { ok = false, error = "No matching application window was found." };
        }

        AutomationElement target;
        object? actionTimings = null;
        long elementResolveMs = 0;
        if (action == "focus_window")
        {
            target = window.Element;
            var actionTimer = Stopwatch.StartNew();
            UiAutomationActions.FocusWindow(window);
            actionTimings = new
            {
                focusWindow = actionTimer.ElapsedMilliseconds
            };
        }
        else
        {
            var elementTimer = Stopwatch.StartNew();
            target = AutomationSearch.ResolveElement(window.Element, request.Element, request.SearchLimit)
                ?? throw new InvalidOperationException("No matching UI element was found in the selected window.");
            elementResolveMs = elementTimer.ElapsedMilliseconds;
            var actionTimer = Stopwatch.StartNew();
            actionTimings = UiAutomationActions.Perform(action, window, target, request);
            if (actionTimings is null)
            {
                actionTimings = new
                {
                    action = actionTimer.ElapsedMilliseconds
                };
            }
        }

        return new
        {
            ok = true,
            action,
            window = SnapshotBuilder.BuildWindow(window),
            target = SnapshotBuilder.BuildLeaf(target),
            timings = new
            {
                total = totalTimer.ElapsedMilliseconds,
                windowResolve = windowResolveMs,
                elementResolve = elementResolveMs,
                action = actionTimings
            }
        };
    }
}

internal sealed class ServeRequest
{
    public string? Id { get; init; }
    public string? Command { get; init; }
    public JsonElement? Payload { get; init; }
}

internal sealed class ServeResponse
{
    public string? Id { get; init; }
    public bool Ok { get; init; }
    public string? Error { get; init; }
    public object? Payload { get; init; }
}

internal sealed class ListWindowsRequest
{
    public UiSelector? Selector { get; init; }
    public int? Limit { get; init; }
}

internal sealed class SnapshotRequest
{
    public UiSelector? Window { get; init; }
    public UiSelector? Element { get; init; }
    public int? MaxDepth { get; init; }
    public int? MaxNodes { get; init; }
    public int? SearchLimit { get; init; }
}

internal sealed class ActionRequest
{
    public string? Action { get; init; }
    public UiSelector? Window { get; init; }
    public UiSelector? Element { get; init; }
    public string? Value { get; init; }
    public string? Text { get; init; }
    public int? SearchLimit { get; init; }
}

internal sealed class UiSelector
{
    public string? Hwnd { get; init; }
    public string? ProcessName { get; init; }
    public string? TitleContains { get; init; }
    public string? Name { get; init; }
    public string? AutomationId { get; init; }
    public string? ClassName { get; init; }
    public string? ControlType { get; init; }
    public int? Index { get; init; }
}

internal sealed record WindowMatch(IntPtr Handle, AutomationElement Element, string ProcessName, string Title, string ClassName, bool Focused);

internal static class WindowCatalog
{
    private const int SwShow = 5;
    private const int SwRestore = 9;

    public static List<object> ListWindows(UiSelector? selector, int? limit)
    {
        var max = ClampLimit(limit, 24);
        var windows = EnumerateVisibleWindows()
            .Where((window) => SelectorMatcher.MatchesWindow(window, selector))
            .Take(max)
            .Select(SnapshotBuilder.BuildWindow)
            .ToList();
        return windows;
    }

    public static WindowMatch? ResolveWindow(UiSelector? selector)
    {
        var current = GetForegroundWindow();
        if (SelectorMatcher.IsEmpty(selector))
        {
            return current == IntPtr.Zero ? null : BuildWindowMatch(current);
        }

        var matches = EnumerateVisibleWindows()
            .Where((window) => SelectorMatcher.MatchesWindow(window, selector))
            .ToList();
        if (matches.Count == 0)
        {
            return null;
        }

        var index = Math.Max(0, selector?.Index ?? 0);
        return matches[Math.Min(index, matches.Count - 1)];
    }

    public static void BringToFront(WindowMatch window)
    {
        if (window.Handle == GetForegroundWindow())
        {
            return;
        }

        var command = IsIconic(window.Handle) ? SwRestore : SwShow;
        ShowWindow(window.Handle, command);
        SetForegroundWindow(window.Handle);
    }

    private static IEnumerable<WindowMatch> EnumerateVisibleWindows()
    {
        var windows = new List<WindowMatch>();
        EnumWindows((handle, _) =>
        {
            try
            {
                if (!IsWindowVisible(handle))
                {
                    return true;
                }

                var title = ReadWindowText(handle);
                if (string.IsNullOrWhiteSpace(title))
                {
                    return true;
                }

                var match = BuildWindowMatch(handle);
                if (match is not null)
                {
                    windows.Add(match);
                }
            }
            catch
            {
            }

            return true;
        }, IntPtr.Zero);

        return windows;
    }

    private static WindowMatch? BuildWindowMatch(IntPtr handle)
    {
        if (handle == IntPtr.Zero)
        {
            return null;
        }

        var element = AutomationElement.FromHandle(handle);
        if (element is null)
        {
            return null;
        }

        var processId = SafeAutomation.GetInt(element, AutomationElement.ProcessIdProperty);
        var processName = SafeAutomation.GetProcessName(processId);
        var title = ReadWindowText(handle);
        var className = ReadClassName(handle);
        var focused = handle == GetForegroundWindow();
        return new WindowMatch(handle, element, processName, title, className, focused);
    }

    private static string ReadWindowText(IntPtr handle)
    {
        var length = GetWindowTextLengthW(handle);
        if (length <= 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder(length + 1);
        _ = GetWindowTextW(handle, builder, builder.Capacity);
        return builder.ToString().Trim();
    }

    private static string ReadClassName(IntPtr handle)
    {
        var builder = new StringBuilder(256);
        _ = GetClassNameW(handle, builder, builder.Capacity);
        return builder.ToString().Trim();
    }

    private static int ClampLimit(int? value, int fallback)
    {
        if (!value.HasValue)
        {
            return fallback;
        }

        return Math.Max(1, Math.Min(64, value.Value));
    }

    private delegate bool EnumWindowsProc(IntPtr handle, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
}

internal static class AutomationSearch
{
    public static AutomationElement? ResolveElement(AutomationElement root, UiSelector? selector, int? searchLimit)
    {
        if (root is null)
        {
            return null;
        }

        if (SelectorMatcher.IsEmpty(selector))
        {
            return root;
        }

        var limit = Math.Max(10, Math.Min(800, searchLimit ?? 320));
        var matches = new List<AutomationElement>();
        var queue = new Queue<AutomationElement>();
        queue.Enqueue(root);

        while (queue.Count > 0 && matches.Count <= (selector?.Index ?? 0))
        {
            var current = queue.Dequeue();
            if (SelectorMatcher.MatchesElement(current, selector))
            {
                matches.Add(current);
            }

            if (limit-- <= 0)
            {
                break;
            }

            foreach (var child in SafeAutomation.GetChildren(current))
            {
                queue.Enqueue(child);
            }
        }

        if (matches.Count == 0)
        {
            return null;
        }

        var index = Math.Max(0, selector?.Index ?? 0);
        return matches[Math.Min(index, matches.Count - 1)];
    }
}

internal static class UiAutomationActions
{
    private const int FocusSettleDelayMs = 20;
    private const int ClipboardSettleDelayMs = 10;
    private const int PasteSettleDelayMs = 40;
    private const int ClipboardRetryAttempts = 8;
    private const int ClipboardRetryDelayMs = 20;

    public static object? Perform(string action, WindowMatch window, AutomationElement target, ActionRequest request)
    {
        switch (action)
        {
            case "focus":
            case "focus_element":
                SetFocus(window, target);
                return null;
            case "invoke":
                Invoke(window, target);
                return null;
            case "set_value":
                SetValue(window, target, request.Value);
                return null;
            case "paste_text":
                return PasteText(window, request.Text ?? request.Value);
            case "send_keys":
                SendKeys(window, target, request.Text ?? request.Value);
                return null;
            case "expand":
                ExpandCollapse(window, target, expand: true);
                return null;
            case "collapse":
                ExpandCollapse(window, target, expand: false);
                return null;
            case "toggle":
                Toggle(window, target);
                return null;
            case "select":
                Select(window, target);
                return null;
            default:
                throw new InvalidOperationException($"Unsupported action \"{action}\".");
        }
    }

    public static void FocusWindow(WindowMatch window)
    {
        WindowCatalog.BringToFront(window);
        window.Element.SetFocus();
    }

    private static void SetFocus(WindowMatch window, AutomationElement target)
    {
        WindowCatalog.BringToFront(window);
        target.SetFocus();
    }

    private static void Invoke(WindowMatch window, AutomationElement target)
    {
        SetFocus(window, target);

        if (target.TryGetCurrentPattern(InvokePattern.Pattern, out var invokePattern))
        {
            ((InvokePattern)invokePattern).Invoke();
            return;
        }

        if (target.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var selectionItemPattern))
        {
            ((SelectionItemPattern)selectionItemPattern).Select();
            return;
        }

        if (target.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var expandCollapsePattern))
        {
            var pattern = (ExpandCollapsePattern)expandCollapsePattern;
            var state = pattern.Current.ExpandCollapseState;
            if (state is ExpandCollapseState.Collapsed or ExpandCollapseState.PartiallyExpanded)
            {
                pattern.Expand();
            }
            else if (state == ExpandCollapseState.Expanded)
            {
                pattern.Collapse();
            }
            return;
        }

        throw new InvalidOperationException("The selected UI element does not support invoke-style actions.");
    }

    private static void SetValue(WindowMatch window, AutomationElement target, string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidOperationException("A non-empty value is required for set_value.");
        }

        SetFocus(window, target);
        if (!target.TryGetCurrentPattern(ValuePattern.Pattern, out var valuePattern))
        {
            throw new InvalidOperationException("The selected UI element does not support ValuePattern.");
        }

        var pattern = (ValuePattern)valuePattern;
        if (pattern.Current.IsReadOnly)
        {
            throw new InvalidOperationException("The selected UI element is read-only.");
        }

        pattern.SetValue(value);
    }

    private static object PasteText(WindowMatch window, string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            throw new InvalidOperationException("A non-empty text value is required for paste_text.");
        }

        var focusTimer = Stopwatch.StartNew();
        WindowCatalog.BringToFront(window);
        System.Threading.Thread.Sleep(FocusSettleDelayMs);
        var focusMs = focusTimer.ElapsedMilliseconds;

        System.Windows.Forms.IDataObject? previousClipboard = null;
        var hadClipboard = false;
        string? previousClipboardText = null;
        long clipboardSetMs = 0;
        long pasteShortcutMs = 0;
        long clipboardRestoreMs = 0;
        int clipboardRestoreAttempts = 0;
        bool clipboardRestoreSuccess = false;
        string? clipboardRestoreError = null;
        try
        {
            try
            {
                previousClipboard = System.Windows.Forms.Clipboard.GetDataObject();
                hadClipboard = previousClipboard is not null;
                previousClipboardText = GetClipboardText(previousClipboard);
            }
            catch
            {
                previousClipboard = null;
                hadClipboard = false;
            }

            var clipboardSetTimer = Stopwatch.StartNew();
            System.Windows.Forms.Clipboard.SetText(text);
            System.Threading.Thread.Sleep(ClipboardSettleDelayMs);
            clipboardSetMs = clipboardSetTimer.ElapsedMilliseconds;
            var pasteTimer = Stopwatch.StartNew();
            SendPasteShortcut();
            System.Threading.Thread.Sleep(PasteSettleDelayMs);
            pasteShortcutMs = pasteTimer.ElapsedMilliseconds;
        }
        finally
        {
            var clipboardRestoreTimer = Stopwatch.StartNew();
            var restoreResult = RestoreClipboard(previousClipboard, previousClipboardText, hadClipboard);
            clipboardRestoreMs = clipboardRestoreTimer.ElapsedMilliseconds;
            clipboardRestoreAttempts = restoreResult.Attempts;
            clipboardRestoreSuccess = restoreResult.Success;
            clipboardRestoreError = restoreResult.Error;
        }

        return new
        {
            focus = focusMs,
            clipboardSet = clipboardSetMs,
            paste = pasteShortcutMs,
            clipboardRestore = clipboardRestoreMs,
            clipboardRestoreSuccess,
            clipboardRestoreAttempts,
            clipboardRestoreError
        };
    }

    private static string? GetClipboardText(System.Windows.Forms.IDataObject? clipboardData)
    {
        if (clipboardData is null)
        {
            return null;
        }

        string? Read(string format)
        {
            try
            {
                if (!clipboardData.GetDataPresent(format))
                {
                    return null;
                }

                return clipboardData.GetData(format) as string;
            }
            catch
            {
                return null;
            }
        }

        return string.IsNullOrWhiteSpace(Read(DataFormats.UnicodeText))
            ? string.IsNullOrWhiteSpace(Read(DataFormats.Text))
                ? string.IsNullOrWhiteSpace(Read(DataFormats.StringFormat))
                    ? null
                    : Read(DataFormats.StringFormat)
                : Read(DataFormats.Text)
            : Read(DataFormats.UnicodeText);
    }

    private static ClipboardRestoreResult RestoreClipboard(System.Windows.Forms.IDataObject? previousClipboard, string? previousText, bool hadClipboard)
    {
        if (hadClipboard && previousClipboard is not null)
        {
            var restoreOriginal = SetClipboardWithRetry(
                () => System.Windows.Forms.Clipboard.SetDataObject(previousClipboard, true, ClipboardRetryAttempts, ClipboardRetryDelayMs),
                "restore original clipboard data"
            );
            if (restoreOriginal.Success)
            {
                return restoreOriginal;
            }

            if (!string.IsNullOrWhiteSpace(previousText))
            {
                var restoreText = SetClipboardWithRetry(
                    () => System.Windows.Forms.Clipboard.SetText(previousText),
                    "restore previous clipboard text"
                );
                if (restoreText.Success)
                {
                    return restoreText with { Attempts = restoreOriginal.Attempts + restoreText.Attempts };
                }
            }
        }

        return SetClipboardWithRetry(System.Windows.Forms.Clipboard.Clear, "clear clipboard");
    }

    private static ClipboardRestoreResult SetClipboardWithRetry(Action setAction, string operation)
    {
        var lastError = (string?)null;
        for (var attempt = 1; attempt <= ClipboardRetryAttempts; attempt++)
        {
            try
            {
                setAction();
                return new ClipboardRestoreResult(attempt, true, null);
            }
            catch (Exception error)
            {
                lastError = $"{operation}: {error.Message}";
                if (attempt < ClipboardRetryAttempts)
                {
                    System.Threading.Thread.Sleep(ClipboardRetryDelayMs);
                }
            }
        }

        return new ClipboardRestoreResult(ClipboardRetryAttempts, false, lastError);
    }

    private readonly record struct ClipboardRestoreResult(int Attempts, bool Success, string? Error);

    private static void SendPasteShortcut()
    {
        var inputs = new[]
        {
            CreateKeyboardInput(VkControl, keyUp: false),
            CreateKeyboardInput(VkV, keyUp: false),
            CreateKeyboardInput(VkV, keyUp: true),
            CreateKeyboardInput(VkControl, keyUp: true)
        };

        var sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<NativeInput>());
        if (sent == inputs.Length)
        {
            return;
        }

        SendPasteShortcutWithKeybdEvent();
    }

    private static void SendPasteShortcutWithKeybdEvent()
    {
        keybd_event(VkControl, 0, 0, UIntPtr.Zero);
        keybd_event(VkV, 0, 0, UIntPtr.Zero);
        keybd_event(VkV, 0, KeyeventfKeyup, UIntPtr.Zero);
        keybd_event(VkControl, 0, KeyeventfKeyup, UIntPtr.Zero);
    }

    private static NativeInput CreateKeyboardInput(ushort vk, bool keyUp)
    {
        return new NativeInput
        {
            Type = InputKeyboard,
            Data = new InputUnion
            {
                Keyboard = new KeyboardInput
                {
                    Vk = vk,
                    Scan = 0,
                    Flags = keyUp ? KeyeventfKeyup : 0,
                    Time = 0,
                    ExtraInfo = IntPtr.Zero
                }
            }
        };
    }

    private const int InputKeyboard = 1;
    private const uint KeyeventfKeyup = 0x0002;
    private const ushort VkControl = 0x11;
    private const ushort VkV = 0x56;

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeInput
    {
        public int Type;
        public InputUnion Data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)]
        public KeyboardInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort Vk;
        public ushort Scan;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, NativeInput[] pInputs, int cbSize);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern void keybd_event(ushort bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    private static void SendKeys(WindowMatch window, AutomationElement target, string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            throw new InvalidOperationException("A non-empty text value is required for send_keys.");
        }

        SetFocus(window, target);
        System.Threading.Thread.Sleep(FocusSettleDelayMs);
        System.Windows.Forms.SendKeys.SendWait(text);
    }

    private static void ExpandCollapse(WindowMatch window, AutomationElement target, bool expand)
    {
        SetFocus(window, target);
        if (!target.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var patternObject))
        {
            throw new InvalidOperationException("The selected UI element does not support ExpandCollapsePattern.");
        }

        var pattern = (ExpandCollapsePattern)patternObject;
        if (expand)
        {
            pattern.Expand();
        }
        else
        {
            pattern.Collapse();
        }
    }

    private static void Toggle(WindowMatch window, AutomationElement target)
    {
        SetFocus(window, target);
        if (!target.TryGetCurrentPattern(TogglePattern.Pattern, out var patternObject))
        {
            throw new InvalidOperationException("The selected UI element does not support TogglePattern.");
        }

        ((TogglePattern)patternObject).Toggle();
    }

    private static void Select(WindowMatch window, AutomationElement target)
    {
        SetFocus(window, target);
        if (!target.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var patternObject))
        {
            throw new InvalidOperationException("The selected UI element does not support SelectionItemPattern.");
        }

        ((SelectionItemPattern)patternObject).Select();
    }
}

internal static class SelectorMatcher
{
    public static bool IsEmpty(UiSelector? selector)
    {
        return selector is null
            || (
                string.IsNullOrWhiteSpace(selector.Hwnd)
                && string.IsNullOrWhiteSpace(selector.ProcessName)
                && string.IsNullOrWhiteSpace(selector.TitleContains)
                && string.IsNullOrWhiteSpace(selector.Name)
                && string.IsNullOrWhiteSpace(selector.AutomationId)
                && string.IsNullOrWhiteSpace(selector.ClassName)
                && string.IsNullOrWhiteSpace(selector.ControlType)
            );
    }

    public static bool MatchesWindow(WindowMatch window, UiSelector? selector)
    {
        if (selector is null)
        {
            return true;
        }

        if (!MatchesWindowHandle(window.Handle, selector.Hwnd))
        {
            return false;
        }

        if (!MatchesText(window.ProcessName, selector.ProcessName, exact: true))
        {
            return false;
        }

        if (!MatchesText(window.Title, selector.TitleContains))
        {
            return false;
        }

        if (!MatchesText(window.ClassName, selector.ClassName, exact: true))
        {
            return false;
        }

        if (!MatchesText(window.Title, selector.Name))
        {
            return false;
        }

        return true;
    }

    private static bool MatchesWindowHandle(IntPtr actualHandle, string? expectedHandle)
    {
        if (string.IsNullOrWhiteSpace(expectedHandle))
        {
            return true;
        }

        var actual = $"0x{actualHandle.ToInt64():X}";
        return string.Equals(actual, expectedHandle.Trim(), StringComparison.OrdinalIgnoreCase);
    }

    public static bool MatchesElement(AutomationElement element, UiSelector? selector)
    {
        if (selector is null)
        {
            return true;
        }

        if (!MatchesText(SafeAutomation.GetProcessName(SafeAutomation.GetInt(element, AutomationElement.ProcessIdProperty)), selector.ProcessName, exact: true))
        {
            return false;
        }

        if (!MatchesText(SafeAutomation.GetString(element, AutomationElement.NameProperty), selector.Name))
        {
            return false;
        }

        if (!MatchesText(SafeAutomation.GetString(element, AutomationElement.AutomationIdProperty), selector.AutomationId, exact: true))
        {
            return false;
        }

        if (!MatchesText(SafeAutomation.GetString(element, AutomationElement.ClassNameProperty), selector.ClassName, exact: true))
        {
            return false;
        }

        if (!MatchesControlType(SafeAutomation.GetControlTypeName(element), selector.ControlType))
        {
            return false;
        }

        return true;
    }

    private static bool MatchesText(string actual, string? expected, bool exact = false)
    {
        if (string.IsNullOrWhiteSpace(expected))
        {
            return true;
        }

        if (string.IsNullOrWhiteSpace(actual))
        {
            return false;
        }

        return exact
            ? string.Equals(actual.Trim(), expected.Trim(), StringComparison.OrdinalIgnoreCase)
            : actual.Contains(expected.Trim(), StringComparison.OrdinalIgnoreCase);
    }

    private static bool MatchesControlType(string actual, string? expected)
    {
        if (string.IsNullOrWhiteSpace(expected))
        {
            return true;
        }

        var normalizedExpected = NormalizeToken(expected);
        var normalizedActual = NormalizeToken(actual);
        return normalizedActual == normalizedExpected;
    }

    private static string NormalizeToken(string? value)
    {
        return string.Concat((value ?? "")
            .Trim()
            .ToLowerInvariant()
            .Where(char.IsLetterOrDigit));
    }
}

internal sealed class SnapshotBudget
{
    public SnapshotBudget(int maxNodes)
    {
        MaxNodes = Math.Max(1, Math.Min(500, maxNodes));
    }

    public int MaxNodes { get; }

    public int Visited { get; private set; }

    public bool Truncated { get; private set; }

    public bool TryVisit()
    {
        if (Visited >= MaxNodes)
        {
            Truncated = true;
            return false;
        }

        Visited += 1;
        return true;
    }
}

internal static class SnapshotBuilder
{
    public static object BuildWindow(WindowMatch window)
    {
        return new
        {
            hwnd = window.Handle == IntPtr.Zero ? null : $"0x{window.Handle.ToInt64():X}",
            title = window.Title,
            processName = window.ProcessName,
            className = window.ClassName,
            focused = window.Focused,
            bounds = SafeAutomation.GetBounds(window.Element)
        };
    }

    public static object BuildLeaf(AutomationElement element)
    {
        return BuildNode(element, includeChildren: false, Array.Empty<object>());
    }

    public static object? Build(AutomationElement element, int depth, int maxDepth, SnapshotBudget budget)
    {
        if (!budget.TryVisit())
        {
            return null;
        }

        var children = new List<object>();
        if (depth < maxDepth)
        {
            foreach (var child in SafeAutomation.GetChildren(element))
            {
                var childNode = Build(child, depth + 1, maxDepth, budget);
                if (childNode is not null)
                {
                    children.Add(childNode);
                }

                if (budget.Truncated)
                {
                    break;
                }
            }
        }

        return BuildNode(element, includeChildren: depth < maxDepth, children);
    }

    private static object BuildNode(AutomationElement element, bool includeChildren, IReadOnlyList<object> children)
    {
        return new
        {
            name = SafeAutomation.GetString(element, AutomationElement.NameProperty),
            controlType = SafeAutomation.GetControlTypeName(element),
            automationId = SafeAutomation.GetString(element, AutomationElement.AutomationIdProperty),
            className = SafeAutomation.GetString(element, AutomationElement.ClassNameProperty),
            processName = SafeAutomation.GetProcessName(SafeAutomation.GetInt(element, AutomationElement.ProcessIdProperty)),
            hasKeyboardFocus = SafeAutomation.GetBool(element, AutomationElement.HasKeyboardFocusProperty),
            isEnabled = SafeAutomation.GetBool(element, AutomationElement.IsEnabledProperty),
            isOffscreen = SafeAutomation.GetBool(element, AutomationElement.IsOffscreenProperty),
            bounds = SafeAutomation.GetBounds(element),
            value = SafeAutomation.GetValue(element),
            text = SafeAutomation.GetText(element),
            patterns = SafeAutomation.GetSupportedPatternNames(element),
            children = includeChildren ? children : null
        };
    }
}

internal static class SafeAutomation
{
    private static readonly TreeWalker ControlWalker = TreeWalker.ControlViewWalker;
    private static readonly Dictionary<int, string> ProcessNameCache = new();

    public static IEnumerable<AutomationElement> GetChildren(AutomationElement element)
    {
        AutomationElement? current = null;
        try
        {
            current = ControlWalker.GetFirstChild(element);
        }
        catch
        {
            yield break;
        }

        while (current is not null)
        {
            yield return current;
            try
            {
                current = ControlWalker.GetNextSibling(current);
            }
            catch
            {
                yield break;
            }
        }
    }

    public static string GetString(AutomationElement element, AutomationProperty property)
    {
        try
        {
            var value = element.GetCurrentPropertyValue(property, true);
            return value is string text ? text.Trim() : string.Empty;
        }
        catch
        {
            return string.Empty;
        }
    }

    public static int GetInt(AutomationElement element, AutomationProperty property)
    {
        try
        {
            var value = element.GetCurrentPropertyValue(property, true);
            return value is int number ? number : 0;
        }
        catch
        {
            return 0;
        }
    }

    public static bool GetBool(AutomationElement element, AutomationProperty property)
    {
        try
        {
            var value = element.GetCurrentPropertyValue(property, true);
            return value is bool flag && flag;
        }
        catch
        {
            return false;
        }
    }

    public static object? GetBounds(AutomationElement element)
    {
        try
        {
            var value = element.GetCurrentPropertyValue(AutomationElement.BoundingRectangleProperty, true);
            if (value is not Rect rect || rect.IsEmpty)
            {
                return null;
            }

            return new
            {
                left = Math.Round(rect.Left, 2),
                top = Math.Round(rect.Top, 2),
                width = Math.Round(rect.Width, 2),
                height = Math.Round(rect.Height, 2)
            };
        }
        catch
        {
            return null;
        }
    }

    public static string GetControlTypeName(AutomationElement element)
    {
        try
        {
            var value = element.GetCurrentPropertyValue(AutomationElement.ControlTypeProperty, true);
            if (value is not ControlType controlType)
            {
                return string.Empty;
            }

            var programmaticName = controlType.ProgrammaticName ?? string.Empty;
            var suffix = programmaticName.Contains('.', StringComparison.Ordinal)
                ? programmaticName[(programmaticName.LastIndexOf('.') + 1)..]
                : programmaticName;
            return suffix.ToLowerInvariant();
        }
        catch
        {
            return string.Empty;
        }
    }

    public static string? GetValue(AutomationElement element)
    {
        try
        {
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var valuePatternObject))
            {
                var value = ((ValuePattern)valuePatternObject).Current.Value;
                return TrimText(value, 320);
            }
        }
        catch
        {
        }

        return null;
    }

    public static string? GetText(AutomationElement element)
    {
        try
        {
            if (element.TryGetCurrentPattern(TextPattern.Pattern, out var textPatternObject))
            {
                var text = ((TextPattern)textPatternObject).DocumentRange.GetText(-1);
                return TrimText(text, 500);
            }
        }
        catch
        {
        }

        return null;
    }

    public static IReadOnlyList<string> GetSupportedPatternNames(AutomationElement element)
    {
        try
        {
            return element.GetSupportedPatterns()
                .Select((pattern) => (pattern?.ProgrammaticName ?? string.Empty)
                    .Replace("Identifiers.Pattern", string.Empty, StringComparison.OrdinalIgnoreCase)
                    .Replace("PatternIdentifiers.", string.Empty, StringComparison.OrdinalIgnoreCase)
                    .Replace("AutomationPatternIdentifiers.", string.Empty, StringComparison.OrdinalIgnoreCase)
                    .Trim('.', ' '))
                .Where((value) => !string.IsNullOrWhiteSpace(value))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy((value) => value, StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }
        catch
        {
            return Array.Empty<string>();
        }
    }

    public static string GetProcessName(int processId)
    {
        if (processId <= 0)
        {
            return string.Empty;
        }

        if (ProcessNameCache.TryGetValue(processId, out var cached))
        {
            return cached;
        }

        try
        {
            var processName = Process.GetProcessById(processId).ProcessName ?? string.Empty;
            ProcessNameCache[processId] = processName;
            return processName;
        }
        catch
        {
            return string.Empty;
        }
    }

    private static string? TrimText(string? value, int limit)
    {
        var text = string.Join(' ', (value ?? string.Empty)
            .Split(new[] { '\r', '\n', '\t' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        if (text.Length <= limit)
        {
            return text;
        }

        return $"{text[..Math.Max(0, limit - 3)].Trim()}...";
    }
}
