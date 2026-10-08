// =============================================================
//  ext_voice : vocal par zone pour Blood on the Moon (HTML5)
//
//  Ce fichier tourne dans le navigateur, à côté du jeu GameMaker.
//  - Il demande l'accès au micro.
//  - Il ouvre sa propre connexion au serveur pour se mettre en relation
//    avec les autres joueurs.
//  - Il crée une connexion audio directe (WebRTC) avec chaque joueur.
//  - Le serveur lui dit à qui il a le droit d'envoyer sa voix ("sendTo") :
//    aux autres, il envoie du silence.
//
//  Fonctions appelées depuis GameMaker :
//    voice_start(url, code, token)  -> démarre le vocal
//    voice_stop()                   -> arrête tout
//    voice_set_mic(on)              -> 1 = micro ouvert, 0 = coupé
//    voice_set_mode(mode)           -> "auto" (filtre anti-bruits) ou "ptt" (appuyer pour parler)
//    voice_set_ptt(down)            -> mode "ptt" : 1 = touche enfoncée
//    voice_set_threshold(t)         -> mode "auto" : de combien la voix doit dépasser le bruit de fond
//                                      (2 = sensible, 3 = normal, 4.5 = filtre beaucoup)
//    voice_state()                  -> "off", "asking", "ready", "denied", "error", "unsupported"
//    voice_levels()                 -> texte JSON { idJoueur: volume entre 0 et 1 }
// =============================================================

// Fond de la page de la même couleur que le jeu (au lieu des bandes blanches autour)
try {
	document.documentElement.style.background = "#16101c";
	if (document.body) document.body.style.background = "#16101c";
	else window.addEventListener("DOMContentLoaded", function () { document.body.style.background = "#16101c"; });
} catch (e) {}

// ---------- Fonctions "page web" (adresse du site, lien d'invitation) ----------

// Nom du site qui affiche le jeu, ex : "botc-xxx.onrender.com"
function web_page_host() {
	return window.location.hostname;
}

// Port du site (443 pour https, 80 pour http si non précisé)
function web_page_port() {
	var p = window.location.port;
	if (p) return parseInt(p, 10);
	return window.location.protocol === "https:" ? 443 : 80;
}

// 1 si le site est en https (il faut alors une connexion wss:// sécurisée)
function web_page_secure() {
	return window.location.protocol === "https:" ? 1 : 0;
}

// Adresse de la page sans les paramètres, ex : "https://botc-xxx.onrender.com/"
function web_page_base() {
	return window.location.origin + window.location.pathname;
}

// Lit un paramètre de l'adresse, ex : ?room=ABCD -> web_get_param("room") = "ABCD"
function web_get_param(name) {
	try {
		var v = new URLSearchParams(window.location.search).get(name);
		return v ? v : "";
	} catch (e) { return ""; }
}

// Copie un texte dans le presse-papiers. Renvoie 1 si c'est possible.
function web_copy(text) {
	try {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text);
			return 1;
		}
		var ta = document.createElement("textarea");
		ta.value = text;
		document.body.appendChild(ta);
		ta.select();
		document.execCommand("copy");
		document.body.removeChild(ta);
		return 1;
	} catch (e) { return 0; }
}

var __voice = {
	state: "off",
	url: "", code: "", token: "",
	ws: null, retry: null,
	stream: null,      // micro brut
	sendStream: null,  // micro traité (nettoyé + volume ajusté) : c'est lui qu'on envoie
	ctx: null, localAnalyser: null,
	detect: null,      // analyse de la bande de fréquences de la voix (pour le filtre)
	pitch: null,       // analyse de la vibration des cordes vocales (voix ou bruit ?)
	post: null,        // analyse après compression (pour le volume automatique)
	makeup: null,      // gain automatique
	me: "",
	peers: {},      // id -> { id, sid, pc, track, audio, analyser, initiator, remoteSet, pendingIce }
	sendTo: [],
	micOn: true,
	// Appareils choisis ("" = celui par défaut du système)
	inputId: "",
	echo: true,         // anti-écho du navigateur (à couper avec un casque)
	noise: true,        // réduction de bruit du navigateur
	outputId: "",
	volume: 1,          // volume des autres joueurs (0 à 1)
	devices: { inputs: [], outputs: [] },
	srcNode: null, chainInputs: [],
	// Filtre anti-bruits : on ne transmet que si le son dure (une voix) et dépasse
	// nettement le bruit de fond du micro. Un clic ou une touche, trop courts, sont ignorés.
	mode: "auto",
	pttDown: false,    // touche considérée comme enfoncée (avec un petit délai au relâchement)
	pttWanted: false,  // touche réellement enfoncée
	pttTimer: null,
	lastVoicedAt: 0,
	sensMult: 3,      // la voix doit être 3x plus forte que le bruit de fond
	floor: 0,          // bruit de fond mesuré en continu
	learnMs: 0,
	speechRms: 0,      // volume moyen de la voix (pour le gain automatique)
	gateOpen: false,
	aboveMs: 0,
	belowMs: 0,
	gateTimer: null
};

