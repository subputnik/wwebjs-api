const axios = require('axios')
const { globalApiKey, disabledCallbacks, enableWebHook } = require('./config')
const { logger } = require('./logger')
const ChatFactory = require('whatsapp-web.js/src/factories/ChatFactory')
const Client = require('whatsapp-web.js').Client
const { Chat, Message } = require('whatsapp-web.js/src/structures')

// Trigger webhook endpoint
const triggerWebhook = (webhookURL, sessionId, dataType, data) => {
  if (enableWebHook) {
    axios.post(webhookURL, { dataType, data, sessionId }, { headers: { 'x-api-key': globalApiKey } })
      .then(() => logger.debug({ sessionId, dataType, data: data || '' }, `Webhook message sent to ${webhookURL}`))
      .catch(error => logger.error({ sessionId, dataType, err: error, data: data || '' }, `Failed to send webhook message to ${webhookURL}`))
  }
}

// Function to send a response with error status and message
const sendErrorResponse = (res, status, message) => {
  res.status(status).json({ success: false, error: message })
}

// Function to wait for a specific item not to be null
const waitForNestedObject = (rootObj, nestedPath, maxWaitTime = 10000, interval = 100) => {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const checkObject = () => {
      const nestedObj = nestedPath.split('.').reduce((obj, key) => obj ? obj[key] : undefined, rootObj)
      if (nestedObj) {
        // Nested object exists, resolve the promise
        resolve()
      } else if (Date.now() - start > maxWaitTime) {
        // Maximum wait time exceeded, reject the promise
        logger.error('Timed out waiting for nested object')
        reject(new Error('Timeout waiting for nested object'))
      } else {
        // Nested object not yet created, continue waiting
        setTimeout(checkObject, interval)
      }
    }
    checkObject()
  })
}

const isEventEnabled = (event) => {
  return !disabledCallbacks.includes(event)
}

const sendMessageSeenStatus = async (message) => {
  try {
    const chat = await message.getChat()
    await chat.sendSeen()
  } catch (error) {
    logger.error(error, 'Failed to send seen status')
  }
}

const decodeBase64 = function * (base64String) {
  const chunkSize = 1024
  for (let i = 0; i < base64String.length; i += chunkSize) {
    const chunk = base64String.slice(i, i + chunkSize)
    yield Buffer.from(chunk, 'base64')
  }
}

