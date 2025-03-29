const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const PORT = process.env.PORT || 3000;
const MAP_WIDTH = 15;
const MAP_HEIGHT = 15;
const INITIAL_SOLDIERS_NEUTRAL = 5;
const INITIAL_SOLDIERS_START_PLAYER = 20;
const SOLDIER_GENERATION_INTERVAL = 1000;
const SOLDIERS_PER_TICK = 1;
const SERVER_TICK_RATE_MS = 100;
const LOCALSTORAGE_KEY = 'factionsGamePlayerId';
const MAX_DISPLAY_NAME_LENGTH = 16;

let map = initializeMap();
let players = new Map();
let activePlayerConnections = new Map();
let playerDisplayNames = new Map();

let mainGameLoopIntervalHandle = null;
let mapStateChangedSinceLastTick = false;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));

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

function sanitizeDisplayName(name) {
    if (typeof name !== 'string') return '';
    let cleanName = name.trim();
    if (cleanName.length > MAX_DISPLAY_NAME_LENGTH) {
        cleanName = cleanName.substring(0, MAX_DISPLAY_NAME_LENGTH);
    }
    cleanName = cleanName.replace(/</g, "<").replace(/>/g, ">").replace(/&/g, "&");
    return cleanName;
}

function initializeMap() {
    console.log("Initializing map...");
    const newMap = [];
    for (let y = 0; y < MAP_HEIGHT; y++) {
        newMap[y] = [];
        for (let x = 0; x < MAP_WIDTH; x++) {
            newMap[y][x] = { soldiers: INITIAL_SOLDIERS_NEUTRAL, owner: null };
        }
    }
    console.log(`Map initialized (${MAP_WIDTH}x${MAP_HEIGHT}).`);
    return newMap;
}

function assignStartingTile(playerId) {
    let existingTileCount = 0;
    for (let y = 0; y < MAP_HEIGHT; y++) {
        for (let x = 0; x < MAP_WIDTH; x++) {
            if (map[y][x].owner === playerId) {
                existingTileCount++;
                break;
            }
        }
         if (existingTileCount > 0) break;
    }
    if (existingTileCount > 0) {
        console.log(`Player ${playerId} already has tiles.`);
        return true;
    }

    const neutralTiles = [];
    for (let y = 0; y < MAP_HEIGHT; y++) { for (let x = 0; x < MAP_WIDTH; x++) { if (map[y][x].owner === null) { neutralTiles.push({ x, y }); } } }
    if (neutralTiles.length === 0) { console.warn(`No neutral tiles for NEW player ${playerId}!`); return false; }

    const randomIndex = Math.floor(Math.random() * neutralTiles.length);
    const startTileCoords = neutralTiles[randomIndex];
    const tile = map[startTileCoords.y][startTileCoords.x];
    tile.owner = playerId;
    tile.soldiers = INITIAL_SOLDIERS_START_PLAYER;
    console.log(`Assigned NEW starting tile (${startTileCoords.x}, ${startTileCoords.y}) to ${playerId}`);
    mapStateChangedSinceLastTick = true;
    return true;
}

function getPlayerIdFromWebSocket(ws) {
    const playerData = players.get(ws);
    return playerData ? playerData.playerId : null;
}

function broadcast(data) {
    const message = JSON.stringify(data);
    players.forEach((playerData, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
        }
    });
}

function broadcastMapUpdate() {
    const displayNamesObject = Object.fromEntries(playerDisplayNames);
    // Only broadcast if there are players to receive it
    if (activePlayerConnections.size > 0) {
        broadcast({
            type: 'mapUpdate',
            payload: {
                map: map,
                displayNames: displayNamesObject
            }
        });
    } else {
        // console.log("Skipping map broadcast: No players connected.");
    }
}

