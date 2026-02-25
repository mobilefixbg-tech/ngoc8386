require("dotenv").config({ quiet: true })

const { app, BrowserWindow, ipcMain, dialog } = require("electron")
const
    OpenAI = require("openai")
const { execFile, spawn } = require("node:child_process")
const path = require("node:path")
const fs = require("node:fs/promises")
const http = require("node:http")

const DEFAULT_AI_MODEL = "gpt-4o-mini"
const DEFAULT_OLLAMA_HOST = String(process.env.OLLAMA_HOST || "http://127.0.0.1:11434")
const ADB_DEFAULT_TCP_PORT = 5555
const APP_REMOTE_DEFAULT_PORT = 17321
const LOCAL_TOOLS_DIR = path.join(__dirname, "tools")
const LOCAL_PLATFORM_TOOLS_DIR = path.join(LOCAL_TOOLS_DIR, "platform-tools")
const LOCAL_AUTOMA_DIR = path.join(LOCAL_TOOLS_DIR, "automa")
const AUTOMA_REPO_URL = "https://github.com/AutomaApp/automa.git"
const LOCAL_ADB_BINARY = process.platform === "win32" ? "adb.exe" : "adb"
const OLLAMA_PRESET_CATALOG = [
  {
    id: "llama2_7b",
    label: "LLaMA-2 7B",
    stars: "⭐⭐⭐⭐",
    model: "llama2:7b",
    pullCandidates: ["llama2:7b"]
  },
  {
    id: "alpaca_7b_q4",
    label: "Alpaca 7B (Q4)",
    stars: "⭐⭐",
    model: "alpaca-7b-q4:latest",
    pullCandidates: ["alpaca:7b", "alpaca:latest"],
    createFromLlama2: true
  },
  {
    id: "vicuna_7b_q4",
    label: "Vicuna 7B (Q4)",
    stars: "⭐⭐",
    model: "vicuna-7b-q4:latest",
    pullCandidates: ["vicuna:7b", "vicuna:latest"],
    createFromLlama2: true
  },
  {
    id: "gptq_4bit_alias",
    label: "LLaMA2 GPTQ-4bit (Alias)",
    stars: "⭐⭐⭐⭐",
    model: "llama2-gptq-4bit:latest",
    pullCandidates: [],
    createFromLlama2: true
  },
  {
    id: "mistral_mini",
    label: "Mistral Mini (Q4)",
    stars: "⭐⭐⭐",
    model: "mistral:7b-instruct-q4_0",
    pullCandidates: ["mistral:7b-instruct-q4_0", "mistral:latest"]
  },
  {
    id: "tinytext_nano",
    label: "TinyText / NanoGPT Class",
    stars: "⭐⭐",
    model: "tinyllama:latest",
    pullCandidates: ["tinyllama:latest"]
  }
]

let runtimeAiConfig = {
  apiKey: String(process.env.OPENAI_API_KEY || ""),
  model: DEFAULT_AI_MODEL,
  ollamaHost: DEFAULT_OLLAMA_HOST
}
let openaiClient = null
let openaiClientApiKey = ""
let autoAgentRef = null
let mainWindowRef = null
let appRemoteServer = null
let appRemoteServerPort = APP_REMOTE_DEFAULT_PORT

function isAllowedInAppUrl(rawUrl) {
  const value = String(rawUrl || "").trim()
  if (!value) return false
  if (value.startsWith("about:")) return true
  try {
    const parsed = new URL(value)
    return ["http:", "https:", "file:"].includes(parsed.protocol)
  } catch (_e) {
    return false
  }
}

function guardWebContentsNavigation(win, targetContents) {
  if (!win || !targetContents) return

  targetContents.setWindowOpenHandler(({ url }) => {
    if (targetContents !== win.webContents && isAllowedInAppUrl(url)) {
      win.webContents.send("app:navigate-in-webview", String(url))
    }
    return { action: "deny" }
  })

  targetContents.on("will-navigate", (event, url) => {
    if (isAllowedInAppUrl(url)) return
    event.preventDefault()
  })
}

function runExecFile(command, args = [], timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        const output = {
          stdout: String(stdout || ""),
          stderr: String(stderr || "")
        }
        if (error) {
          const wrapped = new Error(
            output.stderr.trim() || output.stdout.trim() || error.message || "Command failed"
          )
          wrapped.cause = error
          reject(wrapped)
          return
        }
        resolve(output)
      }
    )
  })
}

function parseAdbDevices(rawOutput) {
  return String(rawOutput || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.toLowerCase().startsWith("list of devices"))
    .map((line) => {
      const parts = line.split(/\s+/)
      const serial = String(parts[0] || "").trim()
      const state = String(parts[1] || "").trim().toLowerCase()
      return {
        serial,
        state,
        transport: serial.includes(":") ? "wifi" : "usb"
      }
    })
    .filter((item) => item.serial && item.state === "device")
}

function getLocalAdbPath() {
  return path.join(LOCAL_PLATFORM_TOOLS_DIR, LOCAL_ADB_BINARY)
}

function getPlatformToolsDownloadUrl() {
  if (process.platform === "darwin") {
    return "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip"
  }
  if (process.platform === "win32") {
    return "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"
  }
  return "https://dl.google.com/android/repository/platform-tools-latest-linux.zip"
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch (_err) {
    return false
  }
}

async function resolveAdbCommandPath() {
  const localAdb = getLocalAdbPath()
  if (await pathExists(localAdb)) {
    return localAdb
  }
  return "adb"
}

function formatAdbCommandStatus(adbCommand) {
  const localAdb = getLocalAdbPath()
  return {
    adbCommand,
    localAdb,
    usingLocalAdb: adbCommand === localAdb
  }
}

async function getPlatformToolsStatus() {
  const adbCommand = await resolveAdbCommandPath()
  const status = formatAdbCommandStatus(adbCommand)
  const localInstalled = await pathExists(status.localAdb)
  let adbReady = false
  let version = ""
  let error = ""

  try {
    const { stdout, stderr } = await runExecFile(adbCommand, ["version"], 8000)
    adbReady = true
    version = String(stdout || stderr || "").trim()
  } catch (err) {
    error = err.message
  }

  return {
    ...status,
    localInstalled,
    adbReady,
    version,
    error
  }
}

async function installPlatformTools() {
  await fs.mkdir(LOCAL_TOOLS_DIR, { recursive: true })
  const zipUrl = getPlatformToolsDownloadUrl()
  const zipPath = path.join(LOCAL_TOOLS_DIR, `platform-tools-${process.platform}.zip`)

  const response = await fetch(zipUrl)
  if (!response.ok) {
    throw new Error(`Tải Platform Tools thất bại (HTTP ${response.status})`)
  }

  const binary = Buffer.from(await response.arrayBuffer())
  await fs.writeFile(zipPath, binary)
  await fs.rm(LOCAL_PLATFORM_TOOLS_DIR, { recursive: true, force: true })
  await runExecFile("unzip", ["-oq", zipPath, "-d", LOCAL_TOOLS_DIR], 120000)
  if (process.platform !== "win32") {
    await fs.chmod(getLocalAdbPath(), 0o755).catch(() => {})
  }
  await runExecFile(getLocalAdbPath(), ["version"], 10000)
  return getPlatformToolsStatus()
}

