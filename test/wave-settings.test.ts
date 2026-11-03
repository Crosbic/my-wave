import assert from 'node:assert/strict'
import { describe, it, TestContext } from 'node:test'

import { ChatInputCommandInteraction, Collection, MessageComponentInteraction } from 'discord.js'

import { execute, handleSettingsPanel } from '../src/commands/my-wave.js'
import { YandexAuthError } from '../src/errors/yandexAuthError.js'
import { DatabaseService } from '../src/services/database.service.js'
import { PlayerService, StartWaveOptions } from '../src/services/player.service.js'
import {
  describeChoice,
  parsePanelId,
  readSettingsPanel,
  sameChoice,
  sanitizeChoice,
  SettingsPanel,
  settingsPanel,
  waveSeeds
} from '../src/services/wave-settings.js'
import { YandexMusicService } from '../src/services/yandex-music.service.js'
import { WaveChoice, WaveSettingGroup } from '../src/types/waveSettings.js'

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

describe('настройки волны', () => {
  it('сиды собираются как в веб-клиенте: занятие заменяет «Мою волну», остальное добавляется', () => {
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
  })

  it('описание для плеера идёт в порядке групп, «Любое» не упоминается', () => {
    assert.equal(describeChoice({}), '')
    assert.equal(describeChoice({ language: FULL.language, activity: FULL.activity }), 'Тренируюсь · Русский')
  })

  it('настройки сравниваются по сидам, а не по названиям', () => {
    assert.ok(sameChoice({}, {}))
    assert.ok(sameChoice(WORKOUT, { activity: { seed: 'activity:workout', name: 'Другое название' } }))
    assert.ok(!sameChoice(WORKOUT, {}))
    assert.ok(!sameChoice(WORKOUT, FULL))
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
    const panel = settingsPanel(GROUPS, FULL, { kind: 'launch' })

    assert.deepEqual(readSettingsPanel(panel.components), { groups: GROUPS, choice: FULL })
    assert.deepEqual(readSettingsPanel(settingsPanel(GROUPS, {}, { kind: 'launch' }).components).choice, {})

    const json = panel.components.map(row => row.toJSON())
    assert.equal(json.length, 5, 'четыре списка и ряд кнопок')
    const buttons = json[4].components as { custom_id: string; label: string }[]
    assert.deepEqual(
      buttons.map(button => [button.custom_id, button.label]),
      [
        ['wave-settings:new:submit', '▶️ Запустить'],
        ['wave-settings:new:default', '▶️ По умолчанию'],
        ['wave-settings:new:reset', 'Сбросить']
      ]
    )

    const retune = settingsPanel(GROUPS, {}, { kind: 'retune', playerMessageId: '123' })
    const retuneButtons = retune.components[4].toJSON().components as { custom_id: string; label: string }[]
    assert.deepEqual(
      retuneButtons.map(button => [button.custom_id, button.label]),
      [
        ['wave-settings:123:submit', 'Применить'],
        ['wave-settings:123:default', 'По умолчанию'],
        ['wave-settings:123:reset', 'Сбросить']
      ]
    )
  })

  it('разбирает customId панели и отбрасывает чужие', () => {
    assert.deepEqual(parsePanelId('wave-settings:new:moodEnergy'), {
      target: { kind: 'launch' },
      field: 'moodEnergy'
    })
    assert.deepEqual(parsePanelId('wave-settings:123:submit'), {
      target: { kind: 'retune', playerMessageId: '123' },
      field: 'submit'
    })
    assert.equal(parsePanelId('wave-settings:new:default')?.field, 'default')
    assert.equal(parsePanelId('wave-settings:new:unknown'), null)
    assert.equal(parsePanelId('wave:settings'), null)
  })
})

/**
 * Части взаимодействия, которые проверяет запуск: пользователь owner в голосовом канале, у бота есть все права
 */
