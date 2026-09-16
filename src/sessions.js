const { Client, LocalAuth } = require('whatsapp-web.js')
// Used to restore window.WWebJS when the library's own re-injection (triggered
// by a page navigation) stops half way: window.Store exists but the helper does not.
const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils')
const fs = require('fs')
const path = require('path')
const sessions = new Map()
const { baseWebhookURL, sessionFolderPath, maxAttachmentSize, setMessagesAsSeen, webVersion, webVersionCacheType, recoverSessions, chromeBin, headless, dumpio, releaseBrowserLock, recoverSessionMaxAttempts, recoverSessionBaseDelayMs, recoverSessionMaxDelayMs, browserCloseTimeoutMs, unpairedSessionMaxAgeMs, sessionWatchdogIntervalMs, restoreConcurrency } = require('./config')
const { triggerWebhook, waitForNestedObject, isEventEnabled, sendMessageSeenStatus, sleep, patchWWebLibrary } = require('./utils')
const { logger } = require('./logger')
const { initWebSocketServer, terminateWebSocketServer, triggerWebSocket } = require('./websocket')

// Sessions whose setup is currently in progress, keyed by session id.
// Prevents two concurrent /session/start calls from launching two browsers
// against the same Chromium profile (which makes WhatsApp drop the session).
const pendingSessions = new Map()
// Consecutive automatic recovery attempts per session, reset once the client is ready.
const sessionRecoverAttempts = new Map()
// Sessions taken offline on purpose (unpaired for too long); their page 'close'
// handler must not restart them.
const suspendedSessions = new Set()
// Timestamp of the first QR seen for a session that is not authenticated yet.
const unpairedSince = new Map()
// Sessions currently being recovered automatically (guards re-entrancy).
const recoveringSessions = new Set()
// Sessions being stopped on purpose; their browser must not be auto-restarted.
const stoppingSessions = new Set()
// Consecutive watchdog ticks where a live page was missing the injected
// window.WWebJS helper (it disappears when WhatsApp Web navigates and the
// library fails to re-inject). Used to avoid restarting on a short blip.
const injectionFailures = new Map()
// A page rebuild can leave the page listeners attached twice (the library's own
// attach plus our defensive one at recovery). Dedupe deliveries by event type and
// message id so the same message is not reported to the webhook twice.
const seenMessageIds = new Map()
const isDuplicateDelivery = (kind, message) => {
  const id = message && message.id && message.id._serialized
  if (!id) {
    return false
  }
  const key = `${kind}:${id}`
  const now = Date.now()
  if (seenMessageIds.has(key)) {
    return true
  }
  seenMessageIds.set(key, now)
  if (seenMessageIds.size > 2000) {
    for (const [entryKey, timestamp] of seenMessageIds) {
      if (now - timestamp > 300000) {
        seenMessageIds.delete(entryKey)
      }
    }
  }
  return false
}

