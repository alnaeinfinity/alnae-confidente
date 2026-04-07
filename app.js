const express = require("express");
const crypto = require("crypto");

const app = express();
const port = process.env.PORT || 10000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/*
  VERSION DE TRAVAIL
  - fonctionne en démo
  - stockage en mémoire uniquement
  - les données seront perdues si le serveur redémarre
  - prochaine étape : brancher Shopify + vraie base de données
*/

const orders = [
  {
    orderNumber: "CMD-2024-00142",
    email: "aline@test.fr",
    firstName: "Aline",
    lastName: "Martin",
    connectedUnits: 2
  },
  {
    orderNumber: "CMD-2024-00200",
    email: "marie@test.fr",
    firstName: "Marie",
    lastName: "Dupont",
    connectedUnits: 1
  }
];

const slots = new Map();

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalize(value = "") {
  return String(value).trim().toLowerCase();
}

function findOrder(orderNumber, email, firstName, lastName) {
  return orders.find((order) => {
    return (
      normalize(order.orderNumber) === normalize(orderNumber) &&
      normalize(order.email) === normalize(email) &&
      normalize(order.firstName) === normalize(firstName) &&
      normalize(order.lastName) === normalize(lastName)
    );
  });
}

function getOrderSlots(orderNumber) {
  return [...slots.values()].filter((slot) => slot.orderNumber === orderNumber);
}

function createMissingSlots(order) {
  const existing = getOrderSlots(order.orderNumber).length;
  const missing = order.connectedUnits - existing;

  for (let i = 0; i < missing; i++) {
    const token = crypto.randomBytes(16).toString("hex");
    const revealToken = crypto.randomBytes(16).toString("hex");
    const slotIndex = existing + i + 1;

    slots.set(token, {
      token,
      revealToken,
      orderNumber: order.orderNumber,
      slotIndex,
      status: "available",
      recipientName: "",
      senderName: "",
      message: "",
      pin: "",
      createdAt: new Date().toISOString()
    });
  }
}

const config = {
  demoMode: false
};
app.get("/", (req, res) => {
  res.send(
    pageTemplate(
      "Alnaé Confidente",
      `
      <div class="brand">ALNAÉ Infinity</div>
      <h1 class="title">Confidente</h1>
      <p class="muted">Serveur Alnaé Confidente actif 💎</p>

      <div class="card">
        <h2>Démarrage</h2>
        <p>Cette version est une base de travail. Elle permet déjà :</p>
        <ul>
          <li>la vérification d'une commande en mode démo</li>
          <li>la création de slots de messages</li>
          <li>un lien unique par message</li>
          <li>une page de révélation protégée par code PIN</li>
        </ul>

        <a class="btn" href="/confidente">Ouvrir Confidente</a>
      </div>

      <div class="card">
        <h3>Commande de test</h3>
        <p><strong>Numéro :</strong> CMD-2024-00142</p>
        <p><strong>Email :</strong> aline@test.fr</p>
        <p><strong>Prénom :</strong> Aline</p>
        <p><strong>Nom :</strong> Martin</p>
      </div>
      `
    )
  );
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/confidente", (req, res) => {
  res.send(
    pageTemplate(
      "Confidente",
      `
      <div class="brand">ALNAÉ Infinity</div>
      <h1 class="title">Confidente</h1>
      <p class="muted">Déposez un message sécurisé lié à votre commande.</p>

      <div class="card">
        <h2>Vérification de commande</h2>
        <form method="POST" action="/confidente/verify">
          <label>Numéro de commande</label>
          <input name="orderNumber" placeholder="CMD-2024-00142" required />

          <label>Email</label>
          <input type="email" name="email" placeholder="aline@test.fr" required />

          <label>Prénom</label>
          <input name="firstName" placeholder="Aline" required />

          <label>Nom</label>
          <input name="lastName" placeholder="Martin" required />

          <button class="btn" type="submit">Vérifier ma commande</button>
        </form>
      </div>
      `
    )
  );
});