function ownerInVoiceChannel() {
  const voiceChannel = { full: false, permissionsFor: () => ({ has: () => true }) }
  return {
    user: { id: 'owner' },
    guildId: 'guild-1',
    guild: { voiceStates: { cache: new Collection([['owner', { channel: voiceChannel }]]) }, members: { me: {} } },
    channel: { isThread: () => false },
    appPermissions: { has: () => true }
  }
}

interface PanelClick {
  customId: string
  panel: SettingsPanel
  values?: string[]
}

/**
 * Нажатие на панели настроек
 */
function click(t: TestContext, { customId, panel, values }: PanelClick) {
  const calls: string[] = []
  const updates: SettingsPanel[] = []
  const starts: StartWaveOptions[] = []
  const saved: [string, WaveChoice][] = []

  t.mock.method(DatabaseService, 'getInstance', () => ({
    getUserData: () => ({ accessToken: 'token-owner', userInfo: { id: 'yandex-owner' } }),
    saveWaveChoice: (id: string, choice: WaveChoice) => saved.push([id, choice])
  }))
  t.mock.method(PlayerService.getInstance(), 'startWave', async (options: StartWaveOptions) => {
    starts.push(options)
  })
  const apply = t.mock.method(PlayerService.getInstance(), 'applyWaveSettings', async () => {})

  const interaction = {
    ...ownerInVoiceChannel(),
    customId,
    values,
    message: { components: panel.components },
    replied: false,
    deferred: false,
    inCachedGuild: () => true,
    isButton: () => !values,
    isStringSelectMenu: () => !!values,
    update: async (payload: SettingsPanel) => {
      updates.push(payload)
    },
    deferUpdate: async () => {
      interaction.deferred = true
      calls.push('deferUpdate')
    },
    deleteReply: async () => calls.push('deleteReply'),
    editReply: async (payload: { content: string }) => calls.push(`editReply: ${payload.content}`)
  }

  const done = handleSettingsPanel(interaction as unknown as MessageComponentInteraction)
  return { done, calls, updates, starts, saved, apply }
}

describe('панель настроек /my-wave', () => {
  it('выбор в списке обновляет панель, остальные группы не меняются', async t => {
    const panel = settingsPanel(GROUPS, WORKOUT, { kind: 'launch' })
    const { done, updates } = click(t, {
      customId: 'wave-settings:new:language',
      panel,
      values: ['settingLanguage:without-words']
    })
    await done

    assert.deepEqual(readSettingsPanel(updates[0].components).choice, {
      ...WORKOUT,
      language: { seed: 'settingLanguage:without-words', name: 'Без слов' }
    })

    const { done: anyDone, updates: anyUpdates } = click(t, {
      customId: 'wave-settings:new:activity',
      panel,
      values: ['any']
    })
    await anyDone
    assert.deepEqual(readSettingsPanel(anyUpdates[0].components).choice, {}, '«Любое» снимает выбор группы')
  })

  it('«Сбросить» ставит «Любое» во всех группах', async t => {
    const { done, updates } = click(t, {
      customId: 'wave-settings:new:reset',
      panel: settingsPanel(GROUPS, FULL, { kind: 'launch' })
    })
    await done

    assert.deepEqual(readSettingsPanel(updates[0].components), { groups: GROUPS, choice: {} })
  })

  it('«Запустить» запускает волну с выбором из панели, запоминает его и убирает панель', async t => {
    const { done, calls, starts, saved } = click(t, {
      customId: 'wave-settings:new:submit',
      panel: settingsPanel(GROUPS, FULL, { kind: 'launch' })
    })
    await done

    assert.equal(starts.length, 1)
    assert.deepEqual(starts[0].choice, FULL)
    assert.equal(starts[0].accessToken, 'token-owner')
    assert.deepEqual(saved, [['owner', FULL]])
    assert.deepEqual(calls, ['deferUpdate', 'deleteReply'])
  })

  it('«Применить» на панели из плеера передаёт выбор PlayerService', async t => {
    const { done, apply, starts } = click(t, {
      customId: 'wave-settings:message-1:submit',
      panel: settingsPanel(GROUPS, WORKOUT, { kind: 'retune', playerMessageId: 'message-1' })
    })
    await done

    assert.equal(apply.mock.callCount(), 1)
    assert.deepEqual(apply.mock.calls[0].arguments.slice(1), ['message-1', WORKOUT])
    assert.equal(starts.length, 0)
  })

  it('«По умолчанию» сразу запускает или применяет волну без настроек, что бы ни было в списках', async t => {
    const launch = click(t, {
      customId: 'wave-settings:new:default',
      panel: settingsPanel(GROUPS, FULL, { kind: 'launch' })
    })
    await launch.done

    assert.deepEqual(
      launch.starts.map(start => start.choice),
      [{}]
    )
    assert.deepEqual(launch.saved, [['owner', {}]])
    assert.deepEqual(launch.calls, ['deferUpdate', 'deleteReply'])

    const retune = click(t, {
      customId: 'wave-settings:message-1:default',
      panel: settingsPanel(GROUPS, FULL, { kind: 'retune', playerMessageId: 'message-1' })
    })
    await retune.done

    assert.deepEqual(retune.apply.mock.calls[0].arguments.slice(1), ['message-1', {}])
  })
})

