const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

let broadcaster = null;

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("broadcaster", () => {
    broadcaster = socket.id;
    socket.broadcast.emit("broadcaster");
  });

  socket.on("watcher", () => {
    if (broadcaster) {
      socket.to(broadcaster).emit("watcher", socket.id);
    }
  });

  socket.on("offer", (id, message) =>
    socket.to(id).emit("offer", socket.id, message),
  );
  socket.on("answer", (id, message) =>
    socket.to(id).emit("answer", socket.id, message),
  );
  socket.on("candidate", (id, message) =>
    socket.to(id).emit("candidate", socket.id, message),
  );

  // --- NEW: CHAT RELAY ---
  socket.on("chatMessage", (msg) => {
    socket.broadcast.emit("chatMessage", msg);
  });

  socket.on("disconnect", () => {
    socket.broadcast.emit("disconnectPeer", socket.id);
    if (socket.id === broadcaster) broadcaster = null;
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`Signaling server running on port ${PORT}`),
);
