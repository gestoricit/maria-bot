import { spawn } from 'node:child_process';
import { config } from './config.js';

/**
 * Invoca Claude Code headless com o prompt do usuario.
 * Forca o subagente mar-ia para garantir roteamento consistente.
 *
 * Se passar `sessionId` e o resume falhar (sessao foi limpa, log rotacionado
 * etc.), automaticamente faz fallback para uma sessao nova — preserva a
 * resposta para o usuario em vez de quebrar a conversa.
 *
 * @param {object} args
 * @param {string} args.prompt           Texto do usuario (com prefixo de contexto)
 * @param {string} [args.sessionId]      Id de sessao para continuidade (--resume)
 * @param {string[]} [args.attachments]  Caminhos absolutos de arquivos anexados
 * @returns {Promise<{stdout: string, stderr: string, code: number, sessionId: string|null, resumed: boolean}>}
 */
export async function dispatch({ prompt, sessionId, attachments = [] }) {
  // 1a tentativa: com --resume se sessionId existir
  const first = await runOnce({ prompt, sessionId, attachments });
  if (first.code === 0) return { ...first, resumed: !!sessionId };

  // Se falhou E estavamos tentando resume, retenta sem resume.
  // Padrao de erro tipico: "Session not found" / exit nao-zero com stderr
  // mencionando session.
  if (
    sessionId &&
    (first.stderr.includes('session') ||
      first.stderr.includes('Session') ||
      first.code !== 0)
  ) {
    const retry = await runOnce({ prompt, sessionId: null, attachments });
    return { ...retry, resumed: false };
  }

  return { ...first, resumed: !!sessionId };
}

function runOnce({ prompt, sessionId, attachments }) {
  const ctx = [
    '[origin: whatsapp]',
    sessionId ? `[session: ${sessionId}]` : null,
    attachments.length
      ? `[attachments]\n${attachments.map((a) => `- ${a}`).join('\n')}`
      : null,
    '',
    'Voce e a agente mar.IA. Roteie o pedido abaixo para a skill ou subagente correto e devolva resposta concisa adequada ao WhatsApp.',
    '',
    '---',
    prompt,
  ]
    .filter(Boolean)
    .join('\n');

  const args = [
    '-p',
    ctx,
    '--model',
    config.claudeModel,
    '--output-format',
    'json',
    '--permission-mode',
    'acceptEdits',
  ];

  if (sessionId) {
    args.push('--resume', sessionId);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(config.claudeBin, args, {
      cwd: config.claudeCwd,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timeout apos ${config.claudeTimeoutSec}s`));
    }, config.claudeTimeoutSec * 1000);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        // se nao for JSON, devolve cru
      }
      resolve({
        stdout: parsed?.result ?? stdout,
        stderr,
        code: code ?? 0,
        sessionId: parsed?.session_id ?? null,
      });
    });
  });
}