// Check whether a PID is still running (used to detect stale Chromium profile locks)
const isProcessAlive = (pid) => {
  if (!pid || Number.isNaN(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user
    return error.code === 'EPERM'
  }
}

// Chromium writes a SingletonLock symlink containing "<hostname>-<pid>".
// Only remove it when the owning process is gone; otherwise two browsers would
// share one profile and WhatsApp would invalidate the session.
const removeStaleBrowserLock = async (sessionId) => {
  const lockPath = path.resolve(path.join(sessionFolderPath, `session-${sessionId}`, 'SingletonLock'))
  let target
  try {
    target = await fs.promises.readlink(lockPath)
  } catch (error) {
    return
  }
  const match = /-(\d+)$/.exec(target || '')
  const lockPid = match ? parseInt(match[1], 10) : null
  if (lockPid && isProcessAlive(lockPid)) {
    logger.warn({ sessionId, lockPid, target }, 'Browser lock is held by a live process, keeping it')
    return
  }
  try {
    await fs.promises.unlink(lockPath)
    logger.warn({ sessionId, lockPid, target }, 'Removed stale browser lock file')
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to remove stale browser lock file')
  }
}

// Close the browser and make sure the OS process is really gone before the
// caller starts a new one on the same profile directory.
const closeBrowser = async (client) => {
  if (!client || !client.pupBrowser) return
  let childProcess = null
  try {
    childProcess = client.pupBrowser.process()
  } catch (error) {
    childProcess = null
  }
  try {
    await client.pupBrowser.close()
  } catch (error) {
    logger.debug({ err: error }, 'Failed to close browser gracefully')
  }
  const maxTicks = Math.max(1, Math.ceil(browserCloseTimeoutMs / 100))
  for (let tick = 0; tick < maxTicks; tick++) {
    if (!childProcess || childProcess.exitCode !== null || childProcess.signalCode !== null) {
      break
    }
    await sleep(100)
  }
  if (childProcess && childProcess.exitCode === null && childProcess.signalCode === null) {
    logger.warn({ pid: childProcess.pid }, 'Browser process did not exit in time, killing it')
    try {
      childProcess.kill('SIGKILL')
    } catch (error) {
      logger.error({ err: error }, 'Failed to kill browser process')
    }
  }
}

// Check that the library helper is still injected. Client.getState() only reads
// the WhatsApp socket state, so a page can look CONNECTED while every
// window.WWebJS call fails with
// "Cannot read properties of undefined (reading 'getChat')".
const isPageInjected = async (client) => {
  if (!client || !client.pupPage || client.pupPage.isClosed()) {
    return false
  }
  try {
    return await Promise.race([
      client.pupPage.evaluate(() => typeof window.WWebJS !== 'undefined' && typeof window.WWebJS.getChats === 'function'),
      sleep(5000).then(() => false)
    ])
  } catch (error) {
    return false
  }
}

// A page navigation makes the library rebuild window.WWebJS from scratch, which
// wipes the page-side overrides applied by patchWWebLibrary(). The helper is
// present again, so the session looks healthy, but the chat methods silently
// fall back to the buggy library versions.
const isPagePatched = async (client) => {
  if (!client || !client.pupPage || client.pupPage.isClosed()) {
    return false
  }
  try {
    return await Promise.race([
      client.pupPage.evaluate(() => Boolean(window.WWebJS && window.WWebJS.__getChatModelPatched)),
      sleep(5000).then(() => false)
    ])
  } catch (error) {
    return false
  }
}

// Re-apply the page-side overrides if they were lost. Cheap and idempotent.
const ensurePagePatched = async (client, sessionId) => {
  if (await isPagePatched(client)) {
    return true
  }
  logger.warn({ sessionId }, 'Session page lost the WWebJS overrides, re-applying')
  try {
    await patchWWebLibrary(client)
    // The overrides disappear when a navigation rebuilds the page, and that
    // rebuild can leave the page without any event subscriptions. Re-attach
    // them; duplicate deliveries are filtered by isDuplicateDelivery().
    if (client.attachEventListeners) {
      await client.attachEventListeners()
    }
    return await isPagePatched(client)
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to re-apply WWebJS overrides')
    return false
  }
}

// Restore the library helper without restarting the browser. Requires the page
// module loader to be present; throws (and is caught by the caller) otherwise.
const reinjectHelpers = async (client) => {
  if (!client || !client.pupPage || client.pupPage.isClosed()) {
    return false
  }
  await client.pupPage.evaluate(LoadUtils)
  // Defining window.WWebJS here makes the library's own sync callback believe the
  // page is already injected, so it skips attachEventListeners(). Without that
  // call the page keeps no event subscriptions and no message/chat events are
  // ever emitted. Wire them up ourselves.
  if (client.attachEventListeners) {
    await client.attachEventListeners()
  }
  // LoadUtils recreates window.WWebJS from scratch, so re-apply the overrides.
  await patchWWebLibrary(client)
  return true
}

// Restart a session after its browser or page died, with exponential backoff
// and a hard cap on consecutive attempts.
const recoverSession = async (sessionId, client, reason) => {
  if (suspendedSessions.has(sessionId) || stoppingSessions.has(sessionId)) {
    logger.warn({ sessionId, reason }, 'Session must not be recovered right now, skipping')
    return
  }
  if (recoveringSessions.has(sessionId) || pendingSessions.has(sessionId)) {
    return
  }
  recoveringSessions.add(sessionId)
  try {
    for (let attempt = 1; attempt <= recoverSessionMaxAttempts; attempt++) {
      sessionRecoverAttempts.set(sessionId, attempt)
      const delay = Math.min(recoverSessionBaseDelayMs * Math.pow(2, attempt - 1), recoverSessionMaxDelayMs)
      logger.warn({ sessionId, attempt, delay, reason }, 'Restoring session after delay')
      await sleep(delay)
      if (suspendedSessions.has(sessionId) || stoppingSessions.has(sessionId)) {
        return
      }
      sessions.delete(sessionId)
      await closeBrowser(client)
      const result = await setupSession(sessionId)
      if (result && result.success === true) {
        return
      }
      // A restart can itself fail (e.g. the new browser aborts during start).
      // Keep retrying instead of leaving the session down until someone notices.
      logger.warn({ sessionId, attempt, message: result && result.message }, 'Session restore attempt failed, retrying')
    }
    logger.error({ sessionId, reason }, 'Max session recover attempts reached, giving up')
    sessions.delete(sessionId)
  } finally {
    recoveringSessions.delete(sessionId)
  }
}

// Function to validate if the session is ready
const validateSession = async (sessionId) => {
  try {
    const returnData = { success: false, state: null, message: '' }

    // Session not Connected 😢
    if (!sessions.has(sessionId) || !sessions.get(sessionId)) {
      returnData.message = 'session_not_found'
      return returnData
    }

    const client = sessions.get(sessionId)
    // A session that is still starting must not be reported as broken: the old
    // code ignored the waitForNestedObject failure and declared it "session closed".
    if (pendingSessions.has(sessionId)) {
      return { success: false, state: null, message: 'session_initializing' }
    }
    try {
      await waitForNestedObject(client, 'pupPage')
    } catch (error) {
      return { success: false, state: null, message: 'session_initializing' }
    }

    // Wait for client.pupPage to be evaluable
    let maxRetry = 0
    while (true) {
      try {
        if (client.pupPage.isClosed()) {
          return { success: false, state: null, message: 'browser tab closed' }
        }
        await Promise.race([
          client.pupPage.evaluate('1'),
          new Promise(resolve => setTimeout(resolve, 1000))
        ])
        break
      } catch (error) {
        if (maxRetry === 2) {
          return { success: false, state: null, message: 'session closed' }
        }
        maxRetry++
        await sleep(250)
      }
    }

    const state = await client.getState()
    returnData.state = state
    if (state !== 'CONNECTED') {
      returnData.message = 'session_not_connected'
      return returnData
    }

    // getState() only proves the socket is CONNECTED; make sure the library helper
    // is injected too, otherwise the session cannot serve any chat request.
    if (!(await isPageInjected(client))) {
      returnData.message = 'session_not_connected'
      return returnData
    }

    // The helper can be present while our overrides were wiped by a navigation.
    if (!(await ensurePagePatched(client, sessionId))) {
      returnData.message = 'session_not_connected'
      return returnData
    }

    // Session Connected 🎉
    returnData.success = true
    returnData.message = 'session_connected'
    return returnData
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to validate session')
    return { success: false, state: null, message: error.message }
  }
}

// Function to handle client session restoration
const restoreSessions = () => {
  try {
    if (!fs.existsSync(sessionFolderPath)) {
      fs.mkdirSync(sessionFolderPath) // Create the session directory if it doesn't exist
    }
    // Read the contents of the folder
    fs.readdir(sessionFolderPath, async (_, files) => {
      const sessionIds = []
      for (const file of files) {
        // Use regular expression to extract the string from the folder name
        const match = file.match(/^session-(.+)$/)
        if (match) {
          sessionIds.push(match[1])
        }
      }
      logger.info({ count: sessionIds.length, concurrency: restoreConcurrency }, 'Restoring sessions')
      // Restore with a bounded worker pool: a single session that takes minutes
      // to initialize (or fails) must not hold back all the others.
      const queue = [...sessionIds]
      const worker = async () => {
        while (queue.length > 0) {
          const sessionId = queue.shift()
          logger.warn({ sessionId }, 'Existing session detected')
          try {
            await setupSession(sessionId)
          } catch (error) {
            logger.error({ sessionId, err: error }, 'Failed to restore session')
          }
        }
      }
      const workers = Array.from(
        { length: Math.max(1, Math.min(restoreConcurrency, queue.length)) },
        () => worker()
      )
      await Promise.all(workers)
    })
  } catch (error) {
    logger.error(error, 'Failed to restore sessions')
  }
}

// Start a new session (internal, no duplicate guard)
const createSession = async (sessionId) => {
  try {
    logger.info({ sessionId }, 'Session is being initiated')
    suspendedSessions.delete(sessionId)
    stoppingSessions.delete(sessionId)
    unpairedSince.delete(sessionId)
    // Disable the delete folder from the logout function (will be handled separately)
    const localAuth = new LocalAuth({ clientId: sessionId, dataPath: sessionFolderPath })
    delete localAuth.logout
    localAuth.logout = () => { }

    const clientOptions = {
      puppeteer: {
        executablePath: chromeBin,
        headless,
        dumpio,
        // Puppeteer's own CDP call timeout; the default is too tight for this
        // container and made session restarts fail with
        // "Runtime.callFunctionOn timed out".
        protocolTimeout: 180000,
        // Chromium treats a dropped D-Bus connection as fatal
        // ("FATAL:dbus/bus.cc] D-Bus connection was disconnected. Aborting.").
        // The session bus here belongs to transient login sessions, so instead of
        // connecting to it, tell Chromium to skip D-Bus ("disabled:" sentinel).
        env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'disabled:' },
        args: [
          '--autoplay-policy=user-gesture-required',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-client-side-phishing-detection',
          '--disable-component-update',
          '--disable-default-apps',
          '--disable-dev-shm-usage',
          '--disable-domain-reliability',
          '--disable-extensions',
          '--disable-features=AudioServiceOutOfProcess',
          '--disable-hang-monitor',
          '--disable-ipc-flooding-protection',
          '--disable-notifications',
          '--disable-offer-store-unmasked-wallet-cards',
          '--disable-popup-blocking',
          '--disable-print-preview',
          '--disable-prompt-on-repost',
          '--disable-renderer-backgrounding',
          '--disable-speech-api',
          '--disable-sync',
          '--disable-gpu',
          '--disable-accelerated-2d-canvas',
          '--hide-scrollbars',
          '--ignore-gpu-blacklist',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-default-browser-check',
          '--no-first-run',
          '--no-pings',
          '--password-store=basic',
          '--use-mock-keychain',
          '--disable-setuid-sandbox',
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled'
        ]
      },
      authStrategy: localAuth
    }

    if (webVersion) {
      clientOptions.webVersion = webVersion
      switch (webVersionCacheType.toLowerCase()) {
        case 'local':
          clientOptions.webVersionCache = {
            type: 'local'
          }
          break
        case 'remote':
          clientOptions.webVersionCache = {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/' + webVersion + '.html'
          }
          break
        default:
          clientOptions.webVersionCache = {
            type: 'none'
          }
      }
    }

    const client = new Client(clientOptions)
    if (releaseBrowserLock) {
      // Only a lock left behind by a dead process may be removed, otherwise two
      // browser instances would share one profile and break the session.
      await removeStaleBrowserLock(sessionId)
    }

    try {
      client.once('ready', () => {
        sessionRecoverAttempts.delete(sessionId)
        injectionFailures.delete(sessionId)
        unpairedSince.delete(sessionId)
        patchWWebLibrary(client).catch((err) => {
          logger.error({ sessionId, err }, 'Failed to patch WWebJS library')
        })
      })
      initWebSocketServer(sessionId)
      initializeEvents(client, sessionId)
      await client.initialize()
    } catch (error) {
      logger.error({ sessionId, err: error }, 'Initialize error')
      await closeBrowser(client)
      throw error
    }

    // Save the session to the Map
    sessions.set(sessionId, client)
    return { success: true, message: 'Session initiated successfully', client }
  } catch (error) {
    // initialize() can throw a bare string (e.g. 'auth timeout'), which would
    // otherwise be reported as an empty error to the API caller.
    return { success: false, message: (error && error.message) || String(error), client: null }
  }
}

