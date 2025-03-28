const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
// const { v4: uuidv4 } = require('uuid');

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const MAP_WIDTH = 15;
const MAP_HEIGHT = 15;
const INITIAL_SOLDIERS_NEUTRAL = 5;
const INITIAL_SOLDIERS_START_PLAYER = 20;
const SOLDIER_GENERATION_INTERVAL = 1000; // ms (1 second)
const SOLDIERS_PER_TICK = 1;

// --- Game State ---
let map = initializeMap();
let players = new Map(); // Map<WebSocket, {playerId: string}>
let nextPlayerNumber = 1; // <<<--- ADD THIS COUNTER
let soldierGenerationIntervalHandle = null;

// --- Server Setup ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));

// --- Utility Functions ---
function getAdjacentCoords(x, y) {
    const coords = [];
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < MAP_WIDTH && ny >= 0 && ny < MAP_HEIGHT) {
                coords.push({ x: nx, y: ny });
            }
        }
    }
    return coords;
}


// --- Game Logic Functions ---

function initializeMap() {
    console.log("Initializing map...");
    const newMap = [];
    for (let y = 0; y < MAP_HEIGHT; y++) {
        newMap[y] = [];
        for (let x = 0; x < MAP_WIDTH; x++) {
            newMap[y][x] = {
                soldiers: INITIAL_SOLDIERS_NEUTRAL,
                owner: null
            };
        }
    }
    console.log(`Map initialized (${MAP_WIDTH}x${MAP_HEIGHT}).`);
    return newMap;
}

function assignStartingTile(playerId) {
    const neutralTiles = [];
    for (let y = 0; y < MAP_HEIGHT; y++) {
        for (let x = 0; x < MAP_WIDTH; x++) {
            if (map[y][x].owner === null) {
                neutralTiles.push({ x, y });
            }
        }
    }

    if (neutralTiles.length === 0) {
        console.warn(`No neutral tiles available to assign to ${playerId}!`);
        return false;
    }

    const randomIndex = Math.floor(Math.random() * neutralTiles.length);
    const startTileCoords = neutralTiles[randomIndex];
    const tile = map[startTileCoords.y][startTileCoords.x];

    tile.owner = playerId;
    tile.soldiers = INITIAL_SOLDIERS_START_PLAYER;

    console.log(`Assigned starting tile (${startTileCoords.x}, ${startTileCoords.y}) to ${playerId}`);
    return true;
}


function getPlayerId(ws) {
    const playerData = players.get(ws);
    return playerData ? playerData.playerId : null;
}

function broadcast(data, senderWs = null) {
    const message = JSON.stringify(data);
    players.forEach((playerData, ws) => {
        if (ws !== senderWs && ws.readyState === WebSocket.OPEN) {
            ws.send(message);
        }
    });
}

function broadcastMapUpdate(senderWs = null) {
    broadcast({ type: 'mapUpdate', payload: map }, senderWs);
}

