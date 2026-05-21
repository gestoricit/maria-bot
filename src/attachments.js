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

// AT2 (Rev.1.0.1) — limite de tamanho do anexo recebido.
// Default 30MB — cobre PDFs de processos longos + áudios curtos. Configurável
// via env INBOX_MAX_MB. Baileys downloadMediaMessage carrega o buffer inteiro
// em RAM, então sem limite um atacante autorizado pode disparar OOM.
const INBOX_MAX_BYTES = (Number(process.env.INBOX_MAX_MB || 30)) * 1024 * 1024;

export async function ensureDirs() {
  await fs.mkdir(config.inboxDir, { recursive: true });
  await fs.mkdir(config.outboxDir, { recursive: true });
}

/**
 * Baixa midia de uma mensagem WhatsApp e salva em INBOX_DIR.
 * Retorna caminho absoluto ou null se nao houver midia (ou se excede limite).
 *
 * AT2 (Rev.1.0.1): rejeita anexos > INBOX_MAX_BYTES antes do download.
 * Path safety: filename sanitizado via regex que neutraliza '/'; '..' fica
 * literal sem ser interpretado como up-dir (validado).
 */
export async function saveIncomingMedia(msg, sock, logger) {
  const m = msg.message;
  if (!m) return null;
  const type = Object.keys(m).find((k) => EXT_MAP.hasOwnProperty(k));
  if (!type) return null;

  // AT2 — verificar tamanho ANTES de baixar (evita alocar 1GB em RAM).
  // `fileLength` vem como Long ou number; convertendo defensivamente.
  const rawLen = m[type]?.fileLength;
  const declaredSize = typeof rawLen === 'object' && rawLen?.low !== undefined
    ? Number(rawLen.low) + Number(rawLen.high || 0) * 2 ** 32
    : Number(rawLen || 0);
  if (declaredSize > INBOX_MAX_BYTES) {
    logger.warn(
      { type, declaredSize, max: INBOX_MAX_BYTES },
      'Anexo rejeitado (excede INBOX_MAX_MB)'
    );
    return null;
  }

  const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });

  // AT2 — double-check pós-download (declaredSize pode mentir).
  if (buffer.length > INBOX_MAX_BYTES) {
    logger.warn(
      { type, actualSize: buffer.length, max: INBOX_MAX_BYTES },
      'Anexo descartado pós-download (declared mentiu)'
    );
    return null;
  }

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
