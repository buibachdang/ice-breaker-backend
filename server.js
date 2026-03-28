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

// --- MATH HELPER: PERFECT DISTANCE TO EDGE ---
function getEquidistantSpawns(shape, size, numPlayers, distanceToEdge) {
    const cx = 400; // Center of canvas X
    const cy = 300; // Center of canvas Y
    const positions = [];

    if (shape === 'circle') {
        // Spawn on a concentric circle
        const spawnRadius = size + distanceToEdge;
        for (let i = 0; i < numPlayers; i++) {
            const angle = (i / numPlayers) * Math.PI * 2;
            positions.push({
                x: cx + Math.cos(angle) * spawnRadius,
                y: cy + Math.sin(angle) * spawnRadius
            });
        }
    } else if (shape === 'square') {
        // Spawn strictly along 4 lines perfectly parallel to the flat edges
        // This guarantees the shortest path to the ice is exactly 'distanceToEdge'
        const flatPerimeter = 8 * size; // 4 edges, each is (2 * size) long
        
        for (let i = 0; i < numPlayers; i++) {
            const distAlong = (i / numPlayers) * flatPerimeter;
            let px, py;
            
            if (distAlong < 2 * size) { 
                // Top Edge
                px = cx - size + distAlong;
                py = cy - size - distanceToEdge;
            } else if (distAlong < 4 * size) { 
                // Right Edge
                px = cx + size + distanceToEdge;
                py = cy - size + (distAlong - 2 * size);
            } else if (distAlong < 6 * size) { 
                // Bottom Edge
                px = cx + size - (distAlong - 4 * size);
                py = cy + size + distanceToEdge;
            } else { 
                // Left Edge
                px = cx - size - distanceToEdge;
                py = cy + size - (distAlong - 6 * size);
            }
            positions.push({ x: px, y: py });
        }
    }
    return positions;
}

io.on('connection', (socket) => {
    socket.on('createSession', () => {
        const sessionId = Math.random().toString(36).substring(2, 8);
        const adminId = socket.id;
        sessions[sessionId] = {
            id: sessionId, adminId, timeSetting: 60, shape: 'circle', size: 100,
            status: 'waiting', players: {}, totalIce: 1000, iceRemaining: 1000, timer: null
        };
        socket.join(sessionId);
        socket.emit('sessionCreated', sessionId);
    });

    socket.on('updateSettings', ({ sessionId, time, shape, size }) => {
        const session = sessions[sessionId];
        if (session && session.adminId === socket.id && session.status === 'waiting') {
            session.timeSetting = Math.max(30, Math.min(300, time));
            session.shape = shape || 'circle';
            session.size = Math.max(50, Math.min(250, size || 100));
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
            x: -100, y: -100, 
            score: 0, clickTimestamps: [], timeReachedHighest: 0
        };

        socket.join(sessionId);
        io.to(sessionId).emit('updatePlayers', Object.values(session.players));
    });

    socket.on('startGame', (sessionId) => {
        const session = sessions[sessionId];
        if (session && session.adminId === socket.id) {
            session.status = 'playing';
            
            // Calculate total cubes based on area
            let area = session.shape === 'circle' 
                ? Math.PI * session.size * session.size 
                : (session.size * 2) * (session.size * 2);
            
            session.totalIce = Math.floor(area / 25) || 1;
            session.iceRemaining = session.totalIce;

            // Apply Equidistant Spawning
            const playerIds = Object.keys(session.players);
            const spawnPoints = getEquidistantSpawns(session.shape, session.size, playerIds.length, 150);
            
            playerIds.forEach((id, index) => {
                session.players[id].x = spawnPoints[index].x;
                session.players[id].y = spawnPoints[index].y;
            });

            io.to(sessionId).emit('gameStarted', { 
                players: session.players, 
                time: session.timeSetting,
                shape: session.shape,
                initialIce: session.totalIce
            });

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

        // Visual size of ice shrinks as cubes are broken
        const scale = Math.sqrt(session.iceRemaining / session.totalIce);
        const currentSize = session.size * scale;
        
        // Exact distance validation from the edge
        let isCloseEnough = false;
        const maxReach = 150 + 20; // 150px distance + 20px wiggle room for latency
        
        if (session.shape === 'circle') {
            const distToCenter = Math.hypot(player.x - 400, player.y - 300);
            if (distToCenter <= currentSize + maxReach) isCloseEnough = true; 
        } else if (session.shape === 'square') {
            if (player.x >= 400 - currentSize - maxReach && player.x <= 400 + currentSize + maxReach &&
                player.y >= 300 - currentSize - maxReach && player.y <= 300 + currentSize + maxReach) {
                isCloseEnough = true;
            }
        }

        if (!isCloseEnough) return; 

        // Mining logic
        const now = Date.now();
        player.clickTimestamps = player.clickTimestamps.filter(t => now - t < 1000);
        player.clickTimestamps.push(now);

        let cubesToBreak = Math.min(5, 1 + Math.floor(player.clickTimestamps.length / 2));
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

        const sorted = Object.values(session.players).sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.timeReachedHighest - b.timeReachedHighest;
        });

        const highestScore = sorted[0]?.score || 0;
        const winners = sorted.filter(p => p.score === highestScore);

        io.to(sessionId).emit('gameOver', { winners, highestScore });
    }
});

server.listen(3000, () => console.log('Server running on port 3000'));