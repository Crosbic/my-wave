import assert from 'node:assert/strict'
import { describe, it, TestContext } from 'node:test'

import { ButtonInteraction, ChatInputCommandInteraction, Collection, ModalSubmitInteraction } from 'discord.js'

import { createTestSession, removeDir, tempDir } from './helpers.js'
import { execute } from '../src/commands/my-wave.js'
import { YandexAuthError } from '../src/errors/yandexAuthError.js'
import { DatabaseService } from '../src/services/database.service.js'
import { LoginService } from '../src/services/login.service.js'
import { PlayerService, StartWaveOptions } from '../src/services/player.service.js'
import { WaveSession } from '../src/services/wave-session.js'
import { YandexMusicService } from '../src/services/yandex-music.service.js'
import { DeviceCode, DeviceTokenResult, YandexOAuthService } from '../src/services/yandex-oauth.service.js'
import { IUserData, YandexTokens } from '../src/types/userData.js'
import { UserFacingError } from '../src/utils/errors.js'

const DAY = 24 * 60 * 60 * 1000
const USER_ID = 'user-1'

const USER: IUserData = {
  id: 'yandex-1',
  fullName: 'Иван Петров',
  firstName: 'Иван',
  lastName: 'Петров',
  nickName: 'ivan',
  avatarUrl: '',
  hasPlus: true
}

// Опрос раз в 10 мс вместо 5 секунд
const CODE: DeviceCode = {
  deviceCode: 'device-code',
  userCode: 'k7m2xq9p',
  verificationUrl: 'https://ya.ru/device',
  interval: 0.01,
  expiresIn: 2
}

const TOKENS: YandexTokens = {
  accessToken: 'new-token',
  refreshToken: 'refresh-token',
  expiresAt: Date.now() + 365 * DAY
}
const PENDING: DeviceTokenResult = { status: 'pending' }
const GRANTED: DeviceTokenResult = { status: 'granted', tokens: TOKENS }

interface Reply {
  content: string
  components?: { toJSON(): { components: { custom_id?: string; url?: string }[] } }[]
}

interface Stubs {
  // Ответы Яндекса на опросы входа по коду. Когда они кончаются, Яндекс отвечает, что вход ещё не подтверждён
  steps?: DeviceTokenResult[]
  refresh?: (refreshToken: string) => Promise<YandexTokens | null>
  startWave?: (options: StartWaveOptions) => Promise<void>
}

/**
 * Настоящая база во временном каталоге, а Яндекс и плеер без сети
 */
function stub(t: TestContext, { steps = [], refresh = async () => null, startWave = async () => {} }: Stubs = {}) {
  // Подтверждение входа удаляется по таймеру: он не должен держать тесты
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const dir = tempDir('wave-launch')
  const db = DatabaseService.open(dir)
  t.after(() => {
    db.close()
    removeDir(dir)
  })
  t.mock.method(DatabaseService, 'getInstance', () => db)

  const oauth = YandexOAuthService.getInstance()
  t.mock.method(oauth, 'requestDeviceCode', async () => CODE)
  t.mock.method(oauth, 'pollDeviceToken', async () => steps.shift() ?? PENDING)
  const refreshed = t.mock.method(oauth, 'refreshTokens', refresh)
  t.mock.method(oauth, 'revokeToken', async () => {})
  t.mock.method(YandexMusicService.getInstance(), 'getUserInfo', async () => ({ userInfo: USER, hasPlus: true }))
  const started = t.mock.method(PlayerService.getInstance(), 'startWave', startWave)
  const updated = t.mock.method(PlayerService.getInstance(), 'updateOwnerToken', () => {})
  return { db, refreshed, started, updated }
}

interface InteractionOptions {
  kind?: 'command' | 'button' | 'modal'
  customId?: string
  inVoice?: boolean
  // Что пользователь вставил в окно с токеном
  tokenInput?: string
}

/**
 * /my-wave, кнопка или окно в эфемерном сообщении на сервере. Пользователь в голосовом канале, у бота все права
 */
function guildInteraction({
  kind = 'command',
  customId = '',
  inVoice = true,
  tokenInput = ''
}: InteractionOptions = {}) {
  const replies: Reply[] = []
  const calls: string[] = []
  const voiceChannel = { full: false, permissionsFor: () => ({ has: () => true }) }
  const voiceStates = new Collection<string, { channel: typeof voiceChannel }>()
  if (inVoice) {
    voiceStates.set(USER_ID, { channel: voiceChannel })
  }

  const interaction = {
    customId,
    user: { id: USER_ID, tag: USER_ID },
    message: { id: 'message-1' },
    guild: {
      voiceStates: {
        cache: voiceStates,
        fetch: async () => {
          throw new Error('Unknown Voice State')
        }
      },
      members: { me: {} }
    },
    channel: { isThread: () => false },
    appPermissions: { has: () => true },
    deferred: false,
    replied: false,
    inCachedGuild: () => true,
    isChatInputCommand: () => kind === 'command',
    isButton: () => kind === 'button',
    isModalSubmit: () => kind === 'modal',
    isFromMessage: () => true,
    fields: { getTextInputValue: () => tokenInput },
    deferReply: async () => {
      interaction.deferred = true
    },
    deferUpdate: async () => {
      interaction.deferred = true
      calls.push('deferUpdate')
    },
    editReply: async (reply: Reply) => {
      replies.push(reply)
      return { id: 'message-1' }
    },
    deleteReply: async (target = '@original') => {
      calls.push(`deleteReply: ${target}`)
    }
  }
  return { interaction, replies, calls }
}

