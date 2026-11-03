import assert from 'node:assert/strict'
import { beforeEach, describe, it, TestContext } from 'node:test'

import { ButtonInteraction, Collection, MessageFlags } from 'discord.js'

import { track } from './helpers.js'
import { YandexAuthError } from '../src/errors/yandexAuthError.js'
import { DatabaseService } from '../src/services/database.service.js'
import { PlayerService } from '../src/services/player.service.js'
import { describeChoice, readSettingsPanel, SettingsPanel } from '../src/services/wave-settings.js'
import { YandexMusicService } from '../src/services/yandex-music.service.js'
import { WaveChoice, WaveSettingGroup } from '../src/types/waveSettings.js'
import { LONG_NOTICE_TTL, SHORT_NOTICE_TTL } from '../src/utils/interactions.js'

const GROUPS: WaveSettingGroup[] = [
  {
    key: 'moodEnergy',
    name: 'Под настроение',
    anyName: 'Любое',
    options: [
      { seed: 'settingMoodEnergy:active', name: 'Бодрое' },
      { seed: 'settingMoodEnergy:calm', name: 'Спокойное' }
    ]
  }
]
const ACTIVE: WaveChoice = { moodEnergy: { seed: 'settingMoodEnergy:active', name: 'Бодрое' } }
const CALM: WaveChoice = { moodEnergy: { seed: 'settingMoodEnergy:calm', name: 'Спокойное' } }

/**
 * Сессия без звука: проверяем только, как PlayerService реагирует на кнопки
 */
class FakeSession {
  guildId = 'guild-1'
  owner = { discordId: 'owner', yandexId: 'yandex-owner', accessToken: 'token' }
  messageId = 'message-1'
  voiceChannelId = 'voice-1'
  currentTrack = track('11')
  waveChoice: WaveChoice = ACTIVE
  stopReason: string | null = null
  previousResult: 'ok' | 'empty' | 'failed' = 'ok'
  retuneResult = true
  calls: string[] = []

  async retune(choice: WaveChoice) {
    this.calls.push(`retune: ${describeChoice(choice)}`)
    return this.retuneResult
  }

  pause() {
    this.calls.push('pause')
    return true
  }

  resume() {
    this.calls.push('resume')
    return true
  }

  async skip() {
    this.calls.push('skip')
  }

  async previous() {
    this.calls.push('previous')
    return this.previousResult
  }

  async destroy(reason: string) {
    this.calls.push(`destroy: ${reason}`)
  }
}

interface PressOptions {
  user?: string
  messageId?: string
  serverAdmin?: boolean
  inVoiceChannel?: boolean
}

/**
 * Нажатие кнопки: вызовы методов взаимодействия записываются в calls, а ответы с компонентами — в replies
 */
function buttonInteraction(customId: string, options: PressOptions = {}) {
  const { user = 'owner', messageId = 'message-1', serverAdmin = false, inVoiceChannel = true } = options
  const calls: string[] = []
  const replies: (SettingsPanel & { flags?: number })[] = []
  const interaction = {
    customId,
    user: { id: user, username: user },
    guildId: 'guild-1',
    guild: { voiceStates: { cache: new Collection(inVoiceChannel ? [[user, { channelId: 'voice-1' }]] : []) } },
    message: { id: messageId },
    memberPermissions: { has: () => serverAdmin },
    deferUpdate: async () => calls.push('deferUpdate'),
    followUp: async (reply: SettingsPanel & { flags?: number }) => {
      calls.push(`followUp: ${reply.content}`)
      replies.push(reply)
      return { id: `notice-${calls.length}` }
    },
    deleteReply: async (target?: string) => calls.push(`deleteReply: ${target ?? '@original'}`),
    editReply: async (reply: { content: string; components?: unknown[] }) =>
      calls.push(`editReply: ${reply.content}${reply.components ? ' (без кнопок)' : ''}`),
    update: async (reply?: { content?: string; components?: unknown[] }) =>
      calls.push(reply?.content ? `update: ${reply.content}${reply.components ? ' (без кнопок)' : ''}` : 'update')
  }

  return { interaction: interaction as unknown as ButtonInteraction, calls, replies }
}

function press(customId: string, options: PressOptions = {}) {
  const { interaction, calls, replies } = buttonInteraction(customId, options)
  const done = PlayerService.getInstance().handleButton(interaction)
  return { calls, replies, done }
}

function apply(choice: WaveChoice, options: PressOptions & { playerMessageId?: string } = {}) {
  const { interaction, calls } = buttonInteraction('wave-settings:message-1:submit', options)
  const done = PlayerService.getInstance().applyWaveSettings(
    interaction,
    options.playerMessageId ?? 'message-1',
    choice
  )
  return { calls, done }
}

let session: FakeSession
let publicAccess: boolean
let savedChoices: [string, WaveChoice][]
const users: Record<string, { accessToken: string; userInfo: { id: string; nickName: string } }> = {
  owner: { accessToken: 'token-owner', userInfo: { id: 'yandex-owner', nickName: 'Owner' } },
  listener: { accessToken: 'token-listener', userInfo: { id: 'yandex-listener', nickName: 'Listener' } }
}

