using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using NAudio.Wave;

internal static class Program
{
    private static async Task<int> Main()
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        using var helper = new WindowsCaptureHelper();
        helper.WriteEvent("ready", new
        {
            backend = "native",
            helper = "windows-wavein"
        });
        helper.ReportInputDevices();

        string? line;
        while ((line = await Console.In.ReadLineAsync()) is not null)
        {
            await helper.HandleLine(line);
        }

        await helper.Shutdown();
        return 0;
    }
}

internal sealed class WindowsCaptureHelper : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false
    };

    private readonly object _writeLock = new();
    private readonly ConcurrentDictionary<string, TaskCompletionSource<CaptureResponse>> _pendingRequests = new();
    private int _requestSequence;
    private string _preferredDeviceId = "";
    private RecordingSession? _recording;

    public async Task HandleLine(string line)
    {
        CaptureMessage? message;
        try
        {
            message = JsonSerializer.Deserialize<CaptureMessage>(line, JsonOptions);
        }
        catch
        {
            WriteEvent("error", new { message = "Ignoring invalid Windows capture helper message." });
            return;
        }

        if (message is null)
        {
            WriteEvent("error", new { message = "Ignoring empty Windows capture helper message." });
            return;
        }

        if (string.Equals(message.Kind, "response", StringComparison.OrdinalIgnoreCase))
        {
            HandleCoreResponse(message);
            return;
        }

        var response = message.Type switch
        {
            "configure" => await Configure(message),
            "start-recording" => await StartRecording(message),
            "stop-recording" => await StopRecording(message),
            "cancel-recording" => await CancelRecording(message),
            "toggle-recording" => await ToggleRecording(message),
            "shutdown" => await ShutdownCommand(message),
            _ => CaptureResponse.ForCommand(message.Id, false, null, "Unsupported Windows capture command.")
        };

        WriteMessage(response);
        if (message.Type == "shutdown")
        {
            Environment.Exit(0);
        }
    }

    public void WriteEvent(string type, object payload)
    {
        WriteMessage(new
        {
            kind = "event",
            type,
            payload
        });
    }

    public void ReportInputDevices(string error = "")
    {
        var devices = EnumerateDevices();
        var active = ResolveActiveDevice(devices);
        WriteEvent("input-devices", new
        {
            devices = devices.Select(device => new
            {
                deviceId = device.DeviceId,
                groupId = device.GroupId,
                label = device.Label
            }),
            preferredDeviceId = _preferredDeviceId,
            activeDeviceId = active.DeviceId,
            activeLabel = active.Label,
            permission = "granted",
            error
        });
    }

    public async Task Shutdown()
    {
        if (_recording is not null)
        {
            await StopRecordingInternal(submit: false);
        }
    }

    public void Dispose()
    {
        _recording?.Dispose();
    }

    private Task<CaptureResponse> Configure(CaptureMessage message)
    {
        _preferredDeviceId = PreferredDeviceFromPayload(message.Payload);
        ReportInputDevices();
        return Task.FromResult(CaptureResponse.ForCommand(message.Id, true, new
        {
            backend = "native",
            preferredInputDeviceId = _preferredDeviceId
        }));
    }

    private Task<CaptureResponse> StartRecording(CaptureMessage message)
    {
        if (_recording is not null)
        {
            return Task.FromResult(CaptureResponse.ForCommand(message.Id, true, new { started = false, active = true }));
        }

        var requestedDevice = PreferredDeviceFromPayload(message.Payload);
        if (!string.IsNullOrWhiteSpace(requestedDevice))
        {
            _preferredDeviceId = requestedDevice;
        }

        var devices = EnumerateDevices();
        if (devices.Count == 0)
        {
            ReportInputDevices("No Windows microphone inputs were found.");
            WriteEvent("recording-state", new { phase = "idle" });
            WriteEvent("error", new { message = "No Windows microphone inputs were found." });
            return Task.FromResult(CaptureResponse.ForCommand(message.Id, false, null, "No Windows microphone inputs were found."));
        }

        var active = ResolveActiveDevice(devices);
        try
        {
            _recording = RecordingSession.Start(active, ReportInputLevel);
            WriteEvent("recording-state", new
            {
                phase = "listening",
                captureDevice = active.ToPayload()
            });
            ReportInputDevices();
            return Task.FromResult(CaptureResponse.ForCommand(message.Id, true, new { started = true }));
        }
        catch (Exception error)
        {
            _recording?.Dispose();
            _recording = null;
            WriteEvent("recording-state", new { phase = "idle" });
            WriteEvent("error", new { message = error.Message });
            return Task.FromResult(CaptureResponse.ForCommand(message.Id, false, null, error.Message));
        }
    }

    private async Task<CaptureResponse> StopRecording(CaptureMessage message)
    {
        var hadRecording = _recording is not null;
        if (hadRecording)
        {
            _ = StopRecordingInternal(submit: true);
        }

        return CaptureResponse.ForCommand(message.Id, true, new { stopping = hadRecording });
    }

    private async Task<CaptureResponse> CancelRecording(CaptureMessage message)
    {
        var cancelled = _recording is not null;
        if (cancelled)
        {
            await StopRecordingInternal(submit: false);
        }

        return CaptureResponse.ForCommand(message.Id, true, new { cancelled });
    }

    private async Task<CaptureResponse> ToggleRecording(CaptureMessage message)
    {
        if (_recording is not null)
        {
            await StopRecordingInternal(submit: true);
            return CaptureResponse.ForCommand(message.Id, true, new { active = false });
        }

        return await StartRecording(message);
    }

    private async Task<CaptureResponse> ShutdownCommand(CaptureMessage message)
    {
        var discardedActiveRecording = _recording is not null;
        await StopRecordingInternal(submit: false);
        return CaptureResponse.ForCommand(message.Id, true, new
        {
            closed = true,
            discardedActiveRecording
        });
    }

    private async Task StopRecordingInternal(bool submit)
    {
        var session = _recording;
        if (session is null)
        {
            return;
        }

        _recording = null;
        WriteEvent("recording-state", new
        {
            phase = submit ? "processing" : "idle",
            recordingMs = Math.Max(0, (int)(DateTimeOffset.UtcNow - session.StartedAt).TotalMilliseconds)
        });
        ReportInputLevel(0);

        try
        {
            var audio = await session.Stop();
            if (submit && audio.Length > 44)
            {
                var result = await SendCoreRequest("submit-audio", new
                {
                    mimeType = "audio/wav",
                    audioBase64 = Convert.ToBase64String(audio),
                    recordingMs = Math.Max(0, (int)(DateTimeOffset.UtcNow - session.StartedAt).TotalMilliseconds),
                    captureDevice = session.Device.ToPayload()
                });
                if (!result.Ok)
                {
                    WriteEvent("error", new { message = result.ErrorMessageOrDefault("Dictation failed.") });
                }
            }
        }
        catch (Exception error)
        {
            WriteEvent("error", new { message = error.Message });
        }
        finally
        {
            session.Dispose();
            WriteEvent("recording-state", new { phase = "idle" });
            ReportInputLevel(0);
            ReportInputDevices();
        }
    }

    private Task<CaptureResponse> SendCoreRequest(string type, object payload)
    {
        var id = $"capture-win-{Environment.ProcessId}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}-{Interlocked.Increment(ref _requestSequence):x}";
        var completion = new TaskCompletionSource<CaptureResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pendingRequests[id] = completion;
        WriteMessage(new
        {
            kind = "request",
            id,
            type,
            payload
        });

        _ = Task.Delay(TimeSpan.FromMinutes(3)).ContinueWith(_ =>
        {
            if (_pendingRequests.TryRemove(id, out var pending))
            {
                pending.TrySetException(new TimeoutException("Timed out waiting for tray core response."));
            }
        });
        return completion.Task;
    }

    private void HandleCoreResponse(CaptureMessage message)
    {
        if (string.IsNullOrWhiteSpace(message.Id) || !_pendingRequests.TryRemove(message.Id, out var pending))
        {
            return;
        }

        pending.TrySetResult(new CaptureResponse
        {
            Kind = message.Kind,
            Id = message.Id,
            Ok = message.Ok,
            Payload = message.Payload,
            Error = message.Error
        });
    }

    private void ReportInputLevel(double level)
    {
        WriteEvent("input-level", new
        {
            level = Math.Clamp(level, 0, 1)
        });
    }

    private void WriteMessage(object payload)
    {
        var line = JsonSerializer.Serialize(payload, JsonOptions);
        lock (_writeLock)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }

    private static string PreferredDeviceFromPayload(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object)
        {
            return "";
        }
        if (payload.TryGetProperty("preferredInputDeviceId", out var preferred) && preferred.ValueKind == JsonValueKind.String)
        {
            return preferred.GetString() ?? "";
        }
        if (payload.TryGetProperty("selectedDeviceId", out var selected) && selected.ValueKind == JsonValueKind.String)
        {
            return selected.GetString() ?? "";
        }
        return "";
    }

    private static List<CaptureDevice> EnumerateDevices()
    {
        var devices = new List<CaptureDevice>();
        for (var index = 0; index < WaveIn.DeviceCount; index++)
        {
            var caps = WaveIn.GetCapabilities(index);
            devices.Add(new CaptureDevice(
                Index: index,
                DeviceId: index.ToString(),
                GroupId: index.ToString(),
                Label: string.IsNullOrWhiteSpace(caps.ProductName) ? $"Microphone {index + 1}" : caps.ProductName
            ));
        }
        return devices;
    }

    private CaptureDevice ResolveActiveDevice(IReadOnlyList<CaptureDevice> devices)
    {
        if (devices.Count == 0)
        {
            return CaptureDevice.Empty;
        }
        if (int.TryParse(_preferredDeviceId, out var preferredIndex))
        {
            var preferred = devices.FirstOrDefault(device => device.Index == preferredIndex);
            if (preferred is not null)
            {
                return preferred;
            }
        }
        return devices[0];
    }
}

