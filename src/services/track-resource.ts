import { spawn } from 'child_process'
import fs from 'fs'
import { createRequire } from 'module'
import { Readable } from 'stream'

import { AudioResource, createAudioResource, StreamType } from '@discordjs/voice'

// Типы ffmpeg-static описывают ESM-экспорт default, а сам пакет отдаёт путь через module.exports
const ffmpegStatic = createRequire(import.meta.url)('ffmpeg-static') as string | null
// Как и @discordjs/voice, берём ffmpeg из ffmpeg-static, а если его бинарника нет — из PATH
const FFMPEG = ffmpegStatic && fs.existsSync(ffmpegStatic) ? ffmpegStatic : 'ffmpeg'
// Параметры, с которыми @discordjs/voice перекодирует произвольный поток: PCM 48 кГц, стерео
const FFMPEG_ARGS = '-i - -analyzeduration 0 -loglevel 0 -f s16le -ar 48000 -ac 2 pipe:1'.split(' ')

/**
 * Аудиоресурс трека из потока его файла. ffmpeg запускаем сами, а не через createAudioResource с StreamType.Arbitrary:
 * обёртка prism-media не убивает ffmpeg, если файл уже целиком передан ему и stdin закрыт (последние секунды трека),
 * и такой ffmpeg навсегда зависает на записи в stdout, который больше никто не читает.
 * Здесь ffmpeg завершается вместе с ресурсом: в конце трека, при ошибке, смене трека и остановке плеера
 */
export function createTrackResource(input: Readable): AudioResource {
  const ffmpeg = spawn(FFMPEG, FFMPEG_ARGS, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })

  // Обрыв загрузки и незапустившийся ffmpeg — ошибка воспроизведения: плеер повторит трек или перейдёт к следующему.
  // stdout нет, только если ffmpeg не запустился из-за нехватки файловых дескрипторов
  const fail = (error: Error) => ffmpeg.stdout?.destroy(error)
  ffmpeg.on('error', fail)
  input.on('error', fail)
  // Запись в stdin обрывается, если ffmpeg завершился, не дочитав файл
  ffmpeg.stdin.on('error', () => {})
  input.pipe(ffmpeg.stdin)

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw, inlineVolume: true })
  // Поток ресурса закрывается сам в конце трека, а при смене трека и остановке его уничтожает плеер
  resource.playStream.once('close', () => {
    ffmpeg.kill('SIGKILL')
    discard(input)
  })

  return resource
}

/**
 * Закрытие ненужного потока трека. Недокачанный файл при закрытии сообщает об обрыве ошибкой,
 * а ошибка без обработчика уронила бы процесс
 */
export function discard(stream: Readable): void {
  stream.on('error', () => {})
  stream.destroy()
}
