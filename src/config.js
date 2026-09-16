// Load environment variables from .env file
require('dotenv').config({ path: process.env.ENV_PATH || '.env' })

// setup global const
const servicePort = process.env.PORT || 3000
const sessionFolderPath = process.env.SESSIONS_PATH || './sessions'
const enableLocalCallbackExample = (process.env.ENABLE_LOCAL_CALLBACK_EXAMPLE || '').toLowerCase() === 'true'
const globalApiKey = process.env.API_KEY
const baseWebhookURL = process.env.BASE_WEBHOOK_URL
const maxAttachmentSize = parseInt(process.env.MAX_ATTACHMENT_SIZE) || 10000000
const setMessagesAsSeen = (process.env.SET_MESSAGES_AS_SEEN || '').toLowerCase() === 'true'
const disabledCallbacks = process.env.DISABLED_CALLBACKS ? process.env.DISABLED_CALLBACKS.split('|') : []
const enableSwaggerEndpoint = (process.env.ENABLE_SWAGGER_ENDPOINT || '').toLowerCase() === 'true'
const webVersion = process.env.WEB_VERSION
const webVersionCacheType = process.env.WEB_VERSION_CACHE_TYPE || 'none'
const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX) || 1000
const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 1000
const recoverSessions = (process.env.RECOVER_SESSIONS || '').toLowerCase() === 'true'
const chromeBin = process.env.CHROME_BIN || null
const headless = process.env.HEADLESS ? (process.env.HEADLESS).toLowerCase() === 'true' : true
// Pipe the Chromium stdout/stderr into our process output. Needed to see the
// message Chromium prints right before it aborts (SIGABRT / SIGSEGV).
const dumpio = (process.env.PUPPETEER_DUMPIO || '').toLowerCase() === 'true'
const releaseBrowserLock = process.env.RELEASE_BROWSER_LOCK ? (process.env.RELEASE_BROWSER_LOCK).toLowerCase() === 'true' : true
const recoverSessionMaxAttempts = parseInt(process.env.RECOVER_SESSION_MAX_ATTEMPTS) || 5
const recoverSessionBaseDelayMs = parseInt(process.env.RECOVER_SESSION_BASE_DELAY_MS) || 5000
const recoverSessionMaxDelayMs = parseInt(process.env.RECOVER_SESSION_MAX_DELAY_MS) || 300000
const browserCloseTimeoutMs = parseInt(process.env.BROWSER_CLOSE_TIMEOUT_MS) || 10000
// 0 disables the guard. When set, a session that stays unpaired (QR not scanned)
// for longer than this is taken offline to free memory; the auth folder is kept
// so the session can be linked again later through the regular start endpoint.
const unpairedSessionMaxAgeMs = parseInt(process.env.UNPAIRED_SESSION_MAX_AGE_MS) || 0
// How often to check that each session still has a live browser. 0 disables it.
const sessionWatchdogIntervalMs = process.env.SESSION_WATCHDOG_INTERVAL_MS === undefined
  ? 60000
  : (parseInt(process.env.SESSION_WATCHDOG_INTERVAL_MS, 10) || 0)
// How long /session/start may block before it answers "initiation started".
// Initializing a session can outlast a client's HTTP timeout (page load +
// auth timeout), so we answer early and let the caller poll /session/status.
const sessionStartSyncTimeoutMs = process.env.SESSION_START_SYNC_TIMEOUT_MS === undefined
  ? 20000
  : (parseInt(process.env.SESSION_START_SYNC_TIMEOUT_MS, 10) || 0)
// How many sessions are started in parallel on boot. Keeps one slow or broken
// session from delaying all the others while limiting the browser launch spike.
const restoreConcurrency = parseInt(process.env.SESSION_RESTORE_CONCURRENCY) || 3
const logLevel = process.env.LOG_LEVEL || 'info'
const enableWebHook = process.env.ENABLE_WEBHOOK ? (process.env.ENABLE_WEBHOOK).toLowerCase() === 'true' : true
const enableWebSocket = process.env.ENABLE_WEBSOCKET ? (process.env.ENABLE_WEBSOCKET).toLowerCase() === 'true' : false
const autoStartSessions = process.env.AUTO_START_SESSIONS ? (process.env.AUTO_START_SESSIONS).toLowerCase() === 'true' : true
const basePath = process.env.BASE_PATH || '/'
const trustProxy = process.env.TRUST_PROXY ? (process.env.TRUST_PROXY).toLowerCase() === 'true' : false

module.exports = {
  servicePort,
  sessionFolderPath,
  enableLocalCallbackExample,
  globalApiKey,
  baseWebhookURL,
  maxAttachmentSize,
  setMessagesAsSeen,
  disabledCallbacks,
  enableSwaggerEndpoint,
  webVersion,
  webVersionCacheType,
  rateLimitMax,
  rateLimitWindowMs,
  recoverSessions,
  chromeBin,
  headless,
  dumpio,
  releaseBrowserLock,
  recoverSessionMaxAttempts,
  recoverSessionBaseDelayMs,
  recoverSessionMaxDelayMs,
  browserCloseTimeoutMs,
  unpairedSessionMaxAgeMs,
  sessionWatchdogIntervalMs,
  sessionStartSyncTimeoutMs,
  restoreConcurrency,
  logLevel,
  enableWebHook,
  enableWebSocket,
  autoStartSessions,
  basePath,
  trustProxy
}
