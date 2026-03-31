import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as CANNON from 'cannon-es';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);

// Update this part to enable CORS
const io = new Server(httpServer, {
    cors: {
        origin: "*", // Allows any domain to connect. You can replace "*" with your specific Netlify URL later for security.
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname, 'public')));

// --- PHYSICS WORLD SETUP ---
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -30, 0) });
const iceMaterial = new CANNON.Material('ice');
const iceContact = new CANNON.ContactMaterial(iceMaterial, iceMaterial, {
    friction: 0.05, restitution: 2.0, contactEquationStiffness: 1e7, contactEquationRelaxation: 4
});
world.addContactMaterial(iceContact);

// The Floor (Using a Box for stability)
const platformBody = new CANNON.Body({ mass: 0, material: iceMaterial });
platformBody.addShape(new CANNON.Box(new CANNON.Vec3(20, 0.5, 20)));
world.addBody(platformBody);

// Game State
const players = {};
let platformRadius = 12;
let powerUp = null;

// --- POWER UPS ---
function spawnPowerUp() {
    if (powerUp) return;
    const size = 1.2;
    const body = new CANNON.Body({
        mass: 2,
        shape: new CANNON.Box(new CANNON.Vec3(size/2, size/2, size/2)),
        position: new CANNON.Vec3((Math.random() - 0.5) * platformRadius, 15, (Math.random() - 0.5) * platformRadius)
    });
    world.addBody(body);
    powerUp = { id: Math.random().toString(36).substr(2, 9), body: body };
}
setInterval(spawnPowerUp, 8000);

// --- SOCKET CONNECTIONS ---
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Create player physics body
    const color = Math.random() * 0xffffff;
    const body = new CANNON.Body({
        mass: 10,
        shape: new CANNON.Sphere(1),
        position: new CANNON.Vec3((Math.random() - 0.5) * 10, 5, (Math.random() - 0.5) * 10),
        material: iceMaterial,
        linearDamping: 0.3,
        angularDamping: 0.3
    });
    world.addBody(body);

    players[socket.id] = { 
        body: body, color: color, inputs: { w: false, a: false, s: false, d: false },
        powerMultiplier: 1, baseMass: 10
    };

    socket.emit('init', { id: socket.id, color: color });

    socket.on('input', (inputs) => {
        if (players[socket.id]) players[socket.id].inputs = inputs;
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        if (players[socket.id]) {
            world.removeBody(players[socket.id].body);
            delete players[socket.id];
        }
    });
});

// --- PHYSICS TICK LOOP (60fps) ---
const TICK_RATE = 60;
setInterval(() => {
    world.step(1 / TICK_RATE);

    if (platformRadius > 3) platformRadius -= 0.3 / TICK_RATE;

    const maxSpeed = 18;
    const pack = { players: {}, platformRadius, powerUp: null };

    // Process Players
    for (const id in players) {
        const p = players[id];
        const force = 120 * p.powerMultiplier;
        const torque = 80 * p.powerMultiplier;

        if (p.inputs.w) { p.body.applyForce(new CANNON.Vec3(0, 0, -force), p.body.position); p.body.applyTorque(new CANNON.Vec3(-torque, 0, 0)); }
        if (p.inputs.s) { p.body.applyForce(new CANNON.Vec3(0, 0, force), p.body.position); p.body.applyTorque(new CANNON.Vec3(torque, 0, 0)); }
        if (p.inputs.a) { p.body.applyForce(new CANNON.Vec3(-force, 0, 0), p.body.position); p.body.applyTorque(new CANNON.Vec3(0, 0, torque)); }
        if (p.inputs.d) { p.body.applyForce(new CANNON.Vec3(force, 0, 0), p.body.position); p.body.applyTorque(new CANNON.Vec3(0, 0, -torque)); }

        // Speed Limit
        const speed = Math.hypot(p.body.velocity.x, p.body.velocity.z);
        if (speed > maxSpeed * p.powerMultiplier) {
            const mult = (maxSpeed * p.powerMultiplier) / speed;
            p.body.velocity.x *= mult;
            p.body.velocity.z *= mult;
        }

        // Edge Fall & Respawn
        const dist = Math.hypot(p.body.position.x, p.body.position.z);
        if (dist > platformRadius) p.body.applyForce(new CANNON.Vec3(0, -600, 0), p.body.position);
        
        if (p.body.position.y < -15) {
            // Respawn
            p.body.position.set(0, 10, 0);
            p.body.velocity.set(0,0,0);
            p.body.angularVelocity.set(0,0,0);
        }

        // PowerUp Collision
        if (powerUp && p.body.position.distanceTo(powerUp.body.position) < 2.5) {
            p.body.mass += 25; p.body.updateMassProperties();
            p.powerMultiplier = 2.0;
            world.removeBody(powerUp.body);
            powerUp = null;
            setTimeout(() => {
                if (players[id]) {
                    p.body.mass = p.baseMass; p.body.updateMassProperties();
                    p.powerMultiplier = 1;
                }
            }, 5000);
        }

        // Pack data for client
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