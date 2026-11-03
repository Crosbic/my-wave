/**
 * Группы настроек «Моей волны», как в приложении Яндекс Музыки
 */
export type WaveSettingKey = 'activity' | 'diversity' | 'moodEnergy' | 'language'

/**
 * Значение настройки: сид сессии волны (например, settingMoodEnergy:active) и его название
 */
export interface WaveOption {
  seed: string
  name: string
}

/**
 * Группа настроек. «Любое» в options не входит: у него нет сида, хранится только название
 */
export interface WaveSettingGroup {
  key: WaveSettingKey
  name: string
  anyName: string
  options: WaveOption[]
}

/**
 * Выбранные настройки волны. Группа без значения означает «Любое»
 */
export type WaveChoice = Partial<Record<WaveSettingKey, WaveOption>>
