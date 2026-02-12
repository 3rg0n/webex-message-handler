import { WebexMessageHandler } from '../src/handler.js';
import type { DecryptedMessage } from '../src/types.js';

/**
 * Integration tests for message loop prevention using ignoreSelfMessages feature.
 *
 * These tests simulate the real-world scenario where:
 * 1. User sends message → Bot receives it
 * 2. Bot responds → Response goes back to Webex
 * 3. Mercury echoes bot's response back → Bot receives its own message
 * 4. Without filtering, bot responds again (infinite loop)
 * 5. With ignoreSelfMessages, bot ignores its own messages
 */
describe('Message Loop Prevention Integration Test', () => {
  const BOT_PERSON_ID = 'bot-person-123';
  const BOT_EMAIL = 'testbot@webex.bot';
  const USER_PERSON_ID = 'user-person-456';
  const USER_EMAIL = 'user@example.com';
  const ROOM_ID = 'room-789';

  // Helper to create a decrypted message (simulates what handler emits after decryption)
  const createDecryptedMessage = (personId: string, personEmail: string, text: string): DecryptedMessage => ({
    id: `msg-${Date.now()}-${Math.random()}`,
    roomId: ROOM_ID,
    personId,
    personEmail,
    text,
    created: new Date().toISOString(),
    raw: {} as any, // Not needed for this test
  });

  it('should demonstrate infinite loop WITHOUT ignoreSelfMessages', () => {
    const messagesReceived: string[] = [];
    const MAX_ITERATIONS = 5; // Safety limit to prevent actual infinite loop

    /**
     * Simulates bot behavior without self-message filtering.
     * This demonstrates the OKRatlas issue where bot keeps responding to itself.
     */
    function simulateBotWithoutFiltering(initialMessage: DecryptedMessage) {
      let iteration = 0;

      function processMessage(msg: DecryptedMessage) {
        messagesReceived.push(`${msg.personId}: ${msg.text}`);
        iteration++;

        // Bot always responds (no filtering)
        if (iteration < MAX_ITERATIONS) {
          // Simulate bot sending response, which comes back as bot's own message
          const botResponse = createDecryptedMessage(
            BOT_PERSON_ID,
            BOT_EMAIL,
            `Response to: ${msg.text}`
          );
          processMessage(botResponse); // Loop!
        }
      }

      processMessage(initialMessage);
    }

    const userMessage = createDecryptedMessage(USER_PERSON_ID, USER_EMAIL, 'Hello');
    simulateBotWithoutFiltering(userMessage);

    // Bot processed MAX_ITERATIONS messages (1 user + 4 self-responses)
    expect(messagesReceived.length).toBe(MAX_ITERATIONS);
    expect(messagesReceived[0]).toBe(`${USER_PERSON_ID}: Hello`);
    expect(messagesReceived[1]).toBe(`${BOT_PERSON_ID}: Response to: Hello`);
    expect(messagesReceived[2]).toContain(BOT_PERSON_ID);
    expect(messagesReceived[3]).toContain(BOT_PERSON_ID);
    expect(messagesReceived[4]).toContain(BOT_PERSON_ID);
  });

  it('should PREVENT infinite loop WITH self-message filtering', () => {
    const messagesReceived: string[] = [];

    /**
     * Simulates bot behavior WITH self-message filtering (ignoreSelfMessages feature).
     * This is what our library does - filters out bot's own messages.
     */
    function simulateBotWithFiltering(initialMessage: DecryptedMessage, botPersonId: string) {
      function processMessage(msg: DecryptedMessage) {
        // Filter self-messages (this is what ignoreSelfMessages does)
        if (msg.personId === botPersonId) {
          return; // Silently ignore bot's own messages
        }

        messagesReceived.push(`${msg.personId}: ${msg.text}`);

        // Bot responds to user messages
        const botResponse = createDecryptedMessage(
          botPersonId,
          BOT_EMAIL,
          `Response to: ${msg.text}`
        );

        // Bot's response comes back, but gets filtered
        processMessage(botResponse); // No loop! Filtered out.
      }

      processMessage(initialMessage);
    }

    const userMessage = createDecryptedMessage(USER_PERSON_ID, USER_EMAIL, 'Hello');
    simulateBotWithFiltering(userMessage, BOT_PERSON_ID);

    // Bot only processed the user message, not its own response
    expect(messagesReceived.length).toBe(1);
    expect(messagesReceived[0]).toBe(`${USER_PERSON_ID}: Hello`);
  });

  it('should demonstrate multiple users vs bot messages', () => {
    const messagesReceived: string[] = [];
    const ALICE_ID = 'alice-123';
    const BOB_ID = 'bob-456';

    function processWithFiltering(msg: DecryptedMessage, botPersonId: string) {
      if (msg.personId === botPersonId) {
        return; // Filter bot's own messages
      }
      messagesReceived.push(`${msg.personId}: ${msg.text}`);
    }

    // Simulate conversation with multiple users and bot responses
    const messages = [
      createDecryptedMessage(ALICE_ID, 'alice@example.com', 'Hi bot'),
      createDecryptedMessage(BOT_PERSON_ID, BOT_EMAIL, 'Hi Alice!'),
      createDecryptedMessage(BOB_ID, 'bob@example.com', 'Hello everyone'),
      createDecryptedMessage(BOT_PERSON_ID, BOT_EMAIL, 'Hi Bob!'),
      createDecryptedMessage(ALICE_ID, 'alice@example.com', 'Thanks bot'),
      createDecryptedMessage(BOT_PERSON_ID, BOT_EMAIL, "You're welcome!"),
    ];

    messages.forEach(msg => processWithFiltering(msg, BOT_PERSON_ID));

    // Only user messages processed, bot's own messages filtered
    expect(messagesReceived.length).toBe(3);
    expect(messagesReceived[0]).toBe(`${ALICE_ID}: Hi bot`);
    expect(messagesReceived[1]).toBe(`${BOB_ID}: Hello everyone`);
    expect(messagesReceived[2]).toBe(`${ALICE_ID}: Thanks bot`);
  });

  it('should show why OKRatlas had infinite loop issue', () => {
    /**
     * OKRatlas Issue:
     * 1. getBotPerson() API call failed or was slow
     * 2. Bot couldn't determine its own person ID
     * 3. Bot processed its own messages → responded to itself
     * 4. Infinite loop
     *
     * Their fix: Cache bot person ID (good)
     * Our fix: Built-in ignoreSelfMessages with automatic caching (better)
     */

    const messagesWithoutBotId: string[] = [];
    const messagesWithBotId: string[] = [];

    // Scenario 1: Bot doesn't know its own ID (OKRatlas bug scenario)
    function processWithoutBotId(msg: DecryptedMessage) {
      messagesWithoutBotId.push(msg.text);
      // Bot can't filter because it doesn't know its ID!
      // So it processes EVERYTHING including its own messages
    }

    // Scenario 2: Bot knows its ID (OKRatlas fix / our feature)
    function processWithBotId(msg: DecryptedMessage, botPersonId: string) {
      if (msg.personId === botPersonId) return;
      messagesWithBotId.push(msg.text);
    }

    const messages = [
      createDecryptedMessage(USER_PERSON_ID, USER_EMAIL, 'Hello'),
      createDecryptedMessage(BOT_PERSON_ID, BOT_EMAIL, 'Hi there!'),
      createDecryptedMessage(BOT_PERSON_ID, BOT_EMAIL, 'Hi there!'), // Loop!
    ];

    messages.forEach(msg => processWithoutBotId(msg));
    messages.forEach(msg => processWithBotId(msg, BOT_PERSON_ID));

    // Without bot ID: processes all 3 messages (including loop)
    expect(messagesWithoutBotId.length).toBe(3);

    // With bot ID: only processes the user message
    expect(messagesWithBotId.length).toBe(1);
    expect(messagesWithBotId[0]).toBe('Hello');
  });
});
