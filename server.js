// ============================================================================
// DERAIL — server.js
// Express serves the static client. A single WebSocket server runs the whole
// game engine: rooms, turns, timers, callouts, voting, and scoring all live
// here, in memory. No database — rooms disappear when the last person leaves.
// ============================================================================

const path = require("path");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const session = require("express-session");
const { WebSocketServer } = require("ws");
const { setupPassport, configuredProviders } = require("./auth");
const localAuth = require("./local-auth");
const aiJudge = require("./ai-judge");
const stats = require("./stats");
const purchases = require("./purchases");

const PORT = process.env.PORT || 8080;
const IS_PROD = process.env.NODE_ENV === "production";

// A signed, httpOnly session cookie is how we recognize "the same browser"
// (guests) or "the same OAuth account" (logged-in players) across requests
// and across the WebSocket handshake. The cookie itself never contains
// player data — just an opaque, server-signed session id.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) {
  console.warn(
    "[derail] SESSION_SECRET not set — using a random one for this process only. " +
      "Logins will be forgotten on every restart. Set SESSION_SECRET in production."
  );
}

const sessionParser = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: IS_PROD,
    maxAge: 90 * 24 * 60 * 60 * 1000, // 90 days
  },
});

const passport = setupPassport();

const app = express();
if (IS_PROD) app.set("trust proxy", 1); // needed so `secure` cookies work behind Render/Railway/Fly proxies
app.use(sessionParser);
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, "public")));

// ----------------------------------------------------------------------------
// Auth routes — each one only exists if its env vars are configured.
// ----------------------------------------------------------------------------

app.get("/auth/providers", (req, res) => res.json({ providers: configuredProviders() }));

app.get("/config", (req, res) => res.json({ aiJudgeAvailable: aiJudge.isConfigured() }));

app.get("/leaderboard", (req, res) => res.json({ leaderboard: stats.getLeaderboard(20) }));

app.get("/entitlements/me", (req, res) => {
  const identity = identityFromRequest(req);
  res.json({ owned: purchases.getEntitlements(identity.identityId) });
});

// ----------------------------------------------------------------------------
// Stripe webhook — grants a cosmetic entitlement the moment a payment
// completes. Needs STRIPE_SECRET_KEY (only used to verify the webhook
// signature here) and STRIPE_WEBHOOK_SECRET set as env vars, and a webhook
// endpoint configured in the Stripe dashboard pointing at
// https://yourdomain.com/webhooks/stripe listening for
// "checkout.session.completed". See README for the full walkthrough,
// including how client_reference_id carries the buyer's identityId.
// Uses express.raw (not express.json) because Stripe's signature check
// needs the exact, untouched request body bytes.
// ----------------------------------------------------------------------------

app.post("/webhooks/stripe", express.raw({ type: "application/json" }), (req, res) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.warn("[derail] Stripe webhook hit but STRIPE_WEBHOOK_SECRET isn't set — ignoring.");
    return res.status(503).send("not configured");
  }

  let event;
  try {
    // Verifying the signature ourselves (HMAC-SHA256, Stripe's documented
    // scheme) avoids requiring the full `stripe` npm package just for this
    // one check.
    const sig = req.headers["stripe-signature"] || "";
    const parts = Object.fromEntries(sig.split(",").map((p) => p.split("=")));
    const signedPayload = `${parts.t}.${req.body}`;
    const expected = crypto.createHmac("sha256", webhookSecret).update(signedPayload).digest("hex");
    if (!parts.v1 || !crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected))) {
      throw new Error("signature mismatch");
    }
    event = JSON.parse(req.body);
  } catch (err) {
    console.error("[derail] Stripe webhook signature check failed:", err.message);
    return res.status(400).send("invalid signature");
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const identityId = session.client_reference_id;
    const sku = session.metadata?.sku;
    if (identityId && sku) {
      purchases.grant(identityId, sku);
      console.log(`[derail] granted cosmetic "${sku}" to ${identityId}`);
    } else {
      console.warn("[derail] Stripe session completed but missing client_reference_id or metadata.sku — nothing granted.");
    }
  }

  res.json({ received: true });
});

app.get("/auth/me", (req, res) => {
  res.json({ user: req.user || null });
});

app.post("/auth/logout", (req, res) => {
  req.logout(() => res.json({ ok: true }));
});

// ----------------------------------------------------------------------------
// Local username/password accounts — always available, no OAuth app setup
// required. A light per-IP attempt limiter on top of the existing
// room-action limiter, since login guessing is a different kind of abuse.
// ----------------------------------------------------------------------------

const loginAttempts = new Map(); // ip -> { count, resetAt }
function loginRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 10;
}

app.post("/auth/local/register", express.json(), (req, res) => {
  const ip = clientIp(req);
  if (loginRateLimited(ip)) return res.status(429).json({ error: "rate_limited" });
  const { username, password } = req.body || {};
  const result = localAuth.register(String(username || ""), String(password || ""));
  if (result.error) return res.status(400).json({ error: result.error });
  req.login(result.user, (err) => {
    if (err) return res.status(500).json({ error: "session_error" });
    res.json({ user: result.user });
  });
});

app.post("/auth/local/login", express.json(), (req, res) => {
  const ip = clientIp(req);
  if (loginRateLimited(ip)) return res.status(429).json({ error: "rate_limited" });
  const { username, password } = req.body || {};
  const result = localAuth.login(String(username || ""), String(password || ""));
  if (result.error) return res.status(400).json({ error: result.error });
  req.login(result.user, (err) => {
    if (err) return res.status(500).json({ error: "session_error" });
    res.json({ user: result.user });
  });
});

if (configuredProviders().includes("google")) {
  app.get("/auth/google", passport.authenticate("google", { scope: ["profile"] }));
  app.get(
    "/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/?auth=failed" }),
    (req, res) => res.redirect("/?auth=ok")
  );
}
if (configuredProviders().includes("github")) {
  app.get("/auth/github", passport.authenticate("github", { scope: ["read:user"] }));
  app.get(
    "/auth/github/callback",
    passport.authenticate("github", { failureRedirect: "/?auth=failed" }),
    (req, res) => res.redirect("/?auth=ok")
  );
}
if (configuredProviders().includes("discord")) {
  app.get("/auth/discord", passport.authenticate("discord"));
  app.get(
    "/auth/discord/callback",
    passport.authenticate("discord", { failureRedirect: "/?auth=failed" }),
    (req, res) => res.redirect("/?auth=ok")
  );
}

const server = http.createServer(app);
// `noServer` + manual upgrade handling lets us run the same sessionParser
// (and therefore know who's logged in) before a WebSocket connection opens.
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  sessionParser(req, {}, () => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
});

// ----------------------------------------------------------------------------
// Content pools — one set per supported match language. Goal `id`s stay
// identical across languages (only `text` changes) because the callout
// guess-picker matches on id, not text.
// ----------------------------------------------------------------------------