function buttonsOf(reply: Reply | undefined): string[] {
  return (reply?.components ?? [])
    .flatMap(row => row.toJSON().components)
    .map(component => component.custom_id ?? component.url ?? '')
}

function contents(replies: Reply[]): string[] {
  return replies.map(reply => reply.content)
}

describe('/my-wave: продление токена', () => {
  it('токен, которому осталось меньше девяти месяцев, продлевается перед запуском', async t => {
    const fresh: YandexTokens = { accessToken: 'fresh', refreshToken: 'refresh-2', expiresAt: Date.now() + 365 * DAY }
    const { db, refreshed, started, updated } = stub(t, { refresh: async () => fresh })
    db.saveUserToken(
      USER_ID,
      { accessToken: 'old', refreshToken: 'refresh-1', expiresAt: Date.now() + 100 * DAY },
      USER
    )
    const { interaction, calls } = guildInteraction()

    await execute(interaction as unknown as ChatInputCommandInteraction)

    assert.deepEqual(
      refreshed.mock.calls.map(call => call.arguments[0]),
      ['refresh-1']
    )
    assert.equal(started.mock.calls[0].arguments[0].accessToken, 'fresh')
    assert.deepEqual(db.getUserData(USER_ID), { ...fresh, userInfo: USER })
    assert.deepEqual(updated.mock.calls[0].arguments, [USER_ID, 'yandex-1', 'fresh'], 'другие плееры тоже на новом')
    assert.deepEqual(calls, ['deleteReply: @original'])
  })

  for (const [name, tokens] of [
    ['свежий токен', { accessToken: 'old', refreshToken: 'refresh-1', expiresAt: Date.now() + 300 * DAY }],
    ['токен, вставленный вручную', { accessToken: 'old' }]
  ] as const) {
    it(`${name} не продлевается`, async t => {
      const { db, refreshed, started } = stub(t)
      db.saveUserToken(USER_ID, tokens, USER)

      await execute(guildInteraction().interaction as unknown as ChatInputCommandInteraction)

      assert.equal(refreshed.mock.callCount(), 0)
      assert.equal(started.mock.calls[0].arguments[0].accessToken, 'old')
    })
  }

  for (const [name, refresh] of [
    [
      'сбой сети',
      async () => {
        throw new Error('ECONNRESET')
      }
    ],
    ['отказ Яндекса', async () => null]
  ] as const) {
    it(`если продлить не удалось (${name}), волна запускается с прежним токеном`, async t => {
      const { db, started } = stub(t, { refresh })
      db.saveUserToken(USER_ID, { accessToken: 'old', refreshToken: 'refresh-1', expiresAt: Date.now() + DAY }, USER)

      await execute(guildInteraction().interaction as unknown as ChatInputCommandInteraction)

      assert.equal(started.mock.calls[0].arguments[0].accessToken, 'old')
      assert.equal(db.getUserData(USER_ID)?.accessToken, 'old')
    })
  }
})

