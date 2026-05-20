import 'dotenv/config';
import path from 'node:path';
import os from 'node:os';

const required = (key) => {
  const v = process.env[key];
  if (!v) throw new Error(`Variavel de ambiente faltando: ${key}`);
  return v;
};

export const config = {
  allowedNumbers: required('ALLOWED_NUMBERS')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean),
  claudeBin: process.env.CLAUDE_BIN || 'claude',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
  claudeCwd: process.env.CLAUDE_CWD || path.join(os.homedir(), '.agents'),
  inboxDir: process.env.INBOX_DIR || path.join(os.homedir(), 'marIA-in'),
  outboxDir: process.env.OUTBOX_DIR || path.join(os.homedir(), 'marIA-out'),
  whatsappFileLimitMb: Number(process.env.WHATSAPP_FILE_LIMIT_MB || 15),
  claudeTimeoutSec: Number(process.env.CLAUDE_TIMEOUT_SEC || 300),
  logLevel: process.env.LOG_LEVEL || 'info',
  authDir: path.resolve('./auth'),
};

export const isAuthorized = (jid) => {
  const num = jid.split('@')[0].split(':')[0];
  return config.allowedNumbers.includes(num);
};
