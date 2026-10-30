import { afterEach, describe, expect, it, vi } from "vitest";

import { callModelWithTools, ModelError } from "@/server/agents/provider.server";

function reply(message: Record<string, unknown>) {
  return {
    ok: true,
    async json() {
      return {
        model: "gpt-4o-mini",
        choices: [{ message }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    },
  };
}

function toolCall(name: string, args: string, id = "call_1") {
  return {
    id,
    type: "function",
    function: { name, arguments: args },
  };
}

const tools = [
  {
    name: "search",
    description: "Search",
    parameters: { type: "object", properties: { q: { type: "string" } } },
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("model tool loop", () => {
  it("sends a tool result back and returns the final JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reply({ content: null, tool_calls: [toolCall("search", '{"q":"acme"}')] }),
      )
      .mockResolvedValueOnce(reply({ content: '{"answer":"found"}' }));
    vi.stubGlobal("fetch", fetchMock);

    const replyPayload = await callModelWithTools({
      model: "gpt-4o-mini",
      system: "system",
      user: "user",
      temperature: 0,
      maxTokens: 200,
      timeoutMs: 5_000,
      tools,
      maxToolCalls: 4,
      execute: async () => ({ ok: true, summary: "one match", result: { id: "v1" } }),
    });

    expect(replyPayload.json).toEqual({ answer: "found" });
    expect(replyPayload.calls).toEqual([{ name: "search", ok: true, summary: "one match" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    const toolMessage = secondBody.messages.find(
      (message: { role: string }) => message.role === "tool",
    );
    expect(JSON.parse(toolMessage.content)).toMatchObject({
      ok: true,
      summary: "one match",
      result: { id: "v1" },
    });
  });

  it("keeps a trimmed tool result as valid JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply({ content: null, tool_calls: [toolCall("search", "{}")] }))
      .mockResolvedValueOnce(reply({ content: '{"answer":"done"}' }));
    vi.stubGlobal("fetch", fetchMock);

    await callModelWithTools({
      model: "gpt-4o-mini",
      system: "system",
      user: "user",
      temperature: 0,
      maxTokens: 200,
      timeoutMs: 5_000,
      tools,
      maxToolCalls: 4,
      execute: async () => ({ ok: true, summary: "big", result: { blob: "x".repeat(20_000) } }),
    });

    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    const toolMessage = secondBody.messages.find(
      (message: { role: string }) => message.role === "tool",
    );
    const parsed = JSON.parse(toolMessage.content) as {
      result: { truncated: boolean; note: string };
    };
    expect(parsed.result.truncated).toBe(true);
    expect(parsed.result.note).toContain("trimmed");
  });

  it("stops when the tool call limit is reached", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(reply({ content: null, tool_calls: [toolCall("search", "{}")] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callModelWithTools({
        model: "gpt-4o-mini",
        system: "system",
        user: "user",
        temperature: 0,
        maxTokens: 200,
        timeoutMs: 5_000,
        tools,
        maxToolCalls: 1,
        execute: async () => ({ ok: true, summary: "one", result: {} }),
      }),
    ).rejects.toBeInstanceOf(ModelError);
  });
});
