const path = require("path");
const express = require("express");
const https   = require("https");
const app     = express();
const port    = process.env.PORT || 10000;

const BASE_URL     = process.env.BASE_URL     || "https://alnae-confidente-1.onrender.com";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "ALNAE-ADMIN-2026";
const ALNAE_EMAIL  = process.env.ALNAE_EMAIL  || "commande.alnae@gmail.com";
const SENDGRID_KEY = process.env.SENDGRID_KEY || "";

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const orders   = new Map();
const codes    = new Map();
const messages = new Map();

function checkAdmin(req, res) {
  const secret = req.body?.adminSecret || req.query?.secret;
  if (secret !== ADMIN_SECRET) { res.status(401).json({ message: "Accès non autorisé." }); return false; }
  return true;
}

function sendEmail(to, subject, htmlBody) {
  if (!SENDGRID_KEY) { console.log("[EMAIL] SendGrid non configuré. Destinataire :", to); return Promise.resolve(false); }
  return new Promise((resolve) => {
    const payload = JSON.stringify({ personalizations:[{to:[{email:to}]}], from:{email:ALNAE_EMAIL,name:"ALNAÉ Infinity"}, subject, content:[{type:"text/html",value:htmlBody}] });
    const opts = { hostname:"api.sendgrid.com", path:"/v3/mail/send", method:"POST", headers:{"Authorization":"Bearer "+SENDGRID_KEY,"Content-Type":"application/json","Content-Length":Buffer.byteLength(payload)} };
    const r = https.request(opts, res => resolve(res.statusCode === 202));
    r.on("error", () => resolve(false)); r.write(payload); r.end();
  });
}

