// ═══════════════════════════════════════════════════════════════════
//  ALNAÉ Confidente — Serveur Render v3
//  Nouveautés v3 :
//  - Envoi email réel via Resend (commande@alnaeinfinity.com)
//  - IA étymologie + citation déplacées côté serveur
//  - Notification admin automatique à chaque scellement
//  - Usage unique renforcé
// ═══════════════════════════════════════════════════════════════════

const express = require("express");
const https   = require("https");
const http    = require("http");
const path    = require("path");
const fs      = require("fs");
const app     = express();
const port    = process.env.PORT || 10000;

// ── VARIABLES D'ENVIRONNEMENT ─────────────────────────────────────
const BASE_URL        = process.env.BASE_URL        || "https://alnae-confidente-1.onrender.com";
const ADMIN_SECRET    = process.env.ADMIN_SECRET    || "ALNAE-ADMIN-2026";
const RESEND_API_KEY  = process.env.RESEND_API_KEY  || "";   // Obligatoire pour l'envoi email
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY  || "";   // Obligatoire pour l'IA
const FROM_EMAIL      = "commande@alnaeinfinity.com";
const ADMIN_EMAIL     = "commande@alnaeinfinity.com";
const CONTACT_EMAIL   = "contact@alnaeinfinity.com";
const FORM_URL        = process.env.FORM_URL || BASE_URL + "/formulaire";

// ── MIDDLEWARES ───────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── STOCKAGE EN MÉMOIRE ───────────────────────────────────────────
const orders   = new Map();  // orderNumber → order data
const codes    = new Map();  // clientCode  → code data
const messages = new Map();  // jewelCode   → message data

// ── PERSISTANCE FICHIER (/tmp) ────────────────────────────────
// Survit aux redéploiements ; ne survit pas aux redémarrages Render gratuit.
// Pour une vraie persistence : passer à Render Starter + Disk, ou ajouter Supabase.
const DATA_PATH = "/tmp/alnae_data.json";

function saveData() {
  try {
    fs.writeFileSync(DATA_PATH, JSON.stringify({
      orders:   [...orders.entries()],
      codes:    [...codes.entries()],
      messages: [...messages.entries()]
    }));
  } catch(e) { console.error("[SAVE] Erreur :", e.message); }
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    (raw.orders   || []).forEach(([k,v]) => orders.set(k, v));
    (raw.codes    || []).forEach(([k,v]) => codes.set(k, v));
    (raw.messages || []).forEach(([k,v]) => messages.set(k, v));
    console.log("[LOAD] Données restaurées — messages:", messages.size,
      "| orders:", orders.size, "| codes:", codes.size);
  } catch(e) { console.error("[LOAD] Erreur :", e.message); }
}

// ── UTILITAIRES ───────────────────────────────────────────────────
function checkAdmin(req, res) {
  const secret = req.body?.adminSecret || req.query?.secret;
  if (secret !== ADMIN_SECRET) {
    res.status(401).json({ message: "Accès non autorisé." });
    return false;
  }
  return true;
}

function normalizeCode(code) {
  return String(code || "").replace(/\s/g, "").toUpperCase();
}

