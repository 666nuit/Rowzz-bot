/**
 * BOT DISCORD TOUT-EN-UN (Railway-friendly)
 * - Vérif règlement (bouton -> rôle membre)
 * - Tickets (panneau -> création salon privé, fermeture staff-only, anti-spam)
 * - Modération (ban/kick/timeout/purge)
 * - Warn system (persistant dans warns.json) + DM au membre
 * - Logs complets + multi-salons (membres, messages, modération, vocal, serveur/audit)
 * - Transcript ticket à la fermeture (export messages -> log mod)
 *
 * ENV (Railway):
 * DISCORD_TOKEN, CLIENT_ID, GUILD_ID (recommandé),
 * STAFF_ROLE_ID, MEMBER_ROLE_ID, TICKETS_CATEGORY_ID,
 * LOG_MEMBERS_CHANNEL_ID, LOG_MESSAGES_CHANNEL_ID, LOG_MOD_CHANNEL_ID, LOG_VOICE_CHANNEL_ID, LOG_SERVER_CHANNEL_ID
 */

const fs = require("fs");
const path = require("path");

// Keep-alive web (Railway => PORT)
const express = require("express");
const app = express();
app.get("/", (req, res) => res.send("Bot is alive ✅"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web ping OK (port ${PORT})`));

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
  AuditLogEvent
} = require("discord.js");

require("dotenv").config();

// ====== ENV / CONFIG ======
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;
const MEMBER_ROLE_ID = process.env.MEMBER_ROLE_ID;
const TICKETS_CATEGORY_ID = process.env.TICKETS_CATEGORY_ID;
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;
const REGLEMENT_CHANNEL_ID = process.env.REGLEMENT_CHANNEL_ID; // déjà présent chez toi, garde-le

// ====== ANTI-FLOOD ======
const FLOOD_WINDOW_MS = 7000;     // 7 secondes
const FLOOD_MAX_MSG = 5;          // 5 messages
const FLOOD_TIMEOUT_MS = 60_000;  // 1 minute
const floodMap = new Map();       // userId -> { count, firstTs, punishedUntil }


// Logs multi-salons
const LOG_CH = {
  members: process.env.LOG_MEMBERS_CHANNEL_ID,
  messages: process.env.LOG_MESSAGES_CHANNEL_ID,
  mod: process.env.LOG_MOD_CHANNEL_ID,
  voice: process.env.LOG_VOICE_CHANNEL_ID,
  server: process.env.LOG_SERVER_CHANNEL_ID
};

// ====== CLIENT ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // activer "Message Content Intent" sur le portail dev si tu veux contenu complet
    GatewayIntentBits.GuildVoiceStates
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
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80) || "ticket";
}

function ticketOwnerFromTopic(topic) {
  if (!topic) return null;
  const m = String(topic).match(/ticketOwner:(\d{10,})/);
  return m ? m[1] : null;
}

async function getAuditExecutorTag(guild, auditType, targetId) {
  try {
    const logs = await guild.fetchAuditLogs({ limit: 10, type: auditType });
    const entry = logs.entries.find(e => (e.target?.id === targetId));
    if (entry?.executor) return `${entry.executor.tag} (${entry.executor.id})`;
  } catch (_) {}
  return "Inconnu";
}

function formatDateFR(iso) {
  try {
    return new Date(iso).toLocaleString("fr-FR");
  } catch {
    return iso;
  }
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
    .addUserOption(o => o.setName("membre").setDescription("Membre").setRequired(true))
    .addStringOption(o => o.setName("raison").setDescription("Raison").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Expulser un membre (staff only).")
    .addUserOption(o => o.setName("membre").setDescription("Membre").setRequired(true))
    .addStringOption(o => o.setName("raison").setDescription("Raison").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Timeout un membre en minutes (staff only).")
    .addUserOption(o => o.setName("membre").setDescription("Membre").setRequired(true))
    .addIntegerOption(o => o.setName("minutes").setDescription("Durée en minutes").setRequired(true))
    .addStringOption(o => o.setName("raison").setDescription("Raison").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Supprime X messages (1 à 100) (staff only).")
    .addIntegerOption(o => o.setName("nombre").setDescription("Nombre 1-100").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Avertir un membre (staff only).")
    .addUserOption(o => o.setName("membre").setDescription("Membre").setRequired(true))
    .addStringOption(o => o.setName("raison").setDescription("Raison").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName("warns")
    .setDescription("Voir les warns d’un membre (staff only).")
    .addUserOption(o => o.setName("membre").setDescription("Membre").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName("unwarn")
    .setDescription("Retirer un warn par numéro (staff only).")
    .addUserOption(o => o.setName("membre").setDescription("Membre").setRequired(true))
    .addIntegerOption(o => o.setName("numero").setDescription("Numéro du warn").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName("clearwarns")
    .setDescription("Supprimer tous les warns d’un membre (staff only).")
    .addUserOption(o => o.setName("membre").setDescription("Membre").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
].map(c => c.toJSON());

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

// ====== WARNS (persistants) ======
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
  // On récupère TOUT (pagination)
  const all = [];
  let lastId = null;

  while (true) {
    const fetched = await channel.messages.fetch({ limit: 100, before: lastId }).catch(() => null);
    if (!fetched || fetched.size === 0) break;
    all.push(...fetched.values());
    lastId = fetched.last().id;
    if (fetched.size < 100) break;
  }

  // du plus ancien au plus récent
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

    const attachments = [...m.attachments.values()].map(a => a.url);
    const attText = attachments.length ? ` | attachments: ${attachments.join(" , ")}` : "";

    // petits indicateurs si embed/sticker
    const extras = [];
    if (m.embeds?.length) extras.push(`embeds:${m.embeds.length}`);
    if (m.stickers?.size) extras.push(`stickers:${m.stickers.size}`);
    const extraText = extras.length ? ` | ${extras.join(" ")}` : "";

    lines.push(`[${time}] ${author}: ${content}${attText}${extraText}`);
  }

  return lines.join("\n");
}

// ====== READY ======
client.once("ready", async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
  await deployCommands();
});

// ====== LOGS : MEMBRES ======
client.on("guildMemberAdd", async (member) => {

  // ===== 1) MESSAGE PUBLIC WELCOME (avec banner URL) =====
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
          { name: "📅 Compte créé", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: false }
        )
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setImage("https://i.postimg.cc/0jZ7h0Hq/welcome-banner.png") // ✅ ICI
        .setFooter({ text: `${member.guild.name} • Bienvenue` })
        .setTimestamp();

      await welcomeChannel.send({
        content: `👋 ${member}`, // ping
        embeds: [embed]
      }).catch(() => null);
    }
  }

  // ===== 2) PING DANS LE SALON RÈGLEMENT (supprime après 5s) =====
  if (REGLEMENT_CHANNEL_ID) {
    const rulesChannel = await getChannel(member.guild, REGLEMENT_CHANNEL_ID);

    if (rulesChannel) {
      const msg = await rulesChannel.send({
        content: `📌 ${member} pense à lire le règlement et clique sur **Accepter** ✅`
      }).catch(() => null);

      if (msg) {
        setTimeout(() => {
          msg.delete().catch(() => null);
        }, 5000);
      }
    }
  }

  // ===== 3) DM PRIVÉ DE BIENVENUE =====
  const dmEmbed = new EmbedBuilder()
    .setTitle(`Bienvenue sur ${member.guild.name} 🎉`)
    .setDescription(
      "Merci d’avoir rejoint le serveur ! 🙌\n\n" +
      "📜 Lis le règlement pour bien commencer.\n" +
      "🎫 Besoin d’aide ? Ouvre un ticket support.\n\n" +
      "Bon séjour parmi nous 💙"
    )
    .setThumbnail(member.guild.iconURL({ dynamic: true }) || null)
    .setTimestamp();

  await member.send({ embeds: [dmEmbed] }).catch(() => null);

  // ===== 4) LOG MEMBERS =====
  const logEmbed = new EmbedBuilder()
    .setTitle("➕ Membre rejoint")
    .setDescription(`${member.user.tag} (${member.id})`)
    .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
    .setTimestamp();

  await sendLog(member.guild, "members", logEmbed);
});



// ====== LOGS : ROLES ADD/REMOVE (avec Audit Logs) ======
client.on("guildMemberUpdate", async (oldM, newM) => {
  const oldRoles = new Set(oldM.roles.cache.keys());
  const newRoles = new Set(newM.roles.cache.keys());

  const added = [...newRoles].filter(r => !oldRoles.has(r));
  const removed = [...oldRoles].filter(r => !newRoles.has(r));
  if (!added.length && !removed.length) return;

  const executorTag = await getAuditExecutorTag(newM.guild, AuditLogEvent.MemberRoleUpdate, newM.id);

  const e = new EmbedBuilder()
    .setTitle("🏷️ Rôles modifiés")
    .setDescription(`Membre: **${newM.user.tag}** (${newM.id})`)
    .addFields(
      { name: "✅ Ajoutés", value: added.length ? added.map(id => `<@&${id}>`).join(", ") : "*Aucun*" },
      { name: "❌ Retirés", value: removed.length ? removed.map(id => `<@&${id}>`).join(", ") : "*Aucun*" },
      { name: "👮 Modifié par", value: executorTag }
    )
    .setFooter({ text: `${newM.guild.name} • Logs serveur` })
    .setTimestamp();

  await sendLog(newM.guild, "server", e);
});

// ====== LOGS : MESSAGES ======
client.on("messageDelete", async (msg) => {
  if (!msg.guild) return;
  if (msg.author?.bot) return;

  const e = new EmbedBuilder()
    .setTitle("🗑️ Message supprimé")
    .addFields(
      { name: "Auteur", value: msg.author ? `${msg.author.tag} (${msg.author.id})` : "Inconnu" },
      { name: "Salon", value: `${msg.channel}` },
      { name: "Contenu", value: cleanText(msg.content || "*vide/attachment*", 1000) }
    )
    .setTimestamp();

  await sendLog(msg.guild, "messages", e);
});

client.on("messageUpdate", async (oldMsg, newMsg) => {
  if (!newMsg.guild) return;
  if (newMsg.author?.bot) return;

  const before = oldMsg.content ?? "";
  const after = newMsg.content ?? "";
  if (before === after) return;

  const e = new EmbedBuilder()
    .setTitle("✏️ Message modifié")
    .addFields(
      { name: "Auteur", value: `${newMsg.author.tag} (${newMsg.author.id})` },
      { name: "Salon", value: `${newMsg.channel}` },
      { name: "Avant", value: cleanText(before || "*vide*", 900) },
      { name: "Après", value: cleanText(after || "*vide*", 900) }
    )
    .setTimestamp();

  await sendLog(newMsg.guild, "messages", e);
});

// ====== LOGS : VOCAL ======
client.on("voiceStateUpdate", async (oldState, newState) => {
  const guild = newState.guild;
  const user = newState.member?.user;
  if (!user) return;

  const oldCh = oldState.channel;
  const newCh = newState.channel;

  if (oldCh?.id !== newCh?.id) {
    const e = new EmbedBuilder()
      .setTitle("🔊 Vocal")
      .addFields(
        { name: "Membre", value: `${user.tag} (${user.id})` },
        { name: "Avant", value: oldCh ? `${oldCh.name}` : "*aucun*" },
        { name: "Après", value: newCh ? `${newCh.name}` : "*aucun*" }
      )
      .setTimestamp();
    await sendLog(guild, "voice", e);
  }

  if (oldState.serverMute !== newState.serverMute || oldState.serverDeaf !== newState.serverDeaf) {
    const e = new EmbedBuilder()
      .setTitle("🎛️ Vocal modération")
      .addFields(
        { name: "Membre", value: `${user.tag} (${user.id})` },
        { name: "ServerMute", value: `${oldState.serverMute} → ${newState.serverMute}`, inline: true },
        { name: "ServerDeaf", value: `${oldState.serverDeaf} → ${newState.serverDeaf}`, inline: true }
      )
      .setTimestamp();
    await sendLog(guild, "voice", e);
  }
});

// ====== LOGS : SERVEUR (salons/rôles/guild) ======
client.on("channelCreate", async (channel) => {
  if (!channel.guild) return;
  const executorTag = await getAuditExecutorTag(channel.guild, AuditLogEvent.ChannelCreate, channel.id);

  const e = new EmbedBuilder()
    .setTitle("📁 Salon créé")
    .addFields(
      { name: "Salon", value: `${channel} (${channel.id})` },
      { name: "Type", value: `${channel.type}` },
      { name: "Créé par", value: executorTag }
    )
    .setTimestamp();

  await sendLog(channel.guild, "server", e);
});

client.on("channelDelete", async (channel) => {
  if (!channel.guild) return;

  // cleanup ticket
  if (channel.type === ChannelType.GuildText) {
    const ownerId = ticketOwnerFromTopic(channel.topic);
    if (ownerId) openTickets.delete(ownerId);
  }

  const executorTag = await getAuditExecutorTag(channel.guild, AuditLogEvent.ChannelDelete, channel.id);

  const e = new EmbedBuilder()
    .setTitle("🗑️ Salon supprimé")
    .addFields(
      { name: "Nom", value: `#${channel.name}` },
      { name: "ID", value: `${channel.id}` },
      { name: "Supprimé par", value: executorTag }
    )
    .setTimestamp();

  await sendLog(channel.guild, "server", e);
});

