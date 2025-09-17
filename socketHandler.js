// socketHandler.js
const socketIo = require('socket.io');

// Game state management
const waitingPlayers = [];
const activeGames = new Map();

// Helpers for Othello game logic (server authoritative)
const BOARD_SIZE = 8;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

const createInitialBoard = () => {
  const board = Array(BOARD_SIZE).fill(null).map(() => Array(BOARD_SIZE).fill(EMPTY));
  board[3][3] = WHITE;
  board[3][4] = BLACK;
  board[4][3] = BLACK;
  board[4][4] = WHITE;
  return board;
};

const generateRoomId = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};

const inBounds = (r, c) => r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;

const opponentOf = (player) => (player === BLACK ? WHITE : BLACK);

// Check whether placing at (row,col) is valid for `player`
const isValidMove = (board, row, col, player) => {
  if (!inBounds(row, col) || board[row][col] !== EMPTY) return false;
  const opp = opponentOf(player);
  const directions = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1], /*0,0*/ [0, 1],
    [1, -1], [1, 0], [1, 1],
  ];
  for (const [dr, dc] of directions) {
    let r = row + dr;
    let c = col + dc;
    let foundOpp = false;
    while (inBounds(r, c) && board[r][c] === opp) {
      foundOpp = true;
      r += dr; c += dc;
    }
    if (foundOpp && inBounds(r, c) && board[r][c] === player) {
      return true;
    }
  }
  return false;
};

// Return array of valid moves [{row, col}, ...] for `player`
const getValidMoves = (board, player) => {
  const moves = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (isValidMove(board, r, c, player)) moves.push({ row: r, col: c });
    }
  }
  return moves;
};

// Apply move and return a new board (deep clone). Assumes move is valid.
const applyMove = (board, row, col, player) => {
  const newBoard = board.map(rowArr => rowArr.slice());
  newBoard[row][col] = player;
  const opp = opponentOf(player);
  const directions = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1], /*0,0*/ [0, 1],
    [1, -1], [1, 0], [1, 1],
  ];
  for (const [dr, dc] of directions) {
    const toFlip = [];
    let r = row + dr;
    let c = col + dc;
    while (inBounds(r, c) && newBoard[r][c] === opp) {
      toFlip.push([r, c]);
      r += dr; c += dc;
    }
    if (toFlip.length > 0 && inBounds(r, c) && newBoard[r][c] === player) {
      // flip
      for (const [fr, fc] of toFlip) newBoard[fr][fc] = player;
    }
  }
  return newBoard;
};

const countPieces = (board) => {
  let black = 0, white = 0;
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c] === BLACK) black++;
      if (board[r][c] === WHITE) white++;
    }
  }
  return { black, white };
};

const checkGameOver = (board) => {
  const blackMoves = getValidMoves(board, BLACK);
  const whiteMoves = getValidMoves(board, WHITE);
  const counts = countPieces(board);
  const full = Object.values(board).flat?.length ? board.flat().every(cell => cell !== EMPTY) : board.flat().every(cell => cell !== EMPTY);
  const noMoves = blackMoves.length === 0 && whiteMoves.length === 0;
  return {
    isOver: full || noMoves,
    blackMoves,
    whiteMoves,
    counts
  };
};

