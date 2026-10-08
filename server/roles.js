// =============================================================
//  Rôles du script "Trouble Brewing"
//  team : "townsfolk" (Villageois), "outsider" (Étranger),
//         "minion" (Sbire), "demon" (Démon)
//  Les capacités sont reformulées (ce ne sont pas les textes officiels).
// =============================================================
const ROLES = [
  // ----- Villageois -----
  { id: "washerwoman", name: "Lavandière", team: "townsfolk",
    ability: "Au début de la partie, tu apprends qu'un joueur parmi deux a un certain rôle de Villageois." },
  { id: "librarian", name: "Bibliothécaire", team: "townsfolk",
    ability: "Au début de la partie, tu apprends qu'un joueur parmi deux a un certain rôle d'Étranger (ou qu'il n'y en a aucun en jeu)." },
  { id: "investigator", name: "Enquêteur", team: "townsfolk",
    ability: "Au début de la partie, tu apprends qu'un joueur parmi deux a un certain rôle de Sbire." },
  { id: "chef", name: "Cuisinier", team: "townsfolk",
    ability: "Au début de la partie, tu apprends combien de paires de joueurs maléfiques sont assis côte à côte." },
  { id: "empath", name: "Empathe", team: "townsfolk",
    ability: "Chaque nuit, tu apprends combien de tes 2 voisins vivants sont maléfiques." },
  { id: "fortuneteller", name: "Voyante", team: "townsfolk",
    ability: "Chaque nuit, choisis 2 joueurs : tu apprends si l'un d'eux est le Démon. Un joueur bon est vu à tort comme Démon." },
  { id: "undertaker", name: "Croque-mort", team: "townsfolk",
    ability: "Chaque nuit sauf la première, tu apprends le rôle du joueur exécuté aujourd'hui." },
  { id: "monk", name: "Moine", team: "townsfolk",
    ability: "Chaque nuit sauf la première, choisis un autre joueur : cette nuit, il est protégé du Démon." },
  { id: "ravenkeeper", name: "Gardien de corbeaux", team: "townsfolk",
    ability: "Si tu meurs pendant la nuit, tu te réveilles pour choisir un joueur : tu apprends son rôle." },
  { id: "virgin", name: "Vierge", team: "townsfolk",
    ability: "La première fois que tu es nommé, si le nominateur est un Villageois, il est exécuté immédiatement." },
  { id: "slayer", name: "Pourfendeur", team: "townsfolk",
    ability: "Une fois par partie, pendant le jour, désigne publiquement un joueur : si c'est le Démon, il meurt." },
  { id: "soldier", name: "Soldat", team: "townsfolk",
    ability: "Le Démon ne peut pas te tuer." },
  { id: "mayor", name: "Maire", team: "townsfolk",
    ability: "S'il ne reste que 3 joueurs vivants et qu'il n'y a pas d'exécution, ton équipe gagne. Si tu dois mourir la nuit, un autre joueur peut mourir à ta place." },
  // ----- Étrangers -----
  { id: "butler", name: "Majordome", team: "outsider",
    ability: "Chaque nuit, choisis un autre joueur : ton maître. Demain, tu ne peux voter que si ton maître vote aussi." },
  { id: "drunk", name: "Ivrogne", team: "outsider",
    ability: "Tu ne le sais pas : tu crois être un Villageois, mais ta capacité ne fonctionne pas." },
  { id: "recluse", name: "Reclus", team: "outsider",
    ability: "Tu peux être perçu comme maléfique, et même comme Sbire ou Démon, même après ta mort." },
  { id: "saint", name: "Saint", team: "outsider",
    ability: "Si tu meurs exécuté, ton équipe perd." },
  // ----- Sbires -----
  { id: "poisoner", name: "Empoisonneur", team: "minion",
    ability: "Chaque nuit, choisis un joueur : il est empoisonné cette nuit et le jour suivant." },
  { id: "spy", name: "Espion", team: "minion",
    ability: "Chaque nuit, tu consultes le Grimoire. Tu peux être perçu comme bon, Villageois ou Étranger, même après ta mort." },
  { id: "scarletwoman", name: "Femme écarlate", team: "minion",
    ability: "S'il reste au moins 5 joueurs vivants et que le Démon meurt, tu deviens le Démon." },
  { id: "baron", name: "Baron", team: "minion",
    ability: "Il y a 2 Étrangers de plus dans la partie." },
  // ----- Démon -----
  { id: "imp", name: "Diablotin", team: "demon",
    ability: "Chaque nuit sauf la première, choisis un joueur : il meurt. Si tu te choisis toi-même, un Sbire devient le Diablotin." },
];

// Marqueurs que le Conteur peut poser sur les joueurs dans le grimoire
const REMINDERS = [
  "Empoisonné", "Ivre", "Protégé", "Mort cette nuit", "Exécuté",
  "Maître", "Fausse piste", "Capacité utilisée", "Sans vote",
];

// Répartition officielle selon le nombre de joueurs : [Villageois, Étrangers, Sbires, Démons]
const SETUP = {
  5: [3, 0, 1, 1], 6: [3, 1, 1, 1], 7: [5, 0, 1, 1], 8: [5, 1, 1, 1], 9: [5, 2, 1, 1],
  10: [7, 0, 2, 1], 11: [7, 1, 2, 1], 12: [7, 2, 2, 1],
  13: [9, 0, 3, 1], 14: [9, 1, 3, 1], 15: [9, 2, 3, 1],
};

const byId = Object.fromEntries(ROLES.map(r => [r.id, r]));

function getRole(id) {
  return byId[id] || null;
}

function isGood(id) {
  const r = byId[id];
  return !!r && (r.team === "townsfolk" || r.team === "outsider");
}

// Répartition conseillée (le Baron ajoute 2 Étrangers)
function setupCounts(nPlayers, hasBaron) {
  let c;
  if (SETUP[nPlayers]) c = [...SETUP[nPlayers]];
  else if (nPlayers > 15) c = [...SETUP[15]];
  else c = [Math.max(0, nPlayers - 1), 0, 0, 1]; // moins de 5 joueurs : pour tester
  if (hasBaron) { c[0] -= 2; c[1] += 2; }
  return c;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { ROLES, REMINDERS, getRole, isGood, setupCounts, shuffle };
