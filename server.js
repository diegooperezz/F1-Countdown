// Pulsador F1 - servidor
// Un pulsador online tipo "el primero que pulsa ESPACIO gana", con cuenta atras
// al estilo semaforo de Formula 1 (encendido secuencial de luces + apagon en
// un instante aleatorio e impredecible).

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Estado en memoria
// ---------------------------------------------------------------------------

/** @type {Map<string, Room>} */
const rooms = new Map();

const LIGHT_COUNT = 5;
const LIGHT_INTERVAL_MS = 700; // como el semaforo real de F1 (~1 luz/seg, aqui un poco mas vivo)
const ARM_BUFFER_MS = 500; // margen antes de encender la primera luz
const GO_DELAY_MIN_MS = 300;
const GO_DELAY_MAX_MS = 3200;
const ROUND_TIMEOUT_MS = 6000; // tiempo maximo tras el "go" para que todos pulsen
const ROOM_IDLE_MS = 1000 * 60 * 60 * 4; // 4h sin actividad -> se borra la sala
const MAX_PLAYERS = 15; // maximo de jugadores por sala

function randomGoDelay() {
  return GO_DELAY_MIN_MS + Math.random() * (GO_DELAY_MAX_MS - GO_DELAY_MIN_MS);
}

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin caracteres ambiguos
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(code) {
  const room = {
    code,
    players: new Map(), // clientId -> player
    adminId: null, // clientId del jugador con permiso para iniciar rondas
    state: 'lobby', // lobby | arming | live | results
    round: null, // datos de la ronda en curso
    roundNumber: 0,
    lastActivity: Date.now(),
    timers: [],
  };
  rooms.set(code, room);
  return room;
}

function getPublicPlayers(room) {
  return [...room.players.values()]
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name))
    .map((p) => ({
      id: p.clientId,
      name: p.name,
      connected: p.connected,
      wins: p.wins,
      points: p.points,
      bestMs: p.bestMs,
      roundsPlayed: p.roundsPlayed,
      isAdmin: p.clientId === room.adminId,
    }));
}

function broadcastPlayers(room) {
  io.to(room.code).emit('players', { players: getPublicPlayers(room), state: room.state, adminId: room.adminId });
}

/** Si el admin actual no esta conectado, cede el rol al siguiente jugador conectado. */
function ensureAdmin(room) {
  const current = room.adminId ? room.players.get(room.adminId) : null;
  if (current && current.connected) return;
  const next = [...room.players.values()].find((p) => p.connected);
  room.adminId = next ? next.clientId : null;
}

function clearRoomTimers(room) {
  room.timers.forEach((t) => clearTimeout(t));
  room.timers = [];
}

function touch(room) {
  room.lastActivity = Date.now();
}

// ---------------------------------------------------------------------------
// Logica de una ronda
// ---------------------------------------------------------------------------

function startRound(room) {
  if (room.state === 'arming' || room.state === 'live') return;
  const connectedPlayers = [...room.players.values()].filter((p) => p.connected);
  if (connectedPlayers.length === 0) return;

  clearRoomTimers(room);
  room.roundNumber += 1;
  room.state = 'arming';
  const roundId = `${room.code}-${room.roundNumber}-${Date.now()}`;
  room.round = {
    id: roundId,
    goEmitted: false,
    goAt: null,
    results: new Map(), // clientId -> { elapsedMs, falseStart, dnf }
    expectedPlayers: new Set(connectedPlayers.map((p) => p.clientId)),
  };
  touch(room);

  io.to(room.code).emit('roundArm', { roundId, lightCount: LIGHT_COUNT, lightIntervalMs: LIGHT_INTERVAL_MS });

  for (let i = 1; i <= LIGHT_COUNT; i += 1) {
    const t = setTimeout(() => {
      io.to(room.code).emit('light', { roundId, index: i });
    }, ARM_BUFFER_MS + (i - 1) * LIGHT_INTERVAL_MS);
    room.timers.push(t);
  }

  const allLitAt = ARM_BUFFER_MS + LIGHT_COUNT * LIGHT_INTERVAL_MS;
  const goDelay = randomGoDelay();

  const goTimer = setTimeout(() => {
    if (!room.round || room.round.id !== roundId) return;
    room.round.goEmitted = true;
    room.round.goAt = Date.now();
    room.state = 'live';
    io.to(room.code).emit('go', { roundId, goAt: room.round.goAt });
    touch(room);

    const timeoutTimer = setTimeout(() => {
      finishRound(room, roundId);
    }, ROUND_TIMEOUT_MS);
    room.timers.push(timeoutTimer);
  }, allLitAt + goDelay);
  room.timers.push(goTimer);
}

