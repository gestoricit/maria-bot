# /ultraplan — Auditoria maria-bot (mar.IA bridge)

> Auditoria do bridge WhatsApp ↔ Claude Code que roda em PM2 (uptime 28h verificado).
>
> Repo **NÃO está no GitHub** (`git log` retorna "no commits yet"). Esta auditoria é local — se quiser publicar, basta `git init && git remote add origin <url>` depois.
>
> **Data**: 2026-05-20.

---

## TL;DR

| Item | Risco | Esforço |
|---|---|---|
| **AC1** — Claude Code roda com `acceptEdits` + Bash sem sandbox | Alto se atacante entra no whitelist | Médio (arquitetura) |
| **RT1** — sem rate limiting interno; mensagem → 1 invocação Claude | Médio (consume quota Max) | 30 min |
| **LG1** — pino sem rotação de log; PM2 talvez | Baixo | 10 min |
| **AT1** — `auth/` (sessions WhatsApp) sem backup automatizado | Médio (perda = repareamento via QR) | 20 min |
| **VC1** — sem versionamento (git init não rodou) | Médio (perda = recriar do zero) | 5 min |

Nada **crítico imediato**. Bot está bem desenhado pra escopo single-user; gaps são "operacionais" — escalabilidade e disaster recovery.

---

## 1 — Modelo de ameaças

**Atacante interno** (alguém em ALLOWED_NUMBERS):
- Pode disparar invocações Claude arbitrárias → consume quota Max
- Claude Code roda com `--permission-mode acceptEdits` + Bash tool → pode executar shell arbitrário no diretório `claudeCwd` (`~/.agents`)
- Pode chegar a outros recursos via skills/MCP servers configurados no Claude Code daquela máquina

**Atacante externo**:
- WhatsApp tem MitM resistance via Signal Protocol (Baileys honra isso)
- Whitelist em `isAuthorized()` bloqueia números fora da lista ✓
- Mas se WhatsApp da Maria for comprometido (cell tower attack, sim-swap), atacante pode falar como ela → ganha acesso ao bot

**Conclusão**: modelo de ameaça depende inteiramente da **confiança nas contas WhatsApp listadas**. Em produção, vale rever periodicamente quem está em `ALLOWED_NUMBERS`.

---

## 2 — Achados por eixo

### 2.1 Segurança (AC1+AC2)

#### AC1 (P1) — Claude com `acceptEdits` + Bash sem sandbox

`dispatcher.js` linha 62: `'--permission-mode', 'acceptEdits'`

Necessário (WhatsApp não tem interatividade), mas amplifica risco. Possíveis mitigações:
- **AC1a**: limitar tools acessíveis no Claude Code do `claudeCwd` via `.claude/settings.json` com permissions explícitas (ex: bloquear `rm -rf`, `curl http://*` exceto whitelist)
- **AC1b**: rodar Claude em container Docker com mounts read-only além do `inboxDir`/`outboxDir`
- **AC1c**: aceitar o risco — modelo single-user/escritório de confiança

Esforço (a): **1h**. Esforço (b): **4h**. Recomendação: começar com (a).

#### AC2 (P3) — `spawn(claudeBin, args)` com prompt no array — sem shell injection ✓

Verificado: `args = ['-p', ctx, ...]` passa pro `spawn` direto (sem shell). `ctx` é texto puro. **Sem shell injection** mesmo se atacante mandar `$(rm -rf /)` no prompt. ✓

### 2.2 Rate limiting (RT1)

#### RT1 (P1) — sem rate limit por sender

Atacante interno (ou usuário legítimo entusiasmado) pode disparar invocações em rajada. Cada invoke = tokens consumidos no plano Max + tempo de processamento.

**Fix**: per-JID counter com janela deslizante. Ex: máx 30 dispatches/hora por JID. Esforço: **30 min**.

```javascript
// Esboço
const rateLimit = new Map(); // jid -> [timestamps]
const WINDOW_MS = 3600_000;
const MAX_PER_WINDOW = 30;

function withinRateLimit(jid) {
  const now = Date.now();
  const arr = (rateLimit.get(jid) || []).filter(t => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) return false;
  arr.push(now);
  rateLimit.set(jid, arr);
  return true;
}
```

### 2.3 Logs e observabilidade

#### LG1 (P2) — sem rotação