async function installPlatformToolsFromUrl(url) {
  await fs.mkdir(LOCAL_TOOLS_DIR, { recursive: true })
  const zipPath = path.join(LOCAL_TOOLS_DIR, `platform-tools-custom.zip`)

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Tải Platform Tools thất bại (HTTP ${response.status})`)
  }

  const binary = Buffer.from(await response.arrayBuffer())
  await fs.writeFile(zipPath, binary)
  await fs.rm(LOCAL_PLATFORM_TOOLS_DIR, { recursive: true, force: true })
  await runExecFile("unzip", ["-oq", zipPath, "-d", LOCAL_TOOLS_DIR], 120000)
  if (process.platform !== "win32") {
    await fs.chmod(getLocalAdbPath(), 0o755).catch(() => {})
  }
  await runExecFile(getLocalAdbPath(), ["version"], 10000)
  return getPlatformToolsStatus()
}

async function getAutomaStatus() {
  const repoPath = LOCAL_AUTOMA_DIR
  const gitReady = await pathExists(path.join(repoPath, ".git"))
  const packageReady = await pathExists(path.join(repoPath, "package.json"))

  return {
    installed: gitReady || packageReady,
    gitReady,
    packageReady,
    repoPath,
    repoUrl: AUTOMA_REPO_URL
  }
}

async function installAutomaSource() {
  await fs.mkdir(LOCAL_TOOLS_DIR, { recursive: true })
  const repoPath = LOCAL_AUTOMA_DIR
  const gitPath = path.join(repoPath, ".git")
  const hasGitRepo = await pathExists(gitPath)
  let output = ""

  if (hasGitRepo) {
    const { stdout, stderr } = await runExecFile("git", ["-C", repoPath, "pull", "--ff-only"], 180000)
    output = `${stdout}${stderr}`.trim()
  } else {
    if (await pathExists(repoPath)) {
      await fs.rm(repoPath, { recursive: true, force: true })
    }
    const { stdout, stderr } = await runExecFile(
      "git",
      ["clone", "--depth", "1", AUTOMA_REPO_URL, repoPath],
      240000
    )
    output = `${stdout}${stderr}`.trim()
  }

  return {
    ...(await getAutomaStatus()),
    output
  }
}

async function ensureAdbAvailable() {
  const adbCommand = await resolveAdbCommandPath()
  try {
    await runExecFile(adbCommand, ["version"], 8000)
  } catch (_err) {
    throw new Error("Không tìm thấy lệnh adb. Hãy bấm 'Cài Android Platform Tools' trong Cài đặt.")
  }
  return adbCommand
}

async function ensureScrcpyAvailable() {
  const LOCAL_SCRCPY_PATH = path.join(__dirname, "tools", "scrcpy", "scrcpy")
  const localExists = await pathExists(LOCAL_SCRCPY_PATH)
  
  if (localExists) {
    return LOCAL_SCRCPY_PATH
  }
  
  try {
    await runExecFile("scrcpy", ["--version"], 8000)
    return "scrcpy"
  } catch (_err) {
    throw new Error("Không tìm thấy scrcpy. Hãy bấm 'Cài scrcpy' trong Cài đặt để cài đặt.")
  }
}

async function adbListDevices() {
  const adbCommand = await ensureAdbAvailable()
  await runExecFile(adbCommand, ["start-server"], 8000)
  const { stdout } = await runExecFile(adbCommand, ["devices"], 10000)
  return parseAdbDevices(stdout)
}

function pickAdbDevice(devices, transportHint = "", preferredSerial = "") {
  const list = Array.isArray(devices) ? devices : []
  const preferred = String(preferredSerial || "").trim()
  const transport = String(transportHint || "").trim().toLowerCase()

  if (preferred) {
    const exact = list.find((item) => item.serial === preferred)
    if (exact) return exact
  }

  if (transport === "usb" || transport === "wifi") {
    const sameTransport = list.find((item) => item.transport === transport)
    if (sameTransport) return sameTransport
  }

  return list[0] || null
}

function parseAdbEndpoint(hostHint, portHint) {
  const rawHost = String(hostHint || "").trim().replace(/^https?:\/\//i, "")
  if (!rawHost) return null

  const fallbackPort = Number.parseInt(String(portHint || ADB_DEFAULT_TCP_PORT), 10)
  let host = rawHost
  let port = Number.isFinite(fallbackPort) && fallbackPort > 0 ? fallbackPort : ADB_DEFAULT_TCP_PORT

  const hostParts = rawHost.split(":")
  if (hostParts.length === 2 && /^\d{2,5}$/.test(hostParts[1])) {
    host = hostParts[0].trim()
    port = Number.parseInt(hostParts[1], 10)
  }

  host = host.replace(/^\[|\]$/g, "").trim()
  if (!host) return null

  return {
    host,
    port,
    target: `${host}:${port}`
  }
}

function missingAdbDeviceMessage(transport) {
  if (transport === "usb") {
    return "Không thấy thiết bị USB. Hãy cắm cáp và bật gỡ lỗi USB."
  }
  if (transport === "wifi") {
    return "Không thấy thiết bị ADB WiFi. Hãy bấm ADB WiFi trước."
  }
  return "Không thấy thiết bị Android nào khả dụng qua ADB."
}

function splitCommandLineArgs(raw) {
  const input = String(raw || "").trim()
  if (!input) return []
  const out = []
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g
  let match = null
  while ((match = regex.exec(input)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? ""
    out.push(String(value).replace(/\\(["'\\])/g, "$1"))
  }
  return out
}

function adbInputText(rawText) {
  return String(rawText || "")
    .replace(/\s+/g, "%s")
    .replace(/["'`$\\]/g, "")
    .trim()
}

async function resolveAdbTarget(payload = {}) {
  const transport = String(payload?.transport || "").trim().toLowerCase()
  const preferredSerial = String(payload?.serial || "").trim()
  const devices = await adbListDevices()
  const target = pickAdbDevice(devices, transport, preferredSerial)
  if (!target) {
    throw new Error(missingAdbDeviceMessage(transport))
  }
  return target
}

function sendRemoteCommandToRenderer(rawCommand) {
  const command = String(rawCommand || "").trim()
  if (!command) return false
  if (!mainWindowRef || mainWindowRef.isDestroyed()) return false
  mainWindowRef.webContents.send("app:remote-command", command)
  return true
}

