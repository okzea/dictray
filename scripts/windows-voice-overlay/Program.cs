using System.Drawing.Drawing2D;
using System.Text.Json;
using System.Text.Json.Serialization;

// Renders the DicTray voice overlay on Windows. The tray core writes an overlay
// payload to a JSON state file and this helper mirrors it as a borderless,
// click-through window, matching the macOS overlay helper.
try
{
    var statePath = args.Length > 0 ? args[0] : "";
    if (string.IsNullOrWhiteSpace(statePath))
    {
        Console.Error.WriteLine("Overlay state path argument is required.");
        return 1;
    }

    Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    Application.Run(new OverlayForm(statePath));
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error.Message);
    return 1;
}

internal sealed class OverlayPayload
{
    [JsonPropertyName("visible")] public bool Visible { get; set; }
    [JsonPropertyName("phase")] public string? Phase { get; set; }
    [JsonPropertyName("targetWindow")] public string? TargetWindow { get; set; }
    [JsonPropertyName("note")] public string? Note { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("inputLevel")] public double? InputLevel { get; set; }
    [JsonPropertyName("bounds")] public OverlayBounds? Bounds { get; set; }
    [JsonPropertyName("windowBounds")] public WindowRect? WindowBounds { get; set; }
    [JsonPropertyName("size")] public OverlaySize? Size { get; set; }
    [JsonPropertyName("margin")] public int? Margin { get; set; }
    [JsonPropertyName("quit")] public bool? Quit { get; set; }
}

internal sealed class WindowRect
{
    [JsonPropertyName("left")] public int Left { get; set; }
    [JsonPropertyName("top")] public int Top { get; set; }
    [JsonPropertyName("width")] public int Width { get; set; }
    [JsonPropertyName("height")] public int Height { get; set; }
}

internal sealed class OverlaySize
{
    [JsonPropertyName("width")] public int Width { get; set; }
    [JsonPropertyName("height")] public int Height { get; set; }
}

internal sealed class OverlayBounds
{
    [JsonPropertyName("x")] public int X { get; set; }
    [JsonPropertyName("y")] public int Y { get; set; }
    [JsonPropertyName("width")] public int Width { get; set; }
    [JsonPropertyName("height")] public int Height { get; set; }
}

internal sealed class OverlayForm : Form
{
    private const double VisibleOpacity = 0.88;

    private const int WsExTransparent = 0x20;
    private const int WsExNoActivate = 0x8000000;
    private const int WsExToolWindow = 0x80;

    private static readonly Color BackgroundColor = Color.FromArgb(15, 15, 15);
    private static readonly Color BorderColor = Color.FromArgb(31, 255, 255, 255);
    private static readonly Color TitleColor = Color.White;
    private static readonly Color DetailColor = Color.FromArgb(189, 255, 255, 255);

    private static readonly Color AccentRed = Color.FromArgb(255, 59, 48);
    private static readonly Color AccentGreen = Color.FromArgb(52, 199, 89);
    private static readonly Color AccentBlue = Color.FromArgb(0, 122, 255);
    private static readonly Color AccentTeal = Color.FromArgb(90, 200, 250);
    private static readonly Color AccentGray = Color.FromArgb(142, 142, 147);
    private static readonly Color AccentOrange = Color.FromArgb(255, 149, 0);
    private static readonly Color AccentPurple = Color.FromArgb(175, 82, 222);

    private readonly string _statePath;
    private readonly System.Windows.Forms.Timer _pollTimer;
    private readonly Font _titleFont;
    private readonly Font _detailFont;

    private Color _accent = AccentTeal;
    private Color _accentTarget = AccentTeal;
    private readonly System.Windows.Forms.Timer _accentTimer;

    private OverlayPayload _payload = new() { Visible = false, Phase = "idle" };
    private string _lastRaw = "";

