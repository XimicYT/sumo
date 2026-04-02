const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Room State Management
const rooms = {};
const colors = ['#f2a900', '#66fcf1', '#ff4655', '#a64d79', '#4CAF50', '#9d4edd'];

io.on('connection', (socket) => {
    console.log(`[+] Connection opened: ${socket.id}`);
    let currentRoom = null;

    // --- ROOM SYSTEM ---
    socket.on('createRoom', () => {
        let code;
        do { code = Math.floor(100 + Math.random() * 900).toString(); } while (rooms[code]);

        rooms[code] = { 
            host: socket.id, 
            state: 'lobby', // 'lobby' or 'racing'
            settings: null,
            players: {},
            leaderboard: []
        };
        joinRoomLogic(socket, code);
    });

    socket.on('joinRoom', (code) => {
        if (rooms[code]) {
            if (rooms[code].state === 'racing') {
                socket.emit('roomError', 'Race already in progress!');
            } else {
                joinRoomLogic(socket, code);
            }
        } else {
            socket.emit('roomError', 'Room not found! Check the 3-digit code.');
        }
    });

    function joinRoomLogic(socket, code) {
        currentRoom = code;
        socket.join(code);
        
        rooms[code].players[socket.id] = {
            x: 0, y: 0, vx: 0, vy: 0,
            color: colors[Math.floor(Math.random() * colors.length)],
            trail: [],
            lastHeartbeat: Date.now(),
            finished: false
        };

        socket.emit('roomJoined', { 
            code, 
            players: rooms[code].players, 
            hostId: rooms[code].host 
        });
        socket.broadcast.to(code).emit('newPlayer', { id: socket.id, player: rooms[code].players[socket.id] });
    }

    // --- HOST RACE CONTROLS ---
    socket.on('startRace', (settings) => {
        if (currentRoom && rooms[currentRoom].host === socket.id) {
            let room = rooms[currentRoom];
            if (Object.keys(room.players).length < 2) {
                socket.emit('roomError', 'Need at least 1 other player to start a race!');
                return;
            }
            
            room.state = 'racing';
            room.settings = settings;
            room.leaderboard = [];
            
            // Reset all players
            Object.values(room.players).forEach(p => {
                p.x = 0; p.y = 0; p.vx = 0; p.vy = 0; p.trail = []; p.finished = false;
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
                io.to(currentRoom).emit('playerFinished', { id: socket.id, place: room.leaderboard.length });
            }
        }
    });

    // --- MOVEMENT & INTERPOLATION DATA ---
    socket.on('playerMovement', (data) => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
            let p = rooms[currentRoom].players[socket.id];
            p.x = data.x; p.y = data.y;
            p.vx = data.vx; p.vy = data.vy; // Pass velocity for client-side prediction
            p.trail = data.trail;
        }
    });

    // --- HEARTBEATS & DISCONNECTS ---
    socket.on('heartbeat_pong', () => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
            rooms[currentRoom].players[socket.id].lastHeartbeat = Date.now();
        }
    });

    socket.on('disconnect', () => { handleDisconnect(socket.id, currentRoom); });
});

function handleDisconnect(socketId, roomCode) {
    if (roomCode && rooms[roomCode]) {
        let room = rooms[roomCode];
        delete room.players[socketId];
        io.to(roomCode).emit('playerDisconnected', socketId);

        if (Object.keys(room.players).length === 0) {
            delete rooms[roomCode];
        } else if (room.host === socketId) {
            // Reassign host
            room.host = Object.keys(room.players)[0];
            io.to(roomCode).emit('newHost', room.host);
        }
    }
}

// 30 FPS Broadcast Tick
setInterval(() => {
    const now = Date.now();
    for (let code in rooms) {
        let players = rooms[code].players;
        io.to(code).emit('stateUpdate', players);

        for (let id in players) {
            if (now - players[id].lastHeartbeat > 10000) {
                const socket = io.sockets.sockets.get(id);
                if (socket) socket.disconnect(true);
                else handleDisconnect(id, code);
            }
        }
    }
}, 1000 / 30);

setInterval(() => { io.emit('heartbeat_ping'); }, 3000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});