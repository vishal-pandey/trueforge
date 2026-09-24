import { OpenAPIHono } from '@hono/zod-openapi';
import {
  AgentSpecSchema,
  Sessions,
  TurnNotFoundError,
  type TurnResourceResolver,
  type TurnStreamingEvent,
} from '@truefoundry/trueforge-core/agent-session';
import type { Kysely } from 'kysely';
import { inspect } from 'node:util';
import { createLogger } from 'winston';
import { createTurnsRouter, turnStreamId } from '../../../src/apis/turns';
import { TrueForgeAuthorizer, type Authorizer } from '../../../src/auth/authorizer';
import { STANDALONE_REQUEST_CONTEXT, type RequestContext } from '../../../src/auth/identity';
import { McpServerWithAuthStore } from '../../../src/db/McpServerWithAuthStore';
import { migrateSqliteToLatest } from '../../../src/db/migrateSqlite';
import { SqliteAgentStore } from '../../../src/db/sqlite/agent-store/SqliteAgentStore';
import { createSqliteDb } from '../../../src/db/sqlite/client';
import { SqliteMcpServerStore } from '../../../src/db/sqlite/mcp-server-store/SqliteMcpServerStore';
import { SqliteModelProviderStore } from '../../../src/db/sqlite/model-provider-store/SqliteModelProviderStore';
import { SqliteSandboxProviderStore } from '../../../src/db/sqlite/sandbox-provider-store/SqliteSandboxProviderStore';
import { SqliteSessionStore } from '../../../src/db/sqlite/session-store/SqliteSessionStore';
import { SqliteSkillStore } from '../../../src/db/sqlite/skill-store/SqliteSkillStore';
import { SqliteOAuthTokenStore } from '../../../src/db/sqlite/token-store/SqliteOAuthTokenStore';
import type { Database } from '../../../src/db/sqlite/types';
import { ActiveTurnRegistry } from '../../../src/runtime/activeTurns';
import { EventSubscriptionRegistry } from '../../../src/runtime/event-subscription/index.js';

/** Standalone identity without the admin role, so session reads follow ownership rules. */
const NON_ADMIN_CONTEXT: RequestContext = { ...STANDALONE_REQUEST_CONTEXT, roles: [] };

function mcpServerStoreWithAuth(db: Kysely<Database>, tokenStore: SqliteOAuthTokenStore) {
  return new McpServerWithAuthStore({
    store: new SqliteMcpServerStore(db),
    tokenStore,
    clientName: 'test-client',
  });
}