    public OverlayForm(string statePath)
    {
        _statePath = statePath;

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = BackgroundColor;
        Opacity = 0d;
        DoubleBuffered = true;
        Size = new Size(292, 78);

        _titleFont = new Font("Segoe UI", 15f, FontStyle.Bold, GraphicsUnit.Pixel);
        _detailFont = new Font("Segoe UI", 12f, FontStyle.Regular, GraphicsUnit.Pixel);

        _accentTimer = new System.Windows.Forms.Timer { Interval = 16 };
        _accentTimer.Tick += (_, _) => StepAccent();

        _pollTimer = new System.Windows.Forms.Timer { Interval = 120 };
        _pollTimer.Tick += (_, _) => ReloadState();
        _pollTimer.Start();

        ReloadState();
    }

    protected override bool ShowWithoutActivation => true;


    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WsExTransparent | WsExNoActivate | WsExToolWindow;
            return cp;
        }
    }

    private void ReloadState()
    {
        string raw;
        try
        {
            raw = File.ReadAllText(_statePath);
        }
        catch
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(raw) || raw == _lastRaw)
        {
            return;
        }

        _lastRaw = raw;

        OverlayPayload? next;
        try
        {
            next = JsonSerializer.Deserialize<OverlayPayload>(raw);
        }
        catch
        {
            return;
        }

        if (next is null)
        {
            return;
        }

        if (next.Quit == true)
        {
            _pollTimer.Stop();
            Close();
            return;
        }

        _payload = next;
        ApplyPayload();
    }

    private void ApplyPayload()
    {
        var target = ResolveBounds();
        if (Bounds != target)
        {
            Bounds = target;
        }

        UpdateRegion();

        // Application.Run(form) forces the form visible, so the overlay cannot rely
        // on Visible alone: it would sit on screen from launch until the first
        // dictation. Keep the window alive and drive presence through opacity.
        var opacity = _payload.Visible ? VisibleOpacity : 0d;
        if (Math.Abs(Opacity - opacity) > 0.001)
        {
            Opacity = opacity;
        }

        var nextAccent = AccentColor();
        if (nextAccent != _accentTarget)
        {
            _accentTarget = nextAccent;
            // A hidden overlay has nothing to animate from, so snap instead of
            // fading in from whatever the previous turn ended on.
            if (_payload.Visible && Opacity > 0)
            {
                _accentTimer.Start();
            }
            else
            {
                _accent = nextAccent;
            }
        }

        if (_payload.Visible)
        {
            Invalidate();
        }
    }

    /// <summary>
    /// Places the overlay at the bottom-centre of the screen holding the focused
    /// window. The tray core cannot do this itself: its host-runtime screen shim
    /// reports a single fixed 1920x1080 display.
    /// </summary>
    private Rectangle ResolveBounds()
    {
        var width = _payload.Size?.Width > 0 ? _payload.Size!.Width : 292;
        var height = _payload.Size?.Height > 0 ? _payload.Size!.Height : 78;
        var margin = _payload.Margin ?? 18;

        Screen screen;
        var win = _payload.WindowBounds;
        if (win is not null && win.Width > 0 && win.Height > 0)
        {
            screen = Screen.FromRectangle(new Rectangle(win.Left, win.Top, win.Width, win.Height));
        }
        else
        {
            screen = Screen.FromPoint(Cursor.Position) ?? Screen.PrimaryScreen!;
        }

        var area = screen.WorkingArea;
        var x = area.X + ((area.Width - width) / 2);
        var y = area.Y + area.Height - height - margin;
        return new Rectangle(x, y, width, height);
    }

    private void StepAccent()
    {
        _accent = LerpColor(_accent, _accentTarget, 0.22);
        if (IsNear(_accent, _accentTarget))
        {
            _accent = _accentTarget;
            _accentTimer.Stop();
        }

        Invalidate();
    }

    private static Color LerpColor(Color from, Color to, double amount)
    {
        return Color.FromArgb(
            (int)Math.Round(from.R + ((to.R - from.R) * amount)),
            (int)Math.Round(from.G + ((to.G - from.G) * amount)),
            (int)Math.Round(from.B + ((to.B - from.B) * amount)));
    }

    private static bool IsNear(Color a, Color b)
    {
        return Math.Abs(a.R - b.R) <= 2 && Math.Abs(a.G - b.G) <= 2 && Math.Abs(a.B - b.B) <= 2;
    }

    private void UpdateRegion()
    {
        using var path = RoundedRect(new Rectangle(0, 0, Width, Height), 16);
        Region?.Dispose();
        Region = new Region(path);
    }

    private static GraphicsPath RoundedRect(Rectangle rect, int radius)
    {
        var diameter = radius * 2;
        var path = new GraphicsPath();
        if (rect.Width <= diameter || rect.Height <= diameter)
        {
            path.AddRectangle(rect);
            return path;
        }

        path.AddArc(rect.X, rect.Y, diameter, diameter, 180, 90);
        path.AddArc(rect.Right - diameter, rect.Y, diameter, diameter, 270, 90);
        path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(rect.X, rect.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    private string PhaseTitle() => (_payload.Phase ?? "idle").Trim() switch
    {
        "processing" => "Listening",
        "listening" => "Listening",
        "transcribing" => "Transcribing",
        "rewriting" => "Improving Text",
        "inserting" => "Inserting",
        "pending_insert" => "Waiting To Insert",
        _ => !string.IsNullOrWhiteSpace(_payload.Error) || !string.IsNullOrWhiteSpace(_payload.Note)
            ? "DicTray"
            : "Ready"
    };

    private string DetailText()
    {
        var error = (_payload.Error ?? "").Trim();
        if (error.Length > 0)
        {
            return Compact(error);
        }

        var note = (_payload.Note ?? "").Trim();
        if (note.Length > 0)
        {
            return Compact(note);
        }

        var target = (_payload.TargetWindow ?? "").Trim();
        if (target.Length > 0)
        {
            return Compact(target);
        }

        return "Hold the shortcut and speak.";
    }

    private static string Compact(string value)
    {
        const int limit = 34;
        var text = value.Trim();
        return text.Length <= limit ? text : text[..(limit - 1)].Trim() + "…";
    }

    private Color AccentColor()
    {
        if (!string.IsNullOrWhiteSpace(_payload.Error))
        {
            return AccentRed;
        }

        var phase = (_payload.Phase ?? "idle").Trim();
        if (phase == "listening")
        {
            return AccentGreen;
        }

        if (phase == "transcribing")
        {
            return AccentBlue;
        }

        if (phase == "rewriting")
        {
            return AccentOrange;
        }

        if (phase == "inserting")
        {
            return AccentPurple;
        }

        // A finished turn that left a note rather than an error is a cancellation
        // or similar notice, not the idle "ready" state, so it gets its own colour.
        if (phase is "idle" or "" && !string.IsNullOrWhiteSpace(_payload.Note))
        {
            return AccentGray;
        }

        return AccentTeal;
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

        var rect = new Rectangle(0, 0, Width - 1, Height - 1);
        using (var path = RoundedRect(rect, 16))
        using (var border = new Pen(BorderColor, 1f))
        {
            g.DrawPath(border, path);
        }

        var accent = _accent;

        // A pulse ring scaled by input level gives visible feedback while recording.
        var level = Math.Clamp(_payload.InputLevel ?? 0, 0, 1);
        if (level > 0.01 && (_payload.Phase ?? "").Trim() is "listening" or "processing")
        {
            var pulse = (int)Math.Round(6 + (level * 10));
            using var pulseBrush = new SolidBrush(Color.FromArgb(60, accent));
            g.FillEllipse(pulseBrush, 24 - pulse, 27 - pulse, pulse * 2, pulse * 2);
        }

        using (var dotBrush = new SolidBrush(accent))
        {
            g.FillEllipse(dotBrush, 18, 21, 12, 12);
        }

        using (var titleBrush = new SolidBrush(TitleColor))
        using (var format = new StringFormat { Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap })
        {
            g.DrawString(PhaseTitle(), _titleFont, titleBrush, new RectangleF(38, 16, Width - 56, 20), format);
        }

        using (var detailBrush = new SolidBrush(DetailColor))
        using (var format = new StringFormat { Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap })
        {
            g.DrawString(DetailText(), _detailFont, detailBrush, new RectangleF(18, 42, Width - 36, 26), format);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _pollTimer.Dispose();
            _accentTimer.Dispose();
            _titleFont.Dispose();
            _detailFont.Dispose();
        }

        base.Dispose(disposing);
    }
}
