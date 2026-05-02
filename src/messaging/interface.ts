export interface CommandEvent {
  command: string;
  args: string[];
  rawText: string;
  channelId: string;
  senderId: string;
  providerName: string;
}

export interface MessageEvent {
  text: string;
  channelId: string;
  senderId: string;
  senderName: string;
  providerName: string;
}

export interface MessagingProvider {
  readonly providerName: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getMainChannelId(): string | null;
  createTaskChannel(taskId: string, title: string): Promise<string>;
  setChannelTopic(channelId: string, topic: string): Promise<void>;
  archiveChannel(channelId: string): Promise<void>;
  /**
   * Re-activates a previously archived/deleted channel for a task.
   * Implementations that delete channels on archive (e.g. Discord) must create
   * a new channel and return its ID. Implementations that support true unarchive
   * return the same channelId unchanged.
   *
   * @returns The channel ID to use going forward (may differ from the input if a
   *          new channel was created).
   */
  reactivateChannel(channelId: string, taskShortId: string, taskTitle: string): Promise<string>;
  sendMessage(channelId: string, text: string): Promise<void>;
  sendFormattedMessage(channelId: string, html: string, plaintext: string): Promise<void>;
  inviteUser(channelId: string, userId: string): Promise<void>;
  kickAllMembers(channelId: string): Promise<void>;
  listTaskChannels(): Promise<string[]>;
  onCommand(handler: (cmd: CommandEvent) => Promise<void>): void;
  onMessage(handler: (msg: MessageEvent) => Promise<void>): void;
}
