# 🍬 Candy Games

A candy-styled mini-games hub for a Telegram friend group: log in with your
Telegram account (name + profile pic become your profile automatically), see
who's online right now, and challenge friends to realtime 1v1 Tic-Tac-Toe.

## Features

- **Telegram login** — official Telegram Login Widget, verified server-side (HMAC-SHA256).
- **Auto profile** — uses your Telegram first name and profile photo; falls back to a generated initial avatar.
- **Live presence** — the list of people currently on the site updates in real time (join / leave / in-game status).
- **1v1 Tic-Tac-Toe** — send a challenge, opponent gets a candy notification with **Accept / Decline**, game is played live over WebSockets with scores and rematch.
- **Candy design** — soft pastel gradients, rounded chunky cards, bouncy animations, and a confetti burst on wins.

## Setup

### 1. Create your Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram.
2. `/newbot` → pick a name and username (e.g. `candy_games_xyz_bot`). BotFather gives you a **bot token**.
3. `/setdomain` → select your bot and set the domain where the site will run
   (e.g. `localhost` for local testing, or `yourdomain.com` when deployed).
   **The login widget will not appear without this.**

### 2. Configure the app

Credentials come from environment variables. For local development, copy
`config.example.js` to `config.js` and fill it in:

```bash
cp config.example.js config.js
```

Or export the env vars directly:

```
BOT_USERNAME=your_bot_username
BOT_TOKEN=123456:ABC-DEF...
PORT=3000
```

Never commit the real bot token — on deploy platforms, set these two env vars
in the service settings instead.

### 3. Run it

```bash
npm install
npm start
```

Open `http://localhost:3000`. Test by opening the page in two browser
windows (log in with two different Telegram accounts — one on phone, one on
desktop) and challenge yourself.

### 4. Deploy

Anything with HTTPS + WebSockets works. The Telegram widget **requires HTTPS**
(except `localhost`), and the domain must match what you set in BotFather.

Easiest options:
- **Render** — this repo has a `render.yaml` blueprint, so it deploys with one
  click. Create a free service from the repo, then set `BOT_USERNAME` and
  `BOT_TOKEN` as environment variables.
- **Railway** — import the GitHub repo, Railway auto-detects Node (Nixpacks),
  set the same two env vars.
- **A VPS** — `git clone`, `npm install`, run with a process manager (pm2 / systemd) behind nginx/caddy with a TLS cert.

Then set the HTTPS domain in BotFather (`/setdomain`) and share the link in
your Telegram group. 🎉

## How it works

- `server.js` — Express + Socket.IO. Verifies Telegram login data, tracks presence, routes game requests, and runs the authoritative Tic-Tac-Toe game engine.
- `public/` — single-page frontend (vanilla JS, no build step): login screen, online list, challenge notification banner, and the game board.
- Presence is in-memory: when the server restarts, everyone reconnects and re-appears automatically.

## Notes

- Sessions live in server memory. Restarting the server just makes everyone log in again — no data is stored.
- Only two people max per game. A player already in a game can't be challenged.
- The profile photo comes from the Telegram widget; for some users it's not exposed, in which case a colorful initial avatar is used.
