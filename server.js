const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const players = {};
let taggerId = null;

const safeSpawns = [
    { x: 50, y: 50 }, { x: 900, y: 50 }, 
    { x: 50, y: 600 }, { x: 900, y: 600 }
];

io.on('connection', (socket) => {
    if (!taggerId) taggerId = socket.id;
    const spawn = safeSpawns[Math.floor(Math.random() * safeSpawns.length)];

    players[socket.id] = {
        x: spawn.x, 
        y: spawn.y,
        isTagger: socket.id === taggerId,
        lastPing: Date.now(),
        serverFrozenUntil: 0 // Server-side tracker for cheating prevention
    };

    socket.emit('init', { players, id: socket.id });
    socket.broadcast.emit('playerJoined', { id: socket.id, player: players[socket.id] });

    // Handle incoming movement (with freeze verification)
    socket.on('move', (data) => {
        if (players[socket.id]) {
            // Do not allow movement if the server knows they are frozen
            if (Date.now() < players[socket.id].serverFrozenUntil) return;
            
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            socket.broadcast.emit('playerMoved', { id: socket.id, x: data.x, y: data.y });
        }
    });

    // HEARTBEAT PING
    socket.on('heartbeat', () => {
        if (players[socket.id]) {
            players[socket.id].lastPing = Date.now();
        }
    });

    // Handle tagging logic
    socket.on('tag', (taggedId) => {
        let tagger = players[socket.id];
        let target = players[taggedId];
        let now = Date.now();

        if (tagger && tagger.isTagger && target && !target.isTagger) {
            // Make sure the tagger isn't currently frozen
            if (now < tagger.serverFrozenUntil) return;

            tagger.isTagger = false;
            target.isTagger = true;
            taggerId = taggedId;
            
            // Lock the new tagger on the server for 2.5 seconds
            target.serverFrozenUntil = now + 2500;

            // Broadcast to all clients to start their local visual timers
            io.emit('tagged', { 
                newTagger: taggedId, 
                newRunner: socket.id 
            });
        }
    });

    socket.on('disconnect', () => {
        handleDisconnect(socket.id);
    });
});

function handleDisconnect(id) {
    if (!players[id]) return;
    delete players[id];
    
    if (id === taggerId) {
        const remainingIds = Object.keys(players);
        taggerId = remainingIds.length > 0 ? remainingIds[0] : null;
        if (taggerId) {
            players[taggerId].isTagger = true;
            io.emit('roleUpdate', players);
        }
    }
    io.emit('playerLeft', id);
}

// THE HEARTBEAT SWEEPER: Runs every 3 seconds to kick disconnected ghosts
setInterval(() => {
    let now = Date.now();
    for (let id in players) {
        if (now - players[id].lastPing > 8000) { // 8 seconds without a ping
            handleDisconnect(id);
        }
    }
}, 3000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on port ${PORT}`));