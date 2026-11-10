import {
  ActionRowBuilder,
  APISelectMenuOption,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ContainerBuilder,
  escapeMarkdown,
  MessageActionRowComponentBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  TextDisplayBuilder
} from 'discord.js'

import { CarouselWave, WaveChoice, WaveOption, WaveSettingGroup, WaveSettingKey } from '../types/waveSettings.js'
import { IYandexTrack } from '../types/yandexTrack.js'

export const MY_WAVE_SEED = 'user:onyourwave'
// Сид плитки «Встряхнуть Мою волну» в карусели, к нему добавляется отметка времени: diversity:reshuffle_<мс>
const RESHUFFLE_SEED = 'diversity:reshuffle'

// Порядок групп в панели и в описании волны
export const WAVE_SETTING_KEYS: readonly WaveSettingKey[] = ['activity', 'diversity', 'moodEnergy', 'language']

export const WAVE_SETTINGS_PREFIX = 'wave-settings:'

// Значение «Любое» в выпадающем списке: сиды всегда содержат двоеточие, поэтому не совпадут с ним
const ANY_VALUE = 'any'
// В сообщении не больше пяти рядов компонентов: четыре списка и ряд кнопок
const MAX_GROUPS = 4
const MAX_SELECT_OPTIONS = 25
// Ограничение Discord на длину значения, названия и подписи пункта списка
const MAX_OPTION_LENGTH = 100

export const HISTORY_PAGE_SIZE = 5
// Полоса панели истории — цвета плеера
const HISTORY_COLOR = 0xffcc00

// carousel — список подборок из кнопки «🎡 Подборки» в плеере.
// history-play и history-page — кнопки ▶️ и листания на панели «📜 История»
export type PanelField = WaveSettingKey | 'submit' | 'default' | 'reset' | 'carousel' | 'history-play' | 'history-page'
const PANEL_CONTROLS: readonly string[] = [
  'submit',
  'default',
  'reset',
  'carousel',
  'history-play',
  'history-page'
] satisfies PanelField[]

export interface SettingsPanel {
  content: string
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[]
}

/**
 * Панель из компонентов V2: в ней и текст — компонент, поэтому content у неё нет
 */
export interface ComponentsPanel {
  components: (ContainerBuilder | TextDisplayBuilder)[]
  flags: MessageFlags.IsComponentsV2
}

/**
 * Сиды сессии волны, как их собирает веб-клиент Яндекс Музыки: занятие или подборка карусели заменяют
 * «Мою волну», а характер, настроение и язык добавляются к ним. «Любое» сидом не передаётся
 */
export function waveSeeds(choice: WaveChoice): string[] {
  const base = choice.activity ? [choice.activity.seed] : (choice.wave?.seeds ?? [MY_WAVE_SEED])
  const settings = WAVE_SETTING_KEYS.filter(key => key !== 'activity').flatMap(key => choice[key]?.seed ?? [])
  return [...base, ...settings]
}

/**
 * Все группы «Любое» и нет подборки: обычная «Моя волна» без настроек
 */
export function isDefaultChoice(choice: WaveChoice): boolean {
  return !choice.wave && WAVE_SETTING_KEYS.every(key => !choice[key])
}

/**
 * Одинаковые ли настройки. Сравниваются сиды: название значения могло поменяться в Яндекс Музыке
 */
export function sameChoice(a: WaveChoice, b: WaveChoice): boolean {
  return (
    a.wave?.seeds.join(',') === b.wave?.seeds.join(',') && WAVE_SETTING_KEYS.every(key => a[key]?.seed === b[key]?.seed)
  )
}

/**
 * Краткое описание настроек для плеера, например «Хочется электроники · Бодрое». Пустая строка, если всё «Любое»
 */
export function describeChoice(choice: WaveChoice): string {
  return [
    ...(choice.wave ? [choice.wave.name] : []),
    ...WAVE_SETTING_KEYS.flatMap(key => choice[key]?.name ?? [])
  ].join(' · ')
}

