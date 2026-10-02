// Hosts DicTray's control named pipe on behalf of the tray process.
//
// Node cannot put a security descriptor on a named pipe, and the default one
// lets Everyone read and every administrator connect. This helper owns the pipe
// with an explicit DACL (the current user's SID only, network logons denied,
// remote clients rejected) and relays raw lines to the tray over stdio. It knows
// nothing about the control protocol itself; src/control-protocol.mjs does.
//
//   WindowsControlPipe.exe <pipe name>     e.g. \\.\pipe\dictray-control-sebastien
//
// stdout, one JSON object per line:
//   {"type":"listening","pipe":"\\.\pipe\..."}
//   {"type":"open","conn":1}
//   {"type":"line","conn":1,"line":"{\"cmd\":\"config\"}"}
//   {"type":"close","conn":1}
//   {"type":"error","message":"...","fatal":true}
// stdin, one JSON object per line:
//   {"type":"write","conn":1,"line":"{\"ok\":true}"}
//   {"type":"close","conn":1}
// The helper exits when stdin reaches EOF, so it never outlives the tray.

using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

internal static class Program
{
    private const string PipePrefix = @"\\.\pipe\";
    internal const int MaxLineChars = 64 * 1024;

    private static readonly object StdoutLock = new();
    private static readonly ConcurrentDictionary<long, PipeConnection> Connections = new();
    private static long _nextConnectionId;

    [MTAThread]
    private static async Task<int> Main(string[] args)
    {
        var requested = args.Length > 0 ? args[0].Trim() : string.Empty;
        var pipeName = requested.StartsWith(PipePrefix, StringComparison.OrdinalIgnoreCase)
            ? requested[PipePrefix.Length..]
            : requested;
        if (string.IsNullOrWhiteSpace(pipeName) || pipeName.Contains('\\'))
        {
            Console.Error.WriteLine("usage: WindowsControlPipe <\\\\.\\pipe\\name>");
            return 2;
        }

        Console.OutputEncoding = new UTF8Encoding(false);
        Console.InputEncoding = new UTF8Encoding(false);
        _ = Task.Run(ReadStdinLoop);

        PipeSecurity security;
        try
        {
            security = BuildPipeSecurity();
        }
        catch (Exception error)
        {
            Emit(new { type = "error", message = $"Cannot build the pipe security descriptor: {error.Message}", fatal = true });
            return 1;
        }

        var first = true;
        var consecutiveFailures = 0;
        while (true)
        {
            NamedPipeServerStream server;
            try
            {
                // FirstPipeInstance makes creation fail if someone else already
                // owns this name, instead of silently joining their pipe.
                var options = PipeOptions.Asynchronous | (first ? PipeOptions.FirstPipeInstance : PipeOptions.None);
                server = NamedPipeServerStreamAcl.Create(
                    pipeName,
                    PipeDirection.InOut,
                    NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte,
                    options,
                    inBufferSize: 0,
                    outBufferSize: 0,
                    security);
            }
            catch (Exception error)
            {
                Emit(new { type = "error", message = error.Message, fatal = first });
                if (first)
                {
                    return 1;
                }
                consecutiveFailures += 1;
                await Task.Delay(Math.Min(5000, 200 * consecutiveFailures));
                continue;
            }

            if (first)
            {
                first = false;
                Emit(new { type = "listening", pipe = PipePrefix + pipeName });
            }

            try
            {
                await server.WaitForConnectionAsync();
            }
            catch (Exception error)
            {
                server.Dispose();
                Emit(new { type = "error", message = error.Message, fatal = false });
                continue;
            }
            consecutiveFailures = 0;

            var id = Interlocked.Increment(ref _nextConnectionId);
            var connection = new PipeConnection(id, server);
            Connections[id] = connection;
            Emit(new { type = "open", conn = id });
            _ = connection.RunAsync();
        }
    }

