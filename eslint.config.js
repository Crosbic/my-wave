import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import { defineConfig, globalIgnores } from 'eslint/config'
import importPlugin from 'eslint-plugin-import'
import prettierRecommended from 'eslint-plugin-prettier/recommended'
import unusedImports from 'eslint-plugin-unused-imports'

export default defineConfig([
  globalIgnores(['dist/', 'node_modules/', 'src/types/yandex-api.d.ts']),
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [
      js.configs.recommended,
      tsPlugin.configs['flat/recommended'],
      importPlugin.flatConfigs.recommended,
      importPlugin.flatConfigs.typescript,
      prettierRecommended
    ],
    plugins: {
      'unused-imports': unusedImports
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module'
    },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json'
        },
        node: {
          extensions: ['.js', '.ts']
        }
      }
    },
    rules: {
      'prettier/prettier': 'warn',
      'no-console': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'import/no-named-as-default': 'off',
      'import/no-named-as-default-member': 'off',

      // Удаление неиспользуемых импортов
      '@typescript-eslint/no-unused-vars': 'off', // Отключаем стандартное правило
      'unused-imports/no-unused-imports': 'error', // Включаем альтернативное для импортов
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_'
        }
      ],

      // Сортировка импортов
      'import/order': [
        'warn',
        {
          groups: [
            'builtin', // Встроенные модули Node.js (fs, path и т.д.)
            'external', // Пакеты из node_modules
            'internal', // Импорты, соответствующие настройкам alias
            ['parent', 'sibling'], // Импорты из родительских и соседних директорий
            'index', // Импорты из текущей директории
            'object', // Импорт типов объектов
            'type' // Импорт только типов
          ],
          'newlines-between': 'always', // Добавление пустой строки между группами
          pathGroupsExcludedImportTypes: ['builtin'],
          alphabetize: {
            order: 'asc', // Сортировка в алфавитном порядке
            caseInsensitive: true // Без учета регистра
          },
          pathGroups: [
            // Группировка discord.js импортов
            {
              pattern: 'discord.js',
              group: 'external',
              position: 'before'
            },
            // Можно добавить дополнительные группы
            {
              pattern: 'src/**',
              group: 'internal'
            }
          ]
        }
      ],
      'import/first': 'error', // Все импорты должны быть в начале файла
      'import/newline-after-import': 'error', // Добавление пустой строки после импортов
      'import/no-duplicates': 'error' // Объединение импортов из одного модуля
    }
  }
])
