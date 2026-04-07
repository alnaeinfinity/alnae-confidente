const express = require('express');
const app = express();
const port = process.env.PORT || 10000;

app.use(express.json());

// Page accueil
app.get('/', (req, res) => {
  res.send("Serveur Alnaé Confidente actif 💎");
});

// Route test lien unique
app.get('/message/:id', (req, res) => {
  const id = req.params.id;

  res.send(`
    <h1>💎 Message confidentiel</h1>
    <p>Lien sécurisé : ${id}</p>
    <form method="POST" action="/message/${id}">
      <input type="text" name="message" placeholder="Votre message" required />
      <button type="submit">Envoyer</button>
    </form>
  `);
});

// réception message
app.post('/message/:id', (req, res) => {
  const id = req.params.id;

  res.send(`Message enregistré pour ${id} ✅`);
});

app.listen(port, () => {
  console.log(`Serveur lancé sur le port ${port}`);
});
