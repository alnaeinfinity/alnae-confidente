const express  = require("express");
const crypto   = require("crypto");
const https    = require("https");
const app      = express();
const port     = process.env.PORT || 10000;

const WEBHOOK_SECRET  = "b3ec7181efef92e88e640c39153a881249fab46192dcfb71c4ca92cf6d761cec";
const SENDGRID_KEY    = process.env.SENDGRID_KEY    || "";
const ALNAE_EMAIL     = process.env.ALNAE_EMAIL     || "commande.alnae@gmail.com";
const BASE_URL        = process.env.BASE_URL        || "https://alnae-confidente-1.onrender.com";
const STOREFRONT_URL  = "https://www.alnaeinfinity.com/pages/confidente";
const CONFIDENTE_KEYWORDS = ["confidente", "confiant"];

app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const orders   = new Map();
const slots    = new Map();
const messages = new Map();

function normalize(s) {
  return String(s || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function isConfidenreProd(title) {
  const t = normalize(title);
  return CONFIDENTE_KEYWORDS.some(k => t.includes(k));
}
function countConfidente(lineItems) {
  let n = 0;

  for (const article of lineItems) {
    const title = normalize(article.title || article.name || article.product_title || "");
    const variantTitle = normalize(article.variant_title || "");
    const sku = normalize(article.sku || "");
    const tags = normalize((article.product_tags || article.tags || "").replace(/,/g, " "));

    const isConfidente =
      title.includes("option confidente") ||
      variantTitle.includes("option confidente") ||
      sku.includes("confidente") ||
      tags.includes("confidente");

    if (isConfidente) {
      n += Number(article.quantity) || 1;
    }
  }

  return n;
}

function genToken() { return crypto.randomBytes(20).toString("hex"); }
function genJewelCode(orderNumber, i) {
  return ("CONF-" + String(orderNumber).replace(/[^a-zA-Z0-9]/g,"") + "-" + String(i).padStart(2,"0")).toUpperCase();
}

async function sendEmail(to, subject, html) {
  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  const EMAIL_FROM = process.env.EMAIL_FROM || "contact.alnae@gmail.com";
  const SHOP_NAME = process.env.SHOP_NAME || "Alnaé Infinity";

  if (!BREVO_API_KEY) {
    console.log("[EMAIL] BREVO_API_KEY manquante - destinataire:", to);
    return false;
  }

  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: {
          name: SHOP_NAME,
          email: EMAIL_FROM
        },
        to: [{ email: to }],
        subject,
        htmlContent: html
      })
    });

    const text = await response.text();

    if (!response.ok) {
      console.log("[EMAIL] Erreur Brevo:", response.status, text);
      return false;
    }

    console.log("[EMAIL] Envoyé:", to);
    return true;
  } catch (error) {
    console.log("[EMAIL] Exception Brevo:", error.message);
    return false;
  }
}

