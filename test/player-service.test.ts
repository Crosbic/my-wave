import assert from 'node:assert/strict'
import { beforeEach, describe, it, TestContext } from 'node:test'

import {
  ButtonInteraction,
  Collection,
  MessageFlags,
  MessageFlagsBitField,
  StringSelectMenuInteraction
} from 'discord.js'

import { readComponentsPanel, track } from './helpers.js'
import { YandexAuthError } from '../src/errors/yandexAuthError.js'
import { DatabaseService } from '../src/services/database.service.js'
import { PlayerService } from '../src/services/player.service.js'
import { describeChoice, readCarouselWave, readSettingsPanel } from '../src/services/wave-settings.js'
import { YandexMusicService } from '../src/services/yandex-music.service.js'
import { CarouselWave, WaveChoice, WaveSettingGroup } from '../src/types/waveSettings.js'
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
const ELECTRONICS: CarouselWave = { seeds: ['genre:electronics'], name: 'Хочется электроники' }
const NO_WORDS: CarouselWave = {
  seeds: ['genre:electronics', 'local-language:instrumental'],
  name: 'Электроника без слов'
}

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
  recentTracks = [track('10'), track('9')]
  historyResult: 'ok' | 'missing' | 'failed' = 'ok'
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

  async playFromHistory(trackId: string) {
    this.calls.push(`playFromHistory: ${trackId}`)
    return this.historyResult
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
  // Кнопка на панели из компонентов V2 («📜 История»)
  componentsV2?: boolean
}

// Ответ на нажатие так, как его передаёт PlayerService
interface Reply {
  content?: string
  components: { toJSON(): unknown }[]
  flags?: number
}

/**
 * Ответ одной строкой: у панели из компонентов V2 — её тексты, у обычного сообщения — текст
 * и пометка, если кнопки и списки убраны
 */
function describeReply(reply: Reply): string {
  if (new MessageFlagsBitField(reply.flags ?? 0).has(MessageFlags.IsComponentsV2)) {
    return `[V2] ${readComponentsPanel(reply.components).texts.join(' | ')}`
  }
  return reply.content ? `${reply.content}${reply.components?.length === 0 ? ' (без кнопок)' : ''}` : ''
}

/**
 * Нажатие кнопки: вызовы методов взаимодействия записываются в calls, а ответы — в replies
 */
function buttonInteraction(customId: string, options: PressOptions = {}) {
  const { user = 'owner', messageId = 'message-1', serverAdmin = false, inVoiceChannel = true } = options
  const calls: string[] = []
  const replies: Reply[] = []
  const record = (method: string, reply?: Reply) => {
    const text = reply ? describeReply(reply) : ''
    calls.push(text ? `${method}: ${text}` : method)
    if (reply) {
      replies.push(reply)
    }
  }

  const interaction = {
    customId,
    user: { id: user, username: user },
    guildId: 'guild-1',
    guild: { voiceStates: { cache: new Collection(inVoiceChannel ? [[user, { channelId: 'voice-1' }]] : []) } },
    message: {
      id: messageId,
      flags: new MessageFlagsBitField(options.componentsV2 ? MessageFlags.IsComponentsV2 : 0)
    },
    memberPermissions: { has: () => serverAdmin },
    deferUpdate: async () => record('deferUpdate'),
    followUp: async (reply: Reply) => {
      record('followUp', reply)
      return { id: `notice-${calls.length}` }
    },
    deleteReply: async (target?: string) => calls.push(`deleteReply: ${target ?? '@original'}`),
    editReply: async (reply: Reply) => record('editReply', reply),
    update: async (reply?: Reply) => record('update', reply)
  }

  return { interaction: interaction as unknown as ButtonInteraction, calls, replies }
}

function press(customId: string, options: PressOptions = {}) {
  const { interaction, calls, replies } = buttonInteraction(customId, options)
  const done = PlayerService.getInstance().handleButton(interaction)
  return { calls, replies, done }
}

function apply(choice: WaveChoice, options: PressOptions & { playerMessageId?: string; keepCarousel?: boolean } = {}) {
  const { interaction, calls } = buttonInteraction('wave-settings:message-1:submit', options)
  const done = PlayerService.getInstance().applyWaveSettings(
    interaction,
    options.playerMessageId ?? 'message-1',
    choice,
    { keepCarousel: options.keepCarousel ?? true }
  )
  return { calls, done }
}

/**
 * Выбор подборки в списке «🎡 Подборки»
 */
function pick(wave: CarouselWave, options: PressOptions = {}) {
  const { interaction, calls } = buttonInteraction('wave-settings:message-1:carousel', options)
  const done = PlayerService.getInstance().playCarouselWave(
    interaction as unknown as StringSelectMenuInteraction,
    'message-1',
    wave
  )
  return { calls, done }
}

/**
 * Нажатие ▶️ у трека на странице page «📜 Истории»
 */
