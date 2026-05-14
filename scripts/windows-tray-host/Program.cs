using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

if (args.Length < 2)
{
    return;
}

Application.EnableVisualStyles();
Application.SetCompatibleTextRenderingDefault(false);
Application.Run(new TrayHostContext(
    statePath: args[0],
    commandPath: args[1],
    iconPath: args.Length > 2 ? args[2] : ""));

internal sealed class TrayHostContext : ApplicationContext
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private readonly string _statePath;
    private readonly string _commandPath;
    private readonly NotifyIcon _notifyIcon;
    private readonly ContextMenuStrip _contextMenuTrigger;
    private readonly NativeMenuWindow _menuWindow = new();
    private readonly System.Windows.Forms.Timer _timer;
    private string _lastStateJson = "";
    private TrayState? _state;
    private bool _disposed;

    public TrayHostContext(string statePath, string commandPath, string iconPath)
    {
        _statePath = Path.GetFullPath(statePath);
        _commandPath = Path.GetFullPath(commandPath);
        Directory.CreateDirectory(Path.GetDirectoryName(_statePath) ?? ".");
        Directory.CreateDirectory(Path.GetDirectoryName(_commandPath) ?? ".");

        _contextMenuTrigger = new ContextMenuStrip();
        _contextMenuTrigger.Opening += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            ShowNativeMenu();
        };

        _notifyIcon = new NotifyIcon
        {
            Icon = LoadIcon(iconPath),
            Text = "DicTray",
            Visible = true,
            ContextMenuStrip = _contextMenuTrigger
        };
        _notifyIcon.MouseUp += OnTrayMouseUp;

        _timer = new System.Windows.Forms.Timer
        {
            Interval = 500
        };
        _timer.Tick += (_, _) => RefreshFromState();
        _timer.Start();

        RefreshFromState();
    }

    private static Icon LoadIcon(string iconPath)
    {
        try
        {
            if (!string.IsNullOrWhiteSpace(iconPath) && File.Exists(iconPath))
            {
                return new Icon(iconPath);
            }
        }
        catch
        {
            // Fall through to the built-in icon.
        }

        return SystemIcons.Application;
    }

    private void OnTrayMouseUp(object? sender, MouseEventArgs eventArgs)
    {
        if (eventArgs.Button == MouseButtons.Left)
        {
            ShowNativeMenu();
        }
    }

    private void ShowNativeMenu()
    {
        RefreshFromState();
        if (_state?.Menu is not { Count: > 0 })
        {
            return;
        }

        var commandJson = NativeTrayMenu.Show(_state.Menu, Cursor.Position, _menuWindow.Handle);
        if (!string.IsNullOrWhiteSpace(commandJson))
        {
            WriteCommand(commandJson);
        }
    }

    private void RefreshFromState()
    {
        if (_disposed)
        {
            return;
        }

        string stateJson;
        try
        {
            stateJson = File.ReadAllText(_statePath, Encoding.UTF8);
        }
        catch
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(stateJson) || stateJson == _lastStateJson)
        {
            return;
        }

        TrayState? state;
        try
        {
            state = JsonSerializer.Deserialize<TrayState>(stateJson, JsonOptions);
        }
        catch
        {
            return;
        }

        if (state is null)
        {
            return;
        }

        _lastStateJson = stateJson;
        _state = state;

        if (state.Quit)
        {
            ExitThread();
            return;
        }

        _notifyIcon.Text = TrimNotifyText(BuildTooltip(state));
    }

    private static string BuildTooltip(TrayState state)
    {
        var phase = string.IsNullOrWhiteSpace(state.PhaseLabel)
            ? state.Phase
            : state.PhaseLabel;
        return $"DicTray - {(string.IsNullOrWhiteSpace(phase) ? "idle" : phase)}";
    }

    private static string TrimNotifyText(string value)
    {
        var text = string.IsNullOrWhiteSpace(value) ? "DicTray" : value.Trim();
        return text.Length <= 63 ? text : text[..60] + "...";
    }

    private void WriteCommand(string commandJson)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_commandPath) ?? ".");
            File.WriteAllText(_commandPath, commandJson, new UTF8Encoding(false));
        }
        catch
        {
            // A missed click should not crash the tray helper.
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (_disposed)
        {
            base.Dispose(disposing);
            return;
        }

        _disposed = true;
        if (disposing)
        {
            _timer.Stop();
            _timer.Dispose();
            _contextMenuTrigger.Dispose();
            _notifyIcon.Visible = false;
            _notifyIcon.Dispose();
            _menuWindow.DestroyHandle();
        }

        base.Dispose(disposing);
    }
}

