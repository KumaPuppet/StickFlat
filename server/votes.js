// =============================================================
//  NOMINATIONS, VOTES, EXÉCUTION, FIN DE PARTIE
//
//  room.day = {
//    open: nominations ouvertes ?,
//    nominators: [ids qui ont déjà nommé aujourd'hui],
//    nominees:   [ids déjà nommés aujourd'hui],
//    history:    [{ by, target, votes, onBlock }],
//    block:      { pid, votes } | null   (le joueur "sur le billot")
//    top:        meilleur score du jour (pour gérer les égalités)
//    current:    le vote en cours | null
//  }
//  Un vote : { nominee, nominator, status: "pending"|"counting"|"done",
//              order: [ids dans l'ordre du décompte], index, hands: {id: true},
//              locked: {id: true/false}, votes, required }
// =============================================================
const VOTE_STEP_MS = 1200; // temps entre deux joueurs pendant le décompte

function send(ws, type, data = {}) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: type, ...data }));
}

// Annonce affichée en grand chez tout le monde
function announce(room, text) {
  room.broadcast("announce", { text });
}

function newDay() {
  return { open: false, nominators: [], nominees: [], history: [], block: null, top: 0, current: null };
}

function g(room, id) {
  return room.grim && room.grim.players[id];
}

function nameOf(room, id) {
  const p = room.players.get(id);
  return p ? p.name : "?";
}

function aliveCount(room) {
  return room.grim ? Object.values(room.grim.players).filter(x => x.alive).length : 0;
}

// Un joueur peut-il voter ? (vivant, ou mort avec son vote fantôme)
function canVote(room, id) {
  const x = g(room, id);
  return !!x && (x.alive || !x.ghostUsed);
}

// Ce que tout le monde voit des votes
function publicVotes(room) {
  const d = room.day || newDay();
  const c = d.current;
  return {
    open: d.open,
    nominators: d.nominators,
    nominees: d.nominees,
    history: d.history,
    block: d.block,
    current: c && {
      nominee: c.nominee, nominator: c.nominator, status: c.status,
      order: c.order, index: c.index, hands: Object.keys(c.hands),
      locked: c.locked, votes: c.votes, required: c.required,
    },
  };
}

function broadcastVotes(room) {
  room.broadcast("votes", { votes: publicVotes(room) });
}

function isDay(room) {
  return room.started && room.time && room.time.kind === "day";
}

// Fin du décompte : le joueur monte-t-il sur le billot ?
function finishVote(room) {
  const d = room.day, c = d.current;
  c.status = "done";
  if (c.timer) { clearInterval(c.timer); c.timer = null; }
  // Les morts qui ont voté ont utilisé leur vote fantôme
  for (const [id, up] of Object.entries(c.locked)) {
    const x = g(room, id);
    if (up && x && !x.alive) x.ghostUsed = true;
  }
  let onBlock = false;
  if (c.votes >= c.required) {
    if (c.votes > d.top) {
      d.top = c.votes;
      d.block = { pid: c.nominee, votes: c.votes };
      onBlock = true;
    } else if (c.votes === d.top) {
      d.block = null; // égalité : personne sur le billot
    }
  }
  d.history.push({ by: c.nominator, target: c.nominee, votes: c.votes, onBlock });
  const who = nameOf(room, c.nominee);
  if (onBlock) announce(room, `${who} : ${c.votes} voix. Sur le billot !`);
  else if (c.votes >= c.required && c.votes === d.top) announce(room, `${who} : ${c.votes} voix. Égalité : personne sur le billot.`);
  else announce(room, `${who} : ${c.votes} voix. Pas assez pour le billot.`);
  room.broadcastPlayers(); // le vote fantôme est une info publique
  broadcastVotes(room);
}

// Le décompte avance d'un joueur
function voteStep(room) {
  const c = room.day && room.day.current;
  if (!c || c.status !== "counting") return;
  const id = c.order[c.index];
  const up = !!c.hands[id] && canVote(room, id);
  c.locked[id] = up;
  if (up) c.votes++;
  c.index++;
  if (c.index >= c.order.length) finishVote(room);
  else broadcastVotes(room);
}

function stopVote(room) {
  const c = room.day && room.day.current;
  if (c && c.timer) clearInterval(c.timer);
}

