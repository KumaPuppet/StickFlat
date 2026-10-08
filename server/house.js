// =============================================================
//  La maison : liste des lieux et de leurs zones.
//  Pour ajouter une pièce ou une zone, il suffit de modifier cette liste :
//  le jeu GameMaker la reçoit et dessine la carte automatiquement.
//  "id" : identifiant technique (sans espace ni accent), "name" : nom affiché.
// =============================================================
const LOCATIONS = [
  { id: "place", name: "Place du village", zones: [
    { id: "centre", name: "Au centre" },
    { id: "puits", name: "Près du puits" },
  ]},
  { id: "bibliotheque", name: "Bibliothèque", zones: [
    { id: "etageres", name: "Étagères" },
    { id: "bureau", name: "Bureau" },
    { id: "lecture", name: "Coin lecture" },
  ]},
  { id: "jardin", name: "Jardin", zones: [
    { id: "tonnelle", name: "Tonnelle" },
    { id: "potager", name: "Potager" },
    { id: "serre", name: "Serre" },
  ]},
  { id: "salon", name: "Salon", zones: [
    { id: "cheminee", name: "Cheminée" },
    { id: "canape", name: "Canapé" },
    { id: "fenetre", name: "Fenêtre" },
  ]},
];

const START = { loc: "place", zone: "centre" };

function zoneExists(loc, zone) {
  const l = LOCATIONS.find(x => x.id === loc);
  return !!(l && l.zones.some(z => z.id === zone));
}

// Annule le déplacement en cours d'un joueur (décompte vers une autre salle)
function cancelMove(player) {
  if (!player.moveTimer) return;
  clearTimeout(player.moveTimer);
  player.moveTimer = null;
  const ws = player.ws;
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: "moving_cancel" }));
  // Ceux qu'on avait prévenus de son arrivée : finalement, il ne vient pas
  for (const w of player.moveWatchers || []) {
    if (w && w.readyState === w.OPEN) w.send(JSON.stringify({ t: "arriving_cancel", id: player.id }));
  }
  player.moveWatchers = [];
}

module.exports = { LOCATIONS, START, zoneExists, cancelMove };
