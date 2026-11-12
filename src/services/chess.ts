import confetti from "canvas-confetti";
type HistoryMoveInput = {
  turn: "white" | "black";
  pieceName: string;
  from: string;
  to: string;
  capture?: boolean;
  check?: boolean;
  mate?: boolean;
  promotion?: "Q" | "R" | "B" | "N";
  enPassant?: boolean;
  castling?: "O-O" | "O-O-O";
};

type HistoryEntry = {
  number: number;
  white: string;
  black: string;
};

type MoveOutcome = {
  moved: true;
  capture?: boolean;
  check?: boolean;
  mate?: boolean;
  promotion?: "Q" | "R" | "B" | "N";
  enPassant?: boolean;
  castling?: "O-O" | "O-O-O";
} | null;

type Position = [number, number];
type PieceColor = "white" | "black";
type PromotionPiece = "queen" | "rook" | "bishop" | "knight";

type ChessMove = {
  from: Position;
  to: Position;
  capture?: boolean;
  promotion?: PromotionPiece;
  enPassant?: boolean;
  castling?: "O-O" | "O-O-O";
};

type CastlingRights = {
  whiteKing: boolean;
  whiteRookA: boolean;
  whiteRookH: boolean;
  blackKing: boolean;
  blackRookA: boolean;
  blackRookH: boolean;
};

type MoveSnapshot = {
  fromCell: Cell;
  toCell: Cell;
  movingPiece: Piece;
  capturedCell: Cell;
  capturedPiece: Piece | null;
  movingName: string | null;
  movingPosition: Position;
  rookFromCell: Cell | null;
  rookToCell: Cell | null;
  rookPiece: Piece | null;
  rookPosition: Position | null;
};

export default class Chess {
  eventController: AbortController | null = null;
  static onlineGame = false;
  static playerColor: PieceColor | null = null;
  static onMove: ((move: { from: string; to: string; san: string; promotion?: string }) => void) | null = null;
  static board: Cell[][] = Array.from({ length: 8 }, () => []);
  static deletedWhitePieces = 0;
  static deletedBlackPieces = 0;
  static turn: "white" | "black" = "white";
  static selectedPiece: string | null = null;
  static history: HistoryEntry[] = [];
  static enPassantTarget: Position | null = null;
  static castlingRights: CastlingRights = {
    whiteKing: true,
    whiteRookA: true,
    whiteRookH: true,
    blackKing: true,
    blackRookA: true,
    blackRookH: true,
  };

