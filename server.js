const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Enable CORS so your Netlify frontend can talk to the Render backend
const io = new Server(server, {
    cors: {
        origin: "*", // In production, restrict this to your Netlify URL
        methods: ["GET", "POST"]
    }
});

// Store player states
const players = {};
let taggerId = null;

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Assign roles. First player is tagger.
    if (!taggerId) taggerId = socket.id;

    // Initialize player at a random starting spot
    players[socket.id] = {
        x: Math.random() * 400 + 100,
        y: Math.random() * 400 + 100,
        isTagger: socket.id === taggerId
    };

    // Send the current game state to the new player
    socket.emit('init', { players, id: socket.id });
    // Tell everyone else a new player joined
    socket.broadcast.emit('playerJoined', { id: socket.id, player: players[socket.id] });

    // Handle incoming movement
    socket.on('move', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            // Broadcast the update to all OTHER players
            socket.broadcast.emit('playerMoved', { id: socket.id, x: data.x, y: data.y });
        }
    });

    // Handle tagging logic
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
        
        // Reassign tagger if the tagger left
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