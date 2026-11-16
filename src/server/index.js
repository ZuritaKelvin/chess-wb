import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import logger from "morgan";
import { createClient } from "@libsql/client";
import { Server } from "socket.io";
import { Chess as ChessEngine } from "chess.js";

dotenv.config();

const port = Number(process.env.PORT ?? 3000);
const disconnectGraceSeconds = 60;
const playerLifetimeSeconds = 24 * 60 * 60;
const app = express();
const server = createServer(app);
const io = new Server(server, { connectionStateRecovery: {} });
const db = createClient({
  url: process.env.DB_URL ?? "",
  authToken: process.env.DB_TOKEN,
});
const activeSocketsByPlayer = new Map();
const clientDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.DB_URL) {
  throw new Error("Falta configurar DB_URL en el entorno.");
}

await db.execute("PRAGMA foreign_keys = ON");
await db.executeMultiple(
  await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
);

async function ensureColumn(table, column, definition) {
  const columns = await db.execute(`PRAGMA table_info(${table})`);
  if (!columns.rows.some((row) => row.name === column)) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

await ensureColumn(
  "games",
  "current_fen",
  "TEXT NOT NULL DEFAULT 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'",
);
await ensureColumn("games", "finished_at", "INTEGER");
await ensureColumn("games", "match_mode", "TEXT NOT NULL DEFAULT 'random'");
await ensureColumn("games", "invite_code", "TEXT");
await ensureColumn("game_players", "disconnected_at", "INTEGER");
await ensureColumn("moves", "promotion", "TEXT");
await ensureColumn("moves", "fen_after", "TEXT NOT NULL DEFAULT ''");
await db.execute(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_games_invite_code ON games(invite_code)",
);
await db.execute(
  "CREATE INDEX IF NOT EXISTS idx_games_mode_waiting ON games(match_mode, status, created_at)",
);

app.use(logger("dev"));
app.use("/images", express.static(path.join(clientDirectory, "images")));
app.use("/services", express.static(path.join(clientDirectory, "services")));
app.get(["/style.css", "/code.js", "/index.html"], (request, response) => {
  response.sendFile(path.join(clientDirectory, request.path.slice(1)));
});
app.get("/", (_request, response) => {
  response.sendFile(path.join(clientDirectory, "index.html"));
});

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function isSquare(value) {
  return typeof value === "string" && /^[a-h][1-8]$/.test(value);
}

function getPlayerSockets(playerId) {
  let sockets = activeSocketsByPlayer.get(playerId);
  if (!sockets) {
    sockets = new Set();
    activeSocketsByPlayer.set(playerId, sockets);
  }
  return sockets;
}

async function cleanupExpiredAbandonedGames() {
  const cutoff = Math.floor(Date.now() / 1000) - disconnectGraceSeconds;
  const finishedCutoff = Math.floor(Date.now() / 1000) - playerLifetimeSeconds;
  const transaction = await db.transaction("write");
  try {
    const expired = await transaction.execute({
      sql: `SELECT g.id FROM games g
            WHERE (g.status = 'finished' AND COALESCE(g.finished_at, g.created_at) <= ?)
               OR g.id IN (
                 SELECT gp.game_id FROM game_players gp
                 JOIN games active_game ON active_game.id = gp.game_id
                 GROUP BY gp.game_id, active_game.status
                 HAVING (active_game.status = 'waiting' AND COUNT(*) = 1
                         AND SUM(CASE WHEN gp.disconnected_at IS NOT NULL
                                           AND gp.disconnected_at <= ? THEN 1 ELSE 0 END) = 1)
                     OR (active_game.status = 'active' AND COUNT(*) = 2
                         AND SUM(CASE WHEN gp.disconnected_at IS NOT NULL
                                           AND gp.disconnected_at <= ? THEN 1 ELSE 0 END) = 2)
               )`,
      args: [finishedCutoff, cutoff, cutoff],
    });
    const gameIds = expired.rows.map((row) => row.id);
    if (gameIds.length > 0) {
      const placeholders = gameIds.map(() => "?").join(", ");
      await transaction.execute({
        sql: `DELETE FROM moves WHERE game_id IN (${placeholders})`,
        args: gameIds,
      });
      await transaction.execute({
        sql: `DELETE FROM game_players WHERE game_id IN (${placeholders})`,
        args: gameIds,
      });
      await transaction.execute({
        sql: `DELETE FROM games WHERE id IN (${placeholders})`,
        args: gameIds,
      });
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
  await db.execute({
    sql: "DELETE FROM players WHERE expires_at <= ? AND id NOT IN (SELECT player_id FROM game_players)",
    args: [Math.floor(Date.now() / 1000)],
  });
}

async function loadPlayerGames(playerId) {
  const result = await db.execute({
    sql: `SELECT g.id, g.status, g.match_mode, g.invite_code, gp.color
          FROM games g JOIN game_players gp ON gp.game_id = g.id
          WHERE gp.player_id = ? AND g.status IN ('waiting', 'active')
          ORDER BY g.created_at DESC LIMIT 1`,
    args: [playerId],
  });
  return result.rows[0] ?? null;
}

async function loadGamePlayers(gameId) {
  const result = await db.execute({
    sql: `SELECT gp.color, p.display_name AS displayName
          FROM game_players gp JOIN players p ON p.id = gp.player_id
          WHERE gp.game_id = ?`,
    args: [gameId],
  });
  return Object.fromEntries(result.rows.map(({ color, displayName }) => [color, displayName]));
}

async function attachPlayerToGame(socket, game) {
  if (socket.data.gameId && socket.data.gameId !== game.id) {
    await socket.leave(socket.data.gameId);
  }
  socket.data.gameId = game.id;
  socket.data.color = game.color;
  await socket.join(game.id);
  const moves = await db.execute({
    sql: `SELECT move_number, player_id, from_square AS "from", to_square AS "to", san, promotion
          FROM moves WHERE game_id = ? ORDER BY move_number`,
    args: [game.id],
  });
  const players = await loadGamePlayers(game.id);
  socket.emit("game:joined", {
    gameId: game.id,
    color: game.color,
    status: game.status,
    matchMode: game.match_mode,
    inviteCode: game.invite_code,
    players,
    moves: moves.rows,
  });
}

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const displayName = String(socket.handshake.auth?.displayName ?? "").trim();
    if (typeof token !== "string" || token.length < 32 || token.length > 128) {
      return next(new Error("Identidad temporal inválida."));
    }
    const tokenHash = hashToken(token);
    const result = await db.execute({
      sql: "SELECT id, display_name FROM players WHERE token_hash = ?",
      args: [tokenHash],
    });
    let player = result.rows[0];
    if (!player) {
      const id = randomUUID();
      const safeName = displayName.slice(0, 40) || `Invitado-${id.slice(0, 5)}`;
      await db.execute({
        sql: `INSERT INTO players (id, display_name, token_hash, expires_at)
              VALUES (?, ?, ?, ?)`,
        args: [id, safeName, tokenHash, Math.floor(Date.now() / 1000) + playerLifetimeSeconds],
      });
      player = { id, display_name: safeName };
    } else {
      await db.execute({
        sql: "UPDATE players SET expires_at = ?, display_name = ? WHERE id = ?",
        args: [
          Math.floor(Date.now() / 1000) + playerLifetimeSeconds,
          displayName.slice(0, 40) || player.display_name,
          player.id,
        ],
      });
      player.display_name = displayName.slice(0, 40) || player.display_name;
    }
    socket.data.playerId = player.id;
    socket.data.displayName = player.display_name;
    next();
  } catch (error) {
    console.error("No se pudo autenticar jugador:", error);
    next(new Error("No se pudo iniciar la sesión temporal."));
  }
});

