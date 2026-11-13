import { inspect, styleText } from 'util'

import config, { LogLevel } from '../config.js'
import { describeError } from './errors.js'

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: Infinity }

// Уровень отдельного сообщения: silent бывает только у настройки уровня логов
export type MessageLevel = Exclude<LogLevel, 'silent'>

// Цвета видны и на светлом, и на тёмном фоне, в том числе в консоли логов Portainer: обычные красный и синий
// в её палитре почти не видны на тёмной теме, а яркий жёлтый — на светлой
const LEVEL_COLORS: Record<MessageLevel, Parameters<typeof styleText>[0]> = {
  debug: 'gray',
  info: 'cyan',
  warn: 'yellow',
  error: 'redBright'
}

export interface Logger {
  debug(message: string, ...details: unknown[]): void
  info(message: string, ...details: unknown[]): void
  warn(message: string, ...details: unknown[]): void
  error(message: string, ...details: unknown[]): void
  /**
   * Логгер с меткой в каждой строке, например сервера, к которому относится сообщение
   */
  child(scope: string): Logger
}

/**
 * Логгер с уровнями: сообщения ниже config.logLevel не выводятся.
 * Ошибки в деталях форматируются через describeError, поэтому токены из запросов не попадают в лог
 */
export function createLogger(scope?: string): Logger {
  const write = (level: MessageLevel, message: string, details: unknown[]) => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[config.logLevel]) {
      return
    }

    const line = [new Date().toISOString(), levelTag(level), scope && `[${scope}]`, message]
      .concat(details.map(formatDetail))
      .filter(Boolean)
      .join(' ')

    if (level === 'error') {
      console.error(line)
    } else if (level === 'warn') {
      console.warn(line)
    } else {
      console.log(line)
    }
  }

  return {
    debug: (message, ...details) => write('debug', message, details),
    info: (message, ...details) => write('info', message, details),
    warn: (message, ...details) => write('warn', message, details),
    error: (message, ...details) => write('error', message, details),
    child: childScope => createLogger(scope ? `${scope} ${childScope}` : childScope)
  }
}

/**
 * Уровень в строке лога, выровненный по самому длинному. В цвете — если цвета включены в LOG_COLORS,
 * а если там ничего не задано — когда лог выводится в терминал и не задан NO_COLOR
 */
function levelTag(level: MessageLevel): string {
  const label = level.toUpperCase()
  const colors = config.logColors ?? (process.stdout.isTTY && !process.env.NO_COLOR)
  const tag = colors ? styleText(LEVEL_COLORS[level], label, { validateStream: false }) : label
  return tag + ' '.repeat(5 - label.length)
}

function formatDetail(detail: unknown): string {
  if (detail instanceof Error) {
    return describeError(detail)
  }
  return typeof detail === 'string' ? detail : inspect(detail, { depth: 3, breakLength: Infinity })
}

export const logger = createLogger()