  start() {
    this.destroy();
    const controller = new AbortController();
    this.eventController = controller;
    Chess.selectedPiece = null;
    Chess.enPassantTarget = null;
    Chess.castlingRights = createInitialCastlingRights();
    const favDialog = document.getElementById("favDialog") as HTMLDialogElement;
    favDialog.style.display = "none";
    const restartButton = document.getElementById(
      "restartGame",
    ) as HTMLButtonElement;
    const closeDialog = document.getElementById(
      "closeDialog",
    ) as HTMLButtonElement;

    restartButton?.addEventListener(
      "click",
      () => {
        favDialog.close();
        favDialog.classList.add("hidden");

        this.end();
        this.start();
      },
      { signal: controller.signal },
    );

    closeDialog?.addEventListener(
      "click",
      () => {
        favDialog.close();
        favDialog.classList.add("hidden");
      },
      { signal: controller.signal },
    );
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        const piece = getPieceNameFromPosition([i + 1, j + 1]);
        if (piece) {
          Chess.board[i][j] = new Cell(
            [i, j],
            new Piece(piece, j + 1 <= 2 ? "white" : "black", [i, j]),
          );
        } else {
          Chess.board[i][j] = new Cell([i, j]);
        }
      }
    }

    Chess.renderHistory();

    const evenChessBoxed = document.getElementsByClassName("evenChessBox");
    const oddChessBoxed = document.getElementsByClassName("oddChessBox");
    for (let i = 0; i < evenChessBoxed.length; i++) {
      evenChessBoxed[i].addEventListener("click", this.toggleFocus, {
        signal: this.eventController?.signal,
      });
    }
    for (let i = 0; i < oddChessBoxed.length; i++) {
      oddChessBoxed[i].addEventListener("click", this.toggleFocus, {
        signal: this.eventController?.signal,
      });
    }
  }
  toggleFocus(e: Event) {
    const clickedCell = e.currentTarget as HTMLElement;
    const clickedPosition = getPositionFromCellId(clickedCell.id);

    if (!clickedPosition) {
      return;
    }
    if (Chess.onlineGame && (!Chess.playerColor || Chess.turn !== Chess.playerColor)) {
      return;
    }

    if (!Chess.selectedPiece) {
      Chess.selectPiece(clickedCell.id);
      return;
    }

    const selectedPosition = getPositionFromCellId(Chess.selectedPiece);

    if (!selectedPosition) {
      Chess.clearFocusedCells();
      Chess.selectedPiece = null;
      return;
    }

    if (Chess.selectedPiece === clickedCell.id) {
      Chess.clearFocusedCells();
      Chess.selectedPiece = null;
      return;
    }

    const legalMove = Chess.getLegalMoves(selectedPosition).find((move) =>
      positionsAreEqual(move.to, clickedPosition),
    );

    if (legalMove) {
      const piece = Chess.board[selectedPosition[0]][selectedPosition[1]].piece;

      if (piece) {
        Chess.updateCastlingRights(legalMove, piece);
        Chess.executeMove(legalMove);
        Chess.enPassantTarget = getEnPassantTarget(legalMove, piece);
        const opponentColor = Chess.turn === "white" ? "black" : "white";
        const givesCheck = Chess.isKingInCheck(opponentColor);
        const givesMate = givesCheck && Chess.hasNoLegalMoves(opponentColor);

        const san = Chess.recordHistoryMove({
          turn: Chess.turn,
          pieceName: legalMove.promotion ? `${piece.color}-pawn` : piece.name!,
          from: getSquareName(Chess.selectedPiece),
          to: getSquareName(clickedCell.id),
          capture: legalMove.capture,
          check: givesCheck,
          mate: givesMate,
          promotion: legalMove.promotion
            ? getPromotionLetter(legalMove.promotion)
            : undefined,
          enPassant: legalMove.enPassant,
          castling: legalMove.castling,
        });

        Chess.turn = opponentColor;
        Chess.onMove?.({
          from: getSquareName(Chess.selectedPiece),
          to: getSquareName(clickedCell.id),
          promotion: legalMove.promotion ? legalMove.promotion[0] : undefined,
          san,
        });
        Chess.clearFocusedCells();
        Chess.selectedPiece = null;
        if (givesMate) {
          confetti({ particleCount: 200, spread: 70 });
          const favDialog = document.getElementById(
            "favDialog",
          ) as HTMLDialogElement;
          setTimeout(() => {
            favDialog.showModal();
            favDialog.style.display = "flex";
          }, 1000);
        }
      }

      return;
    }

    const clickedPiece =
      Chess.board[clickedPosition[0]][clickedPosition[1]].piece;

    if (clickedPiece?.color === Chess.turn) {
      Chess.selectPiece(clickedCell.id);
    } else {
      Chess.clearFocusedCells();
      Chess.selectedPiece = null;
    }
  }
  static selectPiece(cellId: string) {
    const position = getPositionFromCellId(cellId);

    if (!position) {
      return;
    }

    const piece = Chess.board[position[0]][position[1]].piece;

    if (!piece || piece.color !== Chess.turn) {
      return;
    }

    Chess.clearFocusedCells();
    Chess.selectedPiece = cellId;
    document.getElementById(cellId)?.classList.add("focus");
    console.log(
      "Legal moves for",
      piece.name,
      "at",
      cellId,
      ":",
      Chess.getLegalMoves(position),
    );
    for (const move of Chess.getLegalMoves(position)) {
      const targetId = `${positionXFromNumber(move.to[0])}${move.to[1] + 1}Cell`;
      document.getElementById(targetId)?.classList.add("avaliableMove");
    }
  }

  static clearFocusedCells() {
    document.querySelectorAll("#chessboard > div").forEach((cell) => {
      cell.classList.remove("focus");
      cell.classList.remove("avaliableMove");
    });
  }

  static getLegalMoves(from: Position): ChessMove[] {
    const piece = Chess.board[from[0]]?.[from[1]]?.piece;

    if (!piece || !piece.color) {
      return [];
    }

    return generatePseudoMoves(from, piece).filter((move) => {
      const snapshot = Chess.applyMoveToBoard(move, false);
      const legal = !Chess.isKingInCheck(piece.color as PieceColor);
      Chess.restoreBoardMove(snapshot, false);
      return legal;
    });
  }

  static hasNoLegalMoves(color: PieceColor) {
    for (const row of Chess.board) {
      for (const cell of row) {
        if (
          cell.piece?.color === color &&
          Chess.getLegalMoves(cell.position).length > 0
        ) {
          return false;
        }
      }
    }

    return true;
  }

  static executeMove(move: ChessMove) {
    const snapshot = Chess.applyMoveToBoard(move, true);
    const capturedPiece = snapshot.capturedPiece;

    if (capturedPiece?.color === "white") {
      Chess.deletedWhitePieces++;
      const scoreSpam = document.getElementById("BlackplayerScore");
      scoreSpam!.textContent = String(Chess.deletedWhitePieces);
    } else if (capturedPiece?.color === "black") {
      Chess.deletedBlackPieces++;
      const scoreSpam = document.getElementById("WhiteplayerScore");
      scoreSpam!.textContent = String(Chess.deletedBlackPieces);
    }
  }

  static applyMoveToBoard(move: ChessMove, render: boolean): MoveSnapshot {
    const fromCell = Chess.board[move.from[0]][move.from[1]];
    const toCell = Chess.board[move.to[0]][move.to[1]];
    const movingPiece = fromCell.piece!;
    const capturedCell = move.enPassant
      ? Chess.board[move.to[0]][move.from[1]]
      : toCell;
    const snapshot: MoveSnapshot = {
      fromCell,
      toCell,
      movingPiece,
      capturedPiece: capturedCell.piece,
      capturedCell,
      movingName: movingPiece.name,
      movingPosition: [...movingPiece.position] as Position,
      rookFromCell: null,
      rookToCell: null,
      rookPiece: null,
      rookPosition: null,
    };

    fromCell.clearPiece(render);
    if (capturedCell !== toCell) {
      capturedCell.clearPiece(render);
    }

    if (move.promotion) {
      movingPiece.name = `${movingPiece.color}-${move.promotion}`;
    }

    toCell.setPiece(movingPiece, render);

    if (render) {
      movingPiece.position = [...move.to];
    }

    if (move.castling) {
      const rookFromX = move.castling === "O-O" ? 7 : 0;
      const rookToX = move.castling === "O-O" ? 5 : 3;
      const rookY = move.from[1];
      const rookFromCell = Chess.board[rookFromX][rookY];
      const rookToCell = Chess.board[rookToX][rookY];
      const rook = rookFromCell.piece;

      snapshot.rookFromCell = rookFromCell;
      snapshot.rookToCell = rookToCell;
      snapshot.rookPiece = rook;
      snapshot.rookPosition = rook ? ([...rook.position] as Position) : null;

      if (rook) {
        rookFromCell.clearPiece(render);
        rookToCell.setPiece(rook, render);
        if (render) {
          rook.position = [rookToX, rookY];
        }
      }
    }

    return snapshot;
  }

  static restoreBoardMove(snapshot: MoveSnapshot, render: boolean) {
    snapshot.toCell.clearPiece(render);
    if (snapshot.capturedCell !== snapshot.toCell) {
      snapshot.capturedCell.clearPiece(render);
    }
    snapshot.fromCell.setPiece(snapshot.movingPiece, render);
    snapshot.movingPiece.name = snapshot.movingName;
    snapshot.movingPiece.position = snapshot.movingPosition;

    if (snapshot.rookFromCell && snapshot.rookToCell) {
      snapshot.rookToCell.clearPiece(render);
      if (snapshot.rookPiece) {
        snapshot.rookFromCell.setPiece(snapshot.rookPiece, render);
        snapshot.rookPiece.position = snapshot.rookPosition!;
      }
    }

    if (snapshot.capturedPiece) {
      snapshot.capturedCell.setPiece(snapshot.capturedPiece, render);
    }
  }

  static updateCastlingRights(move: ChessMove, piece: Piece) {
    const color = piece.color as PieceColor;
    const prefix = color === "white" ? "white" : "black";

    if (piece.name?.endsWith("-king")) {
      Chess.castlingRights[`${prefix}King` as keyof CastlingRights] = false;
    }

    if (piece.name?.endsWith("-rook")) {
      disableRookCastlingRight(Chess.castlingRights, color, move.from);
    }

    if (move.capture && !move.enPassant) {
      const capturedPiece = Chess.board[move.to[0]][move.to[1]].piece;
      if (capturedPiece?.name?.endsWith("-rook")) {
        disableRookCastlingRight(
          Chess.castlingRights,
          capturedPiece.color as PieceColor,
          move.to,
        );
      }
    }
  }
  destroy() {
    this.eventController?.abort();
    this.eventController = null;
  }
  end() {
    Chess.board = Array.from({ length: 8 }, () => []);

    Chess.deletedWhitePieces = 0;
    Chess.deletedBlackPieces = 0;

    document.getElementById("BlackplayerScore")!.textContent = "0";
    document.getElementById("WhiteplayerScore")!.textContent = "0";

    Chess.turn = "white";
    Chess.history = [];
    Chess.selectedPiece = null;
    Chess.enPassantTarget = null;
    Chess.castlingRights = createInitialCastlingRights();

    Chess.clearFocusedCells();
    Chess.renderHistory();
  }

  static recordHistoryMove(move: HistoryMoveInput) {
    const notation = formatMoveNotation(move);
    const lastMove = Chess.history[Chess.history.length - 1];

    if (move.turn === "white" || !lastMove) {
      Chess.history.push({
        number: Chess.history.length + 1,
        white: notation,
        black: "",
      });
    } else {
      lastMove.black = notation;
    }

    Chess.renderHistory();
    return notation;
  }

  static applyRemoteMove(move: { from: string; to: string }) {
    const from = getPositionFromCellId(`${move.from}Cell`);
    const to = getPositionFromCellId(`${move.to}Cell`);
    if (!from || !to) return false;

    const legalMove = Chess.getLegalMoves(from).find((candidate) =>
      positionsAreEqual(candidate.to, to),
    );
    const piece = Chess.board[from[0]]?.[from[1]]?.piece;
    if (!legalMove || !piece || piece.color !== Chess.turn) return false;

    Chess.updateCastlingRights(legalMove, piece);
    Chess.executeMove(legalMove);
    Chess.enPassantTarget = getEnPassantTarget(legalMove, piece);
    const opponentColor = Chess.turn === "white" ? "black" : "white";
    const givesCheck = Chess.isKingInCheck(opponentColor);
    const givesMate = givesCheck && Chess.hasNoLegalMoves(opponentColor);
    Chess.recordHistoryMove({
      turn: Chess.turn,
      pieceName: legalMove.promotion ? `${piece.color}-pawn` : piece.name!,
      from: move.from,
      to: move.to,
      capture: legalMove.capture,
      check: givesCheck,
      mate: givesMate,
      promotion: legalMove.promotion ? getPromotionLetter(legalMove.promotion) : undefined,
      enPassant: legalMove.enPassant,
      castling: legalMove.castling,
    });
    Chess.turn = opponentColor;
    Chess.clearFocusedCells();
    Chess.selectedPiece = null;
    return true;
  }

  static isKingInCheck(color: "white" | "black") {
    const kingPosition = findKingPosition(color);

    if (!kingPosition) {
      return false;
    }

    const opponentColor = color === "white" ? "black" : "white";

    return isSquareAttacked(kingPosition, opponentColor);
  }

  static renderHistory() {
    const historyList = document.getElementById("historyList");

    if (!historyList) {
      return;
    }

    if (Chess.history.length === 0) {
      historyList.innerHTML = `
        <li class="historyEmpty">Todavía no hay jugadas. Hacé dos clicks para mover una pieza.</li>
      `;
      return;
    }

    historyList.innerHTML = Chess.history
      .map(
        (move) => `
          <li class="historyRow">
            <span class="moveNumber">${move.number}.</span>
            <span class="historyMove whiteMove ${move.white ? "" : "emptyMove"}">
              <span class="moveColor">BLANCAS</span>
              <strong>${move.white || "—"}</strong>
            </span>
            <span class="historyMove blackMove ${move.black ? "" : "emptyMove"}">
              <span class="moveColor">NEGRAS</span>
              <strong>${move.black || "—"}</strong>
            </span>
          </li>
        `,
      )
      .join("");
  }
}