Verifiquei `/root/maria-bot/logs/` rapidamente — pino default escreve sem rotação. PM2 tem `pm2 install pm2-logrotate` que resolve. Esforço: **10 min**.

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 5
```

#### LG2 (P3) — sem metric endpoint

`stats` é só comando WhatsApp `/stats`. Em produção valeria expor `/metrics` em HTTP local (Prometheus) ou cron pra alertar quando `lastError.at` é recente. Esforço: **30 min** se decidir implementar.

### 2.4 Auth state / disaster recovery

#### AT1 (P1) — sessions sem backup

`/root/maria-bot/auth/` tem ~50KB de credentials Baileys (pre-keys, sender-keys, sessions). Se esse diretório corrompe ou some, precisa reparear via QR Code → user precisa estar fisicamente perto do celular dele com WhatsApp aberto.

**Fix**: backup daily em local outro (Drive via rclone, ou tar+scp pra outro host). Esforço: **20 min**.

```bash
# cron daily
0 3 * * * tar czf /tmp/maria-bot-auth-$(date +\%Y\%m\%d).tar.gz -C /root/maria-bot auth/ && \
  rclone copy /tmp/maria-bot-auth-*.tar.gz mcm-drive:backups/maria-bot/
```

### 2.5 Versionamento

#### VC1 (P1) — sem git remote

`git -C /root/maria-bot log` retorna "no commits yet". Código existe só localmente.

**Risco**: queda do disco da VPS = perda total. Tem `auth/` que perderia tanto código quanto credentials.

**Fix**: criar repo privado no GitHub (já tem token) + commit + push. Esforço: **5 min**.

**Cuidado**: `auth/` e `.env` precisam ficar no `.gitignore`.

### 2.6 Acoplamento Claude Code

#### CL1 (P2) — claudeBin hardcoded vs PATH

`config.claudeBin = process.env.CLAUDE_BIN || 'claude'`. Se PATH muda (update do Claude Code, mudança de versão), pode quebrar.

Esforço (mitigação): documentar versão atual no README e fixar via `CLAUDE_BIN=/exact/path` no `.env`. **5 min.**

#### CL2 (P3) — sessão por JID em memória

`sessions = new Map()` perde estado em restart. PM2 reload = todas conversas perdem continuidade. Aceitável pra escopo atual; pra escalar valeria persistir em arquivo.

### 2.7 Anexos (não auditado profundamente)

`saveIncomingMedia` e `listNewOutputs` em `attachments.js` não foram lidos. Recomendação: verificar:
- Tamanho máximo de download (DoS por anexo enorme)
- Tipos MIME aceitos
- Path traversal no nome do arquivo

Esforço **30 min** pra audit completo. Marcar como **AT2 (P2)**.

---

## 3 — Plano de execução

### Sprint 0 — fundação (1-2h)
| Item | Esforço | Status |
|---|---|---|
| VC1: git init + push pra GitHub | 5 min | ✅ **commit c112205** |
| AT1: backup automatizado das sessions Baileys | 20 min | ✅ **scripts/backup-auth.sh + /etc/cron.d/maria-bot-backup** (cron 03:15 daily, retenção 14d) |
| LG1: pm2-logrotate | 10 min | ✅ **pm2 install pm2-logrotate** (max 50M × 5 backups, compress) |
| RT1: rate limit per-JID | 30 min | ✅ **rateLimitCheck() em src/index.js** (30 dispatches / 60min default) |

### Sprint 1 — robustez (2-3h)
| Item | Esforço |
|---|---|
| AC1a: `.claude/settings.json` com permissions explícitas | 1h |
| AT2: auditoria de `attachments.js` | 30 min |
| CL1: fixar CLAUDE_BIN absoluto + documentar versão | 5 min |
| LG2: `/metrics` endpoint ou alert cron | 30 min |

### Sprint 2 — opcional
| Item | Esforço |
|---|---|
| AC1b: sandbox Docker do Claude subprocess | 4h |
| CL2: persistir sessions em disco | 1h |

---

## 4 — Riscos não cobertos

- **WhatsApp tos**: Baileys é cliente não-oficial; uso intensivo pode disparar ban da conta. Maria perde acesso ao próprio WhatsApp. Mitigação: rate limit + uso "natural" (não bulk).
- **Atualização Baileys**: API privada da Meta muda. Cada update do Baileys (`^6.7.9`) pode quebrar. Pin versão exata depois de validar.

---

## Changelog Rev.1.0.0

- Inicial. 12 itens P1-P3 catalogados. Nenhum P0 crítico no estado atual.
