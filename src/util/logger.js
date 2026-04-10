const path = require('path');
const winston = require('winston');
const config = require('../config');

const COLORIZE = config.NODE_ENV === 'development';

function createLogger(filePath) {
  const fileName = path.basename(filePath);

  const formats = [
    winston.format.label({ label: fileName }),
    winston.format.timestamp(),
    winston.format.splat(),
  ];
  if (COLORIZE) {
    formats.push(winston.format.colorize());
  }
  formats.push(
    winston.format.printf((info) => {
      const {
        level, message, label, timestamp,
      } = info;
      const splat = info[Symbol.for('splat')];
      let msg = `${timestamp} [${label}] ${level}: ${message}`;
      if (splat && splat.length) {
        msg += ` ${splat.map((s) => (typeof s === 'object' ? JSON.stringify(s) : s)).join(' ')}`;
      }
      return msg;
    }),
  );

  const logger = winston.createLogger({
    level: config.LOG_LEVEL || 'info',
    format: winston.format.combine(...formats),
    transports: [new winston.transports.Console()],
  });

  return logger;
}

module.exports = createLogger;