function PositionXFromLetter(positionX: string) {
  switch (positionX) {
    case "a":
      return 0;
    case "b":
      return 1;
    case "c":
      return 2;
    case "d":
      return 3;
    case "e":
      return 4;
    case "f":
      return 5;
    case "g":
      return 6;
    case "h":
      return 7;
    default:
      return 0;
  }
}
function positionXFromNumber(positionX: number) {
  switch (positionX) {
    case 0:
      return "a";
    case 1:
      return "b";
    case 2:
      return "c";
    case 3:
      return "d";
    case 4:
      return "e";
    case 5:
      return "f";
    case 6:
      return "g";
    case 7:
      return "h";
    default:
      return "a";
  }
}

function getPieceNameFromPosition(position: number[]) {
  const x = position[0];
  const y = position[1];
  //White Pieces
  if (y <= 2) {
    switch (x) {
      case 1:
        if (y === 1) {
          return "white-rook";
        } else {
          return "white-pawn";
        }
      case 2:
        if (y === 1) {
          return "white-knight";
        } else {
          return "white-pawn";
        }
      case 3:
        if (y === 1) {
          return "white-bishop";
        } else {
          return "white-pawn";
        }
      case 4:
        if (y === 1) {
          return "white-queen";
        } else {
          return "white-pawn";
        }
      case 5:
        if (y === 1) {
          return "white-king";
        } else {
          return "white-pawn";
        }
      case 6:
        if (y === 1) {
          return "white-bishop";
        } else {
          return "white-pawn";
        }
      case 7:
        if (y === 1) {
          return "white-knight";
        } else {
          return "white-pawn";
        }
      case 8:
        if (y === 1) {
          return "white-rook";
        } else {
          return "white-pawn";
        }
      default:
        return "";
    }
  } else if (y >= 7) {
    // black pieces
    switch (x) {
      case 1:
        if (y === 8) {
          return "black-rook";
        } else {
          return "black-pawn";
        }
      case 2:
        if (y === 8) {
          return "black-knight";
        } else {
          return "black-pawn";
        }
      case 3:
        if (y === 8) {
          return "black-bishop";
        } else {
          return "black-pawn";
        }
      case 4:
        if (y === 8) {
          return "black-queen";
        } else {
          return "black-pawn";
        }
      case 5:
        if (y === 8) {
          return "black-king";
        } else {
          return "black-pawn";
        }
      case 6:
        if (y === 8) {
          return "black-bishop";
        } else {
          return "black-pawn";
        }
      case 7:
        if (y === 8) {
          return "black-knight";
        } else {
          return "black-pawn";
        }
      case 8:
        if (y === 8) {
          return "black-rook";
        } else {
          return "black-pawn";
        }
      default:
        return "";
    }
  }
}
class Cell {
  isEmpty = true;
  piece: Piece | null = null;
  position: Position;
  element: HTMLElement = document.createElement("div");
  constructor(position: Position, piece: Piece | null = null) {
    this.position = position;
    this.element = this.getCellElement(this.position)!;

    this.element.innerHTML = "";

    if (piece) {
      this.setPiece(piece);
    }
  }
  setPiece(piece: Piece, render = true) {
    this.isEmpty = false;
    this.piece = piece;

    if (!render) {
      return;
    }

    const x = positionXFromNumber(this.position[0]);
    const y = this.position[1] + 1;

    this.element.innerHTML = `
    <img
      id="${x}${y}"
      class="chessPiece"
      src="images/${piece.name}.svg"
      alt="${piece.name}"
    />
  `;
  }
  clearPiece(render = true, countAsCaptured = false) {
    if (countAsCaptured && this.piece?.name?.toLowerCase().includes("white")) {
      Chess.deletedWhitePieces++;
    } else if (countAsCaptured && this.piece) {
      Chess.deletedBlackPieces++;
    }
    this.isEmpty = true;
    this.piece = null;

    if (render) {
      this.element.innerHTML = ``;
    }
  }
  getCellElement(elementPosition: Position) {
    const x = positionXFromNumber(elementPosition[0]);
    const y = elementPosition[1];
    const position = `${x}${y + 1}Cell`;
    return document.getElementById(position);
  }
}
class Piece {
  name: string | null;
  color: string | null;
  position: Position;
  availableMoves: Position[] = [];
  element: HTMLElement | null = null;
  constructor(name: string, color: string, position: Position) {
    this.name = name;
    this.color = color;
    this.position = position;
    this.element = this.getPieceElement(position);
  }
  getPieceElement(elementPosition: Position) {
    const x = positionXFromNumber(elementPosition[0]);
    const y = elementPosition[1];
    const position = `${x}${y + 1}`;
    return document.getElementById(position);
  }
  getAvailableMoves() {
    const moves = Chess.getLegalMoves(this.position).map((move) => move.to);
    this.availableMoves = moves;
    return moves;
  }
}

