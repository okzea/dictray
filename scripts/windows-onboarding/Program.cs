using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

// The DicTray Quick Start window on Windows. The tray core writes the onboarding
// payload to a JSON state file and reads the finished choices back from a command
// file, the same file bridge the macOS Quick Start helper uses.
try
{
    if (args.Contains("--self-test"))
    {
        Console.WriteLine("{\"ok\":true,\"script\":\"windows-onboarding\"}");
        return 0;
    }

    var statePath = args.Length > 0 ? args[0] : "";
    var commandPath = args.Length > 1 ? args[1] : "";
    if (string.IsNullOrWhiteSpace(statePath) || string.IsNullOrWhiteSpace(commandPath))
    {
        Console.Error.WriteLine("Usage: WindowsOnboarding <state-path> <command-path> [icon-path]");
        return 1;
    }

    Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    Application.Run(new QuickStartForm(statePath, commandPath, args.Length > 2 ? args[2] : ""));
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error.Message);
    return 1;
}

internal sealed class HotkeyPreset
{
    public string? Value { get; set; }
    public string? Label { get; set; }
}

internal sealed class ProfileState
{
    public string? Name { get; set; }
}

internal sealed class ChoiceState
{
    public bool? RewriteCleanup { get; set; }
    public string? SpeechEffort { get; set; }
    public string? PushToTalkHotkey { get; set; }
    public string? SttPromptContext { get; set; }
}

internal sealed class BenchmarkState
{
    public double? ElapsedMs { get; set; }
}

internal sealed class OnboardingState
{
    public string? SeenAt { get; set; }
    public string? CompletedAt { get; set; }
    public ProfileState? Profile { get; set; }
    public ChoiceState? Choices { get; set; }
    public BenchmarkState? TypingBenchmark { get; set; }
}

internal sealed class LanguageOption
{
    public string? Code { get; set; }
    public string? Label { get; set; }
}

internal sealed class RuntimeState
{
    public string? RewriteProvider { get; set; }
    public string? SpeechEffort { get; set; }
    public string? SttPromptContext { get; set; }
    public List<string>? SttLanguages { get; set; }
    public List<LanguageOption>? SttLanguageOptions { get; set; }
    public string? Hotkey { get; set; }
    public bool? HotkeyManagedByEnv { get; set; }
    public List<HotkeyPreset>? HotkeyPresets { get; set; }
}

internal sealed class UiState
{
    public bool? Pending { get; set; }
    public string? Error { get; set; }
}

internal sealed class StatePayload
{
    public string? SampleText { get; set; }
    public OnboardingState? State { get; set; }
    public RuntimeState? Runtime { get; set; }
    public UiState? Ui { get; set; }
    public bool? Quit { get; set; }
}

internal sealed record ResolvedHotkeyPreset(string Value, string Label);

internal sealed record BenchmarkStats(
    string SampleText,
    int ElapsedMs,
    int CharactersPerMinute,
    double WordsPerMinute,
    string MeasuredAt);

internal static class QuickStartText
{
    public const double LargeStudyAverageWpm = 52.0;
    // Above the fastest recorded sustained typing; anything quicker was pasted.
    public const double MaxPlausibleWpm = 250.0;

    public static readonly ResolvedHotkeyPreset[] FallbackHotkeyPresets =
    [
        new("CommandOrControl+Space", "Ctrl+Space"),
        new("Alt+Space", "Alt+Space"),
        new("CommandOrControl+Alt+F12", "Ctrl+Alt+F12"),
        new("CommandOrControl+Alt+F13", "Ctrl+Alt+F13"),
        new("CommandOrControl+Alt+O", "Ctrl+Alt+O")
    ];

    private static readonly string[] TypingScoreBands =
    [
        "Careful typer: under 30",
        "Casual: 30-39",
        "Office-ready: 40-51",
        "Above average: 52-69",
        "Fast: 70-89",
        "Very fast: 90+"
    ];