var __VOICE_MIN_THRESHOLD = 0.0025; // en dessous, c'est forcément du silence
var __VOICE_VOICING_MIN = 0.55;     // à partir de quel "voisement" on considère que c'est une voix
var __VOICE_STABILITY_MIN = 0.3;    // une voix garde un volume stable (un choc s'éteint vite)
var __VOICE_NO_VOICE_CLOSE = 1200;  // ms sans voix (seulement des bruits) avant de fermer
var __VOICE_DELAY = 0.15;           // retard du son envoyé (secondes)
var __VOICE_TARGET_RMS = 0.07;      // volume visé pour la voix envoyée
var __VOICE_MAX_GAIN = 4;           // on peut monter un micro faible jusqu'à x4 (plus = souffle et grésillement)

var __VOICE_GATE_STEP = 20;     // on vérifie le volume toutes les 20 ms
var __VOICE_GATE_ATTACK = 100;  // il faut 100 ms de voix continue pour ouvrir (un clic dure moins)
var __VOICE_GATE_RELEASE = 450; // on ferme après 450 ms de silence (pour ne pas couper les fins de mots)

// Serveurs STUN publics : ils aident les navigateurs à se trouver à travers les box internet
var __VOICE_ICE = [
	{ urls: "stun:stun.l.google.com:19302" },
	{ urls: "stun:stun1.l.google.com:19302" }
];

function voice_start(url, code, token) {
	var V = __voice;
	if ((V.state === "asking" || V.state === "ready") && V.code === code && V.token === token) return 1;
	if (V.state !== "off") voice_stop();

	V.url = url; V.code = code; V.token = token;
	if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.RTCPeerConnection) {
		V.state = "unsupported";
		return 0;
	}
	V.state = "asking";
	__voice_get_mic(V.inputId).then(function (stream) {
		if (V.state !== "asking") { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
		V.stream = stream;
		V.sendStream = stream;
		try {
			// Même fréquence que le micro : pas de conversion (source de craquements)
			var AC = window.AudioContext || window.webkitAudioContext;
			var rate = 0;
			try { rate = stream.getAudioTracks()[0].getSettings().sampleRate || 0; } catch (e) {}
			try {
				V.ctx = rate ? new AC({ sampleRate: rate, latencyHint: "interactive" }) : new AC({ latencyHint: "interactive" });
			} catch (e) {
				V.ctx = new AC();
			}
			if (V.ctx.state === "suspended") V.ctx.resume();
			__voice_build_chain(stream);
		} catch (e) {
			console.warn("[voice] traitement audio indisponible :", e);
			V.ctx = null;
			V.detect = null;
			V.sendStream = stream;
		}
		V.floor = 0;
		V.learnMs = 0;
		V.speechRms = 0;
		V.localAnalyser = __voice_analyser(V.sendStream);
		V.state = "ready";
		V.gateTimer = setInterval(__voice_gate_tick, __VOICE_GATE_STEP);
		__voice_connect();
		voice_refresh_devices(); // les noms des appareils ne sont visibles qu'après l'accord du micro
	}).catch(function (err) {
		console.warn("[voice] micro :", err);
		V.state = (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) ? "denied" : "error";
	});
	return 1;
}

function voice_stop() {
	var V = __voice;
	V.state = "off";
	if (V.retry) { clearTimeout(V.retry); V.retry = null; }
	if (V.gateTimer) { clearInterval(V.gateTimer); V.gateTimer = null; }
	if (V.pttTimer) { clearTimeout(V.pttTimer); V.pttTimer = null; }
	V.pttDown = false;
	V.pttWanted = false;
	V.pitch = null;
	V.gateOpen = false;
	if (V.ws) { V.ws.onclose = null; try { V.ws.close(); } catch (e) {} V.ws = null; }
	for (var id in V.peers) __voice_peer_close(id);
	if (V.stream) { V.stream.getTracks().forEach(function (t) { t.stop(); }); V.stream = null; }
	if (V.ctx) { try { V.ctx.close(); } catch (e) {} V.ctx = null; }
	V.localAnalyser = null;
	V.detect = null;
	V.post = null;
	V.makeup = null;
	V.gateGain = null;
	V.srcNode = null;
	V.chainInputs = [];
	V.sendStream = null;
	V.sendTo = [];
	return 1;
}