function registerPress(room, player, clientElapsedMs) {
  const round = room.round;
  if (!round) return;
  if (round.results.has(player.clientId)) return; // ya registrado en esta ronda

  if (!round.goEmitted) {
    // Pulso antes del apagon de luces: salida nula
    round.results.set(player.clientId, { falseStart: true });
  } else {
    const elapsed = Math.max(0, Math.round(Number(clientElapsedMs) || 0));
    round.results.set(player.clientId, { elapsedMs: elapsed, falseStart: false });
  }

  io.to(room.code).emit('playerActed', {
    roundId: round.id,
    id: player.clientId,
    name: player.name,
    falseStart: round.results.get(player.clientId).falseStart,
  });

  const allActed = [...round.expectedPlayers].every((id) => round.results.has(id));
  if (allActed) {
    finishRound(room, round.id);
  }
}

function finishRound(room, roundId) {
  const round = room.round;
  if (!round || round.id !== roundId || room.state === 'results') return;
  clearRoomTimers(room);

  const entries = [];
  round.expectedPlayers.forEach((clientId) => {
    const player = room.players.get(clientId);
    if (!player) return;
    const res = round.results.get(clientId);
    if (!res) {
      entries.push({ clientId, name: player.name, status: 'dnf' });
    } else if (res.falseStart) {
      entries.push({ clientId, name: player.name, status: 'falseStart' });
    } else {
      entries.push({ clientId, name: player.name, status: 'ok', elapsedMs: res.elapsedMs });
    }
  });

  const ranking = entries
    .filter((e) => e.status === 'ok')
    .sort((a, b) => a.elapsedMs - b.elapsedMs);
  const falseStarts = entries.filter((e) => e.status === 'falseStart');
  const dnfs = entries.filter((e) => e.status === 'dnf');

  const pointsTable = [5, 3, 2, 1];
  ranking.forEach((e, idx) => {
    const player = room.players.get(e.clientId);
    if (!player) return;
    player.roundsPlayed += 1;
    if (idx === 0) player.wins += 1;
    player.points += pointsTable[idx] || 0;
    if (player.bestMs === null || e.elapsedMs < player.bestMs) player.bestMs = e.elapsedMs;
  });
  [...falseStarts, ...dnfs].forEach((e) => {
    const player = room.players.get(e.clientId);
    if (player) player.roundsPlayed += 1;
  });

  room.state = 'results';
  room.round = null;
  touch(room);

  io.to(room.code).emit('roundResult', {
    roundId,
    ranking: ranking.map((e, idx) => ({ position: idx + 1, id: e.clientId, name: e.name, elapsedMs: e.elapsedMs })),
    falseStarts: falseStarts.map((e) => ({ id: e.clientId, name: e.name })),
    dnfs: dnfs.map((e) => ({ id: e.clientId, name: e.name })),
    champion: ranking[0] ? { id: ranking[0].clientId, name: ranking[0].name, elapsedMs: ranking[0].elapsedMs } : null,
  });
  broadcastPlayers(room);
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('joinRoom', ({ code, name, clientId }, cb) => {
    try {
      let roomCode = (code || '').toUpperCase().trim();
      let room;
      if (roomCode) {
        room = rooms.get(roomCode);
        if (!room) room = createRoom(roomCode);
      } else {
        room = createRoom(makeRoomCode());
      }

      const safeName = (name || 'Jugador').toString().trim().slice(0, 24) || 'Jugador';
      const id = (clientId || '').toString().slice(0, 64) || `${socket.id}-${Date.now()}`;

      const isNewPlayer = !room.players.has(id);
      if (isNewPlayer && room.players.size >= MAX_PLAYERS) {
        cb && cb({ ok: false, error: `La sala está llena (máximo ${MAX_PLAYERS} jugadores).` });
        return;
      }

      let player = room.players.get(id);
      if (!player) {
        player = {
          clientId: id,
          name: safeName,
          connected: true,
          socketId: socket.id,
          wins: 0,
          points: 0,
          bestMs: null,
          roundsPlayed: 0,
        };
        room.players.set(id, player);
      } else {
        player.name = safeName;
        player.connected = true;
        player.socketId = socket.id;
      }

      if (!room.adminId) room.adminId = player.clientId; // el primero en entrar es el admin
      ensureAdmin(room);

      socket.data.roomCode = room.code;
      socket.data.clientId = id;
      socket.join(room.code);
      touch(room);

      cb && cb({
        ok: true,
        code: room.code,
        you: { id: player.clientId, name: player.name },
        state: room.state,
        players: getPublicPlayers(room),
        adminId: room.adminId,
        maxPlayers: MAX_PLAYERS,
      });
      broadcastPlayers(room);
      io.to(room.code).emit('system', { message: `${safeName} se ha unido a la sala.` });
    } catch (err) {
      cb && cb({ ok: false, error: 'No se pudo unir a la sala.' });
    }
  });

  socket.on('startRound', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.clientId !== room.adminId) {
      socket.emit('system', { message: 'Solo el admin de la sala puede iniciar la ronda.' });
      return;
    }
    touch(room);
    startRound(room);
  });

  socket.on('press', ({ roundId, elapsedMs }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.round || room.round.id !== roundId) return;
    const player = room.players.get(socket.data.clientId);
    if (!player) return;
    registerPress(room, player, elapsedMs);
  });

  socket.on('resetScoreboard', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    room.players.forEach((p) => {
      p.wins = 0;
      p.points = 0;
      p.bestMs = null;
      p.roundsPlayed = 0;
    });
    room.roundNumber = 0;
    broadcastPlayers(room);
    io.to(room.code).emit('system', { message: 'Marcador reiniciado.' });
  });

  socket.on('renamePlayer', ({ name }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.get(socket.data.clientId);
    if (!player) return;
    const safeName = (name || '').toString().trim().slice(0, 24);
    if (safeName) {
      player.name = safeName;
      broadcastPlayers(room);
    }
  });

  socket.on('pingCheck', (t) => {
    socket.emit('pongCheck', t);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.get(socket.data.clientId);
    if (player && player.socketId === socket.id) {
      player.connected = false;
      const wasAdmin = room.adminId === player.clientId;
      ensureAdmin(room);
      if (wasAdmin && room.adminId && room.adminId !== player.clientId) {
        const newAdmin = room.players.get(room.adminId);
        if (newAdmin) io.to(room.code).emit('system', { message: `${newAdmin.name} es ahora el admin de la sala.` });
      }
      broadcastPlayers(room);
    }
  });
});

// ---------------------------------------------------------------------------
// Limpieza periodica de salas inactivas
// ---------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    const anyoneConnected = [...room.players.values()].some((p) => p.connected);
    if (!anyoneConnected && now - room.lastActivity > ROOM_IDLE_MS) {
      clearRoomTimers(room);
      rooms.delete(code);
    }
  });
}, 1000 * 60 * 10);

server.listen(PORT, () => {
  console.log(`Pulsador F1 escuchando en el puerto ${PORT}`);
});
