import { describe, expect, it } from 'vitest';
import { App } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions } from '@openai/mcp-extensions/app';
import { OpenAIUiToolMetadataSchema } from '@openai/mcp-extensions/server';

/** Local SDK contract tests; these do not certify a live ChatGPT host. */
describe('MCP extension SDK compatibility', () => {
  it('constructs the standard app and its optional OpenAI extension', () => {
    const app = new App({ name: 'Synthetic task panel', version: '0.1.0' }, {});
    expect(new OpenAIExtensions(app)).toBeInstanceOf(OpenAIExtensions);
  });

  it('accepts global sidebar and conversation panel entrypoints', () => {
    const parsed = OpenAIUiToolMetadataSchema.parse({
      entrypoints: [{ type: 'global' }, { type: 'thread' }],
    });
    expect(parsed.entrypoints?.map((entry) => entry.type)).toEqual(['global', 'thread']);
  });

  it('rejects an invented entrypoint instead of silently advertising it', () => {
    expect(OpenAIUiToolMetadataSchema.safeParse({
      entrypoints: [{ type: 'unknown-surface' }],
    }).success).toBe(false);
  });
});