function stubDatabase(t: TestContext) {
  t.mock.method(DatabaseService, 'getInstance', () => ({
    getUserData: (id: string) => users[id],
    getPublicButtonsAccess: () => publicAccess,
    saveWaveChoice: (id: string, choice: WaveChoice) => savedChoices.push([id, choice])
  }))
}

beforeEach(() => {
  session = new FakeSession()
  publicAccess = false
  savedChoices = []
  const sessions = (PlayerService.getInstance() as unknown as { sessions: Map<string, unknown> }).sessions
  sessions.clear()
  sessions.set('guild-1', session)
})

describe('PlayerService: кнопки плеера', () => {
  for (const [action, expected] of [
    ['pause', 'pause'],
    ['resume', 'resume'],
    ['next', 'skip'],
    ['previous', 'previous'],
    ['stop', 'destroy: Плеер был остановлен.'],
    ['reset', 'retune: ']
  ]) {
    it(`${action}: результат виден в плеере, поэтому сообщения нет`, async t => {
      stubDatabase(t)
      const { calls, done } = press(`wave:${action}`)
      await done

      assert.deepEqual(calls, ['deferUpdate'])
      assert.deepEqual(session.calls, [expected])
    })
  }

  it('чужому пользователю без доступа объясняется отказ, и сообщение исчезает', async t => {
    stubDatabase(t)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { calls, done } = press('wave:next', { user: 'stranger' })
    await done

    assert.equal(calls.length, 2)
    assert.match(calls[1], /^followUp: Только пользователь, запустивший воспроизведение/)
    assert.deepEqual(session.calls, [])

    t.mock.timers.tick(LONG_NOTICE_TTL - 1)
    assert.ok(!calls.some(call => call.startsWith('deleteReply')))
    t.mock.timers.tick(1)
    assert.equal(calls.at(-1), 'deleteReply: notice-2')
  })

  it('при публичном доступе управлять может слушатель из того же канала', async t => {
    stubDatabase(t)
    publicAccess = true

    const inChannel = press('wave:pause', { user: 'listener' })
    await inChannel.done
    assert.deepEqual(inChannel.calls, ['deferUpdate'])

    const outside = press('wave:pause', { user: 'listener', inVoiceChannel: false })
    await outside.done
    assert.match(outside.calls[1], /^followUp: Вы должны находиться в том же голосовом канале/)
    assert.deepEqual(session.calls, ['pause'])
  })

  it('администратор сервера управляет плеером без публичного доступа', async t => {
    stubDatabase(t)
    const { calls, done } = press('wave:stop', { user: 'stranger', serverAdmin: true })
    await done

    assert.deepEqual(calls, ['deferUpdate'])
    assert.deepEqual(session.calls, ['destroy: Плеер был остановлен.'])
  })

  it('лайк подтверждается коротким уведомлением в аккаунт нажавшего', async t => {
    stubDatabase(t)
    const like = t.mock.method(YandexMusicService.getInstance(), 'likeTrack', async () => true)
    t.mock.timers.enable({ apis: ['setTimeout'] })

    const { calls, done } = press('wave:like', { user: 'listener' })
    await done

    assert.deepEqual(like.mock.calls[0].arguments, ['token-listener', 'yandex-listener', '11:100'])
    assert.equal(calls[1], 'followUp: Трек «Track 11» добавлен в «Мне нравится».')
    t.mock.timers.tick(SHORT_NOTICE_TTL)
    assert.equal(calls.at(-1), 'deleteReply: notice-2')
  })

  it('лайк без авторизации и с истёкшим токеном объясняется', async t => {
    stubDatabase(t)
    t.mock.method(YandexMusicService.getInstance(), 'likeTrack', async () => {
      throw new YandexAuthError()
    })

    const guest = press('wave:like', { user: 'guest' })
    await guest.done
    assert.match(guest.calls[1], /^followUp: Вы не авторизованы в Яндекс Музыке/)

    const expired = press('wave:like', { user: 'listener' })
    await expired.done
    assert.match(expired.calls[1], /^followUp: Ваш токен Яндекса недействителен или истёк/)
  })

  it('о сбое ⏮️ сообщается, а пустая история просто игнорируется', async t => {
    stubDatabase(t)

    session.previousResult = 'failed'
    const failed = press('wave:previous')
    await failed.done
    assert.equal(failed.calls[1], 'followUp: Не удалось воспроизвести предыдущий трек.')

    session.previousResult = 'empty'
    const empty = press('wave:previous')
    await empty.done
    assert.deepEqual(empty.calls, ['deferUpdate'])
  })

  it('кнопки старых сообщений плеера гасятся без текста', async t => {
    stubDatabase(t)

    const oldMessage = press('wave:next', { messageId: 'old-message' })
    await oldMessage.done
    assert.deepEqual(oldMessage.calls, ['update'])

    const legacyButton = press('like')
    await legacyButton.done
    assert.deepEqual(legacyButton.calls, ['update'])

    const foreignButton = press('other:button')
    await foreignButton.done
    assert.deepEqual(foreignButton.calls, [])
    assert.deepEqual(session.calls, [])
  })
})