// ---------- Actions des joueurs ----------
const playerHandlers = {
  // Nommer un joueur
  nominate(ws, msg) {
    const ctx = ws.ctx;
    if (!ctx || ctx.player.isST) return;
    const { room, player } = ctx;
    const d = room.day;
    const err = m => send(ws, "error", { msg: m });
    if (!isDay(room) || !d || !d.open) return err("Les nominations ne sont pas ouvertes.");
    if (d.current && d.current.status !== "done") return err("Un vote est déjà en cours.");
    if (!g(room, player.id) || !g(room, player.id).alive) return err("Les morts ne peuvent pas nommer.");
    if (d.nominators.includes(player.id)) return err("Tu as déjà nommé quelqu'un aujourd'hui.");
    const target = room.players.get(msg.target);
    if (!target || target.isST || !g(room, target.id)) return;
    if (d.nominees.includes(target.id)) return err(`${target.name} a déjà été nommé aujourd'hui.`);

    d.nominators.push(player.id);
    d.nominees.push(target.id);
    // Ordre du décompte : on part du joueur après l'accusé, l'accusé vote en dernier
    const seats = room.seats.filter(id => g(room, id));
    const start = seats.indexOf(target.id);
    const order = seats.map((_, i) => seats[(start + 1 + i) % seats.length]);
    d.current = {
      nominee: target.id, nominator: player.id, status: "pending",
      order, index: 0, hands: {}, locked: {}, votes: 0,
      required: Math.ceil(aliveCount(room) / 2), timer: null,
    };
    announce(room, `${player.name} nomme ${target.name} !`);
    broadcastVotes(room);
  },

  // Lever ou baisser la main
  hand(ws, msg) {
    const ctx = ws.ctx;
    if (!ctx || ctx.player.isST) return;
    const { room, player } = ctx;
    const c = room.day && room.day.current;
    if (!c || c.status === "done") return;
    if (player.id in c.locked) return; // l'aiguille est déjà passée : vote figé
    if (msg.up && canVote(room, player.id)) c.hands[player.id] = true;
    else delete c.hands[player.id];
    broadcastVotes(room);
  },
};

// ---------- Actions du Conteur ----------
const stOnly = {
  noms_open(ws, msg, room) {
    if (!isDay(room)) return send(ws, "error", { msg: "Les nominations se font le jour." });
    room.day.open = !!msg.open;
    announce(room, room.day.open ? "Les nominations sont ouvertes !" : "Les nominations sont closes.");
    broadcastVotes(room);
  },

  vote_start(ws, msg, room) {
    const c = room.day && room.day.current;
    if (!c || c.status !== "pending") return;
    c.status = "counting";
    c.timer = setInterval(() => voteStep(room), VOTE_STEP_MS);
    broadcastVotes(room);
  },

  vote_cancel(ws, msg, room) {
    const d = room.day, c = d && d.current;
    if (!c) return;
    stopVote(room);
    if (c.status !== "done") {
      // Nomination annulée : l'accusateur et l'accusé peuvent de nouveau être utilisés
      d.nominators = d.nominators.filter(id => id !== c.nominator);
      d.nominees = d.nominees.filter(id => id !== c.nominee);
    }
    d.current = null;
    broadcastVotes(room);
  },

  // Exécuter le joueur sur le billot (ou "none" = pas d'exécution)
  execute(ws, msg, room) {
    const d = room.day;
    if (!isDay(room) || !d) return;
    if (msg.pid === "none" || !d.block) {
      announce(room, "Pas d'exécution aujourd'hui.");
    } else {
      const x = g(room, d.block.pid);
      if (x) {
        x.alive = false;
        if (!x.reminders.includes("Exécuté")) x.reminders.push("Exécuté");
      }
      announce(room, `${nameOf(room, d.block.pid)} est exécuté.`);
      room.broadcastPlayers();
      require("./grimoire").sendGrimoire(room);
    }
    stopVote(room);
    d.open = false;
    d.current = null;
    d.block = null;
    broadcastVotes(room);
  },

  // Fin de partie : on révèle tous les rôles
  end_game(ws, msg, room) {
    if (!room.started || !room.grim) return;
    stopVote(room);
    room.ended = msg.winner === "evil" ? "evil" : "good";
    room.broadcast("game_over", gameOverData(room));
    announce(room, room.ended === "good" ? "Victoire du Bien !" : "Victoire du Mal !");
    console.log(`[${room.code}] fin de partie : ${room.ended}`);
  },
};

// Le résultat de la partie, avec tous les rôles révélés
function gameOverData(room) {
  const roles = {};
  for (const [id, x] of Object.entries(room.grim.players)) roles[id] = { role: x.role, fake: x.fake, alive: x.alive };
  return { winner: room.ended, roles };
}

const stHandlers = {};
for (const [name, fn] of Object.entries(stOnly)) {
  stHandlers[name] = (ws, msg) => {
    const ctx = ws.ctx;
    if (!ctx || !ctx.player.isST || ctx.room.phase === "lobby") return;
    if (!ctx.room.day) ctx.room.day = newDay();
    fn(ws, msg, ctx.room);
  };
}

module.exports = {
  voteHandlers: { ...playerHandlers, ...stHandlers },
  newDay, publicVotes, broadcastVotes, stopVote, canVote, gameOverData,
};
