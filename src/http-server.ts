#!/usr/bin/env node

import { createServer, IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { TwentyClient } from './client/twenty-client.js';
import { registerPersonTools, registerCompanyTools, registerTaskTools, registerOpportunityTools, registerActivityTools, registerMetadataTools, registerRelationshipTools } from './tools/index.js';
import { WellKnownRoutes } from './routes/well-known.js';
import { AuthMiddleware, AuthenticatedRequest } from './auth/middleware.js';
import { TokenValidator } from './auth/token-validator.js';
import { ClerkClient } from './auth/clerk-client.js';
import { getKeyStorageService } from './auth/key-storage.js';
import { ApiKeyRoutes } from './routes/api-keys.js';
import { IPMiddleware } from './auth/ip-middleware.js';

async function main() {
  const port = parseInt(process.env.PORT || '3000');
  const authEnabled = process.env.AUTH_ENABLED === 'true';
  const wellKnownRoutes = new WellKnownRoutes();
  const ipMiddleware = new IPMiddleware();

  // Initialize auth components only if auth is enabled
  let clerkClient: ClerkClient | null = null;
  let tokenValidator: TokenValidator | null = null;
  let authMiddleware: AuthMiddleware | null = null;
  let keyStorage: any = null;
  let apiKeyRoutes: ApiKeyRoutes | null = null;

  if (authEnabled) {
    clerkClient = new ClerkClient();
    tokenValidator = new TokenValidator(clerkClient);
    authMiddleware = new AuthMiddleware(tokenValidator);
    keyStorage = getKeyStorageService();
    apiKeyRoutes = new ApiKeyRoutes();
  }

  // Parse configuration from multiple sources
  async function parseConfig(url: string, userId?: string) {
    const urlObj = new URL(url, `http://localhost:${port}`);
    const params = urlObj.searchParams;

    // Check for user-specific stored API key first
    let apiKey = params.get('apiKey');
    let baseUrl = params.get('baseUrl');

    if (authEnabled && userId && !apiKey && keyStorage) {
      const storedKey = await keyStorage.getApiKey(userId);
      if (storedKey) {
        apiKey = storedKey.twentyApiKey;
        baseUrl = storedKey.twentyBaseUrl || baseUrl;
      }
    }

    // Priority: URL params > User stored key > Environment variables > Smithery config
    return {
      apiKey: apiKey ||
              process.env.TWENTY_API_KEY ||
              process.env.SMITHERY_CONFIG_APIKEY ||
              process.env.apiKey,
      baseUrl: baseUrl ||
               process.env.TWENTY_BASE_URL ||
               process.env.SMITHERY_CONFIG_BASEURL ||
               process.env.baseUrl ||
               'https://api.twenty.com',
    };
  }

  // Session management: map session IDs to their transports and last-active time
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const sessionLastActive = new Map<string, number>();
  const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  const rawTimeout = (process.env.SESSION_TIMEOUT_MS ?? '').trim();
  const parsedTimeout = /^\d+$/.test(rawTimeout) ? Number.parseInt(rawTimeout, 10) : NaN;
  const SESSION_TIMEOUT_MS = Number.isSafeInteger(parsedTimeout) && parsedTimeout > 0
    ? parsedTimeout
    : DEFAULT_SESSION_TIMEOUT_MS;
  if (rawTimeout !== '' && SESSION_TIMEOUT_MS === DEFAULT_SESSION_TIMEOUT_MS && rawTimeout !== String(DEFAULT_SESSION_TIMEOUT_MS)) {
    console.warn(`Ignoring invalid SESSION_TIMEOUT_MS="${rawTimeout}" — using default ${DEFAULT_SESSION_TIMEOUT_MS}ms`);
  }
  console.log(`Session timeout: ${SESSION_TIMEOUT_MS}ms (${Math.round(SESSION_TIMEOUT_MS / 60000)} min)`);

  // Periodic cleanup of stale sessions
  setInterval(() => {
    const now = Date.now();
    for (const [sid, lastActive] of sessionLastActive) {
      if (now - lastActive > SESSION_TIMEOUT_MS) {
        const transport = sessions.get(sid);
        if (transport) {
          transport.close?.();
        }
        sessions.delete(sid);
        sessionLastActive.delete(sid);
        console.log(`Evicted idle session ${sid} (idle ${Math.round((now - lastActive) / 60000)} min)`);
      }
    }
  }, 5 * 60 * 1000); // Check every 5 minutes

  // Create a new MCP session with server and transport
  async function createSession(
    config: { apiKey: string; baseUrl?: string },
    sessionIdGenerator: () => string = () => randomUUID()
  ): Promise<StreamableHTTPServerTransport> {
    const server = new McpServer({
      name: 'twenty-mcp-server',
      version: '1.0.0',
    }, {
      capabilities: {
        tools: {},
        experimental: {
          authentication: {
            type: 'oauth2',
            required: authEnabled && process.env.REQUIRE_AUTH === 'true',
            enabled: authEnabled,
            discoveryEndpoints: authEnabled ? {
              protectedResource: '/.well-known/oauth-protected-resource',
              authorizationServer: '/.well-known/oauth-authorization-server'
            } : undefined
          }
        }
      }
    });

    const client = new TwentyClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    });

    registerPersonTools(server, client);
    registerCompanyTools(server, client);
    registerTaskTools(server, client);
    registerOpportunityTools(server, client);
    registerActivityTools(server, client);
    registerMetadataTools(server, client);
    registerRelationshipTools(server, client);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator,
    });

    // Clean up session when transport closes
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
        sessionLastActive.delete(sid);
      }
    };

    await server.connect(transport);

    return transport;
  }

  // Resurrect an unknown session ID as a live session.
  //
  // Some MCP gateways do not re-initialise
  // their upstream session when this server answers 404 + -32000 "Session not
  // found" — they keep retrying the dead session ID forever, which surfaces to
  // the end client as the connector dying mid-conversation after idle eviction
  // or a container restart. Sessions on this server are interchangeable for a
  // given config (same API key, same toolset), so instead of rejecting an
  // unknown session ID we can transparently revive it: build a fresh transport
  // pinned to the presented ID and drive a synthetic initialize handshake
  // through it in-process. Returns null if resurrection isn't possible, in
  // which case the caller falls back to the 404 response.
  async function resurrectSession(
    config: { apiKey: string; baseUrl?: string },
    sessionId: string
  ): Promise<StreamableHTTPServerTransport | null> {
    const transport = await createSession(config, () => sessionId);

    // The Node transport wraps a web-standard transport whose handleRequest
    // accepts a fetch Request — that lets us run a real initialize handshake
    // without fabricating Node req/res objects. Guard against SDK internals
    // changing shape so a future upgrade degrades to the old 404 behaviour
    // instead of crashing.
    const inner = (transport as unknown as {
      _webStandardTransport?: { handleRequest?: (req: Request) => Promise<Response> };
    })._webStandardTransport;
    if (!inner || typeof inner.handleRequest !== 'function') {
      console.error('Session resurrection unavailable: SDK internals changed (_webStandardTransport.handleRequest missing)');
      await transport.close?.();
      return null;
    }

    try {
      const initResponse = await inner.handleRequest(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `resurrect-${sessionId}`,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'twenty-mcp-session-resurrector', version: '1.0.0' },
          },
        }),
      }));

      // Drain the response (SSE stream closes once the InitializeResult is
      // sent) so the server finishes processing the handshake. Time-bound so
      // an SDK behaviour change can't wedge the request path.
      const drained = await Promise.race([
        initResponse.text().then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 2000)),
      ]);

      if (!initResponse.ok || !drained || transport.sessionId !== sessionId) {
        console.error(`Session resurrection failed for ${sessionId}: status=${initResponse.status} drained=${drained} sessionId=${transport.sessionId}`);
        await transport.close?.();
        return null;
      }
    } catch (error) {
      console.error(`Session resurrection failed for ${sessionId}:`, error);
      await transport.close?.();
      return null;
    }

    console.log(`Resurrected session ${sessionId}`);
    return transport;
  }

  // Parse request body helper
  function readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const bodyText = Buffer.concat(chunks).toString();
          resolve(bodyText.trim() ? JSON.parse(bodyText) : undefined);
        } catch (error) {
          reject(error);
        }
      });
      req.on('error', reject);
    });
  }

  // Create HTTP server
  const httpServer = createServer(async (req, res) => {
    // Check IP allowlist first (before any other processing)
    if (!await ipMiddleware.checkAccess(req, res)) {
      return;
    }

    // Handle CORS preflight requests
    if (req.method === 'OPTIONS') {
      await wellKnownRoutes.handleOptions(req, res);
      return;
    }

    // Handle health check endpoint
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'healthy',
        service: 'twenty-mcp-server',
        authEnabled,
        ipProtection: ipMiddleware.getConfig().enabled,
        activeSessions: sessions.size
      }));
      return;
    }

    // Handle API key management endpoints
    if (req.url?.startsWith('/api/keys')) {
      if (!authEnabled || !authMiddleware || !apiKeyRoutes) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      const authReq = req as AuthenticatedRequest;
      if (!await authMiddleware.authenticate(authReq, res)) {
        return;
      }
      await apiKeyRoutes.handle(authReq, res);
      return;
    }

    // Handle OAuth discovery endpoints
    if (req.url === '/.well-known/oauth-protected-resource') {
      if (!authEnabled) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      await wellKnownRoutes.handleProtectedResource(req, res);
      return;
    }

    if (req.url === '/.well-known/oauth-authorization-server') {
      if (!authEnabled) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      await wellKnownRoutes.handleAuthorizationServer(req, res);
      return;
    }

    // Only handle /mcp endpoint
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    try {
      // Authenticate request if auth is enabled
      const authReq = req as AuthenticatedRequest;
      if (authEnabled && authMiddleware) {
        if (!await authMiddleware.authenticate(authReq, res)) {
          return;
        }
      }

      // Check for existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const body = req.method === 'POST' ? await readBody(req) : undefined;

      if (sessionId && sessions.has(sessionId)) {
        // Existing session — route to stored transport
        const transport = sessions.get(sessionId)!;
        sessionLastActive.set(sessionId, Date.now());
        if (req.method === 'POST') {
          await transport.handleRequest(req, res, body);
        } else {
          // GET (SSE notification stream) and DELETE requests
          await transport.handleRequest(req, res);
        }
        return;
      }

      // Unknown session ID. If the request is itself an initialize (a client
      // starting fresh while still sending a stale header), let it fall
      // through to the new-session path below, which mints a fresh ID.
      // Anything else gets an in-place resurrection — see resurrectSession
      // for why we don't just 404.
      const wantsInitialize = Array.isArray(body)
        ? body.some(isInitializeRequest)
        : isInitializeRequest(body);

      if (sessionId && !wantsInitialize) {
        const config = await parseConfig(req.url, authReq.auth?.userId);
        const transport = config.apiKey
          ? await resurrectSession({ apiKey: config.apiKey, baseUrl: config.baseUrl }, sessionId)
          : null;

        if (!transport) {
          // Resurrection not possible — tell the client to re-initialize
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Session not found. Please re-initialize.' },
            id: null
          }));
          return;
        }

        sessions.set(sessionId, transport);
        sessionLastActive.set(sessionId, Date.now());
        if (req.method === 'POST') {
          await transport.handleRequest(req, res, body);
        } else {
          await transport.handleRequest(req, res);
        }
        return;
      }

      // New session — need config and API key
      const userId = authReq.auth?.userId;
      const config = await parseConfig(req.url, userId);

      if (!config.apiKey) {
        if (authEnabled && userId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'No API key configured',
            error_description: 'Please configure your Twenty API key first'
          }));
          return;
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Missing required apiKey parameter'
        }));
        return;
      }

      // Create new session and handle the initialize request
      const transport = await createSession({ apiKey: config.apiKey!, baseUrl: config.baseUrl });

      if (req.method === 'POST') {
        await transport.handleRequest(req, res, body);
      } else {
        await transport.handleRequest(req, res);
      }

      // Store session after handling (sessionId is set during initialize)
      if (transport.sessionId) {
        sessions.set(transport.sessionId, transport);
        sessionLastActive.set(transport.sessionId, Date.now());
      }
    } catch (error) {
      console.error('Error handling request:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Internal server error',
          message: error instanceof Error ? error.message : 'Unknown error'
        }));
      }
    }
  });

  httpServer.listen(port, () => {
    console.log(`Twenty MCP Server running at http://localhost:${port}/mcp`);
    console.log(`Health check available at http://localhost:${port}/health`);

    // Log configuration source for debugging
    if (process.env.SMITHERY_CONFIG_APIKEY) {
      console.log('Running in Smithery environment');
    } else if (process.env.TWENTY_API_KEY) {
      console.log('Using environment variables for configuration');
    } else {
      console.log(`Example: http://localhost:${port}/mcp?apiKey=YOUR_API_KEY&baseUrl=https://api.twenty.com`);
    }
  });
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
