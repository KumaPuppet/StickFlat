// =============================================================
//  Serveur StickFlat
//  - Distribue le jeu (dossier "public", export HTML5 de GameMaker)
//  - Gère les rooms en ligne : création avec un code, rejoindre, reconnexion
//  - Pendant un combat, il ne calcule rien : le jeu de l'hôte (celui qui a créé
//    la room) fait tourner l'arène. Le serveur relaie les commandes des autres
//    joueurs vers l'hôte ("in"), et les images de l'arène de l'hôte vers les autres ("snap").
//  Protocole : chaque message est un objet JSON avec un champ "t" (type)
// =============================================================
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
// Nombre minimum de joueurs pour lancer un combat (1 pour tester seul, 2 pour un vrai combat)
const MIN_PLAYERS = Number(process.env.MIN_PLAYERS || 2);
const NAME_MAX = 16;
const CHAR_MAX = 24;
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

function cleanChar(id) {
  const c = cleanText(id, CHAR_MAX);
  return /^[a-z_]+$/.test(c) ? c : "knight";
}

function send(ws, type, data = {}) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: type, ...data }));
}

// ---------- Rooms ----------
class Room {
  constructor(code) {
    this.code = code;
    this.phase = "lobby"; // "lobby" (choix des persos) ou "match" (combat en cours)
    this.hostId = null;
    /** @type {Map<string, object>} */
    this.players = new Map(); // dans l'ordre d'arrivée = place dans l'arène
    this.emptySince = null;
  }

  addPlayer(name, char, ws) {
    const player = { id: makeId(), token: makeId() + makeId(), name, char, ws, connected: true };
    this.players.set(player.id, player);
    if (!this.hostId) this.hostId = player.id;
    return player;
  }

  host() {
    return this.players.get(this.hostId);
  }

  nameTaken(name) {
    const lower = name.toLowerCase();
    for (const p of this.players.values()) if (p.name.toLowerCase() === lower) return true;
    return false;
  }

  connectedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  publicPlayers() {
    return [...this.players.values()].map(p => ({ id: p.id, name: p.name, char: p.char, connected: p.connected }));
  }

  broadcast(type, data, except = null) {
    for (const p of this.players.values()) if (p !== except) send(p.ws, type, data);
  }

  broadcastPlayers() {
    this.broadcast("players", { players: this.publicPlayers(), hostId: this.hostId });
  }

  welcome(player) {
    send(player.ws, "welcome", {
      code: this.code,
      token: player.token,
      you: { id: player.id, name: player.name },
      hostId: this.hostId,
      phase: this.phase,
      players: this.publicPlayers(),
    });
  }

