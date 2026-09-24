import { canAssignSessions, hasAdminRole } from '../../../src/auth/identity';

jest.mock('../../../src/config', () => {
  const actual = jest.requireActual<typeof import('../../../src/config')>('../../../src/config');
  const config = {
    ...actual.default,
    STANDALONE: false as const,
    OIDC: {
      OIDC_ISSUER_URL: 'https://issuer.example.com/',
      OIDC_CLIENT_ID: 'harness-client',
      OIDC_CLIENT_SECRET: 'harness-secret',
      OIDC_USER_REFERENCE_CLAIM: 'email',
      OIDC_USER_DISPLAY_NAME_CLAIM: 'name',
      OIDC_USER_ROLE_CLAIM: 'groups',
      OIDC_ADMIN_ROLE_VALUE: 'admin',
      OIDC_SESSION_ASSIGNER_ROLE_VALUE: 'case-assigner',
      OIDC_SCOPES: ['openid', 'profile', 'email', 'groups'],
      OIDC_ALLOWED_EMAILS: [] as string[],
    },
  };
  return {
    ...actual,
    __esModule: true,
    default: config,
    getTrueForgeAuthMode: jest.fn(() => actual.TrueForgeAuthMode.Oidc),
    isOidcConfigured: jest.fn(() => true),
    isTrueFoundryModeEnabled: jest.fn(() => false),
  };
});

describe('canAssignSessions (OIDC)', () => {
  it('allows admins and holders of the session-assigner role only', () => {
    expect(canAssignSessions({ roles: ['admin'] })).toBe(true);
    expect(canAssignSessions({ roles: ['underwriters', 'case-assigner'] })).toBe(true);
    expect(canAssignSessions({ roles: ['underwriters'] })).toBe(false);
    expect(canAssignSessions({ roles: [] })).toBe(false);
  });

  it('does not make assigners admins', () => {
    expect(hasAdminRole({ roles: ['case-assigner'] })).toBe(false);
  });
});