function getSquareName(cellId: string) {
  return cellId.replace(/Cell$/, "");
}

function getPositionFromCellId(cellId: string): Position | null {
  const match = /^([a-h])([1-8])Cell$/.exec(cellId);

  if (!match) {
    return null;
  }

  return [PositionXFromLetter(match[1]), Number(match[2]) - 1];
}

function positionsAreEqual(first: Position, second: Position) {
  return first[0] === second[0] && first[1] === second[1];
}

function isInsideBoard(x: number, y: number) {
  return x >= 0 && x < 8 && y >= 0 && y < 8;
}

function createInitialCastlingRights(): CastlingRights {
  return {
    whiteKing: true,
    whiteRookA: true,
    whiteRookH: true,
    blackKing: true,
    blackRookA: true,
    blackRookH: true,
  };
}

function generatePseudoMoves(from: Position, piece: Piece): ChessMove[] {
  const pieceType = piece.name?.split("-")[1];
  const moves: ChessMove[] = [];
  const addMove = (to: Position, options: Partial<ChessMove> = {}) => {
    if (!isInsideBoard(to[0], to[1])) {
      return;
    }

    const targetPiece = Chess.board[to[0]][to[1]].piece;

    if (
      targetPiece?.color === piece.color ||
      targetPiece?.name?.endsWith("-king")
    ) {
      return;
    }

    moves.push({
      from,
      to,
      capture: Boolean(targetPiece) || options.enPassant,
      ...options,
    });
  };

  if (pieceType === "pawn") {
    const direction = piece.color === "white" ? 1 : -1;
    const startRank = piece.color === "white" ? 1 : 6;
    const oneStep: Position = [from[0], from[1] + direction];

    if (
      isInsideBoard(oneStep[0], oneStep[1]) &&
      Chess.board[oneStep[0]][oneStep[1]].isEmpty
    ) {
      addMove(oneStep, getPromotionOption(piece, oneStep));

      const twoStep: Position = [from[0], from[1] + direction * 2];
      if (
        from[1] === startRank &&
        Chess.board[twoStep[0]][twoStep[1]].isEmpty
      ) {
        addMove(twoStep);
      }
    }

    for (const deltaX of [-1, 1]) {
      const diagonal: Position = [from[0] + deltaX, from[1] + direction];

      if (!isInsideBoard(diagonal[0], diagonal[1])) {
        continue;
      }

      const targetPiece = Chess.board[diagonal[0]][diagonal[1]].piece;
      if (
        targetPiece &&
        targetPiece.color !== piece.color &&
        !targetPiece.name?.endsWith("-king")
      ) {
        addMove(diagonal, getPromotionOption(piece, diagonal));
      } else if (
        !targetPiece &&
        Chess.enPassantTarget &&
        positionsAreEqual(diagonal, Chess.enPassantTarget)
      ) {
        const adjacentPiece = Chess.board[diagonal[0]][from[1]].piece;
        if (
          adjacentPiece?.name ===
          `${piece.color === "white" ? "black" : "white"}-pawn`
        ) {
          addMove(diagonal, { enPassant: true });
        }
      }
    }

    return moves;
  }

  if (pieceType === "knight") {
    for (const [deltaX, deltaY] of [
      [1, 2],
      [2, 1],
      [2, -1],
      [1, -2],
      [-1, -2],
      [-2, -1],
      [-2, 1],
      [-1, 2],
    ]) {
      addMove([from[0] + deltaX, from[1] + deltaY]);
    }

    return moves;
  }

  if (pieceType === "bishop" || pieceType === "rook" || pieceType === "queen") {
    const directions =
      pieceType === "bishop"
        ? [
            [1, 1],
            [1, -1],
            [-1, 1],
            [-1, -1],
          ]
        : pieceType === "rook"
          ? [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ]
          : [
              [1, 1],
              [1, -1],
              [-1, 1],
              [-1, -1],
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ];

    for (const [deltaX, deltaY] of directions) {
      let x = from[0] + deltaX;
      let y = from[1] + deltaY;

      while (isInsideBoard(x, y)) {
        const targetPiece = Chess.board[x][y].piece;

        if (targetPiece?.color === piece.color) {
          break;
        }

        if (targetPiece?.name?.endsWith("-king")) {
          break;
        }

        addMove([x, y]);

        if (targetPiece) {
          break;
        }

        x += deltaX;
        y += deltaY;
      }
    }

    return moves;
  }

  if (pieceType === "king") {
    for (let deltaX = -1; deltaX <= 1; deltaX++) {
      for (let deltaY = -1; deltaY <= 1; deltaY++) {
        if (deltaX !== 0 || deltaY !== 0) {
          addMove([from[0] + deltaX, from[1] + deltaY]);
        }
      }
    }

    moves.push(...getCastlingMoves(from, piece));
  }

  return moves;
}