function getAppRemoteStatus() {
  const running = Boolean(appRemoteServer && appRemoteServer.listening)
  return {
    running,
    port: appRemoteServerPort,
    url: `http://127.0.0.1:${appRemoteServerPort}`
  }
}

function buildAppRemotePageHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Comet Ultra Remote</title>
  <style>
    body{font-family:Arial,Helvetica,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:14px}
    h3{margin:0 0 10px}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
    button{padding:10px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-weight:700}
    input{width:100%;box-sizing:border-box;margin-top:10px;padding:10px;border-radius:8px;border:1px solid #334155;background:#111827;color:#e5e7eb}
    .hint{margin-top:8px;font-size:12px;color:#94a3b8}
  </style>
</head>
<body>
  <h3>Comet Ultra Remote</h3>
  <div class="grid">
    <button onclick="sendCmd('quay lai')">Back</button>
    <button onclick="sendCmd('tien toi')">Forward</button>
    <button onclick="sendCmd('tai lai')">Reload</button>
    <button onclick="sendCmd('kqxs')">KQXS</button>
    <button onclick="sendCmd('ve trinh duyet')">Browser</button>
    <button onclick="sendCmd('mo chatgpt')">ChatGPT</button>
    <button onclick="sendCmd('lens ocr')">Lens OCR</button>
    <button onclick="sendCmd('lens ai')">Lens AI</button>
  </div>
  <input id="cmdInput" placeholder="Nhập lệnh tiếng Việt để điều khiển app..."/>
  <button style="margin-top:8px;width:100%" onclick="sendInput()">Gửi lệnh</button>
  <div class="hint">Kết nối qua: adb reverse tcp:17321 tcp:17321 (USB) rồi mở http://127.0.0.1:17321 trên Android.</div>
  <script>
    async function sendCmd(c){
      await fetch('/cmd?c=' + encodeURIComponent(c))
    }
    async function sendInput(){
      const c = document.getElementById('cmdInput').value.trim()
      if(!c) return
      await sendCmd(c)
      document.getElementById('cmdInput').value = ''
    }
  </script>
</body>
</html>`
}

async function startAppRemoteServer(portHint) {
  const requestedPort = Number.parseInt(String(portHint || APP_REMOTE_DEFAULT_PORT), 10)
  appRemoteServerPort = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : APP_REMOTE_DEFAULT_PORT

  if (appRemoteServer && appRemoteServer.listening) {
    return getAppRemoteStatus()
  }

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", `http://127.0.0.1:${appRemoteServerPort}`)
    if (reqUrl.pathname === "/cmd") {
      const command = String(reqUrl.searchParams.get("c") || "")
      const ok = sendRemoteCommandToRenderer(command)
      res.writeHead(ok ? 200 : 409, { "Content-Type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ ok, command }))
      return
    }
    if (reqUrl.pathname === "/status") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
      res.end(JSON.stringify(getAppRemoteStatus()))
      return
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(buildAppRemotePageHtml())
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(appRemoteServerPort, "127.0.0.1", resolve)
  })

  appRemoteServer = server
  return getAppRemoteStatus()
}

async function stopAppRemoteServer() {
  if (!appRemoteServer) {
    return getAppRemoteStatus()
  }
  const server = appRemoteServer
  appRemoteServer = null
  await new Promise((resolve) => {
    server.close(() => resolve())
  })
  return getAppRemoteStatus()
}

function extractMessageText(content) {
  if (typeof content === "string") {
    return content.trim()
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return ""
        if (typeof part.text === "string") return part.text
        if (typeof part.content === "string") return part.content
        return ""
      })
      .filter(Boolean)
      .join("\n")
      .trim()
  }

  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text.trim()
  }

  return ""
}

function normalizeImageDataUrl(rawImageDataUrl) {
  const value = String(rawImageDataUrl || "").trim()
  if (!value) return ""
  if (!/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value)) {
    return ""
  }
  return value
}

function cleanDigits(text) {
  return String(text || "").replace(/\D/g, "")
}

function toBaseUrl(rawUrl, fallback = DEFAULT_OLLAMA_HOST) {
  const value = String(rawUrl || "").trim()
  const seed = value || fallback
  try {
    const parsed = new URL(seed)
    const normalized = `${parsed.protocol}//${parsed.host}`.replace(/\/+$/g, "")
    return normalized || fallback
  } catch (_e) {
    return fallback
  }
}

function getOllamaHost(hostHint) {
  return toBaseUrl(hostHint || runtimeAiConfig.ollamaHost || DEFAULT_OLLAMA_HOST)
}

function getPresetById(presetId) {
  return OLLAMA_PRESET_CATALOG.find((item) => item.id === presetId) || null
}

async function requestJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers || {})
      }
    })
    const text = await response.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch (_e) {
      parsed = null
    }

    if (!response.ok) {
      const message =
        parsed?.error || parsed?.message || text || `HTTP ${response.status}`
      throw new Error(message)
    }

    return parsed
  } finally {
    clearTimeout(timeout)
  }
}

async function ollamaTags(hostHint) {
  const host = getOllamaHost(hostHint)
  const data = await requestJson(`${host}/api/tags`, { method: "GET" }, 8000)
  const models = Array.isArray(data?.models) ? data.models : []
  return {
    host,
    models
  }
}

async function ollamaPullModel(modelName, hostHint) {
  const host = getOllamaHost(hostHint)
  const model = String(modelName || "").trim()
  if (!model) {
    throw new Error("Model không hợp lệ")
  }

  await requestJson(
    `${host}/api/pull`,
    {
      method: "POST",
      body: JSON.stringify({
        model,
        stream: false
      })
    },
    1000 * 60 * 60
  )
  return model
}

async function ollamaCreateAliasModel(modelName, systemPrompt, hostHint) {
  const host = getOllamaHost(hostHint)
  const name = String(modelName || "").trim()
  if (!name) {
    throw new Error("Tên model alias không hợp lệ")
  }
  const modelfile = `FROM llama2:7b\nSYSTEM ${String(systemPrompt || "").trim()}`
  await requestJson(
    `${host}/api/create`,
    {
      method: "POST",
      body: JSON.stringify({
        model: name,
        from: "llama2:7b",
        modelfile,
        stream: false
      })
    },
    1000 * 60 * 60
  )
  return name
}

