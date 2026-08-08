// server.js — Candy Games backend: Telegram login verification, live presence,
// challenge requests, and the authoritative realtime 1v1 Tic-Tac-Toe engine.
import express from "express";
import http from "http";
import crypto from "crypto";
import { Server } from "socket.io";
import { config } from "./config.js";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const httpServer = http.createServer(app);
const io = new Server(httpServer, { maxHttpBufferSize: 1e6 });

const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];
const REQUEST_TTL_MS = 30_000;
const GAME_LINGER_MS = 5 * 60_000;

const sessions = new Map(); // token        -> { telegramId, profile, createdAt }
const users = new Map(); //    telegramId   -> { profile, sockets:Set<socketId> }
const socketToUser = new Map(); // socketId  -> telegramId
const games = new Map(); //    gameId       -> game
const requests = new Map(); // requestId    -> { from, to, createdAt }

const otherSeat = (seat) => (seat === 0 ? 1 : 0);

// --- Telegram Bot API helpers ----------------------------------------------
const TG_API = `https://api.telegram.org/bot${config.botToken}`;
const botConfigured = () => !/YOUR_|CHANGE_ME/.test(config.botToken);

async function tgCall(method, params = {}) {
  const qs = new URLSearchParams(params).toString();
  try {
    const res = await fetch(`${TG_API}/${method}?${qs}`);
    const json = await res.json();
    return json && json.ok ? json.result : null;
  } catch {
    return null;
  }
}

// Builds a profile for a Telegram user by looking them up with the bot.
// Requires the user to have pressed Start on the bot at least once.
async function profileFromChatId(chatId) {
  if (!botConfigured()) return null;
  const chat = await tgCall("getChat", { chat_id: chatId });
  if (!chat || chat.type !== "private") return null;
  let photo = "";
  if (chat.photo) {
    const file = await tgCall("getFile", { file_id: chat.photo.small_file_id });
    if (file) photo = `/api/photo?file_id=${encodeURIComponent(file.file_id)}`;
  }
  return {
    id: String(chat.id),
    firstName: String(chat.first_name || "").trim(),
    lastName: String(chat.last_name || "").trim(),
    username: String(chat.username || "").trim(),
    photo,
  };
}

// --- REST endpoints --------------------------------------------------------
app.get("/api/config", (_req, res) => {
  res.json({
    botUsername: config.botUsername,
    configured: !/YOUR_|CHANGE_ME/.test(config.botUsername) && !/YOUR_|CHANGE_ME/.test(config.botToken),
  });
});

// Quick login: enter your numeric Telegram ID, server looks up your real
// name + profile pic via the bot.
app.post("/api/auth/id", async (req, res) => {
  const chatId = String(req.body?.chatId || "").trim();
  if (!/^\d{4,}$/.test(chatId)) {
    return res.status(400).json({ error: "That doesn't look like a Telegram ID. It should be a number." });
  }
  const profile = await profileFromChatId(chatId);
  if (!profile) {
    return res.status(404).json({
      error: "No user found with that ID. Open @Gojobot1_bot and press Start first, then try again.",
    });
  }
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { telegramId: profile.id, profile, createdAt: Date.now() });
  res.json({ token, profile });
});

// Photo proxy so the bot token never reaches the browser (profile pics from
// the Telegram API include token-scoped file paths).
app.get("/api/photo", async (req, res) => {
  const fileId = String(req.query.file_id || "");
  if (!fileId) return res.status(400).end();
  try {
    const file = await tgCall("getFile", { file_id: fileId });
    if (!file) return res.status(404).end();
    const r = await fetch(`${TG_API}/file/${file.file_path}`);
    if (!r.ok) return res.status(r.status).end();
    const buf = Buffer.from(await r.arrayBuffer());
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.send(buf);
  } catch {
    res.status(500).end();
  }
});

// --- Game helpers ----------------------------------------------------------
function checkWin(board) {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return [a, b, c];
  }
  return null;
}

function isInGame(tgId) {
  for (const game of games.values()) {
    if (game.status === "playing" && game.players.some((p) => p.telegramId === tgId)) return true;
  }
  return false;
}

function playerView(game, seat) {
  const me = game.players[seat];
  const opp = game.players[otherSeat(seat)];
  return {
    gameId: game.id,
    board: game.board,
    status: game.status,
    turn: game.turn,
    youSeat: seat,
    yourSymbol: game.symbols[seat],
    winnerSeat: game.winner,
    winLine: game.winLine,
    reason: game.reason,
    scores: {
      you: game.scores[me.telegramId] || 0,
      opponent: game.scores[opp.telegramId] || 0,
    },
    opponent: {
      profile: opp.profile,
      seat: otherSeat(seat),
      symbol: game.symbols[otherSeat(seat)],
    },
  };
}

function emitGame(game) {
  for (let seat = 0; seat < 2; seat++) {
    const view = playerView(game, seat);
    for (const sid of game.players[seat].sockets) io.to(sid).emit("game:state", view);
  }
}