function buildGravureEmail(msg, orderNumber, clientCode) {
  const esc = s => (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;background:#F2EDE3;padding:40px;">
<div style="max-width:560px;margin:0 auto;background:white;border:1px solid #C8BAA0;padding:40px;">
  <div style="text-align:center;margin-bottom:24px;border-bottom:1px solid #C8BAA0;padding-bottom:20px;">
    <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#8B6914;">ALNAÉ Infinity</div>
    <h1 style="font-family:Georgia,serif;font-size:22px;font-weight:400;font-style:italic;color:#1C1408;margin:8px 0 0;">Message prêt à graver ✦</h1>
  </div>
  <div style="background:#F0EBE0;border:1px solid #C8BAA0;padding:16px;margin:16px 0;text-align:center;">
    <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8A7A60;margin-bottom:6px;">Commande</div>
    <div style="font-family:monospace;font-size:18px;letter-spacing:3px;color:#1C1408;font-weight:bold;">${esc(orderNumber)}</div>
  </div>
  <table style="width:100%;font-size:13px;line-height:1.8;color:#5A4A2A;">
    <tr><td style="color:#8A7A60;width:140px;">Destinataire</td><td style="color:#1C1408;font-weight:bold;">${esc(msg.recipientName||"—")}</td></tr>
    <tr><td style="color:#8A7A60;">Occasion</td><td>${esc(msg.occasion||"Non précisée")}</td></tr>
    <tr><td style="color:#8A7A60;">Code bijou</td><td style="font-family:monospace;font-weight:bold;">${esc(msg.jewelCode||"—")}</td></tr>
    <tr><td style="color:#8A7A60;">Code client</td><td style="font-family:monospace;">${esc(clientCode||"—")}</td></tr>
    <tr><td style="color:#8A7A60;">PIN révélation</td><td style="font-family:monospace;">${esc(msg.pin||"—")}</td></tr>
    <tr><td style="color:#8A7A60;">Scellé le</td><td>${new Date().toLocaleDateString("fr-FR",{day:"2-digit",month:"long",year:"numeric",hour:"2-digit",minute:"2-digit"})}</td></tr>
  </table>
  ${msg.personalMessage?`<div style="margin:16px 0;border:1px solid #C8BAA0;padding:16px;background:#F8F4EE;"><div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#8A7A60;margin-bottom:6px;">Message personnel</div><p style="font-family:Georgia,serif;font-style:italic;color:#1C1408;font-size:14px;line-height:1.8;white-space:pre-wrap;margin:0;">${esc(msg.personalMessage)}</p></div>`:""}
  ${msg.motivationText?`<div style="margin:16px 0;background:#1C1408;padding:14px 18px;"><div style="font-size:10px;letter-spacing:2px;color:#8B6914;margin-bottom:6px;">Citation ALNAÉ</div><p style="font-family:Georgia,serif;font-style:italic;color:#F0EBE0;font-size:13px;line-height:1.7;white-space:pre-wrap;margin:0;">${esc(msg.motivationText)}</p></div>`:""}
  <div style="margin-top:24px;padding-top:16px;border-top:1px solid #C8BAA0;font-size:11px;color:#8A7A60;text-align:center;">
    Lien de révélation : <a href="${BASE_URL}/?code=${esc(msg.jewelCode||"")}" style="color:#8B6914;">${BASE_URL}/?code=${esc(msg.jewelCode||"")}</a><br><br>
    ALNAÉ Infinity — <a href="https://www.alnaeinfinity.com" style="color:#8B6914;">www.alnaeinfinity.com</a>
  </div>
</div></body></html>`;
}

// ── PAGE RÉVÉLATION ───────────────────────────────────────────────
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>ALNAÉ Confidente</title><link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;1,400&family=Raleway:wght@300;400&display=swap" rel="stylesheet"><style>:root{--lin:#F2EDE3;--lb:#C8BAA0;--gold:#8B6914;--gd:#6B5010;--dark:#1C1408;--d2:#3A2C18;--tm:#5A4A2A;--td:#8A7A60;--err:#C0392B;}*{margin:0;padding:0;box-sizing:border-box;}body{background:var(--lin);color:var(--dark);font-family:'Raleway',sans-serif;font-weight:300;min-height:100vh;-webkit-font-smoothing:antialiased;}header{text-align:center;padding:2.5rem 2rem 1.5rem;}.ey{font-size:.58rem;letter-spacing:.45em;text-transform:uppercase;color:var(--gold);margin-bottom:.7rem;display:flex;align-items:center;justify-content:center;gap:.8rem;}.ey::before,.ey::after{content:'';width:30px;height:1px;background:var(--gd);}.ct{font-family:'Playfair Display',serif;font-size:3rem;font-weight:400;font-style:italic;color:var(--dark);}.tg{font-size:.62rem;letter-spacing:.3em;text-transform:uppercase;color:var(--tm);margin-top:.3rem;}.cnt{max-width:520px;margin:0 auto;padding:0 1.2rem 5rem;}.page{display:none;animation:fu .4s ease both;}.page.active{display:block;}@keyframes fu{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}.card{background:rgba(255,252,248,.9);border:1px solid var(--lb);padding:2rem 1.8rem;position:relative;overflow:hidden;margin-bottom:.8rem;}.card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--gold),transparent);}.ct2{font-family:'Playfair Display',serif;font-size:1.4rem;font-weight:400;color:var(--dark);margin-bottom:.2rem;}.cs{font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;color:var(--td);margin-bottom:1.4rem;}.f{margin-bottom:1rem;}.f label{display:block;font-size:.6rem;letter-spacing:.2em;text-transform:uppercase;color:var(--tm);margin-bottom:.45rem;}.f input{width:100%;padding:.8rem 1rem;border:1px solid var(--lb);background:rgba(255,252,248,.9);font-family:'Raleway',sans-serif;font-size:.88rem;font-weight:300;color:var(--dark);outline:none;transition:border-color .2s;}.f input:focus{border-color:var(--gd);}.pw{display:flex;gap:.5rem;justify-content:center;margin:.9rem 0;}.pd{width:52px;height:60px;border:1px solid var(--lb);background:rgba(255,252,248,.9);font-family:'Playfair Display',serif;font-size:1.6rem;text-align:center;color:var(--dark);outline:none;-webkit-appearance:none;}.pd:focus{border-color:var(--gd);}.btn{display:block;width:100%;padding:.9rem;background:var(--dark);color:var(--lin);border:none;font-family:'Raleway',sans-serif;font-size:.6rem;font-weight:500;letter-spacing:.3em;text-transform:uppercase;cursor:pointer;transition:background .3s;margin-top:.8rem;}.btn:hover{background:#2A2010;}.btn:disabled{opacity:.4;cursor:not-allowed;}.btn-g{background:var(--gold);}.btn-g:hover{background:#A07820;}.al{padding:.75rem 1rem;font-size:.72rem;line-height:1.5;margin-bottom:.9rem;display:none;border-left:2px solid;}.al.show{display:block;}.ae{background:rgba(192,57,43,.06);border-color:var(--err);color:var(--err);}.it{display:flex;gap:.6rem;align-items:flex-start;font-size:.68rem;color:var(--tm);background:rgba(139,105,20,.04);border:1px solid rgba(139,105,20,.12);padding:.65rem .9rem;margin-bottom:1rem;}.ji{font-size:2.4rem;display:block;text-align:center;margin-bottom:.9rem;animation:pulse 4s ease-in-out infinite;}@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}.ob{display:inline-block;padding:.25rem .9rem;border:1px solid var(--gd);font-size:.58rem;letter-spacing:.25em;text-transform:uppercase;color:var(--gold);margin-bottom:1.1rem;}.rn{font-family:'Playfair Display',serif;font-size:2rem;font-weight:400;font-style:italic;color:var(--dark);text-align:center;margin-bottom:.2rem;}.ds{display:flex;align-items:center;justify-content:center;gap:.7rem;padding:1rem 0;}.ds::before,.ds::after{content:'';width:60px;height:1px;background:var(--lb);}.ds span{width:4px;height:4px;background:var(--gold);transform:rotate(45deg);display:block;}.eb{border-left:1px solid var(--gd);padding:.8rem 1rem;margin:1rem 0;text-align:left;background:rgba(139,105,20,.03);}.el{font-size:.58rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gd);margin-bottom:.3rem;}.eb p{font-family:'Playfair Display',serif;font-size:.95rem;font-style:italic;color:var(--d2);line-height:1.8;white-space:pre-wrap;}.mb{background:#E8E2D4;border:1px solid var(--lb);padding:1.4rem;margin:1rem 0;text-align:left;}.mb p{font-family:'Playfair Display',serif;font-size:1.05rem;line-height:1.9;color:var(--dark);white-space:pre-wrap;}.qb{border:1px solid var(--gd);padding:.9rem 1.3rem;margin:1rem 0;text-align:center;background:rgba(139,105,20,.03);}.qb p{font-family:'Playfair Display',serif;font-size:.9rem;font-style:italic;color:var(--gold);line-height:1.8;white-space:pre-wrap;}.fl{font-size:.65rem;letter-spacing:.12em;color:var(--td);margin-top:.8rem;font-style:italic;text-align:center;}.af{font-size:.58rem;letter-spacing:.18em;color:var(--td);text-transform:uppercase;text-align:center;margin-top:.5rem;}.af a{color:var(--gd);text-decoration:none;}.spw{text-align:center;padding:.9rem;display:none;}.spw.show{display:block;}.sp{width:24px;height:24px;border:1px solid var(--lb);border-top-color:var(--gold);border-radius:50%;animation:spin .9s linear infinite;margin:0 auto .5rem;}@keyframes spin{to{transform:rotate(360deg)}}.st{font-size:.6rem;letter-spacing:.15em;text-transform:uppercase;color:var(--td);}</style></head><body><header><div class="ey">ALNAÉ Infinity</div><h1 class="ct">Confidente</h1><p class="tg">Le bijou qui porte votre voix</p></header><div class="cnt"><div class="page active" id="p-code"><div class="card"><h2 class="ct2">Découvrez votre message</h2><p class="cs">Un message vous a été laissé</p><div class="it"><span>◈</span><span>Scannez le QR code sur votre carte ou saisissez le code du bijou ci-dessous.</span></div><div class="al ae" id="e-code"></div><div class="f"><label>Code du bijou</label><input type="text" id="ci" placeholder="ex. CONF-2026-04-1042" autocomplete="off" style="text-transform:uppercase;"></div><button class="btn" id="bc">Continuer →</button></div></div><div class="page" id="p-pin"><div class="card"><h2 class="ct2">Code confidentiel</h2><p class="cs">Saisissez le code lié à votre message</p><div class="it"><span>◈</span><span>Entrez le code à 4 chiffres communiqué avec le cadeau.</span></div><div class="al ae" id="e-pin"></div><div class="f"><label>Code confidentiel</label><div class="pw"><input type="tel" class="pd" id="c1" maxlength="1" inputmode="numeric"><input type="tel" class="pd" id="c2" maxlength="1" inputmode="numeric"><input type="tel" class="pd" id="c3" maxlength="1" inputmode="numeric"><input type="tel" class="pd" id="c4" maxlength="1" inputmode="numeric"></div></div><button class="btn btn-g" id="br">Révéler mon message →</button></div></div><div class="page" id="p-rev"><div class="card" style="text-align:center;"><span class="ji">◆</span><div id="ow" style="display:none;"><div class="ob" id="ro"></div></div><p class="rn" id="rn"></p><div class="ds"><span></span></div><div class="spw" id="rl"><div class="sp"></div><div class="st">Chargement…</div></div><div class="eb" id="re" style="display:none;"><div class="el">Essence du prénom</div><p id="ret"></p></div><div class="mb" id="rm" style="display:none;"><p id="rmt"></p></div><div class="qb" id="rq" style="display:none;"><p id="rqt"></p></div><p class="fl" id="rf"></p><div class="ds"><span></span></div><div class="af">ALNAÉ Infinity — Collection Confidente<br><a href="https://www.alnaeinfinity.com">www.alnaeinfinity.com</a></div><button class="btn btn-g" id="bdl" style="margin-top:1.3rem;">⬇ Télécharger mon message (PDF)</button></div></div></div><script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script><script>const g=id=>document.getElementById(id);function sP(id){document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));g(id)?.classList.add('active');window.scrollTo({top:0,behavior:'smooth'});}function sT(id,v){const e=g(id);if(e)e.textContent=v??'';}function sE(id,m){const e=g(id);if(e){e.textContent=m;e.classList.add('show');}}function hE(id){g(id)?.classList.remove('show');}['c1','c2','c3','c4'].forEach((id,i,a)=>{const el=g(id);if(!el)return;el.addEventListener('input',function(){this.value=this.value.replace(/[^0-9]/g,'');if(this.value&&i<a.length-1)g(a[i+1])?.focus();});el.addEventListener('keydown',function(e){if(e.key==='Backspace'&&!this.value&&i>0)g(a[i-1])?.focus();});});let cc='';const p=new URLSearchParams(window.location.search),cp=p.get('code');if(cp)g('ci').value=cp.toUpperCase();g('bc')?.addEventListener('click',async function(){const code=(g('ci').value||'').trim().toUpperCase();if(!code){sE('e-code','Veuillez saisir le code du bijou.');return;}hE('e-code');this.disabled=true;this.textContent='VÉRIFICATION…';try{const r=await fetch('/start-reveal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jewelCode:code})});const d=await r.json();if(!r.ok)throw new Error(d.message||'Code introuvable.');cc=d.jewelCode;sP('p-pin');g('c1')?.focus();}catch(err){sE('e-code',err.message||'Code introuvable.');}finally{this.disabled=false;this.textContent='CONTINUER →';}});g('br')?.addEventListener('click',async function(){const pin=['c1','c2','c3','c4'].map(id=>g(id)?.value||'').join('');if(pin.length!==4){sE('e-pin','4 chiffres requis.');return;}hE('e-pin');g('rl').classList.add('show');this.disabled=true;this.textContent='OUVERTURE…';try{const r=await fetch('/reveal-message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jewelCode:cc,pin})});const d=await r.json();if(!r.ok)throw new Error(d.message||'Code incorrect.');rD=d;sT('rn',d.recipientName||'');if(d.occasion){sT('ro',d.occasion);g('ow').style.display='block';}else g('ow').style.display='none';if(d.etymologyText){sT('ret',d.etymologyText);g('re').style.display='block';}else g('re').style.display='none';if(d.personalMessage){sT('rmt',d.personalMessage);g('rm').style.display='block';}else g('rm').style.display='none';if(d.motivationText){sT('rqt',d.motivationText);g('rq').style.display='block';}else g('rq').style.display='none';sT('rf',d.senderLine||'— ALNAÉ Confidente');g('rl').classList.remove('show');sP('p-rev');}catch(err){g('rl').classList.remove('show');sE('e-pin',err.message||'Code incorrect.');}finally{this.disabled=false;this.textContent='RÉVÉLER MON MESSAGE →';}});let rD=null;g('bdl')?.addEventListener('click',()=>{if(!rD||typeof window.jspdf==='undefined'){alert('PDF non disponible.');return;}const{jsPDF}=window.jspdf;const doc=new jsPDF({unit:'mm',format:'a4'});const esc=s=>(s||'').replace(/[^\x20-\x7E\u00C0-\u024F]/g,' ');const y={v:30};const nl=(g=8)=>{y.v+=g;};doc.setFillColor(28,20,8);doc.rect(0,0,210,20,'F');doc.setFontSize(8);doc.setTextColor(139,105,20);doc.setFont('helvetica','normal');doc.text('ALNAÉ INFINITY — COLLECTION CONFIDENTE',105,12,{align:'center',charSpace:2});doc.setFontSize(22);doc.setTextColor(28,20,8);doc.setFont('times','italic');doc.text(esc(rD.recipientName||''),105,y.v,{align:'center'});nl(10);doc.setDrawColor(139,105,20);doc.setLineWidth(0.3);doc.line(40,y.v,170,y.v);nl(8);if(rD.occasion){doc.setFontSize(9);doc.setTextColor(139,105,20);doc.setFont('helvetica','normal');doc.text((rD.occasion||'').toUpperCase(),105,y.v,{align:'center',charSpace:3});nl(10);}if(rD.etymologyText){doc.setFontSize(8);doc.setTextColor(107,80,16);doc.text('ESSENCE DU PRÉNOM',20,y.v,{charSpace:2});nl(6);doc.setFontSize(10);doc.setTextColor(58,44,24);doc.setFont('times','italic');const el=doc.splitTextToSize(esc(rD.etymologyText),160);doc.text(el,25,y.v);nl(el.length*5+8);}if(rD.personalMessage){doc.setFillColor(232,226,212);doc.rect(20,y.v-4,170,4,'F');doc.setFontSize(12);doc.setTextColor(28,20,8);doc.setFont('times','italic');const ml=doc.splitTextToSize(esc(rD.personalMessage),160);doc.text(ml,25,y.v+4);nl(ml.length*6+12);}if(rD.motivationText){doc.setFillColor(28,20,8);const ql=doc.splitTextToSize(esc(rD.motivationText),150);const qh=ql.length*5+12;doc.rect(20,y.v-4,170,qh,'F');doc.setFontSize(10);doc.setTextColor(240,235,224);doc.setFont('times','italic');doc.text(ql,105,y.v+4,{align:'center'});nl(qh+6);}if(rD.senderLine){doc.setFontSize(9);doc.setTextColor(138,122,96);doc.setFont('times','italic');doc.text(esc(rD.senderLine),170,y.v,{align:'right'});nl(16);}doc.setDrawColor(200,186,160);doc.setLineWidth(0.3);doc.line(20,y.v,190,y.v);nl(8);doc.setFontSize(7);doc.setTextColor(138,122,96);doc.setFont('helvetica','normal');doc.text('ALNAÉ INFINITY  ◆  COLLECTION CONFIDENTE  ◆  WWW.ALNAEINFINITY.COM',105,y.v,{align:'center',charSpace:1});doc.save('message-alnae-confidente.pdf');});</script></body></html>`);
});