async function ensurePresetReady(presetId, hostHint) {
  const preset = getPresetById(presetId)
  if (!preset) {
    throw new Error("Preset không tồn tại")
  }

  const host = getOllamaHost(hostHint)
  const attempts = []

  if (preset.pullCandidates.length) {
    for (const candidate of preset.pullCandidates) {
      try {
        const pulled = await ollamaPullModel(candidate, host)
        if (pulled === preset.model) {
          return { host, model: preset.model, source: "pull" }
        }
        if (!preset.createFromLlama2) {
          return { host, model: pulled, source: "pull" }
        }
      } catch (err) {
        attempts.push(`${candidate}: ${err.message}`)
      }
    }
  }

  if (preset.createFromLlama2) {
    try {
      await ollamaPullModel("llama2:7b", host)
      let systemPrompt = "Bạn là trợ lý AI tiếng Việt gọn và rõ."
      if (preset.id.includes("alpaca")) {
        systemPrompt = "Bạn là Alpaca 7B phong cách hướng dẫn, trả lời ngắn gọn tiếng Việt."
      } else if (preset.id.includes("vicuna")) {
        systemPrompt = "Bạn là Vicuna 7B phong cách hội thoại tiếng Việt."
      } else if (preset.id.includes("gptq")) {
        systemPrompt = "Bạn là mô hình LLaMA2 7B cấu hình 4-bit alias cho tác vụ nội bộ."
      }
      await ollamaCreateAliasModel(preset.model, systemPrompt, host)
      return { host, model: preset.model, source: "alias" }
    } catch (err) {
      attempts.push(`alias ${preset.model}: ${err.message}`)
    }
  }

  throw new Error(attempts.length ? attempts.join(" | ") : "Không pull được preset")
}

function toCompactTicket(item) {
  const ticket = item?.ticket && typeof item.ticket === "object" ? item.ticket : null
  const station = String(ticket?.station || item?.station || "").trim() || "Chưa rõ đài"
  const drawDate = String(ticket?.drawDate || "").trim()
  const db = cleanDigits(ticket?.giaiDB || item?.giaiDB || "")
  const g7 = Array.isArray(ticket?.giai7 || item?.giai7)
    ? (ticket?.giai7 || item?.giai7).map((n) => cleanDigits(n)).filter(Boolean)
    : []
  const g8 = Array.isArray(ticket?.giai8 || item?.giai8)
    ? (ticket?.giai8 || item?.giai8).map((n) => cleanDigits(n)).filter(Boolean)
    : []
  const numbers = Array.isArray(item?.numbers)
    ? item.numbers.map((n) => cleanDigits(n)).filter(Boolean).slice(0, 40)
    : []

  return {
    station,
    drawDate,
    db,
    g7,
    g8,
    numbers
  }
}

function normalizeChatMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) {
    return []
  }

  return rawMessages
    .map((item) => {
      const role = item?.role === "assistant" ? "assistant" : "user"
      const content = String(item?.content || "").trim().slice(0, 3000)
      if (!content) return null
      return { role, content }
    })
    .filter(Boolean)
    .slice(-10)
}

async function runVisionPrompt(openai, systemPrompt, userPrompt, imageDataUrl) {
  const completion = await openai.chat.completions.create({
    model: String(runtimeAiConfig.model || DEFAULT_AI_MODEL),
    temperature: 0.1,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          { type: "image_url", image_url: { url: imageDataUrl } }
        ]
      }
    ]
  })

  return extractMessageText(completion.choices?.[0]?.message?.content)
}

function getOpenAiClient() {
  const apiKey = String(runtimeAiConfig.apiKey || "").trim()
  if (!apiKey) {
    return null
  }

  if (!openaiClient || openaiClientApiKey !== apiKey) {
    openaiClient = new OpenAI({ apiKey })
    openaiClientApiKey = apiKey
  }

  return openaiClient
}

function getAutoAgent() {
  if (!autoAgentRef) {
    autoAgentRef = require("./autoAgent")
  }
  return autoAgentRef
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true
    }
  })

  guardWebContentsNavigation(win, win.webContents)
  win.webContents.on("did-attach-webview", (_event, contents) => {
    guardWebContentsNavigation(win, contents)
  })

  mainWindowRef = win
  win.on("closed", () => {
    if (mainWindowRef === win) {
      mainWindowRef = null
    }
  })

  win.loadFile("index.html")
}

app.whenReady().then(createWindow)
app.on("before-quit", () => {
  stopAppRemoteServer().catch(() => {})
})

ipcMain.handle("ai:get-config", async () => {
  return {
    ok: true,
    apiKey: String(runtimeAiConfig.apiKey || ""),
    model: String(runtimeAiConfig.model || DEFAULT_AI_MODEL),
    ollamaHost: String(runtimeAiConfig.ollamaHost || DEFAULT_OLLAMA_HOST)
  }
})

