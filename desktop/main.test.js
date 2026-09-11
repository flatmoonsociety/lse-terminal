// Run with: node --test desktop/main.test.js (no Electron window or engine starts).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

function loadShell({ packaged = false, platform = "win32", channel = "public", override, hook } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const root = platform === "win32" ? "C:\\checkout" : "/checkout";
  const userHome = platform === "win32" ? "C:\\user" : "/user";
  const profiles = {};
  const calls = { reads: [], required: [], profilesAtLock: null, spawn: null };
  const app = {
    isPackaged: packaged,
    commandLine: { appendSwitch() {} },
    setName(name) { calls.name = name; },
    setPath(name, value) { profiles[name] = value; },
    getPath(name) { return profiles[name] || paths.join(userHome, "production-profile"); },
    requestSingleInstanceLock() { calls.profilesAtLock = { ...profiles }; return false; },
    quit() {}, on() {},
  };
  const mocks = {
    electron: { app, nativeTheme: {}, ipcMain: { handle() {} } },
    path: paths,
    os: { homedir: () => userHome },
    "./package.json": { lseChannel: channel },
    fs: {
      mkdirSync() {},
      readFileSync(file) {
        calls.reads.push(file);
        if (hook) return JSON.stringify(hook);
        throw new Error("no developer override");
      },
      existsSync: () => true,
      createWriteStream: () => ({ write() {} }),
    },
    child_process: {
      spawn(cmd, args, options) {
        calls.spawn = { cmd, args, options };
        return { on() {}, stdout: { on() {} }, stderr: { on() {} } };
      },
    },
  };
  const context = vm.createContext({
    __dirname: paths.join(root, "desktop"),
    process: { platform, resourcesPath: paths.join(root, "resources"),
      env: override ? { LSE_TERMINAL_CONFIG_DIR: override } : {} },
    require(name) {
      calls.required.push(name);
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name === "http" || name === "net") return {};
      throw new Error(`unexpected module: ${name}`);
    },
  });
  vm.runInContext(source, context);
  vm.runInContext("spawnSidecar()", context);
  return { calls, root, paths, userHome, get: expression => vm.runInContext(expression, context) };
}

test("source desktop isolates profiles, captures and engine without changing packaged defaults", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const { calls, root, paths, get } = loadShell({ platform, hook: { command: "other-engine" } });
    const config = paths.join(root, ".dev-data", "config");
    const profile = paths.join(root, ".dev-data", "electron");
    assert.equal(calls.profilesAtLock.userData, profile);
    assert.equal(calls.profilesAtLock.sessionData, profile);
    assert.equal(calls.name, "LSE Terminal Dev");
    assert.equal(calls.spawn.cmd, paths.join(root, ".venv", ...(platform === "win32" ? ["Scripts", "lset.exe"] : ["bin", "lset"])));
    assert.equal(calls.spawn.options.cwd, root);
    assert.equal(calls.spawn.options.env.LSE_TERMINAL_CONFIG_DIR, config);
    assert.equal(calls.spawn.options.env.LSE_TERMINAL_DEV, "1");
    assert.equal(calls.spawn.args.at(-1), "7787");
    assert.equal(get("AI_WS"), paths.join(config, "ai-workspace"));
    assert.equal(calls.reads.length, 0, "source must not consult the global developer hook");
    get("setupAutoUpdate()");
    assert.ok(!calls.required.includes("electron-updater"));
  }
  for (const channel of ["public", "demo"]) {
    const { calls, root, paths, userHome, get } = loadShell({ packaged: true, channel });
    assert.deepEqual(calls.profilesAtLock, {});
    assert.equal(calls.spawn.cmd, paths.join(root, "resources", "sidecar", "lset-server", "lset-server.exe"));
    assert.equal(calls.spawn.options.env.LSE_TERMINAL_CONFIG_DIR,
      paths.join(userHome, ".config", channel === "demo" ? "lse-terminal-demo" : "lse-terminal"));
    assert.equal(calls.spawn.options.env.LSE_TERMINAL_DEV, undefined);
    assert.equal(calls.spawn.args.at(-1), "7799");
    assert.equal(get("APP_TITLE"), channel === "demo" ? "LSE Demo Terminal" : "LSE Terminal");
  }
  for (const packaged of [false, true]) {
    const { calls, paths, userHome, get } = loadShell({ packaged, override: "~/custom-data" });
    const config = paths.join(userHome, "custom-data");
    assert.equal(calls.spawn.options.env.LSE_TERMINAL_CONFIG_DIR, config);
    assert.equal(get("AI_WS"), paths.join(config, "ai-workspace"));
  }
  const demo = loadShell({ channel: "demo" });
  assert.equal(demo.get("APP_TITLE"), "LSE Demo Terminal Dev");
  assert.equal(demo.calls.profilesAtLock.userData, demo.paths.join(demo.root, ".dev-data", "electron-demo"));
  assert.equal(demo.calls.spawn.options.env.LSE_TERMINAL_CONFIG_DIR, demo.paths.join(demo.root, ".dev-data", "config-demo"));
  const { calls } = loadShell({ packaged: true, hook: { command: "custom-engine", args: ["--custom"], cwd: "C:\\custom" } });
  assert.equal(calls.spawn.cmd, "custom-engine");
  assert.equal(calls.spawn.args[0], "--custom");
  assert.equal(calls.spawn.options.cwd, "C:\\custom");
});
