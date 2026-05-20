import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'node:fs/promises';
import path from 'node:path';

import { config, isAuthorized, normalizeJid } from './config.js';
import { dispatch } from './dispatcher.js';
import { ensureDirs, saveIncomingMedia, listNewOutputs } from './attachments.js';
import { uploadOrFallback } from './drive.js';

const logger = pino({ level: config.logLevel });
const sessions = new Map(); // jid -> sessionId
const sentByBot = new Set(); // key.id de msgs enviadas pelo bot (evita loop em self-chat)

const stats = {
  startedAt: Date.now(),
  totalDispatches: 0,
  lastDispatchAt: null,
  lastError: null,
};

let activeSocket = null; // referencia para /reconnect e shutdown handlers

async function send(sock, jid, content) {
  const r = await sock.sendMessage(jid, content);
  const id = r?.key?.id;
  if (id) {
    sentByBot.add(id);
    if (sentByBot.size > 500) {
      const arr = Array.from(sentByBot);
      sentByBot.clear();
      arr.slice(-250).forEach((x) => sentByBot.add(x));
    }
  }
  return r;
}

async function start() {
  await ensureDirs();
  await fs.mkdir(config.authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);
  activeSocket = sock;

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      logger.info('Escaneie o QR code abaixo no WhatsApp (Aparelhos conectados):');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn({ code, shouldReconnect }, 'Conexao fechada');
      if (shouldReconnect) setTimeout(start, 3000);
    } else if (connection === 'open') {
      logger.info('mar.IA conectada ao WhatsApp');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    logger.info({ type, count: messages.length }, '>>> messages.upsert disparou');
    if (type !== 'notify') return;
    for (const msg of messages) {
      logger.info(
        {
          fromMe: msg.key.fromMe,
          jid: msg.key.remoteJid,
          id: msg.key.id,
          hasText: !!(msg.message?.conversation || msg.message?.extendedTextMessage?.text),
        },
        '>>> msg recebida'
      );
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        logger.error({ err }, 'Falha processando mensagem');
        const jid = msg.key.remoteJid;
        await send(sock, jid, { text: `Erro: ${err.message}` });
      }
    }
  });
}

async function handleMessage(sock, msg) {
  // Eco da propria resposta -> ignora
  if (msg.key.fromMe && sentByBot.has(msg.key.id)) return;

  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith('@g.us')) return; // ignora grupos

  // Identificadores do owner (a conta pareada). Hoje o WhatsApp usa
  // tanto o numero (...@s.whatsapp.net) quanto o LID (...@lid).
  const ownerNumber = normalizeJid(sock.user?.id);   // ex: "553499723818"
  const ownerLid = normalizeJid(sock.user?.lid);     // ex: "55310639177798"
  const senderNum = normalizeJid(jid);

  // Self-chat: bate o jid do remetente com o numero OU LID do owner
  const isSelfChat =
    msg.key.fromMe && (senderNum === ownerNumber || senderNum === ownerLid);

  if (!isSelfChat && !isAuthorized(jid)) {
    logger.warn({ jid, ownerNumber, ownerLid }, 'Numero nao autorizado');
    return;
  }
  if (isSelfChat && !config.allowedNumbers.includes(ownerNumber)) {
    logger.warn(
      { ownerNumber, allowed: config.allowedNumbers },
      'Self-chat: numero do bot nao esta em ALLOWED_NUMBERS'
    );
    return;
  }

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    '';

  // Comandos administrativos
  const cmd = text.trim().toLowerCase();
  if (cmd === '/reset') {
    sessions.delete(jid);
    await send(sock, jid, { text: 'Sessao reiniciada.' });
    return;
  }
  if (cmd === '/ping') {
    await send(sock, jid, { text: 'pong' });
    return;
  }
  if (cmd === '/help' || cmd === '/?') {
    await send(sock, jid, { text: helpText() });
    return;
  }
  if (cmd === '/stats') {
    await send(sock, jid, { text: statsText() });
    return;
  }
  if (cmd === '/reconnect') {
    await send(sock, jid, { text: 'Reconectando WhatsApp...' });
    sock.end(new Error('Reconnect requested by user'));
    return;
  }

  // Baixa anexo se houver
  const attachments = [];
  const saved = await saveIncomingMedia(msg, sock, logger);
  if (saved) {
    attachments.push(saved);
    logger.info({ saved }, 'Anexo recebido');
  }

  if (!text && !attachments.length) return;

  // Reacao indicando processamento
  await send(sock, jid, { react: { text: '⏳', key: msg.key } });

  const startedAt = Date.now();
  const sessionId = sessions.get(jid);
  let result;
  try {
    result = await dispatch({
      prompt: text || '(somente anexo enviado, sem texto)',
      sessionId,
      attachments,
    });
    stats.totalDispatches += 1;
    stats.lastDispatchAt = Date.now();
  } catch (err) {
    stats.lastError = { at: Date.now(), message: err.message };
    throw err;
  }

  if (result.sessionId) sessions.set(jid, result.sessionId);

  // Texto da resposta
  const replyText = (result.stdout || '').trim() || '(sem resposta)';
  await send(sock, jid, { text: replyText });

  // Arquivos novos no outbox => devolve via WhatsApp, ou sobe pro Drive se grande
  const limitBytes = config.whatsappFileLimitMb * 1024 * 1024;
  const newFiles = await listNewOutputs(startedAt);
  for (const f of newFiles) {
    if (f.size <= limitBytes) {
      await send(sock, jid, {
        document: { url: f.path },
        fileName: f.name,
        mimetype: guessMime(f.name),
      });
    } else {
      const { text: msg } = await uploadOrFallback(f);
      await send(sock, jid, { text: msg });
    }
  }

  await send(sock, jid, { react: { text: '✅', key: msg.key } });
}

