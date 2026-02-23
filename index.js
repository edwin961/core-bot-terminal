require('dotenv').config();
const { 
    Client, GatewayIntentBits, Events, REST, Routes, 
    SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder 
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const https = require('https');

// ─── 1. SUPABASE ───────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ─── 2. EXPRESS BRIDGE ────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ── Status ──
app.get('/', (req, res) => {
    res.json({ status: 'CORE_ONLINE', timestamp: new Date() });
});

// ── Guilds donde está el bot (para el Dashboard) ──
app.get('/api/guilds', (req, res) => {
    try {
        const guilds = client.guilds.cache.map(g => ({
            id:          g.id,
            name:        g.name,
            icon:        g.icon
                           ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64`
                           : null,
            memberCount: g.memberCount
        }));
        res.json(guilds);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Logs ──
app.get('/api/logs', async (req, res) => {
    const { data, error } = await supabase
        .from('system_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);
    if (error) return res.status(500).json({ error });
    res.json(data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`📡 Bridge activo en puerto ${PORT}`));

// ─── 3. CLIENTE DISCORD ───────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildBans,          // necesario para /ban y /unban
        GatewayIntentBits.GuildModeration,    // necesario para moderación
    ],
});

const EMOJI = {
    AMONG_US:   '<a:42811vaporwaveamongus:1475287541308723343>',
    LOCK:       '<a:44503lockkey:1475287251771457636>',
    NUCLEAR:    '<a:5309nuclearlaunchbutton:1475287239046070342>',
    ALERT_BLUE: '<a:5567alertblue1:1475286980957966559>',
    ALERT_RED:  '<a:75814alert:1475286853753241630>'
};

// ─── 4. COMANDOS ──────────────────────────────────────────
const commands = [
    new SlashCommandBuilder()
        .setName('info')
        .setDescription('📋 Manual de protocolos'),

    new SlashCommandBuilder()
        .setName('system-isolation')
        .setDescription('🚨 Lockdown del servidor (Solo Dueño)'),

    new SlashCommandBuilder()
        .setName('lock-channel')
        .setDescription('🔑 Bloquear/desbloquear canal actual'),

    new SlashCommandBuilder()
        .setName('block-word')
        .setDescription('🚫 Bloquear una palabra del filtro')
        .addStringOption(o =>
            o.setName('palabra').setRequired(true).setDescription('Palabra a bloquear')),

    new SlashCommandBuilder()
        .setName('warn')
        .setDescription('⚠️ Advertir a un usuario')
        .addUserOption(o =>
            o.setName('user').setRequired(true).setDescription('Usuario a advertir'))
        .addStringOption(o =>
            o.setName('razon').setRequired(true).setDescription('Motivo de la advertencia')),

    new SlashCommandBuilder()
        .setName('remove-warn')
        .setDescription('🗑️ Limpiar warns de un usuario')
        .addUserOption(o =>
            o.setName('user').setRequired(true).setDescription('Usuario')),

    new SlashCommandBuilder()
        .setName('send-embed')
        .setDescription('📤 Enviar mensaje formal a un canal')
        .addChannelOption(o =>
            o.setName('canal').setRequired(true).setDescription('Canal de destino'))
        .addStringOption(o =>
            o.setName('titulo').setRequired(false).setDescription('Título del embed'))
        .addStringOption(o =>
            o.setName('texto').setRequired(true).setDescription('Contenido del embed')),

    new SlashCommandBuilder()
        .setName('nuke-chat')
        .setDescription('☢️ Purga masiva de mensajes')
        .addIntegerOption(o =>
            o.setName('cant').setRequired(true).setMinValue(1).setMaxValue(100)
             .setDescription('Cantidad de mensajes (1-100)')),

    new SlashCommandBuilder()
        .setName('permissions-scan')
        .setDescription('🛡️ Escanear usuarios con permisos de administrador'),

    new SlashCommandBuilder()
        .setName('warns')
        .setDescription('📋 Ver los warns de un usuario')
        .addUserOption(o =>
            o.setName('user').setRequired(true).setDescription('Usuario')),

].map(c => c.toJSON());

// ─── 5. FILTRO DE PALABRAS ────────────────────────────────
// Cache local para no hacer query a Supabase en cada mensaje
let blockedWordsCache = [];
let cacheTime = 0;
const CACHE_TTL = 60_000; // 60 segundos

async function getBlockedWords(guildId) {
    const now = Date.now();
    if (now - cacheTime > CACHE_TTL) {
        const { data } = await supabase.from('blocked_words').select('word, guild_id');
        blockedWordsCache = data || [];
        cacheTime = now;
    }
    // Filtra por guild si la columna existe, si no devuelve todas
    return blockedWordsCache
        .filter(w => !w.guild_id || w.guild_id === guildId)
        .map(w => w.word.toLowerCase());
}

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guild) return;

    try {
        const list = await getBlockedWords(message.guild.id);
        const content = message.content.toLowerCase();

        if (list.some(w => content.includes(w))) {
            await message.delete().catch(() => {});

            // Aviso efímero al usuario
            const warn = await message.channel.send({
                content: `${EMOJI.ALERT_RED} <@${message.author.id}> Tu mensaje fue eliminado por contener palabras bloqueadas.`
            });
            setTimeout(() => warn.delete().catch(() => {}), 5000);

            await supabase.from('system_logs').insert([{
                event:    'FILTER',
                details:  `MSG_DEL: ${message.author.tag} en #${message.channel.name}: "${message.content.substring(0, 80)}"`,
                operator: 'AUTO_MOD',
                guild_id: message.guild.id
            }]);

            // Invalida cache para que el próximo mensaje use datos frescos
            cacheTime = 0;
        }
    } catch (e) {
        console.error('❌ [FILTER_ERR]', e.message);
    }
});

