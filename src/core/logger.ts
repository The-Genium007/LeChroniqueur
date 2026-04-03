import pino from 'pino';
import { getConfig } from './config.js';

let _logger: pino.Logger | undefined;

export function createLogger(): pino.Logger {
  if (_logger !== undefined) {
    return _logger;
  }

  const config = getConfig();

  const isDev = config.NODE_ENV === 'development';

  const transport = isDev
    ? pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname,service',
          messageFormat: '{msg}',
          customColors: 'fatal:bgRed,error:red,warn:yellow,info:green,debug:gray,trace:gray',
          customLevels: '',
          minimumLevel: config.LOG_LEVEL,
        },
      })
    : undefined;

  _logger = pino(
    {
      level: config.LOG_LEVEL,
      base: { service: 'tumulte-bot' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport,
  );

  return _logger;
}

export function getLogger(): pino.Logger {
  if (_logger === undefined) {
    throw new Error('Logger not created. Call createLogger() first.');
  }
  return _logger;
}
