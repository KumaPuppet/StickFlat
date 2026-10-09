// =============================================================
//  Serveur Blood on the Moon
//  - Gère les rooms (création, code, rejoindre, reconnexion)
//  - Gère la maison (déplacements) et les conversations
//  - C'est lui qui décide ce que chaque joueur a le droit de voir
//  Protocole : chaque message est un objet JSON avec un champ "t" (type)
// =============================================================
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { LOCATIONS, START, zoneExists, cancelMove } = require("./house");
const { updateVoice } = require("./voice");
const { grimHandlers, sendGrimoire, publicInfo, onWelcome, ROLES, REMINDERS } = require("./grimoire");
const { phaseHandlers, isNight } = require("./phases");
const { voteHandlers, publicVotes, stopVote, gameOverData } = require("./votes");
const { speakHandlers, resetSpeak } = require("./speak");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 20;          // 15 joueurs + 5 voyageurs
// Nombre minimum de joueurs pour lancer (1 pour tester seul, 5 pour une vraie partie)
const MIN_PLAYERS = Number(process.env.MIN_PLAYERS || 1);
const NAME_MAX = 16;
const CHAT_MAX = 300;            // longueur max d'un message
const JOIN_DELAY_MS = Number(process.env.JOIN_DELAY_MS ?? 0);    // décompte avant d'entrer dans une room (0 = direct)
const MOVE_DELAY_MS = Number(process.env.MOVE_DELAY_MS ?? 2000); // décompte avant d'entrer dans une autre salle de la maison
const ZONE_DELAY_MS = Number(process.env.ZONE_DELAY_MS ?? 1500); // décompte pour changer de coin dans la même salle
const EMPTY_ROOM_TTL = 10 * 60 * 1000; // room supprimée après 10 min sans personne connecté

/** @type {Map<string, Room>} */
const rooms = new Map();

// ---------- Utilitaires ----------
function makeRoomCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // sans I ni O (confusion avec 1 et 0)
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += letters[crypto.randomInt(letters.length)];
  } while (rooms.has(code));
  return code;
}

function makeId() {
  return crypto.randomBytes(6).toString("hex");
}

function cleanText(text, max) {
  if (typeof text !== "string") return "";
  return text.replace(/[\x00-\x1f]/g, "").trim().slice(0, max);
}

function send(ws, type, data = {}) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ t: type, ...data }));
  }
}

// ---------- Rooms ----------
class Room {
  constructor(code) {
    this.code = code;
    this.phase = "lobby";
    this.storytellerId = null;
    /** @type {Map<string, Player>} */
    this.players = new Map();
    this.emptySince = null;
    this.stTalk = "none";   // vocal du Conteur : "none", "all" ou id d'un joueur
    this.stListen = "none"; // écoute du Conteur : "none", "all" ou "lieu/zone"
    this.pending = [];      // joueurs en train d'arriver (décompte de 2 secondes)
    resetSpeak(this);       // micros coupés, mains levées (voir speak.js)
  }

  addPlayer(name, ws, isST) {
    const player = {
      id: makeId(), token: makeId() + makeId(), name, ws, isST, connected: true,
      loc: START.loc, zone: START.zone, lastChat: 0,
      voiceWs: null, voiceSid: null, // connexion vocale (séparée de la connexion du jeu)
    };
    this.players.set(player.id, player);
    if (isST) this.storytellerId = player.id;
    return player;
  }

  storyteller() {
    return this.players.get(this.storytellerId);
  }

  nameTaken(name) {
    const lower = name.toLowerCase();
    for (const p of this.players.values()) if (p.name.toLowerCase() === lower) return true;
    for (const p of this.pending) if (p.name.toLowerCase() === lower) return true;
    return false;
  }

  // Ce que tout le monde voit de la liste des joueurs (aucune info secrète ici)
  publicPlayers() {
    return [...this.players.values()].map(p => ({
      id: p.id, name: p.name, isST: p.isST, connected: p.connected,
      ...publicInfo(this, p.id), // vivant/mort et place autour de la table
    }));
  }

