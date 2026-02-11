/**
 * Quick test: Can a bot send a message to another bot?
 *
 * Usage:
 *   WEBEX_BOT_TOKEN=your_token TARGET_BOT_EMAIL=other_bot@webex.bot node test-bot-to-bot.js
 */

const token = process.env.WEBEX_BOT_TOKEN;
const targetEmail = process.env.TARGET_BOT_EMAIL;

if (!token || !targetEmail) {
  console.error('❌ Missing environment variables:');
  console.error('   WEBEX_BOT_TOKEN - your bot token');
  console.error('   TARGET_BOT_EMAIL - another bot email to test with');
  process.exit(1);
}

async function test() {
  console.log('🧪 Testing bot-to-bot messaging...\n');

  // Get current bot identity
  const whoamiRes = await fetch('https://webexapis.com/v1/people/me', {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!whoamiRes.ok) {
    console.error(`❌ Failed to get bot identity: ${whoamiRes.status}`);
    process.exit(1);
  }

  const whoami = await whoamiRes.json();
  console.log(`📤 From: ${whoami.displayName} (${whoami.emails[0]})`);
  console.log(`📥 To: ${targetEmail}\n`);

  // Try to send a message
  const testMessage = `Bot-to-bot test ${Date.now()}`;
  console.log(`💬 Message: "${testMessage}"\n`);

  const sendRes = await fetch('https://webexapis.com/v1/messages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      toPersonEmail: targetEmail,
      text: testMessage
    })
  });

  console.log(`📊 Response: HTTP ${sendRes.status} ${sendRes.statusText}\n`);

  if (sendRes.ok) {
    const msg = await sendRes.json();
    console.log('✅ SUCCESS - Bot-to-bot messaging works!');
    console.log(`   Message ID: ${msg.id}`);
    return true;
  } else {
    const error = await sendRes.text();
    console.log('❌ FAILED - Bot-to-bot messaging blocked');
    console.log(`   Error: ${error}`);
    return false;
  }
}

test().then(success => process.exit(success ? 0 : 1));
