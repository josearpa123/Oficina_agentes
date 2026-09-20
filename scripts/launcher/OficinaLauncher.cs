// Lanzador de la Oficina de Agentes (se compila en tu PC con `npm run autostart:install`; no hay binarios en el repositorio).
//
// Qué hace:
//   - Se ve en el Administrador de tareas como "Oficina de Agentes" (con su ícono y descripción).
//   - Ejecuta el servidor de Node oculto (sin ventana) y lo vuelve a levantar 5 s después si se cae.
//   - Si cierras este proceso (Administrador de tareas → Finalizar tarea), el servidor se cierra con él:
//     el servidor vive dentro de un "Job Object" de Windows que lo termina cuando este proceso desaparece.
//   - El registro del servidor va a data\server.log (se rota al pasar de 2 MB).
//
// Los valores @@…@@ los rellena scripts/autostart.js al compilar.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;

[assembly: AssemblyTitle("Oficina de Agentes")]
[assembly: AssemblyDescription("Servidor local de la Oficina de Agentes: arranca oculto y se reinicia solo si se cae")]
[assembly: AssemblyProduct("Oficina de Agentes")]
[assembly: AssemblyCompany("Oficina de Agentes")]
[assembly: AssemblyVersion("1.0.0.0")]

static class Program
{
    const string Root = @"@@ROOT@@";
    const string Node = @"@@NODE@@";
    const bool Lan = @@LAN@@;

    // ---- Job Object (para que el servidor muera junto con este proceso) ----
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);
    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimit
    {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimit
    {
        public BasicLimit Basic; public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    static IntPtr MakeJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        ExtendedLimit info = new ExtendedLimit();
        info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int len = Marshal.SizeOf(typeof(ExtendedLimit));
        IntPtr ptr = Marshal.AllocHGlobal(len);
        try { Marshal.StructureToPtr(info, ptr, false); SetInformationJobObject(job, 9, ptr, (uint)len); }
        finally { Marshal.FreeHGlobal(ptr); }
        return job;
    }

    // ---- Registro ----
    static readonly object Gate = new object();
    static void Log(string path, string line)
    {
        lock (Gate)
        {
            try
            {
                FileInfo fi = new FileInfo(path);
                if (fi.Exists && fi.Length > 2 * 1024 * 1024)
                {
                    if (File.Exists(path + ".old")) File.Delete(path + ".old");
                    File.Move(path, path + ".old");
                }
                File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line + Environment.NewLine);
            }
            catch { /* el registro nunca debe tumbar el lanzador */ }
        }
    }

    static void RunOnce(IntPtr job, string logPath)
    {
        ProcessStartInfo psi = new ProcessStartInfo(Node, "--disable-warning=ExperimentalWarning server\\index.js");
        psi.WorkingDirectory = Root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        if (Lan) psi.EnvironmentVariables["HOST"] = "0.0.0.0";

        using (Process p = Process.Start(psi))
        {
            AssignProcessToJobObject(job, p.Handle);
            p.OutputDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) Log(logPath, e.Data); };
            p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) { if (e.Data != null) Log(logPath, e.Data); };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            p.WaitForExit();
            Log(logPath, "[lanzador] el servidor terminó (código " + p.ExitCode + "); se reinicia en 5 s");
        }
    }

    static void Main(string[] args)
    {
        bool created;
        using (Mutex mutex = new Mutex(true, "OficinaDeAgentes-Lanzador", out created))
        {
            if (!created) return; // ya hay un lanzador en marcha

            IntPtr job = MakeJob();
            string data = Path.Combine(Root, "data");
            Directory.CreateDirectory(data);
            string logPath = Path.Combine(data, "server.log");
            Log(logPath, "[lanzador] iniciado" + (Lan ? " (modo red local)" : " (modo local)"));

            while (true)
            {
                try { RunOnce(job, logPath); }
                catch (Exception e) { Log(logPath, "[lanzador] error: " + e.Message); }
                Thread.Sleep(5000);
            }
        }
    }
}
