// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const sessions = {};
const COLORS = ['#FF5733', '#33FF57', '#3357FF', '#F333FF', '#33FFF3', '#F3FF33', '#FF8333', '#83FF33', '#3383FF', '#8333FF'];

io.on('connection', (socket) => {
    socket.on('createSession', () => {
        const sessionId = Math.random().toString(36).substring(2, 8);
        const adminId = socket.id;
        sessions[sessionId] = {
            id: sessionId, adminId, timeSetting: 60, status: 'waiting',
            players: {}, iceRemaining: 1000, timer: null
        };
        socket.join(sessionId);
        socket.emit('sessionCreated', sessionId);
    });

    socket.on('updateTime', ({ sessionId, time }) => {
        const session = sessions[sessionId];
        if (session && session.adminId === socket.id && session.status === 'waiting') {
            session.timeSetting = Math.max(30, Math.min(300, time));
            io.to(sessionId).emit('timeUpdated', session.timeSetting);
        }
    });

    socket.on('joinSession', ({ sessionId, name }) => {
        const session = sessions[sessionId];
        if (!session) return socket.emit('error', 'Session not found');
        if (session.status !== 'waiting') return socket.emit('error', 'Game already started');
        if (Object.keys(session.players).length >= 20) return socket.emit('error', 'Game is full');

        const color = COLORS[Object.keys(session.players).length % COLORS.length];
        session.players[socket.id] = {
            id: socket.id, name, color,
            x: -100, y: -100, // Spawn positions set on game start
            score: 0, clickTimestamps: [], timeReachedHighest: 0
        };

        socket.join(sessionId);
        io.to(sessionId).emit('updatePlayers', Object.values(session.players));
    });

    socket.on('startGame', (sessionId) => {
        const session = sessions[sessionId];
        if (session && session.adminId === socket.id) {
            session.status = 'playing';
            
            // Assign perimeter spawn positions evenly
            const playerIds = Object.keys(session.players);
            const w = 800, h = 600; 
            const perimeter = 2 * (w + h);
            const spacing = perimeter / playerIds.length;

            playerIds.forEach((id, index) => {
                let dist = index * spacing;
                let px, py;
                if (dist < w) { px = dist; py = 0; }
                else if (dist < w + h) { px = w; py = dist - w; }
                else if (dist < 2 * w + h) { px = w - (dist - (w + h)); py = h; }
                else { px = 0; py = h - (dist - (2 * w + h)); }
                
                session.players[id].x = px;
                session.players[id].y = py;
            });

            io.to(sessionId).emit('gameStarted', { players: session.players, time: session.timeSetting });

            session.timer = setInterval(() => {
                session.timeSetting--;
                io.to(sessionId).emit('tick', session.timeSetting);
                if (session.timeSetting <= 0) endGame(sessionId);
            }, 1000);
        }
    });

    socket.on('move', ({ sessionId, x, y }) => {
        const session = sessions[sessionId];
        if (session && session.status === 'playing' && session.players[socket.id]) {
            session.players[socket.id].x = x;
            session.players[socket.id].y = y;
            io.to(sessionId).emit('playerMoved', { id: socket.id, x, y });
        }
    });

    socket.on('clickIce', (sessionId) => {
        const session = sessions[sessionId];
        if (!session || session.status !== 'playing' || session.iceRemaining <= 0) return;
        const player = session.players[socket.id];
        if (!player) return;

        // Player must be close to the center (400, 300) to mine
        const dist = Math.hypot(player.x - 400, player.y - 300);
        if (dist > 150) return; 

        const now = Date.now();
        // Rolling 1 second window
        player.clickTimestamps = player.clickTimestamps.filter(t => now - t < 1000);
        player.clickTimestamps.push(now);

        const recentClicks = player.clickTimestamps.length;
        let cubesToBreak = Math.min(5, 1 + Math.floor(recentClicks / 2));
        cubesToBreak = Math.min(cubesToBreak, session.iceRemaining);

        if (cubesToBreak > 0) {
            session.iceRemaining -= cubesToBreak;
            player.score += cubesToBreak;
            player.timeReachedHighest = now;

            io.to(sessionId).emit('iceUpdate', { 
                iceRemaining: session.iceRemaining, 
                players: session.players 
            });

            if (session.iceRemaining <= 0) endGame(sessionId);
        }
    });

    function endGame(sessionId) {
        const session = sessions[sessionId];
        if (!session || session.status === 'ended') return;
        session.status = 'ended';
        clearInterval(session.timer);

        // Sort by score (desc), then by time reached (asc)
        const sorted = Object.values(session.players).sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.timeReachedHighest - b.timeReachedHighest;
        });

        const highestScore = sorted[0]?.score || 0;
        const winners = sorted.filter(p => p.score === highestScore);

        io.to(sessionId).emit('gameOver', { winners, highestScore });
    }
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);   
});