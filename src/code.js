import Chess from "./services/chess.js";

const chess = new Chess();
chess.start();

const status = document.getElementById("matchStatus");
const nameInput = document.getElementById("playerName");
const findButton = document.getElementById("findMatch");
const localButton = document.getElementById("playLocal");
const createInviteButton = document.getElementById("createInvite");
const cancelWaitingButton = document.getElementById("cancelWaiting");
const inviteCodeInput = document.getElementById("inviteCode");
const joinInviteButton = document.getElementById("joinInvite");
const inviteShare = document.getElementById("inviteShare");
const inviteCodeDisplay = document.getElementById("inviteCodeDisplay");
const copyInviteButton = document.getElementById("copyInvite");
const tokenKey = "chessPlayerToken";
const nameKey = "chessPlayerName";
const playerToken =
  localStorage.getItem(tokenKey) ?? `${crypto.randomUUID()}${crypto.randomUUID()}`;
localStorage.setItem(tokenKey, playerToken);
nameInput.value =
  localStorage.getItem(nameKey) ?? `Invitado-${playerToken.slice(0, 5)}`;

const socket = io({
  auth: {
    token: playerToken,
    displayName: nameInput.value,
  },
});

let gameId = null;
let playerColor = null;
let gameStarted = false;
let gameMode = null;
let pendingLinkCode = new URL(location.href).searchParams.get("invite");
let currentInviteCode = pendingLinkCode;
let autoJoinAttempted = false;

const updateStatus = (message) => {
  status.textContent = message;
};

const setInviteInUrl = (code) => {
  const url = new URL(location.href);
  url.searchParams.set("invite", code);
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  currentInviteCode = code;
};