function scheduleGameCleanup(game) {
  setTimeout(() => {
    const still = games.get(game.id);
    if (still && still.players.every((p) => p.left)) games.delete(game.id);
  }, GAME_LINGER_MS).unref();
}

function startGame(aId, bId) {
  const a = users.get(aId);
  const b = users.get(bId);
  if (!a || !b || a.sockets.size === 0 || b.sockets.size === 0) return;

  const first = Math.random() < 0.5 ? a : b;
  const second = first === a ? b : a;
  const game = {
    id: crypto.randomBytes(6).toString("hex"),
    players: [
      { telegramId: first.profile.id, profile: first.profile, sockets: first.sockets, left: false },
      { telegramId: second.profile.id, profile: second.profile, sockets: second.sockets, left: false },
    ],
    symbols: ["X", "O"],
    board: Array(9).fill(null),
    turn: 0,
    status: "playing",
    winner: null,
    winLine: null,
    reason: null,
    scores: {},
    rematch: new Set(),
    createdAt: Date.now(),
  };
  games.set(game.id, game);
  emitGame(game);
  broadcastPresence();
}

function endGameForfeit(game, seat, reason) {
  if (game.status !== "playing") return;
  const opp = otherSeat(seat);
  game.status = "over";
  game.winner = opp;
  game.winLine = null;
  game.reason = reason;
  game.scores[game.players[opp].telegramId] = (game.scores[game.players[opp].telegramId] || 0) + 1;
  game.players[seat].left = true;
  emitGame(game);
  scheduleGameCleanup(game);
  broadcastPresence();
}

function broadcastPresence() {
  const list = [];
  for (const [tgId, entry] of users) {
    list.push({ ...entry.profile, inGame: isInGame(tgId) });
  }
  list.sort((a, b) => (a.firstName || a.username).localeCompare(b.firstName || b.username));
  io.emit("presence", list);
}

// --- Socket.IO -------------------------------------------------------------
io.on("connection", (socket) => {
  let telegramId = null;

  socket.on("auth", ({ token } = {}) => {
    const session = token && sessions.get(token);
    if (!session) {
      socket.emit("auth:error", { message: "Session expired. Please log in again." });
      return;
    }
    telegramId = session.telegramId;
    socketToUser.set(socket.id, telegramId);
    let entry = users.get(telegramId);
    if (!entry) entry = { profile: session.profile, sockets: new Set() };
    entry.profile = session.profile;
    entry.sockets.add(socket.id);
    users.set(telegramId, entry);
    socket.emit("auth:ok", { profile: session.profile });
    broadcastPresence();
  });

  socket.on("game:request", ({ to } = {}) => {
    const from = telegramId;
    const fromEntry = from && users.get(from);
    const toEntry = to && users.get(to);
    if (!from || !to || from === to || !fromEntry || !toEntry || toEntry.sockets.size === 0) {
      socket.emit("game:error", { message: "That player is no longer online." });
      return;
    }
    if (isInGame(from) || isInGame(to)) {
      socket.emit("game:error", { message: "One of you is already in a game." });
      return;
    }
    for (const r of requests.values()) {
      if ((r.from === from && r.to === to) || (r.from === to && r.to === from)) {
        socket.emit("game:error", { message: "A game request between you two is already pending." });
        return;
      }
    }

    const requestId = crypto.randomBytes(6).toString("hex");
    requests.set(requestId, { from, to, createdAt: Date.now() });

    for (const sid of toEntry.sockets) {
      io.to(sid).emit("game:request_incoming", { requestId, from: { profile: fromEntry.profile } });
    }
    socket.emit("game:request_sent", { requestId, to: { profile: toEntry.profile } });

    setTimeout(() => {
      if (!requests.has(requestId)) return;
      requests.delete(requestId);
      for (const sid of toEntry.sockets) io.to(sid).emit("game:request_expired", { requestId });
      for (const sid of fromEntry.sockets) io.to(sid).emit("game:request_expired", { requestId });
    }, REQUEST_TTL_MS);
  });

  socket.on("game:request_response", ({ requestId, accept } = {}) => {
    const req = requests.get(requestId);
    if (!req || req.to !== telegramId) return;
    requests.delete(requestId);

    const fromEntry = users.get(req.from);
    if (!fromEntry) return;

    if (!accept) {
      const me = users.get(req.to);
      for (const sid of fromEntry.sockets) {
        io.to(sid).emit("game:request_declined", { requestId, name: me?.profile.firstName || "Your friend" });
      }
      return;
    }
    startGame(req.from, req.to);
  });

  socket.on("game:move", ({ gameId, index } = {}) => {
    const game = games.get(gameId);
    if (!game || game.status !== "playing") return;
    const seat = game.players.findIndex((p) => p.telegramId === telegramId);
    if (seat === -1 || seat !== game.turn) return;
    if (!Number.isInteger(index) || index < 0 || index > 8 || game.board[index]) return;

    game.board[index] = game.symbols[seat];
    const line = checkWin(game.board);
    if (line) {
      game.status = "over";
      game.winner = seat;
      game.winLine = line;
      game.reason = "win";
      game.scores[game.players[seat].telegramId] = (game.scores[game.players[seat].telegramId] || 0) + 1;
      emitGame(game);
      scheduleGameCleanup(game);
      broadcastPresence();
      return;
    }
    if (game.board.every(Boolean)) {
      game.status = "over";
      game.winner = null;
      game.winLine = null;
      game.reason = "draw";
      emitGame(game);
      scheduleGameCleanup(game);
      broadcastPresence();
      return;
    }
    game.turn = otherSeat(game.turn);
    emitGame(game);
  });

  socket.on("game:rematch", ({ gameId } = {}) => {
    const game = games.get(gameId);
    if (!game || game.status !== "over") return;
    const seat = game.players.findIndex((p) => p.telegramId === telegramId);
    if (seat === -1 || game.players[seat].left) return;

    game.rematch.add(seat);
    if (game.rematch.size === 2) {
      game.rematch.clear();
      game.players.reverse();
      game.symbols.reverse();
      game.board = Array(9).fill(null);
      game.turn = game.symbols.indexOf("X");
      game.status = "playing";
      game.winner = null;
      game.winLine = null;
      game.reason = null;
      emitGame(game);
    }
  });

  socket.on("game:leave", ({ gameId } = {}) => {
    const game = games.get(gameId);
    if (!game) return;
    const seat = game.players.findIndex((p) => p.telegramId === telegramId);
    if (seat === -1) return;

    game.players[seat].left = true;
    if (game.status === "playing") {
      endGameForfeit(game, seat, "forfeit");
      return;
    }
    for (const p of game.players) {
      if (p.left) continue;
      for (const sid of p.sockets) io.to(sid).emit("game:closed", { gameId });
    }
    if (game.players.every((p) => p.left)) games.delete(game.id);
    broadcastPresence();
  });

  socket.on("disconnect", () => {
    const tgId = socketToUser.get(socket.id);
    if (!tgId) return;
    socketToUser.delete(socket.id);

    const entry = users.get(tgId);
    if (!entry) return;
    entry.sockets.delete(socket.id);
    if (entry.sockets.size > 0) return;

    users.delete(tgId);
    for (const game of games.values()) {
      if (game.status !== "playing") continue;
      const seat = game.players.findIndex((p) => p.telegramId === tgId);
      if (seat !== -1) endGameForfeit(game, seat, "disconnect");
    }
    broadcastPresence();
  });
});