internal sealed class RecordingSession : IDisposable
{
    private readonly WaveInEvent _waveIn;
    private readonly MemoryStream _stream = new();
    private readonly WaveFileWriter _writer;
    private readonly TaskCompletionSource<byte[]> _stopped = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Action<double> _reportInputLevel;
    private long _lastLevelReportTicks;

    private RecordingSession(CaptureDevice device, Action<double> reportInputLevel)
    {
        Device = device;
        _reportInputLevel = reportInputLevel;
        _waveIn = new WaveInEvent
        {
            DeviceNumber = device.Index,
            WaveFormat = new WaveFormat(16000, 16, 1),
            BufferMilliseconds = 50,
            NumberOfBuffers = 3
        };
        _writer = new WaveFileWriter(_stream, _waveIn.WaveFormat);
        _waveIn.DataAvailable += HandleDataAvailable;
        _waveIn.RecordingStopped += HandleRecordingStopped;
    }

    public CaptureDevice Device { get; }
    public DateTimeOffset StartedAt { get; } = DateTimeOffset.UtcNow;

    public static RecordingSession Start(CaptureDevice device, Action<double> reportInputLevel)
    {
        var session = new RecordingSession(device, reportInputLevel);
        session._waveIn.StartRecording();
        return session;
    }

    public async Task<byte[]> Stop()
    {
        try
        {
            _waveIn.StopRecording();
        }
        catch (Exception error)
        {
            _stopped.TrySetException(error);
        }
        return await _stopped.Task;
    }

