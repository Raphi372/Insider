'use strict';

function write(level, message, extra) {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  const out = level === 'ERROR' || level === 'WARN' ? console.error : console.log;
  if (extra === undefined) out(line);
  else out(line, extra);
}

module.exports = {
  info: (message, extra) => write('INFO', message, extra),
  warn: (message, extra) => write('WARN', message, extra),
  error: (message, extra) => write('ERROR', message, extra),
};
