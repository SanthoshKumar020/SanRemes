import { describe, expect, it } from "vitest";

import {
  checkSentinelInstall, launchdPlist, sentinelCommand, sentinelLaunchdPlist, sentinelServicePlan, sentinelSystemdService, sentinelSystemdTimer,
  sentinelUnitCommand, serviceCommand, servicePlan, shippedSentinelCli, systemdUnit, unstableInstallWarning, type ServiceSpec,
} from "./service-unit.ts";

const spec: ServiceSpec = {
  node: "/usr/bin/node",
  script: "/usr/lib/node_modules/sanremes/cli.js",
  serveArgs: ["--port", "8799", "--data-dir", "/home/sanremes/.sanremes", "--domain", "sanremes.example.com", "--no-pair"],
  dataDir: "/home/sanremes/.sanremes",
  user: "sanremes",
  home: "/home/sanremes",
  bindsLowPorts: true,
  label: "agentada",
};

describe("service units", () => {
  it("runs the same serve command, with strip-types only for a checkout", () => {
    expect(serviceCommand(spec)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/sanremes/cli.js", "serve", ...spec.serveArgs]);
    expect(serviceCommand({ ...spec, script: "/srv/SanRemes/server/sanremes.ts" })[1]).toBe("--experimental-strip-types");
  });

  it("renders a systemd unit that restarts, runs as the user, and grants low ports only for --domain", () => {
    const unit = systemdUnit(spec);
    expect(unit).toContain("Description=SanRemes (agentada)");
    expect(unit).toContain("User=sanremes");
    expect(unit).toContain("Environment=SANREMES_DATA_DIR=/home/sanremes/.sanremes");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/lib/node_modules/sanremes/cli.js serve --port 8799 --data-dir /home/sanremes/.sanremes --domain sanremes.example.com --no-pair");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(unit).toContain("WantedBy=multi-user.target");
    const local = systemdUnit({ ...spec, bindsLowPorts: false, serveArgs: ["--port", "8799", "--data-dir", "/home/sanremes/.sanremes"] });
    expect(local).not.toContain("CAP_NET_BIND_SERVICE");
    expect(systemdUnit({ ...spec, dataDir: "/home/sanremes/My Data", serveArgs: ["--data-dir", "/home/sanremes/My Data"] })).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/sanremes/cli.js serve --data-dir "/home/sanremes/My Data"');
  });

  it("renders a launchd agent that keeps the server alive and logs under the data dir", () => {
    const plist = launchdPlist({ ...spec, home: "/Users/sanremes", dataDir: "/Users/sanremes/.sanremes" });
    expect(plist).toContain("<string>com.sanremes.serve</string>");
    expect(plist).toContain("<string>/usr/bin/node</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<string>sanremes.example.com</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("/Users/sanremes/.sanremes/logs/service.log");
    expect(launchdPlist({ ...spec, serveArgs: ["--label", "a & b <c>"] })).toContain("<string>a &amp; b &lt;c&gt;</string>");
  });

  it("refuses to point a service at an npx cache, and knows where each platform's file goes", () => {
    expect(unstableInstallWarning("/home/sanremes/.npm/_npx/abc123/node_modules/sanremes/cli.js")).toMatch(/npm install -g sanremes/);
    expect(unstableInstallWarning("/usr/lib/node_modules/sanremes/cli.js")).toBeNull();
    const linux = servicePlan("linux", "/home/sanremes/.sanremes");
    expect(linux?.installed).toBe("/etc/systemd/system/sanremes.service");
    expect(linux?.activate.join("\n")).toContain("systemctl enable --now sanremes");
    const mac = servicePlan("darwin", "/Users/sanremes/.sanremes", "/Users/sanremes");
    expect(mac?.installed).toBe("/Users/sanremes/Library/LaunchAgents/com.sanremes.serve.plist");
    expect(mac?.activate.join("\n")).toContain("launchctl bootstrap gui/$(id -u)");
    expect(servicePlan("win32", "C:\\x")).toBeNull();
  });

  it("renders Sentinel as a launchd agent on an interval, under its own label, logging outside the data dir", () => {
    const out = "/Users/sanremes/Library/Application Support/sanremes-sentinel";
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/sanremes/cli.js", dataDir: "/Users/sanremes/.sanremes", home: "/Users/sanremes", out };
    expect(sentinelCommand(sentinel)).toEqual(["/usr/bin/node", "/usr/lib/node_modules/sanremes/cli.js", "sentinel", "--once", "--data-dir", "/Users/sanremes/.sanremes", "--out", out]);
    expect(sentinelCommand({ ...sentinel, script: "/srv/SanRemes/server/sanremes.ts" })[1]).toBe("--experimental-strip-types");
    const plist = sentinelLaunchdPlist(sentinel);
    expect(plist).toContain("<string>com.sanremes.sentinel</string>");
    expect(plist).toContain("<key>StartInterval</key>\n\t<integer>120</integer>");
    expect(plist).toContain("<string>sentinel</string>");
    expect(plist).not.toContain("KeepAlive");
    expect(plist).toContain(`<string>${out}/sentinel.log</string>`);
    expect(plist).not.toContain(".sanremes/logs");
    const mac = sentinelServicePlan("darwin", out, "/Users/sanremes");
    expect(mac?.files).toEqual([{ name: "com.sanremes.sentinel.plist", installed: "/Users/sanremes/Library/LaunchAgents/com.sanremes.sentinel.plist" }]);
    // a path with a space is one argument in the printed commands
    expect(mac?.activate[0]).toBe("mkdir -p /Users/sanremes/Library/LaunchAgents && cp '/Users/sanremes/Library/Application Support/sanremes-sentinel/com.sanremes.sentinel.plist' /Users/sanremes/Library/LaunchAgents/com.sanremes.sentinel.plist");
    expect(mac?.deactivate[0]).toBe("launchctl bootout gui/$(id -u)/com.sanremes.sentinel");
  });

  it("renders Sentinel as a systemd user timer, with no root", () => {
    const sentinel = { node: "/usr/bin/node", script: "/usr/lib/node_modules/sanremes/cli.js", dataDir: "/home/sanremes/My Data", home: "/home/sanremes", out: "/home/sanremes/.local/state/sanremes-sentinel" };
    const unit = sentinelSystemdService(sentinel);
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/sanremes/cli.js sentinel --once --data-dir "/home/sanremes/My Data" --out /home/sanremes/.local/state/sanremes-sentinel');
    expect(unit).not.toContain("User=");
    expect(sentinelSystemdTimer()).toContain("OnUnitActiveSec=120s");
    expect(sentinelSystemdTimer()).toContain("WantedBy=timers.target");
    const linux = sentinelServicePlan("linux", sentinel.out, "/home/sanremes");
    expect(linux?.files.map((file) => file.installed)).toEqual(["/home/sanremes/.config/systemd/user/sanremes-sentinel.service", "/home/sanremes/.config/systemd/user/sanremes-sentinel.timer"]);
    expect(linux?.activate[0]).toContain("cp /home/sanremes/.local/state/sanremes-sentinel/sanremes-sentinel.service");
    expect(linux?.activate.join("\n")).toContain("systemctl --user enable --now sanremes-sentinel.timer");
    expect(linux?.activate.join("\n")).not.toContain("sudo");
    expect(sentinelServicePlan("win32", "C:\\x")).toBeNull();
  });

  it("finds the CLI the installed desktop app ships, and runs it as Node", () => {
    const app = "/Applications/SanRemes.app/Contents";
    const present = new Set([`${app}/MacOS/SanRemes`, `${app}/Resources/server/sanremes.js`]);
    expect(shippedSentinelCli("darwin", "/Users/sanremes", (path) => present.has(path))).toEqual({ node: `${app}/MacOS/SanRemes`, script: `${app}/Resources/server/sanremes.js` });
    const user = "/Users/sanremes/Applications/SanRemes.app/Contents";
    expect(shippedSentinelCli("darwin", "/Users/sanremes", (path) => path.startsWith(user))?.script).toBe(`${user}/Resources/server/sanremes.js`);
    expect(shippedSentinelCli("linux", "/home/sanremes", (path) => path.startsWith("/opt/SanRemes/"))).toEqual({ node: "/opt/SanRemes/sanremes", script: "/opt/SanRemes/resources/server/sanremes.js" });
    // an app with its script missing, or one released before Sentinel, is no CLI for it
    expect(shippedSentinelCli("darwin", "/Users/sanremes", (path) => path.endsWith("MacOS/SanRemes"))).toBeNull();
    expect(shippedSentinelCli("darwin", "/Users/sanremes", (path) => present.has(path), () => false)).toBeNull();
    expect(shippedSentinelCli("win32", "C:\\Users\\sanremes", () => true)).toBeNull();

    const spec = { node: `${app}/MacOS/SanRemes`, script: `${app}/Resources/server/sanremes.js`, dataDir: "/Users/sanremes/.sanremes", home: "/Users/sanremes", out: "/tmp/s", electronRunAsNode: true };
    expect(sentinelLaunchdPlist(spec)).toContain("<key>ELECTRON_RUN_AS_NODE</key>\n\t\t<string>1</string>");
    expect(sentinelSystemdService(spec)).toContain("Environment=ELECTRON_RUN_AS_NODE=1");
    expect(sentinelLaunchdPlist({ ...spec, electronRunAsNode: false })).not.toContain("ELECTRON_RUN_AS_NODE");
  });

  it("keeps every path one quoted value in the systemd unit, and refuses one no unit can hold", () => {
    const spec = { node: "/usr/bin/node", script: "/srv/sanremes/cli.js", dataDir: "/home/sanremes/100% $HOME\\", home: "/home/my sanremes", out: "/home/my sanremes/.local/state/sanremes-sentinel" };
    const unit = sentinelSystemdService(spec);
    expect(unit).toContain('Environment="HOME=/home/my sanremes"');
    // % is no specifier, $ no variable, and the trailing backslash no continuation
    expect(unit).toContain('"/home/sanremes/100%% $$HOME\\\\"');
    expect(sentinelUnitCommand(unit)).toEqual({ node: "/usr/bin/node", script: "/srv/sanremes/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService({ ...spec, script: "/srv/100% $x/cli.js" }))?.script).toBe("/srv/100% $x/cli.js");
    for (const bad of ["/home/sanremes\n[Service]\nExecStartPre=/bin/true", "/home/sanremes\r", "/home/\0maus"]) {
      expect(() => sentinelSystemdService({ ...spec, home: bad })).toThrow(/line break or NUL/);
      expect(() => sentinelLaunchdPlist({ ...spec, dataDir: bad })).toThrow(/line break or NUL/);
    }
  });

  it("reads back what an installed unit runs, and calls it stale when either path is gone", () => {
    const spec = { node: "/opt/node & co/bin/node", script: "/srv/sanremes/cli.js", dataDir: "/home/sanremes/My Data", home: "/home/sanremes", out: "/home/sanremes/.local/state/sanremes-sentinel" };
    expect(sentinelUnitCommand(sentinelLaunchdPlist(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/sanremes/cli.js" });
    expect(sentinelUnitCommand(sentinelSystemdService(spec))).toEqual({ node: "/opt/node & co/bin/node", script: "/srv/sanremes/cli.js" });
    expect(sentinelUnitCommand("[Service]\nType=oneshot\n")).toBeNull();

    const unit = "/home/sanremes/.config/systemd/user/sanremes-sentinel.service";
    const timer = "/home/sanremes/.config/systemd/user/sanremes-sentinel.timer";
    const files = new Map([[unit, sentinelSystemdService(spec)]]);
    const fs = (present: string[]) => ({ exists: (path: string) => files.has(path) || present.includes(path), read: (path: string) => files.get(path)! });
    expect(checkSentinelInstall("linux", "/home/sanremes", fs([spec.node, spec.script, timer]))).toMatchObject({ status: "ok", unit });
    expect(checkSentinelInstall("linux", "/home/sanremes", fs([spec.node, timer]))).toMatchObject({ status: "stale", missing: ["/srv/sanremes/cli.js"] });
    // the service without its timer never runs
    expect(checkSentinelInstall("linux", "/home/sanremes", fs([spec.node, spec.script]))).toMatchObject({ status: "stale", missing: [timer] });
    expect(checkSentinelInstall("darwin", "/Users/sanremes", fs([]))).toEqual({ status: "not_installed", unit: "/Users/sanremes/Library/LaunchAgents/com.sanremes.sentinel.plist" });
    files.set(unit, "garbage");
    expect(checkSentinelInstall("linux", "/home/sanremes", fs([]))).toEqual({ status: "unreadable", unit });
    expect(checkSentinelInstall("win32", "C:\\Users\\sanremes", fs([]))).toEqual({ status: "unsupported" });
  });
});
