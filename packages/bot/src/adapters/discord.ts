import { Client, GatewayIntentBits, Message, TextChannel } from 'discord.js';
import { TransactionNotificationData } from './types';
import { createTrustlineOperation } from '@chen-pilot/sdk-core';
import { AssetVerificationService } from '../assetVerification';

const BACKEND_URL = process.env.API_BASE_URL || 'http://localhost:2333';
const DASHBOARD_URL = process.env.DASHBOARD_URL || `${BACKEND_URL}/dashboard`;
const HORIZON_URL = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';

// #145: Anti-flood debounce — 3 seconds per user
const DEBOUNCE_MS = 3000;

export class DiscordAdapter {
  private client: Client;
  private userChannels: Map<string, string> = new Map(); // userId -> channelId
  private token: string;
  // #145: Track last command timestamp per user
  private lastCommandTime: Map<string, number> = new Map();
  private verificationService: AssetVerificationService;

  constructor(token: string) {
    this.token = token;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.verificationService = new AssetVerificationService(HORIZON_URL);
  }

  // #145: Returns true if the user is flooding (within debounce window)
  private isFlooding(userId: string): boolean {
    const now = Date.now();
    const last = this.lastCommandTime.get(userId) ?? 0;
    if (now - last < DEBOUNCE_MS) return true;
    this.lastCommandTime.set(userId, now);
    return false;
  }