function choose(trackId: string, options: PressOptions & { playerMessageId?: string; page?: number } = {}) {
  const page = options.page ?? 0
  const { interaction, calls, replies } = buttonInteraction(`wave-settings:message-1:history-play:${page}:${trackId}`, {
    ...options,
    componentsV2: true
  })
  const done = PlayerService.getInstance().playHistoryTrack(
    interaction,
    options.playerMessageId ?? 'message-1',
    page,
    trackId
  )
  return { calls, replies, done }
}

/**
 * Листание «📜 Истории» на страницу page
 */
function turn(page: number, options: PressOptions & { playerMessageId?: string } = {}) {
  const { interaction, calls, replies } = buttonInteraction(`wave-settings:message-1:history-page:${page}`, {
    ...options,
    componentsV2: true
  })
  const done = PlayerService.getInstance().showHistoryPage(interaction, options.playerMessageId ?? 'message-1', page)
  return { calls, replies, done }
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

// Семь сыгранных треков, последний — 17: две страницы истории
const SEVEN_TRACKS = ['17', '16', '15', '14', '13', '12', '11'].map(id => track(id))

describe('PlayerService: история', () => {
  it('📜 открывает первую страницу истории, видимую только нажавшему', async t => {
    stubDatabase(t)
    session.recentTracks = SEVEN_TRACKS

    const { calls, replies, done } = press('wave:history')
    await done

    assert.deepEqual(calls, ['deferUpdate', 'followUp: [V2] ### 📜 История'])
    assert.equal(replies[0].flags, MessageFlags.Ephemeral | MessageFlags.IsComponentsV2)
    const page = readComponentsPanel(replies[0].components)
    assert.deepEqual(
      page.sections.map(section => section.button),
      ['17', '16', '15', '14', '13'].map(id => `wave-settings:message-1:history-play:0:${id}`)
    )
    assert.deepEqual(
      page.buttons.map(button => button.label),
      ['⬅️', '1 / 2', '➡️']
    )
    assert.deepEqual(session.calls, [])
  })

  it('листание собирает страницу заново по текущей истории', async t => {
    stubDatabase(t)
    session.recentTracks = SEVEN_TRACKS

    const { calls, replies, done } = turn(1)
    await done

    assert.deepEqual(calls, ['update: [V2] ### 📜 История'])
    assert.deepEqual(
      readComponentsPanel(replies[0].components).sections.map(section => section.button),
      ['wave-settings:message-1:history-play:1:12', 'wave-settings:message-1:history-play:1:11']
    )
  })

  it('без сыгранных треков 📜 ничего не показывает, а без доступа объясняет отказ', async t => {
    stubDatabase(t)

    session.recentTracks = []
    const empty = press('wave:history')
    await empty.done
    assert.deepEqual(empty.calls, ['deferUpdate'])

    session.recentTracks = [track('10')]
    const denied = press('wave:history', { user: 'stranger' })
    await denied.done
    assert.match(denied.calls[1], /^followUp: Только пользователь, запустивший воспроизведение/)
  })

  it('▶️ сразу включает трек, и история закрывается', async t => {
    stubDatabase(t)

    const { calls, done } = choose('9')
    await done

    assert.deepEqual(session.calls, ['playFromHistory: 9'])
    assert.deepEqual(calls, ['deferUpdate', 'deleteReply: @original'])
  })

  it('если трек не запустился или пропал из истории, та же страница показывается заново с пояснением', async t => {
    stubDatabase(t)
    session.recentTracks = SEVEN_TRACKS

    session.historyResult = 'failed'
    const failed = choose('12', { page: 1 })
    await failed.done
    assert.deepEqual(failed.calls, [
      'deferUpdate',
      'editReply: [V2] ### 📜 История\nНе удалось включить трек, играет прежний. Попробуйте ещё раз.'
    ])
    assert.equal(readComponentsPanel(failed.replies[0].components).buttons[1].label, '2 / 2', 'та же страница')

    session.historyResult = 'missing'
    const missing = choose('12', { page: 1 })
    await missing.done
    assert.deepEqual(missing.calls, [
      'deferUpdate',
      'editReply: [V2] ### 📜 История\nЭтого трека уже нет в истории, список обновлён.'
    ])
  })

  it('если плеер остановился, вместо истории видна причина', async t => {
    stubDatabase(t)
    session.historyResult = 'failed'
    session.stopReason = 'Токен Яндекса владельца плеера недействителен или истёк.'

    const { calls, done } = choose('9')
    await done

    assert.deepEqual(calls, ['deferUpdate', 'editReply: [V2] Токен Яндекса владельца плеера недействителен или истёк.'])
  })

  it('без доступа или со старой историей трек не включается, а вместо истории видно почему', async t => {
    stubDatabase(t)

    const denied = choose('9', { user: 'stranger' })
    await denied.done
    assert.match(denied.calls[0], /^update: \[V2\] Только пользователь, запустивший воспроизведение/)

    const stale = choose('9', { playerMessageId: 'old-message' })
    await stale.done
    assert.deepEqual(stale.calls, ['update: [V2] Этот плеер больше не активен. Запустите волну командой `/my-wave`.'])

    const staleTurn = turn(1, { playerMessageId: 'old-message' })
    await staleTurn.done
    assert.deepEqual(staleTurn.calls, stale.calls, 'листание старой истории тоже объясняет')

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

  it('выбор слушателя с публичным доступом запоминается за самим слушателем, а не за владельцем', async t => {
    stubDatabase(t)
    publicAccess = true

    const applied = apply(CALM, { user: 'listener' })
    await applied.done
    assert.deepEqual(session.calls, ['retune: Спокойное'])
    assert.deepEqual(savedChoices, [['listener', CALM]])

    const reset = press('wave:reset', { user: 'listener' })
    await reset.done
    assert.deepEqual(savedChoices.at(-1), ['listener', {}], 'сброс тоже запоминается за нажавшим')
    assert.ok(!savedChoices.some(([id]) => id === 'owner'), 'настройки владельца не тронуты')
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

describe('PlayerService: подборки карусели', () => {
  it('🎡 открывает подборки под играющую волну, видимые только нажавшему', async t => {
    stubDatabase(t)
    const carousel = t.mock.method(YandexMusicService.getInstance(), 'getWaveCarousel', async () => [ELECTRONICS])

    const { calls, replies, done } = press('wave:carousel')
    await done

    assert.deepEqual(
      carousel.mock.calls[0].arguments,
      ['token', ['user:onyourwave', 'settingMoodEnergy:active']],
      'карусель запрашивается токеном владельца с сидами играющей волны'
    )
    assert.equal(calls[1], 'followUp: Выберите подборку, и она сразу заиграет.')
    assert.equal(replies[0].flags, MessageFlags.Ephemeral)
    assert.deepEqual(readCarouselWave(replies[0].components, 'genre:electronics'), ELECTRONICS)
  })

  it('без подборок или при сбое карусели нажавший видит предупреждение', async t => {
    stubDatabase(t)
    let waves: CarouselWave[] | null = []
    t.mock.method(YandexMusicService.getInstance(), 'getWaveCarousel', async () => {
      if (!waves) {
        throw new Error('ECONNRESET')
      }
      return waves
    })

    const empty = press('wave:carousel')
    await empty.done
    assert.equal(empty.calls[1], 'followUp: Яндекс Музыка не предложила подборок. Попробуйте позже.')

    waves = null
    const failed = press('wave:carousel')
    await failed.done
    assert.equal(failed.calls[1], 'followUp: Не удалось загрузить подборки. Попробуйте ещё раз.')
  })

  it('выбранная подборка сразу играет без настроек и запоминается за выбравшим', async t => {
    stubDatabase(t)
    publicAccess = true

    const { calls, done } = pick(ELECTRONICS)
    await done

    assert.deepEqual(session.calls, ['retune: Хочется электроники'])
    assert.deepEqual(savedChoices, [['owner', { wave: ELECTRONICS }]])
    assert.deepEqual(calls, ['deferUpdate', 'deleteReply: @original'])

    const listener = pick(NO_WORDS, { user: 'listener' })
    await listener.done
    assert.deepEqual(savedChoices.at(-1), ['listener', { wave: NO_WORDS }])
  })

  it('«Встряхнуть Мою волну» играет, но не запоминается: это разовое действие', async t => {
    stubDatabase(t)

    const { done } = pick({ seeds: ['diversity:reshuffle_1793627542457'], name: 'Встряхнуть Мою волну' })
    await done

    assert.deepEqual(session.calls, ['retune: Встряхнуть Мою волну'])
    assert.deepEqual(savedChoices, [], 'запомненные настройки остаются прежними')
  })

  it('выбор играющей подборки просто закрывает список', async t => {
    stubDatabase(t)
    session.waveChoice = { wave: ELECTRONICS }

    const { calls, done } = pick({ seeds: ['genre:electronics'], name: 'Хочется электроники' })
    await done

    assert.deepEqual(session.calls, [])
    assert.deepEqual(calls, ['deferUpdate', 'deleteReply: @original'])
  })

  it('настройки из ⚙️ ложатся поверх подборки и запоминаются вместе с ней, а «По умолчанию» её убирает', async t => {
    stubDatabase(t)
    session.waveChoice = { wave: ELECTRONICS }

    const applied = apply(CALM)
    await applied.done
    assert.deepEqual(session.calls, ['retune: Хочется электроники · Спокойное'])
    assert.deepEqual(savedChoices, [['owner', { ...CALM, wave: ELECTRONICS }]])

    const reset = apply({}, { keepCarousel: false })
    await reset.done
    assert.deepEqual(session.calls.at(-1), 'retune: ')
  })
})