// ── ENVOI EMAIL VIA RESEND ────────────────────────────────────────
function sendEmailResend(to, subject, html, replyTo) {
  if (!RESEND_API_KEY) {
    console.log("[EMAIL] Resend non configuré. Destinataire:", to, "| Sujet:", subject);
    return Promise.resolve({ ok: false, reason: "RESEND_API_KEY manquante" });
  }

  return new Promise((resolve) => {
    const body = JSON.stringify({
      from:     `ALNAÉ Infinity <${FROM_EMAIL}>`,
      to:       [to],
      subject,
      html,
      reply_to: replyTo || CONTACT_EMAIL
    });

    const opts = {
      hostname: "api.resend.com",
      path:     "/emails",
      method:   "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type":  "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };

    let data = "";
    const req = https.request(opts, (r) => {
      r.on("data", d => data += d);
      r.on("end", () => {
        const success = r.statusCode === 200 || r.statusCode === 201;
        if (!success) console.warn("[EMAIL] Resend erreur:", r.statusCode, data);
        resolve({ ok: success, statusCode: r.statusCode, data });
      });
    });
    req.on("error", (e) => { console.error("[EMAIL] Resend erreur réseau:", e); resolve({ ok: false, error: e.message }); });
    req.write(body);
    req.end();
  });
}

// ── IA CÔTÉ SERVEUR ───────────────────────────────────────────────
function callOpenAI(systemPrompt, userMessage, maxTokens) {
  if (!OPENAI_API_KEY) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userMessage  }
      ],
      max_tokens:   maxTokens || 400,
      temperature:  0.85
    });

    const opts = {
      hostname: "api.openai.com",
      path:     "/v1/chat/completions",
      method:   "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type":  "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };

    let data = "";
    const req = https.request(opts, (r) => {
      r.on("data", d => data += d);
      r.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          // Format standard /v1/chat/completions
          const text = parsed.choices?.[0]?.message?.content;
          if (text && text.trim()) {
            resolve(text.replace(/\*([^*]+)\*/g, "$1").trim());
          } else {
            // Log complet pour diagnostic
            console.error("[OPENAI] ❌ Réponse inattendue (status HTTP:", r.statusCode, ")");
            console.error("[OPENAI] Détail:", JSON.stringify(parsed).slice(0, 400));
            resolve(null);
          }
        } catch (e) {
          console.error("[OPENAI] ❌ Parse erreur:", e.message);
          console.error("[OPENAI] Données brutes:", data.slice(0, 300));
          resolve(null);
        }
      });
    });
    req.on("error", (e) => {
      console.error("[OPENAI] Erreur réseau :", e.message);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}


// Détection genre simple côté serveur
function detectGenre(prenom) {
  if (!prenom) return "neutre";
  const prenomsMasculins = new Set([
    "aaron","adam","adrien","alexandre","alexis","arnaud","arthur","axel","baptiste",
    "benjamin","charles","christophe","clement","damien","daniel","david","edouard",
    "emmanuel","ethan","etienne","felix","florian","francois","gabriel","gabin",
    "guillaume","hugo","jean","jeremy","jerome","julien","kevin","kylian","laurent",
    "leon","luca","lucas","leo","loic","louis","luka","mael","marc","martin",
    "mathieu","mathis","maxime","maxence","mehdi","michael","michel","nathan",
    "nicolas","noah","noel","nolan","olivier","oscar","paul","philippe","pierre",
    "raphael","remi","robin","romain","ruben","samuel","sebastien","simon",
    "stephane","tanguy","theo","thibault","thierry","thomas","timothee","tom",
    "tristan","ugo","valentin","victor","vincent","william","xavier","yann"
  ]);
  const p = prenom.trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .split(/[\s-]/)[0];
  if (prenomsMasculins.has(p)) return "masculin";
  // Heuristiques
  const l3=p.slice(-3), l2=p.slice(-2), l1=p.slice(-1);
  if (["ine","ene","ale","lle","tte","ise","ose","ane","elle"].includes(l3)) return "feminin";
  if (["ia","ea","na","la","ra","sa"].includes(l2)) return "feminin";
  if (l1==="a" && p.length>3) return "feminin";
  if (["el","en","on","an","in","us"].includes(l2)) return "masculin";
  if (l1==="o" && p.length>3) return "masculin";
  return "neutre"; // si incertain → formulation neutre
}

// Textes de secours si l'IA est indisponible
function fallbackEtym(prenom, genre) {
  if (genre === "masculin") {
    return `${prenom} porte en lui la force tranquille de ceux qui savent qui ils sont.\n\nIl avance avec une clarté rare — celle des hommes qui ne cherchent plus à prouver, mais à créer.\n\nPorte-le. Il te va bien.`;
  }
  if (genre === "feminin") {
    return `${prenom} porte en lui la grâce de celles qui ont su traverser les tempêtes sans perdre leur lumière.\n\nIl incarne une douceur qui ne capitule pas, une élégance qui vient de l'intérieur.\n\nPorte-le. Il te ressemble.`;
  }
  return `${prenom} porte en lui quelque chose de rare — une énergie singulière qui appartient seulement à ceux qui osent être vraiment eux-mêmes.\n\nC'est un prénom qui laisse une trace.\n\nPorte-le. Il te ressemble.`;
}

function fallbackMotiv(genre) {
  const citations = {
    feminin: "Porter ce bijou, c'est porter un morceau de l'âme de quelqu'un qui croit en toi.\n\nN'oublie pas qui tu es.",
    masculin: "Ce bijou porte avec lui tout ce que les mots n'ont pas su dire.\n\nN'oublie pas qui tu es.",
    neutre: "Ce bijou est un morceau d'âme offert avec intention.\n\nN'oublie pas qui tu es."
  };
  return citations[genre] || citations.neutre;
}

// ── ENDPOINT : GÉNÉRER ÉTYMOLOGIE ────────────────────────────────
app.post("/generate-etym", async (req, res) => {
  const { prenom } = req.body;
  if (!prenom) return res.status(400).json({ message: "Prénom manquant." });

  const genre = detectGenre(prenom);
  const gLabel = genre === "neutre" ? "mixte" : genre;

  const systemPrompt = `Tu es un expert en écriture émotionnelle haut de gamme pour une marque de bijoux de luxe français appelée ALNAÉ Infinity.
Tu vas écrire l'essence poétique d'un prénom pour accompagner un bijou offert.
RÈGLES ABSOLUES :
- Jamais de texte générique ou répétitif
- Toujours accorder au genre : ${gLabel}
- Ton poétique, profond, élégant, jamais cliché
- Pas de liste, pas de tiret, pas de guillemets, pas de markdown, pas de caractères spéciaux
- 3 courts paragraphes séparés par une ligne vide
- Le texte sera gravé sur une carte qui accompagne un bijou de luxe`;

  const userMessage = `Prénom : ${prenom}
Genre : ${gLabel}

1. Donne une interprétation poétique et crédible du prénom (pas forcément une étymologie académique, mais belle et cohérente) — 2 phrases
2. Écris ce que ce prénom révèle de la personne qui le porte, en tutoiement, accordé au genre ${gLabel} — 2 phrases intimes
3. Une seule phrase finale, courte, forte, mémorable

Le texte doit être UNIQUE et ne jamais se répéter.`;

  const result = await callOpenAI(systemPrompt, userMessage, 350);

  return res.json({
    etymologyText: result || fallbackEtym(prenom, genre),
    genre,
    source: result ? "ia" : "fallback"
  });
});


// ── ENDPOINT : GÉNÉRER CITATION ───────────────────────────────────
app.post("/generate-motiv", async (req, res) => {
  const { prenom, occasion, personalMessage } = req.body;
  if (!prenom) return res.status(400).json({ message: "Prénom manquant." });

  const genre = detectGenre(prenom);
  const gLabel = genre === "neutre" ? "mixte" : genre;
  const ctx = [];
  if (occasion && occasion !== "Autre") ctx.push(`Occasion : ${occasion}`);
  if (personalMessage) ctx.push(`Contexte du message : "${personalMessage.slice(0, 100)}"`);

  const systemPrompt = `Tu es un expert en écriture émotionnelle haut de gamme pour ALNAÉ Infinity, marque de bijoux de luxe.
Tu écris UNE citation courte (2 à 3 phrases maximum) qui accompagnera un bijou offert.
RÈGLES ABSOLUES :
- Accordée au genre : ${gLabel}
- Unique, jamais générique, jamais répétitive
- Poétique, profond, élégant — jamais cliché
- Doit évoquer la valeur, la beauté intérieure, la force de la personne
- Se termine TOUJOURS par : "N'oublie pas qui tu es."
- Pas de guillemets, pas de tiret, pas de markdown`;
  const ctxStr = ctx.join("\n") || "Bijou offert avec amour.";
  const userMessage = "Pr\xc3\xa9nom du destinataire : " + prenom + " (genre : " + gLabel + ")\n" +
    ctxStr + "\n\n" +
    "\xc3\x89cris une citation courte, forte et unique pour ce bijou. Termine par \"N'oublie pas qui tu es.\"";
  const result = await callOpenAI(systemPrompt, userMessage, 150);

  return res.json({
    motivationText: result || fallbackMotiv(genre),
    genre,
    source: result ? "ia" : "fallback"
  });
});


// ── ENDPOINT : GÉNÉRER SUGGESTIONS ───────────────────────────────
app.post("/generate-suggestions", async (req, res) => {
  const { occasion, prenom } = req.body;
  if (!occasion) return res.status(400).json({ message: "Occasion manquante." });

  const genre = detectGenre(prenom || "");
  const gLabel = genre === "neutre" ? "mixte" : genre;

  const systemPrompt = `Tu es un expert en écriture émotionnelle haut de gamme pour ALNAÉ Infinity, marque de bijoux de luxe français.
Tu vas écrire 3 suggestions de messages personnalisés pour accompagner un bijou offert.
RÈGLES ABSOLUES :
- Accordées au genre : ${gLabel}
- Chaque message est UNIQUE et différent des autres — jamais les mêmes phrases
- Style : poétique, profond, élégant, haute couture émotionnelle
- Jamais cliché, jamais générique, jamais répétitif
- Tutoiement
- 2 à 4 phrases par message
- Réponds UNIQUEMENT en JSON valide, sans markdown, sans commentaire
Format : {"suggestions":["message1","message2","message3"]}`;

  const userMessage = `Occasion : ${occasion}
Prénom du destinataire : ${prenom || "le destinataire"} (genre : ${gLabel})

Génère 3 messages d'accompagnement uniques et émotionnels pour ce bijou.
Le 1er doit être touchant et intime.
Le 2e doit être poétique et métaphorique.
Le 3e doit être puissant et mémorable.`;

  const result = await callOpenAI(systemPrompt, userMessage, 600);
  let suggestions = null;

  if (result) {
    try {
      const cleaned = result.replace(/\`\`\`json|\`\`\`/g, "").trim();
      const parsed  = JSON.parse(cleaned);
      if (parsed.suggestions?.length >= 3) suggestions = parsed.suggestions;
    } catch(e) {
      console.error("[SUGGESTIONS] Parse JSON échoué:", result.slice(0, 200));
    }
  }

  return res.json({ suggestions: suggestions || null });
});


// ── ENDPOINT ADMIN : CRÉER UNE COMMANDE ──────────────────────────
app.post("/admin/create-order", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { orderNumber, clientEmail, clientName, codes: clientCodes, messageAccompagnement } = req.body;
  if (!orderNumber || !clientEmail || !clientCodes?.length) {
    return res.status(400).json({ message: "Données manquantes (orderNumber, clientEmail, codes requis)." });
  }
  if (orders.has(orderNumber)) {
    return res.status(409).json({ message: "Cette commande existe déjà." });
  }
  const orderData = {
    orderNumber, clientEmail, clientName: clientName || "",
    codes: clientCodes.map((code, i) => ({ code, index: i+1, status: "available", jewelCode: null, sealedAt: null })),
    messageAccompagnement: messageAccompagnement || "",
    createdAt: new Date().toISOString()
  };
  orders.set(orderNumber, orderData);
  clientCodes.forEach((code, i) => {
    codes.set(normalizeCode(code), { orderNumber, index: i+1, status: "available", jewelCode: null, sealedAt: null });
  });
  console.log("[ADMIN] Commande créée :", orderNumber, "| Codes :", clientCodes.length);
  saveData();
  return res.json({ ok: true, orderNumber, codesCreated: clientCodes.length });
});

// ── ENDPOINT ADMIN : ENVOYER EMAIL AU CLIENT ──────────────────────
app.post("/admin/send-client-email", async (req, res) => {
  if (!checkAdmin(req, res)) return;

  const { orderNumber, clientEmail, clientName, codes: clientCodes } = req.body;
  if (!orderNumber || !clientEmail || !clientCodes?.length) {
    return res.status(400).json({ message: "Données manquantes." });
  }

  const prenom = clientName ? `<strong>${clientName}</strong>` : "Madame, Monsieur";
  const nbBijoux = clientCodes.length;
  const codesHtml = clientCodes.map((code, i) => `
    <div style="margin:10px 0;">
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#8A7A60;margin-bottom:5px;">
        Code ${i+1} sur ${nbBijoux}
      </div>
      <div style="background:#F8F4EE;border:1.5px solid #1C1408;padding:10px 16px;font-family:'Courier New',monospace;font-size:16px;letter-spacing:3px;color:#1C1408;font-weight:bold;display:inline-block;">
        ${code}
      </div>
    </div>`).join("");

  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F2EDE3;font-family:Arial,sans-serif;">
<div style="max-width:580px;margin:40px auto;background:#FDFAF5;border:1px solid #C8BAA0;">

  <!-- En-tête -->
  <div style="background:#1C1408;padding:28px 36px;text-align:center;">
    <div style="font-size:10px;letter-spacing:5px;text-transform:uppercase;color:#8B6914;margin-bottom:8px;">ALNAÉ INFINITY</div>
    <div style="font-family:Georgia,serif;font-size:24px;font-style:italic;color:#F0EBE0;font-weight:400;">Collection Confidente</div>
  </div>

  <!-- Corps -->
  <div style="padding:36px 40px;">
    <p style="font-size:15px;color:#1C1408;margin:0 0 16px;">Bonjour ${prenom},</p>

    <p style="font-size:14px;color:#5A4A2A;line-height:1.8;margin:0 0 20px;">
      Nous vous remercions pour votre confiance et votre commande
      <strong style="color:#1C1408;">${orderNumber}</strong> auprès d'ALNAÉ Infinity.
    </p>

    <p style="font-size:14px;color:#5A4A2A;line-height:1.8;margin:0 0 20px;">
      Vous avez choisi la collection <strong style="color:#1C1408;">Confidente</strong> —
      une expérience où chaque bijou devient le messager d'un message personnel
      que vous souhaitez transmettre à quelqu'un qui compte.
    </p>

    <p style="font-size:14px;color:#5A4A2A;line-height:1.8;margin:0 0 8px;">
      Pour ${nbBijoux > 1 ? `personnaliser vos ${nbBijoux} bijoux` : "personnaliser votre bijou"},
      voici ${nbBijoux > 1 ? "vos codes confidentiels exclusifs" : "votre code confidentiel exclusif"} :
    </p>

    <div style="background:#F8F4EE;border:1px solid #C8BAA0;padding:20px 24px;margin:16px 0;">
      ${codesHtml}
    </div>

    <!-- Instructions -->
    <div style="margin:24px 0;">
      <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#8B6914;margin-bottom:12px;">Comment créer votre message</div>
      <table style="width:100%;font-size:13px;color:#5A4A2A;line-height:1.9;">
        <tr><td style="width:24px;vertical-align:top;color:#8B6914;font-weight:bold;">1.</td><td>Rendez-vous sur notre espace dédié :<br><a href="${FORM_URL}" style="color:#8B6914;font-weight:bold;">${FORM_URL}</a></td></tr>
        <tr><td style="vertical-align:top;color:#8B6914;font-weight:bold;">2.</td><td>Saisissez votre code confidentiel — le numéro de commande <strong>${orderNumber}</strong> s'affichera automatiquement</td></tr>
        <tr><td style="vertical-align:top;color:#8B6914;font-weight:bold;">3.</td><td>Composez votre message personnel avec soin, directement dans l'espace dédié — chaque mot compte</td></tr>
        <tr><td style="vertical-align:top;color:#8B6914;font-weight:bold;">4.</td><td>Prévisualisez, puis scellez lorsque vous êtes satisfait(e)</td></tr>
      </table>
    </div>

    <!-- Encadré important -->
    <div style="background:#F0EBE0;border-left:3px solid #8B6914;padding:14px 18px;margin:20px 0;font-size:13px;color:#1C1408;line-height:1.7;">
      <strong>À noter :</strong><br>
      Chaque code est strictement personnel et à usage unique.
      Une fois votre message scellé, il ne pourra plus être modifié.
      Prenez le temps de relire votre message avant de valider.
    </div>

    <p style="font-size:13px;color:#5A4A2A;line-height:1.8;margin:20px 0 0;">
      Après réception de votre message, notre équipe le prendra en charge personnellement
      sous <strong>24 à 48h ouvrées</strong>. Votre bijou vous sera ensuite expédié par La Poste
      et vous recevrez un email de confirmation de suivi.
    </p>

    <p style="font-size:13px;color:#5A4A2A;line-height:1.8;margin:16px 0 0;">
      Pour toute question relative à votre commande <strong>${orderNumber}</strong>,
      notre équipe est disponible à :
      <a href="mailto:${CONTACT_EMAIL}" style="color:#8B6914;">${CONTACT_EMAIL}</a>
    </p>

    <p style="font-size:13px;color:#8A7A60;font-style:italic;margin:28px 0 0;">
      Toute l'équipe ALNAÉ Infinity vous souhaite une belle expérience Confidente. ✦
    </p>
  </div>

  <!-- Pied de page -->
  <div style="background:#F8F4EE;border-top:1px solid #C8BAA0;padding:18px 36px;text-align:center;">
    <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8B6914;margin-bottom:6px;">ALNAÉ INFINITY — COLLECTION CONFIDENTE</div>
    <a href="https://www.alnaeinfinity.com" style="font-size:12px;color:#8A7A60;text-decoration:none;">www.alnaeinfinity.com</a>
  </div>

</div>
</body></html>`;

  const subject = `ALNAÉ Infinity ✦ Votre expérience Confidente — Commande ${orderNumber}`;
  const result = await sendEmailResend(clientEmail, subject, html, CONTACT_EMAIL);

  if (result.ok) {
    console.log("[EMAIL CLIENT] Envoyé à", clientEmail, "pour commande", orderNumber);
    return res.json({ ok: true, message: `Email envoyé avec succès à ${clientEmail}.` });
  } else {
    console.error("[EMAIL CLIENT] Échec :", result);
    return res.status(500).json({
      ok: false,
      message: "L'email n'a pas pu être envoyé. Vérifiez la clé RESEND_API_KEY et le domaine expéditeur.",
      detail: result.data || result.reason || result.error
    });
  }
});

// ── ENDPOINT ADMIN : LISTE COMMANDES ─────────────────────────────
app.get("/admin/orders", (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(401).json({ message: "Accès non autorisé." });
  const list = [...orders.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return res.json({ orders: list });
});

// ── ENDPOINT ADMIN : STATISTIQUES ────────────────────────────────
app.get("/admin/stats", (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(401).json({ message: "Accès non autorisé." });
  let total = 0, sealed = 0;
  orders.forEach(o => (o.codes || []).forEach(c => { total++; if (c.status === "sealed") sealed++; }));
  return res.json({
    totalOrders: orders.size, totalCodes: total, totalSealed: sealed, totalPending: total - sealed,
    recentOrders: [...orders.values()].sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt)).slice(0,5)
  });
});

// ── ENDPOINT CLIENT : VALIDER CODE ───────────────────────────────
app.post("/validate-client-code", (req, res) => {
  const { clientCode } = req.body;
  if (!clientCode) return res.status(400).json({ message: "Code manquant." });

  const normalized = normalizeCode(clientCode);
  const codeData   = codes.get(normalized);

  if (!codeData) {
    return res.status(404).json({ message: "Code incorrect. Vérifiez votre code confidentiel et réessayez." });
  }
  if (codeData.status === "sealed") {
    return res.status(410).json({
      message: "Ce code a déjà été utilisé pour créer un message. Si vous souhaitez lire le message, rendez-vous sur la page de révélation."
    });
  }

  const order = orders.get(codeData.orderNumber);
  return res.json({
    valid: true,
    orderNumber: codeData.orderNumber,
    codeIndex:   codeData.index,
    clientName:  order?.clientName || ""
  });
});

// ── ENDPOINT CLIENT : SCELLER LE MESSAGE ─────────────────────────
app.post("/seal-message", async (req, res) => {
  const { clientCode, pin, jewelCode, recipientName, occasion,
          personalMessage, etymologyText, motivationText, senderLine } = req.body;

  if (!pin || !jewelCode) return res.status(400).json({ message: "Données manquantes." });

  const finalCode = normalizeCode(jewelCode);

  // Vérifier usage unique
  if (clientCode) {
    const normalized = normalizeCode(clientCode);
    const codeData   = codes.get(normalized);
    if (codeData) {
      if (codeData.status === "sealed") {
        return res.status(410).json({
          message: "Ce code a déjà été utilisé. Votre message est en cours de traitement par ALNAÉ Infinity."
        });
      }
      codeData.status   = "sealed";
      codeData.jewelCode = finalCode;
      codeData.sealedAt  = new Date().toISOString();
      const order = orders.get(codeData.orderNumber);
      if (order) {
        const ce = order.codes.find(c => normalizeCode(c.code) === normalized);
        if (ce) { ce.status = "sealed"; ce.jewelCode = finalCode; ce.sealedAt = codeData.sealedAt; }
      }
    }
  }

  // ── GÉNÉRATION IA CÔTÉ SERVEUR ────────────────────────────────
  // Le front n'envoie plus l'étymologie ni la citation — tout est généré ici
  const prenom = recipientName || "";
  const genre  = detectGenre(prenom);
  const gLabel = genre === "neutre" ? "mixte" : genre;

  // Les deux appels IA en parallèle pour ne pas ralentir la réponse
  const [aiEtym, aiMotiv] = await Promise.all([

    // Étymologie poétique du prénom
    prenom ? callOpenAI(
      `Tu es un expert en écriture émotionnelle haut de gamme pour ALNAÉ Infinity, marque de bijoux de luxe.
Tu vas écrire l'essence poétique d'un prénom pour accompagner un bijou offert.
RÈGLES ABSOLUES :
- Accordé au genre : ${gLabel}
- Jamais générique, jamais répétitif, jamais académique
- Ton poétique, profond, élégant
- 3 courts paragraphes séparés par une ligne vide
- Pas de liste, pas de tiret, pas de guillemets, pas de markdown`,
      `Prénom : ${prenom}. Genre : ${gLabel}.
1. Donne une interprétation poétique et crédible du prénom (belle et cohérente) — 2 phrases
2. Ce que ce prénom révèle de la personne qui le porte, en tutoiement — 2 phrases intimes
3. Une seule phrase finale, courte, forte, mémorable`,
      350
    ) : null,

    // Citation ALNAÉ adaptée à l'occasion
    callOpenAI(
      `Tu es un expert en écriture émotionnelle haut de gamme pour ALNAÉ Infinity, marque de bijoux de luxe.
Tu écris UNE citation courte (2 à 3 phrases max) qui accompagne un bijou offert.
RÈGLES ABSOLUES :
- Accordée au genre : ${gLabel}
- Unique, jamais générique, jamais répétitive
- Poétique, profond, élégant — jamais cliché
- Évoque la valeur intérieure, la beauté, la force de la personne
- Se termine TOUJOURS par : "N'oublie pas qui tu es."
- Pas de guillemets, pas de tiret, pas de markdown`,
      `Prénom : ${prenom} (genre : ${gLabel})
Occasion : ${occasion || "cadeau"}
${personalMessage ? "Contexte : " + personalMessage.slice(0, 100) : ""}
Génère une citation courte, unique et émotionnelle. Termine par "N'oublie pas qui tu es."`,
      150
    )
  ]);

  // Utiliser l'IA ou le fallback si l'IA est indisponible
  const finalEtym  = aiEtym  || fallbackEtym(prenom, genre);
  const finalMotiv = aiMotiv || fallbackMotiv(genre);

  console.log("[SEAL] IA étym:", aiEtym  ? "✓ générée" : "⚠ fallback");
  console.log("[SEAL] IA motiv:", aiMotiv ? "✓ générée" : "⚠ fallback");

  // ── Stocker le message avec contenu IA ───────────────────────
  const msgData = {
    jewelCode: finalCode, clientCode: clientCode ? normalizeCode(clientCode) : null,
    pin: normalizeCode(pin),
    recipientName: prenom, occasion: occasion || null,
    personalMessage: personalMessage || null,
    etymologyText: finalEtym,
    motivationText: finalMotiv,
    senderLine: senderLine || "— ALNAÉ Confidente",
    createdAt: new Date().toISOString()
  };
  messages.set(finalCode, msgData);

  // Retrouver le numéro de commande
  let orderNumber = "—";
  if (clientCode) {
    const cd = codes.get(normalizeCode(clientCode));
    if (cd) orderNumber = cd.orderNumber;
  }

  console.log("[SEAL]", finalCode, "| Destinataire:", recipientName, "| Commande:", orderNumber);
  saveData(); // persister immédiatement après scellement

  // Email notification admin
  const revealUrl = BASE_URL + "/?code=" + encodeURIComponent(finalCode);
  const esc = s => (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  const adminHtml = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F2EDE3;font-family:Arial,sans-serif;">
<div style="max-width:600px;margin:40px auto;background:#FDFAF5;border:1px solid #C8BAA0;">
  <div style="background:#1C1408;padding:24px 36px;">
    <div style="font-size:10px;letter-spacing:5px;text-transform:uppercase;color:#8B6914;margin-bottom:6px;">ALNAÉ INFINITY</div>
    <div style="font-family:Georgia,serif;font-size:20px;font-style:italic;color:#F0EBE0;">✦ Message prêt à graver</div>
  </div>
  <div style="padding:32px 36px;">
    <table style="width:100%;border-collapse:collapse;font-size:13px;color:#5A4A2A;margin-bottom:24px;">
      <tr style="background:#F8F4EE;"><td style="padding:8px 12px;color:#8A7A60;width:160px;">Commande</td><td style="padding:8px 12px;font-family:monospace;color:#1C1408;font-weight:bold;">${esc(orderNumber)}</td></tr>
      <tr><td style="padding:8px 12px;color:#8A7A60;border-top:1px solid #E8E2D4;">Code confidentiel</td><td style="padding:8px 12px;font-family:monospace;border-top:1px solid #E8E2D4;">${esc(clientCode||"—")}</td></tr>
      <tr style="background:#F8F4EE;"><td style="padding:8px 12px;color:#8A7A60;">Destinataire</td><td style="padding:8px 12px;font-weight:bold;color:#1C1408;">${esc(recipientName||"—")}</td></tr>
      <tr><td style="padding:8px 12px;color:#8A7A60;border-top:1px solid #E8E2D4;">Occasion</td><td style="padding:8px 12px;border-top:1px solid #E8E2D4;">${esc(occasion||"Non précisée")}</td></tr>
      <tr style="background:#F8F4EE;"><td style="padding:8px 12px;color:#8A7A60;">Code bijou (QR)</td><td style="padding:8px 12px;font-family:monospace;">${esc(finalCode)}</td></tr>
      <tr><td style="padding:8px 12px;color:#8A7A60;border-top:1px solid #E8E2D4;">Scellé le</td><td style="padding:8px 12px;border-top:1px solid #E8E2D4;">${new Date().toLocaleDateString("fr-FR",{weekday:"long",day:"2-digit",month:"long",year:"numeric",hour:"2-digit",minute:"2-digit"})}</td></tr>
    </table>
    ${personalMessage ? `
    <div style="margin:16px 0;">
      <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8B6914;margin-bottom:8px;">Message personnel</div>
      <div style="background:#F8F4EE;border:1px solid #C8BAA0;padding:16px;font-family:Georgia,serif;font-style:italic;font-size:14px;color:#1C1408;line-height:1.8;white-space:pre-wrap;">${esc(personalMessage)}</div>
    </div>` : ""}
    ${finalEtym ? `
    <div style="margin:16px 0;">
      <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8B6914;margin-bottom:8px;">Essence du prénom</div>
      <div style="border-left:3px solid #8B6914;padding:10px 16px;background:#F8F4EE;font-family:Georgia,serif;font-style:italic;font-size:13px;color:#3A2C18;line-height:1.7;white-space:pre-wrap;">${esc(finalEtym)}</div>
    </div>` : ""}
    ${finalMotiv ? `
    <div style="margin:16px 0;">
      <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8B6914;margin-bottom:8px;">Citation ALNAÉ</div>
      <div style="background:#1C1408;padding:14px 18px;font-family:Georgia,serif;font-style:italic;font-size:13px;color:#F0EBE0;line-height:1.7;white-space:pre-wrap;">${esc(finalMotiv)}</div>
    </div>` : ""}
    <div style="margin:24px 0;padding:16px 18px;background:#F0EBE0;border:1px solid #C8BAA0;">
      <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8B6914;margin-bottom:14px;">QR Code &amp; Lien de révélation</div>
      <div style="display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap;">
        <div>
          <img src="https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(revealUrl)}&size=140x140&color=1C1408&bgcolor=F0EBE0&margin=6" alt="QR Code" width="140" height="140" style="display:block;border:1px solid #C8BAA0;">
          <div style="font-size:9px;color:#8A7A60;text-align:center;margin-top:4px;letter-spacing:1px;">À imprimer sur la carte</div>
        </div>
        <div style="flex:1;min-width:180px;">
          <div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#8A7A60;margin-bottom:6px;">Code confidentiel</div>
          <div style="font-family:monospace;font-size:15px;letter-spacing:3px;color:#1C1408;font-weight:bold;background:white;padding:8px 14px;border:1.5px solid #1C1408;display:inline-block;margin-bottom:14px;">${esc(clientCode||finalCode)}</div>
          <div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#8A7A60;margin-bottom:6px;">Lien direct</div>
          <a href="${revealUrl}" style="color:#8B6914;font-size:12px;word-break:break-all;display:block;">${revealUrl}</a>
          <div style="margin-top:12px;">
            <a href="${BASE_URL}/admin/print-card?code=${encodeURIComponent(finalCode)}&secret=${ADMIN_SECRET}"
               style="display:inline-block;background:#1C1408;color:#F0EBE0;padding:8px 16px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;text-decoration:none;">
              Imprimer / télécharger la carte
            </a>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div style="background:#F8F4EE;border-top:1px solid #C8BAA0;padding:14px 36px;text-align:center;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8A7A60;">
    ALNAÉ INFINITY — ESPACE INTERNE
  </div>
</div>
</body></html>`;

  const emailResult = await sendEmailResend(
    ADMIN_EMAIL,
    `[Confidente] ✦ Message prêt à graver — ${orderNumber} — ${recipientName}`,
    adminHtml
  );
  console.log("[EMAIL ADMIN]", emailResult.ok ? "✓ Envoyé" : "⚠ Non envoyé (Resend non configuré)");

  return res.json({ ok: true, jewelCode: finalCode, revealUrl });
});

// ── RÉVÉLATION : VÉRIFIER CODE BIJOU ─────────────────────────────
app.post("/start-reveal", (req, res) => {
  const { jewelCode } = req.body;
  if (!jewelCode) return res.status(400).json({ message: "Code manquant." });
  const code = normalizeCode(jewelCode);
  if (!messages.has(code)) {
    return res.status(404).json({ message: "Code incorrect. Vérifiez votre code confidentiel et réessayez." });
  }
  return res.json({ jewelCode: code });
});

// ── RÉVÉLATION : RÉVÉLER APRÈS CODE ──────────────────────────────
app.post("/reveal-message", (req, res) => {
  const { jewelCode, pin } = req.body;
  if (!jewelCode || !pin) return res.status(400).json({ message: "Données manquantes." });
  const code    = normalizeCode(jewelCode);
  const pinNorm = normalizeCode(pin);
  const msg     = messages.get(code);
  if (!msg) return res.status(404).json({ message: "Code incorrect. Vérifiez votre code confidentiel et réessayez." });
  if (msg.pin !== pinNorm) return res.status(401).json({ message: "Code incorrect. Vérifiez votre code confidentiel et réessayez." });
  return res.json({
    recipientName:   msg.recipientName,
    occasion:        msg.occasion,
    etymologyText:   msg.etymologyText,
    personalMessage: msg.personalMessage,
    motivationText:  msg.motivationText,
    senderLine:      msg.senderLine
  });
});

// ── ADMIN : PAGE CARTE IMPRIMABLE ────────────────────────────────
app.get("/admin/print-card", (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(401).send("Non autorisé.");
  const code = (req.query.code || "").replace(/\s/g,"").toUpperCase();
  if (!code) return res.status(400).send("Paramètre code manquant.");

  const revealUrl = BASE_URL + "/?code=" + encodeURIComponent(code);
  const qrUrl = "https://api.qrserver.com/v1/create-qr-code/?data="
              + encodeURIComponent(revealUrl)
              + "&size=220x220&color=1C1408&bgcolor=F8F4EE&margin=8";

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<title>Carte ALNAE — ${code}</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;1,400&family=Raleway:wght@300;400&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#f5f5f5;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:24px;font-family:'Raleway',sans-serif;}
.carte{width:340px;background:white;border:1.5px solid #1C1408;overflow:hidden;}
.ct{background:#1C1408;padding:12px 18px;display:flex;align-items:center;justify-content:space-between;}
.cb{font-size:8px;letter-spacing:4px;text-transform:uppercase;color:#8B6914;}
.cn{font-family:'Playfair Display',serif;font-size:20px;font-style:italic;color:#F0EBE0;font-weight:400;}
.cc{padding:16px;display:flex;gap:14px;align-items:center;}
.cl{flex:1;}
.ci{font-size:10px;color:#5A4A2A;line-height:1.7;margin-bottom:12px;}
.ci strong{color:#1C1408;display:block;}
.ck{font-size:7px;letter-spacing:2px;text-transform:uppercase;color:#8A7A60;margin-bottom:5px;}
.cv{background:white;color:#1C1408;border:1.5px solid #1C1408;padding:5px 10px;font-family:'Courier New',monospace;font-size:12px;letter-spacing:2px;display:inline-block;font-weight:bold;}
.cq img{width:110px;height:110px;display:block;border:1px solid #E8E2D4;}
.cf{border-top:1px solid #E8E2D4;padding:7px 16px;display:flex;justify-content:space-between;}
.cu{font-size:7px;color:#8A7A60;letter-spacing:1px;}
.actions{margin-top:20px;display:flex;gap:10px;flex-wrap:wrap;justify-content:center;}
.btn{padding:10px 22px;border:none;font-size:11px;letter-spacing:2px;text-transform:uppercase;cursor:pointer;font-family:'Raleway',sans-serif;}
.bp{background:#1C1408;color:white;}
.bd{background:white;border:1px solid #C8BAA0;color:#5A4A2A;}
@media print{body{background:white;padding:0;}.actions{display:none;}}
</style></head>
<body>
<div class="carte">
  <div class="ct">
    <div><div class="cb">ALNAÉ INFINITY</div><div class="cn">Confidente</div></div>
    <div style="color:#8B6914;font-size:14px;">◆</div>
  </div>
  <div class="cc">
    <div class="cl">
      <div class="ci">Scannez le QR code ou rendez-vous sur<br>
        <strong>alnaeinfinity.com/pages/confidente</strong>
        et saisissez votre <strong>code confidentiel</strong> pour découvrir votre message.
      </div>
      <div class="ck">CODE CONFIDENTIEL</div>
      <div class="cv">${code}</div>
    </div>
    <div class="cq"><img src="${qrUrl}" alt="QR Code"></div>
  </div>
  <div class="cf">
    <span class="cu">www.alnaeinfinity.com</span>
    <span class="cu">◆ Collection Confidente</span>
  </div>
</div>
<div class="actions">
  <button class="btn bp" onclick="window.print()">Imprimer la carte</button>
  <button class="btn bd" onclick="window.close()">Fermer</button>
</div>
</body></html>`);
});

// ── SANTÉ ─────────────────────────────────────────────────────────
// ── TEST OPENAI — Diagnostic rapide ─────────────────────────────
// Accès : https://alnae-confidente-1.onrender.com/test-openai?secret=ALNAE-ADMIN-2026
app.get("/test-openai", async (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) {
    return res.status(401).json({ message: "Non autorisé" });
  }

  if (!OPENAI_API_KEY) {
    return res.json({
      status: "❌ ECHEC",
      cause: "OPENAI_API_KEY manquante sur Render",
      solution: "Render → ton service → Environment → ajouter OPENAI_API_KEY"
    });
  }

  console.log("[TEST] Appel OpenAI en cours...");
  const result = await callOpenAI(
    "Tu es un assistant de test.",
    "Réponds uniquement : TEST_OK_ALNAE",
    20
  );

  if (result) {
    return res.json({
      status: "✅ OpenAI fonctionne",
      reponse: result,
      cle_presente: true
    });
  } else {
    return res.json({
      status: "❌ Appel OpenAI échoué",
      cause: "Clé présente mais appel rejeté — vérifier les logs Render",
      cle_presente: true,
      solution: "Render → ton service → Logs → chercher [OPENAI]"
    });
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true, version: "v3",
    orders: orders.size, codes: codes.size, messages: messages.size,
    resend: !!RESEND_API_KEY,
    openai: !!OPENAI_API_KEY,
    dataFile: fs.existsSync(DATA_PATH) ? "sauvegarde ok" : "pas de sauvegarde",
    uptime: Math.floor(process.uptime()) + "s"
  });
});

// ── FORMULAIRE CLIENT ────────────────────────────────────────────
// Sert le fichier alnae-formulaire-client.html depuis le même dossier que app.js
app.get("/formulaire", (req, res) => {
  res.sendFile(path.join(__dirname, "alnae-formulaire-client.html"));
});

// ── ESPACE INTERNE ADMIN ──────────────────────────────────────────
app.get("/espace-interne", (req, res) => {
  res.sendFile(path.join(__dirname, "alnae-espace-interne.html"));
});

// ── PAGE RÉVÉLATION ───────────────────────────────────────────────
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>ALNAÉ Confidente — Découvrez votre message</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;1,400&family=Raleway:wght@300;400&display=swap" rel="stylesheet">
<style>
:root{--lin:#F2EDE3;--lb:#C8BAA0;--gold:#8B6914;--gd:#6B5010;--dark:#1C1408;--d2:#3A2C18;--tm:#5A4A2A;--td:#8A7A60;--err:#C0392B;}
*{margin:0;padding:0;box-sizing:border-box;}
body{background:var(--lin);color:var(--dark);font-family:'Raleway',sans-serif;font-weight:300;min-height:100vh;-webkit-font-smoothing:antialiased;}
header{text-align:center;padding:2.5rem 2rem 1.5rem;}
.ey{font-size:.58rem;letter-spacing:.45em;text-transform:uppercase;color:var(--gold);margin-bottom:.7rem;display:flex;align-items:center;justify-content:center;gap:.8rem;}
.ey::before,.ey::after{content:'';width:30px;height:1px;background:var(--gd);}
.ct{font-family:'Playfair Display',serif;font-size:3rem;font-weight:400;font-style:italic;color:var(--dark);}
.tg{font-size:.62rem;letter-spacing:.3em;text-transform:uppercase;color:var(--tm);margin-top:.3rem;}
.cnt{max-width:520px;margin:0 auto;padding:0 1.2rem 5rem;}
.page{display:none;animation:fu .4s ease both;}.page.active{display:block;}
@keyframes fu{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.card{background:rgba(255,252,248,.9);border:1px solid var(--lb);padding:2rem 1.8rem;position:relative;overflow:hidden;margin-bottom:.8rem;}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--gold),transparent);}
.ct2{font-family:'Playfair Display',serif;font-size:1.4rem;font-weight:400;color:var(--dark);margin-bottom:.2rem;}
.cs{font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;color:var(--td);margin-bottom:1.4rem;}
.f{margin-bottom:1rem;}.f label{display:block;font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;color:var(--tm);margin-bottom:.45rem;}
.f input{width:100%;padding:.8rem 1rem;border:1px solid var(--lb);background:rgba(255,252,248,.9);font-family:monospace;font-size:1rem;letter-spacing:.1em;text-align:center;text-transform:uppercase;color:var(--dark);outline:none;transition:border-color .2s;}
.f input:focus{border-color:var(--gd);}
.fh{font-size:.65rem;color:var(--td);margin-top:.4rem;line-height:1.5;}
.btn{display:block;width:100%;padding:.9rem;background:var(--dark);color:var(--lin);border:none;font-family:'Raleway',sans-serif;font-size:.6rem;font-weight:500;letter-spacing:.3em;text-transform:uppercase;cursor:pointer;transition:background .3s;margin-top:.8rem;}
.btn:hover{background:#2A2010;}.btn:disabled{opacity:.4;cursor:not-allowed;}
.btn-g{background:var(--gold);}.btn-g:hover{background:#A07820;}
.al{padding:.75rem 1rem;font-size:.72rem;line-height:1.5;margin-bottom:.9rem;display:none;border-left:2px solid;}
.al.show{display:block;}.ae{background:rgba(192,57,43,.06);border-color:var(--err);color:var(--err);}
.it{display:flex;gap:.6rem;align-items:flex-start;font-size:.68rem;color:var(--tm);background:rgba(139,105,20,.04);border:1px solid rgba(139,105,20,.12);padding:.65rem .9rem;margin-bottom:1rem;}
.ji{font-size:2.4rem;display:block;text-align:center;margin-bottom:.9rem;animation:pulse 4s ease-in-out infinite;}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}
.ob{display:inline-block;padding:.25rem .9rem;border:1px solid var(--gd);font-size:.58rem;letter-spacing:.25em;text-transform:uppercase;color:var(--gold);margin-bottom:1.1rem;}
.rn{font-family:'Playfair Display',serif;font-size:2rem;font-weight:400;font-style:italic;color:var(--dark);text-align:center;margin-bottom:.2rem;}
.ds{display:flex;align-items:center;justify-content:center;gap:.7rem;padding:1rem 0;}
.ds::before,.ds::after{content:'';width:60px;height:1px;background:var(--lb);}
.ds span{width:4px;height:4px;background:var(--gold);transform:rotate(45deg);display:block;}
.eb{border-left:1px solid var(--gd);padding:.8rem 1rem;margin:1rem 0;text-align:left;background:rgba(139,105,20,.03);}
.el{font-size:.58rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gd);margin-bottom:.3rem;}
.eb p{font-family:'Playfair Display',serif;font-size:.95rem;font-style:italic;color:var(--d2);line-height:1.8;white-space:pre-wrap;}
.mb{background:#E8E2D4;border:1px solid var(--lb);padding:1.4rem;margin:1rem 0;text-align:left;}
.mb p{font-family:'Playfair Display',serif;font-size:1.05rem;line-height:1.9;color:var(--dark);white-space:pre-wrap;}
.qb{border:1px solid var(--gd);padding:.9rem 1.3rem;margin:1rem 0;text-align:center;background:rgba(139,105,20,.03);}
.qb p{font-family:'Playfair Display',serif;font-size:.9rem;font-style:italic;color:var(--gold);line-height:1.8;white-space:pre-wrap;}
.fl{font-size:.65rem;letter-spacing:.12em;color:var(--td);margin-top:.8rem;font-style:italic;text-align:center;}
.af{font-size:.58rem;letter-spacing:.18em;color:var(--td);text-transform:uppercase;text-align:center;margin-top:.5rem;}
.af a{color:var(--gd);text-decoration:none;}
.spw{text-align:center;padding:.9rem;display:none;}.spw.show{display:block;}
.sp{width:24px;height:24px;border:1px solid var(--lb);border-top-color:var(--gold);border-radius:50%;animation:spin .9s linear infinite;margin:0 auto .5rem;}
@keyframes spin{to{transform:rotate(360deg)}}
.st{font-size:.6rem;letter-spacing:.15em;text-transform:uppercase;color:var(--td);}
</style></head>
<body>
<header>
  <div class="ey">ALNAÉ Infinity</div>
  <h1 class="ct">Confidente</h1>
  <p class="tg">Le bijou qui porte votre voix</p>
</header>
<div class="cnt">
  <div class="page active" id="p-code">
    <div class="card">
      <h2 class="ct2">Découvrez votre message</h2>
      <p class="cs">Un message vous a été laissé</p>
      <div class="it"><span>◈</span><span>Saisissez le code confidentiel communiqué avec votre bijou pour révéler le message.</span></div>
      <div class="al ae" id="e-code"></div>
      <div class="f">
        <label>Code confidentiel</label>
        <input type="text" id="ci" placeholder="ex. CL-PWFNBRBH" autocomplete="off" oninput="this.value=this.value.replace(/\\s/g,'').toUpperCase()">
        <div class="fh">Ce code vous a été transmis avec votre bijou.</div>
      </div>
      <button class="btn" id="bc">Continuer →</button>
    </div>
  </div>
  <div class="page" id="p-rev">
    <div class="card" style="text-align:center;">
      <span class="ji">◆</span>
      <div id="ow" style="display:none;"><div class="ob" id="ro"></div></div>
      <p class="rn" id="rn"></p>
      <div class="ds"><span></span></div>
      <div class="spw" id="rl"><div class="sp"></div><div class="st">Chargement…</div></div>
      <div class="eb" id="re" style="display:none;"><div class="el">Essence du prénom</div><p id="ret"></p></div>
      <div class="mb" id="rm" style="display:none;"><p id="rmt"></p></div>
      <div class="qb" id="rq" style="display:none;"><p id="rqt"></p></div>
      <p class="fl" id="rf"></p>
      <div class="ds"><span></span></div>
      <div class="af">ALNAÉ Infinity — Collection Confidente<br><a href="https://www.alnaeinfinity.com">www.alnaeinfinity.com</a></div>
      <button class="btn btn-g" id="bdl" style="margin-top:1.2rem;max-width:320px;width:100%;">⬇ Télécharger mon message (PDF)</button>
    </div>
  </div>
</div>
<script>
const g=id=>document.getElementById(id);
function sP(id){document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));g(id)?.classList.add('active');window.scrollTo({top:0,behavior:'smooth'});}
function sT(id,v){const e=g(id);if(e)e.textContent=v??'';}
function sE(id,m){const e=g(id);if(e){e.textContent=m;e.classList.add('show');}}
function hE(id){g(id)?.classList.remove('show');}
const params=new URLSearchParams(window.location.search);
const cp=params.get('code');
if(cp)g('ci').value=cp.replace(/\\s/g,'').toUpperCase();
// ── TÉLÉCHARGEMENT PDF DU MESSAGE ────────────────────────────
let rD=null;