// Daily hygiene for stale sessions and dead games.
setInterval(() => {
  const cutoff = Date.now() - GAME_LINGER_MS;
  for (const game of games.values()) {
    if (game.players.every((p) => p.left)) games.delete(game.id);
    else if (game.status === "over" && game.createdAt && game.createdAt < cutoff) {
      for (const p of game.players) if (!p.left) for (const sid of p.sockets) io.to(sid).emit("game:closed", { gameId: game.id });
      games.delete(game.id);
    }
  }
}, 60_000).unref();

// Bot long-polling: replies to /start with the user's Telegram ID so they can
// log in on the site. Poll errors are normal (timeouts / bot restarts) — ignore.
let pollOffset = 0;
async function pollBotOnce() {
  if (!botConfigured()) return;
  const updates = await tgCall("getUpdates", {
    offset: pollOffset,
    timeout: 25,
    allowed_updates: JSON.stringify(["message"]),
  });
  if (!updates) return;
  for (const update of updates) {
    pollOffset = update.update_id + 1;
    const msg = update.message;
    if (!msg || !msg.text || msg.chat.type !== "private") continue;
    const text = msg.text.trim();
    if (text === "/start" || text.startsWith("/start")) {
      await tgCall("sendMessage", {
        chat_id: msg.chat.id,
        text:
          `👋 Welcome to Candy Games! 🍬\n\n` +
          `Your Telegram ID is:\n<code>${msg.chat.id}</code>\n\n` +
          `Type that number into the login box on the site and you're in. ` +
          `(It also automatically pulls your name & profile pic.)`,
        parse_mode: "HTML",
      });
    } else if (/^\d{4,}$/.test(text)) {
      await tgCall("sendMessage", {
        chat_id: msg.chat.id,
        text: `✅ That's you, ${msg.chat.first_name || "friend"}! You can log in with <code>${text}</code> on the site.`,
        parse_mode: "HTML",
      });
    }
  }
}
async function pollLoop() {
  await pollBotOnce();
  setTimeout(pollLoop, 1500);
}
pollLoop();

httpServer.listen(config.port, () => {
  console.log(`🍬 Candy Games running at http://localhost:${config.port}`);
  console.log(`   Bot: ${config.botUsername} | configured: ${!/YOUR_|CHANGE_ME/.test(config.botUsername) && !/YOUR_|CHANGE_ME/.test(config.botToken)}`);
});