function handleActionOnTile(playerId, ws, actionData) {
    const { target, soldiers: amount } = actionData;

    // --- 1. Validate Input ---
    if (!playerId || !target || amount === undefined || amount === null ||
        typeof target.x !== 'number' || typeof target.y !== 'number' ||
        !map[target.y]?.[target.x]) {
        console.error(`Invalid action data received from ${playerId}: ${JSON.stringify(actionData)}`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', payload: 'Invalid action data.' }));
        return;
    }

    const parsedAmount = parseInt(amount, 10); // Ensure amount is integer
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
        console.error(`Invalid soldier amount from ${playerId}: ${amount}`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', payload: 'Soldier amount must be a positive number.' }));
        return;
    }

    const targetTile = map[target.y][target.x];

    // --- 2. Find Valid Adjacent Owned Source Tiles ---
    const adjacentCoords = getAdjacentCoords(target.x, target.y);
    const ownedAdjacentSources = [];
    for (const coord of adjacentCoords) {
        const tile = map[coord.y][coord.x];
        if (tile && tile.owner === playerId && tile.soldiers > 0) {
            ownedAdjacentSources.push({ ...coord, soldiers: tile.soldiers });
        }
    }

    if (ownedAdjacentSources.length === 0) {
        console.log(`Player ${playerId} tried action on tile (${target.x}, ${target.y}) with no owned adjacent tiles.`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', payload: 'Must target a tile adjacent to one you own.' }));
        return;
    }

    // --- 3. Select Source Tile (Strongest Adjacent) ---
    ownedAdjacentSources.sort((a, b) => b.soldiers - a.soldiers);
    const sourceCoord = ownedAdjacentSources[0];
    const sourceTile = map[sourceCoord.y][sourceCoord.x];

    // --- 4. Check if Source Has Enough Soldiers ---
    if (sourceTile.soldiers < parsedAmount) {
        console.log(`Player ${playerId} action failed: Strongest adjacent source (${sourceCoord.x}, ${sourceCoord.y}) only has ${sourceTile.soldiers} soldiers, needed ${parsedAmount}.`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', payload: `Not enough soldiers on strongest adjacent tile (${sourceTile.soldiers} available).` }));
        return;
    }

    // --- 5. Execute Action ---
    console.log(`Player ${playerId} action: ${parsedAmount} soldiers from (${sourceCoord.x},${sourceCoord.y}) to target (${target.x},${target.y})`);
    sourceTile.soldiers -= parsedAmount;

    if (targetTile.owner === playerId) {
        targetTile.soldiers += parsedAmount;
        console.log(`  Reinforced: Target tile now has ${targetTile.soldiers} soldiers.`);
    } else {
        const defenders = targetTile.soldiers;
        const attackResult = defenders - parsedAmount;

        if (attackResult < 0) {
            const remainingAttackers = Math.abs(attackResult);
            const oldOwner = targetTile.owner;
            console.log(`  Capture!: Target tile captured from ${oldOwner || 'Neutral'} with ${remainingAttackers} soldiers remaining.`);
            targetTile.owner = playerId;
            targetTile.soldiers = remainingAttackers;
        } else if (attackResult === 0) {
            targetTile.soldiers = 0;
            console.log(`  Attack Stalemate: Target tile now has 0 soldiers left. Owner: ${targetTile.owner}`);
        } else {
            targetTile.soldiers = attackResult;
            console.log(`  Attack Repelled: Target tile now has ${targetTile.soldiers} soldiers left. Owner: ${targetTile.owner}`);
        }
    }

    // --- 6. Broadcast Update ---
    broadcastMapUpdate();
}

// --- Passive Soldier Generation ---
function startGameTick() {
    if (soldierGenerationIntervalHandle) {
        clearInterval(soldierGenerationIntervalHandle);
    }
    console.log(`Starting soldier generation interval (${SOLDIER_GENERATION_INTERVAL}ms)`);
    soldierGenerationIntervalHandle = setInterval(() => {
        let changed = false;
        for (let y = 0; y < MAP_HEIGHT; y++) {
            for (let x = 0; x < MAP_WIDTH; x++) {
                const tile = map[y][x];
                if (tile.owner !== null) {
                    tile.soldiers += SOLDIERS_PER_TICK;
                    changed = true;
                }
            }
        }
        if (changed && players.size > 0) {
             broadcastMapUpdate();
        }
    }, SOLDIER_GENERATION_INTERVAL);
}

function stopGameTick() {
     if (soldierGenerationIntervalHandle) {
        clearInterval(soldierGenerationIntervalHandle);
        soldierGenerationIntervalHandle = null;
        console.log("Stopped soldier generation interval.");
    }
}


// --- WebSocket Connection Handling ---
wss.on('connection', (ws) => {
    // <<<--- USE THE INCREMENTING COUNTER ---<<<
    const playerId = `player_${nextPlayerNumber}`;
    nextPlayerNumber++; // Increment for the *next* player

    players.set(ws, { playerId: playerId });
    // Log the actual size of the active player map, not the ID number
    console.log(`Player ${playerId} connected. Total active players: ${players.size}`);

    const assigned = assignStartingTile(playerId);
    if (!assigned) {
         console.error(`Failed to assign starting tile for ${playerId}. Disconnecting.`);
         ws.send(JSON.stringify({ type: 'error', payload: 'Could not find a starting position on the map.' }));
         ws.terminate();
         players.delete(ws); // Ensure removal if placement failed
         // No need to decrement nextPlayerNumber here, the number is "used"
         return;
    }

    ws.send(JSON.stringify({
        type: 'initialState',
        payload: {
            playerId: playerId,
            map: map
        }
    }));

     broadcast({ type: 'playerJoined', payload: { playerId } }, ws);
     broadcastMapUpdate();

     // Start tick if it wasn't running and we now have players
     if (!soldierGenerationIntervalHandle && players.size > 0) {
         startGameTick();
     }

    ws.on('message', (message) => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
            const currentPlayerId = getPlayerId(ws);
             if (!currentPlayerId) return;

            console.log(`Received from ${currentPlayerId}: ${JSON.stringify(parsedMessage)}`);

            switch (parsedMessage.type) {
                case 'executeAction':
                    handleActionOnTile(currentPlayerId, ws, parsedMessage.payload);
                    break;
                default:
                    console.log(`Unknown message type from ${currentPlayerId}: ${parsedMessage.type}`);
            }
        } catch (error) {
            const errorPlayerId = getPlayerId(ws) || 'unknown player';
            console.error(`Failed to parse message or handle logic for ${errorPlayerId}:`, message, error);
             if (ws.readyState === WebSocket.OPEN) {
                 ws.send(JSON.stringify({ type: 'error', payload: 'Invalid message format received.' }));
             }
        }
    });

    ws.on('close', () => {
        const playerData = players.get(ws);
        const playerId = playerData ? playerData.playerId : null;

        if (playerId) {
            console.log(`Player ${playerId} disconnected.`);
            players.delete(ws);
            broadcast({ type: 'playerLeft', payload: { playerId } });
            console.log(`Total active players: ${players.size}`);
            console.log(`Tiles owned by ${playerId} remain on the map.`);

            if (players.size === 0) {
                stopGameTick();
            }

        } else {
             console.log("Unknown player disconnected.");
        }
    });

    ws.on('error', (error) => {
        const playerData = players.get(ws);
        const playerId = playerData ? playerData.playerId : 'unknown player';
        console.error(`WebSocket error for player ${playerId}:`, error);
        if (players.has(ws)) {
             players.delete(ws);
              console.log(`Removed player ${playerId} due to WebSocket error. Total active players: ${players.size}`);
             broadcast({ type: 'playerLeft', payload: { playerId } });
            if (players.size === 0) {
                stopGameTick();
            }
        }
    });
});


// --- Route to serve the main HTML file ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});


// --- Start Server ---
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Access the game at: http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nServer shutting down...');
    stopGameTick();
    wss.close(() => {
        console.log('WebSocket server closed.');
        server.close(() => {
            console.log('HTTP server closed.');
            console.log('Server shut down gracefully.');
            process.exit(0);
        });
    });
    setTimeout(() => {
        console.error('Graceful shutdown timed out. Forcing exit.');
        process.exit(1);
    }, 5000);
});