ipcMain.handle("ai:set-config", async (_event, payload) => {
  try {
    if (payload && typeof payload === "object") {
      if (Object.prototype.hasOwnProperty.call(payload, "apiKey")) {
        runtimeAiConfig.apiKey = String(payload.apiKey || "").trim()
      }
      if (Object.prototype.hasOwnProperty.call(payload, "model")) {
        const nextModel = String(payload.model || "").trim()
        runtimeAiConfig.model = nextModel || DEFAULT_AI_MODEL
      }
      if (Object.prototype.hasOwnProperty.call(payload, "ollamaHost")) {
        runtimeAiConfig.ollamaHost = toBaseUrl(payload.ollamaHost, DEFAULT_OLLAMA_HOST)
      }
    }

    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ===== AI HANDLER =====
ipcMain.handle("ask-ai", async (event, payload) => {
  try {
    const openai = getOpenAiClient()
    if (!openai) {
      return JSON.stringify({
        action: "none",
        target: "",
        message: "Thiếu OPENAI_API_KEY"
      })
    }

    const userContent =
      payload && typeof payload === "object"
        ? JSON.stringify(payload, null, 2)
        : String(payload || "")

    const completion = await openai.chat.completions.create({
      model: String(runtimeAiConfig.model || DEFAULT_AI_MODEL),
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: `
Bạn là AI điều khiển app trình duyệt.
Chỉ trả về 1 JSON object, không thêm markdown hay chữ khác.

Danh sách action hợp lệ:
- open_tool
- switch_ai
- navigate_url
- search_web
- show_kqxs
- show_browser
- open_settings
- open_ai_settings
- back
- forward
- reload
- theme_dark
- theme_light
- theme_toggle
- lens_print
- lens_ocr
- lens_ai
- zoom_in
- zoom_out
- zoom_set
- run_command
- none

Quy tắc:
- Ưu tiên điều khiển app thay vì trả text.
- Nếu người dùng yêu cầu mở công cụ AI, đặt action=open_tool và toolId
  (agentgpt/chatgpt/openai/lotoai/ollama_llama2_7b/ollama_alpaca_7b/ollama_vicuna_7b/ollama_gptq_4bit/ollama_tiny/ollama_mistral_mini...).
- Nếu không xác định được hành động, trả action=none.

Mẫu:
{
  "action": "open_tool",
  "toolId": "openai",
  "target": "",
  "value": "",
  "message": ""
}
`
        },
        {
          role: "user",
          content: userContent
        }
      ]
    })

    return (
      completion.choices?.[0]?.message?.content ||
      JSON.stringify({ action: "none", target: "", message: "Không có nội dung phản hồi" })
    )
  } catch (err) {
    return JSON.stringify({
      action: "none",
      target: "",
      message: `Lỗi AI: ${err.message}`
    })
  }
})

ipcMain.handle("ollama:get-status", async (_event, payload) => {
  const host = getOllamaHost(payload?.host)
  try {
    const tags = await ollamaTags(host)
    return {
      ok: true,
      host: tags.host,
      models: tags.models,
      presets: OLLAMA_PRESET_CATALOG
    }
  } catch (err) {
    return {
      ok: false,
      host,
      error: err.message,
      models: [],
      presets: OLLAMA_PRESET_CATALOG
    }
  }
})

ipcMain.handle("ollama:pull-model", async (_event, payload) => {
  const host = getOllamaHost(payload?.host)
  const model = String(payload?.model || "").trim()
  if (!model) {
    return { ok: false, host, error: "Model rỗng", model: "" }
  }
  try {
    const pulledModel = await ollamaPullModel(model, host)
    const tags = await ollamaTags(host)
    return { ok: true, host, model: pulledModel, models: tags.models }
  } catch (err) {
    return { ok: false, host, error: err.message, model, models: [] }
  }
})

ipcMain.handle("ollama:pull-preset", async (_event, payload) => {
  const host = getOllamaHost(payload?.host)
  const presetId = String(payload?.presetId || "").trim()
  if (!presetId) {
    return { ok: false, host, error: "Preset rỗng", model: "" }
  }
  try {
    const resolved = await ensurePresetReady(presetId, host)
    const tags = await ollamaTags(host)
    return { ok: true, host, model: resolved.model, source: resolved.source, models: tags.models }
  } catch (err) {
    return { ok: false, host, error: err.message, model: "", models: [] }
  }
})

ipcMain.handle("ollama:pull-all-presets", async (_event, payload) => {
  const host = getOllamaHost(payload?.host)
  const result = {
    ok: true,
    host,
    done: [],
    failed: []
  }

  for (const preset of OLLAMA_PRESET_CATALOG) {
    try {
      const resolved = await ensurePresetReady(preset.id, host)
      result.done.push({ presetId: preset.id, model: resolved.model, source: resolved.source })
    } catch (err) {
      result.ok = false
      result.failed.push({ presetId: preset.id, error: err.message })
    }
  }

  try {
    const tags = await ollamaTags(host)
    result.models = tags.models
  } catch (_e) {
    result.models = []
  }

  return result
})

ipcMain.handle("ollama:chat", async (_event, payload) => {
  const host = getOllamaHost(payload?.host)
  try {
    const prompt = String(payload?.prompt || "").trim().slice(0, 3000)
    const model = String(payload?.model || "llama2:7b").trim()
    if (!prompt) {
      return { ok: false, host, error: "Bạn chưa nhập câu hỏi", reply: "" }
    }

    const historyMessages = normalizeChatMessages(payload?.messages)
    const autoAgent = getAutoAgent()
    const [history, topByStation] = await Promise.all([
      autoAgent.getHistory(18),
      autoAgent.thongKeTheoDai(3)
    ])
    const contextPayload = {
      latestDraws: Array.isArray(history) ? history.slice(0, 10).map((item) => toCompactTicket(item)) : [],
      topByStation: Array.isArray(topByStation) ? topByStation : []
    }

    const messages = [
      {
        role: "system",
        content:
          "Bạn là AI nội bộ trong app KQXS. Trả lời tiếng Việt ngắn gọn, rõ ràng, ưu tiên số liệu, không hứa hẹn trúng thưởng."
      },
      {
        role: "system",
        content: `Dữ liệu nội bộ KQXS (JSON):\n${JSON.stringify(contextPayload)}`
      },
      ...historyMessages,
      {
        role: "user",
        content: prompt
      }
    ]

    const data = await requestJson(
      `${host}/api/chat`,
      {
        method: "POST",
        body: JSON.stringify({
          model,
          stream: false,
          messages
        })
      },
      1000 * 60 * 20
    )

    const reply = extractMessageText(data?.message?.content || data?.response || "")
    return {
      ok: true,
      host,
      model,
      reply: String(reply || "").trim()
    }
  } catch (err) {
    return {
      ok: false,
      host,
      error: err.message,
      reply: ""
    }
  }
})

ipcMain.handle("lotoai:chat", async (_event, payload) => {
  try {
    const openai = getOpenAiClient()
    if (!openai) {
      return { ok: false, error: "Thiếu OPENAI_API_KEY", reply: "" }
    }

    const prompt = String(payload?.prompt || "").trim().slice(0, 2500)
    if (!prompt) {
      return { ok: false, error: "Bạn chưa nhập câu hỏi", reply: "" }
    }

    const historyMessages = normalizeChatMessages(payload?.messages)
    const autoAgent = getAutoAgent()
    const [history, topByStation] = await Promise.all([
      autoAgent.getHistory(18),
      autoAgent.thongKeTheoDai(3)
    ])

    const contextPayload = {
      latestDraws: Array.isArray(history) ? history.slice(0, 10).map((item) => toCompactTicket(item)) : [],
      topByStation: Array.isArray(topByStation) ? topByStation : []
    }

    const completion = await openai.chat.completions.create({
      model: String(runtimeAiConfig.model || DEFAULT_AI_MODEL),
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: `
Bạn là LotoAI nội bộ trong app Ngọc Phát Tài 1990.
Nhiệm vụ:
- Phân tích KQXS từ dữ liệu nội bộ.
- Trả lời tiếng Việt ngắn gọn, rõ ràng, ưu tiên số liệu.
- Khi chưa đủ dữ liệu, nói rõ thiếu gì.
- Không khẳng định chắc chắn trúng thưởng.
          `.trim()
        },
        {
          role: "system",
          content: `Dữ liệu nội bộ KQXS (JSON):\n${JSON.stringify(contextPayload)}`
        },
        ...historyMessages,
        {
          role: "user",
          content: prompt
        }
      ]
    })

    const reply = extractMessageText(completion.choices?.[0]?.message?.content)
    return { ok: true, reply: String(reply || "").trim() }
  } catch (err) {
    return { ok: false, error: err.message, reply: "" }
  }
})

