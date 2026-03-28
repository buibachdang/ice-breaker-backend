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
            players: {}, iceRemaining: 1000, timer: null,
            brokenBlocks: [] // <--- NEW: Track exactly which blocks are broken
        };
        socket.join(sessionId);
        socket.emit('sessionCreated', sessionId);
    });

// Allow admin to update settings
    socket.on('updateSettings', ({ sessionId, time, shape, size }) => {
        const session = sessions[sessionId];
        if (session && session.adminId === socket.id && session.status === 'waiting') {
            session.timeSetting = Math.max(30, Math.min(300, time));
            session.shape = shape || 'circle';
            session.size = Math.max(50, Math.min(250, size || 100));
            io.to(sessionId).emit('settingsUpdated', { time: session.timeSetting, shape: session.shape, size: session.size });
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
            
            // Set defaults if admin didn't change them
            if (!session.shape) { session.shape = 'circle'; session.size = 100; }
            
            // Calculate dynamic cube count based on Area (1 cube = 25px area)
            let area = 0;
            if (session.shape === 'circle') {
                area = Math.PI * session.size * session.size;
            } else if (session.shape === 'square') {
                area = (session.size * 2) * (session.size * 2); 
            }
            session.totalIce = Math.floor(area / 25);
            session.iceRemaining = session.totalIce;

            // Strict Equidistant Spawning
            const playerIds = Object.keys(session.players);
            const numPlayers = playerIds.length;
            const spawnDistance = 150; // Every player is exactly 150px away from the ice

            playerIds.forEach((id, index) => {
                let px, py;
                
                if (session.shape === 'circle') {
                    // Spawn on a concentric circle
                    const angle = (index / numPlayers) * Math.PI * 2;
                    const spawnRadius = session.size + spawnDistance;
                    px = 400 + Math.cos(angle) * spawnRadius;
                    py = 300 + Math.sin(angle) * spawnRadius;
                } 
                else if (session.shape === 'square') {
                    // Spawn strictly along the straight offset edges to avoid corner distance distortion
                    const edgeLength = session.size * 2; 
                    const totalSafePerimeter = edgeLength * 4;
                    const distanceAlongPerimeter = (index / numPlayers) * totalSafePerimeter;
                    
                    const offset = session.size + spawnDistance;
                    
                    if (distanceAlongPerimeter < edgeLength) { // Top edge
                        px = 400 - session.size + distanceAlongPerimeter;
                        py = 300 - offset;
                    } else if (distanceAlongPerimeter < edgeLength * 2) { // Right edge
                        px = 400 + offset;
                        py = 300 - session.size + (distanceAlongPerimeter - edgeLength);
                    } else if (distanceAlongPerimeter < edgeLength * 3) { // Bottom edge
                        px = 400 + session.size - (distanceAlongPerimeter - edgeLength * 2);
                        py = 300 + offset;
                    } else { // Left edge
                        px = 400 - offset;
                        py = 300 + session.size - (distanceAlongPerimeter - edgeLength * 3);
                    }
                }
                
                session.players[id].x = px;
                session.players[id].y = py;
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

socket.on('clickIce', ({ sessionId, blockIndex }) => {
        const session = sessions[sessionId];
        if (!session || session.status !== 'playing' || session.iceRemaining <= 0) return;
        const player = session.players[socket.id];
        if (!player) return;

        // Ensure the block isn't already broken
        if (session.brokenBlocks.includes(blockIndex)) return;

        const now = Date.now();
        player.clickTimestamps = player.clickTimestamps.filter(t => now - t < 1000);
        player.clickTimestamps.push(now);

        // Calculate combo multiplier (max 5 cubes per click)
        const recentClicks = player.clickTimestamps.length;
        let cubesToBreak = Math.min(5, 1 + Math.floor(recentClicks / 2));
        cubesToBreak = Math.min(cubesToBreak, session.iceRemaining);

        const brokenThisClick = [];
        if (cubesToBreak > 0) {
            // 1. Break the primary target block
            session.brokenBlocks.push(blockIndex);
            brokenThisClick.push(blockIndex);
            cubesToBreak--;

            // 2. Break adjacent blocks to satisfy the combo multiplier
            let offset = 1;
            while (cubesToBreak > 0 && session.brokenBlocks.length < 1000 && offset < 1000) {
                if (blockIndex + offset < 1000 && !session.brokenBlocks.includes(blockIndex + offset)) {
                    session.brokenBlocks.push(blockIndex + offset);
                    brokenThisClick.push(blockIndex + offset);
                    cubesToBreak--;
                }
                if (cubesToBreak > 0 && blockIndex - offset >= 0 && !session.brokenBlocks.includes(blockIndex - offset)) {
                    session.brokenBlocks.push(blockIndex - offset);
                    brokenThisClick.push(blockIndex - offset);
                    cubesToBreak--;
                }
                offset++;
            }

            const totalBroken = brokenThisClick.length;
            session.iceRemaining -= totalBroken;
            player.score += totalBroken;
            player.timeReachedHighest = now;

            // Broadcast the exact broken blocks array to everyone
            io.to(sessionId).emit('iceUpdate', { 
                iceRemaining: session.iceRemaining, 
                brokenBlocks: session.brokenBlocks, 
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