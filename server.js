import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as CANNON from 'cannon-es';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- SERVER PHYSICS WORLD ---
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -50, 0) });
const iceMat = new CANNON.Material('ice');
const iceContact = new CANNON.ContactMaterial(iceMat, iceMat, {
    friction: 0.1, restitution: 0.8, contactEquationStiffness: 1e8, contactEquationRelaxation: 3
});
world.addContactMaterial(iceContact);

// --- FIXED: The Giant Platform is now a true Cylinder ---
const arenaRadius = 100;
const platformBody = new CANNON.Body({ mass: 0, material: iceMat });
const platformShape = new CANNON.Cylinder(arenaRadius, arenaRadius, 2, 64);
const quat = new CANNON.Quaternion();
quat.setFromEuler(-Math.PI / 2, 0, 0); // Rotate the Cannon cylinder to lay flat
platformBody.addShape(platformShape, new CANNON.Vec3(0, -1, 0), quat);
world.addBody(platformBody);

// Game State
const players = {};
let scores = { red: 0, blue: 0 };
let powerUp = null;

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

    const body = new CANNON.Body({
        mass: 20, 
        shape: new CANNON.Sphere(1.5),
        position: new CANNON.Vec3((Math.random() - 0.5) * 40, 10, (Math.random() - 0.5) * 40),
        material: iceMat, linearDamping: 0.5, angularDamping: 0.5
    });
    world.addBody(body);

    players[socket.id] = { 
        color, isRed, body, 
        inputs: { w: false, a: false, s: false, d: false, space: false },
        powerMult: 1, dashCooldown: 0 
    };

    socket.emit('init', { id: socket.id, color, scores, arenaRadius });
    io.emit('log', 'A challenger appears!');

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
    for (let id in players) {
        const p = players[id];
        if (p.body.position.y < -5) continue;

        const force = 1200 * p.powerMult;
        const torque = 600 * p.powerMult;
        
        if (p.inputs.w) { p.body.applyForce(new CANNON.Vec3(0, 0, -force), p.body.position); p.body.applyTorque(new CANNON.Vec3(-torque, 0, 0)); }
        if (p.inputs.s) { p.body.applyForce(new CANNON.Vec3(0, 0, force), p.body.position); p.body.applyTorque(new CANNON.Vec3(torque, 0, 0)); }
        if (p.inputs.a) { p.body.applyForce(new CANNON.Vec3(-force, 0, 0), p.body.position); p.body.applyTorque(new CANNON.Vec3(0, 0, torque)); }
        if (p.inputs.d) { p.body.applyForce(new CANNON.Vec3(force, 0, 0), p.body.position); p.body.applyTorque(new CANNON.Vec3(0, 0, -torque)); }

        if (p.inputs.space && p.dashCooldown <= 0) {
            const vel = p.body.velocity;
            const dir = new CANNON.Vec3(vel.x, 0, vel.z);
            if (dir.length() > 0.1) {
                dir.normalize();
                p.body.applyImpulse(new CANNON.Vec3(dir.x * 1200, 0, dir.z * 1200), p.body.position);
                p.dashCooldown = 120;
                io.emit('log', '💨 DASH!');
            }
        }
        if (p.dashCooldown > 0) p.dashCooldown--;

        if (powerUp) {
            const dx = p.body.position.x - powerUp.x;
            const dz = p.body.position.z - powerUp.z;
            if (Math.hypot(dx, dz) < 3.5 && p.body.position.y < 5) {
                if (powerUp.type === 'speed') p.powerMult = 2;
                if (powerUp.type === 'mass') p.body.mass = 60;
                if (powerUp.type === 'repel') {
                    for (let otherId in players) {
                        if (otherId !== id) players[otherId].body.applyImpulse(new CANNON.Vec3(dx * -100, 30, dz * -100), players[otherId].body.position);
                    }
                }
                setTimeout(() => { p.powerMult = 1; p.body.mass = 20; p.body.updateMassProperties(); }, 5000);
                powerUp = null;
                io.emit('log', `⚡ Power-up consumed!`);
            }
        }
        
        // Natural death (fell below arena)
        if (p.body.position.y < -30) {
            if (p.isRed) scores.blue++; else scores.red++;
            io.emit('updateScores', scores);
            io.emit('log', '💀 Ring out!');
            
            p.body.position.set((Math.random() - 0.5) * 40, 20, (Math.random() - 0.5) * 40);
            p.body.velocity.set(0, 0, 0);
            p.body.angularVelocity.set(0, 0, 0);
        }
    }
    
    world.step(1 / 60);

    const state = { players: {}, powerUp, arenaRadius };
    for (let id in players) {
        state.players[id] = {
            x: players[id].body.position.x, y: players[id].body.position.y, z: players[id].body.position.z,
            vx: players[id].body.velocity.x, vy: players[id].body.velocity.y, vz: players[id].body.velocity.z,
            qx: players[id].body.quaternion.x, qy: players[id].body.quaternion.y, qz: players[id].body.quaternion.z, qw: players[id].body.quaternion.w,
            color: players[id].color,
            dashReady: players[id].dashCooldown <= 0
        };
    }
    io.emit('gameState', state);

}, 1000 / 60);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Authoritative Server running on port ${PORT}`));