// Setup Session - concurrent calls for the same id share one in-flight setup
const setupSession = async (sessionId) => {
  if (sessions.has(sessionId)) {
    return { success: false, message: `Session already exists for: ${sessionId}`, client: sessions.get(sessionId) }
  }
  if (pendingSessions.has(sessionId)) {
    return pendingSessions.get(sessionId)
  }
  const pending = createSession(sessionId).finally(() => {
    pendingSessions.delete(sessionId)
  })
  pendingSessions.set(sessionId, pending)
  return pending
}

const initializeEvents = (client, sessionId) => {
  // check if the session webhook is overridden
  const sessionWebhook = process.env[sessionId.toUpperCase() + '_WEBHOOK_URL'] || baseWebhookURL

  if (recoverSessions) {
    waitForNestedObject(client, 'pupPage').then(() => {
      const onPageLost = (reason) => {
        recoverSession(sessionId, client, reason)
          .catch(err => logger.error({ sessionId, err }, 'Failed to restore session'))
      }
      client.pupPage.once('close', function () {
        // emitted when the page closes
        onPageLost('page close')
      })
      client.pupPage.once('error', function () {
        // emitted when the page crashes
        onPageLost('page error')
      })
      // A hard browser crash (SIGSEGV / core dump) does not always emit a page
      // event, but the browser does emit 'disconnected'.
      client.pupBrowser && client.pupBrowser.once('disconnected', function () {
        onPageLost('browser disconnected')
      })
      client.pupPage
        .on('console', message => {
          const type = message.type().substr(0, 3).toUpperCase()
          logger.debug({ sessionId, type }, `Page console log: ${message.text()}`)
        })
        .on('requestfailed', request => {
          const failure = request.failure()
          if (failure) {
            logger.error({ sessionId, url: request.url() }, `Page request failed: ${failure.errorText}`)
          } else {
            logger.error({ sessionId, url: request.url() }, 'Page request failed but no failure reason provided')
          }
        })
        .on('pageerror', ({ message }) => logger.error({ sessionId, message }, 'Page error occurred'))
    }).catch(e => { })
  }

  if (isEventEnabled('auth_failure')) {
    client.on('auth_failure', (msg) => {
      triggerWebhook(sessionWebhook, sessionId, 'status', { msg })
      triggerWebSocket(sessionId, 'status', { msg })
    })
  }

  client.on('authenticated', () => {
    client.qr = null
    unpairedSince.delete(sessionId)
    if (isEventEnabled('authenticated')) {
      triggerWebhook(sessionWebhook, sessionId, 'authenticated')
      triggerWebSocket(sessionId, 'authenticated')
    }
  })

  if (isEventEnabled('call')) {
    client.on('call', (call) => {
      triggerWebhook(sessionWebhook, sessionId, 'call', { call })
      triggerWebSocket(sessionId, 'call', { call })
    })
  }

  if (isEventEnabled('change_state')) {
    client.on('change_state', state => {
      triggerWebhook(sessionWebhook, sessionId, 'change_state', { state })
      triggerWebSocket(sessionId, 'change_state', { state })
    })
  }

  client.on('disconnected', (reason) => {
    logger.warn({ sessionId, reason }, 'Session disconnected')
    if (isEventEnabled('disconnected')) {
      triggerWebhook(sessionWebhook, sessionId, 'disconnected', { reason })
      triggerWebSocket(sessionId, 'disconnected', { reason })
    }
  })

  if (isEventEnabled('group_join')) {
    client.on('group_join', (notification) => {
      triggerWebhook(sessionWebhook, sessionId, 'group_join', { notification })
      triggerWebSocket(sessionId, 'group_join', { notification })
    })
  }

  if (isEventEnabled('group_leave')) {
    client.on('group_leave', (notification) => {
      triggerWebhook(sessionWebhook, sessionId, 'group_leave', { notification })
      triggerWebSocket(sessionId, 'group_leave', { notification })
    })
  }

  if (isEventEnabled('group_admin_changed')) {
    client.on('group_admin_changed', (notification) => {
      triggerWebhook(sessionWebhook, sessionId, 'group_admin_changed', { notification })
      triggerWebSocket(sessionId, 'group_admin_changed', { notification })
    })
  }

  if (isEventEnabled('group_membership_request')) {
    client.on('group_membership_request', (notification) => {
      triggerWebhook(sessionWebhook, sessionId, 'group_membership_request', { notification })
      triggerWebSocket(sessionId, 'group_membership_request', { notification })
    })
  }

  if (isEventEnabled('group_update')) {
    client.on('group_update', (notification) => {
      triggerWebhook(sessionWebhook, sessionId, 'group_update', { notification })
      triggerWebSocket(sessionId, 'group_update', { notification })
    })
  }

  if (isEventEnabled('loading_screen')) {
    client.on('loading_screen', (percent, message) => {
      triggerWebhook(sessionWebhook, sessionId, 'loading_screen', { percent, message })
      triggerWebSocket(sessionId, 'loading_screen', { percent, message })
    })
  }

  if (isEventEnabled('media_uploaded')) {
    client.on('media_uploaded', (message) => {
      triggerWebhook(sessionWebhook, sessionId, 'media_uploaded', { message })
      triggerWebSocket(sessionId, 'media_uploaded', { message })
    })
  }

  client.on('message', async (message) => {
    if (isDuplicateDelivery('message', message)) {
      return
    }
    if (isEventEnabled('message')) {
      triggerWebhook(sessionWebhook, sessionId, 'message', { message })
      triggerWebSocket(sessionId, 'message', { message })
      if (message.hasMedia && message._data?.size < maxAttachmentSize) {
      // custom service event
        if (isEventEnabled('media')) {
          message.downloadMedia().then(messageMedia => {
            triggerWebhook(sessionWebhook, sessionId, 'media', { messageMedia, message })
            triggerWebSocket(sessionId, 'media', { messageMedia, message })
          }).catch(error => {
            logger.error({ sessionId, err: error }, 'Failed to download media')
          })
        }
      }
    }
    if (setMessagesAsSeen) {
      // small delay to ensure the message is processed before sending seen status
      await sleep(1000)
      sendMessageSeenStatus(message)
    }
  })

  if (isEventEnabled('message_ack')) {
    client.on('message_ack', (message, ack) => {
      triggerWebhook(sessionWebhook, sessionId, 'message_ack', { message, ack })
      triggerWebSocket(sessionId, 'message_ack', { message, ack })
    })
  }

  if (isEventEnabled('message_create')) {
    client.on('message_create', (message) => {
      if (isDuplicateDelivery('message_create', message)) {
        return
      }
      triggerWebhook(sessionWebhook, sessionId, 'message_create', { message })
      triggerWebSocket(sessionId, 'message_create', { message })
    })
  }

  if (isEventEnabled('message_reaction')) {
    client.on('message_reaction', (reaction) => {
      triggerWebhook(sessionWebhook, sessionId, 'message_reaction', { reaction })
      triggerWebSocket(sessionId, 'message_reaction', { reaction })
    })
  }

  if (isEventEnabled('message_edit')) {
    client.on('message_edit', (message, newBody, prevBody) => {
      triggerWebhook(sessionWebhook, sessionId, 'message_edit', { message, newBody, prevBody })
      triggerWebSocket(sessionId, 'message_edit', { message, newBody, prevBody })
    })
  }

  if (isEventEnabled('message_ciphertext')) {
    client.on('message_ciphertext', (message) => {
      triggerWebhook(sessionWebhook, sessionId, 'message_ciphertext', { message })
      triggerWebSocket(sessionId, 'message_ciphertext', { message })
    })
  }

  if (isEventEnabled('message_revoke_everyone')) {
    client.on('message_revoke_everyone', (message) => {
      triggerWebhook(sessionWebhook, sessionId, 'message_revoke_everyone', { message })
      triggerWebSocket(sessionId, 'message_revoke_everyone', { message })
    })
  }

  if (isEventEnabled('message_revoke_me')) {
    client.on('message_revoke_me', (message, revokedMsg) => {
      triggerWebhook(sessionWebhook, sessionId, 'message_revoke_me', { message, revokedMsg })
      triggerWebSocket(sessionId, 'message_revoke_me', { message, revokedMsg })
    })
  }

  client.on('qr', (qr) => {
    // inject qr code into session
    client.qr = qr
    if (unpairedSessionMaxAgeMs > 0) {
      if (!unpairedSince.has(sessionId)) {
        unpairedSince.set(sessionId, Date.now())
      }
      if (Date.now() - unpairedSince.get(sessionId) > unpairedSessionMaxAgeMs) {
        logger.warn({ sessionId }, 'Session stayed unpaired for too long, taking it offline (auth folder is kept)')
        suspendedSessions.add(sessionId)
        sessions.delete(sessionId)
        closeBrowser(client).catch(err => logger.error({ sessionId, err }, 'Failed to close suspended session browser'))
        return
      }
    }
    if (isEventEnabled('qr')) {
      triggerWebhook(sessionWebhook, sessionId, 'qr', { qr })
      triggerWebSocket(sessionId, 'qr', { qr })
    }
  })

  if (isEventEnabled('ready')) {
    client.on('ready', () => {
      triggerWebhook(sessionWebhook, sessionId, 'ready')
      triggerWebSocket(sessionId, 'ready')
    })
  }

  if (isEventEnabled('contact_changed')) {
    client.on('contact_changed', (message, oldId, newId, isContact) => {
      triggerWebhook(sessionWebhook, sessionId, 'contact_changed', { message, oldId, newId, isContact })
      triggerWebSocket(sessionId, 'contact_changed', { message, oldId, newId, isContact })
    })
  }

  if (isEventEnabled('chat_removed')) {
    client.on('chat_removed', (chat) => {
      triggerWebhook(sessionWebhook, sessionId, 'chat_removed', { chat })
      triggerWebSocket(sessionId, 'chat_removed', { chat })
    })
  }

  if (isEventEnabled('chat_archived')) {
    client.on('chat_archived', (chat, currState, prevState) => {
      triggerWebhook(sessionWebhook, sessionId, 'chat_archived', { chat, currState, prevState })
      triggerWebSocket(sessionId, 'chat_archived', { chat, currState, prevState })
    })
  }

  if (isEventEnabled('unread_count')) {
    client.on('unread_count', (chat) => {
      triggerWebhook(sessionWebhook, sessionId, 'unread_count', { chat })
      triggerWebSocket(sessionId, 'unread_count', { chat })
    })
  }

  if (isEventEnabled('vote_update')) {
    client.on('vote_update', (vote) => {
      triggerWebhook(sessionWebhook, sessionId, 'vote_update', { vote })
      triggerWebSocket(sessionId, 'vote_update', { vote })
    })
  }

  if (isEventEnabled('code')) {
    client.on('code', (code) => {
      triggerWebhook(sessionWebhook, sessionId, 'code', { code })
      triggerWebSocket(sessionId, 'code', { code })
    })
  }
}

