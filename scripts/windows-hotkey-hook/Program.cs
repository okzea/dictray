using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

try
{
    var primaryShortcut = args.Length > 0 ? args[0] : "CommandOrControl+Space";
    var registrations = new List<HotkeyRegistration>
    {
        new(HotkeyDefinition.Parse(primaryShortcut), "down", "up")
    };

    var promptShortcut = args.Length > 1 ? args[1] : "";
    if (!string.IsNullOrWhiteSpace(promptShortcut)
        && !string.Equals(primaryShortcut.Trim(), promptShortcut.Trim(), StringComparison.OrdinalIgnoreCase))
    {
        registrations.Add(new HotkeyRegistration(HotkeyDefinition.Parse(promptShortcut), "prompt-down", "prompt-up"));
    }

    var cancelStatePath = args.Length > 2 ? args[2] : "";
    var exitCode = KeyboardHookBridge.Run(registrations, cancelStatePath);
    Environment.ExitCode = exitCode;
}
catch (Exception error)
{
    Console.Error.WriteLine(error.Message);
    Environment.ExitCode = 1;
}

internal sealed record HotkeyRegistration(HotkeyDefinition Definition, string DownEvent, string UpEvent);

internal sealed record HotkeyDefinition(bool Ctrl, bool Alt, bool Shift, bool Win, int Key)
{
    public static HotkeyDefinition Parse(string input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            throw new InvalidOperationException("Shortcut cannot be empty.");
        }

        var ctrl = false;
        var alt = false;
        var shift = false;
        var win = false;
        int? key = null;

        foreach (var token in input.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            switch (token.ToLowerInvariant())
            {
                case "ctrl":
                case "control":
                case "commandorcontrol":
                case "cmdorctrl":
                    ctrl = true;
                    continue;
                case "alt":
                    alt = true;
                    continue;
                case "shift":
                    shift = true;
                    continue;
                case "super":
                case "meta":
                case "win":
                case "windows":
                case "command":
                    win = true;
                    continue;
            }

            if (key.HasValue)
            {
                throw new InvalidOperationException($"Shortcut must contain exactly one non-modifier key: {input}");
            }

            key = ResolveKeyCode(token);
        }

        if (!key.HasValue)
        {
            throw new InvalidOperationException($"Shortcut must include one non-modifier key: {input}");
        }