function voice_set_mic(on) {
	__voice.micOn = !!on;
	__voice_apply_send();
	return 1;
}

function voice_set_mode(mode) {
	__voice.mode = (mode === "ptt") ? "ptt" : "auto";
	__voice_apply_send();
	return 1;
}

function voice_set_ptt(down) {
	var V = __voice;
	var d = !!down;
	if (d === V.pttWanted) return 1;
	V.pttWanted = d;
	if (V.pttTimer) { clearTimeout(V.pttTimer); V.pttTimer = null; }
	if (d) {
		V.pttDown = true;
		__voice_apply_send();
	} else {
		// Le son envoyé a 120 ms de retard : on attend un peu pour ne pas couper la fin
		V.pttTimer = setTimeout(function () {
			V.pttDown = false;
			V.pttTimer = null;
			__voice_apply_send();
		}, __VOICE_DELAY * 1000 + 30);
	}
	return 1;
}

function voice_set_threshold(t) {
	__voice.sensMult = Math.max(1.2, Math.min(10, +t || 3));
	return 1;
}

// Chaîne de traitement du micro :
//  - détection du volume : on n'écoute que la bande de la voix (250-3500 Hz)
//  - détection de la voix : bande 70-900 Hz, là où l'on repère la vibration régulière
//    des cordes vocales (un clic ou une touche n'a pas cette régularité)
//  - envoi : léger retard (le filtre a le temps de décider sans couper le début des mots),
//    on coupe les graves parasites, on compresse (les sons faibles remontent),
//    on ajuste le volume automatiquement, et un limiteur évite la saturation
function __voice_build_chain(raw) {
	var V = __voice, ctx = V.ctx;
	var src = ctx.createMediaStreamSource(raw);
	V.srcNode = src;
	V.chainInputs = []; // les premiers maillons de la chaîne (pour changer de micro sans tout refaire)

	var bandLow = ctx.createBiquadFilter();
	bandLow.type = "highpass"; bandLow.frequency.value = 250;
	var bandHigh = ctx.createBiquadFilter();
	bandHigh.type = "lowpass"; bandHigh.frequency.value = 3500;
	var det = ctx.createAnalyser();
	det.fftSize = 1024;
	src.connect(bandLow); bandLow.connect(bandHigh); bandHigh.connect(det);
	V.chainInputs.push(bandLow);
	V.detect = { node: det, buf: new Float32Array(det.fftSize) };

	var pitchLow = ctx.createBiquadFilter();
	pitchLow.type = "highpass"; pitchLow.frequency.value = 70;
	var pitchHigh = ctx.createBiquadFilter();
	pitchHigh.type = "lowpass"; pitchHigh.frequency.value = 900;
	var pitch = ctx.createAnalyser();
	pitch.fftSize = 2048;
	src.connect(pitchLow); pitchLow.connect(pitchHigh); pitchHigh.connect(pitch);
	V.chainInputs.push(pitchLow);
	V.pitch = { node: pitch, buf: new Float32Array(pitch.fftSize) };

	var delay = ctx.createDelay(1);
	delay.delayTime.value = __VOICE_DELAY;
	var rumble = ctx.createBiquadFilter();
	rumble.type = "highpass"; rumble.frequency.value = 90;
	var comp = ctx.createDynamicsCompressor();
	// Compression douce (une attaque trop rapide déforme les sons graves)
	comp.threshold.value = -36; comp.knee.value = 30; comp.ratio.value = 2;
	comp.attack.value = 0.015; comp.release.value = 0.3;
	var post = ctx.createAnalyser();
	post.fftSize = 1024;
	var makeup = ctx.createGain();
	makeup.gain.value = 1;
	var limiter = ctx.createDynamicsCompressor();
	// Limiteur doux : évite la saturation sans "écrêter" (un limiteur trop brutal grésille)
	limiter.threshold.value = -6; limiter.knee.value = 6; limiter.ratio.value = 12;
	limiter.attack.value = 0.003; limiter.release.value = 0.25;
	// Ouverture / fermeture du micro en fondu (au lieu d'une coupure nette qui fait "clic")
	var gate = ctx.createGain();
	gate.gain.value = 0;
	var dest = ctx.createMediaStreamDestination();

	V.chainInputs.push(delay);
	src.connect(delay); delay.connect(rumble); rumble.connect(comp); comp.connect(makeup);
	makeup.connect(limiter); limiter.connect(gate); gate.connect(dest);
	V.gateGain = gate;
	comp.connect(post);
	V.post = { node: post, buf: new Float32Array(post.fftSize) };
	V.makeup = makeup;
	V.sendStream = dest.stream;
}

