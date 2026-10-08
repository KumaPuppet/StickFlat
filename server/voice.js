// =============================================================
//  VOCAL
//  Les navigateurs se parlent directement entre eux (WebRTC).
//  Le serveur sert à deux choses :
//   1. les mettre en relation (il fait passer les messages "v_signal")
//   2. décider QUI ENTEND QUI : chaque navigateur reçoit la liste "sendTo"
//      des joueurs à qui il a le droit d'envoyer sa voix. Aux autres, il
//      n'envoie que du silence. Personne ne peut donc écouter une autre zone.
// =============================================================

function send(ws, type, data = {}) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: type, ...data }));
}

// Est-ce que "listener" entend "speaker" ?
function canHear(room, listener, speaker) {
  if (listener === speaker) return false;

  // Dans le lobby, tout le monde s'entend
  if (room.phase === "lobby") return true;

  const talk = room.stTalk;     // "none", "all" ou l'id d'un joueur (privé)
  const listen = room.stListen; // "none", "all" ou "lieu/zone"

  // Le Conteur parle : à tout le monde, ou à un seul joueur en privé
  if (speaker.isST) return talk === "all" || talk === listener.id;

  // Le Conteur écoute : un joueur en privé, toute la maison, ou une zone
  if (listener.isST) {
    return talk === speaker.id || listen === "all" || listen === `${speaker.loc}/${speaker.zone}`;
  }

  // La nuit, les joueurs dorment : ils ne s'entendent pas entre eux
  if (room.time && room.time.kind === "night") return false;

  // Un joueur en privé avec le Conteur est "mis à l'écart" : sa zone ne l'entend plus
  if (talk === listener.id || talk === speaker.id) return false;

  // Sinon : on entend les gens de sa zone
  return listener.loc === speaker.loc && listener.zone === speaker.zone;
}

// À appeler à chaque changement (déplacement, connexion, réglage du Conteur...)
function updateVoice(room) {
  const voiced = [...room.players.values()].filter(p => p.voiceWs);
  for (const p of voiced) {
    const peers = voiced.filter(q => q !== p).map(q => ({ id: q.id, sid: q.voiceSid }));
    const sendTo = voiced.filter(q => canHear(room, q, p)).map(q => q.id);
    send(p.voiceWs, "v_peers", { me: p.id, peers, sendTo });
  }
  // Chaque joueur sait si le Conteur lui parle en privé ou fait une annonce
  for (const p of room.players.values()) {
    if (p.isST) {
      send(p.ws, "st_voice", { listen: room.stListen, talk: room.stTalk });
    } else {
      send(p.ws, "voice_you", { private: room.stTalk === p.id, announce: room.stTalk === "all" });
    }
  }
}

module.exports = { canHear, updateVoice };
