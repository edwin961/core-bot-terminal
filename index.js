require('dotenv').config();
const { 
    Client, GatewayIntentBits, Events, REST, Routes, 
    SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder 
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const https = require('https');

// --- 1. CONEXIÓN SUPABASE ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- 2. CONFIGURACIÓN EXPRESS (Bridge para Dashboard) ---
const app = express();
app.use(cors()); 
app.use(express.json());

app.get('/', (req, res) => {
    res.send({ status: "CORE_ONLINE", timestamp: new Date() });
});

app.get('/api/logs', async (req, res) => {
    const { data } = await supabase.from('system_logs').select('*').order('created_at', { ascending: false }).limit(20);
    res.json(data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`📡 Bridge activo en puerto ${PORT}`));

// --- 3. CONFIGURACIÓN BOT DISCORD ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent
    ],
});

const EMOJI = {
    AMONG_US: '<a:42811vaporwaveamongus:1475287541308723343>',
    LOCK: '<a:44503lockkey:1475287251771457636>',
    NUCLEAR: '<a:5309nuclearlaunchbutton:1475287239046070342>',
    ALERT_BLUE: '<a:5567alertblue1:1475286980957966559>',
    ALERT_RED: '<a:75814alert:1475286853753241630>'
};

// --- 4. DEFINICIÓN DE COMANDOS ---
const commands = [
    new SlashCommandBuilder().setName('info').setDescription('📋 Manual de protocolos'),
    new SlashCommandBuilder().setName('system-isolation').setDescription('🚨 Lockdown (Solo Dueño)'),
    new SlashCommandBuilder().setName('lock-channel').setDescription('🔑 Bloqueo de canal'),
    new SlashCommandBuilder().setName('block-word').setDescription('🚫 Bloquear palabra').addStringOption(o => o.setName('palabra').setRequired(true).setDescription('Palabra a banear')),
    new SlashCommandBuilder().setName('warn').setDescription('⚠️ Advertir usuario').addUserOption(o => o.setName('user').setRequired(true).setDescription('Usuario')).addStringOption(o => o.setName('razon').setRequired(true).setDescription('Motivo')),
    new SlashCommandBuilder().setName('send-embed').setDescription('📤 Mensaje formal').addChannelOption(o => o.setName('canal').setRequired(true).setDescription('Donde enviar')).addStringOption(o => o.setName('texto').setRequired(true).setDescription('Contenido')),
    new SlashCommandBuilder().setName('nuke-chat').setDescription('☢️ Purga masiva').addIntegerOption(o => o.setName('cant').setRequired(true).setDescription('Cantidad de mensajes')),
    new SlashCommandBuilder().setName('permissions-scan').setDescription('🛡️ Escaneo de Admins')
].map(c => c.toJSON());

// --- 5. FILTRO DE PALABRAS ---
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.guild) return;
    const { data: words } = await supabase.from('blocked_words').select('word');
    const list = words?.map(w => w.word.toLowerCase()) || [];
    if (list.some(w => message.content.toLowerCase().includes(w))) {
        await message.delete().catch(() => {});
        await supabase.from('system_logs').insert([{ event: 'FILTER', details: `MSG_DEL: ${message.author.tag} en #${message.channel.name}`, operator: 'AUTO_MOD' }]);
    }
});

// --- 6. MANEJO DE INTERACCIONES ---
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName: cmd, options, guild, user, channel } = interaction;

    if (cmd === 'info') {
        await interaction.reply(`${EMOJI.AMONG_US} **[TERMINAL_READY]**\n- Protocolos cargados.\n- Sync con Supabase: OK.\n- Bridge Dashboard: ONLINE.`);
    }

    if (cmd === 'block-word') {
        const word = options.getString('palabra').toLowerCase();
        await supabase.from('blocked_words').insert([{ word }]);
        await interaction.reply(`${EMOJI.LOCK} **[DB_UPDATE]**: "${word}" bloqueada.`);
    }

    if (cmd === 'warn') {
        const target = options.getUser('user');
        const reason = options.getString('razon');
        const { data } = await supabase.from('user_warns').select('warn_count').eq('user_id', target.id).single();
        const count = (data?.warn_count || 0) + 1;
        await supabase.from('user_warns').upsert({ user_id: target.id, warn_count: count, last_warn_reason: reason });
        await interaction.reply(`${EMOJI.ALERT_RED} **WARN [${count}]** -> ${target} | Motivo: ${reason}`);
    }

    if (cmd === 'system-isolation') {
        if (user.id !== guild.ownerId) return interaction.reply({ content: '❌ Acceso denegado: Se requiere privilegios ROOT.', ephemeral: true });
        const active = guild.verificationLevel !== 4;
        await guild.setVerificationLevel(active ? 4 : 1);
        await interaction.reply(`${active ? EMOJI.ALERT_RED : EMOJI.AMONG_US} **AISLAMIENTO**: ${active ? 'ACTIVADO (Nivel 4)' : 'DESACTIVADO'}`);
    }

    if (cmd === 'lock-channel') {
        const everyone = guild.roles.everyone;
        const canSend = channel.permissionsFor(everyone).has(PermissionFlagsBits.SendMessages);
        await channel.permissionOverwrites.edit(everyone, { SendMessages: !canSend });
        await interaction.reply(`${EMOJI.LOCK} **CANAL**: ${canSend ? 'CERRADO' : 'ABIERTO'}`);
    }

    if (cmd === 'send-embed') {
        const targetChannel = options.getChannel('canal');
        const text = options.getString('texto');
        const embed = new EmbedBuilder()
            .setColor('#00ffcc')
            .setTitle(`${EMOJI.ALERT_BLUE} COMUNICADO DEL NÚCLEO`)
            .setDescription(text)
            .setTimestamp()
            .setFooter({ text: `Auth: ${user.tag}` });
        
        await targetChannel.send({ embeds: [embed] });
        await interaction.reply({ content: '✅ Transmisión enviada.', ephemeral: true });
    }

    if (cmd === 'nuke-chat') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) return interaction.reply('❌ No tienes permisos.');
        const cant = options.getInteger('cant');
        const deleted = await channel.bulkDelete(Math.min(cant, 100), true);
        await interaction.reply(`${EMOJI.NUCLEAR} **PURGA**: ${deleted.size} mensajes eliminados.`);
    }

    if (cmd === 'permissions-scan') {
        const admins = (await guild.members.fetch()).filter(m => m.permissions.has(PermissionFlagsBits.Administrator) && !m.user.bot);
        await interaction.reply(`${EMOJI.ALERT_BLUE} **AUDITORÍA**: Se detectaron **${admins.size}** usuarios con acceso TOTAL.`);
    }
});

// --- 7. PROTOCOLO ANTI-SLEEP ---
setInterval(() => {
    if (process.env.RENDER_EXTERNAL_HOSTNAME) {
        https.get(`https://${process.env.RENDER_EXTERNAL_HOSTNAME}`, (res) => {
            console.log(`🟢 [KEEP_ALIVE]: Status ${res.statusCode}`);
        }).on('error', (e) => console.error('🔴 [KEEP_ALIVE_ERR]'));
    }
}, 280000);

client.once(Events.ClientReady, async () => {
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log(`✅ ${client.user.tag} ONLINE | Comandos Sincronizados`);
    } catch (error) {
        console.error('❌ Error al registrar comandos:', error);
    }
});

client.login(process.env.DISCORD_TOKEN);