// Volume "réel" (RMS) d'un analyseur, entre 0 et 1
function __voice_rms(a) {
	if (!a) return 0;
	a.node.getFloatTimeDomainData(a.buf);
	var sum = 0;
	for (var i = 0; i < a.buf.length; i++) sum += a.buf[i] * a.buf[i];
	return Math.sqrt(sum / a.buf.length);
}

// "Voisement" : est-ce que le son se répète régulièrement, comme une voix ?
// On compare le signal avec lui-même décalé d'une période de voix (75 à 400 Hz).
// Résultat proche de 1 = voix, proche de 0 = bruit, clic, touche de clavier.
function __voice_voicing(a, sampleRate) {
	if (!a) return 1;
	a.node.getFloatTimeDomainData(a.buf);
	var x = a.buf, n = x.length;

	// Un choc (touche, clic) s'éteint très vite : toute l'énergie est au début ou à la fin.
	// Une voix garde un volume à peu près stable : on compare les deux moitiés.
	var h1 = 0, h2 = 0, half = n >> 1;
	for (var j = 0; j < half; j++) h1 += x[j] * x[j];
	for (var j2 = half; j2 < n; j2++) h2 += x[j2] * x[j2];
	if (Math.min(h1, h2) < Math.max(h1, h2) * __VOICE_STABILITY_MIN) return 0;

	var minLag = Math.floor(sampleRate / 400);
	var maxLag = Math.min(Math.floor(sampleRate / 75), Math.floor(n / 2));
	var best = 0;
	for (var lag = minLag; lag <= maxLag; lag += 2) {
		var s = 0, e1 = 0, e2 = 0, m = n - lag;
		for (var i = 0; i < m; i += 2) {
			var u = x[i], v = x[i + lag];
			s += u * v; e1 += u * u; e2 += v * v;
		}
		var r = s / Math.sqrt(e1 * e2 + 1e-12);
		if (r > best) best = r;
	}
	return best;
}

// Est-ce qu'on transmet notre voix en ce moment ?
function __voice_transmitting() {
	var V = __voice;
	if (!V.micOn) return false;
	return (V.mode === "ptt") ? V.pttDown : V.gateOpen;
}

