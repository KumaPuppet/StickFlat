// =============================================================
//  BRUITAGES "PAPIER" (HTML5, WebAudio)
//  Tous les sons sont fabriqués à la volée à partir de bruit filtré :
//  papier froissé, déchiré, feuilles qui claquent, crayon qui gratte...
//  Aucun fichier audio à charger.
//  Appel depuis GameMaker : sfx_play(nom, pan (-1..1), force (0..1), volume (0..1))
// =============================================================

var __sfx = {
	ctx: null, master: null, noise: null,
	volume: 1, muted: false,
	last: {},      // nom -> heure du dernier son (anti-mitraillage)
	voices: []     // heures de fin des sons en cours (plafond)
};

// Intervalle minimal entre deux sons du même nom (secondes)
var __sfxGap = {
	hit: 0.035, land: 0.07, gatling: 0.045, flame: 0.08, pistol: 0.05, jump: 0.05,
	swing: 0.06, arrow_hit: 0.04, ui_hover: 0.05, ui_click: 0.04, pickup: 0.1, drop: 0.1,
	"break": 0.08, ko: 0.2, boom: 0.06, hunt: 0.06, parry: 0.05, bounce: 0.08
};
var SFX_MAX_VOICES = 28;

// Correction de volume par son : le bruit filtré très étroit (souffles, frottements)
// sort bien plus faible que les "pops" ; on remonte les sons doux pour équilibrer
var __sfxTrim = {
	jump: 5, land: 6, flame: 6, ui_click: 6, ui_hover: 8, bounce: 6, swing: 3.5, dash: 4,
	drop: 4, pickup: 3.5, "throw": 4, hook: 4, hunt: 4, fireball: 4, shuriken: 5, reload: 6,
	round: 3, win: 4, draft: 3.5, "break": 5, parry: 3, bow: 2, thrust: 3, teleport: 3, slice: 3,
	arrow_hit: 1.8, grab: 1.5
};

function __sfxInit() {
	if (__sfx.ctx) return __sfx.ctx;
	var AC = window.AudioContext || window.webkitAudioContext;
	if (!AC) return null;
	var ctx = new AC();
	__sfx.ctx = ctx;
	if (__sfx.sink) __sfxApplySink(ctx); // sortie audio choisie (voir plus bas)
	// Petit compresseur : les explosions et les rafales ne saturent pas
	var comp = ctx.createDynamicsCompressor();
	comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 5;
	comp.attack.value = 0.003; comp.release.value = 0.15;
	__sfx.master = ctx.createGain();
	__sfx.master.gain.value = __sfx.muted ? 0 : __sfx.volume;
	__sfx.master.connect(comp);
	comp.connect(ctx.destination);
	// 2 s de bruit blanc, réutilisé par tous les sons (départ au hasard dedans)
	var len = ctx.sampleRate * 2;
	var buf = ctx.createBuffer(1, len, ctx.sampleRate);
	var d = buf.getChannelData(0);
	for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
	__sfx.noise = buf;
	return ctx;
}

// Le navigateur n'autorise le son qu'après un clic ou une touche
(function () {
	function unlock() {
		var ctx = __sfxInit();
		if (ctx && ctx.state === "suspended") ctx.resume();
	}
	window.addEventListener("pointerdown", unlock, true);
	window.addEventListener("keydown", unlock, true);
	window.addEventListener("touchstart", unlock, true);
})();

function __rnd(a, b) { return a + Math.random() * (b - a); }

// Sortie d'un son : panoramique gauche/droite puis volume général
function __sfxOut(ctx, pan, vol) {
	var g = ctx.createGain();
	g.gain.value = vol;
	if (ctx.createStereoPanner) {
		var p = ctx.createStereoPanner();
		p.pan.value = Math.max(-1, Math.min(1, pan * 0.7));
		g.connect(p); p.connect(__sfx.master);
	} else g.connect(__sfx.master);
	return g;
}

// Bouffée de bruit filtré (la brique de base : un "grain" de papier)
function __grain(ctx, out, t, dur, freq, q, gain, type) {
	var src = ctx.createBufferSource();
	src.buffer = __sfx.noise;
	var f = ctx.createBiquadFilter();
	f.type = type || "bandpass";
	f.frequency.value = freq;
	f.Q.value = q;
	var g = ctx.createGain();
	g.gain.setValueAtTime(0.0001, t);
	g.gain.linearRampToValueAtTime(gain, t + Math.min(0.004, dur * 0.2));
	g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
	src.connect(f); f.connect(g); g.connect(out);
	src.start(t, Math.random() * 1.8, dur + 0.05);
	return f;
}

