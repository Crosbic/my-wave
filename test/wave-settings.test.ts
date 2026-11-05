import assert from 'node:assert/strict'
import { describe, it, TestContext } from 'node:test'

import { ChatInputCommandInteraction, Collection, MessageComponentInteraction } from 'discord.js'

import { execute } from '../src/commands/my-wave.js'
import { DatabaseService } from '../src/services/database.service.js'
import { PlayerService, StartWaveOptions } from '../src/services/player.service.js'
import {
  carouselPanel,
  describeChoice,
  isDefaultChoice,
  isReshuffle,
  parsePanelId,
  readCarouselWave,
  readSettingsPanel,
  rememberedChoice,
  sameChoice,
  sanitizeChoice,
  SettingsPanel,
  settingsPanel,
  waveSeeds,
  withCarousel
} from '../src/services/wave-settings.js'
import { YandexMusicService } from '../src/services/yandex-music.service.js'
import { CarouselWave, WaveChoice, WaveSettingGroup } from '../src/types/waveSettings.js'
import { UserFacingError } from '../src/utils/errors.js'

// Настройки в том виде, в каком их отдаёт Яндекс Музыка (сокращённо)
const GROUPS: WaveSettingGroup[] = [
  {
    key: 'activity',
    name: 'Под занятие',
    anyName: 'Любое',
    options: [
      { seed: 'activity:wake-up', name: 'Просыпаюсь' },
      { seed: 'activity:workout', name: 'Тренируюсь' }
    ]
  },
  {
    key: 'diversity',
    name: 'По характеру',
    anyName: 'Любое',
    options: [
      { seed: 'settingDiversity:favorite', name: 'Любимое' },
      { seed: 'settingDiversity:discover', name: 'Незнакомое' }
    ]
  },
  {
    key: 'moodEnergy',
    name: 'Под настроение',
    anyName: 'Любое',
    options: [
      { seed: 'settingMoodEnergy:active', name: 'Бодрое' },
      { seed: 'settingMoodEnergy:calm', name: 'Спокойное' }
    ]
  },
  {
    key: 'language',
    name: 'По языку',
    anyName: 'Любой',
    options: [
      { seed: 'settingLanguage:russian', name: 'Русский' },
      { seed: 'settingLanguage:without-words', name: 'Без слов' }
    ]
  }
]

const WORKOUT: WaveChoice = { activity: { seed: 'activity:workout', name: 'Тренируюсь' } }
const FULL: WaveChoice = {
  activity: { seed: 'activity:workout', name: 'Тренируюсь' },
  diversity: { seed: 'settingDiversity:discover', name: 'Незнакомое' },
  moodEnergy: { seed: 'settingMoodEnergy:active', name: 'Бодрое' },
  language: { seed: 'settingLanguage:russian', name: 'Русский' }
}

// Подборки карусели в том виде, в каком их отдаёт Яндекс Музыка (сокращённо)
const ELECTRONICS: CarouselWave = {
  seeds: ['genre:electronics'],
  name: 'Хочется электроники',
  description: 'Моя волна по жанру'
}
const NO_WORDS: CarouselWave = {
  seeds: ['genre:electronics', 'local-language:instrumental'],
  name: 'Электроника без слов',
  description: 'Моя волна'
}