/**
 * Настройки из панели ⚙️ поверх играющей подборки карусели, как в приложении: характер, настроение и язык
 * добавляются к подборке, а выбранное занятие её заменяет
 */
export function withCarousel(choice: WaveChoice, current: WaveChoice): WaveChoice {
  return current.wave && !choice.activity && !choice.wave ? { ...choice, wave: current.wave } : choice
}

/**
 * Выбор с изменённым значением одной группы. Без значения группа становится «Любое»
 */
export function withOption(choice: WaveChoice, key: WaveSettingKey, option: WaveOption | undefined): WaveChoice {
  const next = { ...choice }
  if (option) {
    next[key] = option
  } else {
    delete next[key]
  }
  return next
}

/**
 * Оставляет только значения, которые Яндекс Музыка предлагает сейчас: сохранённый выбор мог устареть
 */
export function sanitizeChoice(choice: WaveChoice, groups: WaveSettingGroup[]): WaveChoice {
  let sanitized: WaveChoice = {}
  for (const group of groups) {
    const option = group.options.find(item => item.seed === choice[group.key]?.seed)
    sanitized = withOption(sanitized, group.key, option)
  }
  return sanitized
}

/**
 * Выбор, сохранённый в базе. Повреждённые и неизвестные значения отбрасываются
 */
export function parseWaveChoice(value: unknown): WaveChoice {
  let choice: WaveChoice = {}
  if (!value || typeof value !== 'object') {
    return choice
  }

  const record = value as Record<string, unknown>
  for (const key of WAVE_SETTING_KEYS) {
    const option = record[key]
    if (isWaveOption(option)) {
      choice = withOption(choice, key, { seed: option.seed, name: option.name })
    }
  }
  if (isCarouselWave(record.wave)) {
    choice.wave = { seeds: [...record.wave.seeds], name: record.wave.name }
  }
  return choice
}

/**
 * «Встряхнуть Мою волну» из карусели: разовое действие с отметкой времени в сиде, а не настройка волны
 */
export function isReshuffle(wave: CarouselWave | undefined): boolean {
  return wave?.seeds.some(seed => seed.startsWith(RESHUFFLE_SEED)) ?? false
}

/**
 * Что из выбора запомнить для следующего /my-wave: всё, кроме «Встряхнуть Мою волну»
 */
export function rememberedChoice(choice: WaveChoice): WaveChoice {
  if (!isReshuffle(choice.wave)) {
    return choice
  }
  const { wave: _wave, ...settings } = choice
  return settings
}

export function isWaveSettingKey(value: string): value is WaveSettingKey {
  return (WAVE_SETTING_KEYS as readonly string[]).includes(value)
}

/**
 * Панель настроек играющей волны (кнопка ⚙️ в плеере): по выпадающему списку на группу и кнопки.
 * Состояние панели хранится в самом сообщении (выбранные пункты списков), поэтому между нажатиями
 * боту ничего не нужно помнить
 */
export function settingsPanel(groups: WaveSettingGroup[], choice: WaveChoice, playerMessageId: string): SettingsPanel {
  const rows = groups.slice(0, MAX_GROUPS).map(group =>
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(panelId(playerMessageId, group.key))
        .setPlaceholder(group.name)
        .addOptions(
          { label: group.anyName, value: ANY_VALUE },
          ...group.options.slice(0, MAX_SELECT_OPTIONS - 1).map(option => ({
            label: option.name,
            value: option.seed,
            // «Любое» не отмечается: тогда в свёрнутом списке видно название группы
            default: option.seed === choice[group.key]?.seed
          }))
        )
    )
  )

  rows.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(panelId(playerMessageId, 'submit'))
        .setLabel('Применить')
        .setStyle(ButtonStyle.Primary),
      // Волна без настроек одним нажатием, не выбирая «Любое» в каждом списке
      new ButtonBuilder()
        .setCustomId(panelId(playerMessageId, 'default'))
        .setLabel('По умолчанию')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(panelId(playerMessageId, 'reset'))
        .setLabel('Сбросить')
        .setStyle(ButtonStyle.Secondary)
    )
  )

  return { content: 'Новые настройки применятся сразу: заиграет первый трек новой волны.', components: rows }
}