client.on("channelUpdate", async (oldCh, newCh) => {
  if (!newCh.guild) return;

  const changes = [];
  if (oldCh.name !== newCh.name) changes.push(`Nom: **${oldCh.name}** → **${newCh.name}**`);
  if ((oldCh.topic || "") !== (newCh.topic || "")) changes.push(`Topic: **${cleanText(oldCh.topic || "", 200)}** → **${cleanText(newCh.topic || "", 200)}**`);
  if (!changes.length) return;

  const executorTag = await getAuditExecutorTag(newCh.guild, AuditLogEvent.ChannelUpdate, newCh.id);

  const e = new EmbedBuilder()
    .setTitle("🛠️ Salon modifié")
    .addFields(
      { name: "Salon", value: `${newCh} (${newCh.id})` },
      { name: "Changements", value: changes.join("\n").slice(0, 1024) },
      { name: "Modifié par", value: executorTag }
    )
    .setTimestamp();

  await sendLog(newCh.guild, "server", e);
});

client.on("roleCreate", async (role) => {
  const executorTag = await getAuditExecutorTag(role.guild, AuditLogEvent.RoleCreate, role.id);

  const e = new EmbedBuilder()
    .setTitle("🆕 Rôle créé")
    .addFields(
      { name: "Rôle", value: `<@&${role.id}> (${role.id})` },
      { name: "Créé par", value: executorTag }
    )
    .setTimestamp();

  await sendLog(role.guild, "server", e);
});

