import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { describeVersion } from '../src/version.js'

describe('коммит в логе запуска', () => {
  it('у образа из CI — короткий коммит и его дата', () => {
    const text = describeVersion({
      GIT_COMMIT: '38c83b7065adde9d128392f2113ec12ea1e96ba6',
      GIT_COMMIT_DATE: '2026-11-10T14:01:39+03:00'
    })

    assert.equal(text, 'коммит 38c83b7 от 2026-11-10T14:01:39+03:00')
  })

  it('без коммита из CI видно, что сборка не из CI', () => {
    // Образ, собранный без --build-arg, получает пустые переменные
    assert.equal(describeVersion({ GIT_COMMIT: '', GIT_COMMIT_DATE: '' }), 'коммит неизвестен (сборка не из CI)')
  })
})
