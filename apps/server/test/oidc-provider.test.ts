import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { TEST_PASSWORD } from "./helpers.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const wrongKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const issuer = "https://identity.example/issuer/";
const origin = "https://identity.example";
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("OIDC signed provider responses (real client validation)", () => {
  for (const mode of ["valid", "state", "nonce", "issuer", "audience", "expired", "signature", "subject"]) {
    it(`handles ${mode} without bypassing cryptographic or identity checks`, async () => {
      const dataDir = mkdtempSync(path.join(tmpdir(), "ck-oidc-provider-"));
      let nonce = "";
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes(".well-known/openid-configuration")) return json({ issuer,
          authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks`,
          response_types_supported: ["code"], subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["client_secret_post"],
          code_challenge_methods_supported: ["S256"] });
        if (url === `${origin}/jwks`) return json({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "test", use: "sig", alg: "RS256" }] });
        if (url === `${origin}/token`) {
          const now = Math.floor(Date.now() / 1000);
          const claims = { iss: mode === "issuer" ? "https://other.example/" : issuer,
            aud: mode === "audience" ? "other-client" : "test-client", sub: mode === "subject" ? "another-owner" : "test-owner",
            iat: now, exp: mode === "expired" ? now - 3600 : now + 300, nonce: mode === "nonce" ? "incorrect" : nonce };
          const input = `${encode({ alg: "RS256", kid: "test" })}.${encode(claims)}`;
          const signature = sign("RSA-SHA256", Buffer.from(input), mode === "signature" ? wrongKeys.privateKey : keys.privateKey).toString("base64url");
          return json({ token_type: "Bearer", access_token: "synthetic-access", id_token: `${input}.${signature}` });
        }
        throw new Error("Unexpected provider request");
      });
      const app = await buildApp({ config: loadConfig({ NODE_ENV: "test", CK_DATA_DIR: dataDir,
        CK_SESSION_SECRET: "synthetic-session-secret", CK_OIDC_ISSUER: issuer, CK_OIDC_CLIENT_ID: "test-client",
        CK_OIDC_CLIENT_SECRET: "synthetic-client-secret", CK_OIDC_OWNER_SUBJECT: "test-owner",
        CK_OIDC_CALLBACK_URL: "https://memory.example/api/auth/oidc/callback" }), logger: false });
      try {
        await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: TEST_PASSWORD } });
        const start = await app.inject({ method: "GET", url: "/api/auth/oidc/start" });
        expect(start.statusCode).toBe(302);
        const url = new URL(start.headers.location!);
        nonce = url.searchParams.get("nonce")!;
        const cookie = start.cookies.find(c => c.name === "__Host-ck_oidc")!;
        const response = await app.inject({ method: "GET",
          url: `/api/auth/oidc/callback?code=synthetic-code&state=${mode === "state" ? "wrong-state" : url.searchParams.get("state")}`,
          headers: { cookie: `${cookie.name}=${cookie.value}` } });
        expect(response.statusCode, response.body).toBe(mode === "valid" ? 302 : mode === "subject" ? 403 : 401);
        expect(response.cookies.some(c => c.name === "ck_session")).toBe(mode === "valid");
      } finally { await app.close(); fetchMock.mockRestore(); rmSync(dataDir, { recursive: true, force: true }); }
    });
  }
});