const removeInviteFromUrl = () => {
  if (!currentInviteCode) return;
  const url = new URL(location.href);
  if (url.searchParams.get("invite") === currentInviteCode) {
    url.searchParams.delete("invite");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  currentInviteCode = null;
};

const setOnlineControls = (isActive) => {
  localButton.disabled = isActive;
  findButton.disabled = isActive || gameMode === "random";
  createInviteButton.disabled = isActive || gameMode === "invite";
  joinInviteButton.disabled = isActive;
  inviteCodeInput.disabled = isActive;
  cancelWaitingButton.hidden = isActive || !gameId;
};

const clearOnlineGame = () => {
  if (gameMode === "invite") removeInviteFromUrl();
  gameId = null;
  gameMode = null;
  gameStarted = false;
  playerColor = null;
  localStorage.removeItem("chessGameId");
  Chess.onlineGame = false;
  Chess.playerColor = null;
  inviteShare.hidden = true;
  setOnlineControls(false);
};

const cancelPendingGame = () =>
  new Promise((resolve) => {
    if (!gameId) {
      resolve(true);
      return;
    }
    if (gameStarted) {
      updateStatus("Primero terminá la partida online activa.");
      resolve(false);
      return;
    }
    if (!socket.connected) {
      updateStatus("Esperá a recuperar la conexión antes de cancelar la sala.");
      resolve(false);
      return;
    }
    socket.emit("game:cancel", { gameId }, (result) => {
      if (!result?.ok) {
        updateStatus(result?.message ?? "No se pudo cancelar la espera.");
        resolve(false);
        return;
      }
      clearOnlineGame();
      resolve(true);
    });
  });

const syncGame = () => {
  if (gameId) socket.emit("game:sync", { gameId });
};

const applyGameSnapshot = (game) => {
  if (!game || game.gameId !== gameId) return;
  chess.end();
  chess.start();
  Chess.onlineGame = true;
  Chess.playerColor = game.status === "active" ? playerColor : null;
  for (const move of game.moves) {
    if (!Chess.applyRemoteMove(move)) {
      Chess.onlineGame = false;
      updateStatus("La partida quedó desincronizada. Cancelá la sala o volvé a unirte.");
      return;
    }
  }
  gameStarted = game.status === "active";
  setOnlineControls(gameStarted);
  if (game.matchMode === "invite" && game.inviteCode) {
    inviteCodeDisplay.textContent = game.inviteCode;
    setInviteInUrl(game.inviteCode);
    inviteShare.hidden = gameStarted;
  } else {
    inviteShare.hidden = true;
  }
  updateStatus(
    gameStarted
      ? `Partida activa — jugás con ${playerColor === "white" ? "blancas" : "negras"}.`
      : game.matchMode === "invite"
        ? "Sala privada creada. Compartí el código o el enlace para invitar."
        : "Buscando rival aleatorio…",
  );
};

const joinInvitation = (code) => {
  if (!socket.connected) {
    updateStatus("Todavía no hay conexión con el servidor.");
    return;
  }
  inviteCodeInput.value = String(code ?? "").trim().toLowerCase();
  updateStatus("Uniéndote a la partida…");
  joinInviteButton.disabled = true;
  socket.emit("invite:join", { code: inviteCodeInput.value }, (result) => {
    if (!result?.ok) {
      joinInviteButton.disabled = false;
      updateStatus(result?.message ?? "No se pudo aceptar la invitación.");
    }
  });
};

Chess.onlineGame = false;
Chess.playerColor = null;
Chess.onMove = ({ from, to, san, promotion }) => {
  if (!gameStarted || !gameId) return;
  socket.emit("game:move", { gameId, from, to, san, promotion }, (result) => {
    if (!result?.ok) {
      updateStatus(result?.message ?? "No se pudo sincronizar la jugada.");
      syncGame();
    }
  });
};

nameInput.addEventListener("change", () => {
  const name = nameInput.value.trim().slice(0, 40);
  nameInput.value = name || `Invitado-${playerToken.slice(0, 5)}`;
  localStorage.setItem(nameKey, nameInput.value);
  socket.auth.displayName = nameInput.value;
  if (socket.connected) socket.emit("player:rename", { displayName: nameInput.value });
});

localButton.addEventListener("click", async () => {
  if (!(await cancelPendingGame())) return;
  chess.end();
  chess.start();
  updateStatus("Partida local: juegan dos personas en esta pantalla.");
});

findButton.addEventListener("click", async () => {
  if (!socket.connected) {
    updateStatus("Todavía no hay conexión con el servidor.");
    return;
  }
  if (!(await cancelPendingGame())) return;
  socket.auth.displayName = nameInput.value.trim();
  localStorage.setItem(nameKey, nameInput.value.trim());
  findButton.disabled = true;
  updateStatus("Buscando un rival aleatorio…");
  socket.emit("match:find", {}, (result) => {
    if (!result?.ok) {
      findButton.disabled = false;
      updateStatus(result?.message ?? "No se pudo buscar rival.");
    }
  });
});

createInviteButton.addEventListener("click", async () => {
  if (!socket.connected) {
    updateStatus("Todavía no hay conexión con el servidor.");
    return;
  }
  if (!(await cancelPendingGame())) return;
  inviteShare.hidden = true;
  createInviteButton.disabled = true;
  updateStatus("Creando una sala privada…");
  socket.emit("invite:create", {}, (result) => {
    if (!result?.ok) {
      createInviteButton.disabled = false;
      updateStatus(result?.message ?? "No se pudo crear la invitación.");
      return;
    }
    inviteCodeInput.value = result.inviteCode;
    inviteCodeDisplay.textContent = result.inviteCode;
    setInviteInUrl(result.inviteCode);
    inviteShare.hidden = false;
  });
});

joinInviteButton.addEventListener("click", async () => {
  if (!(await cancelPendingGame())) return;
  joinInvitation(inviteCodeInput.value);
});

cancelWaitingButton.addEventListener("click", async () => {
  if (await cancelPendingGame()) updateStatus("La espera se canceló.");
});

copyInviteButton.addEventListener("click", async () => {
  if (!currentInviteCode) return;
  try {
    const inviteUrl = new URL(location.href);
    inviteUrl.searchParams.set("invite", currentInviteCode);
    await navigator.clipboard.writeText(inviteUrl.toString());
    updateStatus("Enlace de invitación copiado.");
  } catch {
    updateStatus("No se pudo copiar; copiá el enlace desde la barra del navegador.");
  }
});

socket.on("connect", () => updateStatus("Conectado. Elegí cómo querés jugar."));
socket.on("disconnect", () => updateStatus("Se perdió la conexión; intentando reconectar…"));
socket.on("connect_error", (error) => updateStatus(error.message));
socket.on("game:error", ({ message }) => updateStatus(message));

socket.on("player:ready", ({ hasGame }) => {
  if (hasGame) return;
  const previousGameId = localStorage.getItem("chessGameId");
  clearOnlineGame();
  if (pendingLinkCode && !autoJoinAttempted) {
    autoJoinAttempted = true;
    joinInvitation(pendingLinkCode);
    return;
  }
  if (previousGameId) updateStatus("La partida anterior ya no existe; elegí otra modalidad.");
});

socket.on("game:joined", (game) => {
  gameId = game.gameId;
  gameMode = game.matchMode;
  playerColor = game.color;
  if (game.matchMode === "invite" && game.inviteCode) {
    currentInviteCode = game.inviteCode;
  }
  Chess.playerColor = playerColor;
  localStorage.setItem("chessGameId", gameId);
  applyGameSnapshot(game);
});

socket.on("game:started", ({ gameId: startedGameId }) => {
  if (startedGameId !== gameId) return;
  gameStarted = true;
  Chess.onlineGame = true;
  Chess.playerColor = playerColor;
  setOnlineControls(true);
  inviteShare.hidden = true;
  updateStatus(`¡Rival conectado! Jugás con ${playerColor === "white" ? "blancas" : "negras"}.`);
});

socket.on("game:move", (move) => {
  if (move.gameId !== gameId) return;
  if (!Chess.applyRemoteMove(move)) {
    updateStatus("Se detectó una desincronización; recuperando la partida…");
    syncGame();
  }
});

socket.on("game:state", applyGameSnapshot);
socket.on("game:finished", ({ gameId: finishedGameId, result }) => {
  if (finishedGameId !== gameId) return;
  socket.emit("game:leave", { gameId });
  clearOnlineGame();
  updateStatus(
    result === "draw"
      ? "Tablas. La partida terminó; podés elegir otra modalidad."
      : `Partida terminada. Ganaron ${result === "white" ? "las blancas" : "las negras"}. Podés elegir otra modalidad.`,
  );
});

if (pendingLinkCode) inviteCodeInput.value = pendingLinkCode.toLowerCase();