client.on("roleDelete", async (role) => {
  const executorTag = await getAuditExecutorTag(role.guild, AuditLogEvent.RoleDelete, role.id);

  const e = new EmbedBuilder()
    .setTitle("🗑️ Rôle supprimé")
    .addFields(
      { name: "Nom", value: `${role.name}` },
      { name: "ID", value: `${role.id}` },
      { name: "Supprimé par", value: executorTag }
    )
    .setTimestamp();

  await sendLog(role.guild, "server", e);
});

client.on("roleUpdate", async (oldRole, newRole) => {
  const changes = [];
  if (oldRole.name !== newRole.name) changes.push(`Nom: **${oldRole.name}** → **${newRole.name}**`);
  if (oldRole.color !== newRole.color) changes.push(`Couleur: **${oldRole.color}** → **${newRole.color}**`);
  if (oldRole.hoist !== newRole.hoist) changes.push(`Affiché séparément: **${oldRole.hoist}** → **${newRole.hoist}**`);
  if (oldRole.mentionable !== newRole.mentionable) changes.push(`Mentionnable: **${oldRole.mentionable}** → **${newRole.mentionable}**`);
  if (!changes.length) return;

  const executorTag = await getAuditExecutorTag(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);

  const e = new EmbedBuilder()
    .setTitle("🛡️ Rôle modifié")
    .addFields(
      { name: "Rôle", value: `<@&${newRole.id}> (${newRole.id})` },
      { name: "Changements", value: changes.join("\n").slice(0, 1024) },
      { name: "Modifié par", value: executorTag }
    )
    .setTimestamp();

  await sendLog(newRole.guild, "server", e);
});