function getPromotionOption(piece: Piece, to: Position): Partial<ChessMove> {
  if (piece.name?.endsWith("-pawn") && (to[1] === 0 || to[1] === 7)) {
    return { promotion: "queen" };
  }

  return {};
}

function getCastlingMoves(from: Position, piece: Piece): ChessMove[] {
  if (piece.name?.split("-")[1] !== "king" || from[0] !== 4) {
    return [];
  }

  const color = piece.color as PieceColor;
  const y = color === "white" ? 0 : 7;
  const opponentColor = color === "white" ? "black" : "white";
  const rights = Chess.castlingRights;
  const moves: ChessMove[] = [];

  if (from[1] !== y || Chess.isKingInCheck(color)) {
    return moves;
  }

  const kingSide =
    color === "white"
      ? rights.whiteKing && rights.whiteRookH
      : rights.blackKing && rights.blackRookH;
  const queenSide =
    color === "white"
      ? rights.whiteKing && rights.whiteRookA
      : rights.blackKing && rights.blackRookA;

  if (
    kingSide &&
    Chess.board[7][y].piece?.name === `${color}-rook` &&
    Chess.board[5][y].isEmpty &&
    Chess.board[6][y].isEmpty &&
    !isSquareAttacked([5, y], opponentColor) &&
    !isSquareAttacked([6, y], opponentColor)
  ) {
    moves.push({ from, to: [6, y], castling: "O-O" });
  }

  if (
    queenSide &&
    Chess.board[0][y].piece?.name === `${color}-rook` &&
    Chess.board[1][y].isEmpty &&
    Chess.board[2][y].isEmpty &&
    Chess.board[3][y].isEmpty &&
    !isSquareAttacked([3, y], opponentColor) &&
    !isSquareAttacked([2, y], opponentColor)
  ) {
    moves.push({ from, to: [2, y], castling: "O-O-O" });
  }

  return moves;
}