// ── ADMIN : CRÉER UNE COMMANDE ────────────────────────────────────
app.post("/admin/create-order", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { orderNumber, clientEmail, clientName, codes: clientCodes, messageAccompagnement } = req.body;
  if (!orderNumber || !clientEmail || !clientCodes?.length) return res.status(400).json({ message: "Données manquantes." });
  if (orders.has(orderNumber)) return res.status(409).json({ message: "Cette commande existe déjà." });
  const orderData = { orderNumber, clientEmail, clientName:clientName||"", codes:clientCodes.map((code,i)=>({code,index:i+1,status:"available",jewelCode:null,sealedAt:null})), messageAccompagnement:messageAccompagnement||"", createdAt:new Date().toISOString() };
  orders.set(orderNumber, orderData);
  clientCodes.forEach((code,i) => codes.set(code, {orderNumber,index:i+1,status:"available",jewelCode:null,sealedAt:null}));
  console.log("[ADMIN] Commande créée :", orderNumber, "Codes :", clientCodes.length);
  return res.json({ ok:true, orderNumber, codesCreated:clientCodes.length });
});

// ── ADMIN : LISTE COMMANDES ───────────────────────────────────────
app.get("/admin/orders", (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(401).json({ message: "Accès non autorisé." });
  const ordersList = [...orders.values()].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  return res.json({ orders: ordersList });
});