// Function to delete client session folder
const deleteSessionFolder = async (sessionId) => {
  try {
    const targetDirPath = path.join(sessionFolderPath, `session-${sessionId}`)
    const resolvedTargetDirPath = await fs.promises.realpath(targetDirPath)
    const resolvedSessionPath = await fs.promises.realpath(sessionFolderPath)

    // Ensure the target directory path ends with a path separator
    const safeSessionPath = `${resolvedSessionPath}${path.sep}`

    // Validate the resolved target directory path is a subdirectory of the session folder path
    if (!resolvedTargetDirPath.startsWith(safeSessionPath)) {
      throw new Error('Invalid path: Directory traversal detected')
    }
    await fs.promises.rm(resolvedTargetDirPath, { recursive: true, force: true })
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Folder deletion error')
    throw error
  }
}

// Function to reload client session without removing browser cache
const reloadSession = async (sessionId) => {
  try {
    const client = sessions.get(sessionId)
    if (!client) {
      return
    }
    client.pupPage?.removeAllListeners('close')
    client.pupPage?.removeAllListeners('error')
    stoppingSessions.add(sessionId)
    await closeBrowser(client)
    suspendedSessions.delete(sessionId)
    sessions.delete(sessionId)
    await setupSession(sessionId)
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to reload session')
    throw error
  }
}

