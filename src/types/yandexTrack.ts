export interface IYandexTrack {
  id: string
  title: string
  artists: Array<{ name: string }>
  albums: Array<{ id?: number; title: string }>
  coverUri: string
  durationMs?: number
}

/**
 * Партия треков, выданная станцией. batchId нужен для фидбэка по этим трекам
 */
export interface IStationBatch {
  batchId: string | null
  tracks: IYandexTrack[]
}
