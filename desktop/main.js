// 蜂群引力AI (openswarm) desktop shell.
//
// Boot sequence: invite-code gate -> Redis sidecar -> Python backend ->
// poll /ready -> main window at http://127.0.0.1:8000.
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

// SHA-256 hashes of valid invite codes. Regenerate with scripts/gen-codes.mjs.
const INVITE_CODE_HASHES = [
  "96920cb4730d81cc6abd51cc543f3535b88d86d9dd9be5499a16c6ce2c386755",
  "6a4bee73c8fb3927aec2b0716e7aac86ffa6ddb638008cb6d58c71a8ee248be2",
  "1b1a6648bdb0b97bc86fe489804531b293f238cc269c5969863c26165ecaaa89",
  "3a64fa771cdd545ee340ececb680acfa3991c33cc4a098f43092ad757a77cd94",
  "d1f947f95bb82bc678b1d489be5741c2c89a977d60903e2de4bf463fbfcdb459",
];

const BACKEND_URL = "http://127.0.0.1:8000";
const READY_TIMEOUT_MS = 60_000;

let redisProcess = null;
let backendProcess = null;
let redisPort = 0;
let quitting = false;

const userDataDir = () => app.getPath("userData");
const activationFile = () => path.join(userDataDir(), "activation.json");
const logsDir = () => path.join(userDataDir(), "logs");

// ---------------------------------------------------------------------------
// Invite-code gate
// ---------------------------------------------------------------------------

function hashCode(code) {
  return crypto.createHash("sha256").update(code, "utf8").digest("hex");
}

function isActivated() {
  try {
    const record = JSON.parse(fs.readFileSync(activationFile(), "utf8"));
    // Removing a hash from INVITE_CODE_HASHES revokes existing activations.
    return INVITE_CODE_HASHES.includes(record.codeHash);
  } catch {
    return false;
  }
}

function saveActivation(codeHash) {
  fs.mkdirSync(userDataDir(), { recursive: true });
  fs.writeFileSync(
    activationFile(),
    JSON.stringify({ codeHash, activatedAt: new Date().toISOString() }, null, 2),
  );
}

function registerActivationHandler() {
  ipcMain.handle("activate", (_event, rawCode) => {
    const code = String(rawCode || "").trim().toUpperCase();
    if (!code) {
      return { ok: false, message: "请输入邀请码" };
    }
    const digest = hashCode(code);
    if (!INVITE_CODE_HASHES.includes(digest)) {
      return { ok: false, message: "邀请码无效，请检查后重试" };
    }
    saveActivation(digest);
    return { ok: true };
  });
}

