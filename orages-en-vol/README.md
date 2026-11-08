# ⚡ Orages en vol

Carte web temps réel des orages pour l'aviation, construite **uniquement avec des données ouvertes et gratuites**.
Elle superpose la foudre en direct, le radar, le satellite, les SIGMET convectifs, les METAR/PIREP et le trafic
aérien ADS-B, puis calcule pour chaque avion son **exposition orageuse** (impacts proches, cellules sur la route,
SIGMET traversé).

> ⚠️ Outil d'information sans valeur opérationnelle : il ne remplace ni le briefing météo officiel,
> ni l'ATC, ni le radar météo de bord.

## Lancer

```bash
cd orages-en-vol
node server.js          # Node.js >= 22, aucune dépendance à installer
# → http://localhost:8080   (PORT=xxxx pour changer de port)
```

Ou avec Docker :

```bash
docker build -t orages-en-vol .
docker run -p 8080:8080 orages-en-vol
```

## Fonctionnalités

- **Foudre en direct** : chaque impact apparaît en quelques secondes (halo animé), couleur selon l'âge
  (< 1 min → 60 min), taux d'impacts par minute dans la vue.
- **Radar** mondial animé (2 h d'historique, lecture / curseur / opacité).
- **Satellite** infrarouge (Meteosat MTG + composite mondial), RGB convection, et **foudre satellite MTG-LI**.
- **SIGMET** convectifs (rouge) et autres SIGMET (turbulence, givrage… en bleu), avec texte brut et niveaux.
- **METAR** : stations signalant un orage (⚡) ou des CB/TCU, catégories de vol VFR/IFR au zoom.
- **PIREP / AIREP** : turbulence et givrage rapportés par les équipages.
- **Trafic aérien** en direct (positions extrapolées chaque seconde), filtre par niveau de vol.
- **Analyse d'exposition par avion** :
  - impact le plus proche (distance, direction) et impacts < 20 / < 50 NM ;
  - impacts dans un cône de ±30° sur la route, avec temps estimé avant d'y arriver ;
  - présence dans un SIGMET convectif (en tenant compte du sommet annoncé) ;
  - CAPE, Lifted Index et isotherme 0 °C au point (Open-Meteo) ;
  - trajectoire projetée à +15 min et suivi automatique de l'avion.
- Onglet **Exposés** : liste des vols de la zone triés par niveau de risque.
- Clic n'importe où sur la carte : analyse convective du point.
- Lien partageable (la position de la carte est dans l'URL), interface responsive mobile.

Niveaux de risque : 🟢 RAS · 🔵 activité à < 80 NM · 🟠 orage < 27 NM, sur la route < 54 NM ou SIGMET convectif ·
🔴 impact à < 10 NM ou cellule active droit devant.

## Sources de données

| Donnée | Source | Licence / conditions |
|---|---|---|
| Foudre temps réel | [Blitzortung.org](https://www.blitzortung.org) (WebSocket) | Réseau communautaire, usage non commercial |
| Foudre satellite, IR, RGB convection | [EUMETSAT View](https://view.eumetsat.int) (WMS) | Données ouvertes EUMETSAT |
| Radar | [RainViewer](https://www.rainviewer.com/api.html) | Gratuit avec attribution (zoom natif max 7) |
| SIGMET, METAR, PIREP | [NOAA Aviation Weather Center](https://aviationweather.gov/data/api/) | Domaine public |
| Trafic aérien | [adsb.lol](https://adsb.lol) → repli [OpenSky Network](https://opensky-network.org) | ODbL / conditions OpenSky |
| CAPE, Lifted Index, isotherme 0 °C | [Open-Meteo](https://open-meteo.com) | CC BY 4.0 |
| Fond de carte | Esri World Dark Gray Canvas, © OpenStreetMap | Attribution |

## Architecture

```
orages-en-vol/
├── server.js        # serveur Node sans dépendance
│                    #  - connexion WebSocket Blitzortung (décodage, 60 min en mémoire)
│                    #  - diffusion des impacts en Server-Sent Events  (/api/lightning/stream)
│                    #  - relais + cache des API sans CORS (AWC, adsb.lol, OpenSky)
└── public/
    ├── index.html
    ├── style.css
    └── app.js       # Leaflet, calques, rendu canvas de la foudre, analyse de risque
```

API exposée par le serveur :

| Route | Description |
|---|---|
| `GET /api/lightning?since=<ms>` | impacts `[t_ms, lat, lon]` depuis `since` (max 60 min) |
| `GET /api/lightning/stream` | flux SSE des nouveaux impacts (lots d'1 s) |
| `GET /api/sigmets` | SIGMET internationaux + US normalisés (GeoJSON) |
| `GET /api/metars?bbox=s,o,n,e` | METAR avec indicateurs `ts` (orage) et `cb` |
| `GET /api/pireps?bbox=s,o,n,e` | PIREP/AIREP des 3 dernières heures |
| `GET /api/aircraft?lat=&lon=&dist=<NM>` | avions dans un rayon (≤ 250 NM) |
| `GET /api/health` | état de la connexion foudre |
