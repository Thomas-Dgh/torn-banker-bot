require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");

const BANK_CATEGORY_ID = process.env.BANK_CATEGORY_ID;
const TORN_API_KEY = process.env.TORN_API_KEY;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

console.log("🏦 === FLUFFY BANKER BOT ===");
console.log("🚀 Starting...\n");

// Cache faction balances (refresh every 2 minutes)
let balanceCache = null;
let balanceCacheTime = 0;
const CACHE_TTL = 2 * 60 * 1000;

async function getFactionBalances() {
  const now = Date.now();
  if (balanceCache && now - balanceCacheTime < CACHE_TTL) {
    return balanceCache;
  }

  try {
    const response = await fetch("https://api.torn.com/v2/faction?selections=balance", {
      headers: { "Authorization": `ApiKey ${TORN_API_KEY}` },
    });
    const data = await response.json();

    if (data.error) {
      console.error("❌ Torn API error:", data.error.error);
      return null;
    }

    balanceCache = data.balance;
    balanceCacheTime = now;
    return data.balance;
  } catch (error) {
    console.error("❌ Torn API fetch error:", error.message);
    return null;
  }
}

function getMemberBalance(balances, tornId) {
  if (!balances || !balances.members) return null;
  const member = balances.members.find((m) => m.id === tornId);
  return member ? member.money : null;
}

async function parseAmountWithMistral(message, balance) {
  try {
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: "mistral-small-latest",
        messages: [
          {
            role: "system",
            content: `You are a money amount parser for a game faction bank. The player's current balance is $${balance}.
Extract the withdrawal amount from the player's message. Rules:
- "20mil" or "20m" = 20000000
- "5k" = 5000
- "1.5m" = 1500000
- "72,979,001" = 72979001
- "all", "everything", "tout", "whole", "max", "the lot", "kit n kaboodle", "all of it" = ${balance} (full balance)
- If unclear or no amount found, respond with 0
Respond with ONLY the number, nothing else. No text, no dollar sign, no commas. Just the integer.`,
          },
          {
            role: "user",
            content: message,
          },
        ],
        max_tokens: 50,
        temperature: 0,
      }),
    });

    const data = await response.json();
    const result = data.choices?.[0]?.message?.content?.trim();
    const amount = parseInt(result, 10);
    return isNaN(amount) ? 0 : amount;
  } catch (error) {
    console.error("❌ Mistral API error:", error.message);
    return 0;
  }
}

function extractTornIdFromNickname(nickname) {
  const match = nickname.match(/\[(\d+)\]/);
  return match ? parseInt(match[1], 10) : null;
}

function extractTornNameFromNickname(nickname) {
  const match = nickname.match(/^(.+?)\s*\[/);
  return match ? match[1].trim() : nickname;
}

function formatMoney(amount) {
  return "$" + amount.toLocaleString("en-US");
}

// Track processed tickets to avoid duplicates
const processedTickets = new Set();

client.once("ready", () => {
  console.log(`✅ Banker Bot connected as ${client.user.tag}`);
  console.log(`📂 Watching category: ${BANK_CATEGORY_ID}\n`);
});

client.on("messageCreate", async (message) => {
  // ONLY respond to Ticket Tool's welcome message, nothing else
  if (!message.author.bot) return;
  if (message.author.id === client.user.id) return;

  // Only process messages in Bank Requests category
  const channel = message.channel;
  if (!channel.parentId || channel.parentId !== BANK_CATEGORY_ID) return;
  if (!channel.name.startsWith("ticket-")) return;

  // Ignore old messages (only process messages from the last 30 seconds)
  const messageAge = Date.now() - message.createdTimestamp;
  if (messageAge > 30000) return;

  // Don't process same ticket twice
  if (processedTickets.has(channel.id)) return;

  // Extract user mention from all available text
  const content = message.content || "";
  const embedDescription = message.embeds?.[0]?.description || "";
  const fullText = content + " " + embedDescription;

  // Find mentioned user
  const mentionMatch = fullText.match(/<@!?(\d+)>/);
  if (!mentionMatch) return;

  const discordUserId = mentionMatch[1];
  processedTickets.add(channel.id);

  console.log(`🎫 New ticket: ${channel.name} | User: ${discordUserId}`);

  // Extract the amount from the ticket message (usually in quotes)
  const amountMatch = fullText.match(/"([^"]+)"/);
  if (amountMatch) {
    console.log(`   💰 Amount text: "${amountMatch[1]}"`);
    await processWithdrawal(channel, discordUserId, { content: amountMatch[1] });
  } else {
    // No amount in the ticket message, just show balance
    await processWithdrawal(channel, discordUserId, { content: "" });
  }
});