describe('настройки волны', () => {
  it('сиды собираются как в веб-клиенте: занятие или подборка заменяют «Мою волну», остальное добавляется', () => {
    assert.deepEqual(waveSeeds({}), ['user:onyourwave'])
    assert.deepEqual(waveSeeds({ language: FULL.language, moodEnergy: FULL.moodEnergy }), [
      'user:onyourwave',
      'settingMoodEnergy:active',
      'settingLanguage:russian'
    ])
    assert.deepEqual(waveSeeds(FULL), [
      'activity:workout',
      'settingDiversity:discover',
      'settingMoodEnergy:active',
      'settingLanguage:russian'
    ])
    assert.deepEqual(waveSeeds({ wave: NO_WORDS, moodEnergy: FULL.moodEnergy }), [
      'genre:electronics',
      'local-language:instrumental',
      'settingMoodEnergy:active'
    ])
  })

  it('описание для плеера идёт в порядке групп, «Любое» не упоминается', () => {
    assert.equal(describeChoice({}), '')
    assert.equal(describeChoice({ language: FULL.language, activity: FULL.activity }), 'Тренируюсь · Русский')
    assert.equal(describeChoice({ wave: ELECTRONICS, moodEnergy: FULL.moodEnergy }), 'Хочется электроники · Бодрое')
  })

  it('настройки сравниваются по сидам, а не по названиям', () => {
    assert.ok(sameChoice({}, {}))
    assert.ok(sameChoice(WORKOUT, { activity: { seed: 'activity:workout', name: 'Другое название' } }))
    assert.ok(!sameChoice(WORKOUT, {}))
    assert.ok(!sameChoice(WORKOUT, FULL))
    assert.ok(sameChoice({ wave: ELECTRONICS }, { wave: { seeds: ['genre:electronics'], name: 'Другое название' } }))
    assert.ok(!sameChoice({ wave: ELECTRONICS }, { wave: NO_WORDS }))
    assert.ok(!sameChoice({ wave: ELECTRONICS }, {}))
  })

  it('настройки из ⚙️ ложатся поверх подборки, а занятие её заменяет', () => {
    const playing: WaveChoice = { wave: ELECTRONICS, language: FULL.language }

    assert.deepEqual(withCarousel({ moodEnergy: FULL.moodEnergy }, playing), {
      moodEnergy: FULL.moodEnergy,
      wave: ELECTRONICS
    })
    assert.deepEqual(withCarousel(WORKOUT, playing), WORKOUT)
    assert.deepEqual(withCarousel(WORKOUT, {}), WORKOUT)
    assert.ok(!isDefaultChoice({ wave: ELECTRONICS }), 'с подборки можно сбросить на обычную «Мою волну»')
  })

  it('подборка запоминается как настройка, а «Встряхнуть Мою волну» — нет', () => {
    const reshuffle: CarouselWave = { seeds: ['diversity:reshuffle_1793627542457'], name: 'Встряхнуть Мою волну' }

    assert.deepEqual(rememberedChoice({ wave: ELECTRONICS, moodEnergy: FULL.moodEnergy }), {
      wave: ELECTRONICS,
      moodEnergy: FULL.moodEnergy
    })
    assert.ok(isReshuffle(reshuffle))
    assert.ok(!isReshuffle(ELECTRONICS))
    assert.deepEqual(rememberedChoice({ wave: reshuffle, moodEnergy: FULL.moodEnergy }), {
      moodEnergy: FULL.moodEnergy
    })
  })

  it('список подборок хранит сиды в значениях пунктов и отмечает играющую подборку', () => {
    const tooLong: CarouselWave = { seeds: ['genre:' + 'x'.repeat(100)], name: 'Слишком длинные сиды' }
    const panel = carouselPanel([ELECTRONICS, NO_WORDS, tooLong], { wave: NO_WORDS }, '123')
    assert.ok(panel)

    // Через JSON, как при отправке в Discord: билдер оставляет ключи со значением undefined
    const select = JSON.parse(JSON.stringify(panel.components[0].toJSON().components[0])) as {
      custom_id: string
      options: { label: string; value: string; description?: string; default?: boolean }[]
    }
    assert.equal(select.custom_id, 'wave-settings:123:carousel')
    assert.deepEqual(select.options, [
      {
        label: 'Хочется электроники',
        value: 'genre:electronics',
        description: 'Моя волна по жанру',
        default: false
      },
      {
        label: 'Электроника без слов',
        value: 'genre:electronics,local-language:instrumental',
        description: 'Моя волна',
        default: true
      }
    ])
    assert.deepEqual(readCarouselWave(panel.components, 'genre:electronics,local-language:instrumental'), {
      seeds: ['genre:electronics', 'local-language:instrumental'],
      name: 'Электроника без слов'
    })
    assert.equal(readCarouselWave(panel.components, 'genre:unknown'), undefined)
    assert.equal(carouselPanel([tooLong], {}, '123'), null, 'показывать нечего')
  })

  it('из сохранённого выбора остаются только значения, которые Яндекс Музыка предлагает сейчас', () => {
    const saved: WaveChoice = {
      activity: { seed: 'activity:party', name: 'Вечериниться' },
      moodEnergy: { seed: 'settingMoodEnergy:active', name: 'Старое название' }
    }

    assert.deepEqual(sanitizeChoice(saved, GROUPS), {
      moodEnergy: { seed: 'settingMoodEnergy:active', name: 'Бодрое' }
    })
  })

  it('панель хранит группы и выбор в самих компонентах', () => {
    const panel = settingsPanel(GROUPS, FULL, '123')

    assert.deepEqual(readSettingsPanel(panel.components), { groups: GROUPS, choice: FULL })
    assert.deepEqual(readSettingsPanel(settingsPanel(GROUPS, {}, '123').components).choice, {})

    const json = panel.components.map(row => row.toJSON())
    assert.equal(json.length, 5, 'четыре списка и ряд кнопок')
    const buttons = json[4].components as { custom_id: string; label: string }[]
    assert.deepEqual(
      buttons.map(button => [button.custom_id, button.label]),
      [
        ['wave-settings:123:submit', 'Применить'],
        ['wave-settings:123:default', 'По умолчанию'],
        ['wave-settings:123:reset', 'Сбросить']
      ]
    )
  })

  it('разбирает customId панели и отбрасывает чужие', () => {
    assert.deepEqual(parsePanelId('wave-settings:123:moodEnergy'), { playerMessageId: '123', field: 'moodEnergy' })
    assert.equal(parsePanelId('wave-settings:123:default')?.field, 'default')
    assert.equal(parsePanelId('wave-settings:123:carousel')?.field, 'carousel')
    assert.equal(parsePanelId('wave-settings:123:unknown'), null)
    assert.equal(parsePanelId('wave:settings'), null)
  })
})