ipcMain.handle("gemini:chat", async (_event, payload) => {
  try {
    const apiKey = String(payload?.apiKey || "").trim()
    if (!apiKey) {
      return { ok: false, error: "Thiếu Gemini API Key", reply: "" }
    }

    const model = String(payload?.model || "gemini-2.0-flash").trim()
    const prompt = String(payload?.prompt || "").trim().slice(0, 4000)
    const systemPrompt = String(payload?.systemPrompt || "").trim()

    if (!prompt) {
      return { ok: false, error: "Bạn chưa nhập câu hỏi", reply: "" }
    }

    const historyMessages = normalizeChatMessages(payload?.messages)

    const contents = []
    
    if (systemPrompt) {
      contents.push({ role: "user", parts: [{ text: systemPrompt }] })
    }

    for (const msg of historyMessages) {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }]
      })
    }
    contents.push({ role: "user", parts: [{ text: prompt }] })

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
    
    const data = await requestJson(
      geminiUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 4096,
            topP: 0.95,
            topK: 40
          }
        })
      },
      1000 * 60 * 2
    )

    if (data?.error) {
      return { ok: false, error: data.error.message || "Lỗi Gemini API", reply: "" }
    }

    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || ""
    return { ok: true, model, reply: String(reply || "").trim() }
  } catch (err) {
    return { ok: false, error: err.message, reply: "" }
  }
})

ipcMain.handle("lens:ocr-image", async (_event, payload) => {
  try {
    const openai = getOpenAiClient()
    if (!openai) {
      return { ok: false, error: "Thiếu OPENAI_API_KEY" }
    }

    const imageDataUrl = normalizeImageDataUrl(payload?.imageDataUrl)
    if (!imageDataUrl) {
      return { ok: false, error: "Thiếu dữ liệu ảnh vùng quét" }
    }

    const text = await runVisionPrompt(
      openai,
      "Bạn là OCR tiếng Việt. Trả về văn bản đúng thứ tự trong ảnh, không thêm giải thích.",
      "Nhận diện toàn bộ chữ và số trong ảnh. Giữ xuống dòng. Chỉ trả về văn bản thuần.",
      imageDataUrl
    )

    return { ok: true, text: String(text || "").trim() }
  } catch (err) {
    return { ok: false, error: err.message, text: "" }
  }
})

ipcMain.handle("lens:ai-process", async (_event, payload) => {
  try {
    const openai = getOpenAiClient()
    if (!openai) {
      return { ok: false, error: "Thiếu OPENAI_API_KEY" }
    }

    const imageDataUrl = normalizeImageDataUrl(payload?.imageDataUrl)
    if (!imageDataUrl) {
      return { ok: false, error: "Thiếu dữ liệu ảnh vùng quét" }
    }

    const textHint = String(payload?.textHint || "").trim()
    const instruction = String(payload?.instruction || "").trim()
    const userPrompt = `
${instruction || "Phân tích nội dung vùng ảnh đã quét."}

Yêu cầu trả về theo đúng 3 phần:
1) Nội dung chính nhận được
2) Kết luận nhanh
3) Nếu là bảng xổ số, chuẩn hoá lại theo dạng từng dòng: ĐB/G1/G2... và số tương ứng.

Văn bản tham chiếu (nếu có):
${textHint || "(không có)"}
    `.trim()

    const result = await runVisionPrompt(
      openai,
      "Bạn là trợ lý AI xử lý nội dung ảnh tiếng Việt, ưu tiên độ chính xác dữ liệu số.",
      userPrompt,
      imageDataUrl
    )

    return { ok: true, result: String(result || "").trim() }
  } catch (err) {
    return { ok: false, error: err.message, result: "" }
  }
})

