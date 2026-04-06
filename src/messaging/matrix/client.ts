import * as sdk from "matrix-js-sdk";
import { logger as matrixLogger } from "matrix-js-sdk/lib/logger";
import type { MessagingProvider, CommandEvent, MessageEvent } from "../interface";
import { getDb } from "../../knowledge/db";
import { config } from "../../shared/config";
import { logger } from "../../shared/logger";

// Silence matrix-js-sdk's verbose internal logging (fetchHttpApi, etc.)
matrixLogger.setLevel("warn");

export class MatrixProvider implements MessagingProvider {
  readonly providerName = "matrix";

  private client: sdk.MatrixClient | null = null;
  private commandHandlers: Array<(cmd: CommandEvent) => Promise<void>> = [];
  private messageHandlers: Array<(msg: MessageEvent) => Promise<void>> = [];
  private userId: string = "";
  private mainChannelId: string | null = null;

  async connect(): Promise<void> {
    const homeserverUrl = config.matrixHomeserverUrl;
    if (!homeserverUrl) {
      throw new Error("MATRIX_HOMESERVER_URL not configured");
    }

    // Try to use existing token from config or env
    let accessToken = config.matrixBotToken;
    const botUser = config.matrixBotUser;

    // Check DB for stored token
    if (!accessToken) {
      const db = getDb();
      const stored = db.query("SELECT value FROM messaging_config WHERE key = 'matrix_access_token'").get() as { value: string } | null;
      if (stored) {
        accessToken = stored.value;
      }
    }

    // Validate the token if we have one
    if (accessToken) {
      try {
        const res = await fetch(`${homeserverUrl}/_matrix/client/v3/account/whoami`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) {
          logger.info("Stored Matrix token is invalid, re-authenticating");
          accessToken = null;
        }
      } catch {
        logger.info("Could not validate Matrix token, re-authenticating");
        accessToken = null;
      }
    }

    // If no valid token, register or login
    if (!accessToken) {
      accessToken = await this.authenticate(homeserverUrl, botUser);
    }

    this.client = sdk.createClient({
      baseUrl: homeserverUrl,
      accessToken,
      userId: botUser,
    });

    this.userId = botUser;

    // Set up event listeners
    this.client.on(sdk.RoomEvent.Timeline, (event, room) => {
      if (!room) return;
      if (event.getType() !== "m.room.message") return;
      if (event.getSender() === this.userId) return; // Ignore own messages

      const content = event.getContent();
      const body = content.body as string;
      if (!body) return;

      const channelId = room.roomId;
      const senderId = event.getSender() ?? "unknown";
      const senderName = room.getMember(senderId)?.name ?? senderId;

      if (body.startsWith("!")) {
        // Parse command
        const parts = body.slice(1).split(/\s+/);
        const command = parts[0];
        const args = parts.slice(1);

        const cmd: CommandEvent = {
          command,
          args,
          rawText: body,
          channelId,
          senderId,
          providerName: "matrix",
        };

        for (const handler of this.commandHandlers) {
          handler(cmd);
        }
      } else {
        const msg: MessageEvent = {
          text: body,
          channelId,
          senderId,
          senderName,
          providerName: "matrix",
        };

        for (const handler of this.messageHandlers) {
          handler(msg);
        }
      }
    });

    await this.client.startClient({ initialSyncLimit: 0 });

    // Wait for initial sync
    await new Promise<void>((resolve) => {
      this.client?.once(sdk.ClientEvent.Sync, (state) => {
        if (state === "PREPARED") resolve();
      });
    });

    // Ensure main channel exists
    this.mainChannelId = await this.ensureMainChannel();

    logger.info("Matrix client connected", { userId: botUser, homeserver: homeserverUrl });
  }