const SCENARIOS_BY_LANG = {
  en: [
    "Dave walks into a diner at 2:00 AM and sits at the counter.",
    "The city council meeting starts thirty seconds late, as always.",
    "Margaret finds a package on her porch that she didn't order.",
    "The intern is the last one left in the office at 6 PM.",
    "A man in a rumpled suit boards the 11:42 train to nowhere in particular.",
    "The wedding photographer arrives an hour before the ceremony.",
    "Two coworkers are stuck in an elevator between the 3rd and 4th floor.",
    "The new tenant is unpacking boxes in apartment 4B.",
    "A substitute teacher takes attendance for the first time.",
    "The night security guard clocks in for another quiet shift at the museum.",
    "A tired barista steams milk for the last customer before closing.",
    "The new hire is introduced to the team over video call, camera off.",
    "A tow truck driver hooks up a car parked in the wrong spot.",
    "Grandma pulls a mysterious casserole dish out of the freezer.",
    "The dentist's waiting room fills up ten minutes before opening.",
    "A delivery driver double-checks the address before ringing the doorbell.",
    "The office printer jams for the third time this week.",
    "Two strangers reach for the last umbrella at the same time.",
    "A librarian shushes the reading room out of pure habit.",
    "The last customer of the day walks into the hardware store at 8:58 PM.",
    "A family reunion photo is about to be taken, and someone is still missing.",
  ],
  el: [
    "Ο Ντίνος μπαίνει σε ένα εστιατόριο στις 2:00 τη νύχτα και κάθεται στον πάγκο.",
    "Η συνεδρίαση του δημοτικού συμβουλίου ξεκινά, όπως πάντα, με μισό λεπτό καθυστέρηση.",
    "Η Μαργαρίτα βρίσκει ένα δέμα στη βεράντα της που δεν είχε παραγγείλει.",
    "Ο ασκούμενος είναι ο τελευταίος που έχει μείνει στο γραφείο στις 6 το απόγευμα.",
    "Ένας άντρας με τσαλακωμένο κοστούμι επιβιβάζεται στο τρένο των 11:42, χωρίς συγκεκριμένο προορισμό.",
    "Ο φωτογράφος του γάμου φτάνει μία ώρα πριν την τελετή.",
    "Δύο συνάδελφοι μένουν κολλημένοι στο ασανσέρ ανάμεσα στον 3ο και τον 4ο όροφο.",
    "Ο νέος ένοικος ξεπακετάρει κούτες στο διαμέρισμα 4Β.",
    "Μια αναπληρώτρια καθηγήτρια παίρνει παρουσίες για πρώτη φορά.",
    "Ο νυχτοφύλακας του μουσείου μπαίνει βάρδια για άλλη μια ήσυχη νύχτα.",
    "Μια κουρασμένη μπαρίστα ζεσταίνει γάλα για τον τελευταίο πελάτη πριν το κλείσιμο.",
    "Ο νέος υπάλληλος συστήνεται στην ομάδα μέσω βιντεοκλήσης, με κλειστή κάμερα.",
    "Ένας γερανοφόρος γαντζώνει ένα αυτοκίνητο παρκαρισμένο σε λάθος θέση.",
    "Η γιαγιά βγάζει ένα μυστηριώδες ταψί από την κατάψυξη.",
    "Η αίθουσα αναμονής του οδοντιάτρου γεμίζει δέκα λεπτά πριν το άνοιγμα.",
    "Ένας διανομέας ελέγχει ξανά τη διεύθυνση πριν χτυπήσει το κουδούνι.",
    "Ο εκτυπωτής του γραφείου κολλάει για τρίτη φορά αυτή την εβδομάδα.",
    "Δύο άγνωστοι απλώνουν το χέρι για την τελευταία ομπρέλα ταυτόχρονα.",
    "Μια βιβλιοθηκάριος κάνει «σουτ» στην αίθουσα ανάγνωσης από απλή συνήθεια.",
    "Ο τελευταίος πελάτης της ημέρας μπαίνει στο κατάστημα σιδηρικών στις 8:58 το βράδυ.",
    "Μια οικογενειακή φωτογραφία πρόκειται να τραβηχτεί, και κάποιος λείπει ακόμα.",
  ],
  es: [
    "Dave entra en una cafetería a las 2:00 AM y se sienta en la barra.",
    "La reunión del ayuntamiento empieza, como siempre, treinta segundos tarde.",
    "Margarita encuentra un paquete en su porche que no había pedido.",
    "El becario es el último que queda en la oficina a las 6 de la tarde.",
    "Un hombre con traje arrugado sube al tren de las 11:42 sin destino concreto.",
    "El fotógrafo de la boda llega una hora antes de la ceremonia.",
    "Dos compañeros de trabajo quedan atrapados en el ascensor entre el piso 3 y el 4.",
    "El nuevo inquilino está desempacando cajas en el apartamento 4B.",
    "Una profesora sustituta pasa lista por primera vez.",
    "El guardia de seguridad nocturno ficha para otro turno tranquilo en el museo.",
    "Una barista agotada calienta leche para el último cliente antes de cerrar.",
    "El nuevo empleado se presenta al equipo por videollamada, con la cámara apagada.",
    "Un camión grúa engancha un coche mal aparcado.",
    "La abuela saca un misterioso plato del congelador.",
    "La sala de espera del dentista se llena diez minutos antes de abrir.",
    "Un repartidor comprueba dos veces la dirección antes de tocar el timbre.",
    "La impresora de la oficina se atasca por tercera vez esta semana.",
    "Dos desconocidos alcanzan el último paraguas al mismo tiempo.",
    "Una bibliotecaria manda callar a la sala de lectura por pura costumbre.",
    "El último cliente del día entra a la ferretería a las 8:58 de la noche.",
    "Están a punto de tomar la foto de la reunión familiar y todavía falta alguien.",
  ],
};