function helpText() {
  return [
    'mar.IA — comandos:',
    '/ping — vivo?',
    '/help — esta lista',
    '/stats — uptime, sessoes, dispatches',
    '/reset — zera sessao atual',
    '/reconnect — reconecta WhatsApp (mantem skills/auth)',
    '',
    'Em linguagem natural: redija contestacao, calcula DAS, manda email, agenda reuniao, valida PJC, extrai dados do PJe, etc. Ver docs/COMANDOS.md.',
    '',
    'Anexos: pode mandar PDF, imagem, audio — o bot baixa pra inbox e roteia.',
    `Arquivos >${config.whatsappFileLimitMb}MB voltam via Drive (se configurado) ou via path no VPS.`,
  ].join('\n');
}

function statsText() {
  const uptimeMs = Date.now() - stats.startedAt;
  const h = Math.floor(uptimeMs / 3600000);
  const m = Math.floor((uptimeMs % 3600000) / 60000);
  const lastDisp = stats.lastDispatchAt
    ? new Date(stats.lastDispatchAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
    : 'nunca';
  const lastErr = stats.lastError
    ? `\nUltimo erro: ${new Date(stats.lastError.at).toISOString().slice(0, 19)}Z — ${stats.lastError.message}`
    : '';
  return [
    'mar.IA stats:',
    `Uptime: ${h}h${m.toString().padStart(2, '0')}m`,
    `Sessoes ativas: ${sessions.size}`,
    `Dispatches: ${stats.totalDispatches}`,
    `Ultimo dispatch: ${lastDisp}`,
    `Drive: ${config.driveRemoteName ? `OK (${config.driveRemoteName})` : 'nao configurado'}`,
    `Numeros autorizados: ${config.allowedNumbers.length}`,
    lastErr,
  ].join('\n');
}

function guessMime(name) {
  const ext = path.extname(name).toLowerCase();
  const map = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.zip': 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

// Graceful shutdown — PM2 manda SIGINT em reload; sem isso o socket WhatsApp
// fica zumbi e a sessao precisa ser repareada no proximo start.
async function shutdown(signal) {
  logger.info({ signal }, 'Recebido sinal de shutdown — encerrando socket WhatsApp...');
  try {
    if (activeSocket) {
      activeSocket.end(new Error(`Shutdown via ${signal}`));
    }
  } catch (err) {
    logger.error({ err }, 'Erro fechando socket no shutdown');
  }
  // Da 1s pro Baileys flush e sai limpo
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection — bot continua, mas investigar');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException — abortando');
  process.exit(1);
});

start().catch((err) => {
  logger.fatal({ err }, 'Falha ao iniciar mar.IA bot');
  process.exit(1);
});
