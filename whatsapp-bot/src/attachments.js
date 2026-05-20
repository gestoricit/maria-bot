import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { config } from './config.js';

const EXT_MAP = {
  imageMessage: 'jpg',
  documentMessage: null, // pega do mimetype/filename
  audioMessage: 'ogg',
  videoMessage: 'mp4',
};

export async function ensureDirs() {
  await fs.mkdir(config.inboxDir, { recursive: true });
  await fs.mkdir(config.outboxDir, { recursive: true });
}

/**
 * Baixa midia de uma mensagem WhatsApp e salva em INBOX_DIR.
 * Retorna caminho absoluto ou null se nao houver midia.
 */
export async function saveIncomingMedia(msg, sock, logger) {
  const m = msg.message;
  if (!m) return null;
  const type = Object.keys(m).find((k) => EXT_MAP.hasOwnProperty(k));
  if (!type) return null;

  const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });

  const stamp = Date.now();
  const sender = msg.key.remoteJid.split('@')[0];
  const filename =
    m[type]?.fileName ||
    `${type.replace('Message', '')}_${stamp}.${EXT_MAP[type] || 'bin'}`;
  const safe = filename.replace(/[^\w.\-]+/g, '_');
  const dest = path.join(config.inboxDir, `${sender}_${stamp}_${safe}`);
  await fs.writeFile(dest, buffer);
  return dest;
}

/**
 * Lista arquivos novos em OUTBOX_DIR criados depois de `since` (timestamp ms).
 * Usado para detectar artefatos gerados pelo claude.
 */
export async function listNewOutputs(since) {
  try {
    const entries = await fs.readdir(config.outboxDir, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const full = path.join(config.outboxDir, e.name);
      const stat = await fs.stat(full);
      if (stat.mtimeMs >= since) {
        out.push({ path: full, size: stat.size, name: e.name });
      }
    }
    return out;
  } catch {
    return [];
  }
}
