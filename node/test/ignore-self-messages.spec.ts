import { WebexMessageHandler } from '../src/handler.js';

describe('ignoreSelfMessages feature', () => {
  it('should accept ignoreSelfMessages config option', () => {
    expect(() => {
      new WebexMessageHandler({
        token: 'test-token',
        ignoreSelfMessages: true,
      });
    }).not.toThrow();
  });

  it('should default ignoreSelfMessages to true', () => {
    const handler = new WebexMessageHandler({
      token: 'test-token',
    });

    expect(handler).toBeDefined();
    expect(handler['ignoreSelfMessages']).toBe(true);
  });

  it('should allow opting out with ignoreSelfMessages: false', () => {
    const handler = new WebexMessageHandler({
      token: 'test-token',
      ignoreSelfMessages: false,
    });

    expect(handler).toBeDefined();
    expect(handler['ignoreSelfMessages']).toBe(false);
  });

  it('should work with ignoreSelfMessages enabled', () => {
    const handler = new WebexMessageHandler({
      token: 'test-token',
      ignoreSelfMessages: true,
    });

    expect(handler).toBeDefined();
  });

  it('should work with both native mode and ignoreSelfMessages', () => {
    expect(() => {
      new WebexMessageHandler({
        token: 'test-token',
        mode: 'native',
        ignoreSelfMessages: true,
      });
    }).not.toThrow();
  });

  it('should work with both injected mode and ignoreSelfMessages', () => {
    const mockFetch = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: jest.fn().mockResolvedValue({}),
      text: jest.fn().mockResolvedValue(''),
    });

    const mockWsFactory = jest.fn().mockReturnValue({
      send: jest.fn(),
      close: jest.fn(),
      readyState: 1,
      on: jest.fn(),
    });

    expect(() => {
      new WebexMessageHandler({
        token: 'test-token',
        mode: 'injected',
        fetch: mockFetch,
        webSocketFactory: mockWsFactory,
        ignoreSelfMessages: true,
      });
    }).not.toThrow();
  });
});