function dlPDF(){
  if(!rD){return;}
  if(typeof window.jspdf==='undefined'){alert('PDF non disponible, rechargez la page.');return;}
  const{jsPDF}=window.jspdf;
  const doc=new jsPDF({unit:'mm',format:'a4'});
  const esc=s=>(s||'').replace(/[^\x20-\x7E\u00C0-\u024F\n]/g,' ');
  const y={v:28};
  const nl=(g=7)=>{y.v+=g;};

  // En-tête
  doc.setFillColor(28,20,8);doc.rect(0,0,210,18,'F');
  doc.setFontSize(7);doc.setTextColor(139,105,20);doc.setFont('helvetica','normal');
  doc.text('ALNAÉ INFINITY — COLLECTION CONFIDENTE',105,11,{align:'center',charSpace:2});

  // Titre prénom
  doc.setFontSize(22);doc.setTextColor(28,20,8);doc.setFont('times','italic');
  doc.text(esc(rD.recipientName||''),105,y.v,{align:'center'});nl(10);

  // Ligne or
  doc.setDrawColor(139,105,20);doc.setLineWidth(0.3);doc.line(40,y.v,170,y.v);nl(7);

  // Occasion
  if(rD.occasion){
    doc.setFontSize(8);doc.setTextColor(139,105,20);doc.setFont('helvetica','normal');
    doc.text(esc(rD.occasion.toUpperCase()),105,y.v,{align:'center',charSpace:3});nl(9);
  }

  // Étymologie
  if(rD.etymologyText){
    doc.setFontSize(7);doc.setTextColor(107,80,16);doc.setFont('helvetica','normal');
    doc.text('ESSENCE DU PRÉNOM',20,y.v,{charSpace:2});nl(5);
    doc.setFontSize(9.5);doc.setTextColor(58,44,24);doc.setFont('times','italic');
    const el=doc.splitTextToSize(esc(rD.etymologyText),165);
    doc.text(el,22,y.v);nl(el.length*5+7);
  }

  // Message personnel
  if(rD.personalMessage){
    doc.setFillColor(232,226,212);doc.rect(18,y.v-3,174,2,'F');
    doc.setFontSize(11);doc.setTextColor(28,20,8);doc.setFont('times','italic');
    const ml=doc.splitTextToSize(esc(rD.personalMessage),168);
    doc.text(ml,21,y.v+4);nl(ml.length*6+11);
  }

  // Citation ALNAÉ
  if(rD.motivationText){
    doc.setFillColor(28,20,8);
    const ql=doc.splitTextToSize(esc(rD.motivationText),155);
    const qh=ql.length*5.5+10;
    doc.rect(18,y.v-3,174,qh,'F');
    doc.setFontSize(9.5);doc.setTextColor(240,235,224);doc.setFont('times','italic');
    doc.text(ql,105,y.v+4,{align:'center'});nl(qh+5);
  }

  // Signature
  if(rD.senderLine){
    doc.setFontSize(8);doc.setTextColor(138,122,96);doc.setFont('times','italic');
    doc.text(esc(rD.senderLine),170,y.v,{align:'right'});nl(14);
  }

  // Pied de page
  doc.setDrawColor(200,186,160);doc.setLineWidth(0.3);doc.line(18,y.v,192,y.v);nl(7);
  doc.setFontSize(6.5);doc.setTextColor(138,122,96);doc.setFont('helvetica','normal');
  doc.text('ALNAÉ INFINITY  ◆  COLLECTION CONFIDENTE  ◆  WWW.ALNAEINFINITY.COM',105,y.v,{align:'center',charSpace:1});

  doc.save('message-alnae-confidente.pdf');
}