client.on("guildUpdate", async (oldG, newG) => {
  const changes = [];
  if (oldG.name !== newG.name) changes.push(`Nom: **${oldG.name}** → **${newG.name}**`);
  if (oldG.iconURL() !== newG.iconURL()) changes.push(`Icône: modifiée`);
  if (!changes.length) return;

  const executorTag = await getAuditExecutorTag(newG, AuditLogEvent.GuildUpdate, newG.id);

  const e = new EmbedBuilder()
    .setTitle("🏰 Serveur modifié")
    .addFields(
      { name: "Changements", value: changes.join("\n").slice(0, 1024) },
      { name: "Modifié par", value: executorTag }
    )
    .setTimestamp();

  await sendLog(newG, "server", e);
});

// ====== Interaction handling ======
client.on("interactionCreate", async (interaction) => {
  if (!interaction.inGuild()) return;

  /* ===========================
     ===== BOUTONS ============
  ============================ */
  if (interaction.isButton()) {
    // Vérification règlement
    if (interaction.customId === "verify_rules") {
      if (!MEMBER_ROLE_ID) {
        return interaction.reply({ content: "❌ Rôle membre non configuré.", ephemeral: true });
      }

      const role = interaction.guild.roles.cache.get(MEMBER_ROLE_ID);
      if (!role) {
        return interaction.reply({ content: "❌ Rôle introuvable.", ephemeral: true });
      }

      await interaction.member.roles.add(role).catch(() => null);
      return interaction.reply({ content: "✅ Vous avez accepté le règlement !", ephemeral: true });
    }

    // Ouvrir ticket
    if (interaction.customId === "open_ticket") {
      if (openTickets.has(interaction.user.id)) {
        return interaction.reply({ content: "❌ Vous avez déjà un ticket ouvert.", ephemeral: true });
      }

      const now = Date.now();
      const last = ticketCooldown.get(interaction.user.id) || 0;
      if (now - last < COOLDOWN_MS) {
        return interaction.reply({ content: "⏳ Veuillez patienter avant de rouvrir un ticket.", ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

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
            ? [{
                id: STAFF_ROLE_ID,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.SendMessages,
                  PermissionsBitField.Flags.ReadMessageHistory
                ]
              }]
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
        new ButtonBuilder()
          .setCustomId("close_ticket")
          .setLabel("🔒 Fermer (staff)")
          .setStyle(ButtonStyle.Danger)
      );

      await channel.send({ embeds: [ticketEmbed], components: [row] });

      // Log mod
      const e = new EmbedBuilder()
        .setTitle("🎫 Ticket créé")
        .addFields(
          { name: "Utilisateur", value: `${interaction.user.tag} (${interaction.user.id})` },
          { name: "Salon", value: `${channel} (${channel.id})` }
        )
        .setTimestamp();
      await sendLog(interaction.guild, "mod", e);

      return interaction.editReply(`✅ Ticket ouvert : ${channel}`);
    }

    // Fermer ticket + transcript
    if (interaction.customId === "close_ticket") {
      if (!isStaff(interaction.member)) {
        return interaction.reply({ content: "❌ Seul le staff peut fermer les tickets.", ephemeral: true });
      }

      const ch = interaction.channel;
      const ownerId = ticketOwnerFromTopic(ch.topic);

      await interaction.reply("🔒 Fermeture du ticket... Génération du transcript 📄");

      // Build transcript
      const text = await buildTicketTranscriptText(ch).catch(() => "Transcript indisponible (erreur).");
      const filename = `transcript-${ch.name}-${Date.now()}.txt`;

      const closeEmbed = new EmbedBuilder()
        .setTitle("🔒 Ticket fermé")
        .addFields(
          { name: "Salon", value: `#${ch.name} (${ch.id})` },
          { name: "Propriétaire", value: ownerId ? `<@${ownerId}> (${ownerId})` : "Inconnu" },
          { name: "Fermé par", value: `${interaction.user.tag} (${interaction.user.id})` }
        )
        .setTimestamp();

      await sendLog(interaction.guild, "mod", closeEmbed, [
        { attachment: Buffer.from(text, "utf8"), name: filename }
      ]);

      // nettoyage openTickets
      if (ownerId) openTickets.delete(ownerId);

      setTimeout(() => ch.delete().catch(() => null), 2500);
      return;
    }
  }

  /* ===========================
     ===== SLASH COMMANDS =====
  ============================ */
  if (!interaction.isChatInputCommand()) return;

  await interaction.deferReply({ ephemeral: true });
  const { commandName, options } = interaction;

  try {
    // Setup règlement (embed beau)
    if (commandName === "setup-rules") {
      const embed = new EmbedBuilder()
        .setTitle("📜 Règlement du serveur")
        .setDescription(
          "Bienvenue ! Merci de lire le règlement.\n\n" +
          "✅ Clique sur **Accepter le règlement** pour obtenir l’accès membre.\n" +
          "⚠️ Le non-respect peut entraîner des sanctions."
        )
        .addFields(
          { name: "🔹 Respect", value: "Pas d’insultes, harcèlement, provocations.", inline: false },
          { name: "🔹 Contenu", value: "Pas de NSFW, pubs, ou contenus illégaux.", inline: false },
          { name: "🔹 Spam", value: "Pas de flood / ping abusif / messages inutiles.", inline: false }
        )
        .setFooter({ text: `${interaction.guild.name} • Vérification` })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("verify_rules")
          .setLabel("✅ Accepter le règlement")
          .setStyle(ButtonStyle.Success)
      );

      await interaction.channel.send({ embeds: [embed], components: [row] });
      return interaction.editReply("✅ Règlement envoyé.");
    }

    // Setup ticket panel (embed beau)
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
        new ButtonBuilder()
          .setCustomId("open_ticket")
          .setLabel("➕ Ouvrir un ticket")
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.channel.send({ embeds: [embed], components: [row] });
      return interaction.editReply("✅ Panneau envoyé.");
    }

    // Purge
    if (commandName === "purge") {
      const amount = options.getInteger("nombre");
      if (amount < 1 || amount > 100) return interaction.editReply("❌ Entre 1 et 100.");

      const deleted = await interaction.channel.bulkDelete(amount, true);

      const e = new EmbedBuilder()
        .setTitle("🧹 Purge")
        .addFields(
          { name: "Salon", value: `${interaction.channel} (${interaction.channel.id})` },
          { name: "Modérateur", value: `${interaction.user.tag} (${interaction.user.id})` },
          { name: "Supprimés", value: `${deleted.size}` }
        )
        .setTimestamp();
      await sendLog(interaction.guild, "mod", e);

      return interaction.editReply(`✅ ${deleted.size} messages supprimés.`);
    }

    // BAN
    if (commandName === "ban") {
      const user = options.getUser("membre");
      const reason = options.getString("raison") || "Aucune raison";
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.editReply("❌ Membre introuvable.");

      await sendLog(interaction.guild, "mod",
        new EmbedBuilder()
          .setTitle("🔨 Bannissement")
          .addFields(
            { name: "Membre", value: `${user.tag} (${user.id})` },
            { name: "Modérateur", value: `${interaction.user.tag} (${interaction.user.id})` },
            { name: "Raison", value: reason }
          )
          .setTimestamp()
      );

      await member.ban({ reason }).catch(() => null);
      return interaction.editReply(`🔨 ${user.tag} a été banni.\nRaison: ${reason}`);
    }

    // KICK
    if (commandName === "kick") {
      const user = options.getUser("membre");
      const reason = options.getString("raison") || "Aucune raison";
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.editReply("❌ Membre introuvable.");

      await sendLog(interaction.guild, "mod",
        new EmbedBuilder()
          .setTitle("👢 Expulsion")
          .addFields(
            { name: "Membre", value: `${user.tag} (${user.id})` },
            { name: "Modérateur", value: `${interaction.user.tag} (${interaction.user.id})` },
            { name: "Raison", value: reason }
          )
          .setTimestamp()
      );

      await member.kick(reason).catch(() => null);
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

      await sendLog(interaction.guild, "mod",
        new EmbedBuilder()
          .setTitle("⏳ Timeout")
          .addFields(
            { name: "Membre", value: `${user.tag} (${user.id})` },
            { name: "Modérateur", value: `${interaction.user.tag} (${interaction.user.id})` },
            { name: "Durée", value: `${minutes} minute(s)` },
            { name: "Raison", value: reason }
          )
          .setTimestamp()
      );

      await member.timeout(duration, reason).catch(() => null);
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

      // log mod
      await sendLog(interaction.guild, "mod",
        new EmbedBuilder()
          .setTitle("⚠️ Warn")
          .setDescription(`**${user.tag}** (${user.id}) a reçu un warn.`)
          .addFields(
            { name: "👮 Modérateur", value: `${interaction.user.tag} (${interaction.user.id})` },
            { name: "📝 Raison", value: reason },
            { name: "📌 Total warns", value: `${total}` }
          )
          .setTimestamp()
      );

      // DM à l'utilisateur
      const dmEmbed = new EmbedBuilder()
        .setTitle("⚠️ Avertissement reçu")
        .setDescription(`Tu as reçu un warn sur **${interaction.guild.name}**.`)
        .addFields(
          { name: "📝 Raison", value: reason },
          { name: "📌 Total de warns", value: `${total}` },
          { name: "👮 Modérateur", value: interaction.user.tag }
        )
        .setFooter({ text: "Merci de respecter le règlement." })
        .setTimestamp();

      let dmOk = true;
      await user.send({ embeds: [dmEmbed] }).catch(() => { dmOk = false; });

      // Auto-timeout à 3 warns
      if (total >= 3) {
        await member.timeout(10 * 60 * 1000, "3 warns automatiques").catch(() => null);
        await sendLog(interaction.guild, "mod",
          new EmbedBuilder()
            .setTitle("⏳ Auto-timeout (3 warns)")
            .addFields(
              { name: "Membre", value: `${user.tag} (${user.id})` },
              { name: "Durée", value: "10 minutes" }
            )
            .setTimestamp()
        );
      }

      return interaction.editReply(`⚠️ ${user.tag} a reçu un warn.\nTotal : ${total}\nDM: ${dmOk ? "✅ envoyé" : "❌ impossible"}`);
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

      await sendLog(interaction.guild, "mod",
        new EmbedBuilder()
          .setTitle("🧾 Unwarn")
          .addFields(
            { name: "Membre", value: `${user.tag} (${user.id})` },
            { name: "Modérateur", value: `${interaction.user.tag} (${interaction.user.id})` },
            { name: "Warn retiré", value: `#${numero}` }
          )
          .setTimestamp()
      );

      return interaction.editReply(`✅ Warn #${numero} retiré à ${user.tag}.`);
    }

    // CLEARWARNS
    if (commandName === "clearwarns") {
      const user = options.getUser("membre");
      const ok = clearWarns(interaction.guild.id, user.id);
      if (!ok) return interaction.editReply("❌ Aucun warn à supprimer.");

      await sendLog(interaction.guild, "mod",
        new EmbedBuilder()
          .setTitle("🧾 Clear warns")
          .addFields(
            { name: "Membre", value: `${user.tag} (${user.id})` },
            { name: "Modérateur", value: `${interaction.user.tag} (${interaction.user.id})` }
          )
          .setTimestamp()
      );

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

    const member = message.member;
    if (!member) return;

    // ignore le staff
    if (isStaff(member)) return;

    const now = Date.now();
    const key = message.author.id;

    const data = floodMap.get(key) || { count: 0, firstTs: now, punishedUntil: 0 };

    // si déjà puni récemment, on évite de re-punir en boucle
    if (data.punishedUntil && now < data.punishedUntil) {
      floodMap.set(key, data);
      return;
    }

    // reset fenêtre si trop vieille
    if (now - data.firstTs > FLOOD_WINDOW_MS) {
      data.count = 0;
      data.firstTs = now;
    }

    data.count += 1;

    // Flood détecté
    if (data.count >= FLOOD_MAX_MSG) {
      data.punishedUntil = now + FLOOD_TIMEOUT_MS + 5000; // buffer
      floodMap.set(key, data);

      const reason = `Anti-flood: ${FLOOD_MAX_MSG} messages en ${Math.floor(FLOOD_WINDOW_MS / 1000)}s`;

      // 1) warn auto (persistant)
      const total = addWarn(message.guild.id, message.author.id, {
        reason,
        moderator: client.user.tag,
        date: new Date().toISOString()
      });

      // 2) timeout 1 minute
      await member.timeout(FLOOD_TIMEOUT_MS, "Anti-flood automatique").catch(() => null);

      // 3) DM utilisateur
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

      // 4) log mod
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

      // reset compteur
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
