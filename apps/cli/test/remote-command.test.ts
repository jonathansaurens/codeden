import { describe, expect, it } from "vitest";
import { parseRemoteCommand, runRemoteCommand } from "../src/remote-command";

describe("codeden --server … (member tools over HTTP)", () => {
  it("turns a command and its flags into a tool call", () => {
    expect(
      parseRemoteCommand([
        "--server",
        "https://team.example.com/ignored/path",
        "--token",
        "cda_x",
        "list-sessions",
        "--projectId",
        "123",
        "--limit",
        "5",
      ]),
    ).toEqual({
      server: "https://team.example.com",
      token: "cda_x",
      command: "list_sessions",
      // Ids stay text; counts become numbers.
      input: { projectId: "123", limit: 5 },
    });
    expect(
      parseRemoteCommand(
        [
          "--server=http://127.0.0.1:4317",
          "message-session",
          "--sessionId",
          "s1",
          "--text",
          "true",
          "--steer",
        ],
        { CODEDEN_TOKEN: "cda_env" },
      ),
    ).toMatchObject({ token: "cda_env", input: { sessionId: "s1", text: "true", steer: true } });
    expect(
      parseRemoteCommand([
        "--server",
        "http://h",
        "--token",
        "t",
        "answer-question",
        "--json",
        '{"inboxItemId":"i","text":"yes"}',
      ]).input,
    ).toEqual({ inboxItemId: "i", text: "yes" });
  });

  it("explains what is missing", () => {
    expect(() => parseRemoteCommand(["--server", "http://h", "tools"], {})).toThrow(/token/);
    expect(() => parseRemoteCommand(["--server", "ftp://h", "--token", "t", "tools"], {})).toThrow(
      /http/,
    );
    expect(() => parseRemoteCommand(["--server", "http://h", "--token", "t"], {})).toThrow(
      /command/,
    );
  });

  it("posts to /api/member-tools with the bearer token and prints the result", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const out: string[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ result: { ok: 1 } }), { status: 200 });
    }) as typeof fetch;
    const code = await runRemoteCommand(
      [
        "--server",
        "https://team.example.com",
        "--token",
        "cda_x",
        "stop-session",
        "--sessionId",
        "s1",
      ],
      { fetch: fakeFetch, out: (t) => out.push(t), err: () => {} },
    );
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe("https://team.example.com/api/member-tools/stop_session");
    expect(calls[0]?.init?.method).toBe("POST");
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer cda_x");
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ sessionId: "s1" });
    expect(JSON.parse(out[0] as string)).toEqual({ ok: 1 });

    const errors: string[] = [];
    const refused = (async () =>
      new Response(JSON.stringify({ error: { message: "This needs an Operator." } }), {
        status: 403,
      })) as unknown as typeof fetch;
    expect(
      await runRemoteCommand(["--server", "http://h", "--token", "t", "stop-session"], {
        fetch: refused,
        out: () => {},
        err: (t) => errors.push(t),
      }),
    ).toBe(1);
    expect(errors).toEqual(["This needs an Operator."]);
  });
});