  // Qui est où, du point de vue de "viewer" (le Conteur n'a pas de position) :
  //  - le Conteur voit tout le monde
  //  - un joueur ne voit que les gens de sa salle (on ne sait pas qui est au jardin depuis le salon)
  positionsFor(viewer) {
    const pos = {};
    const seeAll = !viewer || viewer.isST;
    for (const p of this.players.values()) {
      if (p.isST) continue;
      if (seeAll || p === viewer || p.loc === viewer.loc) pos[p.id] = { loc: p.loc, zone: p.zone };
    }
    return pos;
  }

  broadcast(type, data) {
    for (const p of this.players.values()) send(p.ws, type, data);
  }

  broadcastPlayers() {
    this.broadcast("players", { players: this.publicPlayers() });
  }

  // Chaque joueur reçoit SA version des positions
  broadcastPositions() {
    for (const p of this.players.values()) send(p.ws, "positions", { positions: this.positionsFor(p) });
  }

  welcome(player) {
    send(player.ws, "welcome", {
      code: this.code,
      token: player.token,
      you: { id: player.id, name: player.name, isST: player.isST },
      phase: this.phase,
      players: this.publicPlayers(),
      locations: LOCATIONS,
      positions: this.positionsFor(player),
      roles: ROLES,
      reminders: REMINDERS,
      started: !!this.started,                                    // partie lancée ?
      elapsed: this.started ? Date.now() - this.startedAt : 0,   // temps écoulé (ms)
      time: this.time || { kind: "setup", n: 0 },               // jour / nuit
      votes: publicVotes(this),                                    // nominations du jour
      gameOver: this.ended ? gameOverData(this) : null,           // partie terminée ?
    });
    onWelcome(this, player);
  }

  connectedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }
}

// Retrouve un joueur grâce à son code de room et sa clé secrète (token)
function findByToken(code, token) {
  const room = rooms.get(String(code || "").toUpperCase());
  const player = room && typeof token === "string" && [...room.players.values()].find(p => p.token === token);
  return player ? { room, player } : null;
}

