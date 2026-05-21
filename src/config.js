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
  // Drive (opcional) — preencha apenas se quiser que arquivos acima do
  // limite WhatsApp subam para o Drive. Ver docs/DRIVE_SETUP.md.
  rcloneBin: process.env.RCLONE_BIN || 'rclone',
  driveRemoteName: process.env.DRIVE_REMOTE_NAME || '',
  driveFolder: process.env.DRIVE_FOLDER || 'mar.IA Out',
  // RT1 — rate limit per-JID (default 30 dispatches / 60 min).
  rateLimitMaxPerWindow: Number(process.env.RATE_LIMIT_MAX || 30),
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MIN || 60) * 60 * 1000,
};

export const normalizeJid = (jid) => (jid || '').split('@')[0].split(':')[0];

export const isAuthorized = (jid) => config.allowedNumbers.includes(normalizeJid(jid));