function buildEmailHTML(order, orderSlots) {
  const slotsHtml = orderSlots.map((slot, i) => `
    <div style="background:#F8F4EE;border:1px solid #C8BAA0;padding:20px;margin:10px 0;">
      <h3 style="color:#1C1408;font-family:Georgia,serif;margin:0 0 8px;">Bijou ${i + 1}</h3>
      <a href="${BASE_URL}/formulaire/${slot.accessToken}"
         style="display:inline-block;background:#1C1408;color:#F0EBE0;padding:10px 20px;text-decoration:none;margin:8px 0;">
        Déposer le message du bijou ${i + 1}
      </a>
      <p style="color:#8A7A60;font-size:12px;margin:8px 0 0;">Lien personnel — usage unique.</p>
    </div>
  `).join("");
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
  <body style="font-family:Arial,sans-serif;background:#F2EDE3;padding:40px;">
  <div style="max-width:560px;margin:0 auto;background:white;border:1px solid #C8BAA0;padding:40px;">
    <div style="text-align:center;margin-bottom:24px;">
      <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#8B6914;">ALNAÉ Infinity</div>
      <h1 style="font-family:Georgia,serif;font-size:26px;font-weight:400;font-style:italic;color:#1C1408;">Collection Confidente</h1>
    </div>
    <p style="color:#3A2C18;font-size:15px;">Bonjour ${order.firstName},</p>
    <p style="color:#5A4A2A;font-size:14px;line-height:1.7;">
      Merci pour votre commande <strong>${order.orderNumber}</strong>.<br>
      Vous avez commandé <strong>${orderSlots.length} bijou(x) Confidente</strong>.
    </p>
    ${slotsHtml}
    <p style="color:#8A7A60;font-size:12px;margin-top:24px;border-top:1px solid #C8BAA0;padding-top:16px;">
      ALNAÉ Infinity — <a href="https://www.alnaeinfinity.com" style="color:#8B6914;">www.alnaeinfinity.com</a>
    </p>
  </div></body></html>`;
}

function verifyShopify(req) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  if (!hmac || !req.body) return false;
  const digest = crypto.createHmac("sha256", WEBHOOK_SECRET).update(req.body).digest("base64");
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac)); }
  catch(_) { return false; }
}

app.post("/webhook/shopify", async (req, res) => {
  if (!verifyShopify(req)) { console.warn("[WEBHOOK] Signature invalide"); return res.status(401).json({ error: "Unauthorized" }); }
  let shopifyOrder;
  try { shopifyOrder = JSON.parse(req.body.toString()); } catch(e) { return res.status(400).json({ error: "Invalid JSON" }); }
  res.status(200).json({ ok: true });
  const orderNumber = String(shopifyOrder.order_number || shopifyOrder.name || "").replace("#","");
  const email       = shopifyOrder.email || shopifyOrder.contact_email || "";
  const firstName   = shopifyOrder.billing_address?.first_name || shopifyOrder.customer?.first_name || "";
  const lastName    = shopifyOrder.billing_address?.last_name  || shopifyOrder.customer?.last_name  || "";
  const lineItems   = shopifyOrder.line_items || [];
  const count       = countConfidente(lineItems);
  console.log("[WEBHOOK] Commande:", orderNumber, firstName, lastName, "— Confidente:", count);
  if (count === 0) return;
  orders.set(normalize(orderNumber), { orderNumber, email, firstName, lastName, count, receivedAt: new Date().toISOString() });
  const orderSlots = [];
  for (let i = 1; i <= count; i++) {
    const accessToken = genToken();
    const jewelCode   = genJewelCode(orderNumber, i);
    const slot = { accessToken, jewelCode, orderNumber, slotIndex: i, status: "available", email, firstName, lastName, createdAt: new Date().toISOString() };
    slots.set(accessToken, slot);
    orderSlots.push(slot);
    console.log("[SLOT]", jewelCode, BASE_URL + "/formulaire/" + accessToken);
  }
  const emailHtml = buildEmailHTML({ orderNumber, firstName }, orderSlots);
  const sent = await sendEmail(email, "ALNAÉ Infinity — Collection Confidente — Commande " + orderNumber, emailHtml);
  await sendEmail(ALNAE_EMAIL, "[ALNAE] Commande Confidente " + orderNumber + " (" + count + " bijou(x))", emailHtml);
  console.log("[EMAIL] Envoyé:", sent);
});

app.get("/health", (req, res) => res.json({ ok:true, orders:orders.size, slots:slots.size, messages:messages.size, uptime:Math.floor(process.uptime())+"s" }));

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ALNAÉ Confidente</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;1,400;1,500&family=Raleway:wght@200;300;400;500&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
/* ═══════════════════════════════════════════════════════════
   ALNAÉ CONFIDENTE — LUXURY EDITORIAL DESIGN
   Direction : Noir de fond, or mat, espaces généreux,
   typographie haute couture. Universel, sans genre.
═══════════════════════════════════════════════════════════ */
:root {
  --obsidian: #F2EDE3;
  --obsidian-mid: #EDE8DC;
  --obsidian-soft: #E8E2D4;
  --obsidian-border: #C8BAA0;
  --gold: #8B6914;
  --gold-bright: #A07820;
  --gold-dim: #6B5010;
  --gold-trace: rgba(139,105,20,.06);
  --gold-glow: rgba(139,105,20,.1);
  --ivory: #1C1408;
  --ivory-dim: #3A2C18;
  --ivory-faint: rgba(139,105,20,.04);
  --white: #FDFAF5;
  --error: #C0392B;
  --success: #2ECC71;
  --text: #1C1408;
  --text-mid: #5A4A2A;
  --text-dim: #8A7A60;
}
* { margin:0; padding:0; box-sizing:border-box; }
html { scroll-behavior: smooth; }

body {
  background: var(--obsidian);
  color: var(--text);
  font-family: 'Raleway', sans-serif;
  font-weight: 300;
  min-height: 100vh;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
}

/* Grain texture overlay */
body::after {
  content: '';
  position: fixed;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");
  pointer-events: none;
  z-index: 9999;
  opacity: .4;
}

/* Ambient gold glow */
body::before {
  content: '';
  position: fixed;
  top: -30vh;
  left: 50%;
  transform: translateX(-50%);
  width: 600px;
  height: 400px;
  background: radial-gradient(ellipse, rgba(196,163,90,.06) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
}

/* ── HEADER ───────────────────────────────────────── */
header {
  text-align: center;
  padding: 4rem 2rem 2rem;
  position: relative;
  z-index: 1;
}

.brand-eyebrow {
  font-size: .6rem;
  letter-spacing: .5em;
  text-transform: uppercase;
  color: var(--gold);
  margin-bottom: 1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
}
.brand-eyebrow::before,.brand-eyebrow::after {
  content: '';
  width: 40px;
  height: 1px;
  background: var(--gold-dim);
}

.collection-title {
  font-family: 'Playfair Display', serif;
  font-size: 3.8rem;
  font-weight: 400;
  font-style: italic;
  color: var(--ivory);
  line-height: .95;
  letter-spacing: -.01em;
  margin-bottom: .6rem;
}

.tagline {
  font-size: .62rem;
  letter-spacing: .35em;
  text-transform: uppercase;
  color: var(--text-mid);
}

/* ── CONTAINER ────────────────────────────────────── */
.container {
  max-width: 560px;
  margin: 0 auto;
  padding: 0 1.2rem 5rem;
  position: relative;
  z-index: 1;
}

/* ── NAV TABS ─────────────────────────────────────── */
.nav-tabs {
  display: flex;
  border-bottom: 1px solid var(--obsidian-border);
  margin-bottom: 2rem;
  position: sticky;
  top: 0;
  background: var(--obsidian);
  z-index: 50;
  padding-top: .5rem;
  gap: 0;
}

.nav-tab {
  flex: 1;
  padding: .85rem .5rem;
  text-align: center;
  font-size: .6rem;
  letter-spacing: .25em;
  text-transform: uppercase;
  color: var(--text-dim);
  cursor: pointer;
  border-bottom: 1px solid transparent;
  margin-bottom: -1px;
  transition: all .25s;
  user-select: none;
  font-weight: 400;
}
.nav-tab:hover { color: var(--text-mid); }
.nav-tab.active { color: var(--gold); border-bottom-color: var(--gold); }

/* ── PAGES ────────────────────────────────────────── */
.page { display: none; animation: fadeUp .4s ease both; }
.page.active { display: block; }
@keyframes fadeUp { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }

/* ── STEP DOTS ────────────────────────────────────── */
.steps {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: .5rem;
  margin-bottom: 1.5rem;
}
.step-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--obsidian-border);
  transition: all .3s;
}
.step-dot.active { background: var(--gold); width: 20px; border-radius: 3px; }

/* ── CARD ─────────────────────────────────────────── */
.card {
  background: var(--obsidian-mid);
  border: 1px solid var(--obsidian-border);
  border-radius: 1px;
  padding: 2.2rem 2rem;
  position: relative;
  overflow: hidden;
  margin-bottom: .8rem;
}
.card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--gold), transparent);
}

.card-title {
  font-family: 'Playfair Display', serif;
  font-size: 1.5rem;
  font-weight: 400;
  color: var(--ivory);
  margin-bottom: .2rem;
  letter-spacing: -.01em;
}
.card-subtitle {
  font-size: .6rem;
  letter-spacing: .2em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 1.8rem;
}

/* ── FIELDS ───────────────────────────────────────── */
.field { margin-bottom: 1.2rem; }
.field label {
  display: block;
  font-size: .6rem;
  letter-spacing: .2em;
  text-transform: uppercase;
  color: var(--text-mid);
  margin-bottom: .5rem;
  font-weight: 400;
}
.req { color: var(--gold); }

.field input[type=text],
.field input[type=email],
.field input[type=tel],
.field textarea {
  width: 100%;
  padding: .85rem 1rem;
  border: 1px solid var(--obsidian-border);
  border-radius: 1px;
  background: var(--obsidian-soft);
  font-family: 'Raleway', sans-serif;
  font-size: .88rem;
  font-weight: 300;
  color: var(--ivory);
  transition: border-color .2s, box-shadow .2s;
  outline: none;
  -webkit-appearance: none;
}
.field input::placeholder, .field textarea::placeholder { color: var(--text-dim); }
.field input:focus, .field textarea:focus {
  border-color: var(--gold-dim);
  box-shadow: 0 0 0 3px rgba(196,163,90,.07);
}
.field input.err { border-color: var(--error); }
.field textarea { resize: vertical; min-height: 110px; line-height: 1.75; }
.field-error { font-size: .65rem; color: var(--error); margin-top: .3rem; display: none; }
.field-error.show { display: block; }
.char-count { text-align: right; font-size: .62rem; color: var(--text-dim); margin-top: .3rem; }
.small-muted { font-size: .63rem; color: var(--text-dim); margin-top: .3rem; }

/* ── PILLS ────────────────────────────────────────── */
.pill-group { display: flex; flex-wrap: wrap; gap: .4rem; margin-bottom: .7rem; }
.pill {
  padding: .3rem .8rem;
  border: 1px solid var(--obsidian-border);
  border-radius: 0;
  font-size: .62rem;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--text-mid);
  cursor: pointer;
  transition: all .2s;
  background: transparent;
  user-select: none;
  font-family: 'Raleway', sans-serif;
  font-weight: 400;
}
.pill:hover { border-color: var(--gold-dim); color: var(--gold); }
.pill.active { background: var(--gold); border-color: var(--gold); color: var(--obsidian); }

/* ── OPTION BLOCKS ────────────────────────────────── */
.option-block {
  border: 1px solid var(--obsidian-border);
  margin-bottom: .6rem;
  overflow: hidden;
  transition: border-color .3s;
  background: var(--obsidian-mid);
}
.option-block.on {
  border-color: var(--gold-dim);
  box-shadow: 0 0 24px rgba(196,163,90,.06);
}
.option-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: .85rem 1.1rem;
  user-select: none;
}
.option-left { display: flex; align-items: center; gap: .8rem; }
.option-icon { font-size: 1rem; opacity: .7; }
.option-title { font-size: .75rem; font-weight: 400; color: var(--ivory); letter-spacing: .03em; }
.option-desc { font-size: .62rem; color: var(--text-dim); margin-top: .1rem; }
.option-body {
  padding: 1rem 1.1rem;
  border-top: 1px solid var(--obsidian-border);
  display: none;
}
.option-body.open { display: block; }

/* ── TOGGLE ───────────────────────────────────────── */
.toggle { position: relative; width: 36px; height: 20px; flex-shrink: 0; }
.toggle input { opacity: 0; width: 0; height: 0; }
.slider {
  position: absolute; inset: 0;
  background: var(--obsidian-soft);
  border: 1px solid var(--obsidian-border);
  border-radius: 10px;
  cursor: pointer;
  transition: .3s;
}
.slider::before {
  content: '';
  position: absolute;
  width: 14px; height: 14px;
  left: 2px; top: 2px;
  background: var(--text-dim);
  border-radius: 50%;
  transition: .3s;
}
.toggle input:checked + .slider { background: var(--gold); border-color: var(--gold); }
.toggle input:checked + .slider::before { background: var(--obsidian); transform: translateX(16px); }

/* ── SUGGESTIONS ──────────────────────────────────── */
.suggestions-box {
  background: var(--obsidian-soft);
  border: 1px solid var(--obsidian-border);
  padding: .8rem;
  margin-top: .6rem;
}
.sug-title {
  font-size: .58rem;
  letter-spacing: .2em;
  text-transform: uppercase;
  color: var(--gold-dim);
  margin-bottom: .6rem;
  font-weight: 400;
}
.sug-item {
  display: flex;
  align-items: flex-start;
  gap: .6rem;
  padding: .4rem 0;
  border-bottom: 1px solid var(--obsidian-border);
  cursor: pointer;
}
.sug-item:last-child { border-bottom: none; }
.sug-item input[type=checkbox] {
  width: 14px; height: 14px; min-width: 14px;
  margin-top: 3px;
  accent-color: var(--gold);
  cursor: pointer;
  flex-shrink: 0;
}
.sug-item span {
  font-size: .78rem;
  font-family: 'Playfair Display', serif;
  font-style: italic;
  color: var(--ivory-dim);
  line-height: 1.5;
}

/* ── RGPD BOX ─────────────────────────────────────── */
.rgpd-box {
  background: var(--obsidian-soft);
  border: 1px solid var(--obsidian-border);
  padding: .9rem 1.1rem;
  margin: .9rem 0;
  font-size: .7rem;
  line-height: 1.7;
  color: var(--text-mid);
}
.rgpd-box strong { color: var(--ivory); font-weight: 400; }
.rgpd-row { display: flex; align-items: flex-start; gap: .65rem; margin-top: .7rem; }
.rgpd-row input[type=checkbox] {
  width: 15px; height: 15px; min-width: 15px;
  flex-shrink: 0; margin-top: 2px;
  cursor: pointer; accent-color: var(--gold);
}
.rgpd-row span { font-size: .68rem; color: var(--text); line-height: 1.5; cursor: pointer; }

/* ── ALERTS ───────────────────────────────────────── */
.alert-box {
  padding: .75rem 1rem;
  font-size: .72rem;
  line-height: 1.5;
  margin-bottom: .9rem;
  display: none;
  border-left: 2px solid;
}
.alert-box.show { display: block; }
.alert-error { background: rgba(192,57,43,.08); border-color: var(--error); color: #E0756B; }
.alert-success { background: rgba(46,204,113,.06); border-color: var(--success); color: #5DC988; }

/* ── INFO ROWS ────────────────────────────────────── */
.info-row {
  display: flex;
  gap: .6rem;
  align-items: flex-start;
  font-size: .68rem;
  color: var(--text-mid);
  margin-bottom: 1rem;
}
.info-row.tip {
  background: var(--ivory-faint);
  border: 1px solid rgba(196,163,90,.12);
  padding: .65rem .9rem;
}

/* ── BUTTONS ──────────────────────────────────────── */
.btn {
  display: block;
  width: 100%;
  padding: 1rem;
  background: transparent;
  color: var(--ivory);
  border: 1px solid var(--obsidian-border);
  font-family: 'Raleway', sans-serif;
  font-size: .6rem;
  font-weight: 500;
  letter-spacing: .3em;
  text-transform: uppercase;
  cursor: pointer;
  transition: all .3s;
  margin-top: 1rem;
  position: relative;
  overflow: hidden;
}
.btn::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--ivory-faint);
  transform: scaleX(0);
  transform-origin: left;
  transition: transform .3s;
}
.btn:hover { border-color: var(--text-mid); }
.btn:hover::after { transform: scaleX(1); }
.btn:disabled { opacity: .4; cursor: not-allowed; }
.btn:disabled::after { display: none; }

.btn-primary {
  background: #1C1408;
  color: #F2EDE3;
  border-color: #1C1408;
}
.btn-primary::after { background: rgba(255,255,255,.05); }
.btn-primary:hover { background: #2A2010; border-color: #2A2010; }

.btn-gold {
  background: var(--gold);
  color: var(--obsidian);
  border-color: var(--gold);
  font-weight: 500;
}
.btn-gold::after { background: rgba(0,0,0,.08); }
.btn-gold:hover { background: var(--gold-bright); border-color: var(--gold-bright); }

/* ── PIN ──────────────────────────────────────────── */
.pin-wrap { display: flex; gap: .5rem; justify-content: center; margin: .9rem 0; }
.pin-digit {
  width: 50px; height: 58px;
  border: 1px solid var(--obsidian-border);
  background: var(--obsidian-soft);
  font-family: 'Playfair Display', serif;
  font-size: 1.6rem;
  text-align: center;
  color: var(--ivory);
  outline: none;
  transition: border-color .2s, box-shadow .2s;
  -webkit-appearance: none;
}
.pin-digit:focus { border-color: var(--gold-dim); box-shadow: 0 0 0 3px rgba(196,163,90,.08); }
.pin-hint { font-size: .63rem; color: var(--text-dim); text-align: center; line-height: 1.5; letter-spacing: .05em; }

/* ── MÉDIA ────────────────────────────────────────── */
.media-upload-area {
  border: 1px dashed var(--obsidian-border);
  padding: 1.5rem 1rem;
  text-align: center;
  cursor: pointer;
  transition: all .2s;
  position: relative;
}
.media-upload-area:hover, .media-upload-area.drag-over {
  border-color: var(--gold-dim);
  background: var(--ivory-faint);
}
.media-upload-area input[type=file] {
  position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%;
}
.media-upload-icon { font-size: 1.5rem; display: block; margin-bottom: .5rem; opacity: .5; }
.media-upload-label { font-size: .7rem; color: var(--text-mid); line-height: 1.6; }
.media-upload-label strong { color: var(--gold); display: block; font-size: .72rem; font-weight: 400; letter-spacing: .05em; }
.media-types { display: flex; gap: .4rem; justify-content: center; flex-wrap: wrap; margin-top: .6rem; }
.media-type-badge {
  font-size: .55rem; letter-spacing: .15em; text-transform: uppercase;
  padding: .2rem .5rem; border: 1px solid var(--obsidian-border);
  color: var(--text-dim); font-weight: 400;
}
.media-previews { display: flex; flex-direction: column; gap: .5rem; margin-top: .8rem; }
.media-item {
  display: flex; align-items: center; gap: .7rem;
  background: var(--obsidian-soft);
  border: 1px solid var(--obsidian-border);
  padding: .6rem .8rem;
  position: relative;
}
.media-item-icon { font-size: 1.2rem; flex-shrink: 0; opacity: .7; }
.media-item-info { flex: 1; min-width: 0; }
.media-item-name { font-size: .72rem; color: var(--ivory); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.media-item-size { font-size: .62rem; color: var(--text-dim); margin-top: .1rem; }
.media-item-remove {
  background: none; border: none; color: var(--text-dim);
  cursor: pointer; font-size: .9rem; padding: .2rem; flex-shrink: 0; line-height: 1;
}
.media-item-remove:hover { color: var(--error); }
.media-item-preview { width: 44px; height: 44px; object-fit: cover; flex-shrink: 0; border: 1px solid var(--obsidian-border); }
.media-item-audio { width: 100%; margin-top: .4rem; filter: invert(1) hue-rotate(180deg); opacity: .7; }
.media-limit-info { font-size: .62rem; color: var(--text-dim); text-align: center; margin-top: .5rem; line-height: 1.5; }
.media-error { font-size: .65rem; color: var(--error); margin-top: .3rem; display: none; }
.media-error.show { display: block; }

/* ── QR / CARTE ───────────────────────────────────── */
.qr-section { text-align: center; padding: 1.2rem 0; }
.qr-label { font-size: .6rem; letter-spacing: .2em; text-transform: uppercase; color: var(--gold); margin-bottom: .8rem; }
#qrcode-container canvas, #qrcode-container img,
#carte-qr-mini canvas, #carte-qr-mini img { display: block; margin: 0 auto; }
.qr-url { font-size: .6rem; color: var(--text-dim); margin-top: .5rem; word-break: break-all; }
.carte-preview {
  border: 1px solid var(--obsidian-border);
  padding: 1.2rem;
  margin: 1rem 0;
  background: var(--obsidian-soft);
  position: relative;
}
.carte-preview::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--gold), transparent);
}
.carte-header { font-size: .58rem; letter-spacing: .2em; text-transform: uppercase; color: var(--gold); text-align: center; margin-bottom: .7rem; }
.carte-body { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.carte-text { flex: 1; font-size: .72rem; color: var(--text-mid); line-height: 1.6; min-width: 160px; }
.carte-code-badge {
  background: var(--obsidian);
  color: var(--gold);
  padding: .4rem .8rem;
  font-family: monospace;
  font-size: .85rem;
  letter-spacing: .15em;
  border: 1px solid var(--gold-dim);
  text-align: center;
  white-space: nowrap;
}

/* ── REVEAL / MESSAGE ─────────────────────────────── */
.reveal-center { text-align: center; }
.jewel-icon { font-size: 2.6rem; display: block; text-align: center; margin-bottom: .9rem; animation: pulse 4s ease-in-out infinite; }
@keyframes pulse { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.04);opacity:.85} }

.occasion-badge {
  display: inline-block;
  padding: .25rem .9rem;
  border: 1px solid var(--gold-dim);
  font-size: .58rem;
  letter-spacing: .25em;
  text-transform: uppercase;
  color: var(--gold);
  margin-bottom: 1.1rem;
}
.recipient-name {
  font-family: 'Playfair Display', serif;
  font-size: 2.2rem;
  font-weight: 400;
  font-style: italic;
  color: var(--ivory);
  text-align: center;
  margin-bottom: .2rem;
  letter-spacing: -.01em;
}
.diamond-sep {
  display: flex; align-items: center; justify-content: center; gap: .7rem; padding: 1rem 0;
}
.diamond-sep::before, .diamond-sep::after { content: ''; width: 60px; height: 1px; background: var(--obsidian-border); }
.diamond-sep span { width: 4px; height: 4px; background: var(--gold); transform: rotate(45deg); display: block; }

.etym-block {
  border-left: 1px solid var(--gold-dim);
  padding: .8rem 1rem;
  margin: 1rem 0;
  text-align: left;
  background: var(--ivory-faint);
}
.etym-label { font-size: .58rem; letter-spacing: .2em; text-transform: uppercase; color: var(--gold-dim); margin-bottom: .3rem; }
.etym-block p {
  font-family: 'Playfair Display', serif;
  font-size: .95rem;
  font-style: italic;
  color: var(--ivory-dim);
  line-height: 1.8;
  white-space: pre-wrap;
}
.msg-block {
  background: var(--obsidian-soft);
  border: 1px solid var(--obsidian-border);
  padding: 1.4rem;
  margin: 1rem 0;
  text-align: left;
}
.msg-block p {
  font-family: 'Playfair Display', serif;
  font-size: 1.05rem;
  line-height: 1.9;
  color: var(--ivory);
  white-space: pre-wrap;
}
.motiv-block {
  border: 1px solid var(--gold-dim);
  padding: .9rem 1.3rem;
  margin: 1rem 0;
  text-align: center;
  background: var(--ivory-faint);
}
.motiv-block p {
  font-family: 'Playfair Display', serif;
  font-size: .9rem;
  font-style: italic;
  color: var(--gold);
  line-height: 1.8;
  white-space: pre-wrap;
}
.from-line {
  font-size: .65rem; letter-spacing: .12em;
  color: var(--text-dim); margin-top: .8rem;
  font-style: italic; text-align: center;
}
.alnae-footer { font-size: .58rem; letter-spacing: .18em; color: var(--text-dim); text-transform: uppercase; text-align: center; margin-top: .5rem; }
.alnae-footer a { color: var(--gold-dim); text-decoration: none; }
.alnae-footer a:hover { color: var(--gold); }

/* ── SUCCESS ──────────────────────────────────────── */
.success-icon {
  width: 52px; height: 52px;
  border: 1px solid var(--gold-dim);
  display: flex; align-items: center; justify-content: center;
  margin: 0 auto 1.3rem;
  font-size: 1.2rem;
  color: var(--gold);
  font-family: 'Playfair Display', serif;
  font-style: italic;
}

/* ── SPINNER ──────────────────────────────────────── */
.spinner-wrap { text-align: center; padding: .9rem; display: none; }
.spinner-wrap.show { display: block; }
.spinner {
  width: 24px; height: 24px;
  border: 1px solid var(--obsidian-border);
  border-top-color: var(--gold);
  border-radius: 50%;
  animation: spin .9s linear infinite;
  margin: 0 auto .5rem;
}
@keyframes spin { to{transform:rotate(360deg)} }
.spinner-text { font-size: .6rem; letter-spacing: .15em; text-transform: uppercase; color: var(--text-dim); }

/* ── PREVIEW OVERLAY ──────────────────────────────── */
.preview-overlay {
  display: none; position: fixed; inset: 0;
  background: rgba(28,20,8,.75);
  z-index: 1000; overflow-y: auto; padding: 2rem 1rem;
  backdrop-filter: blur(4px);
}
.preview-overlay.show { display: flex; align-items: flex-start; justify-content: center; }
.preview-inner {
  background: var(--obsidian-mid);
  border: 1px solid var(--obsidian-border);
  max-width: 520px; width: 100%;
  position: relative; margin: auto;
}
.preview-inner::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--gold), transparent);
}
.preview-header {
  background: var(--obsidian);
  padding: .9rem 1.3rem;
  display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid var(--obsidian-border);
}
.preview-header span { font-size: .6rem; letter-spacing: .2em; text-transform: uppercase; color: var(--gold); }
.preview-close {
  background: none; border: none; color: var(--text-dim);
  font-size: 1rem; cursor: pointer; padding: .2rem .4rem; line-height: 1;
}
.preview-close:hover { color: var(--ivory); }
.preview-body { padding: 1.8rem 1.4rem; }
.preview-warning {
  background: rgba(196,163,90,.05);
  border: 1px solid rgba(196,163,90,.15);
  padding: .7rem .9rem; margin-bottom: 1.3rem;
  font-size: .68rem; color: var(--text-mid); line-height: 1.5;
}

/* ── BADGE ────────────────────────────────────────── */
.badge-new {
  display: inline-block; background: var(--gold);
  color: var(--obsidian); font-size: .52rem;
  letter-spacing: .12em; text-transform: uppercase;
  padding: .15rem .45rem; margin-left: .4rem; vertical-align: middle;
  font-weight: 500;
}

.email-status{padding:.7rem 1rem;border-radius:2px;font-size:.72rem;line-height:1.5;margin:.8rem 0;}
.email-status.sent{background:rgba(46,204,113,.08);border:1px solid rgba(46,204,113,.3);color:#27AE60;}
.email-status.pending{background:rgba(139,105,20,.08);border:1px solid rgba(139,105,20,.3);color:var(--gold);}
/* ── CONFETTI ─────────────────────────────────────── */
.confetti-wrap { position: fixed; inset: 0; pointer-events: none; z-index: 100; overflow: hidden; }
.cp { position: absolute; top: -10px; animation: fall linear forwards; opacity: 0; }
@keyframes fall { 0%{opacity:1;transform:translateY(0) rotate(0)} 100%{opacity:0;transform:translateY(100vh) rotate(720deg)} }

@media(max-width:480px) {
  .collection-title { font-size: 2.8rem; }
  .card { padding: 1.6rem 1.2rem; }
  .pin-digit { width: 42px; height: 50px; font-size: 1.4rem; }
  .carte-body { flex-direction: column; align-items: flex-start; }
}
</style>
</head>
<body>
<div class="confetti-wrap" id="confetti"></div>

<!-- APERÇU OVERLAY -->
<div class="preview-overlay" id="preview-overlay">
  <div class="preview-inner">
    <div class="preview-header">
      <span>Aperçu — Message Confidente</span>
      <button class="preview-close" id="btn-close-preview" type="button">✕</button>
    </div>
    <div class="preview-body">
      <div class="preview-warning">Voici exactement ce que verra le destinataire. Vérifiez avant de sceller.</div>
      <div class="reveal-center">
        <div id="prev-media-block" style="display:none;margin:0 0 1.2rem;"></div>
        <span class="jewel-icon">◆</span>
        <div id="prev-occ-wrap" style="display:none"><div class="occasion-badge" id="prev-occasion"></div></div>
        <p class="recipient-name" id="prev-name"></p>
        <div class="diamond-sep"><span></span></div>
        <div class="spinner-wrap" id="prev-loading"><div class="spinner"></div><div class="spinner-text">Préparation de l'aperçu…</div></div>
        <div class="etym-block" id="prev-etym" style="display:none"><div class="etym-label">Essence du prénom</div><p id="prev-etym-text"></p></div>
        <div class="msg-block" id="prev-msg-block" style="display:none"><p id="prev-message"></p></div>
        <div class="motiv-block" id="prev-motiv-block" style="display:none"><p id="prev-motiv-text"></p></div>
        
        <p class="from-line" id="prev-from"></p>
        <div class="diamond-sep"><span></span></div>
        <div class="alnae-footer">ALNAÉ Infinity — Collection Confidente<br><a href="https://www.alnaeinfinity.com" target="_blank" rel="noopener">www.alnaeinfinity.com</a></div>
      </div>
      <button class="btn btn-gold" id="btn-confirm-seal" type="button" style="margin-top:1.3rem;">Confirmer et sceller</button>
      <button class="btn" id="btn-back-edit" type="button" style="margin-top:.5rem;">← Modifier</button>
    </div>
  </div>
</div>

<header>
  <div class="brand-eyebrow">ALNAÉ Infinity</div>
  <h1 class="collection-title" style="cursor:pointer;" id="title-home">Confidente</h1>
  <p class="tagline">Le bijou qui porte votre voix</p>
</header>

<div class="container">
  <div class="nav-tabs">
    <div class="nav-tab" id="tab-deposer">Déposer un message</div>
    <div class="nav-tab" id="tab-decouvrir">Découvrir mon message</div>
  </div>

  <!-- ACCUEIL -->
  <div class="page active" id="page-accueil">
    <div class="card" style="text-align:center;padding:3rem 2rem;">
      <div style="font-size:2rem;color:var(--gold);margin-bottom:1.2rem;font-family:'Playfair Display',serif;">◆</div>
      <h2 class="card-title" style="text-align:center;margin-bottom:.6rem;">Bienvenue</h2>
      <p style="font-size:.75rem;color:var(--text-mid);line-height:1.8;margin-bottom:2.5rem;letter-spacing:.03em;">Vous venez d'acquérir un bijou de la collection Confidente.<br>Que souhaitez-vous faire ?</p>
      <button class="btn btn-primary" id="btn-accueil-deposer" type="button" style="margin-top:0;">Déposer un message</button>
      <p style="font-size:.6rem;color:var(--text-dim);margin:.6rem 0;letter-spacing:.12em;text-transform:uppercase;">Vous avez commandé ce bijou pour l'offrir</p>
      <button class="btn" id="btn-accueil-decouvrir" type="button" style="margin-top:0;">Découvrir mon message</button>
      <p style="font-size:.6rem;color:var(--text-dim);margin:.6rem 0;letter-spacing:.12em;text-transform:uppercase;">Ce bijou vous a été offert et vous disposez d'un code</p>
    </div>
  </div>

  <!-- AUTH -->
  <div class="page" id="page-auth">
    <div class="steps"><div class="step-dot active"></div><div class="step-dot"></div><div class="step-dot"></div><div class="step-dot"></div></div>
    <div class="card">
      <h2 class="card-title">Vérification de commande</h2>
      <p class="card-subtitle">Étape 1 sur 4 — Identification sécurisée</p>
      <div class="info-row"><span>◈</span><span>Vos informations sont vérifiées de façon sécurisée avant l'accès au formulaire.</span></div>
      <div class="alert-box alert-error" id="auth-error"></div>
      <div class="field">
        <label>Numéro de commande <span class="req">*</span></label>
        <input type="text" id="order-number" placeholder="ex. CMD-2024-00142" autocomplete="off">
        <div class="field-error" id="err-order">Champ obligatoire</div>
      </div>
      <div class="field">
        <label>Prénom <span class="req">*</span></label>
        <input type="text" id="auth-firstname" placeholder="Prénom utilisé lors de la commande" autocomplete="given-name">
        <div class="field-error" id="err-firstname">Champ obligatoire</div>
      </div>
      <div class="field">
        <label>Nom <span class="req">*</span></label>
        <input type="text" id="auth-lastname" placeholder="Nom utilisé lors de la commande" autocomplete="family-name">
        <div class="field-error" id="err-lastname">Champ obligatoire</div>
      </div>
      <div class="field">
        <label>Adresse e-mail <span class="req">*</span></label>
        <input type="email" id="auth-email" placeholder="votre@email.fr" autocomplete="email">
        <div class="field-error" id="err-email">Email requis pour recevoir votre confirmation</div>
        <div class="small-muted">Votre confirmation avec QR code sera envoyée à cette adresse</div>
      </div>
      <div class="rgpd-box">
        <strong>Données personnelles</strong><br>
        Vos données sont utilisées pour vérifier votre commande et vous envoyer la confirmation. Elles ne sont pas revendues. Conformément au RGPD : <strong>contact.alnae@gmail.com</strong>
        <div class="rgpd-row"><input type="checkbox" id="rgpd-auth"><span id="lbl-rgpd-auth">J'accepte la politique de confidentialité d'ALNAÉ Infinity.</span></div>
        <div class="field-error" id="err-rgpd">Consentement requis.</div>
      </div>
      <button class="btn btn-primary" id="btn-verify" type="button">Vérifier ma commande →</button>
    </div>
  </div>

  <!-- PIN -->
  <div class="page" id="page-pin">
    <div class="steps"><div class="step-dot"></div><div class="step-dot active"></div><div class="step-dot"></div><div class="step-dot"></div></div>
    <div class="card">
      <h2 class="card-title">Code confidentiel</h2>
      <p class="card-subtitle">Étape 2 sur 4 — Sécurisation du message</p>
      <div class="info-row tip"><span>◈</span><span>Choisissez un code à 4 chiffres. Il sera demandé au destinataire pour révéler votre message. La surprise est préservée.</span></div>
      <div class="field">
        <label>Créez votre code <span class="req">*</span></label>
        <div class="pin-wrap">
          <input type="tel" class="pin-digit" id="pin1" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="pin2" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="pin3" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="pin4" maxlength="1" inputmode="numeric">
        </div>
        <div class="pin-hint">4 chiffres — mémorable pour vous, confidentiel pour les autres</div>
        <div class="field-error" id="err-pin">4 chiffres requis</div>
      </div>
      <div class="field" style="margin-top:1.2rem;">
        <label>Confirmez votre code <span class="req">*</span></label>
        <div class="pin-wrap">
          <input type="tel" class="pin-digit" id="pin1b" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="pin2b" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="pin3b" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="pin4b" maxlength="1" inputmode="numeric">
        </div>
        <div class="field-error" id="err-pin-confirm">Les codes ne correspondent pas</div>
      </div>
      <button class="btn btn-primary" id="btn-pin-next" type="button">Continuer →</button>
    </div>
  </div>

  <!-- FORMULAIRE -->
  <div class="page" id="page-form">
    <div class="steps"><div class="step-dot"></div><div class="step-dot"></div><div class="step-dot active"></div><div class="step-dot"></div></div>
    <div class="card">
      <h2 class="card-title">Composition du message</h2>
      <p class="card-subtitle">Étape 3 sur 4 — Activez les modules souhaités</p>
      <div class="info-row"><span>◈</span><span>Commande vérifiée — <strong id="verified-name-display"></strong></span></div>
      <div class="info-row tip"><span>◈</span><span>Activez uniquement les modules souhaités. Seul le prénom du destinataire est obligatoire.</span></div>
    </div>

    <!-- Destinataire -->
    <div class="option-block on" style="border-color:var(--gold-dim);">
      <div class="option-header">
        <div class="option-left"><span class="option-icon">◈</span>
          <div><div class="option-title">Destinataire <span class="req">*</span></div><div class="option-desc">Prénom de la personne qui reçoit le bijou</div></div>
        </div>
      </div>
      <div class="option-body open">
        <div class="field" style="margin:0;">
          <input type="text" id="recipient-name-input" placeholder="ex. Sophie, Alexandre, Marie…">
          <div class="field-error" id="err-recipient">Obligatoire</div>
        </div>
      </div>
    </div>

    <!-- Occasion -->
    <div class="option-block" id="block-occasion">
      <div class="option-header">
        <div class="option-left"><span class="option-icon">◇</span>
          <div><div class="option-title">L'occasion</div><div class="option-desc">Anniversaire, diplôme, retraite… avec suggestions de texte</div></div>
        </div>
        <label class="toggle"><input type="checkbox" id="tog-occasion"><span class="slider"></span></label>
      </div>
      <div class="option-body" id="body-occasion">
        <div class="pill-group" id="occasion-pills">
          <div class="pill" data-occasion="Anniversaire">Anniversaire</div>
          <div class="pill" data-occasion="Amitié">Amitié</div>
          <div class="pill" data-occasion="Diplôme">Diplôme</div>
          <div class="pill" data-occasion="Fête des mères">Fête des mères</div>
          <div class="pill" data-occasion="Encouragement">Encouragement</div>
          <div class="pill" data-occasion="Souvenir">Souvenir</div>
          <div class="pill" data-occasion="Noël">Noël</div>
          <div class="pill" data-occasion="Autre">Autre</div>
        </div>
        <div class="field-error" id="err-occasion">Choisissez une occasion ou désactivez ce module</div>
        <div class="field" id="autre-field" style="display:none;">
          <label>Précisez l'occasion</label>
          <input type="text" id="autre-text" placeholder="ex. Mariage, Naissance, Retraite, Promotion…">
        </div>
        <div class="suggestions-box" id="suggestions-box" style="display:none;">
          <div class="sug-title">Suggestions — cochez celle(s) qui vous inspirent</div>
          <div id="suggestions-list"></div>
        </div>
      </div>
    </div>

    <!-- Message personnel -->
    <div class="option-block" id="block-message">
      <div class="option-header">
        <div class="option-left"><span class="option-icon">✦</span>
          <div><div class="option-title">Message personnel</div><div class="option-desc">Vos propres mots, librement</div></div>
        </div>
        <label class="toggle"><input type="checkbox" id="tog-message"><span class="slider"></span></label>
      </div>
      <div class="option-body" id="body-message">
        <div class="field" style="margin:0;">
          <textarea id="message-input" placeholder="Écrivez ici ce que vous souhaitez lui transmettre…" maxlength="600"></textarea>
          <div class="char-count"><span id="char-count">0</span> / 600</div>
          <div class="field-error" id="err-message">Le message est vide</div>
        </div>
      </div>
    </div>

    <!-- Étymologie -->
    <div class="option-block" id="block-etym">
      <div class="option-header">
        <div class="option-left"><span class="option-icon">◉</span>
          <div><div class="option-title">Essence du prénom <span class="badge-new">IA</span></div><div class="option-desc">Origine et signification du prénom, générée par intelligence artificielle</div></div>
        </div>
        <label class="toggle"><input type="checkbox" id="tog-etym"><span class="slider"></span></label>
      </div>
      <div class="option-body" id="body-etym">
        <p style="font-size:.72rem;color:var(--text-mid);line-height:1.7;">Générée à partir du prénom du destinataire. Visible dans l'aperçu avant de sceller.</p>
      </div>
    </div>

    <!-- Citation -->
    <div class="option-block" id="block-motiv">
      <div class="option-header">
        <div class="option-left"><span class="option-icon">◌</span>
          <div><div class="option-title">Citation ALNAÉ Infinity</div><div class="option-desc">Une pensée inspirante, signée ALNAÉ Infinity</div></div>
        </div>
        <label class="toggle"><input type="checkbox" id="tog-motiv"><span class="slider"></span></label>
      </div>
      <div class="option-body" id="body-motiv">
        <p style="font-size:.72rem;color:var(--text-mid);line-height:1.7;font-style:italic;">Une citation sera choisie parmi la sélection ALNAÉ. Elle se conclut par : « N'oublie pas qui tu es. »</p>
      </div>
    </div>

    <!-- Média -->
    <div class="option-block" id="block-media">
      <div class="option-header">
        <div class="option-left"><span class="option-icon">▣</span>
          <div><div class="option-title">Photo, vidéo ou audio</div><div class="option-desc">Ajoutez un contenu visuel ou vocal à votre message</div></div>
        </div>
        <label class="toggle"><input type="checkbox" id="tog-media"><span class="slider"></span></label>
      </div>
      <div class="option-body" id="body-media">
        <div class="media-upload-area" id="media-drop-zone">
          <input type="file" id="media-file-input" accept="image/*,video/*,audio/*" multiple>
          <span class="media-upload-icon">▣</span>
          <div class="media-upload-label">
            <strong>Cliquez ou déposez vos fichiers ici</strong>
            Photo, vidéo ou message audio
          </div>
          <div class="media-types">
            <span class="media-type-badge">Photo</span>
            <span class="media-type-badge">Vidéo</span>
            <span class="media-type-badge">Audio</span>
          </div>
        </div>
        <div class="media-error" id="media-error">Fichier trop volumineux (max 20 Mo) ou format non supporté.</div>
        <div class="media-limit-info">Maximum 3 fichiers · 20 Mo par fichier · JPG, PNG, GIF, MP4, MOV, MP3, WAV, M4A</div>
        <div class="media-previews" id="media-previews"></div>
      </div>
    </div>

    <!-- RGPD + bouton -->
    <div class="card" style="margin-top:.3rem;">
      <div class="alert-box alert-error" id="form-error">Activez au moins un module en plus du prénom.</div>
      <div class="rgpd-box" style="border-color:rgba(196,163,90,.2);">
        <strong>Option impression carte par ALNAÉ Infinity</strong><br>
        En cochant cette case, ALNAÉ Infinity imprimera et joindra la carte avec le QR code directement dans le colis du bijou. <strong style="color:#E0756B;">En cochant, vous autorisez ALNAÉ Infinity à accéder à votre message pour réaliser ce service.</strong>
        <div class="rgpd-row"><input type="checkbox" id="opt-impression"><span id="lbl-impression">J'autorise ALNAÉ Infinity à imprimer et joindre la carte confidentielle à mon bijou.</span></div>
      </div>
      <div class="rgpd-box" style="margin-top:.5rem;">
        <strong>Consentement au stockage du message</strong><br>
        Votre message sera associé au bijou et révélé uniquement après vérification du code confidentiel.
        <div class="rgpd-row"><input type="checkbox" id="rgpd-msg"><span id="lbl-rgpd-msg">Je consens au stockage sécurisé de mon message associé au bijou.</span></div>
        <div class="field-error" id="err-rgpd-msg">Consentement requis</div>
      </div>
      <button class="btn btn-gold" id="btn-preview-msg" type="button">Prévisualiser le message</button>
    </div>
  </div>

  <!-- SUCCÈS -->
  <div class="page" id="page-success">
    <div class="steps"><div class="step-dot"></div><div class="step-dot"></div><div class="step-dot"></div><div class="step-dot active"></div></div>
    <div class="card" style="text-align:center;">
      <div class="success-icon">✦</div>
      <h2 class="card-title" style="text-align:center;">Message scellé</h2>
      <div class="alert-box alert-success show" id="success-box">Votre confirmation a été préparée. Téléchargez-la ci-dessous — elle contient la carte à joindre au bijou.</div>
      <p style="font-size:.75rem;color:var(--text-mid);line-height:1.8;margin:1rem 0;">Votre message est lié à ce bijou et protégé par votre code confidentiel.</p>
      <div id="impression-notice" style="display:none;background:rgba(196,163,90,.06);border:1px solid rgba(196,163,90,.2);padding:.8rem 1rem;font-size:.72rem;color:var(--ivory);margin:.8rem 0;line-height:1.6;">
        <strong>Impression demandée</strong> — ALNAÉ Infinity préparera la carte à joindre au colis.
      </div>
      <div class="qr-section">
        <div class="qr-label">QR Code du bijou</div>
        <div id="qrcode-container"></div>
        <div class="qr-url" id="qr-url-display"></div>
      </div>
      <div class="carte-preview">
        <div class="carte-header">ALNAÉ Infinity — Carte à glisser dans le paquet</div>
        <div class="carte-body">
          <div class="carte-text">Scannez le QR code ou rendez-vous sur<br><strong style="color:var(--ivory);">www.alnaeinfinity.com/pages/confidente</strong><br>puis saisissez les informations demandées.</div>
          <div>
            <div style="font-size:.55rem;color:var(--text-dim);margin-bottom:.3rem;letter-spacing:.1em;text-transform:uppercase;">Code du bijou</div>
            <div class="carte-code-badge" id="carte-code-display">—</div>
          </div>
        </div>
        <div id="carte-qr-mini" style="text-align:right;margin-top:.5rem;"></div>
      </div>
      <button class="btn btn-gold" id="btn-dl-confirm" type="button">Télécharger la confirmation complète</button>
      <button class="btn btn-gold" id="btn-print-card" type="button" style="margin-top:.5rem;">🖨️ Imprimer la carte cadeau</button>
      <button class="btn" id="btn-go-reveal" type="button" style="margin-top:.5rem;">Aperçu du message final →</button>
    </div>
  </div>

  <!-- DÉCOUVRIR — CODE -->
  <div class="page" id="page-decouvrir">
    <div class="card">
      <h2 class="card-title">Découvrez votre message</h2>
      <p class="card-subtitle">Un message vous a été laissé</p>
      <div class="info-row tip"><span>◈</span><span>Scannez le QR code sur votre carte ou saisissez le code du bijou ci-dessous.</span></div>
      <div class="field">
        <label>Code du bijou <span class="req">*</span></label>
        <input type="text" id="discover-code" placeholder="ex. CONF-2024-001">
        <div class="field-error" id="err-discover">Code introuvable.</div>
      </div>
      <button class="btn btn-primary" id="btn-discover" type="button">Continuer →</button>
    </div>
  </div>

  <!-- DÉCOUVRIR — PIN -->
  <div class="page" id="page-pin-check">
    <div class="card">
      <h2 class="card-title">Code confidentiel</h2>
      <p class="card-subtitle">Saisissez le code lié à votre message</p>
      <div class="info-row tip"><span>◈</span><span>Entrez le code à 4 chiffres communiqué avec le cadeau.</span></div>
      <div class="alert-box alert-error" id="pin-check-error"></div>
      <div class="field">
        <label>Code confidentiel <span class="req">*</span></label>
        <div class="pin-wrap">
          <input type="tel" class="pin-digit" id="check1" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="check2" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="check3" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="check4" maxlength="1" inputmode="numeric">
        </div>
        <div class="field-error" id="err-pin-check">Code à 4 chiffres requis</div>
      </div>
      <button class="btn btn-primary" id="btn-pin-check" type="button">Révéler le message →</button>
    </div>
  </div>

  <!-- RÉVÉLATION -->
  <div class="page" id="page-reveal">
    <div class="card reveal-center">
      <div id="reveal-media-block" style="display:none;margin:0 0 1.5rem;width:100%;"></div>
      <span class="jewel-icon">◆</span>
      <div id="reveal-occ-wrap" style="display:none"><div class="occasion-badge" id="reveal-occasion"></div></div>
      <p class="recipient-name" id="reveal-name"></p>
      <div class="diamond-sep"><span></span></div>
      <div class="spinner-wrap" id="reveal-loading"><div class="spinner"></div><div class="spinner-text">Chargement…</div></div>
      
      <div class="etym-block" id="reveal-etym" style="display:none"><div class="etym-label">Essence du prénom</div><p id="reveal-etym-text"></p></div>
      <div class="msg-block" id="reveal-msg-block" style="display:none"><p id="reveal-message"></p></div>
      <div class="motiv-block" id="reveal-motiv-block" style="display:none"><p id="reveal-motiv-text"></p></div>
      <p class="from-line" id="reveal-from"></p>
      <div class="diamond-sep"><span></span></div>
      <div class="alnae-footer">ALNAÉ Infinity — Collection Confidente<br><a href="https://www.alnaeinfinity.com" target="_blank" rel="noopener">www.alnaeinfinity.com</a></div>
      <button class="btn btn-gold" id="btn-dl-msg" type="button" style="margin-top:1.3rem;">Télécharger mon message</button>
      <button class="btn" id="btn-share" type="button" style="margin-top:.5rem;">Partager ce moment</button>
    </div>
  </div>

</div>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js"></script>
<script>
(() => {
  'use strict';

  // ══════════════════════════════════════════════════════════════════
  //  CONFIGURATION — REMPLACE LES VALEURS CI-DESSOUS PAR LES TIENNES
  // ══════════════════════════════════════════════════════════════════
  const CONFIG = {
    // Supabase — récupère ces valeurs sur supabase.com > Settings > API
    supabaseUrl:    '',
    supabaseKey:    '',

    // EmailJS — récupère ces valeurs sur emailjs.com > Account
    emailjsPublicKey:   'COLLE_TA_EMAILJS_PUBLIC_KEY_ICI',
    emailjsServiceId:   'COLLE_TON_EMAILJS_SERVICE_ID_ICI',
    emailjsTemplateId:  'COLLE_TON_EMAILJS_TEMPLATE_ID_ICI',

    // Ton email ALNAÉ pour recevoir une copie de chaque confirmation
    alnaEmail: 'commande.alnae@gmail.com',

    // URL de la page Shopify
    storefrontPageUrl: 'https://alnae-confidente-1.onrender.com',

    // Mode démo : true = pas besoin de Supabase/EmailJS pour tester
    // Passe à false une fois tes clés configurées
    demoMode: false
  };
  // ══════════════════════════════════════════════════════════════════

  // ── SUPABASE INIT ─────────────────────────────────────────────────
  let db = null;
  function initSupabase() {
    if (CONFIG.supabaseUrl === 'COLLE_TON_SUPABASE_URL_ICI') return false;
    try {
      db = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);
      return true;
    } catch(e) { console.warn('Supabase non initialisé:', e); return false; }
  }

  // ── EMAILJS INIT ──────────────────────────────────────────────────
  function initEmailJS() {
    if (CONFIG.emailjsPublicKey === 'COLLE_TA_EMAILJS_PUBLIC_KEY_ICI') return false;
    try { emailjs.init({ publicKey: CONFIG.emailjsPublicKey }); return true; }
    catch(e) { console.warn('EmailJS non initialisé:', e); return false; }
  }

  const isSupabaseReady = () => db !== null;
  const isEmailJSReady = () => CONFIG.emailjsPublicKey !== 'COLLE_TA_EMAILJS_PUBLIC_KEY_ICI';

  // ── DONNÉES DÉMO ──────────────────────────────────────────────────

  // ── GENRES ────────────────────────────────────────────────────────
  const PRENOMS_M = new Set([
    'aaron','adam','adrien','alexandre','alexis','alban','albert','ali','allan',
    'arnaud','arthur','aurelien','axel','ayoub','baptiste','benjamin','benoit',
    'bernard','boris','brice','bruno','cedric','charles','christophe','clement',
    'corentin','cyril','damien','daniel','david','denis','dorian','dylan',
    'edouard','emmanuel','eric','ethan','etienne','evan','felix','florian',
    'francois','frederic','gabriel','gabin','gautier','geoffrey','gerard',
    'gilles','guillaume','gustave','guy','henri','hugo','isaac','ivan','jack',
    'jean','jeremy','jerome','julien','kevin','kylian','laurent','leon',
    'leonard','liam','lionel','luca','lucas','ludovic','leo','loic','louis',
    'luka','mael','malo','marc','martin','mathieu','mathis','maxime','maxence',
    'mehdi','michael','michel','milan','morgan','nael','nathan','nicolas',
    'noah','noel','nolan','octave','olivier','oscar','paul','philippe','pierre',
    'rafael','raphael','regis','remi','renaud','rene','robin','romain','ruben',
    'samuel','sasha','sebastien','serge','simon','stanislas','stephane',
    'sylvain','tanguy','theo','thibault','thierry','thomas','timothee','tom',
    'tristan','ugo','valentin','victor','vincent','william','xavier','yann',
    'yannick','yves','zacharie','zinedine'
  ]);

  function detectGenre(prenom) {
    if (!prenom) return 'F';
    const p = prenom.trim().toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').split(/[\\s-]/)[0];
    if (PRENOMS_M.has(p)) return 'M';
    const l3=p.slice(-3),l2=p.slice(-2),l1=p.slice(-1);
    if (['ine','ene','ale','lle','tte','ise','ose','ane'].includes(l3)) return 'F';
    if (['ia','ea','na','la','ra','sa'].includes(l2)) return 'F';
    if (l1==='a' && p.length>3) return 'F';
    if (['el','en','on','an','in','us'].includes(l2)) return 'M';
    if (l1==='o' && p.length>3) return 'M';
    return 'F';
  }

  const CITATIONS = {
    F: [
      "Tu es plus forte que tu ne le crois, plus belle que tu ne le vois, et plus aimee que tu ne le sais.\\n\\nN'oublie pas qui tu es.",
      "Porter ce bijou, c'est porter un morceau de l'ame de quelqu'un qui croit en toi.\\n\\nN'oublie pas qui tu es.",
      "Elle croyait qu'elle pouvait, alors elle l'a fait.\\n\\nN'oublie pas qui tu es.",
      "Chaque jour est une nouvelle page. Ecris quelque chose qui vaut la peine d'etre lu.\\n\\nN'oublie pas qui tu es."
    ],
    M: [
      "Tu es plus fort que tu ne le crois, plus grand que tu ne le vois, et plus aime que tu ne le sais.\\n\\nN'oublie pas qui tu es.",
      "Porter ce bijou, c'est porter un morceau de l'ame de quelqu'un qui croit en toi.\\n\\nN'oublie pas qui tu es.",
      "Il croyait qu'il pouvait, alors il l'a fait.\\n\\nN'oublie pas qui tu es.",
      "Chaque jour est une nouvelle page. Ecris quelque chose qui vaut la peine d'etre lu.\\n\\nN'oublie pas qui tu es."
    ]
  };

  // ── CITATION IA SELON OCCASION + GENRE ────────────────────────────
  async function getMotivationIA(prenom, occasion, personalMessage) {
    const genre = detectGenre(prenom);
    const genreLabel = genre === 'M' ? 'masculin' : 'feminin';
    const key = prenom + '|' + (occasion||'') + '|' + genreLabel;
    if (state.cachedEtym && state.cachedEtym['motiv_'+key]) return state.cachedEtym['motiv_'+key];
    try {
      const context = occasion
        ? 'occasion: ' + occasion
        : (personalMessage ? 'message: ' + personalMessage.substring(0,100) : 'bijou offert en cadeau');
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          model:'claude-sonnet-4-20250514', max_tokens:120,
          system:'Tu es ALNAE Infinity, marque de bijoux haut de gamme. Ecris une citation inspirante de 1-2 phrases maximum, accordee au genre ('+genreLabel+'), en lien avec le contexte donne. Termine TOUJOURS par "N oublie pas qui tu es." Pas de guillemets, pas de markdown.',
          messages:[{role:'user', content:'Citation pour un bijou Confidente. Contexte: '+context+'. Prenom du destinataire: '+prenom+'. Genre: '+genreLabel}]
        })
      });
      const d = await r.json();
      const t = d.content?.[0]?.text?.trim();
      if (t) {
        if (!state.cachedEtym) state.cachedEtym = {};
        state.cachedEtym['motiv_'+key] = t;
        return t;
      }
    } catch(_) {}
    // Fallback si IA indisponible
    const list = CITATIONS[genre] || CITATIONS.F;
    return list[Math.floor(Math.random()*list.length)];
  }

  function getMotivation(prenom) {
    const list = CITATIONS[detectGenre(prenom)] || CITATIONS.F;
    return list[Math.floor(Math.random()*list.length)];
  }

  // Citation IA contextuelle — tient compte de l'occasion et du message
  async function fetchContextualMotivation(prenom, occasion, personalMessage) {
    const genre = detectGenre(prenom);
    const gLabel = genre === 'M' ? 'masculin' : 'feminin';
    const ctx = occasion ? 'Occasion: ' + occasion + '.' : '';
    const msgCtx = personalMessage ? 'Contexte du message: "' + personalMessage.slice(0,120) + '"' : '';
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514', max_tokens: 120,
          system: 'Tu es la voix poetique d ALNAE Infinity, marque de bijoux haut de gamme. Ecris UNE citation courte (2-3 phrases max) en lien avec l occasion et le bijou offert. Accorde au genre indique. Termine TOUJOURS par: N oublie pas qui tu es. Pas de guillemets, pas de markdown.',
          messages: [{ role: 'user', content: 'Prenom: ' + prenom + '. Genre: ' + gLabel + '. ' + ctx + ' ' + msgCtx + '. Ecris la citation inspirante.' }]
        })
      });
      const d = await r.json();
      const t = d.content?.[0]?.text;
      if (t) return t.replace(/\\*([^*]+)\\*/g,'$1').trim();
    } catch(_) {}
    return getMotivation(prenom);
  }

  // Suggestions IA aléatoires selon l'occasion
  async function fetchAISuggestions(occasion, prenom) {
    const genre = detectGenre(prenom||'');
    const gLabel = genre === 'M' ? 'masculin' : 'feminin';
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514', max_tokens: 400,
          system: 'Tu génères 3 textes courts (2-3 phrases chacun) pour accompagner un bijou offert. Chaque texte doit etre different, poetique, sincere. Genre: ' + gLabel + '. Reponds UNIQUEMENT en JSON valide: {"suggestions":["texte1","texte2","texte3"]}',
          messages: [{ role: 'user', content: 'Occasion: ' + occasion + '. Génère 3 messages de bijou differents.' }]
        })
      });
      const d = await r.json();
      const t = d.content?.[0]?.text;
      if (t) {
        const clean = t.replace(/\\u0060{3}json|\\u0060{3}/g,'').trim();
        const parsed = JSON.parse(clean);
        if (parsed.suggestions && parsed.suggestions.length >= 3) return parsed.suggestions;
      }
    } catch(_) {}
    return null;
  }

  // Citation IA contextuelle selon occasion + message + bijou
  async function fetchMotivationIA(prenom, occasion, personalMessage) {
    const genre = detectGenre(prenom);
    const contexte = [
      occasion ? 'Occasion: ' + occasion : '',
      personalMessage ? 'Ton du message: ' + personalMessage.substring(0, 100) : ''
    ].filter(Boolean).join('. ');
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514', max_tokens: 120,
          system: 'Tu es ALNAÉ Infinity, marque de bijoux premium. Génère UNE SEULE citation inspirante courte (max 2 phrases) pour accompagner un bijou offert. La citation doit être en lien avec le contexte fourni, accordée au genre (' + (genre==='M'?'masculin':'féminin') + '), poétique et se terminer par "N\\'oublie pas qui tu es." Pas de guillemets, pas de tirets.',
          messages:[{role:'user', content: 'Bijou offert pour: ' + prenom + '. ' + (contexte||'Occasion spéciale.')}]
        })
      });
      const d = await r.json();
      const t = d.content?.[0]?.text;
      if (t) return t.replace(/\\*([^*]+)\\*/g,'$1').trim();
    } catch(_) {}
    return getMotivation(prenom);
  }

  // ── SUGGESTIONS & CITATIONS PAR IA ──────────────────────────────
  // Cache pour ne pas rappeler l'IA deux fois pour le même thème
  const suggestionsCache = {};
  const citationsCache   = {};

  async function fetchSuggestionsIA(occasion, recipientName) {
    const key = (occasion + '|' + (recipientName||'')).toLowerCase();
    if (suggestionsCache[key]) return suggestionsCache[key];
    try {
      const genre = detectGenre(recipientName || '');
      const genreLabel = genre === 'M' ? 'masculin' : 'feminin';
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          system: "Tu es expert en messages pour bijoux haut de gamme. Reponds UNIQUEMENT avec un JSON valide. Format: {\\"suggestions\\":[\\"msg1\\",\\"msg2\\",\\"msg3\\"]}. 3 messages: 2-3 phrases max, poetiques, accordees au genre. Tutoiement. Pas de markdown.",
          messages: [{ role: 'user', content: 'Occasion: ' + occasion + '. Prenom destinataire: ' + (recipientName||'le destinataire') + ' (genre: ' + genreLabel + '). Genere 3 messages differents et inspirants pour accompagner un bijou offert pour cette occasion.' }]
        })
      });
      const d = await r.json();
      const t = d.content?.[0]?.text || '{}';
      const parsed = JSON.parse(t.replace(/\\u0060{3}json|\\u0060{3}/g,'').trim());
      if (parsed.suggestions && parsed.suggestions.length) {
        suggestionsCache[key] = parsed.suggestions;
        return parsed.suggestions;
      }
    } catch(_) {}
    // Fallback statique si IA indisponible
    return [
      "Ce bijou porte avec lui toute la gratitude que j'ai pour toi. Tu mérites ce qu'il y a de plus beau.",
      "Chaque fois que tu le porteras, souviens-toi que quelqu'un pense à toi avec beaucoup d'amour.",
      "Ce moment entre nous méritait quelque chose de précieux. Comme tu l'es pour moi."
    ];
  }

  async function fetchCitationIA(occasion, recipientName, personalMessage) {
    const key = (occasion + '|' + (recipientName||'') + '|' + (personalMessage||'').slice(0,30)).toLowerCase();
    if (citationsCache[key]) return citationsCache[key];
    try {
      const genre = detectGenre(recipientName || '');
      const genreLabel = genre === 'M' ? 'masculin' : 'feminin';
      const context = personalMessage
        ? 'Message personnel: "' + personalMessage.slice(0,200) + '"'
        : 'Occasion: ' + occasion;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 200,
          system: "Tu es ALNAE Infinity, marque de bijoux haut de gamme. Reponds avec un JSON. Format: {\\"citation\\":\\"...\\"} Une phrase poetique inspirante accordee au genre, en lien avec le bijou offert. Termine par: N\\'oublie pas qui tu es. Pas de markdown.",          messages: [{ role: 'user', content: context + '. Prenom: ' + (recipientName||'le destinataire') + ' (genre: ' + genreLabel + '). Bijou: collection Confidente ALNAE Infinity.' }]
        })
      });
      const d = await r.json();
      const t = d.content?.[0]?.text || '{}';
      const parsed = JSON.parse(t.replace(/\\u0060{3}json|\\u0060{3}/g,'').trim());
      if (parsed.citation) {
        citationsCache[key] = parsed.citation;
        return parsed.citation;
      }
    } catch(_) {}
    return getMotivation(recipientName || '');
  }

  async function renderSuggestions(occasion, recipientName) {
    const box  = g('suggestions-box');
    const list = g('suggestions-list');
    if (!box || !list) return;

    // Afficher spinner pendant le chargement IA
    box.style.display = 'block';
    list.innerHTML = '<div style="font-size:.7rem;color:var(--text-dim);padding:.5rem;text-align:center;">Génération des suggestions...</div>';

    const items = await fetchSuggestionsIA(occasion, recipientName);
    list.innerHTML = '';
    items.forEach(txt => {
      const row = document.createElement('div');
      row.className = 'sug-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.dataset.text = txt;
      const sp = document.createElement('span');
      sp.textContent = txt;
      row.appendChild(cb); row.appendChild(sp);
      cb.addEventListener('change', applySuggestions);
      sp.addEventListener('click', () => { cb.checked = !cb.checked; applySuggestions(); });
      list.appendChild(row);
    });
  }

  function applySuggestions() {
    const sel = Array.from(document.querySelectorAll('#suggestions-list input:checked')).map(cb => cb.dataset.text);
    if (!sel.length) return;
    const ta = g('message-input');
    ta.value = sel.join('\\n\\n');
    setText('char-count', String(ta.value.length));
    if (!toggleOn('tog-message')) {
      g('tog-message').checked = true;
      g('body-message').classList.add('open');
      g('block-message').classList.add('on');
    }
  }

  function getMotivation(prenom) {
    const list = CITATIONS[detectGenre(prenom)] || CITATIONS.F;
    return list[Math.floor(Math.random() * list.length)];
  }

  const SUGGESTIONS = {
    'Anniversaire': [
      "En ce jour si particulier, je voulais que tu saches a quel point tu comptes dans ma vie. Chaque annee te rend encore plus toi. Joyeux anniversaire.",
      "Tu merites ce bijou, comme tu merites tout ce que la vie a de plus beau. Avec tout mon amour.",
      "Le temps passe, mais ce qui ne change pas c'est la place que tu as dans mon coeur."
    ],
    'Amitié': [
      "Certaines personnes entrent dans ta vie et tu realises que tu ne peux plus imaginer sans elles. Tu es de celles-la.",
      "On dit que les vrais amis sont rares. Je suis si heureux/heureuse de t'avoir trouve(e).",
      "Ce bijou est un morceau de notre amitie. Porte-le quand tu as besoin de te sentir moins seul(e)."
    ],
    'Diplôme': [
      "Tu as travaille, tu as persevere, tu y es arrive(e). Ce diplome represente tout ce que tu peux accomplir.",
      "Felicitations. Que cette reussite soit le debut de tout ce que tu as reve de construire.",
      "Je t'ai regarde(e) avancer, douter parfois, mais jamais abandonner. Je suis fier/fiere de toi."
    ],
    'Fête des mères': [
      "Aucun bijou ne pourra exprimer tout ce que tu representes. J'espere qu'il te rappellera a quel point tu es aimee.",
      "Tu m'as appris a me lever quand je tombe, a aimer sans condition. Merci d'etre la mere/le parent que tu es.",
      "Pour celle/celui qui a tout donne sans jamais rien demander. Ce bijou est fait pour toi."
    ],
    'Encouragement': [
      "Je sais que ce n'est pas facile. Mais je connais ta force. Tu vas y arriver.",
      "Tu es capable, tu es fort(e), tu es exactement ou tu dois etre.",
      "Porte ce bijou comme un rappel que tu n'es jamais seul(e). Quelqu'un croit en toi."
    ],
    'Souvenir': [
      "Ce moment entre nous, je ne veux pas l'oublier. Voici quelque chose qui t'y ramenera.",
      "Les mots ne suffisent pas. Ce bijou porte notre souvenir.",
      "La ou les photos s'effacent et les mots se perdent, ce bijou restera."
    ],
    'Noël': [
      "En cette periode de lumieres, j'avais envie de t'offrir quelque chose qui te ressemble. Joyeux Noel.",
      "Noel, c'est le moment que je prefere pour dire les choses qu'on n'ose pas dire. Tu comptes enormement.",
      "Ce bijou est mon cadeau mais surtout un morceau de moi que je t'offre."
    ]
  };

  // ── ÉTAT ──────────────────────────────────────────────────────────
  const state = {
    verification: null, preview: null,
    messageRecord: null, currentOccasion: '',
    revealLookupCode: '', revealRecord: null, cachedEtym: {}
  };

  const mediaFiles = [];
  const MAX_FILES = 3, MAX_SIZE = 20*1024*1024;
  const ALLOWED_TYPES = ['image/jpeg','image/png','image/gif','image/webp',
    'video/mp4','video/quicktime','video/webm',
    'audio/mpeg','audio/wav','audio/mp4','audio/x-m4a','audio/ogg'];

  const g = id => document.getElementById(id);
  const norm = s => (s||'').trim().toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');
  const toggleOn = id => !!g(id)?.checked;

  function showPage(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    g(id)?.classList.add('active');
    window.scrollTo({top:0,behavior:'smooth'});
  }
  function setText(id,v){const e=g(id);if(e)e.textContent=v??'';}
  function setHtml(id,v){const e=g(id);if(e)e.innerHTML=v??'';}
  function setErr(id,show,text=''){const e=g(id);if(!e)return;if(text)e.textContent=text;e.classList.toggle('show',!!show);}
  function setInpErr(id,show){const e=g(id);if(e)e.classList.toggle('err',!!show);}
  function getPinValue(ids){return ids.map(id=>g(id)?.value||'').join('');}
  function bindToggle(lId,iId){g(lId)?.addEventListener('click',()=>{const cb=g(iId);if(cb)cb.checked=!cb.checked;});}

  function initPinNav(ids) {
    ids.forEach((id,i)=>{
      const el=g(id);if(!el)return;
      el.addEventListener('input',function(){this.value=this.value.replace(/[^0-9]/g,'');if(this.value&&i<ids.length-1)g(ids[i+1])?.focus();});
      el.addEventListener('keydown',function(e){if(e.key==='Backspace'&&!this.value&&i>0)g(ids[i-1])?.focus();});
    });
  }

  // ── SUPABASE : VÉRIFIER COMMANDE ──────────────────────────────────
  async function checkOrderInSupabase(orderNumber, firstName, lastName, email) {
    if (!isSupabaseReady()) return null;
    try {
      const { data, error } = await db
        .from('orders')
        .select('*')
        .eq('order_number', orderNumber.toUpperCase())
        .single();
      if (error || !data) return null;
      if (norm(firstName) !== norm(data.customer_first_name)) return null;
      if (norm(lastName)  !== norm(data.customer_last_name))  return null;
      return data;
    } catch(e) { return null; }
  }

  // ── SUPABASE : SAUVEGARDER MESSAGE ────────────────────────────────
  async function saveMessageToSupabase(record) {
    if (!isSupabaseReady()) return false;
    try {
      const { error } = await db.from('messages').insert({
        jewel_code:       record.jewelCode,
        order_number:     record.orderLabel,
        recipient_name:   record.recipientName,
        occasion:         record.occasion || null,
        personal_message: record.personalMessage || null,
        etymology_text:   record.etymologyText || null,
        motivation_text:  record.motivationText || null,
        sender_name:      record.senderFullName,
        sender_email:     record.email,
        pin_hash:         record.pin,
        impression_requested: record.impressionRequested || false,
        created_at:       new Date().toISOString()
      });
      return !error;
    } catch(e) { return false; }
  }

  // ── SUPABASE : RÉCUPÉRER MESSAGE ──────────────────────────────────
  async function getMessageFromSupabase(jewelCode) {
    if (!isSupabaseReady()) return null;
    try {
      const { data, error } = await db
        .from('messages')
        .select('*')
        .eq('jewel_code', jewelCode.toUpperCase())
        .single();
      if (error || !data) return null;
      return {
        recipientName:   data.recipient_name,
        occasion:        data.occasion,
        etymologyText:   data.etymology_text,
        personalMessage: data.personal_message,
        motivationText:  data.motivation_text,
        senderLine:      '- De la part de ' + (data.sender_name||'ALNAE Infinity'),
        pin:             data.pin_hash
      };
    } catch(e) { return null; }
  }

  // ── EMAILJS : ENVOYER CONFIRMATION ───────────────────────────────
  async function sendConfirmationEmail(record) {
    if (!isEmailJSReady()) {
      console.log('[DEMO] Email non envoye - configurez EmailJS');
      return false;
    }
    try {
      const params = {
        to_email:       record.email,
        to_name:        record.senderFullName,
        order_number:   record.orderLabel,
        jewel_code:     record.jewelCode,
        recipient_name: record.recipientName,
        occasion:       record.occasion || 'Non specifie',
        reveal_url:     CONFIG.storefrontPageUrl + '?code=' + record.jewelCode,
        alnae_email:    CONFIG.alnaEmail,
        date:           record.date
      };
      // Envoi à la cliente
      await emailjs.send(CONFIG.emailjsServiceId, CONFIG.emailjsTemplateId, params);
      // Copie à ALNAÉ
      await emailjs.send(CONFIG.emailjsServiceId, CONFIG.emailjsTemplateId, {
        ...params, to_email: CONFIG.alnaEmail, to_name: 'ALNAE Infinity'
      });
      return true;
    } catch(e) { console.warn('EmailJS erreur:', e); return false; }
  }

  // ── ÉTYMOLOGIE IA ─────────────────────────────────────────────────
  async function fetchEtymIA(prenom) {
    const key = norm(prenom);
    if (state.cachedEtym[key]) return state.cachedEtym[key];
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514', max_tokens: 350,
          system: 'Expert etymologie prenoms. 3 paragraphes poetiques separes par ligne vide. 1:racine linguistique. 2:personnalite accordee au genre. 3:phrase finale forte accordee au genre. Tutoiement. Pas de markdown.',
          messages:[{role:'user',content:'Etymologie poetique du prenom '+prenom+' (genre: '+(detectGenre(prenom)==='M'?'masculin':'feminin')+')'}]
        })
      });
      const d = await r.json();
      const t = d.content?.[0]?.text;
      if (t) { const c=t.replace(/\\*([^*]+)\\*/g,'$1').trim(); state.cachedEtym[key]=c; return c; }
    } catch(_) {}
    const gk = detectGenre(prenom);
    const fb = gk==='M'
      ? 'Le prenom '+prenom+' porte en lui la force de tous ceux qui l ont porte avant toi.\\n\\nIl incarne une energie noble et singuliere, celle d un homme qui trace sa voie avec conviction.\\n\\nPorte-le avec fierte. Il te ressemble.'
      : 'Le prenom '+prenom+' porte en lui la grace de toutes celles qui l ont porte avant toi.\\n\\nIl incarne une energie singuliere, celle d une femme qui avance avec elegance et conviction.\\n\\nPorte-le avec fierte. Il te ressemble.';
    state.cachedEtym[key]=fb; return fb;
  }

  // ── QR CODE ───────────────────────────────────────────────────────
  function generateQR(containerId, url, size) {
    const el = g(containerId);
    if (!el || typeof QRCode==='undefined') return;
    el.innerHTML = '';
    new QRCode(el,{text:url,width:size||120,height:size||120,colorDark:'#1C1408',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.H});
  }

  // ── CONFETTI ──────────────────────────────────────────────────────
  function launchConfetti() {
    const c=g('confetti'); if(!c)return; c.innerHTML='';
    for(let i=0;i<30;i++){
      const p=document.createElement('div'); p.className='cp';
      p.style.cssText='left:'+Math.random()*100+'vw;animation-duration:'+(Math.random()*2+1.5)+'s;animation-delay:'+(Math.random()*.8)+'s;width:'+(Math.random()*6+4)+'px;height:'+(Math.random()*6+4)+'px;background:'+(Math.random()>.5?'#8B6914':'#C8BAA0')+';border-radius:'+(Math.random()>.5?'50%':'0')+';';
      c.appendChild(p);
    }
    setTimeout(()=>{c.innerHTML='';},4000);
  }

  // ── SUGGESTIONS ───────────────────────────────────────────────────
  // Générer suggestions de texte via IA (aléatoires à chaque fois)
  async function fetchSuggestionsIA(occasion) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514', max_tokens: 600,
          system: 'Tu génères 3 suggestions de messages courts et sincères pour accompagner un bijou offert. Chaque suggestion fait 2-3 phrases max, style chaleureux et personnel. Réponds UNIQUEMENT avec un JSON valide: {"suggestions":["texte1","texte2","texte3"]}. Pas de markdown.',
          messages:[{role:'user', content:'Génère 3 suggestions variées et originales pour l\\'occasion: ' + occasion + '. Elles doivent être différentes des suggestions habituelles, vraiment personnelles et touchantes.'}]
        })
      });
      const d = await r.json();
      const t = d.content?.[0]?.text;
      if (t) {
        const clean = t.replace(/\\u0060{3}json|\\u0060{3}/g,'').trim();
        const parsed = JSON.parse(clean);
        if (parsed.suggestions && parsed.suggestions.length) return parsed.suggestions;
      }
    } catch(_) {}
    return null;
  }

  function renderSuggestionsFromList(items) {
    const box=g('suggestions-box'), list=g('suggestions-list');
    if(!box||!list||!items||!items.length){if(box)box.style.display='none';return;}
    list.innerHTML='';
    items.forEach(txt=>{
      const row=document.createElement('div'); row.className='sug-item';
      const cb=document.createElement('input'); cb.type='checkbox'; cb.dataset.text=txt;
      const sp=document.createElement('span'); sp.textContent=txt;
      row.appendChild(cb); row.appendChild(sp);
      cb.addEventListener('change',applySuggestions);
      sp.addEventListener('click',()=>{cb.checked=!cb.checked;applySuggestions();});
      list.appendChild(row);
    });
    box.style.display='block';
  }

  function renderSuggestions(occasion) {
    const box=g('suggestions-box'), list=g('suggestions-list');
    if(!box||!list) return;
    const prenom = g('recipient-name-input')?.value?.trim() || '';
    // Afficher les suggestions statiques immédiatement
    const fallback = SUGGESTIONS[occasion];
    if(fallback) renderSuggestionsFromList(fallback);
    else { box.style.display='none'; }
    // Puis charger des suggestions IA fraîches en arrière-plan
    if(occasion && occasion !== 'Autre') {
      list.innerHTML += '<div style="font-size:.62rem;color:var(--text-dim);padding:.4rem 0;font-style:italic;text-align:right;">✦ Génération de nouvelles suggestions…</div>';
      fetchAISuggestions(occasion, prenom).then(aiSugs => {
        if(aiSugs) renderSuggestionsFromList(aiSugs);
      });
    }
  }

  function applySuggestions() {
    const sel=Array.from(document.querySelectorAll('#suggestions-list input:checked')).map(cb=>cb.dataset.text);
    if(!sel.length)return;
    const ta=g('message-input'); ta.value=sel.join('\\n\\n');
    setText('char-count',String(ta.value.length));
    if(!toggleOn('tog-message')){g('tog-message').checked=true;g('body-message').classList.add('open');g('block-message').classList.add('on');}
  }

  // ── MÉDIAS ────────────────────────────────────────────────────────
  function getMediaIcon(type){return type.startsWith('image')?'Photo':type.startsWith('video')?'Video':'Audio';}
  function formatSize(b){return b<1024*1024?(b/1024).toFixed(1)+' Ko':(b/1024/1024).toFixed(1)+' Mo';}

  function renderMediaPreviews() {
    const cont=g('media-previews'); if(!cont)return;
    cont.innerHTML='';
    mediaFiles.forEach((file,idx)=>{
      const url=URL.createObjectURL(file);
      const item=document.createElement('div'); item.className='media-item';
      let inner=file.type.startsWith('image')?'<img src="'+(file._dataUrl||url)+'" class="media-item-preview" alt="'+file.name+'">'
        :'<span class="media-item-icon">'+getMediaIcon(file.type)+'</span>';
      item.innerHTML=inner+'<div class="media-item-info"><div class="media-item-name">'+file.name+'</div><div class="media-item-size">'+formatSize(file.size)+'</div>'+(file.type.startsWith('audio')?'<audio controls class="media-item-audio" src="'+url+'"></audio>':'')+'</div><button class="media-item-remove" data-idx="'+idx+'" type="button">X</button>';
      item.querySelector('.media-item-remove').addEventListener('click',function(){mediaFiles.splice(parseInt(this.dataset.idx),1);renderMediaPreviews();updateMediaDropZone();});
      cont.appendChild(item);
    });
  }

  function updateMediaDropZone(){
    const zone=g('media-drop-zone'),input=g('media-file-input');
    if(!zone||!input)return;
    const dis=mediaFiles.length>=MAX_FILES;
    zone.style.opacity=dis?'.5':'1'; zone.style.pointerEvents=dis?'none':'auto'; input.disabled=dis;
  }

  function handleMediaFiles(files){
    const errEl=g('media-error'); if(errEl)errEl.classList.remove('show');
    let hasErr=false;
    Array.from(files).forEach(file=>{
      if(mediaFiles.length>=MAX_FILES)return;
      if(file.size>MAX_SIZE||!ALLOWED_TYPES.includes(file.type)){hasErr=true;return;}
      if(!mediaFiles.find(f=>f.name===file.name&&f.size===file.size)){
        if(file.type.startsWith('image')){const r=new FileReader();r.onload=e=>{file._dataUrl=e.target.result;renderMediaPreviews();};r.readAsDataURL(file);}
        mediaFiles.push(file);
      }
    });
    if(hasErr&&errEl)errEl.classList.add('show');
    renderMediaPreviews(); updateMediaDropZone();
  }

  function renderMediaInPreview(){
    const block=g('prev-media-block'); if(!block)return;
    if(!mediaFiles.length){block.style.display='none';return;}
    block.style.display='block';
    block.innerHTML='<div style="font-size:.58rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gold-dim);margin-bottom:.6rem;">Medias joints</div>';
    mediaFiles.forEach(f=>{
      const url=URL.createObjectURL(f);
      if(f.type.startsWith('image')){const img=document.createElement('img');img.src=f._dataUrl||url;img.style.cssText='max-width:100%;max-height:200px;object-fit:contain;border:1px solid var(--obsidian-border);display:block;margin:.4rem 0;';block.appendChild(img);}
      else{const d=document.createElement('div');d.style.cssText='padding:.5rem;background:var(--obsidian-soft);border:1px solid var(--obsidian-border);margin:.3rem 0;font-size:.7rem;';d.textContent=getMediaIcon(f.type)+': '+f.name;if(f.type.startsWith('audio')){const au=document.createElement('audio');au.src=url;au.controls=true;au.style.cssText='width:100%;margin-top:.3rem;opacity:.8;';d.appendChild(au);}block.appendChild(d);}
    });
  }

  function renderMediaInReveal(files){
    const block=g('reveal-media-block');
    if(!block||!files||!files.length){if(block)block.style.display='none';return;}
    block.style.display='block';
    block.innerHTML='';
    files.forEach(f=>{
      const url=f._dataUrl||(f instanceof File?URL.createObjectURL(f):null);
      if(!url)return;
      const wrap=document.createElement('div');
      wrap.style.cssText='width:100%;margin-bottom:1rem;text-align:center;';
      if(f.type.startsWith('image')){
        const img=document.createElement('img');
        img.src=url;
        img.style.cssText='max-width:100%;max-height:320px;object-fit:contain;display:block;margin:0 auto;border:1px solid var(--obsidian-border);';
        wrap.appendChild(img);
      } else if(f.type.startsWith('video')){
        const vid=document.createElement('video');
        vid.src=url; vid.controls=true;
        vid.style.cssText='max-width:100%;max-height:280px;display:block;margin:0 auto;border:1px solid var(--obsidian-border);';
        wrap.appendChild(vid);
      } else if(f.type.startsWith('audio')){
        const lbl=document.createElement('div');
        lbl.style.cssText='font-size:.6rem;letter-spacing:.15em;text-transform:uppercase;color:var(--gold-dim);margin-bottom:.5rem;';
        lbl.textContent='Message vocal';
        wrap.appendChild(lbl);
        const au=document.createElement('audio');
        au.src=url; au.controls=true;
        au.style.cssText='width:100%;opacity:.85;';
        wrap.appendChild(au);
      }
      block.appendChild(wrap);
    });
    // Séparateur après les médias
    const sep=document.createElement('div');
    sep.className='diamond-sep'; sep.innerHTML='<span></span>';
    block.appendChild(sep);
  }

  // ── HTML TÉLÉCHARGEABLE ───────────────────────────────────────────
  function buildConfirmationHTML(d) {
    const esc=s=>(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const site='<div style="margin-top:5px"><a href="https://www.alnaeinfinity.com" style="color:#8B6914;text-decoration:none;font-size:11px">www.alnaeinfinity.com</a></div>';
    const eHtml=d.etymologyText?'<div style="background:#F0EBE0;border-left:2px solid #8B6914;padding:12px 16px;margin:12px 0"><p style="font-family:Georgia,serif;font-style:italic;color:#1C1408;font-size:14px;line-height:1.7;white-space:pre-wrap;margin:0">'+esc(d.etymologyText)+'</p></div>':'';
    const mHtml=d.personalMessage?'<div style="background:#F8F4EE;border:1px solid #C8BAA0;padding:18px;margin:10px 0;white-space:pre-wrap;font-style:italic;font-size:15px;line-height:1.8;font-family:Georgia,serif">'+esc(d.personalMessage)+'</div>':'';
    const motHtml=d.motivationText?'<div style="background:#1C1408;padding:12px 18px;margin:10px 0;text-align:center"><p style="font-family:Georgia,serif;font-style:italic;color:#F0EBE0;font-size:14px;line-height:1.7;margin:0;white-space:pre-wrap">'+esc(d.motivationText)+'</p></div>':'';
    const mediaHtml=mediaFiles.length?'<div style="margin:14px 0"><div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8B6914;margin-bottom:8px">Medias joints</div>'+mediaFiles.map(f=>f.type.startsWith('image')&&f._dataUrl?'<div style="margin:6px 0;text-align:center"><img src="'+f._dataUrl+'" style="max-width:100%;max-height:260px;border:1px solid #C8BAA0;" alt="'+f.name+'"></div>':'<div style="padding:5px 0;border-bottom:1px solid #C8BAA0;font-size:12px;">'+getMediaIcon(f.type)+': '+f.name+'</div>').join('')+'</div>':'';
    const carteHtml=d.jewelCode?'<div style="border:1px solid #C8BAA0;padding:14px;margin:14px 0;background:white"><div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#8B6914;text-align:center;margin-bottom:8px">ALNAE Infinity - Carte cadeau</div><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><div style="flex:1;font-size:12px;color:#1C1408;line-height:1.6;min-width:150px">Rendez-vous sur <strong>www.alnaeinfinity.com/pages/confidente</strong> et saisissez le code ci-contre.</div><div style="text-align:center"><div style="font-size:9px;color:#8A7A60;margin-bottom:3px">Code du bijou</div><div style="background:#1C1408;color:#8B6914;padding:6px 12px;font-family:monospace;font-size:14px;letter-spacing:3px">'+esc(d.jewelCode)+'</div></div></div></div>':'';
    return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Confirmation ALNAE</title><style>body{font-family:Georgia,serif;background:#F2EDE3;padding:40px}.w{max-width:560px;margin:0 auto;background:#FDFAF5;border:1px solid #C8BAA0;padding:44px}.l{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8A7A60;font-family:Arial,sans-serif;margin-bottom:3px}.v{font-size:15px;margin-bottom:14px;color:#1C1408}.c{background:#1C1408;color:#8B6914;padding:14px;text-align:center;font-family:monospace;font-size:18px;letter-spacing:4px;margin:14px 0}.a{background:#F0EBE0;border:1px solid #C8BAA0;padding:12px;margin:14px 0;font-size:13px;line-height:1.6}.f{text-align:center;margin-top:28px;font-size:11px;color:#8A7A60;letter-spacing:2px;border-top:1px solid #C8BAA0;padding-top:14px}</style></head><body><div class="w"><div style="text-align:center;margin-bottom:28px"><div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#8B6914;margin-bottom:7px">ALNAE Infinity</div><h1 style="font-size:24px;font-weight:400;font-style:italic;font-family:Georgia,serif;color:#1C1408;margin:0">Confirmation - Collection Confidente</h1></div><div class="l">Date</div><div class="v">'+esc(d.date||'')+'</div><div class="l">Expediteur</div><div class="v">'+esc(d.senderFullName||'')+'</div><div class="l">Email</div><div class="v">'+esc(d.email||'')+'</div><div class="l">Commande</div><div class="v">'+esc(d.orderLabel||'')+'</div><div class="l">Destinataire</div><div class="v">'+esc(d.recipientName||'')+'</div>'+(d.occasion?'<div class="l">Occasion</div><div class="v">'+esc(d.occasion)+'</div>':'')+(d.impressionRequested?'<div class="a">Impression demandee - ALNAE Infinity preparera la carte.</div>':'')+'<div class="l">Code du bijou</div><div class="c">'+esc(d.jewelCode||'')+'</div><div class="a">Imprimez la carte ci-dessous et glissez-la dans le paquet. Le destinataire saisira le code du bijou puis son code confidentiel.</div>'+carteHtml+'<div class="l" style="margin-top:16px">Message</div>'+eHtml+mHtml+motHtml+mediaHtml+'<div class="f">ALNAE Infinity - Collection Confidente'+site+'commande.alnae@gmail.com</div></div></body></html>';
  }

  function buildRevealHTML(d) {
    const esc=s=>(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const site='<div style="margin-top:5px"><a href="https://www.alnaeinfinity.com" style="color:#8B6914;text-decoration:none;font-size:11px">www.alnaeinfinity.com</a></div>';
    const eHtml=d.etymologyText?'<div style="background:#F0EBE0;border-left:2px solid #8B6914;padding:12px 16px;margin:12px 0"><p style="font-family:Georgia,serif;font-style:italic;color:#1C1408;font-size:14px;line-height:1.7;white-space:pre-wrap;margin:0">'+esc(d.etymologyText)+'</p></div>':'';
    const mHtml=d.personalMessage?'<div style="background:#F8F4EE;border:1px solid #C8BAA0;padding:20px;text-align:left;white-space:pre-wrap;font-style:italic;font-size:15px;line-height:1.8;font-family:Georgia,serif">'+esc(d.personalMessage)+'</div>':'';
    const motHtml=d.motivationText?'<div style="background:#1C1408;padding:14px 20px;margin:10px 0;text-align:center"><p style="font-family:Georgia,serif;font-style:italic;color:#F0EBE0;font-size:14px;line-height:1.7;margin:0;white-space:pre-wrap">'+esc(d.motivationText)+'</p></div>':'';
    const occHtml=d.occasion?'<div style="display:inline-block;border:1px solid #8B6914;padding:3px 14px;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8B6914;margin-bottom:12px">'+esc(d.occasion)+'</div><br>':'';
    return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Mon message ALNAE</title><style>body{font-family:Georgia,serif;background:#F2EDE3;padding:40px}.w{max-width:540px;margin:0 auto;background:#FDFAF5;border:1px solid #C8BAA0;padding:44px;text-align:center}.n{font-size:30px;font-weight:400;font-style:italic;color:#1C1408;margin:0 0 8px;font-family:Georgia,serif}.s{color:#C8BAA0;letter-spacing:8px;margin:14px 0}.fr{font-size:12px;color:#8A7A60;font-style:italic;text-align:right;margin-top:10px}.f{margin-top:26px;font-size:10px;color:#8A7A60;letter-spacing:2px;text-transform:uppercase;border-top:1px solid #C8BAA0;padding-top:12px}</style></head><body><div class="w"><div style="font-size:10px;letter-spacing:4px;text-transform:uppercase;color:#8B6914;margin-bottom:10px">ALNAE Infinity</div>'+occHtml+'<p class="n">'+esc(d.recipientName||'')+'</p><div class="s">o o o</div>'+eHtml+'<div style="text-align:left">'+mHtml+motHtml+'</div><div class="fr">'+esc(d.senderLine||'- ALNAE Confidente')+'</div><div class="s">o</div><div class="f">ALNAE Infinity - Collection Confidente'+site+'</div></div></body></html>';
  }

  function downloadHTML(html,filename){const b=new Blob([html],{type:'text/html;charset=utf-8'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=filename;document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(u);}

  // ── VÉRIFICATION COMMANDE ─────────────────────────────────────────
  async function verifyOrder() {
    const orderNumber=g('order-number').value.trim();
    const firstName=g('auth-firstname').value.trim();
    const lastName=g('auth-lastname').value.trim();
    const email=g('auth-email').value.trim();
    const rgpd=g('rgpd-auth').checked;
    let ok=true;
    setErr('auth-error',false,'');
    setErr('err-order',!orderNumber);    setInpErr('order-number',!orderNumber);    if(!orderNumber)ok=false;
    setErr('err-firstname',!firstName);  setInpErr('auth-firstname',!firstName);    if(!firstName)ok=false;
    setErr('err-lastname',!lastName);    setInpErr('auth-lastname',!lastName);      if(!lastName)ok=false;
    const emailOk=email&&/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
    setErr('err-email',!emailOk);        setInpErr('auth-email',!emailOk);          if(!emailOk)ok=false;
    setErr('err-rgpd',!rgpd);            if(!rgpd)ok=false;
    if(!ok)return;
    const btn=g('btn-verify');
    btn.disabled=true; btn.textContent='VERIFICATION...';
    try {
      // 1. Essayer Supabase
      let order = await checkOrderInSupabase(orderNumber, firstName, lastName);
      if (order) {
        state.verification = {
          sessionToken:'SUPA_'+Date.now(), orderNumber:order.order_number,
          orderLabel:order.order_number, displayName:firstName+' '+lastName,
          email, customerFirstName:firstName, customerLastName:lastName,
          bijouCode:order.jewel_code
        };
      } else {
        // 2. Fallback mode démo
        const key=orderNumber.replace('#','').toUpperCase();
        const demoKey=Object.keys(DEMO_ORDERS).find(k=>k===key||k.endsWith('-'+key));
        const demoOrder=demoKey?DEMO_ORDERS[demoKey]:null;
        if(!demoOrder||norm(firstName)!==demoOrder.prenom||norm(lastName)!==demoOrder.nom) {
          throw new Error('Commande introuvable. Verifiez vos informations.');
        }
        await new Promise(r=>setTimeout(r,500));
        state.verification = {
          sessionToken:'DEMO_'+Date.now(), orderNumber:demoKey,
          orderLabel:demoKey, displayName:firstName+' '+lastName,
          email, customerFirstName:firstName, customerLastName:lastName,
          bijouCode:demoOrder.bijouCode
        };
      }
      setText('verified-name-display',state.verification.displayName+' - '+state.verification.orderLabel);
      showPage('page-pin');
    } catch(error) {
      const el=g('auth-error');
      if(el){el.textContent=error.message||'Informations incorrectes.';el.classList.add('show');}
    } finally {
      btn.disabled=false; btn.textContent='VERIFIER MA COMMANDE';
    }
  }

  // ── PIN ───────────────────────────────────────────────────────────
  function validatePinStep(){
    const pin=getPinValue(['pin1','pin2','pin3','pin4']);
    const pinb=getPinValue(['pin1b','pin2b','pin3b','pin4b']);
    if(pin.length!==4){setErr('err-pin',true);return;}
    setErr('err-pin',false);
    if(pin!==pinb){setErr('err-pin-confirm',true);return;}
    setErr('err-pin-confirm',false);
    state.verification.pin=pin;
    showPage('page-form');
  }

  // ── PRÉVISUALISATION ──────────────────────────────────────────────
  async function buildPreview(){
    const recipientName=g('recipient-name-input').value.trim();
    const rgpdMsg=g('rgpd-msg').checked;
    const hasOcc=toggleOn('tog-occasion'),hasMsg=toggleOn('tog-message');
    const hasEtym=toggleOn('tog-etym'),hasMotiv=toggleOn('tog-motiv');
    const message=g('message-input').value.trim();
    let ok=true;
    setErr('err-recipient',!recipientName);setInpErr('recipient-name-input',!recipientName);if(!recipientName)ok=false;
    setErr('err-rgpd-msg',!rgpdMsg);if(!rgpdMsg)ok=false;
    if(!hasOcc&&!hasMsg&&!hasEtym&&!hasMotiv){setErr('form-error',true);ok=false;}else{setErr('form-error',false);}
    if(hasOcc&&!state.currentOccasion){setErr('err-occasion',true);ok=false;}else{setErr('err-occasion',false);}
    if(hasMsg&&!message){setErr('err-message',true);setInpErr('message-input',true);ok=false;}else{setErr('err-message',false);setInpErr('message-input',false);}
    if(!ok)return;
    const occasion=hasOcc?(state.currentOccasion==='Autre'?(g('autre-text').value.trim()||'Autre'):state.currentOccasion):'';
    const btn=g('btn-preview-msg');
    btn.disabled=true; btn.textContent='PREPARATION...';
    g('prev-loading').classList.add('show');
    g('prev-etym').style.display='none';
    g('prev-msg-block').style.display='none';
    g('prev-motiv-block').style.display='none';
    g('preview-overlay').classList.add('show');
    setText('prev-name',recipientName);
    if(occasion){setText('prev-occasion',occasion);g('prev-occ-wrap').style.display='block';}
    else{g('prev-occ-wrap').style.display='none';}
    setText('prev-from','- De la part de '+state.verification.customerFirstName);
    renderMediaInPreview();
    try {
      let etymologyText=null,motivationText=null;
      if(hasEtym)etymologyText=await fetchEtymIA(recipientName);
      if(hasMotiv)motivationText=await fetchMotivationIA(recipientName, occasion, hasMsg?message:null);
      state.preview={
        previewToken:'PREV_'+Date.now(), recipientName, occasion,
        etymologyText, personalMessage:hasMsg?message:null,
        motivationText, senderLine:'- De la part de '+state.verification.customerFirstName
      };
      if(state.preview.etymologyText){setText('prev-etym-text',state.preview.etymologyText);g('prev-etym').style.display='block';}
      if(state.preview.personalMessage){setText('prev-message',state.preview.personalMessage);g('prev-msg-block').style.display='block';}
      if(state.preview.motivationText){setText('prev-motiv-text',state.preview.motivationText);g('prev-motiv-block').style.display='block';}
    } catch(error){
      g('preview-overlay').classList.remove('show');
      setErr('form-error',true,error.message||"Erreur lors de la preparation.");
    } finally {
      g('prev-loading').classList.remove('show');
      btn.disabled=false; btn.textContent='PREVISUALISER LE MESSAGE';
    }
  }

  function closePreview(){g('preview-overlay').classList.remove('show');}

  // ── SCELLEMENT ────────────────────────────────────────────────────
  async function sealMessage(){
    if(!state.preview||!state.verification?.sessionToken||!state.verification?.pin)return;
    const btn=g('btn-confirm-seal');
    btn.disabled=true; btn.textContent='SCELLEMENT...';
    try {
      await new Promise(r=>setTimeout(r,600));
      const qrUrl=CONFIG.storefrontPageUrl+'?code='+(state.verification.bijouCode||'CONF-DEMO');
      const record={
        jewelCode:state.verification.bijouCode||'CONF-DEMO',
        revealUrl:qrUrl,
        impressionRequested:g('opt-impression').checked,
        recipientName:state.preview.recipientName,
        occasion:state.preview.occasion,
        etymologyText:state.preview.etymologyText,
        personalMessage:state.preview.personalMessage,
        motivationText:state.preview.motivationText,
        senderLine:state.preview.senderLine,
        senderFullName:state.verification.displayName,
        email:state.verification.email,
        orderLabel:state.verification.orderLabel,
        pin:state.verification.pin,
        date:new Date().toLocaleDateString('fr-FR',{year:'numeric',month:'long',day:'numeric'})
      };
      // Sauvegarder dans Supabase si disponible
      if(isSupabaseReady()) await saveMessageToSupabase(record);

      // Envoyer les emails si EmailJS configuré
      const emailSent=await sendConfirmationEmail(record);

      state.messageRecord=record;
      setText('carte-code-display',record.jewelCode||'-');
      setText('qr-url-display',record.revealUrl||'');
      generateQR('qrcode-container',record.revealUrl,140);
      generateQR('carte-qr-mini',record.revealUrl,60);
      g('impression-notice').style.display=record.impressionRequested?'block':'none';

      // Afficher statut email
      const emailStatus=g('email-status');
      if(emailStatus){
        emailStatus.style.display='block';
        emailStatus.textContent=emailSent
          ? 'Email de confirmation envoye a '+record.email+' - Une copie a ete envoyee a ALNAE Infinity.'
          : 'Telechargez la confirmation ci-dessous et envoyez-la manuellement.';
        emailStatus.className='email-status '+(emailSent?'sent':'pending');
      }
      closePreview(); launchConfetti(); showPage('page-success');
    } catch(error){
      setErr('form-error',true,error.message||'Erreur lors du scellement.');
      closePreview();
    } finally {
      btn.disabled=false; btn.textContent='CONFIRMER ET SCELLER';
    }
  }

  // ── DÉCOUVRIR ─────────────────────────────────────────────────────
  async function discoverStep1(){
    const jewelCode=g('discover-code').value.trim();
    if(!jewelCode){setErr('err-discover',true);return;}
    setErr('err-discover',false);
    const btn=g('btn-discover');
    btn.disabled=true; btn.textContent='VERIFICATION...';
    try {
      await new Promise(r=>setTimeout(r,400));
      const cu=jewelCode.toUpperCase();
      // Vérifier dans Supabase d'abord
      let found=false;
      if(isSupabaseReady()){
        const msg=await getMessageFromSupabase(cu);
        if(msg){found=true;}
      }
      // Fallback : vérifier si c'est un code démo ou le code sauvegardé
      if(!found){
        const validDemo=Object.values(DEMO_ORDERS).some(o=>o.bijouCode===cu);
        const validSaved=state.messageRecord?.jewelCode===cu;
        if(!validDemo&&!validSaved&&!cu.startsWith('CONF-'))throw new Error('Code introuvable. Verifiez la carte jointe au bijou.');
      }
      state.revealLookupCode=cu;
      g('pin-check-error')?.classList.remove('show');
      showPage('page-pin-check');
    } catch(error){
      setErr('err-discover',true,error.message||'Code introuvable.');
    } finally {
      btn.disabled=false; btn.textContent='CONTINUER';
    }
  }

  async function discoverStep2(){
    const pin=getPinValue(['check1','check2','check3','check4']);
    if(pin.length!==4){setErr('err-pin-check',true);return;}
    setErr('err-pin-check',false);
    setErr('pin-check-error',false,'');
    const btn=g('btn-pin-check');
    btn.disabled=true; btn.textContent='OUVERTURE...';
    try {
      await new Promise(r=>setTimeout(r,500));
      let data=null;
      // 1. Chercher dans Supabase
      if(isSupabaseReady()){
        const msg=await getMessageFromSupabase(state.revealLookupCode);
        if(msg&&msg.pin===pin)data=msg;
        else if(msg&&msg.pin!==pin)throw new Error('Code incorrect. Verifiez la carte jointe au bijou.');
      }
      // 2. Fallback : message en mémoire
      if(!data&&state.messageRecord?.jewelCode===state.revealLookupCode){
        if(pin!==state.verification?.pin)throw new Error('Code incorrect.');
        data=state.messageRecord;
      }
      // 3. Démo
      if(!data){
        if(pin!=='1234')throw new Error('Code incorrect. Pour le test utilisez 1234.');
        data={recipientName:'Destinataire',occasion:'Message special',personalMessage:"Ce bijou a ete cree avec amour pour toi.\\n\\nChaque fois que tu le porteras, souviens-toi que tu comptes enormement.",etymologyText:null,motivationText:null,senderLine:'- ALNAE Confidente'};
      }
      state.revealRecord=data;
      renderReveal(data);
      showPage('page-reveal');
    } catch(error){
      const el=g('pin-check-error');
      if(el){el.textContent=error.message||'Code incorrect.';el.classList.add('show');}
    } finally {
      btn.disabled=false; btn.textContent='REVELER MON MESSAGE';
    }
  }

  function renderReveal(data){
    setText('reveal-name',data.recipientName||'');
    if(data.occasion){setText('reveal-occasion',data.occasion);g('reveal-occ-wrap').style.display='block';}else{g('reveal-occ-wrap').style.display='none';}
    if(data.etymologyText){setText('reveal-etym-text',data.etymologyText);g('reveal-etym').style.display='block';}else{g('reveal-etym').style.display='none';}
    if(data.personalMessage){setText('reveal-message',data.personalMessage);g('reveal-msg-block').style.display='block';}else{g('reveal-msg-block').style.display='none';}
    if(data.motivationText){setText('reveal-motiv-text',data.motivationText);g('reveal-motiv-block').style.display='block';}else{g('reveal-motiv-block').style.display='none';}
    setText('reveal-from',data.senderLine||'- ALNAE Confidente');
    g('reveal-loading')?.classList.remove('show');
    renderMediaInReveal(mediaFiles);
  }

  function prefillFromQuery(){
    const params=new URLSearchParams(window.location.search);
    const code=params.get('code');
    if(code){if(g('discover-code'))g('discover-code').value=code;showPage('page-decouvrir');}
  }

  function shareReveal(){
    const name=g('reveal-name')?.textContent||'';
    const d={title:'ALNAE Confidente',text:(name?name+' a recu':'J ai recu')+' un message dans son bijou ALNAE Infinity',url:CONFIG.storefrontPageUrl};
    if(navigator.share&&navigator.canShare?.(d)){navigator.share(d).catch(()=>{});}
    else if(navigator.clipboard?.writeText){navigator.clipboard.writeText(d.text+'\\n'+d.url).then(()=>alert('Copie! '+d.url)).catch(()=>prompt('Lien:',d.url));}
    else{prompt('Lien:',d.url);}
  }

  function initMediaBlock(){
    const input=g('media-file-input'),zone=g('media-drop-zone');
    if(!input||!zone)return;
    input.addEventListener('change',function(){handleMediaFiles(this.files);this.value='';});
    zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('drag-over');});
    zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));
    zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('drag-over');handleMediaFiles(e.dataTransfer.files);});
    g('tog-media')?.addEventListener('change',function(){g('body-media')?.classList.toggle('open',this.checked);g('block-media')?.classList.toggle('on',this.checked);if(!this.checked){mediaFiles.length=0;renderMediaPreviews();updateMediaDropZone();}});
  }

  // ── INIT ──────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function(){
    initSupabase();
    initEmailJS();

    bindToggle('lbl-rgpd-auth','rgpd-auth');
    bindToggle('lbl-rgpd-msg','rgpd-msg');
    bindToggle('lbl-impression','opt-impression');
    initPinNav(['pin1','pin2','pin3','pin4']);
    initPinNav(['pin1b','pin2b','pin3b','pin4b']);
    initPinNav(['check1','check2','check3','check4']);

    document.querySelectorAll('.pill[data-occasion]').forEach(function(pill){
      pill.addEventListener('click',function(){
        document.querySelectorAll('.pill[data-occasion]').forEach(function(p){p.classList.remove('active');});
        pill.classList.add('active');
        state.currentOccasion=pill.dataset.occasion||'';
        setErr('err-occasion',false);
        if(g('autre-field'))g('autre-field').style.display=state.currentOccasion==='Autre'?'block':'none';
        renderSuggestions(state.currentOccasion, g('recipient-name-input')?.value?.trim() || '');
      });
    });

    [['tog-occasion','body-occasion','block-occasion'],['tog-message','body-message','block-message'],['tog-etym','body-etym','block-etym'],['tog-motiv','body-motiv','block-motiv']].forEach(function(t){
      g(t[0])?.addEventListener('change',function(){g(t[1])?.classList.toggle('open',this.checked);g(t[2])?.classList.toggle('on',this.checked);});
    });

    g('message-input')?.addEventListener('input',function(){setText('char-count',String(this.value.length));});
    // Onglets navigation
    g('tab-deposer')?.addEventListener('click', function() {
      g('tab-deposer').classList.add('active');
      g('tab-decouvrir').classList.remove('active');
      if (state.messageRecord) showPage('page-success');
      else if (state.verification?.sessionToken) showPage('page-form');
      else showPage('page-accueil');
    });
    g('tab-decouvrir')?.addEventListener('click', function() {
      g('tab-decouvrir').classList.add('active');
      g('tab-deposer').classList.remove('active');
      showPage('page-decouvrir');
    });
    g('btn-home-title')?.addEventListener('click', function() { showPage('page-accueil'); });
    g('logo-home')?.addEventListener('click',function(){showPage('page-accueil');});
    // Titre cliquable → accueil
    g('btn-home-title')?.addEventListener('click', function() {
      g('tab-deposer').classList.add('active');
      g('tab-decouvrir').classList.remove('active');
      showPage('page-accueil');
    });
    g('btn-accueil-deposer')?.addEventListener('click',function(){
      g('tab-deposer').classList.add('active');
      g('tab-decouvrir').classList.remove('active');
      showPage('page-auth');
    });
    g('btn-accueil-decouvrir')?.addEventListener('click',function(){showPage('page-decouvrir');});
    g('btn-verify')?.addEventListener('click',verifyOrder);
    g('btn-pin-next')?.addEventListener('click',validatePinStep);
    g('btn-preview-msg')?.addEventListener('click',buildPreview);
    g('btn-close-preview')?.addEventListener('click',closePreview);
    g('btn-back-edit')?.addEventListener('click',closePreview);
    g('btn-confirm-seal')?.addEventListener('click',sealMessage);
    g('preview-overlay')?.addEventListener('click',function(e){if(e.target===g('preview-overlay'))closePreview();});
    g('btn-discover')?.addEventListener('click',discoverStep1);
    g('btn-pin-check')?.addEventListener('click',discoverStep2);

    g('btn-dl-confirm')?.addEventListener('click',function(){
      if(!state.messageRecord)return;
      downloadHTML(buildConfirmationHTML(state.messageRecord),'alnae-confirmation-'+state.messageRecord.jewelCode+'.html');
    });
    g('btn-go-reveal')?.addEventListener('click',function(){
      if(!state.preview)return;
      renderReveal({recipientName:state.preview.recipientName,occasion:state.preview.occasion,etymologyText:state.preview.etymologyText,personalMessage:state.preview.personalMessage,motivationText:state.preview.motivationText,senderLine:state.preview.senderLine});
      showPage('page-reveal');
    });
    g('btn-dl-msg')?.addEventListener('click',function(){
      const data=state.revealRecord||state.preview;
      if(!data)return;
      downloadHTML(buildRevealHTML(data),'alnae-message-confidente.html');
    });
    g('btn-share')?.addEventListener('click',shareReveal);
    initMediaBlock();
    prefillFromQuery();
  });

})();
</script>

</body>
</html>`);
});