describe('turns', () => {
  it('namespaces turn stream ids under tfg', () => {
    expect(turnStreamId('ten', 'sess', 'turn1')).toBe('tfg:agent:turn:ten:sess:turn1:stream');
  });

  describe('turn ownership', () => {
    it('returns 403 for all turn routes when the caller is not the session creator', async () => {
      const db = createSqliteDb(':memory:');
      await migrateSqliteToLatest(db);
      const sessionStore = new SqliteSessionStore(db);
      const sessions = new Sessions({ sessionStore });

      await sessionStore.createSession({
        tenant_id: 'default',
        session_id: 's1',
        created_by_subject: { subject_id: 'someone-else', subject_type: 'user', subject_display_name: 'someone-else' },
        agent: {
          type: 'inline',
          spec: AgentSpecSchema.parse({
            model: { name: 'test-provider/test-model' },
            instructions: 'test',
          }),
        },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });

      const tokenStore = new SqliteOAuthTokenStore(db);
      const app = new OpenAPIHono();
      app.route(
        '/',
        createTurnsRouter({
          sessions,
          sessionStore,
          activeTurns: new ActiveTurnRegistry(),
          resolveModelProviderStore: () => new SqliteModelProviderStore(db),
          resolveMcpServerStore: () => mcpServerStoreWithAuth(db, tokenStore),
          resolveSkillStore: () => new SqliteSkillStore(db),
          resolveAgentStore: () => new SqliteAgentStore(db),
          eventSubscriptions: new EventSubscriptionRegistry(undefined),
          resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
          logger: createLogger({ silent: true }),
          resolveRequestContext: () => NON_ADMIN_CONTEXT,
          authorizer: new TrueForgeAuthorizer(),
        }),
      );

      const forbiddenAccess = { error: { message: 'Only the session creator can access this session' } };

      const createResponse = await app.request('/s1/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: false }),
      });
      expect(createResponse.status).toBe(403);
      expect(await createResponse.json()).toEqual({
        error: { message: 'Only the session creator can create turns' },
      });

      const listResponse = await app.request('/s1/turns');
      expect(listResponse.status).toBe(403);
      expect(await listResponse.json()).toEqual(forbiddenAccess);

      const getResponse = await app.request('/s1/turns/any-turn');
      expect(getResponse.status).toBe(403);
      expect(await getResponse.json()).toEqual(forbiddenAccess);

      const eventsResponse = await app.request('/s1/turns/any-turn/events');
      expect(eventsResponse.status).toBe(403);
      expect(await eventsResponse.json()).toEqual(forbiddenAccess);

      const subscribeResponse = await app.request('/s1/turns/any-turn/subscribe');
      expect(subscribeResponse.status).toBe(403);
      expect(await subscribeResponse.json()).toEqual(forbiddenAccess);

      const downloadResponse = await app.request(
        `/s1/turns/any-turn/download-sandbox-file?path=${encodeURIComponent('/workspace/report.pdf')}`,
      );
      expect(downloadResponse.status).toBe(403);
      expect(await downloadResponse.json()).toEqual(forbiddenAccess);
    });

    it('lets an admin read any session turns but keeps create-turn and sandbox download owner-only', async () => {
      const db = createSqliteDb(':memory:');
      await migrateSqliteToLatest(db);
      const sessionStore = new SqliteSessionStore(db);
      await sessionStore.createSession({
        tenant_id: 'default',
        session_id: 's1',
        created_by_subject: { subject_id: 'someone-else', subject_type: 'user', subject_display_name: 'someone-else' },
        agent: {
          type: 'inline',
          spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
        },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });
      const app = new OpenAPIHono();
      app.route(
        '/',
        createTurnsRouter({
          sessions: new Sessions({ sessionStore }),
          sessionStore,
          activeTurns: new ActiveTurnRegistry(),
          resolveModelProviderStore: () => new SqliteModelProviderStore(db),
          resolveMcpServerStore: () => mcpServerStoreWithAuth(db, new SqliteOAuthTokenStore(db)),
          resolveSkillStore: () => new SqliteSkillStore(db),
          resolveAgentStore: () => new SqliteAgentStore(db),
          eventSubscriptions: new EventSubscriptionRegistry(undefined),
          resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
          logger: createLogger({ silent: true }),
          resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
          authorizer: new TrueForgeAuthorizer(),
        }),
      );

      expect((await app.request('/s1/turns')).status).toBe(200);
      expect((await app.request('/s1/turns/missing')).status).toBe(404);
      expect((await app.request('/s1/turns/missing/events')).status).toBe(404);
      expect((await app.request('/s1/turns/missing/subscribe')).status).toBe(404);
      expect(
        (await app.request(`/s1/turns/missing/download-sandbox-file?path=${encodeURIComponent('/workspace/f.txt')}`))
          .status,
      ).toBe(403);
      expect(
        (
          await app.request('/s1/turns', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ stream: false }),
          })
        ).status,
      ).toBe(403);
    });

    it('lets the assignee create turns after reassignment and refuses the previous owner', async () => {
      const db = createSqliteDb(':memory:');
      await migrateSqliteToLatest(db);
      const sessionStore = new SqliteSessionStore(db);
      await sessionStore.createSession({
        tenant_id: 'default',
        session_id: 's1',
        created_by_subject: { subject_id: 'los-service', subject_type: 'user', subject_display_name: 'LOS' },
        agent: {
          type: 'inline',
          spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' }, instructions: 'test' }),
        },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });
      await sessionStore.updateSession({
        tenant_id: 'default',
        session_id: 's1',
        agent: undefined,
        title: undefined,
        metadata: undefined,
        created_by_subject: { subject_id: 'uw@example.com', subject_type: 'user', subject_display_name: 'UW' },
      });
      let caller: RequestContext = {
        ...NON_ADMIN_CONTEXT,
        subject: { id: 'uw@example.com', type: 'user', display_name: 'UW' },
      };
      const app = new OpenAPIHono();
      app.route(
        '/',
        createTurnsRouter({
          sessions: new Sessions({ sessionStore }),
          sessionStore,
          activeTurns: new ActiveTurnRegistry(),
          resolveModelProviderStore: () => new SqliteModelProviderStore(db),
          resolveMcpServerStore: () => mcpServerStoreWithAuth(db, new SqliteOAuthTokenStore(db)),
          resolveSkillStore: () => new SqliteSkillStore(db),
          resolveAgentStore: () => new SqliteAgentStore(db),
          eventSubscriptions: new EventSubscriptionRegistry(undefined),
          resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
          logger: createLogger({ silent: true }),
          resolveRequestContext: () => caller,
          authorizer: new TrueForgeAuthorizer(),
        }),
      );
      // A malformed metadata header is rejected only after the ownership check passes.
      const createTurn = () =>
        app.request('/s1/turns', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-tfy-metadata': 'not-json' },
          body: JSON.stringify({ stream: false }),
        });

      expect((await createTurn()).status).toBe(400);
      caller = { ...NON_ADMIN_CONTEXT, subject: { id: 'los-service', type: 'user', display_name: 'LOS' } };
      expect((await createTurn()).status).toBe(403);
    });

    it('lets an agent manager use read routes but keeps create-turn and sandbox download creator-only', async () => {
      const db = createSqliteDb(':memory:');
      await migrateSqliteToLatest(db);
      const sessionStore = new SqliteSessionStore(db);
      const agentStore = new SqliteAgentStore(db);
      const agent = await agentStore.createAgent({
        tenant_id: 'default',
        name: 'managed-agent',
        description: 'Test agent.',
        manifest: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } }),
        external_id: 'managed-agent-external',
        created_by_subject: { subject_id: 'owner', subject_type: 'user', subject_display_name: 'Owner' },
      });
      await sessionStore.createSession({
        tenant_id: 'default',
        session_id: 'managed-session',
        created_by_subject: { subject_id: 'owner', subject_type: 'user', subject_display_name: 'Owner' },
        agent: { type: 'reference', id: agent.id, name: agent.name },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });
      const app = new OpenAPIHono();
      app.route(
        '/',
        createTurnsRouter({
          sessions: new Sessions({ sessionStore }),
          sessionStore,
          activeTurns: new ActiveTurnRegistry(),
          resolveModelProviderStore: () => new SqliteModelProviderStore(db),
          resolveMcpServerStore: () => mcpServerStoreWithAuth(db, new SqliteOAuthTokenStore(db)),
          resolveSkillStore: () => new SqliteSkillStore(db),
          resolveAgentStore: () => agentStore,
          eventSubscriptions: new EventSubscriptionRegistry(undefined),
          resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
          logger: createLogger({ silent: true }),
          resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
          authorizer: {
            listAgentAccess: input =>
              Promise.resolve(
                input.action === 'manage'
                  ? { kind: 'agent_external_ids', agent_external_ids: ['managed-agent-external'] }
                  : { kind: 'agent_external_ids', agent_external_ids: [] },
              ),
            canAccessAgent: () => Promise.resolve(false),
            getPermissions: async ({ resourceType, resourceIds }) => ({
              type: resourceType,
              permissions: Object.fromEntries(resourceIds.map(id => [id, []])),
            }),
          },
        }),
      );

      expect((await app.request('/managed-session/turns')).status).toBe(200);
      expect((await app.request('/managed-session/turns/missing')).status).toBe(404);
      expect((await app.request('/managed-session/turns/missing/events')).status).toBe(404);
      expect((await app.request('/managed-session/turns/missing/subscribe')).status).toBe(404);
      expect(
        (
          await app.request(
            `/managed-session/turns/missing/download-sandbox-file?path=${encodeURIComponent('/workspace/file.txt')}`,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request('/managed-session/turns', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ stream: false }),
          })
        ).status,
      ).toBe(403);
    });
  });

  describe('create turn x-tfy-metadata', () => {
    it('rejects a malformed header before starting the turn', async () => {
      const db = createSqliteDb(':memory:');
      await migrateSqliteToLatest(db);
      const sessionStore = new SqliteSessionStore(db);
      const sessions = new Sessions({ sessionStore });
      await sessionStore.createSession({
        tenant_id: 'default',
        session_id: 's1',
        created_by_subject: {
          subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
          subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
          subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
        },
        agent: {
          type: 'inline',
          spec: AgentSpecSchema.parse({
            model: { name: 'test-provider/test-model' },
            instructions: 'test',
          }),
        },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });

      const app = new OpenAPIHono();
      app.route(
        '/',
        createTurnsRouter({
          sessions,
          sessionStore,
          activeTurns: new ActiveTurnRegistry(),
          resolveModelProviderStore: () => new SqliteModelProviderStore(db),
          resolveMcpServerStore: () => mcpServerStoreWithAuth(db, new SqliteOAuthTokenStore(db)),
          resolveSkillStore: () => new SqliteSkillStore(db),
          resolveAgentStore: () => new SqliteAgentStore(db),
          eventSubscriptions: new EventSubscriptionRegistry(undefined),
          resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
          logger: createLogger({ silent: true }),
          resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
          authorizer: new TrueForgeAuthorizer(),
        }),
      );

      const response = await app.request('/s1/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tfy-metadata': 'not-json' },
        body: JSON.stringify({ stream: false }),
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('x-tfy-metadata must be a JSON object');
    });
  });

  describe('create turn non-streaming', () => {
    it('returns the running turn JSON after dual-writing turn.created so subscribe can attach', async () => {
      const logger = createLogger({ silent: true });
      const db = createSqliteDb(':memory:');
      await migrateSqliteToLatest(db);
      const modelProviderStore = new SqliteModelProviderStore(db);
      await modelProviderStore.upsertProvider({
        tenant_id: 'default',
        name: 'test-provider',
        manifest: {
          // Caller-named, so `custom` is the only type it can be.
          type: 'custom',
          name: 'test-provider',
          base_url: 'https://llm.test.example.com/v1',
          auth: { api_key: 'sk-test' },
          models: [
            {
              model_id: 'test-model',
              name: 'test-model',
              properties: { context_length: 128000, max_output_tokens: 4096 },
            },
          ],
        },
      });

      let releaseRest: (() => void) | undefined;
      const restParked = new Promise<void>(resolve => {
        releaseRest = resolve;
      });

      const sessions = {
        get: () =>
          Promise.resolve({
            session_id: 's1',
            tenant_id: STANDALONE_REQUEST_CONTEXT.tenant_id,
            spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } }),
            record: {
              last_turn_id: null,
              created_by_subject: {
                subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
                subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
                subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
              },
              agent: {
                type: 'inline',
                spec: AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } }),
              },
            },
            createTurn: () =>
              Promise.resolve({
                id: 'turn-non-stream',
                record: {
                  turn_id: 'turn-non-stream',
                  session_id: 's1',
                  previous_turn_id: null,
                  input: [],
                  state: { status: 'running' },
                  created_at: new Date('2026-01-01T00:00:00.000Z'),
                },
                stream: async function* stream() {
                  yield {
                    type: 'turn.created',
                    id: 'evt_created',
                    turn_id: 'turn-non-stream',
                    previous_turn_id: null,
                    state: { status: 'running' },
                    created_at: '2026-01-01T00:00:00.000Z',
                    thread_id: null,
                  };
                  await restParked;
                },
              }),
          }),
      } as unknown as Sessions;

      const eventSubscriptions = new EventSubscriptionRegistry<TurnStreamingEvent>(undefined);
      const tokenStore = new SqliteOAuthTokenStore(db);
      const app = new OpenAPIHono();
      app.route(
        '/',
        createTurnsRouter({
          sessions,
          sessionStore: new SqliteSessionStore(db),
          activeTurns: new ActiveTurnRegistry(),
          resolveModelProviderStore: () => modelProviderStore,
          resolveMcpServerStore: () => mcpServerStoreWithAuth(db, tokenStore),
          resolveAgentStore: () => new SqliteAgentStore(db),
          resolveSkillStore: () => new SqliteSkillStore(db),
          eventSubscriptions,
          resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
          logger,
          resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
          authorizer: new TrueForgeAuthorizer(),
        }),
      );

      const response = await app.request('/s1/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: false }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type') ?? '').toContain('application/json');
      const body: unknown = await response.json();
      expect(body).toEqual({
        data: {
          id: 'turn-non-stream',
          session_id: 's1',
          previous_turn_id: null,
          input: [],
          state: { status: 'running' },
          created_at: '2026-01-01T00:00:00.000Z',
        },
      });

      // Resumable stream must exist before the JSON response returns.
      await expect(
        eventSubscriptions.get(turnStreamId('default', 's1', 'turn-non-stream')).assertSubscribable(),
      ).resolves.toBeUndefined();

      releaseRest?.();
    });
  });

  describe('caller identity forwarding', () => {
    it("sends the caller's token only to opted-in MCP servers and never to the LLM", async () => {
      const db = createSqliteDb(':memory:');
      await migrateSqliteToLatest(db);
      const modelProviderStore = new SqliteModelProviderStore(db);
      await modelProviderStore.upsertProvider({
        tenant_id: 'default',
        name: 'test-provider',
        manifest: {
          type: 'custom',
          name: 'test-provider',
          base_url: 'https://llm.test.example.com/v1',
          auth: { api_key: 'sk-test' },
          models: [
            {
              model_id: 'test-model',
              name: 'test-model',
              properties: { context_length: 128000, max_output_tokens: 4096 },
            },
          ],
        },
      });
      const tokenStore = new SqliteOAuthTokenStore(db);
      const mcpServerStore = mcpServerStoreWithAuth(db, tokenStore);
      await mcpServerStore.upsertServer({
        tenant_id: 'default',
        name: 'los',
        manifest: {
          type: 'remote',
          name: 'los',
          url: 'https://los.example/mcp',
          description: 'Lending MCP.',
          forward_caller_identity: true,
        },
      });
      await mcpServerStore.upsertServer({
        tenant_id: 'default',
        name: 'plain',
        manifest: { type: 'remote', name: 'plain', url: 'https://plain.example/mcp', description: 'Plain MCP.' },
      });

      const caller = { ...STANDALONE_REQUEST_CONTEXT, user_credential: 'user-jwt' };
      const agentSpec = AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } });
      let captured: TurnResourceResolver | undefined;
      const sessions = {
        get: () =>
          Promise.resolve({
            session_id: 's1',
            tenant_id: caller.tenant_id,
            spec: agentSpec,
            record: {
              last_turn_id: null,
              created_by_subject: {
                subject_id: caller.subject.id,
                subject_type: caller.subject.type,
                subject_display_name: caller.subject.display_name,
              },
              agent: { type: 'inline', spec: agentSpec },
            },
            createTurn: (input: { resolver: TurnResourceResolver }) => {
              captured = input.resolver;
              return Promise.resolve({
                id: 'turn-identity',
                record: {
                  turn_id: 'turn-identity',
                  session_id: 's1',
                  previous_turn_id: null,
                  input: [],
                  state: { status: 'running' },
                  created_at: new Date('2026-01-01T00:00:00.000Z'),
                },
                stream: async function* stream() {
                  yield {
                    type: 'turn.created',
                    id: 'evt_created',
                    turn_id: 'turn-identity',
                    previous_turn_id: null,
                    state: { status: 'running' },
                    created_at: '2026-01-01T00:00:00.000Z',
                    thread_id: null,
                  };
                },
              });
            },
          }),
      } as unknown as Sessions;

      const app = new OpenAPIHono();
      app.route(
        '/',
        createTurnsRouter({
          sessions,
          sessionStore: new SqliteSessionStore(db),
          activeTurns: new ActiveTurnRegistry(),
          resolveModelProviderStore: () => modelProviderStore,
          resolveMcpServerStore: () => mcpServerStore,
          resolveAgentStore: () => new SqliteAgentStore(db),
          resolveSkillStore: () => new SqliteSkillStore(db),
          eventSubscriptions: new EventSubscriptionRegistry<TurnStreamingEvent>(undefined),
          resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
          logger: createLogger({ silent: true }),
          resolveRequestContext: () => caller,
          authorizer: new TrueForgeAuthorizer(),
        }),
      );

      const response = await app.request('/s1/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: false }),
      });
      expect(response.status).toBe(200);
      if (captured === undefined) {
        throw new Error('expected createTurn to receive a resolver');
      }
      // deps is protected on the core resolver; the test reads the wired hooks directly.
      const resolverDeps = captured['deps'];

      const los = await resolverDeps.mcp('los');
      expect(los.headers).toEqual({
        'X-TrueForge-User': caller.subject.id,
        'X-TrueForge-User-Token': 'user-jwt',
        'X-TrueForge-Session-Id': 's1',
        'X-TrueForge-Turn-Id': expect.any(String),
      });
      const plain = await resolverDeps.mcp('plain');
      expect(plain.headers).toEqual({});

      const llm = await resolverDeps.llm('test-provider/test-model');
      const llmState = inspect(llm.modelClient, { depth: 6 });
      expect(llmState).toContain('llm.test.example.com');
      expect(llmState).not.toContain('user-jwt');
      expect(llmState).not.toContain('X-TrueForge');
    });
  });

  describe('turn SSE after session deletion', () => {
    it('warns when the stream ends because the session/turn was removed', async () => {
      const warnings: unknown[] = [];
      const logger = createLogger({ silent: true });
      logger.warn = ((message: unknown) => {
        warnings.push(message);
        return logger;
      }) as typeof logger.warn;

      const db = createSqliteDb(':memory:');
      await migrateSqliteToLatest(db);
      const modelProviderStore = new SqliteModelProviderStore(db);
      await modelProviderStore.upsertProvider({
        tenant_id: 'default',
        name: 'test-provider',
        manifest: {
          // Caller-named, so `custom` is the only type it can be.
          type: 'custom',
          name: 'test-provider',
          base_url: 'https://llm.test.example.com/v1',
          auth: { api_key: 'sk-test' },
          models: [
            {
              model_id: 'test-model',
              name: 'test-model',
              properties: { context_length: 128000, max_output_tokens: 4096 },
            },
          ],
        },
      });

      const agentSpec = AgentSpecSchema.parse({ model: { name: 'test-provider/test-model' } });
      const sessions = {
        get: () =>
          Promise.resolve({
            session_id: 's1',
            tenant_id: STANDALONE_REQUEST_CONTEXT.tenant_id,
            spec: agentSpec,
            record: {
              session_id: 's1',
              last_turn_id: null,
              created_by_subject: {
                subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
                subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
                subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
              },
              agent: { type: 'inline', spec: agentSpec },
            },
            createTurn: () =>
              Promise.resolve({
                id: 'turn-gone',
                stream: async function* stream() {
                  throw new TurnNotFoundError('turn-gone');
                },
              }),
          }),
      } as unknown as Sessions;

      const tokenStore = new SqliteOAuthTokenStore(db);
      const app = new OpenAPIHono();
      app.route(
        '/',
        createTurnsRouter({
          sessions,
          sessionStore: new SqliteSessionStore(db),
          activeTurns: new ActiveTurnRegistry(),
          resolveModelProviderStore: () => modelProviderStore,
          resolveMcpServerStore: () => mcpServerStoreWithAuth(db, tokenStore),
          resolveSkillStore: () => new SqliteSkillStore(db),
          resolveAgentStore: () => new SqliteAgentStore(db),
          eventSubscriptions: new EventSubscriptionRegistry(undefined),
          resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
          logger,
          resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
          authorizer: new TrueForgeAuthorizer(),
        }),
      );

      const response = await app.request('/s1/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(200);
      await response.text();

      expect(
        warnings.some(
          message =>
            typeof message === 'string' && message.includes('Turn stream ended after session/turn was removed'),
        ),
      ).toBe(true);
    });
  });

  describe('create turn referenced agent', () => {
    const deniedCanAccessAgent = jest.fn((_input: Parameters<Authorizer['canAccessAgent']>[0]) =>
      Promise.resolve(false),
    );
    const denyAllAuthorizer: Authorizer = {
      listAgentAccess: () => Promise.resolve({ kind: 'agent_external_ids', agent_external_ids: [] }),
      canAccessAgent: deniedCanAccessAgent,
      getPermissions: async ({ resourceType, resourceIds }) => ({
        type: resourceType,
        permissions: Object.fromEntries(resourceIds.map(id => [id, []])),
      }),
    };

    async function referencedAgentHarness(authorizer: Authorizer) {
      const db = createSqliteDb(':memory:');
      await migrateSqliteToLatest(db);
      const sessionStore = new SqliteSessionStore(db);
      const sessions = new Sessions({ sessionStore });
      const agentStore = new SqliteAgentStore(db);
      const agent = await agentStore.createAgent({
        tenant_id: 'default',
        created_by_subject: {
          subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
          subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
          subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
        },
        name: 'named-for-turn',
        description: 'Test agent.',
        manifest: AgentSpecSchema.parse({
          model: { name: 'test-provider/test-model' },
          instructions: 'test',
        }),
        external_id: null,
      });
      await sessionStore.createSession({
        tenant_id: 'default',
        session_id: 's1',
        created_by_subject: {
          subject_id: STANDALONE_REQUEST_CONTEXT.subject.id,
          subject_type: STANDALONE_REQUEST_CONTEXT.subject.type,
          subject_display_name: STANDALONE_REQUEST_CONTEXT.subject.display_name,
        },
        agent: { type: 'reference', id: agent.id, name: agent.name },
        custom: null,
        metadata: {},
        external_id: null,
        source: null,
      });
      const tokenStore = new SqliteOAuthTokenStore(db);
      const app = new OpenAPIHono();
      app.route(
        '/',
        createTurnsRouter({
          sessions,
          sessionStore,
          activeTurns: new ActiveTurnRegistry(),
          resolveModelProviderStore: () => new SqliteModelProviderStore(db),
          resolveMcpServerStore: () => mcpServerStoreWithAuth(db, tokenStore),
          resolveSkillStore: () => new SqliteSkillStore(db),
          resolveAgentStore: () => agentStore,
          eventSubscriptions: new EventSubscriptionRegistry(undefined),
          resolveSandboxProviderStore: () => new SqliteSandboxProviderStore(db),
          logger: createLogger({ silent: true }),
          resolveRequestContext: () => STANDALONE_REQUEST_CONTEXT,
          authorizer,
        }),
      );
      return { app, agent, agentStore };
    }

    it('returns 422 when the referenced agent no longer exists', async () => {
      const { app, agent, agentStore } = await referencedAgentHarness(new TrueForgeAuthorizer());
      await agentStore.deleteAgent({ tenant_id: 'default', id: agent.id });
      const response = await app.request('/s1/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: false }),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: { message: `Agent not found: ${agent.id}` } });
    });

    it('returns 404 when the caller cannot use the referenced agent', async () => {
      deniedCanAccessAgent.mockClear();
      const { app, agent } = await referencedAgentHarness(denyAllAuthorizer);
      const response = await app.request('/s1/turns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: false }),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { message: `Agent not found: ${agent.id}` } });
      expect(deniedCanAccessAgent.mock.calls.map(([input]) => input.action)).toEqual(['use']);
    });
  });
});