// ── ADMIN : STATS ─────────────────────────────────────────────────
app.get("/admin/stats", (req, res) => {
  if (req.query.secret !== ADMIN_SECRET) return res.status(401).json({ message: "Accès non autorisé." });
  let total=0,sealed=0;
  orders.forEach(o=>(o.codes||[]).forEach(c=>{total++;if(c.status==="sealed")sealed++;}));
  return res.json({ totalOrders:orders.size, totalCodes:total, totalSealed:sealed, totalPending:total-sealed, recentOrders:[...orders.values()].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,5) });
});

// ── CLIENT : VALIDER CODE ─────────────────────────────────────────
app.post("/validate-client-code", (req, res) => {
  const { clientCode } = req.body;
  if (!clientCode) return res.status(400).json({ message: "Code manquant." });
  const codeData = codes.get(clientCode.toUpperCase());
  if (!codeData) return res.status(404).json({ message: "Code invalide. Vérifiez l'email reçu d'ALNAÉ Infinity." });
  if (codeData.status === "sealed") return res.status(410).json({ message: "Ce code a déjà été utilisé. Votre message a été scellé." });
  const order = orders.get(codeData.orderNumber);
  return res.json({ valid:true, orderNumber:codeData.orderNumber, codeIndex:codeData.index, clientName:order?.clientName||"" });
});