// ─── 6. INTERACCIONES ─────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName: cmd, options, guild, user, channel, member } = interaction;

    // Defer para comandos que tardan
    const slow = ['warn', 'remove-warn', 'nuke-chat', 'permissions-scan', 'block-word', 'warns'];
    if (slow.includes(cmd)) {
        await interaction.deferReply({ ephemeral: ['warn','remove-warn','warns'].includes(cmd) });
    }

    try {

        // ── /info ──
        if (cmd === 'info') {
            await interaction.reply({
                content: `${EMOJI.AMONG_US} **[TERMINAL_READY]**\n- Protocolos cargados.\n- Sync con Supabase: ✅\n- Bridge Dashboard: ✅\n- Servidor: **${guild.name}**`,
                ephemeral: true
            });
        }

        // ── /block-word ──
        if (cmd === 'block-word') {
            if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                return interaction.editReply('❌ No tienes permisos para bloquear palabras.');
            }
            const word = options.getString('palabra').toLowerCase().trim();
            if (!word) return interaction.editReply('❌ Palabra inválida.');

            // Intenta con guild_id, si falla sin él (compatibilidad)
            let { error } = await supabase.from('blocked_words').insert([{ word, guild_id: guild.id }]);
            if (error && error.code === '42703') {
                // columna guild_id no existe
                ({ error } = await supabase.from('blocked_words').insert([{ word }]));
            }
            if (error && error.code === '23505') {
                return interaction.editReply(`${EMOJI.LOCK} La palabra **"${word}"** ya estaba bloqueada.`);
            }
            cacheTime = 0; // invalida cache
            await supabase.from('system_logs').insert([{
                event: 'FILTER', details: `WORD_ADD: "${word}" por ${user.tag}`, operator: user.tag, guild_id: guild.id
            }]);
            await interaction.editReply(`${EMOJI.LOCK} **[DB_UPDATE]**: La palabra **"${word}"** ha sido bloqueada.`);
        }

        // ── /warn ──
        if (cmd === 'warn') {
            if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
                return interaction.editReply('❌ No tienes permisos para advertir usuarios.');
            }
            const target = options.getUser('user');
            const reason = options.getString('razon');

            if (target.id === user.id) return interaction.editReply('❌ No puedes advertirte a ti mismo.');
            if (target.bot)            return interaction.editReply('❌ No puedes advertir a un bot.');

            const { data } = await supabase.from('user_warns')
                .select('warn_count')
                .eq('user_id', target.id)
                .eq('guild_id', guild.id)   // filtrado por servidor
                .single();

            const count = (data?.warn_count || 0) + 1;

            // Intenta upsert con guild_id
            let { error } = await supabase.from('user_warns').upsert({
                user_id:          target.id,
                guild_id:         guild.id,
                warn_count:       count,
                last_warn_reason: reason,
                updated_at:       new Date().toISOString()
            });
            // Fallback sin guild_id
            if (error && error.code === '42703') {
                await supabase.from('user_warns').upsert({
                    user_id: target.id, warn_count: count, last_warn_reason: reason,
                    updated_at: new Date().toISOString()
                });
            }

            await supabase.from('system_logs').insert([{
                event: 'WARN', details: `WARN [${count}]: ${target.tag} | Motivo: ${reason}`, operator: user.tag, guild_id: guild.id
            }]);

            await interaction.editReply(`${EMOJI.ALERT_RED} **WARN [${count}/3]** → <@${target.id}>\n📋 Motivo: ${reason}`);

            // DM al usuario advertido
            try {
                await target.send(`⚠️ Has recibido una advertencia en **${guild.name}**.\n📋 Motivo: ${reason}\n⚠️ Llevas **${count}/3** advertencias.`);
            } catch { /* DMs desactivados */ }
        }

        // ── /remove-warn ──
        if (cmd === 'remove-warn') {
            if (!member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
                return interaction.editReply('❌ No tienes permisos.');
            }
            const target = options.getUser('user');
            const { error } = await supabase.from('user_warns').delete().eq('user_id', target.id);
            if (error) return interaction.editReply('❌ Error al eliminar warns.');
            await interaction.editReply(`✅ Warns de <@${target.id}> eliminados.`);
        }

        // ── /warns ──
        if (cmd === 'warns') {
            const target = options.getUser('user');
            let { data } = await supabase.from('user_warns')
                .select('*').eq('user_id', target.id).eq('guild_id', guild.id).single();
            // Fallback sin guild_id
            if (!data) {
                const fb = await supabase.from('user_warns').select('*').eq('user_id', target.id).single();
                data = fb.data;
            }
            if (!data || data.warn_count === 0) {
                return interaction.editReply(`✅ <@${target.id}> no tiene advertencias en este servidor.`);
            }
            await interaction.editReply(
                `${EMOJI.ALERT_RED} <@${target.id}> tiene **${data.warn_count}/3** advertencias.\n📋 Último motivo: ${data.last_warn_reason || 'N/A'}`
            );
        }

        // ── /system-isolation ──
        if (cmd === 'system-isolation') {
            if (user.id !== guild.ownerId) {
                return interaction.reply({ content: '❌ Solo el dueño del servidor puede usar este comando.', ephemeral: true });
            }
            const active = guild.verificationLevel < 4;
            await guild.setVerificationLevel(active ? 4 : 1);
            await interaction.reply(
                `${active ? EMOJI.ALERT_RED : EMOJI.AMONG_US} **AISLAMIENTO**: ${active ? 'ACTIVADO — Nivel de verificación máximo.' : 'DESACTIVADO — Servidor abierto.'}`
            );
            await supabase.from('system_logs').insert([{
                event: 'BAN', details: `ISOLATION: ${active ? 'ON' : 'OFF'} por ${user.tag}`, operator: user.tag, guild_id: guild.id
            }]);
        }

        // ── /lock-channel ──
        if (cmd === 'lock-channel') {
            if (!member.permissions.has(PermissionFlagsBits.ManageChannels)) {
                return interaction.reply({ content: '❌ No tienes permisos para bloquear canales.', ephemeral: true });
            }
            const everyone = guild.roles.everyone;
            const canSend  = channel.permissionsFor(everyone).has(PermissionFlagsBits.SendMessages);
            await channel.permissionOverwrites.edit(everyone, { SendMessages: canSend ? false : null });
            await interaction.reply(
                `${EMOJI.LOCK} **CANAL ${canSend ? 'CERRADO 🔒' : 'ABIERTO 🔓'}** — ${channel}`
            );
        }

        // ── /send-embed ──
        if (cmd === 'send-embed') {
            if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                return interaction.reply({ content: '❌ No tienes permisos.', ephemeral: true });
            }
            const targetChannel = options.getChannel('canal');
            const titulo = options.getString('titulo') || `${EMOJI.ALERT_BLUE} COMUNICADO DEL NÚCLEO`;
            const texto  = options.getString('texto');

            const embed = new EmbedBuilder()
                .setColor('#00ffcc')
                .setTitle(titulo)
                .setDescription(texto)
                .setTimestamp()
                .setFooter({ text: `Autorizado por: ${user.tag} | ${guild.name}` });

            await targetChannel.send({ embeds: [embed] });
            await interaction.reply({ content: `✅ Embed enviado a ${targetChannel}.`, ephemeral: true });
            await supabase.from('system_logs').insert([{
                event: 'INFO', details: `EMBED enviado a #${targetChannel.name} por ${user.tag}`, operator: user.tag, guild_id: guild.id
            }]);
        }

        // ── /nuke-chat ──
        if (cmd === 'nuke-chat') {
            if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                return interaction.editReply('❌ No tienes permisos de gestionar mensajes.');
            }
            const cant = Math.min(options.getInteger('cant'), 100);
            const deleted = await channel.bulkDelete(cant, true).catch(e => {
                throw new Error(e.message);
            });
            await interaction.editReply(`${EMOJI.NUCLEAR} **PURGA COMPLETADA**: ${deleted.size} mensajes eliminados.`);
            await supabase.from('system_logs').insert([{
                event: 'FILTER', details: `NUKE: ${deleted.size} msgs en #${channel.name} por ${user.tag}`, operator: user.tag, guild_id: guild.id
            }]);
        }

        // ── /permissions-scan ──
        if (cmd === 'permissions-scan') {
            if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.editReply('❌ Solo administradores pueden ejecutar este escaneo.');
            }
            const members = await guild.members.fetch();
            const admins  = members.filter(m =>
                m.permissions.has(PermissionFlagsBits.Administrator) && !m.user.bot
            );
            const list = admins.map(m => `• ${m.user.tag}`).slice(0, 20).join('\n');
            await interaction.editReply(
                `${EMOJI.ALERT_BLUE} **AUDITORÍA DE PERMISOS**\nSe detectaron **${admins.size}** usuario(s) con acceso TOTAL:\n\`\`\`\n${list || 'Ninguno'}\n\`\`\``
            );
        }

    } catch (e) {
        console.error(`❌ [CMD_ERR] /${cmd}:`, e.message);
        const reply = interaction.deferred || interaction.replied ? interaction.editReply : interaction.reply;
        await reply.call(interaction, { content: `❌ Error interno: ${e.message}`, ephemeral: true }).catch(() => {});
    }
});

// ─── 7. ANTI-SLEEP (Render free tier) ────────────────────
setInterval(() => {
    if (process.env.RENDER_EXTERNAL_HOSTNAME) {
        https.get(`https://${process.env.RENDER_EXTERNAL_HOSTNAME}`, res => {
            console.log(`🟢 [KEEP_ALIVE]: ${res.statusCode}`);
        }).on('error', () => console.error('🔴 [KEEP_ALIVE_ERR]'));
    }
}, 280_000);

// ─── 8. READY ─────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log(`✅ ${client.user.tag} ONLINE | ${client.guilds.cache.size} servidor(es) | Comandos sincronizados`);
    } catch (e) {
        console.error('❌ Error al registrar comandos:', e);
    }
});

client.login(process.env.DISCORD_TOKEN);