ipcMain.handle("tools:platform-tools-status", async () => {
  try {
    const status = await getPlatformToolsStatus()
    return { ok: true, ...status }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("tools:install-platform-tools", async () => {
  try {
    const status = await installPlatformTools()
    return { ok: true, ...status }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("tools:install-platform-tools-from-url", async (_event, payload) => {
  try {
    const url = String(payload?.url || "").trim()
    if (!url) {
      throw new Error("URL trống")
    }
    const status = await installPlatformToolsFromUrl(url)
    return { ok: true, ...status }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("tools:install-platform-tools-from-file", async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: "Chọn file/thư mục Platform Tools (ADB)",
      filters: [
        { name: "ZIP Archive", extensions: ["zip"] },
        { name: "All Files", extensions: ["*"] }
      ],
      properties: ["openFile", "openDirectory"]
    })
    
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { ok: false, error: "Người dùng hủy chọn file" }
    }
    
    const selectedPath = result.filePaths[0]
    const stats = await fs.stat(selectedPath)
    
    await fs.mkdir(LOCAL_TOOLS_DIR, { recursive: true })
    
    if (stats.isDirectory()) {
      await fs.rm(LOCAL_PLATFORM_TOOLS_DIR, { recursive: true, force: true })
      await fs.cp(selectedPath, LOCAL_PLATFORM_TOOLS_DIR, { recursive: true })
    } else {
      const ext = path.extname(selectedPath).toLowerCase()
      if (ext === '.zip') {
        const zipPath = path.join(LOCAL_TOOLS_DIR, `platform-tools-custom.zip`)
        await fs.copyFile(selectedPath, zipPath)
        await fs.rm(LOCAL_PLATFORM_TOOLS_DIR, { recursive: true, force: true })
        await runExecFile("unzip", ["-oq", zipPath, "-d", LOCAL_TOOLS_DIR], 120000)
      } else {
        await fs.rm(LOCAL_PLATFORM_TOOLS_DIR, { recursive: true, force: true })
        await fs.mkdir(LOCAL_PLATFORM_TOOLS_DIR, { recursive: true })
        await fs.cp(selectedPath, path.join(LOCAL_PLATFORM_TOOLS_DIR, path.basename(selectedPath)), { recursive: true })
      }
    }
    
    if (process.platform !== "win32") {
      const adbPath = getLocalAdbPath()
      if (await pathExists(adbPath)) {
        await fs.chmod(adbPath, 0o755).catch(() => {})
      }
    }
    
    await runExecFile(getLocalAdbPath(), ["version"], 10000)
    return { ok: true, ...getPlatformToolsStatus() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("adb:install-scrcpy-files", async (_event, payload) => {
  try {
    const LOCAL_SCRCPY_DIR = path.join(LOCAL_TOOLS_DIR, "scrcpy")
    let sourcePath = String(payload?.sourcePath || "").trim()
    
    let sourceFiles = []
    
    if (sourcePath) {
      const sourceDir = sourcePath
      const entries = await fs.readdir(sourceDir, { withFileTypes: true })
      sourceFiles = entries
        .filter(e => e.isFile())
        .map(e => path.join(sourceDir, e.name))
    } else {
      const result = await dialog.showOpenDialog({
        title: "Chọn file scrcpy để cài đặt",
        filters: [
          { name: "Executable/ZIP", extensions: ["exe", "zip", "bat", "cmd"] },
          { name: "All Files", extensions: ["*"] }
        ],
        properties: ["openFile", "multiSelections"]
      })
      
      if (result.canceled || !result.filePaths || !result.filePaths.length) {
        return { ok: false, error: "Người dùng hủy chọn file" }
      }
      
      sourceFiles = result.filePaths
    }
    
    await fs.mkdir(LOCAL_SCRCPY_DIR, { recursive: true })
    
    const copiedFiles = []
    for (const filePath of sourceFiles) {
      const fileName = path.basename(filePath)
      const destPath = path.join(LOCAL_SCRCPY_DIR, fileName)
      
      const alreadyExists = await pathExists(destPath)
      if (alreadyExists) {
        copiedFiles.push({ fileName, alreadyExists: true })
        continue
      }
      
      await fs.copyFile(filePath, destPath)
      
      if (process.platform !== "win32") {
        await fs.chmod(destPath, 0o755).catch(() => {})
      }
      
      copiedFiles.push({ fileName, alreadyExists: false })
    }
    
    const allAlreadyExists = copiedFiles.every(f => f.alreadyExists)
    const firstFile = copiedFiles[0]?.fileName || ""
    
    return { 
      ok: true, 
      fileName: firstFile,
      allFiles: copiedFiles.map(f => f.fileName).join(", "),
      alreadyExists: allAlreadyExists,
      scrcpyDir: LOCAL_SCRCPY_DIR
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("tools:automa-status", async () => {
  try {
    const status = await getAutomaStatus()
    return { ok: true, ...status }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("tools:automa-install", async () => {
  try {
    const status = await installAutomaSource()
    return { ok: true, ...status }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("adb:list-devices", async () => {
  try {
    const devices = await adbListDevices()
    return { ok: true, devices }
  } catch (err) {
    return { ok: false, error: err.message, devices: [] }
  }
})

ipcMain.handle("adb:run-command", async (_event, payload) => {
  try {
    const adbCommand = await ensureAdbAvailable()
    const args = splitCommandLineArgs(payload?.command)
    if (!args.length) {
      throw new Error("Lệnh ADB trống")
    }

    const normalizedArgs =
      args[0].toLowerCase() === "adb"
        ? args.slice(1)
        : args
    if (!normalizedArgs.length) {
      throw new Error("Lệnh ADB trống")
    }

    const timeoutMs = Number(payload?.timeoutMs) > 0
      ? Math.min(120000, Math.max(2000, Number(payload.timeoutMs)))
      : 30000
    const { stdout, stderr } = await runExecFile(adbCommand, normalizedArgs, timeoutMs)
    return {
      ok: true,
      command: `adb ${normalizedArgs.join(" ")}`,
      output: `${stdout}${stderr}`.trim() || "(không có output)"
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("adb:remote-action", async (_event, payload) => {
  try {
    const adbCommand = await ensureAdbAvailable()
    const target = await resolveAdbTarget(payload)
    const action = String(payload?.action || "").trim().toLowerCase()

    let shellArgs = []
    if (action === "back") shellArgs = ["input", "keyevent", "4"]
    else if (action === "home") shellArgs = ["input", "keyevent", "3"]
    else if (action === "recent") shellArgs = ["input", "keyevent", "187"]
    else if (action === "power") shellArgs = ["input", "keyevent", "26"]
    else if (action === "volume_up") shellArgs = ["input", "keyevent", "24"]
    else if (action === "volume_down") shellArgs = ["input", "keyevent", "25"]
    else if (action === "enter") shellArgs = ["input", "keyevent", "66"]
    else if (action === "notifications") shellArgs = ["cmd", "statusbar", "expand-notifications"]
    else if (action === "text") {
      const text = adbInputText(payload?.text)
      if (!text) throw new Error("Text remote rỗng")
      shellArgs = ["input", "text", text]
    } else {
      throw new Error("Remote action không hợp lệ")
    }

    await runExecFile(adbCommand, ["-s", target.serial, "shell", ...shellArgs], 15000)
    return { ok: true, serial: target.serial, transport: target.transport, action }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("app-remote:status", async () => {
  return { ok: true, ...getAppRemoteStatus() }
})

ipcMain.handle("app-remote:start", async (_event, payload) => {
  try {
    const status = await startAppRemoteServer(payload?.port)
    return { ok: true, ...status }
  } catch (err) {
    return { ok: false, error: err.message, ...getAppRemoteStatus() }
  }
})

ipcMain.handle("app-remote:stop", async () => {
  try {
    const status = await stopAppRemoteServer()
    return { ok: true, ...status }
  } catch (err) {
    return { ok: false, error: err.message, ...getAppRemoteStatus() }
  }
})

ipcMain.handle("app-remote:adb-reverse", async (_event, payload) => {
  try {
    const adbCommand = await ensureAdbAvailable()
    const target = await resolveAdbTarget(payload)
    const remotePort = Number.parseInt(String(payload?.remotePort || appRemoteServerPort), 10)
    const localPort = Number.parseInt(String(payload?.localPort || appRemoteServerPort), 10)
    if (!Number.isFinite(remotePort) || !Number.isFinite(localPort)) {
      throw new Error("Port reverse không hợp lệ")
    }
    await runExecFile(
      adbCommand,
      ["-s", target.serial, "reverse", `tcp:${remotePort}`, `tcp:${localPort}`],
      12000
    )
    return {
      ok: true,
      serial: target.serial,
      transport: target.transport,
      reverse: `tcp:${remotePort} -> tcp:${localPort}`
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("adb:connect-wifi", async (_event, payload) => {
  try {
    const adbCommand = await ensureAdbAvailable()
    const endpoint = parseAdbEndpoint(payload?.host, payload?.port)
    if (!endpoint) {
      throw new Error("IP ADB WiFi không hợp lệ")
    }

    const devices = await adbListDevices()
    const preferredUsb = String(payload?.usbSerial || "").trim()
    const usbDevice = pickAdbDevice(devices, "usb", preferredUsb)
    if (!usbDevice || usbDevice.transport !== "usb") {
      throw new Error("Không thấy thiết bị USB để bật ADB WiFi")
    }

    await runExecFile(adbCommand, ["-s", usbDevice.serial, "tcpip", String(endpoint.port)], 15000)
    const connectResult = await runExecFile(adbCommand, ["connect", endpoint.target], 15000)

    return {
      ok: true,
      usbSerial: usbDevice.serial,
      target: endpoint.target,
      output: `${connectResult.stdout}${connectResult.stderr}`.trim()
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("adb:mirror", async (_event, payload) => {
  try {
    const adbCommand = await ensureAdbAvailable()
    const transport = String(payload?.transport || "").trim().toLowerCase()
    const preferredSerial = String(payload?.serial || "").trim()
    const scrcpyCommand = await ensureScrcpyAvailable()
    const devices = await adbListDevices()
    const target = pickAdbDevice(devices, transport, preferredSerial)
    if (!target) {
      throw new Error(missingAdbDeviceMessage(transport))
    }

    const args = ["-s", target.serial]
    const child = spawn(scrcpyCommand, args, {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        ADB: adbCommand
      }
    })
    child.unref()

    return { ok: true, serial: target.serial, transport: target.transport }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("adb:camera-open", async (_event, payload) => {
  try {
    const adbCommand = await ensureAdbAvailable()
    const transport = String(payload?.transport || "").trim().toLowerCase()
    const preferredSerial = String(payload?.serial || "").trim()
    const devices = await adbListDevices()
    const target = pickAdbDevice(devices, transport, preferredSerial)
    if (!target) {
      throw new Error(missingAdbDeviceMessage(transport))
    }

    await runExecFile(
      adbCommand,
      ["-s", target.serial, "shell", "am", "start", "-a", "android.media.action.IMAGE_CAPTURE"],
      15000
    )

    return { ok: true, serial: target.serial, transport: target.transport }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("adb:camera-shutter", async (_event, payload) => {
  try {
    const adbCommand = await ensureAdbAvailable()
    const transport = String(payload?.transport || "").trim().toLowerCase()
    const preferredSerial = String(payload?.serial || "").trim()
    const devices = await adbListDevices()
    const target = pickAdbDevice(devices, transport, preferredSerial)
    if (!target) {
      throw new Error(missingAdbDeviceMessage(transport))
    }

    await runExecFile(adbCommand, ["-s", target.serial, "shell", "input", "keyevent", "27"], 10000)
    return { ok: true, serial: target.serial, transport: target.transport }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("kqxs:crawl-save", async () => {
  try {
    const autoAgent = getAutoAgent()
    const data = await autoAgent.crawlKQXS()
    const history = await autoAgent.getHistory(50)
    return { ok: true, data, history }
  } catch (err) {
    return { ok: false, error: err.message, history: [] }
  }
})

ipcMain.handle("kqxs:get-history", async () => {
  try {
    const autoAgent = getAutoAgent()
    const history = await autoAgent.getHistory(50)
    return { ok: true, history }
  } catch (err) {
    return { ok: false, error: err.message, history: [] }
  }
})

ipcMain.handle("kqxs:get-top", async () => {
  try {
    const autoAgent = getAutoAgent()
    const top = await autoAgent.thongKe(10)
    return { ok: true, top }
  } catch (err) {
    return { ok: false, error: err.message, top: [] }
  }
})

ipcMain.handle("kqxs:get-top-by-station", async () => {
  try {
    const autoAgent = getAutoAgent()
    const topByStation = await autoAgent.thongKeTheoDai(3)
    return { ok: true, topByStation }
  } catch (err) {
    return { ok: false, error: err.message, topByStation: [] }
  }
})

ipcMain.handle("kqxs:save-manual-copy", async (_event, payload) => {
  try {
    const autoAgent = getAutoAgent()
    const text = String(payload?.text || "")
    const stationHint =
      payload?.stationHint && typeof payload.stationHint === "object"
        ? payload.stationHint
        : {}
    const saved = await autoAgent.saveManualCopy(text, stationHint)
    const history = await autoAgent.getHistory(50)
    const top = await autoAgent.thongKe(10)
    const topByStation = await autoAgent.thongKeTheoDai(3)
    return { ok: true, saved, history, top, topByStation }
  } catch (err) {
    return { ok: false, error: err.message, history: [], top: [], topByStation: [] }
  }
})

ipcMain.handle("kqxs:clear-history", async () => {
  try {
    const autoAgent = getAutoAgent()
    await autoAgent.clearHistory()
    return { ok: true, history: [], top: [], topByStation: [] }
  } catch (err) {
    return { ok: false, error: err.message, history: [], top: [], topByStation: [] }
  }
})

ipcMain.handle("dialog:open-file", async (_event, payload) => {
  try {
    const result = await dialog.showOpenDialog({
      title: payload?.title || "Chọn file",
      filters: payload?.filters || [
        { name: "All Files", extensions: ["*"] }
      ],
      properties: ["openFile"]
    })
    return result
  } catch (err) {
    return { ok: false, error: err.message, canceled: true }
  }
})

ipcMain.handle("fs:read-file", async (_event, payload) => {
  try {
    const filePath = String(payload?.path || "").trim()
    if (!filePath) {
      throw new Error("Đường dẫn file trống")
    }
    const data = await fs.readFile(filePath)
    return { ok: true, data: Array.from(data), path: filePath }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

ipcMain.handle("fs:read-file-text", async (_event, payload) => {
  try {
    const filePath = String(payload?.path || "").trim()
    if (!filePath) {
      throw new Error("Đường dẫn file trống")
    }
    const text = await fs.readFile(filePath, "utf-8")
    return { ok: true, text, path: filePath }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

let currentTerminalProcess = null

ipcMain.handle("terminal:run", async (_event, payload) => {
  const command = String(payload?.command || "").trim()
  const timeoutMs = Number(payload?.timeoutMs) > 0 ? Math.min(300000, Number(payload.timeoutMs)) : 60000
  
  if (!command) {
    return { ok: false, error: "Lệnh trống" }
  }
  
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32"
    const shell = isWindows ? "cmd.exe" : "/bin/bash"
    const shellArgs = isWindows ? ["/c", command] : ["-c", command]
    
    currentTerminalProcess = spawn(shell, shellArgs, {
      cwd: process.env.HOME || process.cwd(),
      env: { ...process.env },
      shell: false
    })
    
    let stdout = ""
    let stderr = ""
    
    currentTerminalProcess.stdout.on("data", (data) => {
      stdout += data.toString()
    })
    
    currentTerminalProcess.stderr.on("data", (data) => {
      stderr += data.toString()
    })
    
    const timeout = setTimeout(() => {
      if (currentTerminalProcess && !currentTerminalProcess.killed) {
        currentTerminalProcess.kill("SIGTERM")
        stderr += "\n[TIMEOUT] Lệnh bị dừng do quá thời gian"
      }
    }, timeoutMs)
    
    currentTerminalProcess.on("close", (code) => {
      clearTimeout(timeout)
      currentTerminalProcess = null
      resolve({
        ok: true,
        output: stdout + (stderr ? "\n" + stderr : ""),
        exitCode: code,
        error: code !== 0 ? stderr : null
      })
    })
    
    currentTerminalProcess.on("error", (err) => {
      clearTimeout(timeout)
      currentTerminalProcess = null
      resolve({
        ok: false,
        output: "",
        exitCode: -1,
        error: err.message
      })
    })
  })
})

ipcMain.handle("terminal:kill", async () => {
  try {
    if (currentTerminalProcess && !currentTerminalProcess.killed) {
      currentTerminalProcess.kill("SIGTERM")
      return { ok: true }
    }
    return { ok: false, error: "Không có lệnh đang chạy" }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})