internal sealed class NativeMenuWindow : NativeWindow
{
    public NativeMenuWindow()
    {
        CreateHandle(new CreateParams
        {
            Caption = "DicTrayMenuWindow"
        });
    }
}

internal static class NativeTrayMenu
{
    private const uint MfString = 0x0000;
    private const uint MfGrayed = 0x0001;
    private const uint MfChecked = 0x0008;
    private const uint MfPopup = 0x0010;
    private const uint MfSeparator = 0x0800;
    private const uint TpmRightButton = 0x0002;
    private const uint TpmReturnCmd = 0x0100;
    private const int WmNull = 0x0000;

    public static string Show(IReadOnlyList<MenuPayload> items, Point location, IntPtr ownerWindow)
    {
        var commands = new Dictionary<int, string>();
        var nextId = 1000;
        var menu = CreatePopupMenu();
        if (menu == IntPtr.Zero)
        {
            return "";
        }

        try
        {
            AppendItems(menu, items, commands, ref nextId);
            SetForegroundWindow(ownerWindow);
            var selectedId = TrackPopupMenuEx(
                menu,
                TpmRightButton | TpmReturnCmd,
                location.X,
                location.Y,
                ownerWindow,
                IntPtr.Zero);
            PostMessage(ownerWindow, WmNull, IntPtr.Zero, IntPtr.Zero);
            return selectedId != 0 && commands.TryGetValue(unchecked((int)selectedId), out var commandJson)
                ? commandJson
                : "";
        }
        finally
        {
            DestroyMenu(menu);
        }
    }

    private static void AppendItems(
        IntPtr menu,
        IReadOnlyList<MenuPayload> items,
        Dictionary<int, string> commands,
        ref int nextId)
    {
        foreach (var item in items)
        {
            if (IsSeparator(item))
            {
                AppendMenu(menu, MfSeparator, UIntPtr.Zero, null);
                continue;
            }

            var submenuItems = item.Submenu;
            if (submenuItems is { Count: > 0 })
            {
                var submenu = CreatePopupMenu();
                AppendItems(submenu, submenuItems, commands, ref nextId);
                var submenuFlags = MfPopup | EnabledFlag(item, true) | CheckedFlag(item);
                AppendMenu(menu, submenuFlags, (UIntPtr)submenu, MenuLabel(item.Label));
                continue;
            }

            var commandJson = CommandJson(item.Command);
            var hasCommand = !string.IsNullOrWhiteSpace(commandJson);
            var id = hasCommand ? nextId++ : 0;
            if (hasCommand)
            {
                commands[id] = commandJson;
            }

            var flags = MfString | EnabledFlag(item, hasCommand) | CheckedFlag(item);
            AppendMenu(menu, flags, (UIntPtr)id, MenuLabel(item.Label));
        }
    }

    private static uint EnabledFlag(MenuPayload item, bool defaultEnabled)
    {
        return (item.Enabled ?? defaultEnabled) ? 0 : MfGrayed;
    }

    private static uint CheckedFlag(MenuPayload item)
    {
        return item.Checked == true ? MfChecked : 0;
    }

    private static bool IsSeparator(MenuPayload item)
    {
        return string.Equals(item.Type?.Trim(), "separator", StringComparison.OrdinalIgnoreCase);
    }

    private static string MenuLabel(string value)
    {
        var label = string.IsNullOrWhiteSpace(value) ? " " : value.Trim();
        return label.Replace("&", "&&");
    }

    private static string CommandJson(JsonElement? command)
    {
        if (!command.HasValue)
        {
            return "";
        }

        var value = command.Value;
        return value.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null
            ? ""
            : value.GetRawText();
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr CreatePopupMenu();

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool AppendMenu(IntPtr hMenu, uint uFlags, UIntPtr uIdNewItem, string? lpNewItem);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyMenu(IntPtr hMenu);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint TrackPopupMenuEx(IntPtr hMenu, uint uFlags, int x, int y, IntPtr hwnd, IntPtr lptpm);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
}

internal sealed class TrayState
{
    public string Phase { get; set; } = "idle";
    public string PhaseLabel { get; set; } = "idle";
    public bool Dictating { get; set; }
    public bool Quit { get; set; }
    public List<MenuPayload>? Menu { get; set; }
}

internal sealed class MenuPayload
{
    public string Label { get; set; } = "";
    public string Type { get; set; } = "";
    public bool? Enabled { get; set; }
    public bool? Checked { get; set; }
    public JsonElement? Command { get; set; }
    public List<MenuPayload>? Submenu { get; set; }
}