const destroySession = async (sessionId) => {
  try {
    const client = sessions.get(sessionId)
    if (!client) {
      return
    }
    client.pupPage?.removeAllListeners('close')
    client.pupPage?.removeAllListeners('error')
    try {
      await terminateWebSocketServer(sessionId)
    } catch (error) {
      logger.error({ sessionId, err: error }, 'Failed to terminate WebSocket server')
    }
    // Mark as intentionally stopped so a browser 'disconnected' event does not
    // trigger the automatic recovery.
    stoppingSessions.add(sessionId)
    await client.destroy().catch(err => logger.error({ sessionId, err }, 'Failed to destroy client'))
    await closeBrowser(client)
    suspendedSessions.delete(sessionId)
    sessions.delete(sessionId)
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to stop session')
    throw error
  }
}

const deleteSession = async (sessionId, validation) => {
  try {
    const client = sessions.get(sessionId)
    if (!client) {
      return
    }
    client.pupPage?.removeAllListeners('close')
    client.pupPage?.removeAllListeners('error')
    try {
      await terminateWebSocketServer(sessionId)
    } catch (error) {
      logger.error({ sessionId, err: error }, 'Failed to terminate WebSocket server')
    }
    // Mark as intentionally stopped so a browser 'disconnected' event does not
    // trigger the automatic recovery.
    stoppingSessions.add(sessionId)
    // Always tear the browser down, whatever the validation result said.
    // Previously a session reported as "browser tab closed"/"session closed"
    // skipped both logout and destroy, leaving an orphan Chromium process.
    try {
      if (validation.success) {
        // Client Connected, request logout
        logger.info({ sessionId }, 'Logging out session')
        await client.logout()
      } else {
        // Client not Connected, request destroy
        logger.info({ sessionId }, 'Destroying session')
        await client.destroy()
      }
    } catch (error) {
      logger.error({ sessionId, err: error }, 'Failed to logout/destroy client, closing browser anyway')
    } finally {
      await closeBrowser(client)
      suspendedSessions.delete(sessionId)
      sessions.delete(sessionId)
    }
    await deleteSessionFolder(sessionId)
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to delete session')
    throw error
  }
}