  getMainChannelId(): string | null {
    return this.mainChannelId;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.stopClient();
      this.client = null;
    }
  }

  async createTaskChannel(taskId: string, title: string): Promise<string> {
    if (!this.client) throw new Error("Matrix client not connected");

    const shortId = taskId.slice(0, 8).toLowerCase();
    const alias = `hoto-task-${shortId}`;
    const roomName = `[Task] ${title.slice(0, 50)}`;

    const result = await this.client.createRoom({
      name: roomName,
      room_alias_name: alias,
      topic: `Hoto task: ${taskId}`,
      preset: sdk.Preset.PublicChat,
      visibility: sdk.Visibility.Public,
    });

    // Explicitly publish to room directory
    try {
      await this.client.setRoomDirectoryVisibility(result.room_id, sdk.Visibility.Public);
    } catch (err) {
      logger.warn("Failed to publish task channel to directory", { taskId, error: String(err) });
    }

    return result.room_id;
  }

  async setChannelTopic(channelId: string, topic: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.setRoomTopic(channelId, topic);
    } catch (err) {
      logger.warn("Failed to set channel topic", { channelId, error: String(err) });
    }
  }

  async inviteUser(channelId: string, userId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.invite(channelId, userId);
    } catch (err) {
      logger.warn("Failed to invite user", { channelId, userId, error: String(err) });
    }
  }

  async archiveChannel(channelId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.setRoomTopic(channelId, "[Archived]");
    } catch (err) {
      logger.warn("Failed to archive channel", { channelId, error: String(err) });
    }
  }

  async kickAllMembers(channelId: string): Promise<void> {
    if (!this.client) return;
    try {
      const room = this.client.getRoom(channelId);
      if (!room) return;
      const members = room.getJoinedMembers();
      for (const member of members) {
        if (member.userId === this.userId) continue;
        try {
          await this.client.kick(channelId, member.userId, "Task cleaned up");
        } catch (err) {
          logger.warn("Failed to kick member from channel", { channelId, userId: member.userId, error: String(err) });
        }
      }
    } catch (err) {
      logger.warn("Failed to kick members from channel", { channelId, error: String(err) });
    }
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.sendTextMessage(channelId, text);
    } catch (err) {
      logger.warn("Failed to send message", { channelId, error: String(err) });
    }
  }

  async sendFormattedMessage(channelId: string, html: string, plaintext: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.sendHtmlMessage(channelId, plaintext, html);
    } catch (err) {
      logger.warn("Failed to send formatted message", { channelId, error: String(err) });
    }
  }

  onCommand(handler: (cmd: CommandEvent) => Promise<void>): void {
    this.commandHandlers.push(handler);
  }

  onMessage(handler: (msg: MessageEvent) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  private async authenticate(homeserverUrl: string, botUser: string): Promise<string> {
    const localpart = botUser.split(":")[0].replace("@", "");
    const password = config.matrixBotPassword ?? "hoto-bot-default";

    const tempClient = sdk.createClient({ baseUrl: homeserverUrl });

    let accessToken: string;

    // Try to register first
    try {
      const registerResult = await tempClient.register(localpart, password, null, { type: "m.login.dummy" });
      accessToken = registerResult.access_token ?? "";
      logger.info("Matrix bot registered", { user: botUser });
    } catch {
      // Registration failed, try login
      try {
        const loginResult = await tempClient.login("m.login.password", {
          user: localpart,
          password,
        });
        accessToken = loginResult.access_token;
        logger.info("Matrix bot logged in", { user: botUser });
      } catch (loginErr) {
        throw new Error(`Matrix authentication failed: ${loginErr}`);
      }
    }

    // Store token in DB
    const db = getDb();
    db.run(
      "INSERT OR REPLACE INTO messaging_config (key, value) VALUES ('matrix_access_token', ?)",
      [accessToken]
    );

    return accessToken;
  }

  private async ensureMainChannel(): Promise<string> {
    if (!this.client) throw new Error("Matrix client not connected");

    const alias = "#hoto:localhost";

    // Check if we already know the room
    const db = getDb();
    const stored = db.query("SELECT value FROM messaging_config WHERE key = 'main_channel_id'").get() as { value: string } | null;

    // Try to resolve the alias on the server (authoritative check)
    try {
      const resolved = await this.client.getRoomIdForAlias(alias);
      if (resolved?.room_id) {
        // Join the room if not already joined
        try { await this.client.joinRoom(resolved.room_id); } catch {}
        db.run("INSERT OR REPLACE INTO messaging_config (key, value) VALUES ('main_channel_id', ?)", [resolved.room_id]);
        await this.client.setRoomDirectoryVisibility(resolved.room_id, sdk.Visibility.Public).catch(() => {});
        logger.info("Main channel found via alias", { roomId: resolved.room_id });
        return resolved.room_id;
      }
    } catch {
      // Alias doesn't exist -- clear stale stored ID if any
      if (stored) {
        db.run("DELETE FROM messaging_config WHERE key = 'main_channel_id'");
      }
    }

    const result = await this.client.createRoom({
      name: "Hoto",
      room_alias_name: "hoto",
      topic: `Hoto task manager${config.giteaUrl ? ` -- Gitea: ${config.giteaUrl}/${config.giteaOrg}` : ""}`,
      preset: sdk.Preset.PublicChat,
      visibility: sdk.Visibility.Public,
    });

    db.run("INSERT OR REPLACE INTO messaging_config (key, value) VALUES ('main_channel_id', ?)", [result.room_id]);

    try {
      await this.client.setRoomDirectoryVisibility(result.room_id, sdk.Visibility.Public);
    } catch (err) {
      logger.warn("Failed to publish main channel to directory", { error: String(err) });
    }

    logger.info("Created main Matrix channel", { roomId: result.room_id });

    return result.room_id;
  }
}