  // Combat fini (ou interrompu) : tout le monde revient au choix des personnages
  toLobby(info = "") {
    this.phase = "lobby";
    // Ceux qui ont été déconnectés pendant le combat libèrent leur place
    for (const p of [...this.players.values()]) if (!p.connected && p.id !== this.hostId) this.players.delete(p.id);
    this.broadcast("lobby", { info });
    this.broadcastPlayers();
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
  // Créer une room : le créateur devient l'hôte (c'est son jeu qui fera tourner l'arène)
  create(ws, msg) {
    const name = cleanText(msg.name, NAME_MAX);
    if (!name) return send(ws, "error", { msg: "Choisis un pseudo." });
    leaveCurrentRoom(ws);
    const room = new Room(makeRoomCode());
    rooms.set(room.code, room);
    const player = room.addPlayer(name, cleanChar(msg.char), ws);
    ws.ctx = { room, player };
    room.welcome(player);
    console.log(`[${room.code}] créée par ${name}`);
  },

  // Rejoindre une room existante avec son code
  join(ws, msg) {
    const name = cleanText(msg.name, NAME_MAX);
    const code = String(msg.code || "").toUpperCase().trim();
    if (!name) return send(ws, "error", { msg: "Choisis un pseudo." });
    if (!/^[A-Z]{4}$/.test(code)) return send(ws, "error", { msg: "Le code fait 4 lettres." });
    const room = rooms.get(code);
    if (!room) return send(ws, "error", { msg: `La room ${code} n'existe pas.` });
    if (ws.ctx && ws.ctx.room === room) return room.welcome(ws.ctx.player);
    if (room.phase !== "lobby") return send(ws, "error", { msg: "Un combat est en cours dans cette room : attends la fin." });
    if (room.players.size >= MAX_PLAYERS) return send(ws, "error", { msg: `La room est pleine (${MAX_PLAYERS} joueurs).` });
    if (room.nameTaken(name)) return send(ws, "error", { msg: "Ce pseudo est déjà pris dans cette room." });
    leaveCurrentRoom(ws);
    const player = room.addPlayer(name, cleanChar(msg.char), ws);
    ws.ctx = { room, player };
    room.emptySince = null;
    room.welcome(player);
    room.broadcastPlayers();
    console.log(`[${room.code}] ${name} a rejoint`);
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
    // L'hôte a rechargé sa page pendant un combat : l'arène est perdue, retour au choix des persos
    if (room.phase === "match" && player.id === room.hostId) room.toLobby("L'hôte s'est reconnecté : nouveau combat.");
    room.welcome(player);
    room.broadcastPlayers();
    console.log(`[${room.code}] ${player.name} est revenu`);
  },

  // Quitter volontairement la room
  leave(ws) {
    leaveCurrentRoom(ws);
    send(ws, "left");
  },

  // Changer de personnage (dans le lobby)
  char(ws, msg) {
    const ctx = ws.ctx;
    if (!ctx || ctx.room.phase !== "lobby") return;
    ctx.player.char = cleanChar(msg.char);
    ctx.room.broadcastPlayers();
  },

  // L'hôte lance le combat
  start(ws) {
    const ctx = ws.ctx;
    if (!ctx || ctx.player.id !== ctx.room.hostId || ctx.room.phase !== "lobby") return;
    const room = ctx.room;
    const count = room.connectedCount();
    if (count < MIN_PLAYERS) return send(ws, "error", { msg: `Il faut au moins ${MIN_PLAYERS} joueurs pour lancer.` });
    room.phase = "match";
    room.broadcast("start", { players: room.publicPlayers().filter(p => p.connected), hostId: room.hostId });
    console.log(`[${room.code}] combat lancé (${count} joueurs)`);
  },

  // L'hôte arrête le combat : retour au choix des personnages
  lobby(ws) {
    const ctx = ws.ctx;
    if (!ctx || ctx.player.id !== ctx.room.hostId || ctx.room.phase !== "match") return;
    ctx.room.toLobby();
  },

  // Commandes d'un joueur (clavier, souris, choix de bonus) : envoyées à l'hôte
  in(ws, msg) {
    const ctx = ws.ctx;
    if (!ctx || ctx.room.phase !== "match" || ctx.player.id === ctx.room.hostId) return;
    const host = ctx.room.host();
    if (host) send(host.ws, "in", { ...msg, id: ctx.player.id });
  },

  // Image de l'arène calculée par l'hôte : relayée telle quelle aux autres joueurs
  snap(ws, msg, text) {
    const ctx = ws.ctx;
    if (!ctx || ctx.room.phase !== "match" || ctx.player.id !== ctx.room.hostId) return;
    for (const p of ctx.room.players.values()) {
      // Pas de file d'attente : si un joueur a une connexion lente, on saute des images
      // (mieux vaut sauter une image que tout afficher avec une seconde de retard)
      if (p !== ctx.player && p.ws && p.ws.readyState === p.ws.OPEN && p.ws.bufferedAmount < SNAP_BACKLOG) p.ws.send(text);
    }
  },
};

function leaveCurrentRoom(ws) {
  const ctx = ws.ctx;
  if (!ctx) return;
  ws.ctx = null;
  removePlayer(ctx.room, ctx.player);
}

function removePlayer(room, player) {
  room.players.delete(player.id);
  console.log(`[${room.code}] ${player.name} est parti`);
  if (room.players.size === 0) {
    rooms.delete(room.code);
    console.log(`[${room.code}] supprimée (vide)`);
    return;
  }
  // L'hôte part : le joueur suivant devient l'hôte ; un combat en cours s'arrête
  if (player.id === room.hostId) {
    const next = [...room.players.values()].find(p => p.connected) || room.players.values().next().value;
    room.hostId = next.id;
    send(next.ws, "info", { msg: "Tu es maintenant l'hôte de la room." });
    if (room.phase === "match") return room.toLobby(`${player.name} (l'hôte) est parti : combat arrêté.`);
  }
  room.broadcastPlayers();
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
  ".exe": "application/vnd.microsoft.portable-executable",
};

// Version Windows (installateur rangé par construire.ps1) : bouton discret en bas à gauche, refermable
const INDEX_FILE = path.join(PUBLIC_DIR, "index.html");
const WINDOWS_EXE = path.join(PUBLIC_DIR, "telechargement", "StickFlat-Windows.exe");
// Même couleur que PAPER dans le jeu (scr_sketch), sans barres de défilement
// Le canvas est lissé (GameMaker le met en "pixels carrés" quand il est agrandi : jeu pixelisé),
// et les traits sont anticrénelés : GameMaker crée son contexte WebGL avec antialias:false,
// on le force à true avant que le jeu démarre (les stickmen ne sont que des traits fins).
const PAGE_STYLE = `<style>html, body { background: #f4eddc !important; overflow: hidden; }
canvas { image-rendering: auto !important; -webkit-interpolation-mode: bicubic !important; }</style>
<script>(function () {
  var get = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, opts) {
    if (type === "webgl" || type === "webgl2" || type === "experimental-webgl") opts = Object.assign({}, opts || {}, { antialias: true });
    return get.call(this, type, opts);
  };
})();</script>\n`;
// Retard max d'images de l'arène en attente pour un invité (au-delà, on saute des images)
const SNAP_BACKLOG = 48 * 1024;
const DOWNLOAD_BUTTON = `
<div id="dl-win" style="position:fixed;left:10px;bottom:10px;z-index:10;font:13px sans-serif;display:flex;gap:4px">
  <a href="/telechargement/StickFlat-Windows.exe" download
     style="background:#222c;color:#fff;padding:6px 10px;border-radius:6px;text-decoration:none">&#11015; Télécharger pour Windows</a>
  <button onclick="this.parentNode.remove()" title="Masquer"
     style="background:#222c;color:#fff;border:0;border-radius:6px;cursor:pointer">&times;</button>
</div>
`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Petite page pour vérifier que le serveur tourne (utile pour Render)
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end(`Serveur StickFlat en ligne - ${rooms.size} room(s)\n`);
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
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const headers = { "Content-Type": type, "Cache-Control": "no-cache" };
    // L'installateur Windows se télécharge au lieu de s'ouvrir
    if (ext === ".exe") headers["Content-Disposition"] = `attachment; filename="${path.basename(file)}"`;
    // Page du jeu (l'export GameMaker est refait à chaque build) : fond couleur papier autour du jeu
    // au lieu des bandes noires, et bouton "Télécharger pour Windows"
    if (file === INDEX_FILE) {
      let html = data.toString("utf8").replace("</head>", PAGE_STYLE + "</head>");
      if (fs.existsSync(WINDOWS_EXE)) html = html.replace("</body>", DOWNLOAD_BUTTON + "</body>");
      data = Buffer.from(html);
    }
    // "no-cache" : le navigateur vérifie toujours qu'il a la dernière version du jeu
    res.writeHead(200, headers);
    res.end(data);
  });
});