// Filtre anti-bruits (mode "auto")
function __voice_gate_tick() {
	var V = __voice;
	if (!V.localAnalyser) return;
	// Temps réel écoulé (le navigateur ralentit les minuteries quand l'onglet est caché)
	var now = performance.now();
	var dt = Math.min(100, now - (V.lastTick || now));
	V.lastTick = now;
	var was = V.gateOpen;

	// Sans traitement audio (vieux navigateur) : pas de filtre, le micro reste ouvert
	if (!V.detect) {
		V.gateOpen = true;
		if (!was) __voice_apply_send();
		return;
	}

	var lv = __voice_rms(V.detect);
	var voicing = __voice_voicing(V.pitch, V.ctx.sampleRate);
	var voiced = voicing >= __VOICE_VOICING_MIN;

	// 1) Bruit de fond : mesuré quand on ne parle pas.
	//    Il descend vite (le silence revient) et monte lentement (un ventilateur s'allume).
	if (!V.gateOpen && !voiced) {
		if (V.learnMs < 1500) {
			V.learnMs += dt;
			V.floor = (V.floor === 0) ? lv : V.floor * 0.8 + lv * 0.2;
		} else if (lv < V.floor) {
			V.floor += (lv - V.floor) * 0.3;
		} else {
			V.floor += (lv - V.floor) * Math.min(1, dt / 8000);
		}
		V.floor = Math.max(0.0003, V.floor);
	}

	// 2) Seuil : la voix doit dépasser nettement le bruit de fond.
	//    Une fois ouvert, on tolère une voix un peu plus faible (fin de phrase).
	var threshold = Math.max(__VOICE_MIN_THRESHOLD, V.floor * V.sensMult);
	if (V.gateOpen) threshold *= 0.6;

	// 3) Volume automatique : on vise le même volume pour tout le monde
	if (V.gateOpen && V.post && V.makeup) {
		var pr = __voice_rms(V.post);
		if (pr > 0.0005) {
			V.speechRms = (V.speechRms === 0) ? pr : V.speechRms * 0.97 + pr * 0.03;
			var g = Math.max(1, Math.min(__VOICE_MAX_GAIN, __VOICE_TARGET_RMS / V.speechRms));
			V.makeup.gain.setTargetAtTime(g, V.ctx.currentTime, 1.5); // changements de volume lents
		}
	}

	// 4) Décision
	//  - pour OUVRIR : il faut un son assez fort ET qui ressemble à une voix, pendant 80 ms
	//  - une fois ouvert : on reste ouvert tant qu'il y a du son (les consonnes comme
	//    "s" ou "f" ne sont pas "voisées", il ne faut pas les couper)
	//  - mais si plus rien ne ressemble à une voix pendant 1,2 s, on ferme
	//    (quelqu'un qui tape au clavier juste après avoir parlé)
	var loud = lv >= threshold;
	if (loud && voiced) {
		V.aboveMs += dt;
		// "Il y a encore de la voix" seulement après 100 ms de voix continue
		// (deux frappes rapprochées peuvent ressembler à une voix une fraction de seconde)
		if (V.aboveMs >= __VOICE_GATE_ATTACK) V.lastVoicedAt = now;
	} else {
		V.aboveMs = 0; // il faut de la voix SANS interruption (des touches successives ne s'additionnent pas)
	}
	if (!V.gateOpen) {
		if (V.aboveMs >= __VOICE_GATE_ATTACK) {
			V.gateOpen = true;
			V.belowMs = 0;
		}
	} else {
		V.belowMs = loud ? 0 : V.belowMs + dt;
		if (V.belowMs >= __VOICE_GATE_RELEASE || now - V.lastVoicedAt > __VOICE_NO_VOICE_CLOSE) {
			V.gateOpen = false;
			V.aboveMs = 0;
		}
	}
	if (was !== V.gateOpen) __voice_apply_send();
}

function voice_state() {
	return __voice.state;
}

function voice_levels() {
	var V = __voice;
	var out = {};
	if (V.state !== "ready") return "{}";
	if (V.ctx && V.ctx.state === "suspended") V.ctx.resume();
	// Mon propre volume : seulement quand ma voix est vraiment transmise
	if (V.me && V.localAnalyser) out[V.me] = __voice_transmitting() ? __voice_level(V.localAnalyser) : 0;
	for (var id in V.peers) {
		var p = V.peers[id];
		if (p.analyser) out[id] = __voice_level(p.analyser);
	}
	return JSON.stringify(out);
}

// ---------- Connexion au serveur (mise en relation) ----------

function __voice_connect() {
	var V = __voice;
	var ws = new WebSocket(V.url);
	V.ws = ws;
	ws.onopen = function () {
		ws.send(JSON.stringify({ t: "voice_hello", code: V.code, token: V.token }));
	};
	ws.onmessage = function (ev) {
		var msg;
		try { msg = JSON.parse(ev.data); } catch (e) { return; }
		if (msg.t === "v_peers") __voice_on_peers(msg);
		else if (msg.t === "v_signal") __voice_on_signal(msg.from, msg.sid, msg.data);
		else if (msg.t === "v_error") console.warn("[voice]", msg.msg);
	};
	ws.onclose = function () {
		// Coupure : on ferme les connexions audio et on réessaie dans 2 secondes
		for (var id in V.peers) __voice_peer_close(id);
		if (V.state === "ready") V.retry = setTimeout(__voice_connect, 2000);
	};
}

function __voice_signal(to, data) {
	var V = __voice;
	if (V.ws && V.ws.readyState === 1) V.ws.send(JSON.stringify({ t: "v_signal", to: to, data: data }));
}

// Le serveur envoie la liste des joueurs et à qui on peut parler
function __voice_on_peers(msg) {
	var V = __voice;
	V.me = msg.me;
	V.sendTo = msg.sendTo || [];
	var wanted = {};
	for (var i = 0; i < msg.peers.length; i++) {
		var info = msg.peers[i];
		wanted[info.id] = true;
		var p = V.peers[info.id];
		if (p && p.sid !== info.sid) { __voice_peer_close(info.id); p = null; } // l'autre s'est reconnecté
		if (!p) __voice_peer_create(info.id, info.sid);
	}
	for (var id in V.peers) if (!wanted[id]) __voice_peer_close(id);
	__voice_apply_send();
}

