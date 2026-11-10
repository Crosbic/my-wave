import assert from 'node:assert/strict'
import { describe, it, TestContext } from 'node:test'

import { ButtonInteraction, ChatInputCommandInteraction, ModalSubmitInteraction } from 'discord.js'

import { AxiosError, AxiosInstance, InternalAxiosRequestConfig } from 'axios'

import { waitFor } from './helpers.js'
import { execute } from '../src/commands/login.js'
import { execute as logout } from '../src/commands/logout.js'
import { YandexAuthError } from '../src/errors/yandexAuthError.js'
import { DatabaseService } from '../src/services/database.service.js'
import { extractToken, LOGIN_PREFIX, LoginService } from '../src/services/login.service.js'
import { PlayerService } from '../src/services/player.service.js'
import { YandexMusicService } from '../src/services/yandex-music.service.js'
import { DeviceCode, deviceIdFor, DeviceTokenResult, YandexOAuthService } from '../src/services/yandex-oauth.service.js'
import { IUserData, StoredUser, YandexTokens } from '../src/types/userData.js'
import { LONG_NOTICE_TTL, SHORT_NOTICE_TTL } from '../src/utils/interactions.js'

const USER: IUserData = {
  id: 'yandex-1',
  fullName: 'Иван Петров',
  firstName: 'Иван',
  lastName: 'Петров',
  nickName: 'ivan',
  avatarUrl: '',
  hasPlus: true
}

// Опрос раз в 10 мс вместо 5 секунд. Код живёт 2 секунды, чтобы забытый в тесте вход быстро закончился сам
const CODE: DeviceCode = {
  deviceCode: 'device-code',
  userCode: 'k7m2xq9p',
  verificationUrl: 'https://ya.ru/device',
  interval: 0.01,
  expiresIn: 2
}

const YEAR = 365 * 24 * 60 * 60 * 1000
// Токены, которые Яндекс выдаёт по входу с кодом
const TOKENS: YandexTokens = { accessToken: 'new-token', refreshToken: 'refresh-token', expiresAt: Date.now() + YEAR }

const PENDING: DeviceTokenResult = { status: 'pending' }
const GRANTED: DeviceTokenResult = { status: 'granted', tokens: TOKENS }

// Кнопки неудачного входа, начатого с /login
const RETRY_BUTTONS = ['login:retry:login', 'login:manual:login']

interface Reply {
  content: string
  components: { toJSON(): { components: { custom_id?: string; url?: string }[] } }[]
}

interface Stubs {
  code?: DeviceCode
  // Ответы Яндекса на опросы по порядку. Когда они кончаются, Яндекс отвечает, что вход ещё не подтверждён
  steps?: (DeviceTokenResult | Error)[]
  hasPlus?: boolean
  userInfoError?: Error
  // Пользователи, которые уже вошли
  users?: Record<string, IUserData>
}

/**
 * Яндекс, база и плееры без сети. Опрос идёт по-настоящему, а таймеры удаления сообщений замокированы
 */
function stub(t: TestContext, { code = CODE, steps = [], hasPlus = true, userInfoError, users = {} }: Stubs = {}) {
  // Подтверждение входа удаляется через 15 секунд: такой таймер не должен держать тесты
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const oauth = YandexOAuthService.getInstance()
  const requested = t.mock.method(oauth, 'requestDeviceCode', async () => code)
  const polled = t.mock.method(oauth, 'pollDeviceToken', async () => {
    const step = steps.shift() ?? PENDING
    if (step instanceof Error) {
      throw step
    }
    return step
  })
  const userInfo = t.mock.method(YandexMusicService.getInstance(), 'getUserInfo', async () => {
    if (userInfoError) {
      throw userInfoError
    }
    return { userInfo: { ...USER, hasPlus }, hasPlus }
  })
  const revoked = t.mock.method(oauth, 'revokeToken', async () => {})
  const saved: [string, YandexTokens, IUserData][] = []
  t.mock.method(DatabaseService, 'getInstance', () => ({
    getUserData: (id: string) => (users[id] ? { accessToken: 'old-token', userInfo: users[id] } : undefined),
    hasUserToken: (id: string) => id in users,
    saveUserToken: (id: string, tokens: YandexTokens, info: IUserData) => saved.push([id, tokens, info])
  }))
  const updated = t.mock.method(PlayerService.getInstance(), 'updateOwnerToken', () => {})
  return { requested, polled, userInfo, revoked, saved, updated }
}