app.get("/formulaire/:token", (req, res) => {
  const slot = slots.get(req.params.token);
  if (!slot) return res.status(404).send(`<!DOCTYPE html><html><body style="font-family:Georgia,serif;background:#F2EDE3;text-align:center;padding:80px;"><h2 style="color:#C0392B;">Lien introuvable</h2><p>Ce lien est invalide ou a expiré.</p></body></html>`);
  if (slot.status === "sealed") return res.send(`<!DOCTYPE html><html><body style="font-family:Georgia,serif;background:#F2EDE3;text-align:center;padding:80px;"><h2>Message déjà déposé</h2></body></html>`);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ALNAÉ Confidente</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;1,400;1,500&family=Raleway:wght@200;300;400;500&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
/* ═══════════════════════════════════════════════════════════
   ALNAÉ CONFIDENTE — LUXURY EDITORIAL DESIGN
   Direction : Noir de fond, or mat, espaces généreux,
   typographie haute couture. Universel, sans genre.
═══════════════════════════════════════════════════════════ */
:root {
  --obsidian: #F2EDE3;
  --obsidian-mid: #EDE8DC;
  --obsidian-soft: #E8E2D4;
  --obsidian-border: #C8BAA0;
  --gold: #8B6914;
  --gold-bright: #A07820;
  --gold-dim: #6B5010;
  --gold-trace: rgba(139,105,20,.06);
  --gold-glow: rgba(139,105,20,.1);
  --ivory: #1C1408;
  --ivory-dim: #3A2C18;
  --ivory-faint: rgba(139,105,20,.04);
  --white: #FDFAF5;
  --error: #C0392B;
  --success: #2ECC71;
  --text: #1C1408;
  --text-mid: #5A4A2A;
  --text-dim: #8A7A60;
}
* { margin:0; padding:0; box-sizing:border-box; }
html { scroll-behavior: smooth; }

body {
  background: var(--obsidian);
  color: var(--text);
  font-family: 'Raleway', sans-serif;
  font-weight: 300;
  min-height: 100vh;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
}

/* Grain texture overlay */
body::after {
  content: '';
  position: fixed;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.03'/%3E%3C/svg%3E");
  pointer-events: none;
  z-index: 9999;
  opacity: .4;
}

/* Ambient gold glow */
body::before {
  content: '';
  position: fixed;
  top: -30vh;
  left: 50%;
  transform: translateX(-50%);
  width: 600px;
  height: 400px;
  background: radial-gradient(ellipse, rgba(196,163,90,.06) 0%, transparent 70%);
  pointer-events: none;
  z-index: 0;
}

/* ── HEADER ───────────────────────────────────────── */
header {
  text-align: center;
  padding: 4rem 2rem 2rem;
  position: relative;
  z-index: 1;
}

.brand-eyebrow {
  font-size: .6rem;
  letter-spacing: .5em;
  text-transform: uppercase;
  color: var(--gold);
  margin-bottom: 1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
}
.brand-eyebrow::before,.brand-eyebrow::after {
  content: '';
  width: 40px;
  height: 1px;
  background: var(--gold-dim);
}

.collection-title {
  font-family: 'Playfair Display', serif;
  font-size: 3.8rem;
  font-weight: 400;
  font-style: italic;
  color: var(--ivory);
  line-height: .95;
  letter-spacing: -.01em;
  margin-bottom: .6rem;
}

.tagline {
  font-size: .62rem;
  letter-spacing: .35em;
  text-transform: uppercase;
  color: var(--text-mid);
}

/* ── CONTAINER ────────────────────────────────────── */
.container {
  max-width: 560px;
  margin: 0 auto;
  padding: 0 1.2rem 5rem;
  position: relative;
  z-index: 1;
}

/* ── NAV TABS ─────────────────────────────────────── */
.nav-tabs {
  display: flex;
  border-bottom: 1px solid var(--obsidian-border);
  margin-bottom: 2rem;
  position: sticky;
  top: 0;
  background: var(--obsidian);
  z-index: 50;
  padding-top: .5rem;
  gap: 0;
}

.nav-tab {
  flex: 1;
  padding: .85rem .5rem;
  text-align: center;
  font-size: .6rem;
  letter-spacing: .25em;
  text-transform: uppercase;
  color: var(--text-dim);
  cursor: pointer;
  border-bottom: 1px solid transparent;
  margin-bottom: -1px;
  transition: all .25s;
  user-select: none;
  font-weight: 400;
}
.nav-tab:hover { color: var(--text-mid); }
.nav-tab.active { color: var(--gold); border-bottom-color: var(--gold); }

/* ── PAGES ────────────────────────────────────────── */
.page { display: none; animation: fadeUp .4s ease both; }
.page.active { display: block; }
@keyframes fadeUp { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }

/* ── STEP DOTS ────────────────────────────────────── */
.steps {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: .5rem;
  margin-bottom: 1.5rem;
}
.step-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--obsidian-border);
  transition: all .3s;
}
.step-dot.active { background: var(--gold); width: 20px; border-radius: 3px; }

