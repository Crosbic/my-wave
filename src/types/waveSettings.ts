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
 * Подборка из карусели «Моей волны», например «Хочется электроники»: своя волна со своими сидами.
 * description — подпись подборки в карусели («Моя волна по жанру»)
 */
export interface CarouselWave {
  seeds: string[]
  name: string
  description?: string
}

/**
 * Выбранные настройки волны. Группа без значения означает «Любое».
 * wave — подборка из карусели: она играет вместо «Моей волны», а занятие заменяет её
 */
export type WaveChoice = Partial<Record<WaveSettingKey, WaveOption>> & { wave?: CarouselWave }