async function processWithdrawal(channel, discordUserId, userMessage) {
  try {
    // Get the member's nickname to extract Torn ID
    const guild = channel.guild;
    let member;
    try {
      member = await guild.members.fetch(discordUserId);
    } catch (e) {
      console.error(`❌ Could not fetch member ${discordUserId}`);
      return;
    }

    const nickname = member.nickname || member.user.username;
    const tornId = extractTornIdFromNickname(nickname);
    const tornName = extractTornNameFromNickname(nickname);

    if (!tornId) {
      await channel.send(
        `⚠️ Could not find Torn ID for <@${discordUserId}>. Make sure your server nickname is set to \`YourName [TornID]\`.`
      );
      return;
    }

    console.log(`🔍 Processing withdrawal for ${tornName} [${tornId}]`);

    // Get faction balances
    const balances = await getFactionBalances();
    if (!balances) {
      await channel.send("❌ Could not fetch faction bank data. Please try again later.");
      return;
    }

    const balance = getMemberBalance(balances, tornId);
    if (balance === null) {
      await channel.send(`❌ Could not find **${tornName}** [${tornId}] in the faction bank.`);
      return;
    }

    if (balance === 0) {
      await channel.send(
        `🏦 **Bank Request — ${tornName}** [${tornId}]\n\n` +
        `💰 Balance: ${formatMoney(0)}\n\n` +
        `❌ No funds available to withdraw.`
      );
      return;
    }

    // Parse amount with Mistral
    const requestedAmount = await parseAmountWithMistral(userMessage.content, balance);

    if (requestedAmount <= 0) {
      // Could not parse amount, show balance and ask to clarify
      await channel.send(
        `🏦 **Bank Request — ${tornName}** [${tornId}]\n\n` +
        `💰 Balance: **${formatMoney(balance)}**\n\n` +
        `❓ Could not determine the withdrawal amount. Please specify a clear amount (e.g. "20mil", "all", "$5,000,000").`
      );
      return;
    }

    const finalAmount = Math.min(requestedAmount, balance);

    // Build the Torn link
    const tornLink = `https://www.torn.com/factions.php?step=your#/tab=controls&giveMoneyTo=${tornId}&money=${finalAmount}`;

    const responseMessage =
      `🏦 **Bank Request — ${tornName}** [${tornId}]\n\n` +
      `💰 Balance: **${formatMoney(balance)}**\n` +
      `💸 Requested: **${formatMoney(finalAmount)}**` +
      (finalAmount < requestedAmount ? ` _(capped to balance)_` : ``) +
      `\n\n` +
      `🔗 **[Click here to send payment](${tornLink})**`;

    await channel.send(responseMessage);
    console.log(`✅ Processed: ${tornName} wants ${formatMoney(finalAmount)} (balance: ${formatMoney(balance)})`);
  } catch (error) {
    console.error(`❌ Error processing withdrawal:`, error.message);
    await channel.send("❌ An error occurred while processing this request. Please try again.");
  }
}

// Cleanup old tickets from memory every hour
setInterval(() => {
  if (processedTickets.size > 500) {
    processedTickets.clear();
    console.log("🧹 Cleared processed tickets cache");
  }
}, 60 * 60 * 1000);

// Global error handling
process.on("uncaughtException", (error) => {
  console.error("❌ Unhandled error:", error);
});

process.on("unhandledRejection", (error) => {
  console.error("❌ Unhandled rejection:", error);
});

// Login
client.login(process.env.DISCORD_TOKEN);