// `trojan: true` marks the one "just be normal" goal.
const GOAL_POOL_BY_LANG = {
  en: [
    { id: "arrest", text: "The protagonist must get arrested for tax evasion.", trojan: false },
    { id: "horse", text: "Someone must ride a horse indoors.", trojan: false },
    { id: "ghost", text: "It must be revealed that the protagonist has been a ghost the whole time.", trojan: false },
    { id: "space", text: "The building must physically launch into space.", trojan: false },
    { id: "wedding", text: "An unplanned wedding must happen before the scene ends.", trojan: false },
    { id: "clone", text: "A character must turn out to be a clone or robot double.", trojan: false },
    { id: "kfire", text: "A kitchen fire must break out.", trojan: false },
    { id: "singing", text: "The scene must break into spontaneous group singing.", trojan: false },
    { id: "raccoon", text: "A raccoon must be revealed as the real mastermind.", trojan: false },
    { id: "timeloop", text: "It must become clear that this exact scene has happened before.", trojan: false },
    { id: "lottery", text: "Someone must win the lottery mid-scene.", trojan: false },
    { id: "alien", text: "A character must be exposed as an alien in disguise.", trojan: false },
    { id: "shrek", text: "The story must become a legally-distinct version of a certain ogre movie.", trojan: false },
    { id: "flood", text: "The room must start flooding with water.", trojan: false },
    { id: "celebrity", text: "A world-famous celebrity must walk in and be recognized.", trojan: false },
    { id: "breakup", text: "Two characters must break up on the spot.", trojan: false },
    { id: "heist", text: "A heist must begin before the scene ends.", trojan: false },
    { id: "dance", text: "A full choreographed dance number must break out.", trojan: false },
    { id: "twins", text: "A secret identical twin must appear.", trojan: false },
    { id: "portal", text: "A portal to another dimension must open.", trojan: false },
    { id: "superhero", text: "A character must reveal a secret superpower.", trojan: false },
    { id: "musical_instrument", text: "Someone must produce a full orchestra's worth of instruments from nowhere.", trojan: false },
    { id: "royalty", text: "A character must be revealed as secret royalty.", trojan: false },
    { id: "swap_bodies", text: "Two characters must swap bodies.", trojan: false },
    { id: "food_fight", text: "A full food fight must break out.", trojan: false },
    { id: "underground", text: "A hidden underground tunnel or bunker must be discovered.", trojan: false },
    { id: "talking_animal", text: "An animal must start talking and nobody finds it strange.", trojan: false },
    { id: "prophecy", text: "An old prophecy must come true.", trojan: false },
    { id: "shrink", text: "Someone must be shrunk to miniature size.", trojan: false },
    { id: "evil_twin", text: "A character's evil twin must show up.", trojan: false },
    { id: "time_travel", text: "A character must accidentally reveal they're from the future or past.", trojan: false },
    { id: "invisible", text: "A character must turn invisible in front of everyone.", trojan: false },
    { id: "curse", text: "An old curse or hex must activate.", trojan: false },
    { id: "secret_agent", text: "A character must be exposed as an undercover secret agent.", trojan: false },
    { id: "normal", text: "Keep things completely normal — no twists, no chaos. Just a mundane, uneventful scene.", trojan: true },
  ],
  el: [
    { id: "arrest", text: "Ο πρωταγωνιστής πρέπει να συλληφθεί για φοροδιαφυγή.", trojan: false },
    { id: "horse", text: "Κάποιος πρέπει να καβαλήσει άλογο μέσα σε κλειστό χώρο.", trojan: false },
    { id: "ghost", text: "Πρέπει να αποκαλυφθεί ότι ο πρωταγωνιστής ήταν φάντασμα από την αρχή.", trojan: false },
    { id: "space", text: "Το κτίριο πρέπει κυριολεκτικά να εκτοξευτεί στο διάστημα.", trojan: false },
    { id: "wedding", text: "Πρέπει να γίνει ένας απρογραμμάτιστος γάμος πριν τελειώσει η σκηνή.", trojan: false },
    { id: "clone", text: "Κάποιος χαρακτήρας πρέπει να αποδειχθεί κλώνος ή ρομποτικό διπλό.", trojan: false },
    { id: "kfire", text: "Πρέπει να ξεσπάσει φωτιά στην κουζίνα.", trojan: false },
    { id: "singing", text: "Η σκηνή πρέπει να μετατραπεί ξαφνικά σε ομαδικό τραγούδι.", trojan: false },
    { id: "raccoon", text: "Ένα ρακούν πρέπει να αποκαλυφθεί ως ο πραγματικός εγκέφαλος όλων.", trojan: false },
    { id: "timeloop", text: "Πρέπει να γίνει σαφές ότι αυτή ακριβώς η σκηνή έχει ξαναγίνει.", trojan: false },
    { id: "lottery", text: "Κάποιος πρέπει να κερδίσει το λαχείο μέσα στη σκηνή.", trojan: false },
    { id: "alien", text: "Ένας χαρακτήρας πρέπει να αποκαλυφθεί ως εξωγήινος μεταμφιεσμένος.", trojan: false },
    { id: "shrek", text: "Η ιστορία πρέπει να μετατραπεί σε μια «διαφορετική» εκδοχή μιας γνωστής ταινίας με ένα πράσινο τέρας.", trojan: false },
    { id: "flood", text: "Ο χώρος πρέπει να αρχίσει να πλημμυρίζει με νερό.", trojan: false },
    { id: "celebrity", text: "Μια παγκοσμίως διάσημη διασημότητα πρέπει να μπει και να αναγνωριστεί.", trojan: false },
    { id: "breakup", text: "Δύο χαρακτήρες πρέπει να χωρίσουν επιτόπου.", trojan: false },
    { id: "heist", text: "Πρέπει να ξεκινήσει μια ληστεία πριν τελειώσει η σκηνή.", trojan: false },
    { id: "dance", text: "Πρέπει να ξεσπάσει ένας ολοκληρωμένος χορευτικός αριθμός.", trojan: false },
    { id: "twins", text: "Πρέπει να εμφανιστεί ένας κρυφός πανομοιότυπος δίδυμος.", trojan: false },
    { id: "portal", text: "Πρέπει να ανοίξει μια πύλη προς άλλη διάσταση.", trojan: false },
    { id: "superhero", text: "Ένας χαρακτήρας πρέπει να αποκαλύψει μια κρυφή υπερδύναμη.", trojan: false },
    { id: "musical_instrument", text: "Κάποιος πρέπει να βγάλει από το πουθενά μια ολόκληρη ορχήστρα οργάνων.", trojan: false },
    { id: "royalty", text: "Ένας χαρακτήρας πρέπει να αποκαλυφθεί ως κρυφή βασιλική οικογένεια.", trojan: false },
    { id: "swap_bodies", text: "Δύο χαρακτήρες πρέπει να ανταλλάξουν σώματα.", trojan: false },
    { id: "food_fight", text: "Πρέπει να ξεσπάσει πλήρης μάχη με φαγητό.", trojan: false },
    { id: "underground", text: "Πρέπει να ανακαλυφθεί ένα κρυφό υπόγειο τούνελ ή καταφύγιο.", trojan: false },
    { id: "talking_animal", text: "Ένα ζώο πρέπει να αρχίσει να μιλάει και κανείς να μη βρίσκει κάτι περίεργο.", trojan: false },
    { id: "prophecy", text: "Μια παλιά προφητεία πρέπει να πραγματοποιηθεί.", trojan: false },
    { id: "shrink", text: "Κάποιος πρέπει να μικρύνει σε μινιατούρα.", trojan: false },
    { id: "evil_twin", text: "Πρέπει να εμφανιστεί ο κακός δίδυμος ενός χαρακτήρα.", trojan: false },
    { id: "time_travel", text: "Ένας χαρακτήρας πρέπει κατά λάθος να αποκαλύψει ότι είναι από το μέλλον ή το παρελθόν.", trojan: false },
    { id: "invisible", text: "Ένας χαρακτήρας πρέπει να γίνει αόρατος μπροστά σε όλους.", trojan: false },
    { id: "curse", text: "Μια παλιά κατάρα πρέπει να ενεργοποιηθεί.", trojan: false },
    { id: "secret_agent", text: "Ένας χαρακτήρας πρέπει να αποκαλυφθεί ως μυστικός πράκτορας.", trojan: false },
    { id: "normal", text: "Κράτα τα πράγματα εντελώς φυσιολογικά — καμία ανατροπή, καμία τρέλα. Απλώς μια ήσυχη, καθημερινή σκηνή.", trojan: true },
  ],
  es: [
    { id: "arrest", text: "El protagonista debe ser arrestado por evasión de impuestos.", trojan: false },
    { id: "horse", text: "Alguien debe montar un caballo dentro de un edificio.", trojan: false },
    { id: "ghost", text: "Debe revelarse que el protagonista ha sido un fantasma todo el tiempo.", trojan: false },
    { id: "space", text: "El edificio debe lanzarse físicamente al espacio.", trojan: false },
    { id: "wedding", text: "Debe ocurrir una boda improvisada antes de que termine la escena.", trojan: false },
    { id: "clone", text: "Un personaje debe resultar ser un clon o doble robótico.", trojan: false },
    { id: "kfire", text: "Debe estallar un incendio en la cocina.", trojan: false },
    { id: "singing", text: "La escena debe convertirse de repente en un número musical grupal.", trojan: false },
    { id: "raccoon", text: "Un mapache debe ser revelado como el verdadero cerebro detrás de todo.", trojan: false },
    { id: "timeloop", text: "Debe quedar claro que esta misma escena ya ha ocurrido antes.", trojan: false },
    { id: "lottery", text: "Alguien debe ganar la lotería en medio de la escena.", trojan: false },
    { id: "alien", text: "Un personaje debe ser expuesto como un extraterrestre disfrazado.", trojan: false },
    { id: "shrek", text: "La historia debe convertirse en una versión «legalmente distinta» de cierta película de un ogro verde.", trojan: false },
    { id: "flood", text: "El lugar debe empezar a inundarse de agua.", trojan: false },
    { id: "celebrity", text: "Una celebridad mundialmente famosa debe entrar y ser reconocida.", trojan: false },
    { id: "breakup", text: "Dos personajes deben romper su relación en el acto.", trojan: false },
    { id: "heist", text: "Debe comenzar un atraco antes de que termine la escena.", trojan: false },
    { id: "dance", text: "Debe estallar un número de baile totalmente coreografiado.", trojan: false },
    { id: "twins", text: "Debe aparecer un gemelo idéntico secreto.", trojan: false },
    { id: "portal", text: "Debe abrirse un portal a otra dimensión.", trojan: false },
    { id: "superhero", text: "Un personaje debe revelar un superpoder secreto.", trojan: false },
    { id: "musical_instrument", text: "Alguien debe sacar de la nada toda una orquesta de instrumentos.", trojan: false },
    { id: "royalty", text: "Un personaje debe resultar ser de la realeza en secreto.", trojan: false },
    { id: "swap_bodies", text: "Dos personajes deben intercambiar cuerpos.", trojan: false },
    { id: "food_fight", text: "Debe estallar una guerra de comida en toda regla.", trojan: false },
    { id: "underground", text: "Debe descubrirse un túnel o búnker secreto bajo tierra.", trojan: false },
    { id: "talking_animal", text: "Un animal debe empezar a hablar y a nadie le debe parecer extraño.", trojan: false },
    { id: "prophecy", text: "Una vieja profecía debe cumplirse.", trojan: false },
    { id: "shrink", text: "Alguien debe encogerse hasta un tamaño miniatura.", trojan: false },
    { id: "evil_twin", text: "Debe aparecer el gemelo malvado de un personaje.", trojan: false },
    { id: "time_travel", text: "Un personaje debe revelar por accidente que viene del futuro o del pasado.", trojan: false },
    { id: "invisible", text: "Un personaje debe volverse invisible delante de todos.", trojan: false },
    { id: "curse", text: "Una vieja maldición debe activarse.", trojan: false },
    { id: "secret_agent", text: "Un personaje debe ser expuesto como agente secreto encubierto.", trojan: false },
    { id: "normal", text: "Mantén todo completamente normal — sin giros, sin caos. Solo una escena tranquila y cotidiana.", trojan: true },
  ],
};