        return new HotkeyDefinition(ctrl, alt, shift, win, key.Value);
    }

    private static int ResolveKeyCode(string token)
    {
        var trimmed = token.Trim();
        if (trimmed.Length == 1)
        {
            var ch = char.ToUpperInvariant(trimmed[0]);
            if ((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9'))
            {
                return ch;
            }
        }

        var normalized = trimmed.ToUpperInvariant();
        if (normalized.Length > 1 && normalized[0] == 'F' && int.TryParse(normalized[1..], out var fnNumber) && fnNumber is >= 1 and <= 24)
        {
            return 0x6F + fnNumber;
        }

        return normalized switch
        {
            "SPACE" => 0x20,
            "TAB" => 0x09,
            "ENTER" or "RETURN" => 0x0D,
            "ESC" or "ESCAPE" => 0x1B,
            "BACKSPACE" => 0x08,
            "DELETE" or "DEL" => 0x2E,
            "INSERT" or "INS" => 0x2D,
            "HOME" => 0x24,
            "END" => 0x23,
            "PAGEUP" or "PGUP" => 0x21,
            "PAGEDOWN" or "PGDN" => 0x22,
            "UP" => 0x26,
            "DOWN" => 0x28,
            "LEFT" => 0x25,
            "RIGHT" => 0x27,
            _ => throw new InvalidOperationException($"Unsupported shortcut key token: {token}")
        };
    }
}

internal static class KeyboardHookBridge
{
    private const int WhKeyboardLl = 13;
    private const int WmKeyDown = 0x0100;
    private const int WmKeyUp = 0x0101;
    private const int WmSysKeyDown = 0x0104;
    private const int WmSysKeyUp = 0x0105;

    private const int VkControl = 0x11;
    private const int VkLControl = 0xA2;
    private const int VkRControl = 0xA3;
    private const int VkMenu = 0x12;
    private const int VkLMenu = 0xA4;
    private const int VkRMenu = 0xA5;
    private const int VkShift = 0x10;
    private const int VkLShift = 0xA0;
    private const int VkRShift = 0xA1;
    private const int VkLWin = 0x5B;
    private const int VkRWin = 0x5C;
    private const int VkEscape = 0x1B;

    private const long CancelStateMaxAgeMs = 5000;
    private const ushort VkNoName = 0xFC;
    private const uint KeyeventfKeyup = 0x0002;

    [DllImport("user32.dll")]
    private static extern void keybd_event(ushort bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    private static IntPtr _hookId = IntPtr.Zero;
    private static HookProc? _proc;
    private static IReadOnlyList<HotkeyRegistration> _registrations = Array.Empty<HotkeyRegistration>();
    private static bool[] _active = [];
    private static bool _escapeIsDown;
    private static string _cancelStatePath = "";
    private static volatile bool _cancelAllowed;
    private static readonly HashSet<int> _swallowNextKeyUp = [];
    private static Thread? _cancelStateThread;

    public static int Run(IReadOnlyList<HotkeyRegistration> registrations, string cancelStatePath = "")
    {
        if (registrations.Count == 0)
        {
            Console.Error.WriteLine("No hotkeys were provided.");
            return 1;
        }

        _cancelStatePath = (cancelStatePath ?? "").Trim();
        StartCancelStateWatcher();
        _registrations = registrations;
        _active = new bool[registrations.Count];
        _proc = HookCallback;
        _hookId = SetHook(_proc);

        if (_hookId == IntPtr.Zero)
        {
            Console.Error.WriteLine("Failed to install keyboard hook.");
            return Marshal.GetLastWin32Error();
        }

        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            PostQuitMessage(0);
        };
        AppDomain.CurrentDomain.ProcessExit += (_, _) => Unhook();

        while (GetMessage(out _, IntPtr.Zero, 0, 0) > 0)
        {
        }

        Unhook();
        return 0;
    }

    private static IntPtr SetHook(HookProc proc)
    {
        using var currentProcess = Process.GetCurrentProcess();
        using var currentModule = currentProcess.MainModule;
        return SetWindowsHookEx(WhKeyboardLl, proc, GetModuleHandle(currentModule?.ModuleName), 0);
    }

    private static void Unhook()
    {
        if (_hookId == IntPtr.Zero)
        {
            return;
        }

        UnhookWindowsHookEx(_hookId);
        _hookId = IntPtr.Zero;
    }

    private static bool IsDown(int vkCode) => (GetAsyncKeyState(vkCode) & 0x8000) != 0;

    private static bool IsCtrlKey(int vkCode) => vkCode is VkControl or VkLControl or VkRControl;
    private static bool IsAltKey(int vkCode) => vkCode is VkMenu or VkLMenu or VkRMenu;
    private static bool IsShiftKey(int vkCode) => vkCode is VkShift or VkLShift or VkRShift;
    private static bool IsWinKey(int vkCode) => vkCode is VkLWin or VkRWin;

    private static bool IsRelevantKey(HotkeyDefinition definition, int vkCode)
    {
        return vkCode == definition.Key
            || (definition.Ctrl && IsCtrlKey(vkCode))
            || (definition.Alt && IsAltKey(vkCode))
            || (definition.Shift && IsShiftKey(vkCode))
            || (definition.Win && IsWinKey(vkCode));
    }

    private static bool ComboActiveForEvent(HotkeyDefinition definition, int vkCode, bool isKeyDown)
    {
        var ctrlDown = IsDown(VkControl) || IsDown(VkLControl) || IsDown(VkRControl);
        var altDown = IsDown(VkMenu) || IsDown(VkLMenu) || IsDown(VkRMenu);
        var shiftDown = IsDown(VkShift) || IsDown(VkLShift) || IsDown(VkRShift);
        var winDown = IsDown(VkLWin) || IsDown(VkRWin);
        var keyDown = IsDown(definition.Key);

        if (IsCtrlKey(vkCode))
        {
            ctrlDown = isKeyDown;
        }
        if (IsAltKey(vkCode))
        {
            altDown = isKeyDown;
        }
        if (IsShiftKey(vkCode))
        {
            shiftDown = isKeyDown;
        }
        if (IsWinKey(vkCode))
        {
            winDown = isKeyDown;
        }
        if (vkCode == definition.Key)
        {
            keyDown = isKeyDown;
        }

        // Modifiers must match exactly. Testing only that required modifiers are
        // down makes a shortcut fire for any superset of itself, so pressing
        // Ctrl+Shift+Space also triggered a Ctrl+Space registration. Matches
        // eventMatches() in macos-hotkey-hook.swift.
        return keyDown
            && definition.Ctrl == ctrlDown
            && definition.Alt == altDown
            && definition.Shift == shiftDown
            && definition.Win == winDown;
    }

    /// <summary>
    /// Windows toggles the keyboard layout when Ctrl+Shift is pressed and released
    /// with no key in between. Swallowing the combo key hides it from the system as
    /// well as the target app, so a Ctrl+Shift+&lt;key&gt; shortcut looks like a bare
    /// Ctrl+Shift chord and flips the layout. Injecting an unassigned key counts as
    /// an intervening keystroke without producing input of its own.
    /// </summary>
    private static void BreakModifierChord()
    {
        var ctrlDown = IsDown(VkControl) || IsDown(VkLControl) || IsDown(VkRControl);
        var shiftDown = IsDown(VkShift) || IsDown(VkLShift) || IsDown(VkRShift);
        if (!ctrlDown || !shiftDown)
        {
            return;
        }

        keybd_event(VkNoName, 0, 0, UIntPtr.Zero);
        keybd_event(VkNoName, 0, KeyeventfKeyup, UIntPtr.Zero);
    }

    /// <summary>
    /// Ends every active combo as if the key had been released: the tray still needs
    /// its up event, and the physical release has to stay swallowed so it does not
    /// leak into the focused app (an Alt+Space release would reopen the system menu).
    /// </summary>
    private static void DeactivateAllCombos()
    {
        for (var index = 0; index < _registrations.Count; index++)
        {
            if (!_active[index])
            {
                continue;
            }

            _active[index] = false;
            _swallowNextKeyUp.Add(_registrations[index].Definition.Key);
            Console.Out.WriteLine(_registrations[index].UpEvent);
        }

        Console.Out.Flush();
    }

    private static bool AnyComboActive()
    {
        foreach (var active in _active)
        {
            if (active)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Polls the overlay state off the hook thread. A WH_KEYBOARD_LL callback that
    /// exceeds LowLevelHooksTimeout (300ms by default) has its result discarded and
    /// can be removed by Windows outright, so the callback must never touch the
    /// filesystem: it reads the cached flag instead.
    /// </summary>
    private static void StartCancelStateWatcher()
    {
        if (_cancelStatePath.Length == 0 || _cancelStateThread is not null)
        {
            return;
        }

        _cancelStateThread = new Thread(() =>
        {
            while (true)
            {
                _cancelAllowed = ReadCancelState();
                Thread.Sleep(100);
            }
        })
        {
            IsBackground = true,
            Name = "dictray-cancel-state"
        };
        _cancelStateThread.Start();
    }

    /// <summary>
    /// Escape only cancels while a dictation turn is on screen, so the hook does
    /// not swallow Escape system-wide. Mirrors overlayStateAllowsCancel() in
    /// macos-hotkey-hook.swift.
    /// </summary>
    private static bool ReadCancelState()
    {
        if (_cancelStatePath.Length == 0)
        {
            return false;
        }

        try
        {
            using var stream = new FileStream(_cancelStatePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var document = JsonDocument.Parse(stream);
            var root = document.RootElement;
            if (!root.TryGetProperty("visible", out var visible) || visible.ValueKind != JsonValueKind.True)
            {
                return false;
            }

            if (!root.TryGetProperty("phase", out var phase) || phase.ValueKind != JsonValueKind.String)
            {
                return false;
            }

            // A wedged tray would otherwise leave a stale "transcribing" payload on
            // disk and make Escape a system-wide black hole.
            if (root.TryGetProperty("updatedAt", out var updatedAt)
                && updatedAt.ValueKind == JsonValueKind.Number
                && updatedAt.TryGetInt64(out var updatedAtMs))
            {
                var ageMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - updatedAtMs;
                if (ageMs > CancelStateMaxAgeMs)
                {
                    return false;
                }
            }

            return (phase.GetString() ?? "").Trim().ToLowerInvariant() switch
            {
                "listening" or "processing" or "transcribing" or "rewriting" or "inserting" or "pending_insert" => true,
                _ => false
            };
        }
        catch
        {
            return false;
        }
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var message = wParam.ToInt32();
            var isKeyDown = message == WmKeyDown || message == WmSysKeyDown;
            var isKeyUp = message == WmKeyUp || message == WmSysKeyUp;

            if (isKeyDown || isKeyUp)
            {
                var data = Marshal.PtrToStructure<KbdLlHookStruct>(lParam);
                var vkCode = unchecked((int)data.vkCode);

                if (vkCode == VkEscape)
                {
                    if (isKeyDown)
                    {
                        if (!_escapeIsDown && (AnyComboActive() || _cancelAllowed))
                        {
                            _escapeIsDown = true;
                            DeactivateAllCombos();
                            Console.Out.WriteLine("cancel");
                            Console.Out.Flush();
                            return (IntPtr)1;
                        }

                        // Never leave the latch set for an Escape that was passed
                        // through, or the following press would be swallowed too.
                        _escapeIsDown = false;
                    }

                    if (isKeyUp && _escapeIsDown)
                    {
                        _escapeIsDown = false;
                        return (IntPtr)1;
                    }
                }

                var swallow = false;
                var breakChord = false;

                if (isKeyUp && _swallowNextKeyUp.Remove(vkCode))
                {
                    return (IntPtr)1;
                }

                for (var index = 0; index < _registrations.Count; index++)
                {
                    var registration = _registrations[index];
                    if (!IsRelevantKey(registration.Definition, vkCode))
                    {
                        continue;
                    }

                    var wasActive = _active[index];
                    var nextActive = ComboActiveForEvent(registration.Definition, vkCode, isKeyDown);
                    if (nextActive && !wasActive)
                    {
                        _active[index] = true;
                        Console.Out.WriteLine(registration.DownEvent);
                        Console.Out.Flush();
                    }
                    else if (!nextActive && wasActive)
                    {
                        _active[index] = false;
                        Console.Out.WriteLine(registration.UpEvent);
                        Console.Out.Flush();
                    }

                    // Swallow both the active combo events and the final release event that ends the combo.
                    // This prevents hotkeys like Alt+Space from leaking a trailing system-menu keyup into
                    // the target app when dictation later restores focus and pastes text.
                    //
                    // Only the combo's own key is swallowed. Swallowing a modifier release instead left
                    // that modifier latched in the target app: releasing Ctrl before Space ends the combo
                    // on the Ctrl keyup, and eating that keyup means the app never sees Ctrl come back up.
                    if ((nextActive || wasActive) && vkCode == registration.Definition.Key)
                    {
                        swallow = true;
                        if (nextActive && !wasActive)
                        {
                            // Only on the activating press: auto-repeat would otherwise
                            // inject dozens of synthetic events per second while held.
                            breakChord = true;
                        }
                    }
                }

                if (swallow)
                {
                    if (breakChord)
                    {
                        BreakModifierChord();
                    }

                    return (IntPtr)1;
                }
            }
        }

        return CallNextHookEx(_hookId, nCode, wParam, lParam);
    }

    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KbdLlHookStruct
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetMessage(out Msg lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern void PostQuitMessage(int nExitCode);

    [StructLayout(LayoutKind.Sequential)]
    private struct Msg
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public Point pt;
        public uint lPrivate;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int x;
        public int y;
    }
}