/* ── CARD ─────────────────────────────────────────── */
.card {
  background: var(--obsidian-mid);
  border: 1px solid var(--obsidian-border);
  border-radius: 1px;
  padding: 2.2rem 2rem;
  position: relative;
  overflow: hidden;
  margin-bottom: .8rem;
}
.card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--gold), transparent);
}

.card-title {
  font-family: 'Playfair Display', serif;
  font-size: 1.5rem;
  font-weight: 400;
  color: var(--ivory);
  margin-bottom: .2rem;
  letter-spacing: -.01em;
}
.card-subtitle {
  font-size: .6rem;
  letter-spacing: .2em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 1.8rem;
}

/* ── FIELDS ───────────────────────────────────────── */
.field { margin-bottom: 1.2rem; }
.field label {
  display: block;
  font-size: .6rem;
  letter-spacing: .2em;
  text-transform: uppercase;
  color: var(--text-mid);
  margin-bottom: .5rem;
  font-weight: 400;
}
.req { color: var(--gold); }

.field input[type=text],
.field input[type=email],
.field input[type=tel],
.field textarea {
  width: 100%;
  padding: .85rem 1rem;
  border: 1px solid var(--obsidian-border);
  border-radius: 1px;
  background: var(--obsidian-soft);
  font-family: 'Raleway', sans-serif;
  font-size: .88rem;
  font-weight: 300;
  color: var(--ivory);
  transition: border-color .2s, box-shadow .2s;
  outline: none;
  -webkit-appearance: none;
}
.field input::placeholder, .field textarea::placeholder { color: var(--text-dim); }
.field input:focus, .field textarea:focus {
  border-color: var(--gold-dim);
  box-shadow: 0 0 0 3px rgba(196,163,90,.07);
}
.field input.err { border-color: var(--error); }
.field textarea { resize: vertical; min-height: 110px; line-height: 1.75; }
.field-error { font-size: .65rem; color: var(--error); margin-top: .3rem; display: none; }
.field-error.show { display: block; }
.char-count { text-align: right; font-size: .62rem; color: var(--text-dim); margin-top: .3rem; }
.small-muted { font-size: .63rem; color: var(--text-dim); margin-top: .3rem; }