const BANNED_WORD_POOL_BY_LANG = {
  en: [
    "suddenly", "alien", "gun", "ghost", "explode", "magic", "secretly",
    "horse", "space", "wedding", "fire", "twin", "portal", "clone",
    "dance", "raccoon", "flood", "shrek", "lottery", "heist",
  ],
  el: [
    "ξαφνικά", "εξωγήινος", "όπλο", "φάντασμα", "εκρήγνυται", "μαγικό", "κρυφά",
    "άλογο", "διάστημα", "γάμος", "φωτιά", "δίδυμος", "πύλη", "κλώνος",
    "χορός", "ρακούν", "πλημμύρα", "λαχείο", "ληστεία",
  ],
  es: [
    "de repente", "extraterrestre", "pistola", "fantasma", "explota", "mágico", "secretamente",
    "caballo", "espacio", "boda", "incendio", "gemelo", "portal", "clon",
    "baile", "mapache", "inundación", "lotería", "atraco",
  ],
};

const SUPPORTED_LANGS = ["en", "el", "es"];
function normalizeLang(lang) {
  return SUPPORTED_LANGS.includes(lang) ? lang : "en";
}

// ----------------------------------------------------------------------------
// Player-name profanity filter (names only — never applied to story text,
// that would ruin the whole point of the game). Deliberately a short,
// common-terms list rather than an exhaustive one; masks everything after
// the first character of each match.
// ----------------------------------------------------------------------------

const NAME_BLOCKLIST = [
  "fuck", "shit", "bitch", "cunt", "asshole", "dick", "pussy", "whore", "slut",
  "nigger", "nigga", "faggot", "retard", "rape", "porn", "hitler", "nazi",
];

function censorName(raw) {
  let name = String(raw || "").trim().slice(0, 18);
  if (!name) return "Player";
  NAME_BLOCKLIST.forEach((word) => {
    const re = new RegExp(word, "ig");
    name = name.replace(re, (match) => match[0] + "*".repeat(Math.max(1, match.length - 1)));
  });
  // if literally nothing but symbols/asterisks survived, fall back to a safe default
  if (!/[a-zA-Z0-9\u0370-\u03ff\u1f00-\u1fff\u00c0-\u017f]/.test(name.replace(/\*/g, ""))) {
    return "Player";
  }
  return name;
}

// ----------------------------------------------------------------------------
// Tunables (defaults — the host can override per-room in the lobby)
// ----------------------------------------------------------------------------

const TURN_SECONDS_DEFAULT = 15;
const MAX_ROUNDS_DEFAULT = 10;
const GAME_TIME_LIMIT_MS = 6 * 60 * 1000; // hard backstop, independent of host settings
const VOTE_SECONDS = 15;
const CALLOUT_SECONDS = 20;

const TURN_SECONDS_OPTIONS = [10, 15, 20, 30];
const MAX_ROUNDS_OPTIONS = [6, 8, 10, 14, 20];
const TROJAN_MODES = ["auto", "always", "never"]; // auto = only when 3+ players
const CHAOS_LEVELS = { off: 0, normal: 2, chaos: 4 };

// ----------------------------------------------------------------------------
// Room state
// ----------------------------------------------------------------------------