let messages = 0

/**
 * Вызов /login: эфемерный ответ, правки которого записываются
 */
function command(userId = 'user-1') {
  const replies: Reply[] = []
  const deleted: string[] = []
  const messageId = `message-${++messages}`
  const interaction = {
    user: { id: userId, tag: userId },
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    isButton: () => false,
    deferReply: async () => {
      interaction.deferred = true
    },
    editReply: async (reply: Reply) => {
      replies.push(reply)
      return { id: messageId }
    },
    deleteReply: async (target: string) => {
      deleted.push(target)
    }
  }
  return { interaction: interaction as unknown as ChatInputCommandInteraction, replies, deleted, messageId }
}

/**
 * Нажатие кнопки в сообщении со входом
 */
function button(customId: string, messageId: string, userId = 'user-1') {
  const calls: string[] = []
  const replies: Reply[] = []
  const modals: { toJSON(): unknown }[] = []
  const interaction = {
    customId,
    user: { id: userId, tag: userId },
    message: { id: messageId },
    deferred: false,
    replied: false,
    isChatInputCommand: () => false,
    isButton: () => true,
    isModalSubmit: () => false,
    deferUpdate: async () => {
      interaction.deferred = true
      calls.push('deferUpdate')
    },
    update: async (reply: Reply) => {
      interaction.replied = true
      replies.push(reply)
    },
    editReply: async (reply: Reply) => {
      replies.push(reply)
      return { id: messageId }
    },
    deleteReply: async (target: string) => {
      calls.push(`deleteReply: ${target}`)
    },
    showModal: async (modal: { toJSON(): unknown }) => {
      modals.push(modal)
    }
  }
  return { interaction: interaction as unknown as ButtonInteraction, calls, replies, modals }
}

/**
 * Отправка окна с токеном, открытого кнопкой из сообщения со входом
 */
function tokenSubmit(value: string, messageId: string, userId = 'user-1') {
  const replies: Reply[] = []
  const interaction = {
    customId: `${LOGIN_PREFIX}token:login`,
    user: { id: userId, tag: userId },
    message: { id: messageId },
    deferred: false,
    replied: false,
    isModalSubmit: () => true,
    isFromMessage: () => true,
    fields: { getTextInputValue: (id: string) => (id === 'token' ? value : '') },
    deferUpdate: async () => {
      interaction.deferred = true
    },
    editReply: async (reply: Reply) => {
      replies.push(reply)
      return { id: messageId }
    },
    deleteReply: async () => {}
  }
  return { interaction: interaction as unknown as ModalSubmitInteraction, replies }
}

/**
 * Кнопки сообщения: custom_id, а у кнопок-ссылок — адрес
 */
function buttonsOf(reply: Reply | undefined): string[] {
  return (reply?.components ?? [])
    .flatMap(row => row.toJSON().components)
    .map(component => component.custom_id ?? component.url ?? '')
}

function last(replies: Reply[]): Reply {
  const reply = replies.at(-1)
  assert.ok(reply, 'сообщение со входом ни разу не обновилось')
  return reply
}