// ── CLIENT : SCELLER ─────────────────────────────────────────────
app.post("/seal-message", async (req, res) => {
  const { clientCode, pin, jewelCode, recipientName, occasion, personalMessage, etymologyText, motivationText, senderLine } = req.body;
  if (!pin || !jewelCode) return res.status(400).json({ message: "Données manquantes." });
  const finalCode = jewelCode.toUpperCase();
  if (clientCode) {
    const cd = codes.get(clientCode.toUpperCase());
    if (cd) {
      cd.status="sealed"; cd.jewelCode=finalCode; cd.sealedAt=new Date().toISOString();
      const order=orders.get(cd.orderNumber);
      if (order) { const ce=order.codes.find(c=>c.code===clientCode.toUpperCase()); if(ce){ce.status="sealed";ce.jewelCode=finalCode;ce.sealedAt=cd.sealedAt;} }
    }
  }
  const msgData = { jewelCode:finalCode, clientCode:clientCode?clientCode.toUpperCase():null, pin, recipientName:recipientName||"", occasion:occasion||null, personalMessage:personalMessage||null, etymologyText:etymologyText||null, motivationText:motivationText||null, senderLine:senderLine||"— ALNAÉ Confidente", createdAt:new Date().toISOString() };
  messages.set(finalCode, msgData);
  let orderNumber="—";
  if (clientCode) { const cd=codes.get(clientCode.toUpperCase()); if(cd)orderNumber=cd.orderNumber; }
  const emailHtml = buildGravureEmail(msgData, orderNumber, clientCode);
  const sent = await sendEmail(ALNAE_EMAIL, `[ALNAÉ Confidente] ✦ Message prêt à graver — ${orderNumber} — ${recipientName}`, emailHtml);
  console.log("[SEAL]", finalCode, "— Email ALNAÉ:", sent?"✓":"⚠ (SendGrid non configuré)");
  return res.json({ ok:true, jewelCode:finalCode, revealUrl:BASE_URL+"/?code="+finalCode });
});

