import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import * as CANNON from "cannon-es";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// --- HEALTH CHECK ENDPOINT ---
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// --- SERVER PHYSICS WORLD ---
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -80, 0) });

const floorMat = new CANNON.Material("floor");
const playerMat = new CANNON.Material("player");

const playerFloorContact = new CANNON.ContactMaterial(floorMat, playerMat, {
  friction: 0.1,
  restitution: 0.1, 
  contactEquationStiffness: 1e8,
  contactEquationRelaxation: 3,
});
world.addContactMaterial(playerFloorContact);

const playerPlayerContact = new CANNON.ContactMaterial(playerMat, playerMat, {
  friction: 0.1,
  restitution: 3.0, 
  contactEquationStiffness: 1e8,
  contactEquationRelaxation: 3,
});
world.addContactMaterial(playerPlayerContact);

const arenaHalfExtent = 100; 
const platformBody = new CANNON.Body({ mass: 0, material: floorMat }); 
const platformShape = new CANNON.Box(
  new CANNON.Vec3(arenaHalfExtent, 1, arenaHalfExtent),
);

platformBody.addShape(platformShape, new CANNON.Vec3(0, 0, 0));
platformBody.position.set(0, -1, 0);
world.addBody(platformBody);

// Game State
const players = {};
let scores = { red: 0, blue: 0 };
let powerUp = null;

function spawnPowerUp() {
  if (powerUp) return;
  const types = ["speed", "mass", "repel"];
  const spawnLimit = arenaHalfExtent * 0.8; 
  powerUp = {
    id: Math.random().toString(36).substr(2, 9),
    type: types[Math.floor(Math.random() * types.length)],
    x: (Math.random() - 0.5) * spawnLimit * 2,
    y: 2,
    z: (Math.random() - 0.5) * spawnLimit * 2,
  };
  io.emit("log", `⚡ ${powerUp.type.toUpperCase()} Power-Up dropped!`);
}
setInterval(spawnPowerUp, 10000);

function removePlayer(id) {
  if (players[id]) {
    world.removeBody(players[id].body);
    delete players[id];
    io.emit("playerLeft", id);
  }
}

setInterval(() => {
  const now = Date.now();
  for (let id in players) {
    if (now - players[id].lastHeartbeat > 4000) {
      io.emit("log", "Player timed out.");
      removePlayer(id);
      const socket = io.sockets.sockets.get(id);
      if (socket) socket.disconnect(true);
    }
  }
}, 2000);

io.on("connection", (socket) => {
  const isRed = Object.keys(players).length % 2 === 0;
  const color = isRed ? 0xff4757 : 0x1e90ff;

  const body = new CANNON.Body({
    mass: 20,
    shape: new CANNON.Sphere(6.0),
    position: new CANNON.Vec3(
      (Math.random() - 0.5) * 40,
      10,
      (Math.random() - 0.5) * 40,
    ),
    material: playerMat, 
    linearDamping: 0.5,
    angularDamping: 0.5,
  });
  world.addBody(body);

  players[socket.id] = {
    color,
    isRed,
    body,
    inputs: { w: false, a: false, s: false, d: false, space: false },
    powerMult: 1,
    dashCooldown: 0,
    lastHeartbeat: Date.now(),
  };

  socket.emit("init", { id: socket.id, color, scores, arenaHalfExtent });
  io.emit("log", "A challenger appears!");

  socket.on("clientInput", (keys) => {
    if (players[socket.id]) players[socket.id].inputs = keys;
  });

  socket.on("heartbeat", () => {
    if (players[socket.id]) players[socket.id].lastHeartbeat = Date.now();
  });

  socket.on("disconnect", () => removePlayer(socket.id));
});