// Papier froissé : plein de petits craquements au hasard
function __crumple(ctx, out, t, dur, perSec, fmin, fmax, gain) {
	var n = Math.max(1, Math.round(dur * perSec));
	for (var i = 0; i < n; i++) {
		var tt = t + Math.pow(Math.random(), 1.6) * dur; // plus dense au début
		var fade = 1 - (tt - t) / (dur * 1.15);
		__grain(ctx, out, tt, __rnd(0.006, 0.025), __rnd(fmin, fmax), __rnd(1.5, 5), gain * fade * __rnd(0.4, 1));
	}
}

// Souffle : une feuille qui fend l'air (bruit dont le filtre glisse)
function __sweep(ctx, out, t, dur, f0, f1, q, gain) {
	var src = ctx.createBufferSource();
	src.buffer = __sfx.noise;
	var f = ctx.createBiquadFilter();
	f.type = "bandpass"; f.Q.value = q;
	f.frequency.setValueAtTime(f0, t);
	f.frequency.exponentialRampToValueAtTime(f1, t + dur);
	var g = ctx.createGain();
	g.gain.setValueAtTime(0.0001, t);
	g.gain.linearRampToValueAtTime(gain, t + dur * 0.35);
	g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
	src.connect(f); f.connect(g); g.connect(out);
	src.start(t, Math.random() * 1.5, dur + 0.05);
}

// Coup sourd : un carton qu'on tape (sinus qui descend)
function __thump(ctx, out, t, dur, f0, f1, gain, wave) {
	var o = ctx.createOscillator();
	o.type = wave || "sine";
	o.frequency.setValueAtTime(f0, t);
	o.frequency.exponentialRampToValueAtTime(f1, t + dur);
	var g = ctx.createGain();
	g.gain.setValueAtTime(0.0001, t);
	g.gain.linearRampToValueAtTime(gain, t + 0.004);
	g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
	o.connect(g); g.connect(out);
	o.start(t); o.stop(t + dur + 0.02);
}

// Papier déchiré : grains très serrés dont la hauteur monte
function __rip(ctx, out, t, dur, gain, f0, f1) {
	f0 = f0 || 1400; f1 = f1 || 3800;
	var tt = t;
	while (tt < t + dur) {
		var k = (tt - t) / dur;
		__grain(ctx, out, tt, __rnd(0.004, 0.012), f0 + (f1 - f0) * k + __rnd(-300, 300), __rnd(2, 6), gain * (0.5 + 0.5 * Math.sin(k * Math.PI)) * __rnd(0.5, 1));
		tt += __rnd(0.003, 0.009);
	}
	__sweep(ctx, out, t, dur, f0 * 0.7, f1, 0.8, gain * 0.35);
}

// Petit clic sec : un crayon qui tape, une carte qu'on pichenette
function __flick(ctx, out, t, freq, gain) {
	__grain(ctx, out, t, 0.018, freq, 7, gain);
	__grain(ctx, out, t + 0.002, 0.03, freq * 0.5, 3, gain * 0.5);
}

// Une page qu'on tourne
function __page(ctx, out, t, gain) {
	__sweep(ctx, out, t, 0.32, 500, 2600, 0.7, gain * 0.6);
	__crumple(ctx, out, t + 0.05, 0.25, 45, 1500, 5000, gain * 0.35);
	__grain(ctx, out, t + 0.3, 0.06, 700, 1, gain * 0.9, "lowpass");
}

// Crayon qui gribouille
function __scribble(ctx, out, t, dur, gain) {
	var tt = t;
	while (tt < t + dur) {
		var w = 0.5 + 0.5 * Math.sin((tt - t) * Math.PI * 2 * 7); // va-et-vient du crayon
		__grain(ctx, out, tt, __rnd(0.01, 0.025), __rnd(2500, 5500), __rnd(3, 8), gain * (0.25 + 0.75 * w));
		tt += __rnd(0.006, 0.014);
	}
}