// ── RÉVÉLATION ────────────────────────────────────────────────────
app.post("/start-reveal", (req, res) => {
  const { jewelCode } = req.body;
  if (!jewelCode) return res.status(400).json({ message: "Code manquant." });
  const code = jewelCode.toUpperCase();
  if (!messages.has(code)) return res.status(404).json({ message: "Code introuvable. Vérifiez la carte jointe au bijou." });
  return res.json({ jewelCode: code });
});

app.post("/reveal-message", (req, res) => {
  const { jewelCode, pin } = req.body;
  if (!jewelCode || !pin) return res.status(400).json({ message: "Données manquantes." });
  const code = jewelCode.toUpperCase();
  const msg  = messages.get(code);
  if (!msg) return res.status(404).json({ message: "Message introuvable." });
  if (msg.pin !== String(pin)) return res.status(401).json({ message: "Code incorrect. Vérifiez la carte jointe au bijou." });
  return res.json({ recipientName:msg.recipientName, occasion:msg.occasion, etymologyText:msg.etymologyText, personalMessage:msg.personalMessage, motivationText:msg.motivationText, senderLine:msg.senderLine });
});

app.get("/health", (req, res) => res.json({ ok:true, orders:orders.size, codes:codes.size, messages:messages.size, uptime:Math.floor(process.uptime())+"s" }));

app.get("/formulaire", (req, res) => {
  res.sendFile(path.join(__dirname, "alnae-formulaire-client.html"));
});

app.listen(port, () => {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  ALNAÉ Confidente v2 — Serveur démarré");
  console.log("  Port :", port, "| URL :", BASE_URL);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});
