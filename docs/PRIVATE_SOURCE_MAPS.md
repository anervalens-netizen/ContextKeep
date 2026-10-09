# Private release source maps

The web build emits hidden maps for the frontend and embedded MCP widget, then moves them outside the served tree into `artifacts/private-source-maps`. The manifest records release identity and SHA-256 hashes of each script and map. Set `VITE_RELEASE` to the exact source commit when producing a deployment artifact.

The compiler-generated Rolldown runtime has an identity map to its own generated text and is listed in `generatedSources`. Application maps preserve original sources. The widget uses the stable stack-frame URL `app:///mcp/widget.js`.

Deployment must keep this private directory separate from `apps/web/dist`, upload each relative script/map path to the configured private receiver exactly once, and verify a received frontend frame and widget frame against their original source before activation. A CLI success or uploaded file count alone is insufficient. Persist an upload-attempt receipt before sending; inspect uncertain attempts rather than repeating them. Keep private credentials and deployment endpoints outside this public repository.

Archive the same manifest and private maps with the release recovery artifact. Never serve or publish the private directory. Retain the preceding release for rollback.
