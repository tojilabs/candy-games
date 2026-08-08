// app.js — Candy Games (static / GitHub Pages build).
// Realtime works over a public MQTT broker (no backend needed): presence,
// game requests, and the 1v1 Tic-Tac-Toe engine all run in the browser.
(() => {
  "use strict";

  const APP_VERSION = "3";
  window.__APP_VERSION = APP_VERSION;
  window.document.title = "Candy Games 🍬 · v" + APP_VERSION;

  // Surface any runtime error on screen so failures are never silent.
  window.addEventListener("error", (e) => {
    const m = (e && e.message) || "Unknown error";
    setConnStatus("Error: " + m + (e && e.filename ? " (" + e.filename.split("/").pop() + ":" + e.lineno + ")" : ""), "error");
    toast("⚠️ " + m);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e && e.reason;
    setConnStatus("Error: " + (r ? r.message || String(r) : "async error"), "error");
  });

  const $ = (id) => document.getElementById(id);
  const screens = { login: $("screen-login"), home: $("screen-home"), game: $("screen-game") };
  const PROFILE_KEY = "candygames.profile";

  // Change this so different groups don't bump into each other on the shared broker.
  const ROOM = "tojigang";
  const BROKERS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://test.mosquitto.org:8081/mqtt",
    "wss://broker.hivemq.com:8884/mqtt",
  ];
  const BROKER_TIMEOUT_MS = 10000;
  const HEARTBEAT_MS = 7000;
  const PRESENCE_STALE_MS = 18000;
  const REQUEST_TTL_MS = 30000;

  const WIN_LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];

  const AVATAR_COLORS = [
    "linear-gradient(135deg,#ff9dbe,#a78bfa)",
    "linear-gradient(135deg,#4ecdc4,#a78bfa)",
    "linear-gradient(135deg,#ffc94d,#ff9dbe)",
    "linear-gradient(135deg,#a78bfa,#4ecdc4)",
    "linear-gradient(135deg,#ff8f6f,#ffc94d)",
  ];

  const state = {
    profile: null,
    mqtt: null,
    connected: false,
    users: new Map(), // id -> { id, name, inGame, ts }
    requestId: null,
    requestQueue: [],
    pendingRequest: null, // { reqId, to, timer }
    game: null,
    boardButtons: [],
    heartbeatTimer: null,
    pruneTimer: null,
    sessionId: null,
  };

  const rand = () => Math.random().toString(36).slice(2, 10);
  const colorFor = (id) => AVATAR_COLORS[Number(id) % AVATAR_COLORS.length];
  const displayName = (p) => p.name || p.nickname || `Friend ${String(p.id).slice(-4)}`;

  const T = {
    presence: (id) => `cg/${ROOM}/presence/${id}`,
    presenceAll: () => `cg/${ROOM}/presence/+`,
    req: (id) => `cg/${ROOM}/req/${id}`,
    game: (id) => `cg/${ROOM}/game/${id}`,
  };

  // ---------- helpers ----------
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  function paintAvatar(node, p) {
    node.textContent = "";
    node.style.backgroundImage = "";
    node.title = "";
    const name = displayName(p);
    if (p.photo) {
      node.style.backgroundImage = `url(${p.photo})`;
      node.title = name;
    } else {
      node.textContent = name.slice(0, 2).toUpperCase();
      node.style.background = colorFor(p.id);
    }
  }

  function showScreen(name) {
    Object.entries(screens).forEach(([k, s]) => s.classList.toggle("active", k === name));
  }

  function toast(message) {
    const wrap = $("toasts");
    const t = el("div", "toast", message);
    wrap.appendChild(t);
    setTimeout(() => {
      t.classList.add("out");
      setTimeout(() => t.remove(), 320);
    }, 2600);
    while (wrap.children.length > 3) wrap.firstElementChild.remove();
  }

  function setConnStatus(message, kind) {
    const el = $("conn-status");
    if (!message) {
      el.classList.add("hidden");
      el.textContent = "";
      return;
    }
    el.textContent = message;
    el.className = "conn-status " + (kind || "info");
  }

  // ---------- login ----------
  const quickForm = $("quick-login");
  const quickInput = $("quick-id");
  const quickError = $("quick-error");

  function showQuickError(message) {
    quickError.textContent = message;
    quickError.classList.remove("hidden");
  }

  quickForm.addEventListener("submit", (e) => {
    e.preventDefault();
    quickError.classList.add("hidden");
    const chatId = quickInput.value.trim();
    if (!/^\d{4,}$/.test(chatId)) {
      showQuickError("That doesn't look like a Telegram ID — it should be a number.");
      return;
    }
    const nickname = $("quick-nick").value.trim();
    const profile = {
      id: chatId,
      name: nickname || `Friend ${chatId.slice(-4)}`,
    };
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    startSession(profile);
  });

  // Belt-and-braces: also catch a direct button click in case the form
  // submit event is swallowed by anything.
  $("quick-btn").addEventListener("click", (e) => {
    e.preventDefault();
    quickForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

  function logout() {
    setInGame(false);
    publishPresenceNow("");
    cleanupTimers();
    if (state.mqtt) {
      try { state.mqtt.end(true); } catch { /* ignore */ }
    }
    state.mqtt = null;
    state.profile = null;
    state.users.clear();
    state.game = null;
    setConnStatus("");
    localStorage.removeItem(PROFILE_KEY);
    showScreen("login");
  }

  // ---------- MQTT transport ----------
  function startSession(profile) {
    state.profile = profile;
    state.sessionId = `${profile.id}_${rand()}`;
    setConnStatus("Connecting to the candy network… 🍬", "info");
    tryBroker(profile, 0);
  }

  function tryBroker(profile, i) {
    if (i >= BROKERS.length) {
      setConnStatus(
        "Couldn't reach any realtime broker — this network may be blocking WebSocket connections. Try a different network or another browser.",
        "error"
      );
      toast("⚠️ Connection failed");
      return;
    }
    const client = mqtt.connect(BROKERS[i], {
      clientId: `cg_${state.sessionId}`,
      keepalive: 10,
      reconnectPeriod: 3000,
      will: { topic: T.presence(profile.id), payload: "", qos: 0, retain: false },
    });
    let aborted = false;
    const timer = setTimeout(() => {
      if (aborted) return;
      aborted = true;
      try { client.end(true); } catch { /* ignore */ }
      tryBroker(profile, i + 1);
    }, BROKER_TIMEOUT_MS);

    client.on("connect", () => {
      if (aborted) return;
      clearTimeout(timer);
      state.mqtt = client;
      state.connected = true;
      setConnStatus("");
      state.mqtt.subscribe(T.presenceAll());
      state.mqtt.subscribe(T.req(profile.id));
      publishPresenceNow("");
      startHeartbeat();
      renderHome();
      showScreen("home");
    });

    // Transient errors are fine — mqtt.js keeps retrying until the timeout above fires.
    client.on("error", () => { /* ignore */ });
    client.on("message", onMqttMessage);
  }

  function startHeartbeat() {
    cleanupTimers();
    state.heartbeatTimer = setInterval(() => publishPresenceNow(""), HEARTBEAT_MS);
    state.pruneTimer = setInterval(prunePresence, 10000);
  }

  function cleanupTimers() {
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    if (state.pruneTimer) clearInterval(state.pruneTimer);
    state.heartbeatTimer = state.pruneTimer = null;
  }

  function publishPresenceNow(empty) {
    if (empty) {
      safePublish(T.presence(state.profile.id), "");
      return;
    }
    const g = state.game && state.game.status === "playing" ? 1 : 0;
    const msg = { n: displayName(state.profile), g, ts: Date.now() };
    safePublish(T.presence(state.profile.id), JSON.stringify(msg));
  }

  function setInGame(inGame) {
    // Presence is recomputed on every heartbeat; fire one right away too.
    publishPresenceNow();
  }

  function safePublish(topic, payload) {
    if (state.connected && state.mqtt) {
      try { state.mqtt.publish(topic, payload); } catch { /* ignore */ }
    }
  }

  function onMqttMessage(topic, payloadBuffer) {
    let topicParts = topic.split("/");
    const kind = topicParts[2];
    const payload = payloadBuffer.toString();

    if (kind === "presence") return handlePresence(topicParts[3], payload);
    if (kind === "req") return handleReq(payload);
    if (kind === "game") return handleGame(payload);
  }

  // ---------- presence ----------
  function handlePresence(id, payload) {
    if (!payload) {
      state.users.delete(id);
      checkForfeitByGone(id);
      renderUsers();
      return;
    }
    let data;
    try { data = JSON.parse(payload); } catch { return; }
    if (!data.n) return;
    state.users.set(id, { id, name: data.n, inGame: data.g === 1, ts: data.ts });
    renderUsers();
  }

  function prunePresence() {
    const now = Date.now();
    let changed = false;
    for (const [id, u] of state.users) {
      if (id === state.profile.id) continue;
      if (now - u.ts > PRESENCE_STALE_MS) {
        state.users.delete(id);
        checkForfeitByGone(id);
        changed = true;
      }
    }
    if (changed) renderUsers();
  }

  function checkForfeitByGone(id) {
    const g = state.game;
    if (!g || g.status !== "playing") return;
    if (opponentOf(g).id === id) forfeitGame("disconnect");
  }

  function renderUsers() {
    const list = $("user-list");
    list.innerHTML = "";
    const others = [...state.users.values()].filter((u) => u.id !== state.profile.id);
    $("online-num").textContent = others.length;

    if (!others.length) {
      $("empty-state").classList.remove("hidden");
      return;
    }
    $("empty-state").classList.add("hidden");

    const inGameWith = state.game && state.game.status === "playing" ? opponentOf(state.game).id : null;

    others.forEach((u, i) => {
      const row = el("li", "user-row");
      row.style.animationDelay = `${i * 0.04}s`;

      const avatar = el("div", "avatar");
      paintAvatar(avatar, u);

      const info = el("div", "user-info");
      const name = el("div", "user-name", u.name);
      const sub = el("div", "user-sub", "Member of the gang");
      info.append(name, sub);

      const tag = el("span", "status-tag", u.inGame ? "In a game" : "Online");
      if (u.inGame) tag.classList.add("ingame");
      else tag.prepend(el("span", "dot"));

      row.append(avatar, info, tag);

      const busy = u.id === inGameWith;
      if (!busy) {
        const btn = el("button", "play-btn", "Play 🎮");
        btn.disabled = u.inGame;
        if (u.inGame) btn.textContent = "Playing";
        btn.addEventListener("click", () => sendInvite(u));
        row.append(btn);
      }

      list.appendChild(row);
    });
  }

  // ---------- game requests ----------
  function sendInvite(target) {
    if (state.game) return;
    if (target.inGame) return toast("⚠️ They're already in a game.");
    const reqId = rand();
    state.pendingRequest = {
      reqId,
      to: target,
      timer: setTimeout(() => {
        safePublish(T.req(target.id), JSON.stringify({ t: "cancel", reqId }));
        if (state.pendingRequest && state.pendingRequest.reqId === reqId) state.pendingRequest = null;
        toast("⏳ Your challenge expired.");
      }, REQUEST_TTL_MS),
    };
    safePublish(T.req(target.id), JSON.stringify({ t: "invite", reqId, from: { id: state.profile.id, name: displayName(state.profile) } }));
    toast(`🍬 Challenge sent to ${target.name}!`);
  }

  function handleReq(payload) {
    let m;
    try { m = JSON.parse(payload); } catch { return; }

    if (m.t === "invite") {
      if (state.game && state.game.status === "playing") {
        safePublish(T.req(m.from.id), JSON.stringify({ t: "reply", reqId: m.reqId, accept: false, from: { id: state.profile.id, name: displayName(state.profile) } }));
        toast("⚠️ You're already in a game.");
        return;
      }
      state.requestQueue.push({ reqId: m.reqId, from: m.from });
      if (!state.requestId) showNextRequest();
    } else if (m.t === "reply") {
      const pending = state.pendingRequest;
      if (!pending || pending.reqId !== m.reqId) return;
      clearTimeout(pending.timer);
      state.pendingRequest = null;
      if (m.accept) startGame(pending.to);
      else toast(`${m.from.name} declined your challenge 😢`);
    } else if (m.t === "cancel") {
      if (state.requestId === m.reqId) {
        state.requestId = null;
        $("request-banner").classList.add("hidden");
        state.requestQueue = state.requestQueue.filter((r) => r.reqId !== m.reqId);
        showNextRequest();
        toast("⏳ That challenge expired.");
      }
    }
  }

  function showNextRequest() {
    const req = state.requestQueue.shift();
    if (!req) return;
    state.requestId = req.reqId;
    state.currentReq = req;
    paintAvatar($("rb-avatar"), { id: req.from.id, name: req.from.name });
    $("rb-name").textContent = req.from.name;
    $("request-banner").classList.remove("hidden");
  }

  function hideRequestBanner() {
    state.requestId = null;
    state.currentReq = null;
    $("request-banner").classList.add("hidden");
  }

  function respondRequest(accept) {
    const req = state.currentReq;
    hideRequestBanner();
    if (req) {
      safePublish(T.req(req.from.id), JSON.stringify({ t: "reply", reqId: req.reqId, accept, from: { id: state.profile.id, name: displayName(state.profile) } }));
    }
    showNextRequest();
  }

  $("rb-accept").addEventListener("click", () => respondRequest(true));
  $("rb-decline").addEventListener("click", () => respondRequest(false));

  // ---------- game engine ----------
  const seatOf = (g) => (g.seats.X.id === state.profile.id ? "X" : "O");
  const opponentOf = (g) => (g.seats.X.id === state.profile.id ? g.seats.O : g.seats.X);

  function freshGame(gameId, a, b) {
    // Randomize who is X (X always moves first).
    const flip = Math.random() < 0.5;
    const x = flip ? a : b;
    const o = flip ? b : a;
    return {
      t: "init",
      gameId,
      seats: { X: x, O: o },
      board: Array(9).fill(null),
      turn: "X",
      status: "playing",
      winner: null,
      winLine: null,
      reason: null,
      scores: {},
      rematch: { me: false, opp: false },
    };
  }

  function startGame(opponentProfile) {
    const game = freshGame(rand(), { id: state.profile.id, name: displayName(state.profile) }, { id: opponentProfile.id, name: opponentProfile.name });
    state.game = game;
    state.mqtt.subscribe(T.game(game.gameId));
    enterGame();
    safePublish(T.game(game.gameId), JSON.stringify(game));
    setInGame(true);
  }

  function handleGame(payload) {
    let m;
    try { m = JSON.parse(payload); } catch { return; }

    if (m.t === "init") {
      state.mqtt.subscribe(T.game(m.gameId));
      state.game = {
        ...m,
        rematch: { me: false, opp: false },
      };
      setInGame(true);
      enterGame();
    } else if (m.t === "state") {
      const g = state.game;
      if (!g || g.gameId !== m.gameId) return;
      g.board = m.board;
      g.turn = m.turn;
      g.status = m.status;
      g.winner = m.winner;
      g.winLine = m.winLine;
      g.reason = m.reason;
      g.scores = m.scores;
      renderGame();
    } else if (m.t === "rematch") {
      const g = state.game;
      if (!g || g.gameId !== m.gameId || g.status !== "over") return;
      g.rematch.opp = true;
      maybeStartRematch();
    } else if (m.t === "leave") {
      const g = state.game;
      if (!g || g.gameId !== m.gameId) return;
      if (g.status === "playing" && opponentOf(g).id === m.by) {
        forfeitGame("forfeit");
      } else {
        toast("👋 Your opponent went back to the lobby.");
        exitGame();
      }
    }
  }

  function publishGameState() {
    const g = state.game;
    safePublish(T.game(g.gameId), JSON.stringify({
      t: "state",
      gameId: g.gameId,
      board: g.board,
      turn: g.turn,
      status: g.status,
      winner: g.winner,
      winLine: g.winLine,
      reason: g.reason,
      scores: g.scores,
    }));
  }

  function checkWin(board) {
    for (const line of WIN_LINES) {
      const [a, b, c] = line;
      if (board[a] && board[a] === board[b] && board[a] === board[c]) return line;
    }
    return null;
  }

  function forfeitGame(reason) {
    const g = state.game;
    g.status = "over";
    g.winner = seatOf(g);
    g.winLine = null;
    g.reason = reason;
    g.scores[state.profile.id] = (g.scores[state.profile.id] || 0) + 1;
    publishGameState();
    setInGame(false);
    renderGame();
  }

  // ---------- game UI ----------
  function buildBoard() {
    const board = $("board");
    board.innerHTML = "";
    state.boardButtons = [];
    for (let i = 0; i < 9; i++) {
      const cell = el("button", "cell");
      cell.addEventListener("click", () => {
        const g = state.game;
        if (!g || g.status !== "playing") return;
        if (g.turn !== seatOf(g)) return toast("⏳ Not your turn!");
        if (g.board[i]) return;
        doMove(i);
      });
      board.appendChild(cell);
      state.boardButtons.push(cell);
    }
  }

  function doMove(index) {
    const g = state.game;
    const sym = seatOf(g);
    g.board[index] = sym;
    const line = checkWin(g.board);
    if (line) {
      g.status = "over";
      g.winner = sym;
      g.winLine = line;
      g.reason = "win";
      g.scores[g.seats[sym].id] = (g.scores[g.seats[sym].id] || 0) + 1;
      publishGameState();
      setInGame(false);
      renderGame();
      return;
    }
    if (g.board.every(Boolean)) {
      g.status = "over";
      g.winner = null;
      g.winLine = null;
      g.reason = "draw";
      publishGameState();
      setInGame(false);
      renderGame();
      return;
    }
    g.turn = g.turn === "X" ? "O" : "X";
    publishGameState();
    renderGame();
  }

  function enterGame() {
    state.rematchVote = false;
    buildBoard();
    renderGame();
    showScreen("game");
  }

  function exitGame() {
    state.game = null;
    hideWinOverlay();
    $("rematch-btn").classList.add("hidden");
    $("rematch-btn").textContent = "Rematch 🔁";
    $("rematch-btn").disabled = false;
    renderUsers();
    showScreen("home");
  }

  function renderGame() {
    const g = state.game;
    if (!g) return;
    const mySym = seatOf(g);
    const opp = opponentOf(g);

    paintAvatar($("score-me-avatar"), { id: state.profile.id, name: displayName(state.profile) });
    paintAvatar($("score-opp-avatar"), opp);
    $("score-me-name").textContent = displayName(state.profile);
    $("score-opp-name").textContent = displayName(opp);
    $("score-me-symbol").textContent = mySym;
    $("score-opp-symbol").textContent = mySym === "X" ? "O" : "X";
    $("score-me-symbol").classList.toggle("x", mySym === "X");
    $("score-me-symbol").classList.toggle("o", mySym === "O");
    $("score-opp-symbol").classList.toggle("x", mySym === "O");
    $("score-opp-symbol").classList.toggle("o", mySym === "X");
    $("score-me-points").textContent = g.scores[state.profile.id] || 0;
    $("score-opp-points").textContent = g.scores[opp.id] || 0;

    $("score-me-name").parentElement.classList.toggle("thinking", g.status === "playing" && g.turn === mySym);
    $("score-opp-name").parentElement.classList.toggle("thinking", g.status === "playing" && g.turn !== mySym);

    g.board.forEach((val, i) => {
      const cell = state.boardButtons[i];
      cell.textContent = val || "";
      cell.className = "cell";
      if (val) cell.classList.add(val.toLowerCase());
      cell.disabled = !!val || g.status !== "playing" || g.turn !== mySym;
    });
    if (g.winLine) g.winLine.forEach((i) => state.boardButtons[i].classList.add("win"));

    renderTurnBanner(g);
    renderWinOverlay(g);
  }

  function renderTurnBanner(g) {
    const banner = $("turn-banner");
    const mySym = seatOf(g);
    banner.classList.toggle("mine", g.status === "playing" && g.turn === mySym);
    if (g.status === "playing") {
      banner.textContent = g.turn === mySym ? "Your turn! 🍭" : `${displayName(opponentOf(g))}'s turn…`;
    } else if (g.reason === "draw") {
      banner.textContent = "It's a draw! 🤝";
    } else {
      banner.textContent = g.winner === mySym ? "You win! 🎉" : `${displayName(opponentOf(g))} wins!`;
    }
  }

  function renderWinOverlay(g) {
    const rematchBtn = $("rematch-btn");
    const mySym = seatOf(g);
    if (g.status === "playing") {
      rematchBtn.classList.add("hidden");
      hideWinOverlay();
      return;
    }

    rematchBtn.classList.remove("hidden");
    rematchBtn.disabled = false;
    if (g.rematch && (g.rematch.me || g.rematch.opp)) {
      rematchBtn.textContent = "Waiting for your rematch…";
    } else {
      rematchBtn.textContent = "Rematch 🔁";
    }

    if (g.reason === "disconnect" || g.reason === "forfeit") {
      $("win-emoji").textContent = g.winner === mySym ? "🏆" : "😵";
      $("win-title").textContent = g.winner === mySym ? "You win!" : "Opponent left";
      $("win-sub").textContent =
        g.reason === "disconnect"
          ? "They disconnected."
          : g.winner === mySym
            ? "They left the game."
            : "You left — head back to the lobby.";
      if (g.winner === mySym) startConfetti();
      $("win-overlay").classList.remove("hidden");
      return;
    }

    if (g.winner === mySym) {
      $("win-emoji").textContent = "🎉";
      $("win-title").textContent = "You win!";
      $("win-sub").textContent = "Sweet victory 🍓";
      startConfetti();
    } else {
      $("win-emoji").textContent = "🍂";
      $("win-title").textContent = "So close!";
      $("win-sub").textContent = `${displayName(opponentOf(g))} takes this one. Rematch?`;
    }
    $("win-overlay").classList.remove("hidden");
  }

  function hideWinOverlay() {
    $("win-overlay").classList.add("hidden");
  }

  $("back-btn").addEventListener("click", () => {
    const g = state.game;
    if (g) {
      safePublish(T.game(g.gameId), JSON.stringify({ t: "leave", gameId: g.gameId, by: state.profile.id }));
      setInGame(false);
    }
    exitGame();
  });

  $("rematch-btn").addEventListener("click", () => {
    const g = state.game;
    if (!g || g.status !== "over") return;
    g.rematch.me = true;
    $("rematch-btn").textContent = "Waiting…";
    $("rematch-btn").disabled = true;
    hideWinOverlay();
    safePublish(T.game(g.gameId), JSON.stringify({ t: "rematch", gameId: g.gameId, by: state.profile.id }));
    maybeStartRematch();
  });

  function maybeStartRematch() {
    const g = state.game;
    if (!g || g.status !== "over" || !g.rematch.me || !g.rematch.opp) return;
    g.rematch = { me: false, opp: false };
    const oldX = g.seats.X;
    g.seats = { X: g.seats.O, O: oldX }; // swap so the other player goes first
    g.board = Array(9).fill(null);
    g.turn = "X";
    g.status = "playing";
    g.winner = null;
    g.winLine = null;
    g.reason = null;
    state.rematchVote = false;
    safePublish(T.game(g.gameId), JSON.stringify({ ...g }));
    setInGame(true);
    renderGame();
  }

  $("logout-btn").addEventListener("click", logout);

  // ---------- confetti ----------
  let confettiRaf = null;
  function startConfetti() {
    const canvas = $("confetti-canvas");
    const ctx = canvas.getContext("2d");
    const colors = ["#ff6fa5", "#4ecdc4", "#ffc94d", "#a78bfa", "#ff9dbe"];
    const pieces = [];
    const resize = () => {
      canvas.width = canvas.offsetWidth * devicePixelRatio;
      canvas.height = canvas.offsetHeight * devicePixelRatio;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    for (let i = 0; i < 120; i++) {
      pieces.push({
        x: Math.random() * canvas.offsetWidth,
        y: -20 - Math.random() * canvas.offsetHeight * 0.6,
        w: 6 + Math.random() * 7,
        h: 8 + Math.random() * 8,
        vx: -1.4 + Math.random() * 2.8,
        vy: 2 + Math.random() * 3.4,
        rot: Math.random() * Math.PI,
        vr: -0.2 + Math.random() * 0.4,
        color: colors[(Math.random() * colors.length) | 0],
      });
    }

    if (confettiRaf) cancelAnimationFrame(confettiRaf);
    const tick = () => {
      ctx.clearRect(0, 0, canvas.offsetWidth, canvas.offsetHeight);
      let alive = false;
      pieces.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        if (p.y < canvas.offsetHeight + 20) alive = true;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });
      confettiRaf = alive ? requestAnimationFrame(tick) : null;
      if (!alive) window.removeEventListener("resize", resize);
    };
    tick();
  }

  // ---------- boot ----------
  function boot() {
    buildBoard();
    if (window.mqtt) return startApp();
    setConnStatus("Loading the candy network… 🍬", "info");
    window.__onMqttLoaded = (ok) => {
      if (!ok) {
        setConnStatus(
          "Couldn't load the connection library from any CDN — this network may be blocking it. Try a different network or another browser.",
          "error"
        );
        return;
      }
      startApp();
    };
  }

  function startApp() {
    setConnStatus("");
    const saved = localStorage.getItem(PROFILE_KEY);
    if (saved) {
      try {
        startSession(JSON.parse(saved));
        return;
      } catch { /* fall through to login */ }
    }
    showScreen("login");
  }

  boot();
})();
