import {
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { getConfig } from '../core/config.js';
import { getLogger } from '../core/logger.js';

function buildCommands(): SlashCommandBuilder[] {
  return [
    new SlashCommandBuilder()
      .setName('search')
      .setDescription('Recherche dans la base de veille, suggestions et publications')
      .addStringOption((option) =>
        option.setName('query').setDescription('Termes de recherche').setRequired(true),
      ) as SlashCommandBuilder,

    new SlashCommandBuilder()
      .setName('veille')
      .setDescription('Force une veille immédiate'),

    new SlashCommandBuilder()
      .setName('budget')
      .setDescription('Affiche les coûts API')
      .addStringOption((option) =>
        option
          .setName('period')
          .setDescription('Période à afficher')
          .setRequired(false)
          .addChoices(
            { name: 'Aujourd\'hui', value: 'daily' },
            { name: 'Cette semaine', value: 'weekly' },
            { name: 'Ce mois', value: 'monthly' },
          ),
      ) as SlashCommandBuilder,

    new SlashCommandBuilder()
      .setName('stats')
      .setDescription('Affiche le profil de préférences actuel'),

    new SlashCommandBuilder()
      .setName('config')
      .setDescription('Modifie un paramètre dynamique')
      .addStringOption((option) =>
        option.setName('key').setDescription('Clé du paramètre').setRequired(true),
      )
      .addStringOption((option) =>
        option.setName('value').setDescription('Nouvelle valeur').setRequired(true),
      ) as SlashCommandBuilder,

    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Reçois un DM pour configurer ou créer une instance'),
  ];
}

export async function registerGuildCommands(clientId: string): Promise<void> {
  const config = getConfig();
  const logger = getLogger();

  const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
  const commands = buildCommands().map((cmd) => cmd.toJSON());

  logger.info(
    { count: commands.length, guild: config.DISCORD_GUILD_ID },
    'Registering slash commands',
  );

  await rest.put(Routes.applicationGuildCommands(clientId, config.DISCORD_GUILD_ID), {
    body: commands,
  });

  logger.info('Slash commands registered');
}
