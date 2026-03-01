/**
 * BOT DISCORD TOUT-EN-UN (Railway-friendly)
 * - Vérif règlement (bouton -> rôle membre)
 * - Tickets (panneau -> création salon privé, fermeture staff-only, anti-spam)
 * - Modération (ban/kick/timeout/purge)
 * - Warn system (persistant dans warns.json) + DM au membre
 * - Logs complets + multi-salons (membres, messages, modération, vocal, serveur/audit)
 * - Transcript ticket à la fermeture (export messages -> log mod)
 * - Giveaways stylés (modal + boutons + auto-refresh + reroll/end/cancel)
 *
 * ENV (Railway):
 * DISCORD_TOKEN, CLIENT_ID, GUILD_ID (recommandé),
 * STAFF_ROLE_ID, MEMBER_ROLE_ID, TICKETS_CATEGORY_ID,
 * WELCOME_CHANNEL_ID, SUGGESTIONS_CHANNEL_ID, REGLEMENT_CHANNEL_ID
 * LOG_MEMBERS_CHANNEL_ID, LOG_MESSAGES_CHANNEL_ID, LOG_MOD_CHANNEL_ID, LOG_VOICE_CHANNEL_ID, LOG_SERVER_CHANNEL_ID
 * (optionnel) WINNER_GIF_URL
 */

const fs = require("fs");
const path = require("path");

// Keep-alive web (Railway / Render / etc.)
const express = require("express");
const app = express();

app.get("/", (req, res) => res.status(200).send("Bot is alive ✅"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🌍 Web server running on port ${PORT}`));

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  AuditLogEvent,
  MessageFlags,
  Events
} = require("discord.js");

require("dotenv").config();

// Logs utiles en prod (évite les crashes silencieux)
process.on("unhandledRejection", (reason) => console.error("❌ Unhandled Rejection:", reason));
process.on("uncaughtException", (err) => console.error("❌ Uncaught Exception:", err));

// ====== ENV / CONFIG ======
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;
const MEMBER_ROLE_ID = process.env.MEMBER_ROLE_ID;
const TICKETS_CATEGORY_ID = process.env.TICKETS_CATEGORY_ID;
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;
const SUGGESTIONS_CHANNEL_ID = process.env.SUGGESTIONS_CHANNEL_ID;
const REGLEMENT_CHANNEL_ID = process.env.REGLEMENT_CHANNEL_ID;

// Logs multi-salons
const LOG_CH = {
  members: process.env.LOG_MEMBERS_CHANNEL_ID,
  messages: process.env.LOG_MESSAGES_CHANNEL_ID,
  mod: process.env.LOG_MOD_CHANNEL_ID,
  voice: process.env.LOG_VOICE_CHANNEL_ID,
  server: process.env.LOG_SERVER_CHANNEL_ID
};

// ====== CHECKS ENV ======
if (!TOKEN) {
  console.error("❌ DISCORD_TOKEN manquant dans les variables d'environnement.");
  process.exit(1);
}
if (!CLIENT_ID) {
  console.warn("⚠️ CLIENT_ID manquant: les slash commands ne seront pas déployées automatiquement.");
}

// ====== ANTI-FLOOD ======
const FLOOD_WINDOW_MS = 7000;     // 7 secondes
const FLOOD_MAX_MSG = 5;          // 5 messages
const FLOOD_TIMEOUT_MS = 60_000;  // 1 minute
const floodMap = new Map();       // userId -> { count, firstTs, punishedUntil }

// ====== CLIENT ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.Reaction,
    Partials.GuildMember,
    Partials.User
  ]
});

// ====== HELPERS ======
function isStaff(member) {
  if (!member) return false;
  if (!STAFF_ROLE_ID) return false;
  return member.roles?.cache?.has(STAFF_ROLE_ID) || false;
}

async function getChannel(guild, id) {
  if (!guild || !id) return null;
  return guild.channels.fetch(id).catch(() => null);
}

async function sendLog(guild, type, embed, files = []) {
  const id = LOG_CH[type];
  if (!id || !guild) return;
  const ch = await getChannel(guild, id);
  if (!ch) return;
  await ch.send({ embeds: [embed], files }).catch(() => null);
}

function cleanText(s, max = 1000) {
  if (!s) return "*vide*";
  const t = String(s);
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
}

function sanitizeChannelName(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 80) || "ticket"
  );
}

function ticketOwnerFromTopic(topic) {
  if (!topic) return null;
  const m = String(topic).match(/ticketOwner:(\d{10,})/);
  return m ? m[1] : null;
}

async function getAuditExecutorTag(guild, auditType, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ limit: 10, type: auditType });
    const entry = logs.entries.find((e) => e.target?.id === targetId);
    if (entry?.executor) return `${entry.executor.tag} (${entry.executor.id})`;
  } catch (_) {}
  return "Inconnu";
}

async function fetchAuditEntry(guild, auditType, targetId, withinMs = 15_000) {
  try {
    const logs = await guild.fetchAuditLogs({ limit: 10, type: auditType });
    const now = Date.now();
    const entry = logs.entries.find((e) => {
      if (targetId && e.target?.id !== targetId) return false;
      if (withinMs && (now - e.createdTimestamp) > withinMs) return false;
      return true;
    });
    if (!entry) return null;
    return {
      executor: entry.executor ? `${entry.executor.tag} (${entry.executor.id})` : "Inconnu",
      reason: entry.reason || "*Aucune*",
      id: entry.id
    };
  } catch {
    return null;
  }
}

function formatDateFR(iso) {
  try {
    return new Date(iso).toLocaleString("fr-FR");
  } catch {
    return iso;
  }
}

function eph() {
  // évite le warning "ephemeral deprecated" en utilisant flags
  return { flags: MessageFlags.Ephemeral };
}

// ====== LOGS PREMIUM (embeds uniformes) ======
const LOG_STYLE = {
  brand: 0x8b5cf6,      // violet premium
  success: 0x22c55e,    // green
  danger: 0xef4444,     // red
  warning: 0xf59e0b,    // orange/amber
  info: 0x3b82f6,       // blue
  neutral: 0x64748b,    // slate
  pink: 0xec4899,       // pink
  cyan: 0x06b6d4        // cyan
};

const LOG_PRESET = {
  // Membres
  MEMBER_JOIN:   { emoji: "👋", color: LOG_STYLE.success, title: "Membre rejoint" },
  MEMBER_LEAVE:  { emoji: "🚪", color: LOG_STYLE.danger,  title: "Membre parti" },

  // Messages
  MSG_DELETE:    { emoji: "🗑️", color: LOG_STYLE.danger,  title: "Message supprimé" },
  MSG_EDIT:      { emoji: "✏️", color: LOG_STYLE.warning, title: "Message modifié" },

  // Modération
  MOD_WARN:      { emoji: "⚠️", color: LOG_STYLE.warning, title: "Warn" },
  MOD_TIMEOUT:   { emoji: "⏳", color: LOG_STYLE.info,    title: "Timeout" },
  MOD_KICK:      { emoji: "👢", color: LOG_STYLE.warning, title: "Expulsion" },
  MOD_BAN:       { emoji: "🔨", color: LOG_STYLE.danger,  title: "Bannissement" },
  MOD_UNWARN:    { emoji: "🧾", color: LOG_STYLE.neutral, title: "Unwarn" },
  MOD_CLEARWARNS:{ emoji: "🧹", color: LOG_STYLE.danger,  title: "Clear warns" },
  MOD_PURGE:     { emoji: "🧽", color: LOG_STYLE.neutral, title: "Purge" },
  MOD_ANTIFLOOD: { emoji: "🚫", color: LOG_STYLE.danger,  title: "Anti-flood déclenché" },

  // Vocal
  VC_JOIN:       { emoji: "📥", color: LOG_STYLE.cyan,    title: "Join vocal" },
  VC_LEAVE:      { emoji: "📤", color: LOG_STYLE.neutral, title: "Leave vocal" },
  VC_MOVE:       { emoji: "🔁", color: LOG_STYLE.brand,   title: "Move vocal" },
  VC_MOD:        { emoji: "🎛️", color: LOG_STYLE.warning, title: "Vocal • Modération" },

  // Serveur
  SRV_CHANNEL_CREATE: { emoji: "📁", color: LOG_STYLE.success, title: "Salon créé" },
  SRV_CHANNEL_DELETE: { emoji: "🗑️", color: LOG_STYLE.danger,  title: "Salon supprimé" },
  SRV_CHANNEL_UPDATE: { emoji: "🛠️", color: LOG_STYLE.info,    title: "Salon modifié" },
  SRV_ROLE_CREATE:    { emoji: "🆕", color: LOG_STYLE.success, title: "Rôle créé" },
  SRV_ROLE_DELETE:    { emoji: "🗑️", color: LOG_STYLE.danger,  title: "Rôle supprimé" },
  SRV_ROLE_UPDATE:    { emoji: "🛡️", color: LOG_STYLE.info,    title: "Rôle modifié" },
  SRV_GUILD_UPDATE:   { emoji: "🏰", color: LOG_STYLE.info,    title: "Serveur modifié" },
  SRV_MEMBER_ROLES:   { emoji: "🏷️", color: LOG_STYLE.info,    title: "Rôles modifiés" },
  SRV_NICK_UPDATE:    { emoji: "📝", color: LOG_STYLE.neutral, title: "Changement de pseudo" }
};

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function userTag(u) {
  if (!u) return "Inconnu";
  return u.tag ? `${u.tag} (${u.id})` : `${u.username || "User"} (${u.id || "?"})`;
}

function chanTag(ch) {
  if (!ch) return "Inconnu";
  return ch.id ? `<#${ch.id}> (${ch.id})` : `${ch.name || "Salon"}`;
}

function trunc(s, n = 1024) {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n - 3) + "..." : t;
}