function getEnPassantTarget(move: ChessMove, piece: Piece): Position | null {
  if (
    piece.name?.endsWith("-pawn") &&
    Math.abs(move.to[1] - move.from[1]) === 2
  ) {
    return [move.from[0], (move.from[1] + move.to[1]) / 2];
  }

  return null;
}

function getPromotionLetter(piece: PromotionPiece): "Q" | "R" | "B" | "N" {
  switch (piece) {
    case "queen":
      return "Q";
    case "rook":
      return "R";
    case "bishop":
      return "B";
    case "knight":
      return "N";
  }
}

function disableRookCastlingRight(
  rights: CastlingRights,
  color: PieceColor,
  position: Position,
) {
  if (color === "white" && position[1] === 0) {
    if (position[0] === 0) rights.whiteRookA = false;
    if (position[0] === 7) rights.whiteRookH = false;
  }

  if (color === "black" && position[1] === 7) {
    if (position[0] === 0) rights.blackRookA = false;
    if (position[0] === 7) rights.blackRookH = false;
  }
}

function findKingPosition(color: "white" | "black") {
  for (const row of Chess.board) {
    for (const cell of row) {
      if (cell.piece?.name === `${color}-king`) {
        return cell.position;
      }
    }
  }

  return null;
}

function isSquareAttacked(target: Position, attackerColor: PieceColor) {
  return Chess.board.some((row) =>
    row.some((cell) => {
      const piece = cell.piece;
      return (
        piece?.color === attackerColor &&
        pieceAttacksSquare(piece, cell.position, target)
      );
    }),
  );
}

