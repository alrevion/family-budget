# Security Policy

## Supported versions

Only the latest commit on `main` is supported. The project is a self-hosted family app: every
deployment runs its own Worker and D1 database, so fixes land in `main` and you redeploy.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub’s private reporting: **Security → Advisories → Report a vulnerability** in this
repository. Describe the impact, the affected route or file, and the steps to reproduce. You will
get an answer as soon as possible.

## Threat model

The app protects one family’s data from everyone who is not in that family.

| Asset | Who can reach it | Control |
|---|---|---|
| Expense/income data | Only allowlisted Telegram IDs | Telegram `initData` HMAC signature + 24 h freshness + `ALLOWED_IDS` |
| Bot commands | Anyone who knows the bot | The bot only answers `/start` with a button and never changes data |
| Webhook endpoint | Anyone who knows the URL | `X-Telegram-Bot-Api-Secret-Token` must equal `WEBHOOK_SECRET` |
| Bot token | Cloudflare account only | Worker secret, never in the repository or the bundle |
| D1 database | Cloudflare account only | Not exposed publicly; only the Worker binding |
| Receipt cache | Allowlisted users | Same auth middleware as the rest of the API |

### What is explicitly out of scope

- **Anyone with access to your Cloudflare account** can read the D1 database. “Hidden expenses” are
  a product feature for the other family member, not encryption from the account owner. Use 2FA on
  the Cloudflare account and do not share it.
- **A stolen bot token** lets an attacker call the Bot API as your bot but still cannot read family
  data: the API requires a valid `initData` from an allowlisted Telegram ID. Revoke the token in
  BotFather (`/revoke`) and re-run `npm run setup` to rotate it.
- **OFD receipt lookups** are public by design: the signing key ships in OFD’s own web client and
  only allows reading a receipt by its QR parameters.

## Design notes

### Authentication

`src/auth.ts` verifies the Telegram WebApp `initData`:

1. `secret = HMAC_SHA256(key="WebAppData", data=BOT_TOKEN)`.
2. `data_check_string` is every field except `hash`, sorted by key, joined with `\n`.
3. The signature is compared inside `crypto.subtle.verify` (constant time).
4. `auth_date` must be within the last 24 hours and not in the future.
5. The Telegram ID from the verified payload must be in `ALLOWED_IDS` **before** any D1 query.

### Secrets

| Name | Storage | Notes |
|---|---|---|
| `BOT_TOKEN` | Worker secret | From BotFather; rotate with `/revoke` |
| `WEBHOOK_SECRET` | Worker secret | `openssl rand -hex 32`; also passed to `setWebhook` |
| `ALLOWED_IDS` | Worker secret | Comma-separated Telegram IDs |
| `BOT_USERNAME`, `MINI_APP_URL`, `MINI_APP_SHORT_NAME` | `wrangler.toml` `[vars]` | Public by nature |
| `database_id` | `wrangler.toml` | Not a secret; useless without account access |

`.dev.vars` and `.env*` are git-ignored. The repository contains no tokens, keys, or personal IDs;
the test fixtures use a dummy bot token and fake Telegram IDs.

### Receipts and client-supplied data

Cloudflare’s edge cannot reach `new-ofd.soliq.uz` (OFD blocks datacenter IPs), so the **phone**
signs and performs the OFD request (`app/src/ofd-direct.ts`) and then posts the OFD `data` object to
`/api/receipts/lookup`. The server:

- derives the receipt key (`terminal_id`, `payment_no`, `payment_date`) from the QR itself and
  overrides the values in the client payload;
- normalizes the payload with the same function used for server-side fetches;
- rejects payloads larger than 200 kB and non-objects.

An allowlisted family member could still send arbitrary amounts. That is accepted: the allowlist is
the trust boundary, and all family members share the same budget anyway. Do not add strangers to
`ALLOWED_IDS`.

### Headers and frontend

`app/_headers` sets a strict Content-Security-Policy (`default-src 'self'`, scripts from
`telegram.org`, `connect-src` only to the API and `new-ofd.soliq.uz`), `nosniff`,
`Referrer-Policy: no-referrer`, and a restrictive `Permissions-Policy`. Framing is allowed only for
Telegram (`frame-ancestors`), because Telegram Web embeds the Mini App in an iframe.

The UI writes user data with `textContent`; `innerHTML` is used only for static SVG icons and
charts built from numbers.

### Dependencies

`npm audit --omit=dev` is clean: the only runtime dependency is Hono. `npm audit` still reports
advisories in **dev-only** tooling (Wrangler/Miniflare/undici/sharp inside the test pool). They are
not shipped to the Worker and cannot be triggered by app traffic; they are updated together with
the test toolchain. CI runs type checks and the full test suite on every push.

## Hardening checklist for your own deployment

- [ ] Enable 2FA on the Cloudflare account.
- [ ] Keep `ALLOWED_IDS` minimal; remove people who should lose access.
- [ ] Use a random `WEBHOOK_SECRET` (`openssl rand -hex 32`); `npm run setup` generates one.
- [ ] Rotate `BOT_TOKEN` in BotFather if it was ever pasted into a chat or a screenshot.
- [ ] Do not commit `.dev.vars`.
- [ ] Review `npx wrangler tail` after major changes; the Worker logs OFD failures without secrets.

---

## По-русски

- Сообщать об уязвимостях — только через приватные GitHub Advisories, не публичным issue.
- Секретов в репозитории нет: токен бота, webhook-секрет и allowlist — секреты Worker’а.
- Каждый запрос к API проверяет подпись Telegram `initData`, свежесть 24 часа и allowlist.
- «Скрытые траты» — продуктовая функция для второго члена семьи, а не шифрование от владельца
  аккаунта Cloudflare.
- Ключ подписи ОФД публичен по природе: он лежит в открытом JS самого ОФД.
- Предупреждения `npm audit` относятся только к dev-зависимостям (Wrangler, Miniflare, sharp) и
  не попадают в продовый Worker; `npm audit --omit=dev` чист.