/* ── PILLS ────────────────────────────────────────── */
.pill-group { display: flex; flex-wrap: wrap; gap: .4rem; margin-bottom: .7rem; }
.pill {
  padding: .3rem .8rem;
  border: 1px solid var(--obsidian-border);
  border-radius: 0;
  font-size: .62rem;
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--text-mid);
  cursor: pointer;
  transition: all .2s;
  background: transparent;
  user-select: none;
  font-family: 'Raleway', sans-serif;
  font-weight: 400;
}
.pill:hover { border-color: var(--gold-dim); color: var(--gold); }
.pill.active { background: var(--gold); border-color: var(--gold); color: var(--obsidian); }

/* ── OPTION BLOCKS ────────────────────────────────── */
.option-block {
  border: 1px solid var(--obsidian-border);
  margin-bottom: .6rem;
  overflow: hidden;
  transition: border-color .3s;
  background: var(--obsidian-mid);
}
.option-block.on {
  border-color: var(--gold-dim);
  box-shadow: 0 0 24px rgba(196,163,90,.06);
}
.option-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: .85rem 1.1rem;
  user-select: none;
}
.option-left { display: flex; align-items: center; gap: .8rem; }
.option-icon { font-size: 1rem; opacity: .7; }
.option-title { font-size: .75rem; font-weight: 400; color: var(--ivory); letter-spacing: .03em; }
.option-desc { font-size: .62rem; color: var(--text-dim); margin-top: .1rem; }
.option-body {
  padding: 1rem 1.1rem;
  border-top: 1px solid var(--obsidian-border);
  display: none;
}
.option-body.open { display: block; }

/* ── TOGGLE ───────────────────────────────────────── */
.toggle { position: relative; width: 36px; height: 20px; flex-shrink: 0; }
.toggle input { opacity: 0; width: 0; height: 0; }
.slider {
  position: absolute; inset: 0;
  background: var(--obsidian-soft);
  border: 1px solid var(--obsidian-border);
  border-radius: 10px;
  cursor: pointer;
  transition: .3s;
}
.slider::before {
  content: '';
  position: absolute;
  width: 14px; height: 14px;
  left: 2px; top: 2px;
  background: var(--text-dim);
  border-radius: 50%;
  transition: .3s;
}
.toggle input:checked + .slider { background: var(--gold); border-color: var(--gold); }
.toggle input:checked + .slider::before { background: var(--obsidian); transform: translateX(16px); }

/* ── SUGGESTIONS ──────────────────────────────────── */
.suggestions-box {
  background: var(--obsidian-soft);
  border: 1px solid var(--obsidian-border);
  padding: .8rem;
  margin-top: .6rem;
}
.sug-title {
  font-size: .58rem;
  letter-spacing: .2em;
  text-transform: uppercase;
  color: var(--gold-dim);
  margin-bottom: .6rem;
  font-weight: 400;
}
.sug-item {
  display: flex;
  align-items: flex-start;
  gap: .6rem;
  padding: .4rem 0;
  border-bottom: 1px solid var(--obsidian-border);
  cursor: pointer;
}
.sug-item:last-child { border-bottom: none; }
.sug-item input[type=checkbox] {
  width: 14px; height: 14px; min-width: 14px;
  margin-top: 3px;
  accent-color: var(--gold);
  cursor: pointer;
  flex-shrink: 0;
}
.sug-item span {
  font-size: .78rem;
  font-family: 'Playfair Display', serif;
  font-style: italic;
  color: var(--ivory-dim);
  line-height: 1.5;
}

/* ── RGPD BOX ─────────────────────────────────────── */
.rgpd-box {
  background: var(--obsidian-soft);
  border: 1px solid var(--obsidian-border);
  padding: .9rem 1.1rem;
  margin: .9rem 0;
  font-size: .7rem;
  line-height: 1.7;
  color: var(--text-mid);
}
.rgpd-box strong { color: var(--ivory); font-weight: 400; }
.rgpd-row { display: flex; align-items: flex-start; gap: .65rem; margin-top: .7rem; }
.rgpd-row input[type=checkbox] {
  width: 15px; height: 15px; min-width: 15px;
  flex-shrink: 0; margin-top: 2px;
  cursor: pointer; accent-color: var(--gold);
}
.rgpd-row span { font-size: .68rem; color: var(--text); line-height: 1.5; cursor: pointer; }

/* ── ALERTS ───────────────────────────────────────── */
.alert-box {
  padding: .75rem 1rem;
  font-size: .72rem;
  line-height: 1.5;
  margin-bottom: .9rem;
  display: none;
  border-left: 2px solid;
}
.alert-box.show { display: block; }
.alert-error { background: rgba(192,57,43,.08); border-color: var(--error); color: #E0756B; }
.alert-success { background: rgba(46,204,113,.06); border-color: var(--success); color: #5DC988; }

/* ── INFO ROWS ────────────────────────────────────── */
.info-row {
  display: flex;
  gap: .6rem;
  align-items: flex-start;
  font-size: .68rem;
  color: var(--text-mid);
  margin-bottom: 1rem;
}
.info-row.tip {
  background: var(--ivory-faint);
  border: 1px solid rgba(196,163,90,.12);
  padding: .65rem .9rem;
}

/* ── BUTTONS ──────────────────────────────────────── */
.btn {
  display: block;
  width: 100%;
  padding: 1rem;
  background: transparent;
  color: var(--ivory);
  border: 1px solid var(--obsidian-border);
  font-family: 'Raleway', sans-serif;
  font-size: .6rem;
  font-weight: 500;
  letter-spacing: .3em;
  text-transform: uppercase;
  cursor: pointer;
  transition: all .3s;
  margin-top: 1rem;
  position: relative;
  overflow: hidden;
}
.btn::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--ivory-faint);
  transform: scaleX(0);
  transform-origin: left;
  transition: transform .3s;
}
.btn:hover { border-color: var(--text-mid); }
.btn:hover::after { transform: scaleX(1); }
.btn:disabled { opacity: .4; cursor: not-allowed; }
.btn:disabled::after { display: none; }

.btn-primary {
  background: #1C1408;
  color: #F2EDE3;
  border-color: #1C1408;
}
.btn-primary::after { background: rgba(255,255,255,.05); }
.btn-primary:hover { background: #2A2010; border-color: #2A2010; }

.btn-gold {
  background: var(--gold);
  color: var(--obsidian);
  border-color: var(--gold);
  font-weight: 500;
}
.btn-gold::after { background: rgba(0,0,0,.08); }
.btn-gold:hover { background: var(--gold-bright); border-color: var(--gold-bright); }

/* ── PIN ──────────────────────────────────────────── */
.pin-wrap { display: flex; gap: .5rem; justify-content: center; margin: .9rem 0; }
.pin-digit {
  width: 50px; height: 58px;
  border: 1px solid var(--obsidian-border);
  background: var(--obsidian-soft);
  font-family: 'Playfair Display', serif;
  font-size: 1.6rem;
  text-align: center;
  color: var(--ivory);
  outline: none;
  transition: border-color .2s, box-shadow .2s;
  -webkit-appearance: none;
}
.pin-digit:focus { border-color: var(--gold-dim); box-shadow: 0 0 0 3px rgba(196,163,90,.08); }
.pin-hint { font-size: .63rem; color: var(--text-dim); text-align: center; line-height: 1.5; letter-spacing: .05em; }

/* ── MÉDIA ────────────────────────────────────────── */
.media-upload-area {
  border: 1px dashed var(--obsidian-border);
  padding: 1.5rem 1rem;
  text-align: center;
  cursor: pointer;
  transition: all .2s;
  position: relative;
}
.media-upload-area:hover, .media-upload-area.drag-over {
  border-color: var(--gold-dim);
  background: var(--ivory-faint);
}
.media-upload-area input[type=file] {
  position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%;
}
.media-upload-icon { font-size: 1.5rem; display: block; margin-bottom: .5rem; opacity: .5; }
.media-upload-label { font-size: .7rem; color: var(--text-mid); line-height: 1.6; }
.media-upload-label strong { color: var(--gold); display: block; font-size: .72rem; font-weight: 400; letter-spacing: .05em; }
.media-types { display: flex; gap: .4rem; justify-content: center; flex-wrap: wrap; margin-top: .6rem; }
.media-type-badge {
  font-size: .55rem; letter-spacing: .15em; text-transform: uppercase;
  padding: .2rem .5rem; border: 1px solid var(--obsidian-border);
  color: var(--text-dim); font-weight: 400;
}
.media-previews { display: flex; flex-direction: column; gap: .5rem; margin-top: .8rem; }
.media-item {
  display: flex; align-items: center; gap: .7rem;
  background: var(--obsidian-soft);
  border: 1px solid var(--obsidian-border);
  padding: .6rem .8rem;
  position: relative;
}
.media-item-icon { font-size: 1.2rem; flex-shrink: 0; opacity: .7; }
.media-item-info { flex: 1; min-width: 0; }
.media-item-name { font-size: .72rem; color: var(--ivory); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.media-item-size { font-size: .62rem; color: var(--text-dim); margin-top: .1rem; }
.media-item-remove {
  background: none; border: none; color: var(--text-dim);
  cursor: pointer; font-size: .9rem; padding: .2rem; flex-shrink: 0; line-height: 1;
}
.media-item-remove:hover { color: var(--error); }
.media-item-preview { width: 44px; height: 44px; object-fit: cover; flex-shrink: 0; border: 1px solid var(--obsidian-border); }
.media-item-audio { width: 100%; margin-top: .4rem; filter: invert(1) hue-rotate(180deg); opacity: .7; }
.media-limit-info { font-size: .62rem; color: var(--text-dim); text-align: center; margin-top: .5rem; line-height: 1.5; }
.media-error { font-size: .65rem; color: var(--error); margin-top: .3rem; display: none; }
.media-error.show { display: block; }

/* ── QR / CARTE ───────────────────────────────────── */
.qr-section { text-align: center; padding: 1.2rem 0; }
.qr-label { font-size: .6rem; letter-spacing: .2em; text-transform: uppercase; color: var(--gold); margin-bottom: .8rem; }
#qrcode-container canvas, #qrcode-container img,
#carte-qr-mini canvas, #carte-qr-mini img { display: block; margin: 0 auto; }
.qr-url { font-size: .6rem; color: var(--text-dim); margin-top: .5rem; word-break: break-all; }
.carte-preview {
  border: 1px solid var(--obsidian-border);
  padding: 1.2rem;
  margin: 1rem 0;
  background: var(--obsidian-soft);
  position: relative;
}
.carte-preview::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--gold), transparent);
}
.carte-header { font-size: .58rem; letter-spacing: .2em; text-transform: uppercase; color: var(--gold); text-align: center; margin-bottom: .7rem; }
.carte-body { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.carte-text { flex: 1; font-size: .72rem; color: var(--text-mid); line-height: 1.6; min-width: 160px; }
.carte-code-badge {
  background: var(--obsidian);
  color: var(--gold);
  padding: .4rem .8rem;
  font-family: monospace;
  font-size: .85rem;
  letter-spacing: .15em;
  border: 1px solid var(--gold-dim);
  text-align: center;
  white-space: nowrap;
}

/* ── REVEAL / MESSAGE ─────────────────────────────── */
.reveal-center { text-align: center; }
.jewel-icon { font-size: 2.6rem; display: block; text-align: center; margin-bottom: .9rem; animation: pulse 4s ease-in-out infinite; }
@keyframes pulse { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.04);opacity:.85} }

.occasion-badge {
  display: inline-block;
  padding: .25rem .9rem;
  border: 1px solid var(--gold-dim);
  font-size: .58rem;
  letter-spacing: .25em;
  text-transform: uppercase;
  color: var(--gold);
  margin-bottom: 1.1rem;
}
.recipient-name {
  font-family: 'Playfair Display', serif;
  font-size: 2.2rem;
  font-weight: 400;
  font-style: italic;
  color: var(--ivory);
  text-align: center;
  margin-bottom: .2rem;
  letter-spacing: -.01em;
}
.diamond-sep {
  display: flex; align-items: center; justify-content: center; gap: .7rem; padding: 1rem 0;
}
.diamond-sep::before, .diamond-sep::after { content: ''; width: 60px; height: 1px; background: var(--obsidian-border); }
.diamond-sep span { width: 4px; height: 4px; background: var(--gold); transform: rotate(45deg); display: block; }

.etym-block {
  border-left: 1px solid var(--gold-dim);
  padding: .8rem 1rem;
  margin: 1rem 0;
  text-align: left;
  background: var(--ivory-faint);
}
.etym-label { font-size: .58rem; letter-spacing: .2em; text-transform: uppercase; color: var(--gold-dim); margin-bottom: .3rem; }
.etym-block p {
  font-family: 'Playfair Display', serif;
  font-size: .95rem;
  font-style: italic;
  color: var(--ivory-dim);
  line-height: 1.8;
  white-space: pre-wrap;
}
.msg-block {
  background: var(--obsidian-soft);
  border: 1px solid var(--obsidian-border);
  padding: 1.4rem;
  margin: 1rem 0;
  text-align: left;
}
.msg-block p {
  font-family: 'Playfair Display', serif;
  font-size: 1.05rem;
  line-height: 1.9;
  color: var(--ivory);
  white-space: pre-wrap;
}
.motiv-block {
  border: 1px solid var(--gold-dim);
  padding: .9rem 1.3rem;
  margin: 1rem 0;
  text-align: center;
  background: var(--ivory-faint);
}
.motiv-block p {
  font-family: 'Playfair Display', serif;
  font-size: .9rem;
  font-style: italic;
  color: var(--gold);
  line-height: 1.8;
  white-space: pre-wrap;
}
.from-line {
  font-size: .65rem; letter-spacing: .12em;
  color: var(--text-dim); margin-top: .8rem;
  font-style: italic; text-align: center;
}
.alnae-footer { font-size: .58rem; letter-spacing: .18em; color: var(--text-dim); text-transform: uppercase; text-align: center; margin-top: .5rem; }
.alnae-footer a { color: var(--gold-dim); text-decoration: none; }
.alnae-footer a:hover { color: var(--gold); }

/* ── SUCCESS ──────────────────────────────────────── */
.success-icon {
  width: 52px; height: 52px;
  border: 1px solid var(--gold-dim);
  display: flex; align-items: center; justify-content: center;
  margin: 0 auto 1.3rem;
  font-size: 1.2rem;
  color: var(--gold);
  font-family: 'Playfair Display', serif;
  font-style: italic;
}

/* ── SPINNER ──────────────────────────────────────── */
.spinner-wrap { text-align: center; padding: .9rem; display: none; }
.spinner-wrap.show { display: block; }
.spinner {
  width: 24px; height: 24px;
  border: 1px solid var(--obsidian-border);
  border-top-color: var(--gold);
  border-radius: 50%;
  animation: spin .9s linear infinite;
  margin: 0 auto .5rem;
}
@keyframes spin { to{transform:rotate(360deg)} }
.spinner-text { font-size: .6rem; letter-spacing: .15em; text-transform: uppercase; color: var(--text-dim); }

/* ── PREVIEW OVERLAY ──────────────────────────────── */
.preview-overlay {
  display: none; position: fixed; inset: 0;
  background: rgba(28,20,8,.75);
  z-index: 1000; overflow-y: auto; padding: 2rem 1rem;
  backdrop-filter: blur(4px);
}
.preview-overlay.show { display: flex; align-items: flex-start; justify-content: center; }
.preview-inner {
  background: var(--obsidian-mid);
  border: 1px solid var(--obsidian-border);
  max-width: 520px; width: 100%;
  position: relative; margin: auto;
}
.preview-inner::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--gold), transparent);
}
.preview-header {
  background: var(--obsidian);
  padding: .9rem 1.3rem;
  display: flex; align-items: center; justify-content: space-between;
  border-bottom: 1px solid var(--obsidian-border);
}
.preview-header span { font-size: .6rem; letter-spacing: .2em; text-transform: uppercase; color: var(--gold); }
.preview-close {
  background: none; border: none; color: var(--text-dim);
  font-size: 1rem; cursor: pointer; padding: .2rem .4rem; line-height: 1;
}
.preview-close:hover { color: var(--ivory); }
.preview-body { padding: 1.8rem 1.4rem; }
.preview-warning {
  background: rgba(196,163,90,.05);
  border: 1px solid rgba(196,163,90,.15);
  padding: .7rem .9rem; margin-bottom: 1.3rem;
  font-size: .68rem; color: var(--text-mid); line-height: 1.5;
}

/* ── BADGE ────────────────────────────────────────── */
.badge-new {
  display: inline-block; background: var(--gold);
  color: var(--obsidian); font-size: .52rem;
  letter-spacing: .12em; text-transform: uppercase;
  padding: .15rem .45rem; margin-left: .4rem; vertical-align: middle;
  font-weight: 500;
}