// --- MAIN GAME LOOP (60 FPS) ---
setInterval(() => {
  for (let id in players) {
    const p = players[id];

    if (p.body.position.y < -30) {
      if (p.isRed) scores.blue++;
      else scores.red++;
      io.emit("updateScores", scores);
      io.emit("log", "💥 Ring out!");

      p.body.position.set(
        (Math.random() - 0.5) * 40,
        20,
        (Math.random() - 0.5) * 40,
      );
      p.body.velocity.set(0, 0, 0);
      p.body.angularVelocity.set(0, 0, 0);
      continue; 
    }

    if (p.body.position.y < -5) continue;

    // --- CAMERA RELATIVE MOVEMENT ---
    let opponent = null;
    for (let otherId in players) {
      if (otherId !== id) { opponent = players[otherId]; break; }
    }

    let fz = -1, fx = 0; 
    if (opponent) {
      const dx = opponent.body.position.x - p.body.position.x;
      const dz = opponent.body.position.z - p.body.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.1) {
        fx = dx / dist; 
        fz = dz / dist; 
      }
    }
    
    let rx = -fz, rz = fx; 

    let moveX = 0, moveZ = 0;
    if (p.inputs.w) { moveX += fx; moveZ += fz; }
    if (p.inputs.s) { moveX -= fx; moveZ -= fz; }
    if (p.inputs.a) { moveX -= rx; moveZ -= rz; }
    if (p.inputs.d) { moveX += rx; moveZ += rz; }

    const moveLen = Math.hypot(moveX, moveZ);
    if (moveLen > 0) {
      moveX /= moveLen; moveZ /= moveLen;
      
      const force = 800 * p.powerMult; 
      const torque = 400 * p.powerMult; 

      p.body.applyForce(new CANNON.Vec3(moveX * force, 0, moveZ * force), p.body.position);
      p.body.applyTorque(new CANNON.Vec3(moveZ * torque, 0, -moveX * torque));
    }

    if (p.inputs.space && p.dashCooldown <= 0) {
      const vel = p.body.velocity;
      const dir = new CANNON.Vec3(vel.x, 0, vel.z);
      if (dir.length() > 0.1) {
        dir.normalize();
        p.body.applyImpulse(
          new CANNON.Vec3(dir.x * 1000, 0, dir.z * 1000),
          p.body.position,
        ); 
        p.dashCooldown = 120;
        io.emit("log", "💨 DASH!");
      }
    }
    if (p.dashCooldown > 0) p.dashCooldown--;

    if (powerUp) {
      const dx = p.body.position.x - powerUp.x;
      const dz = p.body.position.z - powerUp.z;
      
      // FIXED: Increased Y-axis check to 15 to account for massive player size!
      if (Math.hypot(dx, dz) < 12.0 && p.body.position.y < 15) {
        if (powerUp.type === "speed") p.powerMult = 2;
        if (powerUp.type === "mass") p.body.mass = 60;
        if (powerUp.type === "repel") {
          for (let otherId in players) {
            if (otherId !== id)
              players[otherId].body.applyImpulse(
                new CANNON.Vec3(dx * -100, 30, dz * -100),
                players[otherId].body.position,
              );
          }
        }
        setTimeout(() => {
          p.powerMult = 1;
          p.body.mass = 20;
          p.body.updateMassProperties();
        }, 5000);
        powerUp = null;
        io.emit("log", `📦 Power-up consumed!`);
      }
    }
  }

  world.step(1 / 60);

  const state = { players: {}, powerUp, arenaHalfExtent };
  for (let id in players) {
    state.players[id] = {
      x: players[id].body.position.x,
      y: players[id].body.position.y,
      z: players[id].body.position.z,
      vx: players[id].body.velocity.x,
      vy: players[id].body.velocity.y,
      vz: players[id].body.velocity.z,
      qx: players[id].body.quaternion.x,
      qy: players[id].body.quaternion.y,
      qz: players[id].body.quaternion.z,
      qw: players[id].body.quaternion.w,
      color: players[id].color,
      dashReady: players[id].dashCooldown <= 0,
    };
  }
  io.emit("gameState", state);
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () =>
  console.log(`Authoritative Server running on port ${PORT}`),
);