const sleep = function (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const exposeFunctionIfAbsent = async (page, name, fn) => {
  const exist = await page.evaluate((name) => {
    return !!window[name]
  }, name)
  if (exist) {
    return
  }
  await page.exposeFunction(name, fn)
}

const patchWWebLibrary = async (client) => {
  // MUST be run after the 'ready' event fired
  Client.prototype.getChats = async function (searchOptions = {}) {
    try {
      const chats = await this.pupPage.evaluate(async (searchOptions) => {
        return await window.WWebJS.getChats({ ...searchOptions })
      }, searchOptions)

      return chats.map(chat => ChatFactory.create(this, chat))
    } catch (error) {
      logger.error({ err: error, message: error && error.message, stack: error && error.stack }, 'Failed to get chats')
      throw error
    }
  }

  Chat.prototype.fetchMessages = async function (searchOptions) {
    const messages = await this.client.pupPage.evaluate(async (chatId, searchOptions) => {
      const msgFilter = (m) => {
        if (m.isNotification) {
          return false
        }
        if (searchOptions && searchOptions.fromMe !== undefined && m.id.fromMe !== searchOptions.fromMe) {
          return false
        }
        if (searchOptions && searchOptions.since !== undefined && Number.isFinite(searchOptions.since) && m.t < searchOptions.since) {
          return false
        }
        return true
      }

      const chat = await window.WWebJS.getChat(chatId, { getAsModel: false })
      let msgs = chat.msgs.getModelsArray().filter(msgFilter)

      if (searchOptions && searchOptions.limit > 0) {
        while (msgs.length < searchOptions.limit) {
          // whatsapp-web.js moved this around: older builds expose
          // window.Store.ConversationMsgs, 1.34.7+ uses WAWebChatLoadMessages.
          const loadedMessages = (window.Store && window.Store.ConversationMsgs)
            ? await window.Store.ConversationMsgs.loadEarlierMsgs(chat)
            : await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat })
          if (!loadedMessages || !loadedMessages.length) break
          msgs = [...loadedMessages.filter(msgFilter), ...msgs]
        }

        if (msgs.length > searchOptions.limit) {
          msgs.sort((a, b) => (a.t > b.t) ? 1 : -1)
          msgs = msgs.splice(msgs.length - searchOptions.limit)
        }
      }

      return msgs.map(m => window.WWebJS.getMessageModel(m))
    }, this.id._serialized, searchOptions)

    return messages.map(m => new Message(this.client, m))
  }

  // WhatsApp Web renamed these Store collections, but whatsapp-web.js still reads
  // the old names and getChatModel() throws "Cannot read properties of undefined
  // (reading 'update')" (upstream issues #5752/#5796, fix in PR #5779). Alias the
  // new names back; fall back to a no-op so listing chats never fails because a
  // group/newsletter metadata refresh is unavailable.
  await client.pupPage.evaluate(() => {
    const store = window.Store
    if (!store) return
    if (!store.GroupMetadata) {
      store.GroupMetadata = store.WAWebGroupMetadataCollection || { update: async () => {} }
    }
    if (!store.NewsletterMetadataCollection) {
      store.NewsletterMetadataCollection = store.WAWebNewsletterMetadataCollection || { update: async () => {} }
    }
  })

  // Some chats (notably @lid ones) make the library's getChatModel fail deep in
  // WhatsApp Web's IndexedDB layer ("IDBObjectStore.get: No key or key range
  // specified"). Wrap it so one bad chat degrades to a minimal model instead of
  // failing the whole chat listing.
  await client.pupPage.evaluate(() => {
    if (!window.WWebJS || window.WWebJS.__getChatModelPatched) return
    const originalGetChatModel = window.WWebJS.getChatModel
    window.WWebJS.getChatModel = async (chat, options = {}) => {
      try {
        return await originalGetChatModel(chat, options)
      } catch (error) {
        if (!chat || typeof chat.serialize !== 'function') {
          throw error
        }
        const model = chat.serialize()
        model.isGroup = Boolean(chat.groupMetadata)
        model.isChannel = options.isChannel === true || Boolean(chat.newsletterMetadata)
        model.lastMessage = null
        delete model.msgs
        delete model.msgUnsyncedButtonReplyMsgs
        delete model.unsyncedButtonReplies
        return model
      }
    }
    window.WWebJS.__getChatModelPatched = true
  })

  await client.pupPage.evaluate(() => {
    // hotfix for https://github.com/pedroslopez/whatsapp-web.js/pull/3643
    window.WWebJS.getChats = async (searchOptions = {}) => {
      const chatFilter = (c) => {
        if (searchOptions && searchOptions.unread === true && c.unreadCount === 0) {
          return false
        }
        if (searchOptions && searchOptions.since !== undefined && Number.isFinite(searchOptions.since) && c.t < searchOptions.since) {
          return false
        }
        return true
      }

      // 1.34.7+ dropped window.Store in favour of window.require('WAWebCollections').
      const collections = window.Store || window.require('WAWebCollections')
      const allChats = collections.Chat.getModelsArray()

      const filteredChats = allChats.filter(chatFilter)

      return await Promise.all(
        filteredChats.map(chat => window.WWebJS.getChatModel(chat))
      )
    }
  })
}

module.exports = {
  triggerWebhook,
  sendErrorResponse,
  waitForNestedObject,
  isEventEnabled,
  sendMessageSeenStatus,
  decodeBase64,
  sleep,
  exposeFunctionIfAbsent,
  patchWWebLibrary
}
