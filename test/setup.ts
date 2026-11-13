// Тестовое окружение: настоящие токены из .env не используются, логи не мешают выводу тестов
process.env.DISCORD_TOKEN = 'test-discord-token'
process.env.CLIENT_ID = 'test-client-id'
process.env.ENCRYPTION_KEY = 'test-encryption-key'
process.env.ADMINS = ''
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent'
// Тесты сверяют строки лога без цвета, даже если в .env цвета включены
process.env.LOG_COLORS = 'false'
delete process.env.DATA_DIR