// Active notre voix uniquement vers les joueurs autorisés
function __voice_apply_send() {
	var V = __voice;
	var tx = __voice_transmitting();
	// Le fondu d'ouverture/fermeture se fait sur le son lui-même (si le traitement audio marche) ;
	// les pistes vers chaque joueur restent, elles, coupées pour ceux qui n'ont pas le droit d'entendre
	var useFade = !!(V.gateGain && V.ctx);
	if (useFade) {
		var now = V.ctx.currentTime;
		V.gateGain.gain.cancelScheduledValues(now);
		V.gateGain.gain.setTargetAtTime(tx ? 1 : 0, now, tx ? 0.006 : 0.03);
	}
	for (var id in V.peers) {
		var p = V.peers[id];
		var allowed = V.sendTo.indexOf(id) >= 0;
		if (p.track) p.track.enabled = allowed && (useFade ? V.micOn : tx);
	}
}

// ---------- Choix des appareils (micro, sortie) et volume ----------

// Ouvre le micro choisi ("" = celui par défaut). Si l'appareil n'existe plus, on prend celui par défaut.
function __voice_get_mic(deviceId) {
	// autoGainControl désactivé : c'est notre propre volume automatique qui s'en charge
	// (les deux ensemble se "battent" et font grésiller)
	var V = __voice;
	var base = { echoCancellation: V.echo, noiseSuppression: V.noise, autoGainControl: false,
		channelCount: 1, sampleRate: 48000 }; // qualité maximale du micro (48 kHz, mono)
	var withDevice = {};
	for (var k in base) withDevice[k] = base[k];
	if (deviceId) withDevice.deviceId = { exact: deviceId };
	return navigator.mediaDevices.getUserMedia({ audio: withDevice, video: false }).catch(function (err) {
		if (deviceId && err && (err.name === "OverconstrainedError" || err.name === "NotFoundError")) {
			return navigator.mediaDevices.getUserMedia({ audio: base, video: false });
		}
		throw err;
	});
}

// Met à jour la liste des appareils (les noms n'apparaissent qu'une fois le micro autorisé)
function voice_refresh_devices() {
	var V = __voice;
	if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return 0;
	navigator.mediaDevices.enumerateDevices().then(function (list) {
		var ins = [], outs = [];
		list.forEach(function (d) {
			if (!d.deviceId || d.deviceId === "default" || d.deviceId === "communications") return; // doublons de Windows / appareils inconnus
			var item = { id: d.deviceId, label: d.label || "Appareil sans nom" };
			if (d.kind === "audioinput") ins.push(item);
			else if (d.kind === "audiooutput") outs.push(item);
		});
		V.devices = { inputs: ins, outputs: outs };
	}).catch(function () {});
	return 1;
}
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
	navigator.mediaDevices.addEventListener("devicechange", function () { voice_refresh_devices(); });
}

// Liste des appareils pour GameMaker (texte JSON)
function voice_devices() {
	var V = __voice;
	var canOut = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
	return JSON.stringify({
		inputs: V.devices.inputs, outputs: V.devices.outputs,
		input: V.inputId, output: V.outputId, volume: V.volume, outputSupported: canOut,
	});
}

// Change de micro (même en pleine partie : les autres joueurs ne sont pas déconnectés)
function voice_set_input(id) {
	var V = __voice;
	id = id || "";
	if (id === V.inputId && V.state === "ready") return 1;
	V.inputId = id;
	if (V.state !== "ready") return 1; // sera utilisé au démarrage du micro
	__voice_swap_mic();
	return 1;
}

// Traitements du navigateur :
//  echo  = anti-écho (indispensable avec des haut-parleurs, inutile avec un casque :
//          le désactiver rend la voix bien plus naturelle)
//  noise = réduction de bruit (enlève le souffle, mais peut donner un effet "sous l'eau")
function voice_set_processing(echo, noise) {
	var V = __voice;
	echo = !!echo; noise = !!noise;
	if (echo === V.echo && noise === V.noise) return 1;
	V.echo = echo; V.noise = noise;
	if (V.state === "ready") __voice_swap_mic(); // il faut rouvrir le micro avec les nouveaux réglages
	return 1;
}