/** @type {Map<string, Room>} */
const rooms = new Map();

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function makeRoom(code) {
  return {
    code,
    players: new Map(), // id -> player
    hostId: null,
    state: "lobby", // lobby | playing | callout | voting | reveal
    settings: {
      language: "en",
      turnSeconds: TURN_SECONDS_DEFAULT,
      maxRounds: MAX_ROUNDS_DEFAULT,
      trojanMode: "auto", // auto | always | never
      chaos: "normal", // off | normal | chaos — how many words get banned per round
      isPublic: false, // visible to "quick match"?
      aiJudge: aiJudge.isConfigured(), // AI-judged reveal instead of peer voting, when available
      customScenario: "", // host-written opening line; blank = pick randomly
    },
    scenario: null,
    story: [], // { text, playerId, name }
    turnOrder: [],
    currentTurnIndex: 0,
    round: 0,
    bannedWords: [],
    startedAt: null,
    turnTimer: null,
    turnEndsAt: null,
    skipNextTurn: new Set(), // player ids who lose their next turn
    callout: null, // { callerId, targetId, endsAt, timer }
    voting: null, // { subjects: [playerId...], ballots: Map(subjectId -> {yes,no}), voters: Map(voterId -> Set(subjectId voted)), endsAt, timer }
  };
}

function getRoom(code) {
  return rooms.get(code);
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    avatar: p.avatar || null,
    account: !!p.account,
    connected: p.connected,
    score: p.score,
    busted: p.busted,
    isHost: p.isHost,
  };
}

function roomSnapshot(room, forPlayerId) {
  const me = room.players.get(forPlayerId);
  return {
    type: "state",
    code: room.code,
    state: room.state,
    settings: room.settings,
    isHostMe: !!me?.isHost,
    scenario: room.scenario,
    story: room.story,
    players: Array.from(room.players.values()).map(publicPlayer),
    turnOrder: room.turnOrder,
    currentTurnId: room.turnOrder[room.currentTurnIndex] || null,
    round: room.round,
    maxRounds: room.settings.maxRounds,
    bannedWords: room.bannedWords,
    turnEndsAt: room.turnEndsAt,
    myGoal: me && me.goal ? me.goal.text : null,
    myBusted: me ? me.busted : false,
    callout: room.callout
      ? {
          callerId: room.callout.callerId,
          callerName: room.players.get(room.callout.callerId)?.name,
          targetId: room.callout.targetId,
          targetName: room.players.get(room.callout.targetId)?.name,
          endsAt: room.callout.endsAt,
          resolved: room.callout.resolved || null, // { correct, guessText, actualText }
        }
      : null,
    voting: room.voting
      ? {
          subjects: room.voting.subjects.map((id) => ({
            id,
            name: room.players.get(id)?.name,
            avatar: room.players.get(id)?.avatar || null,
            goal: room.reveal ? room.reveal.goals[id] : null,
          })),
          endsAt: room.voting.endsAt,
          myVotes: Array.from(room.voting.voters.get(forPlayerId) || []),
        }
      : null,
    reveal: room.reveal || null,
  };
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify(roomSnapshot(room, p.id)));
    }
  }
}

function send(p, payload) {
  if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(payload));
}

function toast(room, playerId, code, tone = "info", params = null) {
  const p = room.players.get(playerId);
  if (p) send(p, { type: "toast", code, params, tone });
}

// ----------------------------------------------------------------------------
// Game flow
// ----------------------------------------------------------------------------

function connectedPlayers(room) {
  return Array.from(room.players.values()).filter((p) => p.connected);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startGame(room) {
  const players = connectedPlayers(room);
  if (players.length < 2) return false;

  room.state = "playing";
  room.story = [];
  room.round = 0;
  room.startedAt = Date.now();
  room.callout = null;
  room.voting = null;
  room.reveal = null;

  const lang = normalizeLang(room.settings.language);
  const SCENARIOS = SCENARIOS_BY_LANG[lang];
  const GOAL_POOL = GOAL_POOL_BY_LANG[lang];
  const BANNED_WORD_POOL = BANNED_WORD_POOL_BY_LANG[lang];

  room.scenario = room.settings.customScenario || SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];

  // Assign goals: guarantee one trojan goal max, rest unique non-trojan,
  // according to the host's trojanMode setting.
  const trojan = GOAL_POOL.find((g) => g.trojan);
  const normalGoals = shuffle(GOAL_POOL.filter((g) => !g.trojan));
  const trojanMode = TROJAN_MODES.includes(room.settings.trojanMode) ? room.settings.trojanMode : "auto";
  const includeTrojan = trojanMode === "always" || (trojanMode === "auto" && players.length >= 3);
  const chosen = includeTrojan ? [trojan, ...normalGoals] : normalGoals;

  const shuffledPlayers = shuffle(players);
  shuffledPlayers.forEach((p, i) => {
    p.goal = chosen[i % chosen.length];
    p.busted = false;
    p.calledOutCorrectlyBy = null;
  });

  const chaosCount = CHAOS_LEVELS[room.settings.chaos] ?? CHAOS_LEVELS.normal;
  room.bannedWords = chaosCount > 0 ? shuffle(BANNED_WORD_POOL).slice(0, chaosCount) : [];
  room.turnOrder = shuffle(players.map((p) => p.id));
  room.currentTurnIndex = 0;
  room.skipNextTurn = new Set();

  for (const p of players) {
    send(p, { type: "goal", goal: p.goal.text, trojan: !!p.goal.trojan });
  }

  advanceToNextWriter(room, true);
  broadcast(room);
  return true;
}

function activeCandidates(room) {
  return room.turnOrder.filter((id) => {
    const p = room.players.get(id);
    return p && p.connected && !p.busted;
  });
}

function advanceToNextWriter(room, isFirst = false) {
  clearTurnTimer(room);

  const maxRounds = room.settings.maxRounds || MAX_ROUNDS_DEFAULT;
  if (room.round >= maxRounds || Date.now() - room.startedAt >= GAME_TIME_LIMIT_MS) {
    return startReveal(room);
  }
  if (activeCandidates(room).length === 0) {
    return startReveal(room);
  }

  if (!isFirst) room.round += 1;
  if (room.round >= maxRounds) {
    return startReveal(room);
  }

  // find next connected, non-busted player starting from currentTurnIndex
  let attempts = 0;
  let idx = room.currentTurnIndex;
  while (attempts < room.turnOrder.length) {
    idx = (idx + 1) % room.turnOrder.length;
    attempts += 1;
    const candidateId = room.turnOrder[idx];
    const cp = room.players.get(candidateId);
    if (cp && cp.connected && !cp.busted) {
      if (room.skipNextTurn.has(candidateId)) {
        room.skipNextTurn.delete(candidateId);
        toast(room, candidateId, "lost_turn_wrong_callout", "warn");
        continue; // this player is skipped, keep looking
      }
      room.currentTurnIndex = idx;
      startTurnTimer(room);
      return;
    }
  }
  // nobody eligible
  startReveal(room);
}

function startTurnTimer(room) {
  const seconds = room.settings.turnSeconds || TURN_SECONDS_DEFAULT;
  room.turnEndsAt = Date.now() + seconds * 1000;
  clearTurnTimer(room);
  room.turnTimer = setTimeout(() => {
    const currentId = room.turnOrder[room.currentTurnIndex];
    toast(room, currentId, "turn_skipped", "warn");
    advanceToNextWriter(room);
    broadcast(room);
  }, seconds * 1000);
}

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