describe('/my-wave: вход прямо из команды', () => {
  it('кто не вошёл, получает код, а после входа волна запускается сама', async t => {
    const { db, started } = stub(t, { steps: [PENDING, GRANTED] })
    const { interaction, replies, calls } = guildInteraction()

    await execute(interaction as unknown as ChatInputCommandInteraction)

    assert.match(replies[0].content, /^Чтобы запустить волну, войдите в Яндекс Музыку:/)
    assert.match(replies[0].content, /`k7m2xq9p`/)
    assert.match(replies[0].content, /Как только вы войдёте, я запущу волну\./)
    assert.equal(buttonsOf(replies[0])[1], 'login:manual:wave')
    assert.equal(replies.at(-1)?.content, 'Готово! Вы вошли как ivan. Запускаю волну…')
    assert.equal(started.mock.callCount(), 1)
    assert.equal(started.mock.calls[0].arguments[0].accessToken, 'new-token')
    assert.deepEqual(calls, ['deleteReply: @original'], 'сообщение со входом убирается: в канале уже появился плеер')
    assert.equal(db.getUserData(USER_ID)?.refreshToken, 'refresh-token')
  })

  it('если Яндекс отклонил токен, предлагает войти заново и запускает волну с новым токеном', async t => {
    let attempts = 0
    const { db, started } = stub(t, {
      steps: [GRANTED],
      startWave: async () => {
        if (++attempts === 1) {
          throw new YandexAuthError()
        }
      }
    })
    db.saveUserToken(USER_ID, { accessToken: 'dead' }, USER)
    const { interaction, replies, calls } = guildInteraction()

    await execute(interaction as unknown as ChatInputCommandInteraction)

    assert.match(
      replies[0].content,
      /^Вход в Яндекс Музыку истёк или был отозван\. Войдите заново, и волна запустится:/
    )
    assert.deepEqual(
      started.mock.calls.map(call => call.arguments[0].accessToken),
      ['dead', 'new-token']
    )
    assert.deepEqual(calls, ['deleteReply: @original'])
  })

  it('если после входа запустить волну не вышло, объясняет почему', async t => {
    const { started } = stub(t, { steps: [GRANTED] })
    const { interaction, replies } = guildInteraction({ inVoice: false })

    await execute(interaction as unknown as ChatInputCommandInteraction)

    assert.equal(started.mock.callCount(), 0)
    assert.deepEqual(contents(replies).slice(-2), [
      'Готово! Вы вошли как ivan. Запускаю волну…',
      'Вы вошли как ivan, но волну запустить не удалось.\n' +
        'Вы должны находиться в голосовом канале, чтобы использовать эту команду!'
    ])
  })

  it('волна запускается и после «Получить новый код»', async t => {
    const { started } = stub(t, { steps: [{ status: 'expired' }, GRANTED] })
    const first = guildInteraction()
    await execute(first.interaction as unknown as ChatInputCommandInteraction)
    assert.deepEqual(buttonsOf(first.replies.at(-1)), ['login:retry:wave', 'login:manual:wave'])
    assert.equal(started.mock.callCount(), 0)

    const retry = guildInteraction({ kind: 'button', customId: 'login:retry:wave' })
    await LoginService.getInstance().handleInteraction(retry.interaction as unknown as ButtonInteraction)

    assert.equal(started.mock.callCount(), 1)
    assert.deepEqual(retry.calls, ['deferUpdate', 'deleteReply: @original'])
  })

  it('и после входа по токену из окна', async t => {
    const { db, started } = stub(t)
    const submit = guildInteraction({ kind: 'modal', customId: 'login:token:wave', tokenInput: 'y0_manual' })

    await LoginService.getInstance().handleInteraction(submit.interaction as unknown as ModalSubmitInteraction)

    assert.equal(started.mock.calls[0].arguments[0].accessToken, 'y0_manual')
    assert.deepEqual(submit.calls, ['deferUpdate', 'deleteReply: @original'])
    assert.equal(db.getUserData(USER_ID)?.refreshToken, undefined)
  })

  it('вход по /login волну не запускает', async t => {
    const { started } = stub(t)
    const submit = guildInteraction({ kind: 'modal', customId: 'login:token:login', tokenInput: 'y0_manual' })

    await LoginService.getInstance().handleInteraction(submit.interaction as unknown as ModalSubmitInteraction)

    assert.equal(started.mock.callCount(), 0)
    assert.match(submit.replies.at(-1)?.content ?? '', /^Готово! Вы вошли как ivan\. Запустить волну можно командой/)
  })
})

describe('отклонённый токен при запуске', () => {
  it('сессия запоминает, что Яндекс отклонил токен владельца', async t => {
    const yandex = YandexMusicService.getInstance()
    t.mock.method(yandex, 'createWaveSession', async () => {
      throw new YandexAuthError()
    })
    const { session } = createTestSession()
    t.after(() => session.destroy('Конец теста'))

    assert.equal(await session.start(), false)
    assert.equal(session.tokenRejected, true)
    assert.match(session.stopReason ?? '', /войти заново командой `\/login`/)
  })

  it('другие сбои при запуске отклонённым токеном не считаются', async t => {
    t.mock.method(YandexMusicService.getInstance(), 'createWaveSession', async () => {
      throw new Error('ECONNRESET')
    })
    const { session } = createTestSession()
    t.after(() => session.destroy('Конец теста'))

    assert.equal(await session.start(), false)
    assert.equal(session.tokenRejected, false)
  })

  it('startWave бросает YandexAuthError, чтобы /my-wave предложил войти, а в остальных случаях — причину', async t => {
    const sessions = (PlayerService.getInstance() as unknown as { sessions: Map<string, unknown> }).sessions
    t.after(() => sessions.clear())
    const failedSession = (tokenRejected: boolean) => ({
      guildId: 'guild-1',
      owner: { discordId: USER_ID },
      tokenRejected,
      stopReason: 'Не удалось загрузить треки «Моей волны».',
      start: async () => false,
      destroy: async () => {}
    })
    const create = t.mock.method(WaveSession, 'create', async () => failedSession(true))
    const options = {
      user: { id: USER_ID },
      voiceChannel: { guild: { id: 'guild-1' } },
      textChannel: {},
      yandexId: 'yandex-1',
      accessToken: 'token',
      choice: {}
    } as unknown as StartWaveOptions

    await assert.rejects(PlayerService.getInstance().startWave(options), YandexAuthError)

    create.mock.mockImplementation(async () => failedSession(false))
    await assert.rejects(
      PlayerService.getInstance().startWave(options),
      (error: unknown) =>
        error instanceof UserFacingError && error.message === 'Не удалось загрузить треки «Моей волны».'
    )
  })
})