    private static PipeSecurity BuildPipeSecurity()
    {
        var user = WindowsIdentity.GetCurrent().User
            ?? throw new InvalidOperationException("The current user has no SID.");
        var security = new PipeSecurity();
        // Only an explicit DACL: no inherited or default entries.
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.SetOwner(user);
        // Elevated processes of the same user carry the same SID, so this one
        // entry admits them too.
        security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.FullControl, AccessControlType.Allow));
        // Every network logon token carries NETWORK; this denies remote clients
        // even if they authenticate as this user.
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.NetworkSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Deny));
        return security;
    }

    internal static void Emit(object payload)
    {
        var line = JsonSerializer.Serialize(payload);
        lock (StdoutLock)
        {
            Console.Out.Write(line);
            Console.Out.Write('\n');
            Console.Out.Flush();
        }
    }

    internal static void Forget(long id)
    {
        Connections.TryRemove(id, out _);
    }

    private static void ReadStdinLoop()
    {
        try
        {
            string? raw;
            while ((raw = Console.In.ReadLine()) is not null)
            {
                if (string.IsNullOrWhiteSpace(raw))
                {
                    continue;
                }
                try
                {
                    using var document = JsonDocument.Parse(raw);
                    var root = document.RootElement;
                    var type = root.TryGetProperty("type", out var typeValue) ? typeValue.GetString() : null;
                    var id = root.TryGetProperty("conn", out var connValue) && connValue.TryGetInt64(out var parsed) ? parsed : 0;
                    if (!Connections.TryGetValue(id, out var connection))
                    {
                        continue;
                    }
                    switch (type)
                    {
                        case "write":
                            connection.Enqueue(root.TryGetProperty("line", out var lineValue) ? lineValue.GetString() ?? string.Empty : string.Empty);
                            break;
                        case "close":
                            connection.RequestClose();
                            break;
                    }
                }
                catch (JsonException)
                {
                    // Ignore malformed control lines from the tray.
                }
            }
        }
        catch
        {
            // Fall through to exit.
        }
        Environment.Exit(0);
    }
}

internal sealed class PipeConnection
{
    private readonly long _id;
    private readonly NamedPipeServerStream _stream;
    private readonly Channel<string?> _outbound = Channel.CreateUnbounded<string?>(new UnboundedChannelOptions { SingleReader = true });
    private int _closed;

    public PipeConnection(long id, NamedPipeServerStream stream)
    {
        _id = id;
        _stream = stream;
    }

    public void Enqueue(string line)
    {
        _outbound.Writer.TryWrite(line);
    }

    // Queued after pending writes, so the response reaches the client first.
    public void RequestClose()
    {
        _outbound.Writer.TryWrite(null);
    }

    public async Task RunAsync()
    {
        var writer = Task.Run(WriteLoopAsync);
        try
        {
            await ReadLoopAsync();
        }
        catch
        {
            // A broken pipe just ends the connection.
        }
        Close();
        await writer.ConfigureAwait(false);
    }

    private async Task ReadLoopAsync()
    {
        var decoder = new UTF8Encoding(false).GetDecoder();
        var bytes = new byte[4096];
        var chars = new char[8192];
        var line = new StringBuilder();
        while (Volatile.Read(ref _closed) == 0)
        {
            var count = await _stream.ReadAsync(bytes);
            if (count == 0)
            {
                return;
            }
            var charCount = decoder.GetChars(bytes, 0, count, chars, 0);
            for (var index = 0; index < charCount; index += 1)
            {
                var ch = chars[index];
                if (ch == '\n')
                {
                    var text = line.ToString().TrimEnd('\r');
                    line.Clear();
                    Program.Emit(new { type = "line", conn = _id, line = text });
                    continue;
                }
                if (line.Length >= Program.MaxLineChars)
                {
                    // Oversized request: hand what we have to the tray, which
                    // rejects it, and stop reading.
                    Program.Emit(new { type = "line", conn = _id, line = line.ToString(), truncated = true });
                    return;
                }
                line.Append(ch);
            }
        }
    }

    private async Task WriteLoopAsync()
    {
        try
        {
            await foreach (var item in _outbound.Reader.ReadAllAsync())
            {
                if (item is null)
                {
                    break;
                }
                var payload = Encoding.UTF8.GetBytes(item + "\n");
                await _stream.WriteAsync(payload);
                await _stream.FlushAsync();
            }
            // Wait until the client has read everything before the handle
            // goes away, bounded so a client that stops reading cannot pin us.
            await Task.WhenAny(Task.Run(() =>
            {
                try
                {
                    _stream.WaitForPipeDrain();
                }
                catch
                {
                    // ignore
                }
            }), Task.Delay(2000));
        }
        catch
        {
            // Client went away mid-write.
        }
        Close();
    }

    private void Close()
    {
        if (Interlocked.Exchange(ref _closed, 1) != 0)
        {
            return;
        }
        _outbound.Writer.TryComplete();
        try
        {
            _stream.Dispose();
        }
        catch
        {
            // ignore
        }
        Program.Forget(_id);
        Program.Emit(new { type = "close", conn = _id });
    }
}
