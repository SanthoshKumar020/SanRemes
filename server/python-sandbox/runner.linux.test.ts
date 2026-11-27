import { describe, expect, it } from "vitest";

import { detectPythonSandbox, runPython } from "./runner.ts";

describe.skipIf(process.platform !== "linux")("runPython sandbox", () => {
  it("detects a working sandbox on this machine", () => {
    const detection = detectPythonSandbox();
    expect(detection.supported).toBe(true);
    expect(detection.reason).toBeNull();
    expect(detection.bwrap).toBe("/usr/bin/bwrap");
    expect(detection.seccomp).toBe(true);
  });

  it("runs code and returns stdout and exit code", async () => {
    const result = await runPython({ code: "print('hello', 40 + 2)" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello 42\n");
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBe(false);
    expect(result.note).toBeNull();
  }, 60_000);

  it("reports a non-zero exit and stderr instead of swallowing it", async () => {
    const result = await runPython({ code: "import sys\nprint('out')\nprint('boom', file=sys.stderr)\nsys.exit(3)" });
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toContain("boom");
  }, 60_000);

  it("stops an infinite loop at the timeout", async () => {
    const started = Date.now();
    const result = await runPython({ code: "while True:\n    pass", timeoutSeconds: 3 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.note).toContain("Stopped after 3 seconds");
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);

  it("cannot read files outside the working folder", async () => {
    const result = await runPython({
      code: [
        "import os",
        "print('home', os.environ.get('HOME', ''))",
        "print('sanremes' in ''.join(os.environ), os.environ.get('HOME', '').startswith('/tmp'))",
        "for path in ['/home/hatch/MEMORY.md', '/proc/self/environ']:",
        "    try:",
        "        open(path).read()",
        "        print('READABLE', path)",
        "    except Exception as e:",
        "        print('DENIED', path, type(e).__name__)",
        "for path in ['/etc/evil', '/usr/lib/evil']:",
        "    try:",
        "        open(path, 'w')",
        "        print('WRITABLE', path)",
        "    except Exception as e:",
        "        print('DENIED WRITE', path, type(e).__name__)",
      ].join("\n"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DENIED /home/hatch/MEMORY.md FileNotFoundError");
    expect(result.stdout).toContain("DENIED WRITE /etc/evil");
    expect(result.stdout).toContain("DENIED WRITE /usr/lib/evil");
    expect(result.stdout).not.toContain("READABLE");
    expect(result.stdout).not.toContain("WRITABLE");
    expect(result.stdout).toContain("False True");
  }, 60_000);

  it("cannot reach the network", async () => {
    const result = await runPython({
      code: [
        "import socket",
        "for host, port in [('8.8.8.8', 53), ('1.1.1.1', 443)]:",
        "    try:",
        "        socket.create_connection((host, port), timeout=2)",
        "        print('CONNECTED', host)",
        "    except Exception as e:",
        "        print('DENIED', host, type(e).__name__)",
      ].join("\n"),
      timeoutSeconds: 10,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("DENIED 8.8.8.8 OSError");
    expect(result.stdout).toContain("DENIED 1.1.1.1 OSError");
    expect(result.stdout).not.toContain("CONNECTED");
  }, 60_000);

  it("bounds huge output instead of keeping it all", async () => {
    const result = await runPython({ code: "print('x' * 200_000)", timeoutSeconds: 10 }, { maxOutputBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1000);
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it("bounds memory: a 1 GB allocation fails inside a 256 MB box", async () => {
    const result = await runPython({ code: "x = bytearray(1024 * 1024 * 1024)\nprint('allocated', len(x))", memoryMb: 256, timeoutSeconds: 10 });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("MemoryError");
    expect(result.stdout).not.toContain("allocated");
  }, 60_000);

  it("refuses a denied syscall through the seccomp filter", async () => {
    const detection = detectPythonSandbox();
    if (!detection.seccomp) { expect(detection.supported).toBe(true); return; }
    const result = await runPython({
      code: "import ctypes\nlibc = ctypes.CDLL('libc.so.6', use_errno=True)\nr = libc.syscall(321, 0, 0, 0)\nprint('bpf returned', r, 'errno', ctypes.get_errno())",
      timeoutSeconds: 10,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bpf returned -1 errno 1");
  }, 60_000);

  it("bounds processes: a fork loop hits the process ceiling", async () => {
    const result = await runPython({
      code: [
        "import os, time",
        "made = 0",
        "kids = []",
        "for i in range(400):",
        "    try:",
        "        pid = os.fork()",
        "    except OSError as e:",
        "        print('fork failed at', made, e)",
        "        break",
        "    if pid == 0:",
        "        time.sleep(3)",
        "        os._exit(0)",
        "    kids.append(pid)",
        "    made += 1",
        "print('made', made, 'children')",
        "for pid in kids:",
        "    try: os.waitpid(pid, 0)",
        "    except ChildProcessError: pass",
        "print('done')",
      ].join("\n"),
      timeoutSeconds: 20,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/fork failed at \d+/);
    expect(result.stdout).toContain("done");
  }, 60_000);

  it("leaves no detached child running after the run ends", async () => {
    const { spawnSync } = await import("node:child_process");
    const result = await runPython({
      code: "import subprocess\nsubprocess.Popen(['sleep', '29'])\nprint('spawned')",
      timeoutSeconds: 10,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("spawned");
    const survivors = spawnSync("pgrep", ["-f", "^sleep 29$"]);
    expect(survivors.status).toBe(1);
  }, 60_000);

  it("lists files the code wrote", async () => {
    const result = await runPython({ code: "open('report.txt', 'w').write('hi')\nprint('wrote it')" }, { keepWorkdir: false });
    expect(result.exitCode).toBe(0);
    expect(result.files).toEqual([{ name: "report.txt", bytes: 2 }]);
  }, 60_000);

  it("refuses empty code without running anything", async () => {
    const result = await runPython({ code: "   \n" });
    expect(result.exitCode).toBeNull();
    expect(result.note).toContain("No Python code was given.");
  }, 60_000);
});
