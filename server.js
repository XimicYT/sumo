const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Serve static files if you want to host the HTML from the same server later
app.use(express.static(__dirname)); 

const server = http.createServer(app);

// Configure Socket.IO with CORS specifically for your Render URL environment
const io = new Server(server, {
    cors: {
        origin: "*", // Allows any frontend to connect (useful for local testing + production)
        methods: ["GET", "POST"]
    }
});

// State management
const players = {};

io.on('connection', (socket) => {
    console.log(`[+] Player connected: ${socket.id}`);

    // Initialize new player with a random neon color
    const colors = ['#f2a900', '#66fcf1', '#ff4655', '#a64d79', '#4CAF50', '#9d4edd'];
    players[socket.id] = {
        x: 0, y: 0,
        color: colors[Math.floor(Math.random() * colors.length)],
        trail: []
    };

    // Send the current game state to the newly connected client
    socket.emit('currentPlayers', players);

    // Tell all other clients a new player has joined
    socket.broadcast.emit('newPlayer', { id: socket.id, player: players[socket.id] });

    // Handle high-frequency movement updates from clients
    socket.on('playerMovement', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].trail = data.trail;
        }
    });

    // Handle clean disconnections
    socket.on('disconnect', () => {
        console.log(`[-] Player disconnected: ${socket.id}`);
        delete players[socket.id];
        // Notify remaining clients
        io.emit('playerDisconnected', socket.id);
    });
});

// Server Tick Rate: Broadcast the state of all players to everyone at ~30 FPS
// This prevents overwhelming the network while maintaining smooth visual updates
setInterval(() => {
    io.emit('stateUpdate', players);
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});