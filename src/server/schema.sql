CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 40),
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  match_mode TEXT NOT NULL DEFAULT 'random' CHECK (match_mode IN ('random', 'invite')),
  invite_code TEXT,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'active', 'finished')),
  side_to_move TEXT NOT NULL DEFAULT 'white' CHECK (side_to_move IN ('white', 'black')),
  current_fen TEXT NOT NULL DEFAULT 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS game_players (
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  color TEXT NOT NULL CHECK (color IN ('white', 'black')),
  joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
  disconnected_at INTEGER,
  PRIMARY KEY (game_id, player_id),
  UNIQUE (game_id, color),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  move_number INTEGER NOT NULL CHECK (move_number > 0),
  player_id TEXT NOT NULL,
  from_square TEXT NOT NULL CHECK (from_square GLOB '[a-h][1-8]'),
  to_square TEXT NOT NULL CHECK (to_square GLOB '[a-h][1-8]'),
  san TEXT NOT NULL,
  promotion TEXT CHECK (promotion IS NULL OR promotion IN ('q', 'r', 'b', 'n')),
  fen_after TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (game_id, move_number),
  FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
  FOREIGN KEY (game_id, player_id)
    REFERENCES game_players(game_id, player_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_game_players_player
  ON game_players(player_id);

CREATE INDEX IF NOT EXISTS idx_moves_game_order
  ON moves(game_id, move_number);