function pieceAttacksSquare(piece: Piece, from: Position, target: Position) {
  const pieceType = piece.name?.split("-")[1];
  const [fromX, fromY] = from;
  const [targetX, targetY] = target;
  const deltaX = targetX - fromX;
  const deltaY = targetY - fromY;
  const absoluteX = Math.abs(deltaX);
  const absoluteY = Math.abs(deltaY);

  if (pieceType === "pawn") {
    const direction = piece.color === "white" ? 1 : -1;
    return absoluteX === 1 && deltaY === direction;
  }

  if (pieceType === "knight") {
    return (
      (absoluteX === 1 && absoluteY === 2) ||
      (absoluteX === 2 && absoluteY === 1)
    );
  }

  if (pieceType === "king") {
    return absoluteX <= 1 && absoluteY <= 1 && (absoluteX > 0 || absoluteY > 0);
  }

  const isDiagonal = absoluteX === absoluteY && absoluteX > 0;
  const isStraight =
    (fromX === targetX || fromY === targetY) && absoluteX + absoluteY > 0;
  const movesDiagonally = pieceType === "bishop" || pieceType === "queen";
  const movesStraight = pieceType === "rook" || pieceType === "queen";

  if ((movesDiagonally && isDiagonal) || (movesStraight && isStraight)) {
    return isPathClear(from, target);
  }

  return false;
}

