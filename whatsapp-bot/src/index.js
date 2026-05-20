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

import { config, isAuthorized } from './config.js';
import { dispatch } from './dispatcher.js';
import { ensureDirs, saveIncomingMedia, listNewOutputs } from './attachments.js';

const logger = pino({ level: config.logLevel });
const sessions = new Map(); // jid -> sessionId
const sentByBot = new Set(); // key.id de msgs enviadas pelo bot (evita loop em self-chat)

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
    if (type !== 'notify') return;
    for (const msg of messages) {
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
  // Se a msg veio da nossa propria conta:
  //  - se foi enviada pelo bot (id no sentByBot) -> eh eco, ignora
  //  - se foi digitada pelo usuario no self-chat -> processa
  if (msg.key.fromMe && sentByBot.has(msg.key.id)) return;

  const jid = msg.key.remoteJid;
  if (!jid || jid.endsWith('@g.us')) return; // ignora grupos por padrao

  // Em self-chat, autoriza pelo proprio numero conectado
  const ownerJid = sock.user?.id?.split(':')[0]?.split('@')[0];
  const senderNum = jid.split('@')[0].split(':')[0];
  const isSelfChat = msg.key.fromMe && senderNum === ownerJid;

  if (!isSelfChat && !isAuthorized(jid)) {
    logger.warn({ jid }, 'Numero nao autorizado');
    return;
  }
  if (isSelfChat && !config.allowedNumbers.includes(ownerJid)) {
    logger.warn({ ownerJid }, 'Self-chat: numero do bot nao esta em ALLOWED_NUMBERS');
    return;
  }

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    '';

  // Comandos administrativos
  if (text.trim().toLowerCase() === '/reset') {
    sessions.delete(jid);
    await send(sock, jid, { text: 'Sessao reiniciada.' });
    return;
  }
  if (text.trim().toLowerCase() === '/ping') {
    await send(sock, jid, { text: 'pong' });
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
  const result = await dispatch({
    prompt: text || '(somente anexo enviado, sem texto)',
    sessionId,
    attachments,
  });

  if (result.sessionId) sessions.set(jid, result.sessionId);

  // Texto da resposta
  const replyText = (result.stdout || '').trim() || '(sem resposta)';
  await send(sock, jid, { text: replyText });

  // Arquivos novos no outbox => devolve via WhatsApp ou avisa caminho
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
      await send(sock, jid, {
        text: `Arquivo grande (${(f.size / 1024 / 1024).toFixed(1)} MB) salvo em:\n${f.path}\nUse Drive para baixar.`,
      });
    }
  }

  await send(sock, jid, { react: { text: '✅', key: msg.key } });
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

start().catch((err) => {
  logger.fatal({ err }, 'Falha ao iniciar mar.IA bot');
  process.exit(1);
});
