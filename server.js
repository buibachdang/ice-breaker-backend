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
    console.log('User connected:', socket.id);

    socket.on('createSession', () => {
        const sessionId = Math.random().toString(36).substring(2, 8);
        const adminId = socket.id;
        sessions[sessionId] = {
            id: sessionId, adminId, timeSetting: 60, status: 'waiting',
            players: {}, totalIceBlocks: 0, timer: null,
            brokenBlocks: [] // Tracks all broken block indices
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

    socket.on('startGame', ({ sessionId, players: playerSpawns, totalBlocks }) => {
        const session = sessions[sessionId];
        if (session && session.adminId === socket.id) {
            session.status = 'playing';
            session.totalIceBlocks = totalBlocks;

            // Assign pre-calculated spawn positions from client
            Object.keys(session.players).forEach(id => {
                if (playerSpawns[id]) {
                    session.players[id].x = playerSpawns[id].x;
                    session.players[id].y = playerSpawns[id].y;
                }
            });

            io.to(sessionId).emit('gameStarted', { players: session.players, time: session.timeSetting, totalBlocks: session.totalIceBlocks });

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

    socket.on('clickIce', ({ sessionId, blocksToBreak }) => {
        const session = sessions[sessionId];
        if (!session || session.status !== 'playing') return;
        const player = session.players[socket.id];
        if (!player) return;

        const now = Date.now();
        const newlyBroken = [];

        // Filter out blocks that are already broken
        blocksToBreak.forEach(blockIndex => {
            if (!session.brokenBlocks.includes(blockIndex)) {
                session.brokenBlocks.push(blockIndex);
                newlyBroken.push(blockIndex);
            }
        });

        if (newlyBroken.length > 0) {
            player.score += newlyBroken.length;
            player.timeReachedHighest = now;

            const iceRemaining = session.totalIceBlocks - session.brokenBlocks.length;

            io.to(sessionId).emit('iceUpdate', { 
                iceRemaining: iceRemaining,
                brokenBlocks: session.brokenBlocks, 
                players: session.players 
            });

            if (iceRemaining <= 0) endGame(sessionId);
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