describe('/login: вход по коду', () => {
  it('показывает код и ссылку, а после подтверждения сохраняет токен', async t => {
    const { polled, saved, updated } = stub(t, { steps: [PENDING, GRANTED] })
    const { interaction, replies, deleted } = command()

    await execute(interaction)

    const [codeReply] = replies
    assert.match(codeReply.content, /^Чтобы войти в Яндекс Музыку:/)
    assert.match(codeReply.content, /Откройте ya\.ru\/device/)
    assert.match(codeReply.content, /`k7m2xq9p`/)
    assert.match(codeReply.content, /Код истекает <t:\d+:R>/)
    const [link, manual, cancel] = buttonsOf(codeReply)
    assert.equal(link, 'https://ya.ru/device')
    assert.equal(manual, 'login:manual:login')
    assert.match(cancel, /^login:cancel:/)

    assert.deepEqual(
      polled.mock.calls.map(call => call.arguments[0]),
      ['device-code', 'device-code']
    )
    assert.deepEqual(saved, [['user-1', TOKENS, USER]], 'сохраняется и refresh-токен, чтобы потом продлевать вход')
    assert.deepEqual(updated.mock.calls[0].arguments, ['user-1', 'yandex-1', 'new-token'])
    assert.deepEqual(last(replies), {
      content: 'Готово! Вы вошли как ivan. Запустить волну можно командой `/my-wave`.',
      components: []
    })

    // Подтверждение исчезает само, как и прежде
    t.mock.timers.tick(LONG_NOTICE_TTL - 1)
    assert.deepEqual(deleted, [])
    t.mock.timers.tick(1)
    assert.deepEqual(deleted, ['@original'])
  })

  it('тому, кто уже вошёл, напоминает аккаунт, а после входа говорит, в какой аккаунт он вошёл', async t => {
    const { saved } = stub(t, { steps: [GRANTED], users: { 'user-1': { ...USER, nickName: 'old_nick' } } })
    const { interaction, replies } = command()

    await execute(interaction)

    assert.match(replies[0].content, /^Вы уже вошли как old\\_nick\. Если вход перестал работать/)
    assert.equal(saved.length, 1, 'повторный вход заменяет токен')
    assert.equal(last(replies).content, 'Готово! Теперь вы вошли как ivan.')
  })

  it('когда Яндекс говорит, что код истёк, предлагает новый код или токен', async t => {
    const { saved } = stub(t, { steps: [PENDING, { status: 'expired' }] })
    const { interaction, replies } = command()

    await execute(interaction)

    assert.equal(last(replies).content, 'Код истёк. Получите новый, чтобы войти.')
    assert.deepEqual(buttonsOf(last(replies)), RETRY_BUTTONS)
    assert.deepEqual(saved, [])
  })

  it('перестаёт ждать, когда срок кода вышел, даже если Яндекс всё ещё ждёт подтверждения', async t => {
    const { polled } = stub(t, { code: { ...CODE, expiresIn: 0.05 } })
    const { interaction, replies } = command()

    await execute(interaction)

    assert.equal(last(replies).content, 'Код истёк. Получите новый, чтобы войти.')
    assert.ok(polled.mock.callCount() >= 1)
  })

  it('отказ на странице Яндекса тоже можно исправить новым кодом', async t => {
    stub(t, { steps: [{ status: 'denied' }] })
    const { interaction, replies } = command()

    await execute(interaction)

    assert.equal(last(replies).content, 'Вход отклонён на странице Яндекса.')
    assert.deepEqual(buttonsOf(last(replies)), RETRY_BUTTONS)
  })

  it('сбой при опросе не прерывает вход', async t => {
    const { saved } = stub(t, { steps: [new Error('ECONNRESET'), GRANTED] })
    const { interaction, replies } = command()

    await execute(interaction)

    assert.match(last(replies).content, /^Готово!/)
    assert.equal(saved.length, 1)
  })

  it('без Яндекс Плюса токен не сохраняется и отзывается, чтобы бот не оставался в Яндекс ID', async t => {
    const { saved, updated, revoked } = stub(t, { steps: [GRANTED], hasPlus: false })
    const { interaction, replies } = command()

    await execute(interaction)

    assert.match(last(replies).content, /требуется активная подписка Яндекс Плюс/)
    assert.deepEqual(buttonsOf(last(replies)), RETRY_BUTTONS)
    assert.deepEqual(saved, [])
    assert.equal(updated.mock.callCount(), 0)
    assert.deepEqual(
      revoked.mock.calls.map(call => call.arguments[0]),
      ['new-token']
    )
  })

  it('если отозвать токен не удалось, пользователь всё равно узнаёт про Плюс', async t => {
    const { revoked } = stub(t, { steps: [GRANTED], hasPlus: false })
    revoked.mock.mockImplementation(async () => {
      throw new Error('ECONNRESET')
    })
    const { interaction, replies } = command()

    await execute(interaction)

    assert.match(last(replies).content, /требуется активная подписка Яндекс Плюс/)
  })

  it('если код не выдан, предлагает попробовать снова или войти по токену', async t => {
    const { requested } = stub(t)
    requested.mock.mockImplementation(async () => {
      throw new Error('ETIMEDOUT')
    })
    const { interaction, replies } = command()

    await execute(interaction)

    assert.match(last(replies).content, /^Не удалось получить код для входа от Яндекса/)
    assert.deepEqual(buttonsOf(last(replies)), RETRY_BUTTONS)
  })

  it('«Получить новый код» начинает вход заново в том же сообщении', async t => {
    const { saved } = stub(t, { steps: [{ status: 'expired' }, GRANTED] })
    const first = command()
    await execute(first.interaction)

    const retry = button('login:retry:login', first.messageId)
    await LoginService.getInstance().handleInteraction(retry.interaction)

    assert.equal(retry.calls[0], 'deferUpdate', 'обновляется то же сообщение, а не появляется новое')
    assert.match(retry.replies[0].content, /`k7m2xq9p`/)
    assert.match(last(retry.replies).content, /^Готово!/)
    assert.equal(saved.length, 1)
  })

  it('«Отмена» останавливает ожидание', async t => {
    const { polled } = stub(t)
    const { interaction, replies, messageId } = command()
    const done = execute(interaction)
    await waitFor(() => replies.length === 1, 'код')

    const cancel = button(buttonsOf(replies[0])[2], messageId)
    await LoginService.getInstance().handleInteraction(cancel.interaction)
    await done

    assert.deepEqual(cancel.replies, [{ content: 'Вход отменён.', components: [] }])
    const polls = polled.mock.callCount()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(polled.mock.callCount(), polls, 'Яндекс больше не опрашивается')
    t.mock.timers.tick(SHORT_NOTICE_TTL)
    assert.deepEqual(cancel.calls, ['deleteReply: @original'])
  })

  it('новый /login отменяет прежний код, а старая «Отмена» не трогает новый', async t => {
    stub(t)
    const first = command()
    const firstDone = execute(first.interaction)
    await waitFor(() => first.replies.length === 1, 'первый код')

    const second = command()
    const secondDone = execute(second.interaction)
    await firstDone
    assert.deepEqual(last(first.replies), { content: 'Этот код больше не действует.', components: [] })
    await waitFor(() => second.replies.length === 1, 'второй код')

    const staleCancel = button(buttonsOf(first.replies[0])[2], first.messageId)
    await LoginService.getInstance().handleInteraction(staleCancel.interaction)
    assert.equal(second.replies.length, 1, 'второй вход продолжается')

    const cancel = button(buttonsOf(second.replies[0])[2], second.messageId)
    await LoginService.getInstance().handleInteraction(cancel.interaction)
    await secondDone
  })
})