function handleActionOnTile(playerId, ws, actionData) {
    const { target, soldiers: amount } = actionData;
    if (!playerId || !target || amount === undefined || amount === null ||
        typeof target.x !== 'number' || typeof target.y !== 'number' ||
        !map[target.y]?.[target.x]) {
        console.error(`Invalid action data received from ${playerId}: ${JSON.stringify(actionData)}`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', payload: 'Invalid action data.' }));
        return;
    }
    const parsedAmount = parseInt(amount, 10);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
         console.error(`Invalid soldier amount from ${playerId}: ${amount}`);
         if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', payload: 'Soldier amount must be a positive number.' }));
         return;
    }
    const targetTile = map[target.y][target.x];

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

    ownedAdjacentSources.sort((a, b) => b.soldiers - a.soldiers);
    const sourceCoord = ownedAdjacentSources[0];
    const sourceTile = map[sourceCoord.y][sourceCoord.x];

    if (sourceTile.soldiers < parsedAmount) {
         console.log(`Player ${playerId} action failed: Strongest adjacent source (${sourceCoord.x}, ${sourceCoord.y}) only has ${sourceTile.soldiers} soldiers, needed ${parsedAmount}.`);
         if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', payload: `Not enough soldiers on strongest adjacent tile (${sourceTile.soldiers} available).` }));
         return;
    }

    console.log(`Player ${playerId} action processing: ${parsedAmount} soldiers from (${sourceCoord.x},${sourceCoord.y}) to target (${target.x},${target.y})`);
    sourceTile.soldiers -= parsedAmount;

    if (targetTile.owner === playerId) {
        targetTile.soldiers += parsedAmount;
    } else {
        const defenders = targetTile.soldiers;
        const attackResult = defenders - parsedAmount;
        if (attackResult < 0) {
            const oldOwner = targetTile.owner;
            targetTile.owner = playerId;
            targetTile.soldiers = Math.abs(attackResult);
            console.log(`  Capture!: Target tile captured from ${playerDisplayNames.get(oldOwner) || oldOwner || 'Neutral'} by ${playerDisplayNames.get(playerId)||playerId} with ${targetTile.soldiers} soldiers remaining.`);
        } else if (attackResult === 0) {
            targetTile.soldiers = 0;
            console.log(`  Attack Stalemate: Target tile now has 0 soldiers left.`);
        } else {
            targetTile.soldiers = attackResult;
             console.log(`  Attack Repelled: Target tile now has ${targetTile.soldiers} soldiers left.`);
        }
    }
    mapStateChangedSinceLastTick = true;
}

function handleSetDisplayName(playerId, ws, nameData) {
    const newName = sanitizeDisplayName(nameData.name);

    if (!newName) {
        console.log(`Player ${playerId} tried to set an empty/invalid name.`);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', payload: 'Display name cannot be empty or invalid.' }));
        return;
    }

    const oldName = playerDisplayNames.get(playerId);
    if (newName !== oldName) {
        playerDisplayNames.set(playerId, newName);
        console.log(`Player ${playerId} set display name to: ${newName}`);
        mapStateChangedSinceLastTick = true;
    } else {
        console.log(`Player ${playerId} tried to set same name: ${newName}`);
    }
}

let lastSoldierGenerationTime = Date.now();
function generatePassiveSoldiers() {
    const now = Date.now();
    if (now - lastSoldierGenerationTime >= SOLDIER_GENERATION_INTERVAL) {
        let generated = false;
        for (let y = 0; y < MAP_HEIGHT; y++) {
            for (let x = 0; x < MAP_WIDTH; x++) {
                const tile = map[y][x];
                if (tile.owner !== null) {
                    tile.soldiers += SOLDIERS_PER_TICK;
                    generated = true;
                }
            }
        }
        if (generated) {
            mapStateChangedSinceLastTick = true;
        }
        lastSoldierGenerationTime = now;
    }
}

function gameTick() {
    generatePassiveSoldiers();
    if (mapStateChangedSinceLastTick) {
        broadcastMapUpdate();
        mapStateChangedSinceLastTick = false;
    }
}

function startGameLoop() {
    if (mainGameLoopIntervalHandle) {
        // console.log("Game loop already running."); // Less verbose
        return;
    }
    console.log(`Starting main game loop (Tick Rate: ${SERVER_TICK_RATE_MS}ms)`);
    lastSoldierGenerationTime = Date.now();
    mainGameLoopIntervalHandle = setInterval(gameTick, SERVER_TICK_RATE_MS);
}

// Function remains but is no longer called automatically
function stopGameLoop() {
    if (mainGameLoopIntervalHandle) {
        clearInterval(mainGameLoopIntervalHandle);
        mainGameLoopIntervalHandle = null;
        console.log("Stopped main game loop.");
    }
}

