// =============================================================
//  JOUR ET NUIT
//  room.time = { kind: "setup" | "night" | "day", n: numéro }
//  La partie commence par la Nuit 1. Le Conteur passe à la phase suivante :
//  Nuit 1 -> Jour 1 -> Nuit 2 -> Jour 2 ...
//  La nuit : les joueurs ne s'entendent plus et ne bougent plus (voir voice.js).
// =============================================================
const { updateVoice } = require("./voice");
const { START, cancelMove } = require("./house");
const { newDay, stopVote, broadcastVotes } = require("./votes");
const { endGathering } = require("./speak");

function timeLabel(time) {
  if (!time || time.kind === "setup") return "Préparation";
  return (time.kind === "night" ? "Nuit " : "Jour ") + time.n;
}

function isNight(room) {
  return !!room.time && room.time.kind === "night";
}

// Liste des id des joueurs vivants
function aliveIds(room) {
  if (!room.grim) return [];
  return Object.entries(room.grim.players).filter(([, g]) => g.alive).map(([id]) => id);
}

// Annonce affichée en grand chez tout le monde
function announce(room, text) {
  room.broadcast("announce", { text });
}

function setTime(room, kind, n) {
  room.time = { kind, n };
  // Chaque changement de phase remet les nominations à zéro
  stopVote(room);
  room.day = newDay();
  endGathering(room); // fin du rassemblement : les mains se baissent
  broadcastVotes(room);
  room.broadcast("time", { time: room.time });
  updateVoice(room);
}

// Début de la partie (appelé par "begin") : première nuit
function startFirstNight(room) {
  room.nightAlive = aliveIds(room);
  room.stTalk = "none";
  setTime(room, "night", 1);
  announce(room, "La nuit tombe... Nuit 1");
}

const handlers = {
  // Passer à la phase suivante
  next_phase(ws, msg, ctx) {
    const { room } = ctx;
    if (!room.started || !room.time) return;
    room.stTalk = "none"; // on termine les conversations privées en cours

    if (room.time.kind === "night") {
      // Lever du jour : qui est mort cette nuit ?
      const nowAlive = new Set(aliveIds(room));
      const died = (room.nightAlive || []).filter(id => !nowAlive.has(id))
        .map(id => (room.players.get(id) || { name: "?" }).name);
      setTime(room, "day", room.time.n);
      if (died.length === 0) announce(room, `Jour ${room.time.n}. Personne n'est mort cette nuit.`);
      else if (died.length === 1) announce(room, `Jour ${room.time.n}. Cette nuit, ${died[0]} est mort.`);
      else announce(room, `Jour ${room.time.n}. Cette nuit, ${died.join(", ")} sont morts.`);
    } else {
      room.nightAlive = aliveIds(room);
      setTime(room, "night", room.time.n + 1);
      announce(room, `La nuit tombe... Nuit ${room.time.n}`);
    }
    console.log(`[${room.code}] ${timeLabel(room.time)}`);
  },

  // Rassembler tout le monde sur la place (pendant le jour)
  gather(ws, msg, ctx) {
    const { room } = ctx;
    if (isNight(room)) return;
    for (const p of room.players.values()) {
      if (!p.isST) { cancelMove(p); p.loc = START.loc; p.zone = START.zone; }
    }
    room.gathered = true;   // les joueurs peuvent lever la main pour parler
    room.speakHands = [];
    room.broadcastPositions();
    updateVoice(room);
    room.broadcast("gathered"); // tout le monde passe sur la vue en cercle
    announce(room, "Le Conteur rassemble tout le monde sur la place.");
  },
};

const stHandlers = {};
for (const [name, fn] of Object.entries(handlers)) {
  stHandlers[name] = (ws, msg) => {
    const ctx = ws.ctx;
    if (!ctx || !ctx.player.isST || ctx.room.phase === "lobby") return;
    fn(ws, msg, ctx);
  };
}

module.exports = { phaseHandlers: stHandlers, startFirstNight, isNight, timeLabel, announce };