/**
 * Группы и выбор, восстановленные из компонентов сообщения с панелью
 */
export function readSettingsPanel(components: readonly { toJSON(): unknown }[]): {
  groups: WaveSettingGroup[]
  choice: WaveChoice
} {
  const groups: WaveSettingGroup[] = []
  let choice: WaveChoice = {}

  for (const row of components.map(component => component.toJSON() as ComponentJson)) {
    for (const component of row.components ?? []) {
      const field = component.type === ComponentType.StringSelect ? parsePanelId(component.custom_id)?.field : undefined
      if (!field || !isWaveSettingKey(field)) {
        continue
      }

      const options = component.options ?? []
      const values = options.filter(option => option.value !== ANY_VALUE)
      const group: WaveSettingGroup = {
        key: field,
        name: component.placeholder ?? '',
        anyName: options.find(option => option.value === ANY_VALUE)?.label ?? '',
        options: values.map(option => ({ seed: option.value, name: option.label }))
      }
      groups.push(group)

      const selected = values.find(option => option.default)
      choice = withOption(choice, field, selected && { seed: selected.value, name: selected.label })
    }
  }

  return { groups, choice }
}

/**
 * Список подборок для кнопки «🎡 Подборки». Выбор в нём сразу включает подборку, поэтому кнопок нет.
 * null — показывать нечего
 */
export function carouselPanel(
  waves: CarouselWave[],
  current: WaveChoice,
  playerMessageId: string
): SettingsPanel | null {
  const playing = current.wave?.seeds.join(',')
  const options = waves
    .map(wave => ({ wave, value: wave.seeds.join(',') }))
    .filter(({ value }) => value.length <= MAX_OPTION_LENGTH)
    .slice(0, MAX_SELECT_OPTIONS)
    .map(({ wave, value }) => ({
      label: wave.name.slice(0, MAX_OPTION_LENGTH),
      value,
      ...(wave.description && { description: wave.description.slice(0, MAX_OPTION_LENGTH) }),
      default: value === playing
    }))

  if (options.length === 0) {
    return null
  }

  return {
    content: 'Выберите подборку, и она сразу заиграет.',
    components: [
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(panelId(playerMessageId, 'carousel'))
          .setPlaceholder('Подборки для вас')
          .addOptions(options)
      )
    ]
  }
}

/**
 * Подборка, выбранная в списке «🎡 Подборки»: сиды хранятся в значении пункта, название — в его подписи
 */
export function readCarouselWave(
  components: readonly { toJSON(): unknown }[],
  value: string
): CarouselWave | undefined {
  for (const row of components.map(component => component.toJSON() as ComponentJson)) {
    for (const component of row.components ?? []) {
      const option = component.options?.find(item => item.value === value)
      if (option && parsePanelId(component.custom_id)?.field === 'carousel') {
        return { seeds: value.split(','), name: option.label }
      }
    }
  }
  return undefined
}

/**
 * Страница «📜 Истории»: сыгранные треки по пять, последний — первым, у каждого кнопка ▶️, а внизу листание.
 * Собрана из компонентов V2: только в них кнопка стоит рядом с текстом. Номер страницы и ID трека хранятся
 * в самих кнопках, поэтому между нажатиями боту ничего не нужно помнить. notice — пояснение под заголовком
 */