function makeLogEmbed(guild, opts) {
  // opts: { title, color, emoji, fields, description, thumbUrl, authorUser }
  const e = new EmbedBuilder()
    .setColor(opts.color ?? LOG_STYLE.brand)
    .setTitle(`${opts.emoji ? opts.emoji + " " : ""}${opts.title || "Log"}`)
    .setTimestamp(new Date());

  if (opts.description) e.setDescription(trunc(opts.description, 4096));
  if (opts.thumbUrl) e.setThumbnail(opts.thumbUrl);

  // Auteur (si dispo)
  if (opts.authorUser?.displayAvatarURL) {
    e.setAuthor({ name: opts.authorUser.tag || opts.authorUser.username || "Utilisateur", iconURL: opts.authorUser.displayAvatarURL({ size: 64 }) });
  }

  // Champs
  if (Array.isArray(opts.fields) && opts.fields.length) {
    e.addFields(
      ...opts.fields
        .filter(Boolean)
        .slice(0, 25)
        .map((f) => ({ name: trunc(f.name || "Info", 256), value: trunc(f.value || "*vide*", 1024), inline: !!f.inline }))
    );
  }

  // Footer “premium”
  const gname = guild?.name || "Serveur";
  e.setFooter({ text: `${gname} • Logs Premium • <t:${nowTs()}:T>` });

  return e;
}

// Utilitaire: log rapide
async function logPremium(guild, type, opts, files = []) {
  const embed = makeLogEmbed(guild, opts);
  return sendLog(guild, type, embed, files);
}

