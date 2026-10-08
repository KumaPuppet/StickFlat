// =============================================================
//  GRIMOIRE : distribution des rôles et suivi par le Conteur.
//  Le serveur est le seul à connaître tous les rôles :
//   - le Conteur reçoit le grimoire complet ("grimoire")
//   - chaque joueur reçoit SEULEMENT son rôle ("your_role")
//     (l'Ivrogne reçoit le faux rôle qu'il croit avoir)
// =============================================================
const { ROLES, REMINDERS, getRole, isGood, setupCounts, shuffle } = require("./roles");
const { startFirstNight } = require("./phases");

function send(ws, type, data = {}) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: type, ...data }));
}

function nonST(room) {
  return [...room.players.values()].filter(p => !p.isST);
}

// Ordre des places autour de la table (utile pour l'Empathe, le Cuisinier...)
function ensureSeats(room) {
  const ids = nonST(room).map(p => p.id);
  room.seats = (room.seats || []).filter(id => ids.includes(id));
  for (const id of ids) if (!room.seats.includes(id)) room.seats.push(id);
}

// Le grimoire complet, pour le Conteur uniquement
function sendGrimoire(room) {
  const st = room.storyteller();
  if (!st) return;
  ensureSeats(room);
  const n = room.seats.length;
  send(st.ws, "grimoire", {
    ready: !!room.grim,
    started: !!room.started,
    seats: room.seats,
    players: room.grim ? room.grim.players : {},
    bluffs: room.grim ? room.grim.bluffs : [],
    counts: setupCounts(n, false),
    countsBaron: setupCounts(n, true),
  });
}

// Infos maléfiques pour un joueur ("" sinon) : seul le Démon reçoit quelque chose
// (ses Sbires et 3 rôles pour bluffer). Les Sbires ne reçoivent JAMAIS le nom du Démon.
function evilInfoFor(room, playerId) {
  const g = room.grim && room.grim.players[playerId];
  if (!g || getRole(g.role).team !== "demon") return "";
  const nameOf = id => (room.players.get(id) || { name: "?" }).name;
  const minions = Object.entries(room.grim.players)
    .filter(([, x]) => getRole(x.role).team === "minion").map(([id]) => id);
  return `Tes Sbires sont : ${minions.map(nameOf).join(", ") || "aucun"}. ` +
    `Rôles pas en jeu (pour bluffer) : ${room.grim.bluffs.map(roleName).join(", ")}.`;
}

// Le rôle d'un joueur, envoyé à lui seul (seulement une fois la partie lancée).
// L'équipe maléfique ne voit ses alliés sur sa carte qu'une fois que le Conteur
// a cliqué sur « Infos maléfiques » (rien d'automatique).
function sendYourRole(room, player) {
  if (player.isST || !room.started) return;
  const g = room.grim && room.grim.players[player.id];
  const evil = room.grim && room.grim.evilShared ? evilInfoFor(room, player.id) : "";
  send(player.ws, "your_role", { role: g ? (g.fake || g.role) : "", evil });
}

// Renvoie leur carte à tous les joueurs (ex : un rôle maléfique a changé)
function sendAllRoles(room) {
  for (const p of nonST(room)) sendYourRole(room, p);
}

// Message privé "système" du Conteur vers un joueur (affiché dans le fil privé)
function systemPm(room, target, text) {
  const st = room.storyteller();
  const data = { ch: "st", pid: target.id, from: "Conteur", fromId: st ? st.id : "", text, sys: true };
  send(target.ws, "chat", data);
  if (st) send(st.ws, "chat", data);
}

function roleName(id) {
  const r = getRole(id);
  return r ? r.name : "?";
}

