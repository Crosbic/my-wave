import { inspect } from 'util'

import config, { LogLevel } from '../config.js'
import { describeError } from './errors.js'

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: Infinity }

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
  const write = (level: LogLevel, message: string, details: unknown[]) => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[config.logLevel]) {
      return
    }

    const line = [new Date().toISOString(), level.toUpperCase().padEnd(5), scope && `[${scope}]`, message]
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

function formatDetail(detail: unknown): string {
  if (detail instanceof Error) {
    return describeError(detail)
  }
  return typeof detail === 'string' ? detail : inspect(detail, { depth: 3, breakLength: Infinity })
}

export const logger = createLogger()