.email-status{padding:.7rem 1rem;border-radius:2px;font-size:.72rem;line-height:1.5;margin:.8rem 0;}
.email-status.sent{background:rgba(46,204,113,.08);border:1px solid rgba(46,204,113,.3);color:#27AE60;}
.email-status.pending{background:rgba(139,105,20,.08);border:1px solid rgba(139,105,20,.3);color:var(--gold);}
/* ── CONFETTI ─────────────────────────────────────── */
.confetti-wrap { position: fixed; inset: 0; pointer-events: none; z-index: 100; overflow: hidden; }
.cp { position: absolute; top: -10px; animation: fall linear forwards; opacity: 0; }
@keyframes fall { 0%{opacity:1;transform:translateY(0) rotate(0)} 100%{opacity:0;transform:translateY(100vh) rotate(720deg)} }

@media(max-width:480px) {
  .collection-title { font-size: 2.8rem; }
  .card { padding: 1.6rem 1.2rem; }
  .pin-digit { width: 42px; height: 50px; font-size: 1.4rem; }
  .carte-body { flex-direction: column; align-items: flex-start; }
}
</style>
</head>
<body>
<div class="confetti-wrap" id="confetti"></div>

<!-- APERÇU OVERLAY -->
<div class="preview-overlay" id="preview-overlay">
  <div class="preview-inner">
    <div class="preview-header">
      <span>Aperçu — Message Confidente</span>
      <button class="preview-close" id="btn-close-preview" type="button">✕</button>
    </div>
    <div class="preview-body">
      <div class="preview-warning">Voici exactement ce que verra le destinataire. Vérifiez avant de sceller.</div>
      <div class="reveal-center">
        <div id="prev-media-block" style="display:none;margin:0 0 1.2rem;"></div>
        <span class="jewel-icon">◆</span>
        <div id="prev-occ-wrap" style="display:none"><div class="occasion-badge" id="prev-occasion"></div></div>
        <p class="recipient-name" id="prev-name"></p>
        <div class="diamond-sep"><span></span></div>
        <div class="spinner-wrap" id="prev-loading"><div class="spinner"></div><div class="spinner-text">Préparation de l'aperçu…</div></div>
        <div class="etym-block" id="prev-etym" style="display:none"><div class="etym-label">Essence du prénom</div><p id="prev-etym-text"></p></div>
        <div class="msg-block" id="prev-msg-block" style="display:none"><p id="prev-message"></p></div>
        <div class="motiv-block" id="prev-motiv-block" style="display:none"><p id="prev-motiv-text"></p></div>
        
        <p class="from-line" id="prev-from"></p>
        <div class="diamond-sep"><span></span></div>
        <div class="alnae-footer">ALNAÉ Infinity — Collection Confidente<br><a href="https://www.alnaeinfinity.com" target="_blank" rel="noopener">www.alnaeinfinity.com</a></div>
      </div>
      <button class="btn btn-gold" id="btn-confirm-seal" type="button" style="margin-top:1.3rem;">Confirmer et sceller</button>
      <button class="btn" id="btn-back-edit" type="button" style="margin-top:.5rem;">← Modifier</button>
    </div>
  </div>
</div>

<header>
  <div class="brand-eyebrow">ALNAÉ Infinity</div>
  <h1 class="collection-title" style="cursor:pointer;" id="title-home">Confidente</h1>
  <p class="tagline">Le bijou qui porte votre voix</p>
</header>

<div class="container">
  <div class="nav-tabs">
    <div class="nav-tab" id="tab-deposer">Déposer un message</div>
    <div class="nav-tab" id="tab-decouvrir">Découvrir mon message</div>
  </div>

  <!-- ACCUEIL -->
  <div class="page active" id="page-accueil">
    <div class="card" style="text-align:center;padding:3rem 2rem;">
      <div style="font-size:2rem;color:var(--gold);margin-bottom:1.2rem;font-family:'Playfair Display',serif;">◆</div>
      <h2 class="card-title" style="text-align:center;margin-bottom:.6rem;">Bienvenue</h2>
      <p style="font-size:.75rem;color:var(--text-mid);line-height:1.8;margin-bottom:2.5rem;letter-spacing:.03em;">Vous venez d'acquérir un bijou de la collection Confidente.<br>Que souhaitez-vous faire ?</p>
      <button class="btn btn-primary" id="btn-accueil-deposer" type="button" style="margin-top:0;">Déposer un message</button>
      <p style="font-size:.6rem;color:var(--text-dim);margin:.6rem 0;letter-spacing:.12em;text-transform:uppercase;">Vous avez commandé ce bijou pour l'offrir</p>
      <button class="btn" id="btn-accueil-decouvrir" type="button" style="margin-top:0;">Découvrir mon message</button>
      <p style="font-size:.6rem;color:var(--text-dim);margin:.6rem 0;letter-spacing:.12em;text-transform:uppercase;">Ce bijou vous a été offert et vous disposez d'un code</p>
    </div>
  </div>

  <!-- AUTH -->
  <div class="page" id="page-auth">
    <div class="steps"><div class="step-dot active"></div><div class="step-dot"></div><div class="step-dot"></div><div class="step-dot"></div></div>
    <div class="card">
      <h2 class="card-title">Vérification de commande</h2>
      <p class="card-subtitle">Étape 1 sur 4 — Identification sécurisée</p>
      <div class="info-row"><span>◈</span><span>Vos informations sont vérifiées de façon sécurisée avant l'accès au formulaire.</span></div>
      <div class="alert-box alert-error" id="auth-error"></div>
      <div class="field">
        <label>Numéro de commande <span class="req">*</span></label>
        <input type="text" id="order-number" placeholder="ex. CMD-2024-00142" autocomplete="off">
        <div class="field-error" id="err-order">Champ obligatoire</div>
      </div>
      <div class="field">
        <label>Prénom <span class="req">*</span></label>
        <input type="text" id="auth-firstname" placeholder="Prénom utilisé lors de la commande" autocomplete="given-name">
        <div class="field-error" id="err-firstname">Champ obligatoire</div>
      </div>
      <div class="field">
        <label>Nom <span class="req">*</span></label>
        <input type="text" id="auth-lastname" placeholder="Nom utilisé lors de la commande" autocomplete="family-name">
        <div class="field-error" id="err-lastname">Champ obligatoire</div>
      </div>
      <div class="field">
        <label>Adresse e-mail <span class="req">*</span></label>
        <input type="email" id="auth-email" placeholder="votre@email.fr" autocomplete="email">
        <div class="field-error" id="err-email">Email requis pour recevoir votre confirmation</div>
        <div class="small-muted">Votre confirmation avec QR code sera envoyée à cette adresse</div>
      </div>
      <div class="rgpd-box">
        <strong>Données personnelles</strong><br>
        Vos données sont utilisées pour vérifier votre commande et vous envoyer la confirmation. Elles ne sont pas revendues. Conformément au RGPD : <strong>contact.alnae@gmail.com</strong>
        <div class="rgpd-row"><input type="checkbox" id="rgpd-auth"><span id="lbl-rgpd-auth">J'accepte la politique de confidentialité d'ALNAÉ Infinity.</span></div>
        <div class="field-error" id="err-rgpd">Consentement requis.</div>
      </div>
      <button class="btn btn-primary" id="btn-verify" type="button">Vérifier ma commande →</button>
    </div>
  </div>

  <!-- PIN -->
  <div class="page" id="page-pin">
    <div class="steps"><div class="step-dot"></div><div class="step-dot active"></div><div class="step-dot"></div><div class="step-dot"></div></div>
    <div class="card">
      <h2 class="card-title">Code confidentiel</h2>
      <p class="card-subtitle">Étape 2 sur 4 — Sécurisation du message</p>
      <div class="info-row tip"><span>◈</span><span>Choisissez un code à 4 chiffres. Il sera demandé au destinataire pour révéler votre message. La surprise est préservée.</span></div>
      <div class="field">
        <label>Créez votre code <span class="req">*</span></label>
        <div class="pin-wrap">
          <input type="tel" class="pin-digit" id="pin1" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="pin2" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="pin3" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="pin4" maxlength="1" inputmode="numeric">
        </div>
        <div class="pin-hint">4 chiffres — mémorable pour vous, confidentiel pour les autres</div>
        <div class="field-error" id="err-pin">4 chiffres requis</div>
      </div>
      <div class="field" style="margin-top:1.2rem;">
        <label>Confirmez votre code <span class="req">*</span></label>
        <div class="pin-wrap">
          <input type="tel" class="pin-digit" id="pin1b" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="pin2b" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="pin3b" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="pin4b" maxlength="1" inputmode="numeric">
        </div>
        <div class="field-error" id="err-pin-confirm">Les codes ne correspondent pas</div>
      </div>
      <button class="btn btn-primary" id="btn-pin-next" type="button">Continuer →</button>
    </div>
  </div>

  <!-- FORMULAIRE -->
  <!-- CHOIX DU BIJOU / SLOT -->
<div class="page" id="page-slots">
  <div class="steps">
    <div class="step-dot"></div>
    <div class="step-dot active"></div>
    <div class="step-dot"></div>
    <div class="step-dot"></div>
  </div>

  <div class="card">
    <h2 class="card-title">Choisissez le bijou à personnaliser</h2>
    <p class="card-subtitle">Étape 2 sur 4 — Sélection du message à préparer</p>

    <div class="info-row">
      <span>◈</span>
      <span>
        Cette commande contient plusieurs bijoux Confidente. Sélectionnez celui que vous souhaitez remplir maintenant.
      </span>
    </div>

    <div id="slots-list" style="display:flex;flex-direction:column;gap:.8rem;margin-top:1.2rem;"></div>

    <button class="btn" id="btn-slots-back" type="button" style="margin-top:1rem;">← Retour</button>
  </div>
</div>
  <div class="page" id="page-form">
    <div class="steps"><div class="step-dot"></div><div class="step-dot"></div><div class="step-dot active"></div><div class="step-dot"></div></div>
    <div class="card">
      <h2 class="card-title">Composition du message</h2>
      <p class="card-subtitle">Étape 3 sur 4 — Activez les modules souhaités</p>
      <div class="info-row"><span>◈</span><span>Commande vérifiée — <strong id="verified-name-display"></strong></span></div>
      <div class="info-row tip"><span>◈</span><span>Activez uniquement les modules souhaités. Seul le prénom du destinataire est obligatoire.</span></div>
    </div>

    <!-- Destinataire -->
    <div class="option-block on" style="border-color:var(--gold-dim);">
      <div class="option-header">
        <div class="option-left"><span class="option-icon">◈</span>
          <div><div class="option-title">Destinataire <span class="req">*</span></div><div class="option-desc">Prénom de la personne qui reçoit le bijou</div></div>
        </div>
      </div>
      <div class="option-body open">
        <div class="field" style="margin:0;">
          <input type="text" id="recipient-name-input" placeholder="ex. Sophie, Alexandre, Marie…">
          <div class="field-error" id="err-recipient">Obligatoire</div>
        </div>
      </div>
    </div>

    <!-- Occasion -->
    <div class="option-block" id="block-occasion">
      <div class="option-header">
        <div class="option-left"><span class="option-icon">◇</span>
          <div><div class="option-title">L'occasion</div><div class="option-desc">Anniversaire, diplôme, retraite… avec suggestions de texte</div></div>
        </div>
        <label class="toggle"><input type="checkbox" id="tog-occasion"><span class="slider"></span></label>
      </div>
      <div class="option-body" id="body-occasion">
        <div class="pill-group" id="occasion-pills">
          <div class="pill" data-occasion="Anniversaire">Anniversaire</div>
          <div class="pill" data-occasion="Amitié">Amitié</div>
          <div class="pill" data-occasion="Diplôme">Diplôme</div>
          <div class="pill" data-occasion="Fête des mères">Fête des mères</div>
          <div class="pill" data-occasion="Encouragement">Encouragement</div>
          <div class="pill" data-occasion="Souvenir">Souvenir</div>
          <div class="pill" data-occasion="Noël">Noël</div>
          <div class="pill" data-occasion="Autre">Autre</div>
        </div>
        <div class="field-error" id="err-occasion">Choisissez une occasion ou désactivez ce module</div>
        <div class="field" id="autre-field" style="display:none;">
          <label>Précisez l'occasion</label>
          <input type="text" id="autre-text" placeholder="ex. Mariage, Naissance, Retraite, Promotion…">
        </div>
        <div class="suggestions-box" id="suggestions-box" style="display:none;">
          <div class="sug-title">Suggestions — cochez celle(s) qui vous inspirent</div>
          <div id="suggestions-list"></div>
        </div>
      </div>
    </div>

    <!-- Message personnel -->
    <div class="option-block" id="block-message">
      <div class="option-header">
        <div class="option-left"><span class="option-icon">✦</span>
          <div><div class="option-title">Message personnel</div><div class="option-desc">Vos propres mots, librement</div></div>
        </div>
        <label class="toggle"><input type="checkbox" id="tog-message"><span class="slider"></span></label>
      </div>
      <div class="option-body" id="body-message">
        <div class="field" style="margin:0;">
          <textarea id="message-input" placeholder="Écrivez ici ce que vous souhaitez lui transmettre…" maxlength="600"></textarea>
          <div class="char-count"><span id="char-count">0</span> / 600</div>
          <div class="field-error" id="err-message">Le message est vide</div>
        </div>
      </div>
    </div>

    <!-- Étymologie -->
    <div class="option-block" id="block-etym">
      <div class="option-header">
        <div class="option-left"><span class="option-icon">◉</span>
          <div><div class="option-title">Essence du prénom <span class="badge-new">IA</span></div><div class="option-desc">Origine et signification du prénom, générée par intelligence artificielle</div></div>
        </div>
        <label class="toggle"><input type="checkbox" id="tog-etym"><span class="slider"></span></label>
      </div>
      <div class="option-body" id="body-etym">
        <p style="font-size:.72rem;color:var(--text-mid);line-height:1.7;">Générée à partir du prénom du destinataire. Visible dans l'aperçu avant de sceller.</p>
      </div>
    </div>

    <!-- Citation -->
    <div class="option-block" id="block-motiv">
      <div class="option-header">
        <div class="option-left"><span class="option-icon">◌</span>
          <div><div class="option-title">Citation ALNAÉ Infinity</div><div class="option-desc">Une pensée inspirante, signée ALNAÉ Infinity</div></div>
        </div>
        <label class="toggle"><input type="checkbox" id="tog-motiv"><span class="slider"></span></label>
      </div>
      <div class="option-body" id="body-motiv">
        <p style="font-size:.72rem;color:var(--text-mid);line-height:1.7;font-style:italic;">Une citation sera choisie parmi la sélection ALNAÉ. Elle se conclut par : « N'oublie pas qui tu es. »</p>
      </div>
    </div>

    <!-- Média -->
    <div class="option-block" id="block-media">
      <div class="option-header">
        <div class="option-left"><span class="option-icon">▣</span>
          <div><div class="option-title">Photo, vidéo ou audio</div><div class="option-desc">Ajoutez un contenu visuel ou vocal à votre message</div></div>
        </div>
        <label class="toggle"><input type="checkbox" id="tog-media"><span class="slider"></span></label>
      </div>
      <div class="option-body" id="body-media">
        <div class="media-upload-area" id="media-drop-zone">
          <input type="file" id="media-file-input" accept="image/*,video/*,audio/*" multiple>
          <span class="media-upload-icon">▣</span>
          <div class="media-upload-label">
            <strong>Cliquez ou déposez vos fichiers ici</strong>
            Photo, vidéo ou message audio
          </div>
          <div class="media-types">
            <span class="media-type-badge">Photo</span>
            <span class="media-type-badge">Vidéo</span>
            <span class="media-type-badge">Audio</span>
          </div>
        </div>
        <div class="media-error" id="media-error">Fichier trop volumineux (max 20 Mo) ou format non supporté.</div>
        <div class="media-limit-info">Maximum 3 fichiers · 20 Mo par fichier · JPG, PNG, GIF, MP4, MOV, MP3, WAV, M4A</div>
        <div class="media-previews" id="media-previews"></div>
      </div>
    </div>

    <!-- RGPD + bouton -->
    <div class="card" style="margin-top:.3rem;">
      <div class="alert-box alert-error" id="form-error">Activez au moins un module en plus du prénom.</div>
      <div class="rgpd-box" style="border-color:rgba(196,163,90,.2);">
        <strong>Option impression carte par ALNAÉ Infinity</strong><br>
        En cochant cette case, ALNAÉ Infinity imprimera et joindra la carte avec le QR code directement dans le colis du bijou. <strong style="color:#E0756B;">En cochant, vous autorisez ALNAÉ Infinity à accéder à votre message pour réaliser ce service.</strong>
        <div class="rgpd-row"><input type="checkbox" id="opt-impression"><span id="lbl-impression">J'autorise ALNAÉ Infinity à imprimer et joindre la carte confidentielle à mon bijou.</span></div>
      </div>
      <div class="rgpd-box" style="margin-top:.5rem;">
        <strong>Consentement au stockage du message</strong><br>
        Votre message sera associé au bijou et révélé uniquement après vérification du code confidentiel.
        <div class="rgpd-row"><input type="checkbox" id="rgpd-msg"><span id="lbl-rgpd-msg">Je consens au stockage sécurisé de mon message associé au bijou.</span></div>
        <div class="field-error" id="err-rgpd-msg">Consentement requis</div>
      </div>
      <button class="btn btn-gold" id="btn-preview-msg" type="button">Prévisualiser le message</button>
    </div>
  </div>

  <!-- SUCCÈS -->
  <div class="page" id="page-success">
    <div class="steps"><div class="step-dot"></div><div class="step-dot"></div><div class="step-dot"></div><div class="step-dot active"></div></div>
    <div class="card" style="text-align:center;">
      <div class="success-icon">✦</div>
      <h2 class="card-title" style="text-align:center;">Message scellé</h2>
      <div class="alert-box alert-success show" id="success-box">Votre confirmation a été préparée. Téléchargez-la ci-dessous — elle contient la carte à joindre au bijou.</div>
      <p style="font-size:.75rem;color:var(--text-mid);line-height:1.8;margin:1rem 0;">Votre message est lié à ce bijou et protégé par votre code confidentiel.</p>
      <div id="impression-notice" style="display:none;background:rgba(196,163,90,.06);border:1px solid rgba(196,163,90,.2);padding:.8rem 1rem;font-size:.72rem;color:var(--ivory);margin:.8rem 0;line-height:1.6;">
        <strong>Impression demandée</strong> — ALNAÉ Infinity préparera la carte à joindre au colis.
      </div>
      <div class="qr-section">
        <div class="qr-label">QR Code du bijou</div>
        <div id="qrcode-container"></div>
        <div class="qr-url" id="qr-url-display"></div>
      </div>
      <div class="carte-preview">
        <div class="carte-header">ALNAÉ Infinity — Carte à glisser dans le paquet</div>
        <div class="carte-body">
          <div class="carte-text">Scannez le QR code ou rendez-vous sur<br><strong style="color:var(--ivory);">www.alnaeinfinity.com/pages/confidente</strong><br>puis saisissez les informations demandées.</div>
          <div>
            <div style="font-size:.55rem;color:var(--text-dim);margin-bottom:.3rem;letter-spacing:.1em;text-transform:uppercase;">Code du bijou</div>
            <div class="carte-code-badge" id="carte-code-display">—</div>
          </div>
        </div>
        <div id="carte-qr-mini" style="text-align:right;margin-top:.5rem;"></div>
      </div>
      <button class="btn btn-gold" id="btn-dl-confirm" type="button">Télécharger la confirmation complète</button>
      <button class="btn" id="btn-go-reveal" type="button" style="margin-top:.5rem;">Aperçu du message final →</button>
    </div>
  </div>

  <!-- DÉCOUVRIR — CODE -->
  <div class="page" id="page-decouvrir">
    <div class="card">
      <h2 class="card-title">Découvrez votre message</h2>
      <p class="card-subtitle">Un message vous a été laissé</p>
      <div class="info-row tip"><span>◈</span><span>Scannez le QR code sur votre carte ou saisissez le code du bijou ci-dessous.</span></div>
      <div class="field">
        <label>Code du bijou <span class="req">*</span></label>
        <input type="text" id="discover-code" placeholder="ex. CONF-2024-001">
        <div class="field-error" id="err-discover">Code introuvable.</div>
      </div>
      <button class="btn btn-primary" id="btn-discover" type="button">Continuer →</button>
    </div>
  </div>

  <!-- DÉCOUVRIR — PIN -->
  <div class="page" id="page-pin-check">
    <div class="card">
      <h2 class="card-title">Code confidentiel</h2>
      <p class="card-subtitle">Saisissez le code lié à votre message</p>
      <div class="info-row tip"><span>◈</span><span>Entrez le code à 4 chiffres communiqué avec le cadeau.</span></div>
      <div class="alert-box alert-error" id="pin-check-error"></div>
      <div class="field">
        <label>Code confidentiel <span class="req">*</span></label>
        <div class="pin-wrap">
          <input type="tel" class="pin-digit" id="check1" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="check2" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="check3" maxlength="1" inputmode="numeric">
          <input type="tel" class="pin-digit" id="check4" maxlength="1" inputmode="numeric">
        </div>
        <div class="field-error" id="err-pin-check">Code à 4 chiffres requis</div>
      </div>
      <button class="btn btn-primary" id="btn-pin-check" type="button">Révéler le message →</button>
    </div>
  </div>

  <!-- RÉVÉLATION -->
  <div class="page" id="page-reveal">
    <div class="card reveal-center">
      <div id="reveal-media-block" style="display:none;margin:0 0 1.5rem;width:100%;"></div>
      <span class="jewel-icon">◆</span>
      <div id="reveal-occ-wrap" style="display:none"><div class="occasion-badge" id="reveal-occasion"></div></div>
      <p class="recipient-name" id="reveal-name"></p>
      <div class="diamond-sep"><span></span></div>
      <div class="spinner-wrap" id="reveal-loading"><div class="spinner"></div><div class="spinner-text">Chargement…</div></div>
      
      <div class="etym-block" id="reveal-etym" style="display:none"><div class="etym-label">Essence du prénom</div><p id="reveal-etym-text"></p></div>
      <div class="msg-block" id="reveal-msg-block" style="display:none"><p id="reveal-message"></p></div>
      <div class="motiv-block" id="reveal-motiv-block" style="display:none"><p id="reveal-motiv-text"></p></div>
      <p class="from-line" id="reveal-from"></p>
      <div class="diamond-sep"><span></span></div>
      <div class="alnae-footer">ALNAÉ Infinity — Collection Confidente<br><a href="https://www.alnaeinfinity.com" target="_blank" rel="noopener">www.alnaeinfinity.com</a></div>
      <button class="btn btn-gold" id="btn-dl-msg" type="button" style="margin-top:1.3rem;">Télécharger mon message</button>
      <button class="btn" id="btn-share" type="button" style="margin-top:.5rem;">Partager ce moment</button>
    </div>
  </div>

</div>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script src="https://cdn.jsdelivr.net/npm/@emailjs/browser@4/dist/email.min.js"></script>
<script>
(() => {
  'use strict';

  // ══════════════════════════════════════════════════════════════════
  //  CONFIGURATION — REMPLACE LES VALEURS CI-DESSOUS PAR LES TIENNES
  // ══════════════════════════════════════════════════════════════════
  const CONFIG = {
    // Supabase — récupère ces valeurs sur supabase.com > Settings > API
    supabaseUrl:    '',
    supabaseKey:    '',

    // EmailJS — récupère ces valeurs sur emailjs.com > Account
    emailjsPublicKey:   'COLLE_TA_EMAILJS_PUBLIC_KEY_ICI',
    emailjsServiceId:   'COLLE_TON_EMAILJS_SERVICE_ID_ICI',
    emailjsTemplateId:  'COLLE_TON_EMAILJS_TEMPLATE_ID_ICI',

    // Ton email ALNAÉ pour recevoir une copie de chaque confirmation
    alnaEmail: 'commande.alnae@gmail.com',

    // URL de la page Shopify
    storefrontPageUrl: 'https://alnae-confidente-1.onrender.com',

    // Mode démo : true = pas besoin de Supabase/EmailJS pour tester
    // Passe à false une fois tes clés configurées
    demoMode: false
  };
  // ══════════════════════════════════════════════════════════════════

  // ── SUPABASE INIT ─────────────────────────────────────────────────
  let db = null;
  function initSupabase() {
    if (CONFIG.supabaseUrl === 'COLLE_TON_SUPABASE_URL_ICI') return false;
    try {
      db = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);
      return true;
    } catch(e) { console.warn('Supabase non initialisé:', e); return false; }
  }

  // ── EMAILJS INIT ──────────────────────────────────────────────────
  function initEmailJS() {
    if (CONFIG.emailjsPublicKey === 'COLLE_TA_EMAILJS_PUBLIC_KEY_ICI') return false;
    try { emailjs.init({ publicKey: CONFIG.emailjsPublicKey }); return true; }
    catch(e) { console.warn('EmailJS non initialisé:', e); return false; }
  }

  const isSupabaseReady = () => db !== null;
  const isEmailJSReady = () => CONFIG.emailjsPublicKey !== 'COLLE_TA_EMAILJS_PUBLIC_KEY_ICI';

   // ── GENRES ────────────────────────────────────────────────────────
  const PRENOMS_M = new Set([
    'aaron','adam','adrien','alexandre','alexis','alban','albert','ali','allan',
    'arnaud','arthur','aurelien','axel','ayoub','baptiste','benjamin','benoit',
    'bernard','boris','brice','bruno','cedric','charles','christophe','clement',
    'corentin','cyril','damien','daniel','david','denis','dorian','dylan',
    'edouard','emmanuel','eric','ethan','etienne','evan','felix','florian',
    'francois','frederic','gabriel','gabin','gautier','geoffrey','gerard',
    'gilles','guillaume','gustave','guy','henri','hugo','isaac','ivan','jack',
    'jean','jeremy','jerome','julien','kevin','kylian','laurent','leon',
    'leonard','liam','lionel','luca','lucas','ludovic','leo','loic','louis',
    'luka','mael','malo','marc','martin','mathieu','mathis','maxime','maxence',
    'mehdi','michael','michel','milan','morgan','nael','nathan','nicolas',
    'noah','noel','nolan','octave','olivier','oscar','paul','philippe','pierre',
    'rafael','raphael','regis','remi','renaud','rene','robin','romain','ruben',
    'samuel','sasha','sebastien','serge','simon','stanislas','stephane',
    'sylvain','tanguy','theo','thibault','thierry','thomas','timothee','tom',
    'tristan','ugo','valentin','victor','vincent','william','xavier','yann',
    'yannick','yves','zacharie','zinedine'
  ]);

  function detectGenre(prenom) {
    if (!prenom) return 'F';
    const p = prenom.trim().toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').split(/[\\s-]/)[0];
    if (PRENOMS_M.has(p)) return 'M';
    const l3=p.slice(-3),l2=p.slice(-2),l1=p.slice(-1);
    if (['ine','ene','ale','lle','tte','ise','ose','ane'].includes(l3)) return 'F';
    if (['ia','ea','na','la','ra','sa'].includes(l2)) return 'F';
    if (l1==='a' && p.length>3) return 'F';
    if (['el','en','on','an','in','us'].includes(l2)) return 'M';
    if (l1==='o' && p.length>3) return 'M';
    return 'F';
  }

  const CITATIONS = {
    F: [
      "Tu es plus forte que tu ne le crois, plus belle que tu ne le vois, et plus aimee que tu ne le sais.\\n\\nN'oublie pas qui tu es.",
      "Porter ce bijou, c'est porter un morceau de l'ame de quelqu'un qui croit en toi.\\n\\nN'oublie pas qui tu es.",
      "Elle croyait qu'elle pouvait, alors elle l'a fait.\\n\\nN'oublie pas qui tu es.",
      "Chaque jour est une nouvelle page. Ecris quelque chose qui vaut la peine d'etre lu.\\n\\nN'oublie pas qui tu es."
    ],
    M: [
      "Tu es plus fort que tu ne le crois, plus grand que tu ne le vois, et plus aime que tu ne le sais.\\n\\nN'oublie pas qui tu es.",
      "Porter ce bijou, c'est porter un morceau de l'ame de quelqu'un qui croit en toi.\\n\\nN'oublie pas qui tu es.",
      "Il croyait qu'il pouvait, alors il l'a fait.\\n\\nN'oublie pas qui tu es.",
      "Chaque jour est une nouvelle page. Ecris quelque chose qui vaut la peine d'etre lu.\\n\\nN'oublie pas qui tu es."
    ]
  };

  // ── CITATION IA SELON OCCASION + GENRE ────────────────────────────
  async function getMotivationIA(prenom, occasion, personalMessage) {
    const genre = detectGenre(prenom);
    const genreLabel = genre === 'M' ? 'masculin' : 'feminin';
    const key = prenom + '|' + (occasion||'') + '|' + genreLabel;
    if (state.cachedEtym && state.cachedEtym['motiv_'+key]) return state.cachedEtym['motiv_'+key];
    try {
      const context = occasion
        ? 'occasion: ' + occasion
        : (personalMessage ? 'message: ' + personalMessage.substring(0,100) : 'bijou offert en cadeau');
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          model:'claude-sonnet-4-20250514', max_tokens:120,
          system:'Tu es ALNAE Infinity, marque de bijoux haut de gamme. Ecris une citation inspirante de 1-2 phrases maximum, accordee au genre ('+genreLabel+'), en lien avec le contexte donne. Termine TOUJOURS par "N oublie pas qui tu es." Pas de guillemets, pas de markdown.',
          messages:[{role:'user', content:'Citation pour un bijou Confidente. Contexte: '+context+'. Prenom du destinataire: '+prenom+'. Genre: '+genreLabel}]
        })
      });
      const d = await r.json();
      const t = d.content?.[0]?.text?.trim();
      if (t) {
        if (!state.cachedEtym) state.cachedEtym = {};
        state.cachedEtym['motiv_'+key] = t;
        return t;
      }
    } catch(_) {}
    // Fallback si IA indisponible
    const list = CITATIONS[genre] || CITATIONS.F;
    return list[Math.floor(Math.random()*list.length)];
  }

  function getMotivation(prenom) {
    const list = CITATIONS[detectGenre(prenom)] || CITATIONS.F;
    return list[Math.floor(Math.random()*list.length)];
  }

  // Citation IA contextuelle — tient compte de l'occasion et du message
  async function fetchContextualMotivation(prenom, occasion, personalMessage) {
    const genre = detectGenre(prenom);
    const gLabel = genre === 'M' ? 'masculin' : 'feminin';
    const ctx = occasion ? 'Occasion: ' + occasion + '.' : '';
    const msgCtx = personalMessage ? 'Contexte du message: "' + personalMessage.slice(0,120) + '"' : '';
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514', max_tokens: 120,
          system: 'Tu es la voix poetique d ALNAE Infinity, marque de bijoux haut de gamme. Ecris UNE citation courte (2-3 phrases max) en lien avec l occasion et le bijou offert. Accorde au genre indique. Termine TOUJOURS par: N oublie pas qui tu es. Pas de guillemets, pas de markdown.',
          messages: [{ role: 'user', content: 'Prenom: ' + prenom + '. Genre: ' + gLabel + '. ' + ctx + ' ' + msgCtx + '. Ecris la citation inspirante.' }]
        })
      });
      const d = await r.json();
      const t = d.content?.[0]?.text;
      if (t) return t.replace(/\\*([^*]+)\\*/g,'$1').trim();
    } catch(_) {}
    return getMotivation(prenom);
  }

  // Suggestions IA aléatoires selon l'occasion
  async function fetchAISuggestions(occasion, prenom) {
    const genre = detectGenre(prenom||'');
    const gLabel = genre === 'M' ? 'masculin' : 'feminin';
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514', max_tokens: 400,
          system: 'Tu génères 3 textes courts (2-3 phrases chacun) pour accompagner un bijou offert. Chaque texte doit etre different, poetique, sincere. Genre: ' + gLabel + '. Reponds UNIQUEMENT en JSON valide: {"suggestions":["texte1","texte2","texte3"]}',
          messages: [{ role: 'user', content: 'Occasion: ' + occasion + '. Génère 3 messages de bijou differents.' }]
        })
      });
      const d = await r.json();
      const t = d.content?.[0]?.text;
      if (t) {
        const clean = t.replace(/\\u0060{3}json|\\u0060{3}/g,'').trim();
        const parsed = JSON.parse(clean);
        if (parsed.suggestions && parsed.suggestions.length >= 3) return parsed.suggestions;
      }
    } catch(_) {}
    return null;
  }

  // Citation IA contextuelle selon occasion + message + bijou
  async function fetchMotivationIA(prenom, occasion, personalMessage) {
    const genre = detectGenre(prenom);
    const contexte = [
      occasion ? 'Occasion: ' + occasion : '',
      personalMessage ? 'Ton du message: ' + personalMessage.substring(0, 100) : ''
    ].filter(Boolean).join('. ');
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514', max_tokens: 120,
          system: 'Tu es ALNAÉ Infinity, marque de bijoux premium. Génère UNE SEULE citation inspirante courte (max 2 phrases) pour accompagner un bijou offert. La citation doit être en lien avec le contexte fourni, accordée au genre (' + (genre==='M'?'masculin':'féminin') + '), poétique et se terminer par "N\\'oublie pas qui tu es." Pas de guillemets, pas de tirets.',
          messages:[{role:'user', content: 'Bijou offert pour: ' + prenom + '. ' + (contexte||'Occasion spéciale.')}]
        })
      });
      const d = await r.json();
      const t = d.content?.[0]?.text;
      if (t) return t.replace(/\\*([^*]+)\\*/g,'$1').trim();
    } catch(_) {}
    return getMotivation(prenom);
  }

  // ── SUGGESTIONS & CITATIONS PAR IA ──────────────────────────────
  // Cache pour ne pas rappeler l'IA deux fois pour le même thème
  const suggestionsCache = {};
  const citationsCache   = {};

  async function fetchSuggestionsIA(occasion, recipientName) {
    const key = (occasion + '|' + (recipientName||'')).toLowerCase();
    if (suggestionsCache[key]) return suggestionsCache[key];
    try {
      const genre = detectGenre(recipientName || '');
      const genreLabel = genre === 'M' ? 'masculin' : 'feminin';
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          system: "Tu es expert en messages pour bijoux haut de gamme. Reponds UNIQUEMENT avec un JSON valide. Format: {\\"suggestions\\":[\\"msg1\\",\\"msg2\\",\\"msg3\\"]}. 3 messages: 2-3 phrases max, poetiques, accordees au genre. Tutoiement. Pas de markdown.",
          messages: [{ role: 'user', content: 'Occasion: ' + occasion + '. Prenom destinataire: ' + (recipientName||'le destinataire') + ' (genre: ' + genreLabel + '). Genere 3 messages differents et inspirants pour accompagner un bijou offert pour cette occasion.' }]
        })
      });
      const d = await r.json();
      const t = d.content?.[0]?.text || '{}';
      const parsed = JSON.parse(t.replace(/\\u0060{3}json|\\u0060{3}/g,'').trim());
      if (parsed.suggestions && parsed.suggestions.length) {
        suggestionsCache[key] = parsed.suggestions;
        return parsed.suggestions;
      }
    } catch(_) {}
    // Fallback statique si IA indisponible
    return [
      "Ce bijou porte avec lui toute la gratitude que j'ai pour toi. Tu mérites ce qu'il y a de plus beau.",
      "Chaque fois que tu le porteras, souviens-toi que quelqu'un pense à toi avec beaucoup d'amour.",
      "Ce moment entre nous méritait quelque chose de précieux. Comme tu l'es pour moi."
    ];
  }

  async function fetchCitationIA(occasion, recipientName, personalMessage) {
    const key = (occasion + '|' + (recipientName||'') + '|' + (personalMessage||'').slice(0,30)).toLowerCase();
    if (citationsCache[key]) return citationsCache[key];
    try {
      const genre = detectGenre(recipientName || '');
      const genreLabel = genre === 'M' ? 'masculin' : 'feminin';
      const context = personalMessage
        ? 'Message personnel: "' + personalMessage.slice(0,200) + '"'
        : 'Occasion: ' + occasion;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 200,
          system: "Tu es ALNAE Infinity, marque de bijoux haut de gamme. Reponds avec un JSON. Format: {\\"citation\\":\\"...\\"} Une phrase poetique inspirante accordee au genre, en lien avec le bijou offert. Termine par: N\\'oublie pas qui tu es. Pas de markdown.",          messages: [{ role: 'user', content: context + '. Prenom: ' + (recipientName||'le destinataire') + ' (genre: ' + genreLabel + '). Bijou: collection Confidente ALNAE Infinity.' }]
        })
      });
      const d = await r.json();
      const t = d.content?.[0]?.text || '{}';
      const parsed = JSON.parse(t.replace(/\\u0060{3}json|\\u0060{3}/g,'').trim());
      if (parsed.citation) {
        citationsCache[key] = parsed.citation;
        return parsed.citation;
      }
    } catch(_) {}
    return getMotivation(recipientName || '');
  }

  async function renderSuggestions(occasion, recipientName) {
    const box  = g('suggestions-box');
    const list = g('suggestions-list');
    if (!box || !list) return;

    // Afficher spinner pendant le chargement IA
    box.style.display = 'block';
    list.innerHTML = '<div style="font-size:.7rem;color:var(--text-dim);padding:.5rem;text-align:center;">Génération des suggestions...</div>';

    const items = await fetchSuggestionsIA(occasion, recipientName);
    list.innerHTML = '';
    items.forEach(txt => {
      const row = document.createElement('div');
      row.className = 'sug-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.dataset.text = txt;
      const sp = document.createElement('span');
      sp.textContent = txt;
      row.appendChild(cb); row.appendChild(sp);
      cb.addEventListener('change', applySuggestions);
      sp.addEventListener('click', () => { cb.checked = !cb.checked; applySuggestions(); });
      list.appendChild(row);
    });
  }

  function applySuggestions() {
    const sel = Array.from(document.querySelectorAll('#suggestions-list input:checked')).map(cb => cb.dataset.text);
    if (!sel.length) return;
    const ta = g('message-input');
    ta.value = sel.join('\\n\\n');
    setText('char-count', String(ta.value.length));
    if (!toggleOn('tog-message')) {
      g('tog-message').checked = true;
      g('body-message').classList.add('open');
      g('block-message').classList.add('on');
    }
  }

  function getMotivation(prenom) {
    const list = CITATIONS[detectGenre(prenom)] || CITATIONS.F;
    return list[Math.floor(Math.random() * list.length)];
  }

  const SUGGESTIONS = {
    'Anniversaire': [
      "En ce jour si particulier, je voulais que tu saches a quel point tu comptes dans ma vie. Chaque annee te rend encore plus toi. Joyeux anniversaire.",
      "Tu merites ce bijou, comme tu merites tout ce que la vie a de plus beau. Avec tout mon amour.",
      "Le temps passe, mais ce qui ne change pas c'est la place que tu as dans mon coeur."
    ],
    'Amitié': [
      "Certaines personnes entrent dans ta vie et tu realises que tu ne peux plus imaginer sans elles. Tu es de celles-la.",
      "On dit que les vrais amis sont rares. Je suis si heureux/heureuse de t'avoir trouve(e).",
      "Ce bijou est un morceau de notre amitie. Porte-le quand tu as besoin de te sentir moins seul(e)."
    ],
    'Diplôme': [
      "Tu as travaille, tu as persevere, tu y es arrive(e). Ce diplome represente tout ce que tu peux accomplir.",
      "Felicitations. Que cette reussite soit le debut de tout ce que tu as reve de construire.",
      "Je t'ai regarde(e) avancer, douter parfois, mais jamais abandonner. Je suis fier/fiere de toi."
    ],
    'Fête des mères': [
      "Aucun bijou ne pourra exprimer tout ce que tu representes. J'espere qu'il te rappellera a quel point tu es aimee.",
      "Tu m'as appris a me lever quand je tombe, a aimer sans condition. Merci d'etre la mere/le parent que tu es.",
      "Pour celle/celui qui a tout donne sans jamais rien demander. Ce bijou est fait pour toi."
    ],
    'Encouragement': [
      "Je sais que ce n'est pas facile. Mais je connais ta force. Tu vas y arriver.",
      "Tu es capable, tu es fort(e), tu es exactement ou tu dois etre.",
      "Porte ce bijou comme un rappel que tu n'es jamais seul(e). Quelqu'un croit en toi."
    ],
    'Souvenir': [
      "Ce moment entre nous, je ne veux pas l'oublier. Voici quelque chose qui t'y ramenera.",
      "Les mots ne suffisent pas. Ce bijou porte notre souvenir.",
      "La ou les photos s'effacent et les mots se perdent, ce bijou restera."
    ],
    'Noël': [
      "En cette periode de lumieres, j'avais envie de t'offrir quelque chose qui te ressemble. Joyeux Noel.",
      "Noel, c'est le moment que je prefere pour dire les choses qu'on n'ose pas dire. Tu comptes enormement.",
      "Ce bijou est mon cadeau mais surtout un morceau de moi que je t'offre."
    ]
  };

  // ── ÉTAT ──────────────────────────────────────────────────────────
  const state = {
    verification: null, preview: null,
    messageRecord: null, currentOccasion: '',
    revealLookupCode: '', revealRecord: null, cachedEtym: {}
  };

  const mediaFiles = [];
  const MAX_FILES = 3, MAX_SIZE = 20*1024*1024;
  const ALLOWED_TYPES = ['image/jpeg','image/png','image/gif','image/webp',
    'video/mp4','video/quicktime','video/webm',
    'audio/mpeg','audio/wav','audio/mp4','audio/x-m4a','audio/ogg'];

  const g = id => document.getElementById(id);
  const norm = s => (s||'').trim().toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');
  const toggleOn = id => !!g(id)?.checked;

  function showPage(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    g(id)?.classList.add('active');
    window.scrollTo({top:0,behavior:'smooth'});
  }
  function setText(id,v){const e=g(id);if(e)e.textContent=v??'';}
  function setHtml(id,v){const e=g(id);if(e)e.innerHTML=v??'';}
  function setErr(id,show,text=''){const e=g(id);if(!e)return;if(text)e.textContent=text;e.classList.toggle('show',!!show);}
  function setInpErr(id,show){const e=g(id);if(e)e.classList.toggle('err',!!show);}
  function getPinValue(ids){return ids.map(id=>g(id)?.value||'').join('');}
  function bindToggle(lId,iId){g(lId)?.addEventListener('click',()=>{const cb=g(iId);if(cb)cb.checked=!cb.checked;});}

  function initPinNav(ids) {
    ids.forEach((id,i)=>{
      const el=g(id);if(!el)return;
      el.addEventListener('input',function(){this.value=this.value.replace(/[^0-9]/g,'');if(this.value&&i<ids.length-1)g(ids[i+1])?.focus();});
      el.addEventListener('keydown',function(e){if(e.key==='Backspace'&&!this.value&&i>0)g(ids[i-1])?.focus();});
    });
  }

  // ── SUPABASE : VÉRIFIER COMMANDE ──────────────────────────────────
  async function checkOrderInSupabase(orderNumber, firstName, lastName, email) {
    if (!isSupabaseReady()) return null;
    try {
      const { data, error } = await db
        .from('orders')
        .select('*')
        .eq('order_number', orderNumber.toUpperCase())
        .single();
      if (error || !data) return null;
      if (norm(firstName) !== norm(data.customer_first_name)) return null;
      if (norm(lastName)  !== norm(data.customer_last_name))  return null;
      return data;
    } catch(e) { return null; }
  }

  // ── SUPABASE : SAUVEGARDER MESSAGE ────────────────────────────────
  async function saveMessageToSupabase(record) {
    if (!isSupabaseReady()) return false;
    try {
      const { error } = await db.from('messages').insert({
        jewel_code:       record.jewelCode,
        order_number:     record.orderLabel,
        recipient_name:   record.recipientName,
        occasion:         record.occasion || null,
        personal_message: record.personalMessage || null,
        etymology_text:   record.etymologyText || null,
        motivation_text:  record.motivationText || null,
        sender_name:      record.senderFullName,
        sender_email:     record.email,
        pin_hash:         record.pin,
        impression_requested: record.impressionRequested || false,
        created_at:       new Date().toISOString()
      });
      return !error;
    } catch(e) { return false; }
  }

  // ── SUPABASE : RÉCUPÉRER MESSAGE ──────────────────────────────────
  async function getMessageFromSupabase(jewelCode) {
    if (!isSupabaseReady()) return null;
    try {
      const { data, error } = await db
        .from('messages')
        .select('*')
        .eq('jewel_code', jewelCode.toUpperCase())
        .single();
      if (error || !data) return null;
      return {
        recipientName:   data.recipient_name,
        occasion:        data.occasion,
        etymologyText:   data.etymology_text,
        personalMessage: data.personal_message,
        motivationText:  data.motivation_text,
        senderLine:      '- De la part de ' + (data.sender_name||'ALNAE Infinity'),
        pin:             data.pin_hash
      };
    } catch(e) { return null; }
  }

  // ── EMAILJS : ENVOYER CONFIRMATION ───────────────────────────────
  async function sendConfirmationEmail(record) {
    if (!isEmailJSReady()) {
      console.log('[DEMO] Email non envoye - configurez EmailJS');
      return false;
    }
    try {
      const params = {
        to_email:       record.email,
        to_name:        record.senderFullName,
        order_number:   record.orderLabel,
        jewel_code:     record.jewelCode,
        recipient_name: record.recipientName,
        occasion:       record.occasion || 'Non specifie',
        reveal_url:     CONFIG.storefrontPageUrl + '?code=' + record.jewelCode,
        alnae_email:    CONFIG.alnaEmail,
        date:           record.date
      };
      // Envoi à la cliente
      await emailjs.send(CONFIG.emailjsServiceId, CONFIG.emailjsTemplateId, params);
      // Copie à ALNAÉ
      await emailjs.send(CONFIG.emailjsServiceId, CONFIG.emailjsTemplateId, {
        ...params, to_email: CONFIG.alnaEmail, to_name: 'ALNAE Infinity'
      });
      return true;
    } catch(e) { console.warn('EmailJS erreur:', e); return false; }
  }

  // ── ÉTYMOLOGIE IA ─────────────────────────────────────────────────
  async function fetchEtymIA(prenom) {
    const key = norm(prenom);
    if (state.cachedEtym[key]) return state.cachedEtym[key];
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514', max_tokens: 350,
          system: 'Expert etymologie prenoms. 3 paragraphes poetiques separes par ligne vide. 1:racine linguistique. 2:personnalite accordee au genre. 3:phrase finale forte accordee au genre. Tutoiement. Pas de markdown.',
          messages:[{role:'user',content:'Etymologie poetique du prenom '+prenom+' (genre: '+(detectGenre(prenom)==='M'?'masculin':'feminin')+')'}]
        })
      });
      const d = await r.json();
      const t = d.content?.[0]?.text;
      if (t) { const c=t.replace(/\\*([^*]+)\\*/g,'$1').trim(); state.cachedEtym[key]=c; return c; }
    } catch(_) {}
    const gk = detectGenre(prenom);
    const fb = gk==='M'
      ? 'Le prenom '+prenom+' porte en lui la force de tous ceux qui l ont porte avant toi.\\n\\nIl incarne une energie noble et singuliere, celle d un homme qui trace sa voie avec conviction.\\n\\nPorte-le avec fierte. Il te ressemble.'
      : 'Le prenom '+prenom+' porte en lui la grace de toutes celles qui l ont porte avant toi.\\n\\nIl incarne une energie singuliere, celle d une femme qui avance avec elegance et conviction.\\n\\nPorte-le avec fierte. Il te ressemble.';
    state.cachedEtym[key]=fb; return fb;
  }

  // ── QR CODE ───────────────────────────────────────────────────────
  function generateQR(containerId, url, size) {
    const el = g(containerId);
    if (!el || typeof QRCode==='undefined') return;
    el.innerHTML = '';
    new QRCode(el,{text:url,width:size||120,height:size||120,colorDark:'#1C1408',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.H});
  }

  // ── CONFETTI ──────────────────────────────────────────────────────
  function launchConfetti() {
    const c=g('confetti'); if(!c)return; c.innerHTML='';
    for(let i=0;i<30;i++){
      const p=document.createElement('div'); p.className='cp';
      p.style.cssText='left:'+Math.random()*100+'vw;animation-duration:'+(Math.random()*2+1.5)+'s;animation-delay:'+(Math.random()*.8)+'s;width:'+(Math.random()*6+4)+'px;height:'+(Math.random()*6+4)+'px;background:'+(Math.random()>.5?'#8B6914':'#C8BAA0')+';border-radius:'+(Math.random()>.5?'50%':'0')+';';
      c.appendChild(p);
    }
    setTimeout(()=>{c.innerHTML='';},4000);
  }

  // ── SUGGESTIONS ───────────────────────────────────────────────────
  // Générer suggestions de texte via IA (aléatoires à chaque fois)
  async function fetchSuggestionsIA(occasion) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514', max_tokens: 600,
          system: 'Tu génères 3 suggestions de messages courts et sincères pour accompagner un bijou offert. Chaque suggestion fait 2-3 phrases max, style chaleureux et personnel. Réponds UNIQUEMENT avec un JSON valide: {"suggestions":["texte1","texte2","texte3"]}. Pas de markdown.',
          messages:[{role:'user', content:'Génère 3 suggestions variées et originales pour l\\'occasion: ' + occasion + '. Elles doivent être différentes des suggestions habituelles, vraiment personnelles et touchantes.'}]
        })
      });
      const d = await r.json();
      const t = d.content?.[0]?.text;
      if (t) {
        const clean = t.replace(/\\u0060{3}json|\\u0060{3}/g,'').trim();
        const parsed = JSON.parse(clean);
        if (parsed.suggestions && parsed.suggestions.length) return parsed.suggestions;
      }
    } catch(_) {}
    return null;
  }

  function renderSuggestionsFromList(items) {
    const box=g('suggestions-box'), list=g('suggestions-list');
    if(!box||!list||!items||!items.length){if(box)box.style.display='none';return;}
    list.innerHTML='';
    items.forEach(txt=>{
      const row=document.createElement('div'); row.className='sug-item';
      const cb=document.createElement('input'); cb.type='checkbox'; cb.dataset.text=txt;
      const sp=document.createElement('span'); sp.textContent=txt;
      row.appendChild(cb); row.appendChild(sp);
      cb.addEventListener('change',applySuggestions);
      sp.addEventListener('click',()=>{cb.checked=!cb.checked;applySuggestions();});
      list.appendChild(row);
    });
    box.style.display='block';
  }

  function renderSuggestions(occasion) {
    const box=g('suggestions-box'), list=g('suggestions-list');
    if(!box||!list) return;
    const prenom = g('recipient-name-input')?.value?.trim() || '';
    // Afficher les suggestions statiques immédiatement
    const fallback = SUGGESTIONS[occasion];
    if(fallback) renderSuggestionsFromList(fallback);
    else { box.style.display='none'; }
    // Puis charger des suggestions IA fraîches en arrière-plan
    if(occasion && occasion !== 'Autre') {
      list.innerHTML += '<div style="font-size:.62rem;color:var(--text-dim);padding:.4rem 0;font-style:italic;text-align:right;">✦ Génération de nouvelles suggestions…</div>';
      fetchAISuggestions(occasion, prenom).then(aiSugs => {
        if(aiSugs) renderSuggestionsFromList(aiSugs);
      });
    }
  }

  function applySuggestions() {
    const sel=Array.from(document.querySelectorAll('#suggestions-list input:checked')).map(cb=>cb.dataset.text);
    if(!sel.length)return;
    const ta=g('message-input'); ta.value=sel.join('\\n\\n');
    setText('char-count',String(ta.value.length));
    if(!toggleOn('tog-message')){g('tog-message').checked=true;g('body-message').classList.add('open');g('block-message').classList.add('on');}
  }

  // ── MÉDIAS ────────────────────────────────────────────────────────
  function getMediaIcon(type){return type.startsWith('image')?'Photo':type.startsWith('video')?'Video':'Audio';}
  function formatSize(b){return b<1024*1024?(b/1024).toFixed(1)+' Ko':(b/1024/1024).toFixed(1)+' Mo';}

  function renderMediaPreviews() {
    const cont=g('media-previews'); if(!cont)return;
    cont.innerHTML='';
    mediaFiles.forEach((file,idx)=>{
      const url=URL.createObjectURL(file);
      const item=document.createElement('div'); item.className='media-item';
      let inner=file.type.startsWith('image')?'<img src="'+(file._dataUrl||url)+'" class="media-item-preview" alt="'+file.name+'">'
        :'<span class="media-item-icon">'+getMediaIcon(file.type)+'</span>';
      item.innerHTML=inner+'<div class="media-item-info"><div class="media-item-name">'+file.name+'</div><div class="media-item-size">'+formatSize(file.size)+'</div>'+(file.type.startsWith('audio')?'<audio controls class="media-item-audio" src="'+url+'"></audio>':'')+'</div><button class="media-item-remove" data-idx="'+idx+'" type="button">X</button>';
      item.querySelector('.media-item-remove').addEventListener('click',function(){mediaFiles.splice(parseInt(this.dataset.idx),1);renderMediaPreviews();updateMediaDropZone();});
      cont.appendChild(item);
    });
  }

  function updateMediaDropZone(){
    const zone=g('media-drop-zone'),input=g('media-file-input');
    if(!zone||!input)return;
    const dis=mediaFiles.length>=MAX_FILES;
    zone.style.opacity=dis?'.5':'1'; zone.style.pointerEvents=dis?'none':'auto'; input.disabled=dis;
  }

  function handleMediaFiles(files){
    const errEl=g('media-error'); if(errEl)errEl.classList.remove('show');
    let hasErr=false;
    Array.from(files).forEach(file=>{
      if(mediaFiles.length>=MAX_FILES)return;
      if(file.size>MAX_SIZE||!ALLOWED_TYPES.includes(file.type)){hasErr=true;return;}
      if(!mediaFiles.find(f=>f.name===file.name&&f.size===file.size)){
        if(file.type.startsWith('image')){const r=new FileReader();r.onload=e=>{file._dataUrl=e.target.result;renderMediaPreviews();};r.readAsDataURL(file);}
        mediaFiles.push(file);
      }
    });
    if(hasErr&&errEl)errEl.classList.add('show');
    renderMediaPreviews(); updateMediaDropZone();
  }

  function renderMediaInPreview(){
    const block=g('prev-media-block'); if(!block)return;
    if(!mediaFiles.length){block.style.display='none';return;}
    block.style.display='block';
    block.innerHTML='<div style="font-size:.58rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gold-dim);margin-bottom:.6rem;">Medias joints</div>';
    mediaFiles.forEach(f=>{
      const url=URL.createObjectURL(f);
      if(f.type.startsWith('image')){const img=document.createElement('img');img.src=f._dataUrl||url;img.style.cssText='max-width:100%;max-height:200px;object-fit:contain;border:1px solid var(--obsidian-border);display:block;margin:.4rem 0;';block.appendChild(img);}
      else{const d=document.createElement('div');d.style.cssText='padding:.5rem;background:var(--obsidian-soft);border:1px solid var(--obsidian-border);margin:.3rem 0;font-size:.7rem;';d.textContent=getMediaIcon(f.type)+': '+f.name;if(f.type.startsWith('audio')){const au=document.createElement('audio');au.src=url;au.controls=true;au.style.cssText='width:100%;margin-top:.3rem;opacity:.8;';d.appendChild(au);}block.appendChild(d);}
    });
  }

  function renderMediaInReveal(files){
    const block=g('reveal-media-block');
    if(!block||!files||!files.length){if(block)block.style.display='none';return;}
    block.style.display='block';
    block.innerHTML='';
    files.forEach(f=>{
      const url=f._dataUrl||(f instanceof File?URL.createObjectURL(f):null);
      if(!url)return;
      const wrap=document.createElement('div');
      wrap.style.cssText='width:100%;margin-bottom:1rem;text-align:center;';
      if(f.type.startsWith('image')){
        const img=document.createElement('img');
        img.src=url;
        img.style.cssText='max-width:100%;max-height:320px;object-fit:contain;display:block;margin:0 auto;border:1px solid var(--obsidian-border);';
        wrap.appendChild(img);
      } else if(f.type.startsWith('video')){
        const vid=document.createElement('video');
        vid.src=url; vid.controls=true;
        vid.style.cssText='max-width:100%;max-height:280px;display:block;margin:0 auto;border:1px solid var(--obsidian-border);';
        wrap.appendChild(vid);
      } else if(f.type.startsWith('audio')){
        const lbl=document.createElement('div');
        lbl.style.cssText='font-size:.6rem;letter-spacing:.15em;text-transform:uppercase;color:var(--gold-dim);margin-bottom:.5rem;';
        lbl.textContent='Message vocal';
        wrap.appendChild(lbl);
        const au=document.createElement('audio');
        au.src=url; au.controls=true;
        au.style.cssText='width:100%;opacity:.85;';
        wrap.appendChild(au);
      }
      block.appendChild(wrap);
    });
    // Séparateur après les médias
    const sep=document.createElement('div');
    sep.className='diamond-sep'; sep.innerHTML='<span></span>';
    block.appendChild(sep);
  }

  // ── HTML TÉLÉCHARGEABLE ───────────────────────────────────────────
  function buildConfirmationHTML(d) {
    const esc=s=>(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const site='<div style="margin-top:5px"><a href="https://www.alnaeinfinity.com" style="color:#8B6914;text-decoration:none;font-size:11px">www.alnaeinfinity.com</a></div>';
    const eHtml=d.etymologyText?'<div style="background:#F0EBE0;border-left:2px solid #8B6914;padding:12px 16px;margin:12px 0"><p style="font-family:Georgia,serif;font-style:italic;color:#1C1408;font-size:14px;line-height:1.7;white-space:pre-wrap;margin:0">'+esc(d.etymologyText)+'</p></div>':'';
    const mHtml=d.personalMessage?'<div style="background:#F8F4EE;border:1px solid #C8BAA0;padding:18px;margin:10px 0;white-space:pre-wrap;font-style:italic;font-size:15px;line-height:1.8;font-family:Georgia,serif">'+esc(d.personalMessage)+'</div>':'';
    const motHtml=d.motivationText?'<div style="background:#1C1408;padding:12px 18px;margin:10px 0;text-align:center"><p style="font-family:Georgia,serif;font-style:italic;color:#F0EBE0;font-size:14px;line-height:1.7;margin:0;white-space:pre-wrap">'+esc(d.motivationText)+'</p></div>':'';
    const mediaHtml=mediaFiles.length?'<div style="margin:14px 0"><div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8B6914;margin-bottom:8px">Medias joints</div>'+mediaFiles.map(f=>f.type.startsWith('image')&&f._dataUrl?'<div style="margin:6px 0;text-align:center"><img src="'+f._dataUrl+'" style="max-width:100%;max-height:260px;border:1px solid #C8BAA0;" alt="'+f.name+'"></div>':'<div style="padding:5px 0;border-bottom:1px solid #C8BAA0;font-size:12px;">'+getMediaIcon(f.type)+': '+f.name+'</div>').join('')+'</div>':'';
    const carteHtml=d.jewelCode?'<div style="border:1px solid #C8BAA0;padding:14px;margin:14px 0;background:white"><div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#8B6914;text-align:center;margin-bottom:8px">ALNAE Infinity - Carte cadeau</div><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><div style="flex:1;font-size:12px;color:#1C1408;line-height:1.6;min-width:150px">Rendez-vous sur <strong>www.alnaeinfinity.com/pages/confidente</strong> et saisissez le code ci-contre.</div><div style="text-align:center"><div style="font-size:9px;color:#8A7A60;margin-bottom:3px">Code du bijou</div><div style="background:#1C1408;color:#8B6914;padding:6px 12px;font-family:monospace;font-size:14px;letter-spacing:3px">'+esc(d.jewelCode)+'</div></div></div></div>':'';
    return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Confirmation ALNAE</title><style>body{font-family:Georgia,serif;background:#F2EDE3;padding:40px}.w{max-width:560px;margin:0 auto;background:#FDFAF5;border:1px solid #C8BAA0;padding:44px}.l{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8A7A60;font-family:Arial,sans-serif;margin-bottom:3px}.v{font-size:15px;margin-bottom:14px;color:#1C1408}.c{background:#1C1408;color:#8B6914;padding:14px;text-align:center;font-family:monospace;font-size:18px;letter-spacing:4px;margin:14px 0}.a{background:#F0EBE0;border:1px solid #C8BAA0;padding:12px;margin:14px 0;font-size:13px;line-height:1.6}.f{text-align:center;margin-top:28px;font-size:11px;color:#8A7A60;letter-spacing:2px;border-top:1px solid #C8BAA0;padding-top:14px}</style></head><body><div class="w"><div style="text-align:center;margin-bottom:28px"><div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#8B6914;margin-bottom:7px">ALNAE Infinity</div><h1 style="font-size:24px;font-weight:400;font-style:italic;font-family:Georgia,serif;color:#1C1408;margin:0">Confirmation - Collection Confidente</h1></div><div class="l">Date</div><div class="v">'+esc(d.date||'')+'</div><div class="l">Expediteur</div><div class="v">'+esc(d.senderFullName||'')+'</div><div class="l">Email</div><div class="v">'+esc(d.email||'')+'</div><div class="l">Commande</div><div class="v">'+esc(d.orderLabel||'')+'</div><div class="l">Destinataire</div><div class="v">'+esc(d.recipientName||'')+'</div>'+(d.occasion?'<div class="l">Occasion</div><div class="v">'+esc(d.occasion)+'</div>':'')+(d.impressionRequested?'<div class="a">Impression demandee - ALNAE Infinity preparera la carte.</div>':'')+'<div class="l">Code du bijou</div><div class="c">'+esc(d.jewelCode||'')+'</div><div class="a">Imprimez la carte ci-dessous et glissez-la dans le paquet. Le destinataire saisira le code du bijou puis son code confidentiel.</div>'+carteHtml+'<div class="l" style="margin-top:16px">Message</div>'+eHtml+mHtml+motHtml+mediaHtml+'<div class="f">ALNAE Infinity - Collection Confidente'+site+'commande.alnae@gmail.com</div></div></body></html>';
  }

  function buildRevealHTML(d) {
    const esc=s=>(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const site='<div style="margin-top:5px"><a href="https://www.alnaeinfinity.com" style="color:#8B6914;text-decoration:none;font-size:11px">www.alnaeinfinity.com</a></div>';
    const eHtml=d.etymologyText?'<div style="background:#F0EBE0;border-left:2px solid #8B6914;padding:12px 16px;margin:12px 0"><p style="font-family:Georgia,serif;font-style:italic;color:#1C1408;font-size:14px;line-height:1.7;white-space:pre-wrap;margin:0">'+esc(d.etymologyText)+'</p></div>':'';
    const mHtml=d.personalMessage?'<div style="background:#F8F4EE;border:1px solid #C8BAA0;padding:20px;text-align:left;white-space:pre-wrap;font-style:italic;font-size:15px;line-height:1.8;font-family:Georgia,serif">'+esc(d.personalMessage)+'</div>':'';
    const motHtml=d.motivationText?'<div style="background:#1C1408;padding:14px 20px;margin:10px 0;text-align:center"><p style="font-family:Georgia,serif;font-style:italic;color:#F0EBE0;font-size:14px;line-height:1.7;margin:0;white-space:pre-wrap">'+esc(d.motivationText)+'</p></div>':'';
    const occHtml=d.occasion?'<div style="display:inline-block;border:1px solid #8B6914;padding:3px 14px;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#8B6914;margin-bottom:12px">'+esc(d.occasion)+'</div><br>':'';
    return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Mon message ALNAE</title><style>body{font-family:Georgia,serif;background:#F2EDE3;padding:40px}.w{max-width:540px;margin:0 auto;background:#FDFAF5;border:1px solid #C8BAA0;padding:44px;text-align:center}.n{font-size:30px;font-weight:400;font-style:italic;color:#1C1408;margin:0 0 8px;font-family:Georgia,serif}.s{color:#C8BAA0;letter-spacing:8px;margin:14px 0}.fr{font-size:12px;color:#8A7A60;font-style:italic;text-align:right;margin-top:10px}.f{margin-top:26px;font-size:10px;color:#8A7A60;letter-spacing:2px;text-transform:uppercase;border-top:1px solid #C8BAA0;padding-top:12px}</style></head><body><div class="w"><div style="font-size:10px;letter-spacing:4px;text-transform:uppercase;color:#8B6914;margin-bottom:10px">ALNAE Infinity</div>'+occHtml+'<p class="n">'+esc(d.recipientName||'')+'</p><div class="s">o o o</div>'+eHtml+'<div style="text-align:left">'+mHtml+motHtml+'</div><div class="fr">'+esc(d.senderLine||'- ALNAE Confidente')+'</div><div class="s">o</div><div class="f">ALNAE Infinity - Collection Confidente'+site+'</div></div></body></html>';
  }

  function downloadHTML(html,filename){const b=new Blob([html],{type:'text/html;charset=utf-8'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=filename;document.body.appendChild(a);a.click();document.body.removeChild(a);URL.revokeObjectURL(u);}

  // ── VÉRIFICATION COMMANDE ─────────────────────────────────────────
  async function verifyOrder() {
    const orderNumber=g('order-number').value.trim();
    const firstName=g('auth-firstname').value.trim();
    const lastName=g('auth-lastname').value.trim();
    const email=g('auth-email').value.trim();
    const rgpd=g('rgpd-auth').checked;
    let ok=true;
    setErr('auth-error',false,'');
    setErr('err-order',!orderNumber);    setInpErr('order-number',!orderNumber);    if(!orderNumber)ok=false;
    setErr('err-firstname',!firstName);  setInpErr('auth-firstname',!firstName);    if(!firstName)ok=false;
    setErr('err-lastname',!lastName);    setInpErr('auth-lastname',!lastName);      if(!lastName)ok=false;
    const emailOk=email&&/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
    setErr('err-email',!emailOk);        setInpErr('auth-email',!emailOk);          if(!emailOk)ok=false;
    setErr('err-rgpd',!rgpd);            if(!rgpd)ok=false;
    if(!ok)return;
    const btn=g('btn-verify');
    btn.disabled=true; btn.textContent='VERIFICATION...';
    try {
      // 1. Essayer Supabase
      let order = await checkOrderInSupabase(orderNumber, firstName, lastName, email);
      if (order) {
        state.verification = {
          sessionToken:'SUPA_'+Date.now(), orderNumber:order.order_number,
          orderLabel:order.order_number, displayName:firstName+' '+lastName,
          email, customerFirstName:firstName, customerLastName:lastName,
          bijouCode:order.jewel_code
        };
      } else {
        // 2. Fallback mode démo
        const key=orderNumber.replace('#','').toUpperCase();
        const demoKey=Object.keys(DEMO_ORDERS).find(k=>k===key||k.endsWith('-'+key));
        const demoOrder=demoKey?DEMO_ORDERS[demoKey]:null;
        if(!demoOrder||norm(firstName)!==demoOrder.prenom||norm(lastName)!==demoOrder.nom) {
          throw new Error('Commande introuvable. Verifiez vos informations.');
        }
        await new Promise(r=>setTimeout(r,500));
        state.verification = {
          sessionToken:'DEMO_'+Date.now(), orderNumber:demoKey,
          orderLabel:demoKey, displayName:firstName+' '+lastName,
          email, customerFirstName:firstName, customerLastName:lastName,
          bijouCode:demoOrder.bijouCode
        };
      }
      setText('verified-name-display',state.verification.displayName+' - '+state.verification.orderLabel);
      // 🔥 GESTION DES SLOTS MULTIPLES
if (order.slots && order.slots.length > 1) {

  // stocker les slots
  state.slots = order.slots;

  // afficher la liste
  const container = g('slots-list');
  container.innerHTML = '';

  order.slots.forEach(slot => {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = slot.jewelCode;

    btn.onclick = () => {
      state.selectedSlot = slot.jewelCode;
      state.verification.bijouCode = slot.jewelCode;
      showPage('page-form');
    };

    container.appendChild(btn);
  });

  showPage('page-slots');

} else {

  // 1 seul bijou → comportement normal
  const singleSlot = order.slots?.[0];
  if (singleSlot) {
    state.verification.bijouCode = singleSlot.jewelCode;
  }

  showPage('page-pin');
}
    } catch(error) {
      const el=g('auth-error');
      if(el){el.textContent=error.message||'Informations incorrectes.';el.classList.add('show');}
    } finally {
      btn.disabled=false; btn.textContent='VERIFIER MA COMMANDE';
    }
  }

  // ── PIN ───────────────────────────────────────────────────────────
  function validatePinStep(){
    const pin=getPinValue(['pin1','pin2','pin3','pin4']);
    const pinb=getPinValue(['pin1b','pin2b','pin3b','pin4b']);
    if(pin.length!==4){setErr('err-pin',true);return;}
    setErr('err-pin',false);
    if(pin!==pinb){setErr('err-pin-confirm',true);return;}
    setErr('err-pin-confirm',false);
    state.verification.pin=pin;
    showPage('page-form');
  }

  // ── PRÉVISUALISATION ──────────────────────────────────────────────
  async function buildPreview(){
    const recipientName=g('recipient-name-input').value.trim();
    const rgpdMsg=g('rgpd-msg').checked;
    const hasOcc=toggleOn('tog-occasion'),hasMsg=toggleOn('tog-message');
    const hasEtym=toggleOn('tog-etym'),hasMotiv=toggleOn('tog-motiv');
    const message=g('message-input').value.trim();
    let ok=true;
    setErr('err-recipient',!recipientName);setInpErr('recipient-name-input',!recipientName);if(!recipientName)ok=false;
    setErr('err-rgpd-msg',!rgpdMsg);if(!rgpdMsg)ok=false;
    if(!hasOcc&&!hasMsg&&!hasEtym&&!hasMotiv){setErr('form-error',true);ok=false;}else{setErr('form-error',false);}
    if(hasOcc&&!state.currentOccasion){setErr('err-occasion',true);ok=false;}else{setErr('err-occasion',false);}
    if(hasMsg&&!message){setErr('err-message',true);setInpErr('message-input',true);ok=false;}else{setErr('err-message',false);setInpErr('message-input',false);}
    if(!ok)return;
    const occasion=hasOcc?(state.currentOccasion==='Autre'?(g('autre-text').value.trim()||'Autre'):state.currentOccasion):'';
    const btn=g('btn-preview-msg');
    btn.disabled=true; btn.textContent='PREPARATION...';
    g('prev-loading').classList.add('show');
    g('prev-etym').style.display='none';
    g('prev-msg-block').style.display='none';
    g('prev-motiv-block').style.display='none';
    g('preview-overlay').classList.add('show');
    setText('prev-name',recipientName);
    if(occasion){setText('prev-occasion',occasion);g('prev-occ-wrap').style.display='block';}
    else{g('prev-occ-wrap').style.display='none';}
    setText('prev-from','- De la part de '+state.verification.customerFirstName);
    renderMediaInPreview();
    try {
      let etymologyText=null,motivationText=null;
      if(hasEtym)etymologyText=await fetchEtymIA(recipientName);
      if(hasMotiv)motivationText=await fetchMotivationIA(recipientName, occasion, hasMsg?message:null);
      state.preview={
        previewToken:'PREV_'+Date.now(), recipientName, occasion,
        etymologyText, personalMessage:hasMsg?message:null,
        motivationText, senderLine:'- De la part de '+state.verification.customerFirstName
      };
      if(state.preview.etymologyText){setText('prev-etym-text',state.preview.etymologyText);g('prev-etym').style.display='block';}
      if(state.preview.personalMessage){setText('prev-message',state.preview.personalMessage);g('prev-msg-block').style.display='block';}
      if(state.preview.motivationText){setText('prev-motiv-text',state.preview.motivationText);g('prev-motiv-block').style.display='block';}
    } catch(error){
      g('preview-overlay').classList.remove('show');
      setErr('form-error',true,error.message||"Erreur lors de la preparation.");
    } finally {
      g('prev-loading').classList.remove('show');
      btn.disabled=false; btn.textContent='PREVISUALISER LE MESSAGE';
    }
  }

  function closePreview(){g('preview-overlay').classList.remove('show');}

  // ── SCELLEMENT ────────────────────────────────────────────────────
  async function sealMessage(){
    if(!state.preview||!state.verification?.sessionToken||!state.verification?.pin)return;
    const btn=g('btn-confirm-seal');
    btn.disabled=true; btn.textContent='SCELLEMENT...';
    try {
      await new Promise(r=>setTimeout(r,600));
      const qrUrl=CONFIG.storefrontPageUrl+'?code='+(state.verification.bijouCode||'CONF-DEMO');
      const record={
        jewelCode:state.verification.bijouCode||'CONF-DEMO',
        revealUrl:qrUrl,
        impressionRequested:g('opt-impression').checked,
        recipientName:state.preview.recipientName,
        occasion:state.preview.occasion,
        etymologyText:state.preview.etymologyText,
        personalMessage:state.preview.personalMessage,
        motivationText:state.preview.motivationText,
        senderLine:state.preview.senderLine,
        senderFullName:state.verification.displayName,
        email:state.verification.email,
        orderLabel:state.verification.orderLabel,
        pin:state.verification.pin,
        date:new Date().toLocaleDateString('fr-FR',{year:'numeric',month:'long',day:'numeric'})
      };
      // Sauvegarder dans Supabase si disponible
      if(isSupabaseReady()) await saveMessageToSupabase(record);

      // Envoyer les emails si EmailJS configuré
      const emailSent=await sendConfirmationEmail(record);

      state.messageRecord=record;
      setText('carte-code-display',record.jewelCode||'-');
      setText('qr-url-display',record.revealUrl||'');
      generateQR('qrcode-container',record.revealUrl,140);
      generateQR('carte-qr-mini',record.revealUrl,60);
      g('impression-notice').style.display=record.impressionRequested?'block':'none';

      // Afficher statut email
      const emailStatus=g('email-status');
      if(emailStatus){
        emailStatus.style.display='block';
        emailStatus.textContent=emailSent
          ? 'Email de confirmation envoye a '+record.email+' - Une copie a ete envoyee a ALNAE Infinity.'
          : 'Telechargez la confirmation ci-dessous et envoyez-la manuellement.';
        emailStatus.className='email-status '+(emailSent?'sent':'pending');
      }
      closePreview(); launchConfetti(); showPage('page-success');
    } catch(error){
      setErr('form-error',true,error.message||'Erreur lors du scellement.');
      closePreview();
    } finally {
      btn.disabled=false; btn.textContent='CONFIRMER ET SCELLER';
    }
  }

  // ── DÉCOUVRIR ─────────────────────────────────────────────────────
  async function discoverStep1(){
    const jewelCode=g('discover-code').value.trim();
    if(!jewelCode){setErr('err-discover',true);return;}
    setErr('err-discover',false);
    const btn=g('btn-discover');
    btn.disabled=true; btn.textContent='VERIFICATION...';
    try {
      await new Promise(r=>setTimeout(r,400));
      const cu=jewelCode.toUpperCase();
      // Vérifier dans Supabase d'abord
      let found=false;
      if(isSupabaseReady()){
        const msg=await getMessageFromSupabase(cu);
        if(msg){found=true;}
      }
      // Fallback : vérifier si c'est un code démo ou le code sauvegardé
      if(!found){
        const validDemo=Object.values(DEMO_ORDERS).some(o=>o.bijouCode===cu);
        const validSaved=state.messageRecord?.jewelCode===cu;
        if(!validDemo&&!validSaved&&!cu.startsWith('CONF-'))throw new Error('Code introuvable. Verifiez la carte jointe au bijou.');
      }
      state.revealLookupCode=cu;
      g('pin-check-error')?.classList.remove('show');
      showPage('page-pin-check');
    } catch(error){
      setErr('err-discover',true,error.message||'Code introuvable.');
    } finally {
      btn.disabled=false; btn.textContent='CONTINUER';
    }
  }

  async function discoverStep2(){
    const pin=getPinValue(['check1','check2','check3','check4']);
    if(pin.length!==4){setErr('err-pin-check',true);return;}
    setErr('err-pin-check',false);
    setErr('pin-check-error',false,'');
    const btn=g('btn-pin-check');
    btn.disabled=true; btn.textContent='OUVERTURE...';
    try {
      await new Promise(r=>setTimeout(r,500));
      let data=null;
      // 1. Chercher dans Supabase
      if(isSupabaseReady()){
        const msg=await getMessageFromSupabase(state.revealLookupCode);
        if(msg&&msg.pin===pin)data=msg;
        else if(msg&&msg.pin!==pin)throw new Error('Code incorrect. Verifiez la carte jointe au bijou.');
      }
      // 2. Fallback : message en mémoire
      if(!data&&state.messageRecord?.jewelCode===state.revealLookupCode){
        if(pin!==state.verification?.pin)throw new Error('Code incorrect.');
        data=state.messageRecord;
      }
      // 3. Démo
      if(!data){
        if(pin!=='1234')throw new Error('Code incorrect. Pour le test utilisez 1234.');
        data={recipientName:'Destinataire',occasion:'Message special',personalMessage:"Ce bijou a ete cree avec amour pour toi.\\n\\nChaque fois que tu le porteras, souviens-toi que tu comptes enormement.",etymologyText:null,motivationText:null,senderLine:'- ALNAE Confidente'};
      }
      state.revealRecord=data;
      renderReveal(data);
      showPage('page-reveal');
    } catch(error){
      const el=g('pin-check-error');
      if(el){el.textContent=error.message||'Code incorrect.';el.classList.add('show');}
    } finally {
      btn.disabled=false; btn.textContent='REVELER MON MESSAGE';
    }
  }

  function renderReveal(data){
    setText('reveal-name',data.recipientName||'');
    if(data.occasion){setText('reveal-occasion',data.occasion);g('reveal-occ-wrap').style.display='block';}else{g('reveal-occ-wrap').style.display='none';}
    if(data.etymologyText){setText('reveal-etym-text',data.etymologyText);g('reveal-etym').style.display='block';}else{g('reveal-etym').style.display='none';}
    if(data.personalMessage){setText('reveal-message',data.personalMessage);g('reveal-msg-block').style.display='block';}else{g('reveal-msg-block').style.display='none';}
    if(data.motivationText){setText('reveal-motiv-text',data.motivationText);g('reveal-motiv-block').style.display='block';}else{g('reveal-motiv-block').style.display='none';}
    setText('reveal-from',data.senderLine||'- ALNAE Confidente');
    g('reveal-loading')?.classList.remove('show');
    renderMediaInReveal(mediaFiles);
  }

  function prefillFromQuery(){
    const params=new URLSearchParams(window.location.search);
    const code=params.get('code');
    if(code){if(g('discover-code'))g('discover-code').value=code;showPage('page-decouvrir');}
  }

  function shareReveal(){
    const name=g('reveal-name')?.textContent||'';
    const d={title:'ALNAE Confidente',text:(name?name+' a recu':'J ai recu')+' un message dans son bijou ALNAE Infinity',url:CONFIG.storefrontPageUrl};
    if(navigator.share&&navigator.canShare?.(d)){navigator.share(d).catch(()=>{});}
    else if(navigator.clipboard?.writeText){navigator.clipboard.writeText(d.text+'\\n'+d.url).then(()=>alert('Copie! '+d.url)).catch(()=>prompt('Lien:',d.url));}
    else{prompt('Lien:',d.url);}
  }

  function initMediaBlock(){
    const input=g('media-file-input'),zone=g('media-drop-zone');
    if(!input||!zone)return;
    input.addEventListener('change',function(){handleMediaFiles(this.files);this.value='';});
    zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('drag-over');});
    zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));
    zone.addEventListener('drop',e=>{e.preventDefault();zone.classList.remove('drag-over');handleMediaFiles(e.dataTransfer.files);});
    g('tog-media')?.addEventListener('change',function(){g('body-media')?.classList.toggle('open',this.checked);g('block-media')?.classList.toggle('on',this.checked);if(!this.checked){mediaFiles.length=0;renderMediaPreviews();updateMediaDropZone();}});
  }

  // ── INIT ──────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function(){
    initSupabase();
    initEmailJS();

    bindToggle('lbl-rgpd-auth','rgpd-auth');
    bindToggle('lbl-rgpd-msg','rgpd-msg');
    bindToggle('lbl-impression','opt-impression');
    initPinNav(['pin1','pin2','pin3','pin4']);
    initPinNav(['pin1b','pin2b','pin3b','pin4b']);
    initPinNav(['check1','check2','check3','check4']);

    document.querySelectorAll('.pill[data-occasion]').forEach(function(pill){
      pill.addEventListener('click',function(){
        document.querySelectorAll('.pill[data-occasion]').forEach(function(p){p.classList.remove('active');});
        pill.classList.add('active');
        state.currentOccasion=pill.dataset.occasion||'';
        setErr('err-occasion',false);
        if(g('autre-field'))g('autre-field').style.display=state.currentOccasion==='Autre'?'block':'none';
        renderSuggestions(state.currentOccasion, g('recipient-name-input')?.value?.trim() || '');
      });
    });

    [['tog-occasion','body-occasion','block-occasion'],['tog-message','body-message','block-message'],['tog-etym','body-etym','block-etym'],['tog-motiv','body-motiv','block-motiv']].forEach(function(t){
      g(t[0])?.addEventListener('change',function(){g(t[1])?.classList.toggle('open',this.checked);g(t[2])?.classList.toggle('on',this.checked);});
    });

    g('message-input')?.addEventListener('input',function(){setText('char-count',String(this.value.length));});
    // Onglets navigation
    g('tab-deposer')?.addEventListener('click', function() {
      g('tab-deposer').classList.add('active');
      g('tab-decouvrir').classList.remove('active');
      if (state.messageRecord) showPage('page-success');
      else if (state.verification?.sessionToken) showPage('page-form');
      else showPage('page-accueil');
    });
    g('tab-decouvrir')?.addEventListener('click', function() {
      g('tab-decouvrir').classList.add('active');
      g('tab-deposer').classList.remove('active');
      showPage('page-decouvrir');
    });
    g('btn-home-title')?.addEventListener('click', function() { showPage('page-accueil'); });
    g('logo-home')?.addEventListener('click',function(){showPage('page-accueil');});
    // Titre cliquable → accueil
    g('btn-home-title')?.addEventListener('click', function() {
      g('tab-deposer').classList.add('active');
      g('tab-decouvrir').classList.remove('active');
      showPage('page-accueil');
    });
    g('btn-accueil-deposer')?.addEventListener('click',function(){
      g('tab-deposer').classList.add('active');
      g('tab-decouvrir').classList.remove('active');
      showPage('page-auth');
    });
    g('btn-accueil-decouvrir')?.addEventListener('click',function(){showPage('page-decouvrir');});
    g('btn-verify')?.addEventListener('click',verifyOrder);
    g('btn-pin-next')?.addEventListener('click',validatePinStep);
    g('btn-preview-msg')?.addEventListener('click',buildPreview);
    g('btn-close-preview')?.addEventListener('click',closePreview);
    g('btn-back-edit')?.addEventListener('click',closePreview);
    g('btn-confirm-seal')?.addEventListener('click',sealMessage);
    g('preview-overlay')?.addEventListener('click',function(e){if(e.target===g('preview-overlay'))closePreview();});
    g('btn-discover')?.addEventListener('click',discoverStep1);
    g('btn-pin-check')?.addEventListener('click',discoverStep2);

    g('btn-dl-confirm')?.addEventListener('click',function(){
      if(!state.messageRecord)return;
      downloadHTML(buildConfirmationHTML(state.messageRecord),'alnae-confirmation-'+state.messageRecord.jewelCode+'.html');
    });
    g('btn-go-reveal')?.addEventListener('click',function(){
      if(!state.preview)return;
      renderReveal({recipientName:state.preview.recipientName,occasion:state.preview.occasion,etymologyText:state.preview.etymologyText,personalMessage:state.preview.personalMessage,motivationText:state.preview.motivationText,senderLine:state.preview.senderLine});
      showPage('page-reveal');
    });
    g('btn-dl-msg')?.addEventListener('click',function(){
      const data=state.revealRecord||state.preview;
      if(!data)return;
      downloadHTML(buildRevealHTML(data),'alnae-message-confidente.html');
    });
    g('btn-share')?.addEventListener('click',shareReveal);
    initMediaBlock();
    prefillFromQuery();
  });

})();
</script>