export function historyPanel(
  tracks: IYandexTrack[],
  playerMessageId: string,
  page: number,
  notice?: string
): ComponentsPanel {
  // ID трека входит в customId кнопки, а Discord не примет две кнопки с одинаковым customId
  const unique = tracks.filter((track, index) => tracks.findIndex(other => other.id === track.id) === index)
  const pages = Math.max(1, Math.ceil(unique.length / HISTORY_PAGE_SIZE))
  // Пока страница была открыта, история могла стать короче
  const current = Math.min(Math.max(Math.trunc(page) || 0, 0), pages - 1)

  const container = new ContainerBuilder()
    .setAccentColor(HISTORY_COLOR)
    .addTextDisplayComponents(text => text.setContent(notice ? `### 📜 История\n${notice}` : '### 📜 История'))
    .addSeparatorComponents(separator => separator)

  for (const track of unique.slice(current * HISTORY_PAGE_SIZE, (current + 1) * HISTORY_PAGE_SIZE)) {
    const artists = track.artists.map(artist => artist.name).join(', ')
    container.addSectionComponents(section =>
      section
        .addTextDisplayComponents(text =>
          text.setContent(`**${escapeMarkdown(track.title)}**${artists ? `\n-# ${escapeMarkdown(artists)}` : ''}`)
        )
        .setButtonAccessory(button =>
          button
            .setCustomId(panelId(playerMessageId, 'history-play', String(current), track.id))
            .setLabel('▶️')
            .setStyle(ButtonStyle.Secondary)
        )
    )
  }

  if (pages > 1) {
    container
      .addSeparatorComponents(separator => separator)
      .addActionRowComponents(row =>
        row.addComponents(
          historyPageButton(playerMessageId, current - 1, '⬅️').setDisabled(current === 0),
          historyPageButton(playerMessageId, current, `${current + 1} / ${pages}`).setDisabled(true),
          historyPageButton(playerMessageId, current + 1, '➡️').setDisabled(current === pages - 1)
        )
      )
  }

  return { components: [container], flags: MessageFlags.IsComponentsV2 }
}

/**
 * Текст на месте панели из компонентов V2: content у такого сообщения быть не может
 */
export function textPanel(content: string): ComponentsPanel {
  return { components: [new TextDisplayBuilder().setContent(content)], flags: MessageFlags.IsComponentsV2 }
}

/**
 * Разбор customId компонента панели: wave-settings:<ID сообщения плеера>:<поле>[:<параметры>].
 * Параметры есть у кнопок «📜 Истории»: номер страницы, а у ▶️ ещё и ID трека
 */
export function parsePanelId(
  customId: string | undefined
): { playerMessageId: string; field: PanelField; args: string[] } | null {
  if (!customId?.startsWith(WAVE_SETTINGS_PREFIX)) {
    return null
  }

  const [playerMessageId, field, ...args] = customId.slice(WAVE_SETTINGS_PREFIX.length).split(':')
  if (!playerMessageId || !field || !isPanelField(field)) {
    return null
  }

  return { playerMessageId, field, args }
}

/**
 * Выбранное значение списка: ANY_VALUE превращается в «Любое»
 */
export function optionByValue(group: WaveSettingGroup | undefined, value: string): WaveOption | undefined {
  return value === ANY_VALUE ? undefined : group?.options.find(option => option.seed === value)
}

function panelId(playerMessageId: string, field: PanelField, ...args: string[]): string {
  return [`${WAVE_SETTINGS_PREFIX}${playerMessageId}`, field, ...args].join(':')
}

function isPanelField(value: string): value is PanelField {
  return isWaveSettingKey(value) || PANEL_CONTROLS.includes(value)
}

/**
 * Кнопка листания «📜 Истории» на страницу page. У номера текущей страницы тот же вид, но он всегда выключен
 */
function historyPageButton(playerMessageId: string, page: number, label: string): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(panelId(playerMessageId, 'history-page', String(page)))
    .setLabel(label)
    .setStyle(ButtonStyle.Secondary)
}

function isWaveOption(value: unknown): value is WaveOption {
  const option = value as Partial<WaveOption> | null
  return typeof option?.seed === 'string' && typeof option.name === 'string'
}

function isCarouselWave(value: unknown): value is CarouselWave {
  const wave = value as Partial<CarouselWave> | null
  return (
    typeof wave?.name === 'string' &&
    Array.isArray(wave.seeds) &&
    wave.seeds.length > 0 &&
    wave.seeds.every(seed => typeof seed === 'string')
  )
}

interface ComponentJson {
  type: number
  custom_id?: string
  placeholder?: string
  options?: APISelectMenuOption[]
  components?: ComponentJson[]
}
