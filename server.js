import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as CANNON from 'cannon-es';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- SERVER PHYSICS WORLD ---
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -40, 0) });
const iceMat = new CANNON.Material('ice');
const iceContact = new CANNON.ContactMaterial(iceMat, iceMat, {
    friction: 0.1, restitution: 1.2, contactEquationStiffness: 1e8, contactEquationRelaxation: 3
});
world.addContactMaterial(iceContact);

// The Platform
const platformBody = new CANNON.Body({ mass: 0, material: iceMat });
platformBody.addShape(new CANNON.Box(new CANNON.Vec3(60, 1, 60)), new CANNON.Vec3(0, -1, 0));
world.addBody(platformBody);

// Game State
const players = {};
let scores = { red: 0, blue: 0 };
let powerUp = null;
let arenaRadius = 40;

function spawnPowerUp() {
    if (powerUp) return;
    const types = ['speed', 'mass', 'repel'];
    powerUp = {
        id: Math.random().toString(36).substr(2, 9),
        type: types[Math.floor(Math.random() * types.length)],
        x: (Math.random() - 0.5) * (arenaRadius * 1.5),
        y: 2,
        z: (Math.random() - 0.5) * (arenaRadius * 1.5)
    };
    io.emit('log', `🟢 ${powerUp.type.toUpperCase()} Power-Up dropped!`);
}
setInterval(spawnPowerUp, 10000);

io.on('connection', (socket) => {
    const isRed = Object.keys(players).length % 2 === 0;
    const color = isRed ? 0xff4757 : 0x1e90ff;

    // Create Physics Body for the player
    const body = new CANNON.Body({
        mass: 15, shape: new CANNON.Sphere(1.5),
        position: new CANNON.Vec3((Math.random() - 0.5) * 20, 10, (Math.random() - 0.5) * 20),
        material: iceMat, linearDamping: 0.4, angularDamping: 0.4
    });
    world.addBody(body);

    players[socket.id] = { 
        color, isRed, body, 
        inputs: { w: false, a: false, s: false, d: false, space: false },
        powerMult: 1, massMult: 1, dashCooldown: 0 
    };

    socket.emit('init', { id: socket.id, color, scores, arenaRadius });
    io.emit('log', 'A challenger appears!');

    // Receive raw inputs from client
    socket.on('clientInput', (keys) => {
        if (players[socket.id]) players[socket.id].inputs = keys;
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            world.removeBody(players[socket.id].body);
            delete players[socket.id];
            io.emit('playerLeft', socket.id);
        }
    });
});

// --- MAIN GAME LOOP (60 FPS) ---
setInterval(() => {
    // 1. Shrink Arena
    if (arenaRadius > 10) arenaRadius -= 0.005;

    // 2. Process Player Inputs & Physics
    for (let id in players) {
        const p = players[id];
        if (p.body.position.y < -5) continue; // Skip if falling

        const force = 600 * p.powerMult;
        const torque = 300 * p.powerMult;
        
        if (p.inputs.w) { p.body.applyForce(new CANNON.Vec3(0, 0, -force), p.body.position); p.body.applyTorque(new CANNON.Vec3(-torque, 0, 0)); }
        if (p.inputs.s) { p.body.applyForce(new CANNON.Vec3(0, 0, force), p.body.position); p.body.applyTorque(new CANNON.Vec3(torque, 0, 0)); }
        if (p.inputs.a) { p.body.applyForce(new CANNON.Vec3(-force, 0, 0), p.body.position); p.body.applyTorque(new CANNON.Vec3(0, 0, torque)); }
        if (p.inputs.d) { p.body.applyForce(new CANNON.Vec3(force, 0, 0), p.body.position); p.body.applyTorque(new CANNON.Vec3(0, 0, -torque)); }

        // Dash Mechanic
        if (p.inputs.space && p.dashCooldown <= 0) {
            const vel = p.body.velocity;
            const dir = new CANNON.Vec3(vel.x, 0, vel.z);
            if (dir.length() > 0.1) {
                dir.normalize();
                p.body.applyImpulse(new CANNON.Vec3(dir.x * 600, 0, dir.z * 600), p.body.position);
                p.dashCooldown = 120; // 2 seconds at 60fps
                io.emit('log', '💨 DASH!');
            }
        }
        if (p.dashCooldown > 0) p.dashCooldown--;

        // Power-Up Collision
        if (powerUp) {
            const dx = p.body.position.x - powerUp.x;
            const dz = p.body.position.z - powerUp.z;
            if (Math.hypot(dx, dz) < 3.5 && p.body.position.y < 5) {
                if (powerUp.type === 'speed') p.powerMult = 2;
                if (powerUp.type === 'mass') p.body.mass = 45;
                if (powerUp.type === 'repel') {
                    for (let otherId in players) {
                        if (otherId !== id) players[otherId].body.applyImpulse(new CANNON.Vec3(dx * -50, 20, dz * -50), players[otherId].body.position);
                    }
                }
                setTimeout(() => { p.powerMult = 1; p.body.mass = 15; p.body.updateMassProperties(); }, 5000);
                powerUp = null;
                io.emit('log', `⚡ Power-up consumed!`);
            }
        }

        // Death Check (Fell off arena radius)
        const distFromCenter = Math.hypot(p.body.position.x, p.body.position.z);
        if (distFromCenter > arenaRadius && p.body.position.y > 0) {
            p.body.velocity.set(0, -20, 0); // Force downward fall
        }
        
        if (p.body.position.y < -30) {
            if (p.isRed) scores.blue++; else scores.red++;
            io.emit('updateScores', scores);
            io.emit('log', '💀 Ring out!');
            
            // Respawn
            p.body.position.set((Math.random() - 0.5) * 10, 15, (Math.random() - 0.5) * 10);
            p.body.velocity.set(0, 0, 0);
            p.body.angularVelocity.set(0, 0, 0);
        }
    }

    world.step(1 / 60);

    // 3. Broadcast Snapshot to Clients
    const state = { players: {}, powerUp, arenaRadius };
    for (let id in players) {
        state.players[id] = {
            x: players[id].body.position.x, y: players[id].body.position.y, z: players[id].body.position.z,
            qx: players[id].body.quaternion.x, qy: players[id].body.quaternion.y, qz: players[id].body.quaternion.z, qw: players[id].body.quaternion.w,
            color: players[id].color,
            dashReady: players[id].dashCooldown <= 0
        };
    }
    io.emit('gameState', state);

}, 1000 / 60);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Authoritative Server running on port ${PORT}`));