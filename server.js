import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as CANNON from 'cannon-es';

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- STABILIZED PHYSICS WORLD ---
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -40, 0) }); // Stronger gravity to prevent floating

const iceMaterial = new CANNON.Material('ice');
const iceContact = new CANNON.ContactMaterial(iceMaterial, iceMaterial, {
    friction: 0.1,       // Enough friction to grip slightly
    restitution: 1.2,    // 1.2 is bouncy enough to be obnoxious without breaking the engine
    contactEquationStiffness: 1e8, 
    contactEquationRelaxation: 3
});
world.addContactMaterial(iceContact);

// MASSIVE Physics Floor
const platformBody = new CANNON.Body({ mass: 0, material: iceMaterial });
platformBody.addShape(new CANNON.Box(new CANNON.Vec3(60, 0.5, 60))); 
world.addBody(platformBody);

const players = {};
let platformRadius = 40; // MUCH bigger visual platform
let powerUp = null;

// --- POWER UPS ---
function spawnPowerUp() {
    if (powerUp) return;
    const size = 1.5;
    const body = new CANNON.Body({
        mass: 5, // Heavier powerup so it doesn't fly away easily
        shape: new CANNON.Box(new CANNON.Vec3(size/2, size/2, size/2)),
        position: new CANNON.Vec3((Math.random() - 0.5) * (platformRadius - 5), 15, (Math.random() - 0.5) * (platformRadius - 5))
    });
    world.addBody(body);
    powerUp = { id: Math.random().toString(36).substr(2, 9), body: body };
    io.emit('log', '🟢 A Power-Up dropped!');
}
setInterval(spawnPowerUp, 8000);

// --- SOCKET CONNECTIONS ---
io.on('connection', (socket) => {
    const color = Math.random() * 0xffffff;
    const body = new CANNON.Body({
        mass: 15, // Meatier players
        shape: new CANNON.Sphere(1),
        position: new CANNON.Vec3((Math.random() - 0.5) * 20, 10, (Math.random() - 0.5) * 20),
        material: iceMaterial,
        linearDamping: 0.4, // Prevents infinite sliding
        angularDamping: 0.4
    });
    world.addBody(body);

    players[socket.id] = { 
        body: body, color: color, inputs: { w: false, a: false, s: false, d: false },
        powerMultiplier: 1, baseMass: 15
    };

    socket.emit('init', { id: socket.id, color: color });
    io.emit('playerCount', Object.keys(players).length);
    socket.broadcast.emit('log', '⚔️ A new challenger entered the arena!');

    socket.on('input', (inputs) => {
        if (players[socket.id]) players[socket.id].inputs = inputs;
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            world.removeBody(players[socket.id].body);
            delete players[socket.id];
        }
        io.emit('playerCount', Object.keys(players).length);
        io.emit('log', '💨 A player disconnected.');
    });
});

// --- PHYSICS TICK LOOP ---
const TICK_RATE = 60;
setInterval(() => {
    world.step(1 / TICK_RATE);

    // SHRINKING DISABLED FOR NOW
    // if (platformRadius > 3) platformRadius -= 0.3 / TICK_RATE;

    const maxSpeed = 35; // Higher top speed for the bigger arena
    const pack = { players: {}, platformRadius, powerUp: null };

    for (const id in players) {
        const p = players[id];
        const force = 400 * p.powerMultiplier; // Increased force to match heavier mass
        const torque = 200 * p.powerMultiplier;

        if (p.inputs.w) { p.body.applyForce(new CANNON.Vec3(0, 0, -force), p.body.position); p.body.applyTorque(new CANNON.Vec3(-torque, 0, 0)); }
        if (p.inputs.s) { p.body.applyForce(new CANNON.Vec3(0, 0, force), p.body.position); p.body.applyTorque(new CANNON.Vec3(torque, 0, 0)); }
        if (p.inputs.a) { p.body.applyForce(new CANNON.Vec3(-force, 0, 0), p.body.position); p.body.applyTorque(new CANNON.Vec3(0, 0, torque)); }
        if (p.inputs.d) { p.body.applyForce(new CANNON.Vec3(force, 0, 0), p.body.position); p.body.applyTorque(new CANNON.Vec3(0, 0, -torque)); }

        const speed = Math.hypot(p.body.velocity.x, p.body.velocity.z);
        if (speed > maxSpeed * p.powerMultiplier) {
            const mult = (maxSpeed * p.powerMultiplier) / speed;
            p.body.velocity.x *= mult; p.body.velocity.z *= mult;
        }

        const dist = Math.hypot(p.body.position.x, p.body.position.z);
        if (dist > platformRadius) p.body.applyForce(new CANNON.Vec3(0, -800, 0), p.body.position); // YANK them down if they cross the edge
        
        if (p.body.position.y < -20) {
            p.body.position.set(0, 20, 0); // Drop them from the sky on respawn
            p.body.velocity.set(0,0,0);
            p.body.angularVelocity.set(0,0,0);
        }

        if (powerUp && p.body.position.distanceTo(powerUp.body.position) < 3.0) {
            p.body.mass += 30; p.body.updateMassProperties();
            p.powerMultiplier = 2.0;
            world.removeBody(powerUp.body);
            powerUp = null;
            io.emit('log', '⚡ Someone grabbed the power-up!');
            setTimeout(() => {
                if (players[id]) {
                    p.body.mass = p.baseMass; p.body.updateMassProperties();
                    p.powerMultiplier = 1;
                }
            }, 5000);
        }

        pack.players[id] = {
            x: p.body.position.x, y: p.body.position.y, z: p.body.position.z,
            qx: p.body.quaternion.x, qy: p.body.quaternion.y, qz: p.body.quaternion.z, qw: p.body.quaternion.w,
            color: p.color, scale: p.powerMultiplier > 1 ? 1.6 : 1
        };
    }

    if (powerUp) {
        pack.powerUp = {
            x: powerUp.body.position.x, y: powerUp.body.position.y, z: powerUp.body.position.z,
            qx: powerUp.body.quaternion.x, qy: powerUp.body.quaternion.y, qz: powerUp.body.quaternion.z, qw: powerUp.body.quaternion.w
        };
    }

    io.emit('state', pack);
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));