interface PanelClick {
  customId: string
  panel: SettingsPanel
  values?: string[]
}

/**
 * Нажатие на панели под плеером. Смену волны PlayerService проверяют свои тесты, здесь — только разбор панели
 */
function click(t: TestContext, { customId, panel, values }: PanelClick) {
  const updates: SettingsPanel[] = []
  const apply = t.mock.method(PlayerService.getInstance(), 'applyWaveSettings', async () => {})
  const play = t.mock.method(PlayerService.getInstance(), 'playCarouselWave', async () => {})

  const interaction = {
    customId,
    values,
    message: { components: panel.components },
    isButton: () => !values,
    isStringSelectMenu: () => !!values,
    update: async (payload: SettingsPanel) => {
      updates.push(payload)
    }
  }

  const done = PlayerService.getInstance().handleSettingsPanel(interaction as unknown as MessageComponentInteraction)
  return { done, updates, apply, play }
}

describe('панели под плеером', () => {
  it('выбор в списке обновляет панель, остальные группы не меняются', async t => {
    const panel = settingsPanel(GROUPS, WORKOUT, 'message-1')
    const { done, updates } = click(t, {
      customId: 'wave-settings:message-1:language',
      panel,
      values: ['settingLanguage:without-words']
    })
    await done

    assert.deepEqual(readSettingsPanel(updates[0].components).choice, {
      ...WORKOUT,
      language: { seed: 'settingLanguage:without-words', name: 'Без слов' }
    })

    const { done: anyDone, updates: anyUpdates } = click(t, {
      customId: 'wave-settings:message-1:activity',
      panel,
      values: ['any']
    })
    await anyDone
    assert.deepEqual(readSettingsPanel(anyUpdates[0].components).choice, {}, '«Любое» снимает выбор группы')
  })

  it('«Сбросить» ставит «Любое» во всех группах', async t => {
    const { done, updates } = click(t, {
      customId: 'wave-settings:message-1:reset',
      panel: settingsPanel(GROUPS, FULL, 'message-1')
    })
    await done

    assert.deepEqual(readSettingsPanel(updates[0].components), { groups: GROUPS, choice: {} })
  })

  it('«Применить» передаёт выбор из панели и оставляет играющую подборку', async t => {
    const { done, apply } = click(t, {
      customId: 'wave-settings:message-1:submit',
      panel: settingsPanel(GROUPS, WORKOUT, 'message-1')
    })
    await done

    assert.equal(apply.mock.callCount(), 1)
    assert.deepEqual(apply.mock.calls[0].arguments.slice(1), ['message-1', WORKOUT, { keepCarousel: true }])
  })

  it('«По умолчанию» применяет волну без настроек, что бы ни было в списках', async t => {
    const { done, apply } = click(t, {
      customId: 'wave-settings:message-1:default',
      panel: settingsPanel(GROUPS, FULL, 'message-1')
    })
    await done

    assert.deepEqual(apply.mock.calls[0].arguments.slice(1), ['message-1', {}, { keepCarousel: false }])
  })

  it('выбор в списке «🎡 Подборки» сразу передаёт подборку PlayerService', async t => {
    const { done, play, apply } = click(t, {
      customId: 'wave-settings:message-1:carousel',
      panel: carouselPanel([ELECTRONICS, NO_WORDS], {}, 'message-1')!,
      values: ['genre:electronics,local-language:instrumental']
    })
    await done

    assert.equal(play.mock.callCount(), 1)
    assert.deepEqual(play.mock.calls[0].arguments.slice(1), [
      'message-1',
      { seeds: ['genre:electronics', 'local-language:instrumental'], name: 'Электроника без слов' }
    ])
    assert.equal(apply.mock.callCount(), 0)
  })
})