// ====== COMMANDS (auto-deploy) ======
const commands = [
  new SlashCommandBuilder()
    .setName("setup-rules")
    .setDescription("Envoie le règlement avec bouton de vérification (staff only).")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("setup-ticketpanel")
    .setDescription("Envoie le panneau tickets (staff only).")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Bannir un membre (staff only).")
    .addUserOption((o) => o.setName("membre").setDescription("Membre").setRequired(true))
    .addStringOption((o) => o.setName("raison").setDescription("Raison").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Expulser un membre (staff only).")
    .addUserOption((o) => o.setName("membre").setDescription("Membre").setRequired(true))
    .addStringOption((o) => o.setName("raison").setDescription("Raison").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout un membre en minutes (staff only).")
    .addUserOption((o) => o.setName("membre").setDescription("Membre").setRequired(true))
    .addIntegerOption((o) => o.setName("minutes").setDescription("Durée en minutes").setRequired(true))
    .addStringOption((o) => o.setName("raison").setDescription("Raison").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Supprime X messages (1 à 100) (staff only).")
    .addIntegerOption((o) => o.setName("nombre").setDescription("Nombre 1-100").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Avertir un membre (staff only).")
    .addUserOption((o) => o.setName("membre").setDescription("Membre").setRequired(true))
    .addStringOption((o) => o.setName("raison").setDescription("Raison").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName("warns")
    .setDescription("Voir les warns d’un membre (staff only).")
    .addUserOption((o) => o.setName("membre").setDescription("Membre").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName("unwarn")
    .setDescription("Retirer un warn par numéro (staff only).")
    .addUserOption((o) => o.setName("membre").setDescription("Membre").setRequired(true))
    .addIntegerOption((o) => o.setName("numero").setDescription("Numéro du warn").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName("clearwarns")
    .setDescription("Supprimer tous les warns d’un membre (staff only).")
    .addUserOption((o) => o.setName("membre").setDescription("Membre").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  // 🎉 GIVEAWAYS
  new SlashCommandBuilder()
    .setName("creategw")
    .setDescription("Créer un giveaway stylé (staff only).")
    .addChannelOption((o) =>
      o
        .setName("salon")
        .setDescription("Salon où envoyer le giveaway")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("rollgw")
    .setDescription("Reroll un giveaway (choisir d'autres gagnants) (staff only).")
    .addStringOption((o) =>
      o.setName("message_id").setDescription("ID du message giveaway").setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("nombre").setDescription("Nombre de gagnants à tirer (défaut 1)").setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("endgw")
    .setDescription("Terminer un giveaway avec l'ID du message (staff only).")
    .addStringOption((o) =>
      o.setName("message_id").setDescription("ID du message giveaway").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("cancelgw")
    .setDescription("Annuler un giveaway (staff only).")
    .addStringOption((o) =>
      o.setName("message_id").setDescription("ID du message giveaway").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((c) => c.toJSON());

// ✅ IMPORTANT: on définit deployCommands AVANT le ready
async function deployCommands() {
  if (!TOKEN || !CLIENT_ID) {
    console.log("⚠️ DISCORD_TOKEN ou CLIENT_ID manquant. Commands non déployées.");
    return;
  }
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    console.log("📦 Déploiement des commandes...");
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log("✅ Commandes déployées (GUILD) !");
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log("✅ Commandes déployées (GLOBAL) ! (peut prendre du temps à apparaître)");
    }
  } catch (e) {
    console.error("❌ Erreur deploy commands:", e);
  }
}

// ====== GIVEAWAYS (persistant local file) ======
const GIVEAWAY_FILE = path.join(__dirname, "giveaways.json");

function ensureGiveawayFile() {
  if (!fs.existsSync(GIVEAWAY_FILE)) fs.writeFileSync(GIVEAWAY_FILE, JSON.stringify({}, null, 2), "utf8");
}

function loadGiveaways() {
  ensureGiveawayFile();
  try {
    return JSON.parse(fs.readFileSync(GIVEAWAY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveGiveaways(data) {
  fs.writeFileSync(GIVEAWAY_FILE, JSON.stringify(data, null, 2), "utf8");
}

function parseDurationToMs(input) {
  // ex: 10m, 2h, 1d, 30s
  const m = String(input || "").trim().toLowerCase().match(/^(\d+)\s*(s|m|h|d)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}


// ====== SAFE TIMEOUT (évite Overflow > ~24.8 jours) ======
const MAX_TIMEOUT = 2_147_483_647; // ~24.8 jours en ms (limite Node.js setTimeout)

function safeSetTimeout(fn, ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (delay <= MAX_TIMEOUT) return setTimeout(fn, delay);
  return setTimeout(() => safeSetTimeout(fn, delay - MAX_TIMEOUT), MAX_TIMEOUT);
}
function progressBar(endAt, createdAt, width = 12) {
  const now = Date.now();
  const total = Math.max(1, endAt - createdAt);
  const done = Math.min(total, Math.max(0, now - createdAt));
  const ratio = done / total;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

function randSample(arr, k) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

async function updateGiveawayMessage(gw, channel) {
  const embed = new EmbedBuilder()
    .setTitle(`🎉 GIVEAWAY — ${gw.title}`)
    .setDescription(
      `${gw.description ? gw.description + "\n\n" : ""}` +
        `**🎁 Lot :** ${gw.prize}\n` +
        `**👥 Gagnant(s) :** ${gw.winners}\n` +
        `**⏳ Fin :** <t:${Math.floor(gw.endAt / 1000)}:R>\n` +
        `**📊 Progression :** ${progressBar(gw.endAt, gw.createdAt)}\n\n` +
        `Clique sur **Participer** pour entrer !\n\n_⟳ Mise à jour auto toutes les 60s_`
    )
    .setFooter({ text: `ID: ${gw.id}` })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gw_join:${gw.id}`)
      .setLabel(`Participer (${(gw.participants || []).length})`)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`gw_end:${gw.id}`)
      .setLabel("Terminer")
      .setStyle(ButtonStyle.Danger)
  );

  await channel.messages.edit(gw.messageId, { embeds: [embed], components: [row] }).catch(() => null);
}

async function finishGiveaway(gwId, reason = "ended") {
  const data = loadGiveaways();
  const gw = data[gwId];
  if (!gw || gw.ended) return;

  gw.ended = true;
  gw.endReason = reason;
  gw.endedAt = Date.now();

  stopGiveawayTimers(gw.id);

  const participants = Array.from(new Set(gw.participants || []));
  const winners = participants.length ? randSample(participants, Math.min(gw.winners, participants.length)) : [];

  gw.winnerIds = winners;
  saveGiveaways(data);

  const guild = client.guilds.cache.get(gw.guildId);
  if (!guild) return;

  const channel = await getChannel(guild, gw.channelId);
  if (!channel) return;

  const resultEmbed = new EmbedBuilder()
    .setTitle(`🏁 GIVEAWAY terminé — ${gw.title}`)
    .setDescription(
      `**🎁 Lot :** ${gw.prize}\n` +
        `**👥 Participants :** ${participants.length}\n` +
        (winners.length
          ? `**🏆 Gagnant(s) :** ${winners.map((id) => `<@${id}>`).join(", ")}`
          : `**🏆 Gagnant(s) :** Aucun (personne n'a participé)`)
    )
    .setFooter({ text: `ID: ${gw.id}` })
    .setTimestamp();

  await channel.messages.edit(gw.messageId, { embeds: [resultEmbed], components: [] }).catch(() => null);

  if (winners.length) {
    const winnerGif = process.env.WINNER_GIF_URL || null;

    const winEmbed = new EmbedBuilder()
      .setTitle("🏆 W I N N E R 🏆")
      .setDescription(
        "🎊🎊🎊 **FÉLICITATIONS !** 🎊🎊🎊\n\n" +
          `**Gagnant(s) :** ${winners.map((id) => `<@${id}>`).join(", ")}\n` +
          `**Lot :** **${gw.prize}**\n\n` +
          "🔥 Tu viens de gagner le giveaway !"
      )
      .setFooter({ text: `Giveaway: ${gw.title}` })
      .setTimestamp();

    if (winnerGif) winEmbed.setImage(winnerGif);

    await channel.send({ embeds: [winEmbed] }).catch(() => null);
  } else {
    await channel.send("😢 Personne n'a participé au giveaway.").catch(() => null);
  }
}

const giveawayTimers = new Map();
const giveawayIntervals = new Map();

function stopGiveawayTimers(gwId) {
  if (giveawayTimers.has(gwId)) {
    clearTimeout(giveawayTimers.get(gwId));
    giveawayTimers.delete(gwId);
  }
  if (giveawayIntervals.has(gwId)) {
    clearInterval(giveawayIntervals.get(gwId));
    giveawayIntervals.delete(gwId);
  }
}

function scheduleGiveawayRefresh(gw) {
  if (!gw || gw.ended) return;
  if (giveawayIntervals.has(gw.id)) clearInterval(giveawayIntervals.get(gw.id));

  const interval = setInterval(async () => {
    try {
      const data = loadGiveaways();
      const live = data[gw.id];
      if (!live || live.ended) {
        stopGiveawayTimers(gw.id);
        return;
      }
      const guild = client.guilds.cache.get(live.guildId);
      if (!guild) return;
      const ch = await getChannel(guild, live.channelId);
      if (!ch) return;
      await updateGiveawayMessage(live, ch);
    } catch {}
  }, 60_000);

  giveawayIntervals.set(gw.id, interval);
}

function scheduleGiveawayEnd(gw) {
  scheduleGiveawayRefresh(gw);
  if (!gw || gw.ended) return;
  const ms = Math.max(0, gw.endAt - Date.now());
  if (giveawayTimers.has(gw.id)) clearTimeout(giveawayTimers.get(gw.id));
  giveawayTimers.set(gw.id, safeSetTimeout(() => finishGiveaway(gw.id, "time").catch(() => null), ms));
}

// ====== WARNS (persistants local file) ======
const WARN_FILE = path.join(__dirname, "warns.json");

function ensureWarnFile() {
  if (!fs.existsSync(WARN_FILE)) fs.writeFileSync(WARN_FILE, JSON.stringify({}, null, 2), "utf8");
}

function loadWarns() {
  ensureWarnFile();
  try {
    return JSON.parse(fs.readFileSync(WARN_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveWarns(data) {
  fs.writeFileSync(WARN_FILE, JSON.stringify(data, null, 2), "utf8");
}

function addWarn(guildId, userId, warn) {
  const data = loadWarns();
  data[guildId] ||= {};
  data[guildId][userId] ||= [];
  data[guildId][userId].push(warn);
  saveWarns(data);
  return data[guildId][userId].length;
}

function getWarns(guildId, userId) {
  const data = loadWarns();
  return data[guildId]?.[userId] || [];
}

function removeWarn(guildId, userId, index1based) {
  const data = loadWarns();
  const arr = data[guildId]?.[userId];
  if (!arr || index1based < 1 || index1based > arr.length) return false;
  arr.splice(index1based - 1, 1);
  saveWarns(data);
  return true;
}

function clearWarns(guildId, userId) {
  const data = loadWarns();
  if (!data[guildId] || !data[guildId][userId]) return false;
  data[guildId][userId] = [];
  saveWarns(data);
  return true;
}

// ====== TICKETS (anti-spam) ======
const openTickets = new Set(); // userId
const ticketCooldown = new Map(); // userId -> timestamp
const COOLDOWN_MS = 2 * 60 * 1000; // 2 min

async function buildTicketTranscriptText(channel) {
  const all = [];
  let lastId = null;

  while (true) {
    const fetched = await channel.messages.fetch({ limit: 100, before: lastId }).catch(() => null);
    if (!fetched || fetched.size === 0) break;
    all.push(...fetched.values());
    lastId = fetched.last().id;
    if (fetched.size < 100) break;
  }

  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  const lines = [];
  lines.push(`Transcript Ticket - #${channel.name}`);
  lines.push(`Channel ID: ${channel.id}`);
  lines.push(`Guild: ${channel.guild.name} (${channel.guild.id})`);
  lines.push(`Created: ${new Date(channel.createdTimestamp).toISOString()}`);
  lines.push(`Topic: ${channel.topic || ""}`);
  lines.push("=".repeat(70));

  for (const m of all) {
    const time = new Date(m.createdTimestamp).toISOString();
    const author = m.author ? `${m.author.tag} (${m.author.id})` : "Unknown";
    const content = m.content ? m.content.replace(/\n/g, "\\n") : "";

    const attachments = [...m.attachments.values()].map((a) => a.url);
    const attText = attachments.length ? ` | attachments: ${attachments.join(" , ")}` : "";

    const extras = [];
    if (m.embeds?.length) extras.push(`embeds:${m.embeds.length}`);
    if (m.stickers?.size) extras.push(`stickers:${m.stickers.size}`);
    const extraText = extras.length ? ` | ${extras.join(" ")}` : "";

    lines.push(`[${time}] ${author}: ${content}${attText}${extraText}`);
  }

  return lines.join("\n");
}

// ====== READY ======
client.once(Events.ClientReady, async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
  await deployCommands();

  // Replanifier les giveaways en cours après restart
  try {
    const gws = loadGiveaways();
    for (const gw of Object.values(gws)) {
      if (!gw.ended) scheduleGiveawayEnd(gw);
    }
    console.log(`🎉 Giveaways rechargés: ${Object.values(gws).filter((g) => !g.ended).length} en cours`);
  } catch {
    console.log("ℹ️ Pas de giveaways à recharger");
  }
});

// ====== LOGS : MEMBRES ======
client.on("guildMemberAdd", async (member) => {
  // 1) MESSAGE PUBLIC WELCOME
  if (WELCOME_CHANNEL_ID) {
    const welcomeChannel = await getChannel(member.guild, WELCOME_CHANNEL_ID);
    if (welcomeChannel) {
      const embed = new EmbedBuilder()
        .setTitle("🎉 Nouveau membre !")
        .setDescription(
          `Bienvenue ${member} sur **${member.guild.name}** !\n\n` +
            "🙏 Merci d’avoir rejoint le serveur !\n" +
            "📜 Pense à lire le règlement et profite du serveur 💙"
        )
        .addFields(
          { name: "👤 Membre", value: `${member.user.tag}`, inline: true },
          { name: "🆔 ID", value: `${member.id}`, inline: true },
          { name: "📅 Compte créé", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>` }
        )
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
        .setFooter({ text: `${member.guild.name} • Bienvenue` })
        .setTimestamp();

      await welcomeChannel.send({ content: `👋 ${member}`, embeds: [embed] }).catch(() => null);
    }
  }

  // 2) PING DANS LE SALON RÈGLEMENT (supprime après 5s)
  if (REGLEMENT_CHANNEL_ID) {
    const rulesChannel = await getChannel(member.guild, REGLEMENT_CHANNEL_ID);
    if (rulesChannel) {
      const msg = await rulesChannel.send({ content: `📌 ${member} pense à lire le règlement et clique sur **Accepter** ✅` }).catch(() => null);
      if (msg) setTimeout(() => msg.delete().catch(() => null), 5000);
    }
  }

  // 3) DM PRIVÉ DE BIENVENUE
  const dmEmbed = new EmbedBuilder()
    .setTitle(`Bienvenue sur ${member.guild.name} 🎉`)
    .setDescription(
      "Merci d’avoir rejoint le serveur ! 🙌\n\n" +
        "📜 Lis le règlement pour bien commencer.\n" +
        "🎫 Besoin d’aide ? Ouvre un ticket support.\n\n" +
        "Bon séjour parmi nous 💙"
    )
    .setThumbnail(member.guild.iconURL() || null)
    .setTimestamp();

  await member.send({ embeds: [dmEmbed] }).catch(() => null);

  // 4) LOG MEMBERS
    await logPremium(member.guild, "members", {
    presetKey: "MEMBER_JOIN",
    thumbUrl: member.user.displayAvatarURL({ size: 256 }),
    fields: [
      { name: "👤 Utilisateur", value: userTag(member.user) },
      { name: "📅 Compte créé", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:F> • <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>` },
      { name: "📥 Rejoint", value: `<t:${Math.floor(Date.now() / 1000)}:F> • <t:${Math.floor(Date.now() / 1000)}:R>` }
    ]
  });
});


// ====== LOGS : MEMBRES (LEAVE) ======
client.on("guildMemberRemove", async (member) => {
  const guild = member.guild;
  const u = member.user;

  await logPremium(guild, "members", {
    presetKey: "MEMBER_LEAVE",
    authorUser: u,
    thumbUrl: u?.displayAvatarURL ? u.displayAvatarURL({ size: 256 }) : null,
    fields: [
      { name: "👤 Utilisateur", value: u ? userTag(u) : "Inconnu" },
      { name: "📤 Départ", value: `<t:${nowTs()}:F> • <t:${nowTs()}:R>` },
      { name: "📅 Compte créé", value: u ? `<t:${Math.floor(u.createdTimestamp / 1000)}:F> • <t:${Math.floor(u.createdTimestamp / 1000)}:R>` : "*?" }
    ]
  });
});

// ====== LOGS : ROLES / NICKNAME / TIMEOUT ======
client.on("guildMemberUpdate", async (oldM, newM) => {
  const oldRoles = new Set(oldM.roles.cache.keys());
  const newRoles = new Set(newM.roles.cache.keys());

  const added = [...newRoles].filter((r) => !oldRoles.has(r));
  const removed = [...oldRoles].filter((r) => !newRoles.has(r));

  if (added.length || removed.length) {
    const executorTag = await getAuditExecutorTag(newM.guild, AuditLogEvent.MemberRoleUpdate, newM.id);

    const roleEmbed = new EmbedBuilder()
      .setTitle(`${LOG_PRESET.SRV_MEMBER_ROLES.emoji} ${LOG_PRESET.SRV_MEMBER_ROLES.title}`)
      .setColor(LOG_PRESET.SRV_MEMBER_ROLES.color)
      .setDescription(`Membre: **${newM.user.tag}** (${newM.id})`)
      .addFields(
        { name: "✅ Ajoutés", value: added.length ? added.map((id) => `<@&${id}>`).join(", ") : "*Aucun*" },
        { name: "❌ Retirés", value: removed.length ? removed.map((id) => `<@&${id}>`).join(", ") : "*Aucun*" },
        { name: "👮 Modifié par", value: executorTag }
      )
      .setFooter({ text: `${newM.guild.name} • Logs serveur` })
      .setTimestamp();

    await sendLog(newM.guild, "server", roleEmbed);
  }

  if (oldM.nickname !== newM.nickname) {
    const executorTag = await getAuditExecutorTag(newM.guild, AuditLogEvent.MemberUpdate, newM.id);

    const nickEmbed = new EmbedBuilder()
      .setTitle(`${LOG_PRESET.SRV_NICK_UPDATE.emoji} ${LOG_PRESET.SRV_NICK_UPDATE.title}`)
      .setColor(LOG_PRESET.SRV_NICK_UPDATE.color)
      .addFields(
        { name: "Membre", value: `${newM.user.tag} (${newM.id})` },
        { name: "Ancien pseudo", value: oldM.nickname || "*Aucun*" },
        { name: "Nouveau pseudo", value: newM.nickname || "*Aucun*" },
        { name: "Modifié par", value: executorTag }
      )
      .setTimestamp();

    await sendLog(newM.guild, "server", nickEmbed);
  }

  if (oldM.communicationDisabledUntilTimestamp !== newM.communicationDisabledUntilTimestamp) {
    const executorTag = await getAuditExecutorTag(newM.guild, AuditLogEvent.MemberUpdate, newM.id);

    const timeoutEmbed = new EmbedBuilder()
      .setTitle(`${LOG_PRESET.MOD_TIMEOUT.emoji} Timeout modifié`)
      .setColor(LOG_PRESET.MOD_TIMEOUT.color)
      .addFields(
        { name: "Membre", value: `${newM.user.tag} (${newM.id})` },
        { name: "Ancien état", value: oldM.communicationDisabledUntilTimestamp ? "Timeout actif" : "Aucun" },
        { name: "Nouveau état", value: newM.communicationDisabledUntilTimestamp ? "Timeout actif" : "Aucun" },
        { name: "Modifié par", value: executorTag }
      )
      .setTimestamp();

    await sendLog(newM.guild, "mod", timeoutEmbed);
  }
});

// ====== LOGS : MESSAGES ======
client.on("messageDelete", async (msg) => {
  if (!msg.guild) return;
  if (msg.author?.bot) return;

    const att = msg.attachments?.size ? [...msg.attachments.values()].map(a => a.url).slice(0, 3) : [];
  await logPremium(msg.guild, "messages", {
    presetKey: "MSG_DELETE",
    authorUser: msg.author,
    fields: [
      { name: "👤 Auteur", value: msg.author ? userTag(msg.author) : "Inconnu" },
      { name: "💬 Salon", value: chanTag(msg.channel), inline: true },
      { name: "🆔 Message", value: `\`${msg.id}\``, inline: true },
      { name: "📝 Contenu", value: "```" + trunc(msg.content || "*vide/attachment*", 900) + "```" },
      ...(att.length ? [{ name: "📎 Pièces jointes", value: att.join("\n") }] : [])
    ]
  });
});

client.on("messageUpdate", async (oldMsg, newMsg) => {
  if (!newMsg.guild) return;
  if (newMsg.author?.bot) return;

  const before = oldMsg.content ?? "";
  const after = newMsg.content ?? "";
  if (before === after) return;

    await logPremium(newMsg.guild, "messages", {
    presetKey: "MSG_EDIT",
    authorUser: newMsg.author,
    fields: [
      { name: "👤 Auteur", value: userTag(newMsg.author) },
      { name: "💬 Salon", value: chanTag(newMsg.channel), inline: true },
      { name: "🆔 Message", value: `\`${newMsg.id}\``, inline: true },
      { name: "🔗 Lien", value: newMsg.url ? `[Aller au message](${newMsg.url})` : "*indispo*", inline: false },
      { name: "Avant", value: "```" + trunc(before || "*vide*", 800) + "```" },
      { name: "Après", value: "```" + trunc(after || "*vide*", 800) + "```" }
    ]
  });
});

// ====== LOGS : VOCAL (join/leave/mute/deaf) ======
client.on("voiceStateUpdate", async (oldState, newState) => {
  const guild = newState.guild;
  const member = newState.member;
  const user = member?.user;
  if (!user) return;

  const oldCh = oldState.channel;
  const newCh = newState.channel;

  // Join / Leave / Move
  if (oldCh?.id !== newCh?.id) {
    const presetKey = !oldCh && newCh ? "VC_JOIN" : oldCh && !newCh ? "VC_LEAVE" : "VC_MOVE";

    await logPremium(guild, "voice", {
      presetKey,
      authorUser: user,
      thumbUrl: user.displayAvatarURL({ size: 128 }),
      fields: [
        { name: "👤 Membre", value: `${member} • ${userTag(user)}` },
        { name: "Avant", value: oldCh ? `${oldCh} • \`${oldCh.id}\`` : "*aucun*", inline: true },
        { name: "Après", value: newCh ? `${newCh} • \`${newCh.id}\`` : "*aucun*", inline: true },
        { name: "⏱️ Heure", value: `<t:${nowTs()}:F> • <t:${nowTs()}:R>` }
      ]
    });
  }

  // Mute / Deaf serveur (modération)
  const muteChanged = oldState.serverMute !== newState.serverMute;
  const deafChanged = oldState.serverDeaf !== newState.serverDeaf;

  if (muteChanged || deafChanged) {
    const audit = await fetchAuditEntry(guild, AuditLogEvent.MemberUpdate, member.id);

    const fields = [
      { name: "👤 Membre", value: `${member} • ${userTag(user)}` },
      muteChanged ? { name: "🔇 ServerMute", value: `**${oldState.serverMute}** → **${newState.serverMute}**`, inline: true } : null,
      deafChanged ? { name: "🔈 ServerDeaf", value: `**${oldState.serverDeaf}** → **${newState.serverDeaf}**`, inline: true } : null,
      { name: "📋 Audit", value: audit ? `Executor: **${audit.executor}**\nReason: ${audit.reason}\nEntry: \`${audit.id}\`` : "*Indispo*" }
    ].filter(Boolean);

    await logPremium(guild, "voice", {
      presetKey: "VC_MOD",
      authorUser: user,
      thumbUrl: user.displayAvatarURL({ size: 128 }),
      fields
    });
  }
});

// ====== LOGS : SERVEUR ======
client.on("channelCreate", async (channel) => {
  if (!channel.guild) return;
  const executorTag = await getAuditExecutorTag(channel.guild, AuditLogEvent.ChannelCreate, channel.id);

    await logPremium(channel.guild, "server", {
    presetKey: "SRV_CHANNEL_CREATE",
    fields: [
      { name: "💬 Salon", value: `${channel} (\`${channel.id}\`)` },
      { name: "📌 Type", value: `${channel.type}`, inline: true },
      { name: "👮 Créé par", value: executorTag, inline: true }
    ]
  });
});

client.on("channelDelete", async (channel) => {
  if (!channel.guild) return;

  if (channel.type === ChannelType.GuildText) {
    const ownerId = ticketOwnerFromTopic(channel.topic);
    if (ownerId) openTickets.delete(ownerId);
  }

  const executorTag = await getAuditExecutorTag(channel.guild, AuditLogEvent.ChannelDelete, channel.id);

    await logPremium(channel.guild, "server", {
    presetKey: "SRV_CHANNEL_DELETE",
    fields: [
      { name: "💬 Salon", value: `#${channel.name} (\`${channel.id}\`)` },
      { name: "👮 Supprimé par", value: executorTag }
    ]
  });
});

client.on("channelUpdate", async (oldCh, newCh) => {
  if (!newCh.guild) return;

  const changes = [];
  if (oldCh.name !== newCh.name) changes.push(`Nom: **${oldCh.name}** → **${newCh.name}**`);
  if ((oldCh.topic || "") !== (newCh.topic || ""))
    changes.push(`Topic: **${cleanText(oldCh.topic || "", 200)}** → **${cleanText(newCh.topic || "", 200)}**`);
  if (!changes.length) return;

  const executorTag = await getAuditExecutorTag(newCh.guild, AuditLogEvent.ChannelUpdate, newCh.id);

    await logPremium(newCh.guild, "server", {
    presetKey: "SRV_CHANNEL_UPDATE",
    fields: [
      { name: "💬 Salon", value: `${newCh} (\`${newCh.id}\`)` },
      { name: "🧾 Changements", value: changes.join("\n").slice(0, 1024) },
      { name: "👮 Modifié par", value: executorTag }
    ]
  });
});

// ====== Interaction handling ======
client.on("interactionCreate", async (interaction) => {
  if (!interaction.inGuild()) return;

  // ===== BOUTONS =====
  if (interaction.isButton()) {
    if (interaction.customId === "verify_rules") {
      if (!MEMBER_ROLE_ID) return interaction.reply({ content: "❌ Rôle membre non configuré.", ...eph() });

      const role = interaction.guild.roles.cache.get(MEMBER_ROLE_ID);
      if (!role) return interaction.reply({ content: "❌ Rôle introuvable.", ...eph() });

      await interaction.member.roles.add(role).catch(() => null);
      return interaction.reply({ content: "✅ Vous avez accepté le règlement !", ...eph() });
    }

    if (interaction.customId === "open_ticket") {
      if (openTickets.has(interaction.user.id))
        return interaction.reply({ content: "❌ Vous avez déjà un ticket ouvert.", ...eph() });

      const now = Date.now();
      const last = ticketCooldown.get(interaction.user.id) || 0;
      if (now - last < COOLDOWN_MS)
        return interaction.reply({ content: "⏳ Veuillez patienter avant de rouvrir un ticket.", ...eph() });

      await interaction.deferReply({ ...eph() });

      const channel = await interaction.guild.channels.create({
        name: sanitizeChannelName(`ticket-${interaction.user.username}`),
        type: ChannelType.GuildText,
        parent: TICKETS_CATEGORY_ID || null,
        topic: `ticketOwner:${interaction.user.id}`,
        permissionOverwrites: [
          { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          {
            id: interaction.user.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ReadMessageHistory
            ]
          },
          ...(STAFF_ROLE_ID
            ? [
                {
                  id: STAFF_ROLE_ID,
                  allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory
                  ]
                }
              ]
            : [])
        ]
      });

      openTickets.add(interaction.user.id);
      ticketCooldown.set(interaction.user.id, now);

      const ticketEmbed = new EmbedBuilder()
        .setTitle("🎫 Ticket ouvert")
        .setDescription(
          `Salut <@${interaction.user.id}> 👋\n\n` +
            "Décris ton problème **clairement** (screens, détails, etc.).\n" +
            "Le staff arrive dès que possible."
        )
        .addFields(
          { name: "📌 Infos", value: `Utilisateur: **${interaction.user.tag}**\nID: \`${interaction.user.id}\`` },
          { name: "🕒 Ouvert le", value: `${new Date().toLocaleString("fr-FR")}` }
        )
        .setFooter({ text: `${interaction.guild.name} • Support` })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("close_ticket").setLabel("🔒 Fermer (staff)").setStyle(ButtonStyle.Danger)
      );

      await channel.send({ embeds: [ticketEmbed], components: [row] }).catch(() => null);

      await sendLog(
        interaction.guild,
        "mod",
        new EmbedBuilder()
          .setTitle("🎫 Ticket créé")
          .addFields(
            { name: "Utilisateur", value: `${interaction.user.tag} (${interaction.user.id})` },
            { name: "Salon", value: `${channel} (${channel.id})` }
          )
          .setTimestamp()
      );

      return interaction.editReply(`✅ Ticket ouvert : ${channel}`);
    }

    // Giveaway: participer
    if (interaction.customId.startsWith("gw_join:")) {
      const gwId = interaction.customId.split(":")[1];
      const data = loadGiveaways();
      const gw = data[gwId];
      if (!gw) return interaction.reply({ content: "❌ Giveaway introuvable.", ...eph() });
      if (gw.ended) return interaction.reply({ content: "⏳ Ce giveaway est déjà terminé.", ...eph() });

      gw.participants ||= [];
      if (gw.participants.includes(interaction.user.id)) {
        return interaction.reply({ content: "✅ Tu participes déjà !", ...eph() });
      }

      gw.participants.push(interaction.user.id);
      saveGiveaways(data);

      const ch = await getChannel(interaction.guild, gw.channelId);
      if (ch) await updateGiveawayMessage(gw, ch);

      return interaction.reply({ content: "🎉 Participation enregistrée ! Bonne chance 🍀", ...eph() });
    }

    // Giveaway: terminer (staff only)
    if (interaction.customId.startsWith("gw_end:")) {
      if (!isStaff(interaction.member) && !interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({ content: "❌ Seul le staff peut terminer un giveaway.", ...eph() });
      }
      const gwId = interaction.customId.split(":")[1];
      await interaction.reply({ content: "🏁 Je termine le giveaway...", ...eph() });
      await finishGiveaway(gwId, "manual").catch(() => null);
      return;
    }

    // Fermer ticket + transcript
    if (interaction.customId === "close_ticket") {
      if (!isStaff(interaction.member))
        return interaction.reply({ content: "❌ Seul le staff peut fermer les tickets.", ...eph() });

      const ch = interaction.channel;
      const ownerId = ticketOwnerFromTopic(ch.topic);

      await interaction.reply({ content: "🔒 Fermeture du ticket... Génération du transcript 📄", ...eph() });

      const text = await buildTicketTranscriptText(ch).catch(() => "Transcript indisponible (erreur).");
      const filename = `transcript-${ch.name}-${Date.now()}.txt`;

            await logPremium(interaction.guild, "mod", {
        title: "Ticket fermé",
        emoji: "🔒",
        color: LOG_STYLE.neutral,
        authorUser: interaction.user,
        fields: [
          { name: "💬 Salon", value: chanTag(ch) },
          { name: "👤 Propriétaire", value: ownerId ? `<@${ownerId}> (${ownerId})` : "Inconnu" },
          { name: "🔧 Fermé par", value: userTag(interaction.user) }
        ]
      }, [{ attachment: Buffer.from(text, "utf8"), name: filename }]);

      if (ownerId) openTickets.delete(ownerId);
      setTimeout(() => ch.delete().catch(() => null), 2500);
      return;
    }
  }

  // ===== MODALS (Giveaway) =====
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith("gw_create:")) {
      const channelId = interaction.customId.split(":")[1];

      const title = interaction.fields.getTextInputValue("gw_title")?.trim();
      const prize = interaction.fields.getTextInputValue("gw_prize")?.trim();
      const durationRaw = interaction.fields.getTextInputValue("gw_duration")?.trim(); // ex: 30m
      const winnersRaw = interaction.fields.getTextInputValue("gw_winners")?.trim();
      const description = interaction.fields.getTextInputValue("gw_desc")?.trim();

      const durationMs = parseDurationToMs(durationRaw);
      const winners = Math.max(1, Math.min(20, parseInt(winnersRaw || "1", 10) || 1));

      if (!title || !prize || !durationMs) {
        return interaction.reply({
          content: "❌ Champs invalides. Durée: utilise un format comme `30m`, `2h`, `1d`.",
          ...eph()
        });
      }

      const guild = interaction.guild;
      const ch = await getChannel(guild, channelId);
      if (!ch) return interaction.reply({ content: "❌ Salon introuvable.", ...eph() });

      const gwId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const endAt = Date.now() + durationMs;

      const embed = new EmbedBuilder()
        .setTitle(`🎉 GIVEAWAY — ${title}`)
        .setDescription(
          `${description ? description + "\n\n" : ""}` +
            `**🎁 Lot :** ${prize}\n` +
            `**👥 Gagnant(s) :** ${winners}\n` +
            `**⏳ Fin :** <t:${Math.floor(endAt / 1000)}:R>\n` +
            `**📊 Progression :** ${progressBar(endAt, Date.now())}\n\n` +
            `Clique sur **Participer** pour entrer !\n\n_⟳ Mise à jour auto toutes les 60s_`
        )
        .setFooter({ text: `Créé par ${interaction.user.tag}` })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gw_join:${gwId}`).setLabel("Participer (0)").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`gw_end:${gwId}`).setLabel("Terminer").setStyle(ButtonStyle.Danger)
      );

      const msg = await ch.send({ embeds: [embed], components: [row] });

      const data = loadGiveaways();
      data[gwId] = {
        id: gwId,
        guildId: guild.id,
        channelId: ch.id,
        messageId: msg.id,
        title,
        prize,
        description: description || "",
        winners,
        endAt,
        createdAt: Date.now(),
        createdBy: interaction.user.id,
        participants: [],
        ended: false
      };
      saveGiveaways(data);
      scheduleGiveawayEnd(data[gwId]);

      await logPremium(guild, "server", {
        title: "Giveaway créé",
        emoji: "🎉",
        color: LOG_STYLE.success,
        authorUser: interaction.user,
        fields: [
          { name: "📌 Titre", value: trunc(title, 200) },
          { name: "🎁 Lot", value: trunc(prize, 300) },
          { name: "💬 Salon", value: chanTag(ch) },
          { name: "⏳ Fin", value: `<t:${Math.floor(endAt / 1000)}:F> • <t:${Math.floor(endAt / 1000)}:R>` },
          { name: "🆔 Message", value: `\`${msg.id}\`` }
        ]
      });

      return interaction.reply({
        content: `✅ Giveaway créé dans ${ch} !\nID message: \`${msg.id}\``,
        ...eph()
      });
    }
  }

  // ===== SLASH COMMANDS =====
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options } = interaction;

  // IMPORTANT: showModal() doit être appelé AVANT tout deferReply/reply
  if (commandName === "creategw") {
    const salon = options.getChannel("salon");
    if (!salon || salon.type !== ChannelType.GuildText) {
      return interaction.reply({ content: "❌ Choisis un salon texte valide.", ...eph() });
    }

    const { ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");

    const modal = new ModalBuilder().setCustomId(`gw_create:${salon.id}`).setTitle("Créer un Giveaway 🎉");

    const titleInput = new TextInputBuilder()
      .setCustomId("gw_title")
      .setLabel("Titre du giveaway")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Ex: Nitro 1 mois")
      .setRequired(true)
      .setMaxLength(80);

    const prizeInput = new TextInputBuilder()
      .setCustomId("gw_prize")
      .setLabel("Lot à gagner")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Ex: 1x Nitro / 10€ PayPal / rôle VIP")
      .setRequired(true)
      .setMaxLength(120);

    const durationInput = new TextInputBuilder()
      .setCustomId("gw_duration")
      .setLabel("Durée (format: 30m / 2h / 1d)")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Ex: 30m")
      .setRequired(true)
      .setMaxLength(10);

    const winnersInput = new TextInputBuilder()
      .setCustomId("gw_winners")
      .setLabel("Nombre de gagnants (1-20)")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Ex: 1")
      .setRequired(true)
      .setMaxLength(2);

    const descInput = new TextInputBuilder()
      .setCustomId("gw_desc")
      .setLabel("Message/description (optionnel)")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("Ex: Réagis en cliquant sur Participer 🍀")
      .setRequired(false)
      .setMaxLength(400);

    modal.addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(prizeInput),
      new ActionRowBuilder().addComponents(durationInput),
      new ActionRowBuilder().addComponents(winnersInput),
      new ActionRowBuilder().addComponents(descInput)
    );

    return interaction.showModal(modal);
  }

  await interaction.deferReply({ ...eph() });

  try {
    if (commandName === "setup-rules") {
      const embed = new EmbedBuilder()
        .setTitle("📜 Règlement du serveur")
        .setDescription(
          "Bienvenue ! Merci de lire le règlement.\n\n" +
            "✅ Clique sur **Accepter le règlement** pour obtenir l’accès membre.\n" +
            "⚠️ Le non-respect peut entraîner des sanctions."
        )
        .addFields(
          { name: "🔹 Respect", value: "Pas d’insultes, harcèlement, provocations." },
          { name: "🔹 Contenu", value: "Pas de NSFW, pubs, ou contenus illégaux." },
          { name: "🔹 Spam", value: "Pas de flood / ping abusif / messages inutiles." }
        )
        .setFooter({ text: `${interaction.guild.name} • Vérification` })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("verify_rules").setLabel("✅ Accepter le règlement").setStyle(ButtonStyle.Success)
      );

      await interaction.channel.send({ embeds: [embed], components: [row] });
      return interaction.editReply("✅ Règlement envoyé.");
    }

    if (commandName === "setup-ticketpanel") {
      const embed = new EmbedBuilder()
        .setTitle("🎫 Support & Tickets")
        .setDescription(
          "Tu as une question, un souci, ou besoin du staff ?\n\n" +
            "➡️ Clique sur **Ouvrir un ticket** pour créer un salon privé."
        )
        .addFields(
          { name: "🔒 Confidentialité", value: "Visible seulement par toi + staff.", inline: true },
          { name: "🕒 Réponse", value: "Le staff répond dès que possible.", inline: true }
        )
        .setFooter({ text: `${interaction.guild.name} • Support` })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("open_ticket").setLabel("➕ Ouvrir un ticket").setStyle(ButtonStyle.Primary)
      );

      await interaction.channel.send({ embeds: [embed], components: [row] });
      return interaction.editReply("✅ Panneau envoyé.");
    }

    if (commandName === "endgw") {
      const messageId = options.getString("message_id");
      const data = loadGiveaways();
      const gw = Object.values(data).find((g) => g.messageId === messageId && g.guildId === interaction.guild.id);
      if (!gw) return interaction.editReply("❌ Giveaway introuvable.");
      if (gw.ended) return interaction.editReply("⏳ Giveaway déjà terminé.");
      await finishGiveaway(gw.id, "manual").catch(() => null);

      await logPremium(interaction.guild, "server", {
        title: "Giveaway terminé",
        emoji: "🏁",
        color: LOG_STYLE.warning,
        authorUser: interaction.user,
        fields: [
          { name: "📌 Titre", value: trunc(gw.title, 200) },
          { name: "🎁 Lot", value: trunc(gw.prize, 300) },
          { name: "💬 Salon", value: `<#${gw.channelId}> (${gw.channelId})` },
          { name: "🆔 Message", value: `\`${gw.messageId}\`` }
        ]
      });

      return interaction.editReply("🏁 Giveaway terminé !");
    }

    if (commandName === "cancelgw") {
      const messageId = options.getString("message_id");
      const data = loadGiveaways();
      const gwEntry = Object.entries(data).find(([, g]) => g.messageId === messageId && g.guildId === interaction.guild.id);
      if (!gwEntry) return interaction.editReply("❌ Giveaway introuvable.");

      const [gwId, gw] = gwEntry;
      stopGiveawayTimers(gwId);
      delete data[gwId];
      saveGiveaways(data);

      const ch = await getChannel(interaction.guild, gw.channelId);
      if (ch) {
        await ch.messages.edit(gw.messageId, { content: "❌ **Giveaway annulé par le staff.**", embeds: [], components: [] }).catch(() => null);
      }
            await logPremium(interaction.guild, "server", {
        title: "Giveaway annulé",
        emoji: "🛑",
        color: LOG_STYLE.danger,
        authorUser: interaction.user,
        fields: [
          { name: "📌 Titre", value: trunc(gw.title, 200) },
          { name: "🎁 Lot", value: trunc(gw.prize, 300) },
          { name: "💬 Salon", value: `<#${gw.channelId}> (${gw.channelId})` },
          { name: "🆔 Message", value: `\`${gw.messageId}\`` }
        ]
      });

      return interaction.editReply("🛑 Giveaway annulé et supprimé.");
    }

    if (commandName === "rollgw") {
      const messageId = options.getString("message_id");
      const nombre = Math.max(1, Math.min(20, options.getInteger("nombre") || 1));

      const data = loadGiveaways();
      const gw = Object.values(data).find((g) => g.messageId === messageId && g.guildId === interaction.guild.id);

      if (!gw) return interaction.editReply("❌ Giveaway introuvable avec cet ID de message.");
      if (!gw.ended) return interaction.editReply("⏳ Le giveaway n'est pas terminé. Clique sur **Terminer** ou attends la fin.");

      const participants = Array.from(new Set(gw.participants || []));
      if (!participants.length) return interaction.editReply("😢 Aucun participant enregistré.");

      const previous = new Set(gw.winnerIds || []);
      const pool = participants.filter((id) => !previous.has(id));
      const pickFrom = pool.length ? pool : participants;

      const winners = randSample(pickFrom, Math.min(nombre, pickFrom.length));

      gw.rerolls ||= [];
      gw.rerolls.push({ at: Date.now(), by: interaction.user.id, winners });
      saveGiveaways(data);

      await interaction.channel.send(`🎲 **REROLL** — Nouveaux gagnants: ${winners.map((id) => `<@${id}>`).join(", ")} 🎉`).catch(() => null);
      return interaction.editReply("✅ Reroll effectué !");
    }

        // Purge
    if (commandName === "purge") {
      const amount = options.getInteger("nombre");
      if (amount < 1 || amount > 100) return interaction.editReply("❌ Entre 1 et 100.");

      const deleted = await interaction.channel.bulkDelete(amount, true);

      await logPremium(interaction.guild, "mod", {
        presetKey: "MOD_PURGE",
        authorUser: interaction.user,
        fields: [
          { name: "💬 Salon", value: chanTag(interaction.channel) },
          { name: "👮 Modérateur", value: userTag(interaction.user) },
          { name: "🗑️ Supprimés", value: `**${deleted.size}**`, inline: true },
          { name: "🆔 Salon ID", value: `\`${interaction.channel.id}\``, inline: true }
        ]
      });

      return interaction.editReply(`✅ ${deleted.size} messages supprimés.`);
    }

        // BAN
    if (commandName === "ban") {
      const user = options.getUser("membre");
      const reason = options.getString("raison") || "Aucune raison";
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.editReply("❌ Membre introuvable.");

      // Action
      await member.ban({ reason }).catch(() => null);

      // Audit (best-effort)
      await new Promise((r) => setTimeout(r, 800));
      const audit = await fetchAuditEntry(interaction.guild, AuditLogEvent.MemberBanAdd, user.id);

      await logPremium(interaction.guild, "mod", {
        presetKey: "MOD_BAN",
        authorUser: interaction.user,
        fields: [
          { name: "👤 Cible", value: userTag(user) },
          { name: "🆔 ID cible", value: `\`${user.id}\`` , inline: true },
          { name: "👮 Modérateur", value: userTag(interaction.user), inline: true },
          { name: "📝 Raison (commande)", value: trunc(reason, 900) },
          { name: "📋 Audit", value: audit ? `Executor: **${audit.executor}**\nReason: ${audit.reason}\nEntry: \`${audit.id}\`` : "*Indispo*" }
        ]
      });

      return interaction.editReply(`🔨 ${user.tag} a été banni.\nRaison: ${reason}`);
    }

        // KICK
    if (commandName === "kick") {
      const user = options.getUser("membre");
      const reason = options.getString("raison") || "Aucune raison";
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.editReply("❌ Membre introuvable.");

      await member.kick(reason).catch(() => null);

      await new Promise((r) => setTimeout(r, 800));
      const audit = await fetchAuditEntry(interaction.guild, AuditLogEvent.MemberKick, user.id);

      await logPremium(interaction.guild, "mod", {
        presetKey: "MOD_KICK",
        authorUser: interaction.user,
        fields: [
          { name: "👤 Cible", value: userTag(user) },
          { name: "🆔 ID cible", value: `\`${user.id}\``, inline: true },
          { name: "👮 Modérateur", value: userTag(interaction.user), inline: true },
          { name: "📝 Raison (commande)", value: trunc(reason, 900) },
          { name: "📋 Audit", value: audit ? `Executor: **${audit.executor}**\nReason: ${audit.reason}\nEntry: \`${audit.id}\`` : "*Indispo*" }
        ]
      });

      return interaction.editReply(`👢 ${user.tag} a été expulsé.\nRaison: ${reason}`);
    }

        // TIMEOUT
    if (commandName === "timeout") {
      const user = options.getUser("membre");
      const minutes = options.getInteger("minutes");
      const reason = options.getString("raison") || "Aucune raison";
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.editReply("❌ Membre introuvable.");

      const duration = minutes * 60 * 1000;
      await member.timeout(duration, reason).catch(() => null);

      await new Promise((r) => setTimeout(r, 800));
      const audit = await fetchAuditEntry(interaction.guild, AuditLogEvent.MemberUpdate, user.id);

      await logPremium(interaction.guild, "mod", {
        presetKey: "MOD_TIMEOUT",
        authorUser: interaction.user,
        fields: [
          { name: "👤 Cible", value: userTag(user) },
          { name: "🆔 ID cible", value: `\`${user.id}\``, inline: true },
          { name: "👮 Modérateur", value: userTag(interaction.user), inline: true },
          { name: "⏱️ Durée", value: `**${minutes}** minute(s)`, inline: true },
          { name: "📝 Raison (commande)", value: trunc(reason, 900) },
          { name: "📋 Audit", value: audit ? `Executor: **${audit.executor}**\nReason: ${audit.reason}\nEntry: \`${audit.id}\`` : "*Indispo*" }
        ]
      });

      return interaction.editReply(`⏳ ${user.tag} timeout ${minutes} minute(s).\nRaison: ${reason}`);
    }

        // WARN (+ DM)
    if (commandName === "warn") {
      const user = options.getUser("membre");
      const reason = options.getString("raison");
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.editReply("❌ Membre introuvable.");

      const total = addWarn(interaction.guild.id, user.id, {
        reason,
        moderator: interaction.user.tag,
        date: new Date().toISOString()
      });

      const dmEmbed = new EmbedBuilder()
        .setColor(LOG_STYLE.warning)
        .setTitle("⚠️ Avertissement reçu")
        .setDescription(`Tu as reçu un warn sur **${interaction.guild.name}**.`)
        .addFields(
          { name: "📝 Raison", value: trunc(reason, 900) },
          { name: "📌 Total de warns", value: `${total}`, inline: true },
          { name: "👮 Modérateur", value: interaction.user.tag, inline: true }
        )
        .setFooter({ text: "Merci de respecter le règlement." })
        .setTimestamp();

      let dmOk = true;
      await user.send({ embeds: [dmEmbed] }).catch(() => (dmOk = false));

      // Auto-timeout à 3 warns
      let autoTimeout = false;
      if (total >= 3) {
        autoTimeout = true;
        await member.timeout(10 * 60 * 1000, "3 warns automatiques").catch(() => null);
      }

      await logPremium(interaction.guild, "mod", {
        presetKey: "MOD_WARN",
        authorUser: interaction.user,
        fields: [
          { name: "👤 Cible", value: userTag(user) },
          { name: "🆔 ID cible", value: `\`${user.id}\``, inline: true },
          { name: "👮 Modérateur", value: userTag(interaction.user), inline: true },
          { name: "📝 Raison", value: trunc(reason, 900) },
          { name: "📌 Total warns", value: `**${total}**`, inline: true },
          { name: "✉️ DM", value: dmOk ? "✅ Envoyé" : "❌ Impossible", inline: true },
          { name: "⏳ Auto-timeout (≥3)", value: autoTimeout ? "✅ 10 minutes" : "—", inline: true }
        ]
      });

      return interaction.editReply(
        `⚠️ ${user.tag} a reçu un warn.\nTotal : ${total}\nDM: ${dmOk ? "✅ envoyé" : "❌ impossible"}`
      );
    }

    // WARNS
    if (commandName === "warns") {
      const user = options.getUser("membre");
      const warns = getWarns(interaction.guild.id, user.id);
      if (warns.length === 0) return interaction.editReply("✅ Aucun warn.");

      const description = warns
        .map((w, i) => `**${i + 1}.** ${w.reason} | Par **${w.moderator}** | ${formatDateFR(w.date)}`)
        .join("\n");

      return interaction.editReply(description.slice(0, 1900));
    }

        // UNWARN
    if (commandName === "unwarn") {
      const user = options.getUser("membre");
      const numero = options.getInteger("numero");

      const ok = removeWarn(interaction.guild.id, user.id, numero);
      if (!ok) return interaction.editReply("❌ Numéro invalide ou aucun warn.");

      await logPremium(interaction.guild, "mod", {
        presetKey: "MOD_UNWARN",
        authorUser: interaction.user,
        fields: [
          { name: "👤 Cible", value: userTag(user) },
          { name: "🆔 ID cible", value: `\`${user.id}\``, inline: true },
          { name: "👮 Modérateur", value: userTag(interaction.user), inline: true },
          { name: "📌 Warn retiré", value: `#${numero}` }
        ]
      });

      return interaction.editReply(`✅ Warn #${numero} retiré à ${user.tag}.`);
    }

        // CLEARWARNS
    if (commandName === "clearwarns") {
      const user = options.getUser("membre");
      const ok = clearWarns(interaction.guild.id, user.id);
      if (!ok) return interaction.editReply("❌ Aucun warn à supprimer.");

      await logPremium(interaction.guild, "mod", {
        presetKey: "MOD_CLEARWARNS",
        authorUser: interaction.user,
        fields: [
          { name: "👤 Cible", value: userTag(user) },
          { name: "🆔 ID cible", value: `\`${user.id}\``, inline: true },
          { name: "👮 Modérateur", value: userTag(interaction.user), inline: true },
          { name: "✅ Action", value: "Tous les warns supprimés" }
        ]
      });

      return interaction.editReply(`✅ Tous les warns de ${user.tag} ont été supprimés.`);
    }

    return interaction.editReply("⚠️ Commande non configurée.");
  } catch (err) {
    console.error("❌ Erreur interaction:", err);
    return interaction.editReply("❌ Une erreur est survenue.");
  }
});

// ====== ANTI-FLOOD (5 messages -> warn + timeout 1 minute) ======
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (!message.author || message.author.bot) return;

    // Auto-réactions dans #suggestions
    if (SUGGESTIONS_CHANNEL_ID && message.channel.id === SUGGESTIONS_CHANNEL_ID) {
      await message.react("✅").catch(() => null);
      await message.react("❌").catch(() => null);
      return; // enlève ce return si tu veux que l’anti-flood s’applique aussi
    }

    const member = message.member;
    if (!member) return;

    // ignore le staff
    if (isStaff(member)) return;

    const now = Date.now();
    const key = message.author.id;

    const data = floodMap.get(key) || { count: 0, firstTs: now, punishedUntil: 0 };

    if (data.punishedUntil && now < data.punishedUntil) {
      floodMap.set(key, data);
      return;
    }

    if (now - data.firstTs > FLOOD_WINDOW_MS) {
      data.count = 0;
      data.firstTs = now;
    }

    data.count += 1;

    if (data.count >= FLOOD_MAX_MSG) {
      data.punishedUntil = now + FLOOD_TIMEOUT_MS + 5000;
      floodMap.set(key, data);

      const reason = `Anti-flood: ${FLOOD_MAX_MSG} messages en ${Math.floor(FLOOD_WINDOW_MS / 1000)}s`;

      const total = addWarn(message.guild.id, message.author.id, {
        reason,
        moderator: client.user.tag,
        date: new Date().toISOString()
      });

      await member.timeout(FLOOD_TIMEOUT_MS, "Anti-flood automatique").catch(() => null);

      const dmEmbed = new EmbedBuilder()
        .setTitle("🚫 Anti-flood")
        .setDescription(`Tu as été sanctionné sur **${message.guild.name}**.`)
        .addFields(
          { name: "📝 Raison", value: reason },
          { name: "⏳ Sanction", value: "Timeout 1 minute + 1 warn" },
          { name: "📌 Total warns", value: `${total}` }
        )
        .setTimestamp();

      await message.author.send({ embeds: [dmEmbed] }).catch(() => null);

      const logEmbed = new EmbedBuilder()
        .setTitle("🚫 Anti-flood déclenché")
        .addFields(
          { name: "Membre", value: `${message.author.tag} (${message.author.id})` },
          { name: "Salon", value: `${message.channel} (${message.channel.id})` },
          { name: "Action", value: "1 warn + timeout 1 minute" },
          { name: "Total warns", value: `${total}` }
        )
        .setTimestamp();

      await sendLog(message.guild, "mod", logEmbed);

      data.count = 0;
      data.firstTs = now;
      floodMap.set(key, data);
      return;
    }

    floodMap.set(key, data);
  } catch (e) {
    console.error("Anti-flood error:", e);
  }
});

// ====== LOGIN ======
client.login(TOKEN);