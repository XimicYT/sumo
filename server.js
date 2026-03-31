import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const players = {};
let scores = { red: 0, blue: 0 }; // Simple team/color scoring for the prototype
let powerUp = null;

function spawnPowerUp() {
    if (powerUp) return;
    powerUp = { 
        id: Math.random().toString(36).substr(2, 9),
        x: (Math.random() - 0.5) * 50,
        y: 15,
        z: (Math.random() - 0.5) * 50
    };
    io.emit('powerUpSpawned', powerUp);
    io.emit('log', '🟢 Power-Up dropped!');
}
setInterval(spawnPowerUp, 8000);

io.on('connection', (socket) => {
    // Assign team colors alternating
    const isRed = Object.keys(players).length % 2 === 0;
    const color = isRed ? 0xff4757 : 0x1e90ff;
    
    players[socket.id] = { color: color, isRed: isRed };

    // Send the new player their setup, the current players, and scores
    socket.emit('init', { id: socket.id, color: color, players: players, scores: scores });
    socket.broadcast.emit('playerJoined', { id: socket.id, color: color });
    io.emit('playerCount', Object.keys(players).length);

    // DUMB RELAY: When a client sends its physics state, broadcast it to everyone else
    socket.on('clientStateSync', (data) => {
        // Add the sender's ID so clients know whose sphere to update
        socket.broadcast.emit('remotePlayerState', { id: socket.id, state: data });
    });

    // Score handling
    socket.on('playerFell', () => {
        if (players[socket.id].isRed) scores.blue++;
        else scores.red++;
        io.emit('updateScores', scores);
        io.emit('log', '💀 Someone fell into the void!');
    });

    socket.on('powerUpGrabbed', () => {
        powerUp = null;
        io.emit('powerUpDestroyed');
        io.emit('log', '⚡ Power-Up grabbed!');
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerLeft', socket.id);
        io.emit('playerCount', Object.keys(players).length);
    });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Dumb Relay Server running on port ${PORT}`));