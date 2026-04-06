import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, type TextChannel } from "discord.js";
import { getDb } from "../../knowledge/db";
import { logger } from "../../shared/logger";
import type { MessagingProvider, CommandEvent, MessageEvent } from "../interface";

export class DiscordProvider implements MessagingProvider {
  readonly providerName = "discord";

  private client: Client;
  private guildId: string;
  private botToken: string;
  private commandHandlers: Array<(cmd: CommandEvent) => Promise<void>> = [];
  private messageHandlers: Array<(msg: MessageEvent) => Promise<void>> = [];

  constructor(botToken: string, guildId: string) {
    this.botToken = botToken;
    this.guildId = guildId;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async connect(): Promise<void> {
    this.client.on("messageCreate", async (message) => {
      if (message.author.bot) return;
      if (message.guildId !== this.guildId) return;

      const text = message.content.trim();
      const channelId = message.channelId;
      const senderId = message.author.id;
      const senderName = message.author.username;

      if (text.startsWith("!")) {
        const parts = text.slice(1).split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);
        const cmd: CommandEvent = {
          command,
          args,
          rawText: text,
          channelId,
          senderId,
          providerName: "discord",
        };
        for (const handler of this.commandHandlers) {
          try { await handler(cmd); } catch (err) {
            logger.error("Discord command handler error", { error: String(err) });
          }
        }
      } else {
        const msg: MessageEvent = {
          text,
          channelId,
          senderId,
          senderName,
          providerName: "discord",
        };
        for (const handler of this.messageHandlers) {
          try { await handler(msg); } catch (err) {
            logger.error("Discord message handler error", { error: String(err) });
          }
        }
      }
    });

    await this.client.login(this.botToken);

    // Wait for client to be ready
    await new Promise<void>((resolve) => {
      if (this.client.isReady()) { resolve(); return; }
      this.client.once("ready", () => resolve());
    });

    // Find or create #general and store in messaging_config
    const guild = await this.client.guilds.fetch(this.guildId);
    const channels = await guild.channels.fetch();
    let generalChannel = channels.find(
      (ch) => ch?.type === ChannelType.GuildText && ch.name === "general"
    ) as TextChannel | undefined;

    if (!generalChannel) {
      generalChannel = await guild.channels.create({
        name: "general",
        type: ChannelType.GuildText,
      }) as TextChannel;
    }

    const db = getDb();
    db.run(
      "INSERT OR REPLACE INTO messaging_config (key, value) VALUES (?, ?)",
      ["discord_main_channel_id", generalChannel.id]
    );

    logger.info("Discord provider connected", { guildId: this.guildId, generalChannelId: generalChannel.id });
  }

  getMainChannelId(): string | null {
    const db = getDb();
    const row = db.query("SELECT value FROM messaging_config WHERE key = ?")
      .get("discord_main_channel_id") as { value: string } | null;
    return row?.value ?? null;
  }

  async createTaskChannel(taskId: string, title: string): Promise<string> {
    try {
      const guild = await this.client.guilds.fetch(this.guildId);
      const shortId = taskId.slice(0, 8).toLowerCase();
      const channel = await guild.channels.create({
        name: `hoto-task-${shortId}`,
        type: ChannelType.GuildText,
        topic: title,
      }) as TextChannel;

      // Send an initial message so the channel appears in the user's channel list
      await channel.send(`Task: **${title}**\nID: \`${taskId}\``);

      return channel.id;
    } catch (err) {
      logger.warn("Discord: failed to create task channel", { taskId, error: String(err) });
      throw err;
    }
  }

  async setChannelTopic(channelId: string, topic: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel;
      await channel.setTopic(topic);
    } catch (err) {
      logger.warn("Discord: failed to set channel topic", { channelId, error: String(err) });
    }
  }

  async archiveChannel(channelId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel) await channel.delete();
    } catch (err) {
      logger.warn("Discord: failed to delete channel", { channelId, error: String(err) });
    }
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel;
      await channel.send(text);
    } catch (err) {
      logger.warn("Discord: failed to send message", { channelId, error: String(err) });
    }
  }

  async sendFormattedMessage(channelId: string, _html: string, plaintext: string): Promise<void> {
    await this.sendMessage(channelId, plaintext);
  }

  async inviteUser(channelId: string, userId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId) as TextChannel;
      // Grant the user explicit permission to view the channel
      await channel.permissionOverwrites.create(userId, {
        ViewChannel: true,
        SendMessages: true,
      });
      // Mention the user so they get a notification
      await channel.send(`<@${userId}> You've been assigned to this task.`);
    } catch (err) {
      logger.warn("Discord: failed to invite user to channel", { channelId, userId, error: String(err) });
    }
  }

  async kickAllMembers(_channelId: string): Promise<void> {
    // No-op: channel deletion (archiveChannel) handles cleanup.
  }

  onCommand(handler: (cmd: CommandEvent) => Promise<void>): void {
    this.commandHandlers.push(handler);
  }

  onMessage(handler: (msg: MessageEvent) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
  }
}
