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

TYPOS & SPACING: Players often have typos, extra spaces, or broken words. Strip spaces within the number+suffix and parse the intended amount. Examples:
- Broken suffixes: "15mi l" / "15 mil" / "15 mi" / "2b il" / "20k k" = treat as "15mil" / "15mil" / "15mi" / "2bil" / "20kk"
- "mi" alone means million: "15mi" = 15000000
- Double letters: "mill" / "15mill" = million, "bill" = billion
- Plurals: "15mils" / "20mills" = million
- Glued words: "5kplease" / "20mplz" / "15milthanks" = extract the number+suffix, ignore the rest
- European decimals: "1,5m" = 1500000 (comma as decimal separator when followed by a suffix)

AMOUNTS:
- "20mil" / "20m" / "20M" / "20 million" / "20 millions" / "20 milly" / "20 milli" = 20000000
- "5k" / "5K" = 5000
- "1.5m" = 1500000
- "1b" / "1bil" / "1 billion" = 1000000000
- "20kk" = 20000000 (k * k = million)
- "72,979,001" / "72.979.001" / "72 979 001" / "$72,979,001" = 72979001
- "around 20m" / "about 20m" / "roughly 20m" = 20000000 (ignore approximation words)

ALL / EVERYTHING:
- "all" / "everything" / "tout" / "whole" / "max" / "the lot" / "the rest" / "all of it" = ${balance}
- "empty it" / "clean it out" / "drain it" / "what's left" / "whatever I have" / "as much as possible" = ${balance}

PERCENTAGES:
- "50%" = ${Math.floor(balance * 0.5)}, "100%" = ${balance}, "25%" = ${Math.floor(balance * 0.25)}
- "half" / "a half" / "1/2" = ${Math.floor(balance * 0.5)}
- "a third" / "1/3" = ${Math.floor(balance / 3)}
- "a quarter" / "1/4" / "3/4" = calculate from balance

ALL BUT / LEAVE / EXCEPT:
- "all but 10m" / "everything except 10m" / "leave 10m" / "keep 10m" = ${balance} minus 10000000
- "all but 5mil" = ${balance} minus 5000000
- For these, calculate: balance (${balance}) minus the amount they want to keep

IMPORTANT: Players type fast and make mistakes. Always try your BEST to understand what they mean. Only respond with 0 if there is truly no amount whatsoever in the message. If you can reasonably guess what they meant, go with that guess. Messages may be in any language (English, French, Spanish, etc).
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

// Track processed tickets to avoid duplicates (persisted to file)
const fs = require("fs");
const PROCESSED_FILE = __dirname + "/processed-tickets.json";

function loadProcessedTickets() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf8"));
      return new Set(data);
    }
  } catch (e) {}
  return new Set();
}

function saveProcessedTickets() {
  try {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...processedTickets]));
  } catch (e) {}
}

const processedTickets = loadProcessedTickets();
console.log(`📋 Loaded ${processedTickets.size} processed tickets from disk`);

client.once("ready", () => {
  console.log(`✅ Banker Bot connected as ${client.user.tag}`);
  console.log(`📂 Watching category: ${BANK_CATEGORY_ID}\n`);
});

client.on("messageCreate", async (message) => {
  // Ignore own messages
  if (message.author.id === client.user.id) return;
  // Only respond to bot messages (Ticket Tool)
  if (!message.author.bot) return;

  // Only process messages in Bank Requests category
  const channel = message.channel;
  if (!channel.parentId || channel.parentId !== BANK_CATEGORY_ID) return;
  if (!channel.name.startsWith("ticket-")) return;

  // ATOMIC: Mark ticket as processed IMMEDIATELY (before any async call)
  if (processedTickets.has(channel.id)) return;
  processedTickets.add(channel.id);
  saveProcessedTickets();

  // DOUBLE CHECK: also verify via channel history that we haven't posted
  const recentMessages = await channel.messages.fetch({ limit: 20 });
  if (recentMessages.some((msg) => msg.author.id === client.user.id)) return;

  // Ignore old messages (only process messages from the last 10 seconds)
  const messageAge = Date.now() - message.createdTimestamp;
  if (messageAge > 10000) return;

  // Extract user mention from all available text
  const content = message.content || "";
  const embedDescription = message.embeds?.[0]?.description || "";
  const fullText = content + " " + embedDescription;

  // Only process the welcome message (must contain "Welcome")
  if (!fullText.includes("Welcome")) return;

  // Find mentioned user
  const mentionMatch = fullText.match(/<@!?(\d+)>/);
  if (!mentionMatch) return;

  const discordUserId = mentionMatch[1];

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
