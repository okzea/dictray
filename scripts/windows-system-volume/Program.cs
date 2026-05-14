using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true
    };

    [MTAThread]
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
                    backend = "core-audio",
                    supports = new[]
                    {
                        "state",
                        "set"
                    }
                }),
                "state" => HandleState(),
                "set" => HandleSet(ReadRequest<SetVolumeRequest>() ?? new SetVolumeRequest()),
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

    private static int HandleState()
    {
        using var controller = AudioEndpointVolumeController.OpenDefaultRenderEndpoint();
        var state = controller.GetState();
        return WriteJson(new
        {
            ok = true,
            level = state.Level,
            muted = state.Muted
        });
    }

    private static int HandleSet(SetVolumeRequest request)
    {
        using var controller = AudioEndpointVolumeController.OpenDefaultRenderEndpoint();
        var state = controller.SetState(request.Level, request.Muted);
        return WriteJson(new
        {
            ok = true,
            level = state.Level,
            muted = state.Muted
        });
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
}

internal sealed class SetVolumeRequest
{
    public double? Level { get; init; }
    public bool? Muted { get; init; }
}

internal readonly record struct EndpointVolumeState(float Level, bool Muted);

internal sealed class AudioEndpointVolumeController : IDisposable
{
    private readonly IMMDeviceEnumerator _enumerator;
    private readonly IMMDevice _device;
    private readonly IAudioEndpointVolume _endpointVolume;

    private AudioEndpointVolumeController(IMMDeviceEnumerator enumerator, IMMDevice device, IAudioEndpointVolume endpointVolume)
    {
        _enumerator = enumerator;
        _device = device;
        _endpointVolume = endpointVolume;
    }

    public static AudioEndpointVolumeController OpenDefaultRenderEndpoint()
    {
        var enumeratorType = Type.GetTypeFromCLSID(CoreAudioGuids.MMDeviceEnumeratorClsid, throwOnError: true)
            ?? throw new InvalidOperationException("Windows audio device enumerator is unavailable.");
        var enumerator = (IMMDeviceEnumerator)Activator.CreateInstance(enumeratorType)!;
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out var device));

        var interfaceId = CoreAudioGuids.AudioEndpointVolumeIid;
        Marshal.ThrowExceptionForHR(device.Activate(ref interfaceId, (uint)ClsCtx.All, IntPtr.Zero, out var volumeObject));
        return new AudioEndpointVolumeController(enumerator, device, (IAudioEndpointVolume)volumeObject);
    }

    public EndpointVolumeState GetState()
    {
        Marshal.ThrowExceptionForHR(_endpointVolume.GetMasterVolumeLevelScalar(out var level));
        Marshal.ThrowExceptionForHR(_endpointVolume.GetMute(out var muted));
        return new EndpointVolumeState(ClampLevel(level), muted);
    }

    public EndpointVolumeState SetState(double? level, bool? muted)
    {
        if (level.HasValue)
        {
            var targetLevel = ClampLevel((float)level.Value);
            var context = Guid.Empty;
            Marshal.ThrowExceptionForHR(_endpointVolume.SetMasterVolumeLevelScalar(targetLevel, ref context));
        }

        if (muted.HasValue)
        {
            var context = Guid.Empty;
            Marshal.ThrowExceptionForHR(_endpointVolume.SetMute(muted.Value, ref context));
        }

        return GetState();
    }

    public void Dispose()
    {
        Marshal.FinalReleaseComObject(_endpointVolume);
        Marshal.FinalReleaseComObject(_device);
        Marshal.FinalReleaseComObject(_enumerator);
    }

    private static float ClampLevel(float value)
    {
        if (float.IsNaN(value) || float.IsInfinity(value))
        {
            return 0f;
        }

        if (value < 0f)
        {
            return 0f;
        }

        if (value > 1f)
        {
            return 1f;
        }

        return value;
    }
}

internal static class CoreAudioGuids
{
    public static readonly Guid MMDeviceEnumeratorClsid = new("BCDE0395-E52F-467C-8E3D-C4579291692E");
    public static readonly Guid AudioEndpointVolumeIid = new("5CDF2C82-841E-4546-9722-0CF74078229A");
}

internal enum EDataFlow
{
    eRender,
    eCapture,
    eAll
}

internal enum ERole
{
    eConsole,
    eMultimedia,
    eCommunications
}

[Flags]
internal enum ClsCtx : uint
{
    InprocServer = 0x1,
    InprocHandler = 0x2,
    LocalServer = 0x4,
    RemoteServer = 0x10,
    All = InprocServer | InprocHandler | LocalServer | RemoteServer
}

[ComImport]
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceEnumerator
{
    [PreserveSig]
    int EnumAudioEndpoints(EDataFlow dataFlow, uint dwStateMask, out IntPtr devices);

    [PreserveSig]
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);

    [PreserveSig]
    int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);

    [PreserveSig]
    int RegisterEndpointNotificationCallback(IntPtr client);

    [PreserveSig]
    int UnregisterEndpointNotificationCallback(IntPtr client);
}

[ComImport]
[Guid("D666063F-1587-4E43-81F1-B948E807363F")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDevice
{
    [PreserveSig]
    int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePointer);

    [PreserveSig]
    int OpenPropertyStore(uint stgmAccess, out IntPtr properties);

    [PreserveSig]
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);

    [PreserveSig]
    int GetState(out uint state);
}

[ComImport]
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioEndpointVolume
{
    [PreserveSig]
    int RegisterControlChangeNotify(IntPtr notify);

    [PreserveSig]
    int UnregisterControlChangeNotify(IntPtr notify);

    [PreserveSig]
    int GetChannelCount(out uint channelCount);

    [PreserveSig]
    int SetMasterVolumeLevel(float levelDb, ref Guid eventContext);

    [PreserveSig]
    int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);

    [PreserveSig]
    int GetMasterVolumeLevel(out float levelDb);

    [PreserveSig]
    int GetMasterVolumeLevelScalar(out float level);

    [PreserveSig]
    int SetChannelVolumeLevel(uint channelNumber, float levelDb, ref Guid eventContext);

    [PreserveSig]
    int SetChannelVolumeLevelScalar(uint channelNumber, float level, ref Guid eventContext);

    [PreserveSig]
    int GetChannelVolumeLevel(uint channelNumber, out float levelDb);

    [PreserveSig]
    int GetChannelVolumeLevelScalar(uint channelNumber, out float level);

    [PreserveSig]
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);

    [PreserveSig]
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);

    [PreserveSig]
    int GetVolumeStepInfo(out uint step, out uint stepCount);

    [PreserveSig]
    int VolumeStepUp(ref Guid eventContext);

    [PreserveSig]
    int VolumeStepDown(ref Guid eventContext);

    [PreserveSig]
    int QueryHardwareSupport(out uint hardwareSupportMask);

    [PreserveSig]
    int GetVolumeRange(out float volumeMinDb, out float volumeMaxDb, out float volumeIncrementDb);
}