const initializeSocket = (server) => {
  const io = socketIo(server, {
    cors: {
      origin: process.env.NODE_ENV === 'production' 
        ? [process.env.FRONTEND_URL, 'https://your-deployed-frontend.vercel.app']
        : "http://localhost:5173",
      methods: ["GET", "POST"],
      credentials: true
    },
    transports: ['websocket', 'polling']
  });

  io.on('connection', (socket) => {
    console.log('🔌 A user connected:', socket.id);

    // Helper: remove waiting player by id
    const removeFromWaiting = (id) => {
      const idx = waitingPlayers.findIndex(p => p.id === id);
      if (idx !== -1) waitingPlayers.splice(idx, 1);
    };

    // Handle finding a game
    socket.on('find_game', (data = {}) => {
      // data can be { playerName } or { user: { name } } depending on frontend
      const name = data.user?.name || data.playerName || data.name || 'Anonymous';
      console.log('🎮 User looking for game:', socket.id, name);

      // Prevent duplicate entries for same socket
      if (waitingPlayers.some(p => p.id === socket.id)) {
        console.log('⚠️ Already waiting:', socket.id);
        socket.emit('game_error', 'Already searching for a game');
        return;
      }

      const player = { id: socket.id, name };

      // Try to find a valid opponent from the queue (skip disconnected)
      let opponent = null;
      while (waitingPlayers.length > 0 && !opponent) {
        const candidate = waitingPlayers.shift(); // FIFO
        const candidateSocket = io.sockets.sockets.get(candidate.id);
        const alreadyInGame = Array.from(activeGames.values()).some(g => g.players.some(p => p.id === candidate.id));
        if (candidateSocket && candidateSocket.connected && !alreadyInGame) {
          opponent = candidate;
        } else {
          // skip candidate (disconnected or already in game)
          console.log('⏭️ Skipping stale waiting player:', candidate.id);
        }
      }

      if (opponent) {
        // Create a room for both players
        const roomId = generateRoomId();
        const players = [
          { id: opponent.id, name: opponent.name, number: BLACK }, // Black (1) starts
          { id: player.id, name: player.name, number: WHITE }
        ];
        const gameRoom = {
          id: roomId,
          players,
          board: createInitialBoard(),
          currentPlayer: BLACK, // black starts
          gameStarted: true,
          createdAt: new Date()
        };

        activeGames.set(roomId, gameRoom);

        // Join sockets to room
        const opponentSocket = io.sockets.sockets.get(opponent.id);
        if (opponentSocket) opponentSocket.join(roomId);
        socket.join(roomId);

        // Notify players of room join
        if (opponentSocket) {
          opponentSocket.emit('room_joined', {
            roomId,
            playerNumber: BLACK,
            color: 'black'
          });
        }

        socket.emit('room_joined', {
          roomId,
          playerNumber: WHITE,
          color: 'white'
        });

        // Send initial board & start
        io.to(roomId).emit('game_start', {
          roomId,
          players: gameRoom.players,
          board: gameRoom.board,
          currentPlayer: gameRoom.currentPlayer
        });

        console.log('🎯 Game started in room:', roomId, players.map(p => p.id));
      } else {
        // Add to waiting queue
        waitingPlayers.push(player);
        socket.emit('waiting_for_opponent');
        console.log('⏳ Player added to waiting queue:', socket.id);
      }
    });

    // Handle cancelling search
    socket.on('cancel_search', () => {
      removeFromWaiting(socket.id);
      console.log('❌ Player canceled search:', socket.id);
      socket.emit('search_cancelled');
    });

    socket.on('leave_game',(data = {})=>{
      const {roomId, playerNumber} =data
      console.log('🚪 Player intentionally leaving game:', socket.id, roomId);
      const game = activeGames.get(roomId);
      if (!game) {
        console.log('⚠️ Game not found for leave_game:', roomId);
        return;
      }
      const leavingPlayer = game.players.find(p => p.id === socket.id);
      const opponent = game.players.find(p => p.id !== socket.id)
       if (opponent){
        const opponentSocket = io.sockets.sockets.get(opponent.id);
        if(opponentSocket){
          opponentSocket.emit('opponent_left', {
            message: `${leavingPlayer?.name || "Opponent"} has left the game`,
            winner: opponent.number ===BLACK ?'black': 'white',
            winnerName:opponent.name,
            reason:'opponent_left'
          })
          console.log('🏆 Notified winner:', opponent.id, opponent.name);
        }
       }
       activeGames.delete(roomId);
      socket.leave(roomId);
      console.log('🧹 Cleaned up game room:', roomId);
    })
    // Handle making a move (server authoritative)
    // client should send: { roomId, row, col }
    socket.on('make_move', (data = {}) => {
      const { roomId, row, col } = data;
      if (!roomId) {
        socket.emit('game_error', 'Missing roomId');
        return;
      }
      const game = activeGames.get(roomId);
      if (!game) {
        socket.emit('game_error', 'Game not found');
        console.log('❌ Game not found for room:', roomId);
        return;
      }

      const playerIndex = game.players.findIndex(p => p.id === socket.id);
      if (playerIndex === -1) {
        socket.emit('game_error', 'You are not in this game');
        console.log('❌ Player not found in game:', socket.id);
        return;
      }

      const playerNumber = game.players[playerIndex].number;
      if (playerNumber !== game.currentPlayer) {
        socket.emit('game_error', 'Not your turn');
        console.log("❌ Not player's turn:", playerNumber, 'vs', game.currentPlayer);
        return;
      }

      if (!isValidMove(game.board, row, col, playerNumber)) {
        socket.emit('game_error', 'Invalid move');
        console.log('❌ Invalid move attempt by', socket.id, `(${row},${col})`);
        return;
      }

      // Apply the move server-side
      const newBoard = applyMove(game.board, row, col, playerNumber);
      game.board = newBoard;

      // Determine next player
      const nextPlayerCandidate = opponentOf(playerNumber);
      const nextValidMoves = getValidMoves(game.board, nextPlayerCandidate);

      if (nextValidMoves.length > 0) {
        game.currentPlayer = nextPlayerCandidate;
      } else {
        // Opponent has no moves: check if current player still has moves
        const currentValidMoves = getValidMoves(game.board, playerNumber);
        if (currentValidMoves.length > 0) {
          // keep same player
          game.currentPlayer = playerNumber;
        } else {
          // Game over (no moves for both)
          const { counts } = checkGameOver(game.board);
          let winner = null;
          if (counts.black > counts.white) winner = 'black';
          else if (counts.white > counts.black) winner = 'white';
          else winner = 'draw';

          io.to(roomId).emit('game_ended', {
            winner,
            score: counts,
            players: game.players
          });

          console.log(`🏁 Game ended in room ${roomId}, winner: ${winner}`);
          activeGames.delete(roomId);
          return;
        }
      }

      // Broadcast move to room
      io.to(roomId).emit('move_made', {
        row,
        col,
        board: game.board,
        currentPlayer: game.currentPlayer,
        playerId: socket.id
      });

      // After broadcasting, check if board is full or no moves both -> end game
      const check = checkGameOver(game.board);
      if (check.isOver) {
        const { counts } = check;
        let winner = null;
        if (counts.black > counts.white) winner = 'black';
        else if (counts.white > counts.black) winner = 'white';
        else winner = 'draw';

        io.to(roomId).emit('game_ended', {
          winner,
          score: counts,
          players: game.players
        });
        console.log(`🏁 Game ended in room ${roomId}, winner: ${winner}`);
        activeGames.delete(roomId);
      } else {
        // optionally emit valid moves for the next player (helpful for client)
        const validMoves = getValidMoves(game.board, game.currentPlayer);
        io.to(roomId).emit('valid_moves', {
          currentPlayer: game.currentPlayer,
          moves: validMoves
        });
      }
    });

    // Handle game_over sent by client (server will still authoritatively end)
    socket.on('game_over', (data = {}) => {
      const { roomId } = data;
      const game = activeGames.get(roomId);
      if (!game) {
        socket.emit('game_error', 'Game not found');
        return;
      }
      const counts = countPieces(game.board);
      let winner = null;
      if (counts.black > counts.white) winner = 'black';
      else if (counts.white > counts.black) winner = 'white';
      else winner = 'draw';

      io.to(roomId).emit('game_ended', {
        winner,
        score: counts,
        players: game.players
      });

      activeGames.delete(roomId);
      console.log(`🏁 Game ended in room ${roomId} by game_over event, winner: ${winner}`);
    });

    // Handle leaving room (client intentionally leaves)
    socket.on('leave_room', (roomId) => {
      socket.leave(roomId);
      const game = activeGames.get(roomId);
      if (game) {
        socket.to(roomId).emit('opponent_disconnected');
        activeGames.delete(roomId);
        console.log(`🚪 Player left room ${roomId}, game ended`);
      }
    });

    // Clean up on disconnect
    socket.on('disconnect', () => {
      console.log('🔌 User disconnected:', socket.id);
      removeFromWaiting(socket.id);

      // If player was in an active game, notify opponent and delete game
      activeGames.forEach((game, roomId) => {
        const idx = game.players.findIndex(p => p.id === socket.id);
        if (idx !== -1) {
          socket.to(roomId).emit('opponent_disconnected');
          activeGames.delete(roomId);
          console.log(`🚪 Game ${roomId} ended due to disconnect of ${socket.id}`);
        }
      });
    });

    // Legacy message handler (keeps compatibility)
    socket.on('message', (data) => {
      console.log('Message received:', data);
      io.emit('message', {
        id: socket.id,
        message: data.message,
        timestamp: new Date().toISOString()
      });
    });
  });

  return io;
};

// Optional: Export game state getters for debugging/monitoring
const getGameStats = () => {
  return {
    waitingPlayers: waitingPlayers.length,
    activeGames: activeGames.size,
    totalConnections: waitingPlayers.length + (activeGames.size * 2)
  };
};

module.exports = {
  initializeSocket,
  getGameStats
};