// Function to handle session flush
const flushSessions = async (deleteOnlyInactive) => {
  try {
    // Read the contents of the sessions folder
    const files = await fs.promises.readdir(sessionFolderPath)
    // Iterate through the files in the parent folder
    for (const file of files) {
      // Use regular expression to extract the string from the folder name
      const match = file.match(/^session-(.+)$/)
      if (match) {
        const sessionId = match[1]
        // Never flush a session that is still starting up.
        if (pendingSessions.has(sessionId)) {
          continue
        }
        const validation = await validateSession(sessionId)
        if (validation.message === 'session_initializing') {
          continue
        }
        if (!deleteOnlyInactive || !validation.success) {
          await deleteSession(sessionId, validation)
        }
      }
    }
  } catch (error) {
    logger.error(error, 'Failed to flush sessions')
    throw error
  }
}

// Kill all session browsers without starting them again. Used on process
// shutdown so the Chromium profile locks are released for the next start.
const shutdownSessions = async () => {
  const entries = Array.from(sessions.entries())
  for (const [sessionId, client] of entries) {
    stoppingSessions.add(sessionId)
    try {
      client.pupPage?.removeAllListeners('close')
      client.pupPage?.removeAllListeners('error')
      client.pupBrowser?.removeAllListeners('disconnected')
    } catch (error) {
      logger.debug({ err: error }, 'Failed to detach page listeners on shutdown')
    }
  }
  await Promise.all(entries.map(async ([, client]) => {
    try {
      const childProcess = client.pupBrowser?.process()
      if (childProcess && childProcess.exitCode === null && childProcess.signalCode === null) {
        childProcess.kill('SIGKILL')
      } else if (client.pupBrowser) {
        await client.pupBrowser.close()
      }
    } catch (error) {
      logger.debug({ err: error }, 'Failed to stop browser on shutdown')
    }
  }))
  sessions.clear()
}