    public static string CompactSpaces(string? value)
    {
        return string.Join(' ', (value ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
    }

    public static string NormalizeTypedText(string? value)
    {
        return CompactSpaces(value)
            .Replace('’', '\'')
            .Replace('‘', '\'')
            .Replace('ʼ', '\'')
            .ToLowerInvariant();
    }

    public static string TypingScoreLabel(double wpm)
    {
        var value = Math.Max(0, wpm);
        if (value < 30)
        {
            return "Careful typer";
        }
        if (value < 40)
        {
            return "Casual";
        }
        if (value < LargeStudyAverageWpm)
        {
            return "Office-ready";
        }
        if (value < 70)
        {
            return "Above average";
        }
        return value < 90 ? "Fast" : "Very fast";
    }

    public static string TypingPlacementLine(double wpm)
    {
        var roundedWpm = Math.Max(0, (int)Math.Round(wpm, MidpointRounding.AwayFromZero));
        var averageWpm = (int)LargeStudyAverageWpm;
        var comparison = roundedWpm > averageWpm
            ? "above"
            : roundedWpm == averageWpm ? "matches" : "below";
        return $"{roundedWpm} WPM (words per minute) • {comparison} the large-study average of {averageWpm}.";
    }

    public static string TypingScoreTooltip(string currentScore = "")
    {
        var lines = new List<string>();
        if (!string.IsNullOrEmpty(currentScore))
        {
            lines.Add($"You are here: {currentScore}");
            lines.Add("");
        }
        lines.Add("Typing ladder");
        lines.Add("WPM = words per minute");
        lines.Add("");
        lines.AddRange(TypingScoreBands);
        return string.Join(Environment.NewLine, lines);
    }

    public static string NormalizeProfileName(string? value)
    {
        var normalized = CompactSpaces(value);
        return normalized.Length <= 40 ? normalized : normalized[..40];
    }

    public static string NormalizeSttPromptContext(string? value)
    {
        var normalized = string.Join('\n', (value ?? "")
            .Replace("\r\n", "\n")
            .Replace('\r', '\n')
            .Split('\n')
            .Select(CompactSpaces)
            .Where(line => line.Length > 0));
        return normalized.Length <= 1200 ? normalized : normalized[..1200].Trim();
    }

    public static string NormalizeSpeechEffort(string? value)
    {
        switch (CompactSpaces(value).ToLowerInvariant())
        {
            case "low":
            case "fast":
            case "faster":
                return "low";
            case "high":
            case "quality":
                return "high";
            case "mid":
            case "middle":
            case "medium":
            case "balanced":
                return "mid";
            default:
                return "";
        }
    }

    public static string SpeechEffortLabel(string value)
    {
        return NormalizeSpeechEffort(value) switch
        {
            "low" => "Low (Faster)",
            "high" => "High (Quality)",
            _ => "Mid (Balanced)"
        };
    }
}

internal sealed class QuickStartForm : Form
{
    private static readonly JsonSerializerOptions ReadOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    private static readonly JsonSerializerOptions WriteOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private static readonly Color SidebarColor = Color.FromArgb(243, 243, 243);
    private static readonly Color SampleBoxColor = Color.FromArgb(246, 246, 246);
    private static readonly Color BorderColor = Color.FromArgb(220, 220, 220);
    private static readonly Color AccentColor = Color.FromArgb(0, 95, 184);
    private static readonly Color SuccessColor = Color.FromArgb(16, 124, 16);
    private static readonly Color ErrorColor = Color.FromArgb(196, 43, 28);
    private static readonly Color SecondaryColor = Color.FromArgb(96, 96, 96);

    private readonly string _statePath;
    private readonly string _commandPath;
    private readonly string _iconPath;
    private readonly System.Windows.Forms.Timer _pollTimer = new() { Interval = 280 };
    private readonly System.Windows.Forms.Timer _benchmarkTimer = new() { Interval = 250 };
    private readonly System.Windows.Forms.Timer _closeTimer = new() { Interval = 900 };
    private readonly ToolTip _toolTip = new() { AutoPopDelay = 15000, InitialDelay = 300 };

    private StatePayload _latestPayload = new();
    private string _lastRawState = "";
    private bool _hydrated;
    private bool _hydrating;
    private bool _submitted;
    private string _initialCompletedAt = "";
    private DateTime? _benchmarkStartedAt;
    private int _benchmarkElapsedMs;
    private ResolvedHotkeyPreset[] _hotkeyPresets = QuickStartText.FallbackHotkeyPresets;
    private readonly List<(string Code, string Label, CheckBox Box)> _languageCheckboxes = [];

    private readonly TextBox _nameField = new();
    private readonly Label _sampleLabel;
    private readonly TextBox _typingBox = new();
    private readonly TextBox _sttContextBox = new();
    private readonly Label _benchmarkSummaryLabel;
    private readonly Label _benchmarkHintLabel;
    private readonly Button _benchmarkInfoButton = new();
    private readonly Button _resetBenchmarkButton = new();
    private readonly CheckBox _rewriteCheckbox = new();
    private readonly RadioButton _effortLow = new();
    private readonly RadioButton _effortMid = new();
    private readonly RadioButton _effortHigh = new();
    private readonly FlowLayoutPanel _languagePanel = new();
    private readonly ComboBox _hotkeyCombo = new();
    private readonly Label _hotkeyHintLabel;
    private readonly Label _runtimeLabel;
    private readonly Label _summaryLabel;
    private readonly Label _statusLabel;
    private readonly Button _finishButton = new();

    public QuickStartForm(string statePath, string commandPath, string iconPath)
    {
        _statePath = Path.GetFullPath(statePath);
        _commandPath = Path.GetFullPath(commandPath);
        _iconPath = iconPath;

        _sampleLabel = MakeLabel("", 12f, FontStyle.Bold);
        _benchmarkSummaryLabel = MakeLabel("", 9.75f, color: SecondaryColor);
        _benchmarkHintLabel = MakeLabel("", 9f, color: SecondaryColor);
        _hotkeyHintLabel = MakeLabel("", 9f, color: SecondaryColor);
        _runtimeLabel = MakeLabel("", 9.75f, color: SecondaryColor);
        _summaryLabel = MakeLabel("", 9.75f, color: SecondaryColor);
        _statusLabel = MakeLabel("Complete setup, then finish Quick Start.", 9.75f, color: SecondaryColor);

        SuspendLayout();
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Segoe UI", 9.75f);
        BackColor = Color.White;
        Text = "DicTray Quick Start";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(920, 680);
        MinimumSize = new Size(820, 560);
        Icon = LoadIcon();

        BuildLayout();
        ResumeLayout(false);
        PerformLayout();

        _pollTimer.Tick += (_, _) => RefreshState(force: false);
        _benchmarkTimer.Tick += (_, _) => UpdateBenchmarkSummary();
        _closeTimer.Tick += (_, _) =>
        {
            _closeTimer.Stop();
            Close();
        };
    }

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        RefreshState(force: true);
        _pollTimer.Start();
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        BringWindowForward();
        _nameField.Focus();
        WatchParentProcess();
    }

    private void BringWindowForward()
    {
        if (WindowState == FormWindowState.Minimized)
        {
            WindowState = FormWindowState.Normal;
        }
        BringToFront();
        // The helper is spawned by the tray core, which does not own the
        // foreground, so Windows would otherwise open the window behind others.
        TopMost = true;
        TopMost = false;
        Activate();
        NativeMethods.SetForegroundWindow(Handle);
    }

    /// <summary>
    /// The tray keeps standard input open: a "focus" line asks this window to come
    /// forward again when Quick Start is reopened, and EOF means the tray died
    /// without writing a quit payload, which Windows would not reap us for.
    /// </summary>
    private void WatchParentProcess()
    {
        var thread = new Thread(() =>
        {
            try
            {
                using var reader = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
                string? line;
                while ((line = reader.ReadLine()) is not null)
                {
                    if (line.Trim() == "focus")
                    {
                        BeginInvoke(BringWindowForward);
                    }
                }
            }
            catch
            {
                // treat a broken pipe as parent death
            }

            try
            {
                BeginInvoke(Close);
            }
            catch (InvalidOperationException)
            {
                // the window is already gone
            }
        })
        {
            IsBackground = true,
            Name = "parent-watch"
        };
        thread.Start();
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _pollTimer.Stop();
        _benchmarkTimer.Stop();
        _closeTimer.Stop();
        base.OnFormClosed(e);
    }

    private Icon LoadIcon()
    {
        try
        {
            if (!string.IsNullOrWhiteSpace(_iconPath) && File.Exists(_iconPath))
            {
                return new Icon(_iconPath);
            }
        }
        catch
        {
            // Fall through to the built-in icon.
        }
        return SystemIcons.Application;
    }

    private Image? LoadLogo(int size)
    {
        try
        {
            if (!string.IsNullOrWhiteSpace(_iconPath) && File.Exists(_iconPath))
            {
                using var icon = new Icon(_iconPath, size, size);
                return icon.ToBitmap();
            }
        }
        catch
        {
            // The sidebar works without a logo.
        }
        return null;
    }

    private static Label MakeLabel(string text, float size, FontStyle style = FontStyle.Regular, Color? color = null)
    {
        return new Label
        {
            Text = text,
            AutoSize = true,
            Anchor = AnchorStyles.Left | AnchorStyles.Right,
            Font = new Font(style == FontStyle.Bold ? "Segoe UI Semibold" : "Segoe UI", size),
            ForeColor = color ?? Color.FromArgb(28, 28, 28),
            Margin = new Padding(0, 0, 0, 6),
            UseMnemonic = false
        };
    }

    private static TableLayoutPanel MakeColumn()
    {
        var column = new TableLayoutPanel
        {
            ColumnCount = 1,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Anchor = AnchorStyles.Left | AnchorStyles.Right,
            Margin = Padding.Empty,
            Padding = Padding.Empty
        };
        column.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        return column;
    }

    private static void AddSection(TableLayoutPanel column, string title, string subtitle, params Control[] controls)
    {
        var heading = MakeLabel(title, 12.5f, FontStyle.Bold);
        heading.Margin = new Padding(0, column.Controls.Count == 0 ? 0 : 22, 0, 4);
        column.Controls.Add(heading);
        if (!string.IsNullOrWhiteSpace(subtitle))
        {
            column.Controls.Add(MakeLabel(subtitle, 9f, color: SecondaryColor));
        }
        foreach (var control in controls)
        {
            column.Controls.Add(control);
        }
    }

    private static TableLayoutPanel MakeRow(params (Control Control, SizeType SizeType)[] cells)
    {
        var row = new TableLayoutPanel
        {
            ColumnCount = cells.Length,
            RowCount = 1,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Anchor = AnchorStyles.Left | AnchorStyles.Right,
            Margin = new Padding(0, 0, 0, 6)
        };
        for (var index = 0; index < cells.Length; index += 1)
        {
            row.ColumnStyles.Add(cells[index].SizeType == SizeType.Percent
                ? new ColumnStyle(SizeType.Percent, 100F)
                : new ColumnStyle(SizeType.AutoSize));
            row.Controls.Add(cells[index].Control, index, 0);
        }
        return row;
    }

    private void BuildLayout()
    {
        var main = new Panel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(30, 26, 30, 16)
        };
        Controls.Add(main);
        Controls.Add(BuildSidebar());

        var mainLayout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 4
        };
        mainLayout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        mainLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        mainLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        mainLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
        mainLayout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        main.Controls.Add(mainLayout);