// Rough Greek→Latin transliteration so banned-word checks still catch
// "greeklish" (Greek typed with Latin letters, extremely common in casual
// Greek chat). Not a full greeklish parser — just generates one plausible
// spelling per banned word and checks for it as a substring too.
const GREEK_TO_LATIN = {
  "α": "a", "ά": "a", "β": "v", "γ": "g", "δ": "d", "ε": "e", "έ": "e", "ζ": "z",
  "η": "i", "ή": "i", "θ": "th", "ι": "i", "ί": "i", "ϊ": "i", "κ": "k", "λ": "l",
  "μ": "m", "ν": "n", "ξ": "x", "ο": "o", "ό": "o", "π": "p", "ρ": "r", "σ": "s",
  "ς": "s", "τ": "t", "υ": "y", "ύ": "y", "φ": "f", "χ": "ch", "ψ": "ps", "ω": "o", "ώ": "o",
};
function greekToGreeklish(word) {
  return word.toLowerCase().split("").map((c) => GREEK_TO_LATIN[c] || c).join("");
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsBannedWord(text, bannedWords, lang) {
  const lower = text.toLowerCase();
  for (const w of bannedWords) {
    if (new RegExp(`\\b${escapeRegExp(w)}\\b`, "i").test(lower)) return w;
    if (lang === "el") {
      const translit = greekToGreeklish(w);
      if (translit.length > 2 && new RegExp(`\\b${escapeRegExp(translit)}\\b`, "i").test(lower)) return w;
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// Anti-copy-paste: block a player from just retyping their own secret goal
// verbatim (or near-verbatim) as their sentence. Compares the *content*
// words only (stopwords stripped) so natural paraphrasing is always fine —
// this only catches someone lifting most of the goal's distinctive wording.
// ----------------------------------------------------------------------------

const STOPWORDS = {
  en: new Set(["the","a","an","and","or","but","of","to","in","on","at","is","are","was","were","be","been","it","its","his","her","their","they","he","she","with","for","as","that","this","then","must","someone","who","must","without"]),
  el: new Set(["ο","η","το","οι","τα","και","να","του","της","των","με","σε","από","για","είναι","θα","που","κάποιος","πρέπει","ένας","μια","ένα","τον","την"]),
  es: new Set(["el","la","los","las","un","una","y","o","de","en","que","es","son","debe","con","por","para","alguien","su","sus","este","esta"]),
};

function significantWords(text, lang) {
  const stop = STOPWORDS[lang] || STOPWORDS.en;
  return text
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stop.has(w));
}

function isTooCloseToGoal(sentence, goalText, lang) {
  const goalWords = significantWords(goalText, lang);
  if (goalWords.length < 2) return false;
  const sentWords = new Set(significantWords(sentence, lang));
  const matched = goalWords.filter((w) => sentWords.has(w));
  return matched.length >= 2 && matched.length / goalWords.length >= 0.7;
}

function computeSuperlatives(room) {
  const players = Array.from(room.players.values());
  const awards = [];

  const bySharpEye = players.filter((p) => p.callsCorrect > 0).sort((a, b) => b.callsCorrect - a.callsCorrect);
  if (bySharpEye.length) awards.push({ key: "award_sharp_eye", playerId: bySharpEye[0].id });

  const byWildGuess = players.filter((p) => p.callsWrong > 0).sort((a, b) => b.callsWrong - a.callsWrong);
  if (byWildGuess.length) awards.push({ key: "award_wild_guess", playerId: byWildGuess[0].id });

  const bySuspected = players.filter((p) => p.timesAccused > 0).sort((a, b) => b.timesAccused - a.timesAccused);
  if (bySuspected.length) awards.push({ key: "award_most_suspected", playerId: bySuspected[0].id });

  return awards;
}

function recordAccountStats(room) {
  const players = Array.from(room.players.values());
  const topScore = players.length ? Math.max(...players.map((p) => p.score)) : 0;
  stats.recordGame(
    players
      .filter((p) => p.account)
      .map((p) => ({
        identityId: p.id,
        name: p.name,
        score: p.score,
        won: topScore > 0 && p.score === topScore,
      }))
  );
}

function submitSentence(room, playerId, text) {
  if (room.state !== "playing") return;
  const currentId = room.turnOrder[room.currentTurnIndex];
  if (currentId !== playerId) return;
  const player = room.players.get(playerId);
  if (!player || player.busted) return;

  const clean = String(text || "").trim().slice(0, 220);
  if (!clean) return;

  const lang = normalizeLang(room.settings.language);

  const hit = containsBannedWord(clean, room.bannedWords, lang);
  if (hit) {
    toast(room, playerId, "banned_word", "error", { word: hit });
    return;
  }

  if (player.goal && isTooCloseToGoal(clean, player.goal.text, lang)) {
    toast(room, playerId, "too_obvious", "error");
    return;
  }

  room.story.push({ text: clean, playerId, name: player.name });
  advanceToNextWriter(room);
  broadcast(room);
}

// ----------------------------------------------------------------------------
// Callouts
// ----------------------------------------------------------------------------

function startCallout(room, callerId, targetId) {
  if (room.state !== "playing") return;
  if (room.callout) return;
  const caller = room.players.get(callerId);
  const target = room.players.get(targetId);
  if (!caller || !target || caller.busted || target.busted || callerId === targetId) return;

  clearTurnTimer(room);
  room.state = "callout";
  room.callout = {
    callerId,
    targetId,
    endsAt: Date.now() + CALLOUT_SECONDS * 1000,
    timer: setTimeout(() => resolveCallout(room, null), CALLOUT_SECONDS * 1000),
    resolved: null,
  };
  broadcast(room);
}

function resolveCallout(room, guessedGoalId) {
  if (!room.callout) return;
  const { callerId, targetId, timer } = room.callout;
  if (timer) clearTimeout(timer);

  const caller = room.players.get(callerId);
  const target = room.players.get(targetId);

  let correct = false;
  if (caller && target && guessedGoalId) {
    correct = target.goal && target.goal.id === guessedGoalId;
  }

  if (caller) caller.callsMade = (caller.callsMade || 0) + (guessedGoalId ? 1 : 0);
  if (target) target.timesAccused = (target.timesAccused || 0) + 1;

  if (correct) {
    target.busted = true;
    caller.score += 15;
    caller.callsCorrect = (caller.callsCorrect || 0) + 1;
    toast(room, callerId, "callout_correct_points", "success");
    toast(room, targetId, "busted_by", "error", { name: caller.name });
  } else if (guessedGoalId) {
    room.skipNextTurn.add(callerId);
    caller.callsWrong = (caller.callsWrong || 0) + 1;
    toast(room, callerId, "callout_wrong_lose_turn", "warn");
    if (target) toast(room, targetId, "accused_wrong", "info", { name: caller?.name || "?" });
  } else {
    toast(room, callerId, "callout_timeout", "warn");
  }

  room.callout.resolved = {
    correct,
    guessText: guessedGoalId ? GOAL_POOL_BY_LANG[normalizeLang(room.settings.language)].find((g) => g.id === guessedGoalId)?.text : null,
    actualText: target ? target.goal.text : null,
  };
  broadcast(room);

  setTimeout(() => {
    if (!room.callout) return;
    room.callout = null;
    room.state = "playing";
    // Resume: current writer might now be busted if they were target — re-derive.
    if (activeCandidates(room).length === 0) {
      startReveal(room);
    } else {
      const currentId = room.turnOrder[room.currentTurnIndex];
      const currentP = room.players.get(currentId);
      if (!currentP || !currentP.connected || currentP.busted) {
        advanceToNextWriter(room);
      } else {
        startTurnTimer(room);
      }
    }
    broadcast(room);
  }, 3200);
}

// ----------------------------------------------------------------------------
// Reveal & voting
// ----------------------------------------------------------------------------

async function startReveal(room) {
  clearTurnTimer(room);
  const subjects = connectedPlayers(room)
    .filter((p) => !p.busted)
    .map((p) => p.id);

  const goals = {};
  for (const p of room.players.values()) {
    if (p.goal) goals[p.id] = { text: p.goal.text, trojan: !!p.goal.trojan, busted: p.busted };
  }
  room.reveal = { goals, finished: false };

  const useAI = room.settings.aiJudge && aiJudge.isConfigured() && subjects.length > 0;

  if (useAI) {
    room.state = "judging"; // transient — client shows a short "reviewing the case" beat
    broadcast(room);

    const players = subjects.map((id) => ({ id, goalText: room.players.get(id).goal.text }));
    let verdicts = null;
    try {
      verdicts = await aiJudge.judgeStory({
        scenario: room.scenario,
        story: room.story,
        players,
        language: normalizeLang(room.settings.language),
      });
    } catch {
      verdicts = null;
    }

    // The room could've been torn down (everyone left) or moved on while we
    // were awaiting the API call — bail out quietly rather than resurrect it.
    if (!rooms.has(room.code) || room.state !== "judging") return;

    if (verdicts) {
      const results = {};
      for (const id of subjects) {
        const v = verdicts.get(id) || { success: false, reason: "" };
        results[id] = { success: v.success, reason: v.reason, aiJudged: true };
        const p = room.players.get(id);
        if (p && v.success) p.score += 10;
      }
      room.reveal.results = results;
      room.reveal.finished = true;
      room.state = "reveal";
      room.reveal.superlatives = computeSuperlatives(room);
      recordAccountStats(room);
      broadcast(room);
      return;
    }
    // Every model failed or returned something unusable — fall through to
    // ordinary peer voting below instead of leaving the room stuck.
  }

  room.state = "voting";
  room.voting = {
    subjects,
    ballots: new Map(subjects.map((id) => [id, { yes: 0, no: 0 }])),
    voters: new Map(),
    endsAt: Date.now() + VOTE_SECONDS * 1000,
    timer: setTimeout(() => finishVoting(room), VOTE_SECONDS * 1000),
  };
  broadcast(room);
}

function castVote(room, voterId, subjectId, verdict) {
  if (room.state !== "voting" || !room.voting) return;
  if (!room.voting.subjects.includes(subjectId)) return;
  if (voterId === subjectId) return;

  const already = room.voting.voters.get(voterId) || new Set();
  if (already.has(subjectId)) return;
  already.add(subjectId);
  room.voting.voters.set(voterId, already);

  const ballot = room.voting.ballots.get(subjectId);
  if (verdict === "yes") ballot.yes += 1;
  else ballot.no += 1;

  broadcast(room);

  const totalVoters = connectedPlayers(room).length;
  const everyoneVotedOnEverything = Array.from(room.voting.voters.entries()).length >= 0 &&
    room.voting.subjects.every((subj) => {
      let count = 0;
      for (const [voter, set] of room.voting.voters.entries()) {
        if (set.has(subj)) count += 1;
      }
      const eligibleVoters = totalVoters - 1; // subject can't vote for self
      return count >= Math.max(eligibleVoters, 0);
    });

  if (everyoneVotedOnEverything) finishVoting(room);
}

function finishVoting(room) {
  if (!room.voting) return;
  if (room.voting.timer) clearTimeout(room.voting.timer);

  const results = {};
  for (const [subjId, ballot] of room.voting.ballots.entries()) {
    const success = ballot.yes >= ballot.no && (ballot.yes + ballot.no) > 0 ? true : ballot.yes > ballot.no;
    results[subjId] = { yes: ballot.yes, no: ballot.no, success };
    const p = room.players.get(subjId);
    if (p && success) p.score += 10;
  }

  room.reveal.results = results;
  room.reveal.finished = true;
  room.voting = null;
  room.state = "reveal";
  room.reveal.superlatives = computeSuperlatives(room);
  recordAccountStats(room);
  broadcast(room);
}

function playAgain(room) {
  room.callout = null;
  room.voting = null;
  room.reveal = null;
  for (const p of room.players.values()) {
    p.busted = false;
    p.goal = null;
  }
  room.state = "lobby";
  broadcast(room);
}

function updateMatchSettings(room, patch) {
  if (room.state !== "lobby") return;
  const s = room.settings;
  if (patch.language !== undefined) s.language = normalizeLang(patch.language);
  if (patch.turnSeconds !== undefined && TURN_SECONDS_OPTIONS.includes(Number(patch.turnSeconds))) {
    s.turnSeconds = Number(patch.turnSeconds);
  }
  if (patch.maxRounds !== undefined && MAX_ROUNDS_OPTIONS.includes(Number(patch.maxRounds))) {
    s.maxRounds = Number(patch.maxRounds);
  }
  if (patch.trojanMode !== undefined && TROJAN_MODES.includes(patch.trojanMode)) {
    s.trojanMode = patch.trojanMode;
  }
  if (patch.chaos !== undefined && Object.prototype.hasOwnProperty.call(CHAOS_LEVELS, patch.chaos)) {
    s.chaos = patch.chaos;
  }
  if (patch.isPublic !== undefined) {
    s.isPublic = !!patch.isPublic;
  }
  if (patch.aiJudge !== undefined) {
    s.aiJudge = !!patch.aiJudge && aiJudge.isConfigured();
  }
  if (patch.customScenario !== undefined) {
    s.customScenario = String(patch.customScenario || "").trim().slice(0, 200);
  }
  broadcast(room);
}

// ----------------------------------------------------------------------------
// Matchmaking ("quick match") — finds an open, public, not-yet-started room
// with fewer than 8 players, optionally preferring one already set to the
// requested language. Creates a fresh public room if nothing fits.
// ----------------------------------------------------------------------------

function findQuickMatchRoom(preferredLang) {
  const candidates = Array.from(rooms.values()).filter(
    (r) => r.state === "lobby" && r.settings.isPublic && connectedPlayers(r).length < 8
  );
  if (candidates.length === 0) return null;
  const langMatch = candidates.find((r) => r.settings.language === normalizeLang(preferredLang));
  return langMatch || candidates[0];
}

// ----------------------------------------------------------------------------
// WebSocket wiring
// ----------------------------------------------------------------------------

/**
 * Derive a stable identity for this connection:
 *  - Logged in via Google/GitHub/Discord -> identity is the OAuth account
 *    itself (`google:12345`), so the SAME account can never occupy two
 *    seats in the same room, even from two different browsers.
 *  - Guest -> a random id is minted once and stashed in the session, so a
 *    refresh or a second tab from the same browser is recognized as the
 *    same person rather than a new player.
 */
function identityFromRequest(req) {
  if (req.session?.passport?.user) {
    const u = req.session.passport.user;
    return { identityId: u.identityId, name: u.name, avatar: u.avatar, account: true };
  }
  if (!req.session.guestId) {
    req.session.guestId = "guest:" + crypto.randomBytes(9).toString("hex");
    req.session.save?.(() => {});
  }
  return { identityId: req.session.guestId, name: null, avatar: null, account: false };
}

// ----------------------------------------------------------------------------
// Basic abuse protection. Deliberately simple (in-memory, per-process) —
// good enough to stop casual spam on a single small deployment; if this ever
// needs to survive multiple server instances behind a load balancer, move
// these counters to something shared like Redis instead.
// ----------------------------------------------------------------------------

const ROOM_ACTION_LIMIT = 20; // per window, per IP
const ROOM_ACTION_WINDOW_MS = 5 * 60 * 1000;
const roomActionCounts = new Map(); // ip -> { count, resetAt }

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const entry = roomActionCounts.get(ip);
  if (!entry || now > entry.resetAt) {
    roomActionCounts.set(ip, { count: 1, resetAt: now + ROOM_ACTION_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > ROOM_ACTION_LIMIT;
}

// Cheap flood guard on the message stream itself, independent of the
// room-action limiter above (that one only covers create/join/quick-match).
const MESSAGE_FLOOD_LIMIT = 15; // per window, per connection
const MESSAGE_FLOOD_WINDOW_MS = 1000;

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of roomActionCounts.entries()) {
    if (now > entry.resetAt) roomActionCounts.delete(ip);
  }
}, 10 * 60 * 1000).unref();

wss.on("connection", (ws, req) => {
  const identity = identityFromRequest(req);
  const playerId = identity.identityId;
  const ip = clientIp(req);
  let currentRoomCode = null;
  let msgWindowStart = Date.now();
  let msgCountInWindow = 0;

  ws.on("message", (raw) => {
    // Flood guard: silently drop messages once a connection is clearly
    // spamming, rather than doing any per-message work.
    const now = Date.now();
    if (now - msgWindowStart > MESSAGE_FLOOD_WINDOW_MS) {
      msgWindowStart = now;
      msgCountInWindow = 0;
    }
    msgCountInWindow += 1;
    if (msgCountInWindow > MESSAGE_FLOOD_LIMIT) return;

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "create_room" || msg.type === "join_room" || msg.type === "quick_match") {
      if (isRateLimited(ip)) {
        ws.send(JSON.stringify({ type: "error", code: "rate_limited" }));
        return;
      }
    }

    if (msg.type === "create_room") {
      const code = roomCode();
      const room = makeRoom(code);
      if (msg.isPublic) room.settings.isPublic = true;
      if (msg.language) room.settings.language = normalizeLang(msg.language);
      rooms.set(code, room);
      joinRoom(room, msg.name, msg.avatar);
      return;
    }

    if (msg.type === "join_room") {
      const room = getRoom(String(msg.code || "").toUpperCase());
      if (!room) {
        ws.send(JSON.stringify({ type: "error", code: "room_not_found" }));
        return;
      }
      joinRoom(room, msg.name, msg.avatar);
      return;
    }

    if (msg.type === "quick_match") {
      let room = findQuickMatchRoom(msg.language);
      if (!room) {
        const code = roomCode();
        room = makeRoom(code);
        room.settings.isPublic = true;
        if (msg.language) room.settings.language = normalizeLang(msg.language);
        rooms.set(code, room);
      }
      joinRoom(room, msg.name, msg.avatar);
      return;
    }

    const room = currentRoomCode ? getRoom(currentRoomCode) : null;
    if (!room) return;

    switch (msg.type) {
      case "update_match_settings": {
        const player = room.players.get(playerId);
        if (player && player.isHost) updateMatchSettings(room, msg.settings || {});
        break;
      }
      case "start_game": {
        const player = room.players.get(playerId);
        if (player && player.isHost) {
          const ok = startGame(room);
          if (!ok) toast(room, playerId, "need_two_players", "error");
        }
        break;
      }
      case "submit_sentence":
        submitSentence(room, playerId, msg.text);
        break;
      case "start_callout":
        startCallout(room, playerId, msg.targetId);
        break;
      case "resolve_callout":
        if (room.callout && room.callout.callerId === playerId) {
          resolveCallout(room, msg.goalId);
        }
        break;
      case "cast_vote":
        castVote(room, playerId, msg.subjectId, msg.verdict);
        break;
      case "play_again": {
        const player = room.players.get(playerId);
        if (player && player.isHost) playAgain(room);
        break;
      }
      case "leave_room":
        handleLeave(room, playerId);
        break;
    }
  });

  ws.on("close", () => {
    const room = currentRoomCode ? getRoom(currentRoomCode) : null;
    if (!room) return;
    const p = room.players.get(playerId);
    // only mark disconnected if this socket is still the "current" one for
    // that seat — an old socket closing after a reconnect shouldn't knock
    // out the new one.
    if (p && p.ws === ws) {
      p.connected = false;
      p.ws = null;
      broadcast(room);
      // clean up empty rooms after a delay
      setTimeout(() => {
        if (connectedPlayers(room).length === 0) {
          clearTurnTimer(room);
          if (room.callout?.timer) clearTimeout(room.callout.timer);
          if (room.voting?.timer) clearTimeout(room.voting.timer);
          rooms.delete(room.code);
        }
      }, 30000);
    }
  });

  function joinRoom(room, name, avatar) {
    const existing = room.players.get(playerId);

    if (existing) {
      if (existing.connected && existing.ws && existing.ws.readyState === 1 && existing.ws !== ws) {
        // Same identity is already active in this room from another tab/device.
        ws.send(JSON.stringify({ type: "error", code: "already_in_room" }));
        return;
      }
      // Reconnect: same seat, fresh socket, keep score/goal/progress.
      existing.ws = ws;
      existing.connected = true;
      if (identity.account && identity.name) existing.name = censorName(identity.name);
      if (avatar) existing.avatar = avatar;
      currentRoomCode = room.code;
      send(existing, { type: "joined", playerId, code: room.code });
      broadcast(room);
      return;
    }

    currentRoomCode = room.code;
    const isHost = room.players.size === 0;
    const player = {
      id: playerId,
      ws,
      name: censorName(identity.account && identity.name ? identity.name : name),
      avatar: avatar || null,
      account: identity.account,
      connected: true,
      score: 0,
      goal: null,
      busted: false,
      isHost,
    };
    room.players.set(playerId, player);
    if (isHost) room.hostId = playerId;
    send(player, { type: "joined", playerId, code: room.code });
    broadcast(room);
  }

  function handleLeave(room, id) {
    room.players.delete(id);
    if (room.hostId === id) {
      const next = connectedPlayers(room)[0];
      if (next) {
        next.isHost = true;
        room.hostId = next.id;
      }
    }
    broadcast(room);
  }
});

server.listen(PORT, () => {
  console.log(`Derail server running on http://localhost:${PORT}`);
});