// Les images de l'arène (snap) peuvent être grosses : 1 Mo maximum par message.
// Compression (permessage-deflate) : une image JSON de ~10 Ko n'en fait plus que ~2. Le navigateur
// la propose et décompresse tout seul ; un client qui ne la propose pas reçoit du texte normal.
const wss = new WebSocketServer({
  server,
  maxPayload: 1024 * 1024,
  perMessageDeflate: {
    threshold: 512,                    // les petits messages (commandes des joueurs) partent tels quels
    zlibDeflateOptions: { level: 3 },  // rapide : ~30 images par seconde et par joueur
  },
});

wss.on("connection", ws => {
  ws.ctx = null;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", raw => {
    // GameMaker peut envoyer un caractère nul en fin de texte : on l'enlève
    const text = raw.toString("utf8").replace(/\0+$/, "");
    // Image de l'arène : on la relaie sans la décoder (c'est le message le plus fréquent et le plus gros)
    if (text.startsWith('{"t":"snap"')) return handlers.snap(ws, null, text);
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;
    const handler = Object.hasOwn(handlers, msg.t) && handlers[msg.t];
    if (!handler) return;
    try { handler(ws, msg, text); } catch (err) { console.error("Erreur:", err); }
  });

  ws.on("close", () => {
    const ctx = ws.ctx;
    if (!ctx) return;
    const { room, player } = ctx;
    // Dans le choix des persos, on libère la place tout de suite ; pendant un combat,
    // on garde le joueur : il pourra revenir avec son token
    if (room.phase === "lobby") {
      ws.ctx = null;
      return removePlayer(room, player);
    }
    player.connected = false;
    player.ws = null;
    if (room.connectedCount() === 0) room.emptySince = Date.now();
    // L'hôte a disparu pendant le combat : plus personne ne fait tourner l'arène
    if (player.id === room.hostId) {
      const next = [...room.players.values()].find(p => p.connected);
      if (next) {
        room.hostId = next.id;
        room.toLobby(`${player.name} (l'hôte) a été déconnecté : combat arrêté.`);
        return;
      }
    }
    room.broadcastPlayers();
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
  console.log(`Serveur StickFlat démarré sur le port ${PORT}`);
});