// Сохранённые настройки по Discord ID: у owner — WORKOUT, у listener — ничего
const SAVED_CHOICES: Record<string, WaveChoice> = { owner: WORKOUT }

interface MyWaveCall {
  user?: string
  startWave?: (options: StartWaveOptions) => Promise<void>
}

/**
 * Вызов /my-wave. Пользователь в голосовом канале, у бота есть все права
 */
async function runMyWave(t: TestContext, { user = 'owner', startWave = async () => {} }: MyWaveCall = {}) {
  const calls: string[] = []
  const start = t.mock.method(PlayerService.getInstance(), 'startWave', startWave)
  const settings = t.mock.method(YandexMusicService.getInstance(), 'getWaveSettings', async () => GROUPS)
  t.mock.method(DatabaseService, 'getInstance', () => ({
    getUserData: (id: string) => ({ accessToken: `token-${id}`, userInfo: { id: `yandex-${id}` } }),
    getWaveChoice: (id: string) => SAVED_CHOICES[id] ?? {}
  }))

  const voiceChannel = { full: false, permissionsFor: () => ({ has: () => true }) }
  const interaction = {
    user: { id: user },
    guild: { voiceStates: { cache: new Collection([[user, { channel: voiceChannel }]]) }, members: { me: {} } },
    channel: { isThread: () => false },
    appPermissions: { has: () => true },
    replied: false,
    deferred: false,
    inCachedGuild: () => true,
    deferReply: async () => {
      interaction.deferred = true
    },
    editReply: async (reply: { content: string }) => calls.push(`editReply: ${reply.content}`),
    deleteReply: async () => calls.push('deleteReply')
  }

  await execute(interaction as unknown as ChatInputCommandInteraction)
  return { calls, start, settings }
}

describe('/my-wave', () => {
  it('сразу запускает волну с последними настройками, без панели', async t => {
    const { calls, start, settings } = await runMyWave(t)

    assert.equal(start.mock.callCount(), 1)
    assert.deepEqual(start.mock.calls[0].arguments[0].choice, WORKOUT)
    assert.equal(settings.mock.callCount(), 0, 'список настроек при запуске не загружается')
    assert.deepEqual(calls, ['deleteReply'], 'ответ на команду убирается: в канале уже появился плеер')
  })

  it('каждый запускает волну со своими настройками, чужие не подставляются', async t => {
    const owner = await runMyWave(t, { user: 'owner' })
    assert.deepEqual(owner.start.mock.calls[0].arguments[0].choice, WORKOUT)

    const listener = await runMyWave(t, { user: 'listener' })
    const options = listener.start.mock.calls[0].arguments[0]
    assert.deepEqual(options.choice, {}, 'без своих настроек — обычная «Моя волна»')
    assert.equal(options.accessToken, 'token-listener')
  })

  it('если волна не запустилась, объясняет почему', async t => {
    const { calls } = await runMyWave(t, {
      startWave: async () => {
        throw new UserFacingError('Не удалось подключиться к голосовому каналу. Попробуйте ещё раз.')
      }
    })

    assert.deepEqual(calls, ['editReply: Не удалось подключиться к голосовому каналу. Попробуйте ещё раз.'])
  })
})