app.post("/confidente/verify", (req, res) => {
  const { orderNumber, email, firstName, lastName } = req.body;
  const order = findOrder(orderNumber, email, firstName, lastName);

  if (!order) {
    return res.send(
      pageTemplate(
        "Commande introuvable",
        `
        <div class="brand">ALNAÉ Infinity</div>
        <h1 class="title">Confidente</h1>
        <div class="card">
          <p class="err">Commande introuvable ou informations incorrectes.</p>
          <a class="btn" href="/confidente">Réessayer</a>
        </div>
        `
      )
    );
  }

  createMissingSlots(order);
  const orderSlots = getOrderSlots(order.orderNumber);

  const slotsHtml = orderSlots
    .map((slot) => {
      const statusLabel =
        slot.status === "sealed"
          ? `<span class="ok">Message déjà créé</span>`
          : `<span class="muted">Disponible</span>`;

      const action =
        slot.status === "sealed"
          ? `
            <div class="code">Lien de révélation : /reveal/${slot.revealToken}</div>
            <div class="actions" style="margin-top:12px;">
              <a class="btn btn-secondary" href="/reveal/${slot.revealToken}">Voir la page de révélation</a>
            </div>
          `
          : `
            <div class="actions">
              <a class="btn" href="/slot/${slot.token}">Remplir ce message</a>
            </div>
          `;

      return `
        <div class="slot">
          <h3>Message ${slot.slotIndex}</h3>
          <p><strong>Statut :</strong> ${statusLabel}</p>
          ${action}
        </div>
      `;
    })
    .join("");

  res.send(
    pageTemplate(
      "Slots de commande",
      `
      <div class="brand">ALNAÉ Infinity</div>
      <h1 class="title">Confidente</h1>

      <div class="card">
        <h2>Commande vérifiée</h2>
        <p><strong>Commande :</strong> ${escapeHtml(order.orderNumber)}</p>
        <p><strong>Cliente :</strong> ${escapeHtml(order.firstName)} ${escapeHtml(order.lastName)}</p>
        <p><strong>Unités connectées :</strong> ${order.connectedUnits}</p>
      </div>

      <div class="card">
        <h2>Messages disponibles</h2>
        <div class="grid">
          ${slotsHtml}
        </div>
      </div>

      <div class="card">
        <a class="btn" href="/confidente">Retour</a>
      </div>
      `
    )
  );
});

app.get("/slot/:token", (req, res) => {
  const slot = slots.get(req.params.token);

  if (!slot) {
    return res.status(404).send(
      pageTemplate(
        "Introuvable",
        `
        <div class="card">
          <p class="err">Ce lien est introuvable.</p>
          <a class="btn" href="/confidente">Retour</a>
        </div>
        `
      )
    );
  }

  if (slot.status === "sealed") {
    return res.send(
      pageTemplate(
        "Déjà utilisé",
        `
        <div class="card">
          <p class="err">Ce slot a déjà été utilisé.</p>
          <a class="btn btn-secondary" href="/reveal/${slot.revealToken}">Voir la révélation</a>
        </div>
        `
      )
    );
  }

  res.send(
    pageTemplate(
      "Créer un message",
      `
      <div class="brand">ALNAÉ Infinity</div>
      <h1 class="title">Créer le message</h1>

      <div class="card">
        <p><strong>Commande :</strong> ${escapeHtml(slot.orderNumber)}</p>
        <p><strong>Message :</strong> ${slot.slotIndex}</p>

        <form method="POST" action="/slot/${slot.token}">
          <label>Prénom du destinataire</label>
          <input name="recipientName" required />

          <label>Nom de l'expéditeur</label>
          <input name="senderName" required />

          <label>Code PIN à 4 chiffres</label>
          <input name="pin" pattern="[0-9]{4}" maxlength="4" required />

          <label>Message</label>
          <textarea name="message" required></textarea>

          <button class="btn" type="submit">Sceller le message</button>
        </form>
      </div>
      `
    )
  );
});

