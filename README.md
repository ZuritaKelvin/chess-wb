# Chess.js

Chess.js is a browser chess game with local play, random matchmaking, and private invitation games over Socket.IO with Turso/libSQL persistence.

## Run locally

Create a `.env` file in the project root with the credentials for your Turso database:

```env
DB_URL=libsql://your-database.turso.io
DB_TOKEN=your-turso-auth-token
PORT=3000
```

Then install dependencies and start the server:

```sh
bun install
bun run dev
```

Open <http://localhost:3000>. The player can choose local play on one screen, queue for a random opponent, or create/join a private game with a 12-character code or invitation URL. Open a second browser session to try the online options. The server applies the schema from `src/server/schema.sql` when it starts and adds missing columns for databases created with an earlier version.

## Online-game lifecycle

- A random temporary player token is kept in browser `localStorage`; the server stores only its SHA-256 hash.
- Socket.IO is the real-time transport. Turso stores players, game seats, current FEN, and accepted moves.
- Random matchmaking only pairs players from the random queue; private invitation games are isolated and can only be joined with their code/link.
- The server validates every move with `chess.js`; the browser recomputes accepted moves for rendering and history.
- A disconnected player has 60 seconds to reconnect. When all seats in an active game are disconnected past that grace period, the server deletes the game, seats, and moves. An abandoned waiting game is also deleted after its only player has been disconnected for the grace period.
- Finished games and their moves are retained for up to 24 hours, then deleted. Temporary player records are deleted after expiry when no game references them.

Use HTTPS in production. For stronger protection against token theft via browser scripts, replace the localStorage identity token with a `Secure`, `HttpOnly`, `SameSite` cookie.