describe('/login: вход по токену', () => {
  it('«Ввести токен вручную» открывает окно с полем для токена', async t => {
    stub(t)
    const manual = button('login:manual:login', 'message-1')

    await LoginService.getInstance().handleInteraction(manual.interaction)

    const modal = manual.modals[0]?.toJSON() as { custom_id: string; components: unknown[] }
    assert.equal(modal.custom_id, 'login:token:login')
    assert.match(JSON.stringify(modal.components), /"custom_id":"token"/)
  })

  it('принимает и ссылку целиком, и обрывает ожидание кода', async t => {
    const { polled, saved, updated } = stub(t)
    const { interaction, replies, messageId } = command()
    const done = execute(interaction)
    await waitFor(() => replies.length === 1, 'код')

    const submit = tokenSubmit(
      ' https://music.yandex.ru/#access_token=y0_AgAAAA-token.1&token_type=bearer&expires_in=31535645 ',
      messageId
    )
    await LoginService.getInstance().handleInteraction(submit.interaction)
    await done

    assert.deepEqual(saved, [['user-1', { accessToken: 'y0_AgAAAA-token.1' }, USER]], 'без refresh-токена')
    assert.deepEqual(updated.mock.calls[0].arguments, ['user-1', 'yandex-1', 'y0_AgAAAA-token.1'])
    assert.match(last(submit.replies).content, /^Готово!/)
    assert.equal(replies.length, 1, 'сообщение с кодом не получает «код больше не действует»: в нём уже итог входа')
    const polls = polled.mock.callCount()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(polled.mock.callCount(), polls)
  })

  it('недействительный токен не сохраняется', async t => {
    const { saved } = stub(t, { userInfoError: new YandexAuthError() })
    const submit = tokenSubmit('y0_wrong', 'message-1')

    await LoginService.getInstance().handleInteraction(submit.interaction)

    assert.equal(last(submit.replies).content, 'Токен недействителен или истёк.')
    assert.deepEqual(buttonsOf(last(submit.replies)), RETRY_BUTTONS)
    assert.deepEqual(saved, [])
  })

  it('текст, не похожий на токен, даже не отправляется в Яндекс', async t => {
    const { userInfo } = stub(t)
    const submit = tokenSubmit('мой токен', 'message-1')

    await LoginService.getInstance().handleInteraction(submit.interaction)

    assert.match(last(submit.replies).content, /^Это не похоже на токен/)
    assert.equal(userInfo.mock.callCount(), 0)
  })

  it('вставленный вручную токен без Плюса не отзывается: он может работать в других приложениях', async t => {
    const { revoked } = stub(t, { hasPlus: false })
    const submit = tokenSubmit('y0_token', 'message-1')

    await LoginService.getInstance().handleInteraction(submit.interaction)

    assert.match(last(submit.replies).content, /требуется активная подписка Яндекс Плюс/)
    assert.equal(revoked.mock.callCount(), 0)
  })
})

