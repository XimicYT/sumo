const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

const players = {};
let taggerId = null;

// Safe spawn locations in the corners (away from the center walls)
const safeSpawns = [
    { x: 50, y: 50 },   // Top Left
    { x: 700, y: 50 },  // Top Right
    { x: 50, y: 500 },  // Bottom Left
    { x: 700, y: 500 }  // Bottom Right
];

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    if (!taggerId) taggerId = socket.id;

    // Pick a random safe spawn point
    const spawn = safeSpawns[Math.floor(Math.random() * safeSpawns.length)];

    players[socket.id] = {
        x: spawn.x,
        y: spawn.y,
        isTagger: socket.id === taggerId
    };

    socket.emit('init', { players, id: socket.id });
    socket.broadcast.emit('playerJoined', { id: socket.id, player: players[socket.id] });

    socket.on('move', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            socket.broadcast.emit('playerMoved', { id: socket.id, x: data.x, y: data.y });
        }
    });

    socket.on('tag', (taggedId) => {
        if (players[socket.id] && players[socket.id].isTagger && players[taggedId]) {
            players[socket.id].isTagger = false;
            players[taggedId].isTagger = true;
            taggerId = taggedId;
            io.emit('roleUpdate', players);
        }
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        delete players[socket.id];
        
        if (socket.id === taggerId) {
            const remainingIds = Object.keys(players);
            taggerId = remainingIds.length > 0 ? remainingIds[0] : null;
            if (taggerId) {
                players[taggerId].isTagger = true;
                io.emit('roleUpdate', players);
            }
        }
        io.emit('playerLeft', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});