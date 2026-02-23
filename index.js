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
app.use(cors()); // Permite que tu Dashboard se conecte
app.use(express.json());

app.get('/', (req, res) => {
    res.send({ status: "CORE_ONLINE", timestamp: new Date() });
});

// Endpoint para que el Dashboard vea logs rápido
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

// --- 4. COMANDOS ---
const commands = [
    new SlashCommandBuilder().setName('info').setDescription('📋 Manual de protocolos'),
    new SlashCommandBuilder().setName('system-isolation').setDescription('🚨 Lockdown (Solo Dueño)'),
    new SlashCommandBuilder().setName('lock-channel').setDescription('🔑 Bloqueo de canal'),
    new SlashCommandBuilder().setName('block-word').setDescription('🚫 Bloquear palabra').addStringOption(o => o.setName('palabra').setRequired(true)),
    new SlashCommandBuilder().setName('warn').setDescription('⚠️ Advertir usuario').addUserOption(o => o.setName('user').setRequired(true)).addStringOption(o => o.setName('razon').setRequired(true)),
    new SlashCommandBuilder().setName('send-embed').setDescription('📤 Mensaje formal').addChannelOption(o => o.setName('canal').setRequired(true)).addStringOption(o => o.setName('texto').setRequired(true)),
    new SlashCommandBuilder().setName('nuke-chat').setDescription('☢️ Purga masiva').addIntegerOption(o => o.setName('cant').setRequired(true)),
    new SlashCommandBuilder().setName('permissions-scan').setDescription('🛡️ Escaneo de Admins')
].map(c => c.toJSON());

// --- 5. FILTRO DE PALABRAS ---
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    const { data: words } = await supabase.from('blocked_words').select('word');
    const list = words?.map(w => w.word.toLowerCase()) || [];
    if (list.some(w => message.content.toLowerCase().includes(w))) {
        await message.delete().catch(() => {});
        await supabase.from('system_logs').insert([{ event: 'FILTER', details: `MSG_DEL: ${message.author.tag}`, operator: 'AUTO_MOD' }]);
    }
});

// --- 6. MANEJO DE INTERACCIONES ---
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName: cmd, options, guild, user } = interaction;

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
        await interaction.reply(`${EMOJI.ALERT_RED} **WARN [${count}]** -> ${target}`);
    }

    if (cmd === 'system-isolation') {
        if (user.id !== guild.ownerId) return interaction.reply('❌ Acceso denegado.');
        const active = guild.verificationLevel !== 4;
        await guild.setVerificationLevel(active ? 4 : 1);
        await interaction.reply(`${active ? EMOJI.ALERT_RED : EMOJI.AMONG_US} **AISLAMIENTO**: ${active ? 'ON' : 'OFF'}`);
    }

    if (cmd === 'info') {
        await interaction.reply(`${EMOJI.AMONG_US} **[TERMINAL_READY]**\n- Protocolos cargados.\n- Sync con Supabase: OK.\n- Bridge Dashboard: ONLINE.`);
    }
    
    // ... (El resto de lógicas de nuke-chat, send-embed etc son iguales)
});

// --- 7. PROTOCOLO ANTI-SLEEP ---
// Esto hace que el bot se llame a sí mismo para no morir en Render
setInterval(() => {
    const url = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`; // Render autodefine esta variable
    if (process.env.RENDER_EXTERNAL_HOSTNAME) {
        https.get(url, (res) => {
            console.log(`🟢 [KEEP_ALIVE]: Status ${res.statusCode}`);
        }).on('error', (e) => console.error('🔴 [KEEP_ALIVE_ERR]'));
    }
}, 280000); // Cada 4.6 minutos

client.once(Events.ClientReady, async () => {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log(`✅ ${client.user.tag} ONLINE`);
});

client.login(process.env.DISCORD_TOKEN);