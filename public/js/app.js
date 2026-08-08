// app.js — Candy Games frontend: Telegram login, live presence, challenge
// requests, and the 1v1 Tic-Tac-Toe screen with realtime updates.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const screens = { login: $("screen-login"), home: $("screen-home"), game: $("screen-game") };
  const TOKEN_KEY = "candygames.token";

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || null,
    profile: null,
    socket: null,
    users: [],
    requestId: null,
    requestQueue: [],
    game: null,
    boardButtons: [],
    rematchVote: false,
  };

  const AVATAR_COLORS = [
    "linear-gradient(135deg,#ff9dbe,#a78bfa)",
    "linear-gradient(135deg,#4ecdc4,#a78bfa)",
    "linear-gradient(135deg,#ffc94d,#ff9dbe)",
    "linear-gradient(135deg,#a78bfa,#4ecdc4)",
    "linear-gradient(135deg,#ff8f6f,#ffc94d)",
  ];

  // ---------- helpers ----------
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const fullName = (p) => [p.firstName, p.lastName].filter(Boolean).join(" ") || p.username || "Friend";
  const colorFor = (id) => AVATAR_COLORS[Number(id) % AVATAR_COLORS.length];

  function paintAvatar(node, p) {
    node.textContent = "";
    node.style.backgroundImage = "";
    const initials = fullName(p).slice(0, 2).toUpperCase();
    if (p.photo) {
      node.style.backgroundImage = `url(${p.photo})`;
      node.title = fullName(p);
    } else {
      node.textContent = initials;
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
    $("quick-btn").disabled = true;
    fetch("/api/auth/id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId }),
    })
      .then((r) => r.json().then((j) => ({ ok: r.ok, ...j })))
      .then(({ ok, token, profile, error }) => {
        if (!ok) throw new Error(error || "Login failed");
        state.token = token;
        state.profile = profile;
        localStorage.setItem(TOKEN_KEY, token);
        state.socket.emit("auth", { token });
      })
      .catch((err) => showQuickError(err.message))
      .finally(() => {
        $("quick-btn").disabled = false;
      });
  });

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    state.token = null;
    state.profile = null;
    state.game = null;
    hideRequestBanner();
    if (state.socket) state.socket.disconnect();
    showScreen("login");
  }

  // ---------- socket ----------
  function connect() {
    state.socket = io();

    state.socket.on("connect", () => {
      if (state.token) state.socket.emit("auth", { token: state.token });
    });

    state.socket.on("auth:ok", ({ profile }) => {
      state.profile = profile;
      renderHome();
      showScreen("home");
    });

    state.socket.on("auth:error", ({ message } = {}) => {
      localStorage.removeItem(TOKEN_KEY);
      state.token = null;
      toast(message || "Session expired — log in again.");
      showScreen("login");
    });

    state.socket.on("presence", (list) => {
      state.users = list;
      renderUsers();
    });

    state.socket.on("game:request_incoming", (req) => {
      state.requestQueue.push(req);
      if (!state.requestId) showNextRequest();
    });

    state.socket.on("game:request_sent", ({ to }) => toast(`🍬 Request sent to ${fullName(to.profile)}!`));

    state.socket.on("game:request_declined", ({ name }) => toast(`${name} declined your challenge 😢`));

    state.socket.on("game:request_expired", ({ requestId }) => {
      if (state.requestId === requestId) {
        state.requestId = null;
        hideRequestBanner();
        showNextRequest();
      } else {
        state.requestQueue = state.requestQueue.filter((r) => r.requestId !== requestId);
      }
      toast("⏳ That game request expired.");
    });

    state.socket.on("game:error", ({ message }) => toast(`⚠️ ${message}`));

    state.socket.on("game:state", (view) => {
      hideRequestBanner();
      enterGame(view);
    });

    state.socket.on("game:closed", () => {
      toast("👋 The game room closed.");
      exitGame();
    });
  }

  // ---------- home ----------
  function renderHome() {
    paintAvatar($("me-avatar"), state.profile);
    $("me-name").textContent = state.profile.firstName || state.profile.username || "friend";
    renderUsers();
  }

  function renderUsers() {
    const list = $("user-list");
    list.innerHTML = "";
    $("online-num").textContent = state.users.length;

    if (!state.users.length) {
      $("empty-state").classList.remove("hidden");
      return;
    }
    $("empty-state").classList.add("hidden");

    const inGameWith = state.game
      ? state.users.find((u) => u.id === state.game.opponent.profile.id)
      : null;

    state.users.forEach((u, i) => {
      const isMe = state.profile && u.id === state.profile.id;
      const busy = inGameWith && u.id === inGameWith.id;

      const row = el("li", "user-row");
      row.style.animationDelay = `${i * 0.04}s`;

      const avatar = el("div", "avatar");
      paintAvatar(avatar, u);

      const info = el("div", "user-info");
      const name = el("div", "user-name", isMe ? `${fullName(u)} (you)` : fullName(u));
      const sub = el("div", "user-sub", u.username ? `@${u.username}` : "Member of the gang");
      info.append(name, sub);

      const tag = el("span", "status-tag", isMe ? "It's you" : u.inGame ? "In a game" : "Online");
      if (isMe) tag.classList.add("you");
      else if (u.inGame) tag.classList.add("ingame");
      else tag.prepend(el("span", "dot"));

      row.append(avatar, info, tag);

      if (!isMe) {
        const btn = el("button", "play-btn", "Play 🎮");
        btn.disabled = u.inGame || busy;
        if (u.inGame) btn.textContent = "Playing";
        if (busy) btn.textContent = "Playing you";
        btn.addEventListener("click", () => {
          if (state.game) return;
          state.socket.emit("game:request", { to: u.id });
        });
        row.append(btn);
      }

      list.appendChild(row);
    });
  }

  // ---------- request banner ----------
  function showNextRequest() {
    const req = state.requestQueue.shift();
    if (!req) return;
    state.requestId = req.requestId;

    paintAvatar($("rb-avatar"), req.from.profile);
    $("rb-name").textContent = fullName(req.from.profile);
    $("request-banner").classList.remove("hidden");
  }

  function hideRequestBanner() {
    state.requestId = null;
    $("request-banner").classList.add("hidden");
  }

  function respondRequest(accept) {
    const requestId = state.requestId;
    hideRequestBanner();
    if (requestId) state.socket.emit("game:request_response", { requestId, accept });
    showNextRequest();
  }

  $("rb-accept").addEventListener("click", () => respondRequest(true));
  $("rb-decline").addEventListener("click", () => respondRequest(false));

  // ---------- game ----------
  function buildBoard() {
    const board = $("board");
    board.innerHTML = "";
    state.boardButtons = [];
    for (let i = 0; i < 9; i++) {
      const cell = el("button", "cell");
      cell.addEventListener("click", () => {
        const g = state.game;
        if (!g || g.status !== "playing") return;
        if (g.turn !== g.youSeat) return toast("⏳ Not your turn!");
        if (g.board[i]) return;
        state.socket.emit("game:move", { gameId: g.gameId, index: i });
      });
      board.appendChild(cell);
      state.boardButtons.push(cell);
    }
  }

  function enterGame(view) {
    state.game = view;
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

    paintAvatar($("score-me-avatar"), state.profile);
    paintAvatar($("score-opp-avatar"), g.opponent.profile);
    $("score-me-name").textContent = state.profile.firstName || "You";
    $("score-opp-name").textContent = fullName(g.opponent.profile);
    $("score-me-symbol").textContent = g.yourSymbol;
    $("score-opp-symbol").textContent = g.opponent.symbol;
    $("score-me-symbol").classList.toggle("x", g.yourSymbol === "X");
    $("score-me-symbol").classList.toggle("o", g.yourSymbol === "O");
    $("score-opp-symbol").classList.toggle("x", g.opponent.symbol === "X");
    $("score-opp-symbol").classList.toggle("o", g.opponent.symbol === "O");
    $("score-me-points").textContent = g.scores.you;
    $("score-opp-points").textContent = g.scores.opponent;

    $("score-me-name").parentElement.classList.toggle("thinking", g.status === "playing" && g.turn === g.youSeat);
    $("score-opp-name").parentElement.classList.toggle("thinking", g.status === "playing" && g.turn !== g.youSeat);

    g.board.forEach((val, i) => {
      const cell = state.boardButtons[i];
      cell.textContent = val || "";
      cell.className = "cell";
      if (val) cell.classList.add(val.toLowerCase());
      cell.disabled = !!val || g.status !== "playing" || g.turn !== g.youSeat;
    });
    if (g.winLine) g.winLine.forEach((i) => state.boardButtons[i].classList.add("win"));

    renderTurnBanner(g);
    renderWinOverlay(g);
  }

  function renderTurnBanner(g) {
    const banner = $("turn-banner");
    banner.classList.toggle("mine", g.status === "playing" && g.turn === g.youSeat);
    if (g.status === "playing") {
      banner.textContent = g.turn === g.youSeat ? "Your turn! 🍭" : `${fullName(g.opponent.profile)}'s turn…`;
    } else if (g.reason === "draw") {
      banner.textContent = "It's a draw! 🤝";
    } else {
      banner.textContent = g.winner === g.youSeat ? "You win! 🎉" : `${fullName(g.opponent.profile)} wins!`;
    }
  }

  function renderWinOverlay(g) {
    const rematchBtn = $("rematch-btn");
    if (g.status === "playing") {
      rematchBtn.classList.add("hidden");
      hideWinOverlay();
      return;
    }

    rematchBtn.classList.remove("hidden");
    if (g.reason === "draw") {
      rematchBtn.textContent = "Rematch 🔁";
      rematchBtn.disabled = false;
      return;
    }
    if (g.winner === g.youSeat) {
      rematchBtn.textContent = "Rematch 🔁";
      rematchBtn.disabled = false;
    } else {
      rematchBtn.textContent = state.rematchVote ? "Waiting for your rematch…" : "Rematch 🔁";
      rematchBtn.disabled = false;
    }

    if (g.reason === "disconnect" || g.reason === "forfeit") {
      $("win-emoji").textContent = g.winner === g.youSeat ? "🏆" : "😵";
      $("win-title").textContent = g.winner === g.youSeat ? "You win!" : "Opponent left";
      $("win-sub").textContent =
        g.reason === "disconnect"
          ? "They disconnected."
          : g.winner === g.youSeat
            ? "They left the game."
            : "You left — head back to the lobby.";
      if (g.winner === g.youSeat) startConfetti();
      $("win-overlay").classList.remove("hidden");
      return;
    }

    if (g.winner === g.youSeat) {
      $("win-emoji").textContent = "🎉";
      $("win-title").textContent = "You win!";
      $("win-sub").textContent = "Sweet victory 🍓";
      startConfetti();
    } else {
      $("win-emoji").textContent = "🍂";
      $("win-title").textContent = "So close!";
      $("win-sub").textContent = `${fullName(g.opponent.profile)} takes this one. Rematch?`;
    }
    $("win-overlay").classList.remove("hidden");
  }

  function hideWinOverlay() {
    $("win-overlay").classList.add("hidden");
  }

  $("back-btn").addEventListener("click", () => {
    if (state.game) state.socket.emit("game:leave", { gameId: state.game.gameId });
    exitGame();
  });

  $("rematch-btn").addEventListener("click", () => {
    const g = state.game;
    if (!g) return;
    state.rematchVote = true;
    $("rematch-btn").textContent = "Waiting…";
    $("rematch-btn").disabled = true;
    hideWinOverlay();
    state.socket.emit("game:rematch", { gameId: g.gameId });
  });

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
    connect();

    fetch("/api/config")
      .then((r) => r.json())
      .then(({ configured }) => {
        if (!configured) $("config-hint").classList.remove("hidden");
      })
      .catch(() => toast("⚠️ Could not reach the server."));

    if (state.token) {
      // The socket will auth on connect; stay on login until auth:ok.
    } else {
      showScreen("login");
    }
  }

  boot();
})();