/**
 * Вызов /my-wave пользователем, у которого сохранён выбор WORKOUT
 */
async function runMyWave(t: TestContext, loadSettings: () => Promise<WaveSettingGroup[]>) {
  const replies: { content: string; components?: SettingsPanel['components'] }[] = []
  const starts: StartWaveOptions[] = []

  t.mock.method(DatabaseService, 'getInstance', () => ({
    getUserData: () => ({ accessToken: 'token-owner', userInfo: { id: 'yandex-owner' } }),
    getWaveChoice: () => WORKOUT,
    saveWaveChoice: () => {}
  }))
  t.mock.method(YandexMusicService.getInstance(), 'getWaveSettings', loadSettings)
  t.mock.method(PlayerService.getInstance(), 'startWave', async (options: StartWaveOptions) => {
    starts.push(options)
  })
  // Уведомление удаляется по таймеру: настоящий таймер задержал бы завершение тестов
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const interaction = {
    ...ownerInVoiceChannel(),
    replied: false,
    deferred: false,
    inCachedGuild: () => true,
    deferReply: async () => {
      interaction.deferred = true
    },
    editReply: async (reply: { content: string; components?: SettingsPanel['components'] }) => {
      replies.push(reply)
    },
    deleteReply: async () => {}
  }

  await execute(interaction as unknown as ChatInputCommandInteraction)
  return { replies, starts }
}

describe('/my-wave', () => {
  it('показывает панель с сохранённым выбором и не запускает волну сразу', async t => {
    const { replies, starts } = await runMyWave(t, async () => GROUPS)

    assert.equal(starts.length, 0)
    assert.equal(replies[0].content, 'Выберите настройки «Моей волны» и нажмите «Запустить».')
    assert.deepEqual(readSettingsPanel(replies[0].components ?? []).choice, WORKOUT)
  })

  it('если список настроек не загрузился, запускает волну с сохранёнными и говорит об этом', async t => {
    const { replies, starts } = await runMyWave(t, async () => {
      throw new Error('HTTP 429')
    })

    assert.deepEqual(
      starts.map(start => start.choice),
      [WORKOUT]
    )
    assert.equal(
      replies.at(-1)?.content,
      'Не удалось загрузить настройки «Моей волны», поэтому волна запущена с последними выбранными: Тренируюсь. ' +
        'Сменить их можно кнопкой «⚙️ Настроить волну» в плеере.'
    )
  })

  it('с истёкшим токеном объясняет, как его обновить, и не запускает волну', async t => {
    const { replies, starts } = await runMyWave(t, async () => {
      throw new YandexAuthError()
    })

    assert.equal(starts.length, 0)
    assert.match(replies[0].content, /токен Яндекса недействителен или истёк/)
  })
})