// Periodically verify that every session still has a live browser. A hard
// Chromium crash (SIGSEGV / core dump) can leave a session silently dead
// without emitting any page event, so nothing else would notice it.
let sessionWatchdog = null
let watchdogRunning = false
const startSessionWatchdog = (intervalMs = sessionWatchdogIntervalMs) => {
  if (sessionWatchdog || !intervalMs || intervalMs <= 0) {
    return
  }
  sessionWatchdog = setInterval(async () => {
    if (watchdogRunning) {
      return
    }
    watchdogRunning = true
    for (const [sessionId, client] of sessions.entries()) {
      if (pendingSessions.has(sessionId) || recoveringSessions.has(sessionId) ||
        suspendedSessions.has(sessionId) || stoppingSessions.has(sessionId)) {
        continue
      }
      let alive = false
      try {
        alive = Boolean(client.pupBrowser) && client.pupBrowser.isConnected() &&
          Boolean(client.pupPage) && !client.pupPage.isClosed()
      } catch (error) {
        alive = false
      }
      if (!alive) {
        logger.warn({ sessionId }, 'Watchdog: session browser is gone, restoring')
        recoverSession(sessionId, client, 'watchdog')
          .catch(err => logger.error({ sessionId, err }, 'Watchdog recovery failed'))
        continue
      }
      // The browser is up, but the page may have lost the injected WWebJS helper.
      if (await isPageInjected(client)) {
        injectionFailures.delete(sessionId)
        // ...or it was rebuilt by a navigation and our overrides are gone.
        await ensurePagePatched(client, sessionId)
        continue
      }
      // Try a cheap in-place re-injection first; a browser restart is the fallback.
      let reinjected = false
      try {
        reinjected = await reinjectHelpers(client)
      } catch (error) {
        logger.warn({ sessionId, err: error }, 'Watchdog: re-injection failed')
        reinjected = false
      }
      if (reinjected && await isPageInjected(client)) {
        injectionFailures.delete(sessionId)
        logger.warn({ sessionId }, 'Watchdog: restored the WWebJS helper by re-injecting')
        continue
      }
      const failures = (injectionFailures.get(sessionId) || 0) + 1
      injectionFailures.set(sessionId, failures)
      if (failures < 2) {
        logger.warn({ sessionId, failures }, 'Watchdog: page still has no WWebJS helper, will restore if it persists')
        continue
      }
      injectionFailures.delete(sessionId)
      logger.warn({ sessionId }, 'Watchdog: page lost the WWebJS helper, restoring')
      recoverSession(sessionId, client, 'page not injected')
        .catch(err => logger.error({ sessionId, err }, 'Watchdog recovery failed'))
    }
    watchdogRunning = false
  }, intervalMs)
  if (sessionWatchdog.unref) {
    sessionWatchdog.unref()
  }
  logger.info({ intervalMs }, 'Session watchdog started')
}

module.exports = {
  sessions,
  setupSession,
  restoreSessions,
  validateSession,
  deleteSession,
  reloadSession,
  flushSessions,
  destroySession,
  shutdownSessions,
  startSessionWatchdog
}
