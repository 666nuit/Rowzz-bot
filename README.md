# Discord Bot (modération + tickets + giveaways)

## Installation locale
```bash
npm install
node index.js
```

## Variables d'environnement (Railway)
- DISCORD_TOKEN
- CLIENT_ID
- (optionnel) GUILD_ID (recommandé pour déployer vite les slash commands)
- STAFF_ROLE_ID
- MEMBER_ROLE_ID
- TICKETS_CATEGORY_ID
- WELCOME_CHANNEL_ID
- SUGGESTIONS_CHANNEL_ID
- REGLEMENT_CHANNEL_ID
- LOG_MEMBERS_CHANNEL_ID
- LOG_MESSAGES_CHANNEL_ID
- LOG_MOD_CHANNEL_ID
- LOG_VOICE_CHANNEL_ID
- LOG_SERVER_CHANNEL_ID
- (optionnel) WINNER_GIF_URL

## Giveaways
- /creategw (ouvre un formulaire)
- /endgw message_id:...
- /cancelgw message_id:...
- /rollgw message_id:... nombre:1


## Logs Premium
Les logs sont uniformisés (couleurs, champs, footer) et ajoutent des logs pour les actions Giveaway.


## Logs Modération Premium
Les logs ban/kick/timeout/warn incluent raison + IDs + (best-effort) audit log.


## Logs Premium (par catégorie)
Chaque type de log part dans son salon dédié : membres / messages / modération / vocal / serveur.
Les couleurs et icônes changent selon la gravité (warn orange, ban rouge, etc.).
