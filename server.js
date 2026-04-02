const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// Room State Management
// Format: { '123': { players: { 'socketId': { ...data } } } }
const rooms = {};

const colors = ['#f2a900', '#66fcf1', '#ff4655', '#a64d79', '#4CAF50', '#9d4edd'];

io.on('connection', (socket) => {
    console.log(`[+] Connection opened: ${socket.id}`);
    let currentRoom = null;

    // --- ROOM SYSTEM ---
    socket.on('createRoom', () => {
        // Generate a random 3-digit code
        let code;
        do {
            code = Math.floor(100 + Math.random() * 900).toString();
        } while (rooms[code]);

        rooms[code] = { players: {} };
        joinRoomLogic(socket, code);
    });

    socket.on('joinRoom', (code) => {
        if (rooms[code]) {
            joinRoomLogic(socket, code);
        } else {
            socket.emit('roomError', 'Room not found! Check the 3-digit code.');
        }
    });

    function joinRoomLogic(socket, code) {
        currentRoom = code;
        socket.join(code);
        
        rooms[code].players[socket.id] = {
            x: 0, y: 0,
            color: colors[Math.floor(Math.random() * colors.length)],
            trail: [],
            lastHeartbeat: Date.now()
        };

        socket.emit('roomJoined', { code, players: rooms[code].players });
        socket.broadcast.to(code).emit('newPlayer', { id: socket.id, player: rooms[code].players[socket.id] });
        console.log(`[R] Player ${socket.id} joined room ${code}`);
    }

    // --- HEARTBEAT SYSTEM ---
    socket.on('heartbeat_pong', () => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
            rooms[currentRoom].players[socket.id].lastHeartbeat = Date.now();
        }
    });

    // --- MOVEMENT ---
    socket.on('playerMovement', (data) => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].players[socket.id]) {
            let p = rooms[currentRoom].players[socket.id];
            p.x = data.x;
            p.y = data.y;
            p.trail = data.trail;
        }
    });

    // --- DISCONNECTS ---
    socket.on('disconnect', () => {
        console.log(`[-] Connection closed: ${socket.id}`);
        handleDisconnect(socket.id, currentRoom);
    });
});

function handleDisconnect(socketId, roomCode) {
    if (roomCode && rooms[roomCode]) {
        delete rooms[roomCode].players[socketId];
        io.to(roomCode).emit('playerDisconnected', socketId);

        // Clean up empty rooms to prevent memory leaks
        if (Object.keys(rooms[roomCode].players).length === 0) {
            console.log(`[R] Room ${roomCode} empty. Deleting.`);
            delete rooms[roomCode];
        }
    }
}

// SERVER TICK LOOP (30 FPS)
setInterval(() => {
    const now = Date.now();
    for (let code in rooms) {
        let players = rooms[code].players;
        
        // Broadcast state
        io.to(code).emit('stateUpdate', players);

        // Check Heartbeats (Kick if no response in 10 seconds)
        for (let id in players) {
            if (now - players[id].lastHeartbeat > 10000) {
                console.log(`[!] Disconnecting ${id} due to heartbeat timeout.`);
                const socket = io.sockets.sockets.get(id);
                if (socket) socket.disconnect(true);
                else handleDisconnect(id, code); // Force cleanup if socket object is gone
            }
        }
    }
}, 1000 / 30);

// HEARTBEAT PING LOOP (Every 3 seconds)
setInterval(() => {
    io.emit('heartbeat_ping');
}, 3000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});