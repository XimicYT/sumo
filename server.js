const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

const server = http.createServer(app);

// Enable Connection State Recovery to survive brief network drops
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] },
    connectionStateRecovery: {
        maxDisconnectionDuration: 30000, 
        skipMiddlewares: true
    }
});

const rooms = {};
const colors = ['#f2a900', '#66fcf1', '#ff4655', '#a64d79', '#4CAF50', '#9d4edd', '#ff00ff', '#00ffff'];

// Hold players in-memory for a short time after disconnect
const disconnectGraceTimers = {};
const GRACE_PERIOD_MS = 15000;

io.on('connection', (socket) => {
    let currentRoom = null;

    // --- RECOVERY LOGIC ---
    // If the socket successfully recovered from a brief drop, restore their room context
    if (socket.recovered) {
        console.log(`[~] Connection recovered seamlessly: ${socket.id}`);
        for (let code in rooms) {
            if (rooms[code].players[socket.id]) {
                currentRoom = code;
                break;
            }
        }
        // Cancel their deletion timer
        if (disconnectGraceTimers[socket.id]) {
            clearTimeout(disconnectGraceTimers[socket.id]);
            delete disconnectGraceTimers[socket.id];
        }
    } else {
        console.log(`[+] New connection opened: ${socket.id}`);
    }

    // --- ROOM LOGIC ---
    socket.on('createRoom', (username) => {
        let code;
        do { code = Math.floor(100 + Math.random() * 900).toString(); } while (rooms[code]);

        rooms[code] = { host: socket.id, state: 'lobby', settings: null, players: {}, leaderboard: [] };
        joinRoomLogic(socket, code, username);
    });

    socket.on('joinRoom', (data) => {
        if (rooms[data.code]) {
            if (rooms[data.code].state === 'racing') socket.emit('roomError', 'Race already in progress! Wait for them to finish.');
            else joinRoomLogic(socket, data.code, data.username);
        } else socket.emit('roomError', 'Room not found! Check the 3-digit code.');
    });

    function joinRoomLogic(socket, code, username) {
        currentRoom = code;
        socket.join(code);
        
        let safeUsername = username ? username.substring(0, 12) : `Pilot-${Math.floor(Math.random()*1000)}`;

        rooms[code].players[socket.id] = {
            username: safeUsername, x: 0, y: 0, vx: 0, vy: 0,
            color: colors[Math.floor(Math.random() * colors.length)],
            trail: [], lastHeartbeat: Date.now(), finished: false, place: 0
        };

        socket.emit('roomJoined', { code, players: rooms[code].players, hostId: rooms[code].host });
        socket.broadcast.to(code).emit('newPlayer', { id: socket.id, player: rooms[code].players[socket.id] });
    }

    // --- GAME ACTIONS ---
    socket.on('startRace', (settings) => {
        if (currentRoom && rooms[currentRoom].host === socket.id) {
            let room = rooms[currentRoom];
            if (Object.keys(room.players).length < 2) {
                socket.emit('roomError', 'Need at least 1 other player to start a race!');
                return;
            }
            
            room.state = 'racing'; room.settings = settings; room.leaderboard = [];
            
            Object.values(room.players).forEach(p => {
                p.x = 0; p.y = 0; p.vx = 0; p.vy = 0; p.trail = []; p.finished = false; p.place = 0;
            });

            io.to(currentRoom).emit('raceInitializing', settings);
        }
    });

    socket.on('crossFinishLine', () => {
        if (currentRoom && rooms[currentRoom]) {
            let room = rooms[currentRoom];
            if (!room.players[socket.id].finished) {
                room.players[socket.id].finished = true;
                room.leaderboard.push(socket.id);
                room.players[socket.id].place = room.leaderboard.length;
                
                io.to(currentRoom).emit('playerFinished', { 
                    id: socket.id, place: room.leaderboard.length, username: room.players[socket.id].username 
                });

                if (room.leaderboard.length >= Object.keys(room.players).length) {
                    io.to(currentRoom).emit('allFinished');
                }
            }
        }
    });

    socket.on('returnToLobby', () => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].host === socket.id) {
            rooms[currentRoom].state = 'lobby'; rooms[currentRoom].leaderboard = [];
            Object.values(rooms[currentRoom].players).forEach(p => {
                p.x = 0; p.y = 0; p.vx = 0; p.vy = 0; p.trail = []; p.finished = false; p.place = 0;
            });
            io.to(currentRoom).emit('returnedToLobby');
        }
    });

    socket.on('playerMovement', (data) => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
            let p = rooms[currentRoom].players[socket.id];
            p.x = data.x; p.y = data.y; p.vx = data.vx; p.vy = data.vy; p.trail = data.trail;
        }
    });

    socket.on('heartbeat_pong', () => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
            rooms[currentRoom].players[socket.id].lastHeartbeat = Date.now();
            if (disconnectGraceTimers[socket.id]) {
                clearTimeout(disconnectGraceTimers[socket.id]);
                delete disconnectGraceTimers[socket.id];
            }
        }
    });

    // --- GRACEFUL DISCONNECT ---
    socket.on('disconnect', () => {
        console.log(`[-] Connection dropped: ${socket.id}. Starting grace period...`);
        // Start grace period instead of instant kick
        disconnectGraceTimers[socket.id] = setTimeout(() => {
            console.log(`[!] Grace period expired for: ${socket.id}. Removing from server.`);
            handleDisconnect(socket.id, currentRoom);
            delete disconnectGraceTimers[socket.id];
        }, GRACE_PERIOD_MS);
    });
});

function handleDisconnect(socketId, roomCode) {
    if (roomCode && rooms[roomCode]) {
        let room = rooms[roomCode];
        delete room.players[socketId];
        io.to(roomCode).emit('playerDisconnected', socketId);

        if (Object.keys(room.players).length === 0) delete rooms[roomCode];
        else if (room.host === socketId) {
            room.host = Object.keys(room.players)[0];
            io.to(roomCode).emit('newHost', room.host);
        }
    }
}

// 30 FPS Server Tick
setInterval(() => {
    const now = Date.now();
    for (let code in rooms) {
        let players = rooms[code].players;
        io.to(code).emit('stateUpdate', { timestamp: now, players: players });

        for (let id in players) {
            // Heartbeat failure check (20s) in case TCP gets stuck but doesn't throw a disconnect event
            if (now - players[id].lastHeartbeat > 20000) {
                if (disconnectGraceTimers[id]) {
                    clearTimeout(disconnectGraceTimers[id]);
                    delete disconnectGraceTimers[id];
                }
                handleDisconnect(id, code);
                const socket = io.sockets.sockets.get(id);
                if (socket) socket.disconnect(true);
            }
        }
    }
}, 1000 / 30);

setInterval(() => io.emit('heartbeat_ping'), 3000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));