io.on("connection", async (socket) => {
  const playerId = socket.data.playerId;
  const sockets = getPlayerSockets(playerId);
  sockets.add(socket.id);

  try {
    await cleanupExpiredAbandonedGames();
    await db.execute({
      sql: "UPDATE game_players SET disconnected_at = NULL WHERE player_id = ?",
      args: [playerId],
    });
    const existingGame = await loadPlayerGames(playerId);
    if (existingGame) {
      await attachPlayerToGame(socket, existingGame);
    }
    socket.emit("player:ready", {
      displayName: socket.data.displayName,
      hasGame: Boolean(existingGame),
    });
  } catch (error) {
    console.error("Error al recuperar sesión de jugador:", error);
    socket.emit("game:error", { message: "No se pudo recuperar tu partida." });
  }

  socket.on("match:find", async (_payload, acknowledge = () => {}) => {
    try {
      const currentGame = await loadPlayerGames(playerId);
      if (currentGame) {
        await attachPlayerToGame(socket, currentGame);
        acknowledge({ ok: true });
        return;
      }

      const transaction = await db.transaction("write");
      let joinedGame;
      try {
        const existing = await transaction.execute({
          sql: `SELECT g.id, g.status, g.match_mode, g.invite_code, gp.color
                FROM games g JOIN game_players gp ON gp.game_id = g.id
                WHERE gp.player_id = ? AND g.status IN ('waiting', 'active')
                ORDER BY g.created_at DESC LIMIT 1`,
          args: [playerId],
        });
        if (existing.rows[0]) {
          joinedGame = existing.rows[0];
        }

        const waiting = await transaction.execute({
          sql: `SELECT g.id FROM games g
                JOIN game_players gp ON gp.game_id = g.id
                WHERE g.status = 'waiting' AND g.match_mode = 'random'
                  AND gp.player_id <> ? AND gp.disconnected_at IS NULL
                ORDER BY g.created_at LIMIT 1`,
          args: [playerId],
        });
        if (!joinedGame && waiting.rows[0]) {
          const gameId = waiting.rows[0].id;
          const changed = await transaction.execute({
            sql: "UPDATE games SET status = 'active', started_at = unixepoch() WHERE id = ? AND status = 'waiting'",
            args: [gameId],
          });
          if (Number(changed.rowsAffected) === 1) {
            await transaction.execute({
              sql: "INSERT INTO game_players (game_id, player_id, color) VALUES (?, ?, 'black')",
              args: [gameId, playerId],
            });
          joinedGame = { id: gameId, status: "active", match_mode: "random", color: "black" };
          }
        }

        if (!joinedGame) {
          const gameId = randomUUID();
          await transaction.execute({
            sql: "INSERT INTO games (id, status) VALUES (?, 'waiting')",
            args: [gameId],
          });
          await transaction.execute({
            sql: "INSERT INTO game_players (game_id, player_id, color) VALUES (?, ?, 'white')",
            args: [gameId, playerId],
          });
          joinedGame = { id: gameId, status: "waiting", match_mode: "random", color: "white" };
        }
        await transaction.commit();
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        transaction.close();
      }

      await attachPlayerToGame(socket, joinedGame);
      if (joinedGame.status === "active") {
        io.to(joinedGame.id).emit("game:started", {
          gameId: joinedGame.id,
          players: await loadGamePlayers(joinedGame.id),
        });
      }
      acknowledge({ ok: true });
    } catch (error) {
      console.error("No se pudo buscar partida:", error);
      acknowledge({ ok: false, message: "No se pudo buscar una partida." });
    }
  });

  socket.on("invite:create", async (_payload, acknowledge = () => {}) => {
    try {
      if (await loadPlayerGames(playerId)) {
        acknowledge({
          ok: false,
          message: "Terminá o cancelá tu sala pendiente antes de crear otra partida.",
        });
        return;
      }
      const transaction = await db.transaction("write");
      let game;
      try {
        const existing = await transaction.execute({
          sql: `SELECT g.id, g.status, gp.color FROM games g
                JOIN game_players gp ON gp.game_id = g.id
                WHERE gp.player_id = ? AND g.status IN ('waiting', 'active') LIMIT 1`,
          args: [playerId],
        });
        if (existing.rows[0]) {
          await transaction.rollback();
          acknowledge({ ok: false, message: "Ya tenés una partida pendiente o activa." });
          return;
        }
        const gameId = randomUUID();
        const inviteCode = randomBytes(6).toString("hex");
        await transaction.execute({
          sql: `INSERT INTO games (id, match_mode, invite_code, status)
                VALUES (?, 'invite', ?, 'waiting')`,
          args: [gameId, inviteCode],
        });
        await transaction.execute({
          sql: "INSERT INTO game_players (game_id, player_id, color) VALUES (?, ?, 'white')",
          args: [gameId, playerId],
        });
        await transaction.commit();
        game = {
          id: gameId,
          status: "waiting",
          match_mode: "invite",
          invite_code: inviteCode,
          color: "white",
        };
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        transaction.close();
      }
      await attachPlayerToGame(socket, game);
      acknowledge({ ok: true, inviteCode: game.invite_code });
    } catch (error) {
      console.error("No se pudo crear la invitación:", error);
      acknowledge({ ok: false, message: "No se pudo crear la invitación." });
    }
  });

  socket.on("invite:join", async (payload, acknowledge = () => {}) => {
    const inviteCode = String(payload?.code ?? "").trim().toLowerCase();
    if (!/^[0-9a-f]{12}$/.test(inviteCode)) {
      acknowledge({ ok: false, message: "El código de invitación no es válido." });
      return;
    }
    try {
      const transaction = await db.transaction("write");
      let game;
      try {
        const existing = await transaction.execute({
          sql: `SELECT g.id FROM games g JOIN game_players gp ON gp.game_id = g.id
                WHERE gp.player_id = ? AND g.status IN ('waiting', 'active') LIMIT 1`,
          args: [playerId],
        });
        if (existing.rows[0]) {
          await transaction.rollback();
          acknowledge({ ok: false, message: "Ya estás en otra partida." });
          return;
        }
        const invitation = await transaction.execute({
          sql: `SELECT id FROM games
                WHERE invite_code = ? AND match_mode = 'invite' AND status = 'waiting'`,
          args: [inviteCode],
        });
        if (!invitation.rows[0]) {
          await transaction.rollback();
          acknowledge({ ok: false, message: "La invitación no existe o ya fue utilizada." });
          return;
        }
        const gameId = invitation.rows[0].id;
        const owner = await transaction.execute({
          sql: "SELECT player_id FROM game_players WHERE game_id = ? AND color = 'white'",
          args: [gameId],
        });
        if (owner.rows[0]?.player_id === playerId) {
          await transaction.rollback();
          acknowledge({ ok: false, message: "No podés unirte a tu propia invitación." });
          return;
        }
        const changed = await transaction.execute({
          sql: "UPDATE games SET status = 'active', started_at = unixepoch() WHERE id = ? AND status = 'waiting'",
          args: [gameId],
        });
        if (Number(changed.rowsAffected) !== 1) {
          await transaction.rollback();
          acknowledge({ ok: false, message: "La invitación ya fue utilizada." });
          return;
        }
        await transaction.execute({
          sql: "INSERT INTO game_players (game_id, player_id, color) VALUES (?, ?, 'black')",
          args: [gameId, playerId],
        });
        await transaction.commit();
        game = { id: gameId, status: "active", match_mode: "invite", invite_code: inviteCode, color: "black" };
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        transaction.close();
      }
      await attachPlayerToGame(socket, game);
      io.to(game.id).emit("game:started", {
        gameId: game.id,
        players: await loadGamePlayers(game.id),
      });
      acknowledge({ ok: true });
    } catch (error) {
      console.error("No se pudo aceptar la invitación:", error);
      acknowledge({ ok: false, message: "No se pudo unir a esa partida." });
    }
  });

  socket.on("game:cancel", async (payload, acknowledge = () => {}) => {
    const gameId = payload?.gameId;
    if (!gameId || gameId !== socket.data.gameId) {
      acknowledge({ ok: false, message: "No hay una sala pendiente para cancelar." });
      return;
    }
    const transaction = await db.transaction("write");
    try {
      const waiting = await transaction.execute({
        sql: `SELECT g.id FROM games g JOIN game_players gp ON gp.game_id = g.id
              WHERE g.id = ? AND gp.player_id = ? AND g.status = 'waiting'`,
        args: [gameId, playerId],
      });
      if (!waiting.rows[0]) {
        await transaction.rollback();
        acknowledge({ ok: false, message: "Una partida activa no se puede cancelar desde acá." });
        return;
      }
      await transaction.execute({ sql: "DELETE FROM moves WHERE game_id = ?", args: [gameId] });
      await transaction.execute({ sql: "DELETE FROM game_players WHERE game_id = ?", args: [gameId] });
      await transaction.execute({ sql: "DELETE FROM games WHERE id = ?", args: [gameId] });
      await transaction.commit();
      await socket.leave(gameId);
      socket.data.gameId = null;
      socket.data.color = null;
      acknowledge({ ok: true });
    } catch (error) {
      await transaction.rollback();
      console.error("No se pudo cancelar la sala:", error);
      acknowledge({ ok: false, message: "No se pudo cancelar la sala." });
    } finally {
      transaction.close();
    }
  });

  socket.on("player:rename", async (payload) => {
    const displayName = String(payload?.displayName ?? "").trim().slice(0, 40);
    if (!displayName) return;
    try {
      await db.execute({
        sql: "UPDATE players SET display_name = ?, expires_at = ? WHERE id = ?",
        args: [displayName, Math.floor(Date.now() / 1000) + playerLifetimeSeconds, playerId],
      });
      socket.data.displayName = displayName;
      socket.emit("player:renamed", { displayName });
      if (socket.data.gameId) {
        io.to(socket.data.gameId).emit("game:players", {
          gameId: socket.data.gameId,
          players: await loadGamePlayers(socket.data.gameId),
        });
      }
    } catch (error) {
      console.error("No se pudo actualizar el nombre:", error);
    }
  });

  socket.on("game:move", async (payload, acknowledge = () => {}) => {
    try {
      const { gameId, from, to, promotion } = payload ?? {};
      if (
        !isSquare(from) ||
        !isSquare(to) ||
        (promotion !== undefined && !["q", "r", "b", "n"].includes(promotion))
      ) {
        acknowledge({ ok: false, message: "La jugada enviada no es válida." });
        return;
      }
      const transaction = await db.transaction("write");
      let moveNumber;
      let acceptedMove;
      let gameFinished = false;
      let result = null;
      try {
        const game = await transaction.execute({
          sql: `SELECT g.side_to_move, g.current_fen, gp.color
                FROM games g JOIN game_players gp ON gp.game_id = g.id
                WHERE g.id = ? AND gp.player_id = ? AND g.status = 'active'`,
          args: [gameId, playerId],
        });
        const turn = game.rows[0];
        if (!turn || turn.color !== turn.side_to_move || gameId !== socket.data.gameId) {
          await transaction.rollback();
          acknowledge({ ok: false, message: "No es tu turno o la partida terminó." });
          return;
        }
        const engine = new ChessEngine(turn.current_fen);
        try {
          acceptedMove = engine.move({ from, to, promotion });
        } catch {
          await transaction.rollback();
          acknowledge({ ok: false, message: "Esa jugada no es legal." });
          return;
        }
        gameFinished = engine.isGameOver();
        result = engine.isCheckmate()
          ? (turn.side_to_move === "white" ? "black" : "white")
          : "draw";
        const count = await transaction.execute({
          sql: "SELECT COUNT(*) AS count FROM moves WHERE game_id = ?",
          args: [gameId],
        });
        moveNumber = Number(count.rows[0].count) + 1;
        await transaction.execute({
          sql: `INSERT INTO moves (game_id, move_number, player_id, from_square, to_square, san, promotion, fen_after)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [gameId, moveNumber, playerId, from, to, acceptedMove.san, acceptedMove.promotion ?? null, engine.fen()],
        });
        await transaction.execute({
          sql: "UPDATE games SET side_to_move = ?, current_fen = ?, status = ?, finished_at = ? WHERE id = ?",
          args: [
            turn.side_to_move === "white" ? "black" : "white",
            engine.fen(),
            engine.isGameOver() ? "finished" : "active",
            gameFinished ? Math.floor(Date.now() / 1000) : null,
            gameId,
          ],
        });
        await transaction.commit();
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        transaction.close();
      }

      const move = { gameId, moveNumber, playerId, from, to, promotion, san: acceptedMove.san };
      socket.to(gameId).emit("game:move", move);
      if (gameFinished) io.to(gameId).emit("game:finished", { gameId, result });
      acknowledge({ ok: true, moveNumber });
    } catch (error) {
      console.error("No se pudo guardar jugada:", error);
      acknowledge({ ok: false, message: "No se pudo guardar la jugada." });
    }
  });

  socket.on("game:sync", async (payload) => {
    try {
      const gameId = payload?.gameId;
      const game = await db.execute({
        sql: `SELECT g.id, g.status, g.match_mode, gp.color
              FROM games g JOIN game_players gp ON gp.game_id = g.id
              WHERE g.id = ? AND gp.player_id = ?`,
        args: [gameId, playerId],
      });
      if (!game.rows[0]) return;
      const moves = await db.execute({
        sql: `SELECT move_number, player_id, from_square AS "from", to_square AS "to", san, promotion
              FROM moves WHERE game_id = ? ORDER BY move_number`,
        args: [gameId],
      });
      const players = await loadGamePlayers(gameId);
      socket.emit("game:state", {
        gameId,
        status: game.rows[0].status,
        matchMode: game.rows[0].match_mode,
        color: game.rows[0].color,
        players,
        moves: moves.rows,
      });
    } catch (error) {
      console.error("No se pudo sincronizar la partida:", error);
      socket.emit("game:error", { message: "No se pudo sincronizar la partida." });
    }
  });

  socket.on("game:leave", async (payload) => {
    const gameId = payload?.gameId;
    if (gameId && gameId === socket.data.gameId) {
      await socket.leave(gameId);
      socket.data.gameId = null;
      socket.data.color = null;
    }
  });

  socket.on("disconnect", async () => {
    sockets.delete(socket.id);
    if (sockets.size === 0) {
      activeSocketsByPlayer.delete(playerId);
      try {
        await db.execute({
          sql: "UPDATE game_players SET disconnected_at = unixepoch() WHERE player_id = ?",
          args: [playerId],
        });
        io.emit("player:offline", { playerId });
      } catch (error) {
        console.error("No se pudo registrar desconexión:", error);
      }
    }
  });
});

const cleanupTimer = setInterval(() => {
  cleanupExpiredAbandonedGames().catch((error) => {
    console.error("Falló limpieza de partidas abandonadas:", error);
  });
}, 15_000);
cleanupTimer.unref();
await cleanupExpiredAbandonedGames();

server.listen(port, () => {
  console.log(`Servidor de ajedrez escuchando en http://localhost:${port}`);
});

async function shutdown() {
  clearInterval(cleanupTimer);
  io.close();
  server.close();
  db.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