/**
 * Вызов /logout пользователем, который вошёл с этими токенами
 */
async function runLogout(t: TestContext, stored: StoredUser | undefined, revokeError?: Error) {
  const calls: string[] = []
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const revoked = t.mock.method(YandexOAuthService.getInstance(), 'revokeToken', async () => {
    if (revokeError) {
      throw revokeError
    }
  })
  t.mock.method(DatabaseService, 'getInstance', () => ({
    hasUserToken: () => stored !== undefined,
    getUserData: () => stored,
    removeUserToken: (id: string) => calls.push(`removeUserToken: ${id}`)
  }))
  t.mock.method(PlayerService.getInstance(), 'stopSessionsOf', async (id: string, reason: string) => {
    calls.push(`stopSessionsOf: ${id}: ${reason}`)
  })

  const { interaction, replies } = command()
  await logout(interaction)
  return { calls, revoked, replies }
}

describe('/logout', () => {
  it('токен, полученный входом по коду, отзывается и в Яндексе', async t => {
    const { calls, revoked, replies } = await runLogout(t, { ...TOKENS, userInfo: USER })

    assert.deepEqual(calls, [
      'removeUserToken: user-1',
      'stopSessionsOf: user-1: Пользователь, запустивший плеер, вышел из аккаунта Яндекса.'
    ])
    assert.deepEqual(
      revoked.mock.calls.map(call => call.arguments[0]),
      ['new-token']
    )
    assert.equal(last(replies).content, 'Вы вышли из аккаунта Яндекса: бот удалил ваш токен и отозвал его в Яндексе.')
  })

  it('токен, вставленный вручную, только удаляется', async t => {
    const { calls, revoked, replies } = await runLogout(t, { accessToken: 'manual', userInfo: USER })

    assert.equal(calls[0], 'removeUserToken: user-1')
    assert.equal(revoked.mock.callCount(), 0)
    assert.equal(last(replies).content, 'Вы вышли из аккаунта Яндекса: бот удалил ваш токен.')
  })

  it('если отозвать не удалось, подсказывает, где отключить бота самому', async t => {
    const { calls, replies } = await runLogout(t, { ...TOKENS, userInfo: USER }, new Error('ETIMEDOUT'))

    assert.equal(calls[0], 'removeUserToken: user-1', 'бот всё равно забывает токен')
    assert.match(last(replies).content, /отозвать токен в Яндексе не удалось/)
    assert.match(last(replies).content, /«Discord-бот My Wave»/)
  })
})