// ---------- Traitement des messages ----------
const handlers = {
  // Créer une room : le créateur devient le Conteur
  create(ws, msg) {
    const name = cleanText(msg.name, NAME_MAX);
    if (!name) return send(ws, "error", { msg: "Choisis un pseudo." });
    leaveCurrentRoom(ws);
    const room = new Room(makeRoomCode());
    rooms.set(room.code, room);
    const player = room.addPlayer(name, ws, true);
    ws.ctx = { room, player };
    room.welcome(player);
    console.log(`[${room.code}] créée par ${name}`);
  },

  // Rejoindre une room existante avec son code
  join(ws, msg) {
    const name = cleanText(msg.name, NAME_MAX);
    const code = String(msg.code || "").toUpperCase().trim();
    if (!name) return send(ws, "error", { msg: "Choisis un pseudo." });
    const room = rooms.get(code);
    if (!room) return send(ws, "error", { msg: `La room ${code} n'existe pas.` });
    if (room.phase !== "lobby") return send(ws, "error", { msg: "La partie a déjà commencé." });
    if (room.players.size + room.pending.length >= MAX_PLAYERS + 1) return send(ws, "error", { msg: "La room est pleine." });
    if (room.nameTaken(name)) return send(ws, "error", { msg: "Ce pseudo est déjà pris dans cette room." });
    if (ws.pendingJoin) return; // déjà en train d'entrer quelque part
    leaveCurrentRoom(ws);

    // Décompte avant d'entrer : le joueur et ceux déjà présents le voient
    const pend = { name, ws, timer: null };
    room.pending.push(pend);
    ws.pendingJoin = { room, pend };
    send(ws, "joining", { code: room.code, ms: JOIN_DELAY_MS });
    room.broadcast("incoming", { name, ms: JOIN_DELAY_MS });

    pend.timer = setTimeout(() => {
      room.pending = room.pending.filter(x => x !== pend);
      ws.pendingJoin = null;
      if (ws.readyState !== ws.OPEN) return;
      if (rooms.get(room.code) !== room || room.phase !== "lobby") {
        room.broadcast("incoming_cancel", { name });
        return send(ws, "error", { msg: "Impossible d'entrer : la partie a commencé." });
      }
      const player = room.addPlayer(name, ws, false);
      ws.ctx = { room, player };
      room.emptySince = null;
      room.welcome(player);
      room.broadcastPlayers();
      room.broadcastPositions();
      updateVoice(room);
      console.log(`[${room.code}] ${name} a rejoint`);
    }, JOIN_DELAY_MS);
  },

  // Revenir dans sa room après une coupure ou un rechargement de page
  rejoin(ws, msg) {
    const found = findByToken(msg.code, msg.token);
    if (!found) return send(ws, "rejoin_failed", { msg: "Impossible de revenir dans cette room." });
    const { room, player } = found;
    if (player.ws && player.ws !== ws) {
      player.ws.ctx = null;
      player.ws.close();
    }
    player.ws = ws;
    player.connected = true;
    ws.ctx = { room, player };
    room.emptySince = null;
    room.welcome(player);
    room.broadcastPlayers();
    updateVoice(room);
    console.log(`[${room.code}] ${player.name} est revenu`);
  },

  // Le Conteur renvoie tout le monde au lobby (après une partie, pour en rejouer une)
  back_to_lobby(ws) {
    const ctx = ws.ctx;
    if (!ctx || !ctx.player.isST || ctx.room.phase === "lobby") return;
    const room = ctx.room;
    stopVote(room);
    room.phase = "lobby";
    room.started = false;
    room.ended = null;
    room.grim = null;
    room.day = null;
    room.time = { kind: "setup", n: 0 };
    room.stTalk = "none";
    room.stListen = "none";
    resetSpeak(room);
    room.broadcast("phase", { phase: room.phase });
    room.broadcast("clock", { started: false, elapsed: 0 });
    room.broadcastPlayers();
    updateVoice(room);
    console.log(`[${room.code}] retour au lobby`);
  },

  // Quitter volontairement la room
  leave(ws) {
    leaveCurrentRoom(ws);
    send(ws, "left");
  },

  // Le Conteur lance la partie : tout le monde arrive sur la place
  start(ws) {
    const ctx = ws.ctx;
    if (!ctx || !ctx.player.isST || ctx.room.phase !== "lobby") return;
    const room = ctx.room;
    const count = room.players.size - 1;
    if (count < MIN_PLAYERS) {
      return send(ws, "error", { msg: `Il faut au moins ${MIN_PLAYERS} joueur(s) en plus du Conteur.` });
    }
    room.phase = "game";
    room.stTalk = "none";
    room.stListen = "none";
    resetSpeak(room);
    room.grim = null; // les rôles seront distribués par le Conteur
    room.started = false; // puis il lancera la partie (rôles révélés + chronomètre)
    room.time = { kind: "setup", n: 0 };
    room.seats = [];
    for (const p of room.players.values()) { cancelMove(p); p.loc = START.loc; p.zone = START.zone; }
    room.broadcastPositions();
    room.broadcast("phase", { phase: room.phase });
    sendGrimoire(room);   // fixe aussi l'ordre des places
    room.broadcastPlayers();
    updateVoice(room);
    console.log(`[${room.code}] préparation lancée (${count} joueurs)`);
  },

  // Un joueur se déplace dans une zone de la maison
  move(ws, msg) {
    const ctx = ws.ctx;
    if (!ctx || ctx.player.isST || ctx.room.phase === "lobby") return;
    const { room, player } = ctx;
    if (!zoneExists(msg.loc, msg.zone)) return;
    if (isNight(room)) return; // la nuit, on ne bouge pas
    if (room.gathered) return; // rassemblement : tout le monde reste à la table
    cancelMove(player); // un nouveau clic remplace le déplacement en cours
    if (player.loc === msg.loc && player.zone === msg.zone) return;

    const placePlayer = () => {
      player.loc = msg.loc;
      player.zone = msg.zone;
      room.broadcastPositions();
      updateVoice(room);
    };
    // Décompte avant d'arriver, pendant lequel on reste (et on entend) là où on était :
    //  - autre coin de la même salle : 1,5 s
    //  - autre salle : 2 s
    const sameRoom = player.loc === msg.loc;
    const delay = sameRoom ? ZONE_DELAY_MS : MOVE_DELAY_MS;
    if (delay <= 0) return placePlayer();
    send(ws, "moving", { loc: msg.loc, zone: msg.zone, ms: delay });
    // Autre salle : les gens déjà dans la salle d'arrivée sont prévenus ("Untel arrive...")
    player.moveWatchers = [];
    if (!sameRoom) {
      for (const p of room.players.values()) {
        if (p.isST || p === player || p.loc !== msg.loc) continue;
        send(p.ws, "arriving", { id: player.id, name: player.name, ms: delay });
        player.moveWatchers.push(p.ws);
      }
    }
    player.moveTimer = setTimeout(() => {
      player.moveTimer = null;
      player.moveWatchers = [];
      if (!room.players.has(player.id) || room.phase === "lobby" || isNight(room) || room.gathered) {
        return send(player.ws, "moving_cancel");
      }
      placePlayer();
    }, delay);
  },

  // Le Conteur règle son vocal : qui il écoute et à qui il parle
  st_voice(ws, msg) {
    const ctx = ws.ctx;
    if (!ctx || !ctx.player.isST) return;
    const room = ctx.room;
    const listen = String(msg.listen || "none");
    const talk = String(msg.talk || "none");
    const [loc, zone] = listen.split("/");
    if (listen === "none" || listen === "all" || zoneExists(loc, zone)) room.stListen = listen;
    const target = room.players.get(talk);
    if (talk === "none" || talk === "all" || (target && !target.isST)) room.stTalk = talk;
    updateVoice(room);
  },

  // ----- Connexion vocale (deuxième connexion, ouverte par l'extension JavaScript) -----
  voice_hello(ws, msg) {
    const found = findByToken(msg.code, msg.token);
    if (!found) return send(ws, "v_error", { msg: "Room introuvable pour le vocal." });
    const { room, player } = found;
    if (player.voiceWs && player.voiceWs !== ws) {
      player.voiceWs.voiceCtx = null;
      player.voiceWs.close();
    }
    player.voiceWs = ws;
    player.voiceSid = makeId(); // change à chaque connexion : les autres savent qu'il faut se reconnecter
    ws.voiceCtx = { room, player };
    updateVoice(room);
    console.log(`[${room.code}] ${player.name} a activé le vocal`);
  },

  // Message technique WebRTC à faire passer à un autre joueur
  v_signal(ws, msg) {
    const ctx = ws.voiceCtx;
    if (!ctx || ctx.player.voiceWs !== ws) return;
    const target = ctx.room.players.get(msg.to);
    if (!target || !target.voiceWs) return;
    send(target.voiceWs, "v_signal", { from: ctx.player.id, sid: ctx.player.voiceSid, data: msg.data });
  },

  // Un message écrit privé
  //  scope "st"   : joueur -> Conteur (privé)
  //  scope "pm"   : Conteur -> un joueur (privé), avec "to" = id du joueur
  say(ws, msg) {
    const ctx = ws.ctx;
    if (!ctx || ctx.room.phase === "lobby") return;
    const { room, player } = ctx;
    const text = cleanText(msg.text, CHAT_MAX);
    if (!text) return;
    // Anti-spam : pas plus d'un message toutes les 300 ms
    const now = Date.now();
    if (now - player.lastChat < 300) return;
    player.lastChat = now;

    if (msg.scope === "st" && !player.isST) {
      const data = { ch: "st", pid: player.id, from: player.name, fromId: player.id, text };
      send(player.ws, "chat", data);
      const st = room.storyteller();
      if (st) send(st.ws, "chat", data);
    } else if (msg.scope === "pm" && player.isST) {
      const target = room.players.get(msg.to);
      if (!target || target.isST) return;
      const data = { ch: "st", pid: target.id, from: player.name, fromId: player.id, text };
      send(target.ws, "chat", data);
      send(player.ws, "chat", data);
    }
  },
};

