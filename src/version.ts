/**
 * Коммит, из которого собран бот, для лога запуска: по нему видно, обновился ли бот после деплоя,
 * например «коммит 38c83b7 от 2026-11-10T14:01:39+03:00». Коммит и его дату передаёт в образ CI
 * (GIT_COMMIT и GIT_COMMIT_DATE), при локальном запуске их нет
 */
export function describeVersion(env: NodeJS.ProcessEnv = process.env): string {
  const commit = env.GIT_COMMIT?.trim().slice(0, 7)
  if (!commit) {
    return 'коммит неизвестен (сборка не из CI)'
  }

  const date = env.GIT_COMMIT_DATE?.trim()
  return date ? `коммит ${commit} от ${date}` : `коммит ${commit}`
}