g('bdl')?.addEventListener('click', dlPDF);

g('bc')?.addEventListener('click',async function(){
  const code=(g('ci').value||'').replace(/\\s/g,'').toUpperCase();
  if(!code){sE('e-code','Veuillez saisir votre code confidentiel.');return;}
  hE('e-code');this.disabled=true;this.textContent='VÉRIFICATION…';
  g('rl').classList.add('show');
  try{
    const r=await fetch('/reveal-message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jewelCode:code,pin:code})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.message||'Code incorrect.');
    rD=d;
    sT('rn',d.recipientName||'');
    if(d.occasion){sT('ro',d.occasion);g('ow').style.display='block';}else g('ow').style.display='none';
    if(d.etymologyText){sT('ret',d.etymologyText);g('re').style.display='block';}else g('re').style.display='none';
    if(d.personalMessage){sT('rmt',d.personalMessage);g('rm').style.display='block';}else g('rm').style.display='none';
    if(d.motivationText){sT('rqt',d.motivationText);g('rq').style.display='block';}else g('rq').style.display='none';
    sT('rf',d.senderLine||'— ALNAÉ Confidente');
    g('rl').classList.remove('show');
    sP('p-rev');
  }catch(err){g('rl').classList.remove('show');sE('e-code',err.message||'Code incorrect.');}
  finally{this.disabled=false;this.textContent='CONTINUER →';}
});
</script>
</body></html>`);
});

// ── DÉMARRAGE ─────────────────────────────────────────────────────
loadData(); // ← restaurer les données au démarrage

app.listen(port, () => {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ALNAÉ Confidente v3");
  console.log("  Port     :", port);
  console.log("  URL      :", BASE_URL);
  console.log("  Resend   :", RESEND_API_KEY ? "✓ configuré" : "⚠ manquant (emails désactivés)");
  console.log("  OpenAI   :", OPENAI_API_KEY ? "✓ configuré" : "⚠ manquant (IA désactivée)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});