// Actions du grimoire (réservées au Conteur)
Object.assign(handlers, grimHandlers, phaseHandlers, voteHandlers, speakHandlers);

function leaveCurrentRoom(ws) {
  const ctx = ws.ctx;
  if (!ctx) return;
  ws.ctx = null;
  const { room, player } = ctx;
  room.players.delete(player.id);
  console.log(`[${room.code}] ${player.name} est parti`);
  if (player.voiceWs) {
    player.voiceWs.voiceCtx = null;
    player.voiceWs.close();
    player.voiceWs = null;
  }
  if (room.stTalk === player.id) room.stTalk = "none";
  if (room.grim) delete room.grim.players[player.id];

  if (room.players.size === 0) {
    rooms.delete(room.code);
    console.log(`[${room.code}] supprimée (vide)`);
    return;
  }
  // Si le Conteur part, le joueur suivant devient Conteur (uniquement dans le lobby)
  if (player.isST && room.phase === "lobby") {
    const next = room.players.values().next().value;
    next.isST = true;
    room.storytellerId = next.id;
    send(next.ws, "info", { msg: "Tu es maintenant le Conteur." });
  }
  room.broadcastPlayers();
  room.broadcastPositions();
  if (room.phase !== "lobby") sendGrimoire(room);
  updateVoice(room);
}

