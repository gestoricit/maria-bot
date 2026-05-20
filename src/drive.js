import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from './config.js';

/**
 * Faz upload de um arquivo local para o Google Drive via rclone e devolve um
 * link compartilhado. Requer que o usuario tenha rodado `rclone config` no
 * VPS para configurar o remote (ver docs/DRIVE_SETUP.md).
 *
 * @param {string} localPath  Caminho absoluto do arquivo no VPS.
 * @param {string} [destName] Nome do arquivo no Drive (default = basename).
 * @returns {Promise<{url: string, remotePath: string}>}
 * @throws  Error com mensagem clara se rclone nao estiver configurado ou
 *          o remote nao existir.
 */
export async function uploadToDrive(localPath, destName) {
  if (!config.driveRemoteName) {
    throw new Error(
      'DRIVE_REMOTE_NAME nao configurado no .env. Veja docs/DRIVE_SETUP.md para configurar rclone com Google Drive.'
    );
  }

  const name = destName || path.basename(localPath);
  const remotePath = `${config.driveRemoteName}:${config.driveFolder}/${name}`;

  await runRclone(['copyto', localPath, remotePath, '--drive-acknowledge-abuse']);
  const url = await runRclone(['link', remotePath]);

  return { url: url.trim(), remotePath };
}

/**
 * Roda um comando rclone e devolve o stdout. Lanca erro se exit != 0.
 */
function runRclone(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.rcloneBin, args, { env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => reject(new Error(`rclone spawn falhou: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `rclone exit ${code} (cmd: ${args.join(' ')}): ${stderr.trim() || stdout.trim()}`
          )
        );
      }
    });
  });
}

/**
 * Helper: tenta upload para Drive e devolve uma mensagem de status pronta para
 * mandar via WhatsApp. Nao lanca — em caso de erro, devolve mensagem com path
 * local como fallback.
 */
export async function uploadOrFallback(file) {
  if (!config.driveRemoteName) {
    return {
      ok: false,
      text: `Arquivo grande (${(file.size / 1024 / 1024).toFixed(1)} MB) salvo em:\n${file.path}\nDrive nao configurado — baixa via SCP.`,
    };
  }
  try {
    const { url } = await uploadToDrive(file.path, file.name);
    return {
      ok: true,
      text: `Arquivo grande (${(file.size / 1024 / 1024).toFixed(1)} MB) no Drive:\n${url}`,
    };
  } catch (err) {
    return {
      ok: false,
      text: `Falha no upload Drive (${err.message}).\nArquivo local: ${file.path}`,
    };
  }
}
