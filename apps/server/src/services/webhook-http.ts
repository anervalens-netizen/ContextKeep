import https from "node:https";
import dns from "node:dns";
import { BlockList, isIP } from "node:net";
const blocked = new BlockList(),
  blocked6 = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked6.addSubnet(ip, bits, "ipv6");
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  return !(family === 4
    ? blocked.check(address, "ipv4")
    : blocked6.check(address, "ipv6"));
}
export function callbackUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("invalid_callback");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) && !publicAddress(hostname))
    throw new Error("non_public_callback");
  return url;
}
export type WebhookPost = (
  url: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
) => Promise<{ status: number; body: string }>;
/** DNS validation happens inside connection lookup. No second DNS lookup, redirects or unbounded bodies. */
export const webhookPost: WebhookPost = async (
  value,
  headers,
  body,
  signal,
) => {
  const url = callbackUrl(value);
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          ...headers,
          "content-length": String(Buffer.byteLength(body)),
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
        lookup: (hostname, options, callback) => {
          dns.lookup(hostname, { all: true }, (error, addresses) => {
            if (error) {
              callback(error, "", 4);
              return;
            }
            if (
              !addresses.length ||
              addresses.some((a) => !publicAddress(a.address))
            ) {
              callback(new Error("non_public_callback"), "", 4);
              return;
            }
            if (options.all)
              (
                callback as unknown as (
                  err: null,
                  items: Array<{ address: string; family: number }>,
                ) => void
              )(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
          });
        },
      },
      (res) => {
        let response = "",
          bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 65536) {
            res.destroy(new Error("response_too_large"));
            return;
          }
          response += chunk.toString("utf8");
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: response }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
};