describe('extractToken', () => {
  for (const [input, expected] of [
    ['y0_AgAAAAAB-c.d', 'y0_AgAAAAAB-c.d'],
    ['  y0_token\n', 'y0_token'],
    ['https://music.yandex.ru/#access_token=y0_token&token_type=bearer&expires_in=31535645', 'y0_token'],
    ['https://music.yandex.ru/#access_token=y0_token', 'y0_token'],
    ['access_token=y0_token&token_type=bearer', 'y0_token'],
    ['', null],
    ['мой токен', null],
    ['y0 token', null]
  ] as const) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      assert.equal(extractToken(input), expected)
    })
  }
})

/**
 * Клиент OAuth с настоящим axios, но вместо сети — ответы по порядку
 */
function oauthResponses(t: TestContext, responses: { status: number; data: unknown }[]) {
  const { http } = YandexOAuthService.getInstance() as unknown as { http: AxiosInstance }
  const adapter = http.defaults.adapter
  t.after(() => {
    http.defaults.adapter = adapter
  })

  const requests: { url?: string; body: URLSearchParams }[] = []
  http.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    requests.push({ url: config.url, body: new URLSearchParams(String(config.data)) })
    const { status, data } = responses.shift() ?? { status: 500, data: {} }
    const response = { status, statusText: '', headers: {}, config, data }
    if (status >= 400) {
      throw new AxiosError(`HTTP ${status}`, 'ERR_BAD_REQUEST', config, {}, response)
    }
    return response
  }
  return requests
}