function showGateWindow() {
  return new Promise((resolve) => {
    const gate = new BrowserWindow({
      width: 420,
      height: 560,
      resizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      backgroundColor: "#111113",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    gate.loadFile(path.join(__dirname, "gate.html"));
    ipcMain.once("activation-complete", () => {
      resolve(true);
      gate.close();
    });
    gate.on("closed", () => resolve(isActivated()));
  });
}

// ---------------------------------------------------------------------------
// Sidecar processes
// ---------------------------------------------------------------------------

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function openLog(name) {
  fs.mkdirSync(logsDir(), { recursive: true });
  return fs.openSync(path.join(logsDir(), name), "a");
}

async function startRedis() {
  const exe = app.isPackaged
    ? path.join(process.resourcesPath, "redis", "redis-server.exe")
    : path.join(__dirname, "vendor", "redis", "redis-server.exe");
  if (!fs.existsSync(exe)) {
    throw new Error(
      `未找到 Redis 可执行文件：${exe}\n开发模式请先运行 desktop/scripts/fetch-redis.ps1`,
    );
  }
  redisPort = await findFreePort();
  const dataDir = path.join(userDataDir(), "redis");
  fs.mkdirSync(dataDir, { recursive: true });
  const log = openLog("redis.log");
  redisProcess = spawn(
    exe,
    [
      "--port", String(redisPort),
      "--bind", "127.0.0.1",
      "--appendonly", "yes",
      "--dir", dataDir,
    ],
    { stdio: ["ignore", log, log], windowsHide: true },
  );
  redisProcess.on("exit", (code) => {
    redisProcess = null;
    if (!quitting) {
      fatal(`Redis 进程意外退出（code=${code}），详见日志：${path.join(logsDir(), "redis.log")}`);
    }
  });
}

function backendCommand() {
  const packagedExe = app.isPackaged
    ? path.join(process.resourcesPath, "backend", "openswarm-backend.exe")
    : path.join(__dirname, "..", "dist-backend", "openswarm-backend", "openswarm-backend.exe");
  if (fs.existsSync(packagedExe)) {
    return { exe: packagedExe, args: [], cwd: path.dirname(packagedExe) };
  }
  if (!app.isPackaged) {
    // Dev fallback: run the entrypoint straight from the repo venv.
    const repoRoot = path.join(__dirname, "..");
    const python = path.join(repoRoot, ".venv", "Scripts", "python.exe");
    if (fs.existsSync(python)) {
      return { exe: python, args: [path.join(repoRoot, "desktop_entry.py")], cwd: repoRoot };
    }
  }
  throw new Error(`未找到后端可执行文件：${packagedExe}`);
}

function startBackend() {
  const { exe, args, cwd } = backendCommand();
  const dataDir = path.join(userDataDir(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const log = openLog("backend.log");
  backendProcess = spawn(exe, args, {
    cwd,
    stdio: ["ignore", log, log],
    windowsHide: true,
    env: {
      ...process.env,
      OPENSWARM_REDIS_MODE: "external",
      OPENSWARM_REDIS_HOST: "127.0.0.1",
      OPENSWARM_REDIS_PORT: String(redisPort),
      OPENSWARM_DATABASE_PATH: path.join(dataDir, "operations.db"),
      OPENSWARM_WORKSPACE_DIR: path.join(dataDir, "workspaces"),
      OPENSWARM_REPORTS_DIR: path.join(dataDir, "reports"),
      OPENSWARM_CREDENTIAL_VAULT_PATH: path.join(dataDir, "credentials.json"),
    },
  });
  backendProcess.on("exit", (code) => {
    backendProcess = null;
    if (!quitting) {
      fatal(`后端进程意外退出（code=${code}），详见日志：${path.join(logsDir(), "backend.log")}`);
    }
  });
}

async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BACKEND_URL}/ready`);
      if (response.ok) {
        return;
      }
    } catch {
      // Backend not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `后端在 ${READY_TIMEOUT_MS / 1000} 秒内未就绪，日志目录：${logsDir()}`,
  );
}

function stopSidecars() {
  quitting = true;
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
  if (redisProcess) {
    // Ask Redis to flush the AOF/RDB before exiting; fall back to kill.
    const cli = app.isPackaged
      ? path.join(process.resourcesPath, "redis", "redis-cli.exe")
      : path.join(__dirname, "vendor", "redis", "redis-cli.exe");
    if (fs.existsSync(cli)) {
      spawnSync(cli, ["-p", String(redisPort), "shutdown", "save"], {
        timeout: 5000,
        windowsHide: true,
      });
    }
    if (redisProcess) {
      redisProcess.kill();
      redisProcess = null;
    }
  }
}

function fatal(message) {
  stopSidecars();
  dialog.showErrorBox("蜂群引力AI 启动失败", message);
  app.exit(1);
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

function showMainWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    backgroundColor: "#111113",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(BACKEND_URL);
}

async function boot() {
  registerActivationHandler();
  if (!isActivated()) {
    const passed = await showGateWindow();
    if (!passed) {
      app.quit();
      return;
    }
  }
  try {
    await startRedis();
    startBackend();
    await waitForReady();
    showMainWindow();
  } catch (error) {
    fatal(String(error?.message || error));
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(boot);
  app.on("before-quit", stopSidecars);
  app.on("window-all-closed", () => app.quit());
}