var __sfxBank = {
	// --- Mouvements ---
	swing: function (c, o, t, v) {
		__sweep(c, o, t, 0.16 + 0.1 * v, 500, 2600 + 800 * v, 1.3, 0.45);
		__crumple(c, o, t, 0.06, 60, 2000, 5000, 0.12);
	},
	thrust: function (c, o, t, v) {
		__sweep(c, o, t, 0.12 + 0.06 * v, 1100, 3400, 1.8, 0.45);
		__flick(c, o, t + 0.1, 2600, 0.15);
	},
	jump: function (c, o, t, v) {
		__sweep(c, o, t, 0.11, 280, 950, 1.1, 0.22);
	},
	land: function (c, o, t, v) {
		__grain(c, o, t, 0.07, 420, 0.8, 0.35 * v, "lowpass");
		__crumple(c, o, t, 0.05, 80, 1500, 3500, 0.12 * v);
	},
	dash: function (c, o, t, v) {
		__sweep(c, o, t, 0.22, 400, 3000, 1, 0.45);
	},
	// --- Coups ---
	hit: function (c, o, t, v) {
		__thump(c, o, t, 0.07 + 0.08 * v, 190, 55, 0.35 + 0.45 * v);
		__grain(c, o, t, 0.05, 900, 0.9, 0.5 + 0.4 * v, "lowpass");
		__crumple(c, o, t, 0.05 + 0.12 * v, 70 + 100 * v, 1500, 5500, 0.18 + 0.25 * v);
	},
	"break": function (c, o, t, v) {
		__rip(c, o, t, 0.28, 0.5);
	},
	ko: function (c, o, t, v) {
		__thump(c, o, t, 0.4, 130, 40, 0.8);
		__crumple(c, o, t, 0.5, 140, 900, 5000, 0.4);
		__rip(c, o, t + 0.05, 0.35, 0.4, 1200, 3200);
	},
	parry: function (c, o, t, v) {
		__flick(c, o, t, 3200, 0.55);
		__thump(c, o, t, 0.09, 1300, 900, 0.12, "triangle"); // petit "clac" de carton
		__crumple(c, o, t + 0.01, 0.06, 80, 2500, 6000, 0.15);
	},
	// --- Tirs ---
	bow: function (c, o, t, v) {
		__thump(c, o, t, 0.22, 230 + 60 * v, 150, 0.22, "triangle"); // élastique
		__sweep(c, o, t + 0.01, 0.14, 1800, 3800, 2, 0.3);
	},
	hunt: function (c, o, t, v) {
		__thump(c, o, t, 0.12, 300, 200, 0.12, "triangle");
		__sweep(c, o, t, 0.1, 2000, 4000, 2, 0.22);
	},
	arrow_hit: function (c, o, t, v) {
		__thump(c, o, t, 0.06, 260, 120, 0.3);
		__flick(c, o, t, 1500, 0.3);
	},
	throw: function (c, o, t, v) {
		__sweep(c, o, t, 0.2 + 0.1 * v, 350, 1300, 1, 0.35);
	},
	bounce: function (c, o, t, v) {
		__grain(c, o, t, 0.05, 600, 1, 0.3 * v, "lowpass");
		__flick(c, o, t, 1800, 0.12 * v);
	},
	boom: function (c, o, t, v) {
		__thump(c, o, t, 0.45, 120, 32, 0.9 * v);
		__grain(c, o, t, 0.4, 500, 0.7, 0.8 * v, "lowpass");
		__crumple(c, o, t, 0.55, 160, 700, 5000, 0.4 * v);
		__rip(c, o, t + 0.02, 0.2, 0.3 * v, 900, 2500);
	},
	rifle: function (c, o, t, v) { // sac en papier qui éclate
		__grain(c, o, t, 0.04, 2500, 0.6, 1, "highpass");
		__thump(c, o, t, 0.14, 320, 50, 0.7);
		__crumple(c, o, t + 0.02, 0.18, 90, 1200, 5000, 0.25);
	},
	pistol: function (c, o, t, v) {
		__grain(c, o, t, 0.03, 2200, 0.7, 0.7, "highpass");
		__thump(c, o, t, 0.08, 360, 90, 0.45);
		__crumple(c, o, t + 0.01, 0.07, 80, 1500, 5000, 0.15);
	},
	gatling: function (c, o, t, v) {
		__grain(c, o, t, 0.025, 2000, 0.8, 0.45, "highpass");
		__thump(c, o, t, 0.05, 300, 110, 0.25);
	},
	flame: function (c, o, t, v) { // papier qui brûle : crépitements
		__crumple(c, o, t, 0.12, 70, 700, 3500, 0.22);
		__grain(c, o, t, 0.12, 350, 0.7, 0.15, "lowpass");
	},
	fireball: function (c, o, t, v) {
		__sweep(c, o, t, 0.3, 200, 700, 0.9, 0.45);
		__crumple(c, o, t, 0.3, 60, 800, 3500, 0.2);
	},
	bolt: function (c, o, t, v) {
		__rip(c, o, t, 0.22, 0.55, 2000, 5500);
		__thump(c, o, t + 0.04, 0.35, 160, 40, 0.7);
		__crumple(c, o, t + 0.05, 0.3, 120, 800, 4000, 0.3);
	},
	shuriken: function (c, o, t, v) {
		__flick(c, o, t, 3600, 0.35);
		__sweep(c, o, t, 0.13, 2500, 5000, 3, 0.25);
	},
	slice: function (c, o, t, v) { // ciseaux : deux coups de lame
		for (var i = 0; i < 2; i++) {
			var tt = t + i * 0.08;
			__grain(c, o, tt, 0.05, 4200, 2.5, 0.45);
			__thump(c, o, tt, 0.05, 3200, 2600, 0.06, "triangle");
		}
		__rip(c, o, t + 0.16, 0.18, 0.35, 2000, 4200);
	},
	// --- Pouvoirs ---
	teleport: function (c, o, t, v) { // feuilletage rapide
		for (var i = 0; i < 6; i++) __flick(c, o, t + i * 0.025 * (1 - i * 0.08), 2200 + i * 250, 0.3);
		__sweep(c, o, t, 0.25, 3500, 600, 0.9, 0.35);
	},
	grab: function (c, o, t, v) {
		__crumple(c, o, t, 0.25, 120, 900, 4500, 0.35);
		__thump(c, o, t, 0.12, 160, 70, 0.4);
	},
	hook: function (c, o, t, v) {
		__sweep(c, o, t, 0.16, 800, 3000, 1.5, 0.3);
		__flick(c, o, t + 0.15, 2000, 0.25);
	},
	pickup: function (c, o, t, v) {
		__sweep(c, o, t, 0.12, 2400, 1400, 1.2, 0.22);
		__flick(c, o, t + 0.08, 2600, 0.2);
	},
	drop: function (c, o, t, v) {
		__sweep(c, o, t, 0.15, 900, 2400, 1, 0.22);
	},
	reload: function (c, o, t, v) {
		__flick(c, o, t, 2000, 0.3);
		__flick(c, o, t + 0.12, 2800, 0.3);
	},
	// --- Partie ---
	round: function (c, o, t, v) { __page(c, o, t, 0.6); },
	win: function (c, o, t, v) {
		__scribble(c, o, t, 0.55, 0.25);
		__flick(c, o, t + 0.6, 2400, 0.3);
	},
	draft: function (c, o, t, v) { // cartes qu'on distribue
		for (var i = 0; i < 3; i++) {
			__sweep(c, o, t + i * 0.1, 0.09, 1200, 3200, 1.4, 0.3);
			__flick(c, o, t + i * 0.1 + 0.08, 2200, 0.25);
		}
	},
	// --- Interface ---
	ui_click: function (c, o, t, v) { __flick(c, o, t, 2600, 0.4); },
	ui_hover: function (c, o, t, v) { __grain(c, o, t, 0.02, 3800, 4, 0.08); }
};

