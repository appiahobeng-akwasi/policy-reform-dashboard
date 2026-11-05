# Policy Reform Dashboard

[English](#english) · [Français](#français)

## English

A reform delivery dashboard for government reform programmes. It tracks reforms down the chain reform → workstream → deliverable → activity → milestone, with risks, decisions, evidence, results indicators, and a monthly review cycle (prepare, review, decide, track). It was first built for Pillar 1 (policy and institutional reform) of the Green Growth Programme in the Democratic Republic of the Congo, and is published so partner IT teams can adopt and adapt it.

**What it does**

- Every change goes through a data quality check and then approval by someone other than the person who made it. Nothing reaches the shared data without both, and every step is logged.
- Row-level security in the database decides who sees and changes what. The screens only hide buttons.
- Ratings (green, amber, red) are calculated from dates and status, not typed in. Overriding one needs a reason.
- French and English throughout. Each person switches language in the header.
- Built for slow connections: pages are rendered on the server, with little JavaScript and no heavy chart library.
- Reminders, escalations, a weekly digest and a month-end snapshot run on a schedule.
- Six views: Executive, Pathway, Portfolio, Risks, MERL (results) and Governance, plus My items, Approvals and bulk upload from Excel.

**The data in this repository is fictional.** Every reform, person, risk and number in `db/seed/0100_demo_seed.sql` is invented, and the app says so on every page while `DEMO_DATA=true`. Replace it with your own data before real use (see [docs/ADOPTING.md](docs/ADOPTING.md)).

**Stack:** PostgreSQL 15 or later, Astro (server-rendered) with a few React islands, TypeScript, plain CSS. Supabase for sign-in (magic link) and file storage, behind small adapters in `src/lib/platform/`, so you can move to another provider. Vitest and Playwright for tests.

### Try it on your computer

You need Node 26 (see `.nvmrc`), Docker (or Colima) and the [Supabase command-line tool](https://supabase.com/docs/guides/cli).

```bash
npm ci
supabase start
cp .env.example .env
npm run db:reset
npm run users:add -- --email you@example.org --name "Your Name" --role super_admin
npm run dev
```

Open http://localhost:4321 and sign in with that email. Local sign-in emails are caught by Mailpit at http://127.0.0.1:54324. Nothing is really sent.

### Run the tests

```bash
npm run typecheck && npm run lint
npm run test        # unit tests
npm run test:db     # database tests, including row-level security for each role
npm run test:e2e    # end-to-end tests in a browser
```

### Learn more

- [docs/ADOPTING.md](docs/ADOPTING.md): set it up for your own programme, load your data, host it.
- [docs/02_DATA_MODEL.md](docs/02_DATA_MODEL.md), [docs/03_DATA_QUALITY_GATE.md](docs/03_DATA_QUALITY_GATE.md), [docs/04_ARCHITECTURE_AND_HOSTING.md](docs/04_ARCHITECTURE_AND_HOSTING.md), [docs/08_DESIGN_SYSTEM.md](docs/08_DESIGN_SYSTEM.md): how it works.
- [docs/manuals](docs/manuals): user guide, admin guide and procedures.
- [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

Released under the [MIT licence](LICENSE).

## Français

Un tableau de bord de suivi des réformes pour les programmes de réforme publique. Il suit chaque réforme selon la chaîne réforme → axe de travail → livrable → activité → jalon, avec les risques, les décisions, les preuves, les indicateurs de résultats et un cycle de revue mensuel (préparer, examiner, décider, suivre). Il a d'abord été conçu pour le Pilier 1 (réformes politiques et institutionnelles) du Programme de croissance verte en République démocratique du Congo. Il est publié pour que les équipes informatiques des partenaires puissent l'adopter et l'adapter.

**Ce qu'il fait**

- Chaque modification passe par un contrôle de la qualité des données, puis par l'approbation d'une autre personne que son auteur. Rien n'entre dans les données partagées sans ces deux étapes, et chaque étape est consignée.
- La sécurité au niveau des lignes de la base de données décide qui voit et modifie quoi. Les écrans ne font que masquer des boutons.
- Les notes (vert, orange, rouge) sont calculées à partir des dates et du statut, jamais saisies. Toute dérogation exige une justification.
- Français et anglais partout. Chaque personne change de langue dans l'en-tête.
- Conçu pour les connexions lentes : pages rendues sur le serveur, peu de JavaScript, aucune bibliothèque de graphiques lourde.
- Rappels, escalades, synthèse hebdomadaire et instantané de fin de mois sont programmés.
- Six vues : Direction, Parcours, Portefeuille, Risques, MERL (résultats) et Gouvernance, plus Mes éléments, Approbations et l'import en masse depuis Excel.

**Les données de ce dépôt sont fictives.** Chaque réforme, personne, risque et chiffre de `db/seed/0100_demo_seed.sql` est inventé, et l'application l'indique sur chaque page tant que `DEMO_DATA=true`. Remplacez-les par vos propres données avant tout usage réel (voir [docs/ADOPTING.md](docs/ADOPTING.md), en anglais).

**Technologies :** PostgreSQL 15 ou plus récent, Astro (rendu serveur) avec quelques îlots React, TypeScript, CSS simple. Supabase pour la connexion (lien magique) et le stockage des fichiers, derrière de petits adaptateurs dans `src/lib/platform/`, pour pouvoir changer de fournisseur. Vitest et Playwright pour les tests.

### L'essayer sur votre ordinateur

Il vous faut Node 26 (voir `.nvmrc`), Docker (ou Colima) et [l'outil en ligne de commande Supabase](https://supabase.com/docs/guides/cli).

```bash
npm ci
supabase start
cp .env.example .env
npm run db:reset
npm run users:add -- --email vous@example.org --name "Votre nom" --role super_admin
npm run dev
```

Ouvrez http://localhost:4321 et connectez-vous avec cette adresse. En local, les courriels de connexion sont interceptés par Mailpit sur http://127.0.0.1:54324 ; rien n'est réellement envoyé.

### Lancer les tests

```bash
npm run typecheck && npm run lint
npm run test        # tests unitaires
npm run test:db     # tests de la base, dont la sécurité par rôle
npm run test:e2e    # tests de bout en bout dans un navigateur
```

### En savoir plus

La documentation technique est en anglais : [docs/ADOPTING.md](docs/ADOPTING.md) pour l'installer pour votre programme, et [docs/manuals](docs/manuals) pour les guides. Distribué sous [licence MIT](LICENSE).