function isPathClear(from: Position, target: Position) {
  const stepX = Math.sign(target[0] - from[0]);
  const stepY = Math.sign(target[1] - from[1]);
  let x = from[0] + stepX;
  let y = from[1] + stepY;

  while (x !== target[0] || y !== target[1]) {
    if (!Chess.board[x]?.[y]?.isEmpty) {
      return false;
    }

    x += stepX;
    y += stepY;
  }

  return true;
}

export function formatMoveNotation(move: HistoryMoveInput) {
  if (move.castling) {
    return move.castling;
  }

  const pieceType = move.pieceName.split("-")[1] ?? "pawn";
  const pieceLetter = getPieceLetter(pieceType);
  const capture = move.capture ? "x" : "";
  const pawnFile = pieceType === "pawn" && move.capture ? move.from[0] : "";
  const promotion = move.promotion ? `=${move.promotion}` : "";
  const suffix = move.mate ? "#" : move.check ? "+" : "";
  const enPassant = move.enPassant ? " e.p." : "";

  return `${pawnFile}${pieceLetter}${capture}${move.to}${promotion}${suffix}${enPassant}`;
}

function getPieceLetter(pieceType: string) {
  switch (pieceType) {
    case "knight":
      return "N";
    case "bishop":
      return "B";
    case "rook":
      return "R";
    case "queen":
      return "Q";
    case "king":
      return "K";
    default:
      return "";
  }
}