  async init() {
    const token = process.env.DISCORD_BOT_TOKEN || this.token;
    if (!token) {
      console.warn("⚠️ Discord: No token provided, skipping initialization.");
      return;
    }

    this.client.once("ready", () => {
      console.log(`✅ Discord bot logged in as ${this.client.user?.tag}`);
    });

    this.client.on("messageCreate", async (message: Message) => {
      if (message.author.bot) return;

      const userId = message.author.id;

      // #145: Anti-flood check for all commands
      if (this.isFlooding(userId)) {
        await message.reply("⏳ Please wait a moment before sending another command.");
        return;
      }

      if (message.content === "!start") {
        await message.reply(
          "Welcome to Chen Pilot! I am your AI-powered Stellar DeFi assistant."
        );
      }

      if (message.content === "!sponsor") {
        await message.reply("⏳ Requesting account sponsorship...");

        try {
          const response = await fetch(
            `${BACKEND_URL}/api/account/${userId}/sponsor`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
            }
          );
          const data = (await response.json()) as {
            success: boolean;
            message: string;
            address?: string;
          };

          if (data.success) {
            await message.reply(
              `✅ Account sponsored successfully!\n📬 Address: \`${data.address}\``
            );
          } else {
            await message.reply(`❌ Sponsorship failed: ${data.message}`);
          }
        } catch (error) {
          console.error("Sponsor command error:", error);
          await message.reply(
            "❌ Could not reach the sponsorship service. Please try again later."
          );
        }
      }

      if (message.content.startsWith('!trustline')) {
        const args = message.content.split(' ').slice(1);
        if (args.length < 1) {
          return message.reply('Usage: !trustline <assetCode> [issuerDomain|issuerAddress]\nExample: !trustline USDC circle.com');
        }

        const assetCode = args[0];
        const assetIssuer = args[1];

        if (!assetIssuer) {
          return message.reply(`Please provide an issuer domain or address for ${assetCode}.`);
        }

        try {
          await message.reply(`🔍 Looking up asset ${assetCode} from ${assetIssuer}...`);
          const op = await createTrustlineOperation(assetCode, assetIssuer);

          let response = `✅ Found asset ${assetCode}!\n\n`;
          response += `To add this trustline, you can use the following details in your wallet:\n`;
          response += `**Asset:** ${assetCode}\n`;
          response += `**Issuer:** \`${(op as any).asset.issuer}\`\n\n`;
          response += `*Note: In a future update, I will provide a direct signing link.*`;

          await message.reply(response);
        } catch (error) {
          await message.reply(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // #146: Dashboard command
      if (message.content === '!dashboard') {
        await message.reply(
          `📊 **Chen Pilot Dashboard**\n\nAccess your admin dashboard here:\n🔗 ${DASHBOARD_URL}\n\n*Note: You must be logged in to view the dashboard.*`
        );
      }

      // #148: /validate command for Stellar asset verification
      if (message.content.startsWith('!validate')) {
        const args = message.content.split(' ').slice(1);
        if (args.length < 2) {
          return message.reply('Usage: !validate <assetCode> <issuerAddress>\nExample: !validate USDC GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
        }

        const [assetCode, issuerAddress] = args;
        await message.reply(`🔍 Verifying asset **${assetCode}** from issuer \`${issuerAddress.slice(0, 8)}...\``);

        try {
          const result = await this.verificationService.verifyAsset(assetCode, issuerAddress);
          const statusEmoji = result.status === 'VERIFIED' ? '✅' : result.status === 'MALICIOUS' ? '🚨' : '⚠️';

          let reply = `${statusEmoji} **Asset Verification: ${result.status}**\n\n`;
          reply += `**Asset:** ${assetCode}\n`;
          reply += `**Issuer:** \`${issuerAddress}\`\n`;
          if (result.domain) reply += `**Domain:** ${result.domain}\n`;
          if (result.details) reply += `**Details:** ${result.details}\n`;
          reply += `\n**Safe to use:** ${result.isSafe ? 'Yes ✅' : 'No ❌'}`;

          await message.reply(reply);
        } catch (error) {
          await message.reply(`❌ Verification error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });

    await this.client.login(token);
    console.log("✅ Discord bot initialized.");
  }

  // #147: Announce a new GitHub release to all registered announcement channels
  async announceRelease(channelId: string, release: { tag_name: string; name: string; html_url: string; body?: string }): Promise<boolean> {
    if (!this.client?.user) {
      console.warn("⚠️ Discord bot not initialized");
      return false;
    }

    const channel = this.client.channels.cache.get(channelId) as TextChannel;
    if (!channel) {
      console.warn(`⚠️ Announcement channel ${channelId} not found`);
      return false;
    }

    const body = release.body ? `\n\n${release.body.slice(0, 500)}${release.body.length > 500 ? '...' : ''}` : '';
    const message = `🚀 **New Release: ${release.name || release.tag_name}**${body}\n\n🔗 ${release.html_url}`;

    try {
      await channel.send(message);
      return true;
    } catch (error) {
      console.error("Error sending release announcement:", error);
      return false;
    }
  }

  async registerUser(userId: string, channelId: string): Promise<boolean> {
    this.userChannels.set(userId, channelId);
    return true;
  }

  async sendTransactionNotification(
    userId: string,
    data: TransactionNotificationData
  ): Promise<boolean> {
    if (!this.client || !this.client.user) {
      console.warn("⚠️ Discord bot not initialized");
      return false;
    }

    const channelId = this.userChannels.get(userId);
    if (!channelId) {
      console.warn(`⚠️ No channel ID found for user ${userId}`);
      return false;
    }

    const channel = this.client.channels.cache.get(channelId) as TextChannel;
    if (!channel) {
      console.warn(`⚠️ Channel ${channelId} not found`);
      return false;
    }

    const message = this.formatTransactionMessage(data);

    try {
      await channel.send(message);
      return true;
    } catch (error) {
      console.error("Error sending Discord notification:", error);
      return false;
    }
  }

  private formatTransactionMessage(data: TransactionNotificationData): string {
    const statusEmoji = data.successful ? "✅" : "❌";
    const timestamp = new Date(data.timestamp).toLocaleString();

    let message = `**Transaction ${data.successful ? "Confirmed" : "Failed"}** ${statusEmoji}\n\n`;
    message += `📋 **Hash:** \`${data.hash.slice(0, 8)}...${data.hash.slice(-8)}\`\n`;
    message += `💰 **Amount:** ${data.amount} ${data.asset}\n`;
    message += `📤 **From:** \`${data.from.slice(0, 4)}...${data.from.slice(-4)}\`\n`;
    message += `📥 **To:** \`${data.to.slice(0, 4)}...${data.to.slice(-4)}\`\n`;
    message += `⏱️ **Time:** ${timestamp}\n`;

    if (data.fee) {
      message += `💵 **Fee:** ${data.fee} XLM\n`;
    }

    if (data.memo) {
      message += `📝 **Memo:** ${data.memo}\n`;
    }

    return message;
  }

  async sendNotification(userId: string, message: string): Promise<boolean> {
    if (!this.client || !this.client.user) {
      console.warn("⚠️ Discord bot not initialized");
      return false;
    }

    const channelId = this.userChannels.get(userId);
    if (!channelId) {
      return false;
    }

    const channel = this.client.channels.cache.get(channelId) as TextChannel;
    if (!channel) {
      return false;
    }

    try {
      await channel.send(message);
      return true;
    } catch (error) {
      console.error("Error sending Discord notification:", error);
      return false;
    }
  }

  getClient(): Client {
    return this.client;
  }
}