describe('YandexOAuthService', () => {
  it('запрашивает код для постоянного устройства пользователя', async t => {
    const requests = oauthResponses(t, [
      {
        status: 200,
        data: {
          device_code: 'device',
          user_code: 'k7m2xq9p',
          verification_url: 'https://ya.ru/device',
          interval: 5,
          expires_in: 300
        }
      }
    ])

    const code = await YandexOAuthService.getInstance().requestDeviceCode('user-1')

    assert.deepEqual(code, {
      deviceCode: 'device',
      userCode: 'k7m2xq9p',
      verificationUrl: 'https://ya.ru/device',
      interval: 5,
      expiresIn: 300
    })
    const [{ url, body }] = requests
    assert.equal(url, '/device/code')
    assert.equal(body.get('client_id'), '23cabbbdc6cd418abb4b39c32c41195d')
    assert.equal(body.get('device_id'), deviceIdFor('user-1'))
    assert.equal(body.get('device_name'), 'Discord-бот My Wave')
  })

  it('разбирает ответы на опрос, а срок токена переводит в момент истечения', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    const requests = oauthResponses(t, [
      { status: 400, data: { error: 'authorization_pending' } },
      { status: 400, data: { error: 'invalid_grant', error_description: 'Code has expired' } },
      { status: 400, data: { error: 'access_denied' } },
      { status: 200, data: { access_token: 'y0_token', refresh_token: 'refresh', expires_in: 31536000 } },
      { status: 400, data: { error: 'invalid_client' } }
    ])
    const oauth = YandexOAuthService.getInstance()

    assert.deepEqual(await oauth.pollDeviceToken('device'), { status: 'pending' })
    assert.deepEqual(await oauth.pollDeviceToken('device'), { status: 'expired' })
    assert.deepEqual(await oauth.pollDeviceToken('device'), { status: 'denied' })
    assert.deepEqual(await oauth.pollDeviceToken('device'), {
      status: 'granted',
      tokens: { accessToken: 'y0_token', refreshToken: 'refresh', expiresAt: 1_000_000 + 31536000 * 1000 }
    })
    await assert.rejects(oauth.pollDeviceToken('device'), AxiosError)

    const { url, body } = requests[0]
    assert.equal(url, '/token')
    assert.equal(body.get('grant_type'), 'device_code')
    assert.equal(body.get('code'), 'device')
    assert.equal(body.get('client_secret'), '53bc75238f0c4d08a118e51fe9203300')
  })

  it('продлевает токен по refresh-токену', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    const requests = oauthResponses(t, [
      { status: 200, data: { access_token: 'y0_new', refresh_token: 'refresh-new', expires_in: 31536000 } },
      // Яндекс может оставить прежний refresh-токен и не прислать его
      { status: 200, data: { access_token: 'y0_same', expires_in: 100 } },
      { status: 400, data: { error: 'invalid_grant', error_description: 'expired_token' } },
      { status: 400, data: { error: 'invalid_client' } }
    ])
    const oauth = YandexOAuthService.getInstance()

    assert.deepEqual(await oauth.refreshTokens('refresh'), {
      accessToken: 'y0_new',
      refreshToken: 'refresh-new',
      expiresAt: 1_000_000 + 31536000 * 1000
    })
    assert.deepEqual(await oauth.refreshTokens('refresh'), {
      accessToken: 'y0_same',
      refreshToken: 'refresh',
      expiresAt: 1_000_000 + 100 * 1000
    })
    assert.equal(await oauth.refreshTokens('refresh'), null, 'отозванный refresh-токен — не сбой')
    await assert.rejects(oauth.refreshTokens('refresh'), AxiosError)

    const { url, body } = requests[0]
    assert.equal(url, '/token')
    assert.equal(body.get('grant_type'), 'refresh_token')
    assert.equal(body.get('refresh_token'), 'refresh')
    assert.equal(body.get('client_id'), '23cabbbdc6cd418abb4b39c32c41195d')
    assert.equal(body.get('client_secret'), '53bc75238f0c4d08a118e51fe9203300')
  })

  it('отзывает токен', async t => {
    const requests = oauthResponses(t, [
      { status: 200, data: { status: 'ok' } },
      { status: 400, data: { error: 'unsupported_token_type' } }
    ])
    const oauth = YandexOAuthService.getInstance()

    await oauth.revokeToken('y0_token')
    await assert.rejects(oauth.revokeToken('y0_manual'), AxiosError)

    const { url, body } = requests[0]
    assert.equal(url, '/revoke_token')
    assert.equal(body.get('access_token'), 'y0_token')
    assert.equal(body.get('client_id'), '23cabbbdc6cd418abb4b39c32c41195d')
    assert.equal(body.get('client_secret'), '53bc75238f0c4d08a118e51fe9203300')
  })

  it('устройство постоянное и своё у каждого пользователя, а Discord ID в нём не виден', () => {
    const id = deviceIdFor('123456789012345678')

    assert.equal(deviceIdFor('123456789012345678'), id)
    assert.notEqual(deviceIdFor('123456789012345679'), id)
    assert.ok(id.length >= 6 && id.length <= 50, 'Яндекс принимает от 6 до 50 символов')
    assert.ok(!id.includes('123456789012345678'))
  })
})

describe('PlayerService.updateOwnerToken', () => {
  it('переводит на новый токен только плееры того же пользователя с тем же аккаунтом', t => {
    const sessions = (PlayerService.getInstance() as unknown as { sessions: Map<string, unknown> }).sessions
    t.after(() => sessions.clear())
    const owner = (discordId: string, yandexId: string) => ({ owner: { discordId, yandexId, accessToken: 'old' } })
    const same = owner('user-1', 'yandex-1')
    const otherAccount = owner('user-1', 'yandex-2')
    const otherUser = owner('user-2', 'yandex-1')
    sessions.set('guild-1', same)
    sessions.set('guild-2', otherAccount)
    sessions.set('guild-3', otherUser)

    PlayerService.getInstance().updateOwnerToken('user-1', 'yandex-1', 'new')

    assert.equal(same.owner.accessToken, 'new')
    assert.equal(otherAccount.owner.accessToken, 'old', 'старый токен другого аккаунта продолжает работать')
    assert.equal(otherUser.owner.accessToken, 'old')
  })
})