const handlers = {
  // Le Conteur choisit les rôles : on les distribue au hasard
  setup_roles(ws, msg, ctx) {
    const { room } = ctx;
    const players = nonST(room);
    const roles = Array.isArray(msg.roles) ? msg.roles.map(String) : [];
    if (roles.length !== players.length) {
      return send(ws, "error", { msg: `Il faut choisir exactement ${players.length} rôle(s) (un par joueur).` });
    }
    if (new Set(roles).size !== roles.length || !roles.every(getRole)) {
      return send(ws, "error", { msg: "Liste de rôles invalide." });
    }
    // L'Ivrogne croit être un Villageois qui n'est pas en jeu
    let fake = null;
    if (roles.includes("drunk")) {
      fake = String(msg.fake || "");
      const r = getRole(fake);
      if (!r || r.team !== "townsfolk" || roles.includes(fake)) {
        return send(ws, "error", { msg: "Choisis le faux rôle de l'Ivrogne (un Villageois qui n'est pas en jeu)." });
      }
    }

    const shuffled = shuffle([...roles]);
    const grim = { players: {}, bluffs: [] };
    players.forEach((p, i) => {
      grim.players[p.id] = {
        role: shuffled[i],
        fake: shuffled[i] === "drunk" ? fake : "",
        alive: true,
        reminders: [],
      };
    });
    // 3 rôles "bons" pas en jeu, que le Démon pourra prétendre avoir (bluffs)
    const unused = ROLES.filter(r => isGood(r.id) && !roles.includes(r.id) && r.id !== fake && r.id !== "drunk");
    grim.bluffs = shuffle(unused.map(r => r.id)).slice(0, 3);
    room.grim = grim;

    for (const p of players) sendYourRole(room, p);
    room.broadcastPlayers();
    sendGrimoire(room);
    console.log(`[${room.code}] rôles distribués`);
  },

  // Le Conteur modifie un joueur dans le grimoire
  grim_set(ws, msg, ctx) {
    const { room } = ctx;
    const g = room.grim && room.grim.players[msg.pid];
    const target = room.players.get(msg.pid);
    if (!g || !target) return;
    let roleChanged = false;

    if (typeof msg.role === "string" && getRole(msg.role) && msg.role !== g.role) {
      g.role = msg.role;
      if (g.role !== "drunk") g.fake = "";
      roleChanged = true;
    }
    if (typeof msg.fake === "string" && g.role === "drunk") {
      const r = getRole(msg.fake);
      if (r && r.team === "townsfolk") { g.fake = msg.fake; roleChanged = true; }
    }
    if (typeof msg.alive === "boolean" && msg.alive !== g.alive) {
      g.alive = msg.alive;
      room.broadcastPlayers();
    }
    if (Array.isArray(msg.reminders)) {
      g.reminders = msg.reminders.map(String).filter(r => REMINDERS.includes(r));
    }
    if (roleChanged && room.started) {
      sendAllRoles(room); // l'équipe maléfique a pu changer
      systemPm(room, target, `Ton rôle a changé : tu es maintenant ${roleName(g.fake || g.role)}.`);
    }
    sendGrimoire(room);
  },

  // Le Conteur montre un rôle à un joueur (Croque-mort, Gardien de corbeaux...)
  show_role(ws, msg, ctx) {
    const { room } = ctx;
    const target = room.players.get(msg.pid);
    if (!target || target.isST || !getRole(msg.role)) return;
    systemPm(room, target, `Le Conteur te montre le rôle : ${roleName(msg.role)}.`);
  },

  // Le Conteur montre le grimoire à un joueur (l'Espion) pendant quelques secondes
  show_grimoire(ws, msg, ctx) {
    const { room } = ctx;
    const target = room.players.get(msg.pid);
    if (!room.grim || !target || target.isST) return;
    const secs = Math.min(60, Math.max(3, Math.round(Number(msg.seconds) || 15)));
    ensureSeats(room);
    send(target.ws, "grim_peek", { seats: room.seats, players: room.grim.players, ms: secs * 1000 });
    systemPm(room, target, `Le Conteur te montre le grimoire pendant ${secs} secondes.`);
  },

  // Le Conteur referme le grimoire avant la fin du temps
  hide_grimoire(ws, msg, ctx) {
    const target = ctx.room.players.get(msg.pid);
    if (target) send(target.ws, "grim_peek_end");
  },

  // Infos maléfiques : le Démon apprend qui sont ses Sbires et 3 rôles pour bluffer
  // (les Sbires, eux, ne reçoivent rien)
  evil_info(ws, msg, ctx) {
    const { room } = ctx;
    if (!room.grim) return;
    if (!room.started) return send(ws, "error", { msg: "Lance d'abord la partie." });
    room.grim.evilShared = true; // désormais affiché aussi sur leur carte de rôle
    for (const p of nonST(room)) {
      const text = evilInfoFor(room, p.id);
      if (text) systemPm(room, p, text);
    }
    sendAllRoles(room);
    send(ws, "info", { msg: "Infos envoyées au Démon." });
  },

  // Le Conteur lance la partie : chacun découvre son rôle, le chronomètre démarre
  begin(ws, msg, ctx) {
    const { room } = ctx;
    if (!room.grim) return send(ws, "error", { msg: "Distribue d'abord les rôles." });
    if (room.started) return;
    room.started = true;
    room.startedAt = Date.now();
    for (const p of nonST(room)) sendYourRole(room, p);
    room.broadcast("clock", { started: true, elapsed: 0 });
    sendGrimoire(room);
    startFirstNight(room); // la partie commence par la nuit
    console.log(`[${room.code}] partie commencée`);
  },

  // Mélanger les places autour de la table
  seats_shuffle(ws, msg, ctx) {
    ensureSeats(ctx.room);
    shuffle(ctx.room.seats);
    sendGrimoire(ctx.room);
    ctx.room.broadcastPlayers();
  },
};

// On enveloppe chaque action : réservée au Conteur, et pas dans le lobby
const stHandlers = {};
for (const [name, fn] of Object.entries(handlers)) {
  stHandlers[name] = (ws, msg) => {
    const ctx = ws.ctx;
    if (!ctx || !ctx.player.isST || ctx.room.phase === "lobby") return;
    fn(ws, msg, ctx);
  };
}

// Ce que tout le monde sait d'un joueur : vivant ou mort, et sa place
function publicInfo(room, playerId) {
  const g = room.grim && room.grim.players[playerId];
  const seat = room.seats ? room.seats.indexOf(playerId) : -1;
  // ghost : un mort a-t-il encore son vote fantôme ? (information publique)
  return { alive: g ? g.alive : true, seat, ghost: g ? (g.alive || !g.ghostUsed) : true };
}

// À l'arrivée (ou au retour) d'un joueur : on lui renvoie ce qu'il doit savoir
function onWelcome(room, player) {
  if (room.phase === "lobby") return;
  if (player.isST) sendGrimoire(room);
  else sendYourRole(room, player);
}

module.exports = { grimHandlers: stHandlers, sendGrimoire, publicInfo, onWelcome, ROLES, REMINDERS };
