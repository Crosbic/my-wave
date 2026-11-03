import {
  ActionRowBuilder,
  APISelectMenuOption,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageActionRowComponentBuilder,
  StringSelectMenuBuilder
} from 'discord.js'

import { WaveChoice, WaveOption, WaveSettingGroup, WaveSettingKey } from '../types/waveSettings.js'

export const MY_WAVE_SEED = 'user:onyourwave'

// Порядок групп в панели и в описании волны
export const WAVE_SETTING_KEYS: readonly WaveSettingKey[] = ['activity', 'diversity', 'moodEnergy', 'language']

export const WAVE_SETTINGS_PREFIX = 'wave-settings:'

// Панель перед запуском волны; у панели ⚙️ вместо этого стоит ID сообщения плеера
const LAUNCH_TARGET = 'new'
// Значение «Любое» в выпадающем списке: сиды всегда содержат двоеточие, поэтому не совпадут с ним
const ANY_VALUE = 'any'
// В сообщении не больше пяти рядов компонентов: четыре списка и ряд кнопок
const MAX_GROUPS = 4
const MAX_SELECT_OPTIONS = 25

/**
 * Для какой волны открыта панель: новой (перед запуском) или уже играющей (кнопка ⚙️ в плеере)
 */
export type PanelTarget = { kind: 'launch' } | { kind: 'retune'; playerMessageId: string }

export type PanelField = WaveSettingKey | 'submit' | 'default' | 'reset'

export interface SettingsPanel {
  content: string
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[]
}

/**
 * Сиды сессии волны, как их собирает веб-клиент Яндекс Музыки: занятие заменяет «Мою волну»,
 * а характер, настроение и язык добавляются к ней. «Любое» сидом не передаётся
 */
export function waveSeeds(choice: WaveChoice): string[] {
  const settings = WAVE_SETTING_KEYS.filter(key => key !== 'activity').flatMap(key => choice[key]?.seed ?? [])
  return [choice.activity?.seed ?? MY_WAVE_SEED, ...settings]
}

/**
 * Все группы «Любое»: обычная «Моя волна» без настроек
 */
export function isDefaultChoice(choice: WaveChoice): boolean {
  return WAVE_SETTING_KEYS.every(key => !choice[key])
}

/**
 * Одинаковые ли настройки. Сравниваются сиды: название значения могло поменяться в Яндекс Музыке
 */
export function sameChoice(a: WaveChoice, b: WaveChoice): boolean {
  return WAVE_SETTING_KEYS.every(key => a[key]?.seed === b[key]?.seed)
}

/**
 * Краткое описание настроек для плеера, например «Тренируюсь · Бодрое». Пустая строка, если всё «Любое»
 */
export function describeChoice(choice: WaveChoice): string {
  return WAVE_SETTING_KEYS.flatMap(key => choice[key]?.name ?? []).join(' · ')
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

  for (const key of WAVE_SETTING_KEYS) {
    const option: unknown = (value as Record<string, unknown>)[key]
    if (isWaveOption(option)) {
      choice = withOption(choice, key, { seed: option.seed, name: option.name })
    }
  }
  return choice
}

export function isWaveSettingKey(value: string): value is WaveSettingKey {
  return (WAVE_SETTING_KEYS as readonly string[]).includes(value)
}

/**
 * Панель настроек: по выпадающему списку на группу и кнопки. Состояние панели хранится в самом сообщении
 * (выбранные пункты списков), поэтому между нажатиями боту ничего не нужно помнить
 */
export function settingsPanel(
  groups: WaveSettingGroup[],
  choice: WaveChoice,
  target: PanelTarget,
  notice?: string
): SettingsPanel {
  const rows = groups.slice(0, MAX_GROUPS).map(group =>
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(panelId(target, group.key))
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

  const launch = target.kind === 'launch'
  rows.push(
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(panelId(target, 'submit'))
        .setLabel(launch ? '▶️ Запустить' : 'Применить')
        .setStyle(ButtonStyle.Primary),
      // Волна без настроек одним нажатием, не выбирая «Любое» в каждом списке
      new ButtonBuilder()
        .setCustomId(panelId(target, 'default'))
        .setLabel(launch ? '▶️ По умолчанию' : 'По умолчанию')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(panelId(target, 'reset')).setLabel('Сбросить').setStyle(ButtonStyle.Secondary)
    )
  )

  const hint =
    target.kind === 'launch'
      ? 'Выберите настройки «Моей волны» и нажмите «Запустить».'
      : 'Новые настройки применятся сразу: заиграет первый трек новой волны.'
  return { content: notice ?? hint, components: rows }
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
 * Разбор customId компонента панели: wave-settings:<new или ID сообщения плеера>:<поле>
 */
export function parsePanelId(customId: string | undefined): { target: PanelTarget; field: PanelField } | null {
  if (!customId?.startsWith(WAVE_SETTINGS_PREFIX)) {
    return null
  }

  const [target, field] = customId.slice(WAVE_SETTINGS_PREFIX.length).split(':')
  if (
    !target ||
    !field ||
    !(isWaveSettingKey(field) || field === 'submit' || field === 'default' || field === 'reset')
  ) {
    return null
  }

  return {
    target: target === LAUNCH_TARGET ? { kind: 'launch' } : { kind: 'retune', playerMessageId: target },
    field
  }
}

/**
 * Выбранное значение списка: ANY_VALUE превращается в «Любое»
 */
export function optionByValue(group: WaveSettingGroup | undefined, value: string): WaveOption | undefined {
  return value === ANY_VALUE ? undefined : group?.options.find(option => option.seed === value)
}

function panelId(target: PanelTarget, field: PanelField): string {
  const id = target.kind === 'launch' ? LAUNCH_TARGET : target.playerMessageId
  return `${WAVE_SETTINGS_PREFIX}${id}:${field}`
}

function isWaveOption(value: unknown): value is WaveOption {
  const option = value as Partial<WaveOption> | null
  return typeof option?.seed === 'string' && typeof option.name === 'string'
}

interface ComponentJson {
  type: number
  custom_id?: string
  placeholder?: string
  options?: APISelectMenuOption[]
  components?: ComponentJson[]
}
