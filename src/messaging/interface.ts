export interface CommandEvent {
  command: string;
  args: string[];
  rawText: string;
  channelId: string;
  senderId: string;
}

export interface MessageEvent {
  text: string;
  channelId: string;
  senderId: string;
  senderName: string;
}

export interface MessagingProvider {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  createTaskChannel(taskId: string, title: string): Promise<string>;
  setChannelTopic(channelId: string, topic: string): Promise<void>;
  archiveChannel(channelId: string): Promise<void>;
  sendMessage(channelId: string, text: string): Promise<void>;
  sendFormattedMessage(channelId: string, html: string, plaintext: string): Promise<void>;
  onCommand(handler: (cmd: CommandEvent) => Promise<void>): void;
  onMessage(handler: (msg: MessageEvent) => Promise<void>): void;
}