app.post("/slot/:token", (req, res) => {
  const slot = slots.get(req.params.token);

  if (!slot) {
    return res.status(404).send(
      pageTemplate(
        "Introuvable",
        `
        <div class="card">
          <p class="err">Ce lien est introuvable.</p>
        </div>
        `
      )
    );
  }

  if (slot.status === "sealed") {
    return res.send(
      pageTemplate(
        "Déjà utilisé",
        `
        <div class="card">
          <p class="err">Ce slot a déjà été utilisé.</p>
          <a class="btn" href="/reveal/${slot.revealToken}">Voir le message</a>
        </div>
        `
      )
    );
  }

  const { recipientName, senderName, message, pin } = req.body;

  if (!recipientName || !senderName || !message || !pin || !/^[0-9]{4}$/.test(pin)) {
    return res.send(
      pageTemplate(
        "Erreur",
        `
        <div class="card">
          <p class="err">Tous les champs sont obligatoires. Le code PIN doit contenir 4 chiffres.</p>
          <a class="btn" href="/slot/${slot.token}">Retour</a>
        </div>
        `
      )
    );
  }

  slot.recipientName = recipientName;
  slot.senderName = senderName;
  slot.message = message;
  slot.pin = pin;
  slot.status = "sealed";
  slot.sealedAt = new Date().toISOString();

  res.send(
    pageTemplate(
      "Message scellé",
      `
      <div class="brand">ALNAÉ Infinity</div>
      <h1 class="title">Message scellé</h1>

      <div class="card">
        <p class="ok">Le message a été enregistré.</p>
        <p><strong>Destinataire :</strong> ${escapeHtml(slot.recipientName)}</p>
        <p><strong>Lien de révélation :</strong></p>
        <div class="code">/reveal/${slot.revealToken}</div>
        <p style="margin-top:16px;"><strong>Code PIN :</strong> ${escapeHtml(slot.pin)}</p>

        <a class="btn btn-secondary" href="/reveal/${slot.revealToken}">Ouvrir la page de révélation</a>
      </div>
      `
    )
  );
});

app.get("/reveal/:revealToken", (req, res) => {
  const slot = [...slots.values()].find((item) => item.revealToken === req.params.revealToken);

  if (!slot) {
    return res.status(404).send(
      pageTemplate(
        "Introuvable",
        `
        <div class="card">
          <p class="err">Message introuvable.</p>
        </div>
        `
      )
    );
  }

  res.send(
    pageTemplate(
      "Révélation",
      `
      <div class="brand">ALNAÉ Infinity</div>
      <h1 class="title">Révéler le message</h1>

      <div class="card">
        <p><strong>Destinataire :</strong> ${escapeHtml(slot.recipientName || "Message confidentiel")}</p>

        <form method="POST" action="/reveal/${slot.revealToken}">
          <label>Code PIN</label>
          <input name="pin" pattern="[0-9]{4}" maxlength="4" required />
          <button class="btn" type="submit">Révéler</button>
        </form>
      </div>
      `
    )
  );
});

app.post("/reveal/:revealToken", (req, res) => {
  const slot = [...slots.values()].find((item) => item.revealToken === req.params.revealToken);

  if (!slot) {
    return res.status(404).send(
      pageTemplate(
        "Introuvable",
        `
        <div class="card">
          <p class="err">Message introuvable.</p>
        </div>
        `
      )
    );
  }

  if (req.body.pin !== slot.pin) {
    return res.send(
      pageTemplate(
        "PIN incorrect",
        `
        <div class="brand">ALNAÉ Infinity</div>
        <h1 class="title">Révéler le message</h1>

        <div class="card">
          <p class="err">Code PIN incorrect.</p>
          <a class="btn" href="/reveal/${slot.revealToken}">Réessayer</a>
        </div>
        `
      )
    );
  }

  res.send(
    pageTemplate(
      "Message révélé",
      `
      <div class="brand">ALNAÉ Infinity</div>
      <h1 class="title">${escapeHtml(slot.recipientName)}</h1>

      <div class="card">
        <p style="white-space:pre-wrap;">${escapeHtml(slot.message)}</p>
        <p class="muted" style="margin-top:20px;">— De la part de ${escapeHtml(slot.senderName)}</p>
      </div>
      `
    )
  );
});

app.listen(port, () => {
  console.log(`Serveur lancé sur le port ${port}`);
});