    public void Dispose()
    {
        _waveIn.DataAvailable -= HandleDataAvailable;
        _waveIn.RecordingStopped -= HandleRecordingStopped;
        _waveIn.Dispose();
        _writer.Dispose();
        _stream.Dispose();
    }

    private void HandleDataAvailable(object? sender, WaveInEventArgs args)
    {
        if (args.BytesRecorded <= 0)
        {
            return;
        }

        _writer.Write(args.Buffer, 0, args.BytesRecorded);
        _writer.Flush();
        var nowTicks = Environment.TickCount64;
        if (nowTicks - Interlocked.Read(ref _lastLevelReportTicks) < 90)
        {
            return;
        }
        Interlocked.Exchange(ref _lastLevelReportTicks, nowTicks);
        _reportInputLevel(ComputeLevel(args.Buffer, args.BytesRecorded));
    }

    private void HandleRecordingStopped(object? sender, StoppedEventArgs args)
    {
        try
        {
            _writer.Flush();
            if (args.Exception is not null)
            {
                _stopped.TrySetException(args.Exception);
                return;
            }
            _stopped.TrySetResult(_stream.ToArray());
        }
        catch (Exception error)
        {
            _stopped.TrySetException(error);
        }
    }

    private static double ComputeLevel(byte[] buffer, int byteCount)
    {
        if (byteCount < 2)
        {
            return 0;
        }

        double sumSquares = 0;
        var samples = 0;
        for (var offset = 0; offset + 1 < byteCount; offset += 2)
        {
            var sample = BitConverter.ToInt16(buffer, offset) / 32768.0;
            sumSquares += sample * sample;
            samples++;
        }
        if (samples == 0)
        {
            return 0;
        }
        return Math.Clamp(Math.Sqrt(sumSquares / samples) * 8, 0, 1);
    }
}

internal sealed record CaptureDevice(int Index, string DeviceId, string GroupId, string Label)
{
    public static CaptureDevice Empty { get; } = new(-1, "", "", "");

    public object ToPayload()
    {
        return new
        {
            label = Label,
            deviceId = DeviceId,
            groupId = GroupId,
            sampleRate = 16000,
            channelCount = 1,
            echoCancellation = false,
            noiseSuppression = false,
            autoGainControl = false
        };
    }
}

internal sealed class CaptureMessage
{
    public string Kind { get; set; } = "";
    public string Id { get; set; } = "";
    public string Type { get; set; } = "";
    public JsonElement Payload { get; set; }
    public bool Ok { get; set; }
    public string Error { get; set; } = "";
}

internal sealed class CaptureResponse
{
    public string Kind { get; set; } = "response";
    public string Id { get; set; } = "";
    public bool Ok { get; set; }
    public object? Payload { get; set; }
    public string Error { get; set; } = "";

    public static CaptureResponse ForCommand(string id, bool ok, object? payload = null, string error = "")
    {
        return new CaptureResponse
        {
            Id = id,
            Ok = ok,
            Payload = payload ?? new { },
            Error = error
        };
    }

    public string ErrorMessageOrDefault(string fallback)
    {
        return string.IsNullOrWhiteSpace(Error) ? fallback : Error;
    }
}
