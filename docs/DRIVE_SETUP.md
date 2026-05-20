# Configurar Google Drive para arquivos grandes

Quando a mar.IA produz um arquivo acima de `WHATSAPP_FILE_LIMIT_MB` (default 15 MB), em vez de tentar mandar pelo WhatsApp ela sobe para o Google Drive e devolve um link. Para isso, configure `rclone` uma vez no VPS.

## Passo 1 — Garanta que `rclone` esta instalado

O `setup-vps.sh` ja instala. Confirme:

```bash
rclone version
```

## Passo 2 — Configure o remote Drive

```bash
rclone config
```

Use o assistente interativo:

1. `n` para novo remote.
2. Nome: escolha algo curto, ex.: `gdrive`.
3. Tipo: digite `drive` (Google Drive).
4. `client_id` e `client_secret`: deixe em branco (usa app padrao do rclone).
5. Scope: `1` (Full access).
6. `root_folder_id`: opcional. Se quiser que tudo va para uma pasta especifica do Drive, pegue o ID da URL da pasta e cole aqui.
7. `service_account_file`: pular.
8. Edit advanced config: `n`.
9. Use auto config: `n` (VPS sem browser).
10. Vai aparecer um comando para rodar localmente:
   ```bash
   rclone authorize "drive"
   ```
   Rode esse comando **no seu Windows** (em Git Bash ou PowerShell com rclone instalado), faca o login OAuth no browser, e copie o token JSON gerado. Cole de volta no VPS.
11. Configure as a team drive: `n` (a menos que seja Workspace org).
12. Confirma `y`, salva `y`, fecha com `q`.

Verifique que funcionou:

```bash
rclone ls gdrive: | head -5
```

## Passo 3 — Configure o .env do bot

Em `/root/maria-bot/.env`:

```
DRIVE_REMOTE_NAME=gdrive
DRIVE_FOLDER=mar.IA Out
```

`DRIVE_FOLDER` e a subpasta dentro do remote onde os arquivos serao colocados. Se a pasta nao existir, o `rclone copyto` a cria automaticamente.

## Passo 4 — Reinicie o bot

```bash
pm2 restart maria-bot
```

## Passo 5 — Teste

Mande algo que gere um arquivo grande (ex.: planilha consolidando muitos contracheques). O bot deve responder com um link `https://drive.google.com/...` em vez do path local.

Sem configurar, o bot continua funcionando — apenas devolve o path local no VPS (`/root/marIA-out/...`) e pede para voce baixar via SCP. Drive e estritamente um upgrade de UX.

## Troubleshooting

**`rclone exit 1: failed to create directory`**: a pasta `mar.IA Out` no Drive nao pode ser criada por algum motivo (cota, permissao). Cria manualmente no Drive Web e refaz o teste.

**`rclone: command not found`**: ajuste `RCLONE_BIN` no `.env` para o caminho absoluto (`which rclone` no VPS).

**Token expirou**: rode `rclone config reconnect gdrive:` para renovar.

**`Drive: nao configurado` no `/stats`**: confirma que `DRIVE_REMOTE_NAME` esta preenchido no `.env` e que reiniciou o bot.
