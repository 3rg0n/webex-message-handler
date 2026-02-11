import { WebexMessageHandler, consoleLogger } from '../src/index.js';

const handler = new WebexMessageHandler({
  token: process.env.WEBEX_BOT_TOKEN!,
  logger: consoleLogger,
});

handler.on('message:created', (msg) => {
  console.log(`[${msg.personEmail}] ${msg.text}`);
  if (msg.html) {
    console.log(`  HTML: ${msg.html}`);
  }
});

handler.on('message:deleted', (data) => {
  console.log(`Message ${data.messageId} deleted by ${data.personId}`);
});

handler.on('connected', () => console.log('Connected to Webex'));
handler.on('disconnected', (reason) => console.log(`Disconnected: ${reason}`));
handler.on('reconnecting', (attempt) => console.log(`Reconnecting (attempt ${attempt})...`));
handler.on('error', (err) => console.error('Error:', err.message));

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await handler.disconnect();
  process.exit(0);
});

handler.connect().catch((err) => {
  console.error('Failed to connect:', err);
  process.exit(1);
});