// ---------- Serveur HTTP + WebSocket ----------
// Le serveur distribue aussi le jeu : les fichiers exportés par GameMaker (HTML5)
// sont rangés dans le dossier "public".
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".gif": "image/gif", ".ico": "image/x-icon", ".svg": "image/svg+xml",
  ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8", ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Petite page pour vérifier que le serveur tourne (utile pour Render)
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(`Serveur Blood on the Moon en ligne - ${rooms.size} room(s)\n`);
  }

  // Fichiers du jeu (on refuse tout chemin qui sortirait du dossier "public")
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { rel = "/"; }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end(rel.endsWith("index.html")
        ? "Le jeu n'est pas encore installé : exporte-le en HTML5 dans server/public.\n"
        : "Introuvable\n");
    }
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    // "no-cache" : le navigateur vérifie toujours qu'il a la dernière version du jeu
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on("connection", ws => {
  ws.ctx = null;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", raw => {
    // GameMaker peut envoyer un caractère nul en fin de texte : on l'enlève
    const text = raw.toString("utf8").replace(/\0+$/, "");
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;
    const handler = Object.hasOwn(handlers, msg.t) && handlers[msg.t];
    if (!handler) return;
    try { handler(ws, msg); } catch (err) { console.error("Erreur:", err); }
  });

  ws.on("close", () => {
    // Quelqu'un qui partait avant la fin de son décompte d'arrivée
    if (ws.pendingJoin) {
      const { room, pend } = ws.pendingJoin;
      clearTimeout(pend.timer);
      room.pending = room.pending.filter(x => x !== pend);
      room.broadcast("incoming_cancel", { name: pend.name });
      ws.pendingJoin = null;
    }
    // Fermeture d'une connexion vocale
    const vctx = ws.voiceCtx;
    if (vctx && vctx.player.voiceWs === ws) {
      vctx.player.voiceWs = null;
      updateVoice(vctx.room);
    }
    const ctx = ws.ctx;
    if (!ctx) return;
    // On garde le joueur dans la room : il pourra revenir avec son token
    ctx.player.connected = false;
    ctx.player.ws = null;
    if (ctx.room.connectedCount() === 0) ctx.room.emptySince = Date.now();
    ctx.room.broadcastPlayers();
  });
});

// Vérifie régulièrement les connexions mortes et les rooms abandonnées
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL) {
      rooms.delete(code);
      console.log(`[${code}] supprimée (abandonnée)`);
    }
  }
}, 30 * 1000);

server.listen(PORT, () => {
  console.log(`Serveur Blood on the Moon démarré sur le port ${PORT}`);
});