wss.on('connection', (ws, req) => {
    console.log("WebSocket connection opened. Waiting for identification.");

    ws.on('message', (message) => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
            const currentPlayerId = getPlayerIdFromWebSocket(ws);

            if (parsedMessage.type === 'identifyPlayer') {
                const receivedPlayerId = parsedMessage.payload.playerId;
                if (!receivedPlayerId || typeof receivedPlayerId !== 'string' || receivedPlayerId.length < 5) {
                    console.error("Invalid player ID received for identification:", receivedPlayerId);
                    ws.send(JSON.stringify({ type: 'error', payload: 'Invalid identification attempt.' }));
                    ws.terminate(); return;
                }
                if (currentPlayerId) { console.warn(`Connection already identified as ${currentPlayerId}`); return; }
                if (activePlayerConnections.has(receivedPlayerId)) {
                    console.warn(`Player ${receivedPlayerId} is already connected. Terminating new connection.`);
                    ws.send(JSON.stringify({ type: 'error', payload: 'You are already connected in another window/tab.' }));
                    ws.terminate(); return;
                }

                console.log(`Identifying connection as Player ${receivedPlayerId}`);
                players.set(ws, { playerId: receivedPlayerId });
                activePlayerConnections.set(receivedPlayerId, ws);

                if (!playerDisplayNames.has(receivedPlayerId)) { playerDisplayNames.set(receivedPlayerId, receivedPlayerId); }

                const assigned = assignStartingTile(receivedPlayerId);
                if (!assigned) {
                    console.error(`Failed to assign starting tile for ${receivedPlayerId}. Disconnecting.`);
                    ws.send(JSON.stringify({ type: 'error', payload: 'Could not find a starting position on the map.' }));
                    ws.terminate(); return;
                }

                ws.send(JSON.stringify({
                    type: 'initialState',
                    payload: { playerId: receivedPlayerId, map: map, displayNames: Object.fromEntries(playerDisplayNames) }
                }));

                broadcast({ type: 'playerJoined', payload: { playerId: receivedPlayerId, displayName: playerDisplayNames.get(receivedPlayerId) } });
                // Start loop if not already running
                if (!mainGameLoopIntervalHandle) { startGameLoop(); }
                return;
            }

            if (!currentPlayerId) { console.warn("Received non-identify message before identified."); return; }

            console.log(`Received from ${playerDisplayNames.get(currentPlayerId) || currentPlayerId}: ${JSON.stringify(parsedMessage.type)}`);
            switch (parsedMessage.type) {
                case 'executeAction':
                    handleActionOnTile(currentPlayerId, ws, parsedMessage.payload);
                    break;
                case 'setDisplayName':
                    handleSetDisplayName(currentPlayerId, ws, parsedMessage.payload);
                    break;
                default:
                    console.log(`Unknown message type from ${currentPlayerId}: ${parsedMessage.type}`);
            }
        } catch (error) {
             const errorPlayerId = getPlayerIdFromWebSocket(ws) || 'unidentified';
             console.error(`Failed to handle message for ${errorPlayerId}:`, error);
             if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'error', payload: 'Invalid message format received.' })); }
        }
    });

    ws.on('close', () => {
        const playerData = players.get(ws);
        const closedPlayerId = playerData ? playerData.playerId : null;

        if (closedPlayerId) {
            const displayName = playerDisplayNames.get(closedPlayerId) || closedPlayerId;
            console.log(`Player ${displayName} disconnected.`);
            players.delete(ws);
            activePlayerConnections.delete(closedPlayerId);
            broadcast({ type: 'playerLeft', payload: { playerId: closedPlayerId } });
            console.log(`Total active players: ${activePlayerConnections.size}`);
            // REMOVED: if (activePlayerConnections.size === 0 && mainGameLoopIntervalHandle) { stopGameLoop(); }
        } else { console.log("Unidentified player disconnected."); }
    });

    ws.on('error', (error) => {
         const playerData = players.get(ws);
         const errorPlayerId = playerData ? playerData.playerId : 'unidentified';
         const displayName = errorPlayerId !== 'unidentified' ? playerDisplayNames.get(errorPlayerId) : errorPlayerId;
         console.error(`WebSocket error for player ${displayName}:`, error);
         if (players.has(ws)) { players.delete(ws); }
         if (playerData) {
            activePlayerConnections.delete(playerData.playerId);
            broadcast({ type: 'playerLeft', payload: { playerId: playerData.playerId } });
         }
         console.log(`Total active players: ${activePlayerConnections.size}`);
         // REMOVED: if (activePlayerConnections.size === 0 && mainGameLoopIntervalHandle) { stopGameLoop(); }
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Access the game at: http://localhost:${PORT}`);
    // Start the game loop immediately on server start, or keep starting on first connect?
    // Let's keep starting on first connect for now. If you want it always running:
    // startGameLoop();
});

process.on('SIGINT', () => {
    console.log('\nServer shutting down...');
    // Loop might still be running, but we stop broadcasting/processing new things
    if (mainGameLoopIntervalHandle) {
        clearInterval(mainGameLoopIntervalHandle); // Ensure interval stops on shutdown
        console.log("Stopped game loop due to shutdown.");
    }
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
    }, 500);
});