</body>
</html>`);
});

app.post("/verify-order", (req, res) => {
  const { orderNumber, firstName, lastName, email } = req.body;

  if (!orderNumber || !firstName || !lastName) {
    return res.status(400).json({ message: "Champs manquants." });
  }

  const key = normalize(String(orderNumber).replace("#",""));
  const order = orders.get(key);

  if (
    order &&
    normalize(order.firstName) === normalize(firstName) &&
    normalize(order.lastName) === normalize(lastName)
  ) {
    const availableSlots = [...slots.values()].filter(
      s =>
        normalize(s.orderNumber.replace("#","")) === key &&
        s.status === "available"
    );

    return res.json({
      sessionToken: genToken(),
      orderNumber: order.orderNumber,
      orderLabel: order.orderNumber,
      email: order.email || email || "",
      slots: availableSlots.map(s => ({
        jewelCode: s.jewelCode
      }))
    });
  }

  const test = TEST.find(
    t =>
      normalize(t.orderNumber.replace("#","")) === key &&
      normalize(t.firstName) === normalize(firstName) &&
      normalize(t.lastName) === normalize(lastName)
  );

  if (test) {
    return res.json({
      sessionToken: genToken(),
      orderNumber: test.orderNumber,
      orderLabel: test.orderNumber,
      email: email || "",
      slots: [{ jewelCode: test.bijouCode }]
    });
  }

  return res.status(404).json({
    message: "Commande introuvable. Vérifiez votre numéro de commande, prénom et nom."
  });
});

app.post("/preview-message", (req, res) => {
  const { sessionToken, recipientName } = req.body;

  if (!sessionToken || !recipientName) {
    return res.status(400).json({ message: "Données manquantes." });
  }

  return res.json({
    previewToken: genToken(),
    recipientName,
    occasion: req.body.occasion || "",
    personalMessage: req.body.personalMessage || null,
    etymologyText: null,
    motivationText: null,
    senderLine: "— De la part de " + (req.body.senderFirstName || "")
  });
});

app.post("/seal-message", (req, res) => {
  const {
    sessionToken,
    pin,
    jewelCode,
    recipientName,
    occasion,
    personalMessage,
    etymologyText,
    motivationText,
    senderLine,
    impressionRequested
  } = req.body;

  if (!sessionToken || !pin || !jewelCode) {
    return res.status(400).json({ message: "Données manquantes." });
  }

  const slot = [...slots.values()].find(s => s.jewelCode === jewelCode);

  if (slot) {
    slot.status = "sealed";
    slot.sealedAt = new Date().toISOString();
  }

  messages.set(jewelCode, {
    jewelCode,
    pin,
    recipientName,
    occasion: occasion || null,
    personalMessage: personalMessage || null,
    etymologyText: etymologyText || null,
    motivationText: motivationText || null,
    senderLine: senderLine || "— ALNAÉ Confidente",
    impressionRequested: impressionRequested || false,
    createdAt: new Date().toISOString()
  });

  console.log("[SEAL]", jewelCode, "—", recipientName);

  return res.json({
    jewelCode,
    revealUrl: STOREFRONT_URL + "?code=" + jewelCode,
    impressionRequested: impressionRequested || false,
    qrSvg: null,
    qrMiniSvg: null
  });
});

app.post("/start-reveal", (req, res) => {
  const { jewelCode } = req.body;

  if (!jewelCode) {
    return res.status(400).json({ message: "Code manquant." });
  }

  const code = String(jewelCode).toUpperCase();

  if (!messages.has(code)) {
    return res.status(404).json({
      message: "Code introuvable. Vérifiez la carte jointe au bijou."
    });
  }

  return res.json({ jewelCode: code });
});

app.post("/reveal-message", (req, res) => {
  const { jewelCode, pin } = req.body;

  if (!jewelCode || !pin) {
    return res.status(400).json({ message: "Données manquantes." });
  }

  const code = String(jewelCode).toUpperCase();
  const msg = messages.get(code);

  if (!msg) {
    return res.status(404).json({ message: "Message introuvable." });
  }

  if (msg.pin !== pin) {
    return res.status(401).json({
      message: "Code incorrect. Vérifiez la carte jointe au bijou."
    });
  }

  return res.json({
    recipientName: msg.recipientName,
    occasion: msg.occasion,
    etymologyText: msg.etymologyText,
    personalMessage: msg.personalMessage,
    motivationText: msg.motivationText,
    senderLine: msg.senderLine
  });
});

app.listen(port, () => {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ALNAÉ Confidente — Serveur démarré");
  console.log("  Port    :", port);
  console.log("  Webhook : " + BASE_URL + "/webhook/shopify");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});
