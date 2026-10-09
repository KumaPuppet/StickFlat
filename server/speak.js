// =============================================================
//  PRISE DE PAROLE
//  - Le Conteur peut couper le micro de tout le monde ou d'un joueur
//    (room.muted : les autres joueurs ne l'entendent plus ; le Conteur, si).
//  - Pendant un rassemblement, les joueurs peuvent lever la main pour
//    demander la parole (room.speakHands : ids dans l'ordre des mains levées).
//    Le Conteur donne la parole (= rend le micro + baisse la main).
// =============================================================
const { updateVoice } = require("./voice");

function nonST(room) {
  return [...room.players.values()].filter(p => !p.isST);
}

// Remet tout à zéro (nouvelle partie, retour au lobby)
function resetSpeak(room) {
  room.muted = new Set();
  room.speakHands = [];
  room.gathered = false;
}

// Fin du rassemblement (changement de phase) : on baisse les mains
function endGathering(room) {
  room.gathered = false;
  room.speakHands = [];
}

// Actions du Conteur
const stActions = {
  // Couper / rendre le micro de tout le monde
  mute_all(ws, msg, room) {
    room.muted = new Set(msg.on ? nonST(room).map(p => p.id) : []);
  },
  // Couper / rendre le micro d'un joueur
  mute(ws, msg, room) {
    const p = room.players.get(msg.pid);
    if (!p || p.isST) return;
    if (msg.on) room.muted.add(p.id);
    else room.muted.delete(p.id);
  },
  // Donner la parole : on rend le micro au joueur et on baisse sa main
  give_floor(ws, msg, room) {
    room.muted.delete(msg.pid);
    room.speakHands = room.speakHands.filter(id => id !== msg.pid);
  },
  // Baisser la main d'un joueur, ou de tout le monde (pid absent)
  hands_down(ws, msg, room) {
    room.speakHands = msg.pid ? room.speakHands.filter(id => id !== msg.pid) : [];
  },
  // Fin du rassemblement : les joueurs peuvent de nouveau aller dans la maison
  end_gather(ws, msg, room) {
    if (!room.gathered) return;
    endGathering(room);
    room.broadcast("announce", { text: "Fin du rassemblement : vous pouvez de nouveau circuler." });
  },
};

const handlers = {};
for (const [name, fn] of Object.entries(stActions)) {
  handlers[name] = (ws, msg) => {
    const ctx = ws.ctx;
    if (!ctx || !ctx.player.isST || ctx.room.phase === "lobby") return;
    fn(ws, msg, ctx.room);
    updateVoice(ctx.room); // renvoie aussi l'état de la parole à tout le monde
  };
}

// Joueur : lever / baisser la main pendant un rassemblement
handlers.speak_hand = (ws, msg) => {
  const ctx = ws.ctx;
  if (!ctx || ctx.player.isST || ctx.room.phase === "lobby") return;
  const { room, player } = ctx;
  room.speakHands = room.speakHands.filter(id => id !== player.id);
  if (msg.up && room.gathered) room.speakHands.push(player.id);
  updateVoice(room);
};

module.exports = { speakHandlers: handlers, resetSpeak, endGathering };