/// Joue un son. pan : -1 (gauche) .. 1 (droite) ; vol : 0..1 (force du coup) ;
/// gain : 0..1 (volume réglé par le joueur pour ce type de son)
function sfx_play(name, pan, vol, gain) {
	try {
		gain = (gain === undefined) ? 1 : Math.max(0, Math.min(1, +gain || 0));
		if (__sfx.muted || __sfx.volume <= 0 || gain <= 0) return 0;
		var make = __sfxBank[name];
		if (!make) return 0;
		var ctx = __sfxInit();
		if (!ctx || ctx.state !== "running") return 0; // pas encore de clic : on ne fait rien
		var now = ctx.currentTime;
		var gap = __sfxGap[name] || 0.03;
		if (__sfx.last[name] !== undefined && now - __sfx.last[name] < gap) return 0;
		__sfx.voices = __sfx.voices.filter(function (e) { return e > now; });
		if (__sfx.voices.length >= SFX_MAX_VOICES) return 0;
		__sfx.last[name] = now;
		__sfx.voices.push(now + 0.6);
		vol = Math.max(0, Math.min(1, +vol || 0));
		var out = __sfxOut(ctx, +pan || 0, (0.35 + 0.65 * vol) * (__sfxTrim[name] || 1) * gain);
		make(ctx, out, now + 0.005, vol);
		return 1;
	} catch (e) { return 0; }
}