        var header = MakeColumn();
        header.Controls.Add(MakeLabel("Set up DicTray on Windows", 17f, FontStyle.Bold));
        header.Controls.Add(MakeLabel(
            "Measure your typing pace, choose speech-to-text behavior, and pick a push-to-talk shortcut.",
            9.75f,
            color: SecondaryColor));
        _runtimeLabel.Margin = new Padding(0, 0, 0, 12);
        header.Controls.Add(_runtimeLabel);
        mainLayout.Controls.Add(header, 0, 0);

        mainLayout.Controls.Add(new Panel
        {
            Height = 1,
            BackColor = BorderColor,
            Anchor = AnchorStyles.Left | AnchorStyles.Right,
            Margin = new Padding(0, 0, 0, 14)
        }, 0, 1);

        var scroll = new Panel
        {
            Dock = DockStyle.Fill,
            AutoScroll = true,
            Margin = Padding.Empty
        };
        var content = MakeColumn();
        content.Anchor = AnchorStyles.None;
        content.Dock = DockStyle.Top;
        content.Padding = new Padding(0, 0, 18, 12);
        scroll.Controls.Add(content);
        mainLayout.Controls.Add(scroll, 0, 2);

        BuildSections(content);
        mainLayout.Controls.Add(BuildFooter(), 0, 3);
    }

    private Control BuildSidebar()
    {
        var sidebar = new Panel
        {
            Dock = DockStyle.Left,
            Width = 204,
            BackColor = SidebarColor,
            Padding = new Padding(26, 34, 18, 24)
        };

        var stack = MakeColumn();
        stack.Anchor = AnchorStyles.None;
        stack.Dock = DockStyle.Top;
        sidebar.Controls.Add(stack);

        var brandText = MakeColumn();
        var appTitle = MakeLabel("DicTray", 17f, FontStyle.Bold);
        appTitle.Margin = Padding.Empty;
        var appSubtitle = MakeLabel("Quick Start", 9.75f, color: SecondaryColor);
        appSubtitle.Margin = Padding.Empty;
        brandText.Controls.Add(appTitle);
        brandText.Controls.Add(appSubtitle);

        var logo = LoadLogo(32);
        if (logo is not null)
        {
            var logoBox = new PictureBox
            {
                Image = logo,
                SizeMode = PictureBoxSizeMode.Zoom,
                Size = new Size(34, 34),
                Anchor = AnchorStyles.Left,
                Margin = new Padding(0, 0, 10, 0)
            };
            var brand = MakeRow((logoBox, SizeType.AutoSize), (brandText, SizeType.Percent));
            brand.Margin = new Padding(0, 0, 0, 26);
            stack.Controls.Add(brand);
        }
        else
        {
            brandText.Margin = new Padding(0, 0, 0, 26);
            stack.Controls.Add(brandText);
        }

        stack.Controls.Add(MakeSidebarItem("1", "Profile", "Name and greeting"));
        stack.Controls.Add(MakeSidebarItem("2", "Typing Pace", "Savings estimate"));
        stack.Controls.Add(MakeSidebarItem("3", "Dictation", "Model and cleanup"));
        stack.Controls.Add(MakeSidebarItem("4", "Shortcut", "Push to talk"));
        return sidebar;
    }

    private static Control MakeSidebarItem(string number, string title, string detail)
    {
        var index = MakeLabel(number, 9.75f, FontStyle.Bold, AccentColor);
        index.Anchor = AnchorStyles.Left | AnchorStyles.Top;
        index.Margin = new Padding(0, 1, 8, 0);

        var copy = MakeColumn();
        var titleLabel = MakeLabel(title, 9.75f, FontStyle.Bold);
        titleLabel.Margin = Padding.Empty;
        var detailLabel = MakeLabel(detail, 9f, color: SecondaryColor);
        detailLabel.Margin = Padding.Empty;
        copy.Controls.Add(titleLabel);
        copy.Controls.Add(detailLabel);

        var row = MakeRow((index, SizeType.AutoSize), (copy, SizeType.Percent));
        row.Margin = new Padding(0, 0, 0, 14);
        return row;
    }

    private void BuildSections(TableLayoutPanel content)
    {
        _nameField.PlaceholderText = "Avery";
        _nameField.Anchor = AnchorStyles.Left | AnchorStyles.Right;
        _nameField.MaxLength = 80;
        _nameField.Margin = new Padding(0, 2, 0, 6);
        _nameField.TextChanged += (_, _) => FormChanged();
        AddSection(content, "Profile", "Used for the tray greeting and daily savings summary.", _nameField);

        var sampleBox = MakeColumn();
        sampleBox.BackColor = SampleBoxColor;
        sampleBox.Padding = new Padding(12, 10, 12, 8);
        sampleBox.Margin = new Padding(0, 4, 0, 8);
        sampleBox.Paint += (_, eventArgs) =>
        {
            using var pen = new Pen(BorderColor);
            eventArgs.Graphics.DrawRectangle(pen, 0, 0, sampleBox.Width - 1, sampleBox.Height - 1);
        };
        var sampleCaption = MakeLabel("Type this exact phrase", 9f, FontStyle.Bold, SecondaryColor);
        sampleCaption.Margin = new Padding(0, 0, 0, 2);
        sampleCaption.BackColor = Color.Transparent;
        _sampleLabel.BackColor = Color.Transparent;
        _sampleLabel.Margin = Padding.Empty;
        sampleBox.Controls.Add(sampleCaption);
        sampleBox.Controls.Add(_sampleLabel);

        _benchmarkInfoButton.Text = "?";
        _benchmarkInfoButton.Size = new Size(30, 28);
        _benchmarkInfoButton.Anchor = AnchorStyles.Right;
        _benchmarkInfoButton.Margin = new Padding(8, 0, 8, 0);
        _benchmarkInfoButton.Click += (_, _) => ShowBenchmarkScoreHelp();
        _toolTip.SetToolTip(_benchmarkInfoButton, QuickStartText.TypingScoreTooltip());

        _resetBenchmarkButton.Text = "Restart";
        _resetBenchmarkButton.AutoSize = true;
        _resetBenchmarkButton.Anchor = AnchorStyles.Right;
        _resetBenchmarkButton.Margin = Padding.Empty;
        _resetBenchmarkButton.Click += (_, _) => ResetBenchmark();

        _benchmarkSummaryLabel.Margin = Padding.Empty;
        var benchmarkStatusRow = MakeRow(
            (_benchmarkSummaryLabel, SizeType.Percent),
            (_benchmarkInfoButton, SizeType.AutoSize),
            (_resetBenchmarkButton, SizeType.AutoSize));

        _typingBox.Multiline = true;
        _typingBox.ScrollBars = ScrollBars.Vertical;
        _typingBox.Font = new Font("Segoe UI", 11.25f);
        _typingBox.Height = 96;
        _typingBox.Anchor = AnchorStyles.Left | AnchorStyles.Right;
        _typingBox.Margin = new Padding(0, 0, 0, 6);
        _typingBox.TextChanged += (_, _) =>
        {
            if (!_hydrating)
            {
                UpdateBenchmarkSummary();
            }
        };

        AddSection(
            content,
            "Typing Pace",
            "Read the phrase once, then type it naturally. DicTray uses the timing to estimate saved keyboard time.",
            sampleBox,
            benchmarkStatusRow,
            _typingBox,
            _benchmarkHintLabel);

        var effortPanel = new FlowLayoutPanel
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            WrapContents = false,
            Anchor = AnchorStyles.Left,
            Margin = new Padding(0, 4, 0, 6)
        };
        foreach (var (button, label) in new[] { (_effortLow, "Faster"), (_effortMid, "Balanced"), (_effortHigh, "Quality") })
        {
            button.Text = label;
            button.Appearance = Appearance.Button;
            button.TextAlign = ContentAlignment.MiddleCenter;
            button.Size = new Size(116, 32);
            button.Margin = new Padding(0, 0, 2, 0);
            button.CheckedChanged += (_, _) => FormChanged();
            effortPanel.Controls.Add(button);
        }
        _effortMid.Checked = true;

        _languagePanel.AutoSize = true;
        _languagePanel.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        _languagePanel.WrapContents = true;
        _languagePanel.Anchor = AnchorStyles.Left | AnchorStyles.Right;
        _languagePanel.Margin = new Padding(0, 0, 0, 4);

        _sttContextBox.Multiline = true;
        _sttContextBox.AcceptsReturn = true;
        _sttContextBox.ScrollBars = ScrollBars.Vertical;
        _sttContextBox.Height = 84;
        _sttContextBox.Anchor = AnchorStyles.Left | AnchorStyles.Right;
        _sttContextBox.Margin = new Padding(0, 0, 0, 6);
        _sttContextBox.TextChanged += (_, _) => FormChanged();

        _rewriteCheckbox.Text = "Polish transcript text before inserting";
        _rewriteCheckbox.AutoSize = true;
        _rewriteCheckbox.Anchor = AnchorStyles.Left;
        _rewriteCheckbox.Margin = new Padding(0, 6, 0, 0);
        _rewriteCheckbox.CheckedChanged += (_, _) => FormChanged();

        var languageTitle = MakeLabel("Languages you dictate in", 9.75f, FontStyle.Bold);
        languageTitle.Margin = new Padding(0, 10, 0, 2);
        var contextTitle = MakeLabel("Speech context", 9.75f, FontStyle.Bold);
        contextTitle.Margin = new Padding(0, 10, 0, 4);

        AddSection(
            content,
            "Dictation",
            "Choose the speed/quality balance and whether transcripts should be cleaned up before insertion.",
            effortPanel,
            MakeLabel("Faster uses the tiny model, Balanced the base model, and Quality the small model.", 9f, color: SecondaryColor),
            languageTitle,
            _languagePanel,
            MakeLabel("With one language, DicTray always writes in it. With several, each dictation is written in the one you speak. English alone uses the fastest models.", 9f, color: SecondaryColor),
            contextTitle,
            _sttContextBox,
            MakeLabel("Add names, company terms, product words, and corrections. Example: Avery writes for Northstar Labs; LumaNote is one word.", 9f, color: SecondaryColor),
            _rewriteCheckbox);

        _hotkeyCombo.DropDownStyle = ComboBoxStyle.DropDownList;
        _hotkeyCombo.Width = 260;
        _hotkeyCombo.Anchor = AnchorStyles.Left;
        _hotkeyCombo.Margin = new Padding(0, 4, 0, 6);
        _hotkeyCombo.SelectedIndexChanged += (_, _) => FormChanged();
        AddSection(content, "Shortcut", "Hold this shortcut when you want DicTray to listen.", _hotkeyCombo, _hotkeyHintLabel);

        AddSection(content, "Summary", "", _summaryLabel);
    }

    private Control BuildFooter()
    {
        var skipButton = new Button
        {
            Text = "Not Now",
            AutoSize = true,
            MinimumSize = new Size(96, 32),
            Anchor = AnchorStyles.Right,
            Margin = new Padding(12, 0, 8, 0)
        };
        skipButton.Click += (_, _) => Close();
        CancelButton = skipButton;

        _finishButton.Text = "Finish Quick Start";
        _finishButton.AutoSize = true;
        _finishButton.MinimumSize = new Size(140, 32);
        _finishButton.Anchor = AnchorStyles.Right;
        _finishButton.Margin = Padding.Empty;
        _finishButton.Click += (_, _) => SendCompleteCommand();

        _statusLabel.Margin = Padding.Empty;
        var footer = MakeRow(
            (_statusLabel, SizeType.Percent),
            (skipButton, SizeType.AutoSize),
            (_finishButton, SizeType.AutoSize));
        footer.Margin = new Padding(0, 12, 0, 0);
        return footer;
    }

    private void FormChanged()
    {
        if (!_hydrating)
        {
            UpdateSummary();
        }
    }

    private void ShowBenchmarkScoreHelp()
    {
        var text = QuickStartText.TypingScoreTooltip(CurrentBenchmarkScore());
        _toolTip.SetToolTip(_benchmarkInfoButton, text);
        _toolTip.Show(text, _benchmarkInfoButton, 0, _benchmarkInfoButton.Height + 4, 10000);
    }

    private void ResetBenchmark()
    {
        _benchmarkTimer.Stop();
        _benchmarkStartedAt = null;
        _benchmarkElapsedMs = 0;
        _typingBox.Text = "";
        _typingBox.ForeColor = SystemColors.WindowText;
        UpdateBenchmarkSummary();
        _typingBox.Focus();
    }

    private ResolvedHotkeyPreset[] ResolvedPresets()
    {
        var resolved = (_latestPayload.Runtime?.HotkeyPresets ?? [])
            .Select(preset => new ResolvedHotkeyPreset(
                QuickStartText.CompactSpaces(preset.Value),
                QuickStartText.CompactSpaces(preset.Label ?? preset.Value)))
            .Where(preset => preset.Value.Length > 0 && preset.Label.Length > 0)
            .ToArray();
        return resolved.Length > 0 ? resolved : QuickStartText.FallbackHotkeyPresets;
    }

    private string SelectedSpeechEffort()
    {
        if (_effortLow.Checked)
        {
            return "low";
        }
        return _effortHigh.Checked ? "high" : "mid";
    }

    private string SelectedHotkeyValue()
    {
        var index = Math.Max(0, _hotkeyCombo.SelectedIndex);
        return index < _hotkeyPresets.Length
            ? _hotkeyPresets[index].Value
            : QuickStartText.FallbackHotkeyPresets[0].Value;
    }

    private string SampleText()
    {
        return QuickStartText.CompactSpaces(_latestPayload.SampleText);
    }

    private string SttContextText()
    {
        return QuickStartText.NormalizeSttPromptContext(_sttContextBox.Text);
    }

    private bool TypedTextMatchesSample()
    {
        return QuickStartText.NormalizeTypedText(_typingBox.Text) == QuickStartText.NormalizeTypedText(_latestPayload.SampleText);
    }

    private BenchmarkStats ComputeBenchmarkStats(int elapsedMs)
    {
        var sample = SampleText();
        var characters = new StringInfo(sample).LengthInTextElements;
        var words = sample.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
        var cpm = elapsedMs > 0
            ? Math.Max(0, (int)Math.Round(characters / (double)elapsedMs * 60000.0, MidpointRounding.AwayFromZero))
            : 0;
        var wpmRaw = elapsedMs > 0 ? words / (double)elapsedMs * 60000.0 : 0;
        var wpm = Math.Max(0, Math.Round(wpmRaw * 10.0, MidpointRounding.AwayFromZero) / 10.0);
        return new BenchmarkStats(
            sample,
            elapsedMs,
            cpm,
            wpm,
            elapsedMs > 0 ? DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture) : "");
    }

    private string CurrentBenchmarkScore()
    {
        if (_benchmarkElapsedMs <= 0 || !TypedTextMatchesSample())
        {
            return "";
        }
        return QuickStartText.TypingScoreLabel(ComputeBenchmarkStats(_benchmarkElapsedMs).WordsPerMinute);
    }

    private List<(string Code, string Label)> LanguageOptions()
    {
        var options = (_latestPayload.Runtime?.SttLanguageOptions ?? [])
            .Select(option => (
                Code: QuickStartText.CompactSpaces(option.Code).ToLowerInvariant(),
                Label: QuickStartText.CompactSpaces(option.Label)))
            .Where(option => option.Code.Length > 0 && option.Label.Length > 0)
            .ToList();
        return options.Count > 0 ? options : [("en", "English"), ("fr", "French")];
    }

    private void RebuildLanguageCheckboxes(IReadOnlyCollection<string> active)
    {
        _languagePanel.SuspendLayout();
        foreach (var entry in _languageCheckboxes)
        {
            entry.Box.Dispose();
        }
        _languagePanel.Controls.Clear();
        _languageCheckboxes.Clear();
        foreach (var option in LanguageOptions())
        {
            var box = new CheckBox
            {
                Text = option.Label,
                AutoSize = true,
                Checked = active.Contains(option.Code),
                Margin = new Padding(0, 4, 16, 0)
            };
            box.CheckedChanged += (_, _) => FormChanged();
            _languagePanel.Controls.Add(box);
            _languageCheckboxes.Add((option.Code, option.Label, box));
        }
        _languagePanel.ResumeLayout(true);
    }

    private List<string> SelectedLanguages()
    {
        return _languageCheckboxes.Where(entry => entry.Box.Checked).Select(entry => entry.Code).ToList();
    }

    private string LanguagesSummary()
    {
        var labels = _languageCheckboxes.Where(entry => entry.Box.Checked).Select(entry => entry.Label).ToList();
        if (labels.Count == 0)
        {
            return "None";
        }
        return labels.Count > 1 ? $"Auto-detect ({string.Join(" / ", labels)})" : labels[0];
    }

    private string ValidationError()
    {
        if (QuickStartText.NormalizeProfileName(_nameField.Text).Length == 0)
        {
            return "Add your name before finishing Quick Start.";
        }
        if (_benchmarkElapsedMs <= 0)
        {
            return "Complete the typing benchmark before finishing Quick Start.";
        }
        if (!TypedTextMatchesSample())
        {
            return "Type the sample sentence exactly once before finishing Quick Start.";
        }
        if (SelectedLanguages().Count == 0)
        {
            return "Pick at least one language you dictate in.";
        }
        return "";
    }

    private void SetStatus(string message, Color? color = null)
    {
        var text = QuickStartText.CompactSpaces(message);
        _statusLabel.Text = text.Length == 0 ? "Ready." : text;
        _statusLabel.ForeColor = color ?? SecondaryColor;
    }

    private void UpdateRuntimeSummary()
    {
        var provider = QuickStartText.CompactSpaces(_latestPayload.Runtime?.RewriteProvider);
        var improvement = provider.Length > 0 && !provider.Equals("none", StringComparison.OrdinalIgnoreCase)
            ? $"Text improvement: {provider}."
            : "Text improvement is optional.";
        _runtimeLabel.Text = $"Built-in speech to text is ready on Windows. {improvement}";
    }

    private void UpdateHotkeyUi()
    {
        var managed = _latestPayload.Runtime?.HotkeyManagedByEnv == true;
        _hotkeyCombo.Enabled = !managed;
        var hotkey = QuickStartText.CompactSpaces(_latestPayload.Runtime?.Hotkey);
        _hotkeyHintLabel.Text = managed
            ? $"Shortcut is managed externally and currently set to {(hotkey.Length > 0 ? hotkey : "unknown")}."
            : "Choose the shortcut you want to hold when you speak.";
    }

    private static string FormatBenchmarkSeconds(int elapsedMs)
    {
        return (Math.Max(0, elapsedMs) / 1000.0).ToString("0.0", CultureInfo.InvariantCulture) + "s";
    }

    private int ActiveBenchmarkElapsedMs()
    {
        if (_benchmarkStartedAt is not { } startedAt)
        {
            return 0;
        }
        return Math.Max(1, (int)(DateTime.UtcNow - startedAt).TotalMilliseconds);
    }

    private bool PlausibleTypingTime(int elapsedMs)
    {
        return elapsedMs > 0 && ComputeBenchmarkStats(elapsedMs).WordsPerMinute <= QuickStartText.MaxPlausibleWpm;
    }

    private void UpdateBenchmarkSummary()
    {
        var typed = QuickStartText.NormalizeTypedText(_typingBox.Text);
        var sampleCount = new StringInfo(SampleText()).LengthInTextElements;
        var rawTypedCount = new StringInfo(_typingBox.Text).LengthInTextElements;
        _resetBenchmarkButton.Enabled = typed.Length > 0 || _benchmarkElapsedMs > 0;

        if (typed.Length == 0)
        {
            _benchmarkElapsedMs = 0;
            _benchmarkStartedAt = null;
            _benchmarkTimer.Stop();
            _typingBox.ForeColor = SystemColors.WindowText;
            _benchmarkSummaryLabel.ForeColor = SecondaryColor;
            _benchmarkHintLabel.ForeColor = SecondaryColor;
            _benchmarkSummaryLabel.Text = "Ready. Read the phrase once first, then type it naturally.";
            _benchmarkHintLabel.Text = "Smart apostrophes are accepted, so both I'm and I’m will match.";
            _toolTip.SetToolTip(_benchmarkInfoButton, QuickStartText.TypingScoreTooltip());
            UpdateSummary();
            return;
        }

        if (TypedTextMatchesSample() && _benchmarkElapsedMs <= 0 && !PlausibleTypingTime(ActiveBenchmarkElapsedMs()))
        {
            // The phrase arrived faster than anyone types it, from a paste or
            // autofill: a near-zero time would inflate the savings estimates.
            _benchmarkStartedAt = null;
            _benchmarkTimer.Stop();
            _typingBox.ForeColor = ErrorColor;
            _benchmarkSummaryLabel.ForeColor = ErrorColor;
            _benchmarkHintLabel.ForeColor = SecondaryColor;
            _benchmarkSummaryLabel.Text = "Pasted text cannot be timed.";
            _benchmarkHintLabel.Text = "Press Restart, then type the phrase yourself.";
            _toolTip.SetToolTip(_benchmarkInfoButton, QuickStartText.TypingScoreTooltip());
            UpdateSummary();
            return;
        }

        if (TypedTextMatchesSample())
        {
            if (_benchmarkElapsedMs <= 0)
            {
                _benchmarkElapsedMs = ActiveBenchmarkElapsedMs();
            }
            _benchmarkTimer.Stop();
            var stats = ComputeBenchmarkStats(_benchmarkElapsedMs);
            var score = QuickStartText.TypingScoreLabel(stats.WordsPerMinute);
            _typingBox.ForeColor = SuccessColor;
            _benchmarkSummaryLabel.ForeColor = SuccessColor;
            _benchmarkHintLabel.ForeColor = SuccessColor;
            _benchmarkSummaryLabel.Text = $"You are here: {score}";
            _benchmarkHintLabel.Text = $"{QuickStartText.TypingPlacementLine(stats.WordsPerMinute)} Time: {FormatBenchmarkSeconds(stats.ElapsedMs)}.";
            _toolTip.SetToolTip(_benchmarkInfoButton, QuickStartText.TypingScoreTooltip(score));
            UpdateSummary();
            return;
        }

        if (_benchmarkStartedAt is null || _benchmarkElapsedMs > 0)
        {
            _benchmarkStartedAt = DateTime.UtcNow;
        }
        _benchmarkElapsedMs = 0;
        _benchmarkTimer.Start();
        _typingBox.ForeColor = SystemColors.WindowText;
        _benchmarkSummaryLabel.ForeColor = SecondaryColor;
        _benchmarkHintLabel.ForeColor = SecondaryColor;
        _benchmarkSummaryLabel.Text = $"Typing: {FormatBenchmarkSeconds(ActiveBenchmarkElapsedMs())} • {Math.Min(rawTypedCount, sampleCount)}/{sampleCount} characters.";
        _benchmarkHintLabel.Text = "Keep going until the typed text matches the phrase exactly once.";
        _toolTip.SetToolTip(_benchmarkInfoButton, QuickStartText.TypingScoreTooltip());
        UpdateSummary();
    }

    private void UpdateSummary()
    {
        var name = QuickStartText.NormalizeProfileName(_nameField.Text);
        var presetLabel = _hotkeyCombo.SelectedItem as string ?? "Unknown";
        _summaryLabel.Text = string.Join(Environment.NewLine,
            $"Profile: {(name.Length == 0 ? "Anonymous" : name)}",
            $"Text improvement: {(_rewriteCheckbox.Checked ? "On" : "Off")}",
            $"Speech effort: {QuickStartText.SpeechEffortLabel(SelectedSpeechEffort())}",
            $"Languages: {LanguagesSummary()}",
            $"Speech context: {(SttContextText().Length == 0 ? "Empty" : "Added")}",
            $"Push-to-talk: {presetLabel}");
    }

    private void HydrateFromState()
    {
        var state = _latestPayload.State;
        var runtime = _latestPayload.Runtime;
        var speechEffort = QuickStartText.NormalizeSpeechEffort(state?.Choices?.SpeechEffort);
        if (speechEffort.Length == 0)
        {
            speechEffort = QuickStartText.NormalizeSpeechEffort(runtime?.SpeechEffort);
        }
        var pushToTalkHotkey = QuickStartText.CompactSpaces(state?.Choices?.PushToTalkHotkey ?? runtime?.Hotkey);
        var sttPromptContext = QuickStartText.NormalizeSttPromptContext(state?.Choices?.SttPromptContext ?? runtime?.SttPromptContext);

        _hydrating = true;
        try
        {
            _nameField.Text = QuickStartText.NormalizeProfileName(state?.Profile?.Name);
            _rewriteCheckbox.Checked = state?.Choices?.RewriteCleanup == true;
            _effortLow.Checked = speechEffort == "low";
            _effortHigh.Checked = speechEffort == "high";
            _effortMid.Checked = speechEffort is not "low" and not "high";
            _sttContextBox.Text = sttPromptContext.Replace("\n", Environment.NewLine);
            var sttLanguages = runtime?.SttLanguages ?? [];
            RebuildLanguageCheckboxes(sttLanguages.Count == 0 ? ["en"] : sttLanguages);

            _hotkeyPresets = ResolvedPresets();
            _hotkeyCombo.Items.Clear();
            foreach (var preset in _hotkeyPresets)
            {
                _hotkeyCombo.Items.Add(preset.Label);
            }
            var selectedIndex = Array.FindIndex(_hotkeyPresets, preset =>
                preset.Value == pushToTalkHotkey || preset.Value == runtime?.Hotkey);
            _hotkeyCombo.SelectedIndex = Math.Max(0, selectedIndex);

            _sampleLabel.Text = SampleText();
            var elapsed = (int)(state?.TypingBenchmark?.ElapsedMs ?? 0);
            if (elapsed > 0)
            {
                _typingBox.Text = SampleText();
                _benchmarkElapsedMs = elapsed;
                _benchmarkStartedAt = DateTime.UtcNow.AddMilliseconds(-elapsed);
            }
            else
            {
                _typingBox.Text = "";
                _benchmarkElapsedMs = 0;
                _benchmarkStartedAt = null;
            }
        }
        finally
        {
            _hydrating = false;
        }

        UpdateRuntimeSummary();
        UpdateHotkeyUi();
        UpdateBenchmarkSummary();
        UpdateSummary();
        _hydrated = true;
    }

    private void SendCompleteCommand()
    {
        var error = ValidationError();
        if (error.Length > 0)
        {
            SetStatus(error, ErrorColor);
            return;
        }

        var command = new
        {
            action = "complete_onboarding",
            requestedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            payload = new
            {
                profile = new { name = QuickStartText.NormalizeProfileName(_nameField.Text) },
                choices = new
                {
                    rewriteCleanup = _rewriteCheckbox.Checked,
                    speechEffort = SelectedSpeechEffort(),
                    sttLanguages = SelectedLanguages(),
                    pushToTalkHotkey = SelectedHotkeyValue(),
                    sttPromptContext = SttContextText()
                },
                typingBenchmark = ComputeBenchmarkStats(_benchmarkElapsedMs)
            }
        };

        _submitted = true;
        _finishButton.Enabled = false;
        SetStatus("Applying Quick Start choices...");
        if (!WriteCommand(JsonSerializer.Serialize(command, WriteOptions)))
        {
            _submitted = false;
            _finishButton.Enabled = true;
            SetStatus("Could not reach DicTray. Is it still running?", ErrorColor);
        }
    }

    private bool WriteCommand(string json)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_commandPath) ?? ".");
            // Written aside and moved into place so the tray never reads half a command.
            var tempPath = _commandPath + ".tmp";
            File.WriteAllText(tempPath, json, new UTF8Encoding(false));
            File.Move(tempPath, _commandPath, overwrite: true);
            return true;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"Failed to write the Quick Start command: {error.Message}");
            return false;
        }
    }

    private void HandleStateUpdate(StatePayload payload)
    {
        _latestPayload = payload;
        if (payload.Quit == true)
        {
            Close();
            return;
        }

        if (!_hydrated)
        {
            _initialCompletedAt = QuickStartText.CompactSpaces(payload.State?.CompletedAt);
            HydrateFromState();
        }

        UpdateRuntimeSummary();
        UpdateHotkeyUi();

        if (!_submitted)
        {
            return;
        }

        var pending = payload.Ui?.Pending == true;
        var error = QuickStartText.CompactSpaces(payload.Ui?.Error);
        var completedAt = QuickStartText.CompactSpaces(payload.State?.CompletedAt);
        _finishButton.Enabled = !pending;
        if (error.Length > 0)
        {
            SetStatus(error, ErrorColor);
        }
        else if (pending)
        {
            SetStatus("Applying Quick Start choices...");
        }
        else if (completedAt.Length > 0 && completedAt != _initialCompletedAt)
        {
            SetStatus("Quick Start complete. DicTray is ready.", SuccessColor);
            if (!_closeTimer.Enabled)
            {
                _closeTimer.Start();
            }
        }
    }

    private void RefreshState(bool force)
    {
        string raw;
        try
        {
            // Shared read so the tray can replace the file while this poll has it open.
            using var stream = new FileStream(
                _statePath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            raw = reader.ReadToEnd();
        }
        catch
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(raw) || (!force && raw == _lastRawState))
        {
            return;
        }

        StatePayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize<StatePayload>(raw, ReadOptions);
        }
        catch
        {
            return;
        }
        if (payload is null)
        {
            return;
        }

        _lastRawState = raw;
        HandleStateUpdate(payload);
    }
}

internal static class NativeMethods
{
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