// Rouvre le micro (autre appareil ou autres réglages) sans couper les conversations
function __voice_swap_mic() {
	var V = __voice;
	__voice_get_mic(V.inputId).then(function (stream) {
		if (V.state !== "ready") { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
		var old = V.stream;
		V.stream = stream;
		if (V.ctx && V.srcNode) {
			// On branche le nouveau micro au début de la chaîne de traitement
			try { V.srcNode.disconnect(); } catch (e) {}
			V.srcNode = V.ctx.createMediaStreamSource(stream);
			V.chainInputs.forEach(function (n) { V.srcNode.connect(n); });
		} else {
			// Sans traitement audio : on remplace la piste envoyée à chaque joueur
			V.sendStream = stream;
			V.localAnalyser = __voice_analyser(stream);
			for (var pid in V.peers) {
				var p = V.peers[pid];
				var t = stream.getAudioTracks()[0].clone();
				var sender = p.pc.getSenders().find(function (s) { return s.track === p.track; });
				if (sender) sender.replaceTrack(t);
				if (p.track) p.track.stop();
				p.track = t;
			}
		}
		if (old) old.getTracks().forEach(function (t) { t.stop(); });
		V.floor = 0; V.learnMs = 0; V.speechRms = 0; // le nouveau micro a un autre bruit de fond
		__voice_apply_send();
		voice_refresh_devices();
	}).catch(function (err) { console.warn("[voice] changement de micro :", err); });
}

// Change la sortie (casque / haut-parleurs). Chrome et Edge seulement.
function voice_set_output(id) {
	var V = __voice;
	V.outputId = id || "";
	for (var pid in V.peers) if (V.peers[pid].audio) __voice_apply_output(V.peers[pid].audio);
	return 1;
}

// Volume des autres joueurs (0 à 1)
function voice_set_volume(v) {
	var V = __voice;
	V.volume = Math.max(0, Math.min(1, +v));
	for (var pid in V.peers) if (V.peers[pid].audio) V.peers[pid].audio.volume = V.volume;
	return 1;
}

function __voice_apply_output(audio) {
	var V = __voice;
	audio.volume = V.volume;
	if (typeof audio.setSinkId === "function") {
		audio.setSinkId(V.outputId || "").catch(function (err) { console.warn("[voice] sortie :", err); });
	}
}

// Niveau du micro en direct (avant le filtre), pour vérifier qu'il capte bien (0 à 1)
function voice_input_level() {
	var V = __voice;
	if (V.state !== "ready") return 0;
	if (V.detect) return Math.min(1, __voice_rms(V.detect) * 8);
	return V.localAnalyser ? __voice_level(V.localAnalyser) : 0;
}

// ---------- Qualité de la voix (codec Opus) ----------
var __VOICE_BITRATE = 96000; // 96 kbit/s (par défaut les navigateurs utilisent ~32 kbit/s)
var __VOICE_JITTER_MS = 80;  // petit tampon de réception : absorbe les irrégularités du wifi

// Règle le codec dans la description de connexion :
//  - débit plus élevé (voix plus claire)
//  - correction d'erreurs (un paquet perdu en wifi est reconstruit au lieu de faire un trou)
//  - pas de coupure des silences (sinon le début des mots peut être mangé)
function __voice_tune_sdp(sdp) {
	try {
		var m = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
		if (!m) return sdp;
		var pt = m[1];
		var re = new RegExp("a=fmtp:" + pt + " ([^\\r\\n]*)");
		var extra = { maxaveragebitrate: String(__VOICE_BITRATE), maxplaybackrate: "48000",
			useinbandfec: "1", usedtx: "0", stereo: "0" };
		if (re.test(sdp)) {
			return sdp.replace(re, function (line, params) {
				var kv = {};
				params.split(";").forEach(function (p) { var i = p.indexOf("="); if (i > 0) kv[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
				for (var k in extra) kv[k] = extra[k];
				return "a=fmtp:" + pt + " " + Object.keys(kv).map(function (k) { return k + "=" + kv[k]; }).join(";");
			});
		}
		var line = "a=fmtp:" + pt + " " + Object.keys(extra).map(function (k) { return k + "=" + extra[k]; }).join(";");
		return sdp.replace(m[0], m[0] + "\r\n" + line);
	} catch (e) { return sdp; }
}

// Débit maximal de notre envoi vers ce joueur
function __voice_set_bitrate(pc) {
	try {
		pc.getSenders().forEach(function (s) {
			if (!s.track || s.track.kind !== "audio") return;
			var params = s.getParameters();
			if (!params.encodings || !params.encodings.length) params.encodings = [{}];
			params.encodings[0].maxBitrate = __VOICE_BITRATE;
			s.setParameters(params).catch(function () {});
		});
	} catch (e) {}
}

// ---------- Connexion audio avec un joueur ----------

function __voice_peer_create(id, sid) {
	var V = __voice;
	var pc = new RTCPeerConnection({ iceServers: __VOICE_ICE });
	// Une copie de notre micro pour CE joueur : on peut la couper sans couper les autres
	var track = V.sendStream.getAudioTracks()[0].clone();
	track.enabled = false;
	pc.addTrack(track, new MediaStream([track]));

	var p = {
		id: id, sid: sid, pc: pc, track: track, audio: null, analyser: null,
		initiator: V.me < id, // un seul des deux lance la connexion
		remoteSet: false, pendingIce: []
	};
	V.peers[id] = p;

	pc.onicecandidate = function (e) {
		if (e.candidate) __voice_signal(id, { ice: e.candidate });
	};
	pc.ontrack = function (e) {
		try { if (e.receiver && "jitterBufferTarget" in e.receiver) e.receiver.jitterBufferTarget = __VOICE_JITTER_MS; } catch (err) {}
		var stream = (e.streams && e.streams[0]) ? e.streams[0] : new MediaStream([e.track]);
		if (!p.audio) {
			p.audio = new Audio();
			p.audio.autoplay = true;
			__voice_apply_output(p.audio); // sortie (casque / haut-parleurs) et volume choisis
		}
		p.audio.srcObject = stream;
		var play = p.audio.play();
		if (play && play.catch) play.catch(function () {});
		p.analyser = __voice_analyser(stream);
	};
	pc.onconnectionstatechange = function () {
		if (pc.connectionState === "failed" && p.initiator && pc.restartIce) pc.restartIce();
		if (pc.connectionState === "connected") __voice_set_bitrate(pc);
	};
	if (p.initiator) {
		pc.onnegotiationneeded = function () {
			pc.createOffer().then(function (offer) {
				return pc.setLocalDescription({ type: offer.type, sdp: __voice_tune_sdp(offer.sdp) });
			}).then(function () {
				__voice_signal(id, { sdp: pc.localDescription });
			}).catch(function (err) { console.warn("[voice] offre :", err); });
		};
	}
	return p;
}

function __voice_peer_close(id) {
	var V = __voice;
	var p = V.peers[id];
	if (!p) return;
	try { p.pc.close(); } catch (e) {}
	if (p.track) p.track.stop();
	if (p.audio) { p.audio.srcObject = null; }
	delete V.peers[id];
}

// Messages techniques WebRTC reçus d'un autre joueur
function __voice_on_signal(from, sid, data) {
	var V = __voice;
	if (V.state !== "ready" || !data) return;
	var p = V.peers[from];
	if (!p || p.sid !== sid) {
		if (p) __voice_peer_close(from);
		p = __voice_peer_create(from, sid);
	}
	var pc = p.pc;
	if (data.sdp) {
		pc.setRemoteDescription(data.sdp).then(function () {
			p.remoteSet = true;
			for (var i = 0; i < p.pendingIce.length; i++) pc.addIceCandidate(p.pendingIce[i]).catch(function () {});
			p.pendingIce = [];
			if (data.sdp.type === "offer") {
				return pc.createAnswer().then(function (answer) {
					return pc.setLocalDescription({ type: answer.type, sdp: __voice_tune_sdp(answer.sdp) });
				}).then(function () {
					__voice_signal(from, { sdp: pc.localDescription });
				});
			}
		}).catch(function (err) { console.warn("[voice] sdp :", err); });
	} else if (data.ice) {
		if (p.remoteSet) pc.addIceCandidate(data.ice).catch(function () {});
		else p.pendingIce.push(data.ice);
	}
}

// ---------- Mesure du volume (pour savoir qui parle) ----------

function __voice_analyser(stream) {
	var V = __voice;
	if (!V.ctx) return null;
	try {
		var src = V.ctx.createMediaStreamSource(stream);
		var an = V.ctx.createAnalyser();
		an.fftSize = 512;
		src.connect(an);
		return { node: an, buf: new Uint8Array(an.fftSize) };
	} catch (e) { return null; }
}

function __voice_level(a) {
	if (!a) return 0;
	a.node.getByteTimeDomainData(a.buf);
	var sum = 0;
	for (var i = 0; i < a.buf.length; i++) {
		var v = (a.buf[i] - 128) / 128;
		sum += v * v;
	}
	return Math.min(1, Math.sqrt(sum / a.buf.length) * 4);
}