/// Volume général des bruitages (0..1)
function sfx_set_volume(v) {
	__sfx.volume = Math.max(0, Math.min(1, +v || 0));
	if (__sfx.master) __sfx.master.gain.value = __sfx.muted ? 0 : __sfx.volume;
	return 1;
}

/// Coupe (1) ou remet (0) les bruitages
function sfx_set_mute(on) {
	__sfx.muted = !!on;
	if (__sfx.master) __sfx.master.gain.value = __sfx.muted ? 0 : __sfx.volume;
	return 1;
}

// =============================================================
//  SORTIE AUDIO (casque, enceintes...) : Chrome et Edge (AudioContext.setSinkId)
//  Les bruitages (ce fichier) et la musique (son GameMaker, g_WebAudioContext)
//  partent tous les deux vers la sortie choisie.
// =============================================================
__sfx.sink = "";          // sortie choisie ("" = celle du système)
__sfx.outs = [];          // sorties trouvées : [{ id, label }]
__sfx.outState = "idle";  // "idle", "asking", "ready", "denied"

function __sfxSupportsSink() {
	var AC = window.AudioContext || window.webkitAudioContext;
	return !!(AC && AC.prototype && typeof AC.prototype.setSinkId === "function"
		&& navigator.mediaDevices && navigator.mediaDevices.enumerateDevices);
}

function __sfxApplySink(ctx) {
	if (!ctx || typeof ctx.setSinkId !== "function") return;
	try {
		var p = ctx.setSinkId(__sfx.sink);
		if (p && p.catch) p.catch(function () {});
	} catch (e) {}
}

function __sfxListOutputs() {
	return navigator.mediaDevices.enumerateDevices().then(function (devs) {
		var outs = [];
		devs.forEach(function (d) {
			// "default" et "communications" sont des alias de Windows : on garde les vraies sorties
			if (d.kind === "audiooutput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications") {
				outs.push({ id: d.deviceId, label: d.label || "" });
			}
		});
		return outs;
	});
}

/// Cherche les sorties audio. ask = 1 : demande l'autorisation si les noms sont cachés
/// (le navigateur ne donne le nom des sorties qu'après l'accès au micro, coupé aussitôt)
function sfx_out_scan(ask) {
	if (!__sfxSupportsSink()) return 0;
	__sfxListOutputs().then(function (outs) {
		var named = outs.length > 0 && outs.every(function (o) { return o.label !== ""; });
		if (named || !ask) {
			__sfx.outs = named ? outs : [];
			if (named) __sfx.outState = "ready";
			return;
		}
		__sfx.outState = "asking";
		navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
			stream.getTracks().forEach(function (t) { t.stop(); });
			return __sfxListOutputs().then(function (outs2) {
				__sfx.outs = outs2;
				__sfx.outState = "ready";
			});
		}).catch(function () { __sfx.outState = "denied"; });
	}).catch(function () {});
	return 1;
}

/// État pour GameMaker (texte JSON) : { ok, state, outs: [{ id, label }] }
function sfx_out_info() {
	return JSON.stringify({ ok: __sfxSupportsSink() ? 1 : 0, state: __sfx.outState, outs: __sfx.outs });
}

/// Choisit la sortie ("" = celle du système), pour les bruitages et la musique
function sfx_out_set(id) {
	if (!__sfxSupportsSink()) return 0;
	__sfx.sink = String(id || "");
	__sfxApplySink(__sfx.ctx);
	if (typeof g_WebAudioContext !== "undefined") __sfxApplySink(g_WebAudioContext);
	return 1;
}