describe('PlayerService: настройки волны', () => {
  it('⚙️ открывает панель с текущими настройками, видимую только нажавшему', async t => {
    stubDatabase(t)
    const settings = t.mock.method(YandexMusicService.getInstance(), 'getWaveSettings', async () => GROUPS)

    const { calls, replies, done } = press('wave:settings')
    await done

    assert.deepEqual(settings.mock.calls[0].arguments, ['token'], 'варианты загружаются токеном владельца плеера')
    assert.equal(calls[0], 'deferUpdate')
    assert.match(calls[1], /^followUp: Новые настройки применятся сразу/)
    assert.equal(replies[0].flags, MessageFlags.Ephemeral)
    const panel = readSettingsPanel(replies[0].components)
    assert.deepEqual(panel.groups, GROUPS)
    assert.deepEqual(panel.choice, ACTIVE)
    assert.deepEqual(session.calls, [])
  })

  it('⚙️ подчиняется тем же правилам доступа, что и остальные кнопки', async t => {
    stubDatabase(t)
    const settings = t.mock.method(YandexMusicService.getInstance(), 'getWaveSettings', async () => GROUPS)

    const { calls, done } = press('wave:settings', { user: 'stranger' })
    await done

    assert.match(calls[1], /^followUp: Только пользователь, запустивший воспроизведение/)
    assert.equal(settings.mock.callCount(), 0)
  })

  it('если настройки не загрузились, нажавший видит предупреждение', async t => {
    stubDatabase(t)
    t.mock.method(YandexMusicService.getInstance(), 'getWaveSettings', async () => {
      throw new Error('ECONNRESET')
    })

    const { calls, done } = press('wave:settings')
    await done

    assert.equal(calls[1], 'followUp: Не удалось загрузить настройки «Моей волны». Попробуйте ещё раз.')
  })

  it('сброс в плеере запоминается за владельцем, без настроек ничего не делает, о сбое сообщает', async t => {
    stubDatabase(t)

    const reset = press('wave:reset')
    await reset.done
    assert.deepEqual(savedChoices, [['owner', {}]])

    session.waveChoice = {}
    const idle = press('wave:reset')
    await idle.done
    assert.deepEqual(idle.calls, ['deferUpdate'])

    session.waveChoice = ACTIVE
    session.retuneResult = false
    const failed = press('wave:reset')
    await failed.done
    assert.equal(
      failed.calls[1],
      'followUp: Не удалось сбросить настройки, волна играет с прежними. Попробуйте ещё раз.'
    )

    assert.deepEqual(session.calls, ['retune: ', 'retune: '], 'без настроек волна не перезапускалась')
    assert.deepEqual(savedChoices, [['owner', {}]])
  })

  it('«Применить» перестраивает волну, запоминает выбор владельца и закрывает панель', async t => {
    stubDatabase(t)

    const { calls, done } = apply(CALM)
    await done

    assert.deepEqual(session.calls, ['retune: Спокойное'])
    assert.deepEqual(savedChoices, [['owner', CALM]])
    assert.deepEqual(calls, ['deferUpdate', 'deleteReply: @original'])
  })

  it('если настройки не изменились, «Применить» просто закрывает панель, а волна играет дальше', async t => {
    stubDatabase(t)

    // Сравниваются сиды, а не названия значений
    const { calls, done } = apply({ moodEnergy: { seed: 'settingMoodEnergy:active', name: 'Бодрое (новое название)' } })
    await done

    assert.deepEqual(calls, ['deferUpdate', 'deleteReply: @original'])
    assert.deepEqual(session.calls, [], 'волна не перезапускалась')
    assert.deepEqual(savedChoices, [])
  })

  it('выбор слушателя с публичным доступом меняет волну, но не запоминается за владельца', async t => {
    stubDatabase(t)
    publicAccess = true

    const { done } = apply(CALM, { user: 'listener' })
    await done

    assert.deepEqual(session.calls, ['retune: Спокойное'])
    assert.deepEqual(savedChoices, [])
  })

  it('без доступа, со старой панелью или при сбое волна не меняется, а панель объясняет почему', async t => {
    stubDatabase(t)

    const denied = apply(CALM, { user: 'stranger' })
    await denied.done
    assert.match(denied.calls[0], /^update: Только пользователь, запустивший воспроизведение/)

    const stale = apply(CALM, { playerMessageId: 'old-message' })
    await stale.done
    assert.deepEqual(stale.calls, [
      'update: Этот плеер больше не активен. Запустите волну командой `/my-wave`. (без кнопок)'
    ])

    session.retuneResult = false
    const failed = apply(CALM)
    await failed.done
    assert.deepEqual(failed.calls, [
      'deferUpdate',
      'editReply: Не удалось применить настройки, волна играет с прежними. Попробуйте ещё раз.'
    ])

    assert.deepEqual(session.calls, ['retune: Спокойное'], 'перестроить волну пытались только в последнем случае')
    assert.deepEqual(savedChoices, [])
  })
})
